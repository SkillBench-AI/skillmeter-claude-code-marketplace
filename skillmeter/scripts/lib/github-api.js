/**
 * GitHub REST API client used by the sign-in flow.
 *
 * Pure HTTP — no credstore or filesystem dependencies. Callers pass the
 * caller-resolved GitHub token in; this module only knows how to ask
 * GitHub about it.
 */

/**
 * Fetch the activating user's GitHub login + every org they belong to.
 * Returns an array of lowercase logins suitable for passing to
 * `commitSignin`. Throws on any HTTP/network failure so the caller can
 * decide whether to abort.
 */
async function fetchUserGitHubOrgs(githubToken) {
  const headers = {
    "Authorization": `Bearer ${githubToken}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skillmeter-cli",
  };

  const userRes = await fetch("https://api.github.com/user", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) {
    throw new Error(`GET /user returned ${userRes.status}`);
  }
  const userBody = await userRes.json();
  const userLogin = typeof userBody?.login === "string" ? userBody.login : "";

  const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!orgsRes.ok) {
    throw new Error(`GET /user/orgs returned ${orgsRes.status}`);
  }
  const orgsBody = await orgsRes.json();
  const orgLogins = Array.isArray(orgsBody)
    ? orgsBody.map((org) => (typeof org?.login === "string" ? org.login : ""))
    : [];

  return [userLogin, ...orgLogins].filter(Boolean);
}

module.exports = {
  fetchUserGitHubOrgs,
};
