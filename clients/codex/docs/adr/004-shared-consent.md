# One Consent Record Shared by Every Client on a Machine

**Status:** Superseded on 2026-09-28 by [ADR 006](006-per-client-consent.md):
Codex keeps its own consent record. The text below is kept as history.
Previously adopted by reference. Canonical text:
[Claude Code plugin ADR 004](../../../claude-code/docs/adr/004-shared-consent.md)
(Accepted 2026-09-25, [PR #129](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/pull/129)).
The decisions on migration, invalid policy and queued data restate Juho's
proposal in [PR #128](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/pull/128).
**Related:** `docs/repository-consent.md` (the capture-gate change this
plugin made first, and the boundary it documents)

## What is the same

The gate order (decision 2): global pause, license, repository resolvable,
licensed organization, organization authorized, repository enabled. Unset is
"consent required", not OFF. Consent names an organization or a repository,
never a client (decision 3).

## Differences in the Codex plugin, as of 0.7.0

| Area | Codex today | Canonical decision |
| --- | --- | --- |
| Where the repository choice lives | `<git-root>/.codex/settings.local.json`, per checkout; clones and worktrees need separate choices (#48) | `~/.skillbench/telemetry-policy.json`, keyed `github.com/org/repo`, one choice per machine (decision 1) |
| Organization authorization | none; eligibility is the license's organizations, optionally narrowed by `SKILLMETER_REPO_SCOPE_ORGS` | explicit organization ON is the parent of every repository choice (decision 2) |
| Global pause | the shared `global.enabled` only, read and written by `sk-telemetry disable/enable --global`; sign-out no longer pauses (ADR 005) | one field, `global.enabled` (decision 1) |
| Shared ON | never used as permission; #55 and #56 read shared OFF only and keep the local opt-in | shared ON authorizes every client after the one-time scope acknowledgement (decisions 3 and 4) |
| Malformed or missing shared policy | #55 and #56 fail closed on a malformed file. A missing policy keeps local consent only while this client has never observed one; once a policy has been observed, a durable marker makes its disappearance hold capture and delivery, across restarts, until a readable policy is back. Deleting the shared policy never restores a local grant | the same, adopted for every client (decision 5) |
| Send-time re-check | transcript chunks re-check scope before each send (`scopeStillAllowed`); event batches re-check the global pause and license only, so a batch sealed before a repository OFF can still drain (#52 adds the consent re-check on retry) | every queued item re-evaluates the full gate before transmission (decision 2) |
| Repository OFF with queued data | capture stops, queued data stays (0.7.0); #52 purges payloads, keeps cursors, and adds a checkout generation so enable/disable cannot restore them | purge known payloads, keep cursors; organization or repository OFF before global pause (decision 6) |
| Interval proof | consent journal per transcript (#49): first observation excludes the existing prefix, disabled byte ranges are excluded from staging and baseline rebuilds, settings revision and authentication generation close intervals | stays per client (decision 8); the Claude plugin uses privacy cursors |
| Historical backfill | none | stays per client and per installation (decision 7) |
| ChatGPT Work transcripts | `session_meta.originator=codex_work_desktop` rejected at staging | a capability boundary, not a consent choice (decision 3); Work consent is a separate decision |

## Implementation mapping

| Decision | Codex | State |
| --- | --- | --- |
| 1, 2 | `lib/shared-telemetry-policy.js` reader (#55, #56); write path and retirement of the per-checkout choice | #55, #56 open; write path not started |
| 3, 4 | scope acknowledgement and migration command in `telemetry.js` | not started |
| 5 | fail-closed reader | in #55, #56 |
| 6 | `lib/repository-queue.js` revocation (#52), precedence over pause (#56) | open |
| 8 | consent journal in `lib/transcript-delta.js` (#49) | merged 0.7.0 |
| acceptance A1 to C6 | native harness (#57, #58) | open |

## Open items

- Whether this plugin gains an organization authorization control or relies
  on a client that has one (canonical open item).
- Disposition of legacy queue entries without repository attribution.
