# License Token Lifecycle: Lifetime, Refresh, and Recovery

**Date:** 2026-09-10
**Status:** Accepted (PR #104, merged 2026-09-10). Amended 2026-09-16: sign-in
moved off GitHub, which retires decision 4; see the
[amendment](#amendment-2026-09-16-sign-in-moves-to-the-broker-and-decision-4-is-retired)
at the end.
**Tracker:** INF-167 (2026 Q3 Production Readiness / Telemetry pipeline)
**Related:** `skillmeter-license-activation` (server-side counterpart for decision 1), `skillmeter-codex-marketplace`, `skillmeter-vscode-extension`

## Context

SkillMeter clients authenticate telemetry uploads with a license JWT minted
by the activation Lambda. The token carries the tenant meter URL in `aud`;
the tenant's API Gateway JWT authorizer validates signature, issuer,
audience, and expiry before the collector Lambda sees a request. There is no
revocation list, so `exp` is the only revocation mechanism.

### Behaviour at the original decision (2026-09-10)

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

Rationale: `exp` is the revocation latency for a cancelled license. Every
`/refresh` re-checks the organization in the database and returns 402 when
the license is gone, so a device keeps writing for at most one more hour after
cancellation instead of fifteen minutes. That is an acceptable blast radius
into the tenant's own store, and it removes the need to refresh on every Stop.

The TTL does not bound a leaked token. `/refresh` accepts an expired token
together with any `device_id` string, so a stolen token can be rotated for the
rest of its 7-day window; that horizon is set by the window, not by `exp`.
Tightening `/refresh` (for example binding it to a device claim in the token)
is a server-side change outside this ADR and is listed under open items.
Longer TTLs were rejected because cancellation latency is the one control the
TTL does provide. The TTL alone does not fix long sessions; decision 2 does.

### 2. The retry-daemon monitor refreshes the token in the background, independent of queue state

- *The re-activation half of this decision was retired by the 2026-09-16
  amendment. The cadence, the narrowing to 410/401, the backoff and the
  terminal rule all stand; what changes is that 410 and 401 now end in a
  terminal state directly instead of attempting a `gh`-backed re-activation
  first.*

On every sweep the daemon first runs the refresh path when the token is
inside the expiry skew window, then drains. The refresh step is not subject
to the adaptive drain backoff; it has its own failure backoff described
below. SessionStart keeps its refresh. The existing lock-file cooldown
remains the single-flight mechanism across concurrent sessions; a
daemon-owner lock may be added if duplicate refreshes are observed.

Failure handling:

- `/refresh` is the only call made on a routine expiry. The silent `gh`
  re-activation runs only when there is no usable token to rotate: the stored
  token is absent (decision 4), or the server rejected the token itself with
  410 (sliding window exceeded) or 401 (signature no longer valid, for
  example after a signing-key rotation). Every other refresh failure (network
  error, 404, 5xx, malformed response) is transient: the daemon keeps the
  token, backs off, and retries `/refresh`; it does not re-activate. Today
  `refreshLicense` falls through to re-activation on any failure; A2 narrows
  it to the cases above. Re-activation reads the gh CLI's stored credential
  with `gh auth token`; it never opens a browser or a device-code flow, and
  when gh is not authenticated it fails immediately.
- Consecutive refresh failures back off exponentially from the sweep interval
  up to the same 30-minute cap the drain backoff uses, and reset on the first
  success. This bounds calls to the activation Lambda and to GitHub during an
  outage.
- A 402, a gh identity mismatch (decision 4), gh not authenticated, or the
  backoff cap being reached is a terminal state for the session: the daemon
  stops retrying, writes the outcome to the local status record, and B1 shows
  the user what to do. A later SessionStart or `/skillmeter:signin` clears
  the state.

Rationale: the monitor already exists for the life of the session, and the
Codex plugin has run this pattern since skillmeter-codex-marketplace
issue `#28`. A fresh token costs nothing on the hot path; the check is a
local `exp` comparison. From the user's point of view the token stays valid
for as long as a session is open, without any action, and the user is asked
to act only when the client has stopped trying.

### 3. Hooks record while signed in, regardless of expiry; freshness is enforced at transmission

The capture gate uses "a token exists and the user has not signed out"
instead of "the token is unexpired". Drains refresh before uploading, as
they do today.

Recorded-but-unsent data is removed in these cases:

- Explicit sign-out. Today `signout.js` drops the token and purges only the
  organization-audit queue; A3 extends it to every repository queue.
- Server-reported license revocation: 402 from `/refresh` or `/activate`.
  Today 402 is handled as a generic failure with no purge; A3 adds the purge.
- Repository or organization telemetry turned off in policy. This is the
  existing `purgeDisallowedQueues` path, unchanged.
- Age. Unsent events and transcript chunks older than the 7-day refresh
  sliding window are deleted. Today unsent data is never age-deleted, which
  under this decision would mean indefinite local retention when refresh
  keeps failing. Seven days matches the point at which the token chain is
  dead anyway and re-activation is required.

Rationale: authentication is required to send, not to observe. Dropping at
record time is what turns a transient expiry into permanent data loss. The
explicit removal list keeps the local footprint bounded now that expiry no
longer stops recording.

### 4. Silent re-activation is allowed when the device has a prior sign-in and is not signed out

- *Retired by the 2026-09-16 amendment; kept for history. Silent re-activation
  needed a credential the client could read without a browser, and `gh auth
  token` was the only one. There is no longer any such credential.*

When no token is stored, the daemon and SessionStart may attempt the `gh`
re-activation if this device completed a sign-in before and `signed_out` is
not set. Otherwise the client stops and notifies the user (B1).

The prior sign-in is recorded by `commitSignin` as a marker holding the
identity the user consented to: `github_id`, the organization (`sub` and
`org.login`), and the meter audience (`aud`) from the accepted token. Before
calling `/activate`, the client reads the current gh identity and proceeds
only when its GitHub id matches the marker; after minting, the new token's
`github_id`, organization, and `aud` are all checked against the marker
before it is committed. Any mismatch discards the token, invalidates the
marker, records the outcome, and notifies the user. Sign-out clears the
marker. A tenant whose meter hostname changes therefore requires one
interactive sign-in; that is deliberate, since the destination of the data
is part of what the user consented to.

Devices that signed in before the marker existed have no marker. On upgrade,
the marker is created from the claims of the stored token at the next
successful `/refresh` or SessionStart (the token is proof of a completed
sign-in on this device). A device that has no stored token at upgrade time
cannot be recovered silently and is asked to sign in once (B1).

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
  successful token recovery (a `/refresh` rotation or a silent `/activate`),
  for at most 7 days. This is a new retention surface:
  today unsent data is never age-deleted, and sign-out and 402 do not purge
  repository queues; A3 implements all three removals.
- The daemon becomes a required component for reliability, so its failure
  has to be visible to the user (B1).
- The user needs to act only in the terminal states of decision 2: license
  revoked (402), gh identity mismatch, gh not authenticated, refresh backoff
  cap reached, a missing token on a device without a marker, or after an
  explicit sign-out.
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

- The prior-sign-in marker for decision 4 does not exist yet; A4 defines
  where it is written. Migration for devices signed in before this change is
  settled in decision 4.
- `/refresh` accepts any `device_id` with an expired token. Binding refresh to
  a device claim inside the token is a server-side follow-up for
  `skillmeter-license-activation`, tracked with A5.
- Whether a stale token should gate the exclusion-audit path the same way as
  decision 3 (follows C1, INF-171).
- The status surface hooks use to tell the user about refresh failures is
  designed in B1; this ADR only requires that refresh outcomes are written
  where hooks can read them.

## Amendment 2026-09-16: sign-in moves to the broker, and decision 4 is retired

**Tracker:** INF-220 (plugin authentication cutover), INF-112

Sign-in no longer goes through GitHub. It is the same RFC 8628 device grant,
run against SkillBench's own identity service at `id.skillbench.ai`, and the
token handed to `/activate` is an OpenID Connect ID token rather than a GitHub
access token. The reason is INF-112: `/activate` resolved a tenant through a
GitHub App installation, and nobody who onboards normally has one, so that
route could not see them at all. The broker path resolves the tenant through
workspace membership instead.

### What this changes here

**Decision 4 is retired, not re-implemented.** It rested on there being a
credential the client could turn into a licence without a browser — `gh auth
token`. The device grant has no such credential: approving it *is* opening a
browser. So the two calls that used to attempt silent re-activation are gone:

- the `/skillmeter:signin` prompt expansion no longer tries `gh` before telling
  the user how to sign in; and
- the refresh orchestrator no longer falls back to `/activate` on 410 or 401.

**410 and 401 are now terminal.** A licence that can no longer be rotated ends
the retry loop with `reactivation_required`, replacing the `gh_unauthenticated`
terminal reason, and the person runs `/skillmeter:signin`. Decisions 1, 2, 3
and 5 are unaffected: the TTL, the seven-day sliding window, the background
refresh cadence, and the record-while-signed-in rule all stand.

**The prior-sign-in marker described in decision 4 was never built** — it was
already listed under open items — and nothing now needs it. The identity it
would have pinned (`github_id`, the GitHub organization) is not what a broker
licence carries: `sub` holds the control-plane tenant id and a new `broker_sub`
claim holds the person, while `github_id` is absent rather than zero.

### Consequences of the amendment

The cost is concentrated in one place, and it is a real regression: a user with
`gh` authenticated used to cross the seven-day window without noticing. Now
that window ends in an interactive sign-in. Nothing else about the lifecycle
got worse, and everything about who *can* sign in got better.

The obvious repair is the broker's own refresh token. The device flow already
requests `offline` and the broker already issues one; the plugin discards it.
Storing it would restore silent recovery without reintroducing GitHub, and
would make the seven-day window a policy choice rather than a hard wall. That
is tracked as an open decision on INF-220, not settled here.

### Implementation mapping (amendment)

- `scripts/signin.js`, `scripts/lib/config.js` — the device grant and its
  endpoints (marketplace#112).
- `scripts/user_prompt_expansion_signin.js` — the silent attempt removed.
- `scripts/lib/license-activation.js` — `silentGhActivate` and
  `trySilentGhActivate` removed; the 410/401 branch records a terminal state.
- `scripts/lib/license-status.js` — `GH_UNAUTHENTICATED` becomes
  `REACTIVATION_REQUIRED`. Terminal reasons are only ever logged, never
  branched on, so a record written by an older build stays readable.

### Open items (amendment)

- Whether to store the broker refresh token and what that does to the
  seven-day window (INF-220 open decision 4).
- The VS Code extension still authenticates with GitHub and is on its own
  track behind INF-200.
- `/activate` still accepts GitHub tokens, deliberately, until deployed
  plugins stop sending them.


## Amendment: Stop-triggered recovery without a monitor

Stop requests the existing detached `drain_once.js` worker when its repository
allows transmission and the token is expired or within the monitor's look-ahead
window. This request does not depend on queued data. The hook performs no network
I/O; the worker rechecks sign-out, token presence, consent, terminal state and
backoff before refreshing, then drains the queues. The existing drain lock and
refresh single-flight controls apply.

This supplements decision 2 when the session has no running retry monitor.
Recovery makes later hooks eligible to capture; it does not replay turns skipped
while the token was expired. It does not create a sign-in, bypass disabled
telemetry, change token lifetime, or rearm terminal 401/402/410 outcomes.

Implementation: `scripts/lib/hook-license-recovery.js`, `scripts/stop.js` and
`scripts/drain_once.js`. Run `node --test skillmeter/test/expiry-recovery.test.js`
from the repository root. The suite covers empty-queue recovery, consent and
terminal boundaries, and a real detached child that persists a synthetic refresh
after Stop exits. Its clock and network are substituted; it does not use live
authentication or production telemetry.
