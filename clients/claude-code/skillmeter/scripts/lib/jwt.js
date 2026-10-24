// GENERATED from shared/lib/jwt.js by scripts/sync-shared.mjs. Edit that file, not this copy.
"use strict";

/**
 * Decode license claims for local routing and expiry checks. No signature
 * verification: the server verifies; a client only uses claims to route and
 * to avoid sending a token it knows has expired. No client configuration here:
 * each client applies its own endpoint override before the token's audience.
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
 * Return true when the token's `exp` claim is already past (with a skew window).
 * @param {string} token
 * @param {object} [opts]
 * @param {number}  [opts.skewSeconds=JWT_EXPIRY_GRACE_SECONDS] grace/proactive window
 * @param {boolean} [opts.treatMissingAsExpired=true] whether a missing token or
 *   missing/undecodable `exp` counts as expired. True by default so a malformed
 *   token is never sent; pass false only where absence is handled elsewhere.
 */
function isJwtExpired(token, {
  skewSeconds = JWT_EXPIRY_GRACE_SECONDS,
  treatMissingAsExpired = true,
} = {}) {
  if (!token) return treatMissingAsExpired;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return treatMissingAsExpired;
  return payload.exp < Math.floor(Date.now() / 1000) + skewSeconds;
}

// Take the first HTTPS audience, without trailing slashes. The license is sent
// to it as a bearer token, so plain HTTP is never a telemetry endpoint.
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
 * The telemetry base URL from an unexpired token's audience, or null.
 * @param {string} token
 * @returns {string|null}
 */
function getEndpointFromToken(token) {
  if (!token || isJwtExpired(token)) return null;
  return readEndpointClaim(token);
}

/**
 * The telemetry base URL from the token's audience, ignoring expiry: routing
 * only. Upload callers still require a fresh token before sending.
 * @param {string} token
 * @returns {string|null}
 */
function getEndpointFromTokenAllowExpired(token) {
  if (!token) return null;
  return readEndpointClaim(token);
}

/**
 * The GitHub orgs whose repositories this license covers, from the `orgs`
 * claim, lowercased and deduplicated. This is the only source of repository
 * scope: `org.login` is the tenant slug and never a repository owner. A missing
 * or malformed claim covers nothing. No expiry gate: this is identity, not an
 * auth decision.
 */
function getLicenseOrgs(token) {
  const payload = token ? decodeJwtPayload(token) : null;
  if (!payload || !Array.isArray(payload.orgs)) return [];
  return [...new Set(payload.orgs
    .filter((org) => typeof org === "string")
    .map((org) => org.trim().toLowerCase())
    .filter(Boolean))];
}

// Every audience the license names, trimmed, deduplicated and sorted.
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
 * The tenant a license is for: its slug, which the license server keeps in
 * `org.login`. Renewal pins /activate to it so a renewal can never move the
 * license to another workspace (ADR 005). Empty string when absent.
 */
function getLicenseTenantSlug(token) {
  const login = token ? decodeJwtPayload(token)?.org?.login : undefined;
  return typeof login === "string" ? login.trim() : "";
}

module.exports = {
  JWT_EXPIRY_GRACE_SECONDS,
  decodeJwtPayload,
  isJwtExpired,
  getEndpointFromToken,
  getEndpointFromTokenAllowExpired,
  getLicenseOrgs,
  getLicenseAudiences,
  getLicenseTenantSlug,
};
