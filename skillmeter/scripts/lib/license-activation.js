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

const { execSync } = require("child_process");
const credstore = require("../credstore");
const { fetchUserGitHubOrgs } = require("./github-api");
const { getSkillmeterStringSetting } = require("./settings");

// Default points at prod. Devs/agents override via SKILLMETER_ACTIVATE_URL
// (e.g. https://api.dev.skillbench.com/activate) or a `skillmeter.activate_url`
// entry in the project's .claude/settings.local.json.
const DEFAULT_ACTIVATE_URL = "https://api.skillbench.com/activate";

function getActivateUrl() {
  if (process.env.SKILLMETER_ACTIVATE_URL) return process.env.SKILLMETER_ACTIVATE_URL;
  const fromSettings = getSkillmeterStringSetting(process.cwd(), "activate_url");
  if (fromSettings) return fromSettings;
  return DEFAULT_ACTIVATE_URL;
}

const FAILURE_COOLDOWN = 24 * 60 * 60;
const TRANSIENT_COOLDOWN = 5 * 60;

/**
 * Attempt to activate silently using `gh auth token` if the user already
 * has the GitHub CLI authenticated. Returns the license JWT on success,
 * null otherwise. Failures are cached in the credstore so repeated hooks
 * don't hammer GitHub/the activation endpoint.
 */
async function trySilentGhActivate(deviceId) {
  if (credstore.getSignedOut()) {
    console.error("[skillmeter] gh activation skipped: signed out (run /skillmeter:signin to re-enable)");
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const retryAfter = credstore.getGhFallbackRetryAfter();
  if (retryAfter > now) {
    const secondsLeft = retryAfter - now;
    console.error(`[skillmeter] gh activation skipped: in cooldown for another ${secondsLeft}s`);
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
    credstore.setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }
  if (!ghToken) {
    console.error("[skillmeter] gh activation skipped: `gh auth token` returned empty");
    credstore.setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
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
    credstore.setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }

  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation failed: activation endpoint returned ${res.status} (${body.slice(0, 200)})`);
    credstore.setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[skillmeter] gh activation rejected: HTTP ${res.status} (${body.slice(0, 200)})`);
    credstore.setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error("[skillmeter] gh activation failed: activation endpoint returned invalid JSON");
    credstore.setGhFallbackRetryAfter(now + TRANSIENT_COOLDOWN);
    return null;
  }
  const jwt = payload?.token;
  if (!jwt) {
    console.error("[skillmeter] gh activation failed: response missing `token` field");
    credstore.setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
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
    credstore.setGhFallbackRetryAfter(now + FAILURE_COOLDOWN);
    return null;
  }

  if (!credstore.commitSignin({ jwt, orgs })) {
    console.error("[skillmeter] gh activation discarded: signed out during issuance");
    return null;
  }
  console.error(`[skillmeter] gh activation succeeded (allowed orgs: ${orgs.join(", ") || "none"})`);
  return jwt;
}

module.exports = {
  getActivateUrl,
  trySilentGhActivate,
};
