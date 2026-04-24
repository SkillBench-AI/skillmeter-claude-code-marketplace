/**
 * License-JWT helpers: payload decode, expiry check, telemetry endpoint
 * resolution. No signature verification — these are trust-the-server-or-
 * rotate semantics; the plugin only uses claims to make local routing
 * decisions and to avoid sending tokens we know are already expired.
 */

// 30-second grace window tolerates minor clock skew between client and server.
const JWT_EXPIRY_GRACE_SECONDS = 30;

// Emergency override: route all telemetry to the Andela tenant API regardless
// of JWT state. JWT-issued endpoints are misrouted and the license-required
// guard is temporarily lifted to keep telemetry flowing.
const DEFAULT_ENDPOINT = "https://api-meter-andela.skillbench.com";

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
 * grace window). A missing/undecodable token is treated as NOT expired —
 * callers already guard on token presence.
 */
function isJwtExpired(token) {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp < Math.floor(Date.now() / 1000) + JWT_EXPIRY_GRACE_SECONDS;
}

/**
 * Return the telemetry endpoint URL.
 * Currently hardcoded to DEFAULT_ENDPOINT — the JWT telemetry_endpoint claim
 * is ignored during the emergency routing override.
 * @returns {string} Endpoint URL (always non-null)
 */
function getEndpointFromToken() {
  return DEFAULT_ENDPOINT;
}

module.exports = {
  JWT_EXPIRY_GRACE_SECONDS,
  DEFAULT_ENDPOINT,
  decodeJwtPayload,
  isJwtExpired,
  getEndpointFromToken,
};
