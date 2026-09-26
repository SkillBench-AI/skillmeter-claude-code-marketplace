/**
 * The OAuth client for the broker (Ory Hydra): the device grant that signs in,
 * the refresh token grant that renews, and revocation at sign-out (ADR 005).
 *
 * The refresh token is this client's session. It never appears in a log line,
 * an error message or a thrown error, all of which can end up in a terminal
 * or a diagnostics file.
 */

const {
  getDeviceCodeUrl,
  getTokenUrl,
  getRevokeUrl,
  getOAuthClientId,
  OAUTH_SCOPE,
} = require("./config");
const { brokerReason } = require("./http");

async function postFormRaw(url, params, { timeoutMs = 10_000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { res, payload, text };
}

async function postForm(url, params) {
  const { res, payload, text } = await postFormRaw(url, params);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${text}`);
  }
  return payload;
}

// OAuth pending/slow_down responses can use HTTP 400. Parse their error body
// before treating a non-2xx response as a transport failure.
async function postFormExpectingOAuthErrors(url, params) {
  const { res, payload, text } = await postFormRaw(url, params);
  if (payload && typeof payload === "object") return payload;
  throw new Error(`${url} returned ${res.status}: ${text}`);
}

async function requestDeviceCode() {
  return postForm(getDeviceCodeUrl(), { client_id: getOAuthClientId(), scope: OAUTH_SCOPE });
}

// Poll using the device grant and respect pending, slow_down and expiry.
// Return the ID token, which /activate verifies through the broker JWKS
// (opaque access tokens cannot be used for that exchange), and the refresh
// token, which renews the license from then on. The refresh token is absent
// when the broker does not grant `offline`; renewal then falls back to /refresh.
async function pollDeviceToken(deviceCode, initialInterval) {
  let interval = initialInterval;
  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const payload = await postFormExpectingOAuthErrors(getTokenUrl(), {
      client_id: getOAuthClientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (payload.id_token) {
      return {
        idToken: payload.id_token,
        refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
      };
    }
    if (payload.access_token && !payload.id_token) {
      throw new Error("Sign-in returned no id_token — the `openid` scope was not granted.");
    }

    switch (payload.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      // Keeps its own sentence. The broker does not write this one — Hydra
      // does, and its description says less than the next action does.
      case "expired_token":
        throw new Error("The code expired. Run /skillmeter:signin again.");

      // WHERE THE ONLY EXPLANATION LIVES. Every refusal the broker makes comes
      // back as this one code, and what distinguishes them is the description
      // beside it. Thrown from here it travels the whole way on both surfaces
      // with no further plumbing: the foreground prints `err.message`, and the
      // background writes it into signin-result.json, which the FileChanged
      // hook turns into a systemMessage.
      case "access_denied":
        throw new Error(brokerReason(payload) ?? "Sign-in was denied. Aborting.");

      // Same courtesy for a code we do not know: if the server troubled itself
      // to say why, that beats repeating the code back at the person.
      default:
        throw new Error(
          brokerReason(payload) ??
            `Sign-in failed: ${payload.error || "unknown error"}`,
        );
    }
  }
}

/**
 * Renew with the refresh token grant. Never throws.
 *
 *   { outcome: "granted", idToken, refreshToken }  refreshToken is the rotated
 *                                                  one, or the same when the
 *                                                  broker does not rotate
 *   { outcome: "rejected", status, error }         the session is over
 *                                                  (invalid_grant: expired,
 *                                                  revoked, reuse detected)
 *   { outcome: "transient", status?, message }     network, 5xx, bad body
 */
async function refreshGrant(refreshToken) {
  let result;
  try {
    result = await postFormRaw(getTokenUrl(), {
      client_id: getOAuthClientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  } catch (err) {
    return { outcome: "transient", message: `network error: ${err.message}` };
  }
  const { res, payload } = result;
  const error = payload && typeof payload.error === "string" ? payload.error : null;
  // RFC 6749 5.2: an unusable grant is 400 invalid_grant; a client the broker
  // no longer accepts is 401 invalid_client. Neither improves with retrying.
  if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client") {
    return { outcome: "rejected", status: res.status, error };
  }
  if (!res.ok) {
    return { outcome: "transient", status: res.status, message: `HTTP ${res.status}${error ? ` (${error})` : ""}` };
  }
  if (!payload || typeof payload.id_token !== "string") {
    return { outcome: "transient", status: res.status, message: "refresh response has no id_token" };
  }
  return {
    outcome: "granted",
    idToken: payload.id_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
  };
}

/**
 * RFC 7009 revocation, best-effort: a failure never blocks what called it.
 * Returns true when the broker confirmed (RFC 7009 answers 200 even for an
 * unknown token).
 */
async function revoke(refreshToken, { timeoutMs = 3000 } = {}) {
  if (!refreshToken) return false;
  try {
    const { res } = await postFormRaw(getRevokeUrl(), {
      client_id: getOAuthClientId(),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }, { timeoutMs });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  requestDeviceCode,
  pollDeviceToken,
  refreshGrant,
  revoke,
};
