# Anthropic Plugin Directory Submission Readiness

Last reviewed: July 26, 2026

This document is the review packet and release gate for submitting SkillMeter
to Anthropic's official plugin directory. It is not evidence of approval or an
Anthropic endorsement.

## Decision

**Do not submit the current implementation yet.**

The repository meets the public-source and plugin-validation prerequisites,
but current content collection conflicts with the Anthropic Software Directory
Policy restrictions on extraneous conversation data and extracting chat
history, conversation summaries, or user-generated/uploaded files.

Relevant policy:

- <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy>
- <https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms>
- <https://claude.com/docs/plugins/submit>

## Readiness matrix

| Requirement | Status | Evidence or action |
|---|---|---|
| Public GitHub source | Pass | `SkillBench-AI/skillmeter-claude-code-marketplace` is public |
| Valid plugin/marketplace structure | Pass | `claude plugin validate .` |
| Accurate user documentation | Improved | Root README, plugin README, privacy, security, and support documents |
| Accessible privacy policy | Partial | `PRIVACY.md` and SkillBench general policy exist; publish a definite plugin telemetry retention schedule |
| Support contact | Partial | `privacy@skillbench.com`; verify a monitored product-support channel |
| Security-report mechanism | Partial | `SECURITY.md`; verify mailbox ownership and response process |
| Standard test account with sample data | Missing | Create and deliver privately in the submission form |
| Three working examples | Prepared | See below |
| Endpoint/domain control | Must attest | `skillbench.com`, `skillbench.ai`, and tenant telemetry domains |
| Rights and license | Missing decision | Add an approved repository/plugin license before submission |
| Directory Policy 1.D/1.F | Fail | Current plugin collects conversation and user-authored file content |

## Blocking data-access findings

Sanitization does not cure a collection-scope violation. The following data
paths must be removed from the directory build, replaced with aggregate
metadata, or explicitly approved in writing by Anthropic:

1. `scripts/lib/transfer.js`
   - `stageTranscriptDelta` reads Claude transcript JSONL and uploads sanitized
     transcript records.
2. `scripts/lib/hook-registry.js`
   - `UserPromptSubmit` records prompt text.
   - tool hooks record tool inputs, responses, and errors.
   - lifecycle hooks record assistant messages, task descriptions/metadata, and
     compaction instructions.
3. `scripts/harness.js`
   - custom project/user `SKILL.md` bodies and descriptions are read and
     transmitted.
   - permission rule strings and developer-authored names are transmitted.
4. `scripts/lib/backfill-scan.js`
   - historical transcript files are inspected for repository discovery and
     are intended for backfill selection.

These behaviors conflict most directly with Directory Policy sections 1.D and
1.F. They also increase the disclosure and minimization burden under sections
1.C and 3.A.

## Required directory-safe product profile

Before submission, create and test a directory-safe build or make the default
product behavior conform to all of the following:

- do not upload transcript records or conversation content;
- do not collect prompt text, assistant messages, task descriptions,
  compaction instructions, notification text, tool input, tool output, or raw
  error content;
- do not read or upload custom skill bodies, user-authored instruction
  contents, uploaded files, or permission rule strings;
- retain only narrow workflow metadata necessary for SkillMeter's function,
  such as allow-listed event type, allow-listed tool name, timestamps,
  success/failure booleans, bounded counts, coarse enums, and pseudonymous
  repository/session identifiers;
- review whether even filename/name inventories are necessary; remove them
  when counts or allow-listed categories are sufficient;
- remove transcript backfill from the submitted plugin;
- keep explicit organization and repository opt-in and the global
  kill-switch;
- update tests to assert that prohibited content cannot cross the payload
  boundary;
- update `PRIVACY.md`, the manifest descriptions, and the examples to match the
  reduced data model.

If conversation content is essential to the product, obtain written guidance
from Anthropic before submission. Do not rely on redaction or user consent as
an assumed exception to Directory Policy 1.F.

## Draft directory listing

### Name

SkillMeter

### Short description

Opt-in Claude Code workflow telemetry for organization-level developer skill
analytics, gated by licensed GitHub organization and explicit repository
selection.

This description must be revised if the final directory-safe build has a
different data model.

### Publisher

SkillBench, Inc.

### Source

<https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace>

### Homepage

<https://skillbench.com>

### Privacy

- <https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/PRIVACY.md>
- <https://skillbench.com/privacy/>

### Support and security

- <https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/SUPPORT.md>
- <https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/SECURITY.md>

## Three review examples

Use a synthetic organization and repositories in the Anthropic test account.
Do not use customer or employee production data.

### Example 1: Sign in and keep telemetry off

Prompt:

```text
/skillmeter:signin
```

Expected result:

- the plugin explains the licensed organization;
- telemetry remains off by default;
- declining organization authorization sends no telemetry.

### Example 2: Authorize only selected repositories

Prompts:

```text
/skillmeter:signin
/skillmeter:telemetry list
```

Expected result:

- the exact eligible repository names are shown without local paths;
- repositories remain off until explicitly selected;
- selecting one repository does not enable other repositories.

### Example 3: Stop and resume collection

Prompt:

```text
/skillmeter:telemetry list
```

Expected result:

- disabling a repository stops capture and removes its queued payloads;
- the global kill-switch pauses all transmission;
- re-enabling does not upload content created during the disabled period.

For a directory-safe build, provide backend sample data showing only the
approved metadata fields.

## Test account package

Provide the following privately through Anthropic's submission process:

- a dedicated non-production SkillMeter organization;
- a least-privilege test GitHub identity and organization;
- two synthetic repositories, one enabled and one disabled;
- sample dashboard data containing no real user or customer content;
- instructions for sign-in, consent, verification, sign-out, and deletion;
- expected telemetry endpoint and dashboard behavior;
- account expiry and support contact.

Never commit test credentials, OAuth tokens, device codes, license JWTs, or
customer data to this repository.

## Reviewer disclosure

The submission should explicitly state:

- all hooks and background monitors installed by the plugin;
- all local directories and files written by the plugin;
- every network domain contacted;
- authentication scopes (`read:user`, `read:org`) and why they are needed;
- the exact directory-safe telemetry schema;
- local and server retention behavior;
- how to disable capture, purge queues, sign out, uninstall, and request server
  deletion;
- that sanitization is defense in depth rather than an anonymity guarantee.

### Hook and monitor inventory

The current plugin registers these hook events:

```text
SessionStart
FileChanged
UserPromptSubmit
UserPromptExpansion
PreToolUse
PostToolUse
PostToolBatch
PostToolUseFailure
PermissionRequest
PermissionDenied
Notification
Stop
StopFailure
SubagentStart
SubagentStop
TeammateIdle
TaskCreated
TaskCompleted
InstructionsLoaded
ConfigChange
WorktreeCreate
WorktreeRemove
SessionEnd
PreCompact
PostCompact
Setup
CwdChanged
Elicitation
ElicitationResult
```

It also registers `skillmeter-retry-daemon`, a background monitor that retries
pending event and transcript uploads while a Claude Code session is active.

### Local state inventory

- `~/.skillbench/credentials.json`: random device ID, hashing salt, license JWT,
  and sign-in state
- `~/.skillbench/telemetry-policy.json`: global, organization, and repository
  telemetry decisions
- `~/.skillbench/signin-result.json`: latest background sign-in result
- `~/.skillbench/upload-result.json`: latest background upload result
- `~/.skillbench/activate-poll.log`: device-flow activation diagnostics
- `${CLAUDE_PLUGIN_DATA}/logs/`: repository-bound event queues, transcript
  chunks, cursors, metadata, and process locks
- `.claude/settings.local.json`: legacy `skillmeter.telemetry` is removed after
  successful migration; unrelated settings are preserved

### Network inventory

- `https://github.com/login/device/code`
- `https://github.com/login/oauth/access_token`
- `https://api.skillbench.ai/activate`
- `https://api.skillbench.ai/refresh`
- the HTTPS tenant telemetry origin carried in the signed license JWT `aud`
  claim, with `/logs/claude` and `/logs/claude/transcript` paths

Development-only environment variables can override activation and telemetry
origins. The submitted production build and test instructions must not rely on
an unreviewed override.

## Final release checklist

- [ ] Directory Policy 1.D/1.F blocker removed or written exception obtained
- [ ] Plugin-specific server retention schedule published
- [ ] Repository/plugin license approved and added
- [ ] Support and security mailboxes verified and monitored
- [ ] Standard test account and synthetic sample data prepared
- [ ] At least three examples tested end to end
- [ ] `claude plugin validate .`
- [ ] `node --test`
- [ ] Privacy, security, support, manifest, and listing text reviewed
- [ ] Endpoint/domain ownership attested
- [ ] Submission authorized by a SkillBench representative able to accept the
      Anthropic Software Directory Terms

## Submission routes

- Claude.ai Team/Enterprise directory manager:
  <https://claude.ai/admin-settings/directory/submissions/plugins/new>
- Anthropic Console Developer/Admin/Owner:
  <https://platform.claude.com/plugins/submit>

After publication, Anthropic mirrors GitHub updates and screens each update.
Do not release a collection-scope expansion without updating documentation,
tests, and the submission contact.
