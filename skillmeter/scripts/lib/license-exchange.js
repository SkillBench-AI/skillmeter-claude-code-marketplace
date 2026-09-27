/**
 * Exchange a broker ID token for a license at /activate: the one place a
 * license is issued, at sign-in and at every renewal (ADR 005). Never throws.
 *
 *   { outcome: "issued", token }
 *   { outcome: "revoked", status }    402: no workspace licenses this user; or
 *                                     404 for a pinned tenant: the user left or
 *                                     was removed from that workspace
 *   { outcome: "rejected", status }   401: the server refused the ID token
 *   { outcome: "transient", status?, message }
 *
 * A renewal passes `org`, the current license's tenant slug. Without it the
 * server takes the first workspace the user belongs to, which could move a
 * user who was removed from one workspace into another one silently.
 */

const { getActivateUrl } = require("./config");
const { postBearerJson } = require("./http");

async function exchangeIdToken(idToken, deviceId, { org } = {}) {
  const body = { device_id: deviceId };
  if (org) body.org = org;

  let res;
  try {
    res = await postBearerJson(getActivateUrl(), idToken, body, { timeoutMs: 10_000 });
  } catch (err) {
    return { outcome: "transient", message: `network error: ${err.message}` };
  }

  if (res.status === 402 || (res.status === 404 && org)) {
    return { outcome: "revoked", status: res.status };
  }
  if (res.status === 401) return { outcome: "rejected", status: 401 };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { outcome: "transient", status: res.status, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { outcome: "transient", status: res.status, message: "invalid JSON in response" };
  }
  if (typeof payload?.token !== "string" || !payload.token) {
    return { outcome: "transient", status: res.status, message: "response missing token" };
  }
  return { outcome: "issued", token: payload.token };
}

module.exports = { exchangeIdToken };
