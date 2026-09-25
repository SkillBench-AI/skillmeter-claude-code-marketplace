# One Consent Record Shared by Every Client on a Machine

**Date:** 2026-09-25
**Status:** Accepted (PR #129, merged 2026-09-25). Authors: Seungho Baek,
Juho Kim. Decisions 4 to 6 restate the amendment Juho proposed on ADR 001 in
PR #128; this ADR replaces that amendment, and ADR 001 keeps a pointer here.
Acceptance covers the contract; implementation and the open items are gated
separately.
**Related:** ADR 001 (the license is already shared), ADR 002 (sanitization),
`skillmeter-codex-marketplace` `docs/adr/004-shared-consent.md` (adopts this
ADR), `skillmeter-vscode-extension`, the ChatGPT Work extension (its per-task
consent is outside this ADR)

## Context

Two clients capture from the same machine under the same identity: this
plugin and the Codex plugin. Both read the license from
`~/.skillbench/credentials.json` (ADR 001 decision 5), so a sign-in in one is
a sign-in in both. Consent is not shared: each client keeps its own record,
in its own format, with its own revocation rules.

### Current behaviour (as-is)

Claude Code plugin (0.37.0):

- One machine-wide policy file, `~/.skillbench/telemetry-policy.json`
  (`telemetry-store.js`, schema 1): `revision`, `global.enabled`,
  `organizations[org].enabled`, `repositories["github.com/org/repo"].enabled`.
  Repository keys are canonical GitHub identities, so clones and worktrees
  share one choice. Writes take a lock and bump `revision`; repository edits
  can pass an expected revision. Top-level keys the version does not know are
  dropped on write; a malformed file is normalized to defaults on read.
- Capture gate (`telemetry-policy.js`), in order: global pause, valid
  license, working directory known, repository in a licensed organization,
  organization authorized, repository enabled. An unset organization or
  repository is not OFF: it blocks capture and is reported as "consent
  required".
- Organization OFF purges that organization's queues and the audit queue.
  Repository OFF purges that repository's unsent payloads and keeps the
  privacy cursors, so content written while off is never uploaded later.
  Global OFF pauses transmission and keeps queues.
- A separate, one-time historical backfill consent per installation
  (`PRIVACY.md`), stored in the plugin data directory, independent of
  ongoing consent in both directions.
- Sign-out sets `signed_out` in the credential file and purges the audit
  queue; ADR 001 decision 3 adds the purge of unsent data on sign-out and 402.

Codex plugin (0.7.0):

- Repository choice per checkout, `<git-root>/.codex/settings.local.json`
  with `skillmeter.telemetry: true` (Codex #48). Clones and worktrees need
  separate choices. Nested repositories are independent. A subdirectory
  opt-out restricts; a subdirectory opt-in cannot authorize.
- No organization authorization record. Eligibility comes from the
  organizations in the license, optionally narrowed by
  `SKILLMETER_REPO_SCOPE_ORGS` or `skillmeter.repoScopeOrgs`.
- Global pause is `telemetry_disabled` in the shared credential file. Sign-out
  sets it together with `signed_out` and a new authentication generation. It
  keeps queues.
- A consent journal per transcript (Codex #49): the first observation
  excludes the existing prefix; byte ranges observed while capture was off
  are excluded from staging and from baseline rebuilds; a settings revision
  change or an authentication generation change closes the unobserved
  interval. Only a projection of the first `session_meta` record may cross
  the initial prefix.
- Repository disable stops capture but does not purge queued data; Codex
  #52 adds the purge with a checkout generation so that disable/enable
  cannot restore revoked payloads.
- No historical backfill. Transcripts whose originator is
  `codex_work_desktop` are rejected at staging.
- Open, stacked on the policy decision below: Codex #55 reads the Claude
  global pause as an extra restriction, #56 reads Claude organization and
  repository OFF the same way. Both fail closed on a malformed shared file,
  never write it, and never treat shared ON as permission.

### Observed problems

1. One person, one machine, one license, two answers. A repository enabled
   in Claude is off in Codex until the user finds the second control, and
   the reverse. The 0.36.0 onboarding report already names consent as the
   hardest part of setup; repeating it per client does not scale to the VS
   Code extension and ChatGPT Work.
2. Two global switches in two files. Pausing in Claude (`global.enabled`)
   does not pause Codex; signing out of Codex (`telemetry_disabled`) does
   not pause Claude. Codex #55 papers over one direction only.
3. Revocation means different things. Claude deletes unsent payloads on
   repository OFF; Codex keeps them (until #52). A user who turns a
   repository off has no single statement of what happens to queued data.
4. Nothing records what the user was told. A repository choice made before
   the cross-client scope existed cannot be distinguished from one made
   after, so a new client cannot know whether the user meant it (PR #128,
   decision A).
5. Compliance needs one procedure. The consent management procedure
   documents how a data subject consents and withdraws; two consent models mean two procedures and two
   sets of screenshots.

## Decisions

### 1. One consent record per machine, shared by every client

`~/.skillbench/telemetry-policy.json` is the consent record for every
SkillMeter client on the machine: this plugin, the Codex plugin, and any
client that captures later. It sits next to the shared credential file and
follows the same rule: the client that writes it is whichever the user is
using, and every client reads it before capture and again before
transmission. Consent is not a credential: a token change never changes
consent, and consent never mints or revokes a token.

Rationale: the user authorizes SkillBench for an organization and a
repository, not for a client. The credentials are already one record; a
person who signs in once should not consent twice.

### 2. One gate, one order, in every client

Global pause, valid license, repository resolvable, repository in a licensed
organization, organization authorized, repository enabled. Unset is not OFF:
it blocks capture and is reported as consent required; only an explicit OFF
revokes. Transmission re-evaluates the same gate for every queued item. A
client may add restrictions of its own (Codex's originator rejection, the
`SKILLMETER_REPO_SCOPE_ORGS` narrowing); it may not add permissions.

### 3. Consent names an organization or a repository, never a client

Enabling `github.com/org/repo` authorizes every supported client and every
clone or worktree of that repository on the machine. The control says so
before the choice is recorded. Organization records already carry
`consent_version: 1`; repository records get the same field. The statement
that names every client and every clone is `consent_version: 2`; a record at
1 or without the field is a legacy choice. `normalizePolicy()` passes
organization and repository records through unchanged, and the writers
replace a record only when its choice changes, so a reader that predates
version 2 keeps the field and a record it rewrites reads as legacy again,
which is the right answer for a choice made without the statement. No
client-specific consent flag exists; a client that must not upload something
(ChatGPT Work transcripts) enforces a capability boundary, not a consent
choice.

### 4. Migration of Codex's per-checkout choices (PR #128, decision A)

A local ON is never promoted to a shared ON automatically. A local OFF stays
a restriction until the user resolves it. Migration shows the conflicts,
writes through the shared store's lock with an expected revision, and
reloads on a stale revision instead of overwriting a concurrent OFF. A
client that finds a shared ON without `consent_version: 2` asks for the
one-time acknowledgement of decision 3 before using it. Until then the Codex plugin
keeps its local opt-in requirement.

### 5. A missing, unreadable or unsupported record blocks (PR #128, decision B)

A malformed, unreadable or unsupported-schema policy file blocks new capture
and delivery, keeps existing queues subject to retention, and reports an
actionable status. It is never normalized into permission and never
rewritten by the ordinary enable/disable controls; repair is an explicit
action. Each client keeps a durable "policy observed" marker in its own data
directory; if a policy that was observed disappears, the client holds until a
readable policy is back. First use with no record keeps today's
explicit-consent behaviour. An explicit OFF in a valid organization or
repository record still revokes known queued data even when the other record
is missing.

This changes this plugin's reader, which normalizes today.

### 6. Consent changes while data is queued (PR #128, decision C)

Organization or repository OFF purges that scope's known unsent payloads and
keeps privacy cursors and other repositories' data. Global OFF holds. An
unset organization or repository choice holds that scope's queued data; only
an explicit OFF purges it. An organization or repository OFF takes precedence
over the global pause: the purge happens even while the pause holds
everything else. Both change this plugin: `queueDisposition()` in
`repository-queue.js` deletes on an unset record and, like
`organizationAuditDisposition()` in `organization-audit-queue.js`, returns
pause before it looks at the organization. A positive decision whose timestamp changed
without an observed OFF is held, not sent and not deleted. A retry
re-evaluates consent before sending. Data already transmitted or in flight is
outside local revocation.

### 7. Historical backfill consent stays per client and per installation

It concerns one client's own transcript files and a cutoff recorded when the
question was answered. The shared record holds ongoing consent only; the
independence rule in `PRIVACY.md` is unchanged. A client without a backfill
feature (Codex today) has no backfill consent to share.

### 8. Interval enforcement stays per client

The shared record is the input; each client keeps its own proof of what it
excluded: this plugin's privacy cursors, Codex's consent journal. Both must
close the unobserved interval when the shared revision changes, and both
must exclude content written before the first observation of an ON.

### 9. Every client's ADR set points here

The Codex repository carries `docs/adr/004-shared-consent.md`, which adopts
this ADR by reference and lists only its differences. A later client does
the same. A change to consent semantics is made here first and mirrored in
each client's differences section; a client never changes consent behaviour
on its own.

## Consequences

- Codex #55 and #56 become the first half of decision 1 (read shared
  restrictions). The second half is writing through the shared store,
  migrating per-checkout choices (decision 4), and retiring
  `.codex/settings.local.json` as a source of permission.
- This plugin changes in three places: fail-closed reading (decision 5),
  hold on unset and organization/repository OFF before global pause in both
  queue dispositions (decision 6), and `consent_version: 2` on new decisions
  with the acknowledgement flow for legacy ones (decisions 3 and 4).
- `PRIVACY.md`, both READMEs and the consent skills say "for every SkillMeter
  client on this machine" wherever they describe a choice.
- The consent management procedure can describe one consent and withdrawal
  flow and take its screenshots from either client.
- Rollout order matters: ship the fail-closed readers in both clients before
  any writer adds a field an old reader would drop. Today's closed top-level
  schema drops unknown top-level keys on the next write, so new top-level
  fields wait for readers that hold instead of rewrite.

## Implementation mapping

| Decision | This plugin | Codex plugin |
| --- | --- | --- |
| 1, 2 | `telemetry-store.js`, `telemetry-policy.js`, drains | `shared-telemetry-policy.js` (#55, #56), then the write path |
| 3 | `consent_version: 2` in `telemetry-store.js`; wording in `skills/telemetry`, `skills/signin` | acknowledgement in the `telemetry.js` CLI |
| 4 | none | migration command, conflict preview |
| 5 | reader change in `telemetry-store.js`; status wording per ADR 003 (PR #111, proposed) | already fail-closed in #55 and #56 |
| 6 | `queueDisposition()` (`repository-queue.js`), `organizationAuditDisposition()` (`organization-audit-queue.js`) | `repository-queue.js` (#52, #56) |
| 7 | `backfill-state.js` unchanged | none |
| 8 | privacy cursors | consent journal (#49) |
| 9 | this file | `docs/adr/004-shared-consent.md` |

The acceptance cases below come from PR #128 and apply as written; the native
canary in Codex #57 and #58 exercises the shared controls on pinned versions.
Intercepted local delivery proves neither production receipt nor report
generation; those stay separate gates.

## Acceptance cases

| ID | Setup or action | Required observation |
| --- | --- | --- |
| A1 | Legacy local ON; shared choice absent | No automatic shared grant or policy migration. |
| A2 | Shared ON; a clone or client has never opted in | The migration acknowledgement is required before the legacy local gate is dropped. |
| A3 | Shared ON; local or descendant OFF | Capture stays blocked; migration surfaces the conflict. |
| A4 | User confirms while another client writes OFF | Stale revision fails; OFF survives and the user sees the changed choice. |
| A5 | Same canonical repository via clone or worktree; another repository B | Shared OFF blocks every A checkout; B is unaffected. |
| B1 | Malformed JSON, wrong schema, unreadable file or dangling path | Capture and delivery blocked; queues and the original policy bytes preserved; truthful status. |
| B2 | Policy removed after observation, process restarted, then policy restored | The durable client marker survives; hold while absent; blocked-interval transcript growth excluded on resume. A marker I/O failure cannot authorize capture. |
| B3 | Missing choice versus explicit OFF | A missing choice holds; an applicable valid OFF revokes known payloads. |
| C1 | A and B queued; shared A OFF, then ON | A's backlog deleted; B's bytes and privacy cursors retained; old A content cannot reappear on reset. |
| C2 | Global OFF, then ON | Queues retained, nothing transmitted during the pause, paused transcript growth excluded. |
| C3 | ON timestamp changes without an observed OFF; old policy restored | Earlier payloads stay held; no inferred deletion, no restored authorization. |
| C4 | Consent changes between a failed upload and its retry | The retry re-checks consent; no newly revoked payload is sent. |
| C5 | Reaffirmation or an edit to another repository | An unrelated edit preserves authorization; a reaffirmation follows C3 until a stronger contract exists. |
| C6 | Global OFF and repository or organization A OFF together | A's payloads revoked despite the pause; B's queues and all privacy cursors retained. |

## Open items

- Wording of the version 2 statement (decision 3) needs the privacy owner.
- Codex has no organization authorization control today. Decide whether the
  Codex CLI gains one or whether the first authorization always happens in
  a client that has the control.
- Disposition of legacy queue entries that carry no repository attribution.
- ChatGPT Work per-task consent, duration and revocation are outside this
  ADR; the VS Code extension follows when it captures.
- A durable revocation generation that distinguishes reaffirmation from an
  OFF/ON cycle would replace the hold in decision 6; its schema is a separate
  decision.
