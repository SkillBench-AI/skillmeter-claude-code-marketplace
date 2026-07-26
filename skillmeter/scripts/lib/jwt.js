/**
 * License-JWT helpers: payload decode, expiry check, telemetry endpoint
 * resolution. No signature verification — these are trust-the-server-or-
 * rotate semantics; the plugin only uses claims to make local routing
 * decisions and to avoid sending tokens we know are already expired.
 */

const { getBackendUrlOverride } = require("./config");

// 30-second grace window tolerates minor clock skew between client and server.
const JWT_EXPIRY_GRACE_SECONDS = 30;

/**
 * Decode the payload section of a JWT token (without signature verification)
 * @param {string} token - JWT token string
 * @returns {object|null} Decoded payload or null on failure
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Return true when the token's `exp` claim is already past (with a skew window).
 * @param {string} token
 * @param {object} [opts]
 * @param {number}  [opts.skewSeconds=JWT_EXPIRY_GRACE_SECONDS] grace/proactive window
 * @param {boolean} [opts.treatMissingAsExpired=false] whether a missing token or
 *   missing/undecodable `exp` counts as expired. Default false (callers guard on
 *   token presence themselves); the license check passes true.
 */
function isJwtExpired(token, {
  skewSeconds = JWT_EXPIRY_GRACE_SECONDS,
  treatMissingAsExpired = false,
} = {}) {
  if (!token) return treatMissingAsExpired;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return treatMissingAsExpired;
  return payload.exp < Math.floor(Date.now() / 1000) + skewSeconds;
}

/**
 * Resolve the telemetry endpoint for the current license. The activation Lambda
 * mints the tenant's meter URL into the standard JWT `aud` (audience) claim —
 * the token's intended recipient IS the tenant's meter host — so each tenant's
 * traffic routes to its own hostname without per-tenant plugin builds.
 * `SKILLMETER_BACKEND_URL` bypasses the JWT entirely for local development /
 * integration tests.
 *
 * `aud` may be a string or an array of strings (RFC 7519); we take the first
 * `http(s)` URL. No other claim is consulted — the token must carry the endpoint
 * in `aud`.
 *
 * No expiry gate: the endpoint is routing info (the per-tenant meter hostname),
 * still readable from an aged-out token. It is never an auth decision — callers
 * enforce a valid bearer separately (the backend rejects unauthenticated
 * telemetry); this only recovers the destination URL.
 *
 * @param {string} token - License JWT (raw, as stored in the credstore)
 * @returns {string|null} Base URL with no trailing slash, or null when no
 *   endpoint can be resolved. Callers must skip the upload on null and leave
 *   the on-disk file for retry once a fresh JWT is available.
 */
function getEndpointFromTokenAllowExpired(token) {
  const override = getBackendUrlOverride();
  if (override) return override;
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const audUrl = auds.find((a) => typeof a === "string" && /^https?:\/\//.test(a));
  return audUrl || null;
}

/**
 * The GitHub org(s) this license validates for telemetry, as decided by the
 * activator and minted into the JWT. No expiry gate — this is identity/routing
 * info (like getEndpointFromTokenAllowExpired), not an auth decision. Returns a
 * normalized (lowercased) array; `[]` when the token is missing/undecodable or
 * carries no org claim. Accepts the current singular `org.login` claim and a
 * future plural `orgs` array for forward-compat.
 */
function getLicenseOrgs(token) {
  const payload = token ? decodeJwtPayload(token) : null;
  if (!payload) return [];
  const raw = Array.isArray(payload.orgs)
    ? payload.orgs
    : payload.org && payload.org.login
      ? [payload.org.login]
      : [];
  return raw
    .filter((o) => typeof o === "string")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
}

function getLicenseAudiences(token) {
  const payload = token ? decodeJwtPayload(token) : null;
  if (!payload) return [];
  const raw = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return [...new Set(
    raw
      .filter((audience) => typeof audience === "string")
      .map((audience) => audience.trim())
      .filter(Boolean)
  )].sort();
}

module.exports = {
  isJwtExpired,
  getEndpointFromTokenAllowExpired,
  getLicenseOrgs,
  getLicenseAudiences,
};
