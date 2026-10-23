/**
 * Decode license claims for local routing and expiry checks.
 * Signature verification remains the server's responsibility.
 */

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
 * Return true when the token's `exp` claim is already past (with a small
 * grace window). A missing/undecodable token is treated as expired to
 * ensure malformed tokens are rejected.
 */
function isJwtExpired(token) {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp < Math.floor(Date.now() / 1000) + JWT_EXPIRY_GRACE_SECONDS;
}

/**
 * Read the HTTPS audience from an unexpired token, or return null.
 * The legacy telemetry_endpoint claim is not used.
 *
 * @param {string} token
 * @returns {string|null}
 */
function getEndpointFromToken(token) {
  if (!token) return null;
  if (isJwtExpired(token)) return null;
  return readEndpointClaim(token);
}

/**
 * Read the audience without checking expiry, for routing only.
 * Upload callers still require a fresh token before sending.
 *
 * @param {string} token
 * @returns {string|null}
 */
function getEndpointFromTokenAllowExpired(token) {
  if (!token) return null;
  return readEndpointClaim(token);
}

// Take the first HTTPS-prefixed aud value and remove trailing slashes.
// The upload path separately validates the destination host.
function readEndpointClaim(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  for (const aud of auds) {
    if (typeof aud !== "string") continue;
    const trimmed = aud.trim();
    if (!/^https:\/\//i.test(trimmed)) continue;
    return trimmed.replace(/\/+$/, "");
  }
  return null;
}

/**
 * The GitHub accounts the license covers: the tenant's SkillBench app
 * installations, from the `orgs` claim, lower-cased. This is the only source of
 * repository scope. A missing or malformed claim covers nothing.
 */
function getLicenseOrgs(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || !Array.isArray(claims.orgs)) return [];
  return [...new Set(claims.orgs.filter(org => typeof org === "string")
    .map(org => org.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The tenant the license is for, as its slug in `org.login`. A renewal sends it
 * back to /activate so it cannot move the license to another workspace. Never
 * a repository owner.
 */
function getLicenseTenantSlug(token) {
  const login = decodeJwtPayload(token)?.org?.login;
  return typeof login === "string" ? login.trim() : "";
}

module.exports = {
  JWT_EXPIRY_GRACE_SECONDS,
  decodeJwtPayload,
  getLicenseOrgs,
  getLicenseTenantSlug,
  isJwtExpired,
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
};
