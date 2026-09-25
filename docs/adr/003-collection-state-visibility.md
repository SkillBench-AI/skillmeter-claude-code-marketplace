# Collection State Visibility: Notices, Monitor Lifecycle, and the Local Status Record

**Date:** 2026-09-14
**Status:** Proposed. Revised 2026-09-25 against `main` (0.37.0): the backfill
monitor is gone, sign-in is broker-only and ADR 001 decision 4 is retired,
Stop-triggered recovery exists, and the review threads of 2026-09-17 are
folded in.
**Tracker:** INF-174 (B1), with INF-179 (B3), INF-178 (B2), INF-180 (B4) and INF-200 (2026 Q3 Production Readiness / Telemetry observability & transparency)
**Related:** ADR 001 (decision 2, its Stop-recovery amendment and the local status record it requires; decision 4 is retired by the 2026-09-16 amendment), `skillmeter-codex-marketplace`, `skillmeter-vscode-extension` (parity, INF-177)

## Context

The plugin can stop collecting for reasons the user never chose: the license
token is removed from the shared credential file by another client, the
background refresh reaches a terminal failure, or the user signed out in one
session and forgot. Today nothing in the Claude Code UI says so. Between
2026-09-11 and 2026-09-13 four of the six devices producing real events lost
their token this way (the September sign-out incident) and ran silently for one to three days, including
the maintainer's own device. The gap was found by reading server logs, not by
anything the plugin showed.

### Current behaviour (as-is)

What the user can see:

- **SessionStart banner.** `scripts/session_start.js` prints one boxed card
  through `systemMessage`: "sign in required", "telemetry choice required", or
  "telemetry on". It runs once per session and does not say *why* sign-in is
  required (never signed in, signed out, token removed, refresh failed all
  look the same).
- **Sign-in result notice.** SessionStart registers
  `~/.skillbench/signin-result.json` in `hookSpecificOutput.watchPaths`; the
  FileChanged hook `scripts/on_signin_result.js` turns a finished sign-in into
  a one-line `systemMessage` plus an OSC 777 desktop notification, deduplicated
  by the result timestamp. This is the only mid-session channel that reaches
  the user today, and it fires only for sign-in.
- **Skip reasons.** Every capture hook logs
  `[skillmeter] <Hook>: skipped (not signed in)` to stderr. Claude Code shows
  hook stderr only in the debug log, so the user never sees it.
- **Monitor panel.** `monitors/monitors.json` declares one monitor,
  `skillmeter-retry-daemon` ("SkillMeter telemetry sync"); the backfill
  monitor was removed in 0.37.0. The task panel shows it as running for as
  long as the process lives. The description is static; there is no way to
  attach a status text. "Running" therefore means "the sync loop is alive",
  not "telemetry is being collected", and it stayed "running" on every
  affected device in that incident.

What the plugin records:

- `~/.skillbench/license-status.json` (ADR 001, A2) holds
  `last_attempt_at`, `last_success_at`, `last_outcome`, `last_error`,
  `consecutive_failures`, `next_retry_at`, `terminal {reason, at, ...}`,
  `updated_by`, `revision`. Terminal reasons are `revoked` (402),
  `reactivation_required` (401 or 410) and `backoff_exhausted`.
- The retry daemon (`scripts/monitors/retry_daemon.js`) checks the token every
  sweep. When no token is stored, `refreshLicense` returns before recording
  anything ("must never create a brand-new sign-in before the user invokes
  `/skillmeter:signin`"). The record therefore freezes at the last success and
  `/skillmeter:telemetry status` has nothing newer to show. On the
  maintainer's device the record still said "rotated, 0 failures" three days
  after the token was gone.
- Since 0.37.0 the Stop hook asks the detached drain worker to refresh when
  the token is expired or near expiry, even with an empty queue (ADR 001,
  Stop-recovery amendment). That covers a session without a running monitor.
  It does not create a sign-in, so a missing token still stops everything.
- `credentials.json` carries `signed_out: true` only when the user ran
  `/skillmeter:signout`. A token that disappears without that flag is the
  signature of an external removal.

What Claude Code allows (documented behaviour, v2.1.x):

- Hook JSON `systemMessage` is shown to the user as a line in the chat. It is
  not a dialog, does not block input, and scrolls with the transcript.
  SessionStart plain stdout is additionally added to the model's context.
- Hooks configured with `async: true` have their JSON output discarded. In
  this plugin every capture hook is async; the synchronous hooks are
  SessionStart, FileChanged, UserPromptExpansion (slash commands only) and
  SessionEnd. Mid-session, FileChanged is the only synchronous channel that
  fires without user input.
- `watchPaths` accepts several absolute paths; the existing sign-in watcher
  proves a file under the home directory works.
- A monitor runs for the life of the session. Its stdout lines are delivered
  to Claude as notifications, not shown to the user directly; its exit ends
  the task-panel entry. Monitors start at session start, on
  `/reload-plugins`, or when the skill named in `"when":
  "on-skill-invoke:<skill>"` is dispatched.

### Observed problems

1. A device can run signed out indefinitely with every hook skipping and no
   visible sign. Long-lived sessions never see the SessionStart banner again.
2. The one existing sign-in card cannot tell the user what to do, because it
   does not know why the token is missing.
3. The monitor panel says "running" while collection is stopped, which reads
   as "working" to anyone who checks it.
4. The status record stops updating exactly when it is needed most (no
   token), so a status command built on it would report stale success.

## Decisions

### 1. One local state resolver, no network in hooks

Collection state is a small enumeration computed from local files only and
exposed by one module (`scripts/lib/collection-state.js`) that the banner,
the notice handler, the status command and the daemon all use:

| State | Meaning | Source |
| --- | --- | --- |
| `paused` | global kill-switch on | `telemetry-policy.json` |
| `signed_out` | `signed_out: true` (user ran `/skillmeter:signout`) | `credentials.json` |
| `never_signed_in` | no `license_jwt`, no `signed_out`, and no evidence of a prior sign-in on this device | `credentials.json`, `license-status.json` |
| `token_missing` | no `license_jwt`, no `signed_out`, and evidence of a prior sign-in | `credentials.json`, `license-status.json` |
| `revoked` | `terminal.reason = revoked` in the status record (402: the organization license is inactive) | `license-status.json` |
| `delivery_paused` | a token is still stored and the status record is terminal for `reactivation_required` or `backoff_exhausted` | `credentials.json`, `license-status.json` |
| `unconfigured` | signed in, organization or repository choice pending, or repository off | `telemetry-policy.json`, repo scope |
| `recording` | signed in, gate open for the current repository | `credentials.json`, `telemetry-policy.json` |

The states are evaluated in the order of the table and the first match wins,
so one set of local inputs always resolves to one state. `paused` is listed
first because the kill-switch is the user's explicit choice and silences
every other reading; `signed_out` precedes `token_missing` for the same
reason.

Three groups follow from the table:

- **Capture stopped**: `signed_out`, `token_missing`, `revoked`. Capture
  authorization is gone; hooks record nothing. These are the states this ADR
  announces.
- **Delivery paused**: `delivery_paused`. The token is still on disk, so under
  ADR 001 decision 3 hooks keep recording locally and uploads wait; only the
  refresh has given up and the user must act. Until A3 (A3) ships, hooks
  also skip while the stored token is expired, so in that window this state
  under-reports the loss. The wording stays, because the next action is the
  same either way.
- **Healthy or user-chosen**: `recording`, `paused`, `unconfigured`,
  `never_signed_in`. No notice; the SessionStart card covers them.

The resolver reports; it never gates. Capture stays decided by
`resolveTelemetryGate` and ADR 001 decision 3 (token presence, not
freshness), so this ADR cannot reintroduce the data gap ADR 001 closed.

"Evidence of a prior sign-in" is a non-null `last_success_at` in the status
record. ADR 001 decision 4 (silent re-activation and its marker) is retired,
so there is no other source. A device without it is a fresh install and is
asked to sign in by the card, not by a notice.

The daemon records `token_missing` in `license-status.json` instead of
returning silently. `credentials.json` and the resolver define the current
state; the status record is the record of the last refresh attempt. It can
lag an external credential change by up to one daemon sweep, after which the
daemon reconciles it, and it is the input for `revoked` and
`delivery_paused`. This is the "written where hooks can read them"
requirement ADR 001 left to B1.

### 2. Transition notices: one line when collection stops, one when it resumes, nothing in between

SessionStart registers `credentials.json` and `license-status.json` in
`watchPaths` next to `signin-result.json`. A FileChanged handler
(`scripts/on_collection_state.js`) recomputes the state and emits a
`systemMessage` plus the same OSC 777 desktop notification the sign-in notice
uses, only when the state enters or leaves the capture-stopped group or
`delivery_paused`. These states live at the device level (the token, not the
repository), so the lines say so and never claim that this repository was
recording:

- into `signed_out`, `token_missing` or `revoked`: `✗ SkillMeter · <reason> · telemetry cannot be collected on this device · run /skillmeter:signin`
- into `delivery_paused`: `✗ SkillMeter · <reason> · uploads paused on this device · run /skillmeter:signin`
- leaving those states, whatever the destination (`recording` and
  `unconfigured` alike): `✓ SkillMeter · signed in · telemetry can be collected on this device`

The return line fires on leaving the group, not on reaching `recording`, so a
user who was told that collection stopped is always told when the device is
usable again, including the common `token_missing → unconfigured` path after
a sign-in in a repository that was never enabled. Whether this repository
records is the SessionStart card's and the status command's job. The return
line is the one exemption from the wording rule in decision 5: it carries the
state and no next command, because there is none.

There are no periodic reminders. A stopped state stays visible through the
SessionStart card of the next session (decision 4) and
`/skillmeter:telemetry status` (decision 6). Neither reaches the session
where the line has scrolled away, so observed problem 1 is only partly closed
here: the in-session persistent indicator is B4, and this ADR treats it as
the other half of the fix, not a deferral (see Consequences). The monitor's exit (decision 3) is a moment signal, not a
persistent surface: the task panel stops saying "running" and Claude receives
the reason; whether the panel keeps an ended entry is a Claude Code detail
the design does not depend on. Healthy state is silent.

Deduplication is per session and per state (a marker keyed by the hook's
`session_id`), so every open session shows the line once and the daemon's
routine rewrite of `credentials.json` on each refresh produces nothing.
`signed_out` counts as a stop for every open session; the session that ran
`/skillmeter:signout` sees the command's own output and the line, which is
acceptable.

Rationale: the requirement is that a user who is present notices, and that
the notice does not compete with their work. A transition is the only moment
that carries new information; repeating it adds noise without adding a
signal, and the persistent surfaces cover the case where the transition line
has scrolled away.

### 3. The sync monitor exits only when the credential file says the user must act

The retry daemon keeps running through transient failures, backoff, expiry
and the global kill-switch, exactly as ADR 001 decision 2 describes. It exits
on `signed_out` and `token_missing`. Both are read from `credentials.json`,
which any client's sign-in rewrites, so a later restore is seen by the
FileChanged handler and by the next daemon without this process. Before
exiting it writes the status record and prints one stdout line naming the
state and `/skillmeter:signin`, so the task panel stops showing "running"
and Claude receives the reason as a monitor notification.

It does not exit on `revoked` or `delivery_paused`. Those are read from
`license-status.json`, and within a session that record is reconciled only by
the daemon's own sweep; a daemon that exited on them would remove the one
process able to notice another client restoring the licence, and the stopped
state would stick until the next session. The daemon prints the stopped line
once, keeps sweeping at the 30-minute backoff cap, and clears the state when
a refresh succeeds again. Silent re-activation is retired with ADR 001
decision 4, so `token_missing` leads straight to the stopped state.

Two guards keep that exit from racing a sign-in. `/skillmeter:signin` writes
a `pending` result to `signin-result.json` when it starts the device flow,
and the daemon does not exit on `token_missing` while a pending result
younger than the device-code lifetime (15 minutes) exists; the poller's final
result (success, failure or discarded) ends the wait, and the sign-in notice
handler ignores `pending`. Independently, a daemon never exits on
`token_missing` during its first 15 minutes, so a monitor started by the
sign-in skill outlives the broker approval even if the sentinel is missing.

Restart is bound to the user's action: `monitors/monitors.json` gains a
second entry for the same daemon with `"when": "on-skill-invoke:signin"`, so
`/skillmeter:signin` brings the sync loop back in the session where it was
run. The dispatch happens when the sign-in starts, before a token exists,
which is why the guards above are part of this decision; the token the
poller writes is picked up on the daemon's next sweep. New sessions start
the daemon as today. The existing refresh lock keeps concurrent daemons from
duplicating work, so an overlap between the `always` and the
`on-skill-invoke` instance is harmless. Whether `on-skill-invoke:signin`
resolves to the plugin's skill is verified in the B1 pull request; if it does
not, recovery in that session relies on the Stop-triggered drain worker, which
refreshes and uploads without a monitor, and the next session starts a daemon
as usual.

Rationale: a process that can neither refresh nor upload has nothing to
monitor, and its exit is the one moment signal the task panel can give. The
panel is still not a collection indicator: the daemon stays alive through the
kill-switch, `unconfigured`, `revoked` and `delivery_paused`, so "running"
reads as "the sync loop is alive" and nothing more. The monitor's description
therefore becomes "SkillMeter sync loop" unconditionally, and the indicator
that says whether this repository records is B4. Draining a queue that was
filled before the stop resumes with the next live daemon or with the
Stop-triggered worker.

### 4. The SessionStart card names the reason

The "sign in required" card uses the same resolver and adds one line for the
state: not signed in, signed out, license token missing, organization license
inactive, or uploads paused with its terminal reason. Wording follows the
table in decision 5. The "telemetry on"
card is unchanged.

### 5. Wording rules

Every notice and card line is plain text, one line, and consists of a state,
a reason and one next command; the resume line of decision 2 is the only
exemption. No line contains paths, tokens, device ids, or the name of another
client. The reasons known today:

| Reason | Text |
| --- | --- |
| `never_signed_in` | `not signed in` (card only, no notice) |
| `token_missing` | `license token missing` |
| `signed_out` | `signed out` |
| `revoked` | `organization license inactive` |
| `reactivation_required` | `sign-in expired` |
| `backoff_exhausted` | `license refresh failed repeatedly` |

The next command is `/skillmeter:signin` in every case; `revoked` adds
"contact your administrator". This table is the B2 (B2) deliverable;
new terminal reasons must add a row here.

### 6. `/skillmeter:telemetry status` is the on-demand view of the same state

The existing status command reads the resolver and the status record and adds
recency (last upload, unsent counts). Its content is specified in B3 and not
repeated here; this ADR only fixes that it shows the same state names and
reasons as decisions 1 and 5. There is no separate `/skillmeter:status`.

## Consequences

- A present user learns within seconds that collection stopped and what to
  run; an absent user learns at the next session start or by looking at the
  task panel. Neither path repeats itself.
- The status record is always current, which makes the status command and the
  operator-side checks trustworthy without server access.
- `credentials.json` changes on every refresh, so FileChanged fires roughly
  every ten minutes per open session while signed in. The handler reads two
  small files and compares a marker; there is no network call and no output
  in the healthy state.
- When the daemon has exited, queued events and transcript chunks wait until
  a daemon is alive again or the Stop hook's detached worker runs: after
  `/skillmeter:signin` in that session, in any other open session, or at the
  next session start. Nothing is lost; the 7-day age bound of ADR 001 still
  applies.
- Observed problem 1 is closed in-session only for a user who sees the
  transition line. B4, a persistent indicator, is the other half and is a
  dependency of calling problem 1 solved.
- Several open sessions each show the transition once. That is intended: the
  user may be looking at any of them.
- Users on plugin versions before this change see nothing new until they
  update and start a new session. The rollout note asks for update, new
  session and sign-in in one step.
- The Codex plugin and the VS Code extension are expected to follow the same
  state names and the "no deletion on a local check" rule that the September sign-out incident
  records; parity is tracked with the other client-parity work.

## Implementation mapping

| Decision | Issue |
| --- | --- |
| 1, 2, 3, 4 | B1 |
| 5 | B2, folded into B1 |
| 6 | B3 |
| persistent indicator (status line), the other half of problem 1 | B4 |

## Open items

- Two Claude Code behaviours are documented only in outline and are verified
  in the B1 pull request before merge: how the task panel renders a monitor
  that exited, and whether `on-skill-invoke:signin` resolves to the plugin's
  `skillmeter:signin` skill. The "sync loop" rename does not depend on the
  answer.
- The `pending` sign-in sentinel does not exist yet; B1 adds it to
  `signin.js`.
- Whether the idle sweep on `revoked` and `delivery_paused` should slow beyond
  the 30-minute cap; the cost today is one refresh call per sweep.
- Whether `recording resumed` should also be shown when the token was restored
  by another client or session rather than by `/skillmeter:signin` in this
  one. The current answer is yes, since the resolver only sees the file.
- The shared-credential ownership rule (which client may delete the token, and
  under which server responses) is decided with the shared-credential and client-parity work, not here.
