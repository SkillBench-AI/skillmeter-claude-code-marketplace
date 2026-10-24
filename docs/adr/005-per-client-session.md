# Per-Client Sessions: a Hydra Refresh Token, with the License as a Cache

**Date:** 2026-09-27
**Status:** Proposed. Author: arcmin. Implemented and verified end to end in
dev and prod on 2026-09-27 (0.40.0, 0.40.1); see
[Verification](#verification-2026-09-27).
**Supersedes:** ADR 001 decision 1 (1-hour TTL), ADR 001 decision 5 as far as
it shares the license, and the session parts of ADR 001's amendment
"authentication intent across shared clients". ADR 004 (shared consent) was
unchanged by this ADR; ADR 006 (2026-09-28) later made consent per client too.
**Related:** `skillmeter-license-activation` (`/activate`, `/refresh`),
`skillbench-infra` (Hydra clients), `skillmeter-codex-marketplace`,
`skillmeter-vscode-extension`

## Context

### One token, two jobs

The license JWT is both the access token and the refresh credential. The
collector's API Gateway JWT authorizer accepts it for 15 minutes (the TTL is
hard-coded in `jwt.go`; decision 1's one hour was never implemented). After
that, the expired JWT itself is presented to `/refresh`, which checks only its
signature, a 7-day window from `original_iat` and, on the broker path, the
membership. There is no rotation, no reuse detection and no revocation, so a
copied `credentials.json` renews for up to seven days after sign-out. RFC 9700
(OAuth 2.0 Security BCP) asks public clients for rotation with reuse detection
or sender-constrained tokens. The design meets neither.

The broker (Ory Hydra) already issues a standard refresh token. The plugin
requests `openid offline` (`lib/config.js`) and then discards everything but
the ID token (`signin.js`).

### One file, three clients

`~/.skillbench/credentials.json` holds identity (`device_id`, `hash_salt`),
the session (`license_jwt`, `signed_out`, `auth_generation`) and, from the
Codex plugin, `telemetry_disabled`. Three clients write it:

- This plugin and the Codex plugin use the version 2 credential lock.
- The VS Code extension (`dev`) reads the file, changes it and writes it back
  without a lock or a rename. It can erase `signed_out` and `auth_generation`,
  or restore a `license_jwt` another client removed. It signs in with GitHub,
  not the broker.

Moving to Hydra refresh tokens while the session stays shared would make the
race worse. Rotation invalidates the previous refresh token, and reuse
detection revokes the whole chain when a stale one is presented. Two clients
renewing from one file would revoke each other's session.

## Decisions

### 1. The session is per client; identity and consent stay shared

| File | Location | Holds | Shared |
|---|---|---|---|
| `credentials.json` | `~/.skillbench` | `device_id`, `hash_salt` (write-once); other clients' fields are preserved | Yes |
| `telemetry-policy.json` | `~/.skillbench` | Consent (ADR 004) | Yes |
| `session.json` (0600) | `$CLAUDE_PLUGIN_DATA` | `refresh_token`, `license_jwt`, `auth_generation`, `signed_out` | No |
| `license-status.json`, `signin-result.json` | `$CLAUDE_PLUGIN_DATA` (moved) | The session's status record and sign-in sentinel | No |

This plugin stops writing session fields to the shared file at once. It
neither sets nor clears them there. A sign-in or sign-out here no longer
affects another client, and "stop everything on this machine" is the global
pause in the shared policy (ADR 004). Each client is its own OAuth client in
Hydra: this plugin keeps `skillmeter-plugin`, and Codex gets its own id when
it moves.

**Migration:** on first read without a `session.json`, the plugin copies
`signed_out` and `auth_generation` from the shared file once and leaves the
shared file as it is. It does not copy `license_jwt`: a license from before
this decision has no refresh token and cannot be renewed (decision 6), so the
user signs in again.

### 2. The refresh token is the session; the license is a cache

- **Signed in** means this client's session holds a license and is not signed
  out. A session the broker ended keeps its license until the next sign-in, so
  recording continues (ADR 001 decision 3) while transmission waits; the
  SessionStart banner asks for sign-in, and `/skillmeter:signin` runs the
  device flow even while that license is still valid.
- **Sign-in** stores the device grant's refresh token and the license from
  `/activate` in one atomic write.
- **Renewal** is one function behind the existing single-flight lock, held
  from the Hydra call to the last commit:
  1. `refresh_token` grant to Hydra;
  2. commit the rotated refresh token at once;
  3. `POST /activate` with the new ID token and `org` set to the current
     license's tenant slug;
  4. commit the license.
- The pin in step 3 matters. Without it, `/activate` picks the user's first
  active membership, so a user removed from one workspace would be moved into
  another one silently.

| Outcome | Result |
|---|---|
| Hydra `invalid_grant`, or a session without a refresh token | Keep the session; terminal `reactivation_required` |
| `/activate` 402, or 404 `workspace_not_found` for the pinned tenant | Drop the session, purge that organization's unsent data (the 402 rule of ADR 001's 2026-09-27 amendment) and revoke the refresh token; terminal `revoked` |
| `/activate` 401 right after the broker granted | Transient: a server configuration fault, not a verdict on the session |
| Network error or 5xx | Transient; the existing backoff. Recording continues (ADR 001 decision 3) |

### 3. Revocation belongs to Hydra and to the exchange

- Sign-out revokes the refresh token (RFC 7009) with a short timeout, then
  clears the session and purges as today. A failed revoke never blocks
  sign-out.
- Leaving or being removed from a workspace, or a cancelled license, surfaces
  at the next exchange as 402 or 404, so recording stops within one license
  TTL.
- There is no revocation table on our side, and no `/revoke` endpoint.

### 4. License TTL stays 15 minutes, configurable

`LICENSE_TTL_SECONDS` (default 900) replaces the hard-coded value. A longer
TTL would lengthen the window in which a removed user can still upload.
Renewal cost moves to Hydra and `/activate`, so the reason for one hour is
gone.

### 5. Hydra session lifetime: 30 days idle, 90 days absolute

`skillmeter-plugin` is a public client with the `device_code` and
`refresh_token` grants and revocation. The refresh response carries a new
`id_token`, with `auth_time` kept from the original sign-in.

| Setting | Value | Where |
|---|---|---|
| Idle lifetime | 30 days | Hydra's default `ttl.refresh_token` (720h), renewed on every rotation |
| Absolute lifetime | 90 days | Not enforced yet: `/activate` is to refuse an ID token whose `auth_time` is older |
| Rotation grace | 30 s, one reuse | `OAUTH2_GRANT_REFRESH_TOKEN_ROTATION_GRACE_PERIOD=30s`, `..._REUSE_COUNT=2` (skillbench-infra #289, #290) |

The reuse count includes the rotation itself: Hydra increments `used_times`
on every use and allows one while `used_times < count`, so `2` is one reuse
and `1` is none. Hydra's default (`0s`) revokes the whole chain on any second
use; the grace period covers a crash between receiving a rotated token and
storing it, and a second reuse still revokes the chain.

Hydra's task definitions are owned by Terraform, but `modules/ecs-service`
ignores task definition changes on the service. An apply alone does not reach
the running tasks; skillbench-infra #291 rolls a config-only revision after
the control-plane apply.

### 6. The custom refresh protocol is removed after migration

The plugin no longer calls `/refresh` (amended 2026-10-03). A session without
a refresh token records `reactivation_required`, so the SessionStart banner
asks for sign-in, and sign-in fails when the broker returns no refresh token.
The server answers `/refresh` and GitHub sign-in with 410 at an announced
deadline, once every client renews through the broker. `parseExpiredToken`,
`original_iat` and the GitHub-only server code are removed after usage stays
at zero.

## Consequences

- One session per client: a user signs in once per client.
- The standard OAuth model, as in `gcloud` and the Azure CLI: device grant
  (RFC 8628), a rotating refresh token (RFC 6749, RFC 9700), revocation
  (RFC 7009), and the exchange of an IdP token for a resource token
  (RFC 8693).
- A leaked license is usable for at most one TTL. A leaked refresh token is
  detected on reuse and can be revoked.
- The VS Code extension's unlocked writes can no longer touch this plugin's
  session.
- Every renewal depends on Hydra and on `/activate`. An outage delays
  transmission, not recording.
- `/activate` runs once per client per TTL. A failed `registerDevice` no
  longer fails the exchange.

## Implementation mapping

| Step | Repository | Change | Status |
|---|---|---|---|
| 1 | license | Client id list (`PLUGIN_OAUTH_CLIENT_IDS`); `code` in 402 and 404 bodies; `registerDevice` failure is logged, not fatal; `LICENSE_TTL_SECONDS`; no `email` claim | Done: license #41, dev and prod |
| 2a | plugin | `session.json`, migration, status record and sentinel moved | Done: #157, 0.40.0 |
| 2b–2d | plugin | `lib/broker.js` and `lib/license-exchange.js`; refresh token stored at sign-in; Hydra renewal pinned to the tenant; revoke at sign-out | Done: #158, 0.40.0 |
| — | plugin | Sign-in runs the device flow when the session ended | Done: #160, 0.40.1 |
| — | infra | Rotation grace period; roll Hydra after apply | Done: #289, #290 (dev and prod); #291 open |
| 3 | Codex, VS Code | Own session; VS Code moves to the broker and to atomic writes | Open |
| 4a | plugin | Drop the `/refresh` fallback and the license migration; sign-in requires a refresh token | This change |
| 4b | license, infra, collector | `/refresh` and GitHub sign-in return 410; remove `original_iat` and the GitHub path | Open, at the announced deadline |

## Verification (2026-09-27)

Run on `main` against dev and against prod, each in an isolated state
directory with token values hashed in the record:

| Check | Dev | Prod |
|---|---|---|
| Sign-in stores the refresh token and a license (15-minute TTL, no `email`) | ✅ | ✅ |
| Renewal rotates the refresh token and returns an `id_token`; `auth_time` is kept | ✅ | ✅ |
| Renewal `/activate` is pinned to the tenant slug; no `/refresh` call | ✅ | ✅ |
| A spent token presented once more within 30 s is accepted and the session continues | ✅ | ✅ |
| A second reuse gets `invalid_grant` and revokes the chain; the plugin reports sign-in required | ✅ | ✅ |
| After the session ended, `/skillmeter:signin` runs the device flow although the license is valid | ✅ | ✅ |
| Sign-out revokes the refresh token; the old token then gets `invalid_grant` | ✅ | ✅ |

Not verified end to end: removal from a workspace (402, or 404 for the pinned
tenant), which is covered by unit tests only.

## Open items

- The absolute 90-day lifetime (decision 5).
- An end-to-end check of removal from a workspace.
- Steps 3 and 4b. Until the server removes `/refresh`, a copied license can
  still be renewed there for up to seven days from its first activation.
- OS keychain storage for the refresh token is deferred.

## Codex client

**Codex status:** Proposed; implemented in Codex 0.11.0 (#105). Adopts by reference the decisions above
(proposed 2026-09-27; implemented in Claude 0.40.0 and 0.40.1 and verified
end to end in dev and prod). This file is the Codex design, and it is a
**full cutover**: GitHub OAuth, `gh` activation and `/refresh` are removed,
with no compatibility path.
**Amended 2026-09-28 by [ADR 006](006-per-client-consent.md#codex-client):** consent and
the global pause moved from the shared `<state>/telemetry-policy.json` to
`<state>/clients/codex/telemetry-policy.json`. The file table and the global
pause section below describe the state before that change.
**Amended 2026-09-28 (internal channel, #116):** `SKILLMETER_ENV` no longer
selects the environment. The installation's channel does: the internal build
uses dev, the stable build prod. Mentions of `SKILLMETER_ENV=dev` below are
historical.

### Why a cutover, not a migration

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

### Decisions

#### 1. Sign-in is the broker device flow, and nothing else

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

#### 2. The session is this client's; identity and consent stay shared

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

#### 3. Scope comes from the license

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

#### 4. One renewal path, single-flight

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

#### 5. Sign-out revokes

Local first: clear the session and purge the repository and audit queues,
then revoke the refresh token at `{broker}/oauth2/revoke` with a 3 s timeout.
A failed revoke never blocks sign-out and says so. Sign-out does not run in
`SessionEnd` (1 s budget).

#### 6. Existing installations: sign in again, unsent data is dropped

- The first run of the new version finds no `session.json` and treats the
  device as signed out. `SessionStart` says sign-in is required.
- Nothing is copied from the shared file. A GitHub-issued license there is
  left for other clients but never read.
- Unsent queue data recorded under the old license is deleted on that first
  run. It was recorded for a tenant chosen by GitHub sign-in, and the new
  sign-in may land in another tenant; sending it there would be wrong, and
  telling which tenant each batch was for is not worth a compatibility path.
  Consent choices and transcript cursors are kept.

#### 7. Environments

`SKILLMETER_ENV=dev` switches everything together: broker
`https://id.dev.skillbench.com`, activation `https://api.dev.skillbench.com`,
and `~/.skillbench-dev`. `SKILLMETER_BROKER_URL`, `SKILLMETER_ACTIVATE_URL`
and `SKILLMETER_STATE_DIR` override individually, under the existing
HTTPS-and-trusted-domain rule. Project settings files cannot redirect
credentials anywhere.

#### 8. Hooks do not change

`hooks.json` stays byte-identical. Codex trusts plugin hooks by the hash of
their definition, so any change would stop collection for every user until
they re-trust it in `/hooks`. All of the above lives in scripts the hooks
already call.

### Shared code

`lib/broker.js` (device grant, refresh grant, revoke) and
`lib/license-exchange.js` (`/activate`, pinned) are vendored from the Claude
plugin at a pinned revision, as the sanitizer is. The session contract
(`commitSignin`, `commitRotation`, `commitRefresh`, `dropSession`, `signOut`,
snapshot matching) and its tests are ported. The contract tests to port are
`hydra-renewal`, `signout-revoke`, `credential-generation` (isolation) and
`signin-session-ended`.

### Implementation plan

| PR | Change |
|---|---|
| 1 | State directory for every file; session store in `<state>/clients/codex/`; shared file reduced to identity; Keychain and fallback-file migration removed; global pause moved to the shared policy; first-run cutover (signed out, queues dropped) |
| 2 | Broker sign-in (vendored `broker.js`, `license-exchange.js`); `signin` skill rewritten; GitHub OAuth, `github-api.js`, `gh` and `--org` removed |
| 3 | Scope from the `orgs` claim; `allowed_github_orgs` and `orgs_explicitly_set` removed |
| 4 | One renewal path under the lock, 401 force, outcome mapping, sign-out revoke; `/refresh` removed from the client |
| 5 | Tests and fixtures: GitHub, `/refresh` and shared-session cases deleted; mixed-client cases rewritten to assert isolation (Claude's writer never changes this session); docs, skills and ADR mirrors updated; release as a breaking change |

The open PRs that assume the shared session (#79, #81, #83, #101) are
superseded by PR 5; #83's `orgs` intersection is kept in PR 3.

### After Codex ships

- license-activation #42 removes `/refresh`.
- The GitHub path on `/activate` stays until the VS Code extension moves to
  the broker.

### Open items

- Whether Codex should get its own OAuth client id later. Nothing here needs
  it; the login app reads a single plugin client id today.
- A verified answer on `PLUGIN_DATA` persistence (#78), which would matter
  only if the session ever moved there.
