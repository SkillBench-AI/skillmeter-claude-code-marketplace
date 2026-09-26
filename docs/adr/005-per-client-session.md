# Per-Client Sessions: a Hydra Refresh Token, with the License as a Cache

**Date:** 2026-09-27
**Status:** Proposed. Author: arcmin.
**Supersedes:** ADR 001 decision 1 (1-hour TTL), ADR 001 decision 5 as far as
it shares the license, and the session parts of ADR 001's amendment
"authentication intent across shared clients". ADR 004 (shared consent) is
unchanged.
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
`license_jwt` and `signed_out` from the shared file once and leaves the shared
file as it is. That session has no refresh token and renews through
`/refresh` until the next sign-in. A Codex user who relied on this plugin's
sign-in keeps renewing the last shared JWT through `/refresh` until its 7-day
window ends, then signs in to Codex.

### 2. The refresh token is the session; the license is a cache

- **Signed in** means this client's session holds a refresh token (during
  migration, a license) and is not signed out.
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
| Hydra `invalid_grant`; legacy `/refresh` 401 or 410 | Drop the session; terminal `reactivation_required` |
| `/activate` 402, or 404 `membership_removed` for the pinned tenant | Drop the session and purge that organization's unsent data (the 402 rule of ADR 001's 2026-09-27 amendment); terminal `revoked` |
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
`refresh_token` grants and revocation. Refresh tokens rotate with a grace
period of 30 to 60 seconds, covering a crash between receiving a rotated
token and storing it. The refresh response must carry a new `id_token`. These
settings live in `skillbench-infra`.

### 6. The custom refresh protocol is removed after migration

`/refresh`, `parseExpiredToken`, `original_iat` and the plugin's fallback are
removed once the server sees no `/refresh` calls for 14 days. The GitHub
sign-in path goes when the VS Code extension moves to the broker.

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
- `/activate` runs once per client per TTL, as `/refresh` does today. A
  failed `registerDevice` no longer fails the exchange.

## Implementation mapping

| Step | Repository | Change |
|---|---|---|
| 1 | license | Client id list (`PLUGIN_OAUTH_CLIENT_IDS`); `code` in 402 and 404 bodies; `registerDevice` failure is logged, not fatal; `LICENSE_TTL_SECONDS`; no `email` claim |
| 2a | plugin | `session.json`, migration, status record and sentinel moved |
| 2b | plugin | `lib/broker.js` and `lib/license-exchange.js` extracted from `signin.js` |
| 2c | plugin | Store the refresh token at sign-in; Hydra renewal pinned to the tenant |
| 2d | plugin | Revoke at sign-out; release |
| 3 | Codex, VS Code | Own client id and session; VS Code moves to the broker and to atomic writes |
| 4 | all | Remove `/refresh`, `original_iat`, the fallback and the GitHub path |

## Open items

- Hydra configuration has to be confirmed in `skillbench-infra`: grant types,
  rotation grace period, lifetimes, and the `id_token` on refresh.
- OS keychain storage for the refresh token is deferred.
