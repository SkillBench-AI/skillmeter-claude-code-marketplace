# Per-Client Consent Records

**Date:** 2026-09-28
**Status:** Proposed. Supersedes ADR 004 decisions 1, 3, 4 and 9, and the
parts of decisions 5 and 8 that assume a shared record.
**Related:** ADR 004 (shared consent), ADR 005 (per-client sessions),
`skillmeter-codex-marketplace` `docs/adr/004-shared-consent.md`

## Context

ADR 004 made `~/.skillbench/telemetry-policy.json` the one consent record for
every SkillMeter client on a machine. In practice that coupled the Codex
plugin to this plugin's settings:

- Only this plugin could authorize an organization, so Codex capture depended
  on a control that Codex did not have.
- Codex required organization and repository records at `consent_version: 2`,
  but no released version of this plugin writes version 2. Codex capture
  through the shared record could not be enabled at all.
- A choice made in one client silently changed what another client
  captured, which users could not see from the client they were using.

ADR 005 already separated sign-in: each client keeps its own session and only
the device identity is shared. This ADR does the same for consent.

## Decisions

### 1. Each client owns its consent record

- This plugin's record stays `~/.skillbench/telemetry-policy.json`. Only this
  plugin reads or writes it.
- The Codex plugin's record is `~/.skillbench/clients/codex/telemetry-policy.json`,
  next to its session (ADR 005). Only the Codex plugin reads or writes it.
- A client never reads another client's record, as a source or as a fallback.
  A choice in one client never grants, revokes or pauses capture in another.

### 2. Each record keeps ADR 004's model within its client

The gate order, unset-is-consent-required, organization as the parent
authorization, repository keys by canonical GitHub identity, fail-closed
handling of missing or invalid records (decision 5) and queue handling on
change (decision 6) still apply, each within one client's record. The global
pause in a record pauses only that client.

### 3. The consent statement names the client

ON covers every clone and worktree of the repository for the client that
records it. `consent_version: 2` in the Codex record means the user was shown
that statement in Codex. Each client provides its own organization control.

### 4. No migration between clients

The Codex plugin does not import choices from the shared record. After the
change, Codex captures only after organization and repository ON are recorded
in its own record; a local `.codex/settings.local.json` choice remains a
restriction but no longer grants capture on its own. This is what makes the
change safe without reading another client's record: nothing that was paused
or unset in the shared record starts capturing in Codex.

Queued Codex data recorded under the shared record is held and expires at the
existing retention limit; it is never sent under the new record.

### 5. Shared state is limited to identity

`credentials.json` (device identity, ADR 005) is the only state clients share.

## Consequences

- A user who wants both clients to capture a repository records consent in
  each. The consent text in each client says which client it covers.
- The version 2 work for a shared statement (this plugin's open PR #131) no
  longer needs to name every client; it can describe this plugin only.
- ADR 004's open item on a Codex organization control is closed: Codex has
  its own.

## Implementation

| Client | Change | Status |
|---|---|---|
| This plugin | None; its record and controls already cover only this plugin | Done |
| Codex | Own record, organization control, no local-only grant | [skillmeter-codex-marketplace#109](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/pull/109) |
