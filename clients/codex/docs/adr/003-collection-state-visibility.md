# Collection State Visibility: Notices, Monitor Lifecycle, and the Local Status Record

**Status:** Adopted by reference. Canonical text:
[Claude Code plugin ADR 003](../../../claude-code/docs/adr/003-collection-state-visibility.md)
(Accepted 2026-09-25, [PR #111](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/pull/111)).

## What is the same

A single local resolver decides whether collection can proceed, with no
network call in hooks (decision 1). The wording rules (decision 5) apply to
every user-facing line this plugin prints.

## Differences in the Codex plugin

- Codex has no monitor notification surface. The transition notices of
  decision 2 and the SessionStart card of decision 4 have these
  counterparts here: the SessionStart explanation for an unconfigured or
  excluded repository (#48), the hook stderr lines, and `telemetry.js status --details`
  (plain `status` prints a short card since 0.12.2), which distinguishes
  capture policy from delivery readiness (#47) and is
  the on-demand view of decision 6.
- The local status record of decision 1 has no Codex counterpart yet. Until
  it exists, `status` derives its answer from the session file, the
  Codex consent record and the queue directories on each call.
- The retry daemon (`scripts/monitors/retry_daemon.js`) exits on idle and on
  its lifetime limit, not on a blocked state. With a queued batch and an
  unrecoverable authentication state (402, missing token) it keeps sweeping
  until the lifetime ends. The blocked-state exit of decision 3 is not
  implemented.

## Open items

- Write the local status record in the same shape as the Claude plugin's, so
  a shared status view can read both; until then `status` recomputes its
  answer on every call.
- Exit the retry daemon on a blocked state instead of running out the
  lifetime.
