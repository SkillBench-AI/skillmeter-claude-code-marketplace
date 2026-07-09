/**
 * Small HTTP helpers shared by the activation / refresh / sign-in exchanges.
 * Leaf module — uses only global `fetch`/`AbortSignal`, nothing plugin-side.
 */

/**
 * POST a JSON body with a `Bearer <token>` Authorization header and a timeout.
 *
 * Returns the raw Response; callers own the status-code branching and body
 * parsing because those genuinely differ (some return null + log, others
 * throw, with per-status special cases like 402/410/404). Throws on network
 * error / timeout — callers that need graceful degradation wrap in try/catch.
 *
 * @param {string} url
 * @param {string} bearer         token for the Authorization header
 * @param {object} body           JSON-serializable request body
 * @param {object} opts
 * @param {number} opts.timeoutMs abort after this many ms
 * @returns {Promise<Response>}
 */
function postBearerJson(url, bearer, body, { timeoutMs }) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

module.exports = { postBearerJson };
