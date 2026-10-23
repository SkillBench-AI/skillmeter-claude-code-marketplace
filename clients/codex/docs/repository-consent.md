# Repository capture consent

Codex keeps its own consent record,
`<state>/clients/codex/telemetry-policy.json`, as decided in
[ADR 006](../../claude-code/docs/adr/006-per-client-consent.md).
It never reads the Claude plugin's record. An allowed GitHub owner makes a
repository eligible; consent remains separate. Capture needs organization and
repository ON in the Codex record, both at `consent_version: 2` (recorded with
the scope acknowledgement). No record, or a missing choice, grants nothing.

| Boundary | Codex behavior |
| --- | --- |
| Organization and repository choices | `consent-preview` shows the choices and local restrictions; `consent-set` writes an explicit organization or repository choice with expected revision and ON acknowledgement. Repository ON requires organization ON. |
| Local settings | `.codex/settings.local.json` only restricts: local OFF or invalid settings block even an acknowledged grant; local ON grants nothing. |
| Subdirectories and identity | A descendant OFF remains restrictive. Clones/worktrees use canonical GitHub identity. Nested repositories are independent. |
| Organization scope | Organization ON is accepted only for an organization the license covers after optional narrowing. |
| Queues | Explicit OFF revokes known payloads, including while paused. Missing choices hold. Changed positive decisions or acknowledgement versions hold old stamped payloads. Unrelated repository edits preserve authorization. In-flight requests may finish; busy cleanup is deferred. Event batches recorded before 0.11.0 were removed on its first run. |
| Global pause | `global.enabled` in the Codex record blocks Codex capture and delivery while retaining queues. It does not pause other clients. |
| Invalid or disappeared record | The runtime and controls share a strict reader and durable observation marker. Invalid records or marker failures hold capture/delivery without normalizing or rewriting the record. |

ChatGPT Work transcript delivery remains unsupported; consent does not bypass that
capability boundary.

Run `node --test test/plugin/consent-gates.test.js` for the
grant boundary tests, then `npm run check` for the full suite. Synthetic checks
do not prove installed hook trust, production receipt or reporting.

## Transcript interval boundary

Hooks observe the current source size before the consent gate using filesystem
metadata only. The first observation excludes existing content. A partial record
crossing an excluded boundary is excluded in full. Only a small projection of the
first session metadata record (identity, source and lineage, without startup
instructions) may cross that prefix; it still passes scope checks and sanitization.
ChatGPT Work transcripts remain excluded from the repository upload path.

Staging preserves permitted records and structured tool payloads, bounds reads to
the observed tail, and applies the same exclusions when rebuilding a server
baseline. Committed prefix verification rejects a rewritten source whose old byte
positions no longer establish authorization. A byte-identical restored prefix can
recover; an uncertain in-place rewrite is retained with `consent-source-rewritten`
and needs investigation rather than historical replay. Missing or corrupt consent
journals never authorize an old prefix.

The boundary is conservative: records written before the first lifecycle
observation, or since the last observation before a settings change, may be
excluded even if the user intended collection. Start a fresh session after opt-in
and verify native startup timing before relying on complete capture. Settings
revision changes also close unobserved intervals. The existing authentication
generation closes sign-out/sign-in intervals even for the same principal; a
normal token refresh preserves the generation and capture continuity. Repository
revocation starts a new capture generation: server resets cannot reconstruct the
pre-revocation prefix. Previously delivered remote data is not deleted.

A global decision's `decided_at` change closes the unobserved interval,
including an OFF/ON cycle between Codex hooks. The policy's overall `revision`
does not close intervals: another repository's choice must not discard this
repository's authorized records. Writers that restore an identical global record
leave no transition evidence; those unobserved cycles cannot be detected.

## Consent record

Codex reads and writes schema version 1 at `clients/codex/telemetry-policy.json`
under `SKILLMETER_STATE_DIR`, or `~/.skillbench` (`~/.skillbench-dev` in the internal
channel build). The schema matches the Claude plugin's record so the two
stay easy to compare; neither client reads the other's file. Global OFF retains
queues. Organization/repository OFF purges indexed payloads while retaining
privacy cursors.

A record that has never been observed grants nothing. Removing a previously
observed record holds data and blocks capture until it is readable again. Both
organization and repository acknowledgement versions participate in the
consent boundary. Existing malformed, unreadable or unsupported-version records
pause capture and delivery without rewriting them.

Upgrading from the machine-wide shared record starts with no Codex choices.
Event batches stamped under the shared record are held: while no Codex record
exists nothing grants them, and recording consent rotates the delivery token so
they never match it. They expire at the 30-day retention limit without being
sent.

Run the record boundary tests:

```sh
node --test test/plugin/consent/global-pause.test.js test/plugin/consent/repository-record.test.js
```

Canonical identity parsing follows Claude's pinned `repo-scope.js`: matching
origin wins, otherwise one unambiguous matching repository is required. SSH
aliases and Git `insteadOf` rewrites are supported. Codex retains its existing
stricter rejection of empty/unreadable `commondir`; long-lived processes reload
remote-resolution configuration so a changed alias is not cached as permission.

Only an observed OFF deletes queued data. A changed positive decision may be an
unobserved OFF/ON cycle or just reaffirmation: older stamped payloads are held,
not uploaded or deleted. Capture starts a new consent interval; resets cannot
reconstruct the uncertain prefix. Unrelated repository decisions do not affect
this queue. Requests already in flight can finish. Background drains and blocked
hooks reconcile revocations, including quarantined and active event data.

`consent-set` writes through the record's lock and expected revision and
preserves local settings. A local ON grants nothing.

## Queued repository data

The local queue adapter follows Claude's
[payload-removal and cursor-retention contract](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/30659641c0ecd7aa4f1b41d8624ad0620d9eab93/skillmeter/scripts/lib/repository-queue.js).
Codex uses a private routing index because its existing event files can contain
multiple repositories. Hook records carry a local generation, removed before
upload. The index stores checkout paths locally; it is not sent to the collector.
Symlink aliases share a local generation. Separate checkouts retain local
restrictions but share the canonical repository choice. Every event delivery and retry checks known repository consent.
Missing or corrupt routing fails closed without using the retry budget.
Temporarily unauthorized rows remain queued while permitted rows are delivered.
Acknowledgment atomically retains the held portion at the original path; salvage,
retry exhaustion and age quarantine operate only on the deliverable portion.
Retry counts reset when that portion changes. The 14-day retry age still applies
when a held record becomes eligible again. Sealed event batches are removed
after 30 days from sealing, including held rows. Cleanup runs before the global
pause check, uses the batch lock, and does not extend retention when a mixed
batch is rewritten. Transcript chunks and legacy snapshots remain excluded from
automatic expiration; their retention contract must be settled separately.
Failed local acknowledgment
can repeat an upload, consistent with the queue's existing at-least-once delivery.
Authorization is checked once per directory per attempt, never cached across
attempts. Revocation cleanup skips authorization checks and includes sent and quarantined
event files under the original batch lock. Transcript delivery checks
its captured generation. Repository controls publish the generation and choice
under the registration lock. Lock retries are bounded; persistent contention skips
capture with a diagnostic, and the control command reports that it needs a retry.

Global pause retains payloads. Explicit repository disable during a global pause
still revokes that repository. Direct settings edits enforce the current capture
and delivery gate but do not supply the durable off/on generation recorded by the
CLI. Event batches recorded before 0.11.0, which carry no repository routing,
were removed on the first run of 0.11.0.

Run `node --test test/plugin/consent/queue-revocation.test.js` for mixed-batch,
retry, cursor preservation, in-flight revocation and disable/re-enable checks.


### Windows queue durability

Queue files are synced before publication. Windows does not support syncing the
read-only directory handle used here, so the queue skips that operation and emits
one stderr diagnostic per process. Directory-entry persistence after a crash is
unconfirmed. File-write, file-sync and rename failures still fail the operation;
other platforms continue to report directory-sync errors. This does not establish
native Windows or power-loss acceptance.
