# Per-Client Sessions: a Hydra Refresh Token, with the License as a Cache

**Status:** Proposed; implemented in Codex 0.11.0 (#105). Adopts by reference
[Claude Code plugin ADR 005](../../../claude-code/docs/adr/005-per-client-session.md)
(proposed 2026-09-27; implemented in Claude 0.40.0 and 0.40.1 and verified
end to end in dev and prod). This file is the Codex design, and it is a
**full cutover**: GitHub OAuth, `gh` activation and `/refresh` are removed,
with no compatibility path.
**Amended 2026-09-28 by [ADR 006](006-per-client-consent.md):** consent and
the global pause moved from the shared `<state>/telemetry-policy.json` to
`<state>/clients/codex/telemetry-policy.json`. The file table and the global
pause section below describe the state before that change.
**Amended 2026-09-28 (internal channel, #116):** `SKILLMETER_ENV` no longer
selects the environment. The installation's channel does: the internal build
uses dev, the stable build prod. Mentions of `SKILLMETER_ENV=dev` below are
historical.

## Why a cutover, not a migration

- Claude 0.40.0 stopped writing its session to the shared
  `~/.skillbench/credentials.json`. A Codex user who relied on Claude's
  sign-in is renewing the last shared license through `/refresh`, which ends
  within seven days of its first activation.
- `/refresh` is scheduled for removal (license-activation #42). It renews a
  license from the expired license itself, with no rotation, reuse detection
  or revocation.
- The GitHub sign-in cannot stay beside the broker safely: the `gh` identity
  and the broker identity can be different people or tenants (#83), and a
  second sign-in path means a second renewal path, a second scope model and a
  second set of tests.
- A migration would carry all of that for a few weeks and then delete it. The
  cutover deletes it once. The cost is one sign-in per user, which the
  forced re-sign-in below asks for at the next session.

## Decisions

### 1. Sign-in is the broker device flow, and nothing else

- RFC 8628 against Hydra: `POST {broker}/oauth2/device/auth`, then poll
  `{broker}/oauth2/token` with the device code. Client `skillmeter-plugin`
  (the public device client Claude uses; each device grant starts its own
  refresh chain, so the two clients' sessions stay independent). Scope
  `openid offline`.
- The ID token is exchanged at `POST /activate` with `{device_id}`. The
  workspace is the one the person chose in the browser (the `workspace`
  claim); there is no `--org` argument.
- The refresh token and the license are committed together, in one write.
- The existing foreground poll (TTY) and detached background poll stay; only
  their endpoints and payload handling change. Codex has no `FileChanged`, so
  the background result is reported at the next `SessionStart`, as today.

**Removed:** the GitHub device flow and client id (`signin.js`),
`lib/github-api.js`, `trySilentGhActivate` and every `gh` call, the
`--org`/`--orgs` arguments, `SKILLMETER_GITHUB_CLIENT_ID`, and the
`github_client_id` and `activate_url` settings keys.

### 2. The session is this client's; identity and consent stay shared

| File | Holds | Shared |
|---|---|---|
| `<state>/credentials.json` | `device_id`, `hash_salt` (write-once) | Yes, with Claude and VS Code |
| `<state>/telemetry-policy.json` | Consent and the global pause (ADR 004) | Yes |
| `<state>/clients/codex/session.json` (0600) | `refresh_token`, `license_jwt`, `auth_generation`, `signed_out` | No |
| `<state>/clients/codex/license-status.json` | Renewal backoff and terminal state | No |

`<state>` is `SKILLMETER_STATE_DIR`, else `~/.skillbench-dev` when
`SKILLMETER_ENV=dev`, else `~/.skillbench`, the rule the policy file already
follows. Today `credentials.json` ignores it; after the cutover every file
here follows it, so dev and prod never share a session.

**Not `PLUGIN_DATA`.** Codex does not document that `PLUGIN_DATA` survives a
version update (installs land in
`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, see #78). A session
lost on every update would sign everyone out on every release. The state
directory is stable and already per environment.

**Removed:** `license_jwt`, `allowed_github_orgs`, `orgs_explicitly_set`,
`signed_out`, `telemetry_disabled` and `auth_generation` in the shared file;
the Keychain migration and the `.device-id`/`.hash-salt` fallback files.

**Global pause.** `telemetry_disabled` was Codex's own pause, kept in the
shared credential file and ORed with the policy's `global.enabled`. It goes:
the telemetry skill's enable and disable write `global.enabled` in the shared
policy, which is the one pause ADR 004 defines. Sign-out no longer pauses;
it signs out.

**Consent stamp.** The transcript consent stamp keeps using
`auth_generation`, read from the session. A sign-out or sign-in in Codex
still closes an interval; a sign-in in Claude no longer does, because it is
no longer the same session.

### 3. Scope comes from the license

The license's `orgs` claim lists the GitHub accounts the tenant has installed
the SkillBench app on. It replaces the GitHub `/user/orgs` lookup and
`allowed_github_orgs`:

- the allowed owners are the `orgs` claim, lower-cased;
- `SKILLMETER_REPO_SCOPE_ORGS` and the `repoScopeOrgs` project setting can
  only narrow that list, never widen it;
- a missing, empty or malformed `orgs` claim allows nothing, which is
  `not_activated`, as with no sign-in;
- `org.login` is the tenant slug, never a repository owner.

`lib/repo-scope.js` is unchanged; it receives the list.

### 4. One renewal path, single-flight

- Renewal happens only where data is sent: the detached drain and the retry
  daemon's sweeps. `SessionStart` no longer renews.
- One lock (`<state>/clients/codex/.renew.lock`) serializes every renewal on
  the machine for this client. Hydra accepts a spent refresh token once
  within 30 s and revokes the whole chain on a second use, and Codex can run
  up to eight async hooks at once, so two concurrent renewals are a real risk,
  not a theoretical one.
- Under the lock: reread the session; if the license is fresh, return it;
  otherwise run the `refresh_token` grant, store the rotated refresh token
  at once, then `POST /activate` with the new ID token and
  `org = <current license org.login>`, then store the license.
- An upload that gets 401 renews once with `force`, then retries once.

| Outcome | Result |
|---|---|
| Hydra `invalid_grant` | Keep the session, terminal `reactivation_required`; the banner asks for sign-in and the sign-in skill runs the device flow even while the license is still valid |
| `/activate` 402, or 404 for the pinned tenant | Drop the session, purge that tenant's unsent data, revoke the refresh token; terminal `revoked` |
| Network, 5xx, 401 right after the broker granted | Transient backoff; recording continues |

**Removed:** `refreshExpiredJwt`, `getRefreshUrl`, the `/refresh` fallback in
`tryRefreshLicense`, and the renewal call in `session_start.js`.

### 5. Sign-out revokes

Local first: clear the session and purge the repository and audit queues,
then revoke the refresh token at `{broker}/oauth2/revoke` with a 3 s timeout.
A failed revoke never blocks sign-out and says so. Sign-out does not run in
`SessionEnd` (1 s budget).

### 6. Existing installations: sign in again, unsent data is dropped

- The first run of the new version finds no `session.json` and treats the
  device as signed out. `SessionStart` says sign-in is required.
- Nothing is copied from the shared file. A GitHub-issued license there is
  left for other clients but never read.
- Unsent queue data recorded under the old license is deleted on that first
  run. It was recorded for a tenant chosen by GitHub sign-in, and the new
  sign-in may land in another tenant; sending it there would be wrong, and
  telling which tenant each batch was for is not worth a compatibility path.
  Consent choices and transcript cursors are kept.

### 7. Environments

`SKILLMETER_ENV=dev` switches everything together: broker
`https://id.dev.skillbench.com`, activation `https://api.dev.skillbench.com`,
and `~/.skillbench-dev`. `SKILLMETER_BROKER_URL`, `SKILLMETER_ACTIVATE_URL`
and `SKILLMETER_STATE_DIR` override individually, under the existing
HTTPS-and-trusted-domain rule. Project settings files cannot redirect
credentials anywhere.

### 8. Hooks do not change

`hooks.json` stays byte-identical. Codex trusts plugin hooks by the hash of
their definition, so any change would stop collection for every user until
they re-trust it in `/hooks`. All of the above lives in scripts the hooks
already call.

## Shared code

`lib/broker.js` (device grant, refresh grant, revoke) and
`lib/license-exchange.js` (`/activate`, pinned) are vendored from the Claude
plugin at a pinned revision, as the sanitizer is. The session contract
(`commitSignin`, `commitRotation`, `commitRefresh`, `dropSession`, `signOut`,
snapshot matching) and its tests are ported. The contract tests to port are
`hydra-renewal`, `signout-revoke`, `credential-generation` (isolation) and
`signin-session-ended`.

## Implementation plan

| PR | Change |
|---|---|
| 1 | State directory for every file; session store in `<state>/clients/codex/`; shared file reduced to identity; Keychain and fallback-file migration removed; global pause moved to the shared policy; first-run cutover (signed out, queues dropped) |
| 2 | Broker sign-in (vendored `broker.js`, `license-exchange.js`); `signin` skill rewritten; GitHub OAuth, `github-api.js`, `gh` and `--org` removed |
| 3 | Scope from the `orgs` claim; `allowed_github_orgs` and `orgs_explicitly_set` removed |
| 4 | One renewal path under the lock, 401 force, outcome mapping, sign-out revoke; `/refresh` removed from the client |
| 5 | Tests and fixtures: GitHub, `/refresh` and shared-session cases deleted; mixed-client cases rewritten to assert isolation (Claude's writer never changes this session); docs, skills and ADR mirrors updated; release as a breaking change |

The open PRs that assume the shared session (#79, #81, #83, #101) are
superseded by PR 5; #83's `orgs` intersection is kept in PR 3.

## After Codex ships

- license-activation #42 removes `/refresh`.
- The GitHub path on `/activate` stays until the VS Code extension moves to
  the broker.

## Open items

- Whether Codex should get its own OAuth client id later. Nothing here needs
  it; the login app reads a single plugin client id today.
- A verified answer on `PLUGIN_DATA` persistence (#78), which would matter
  only if the session ever moved there.
