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
 * Resolve the telemetry base URL from a development override or the first
 * HTTP(S) audience in the license. An override changes routing only.
 * This helper ignores expiry; upload callers separately require a valid bearer.
 *
 * @param {string} token
 * @returns {string|null}
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

/**
 * The tenant a broker license is for: its slug, which the license server keeps
 * in `org.login` (a GitHub-path license keeps the GitHub login there). Renewal
 * pins `/activate` to it so a renewal can never move the license to another
 * workspace (ADR 005). Empty string when absent.
 */
function getLicenseTenantSlug(token) {
  const payload = decodeJwtPayload(token);
  const login = payload && payload.org && payload.org.login;
  return typeof login === "string" ? login.trim() : "";
}

module.exports = {
  getLicenseTenantSlug,
  isJwtExpired,
  getEndpointFromTokenAllowExpired,
  getLicenseOrgs,
  getLicenseAudiences,
};
