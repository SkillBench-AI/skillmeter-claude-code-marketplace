# License Token Lifecycle: Lifetime, Refresh, and Recovery

**Date:** 2026-09-10
**Status:** Proposed (under review in PR #104)
**Tracker:** INF-167 (2026 Q3 Production Readiness / Telemetry pipeline)
**Related:** `skillmeter-license-activation` (server-side counterpart for decision 1), `skillmeter-codex-marketplace`, `skillmeter-vscode-extension`

## Context

SkillMeter clients authenticate telemetry uploads with a license JWT minted
by the activation Lambda. The token carries the tenant meter URL in `aud`;
the tenant's API Gateway JWT authorizer validates signature, issuer,
audience, and expiry before the collector Lambda sees a request. There is no
revocation list, so `exp` is the only revocation mechanism.

### Current behaviour (as-is)

Server (`skillmeter-license-activation`):

- `POST /activate` exchanges a GitHub token for a license JWT. The TTL is
  15 minutes, hard-coded in `jwt.go`.
- `POST /refresh` rotates an existing token without a GitHub round-trip; an
  expired token is acceptable input. It re-checks that the organization is
  still licensed and enforces a 7-day sliding window from `original_iat`.
  Past the window it returns 410 and the client must re-activate. The window
  is configurable through an environment variable; the TTL is not.

Claude Code plugin (this repository):

- The client treats a token as expired 5 minutes before `exp`
  (`LICENSE_EXPIRY_SKEW_SECONDS`), so a 15-minute token is usable for about
  10 minutes.
- Refresh is attempted in exactly three places: `prepareSession` in the
  SessionStart hook, and the two queue drains (`drainFailedLogs`,
  `drainDeltaChunks`). Both drains return before refreshing when their queue
  is empty.
- The retry-daemon monitor (`scripts/monitors/retry_daemon.js`) runs for the
  life of the session and sweeps every 2 minutes, backing off to 30 minutes
  when the queue does not shrink. It only calls the drains, so it never
  refreshes on an empty queue.
- Every hook checks `hasValidLicense()` first. When the token is expired the
  hook records nothing and writes `skipped (not signed in)` to stderr.
- `refreshLicense` returns without a network call when no token is stored or
  when `signed_out` is set. A brand-new sign-in is created only by
  `/skillmeter:signin`.
- On 410 or any other refresh failure the client falls back to a silent
  `gh auth token` → `/activate` re-activation (`trySilentGhActivate`).
- Single-flight is a lock file (`.license-refresh.lock`) with a 60-second
  cooldown. There is no forced refresh path.

### Observed effect

The refresh trigger depends on queued data, and queued data depends on a
fresh token. Once a token expires mid-session nothing is recorded, so nothing
is drained, so nothing is refreshed. The session stays dark until the next
SessionStart.

Measured on one opted-in repository session (2026-08-24 to 2026-09-07): 52
hook events recorded, 728 skipped. Across production, the device behind this
investigation refreshed 4 times in 30 days while other devices refreshed 500
to 800 times; those devices stay alive only because per-hook exclusion audit
events keep their drains non-empty. A device whose stored token disappears
(observed 2026-09-10 after a sign-out followed by an unfinished sign-in)
never recovers on its own, and the user is not told.

## Decisions

### 1. Token TTL becomes 1 hour; the 7-day sliding window stays

The activation Lambda reads the TTL from an environment variable (default
3600 seconds) and applies it to tokens from both `/activate` and `/refresh`.
The sliding window is unchanged.

Rationale: `exp` is the revocation latency. One hour bounds a cancelled
license or a leaked token to at most an hour of telemetry writes into the
tenant's own store, which is an acceptable blast radius, while removing the
need to refresh on every Stop. Longer values were rejected because the window
is the only revocation control. The TTL alone does not fix long sessions;
decision 2 does.

### 2. The retry-daemon monitor refreshes the token in the background, independent of queue state

On every sweep the daemon first runs the refresh path when the token is
inside the expiry skew window, then drains. The refresh step runs on every
tick regardless of the adaptive drain backoff. SessionStart keeps its
refresh. The existing lock-file cooldown remains the single-flight mechanism
across concurrent sessions; a daemon-owner lock may be added if duplicate
refreshes are observed.

Rationale: the monitor already exists for the life of the session, and the
Codex plugin has run this exact pattern since skillmeter-codex-marketplace
#28. A fresh token costs nothing on the hot path; the check is a local `exp`
comparison. From the user's point of view the token stays valid for as long
as a session is open, without any action.

### 3. Hooks record while signed in, regardless of expiry; freshness is enforced at transmission

The capture gate uses "a token exists and the user has not signed out"
instead of "the token is unexpired". Drains refresh before uploading, as
they do today. Recorded-but-unsent data is discarded only on explicit
sign-out or when the server reports the license as revoked (402); the
existing purge path handles both.

Rationale: authentication is required to send, not to observe. Dropping at
record time is what turns a transient expiry into permanent data loss.

### 4. Silent re-activation is allowed when the device has a prior sign-in and is not signed out

When no token is stored, the daemon and SessionStart may attempt the `gh`
re-activation if this device completed a sign-in before (a local marker
written by `commitSignin`) and `signed_out` is not set. Otherwise the client
stops and notifies the user (B1).

Rationale: the current rule exists so the plugin never signs a user in
without consent. A completed sign-in on the same device is that consent, and
an explicit sign-out (`signed_out`) still blocks re-activation, so the rule
only recovers the accidental case where the stored token is gone. Decision 3
alone does not cover this case: with no token the capture gate stays closed
and there is nothing to refresh. The Codex plugin already re-activates without
a stored token.

### 5. All three clients follow decisions 2 to 4

The Codex plugin already implements decision 2; decisions 3 and 4 are
checked against it and against the VS Code extension's auth service (A6).

## Consequences

- Revocation latency rises from 15 minutes to 1 hour.
- Refresh traffic drops from roughly one call per Stop per active device to
  about one per hour per device.
- Long-lived sessions keep recording; the recorded-versus-skipped gap
  disappears and becomes measurable.
- Events recorded during a stale window are held locally until the next
  successful refresh. Retention of unsent local data is bounded by the
  existing queue cleanup rules; no new retention surface is introduced.
- The daemon becomes a required component for reliability, so its failure
  has to be visible to the user (B1).
- The user needs to act only when both `/refresh` and the silent
  re-activation fail, or after an explicit sign-out.
- Rollout order: client changes first (they work with the 15-minute TTL),
  then the server TTL.

## Implementation mapping

| Decision | Issue |
| --- | --- |
| 1 | A5 (server TTL), with a linked ADR in `skillmeter-license-activation` |
| 2 | A2 (background refresh) |
| 3 | A3 (INF-170) |
| 4 | A4 (recovery without a stored token) |
| 5 | A6 (Codex plugin and VS Code extension) |

## Open items

- The prior-sign-in marker for decision 4 does not exist yet; A4 defines where it is written and how devices signed in before this change are treated.
- Whether a stale token should gate the exclusion-audit path the same way as
  decision 3 (follows C1, INF-171).
- The status surface hooks use to tell the user about refresh failures is
  designed in B1; this ADR only requires that refresh outcomes are written
  where hooks can read them.
