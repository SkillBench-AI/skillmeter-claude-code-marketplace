/**
 * License activation orchestrator.
 *
 * Owns the silent `gh auth token` fallback path and the activation-endpoint
 * URL resolution. Storage lives in credstore (license JWT, allowed orgs,
 * gh-fallback cooldown); HTTP lives in lib/github-api (org lookup). This
 * module wires the two together.
 *
 * The exported surface (`getActivateUrl`, `trySilentGhActivate`) is what
 * sign-in entrypoints and the hook-runtime refresh path consume.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const credstore = require("../credstore");
const { fetchUserGitHubOrgs } = require("./github-api");
const { getSkillmeterStringSetting } = require("./settings");
const { LOG_DIR } = require("./paths");

// Default points at prod (the published plugin serves real users). Devs/agents
// override via SKILLMETER_ACTIVATE_URL (e.g. https://api.dev.skillbench.com/activate)
// or a `skillmeter.activate_url` entry in the project's .claude/settings.local.json.
const DEFAULT_ACTIVATE_URL = "https://api.skillbench.ai/activate";

function getActivateUrl() {
  if (process.env.SKILLMETER_ACTIVATE_URL) return process.env.SKILLMETER_ACTIVATE_URL;
  const fromSettings = getSkillmeterStringSetting(process.cwd(), "activate_url");
  if (fromSettings) return fromSettings;
  return DEFAULT_ACTIVATE_URL;
}

// The /refresh endpoint sits next to /activate on the same host. Derive the
// URL from getActivateUrl so the same host configuration covers both. If the
// activate URL doesn't end with /activate (e.g. a dev override with a custom
// path), we append /refresh to the base path — keeps weird overrides at least
// roundtrippable.
function getRefreshUrl() {
  const url = getActivateUrl();
  if (url.endsWith("/activate")) return url.slice(0, -"/activate".length) + "/refresh";
  return url.replace(/\/?$/, "/refresh");
}

/**
 * Rotate an existing license JWT through the Lambda's /refresh endpoint.
 * The server validates the signature, enforces a sliding window against
 * `original_iat`, re-confirms org purchase, and mints a fresh JWT — no
 * GitHub round-trip, so this works for users without `gh` installed.
 *
 * Returns the new JWT string on success, or `null` for any failure
 * (signature invalid, sliding window exceeded, license cancelled, network
 * error, endpoint not yet deployed). The caller is expected to fall back
 * to silent gh /activate on null.
 *
 * On success the new token is written to credstore atomically.
 */
async function refreshExpiredJwt(jwt, deviceId) {
  if (!jwt || !deviceId) return null;

  const url = getRefreshUrl();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[skillmeter] license refresh failed: network error (${err.message})`);
    return null;
  }

  // 410: sliding window exceeded — client must re-activate via /activate.
  // 404: endpoint not yet deployed on this environment — silent fallback.
  // 401: token signature invalid — caller's silent-gh fallback will deal.
  // 402: org license cancelled — refresh is permanently blocked for this org.
  if (res.status === 410) {
    console.error("[skillmeter] license refresh: token too old, re-activation required");
    return null;
  }
  if (res.status === 404) {
    // Quiet on 404 so logs don't spam during deploy-order rollout.
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] license refresh failed: HTTP ${res.status} (${body.slice(0, 200)})`);
    return null;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] license refresh failed: invalid JSON in response");
    return null;
  }
  const newJwt = payload?.token;
  if (!newJwt) {
    console.error("[skillmeter] license refresh failed: response missing `token` field");
    return null;
  }

  credstore.setLicenseToken(newJwt);
  console.error("[skillmeter] license refresh: rotated successfully");
  return newJwt;
}

/**
 * Attempt to activate silently using `gh auth token` if the user already
 * has the GitHub CLI authenticated. Returns the license JWT on success,
 * null otherwise.
 *
 * Failures are not retried within the same hook — `tryRefreshLicense` is
 * called once per SessionStart, so the hook architecture itself gives us
 * a natural "at-most-once-per-session" rate limit. Anything that fails
 * here just returns null; the caller leaves the on-disk queue for the
 * next session to drain.
 */
async function trySilentGhActivate(deviceId) {
  if (credstore.getSignedOut()) {
    console.error("[skillmeter] gh activation skipped: signed out (run /skillmeter:signin to re-enable)");
    return null;
  }

  let ghToken;
  try {
    ghToken = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    console.error("[skillmeter] gh activation skipped: gh CLI not installed or not authenticated");
    return null;
  }
  if (!ghToken) {
    console.error("[skillmeter] gh activation skipped: `gh auth token` returned empty");
    return null;
  }

  console.error("[skillmeter] gh activation: exchanging token with activation endpoint");

  let res;
  try {
    res = await fetch(getActivateUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_id: deviceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[skillmeter] gh activation failed: network error (${err.message})`);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation rejected: HTTP ${res.status} (${body.slice(0, 200)})`);
    return null;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] gh activation failed: activation endpoint returned invalid JSON");
    return null;
  }
  const jwt = payload?.token;
  if (!jwt) {
    console.error("[skillmeter] gh activation failed: response missing `token` field");
    return null;
  }

  // Fetch the user's GitHub identities BEFORE persisting the license so
  // license + orgs land atomically. If the gh CLI's token lacks the
  // `read:org` scope the fetch fails — we treat that as silent-path
  // failure and let the device-flow path run, which always requests the
  // right scopes.
  let orgs;
  try {
    orgs = await fetchUserGitHubOrgs(ghToken);
  } catch (err) {
    console.error(`[skillmeter] gh activation failed: cannot fetch GitHub orgs (${err.message})`);
    return null;
  }

  if (!credstore.commitSignin({ jwt, orgs })) {
    console.error("[skillmeter] gh activation discarded: signed out during issuance");
    return null;
  }
  console.error(`[skillmeter] gh activation succeeded (allowed orgs: ${orgs.join(", ") || "none"})`);
  return jwt;
}

// ---------------------------------------------------------------------------
// On-demand refresh with cross-process single-flight.
//
// The license JWT is short-lived (15-min TTL). Refreshing only at SessionStart
// leaves mid-session and retry-daemon uploads holding an expired token. These
// helpers let any drain/upload best-effort refresh the token right before it's
// needed, while a file-lock collapses concurrent callers (separate hook
// processes + the daemon) into a single /refresh round-trip.
// ---------------------------------------------------------------------------

const LICENSE_REFRESH_LOCK_FILE = path.join(LOG_DIR, ".license-refresh.lock");
// Don't retry a refresh within this window of the last attempt (non-force).
const LICENSE_REFRESH_COOLDOWN_MS = 60_000;
// A lock younger than this is assumed held by a live, in-flight refresh
// (worst case ~13s: 5s /refresh + 5s gh-activate fetch + 3s `gh auth token`).
// Older locks are reclaimable, so a crashed holder can't wedge refresh.
const LICENSE_REFRESH_STALE_MS = 15_000;

/**
 * Pure single-flight + cooldown decision (no I/O — unit-testable).
 * @param {boolean} tokenFresh   - current token exists and is not near expiry
 * @param {boolean} force        - reactive path (e.g. a 401); ignores cooldown
 * @param {number|null} lockMtimeMs - mtime of the lock file, or null if absent
 * @param {number} now           - Date.now()
 * @returns {"return_current"|"acquire_and_refresh"|"skip_locked"}
 */
function shouldRefresh(
  tokenFresh,
  force,
  lockMtimeMs,
  now,
  cooldownMs = LICENSE_REFRESH_COOLDOWN_MS,
  staleMs = LICENSE_REFRESH_STALE_MS
) {
  if (tokenFresh && !force) return "return_current";
  const lockAge = lockMtimeMs == null ? Infinity : now - lockMtimeMs;
  // A live in-flight holder — never stampede, even on force.
  if (lockAge < staleMs) return "skip_locked";
  // Non-force also honors the cooldown so we don't hammer /refresh; force
  // (a real auth rejection) bypasses cooldown but respected the lock above.
  if (!force && lockAge < cooldownMs) return "skip_locked";
  return "acquire_and_refresh";
}

/**
 * Orchestrate one refresh: try /refresh rotation first (gh-independent), then
 * fall back to silent gh /activate. Returns the freshest token or null. Reads
 * the token uncached so a refresh written by another process is observed.
 * (Body lifted from logger.tryRefreshLicense, which now delegates here.)
 */
async function refreshLicense(deviceId) {
  const current = credstore.getLicenseTokenUncached();
  if (current && !credstore.isLicenseTokenExpired(current)) return current;
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  if (current) {
    const fresh = await refreshExpiredJwt(current, deviceId);
    if (fresh) return fresh;
  }
  try {
    return await trySilentGhActivate(deviceId);
  } catch {
    return null;
  }
}

/**
 * Best-effort, single-flight license refresh. Never throws; returns the
 * freshest token available (refreshed, existing, or null). Safe to call before
 * every drain/upload — cheap no-op when the token is already fresh, and
 * non-blocking when another process holds the refresh lock.
 */
async function ensureFreshLicense(deviceId, { force = false } = {}) {
  if (!deviceId) return null;
  if (credstore.getSignedOut()) return null;

  const current = credstore.getLicenseTokenUncached();
  const tokenFresh = Boolean(current) && !credstore.isLicenseTokenExpired(current);

  let lockMtimeMs = null;
  try {
    lockMtimeMs = fs.statSync(LICENSE_REFRESH_LOCK_FILE).mtimeMs;
  } catch {
    // lock absent
  }

  const action = shouldRefresh(tokenFresh, force, lockMtimeMs, Date.now());
  // return_current or skip_locked: hand back what we have without blocking.
  if (action !== "acquire_and_refresh") return current;

  // Record the attempt time — serves as both the in-flight marker (single
  // flight) and the cooldown anchor. Intentionally not deleted afterward; the
  // mtime ages out past STALE/COOLDOWN. Not matched by listSealedEventLogs /
  // cleanupStaleFiles (same as .drain-once.lock), so it's never swept.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_REFRESH_LOCK_FILE, `${process.pid} ${Date.now()}\n`);
  } catch {
    // best-effort lock; proceed even if it couldn't be written
  }

  try {
    return (await refreshLicense(deviceId)) || current;
  } catch {
    return current;
  }
}

module.exports = {
  getActivateUrl,
  getRefreshUrl,
  refreshExpiredJwt,
  trySilentGhActivate,
  shouldRefresh,
  refreshLicense,
  ensureFreshLicense,
  LICENSE_REFRESH_COOLDOWN_MS,
  LICENSE_REFRESH_STALE_MS,
};
