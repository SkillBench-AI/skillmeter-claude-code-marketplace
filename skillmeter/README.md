# SkillMeter

A Claude Code plugin that sends opt-in, repository-scoped workflow and
conversation telemetry to the [SkillBench](https://skillbench.com) platform for
organization-level developer skill analytics.

Before enabling telemetry, review the repository-level
[privacy notice](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/PRIVACY.md),
[security policy](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/SECURITY.md),
and [support information](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/SUPPORT.md).
Sanitization reduces exposure but does not make arbitrary conversation or
developer-authored content anonymous.

## Data Flow

```
                              Claude Code Runtime
                                     │
                       ┌─────────────┴─────────────┐
                       │        Hook System         │
                       │       (hooks.json)         │
                       └─────────────┬─────────────┘
                                     │
         ┌───────────┬───────────────┼───────────────┬───────────┐
         ▼           ▼               ▼               ▼           ▼
  ┌────────────┐ ┌─────────┐ ┌────────────┐ ┌────────────┐ ┌───────────┐
  │  Session   │ │ Prompt  │ │  PostTool  │ │    Stop    │ │  Session  │
  │  Start     │ │ Submit  │ │  Use       │ │            │ │  End      │
  └─────┬──────┘ └────┬────┘ └─────┬──────┘ └─────┬──────┘ └─────┬─────┘
        │              │            │               │              │
        │         hash paths   hash paths           │      extract conversation
        │              │            │               │      from transcript.jsonl
        │              ▼            ▼               │              │
        │         ┌─────────────────────┐          │              │
        │         │   SHA-256 Hashing   │          │              │
        │         │  (first 16 chars)   │          │              │
        │         └──────────┬──────────┘          │              │
        │              │     │                     │              │
        ▼              ▼     ▼                     ▼              │
  ┌────────────────────────────────────────────────────┐         │
  │              logger.js / logStructured()            │         │
  │                                                    │         │
  │  ┌──────────────┐  ┌───────────────────────────┐   │         │
  │  │ getDeviceId() │  │ Writes NDJSON log entry   │   │         │
  │  │ credentials   │  │ with: timestamp, level,   │   │         │
  │  │ JSON store    │  │ event, session_id,        │   │         │
  │  └──────────────┘  │ device_id, data            │   │         │
  │                     └───────────────────────────┘   │         │
  └────────────────────────┬───────────────────────────┘         │
                           │                                     │
                           ▼                                     │
              ┌────────────────────────┐                         │
              │  logs/events.jsonl     │                         │
              │  (NDJSON, append-only) │                         │
              └────────────┬───────────┘                         │
                           │                                     │
            ┌──────────────┴──────────────┐                      │
            │                             │                      │
     SessionStart /                Stop / SessionEnd             │
     retry monitor                 seal durable queues           │
            │                             │                      │
            ▼                             ▼                      │
  ┌───────────────────────────────────────────┐                  │
  │  Atomic rename:                           │                  │
  │  events.jsonl → events.jsonl.{timestamp}  │                  │
  └────────────────────┬──────────────────────┘                  │
                       │                                         │
                       ▼                                         ▼
  ┌──────────────────────────────┐    ┌──────────────────────────────────┐
  │   drain_once.js              │    │   retry_daemon.js / SessionStart │
  │   (detached one-shot)        │    │   (fallback retry paths)         │
  │                              │    │                                  │
  │  1. Read sealed queues       │    │  1. Scan sealed event logs       │
  │  2. gzip compress            │    │  2. Scan transcript delta chunks │
  │  3. POST to backend          │    │  3. Retry uploads                │
  │  4. Mark/delete on success   │    │  4. Keep failures on disk        │
  └──────────────┬───────────────┘    └────────────────┬─────────────────┘
                 │                                     │
                 └──────────────┬───────────────────────┘
                                ▼
                 ┌────────────────────────────────────────┐
                 │  SkillBench Backend (per-tenant)       │
                 │  <slug>.meter[.<env>].skillbench.com   │
                 │  POST /logs/claude                     │
                 │                                        │
                 │  Hostname is read from the JWT's       │
                 │  JWT `aud` claim, minted               │
                 │  by the activation Lambda against the  │
                 │  tenant slug at issuance time.         │
                 │                                        │
                 │  Headers:                              │
                 │    Content-Encoding: gzip              │
                 │    Authorization: Bearer ...           │
                 └────────────────────────────────────────┘
```

## Project Structure

```
skillmeter/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (name, author)
├── hooks/
│   └── hooks.json           # Hook event → script mappings
├── logs/
│   ├── repositories/<id>/
│   │   ├── events.jsonl     # Active repository event log (NDJSON)
│   │   └── transcripts/
│   │       ├── chunks/      # Sanitized transcript deltas awaiting upload
│   │       └── cursors/     # Per-transcript upload cursors
│   └── organization-audit/  # Organization-scoped audit queues
└── scripts/
    ├── logger.js            # Core hook runner + logging library
    ├── hook.js              # Generic hook entrypoint (dispatches by event name)
    ├── harness.js           # Level 1 harness metadata detection (SessionStart)
    ├── session_start.js     # SessionStart hook handler (dedicated: banner/onGate)
    ├── session_end.js       # SessionEnd hook handler (dedicated: seal + drain)
    ├── stop.js              # Stop hook handler (dedicated: detached drain trigger)
    ├── on_signin_result.js  # FileChanged sign-in notifier (dedicated)
    ├── backfill.js          # One-time historical transcript consent coordinator
    ├── backfill_worker.js   # Detached repository-scoped snapshot worker
    ├── drain_once.js        # One-shot queue uploader
    └── lib/
        ├── hook-registry.js # Field mappers for observation-only hooks (used by hook.js)
        ├── sanitize.js      # Secret/PII redaction + path hashing boundary
        ├── rules.js         # Gitleaks-derived secret/PII rule table
        ├── io.js            # Shared file I/O leaf helpers
        └── http.js          # Shared Bearer-POST helper
```

## Hook Events

Selected high-impact hooks are summarized below. See
[`hooks/hooks.json`](hooks/hooks.json) and
[`scripts/lib/hook-registry.js`](scripts/lib/hook-registry.js) for the complete
event list and payload mapping.

| Hook               | Trigger                     | Data collected |
|--------------------|-----------------------------|----------------|
| `SessionStart`     | Claude Code session begins  | Session/runtime fields and [harness data](#harness-data) |
| `UserPromptSubmit` | User submits a prompt       | Prompt text, permission mode, pseudonymous transcript identifier |
| `PreToolUse`       | Before a tool runs          | Tool name, input, and tool-use identifier |
| `PostToolUse`      | After a tool runs           | Tool name, input, response, and tool-use identifier |
| `Stop`             | A turn stops                | Stop state, assistant message exposed by the hook, event queue, and transcript delta |
| `SessionEnd`       | Session ends                | End reason, event queue, and transcript delta |

## Log Entry Format

Each line in `events.jsonl` is a self-contained JSON object:

```json
{
  "timestamp": "2025-12-19T02:45:30.675Z",
  "level": "info",
  "hook_event_name": "UserPromptSubmit",
  "session_id": "93211d63-9b55-429e-b644-f7eea382db61",
  "device_id": "2B66EC2C-494D-410C-93DC-3BD9B75BD363",
  "data": {
    "transcript_path": "a1b2c3d4e5f67890",
    "permission_mode": "default",
    "prompt": "fix the login bug"
  }
}
```

When organization telemetry is authorized but the cwd gate excludes a hook,
the separate organization audit queue uses this fixed minimal shape:

```json
{
  "timestamp": "2026-07-26T12:34:56.000Z",
  "level": "info",
  "hook_event_name": "TelemetryCaptureExcluded",
  "telemetry_scope": "organization",
  "session_id": "93211d63-9b55-429e-b644-f7eea382db61",
  "device_id": "2B66EC2C-494D-410C-93DC-3BD9B75BD363",
  "data": {
    "source_hook_event_name": "PostToolUse",
    "gate_mode": "out_of_scope",
    "cwd": "a61e0f34c291"
  }
}
```

The `data` object is allow-listed; it is not derived by copying the blocked
hook payload and removing fields.

## Harness Data

To judge a session fairly, analysis needs to know whether the developer was
working *bare* or with a sophisticated **harness** — the instruction files,
skills, hooks, plugins, and orchestration wrapped around the agent. The
`SessionStart` event carries a `harness` block describing that scaffolding.
Most fields are presence, count, name, enum, or size-bucket signals. The current
implementation also collects selected developer-authored content: custom
project/user `SKILL.md` descriptions and bodies (bounded by size/count limits)
and permission rule strings. It does not intentionally collect raw
`CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md` bodies.

Detection is split by what is actually observable:

- **Level 1 (filesystem-detectable, collected today):** instruction-file
  presence/shape, custom skill content, permission rules, skills, hooks, and
  plugin/agent info — probed once at session start by
  [`scripts/harness.js`](scripts/harness.js).
- **Level 2 (architecture-level, NOT detectable):** external orchestration and
  multi-agent setups. These can't be inferred from the filesystem or transcript,
  so they are reported as the explicit string `"unknown"` rather than a
  misleading `false`.

Example `harness` payload:

```json
{
  "schema_version": 2,
  "policy_version": "1.0.0",
  "agent_type": "claude-code",
  "plugin": { "name": "skillmeter", "version": "0.x.y" },
  "instructions": {
    "has_claude_md": true,
    "has_claude_md_global": false,
    "has_agents_md": false,
    "has_agents_md_global": false,
    "scopes": ["project"]
  },
  "skills": { "count": 3, "names": ["deploy", "review-pr", "signin"], "scopes": ["project", "global"] },
  "hooks": { "enabled": ["PostToolUse", "PreToolUse", "SessionStart", "Stop"], "scopes": ["plugin", "project"] },
  "orchestration": { "external_orchestration": "unknown", "multi_agent": "unknown" },
  "redactions": { "hashed_count": 0, "dropped_count": 0, "by_type": {} }
}
```

What is probed:

| Field | Source |
|-------|--------|
| `instructions.has_claude_md` / `has_agents_md` | `CLAUDE.md` / `AGENTS.md` in the cwd or repo root |
| `instructions.has_*_global` | `~/.claude/CLAUDE.md`, `~/.claude/AGENTS.md` |
| `skills.count` / `names` / `scopes` | `SKILL.md` files under `.claude/skills/` (project and `~/.claude/skills/`); hidden `.system` namespaces are skipped |
| `hooks.enabled` / `scopes` | allow-listed lifecycle event names declared in the plugin's `hooks.json` and any user/project/local `.claude/settings.json` |
| `plugin` / `agent_type` / `schema_version` | this plugin's manifest and the harness schema version |
| `policy_version` | the sanitization policy version this metadata was produced under |
| `redactions` | sanitization bookkeeping (`hashed_count`, `dropped_count`, `by_type`) — counts/types only |

Sanitization integration (SBEE-165, Phase 2):

- The whole `harness` block is routed through the deterministic
  `sanitizeEventData` boundary (`lib/sanitize.js`) before upload, so a skill or
  hook name that happens to embed a secret/email is still scrubbed.
- **Fail-closed at the harness boundary:** before any skill name is
  hashed or emitted it is scanned for secrets, and a name that embeds one
  is **dropped** outright (the hashing step would otherwise hide it from the
  downstream scrubber). Every hash and drop is tallied in the `redactions`
  block — counts and field types only, never the original values.
  `skills.count` always keeps the true on-disk total.
- Only **allow-listed** hook event names are reported, so an arbitrary
  user-authored `settings.json` can't inject free-form strings into the metadata.
- Skill names are emitted in plaintext by default. Set
  `SKILLMETER_HARNESS_HASH_SKILL_NAMES=1` to emit HMAC-hashed `names_hashed`
  instead when skill names may be sensitive.
- Detection is filesystem-only, depth-bounded, and fail-safe: any error leaves
  the safe `unknown`/empty defaults in place and never breaks the session.

## Privacy and data access

The complete disclosure, including purposes, destinations, local retention,
server-side requests, and user controls, is in the
[SkillMeter plugin privacy notice](https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/blob/main/PRIVACY.md).

The current plugin can process and transmit free-form content:

- prompts, notification text, and assistant messages exposed by hooks;
- tool inputs, tool responses, and errors;
- task descriptions/metadata and compaction instructions;
- sanitized Claude transcript records;
- custom project/user skill descriptions and bodies; and
- permission rule strings and developer-authored component names.

Every event payload and every transcript line is scrubbed before it leaves the
machine, by one shared boundary (`lib/sanitize.js`):

- **Secrets** are redacted to `[REDACTED_SECRET]` using a curated rule table
  ported from the [Gitleaks](https://github.com/gitleaks/gitleaks) default
  ruleset (MIT — see `NOTICE`), gated by Shannon entropy and a stopword
  allow-list to limit false positives. Field names that denote secrets
  (`api_key`, `token`, `password`, …) force redaction of their values too.
- **Emails** are redacted to `[EMAIL]`.
- **The home-directory prefix** (which carries the OS username) is HMAC-hashed
  everywhere it appears — in message content, tool commands, and file paths —
  so the username never leaves the machine while relative structure is kept.
- **Path-bearing tool fields** (`file_path`, `path`, `command`, …) and the
  `cwd` / `repo_root` / `repo_remote_org` fields are HMAC-hashed wholesale.
- **Device ID** is a random UUID stored in `~/.skillbench/credentials.json`, not derived from hardware.
- **Harness data** (`SessionStart`) runs through the same sanitizer; see
  [Harness Data](#harness-data).

After the feature becomes available, `/skillmeter:signin` can separately offer
new and existing users the option to queue completed historical sessions for
the repositories just enabled. This question is shown once per installation
lifecycle. Historical snapshots retain their UUID boundary but remove
tool-result and image blocks before the shared secret, email, and path
sanitizer runs. The current sign-in session and files modified after the offer
are excluded.

These controls are defense in depth. Pattern-based secret/PII detection can
have false negatives, and sanitization does not make arbitrary content
anonymous. Enable telemetry only where the organization and repository data
can be processed by SkillBench.

## Log Transfer

Logs are sent to the backend from durable filesystem queues:

1. **Active event log** -- Hooks append NDJSON entries to a repository-bound `logs/repositories/<id>/events.jsonl`.
2. **Queue sealing** -- `Stop` and `SessionEnd` atomically rename the active log to `events.jsonl.<timestamp>` and stage sanitized transcript deltas under the same repository queue's `transcripts/chunks/`.
3. **Immediate drain** -- `Stop` triggers a detached `drain_once.js` uploader. `SessionEnd` is synchronous and attempts a bounded 5-second drain before Claude exits.
4. **Fallback retry** -- `SessionStart` and the plugin retry monitor drain any sealed event logs or transcript delta chunks left on disk.

All uploads use gzip compression. Queues are partitioned by canonical GitHub repository identity, and the current global, organization, and repository policy is checked again immediately before each request. Successfully uploaded event batches are renamed with `.sent`; successfully uploaded transcript delta chunks are deleted. Failed uploads remain queued for retry.

## Local State

SkillMeter stores device identity, hash salt, license JWT, and the GitHub fallback cooldown in `~/.skillbench/credentials.json`. Global, organization, and repository telemetry decisions live in the single machine policy store `~/.skillbench/telemetry-policy.json`. The one-time historical-backfill decision lives in Claude Code's persistent plugin data and is removed by a normal final-scope uninstall. Existing and new users receive the same one-time offer.

Legacy telemetry values are imported automatically. After a repository value is durably imported, only `skillmeter.telemetry` is removed from that checkout's `.claude/settings.local.json`; adjacent Claude and SkillMeter development settings are preserved. Clones and worktrees share the same repository policy through the normalized `github.com/org/repo` identity.

## Slash Commands

| Command                              | Purpose                                                            |
|--------------------------------------|--------------------------------------------------------------------|
| `/skillmeter:signin`                 | Sign in with GitHub (silent via `gh`, or device-flow fallback)     |
| `/skillmeter:signout`                | Sign out and stop all telemetry; keeps device identity intact      |
| `/skillmeter:telemetry list`         | Show and toggle effective telemetry for known organization repos   |

## Configuration

| Environment Variable           | Default                                                                       | Description                                                                                                                                  |
|--------------------------------|-------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `SKILLMETER_BACKEND_URL`       | unset — endpoint resolved from the license JWT's `aud` claim                  | Base-URL override for local development / integration tests (e.g. `http://localhost:8080`). Callers append `/logs/claude` and `/logs/claude/transcript`; upload authentication still requires a valid license JWT. |
| `SKILLMETER_ACTIVATE_URL`      | `https://api.skillbench.ai/activate`                                          | Activation endpoint that exchanges a GitHub OAuth token for a SkillMeter license JWT. Point at `https://api.dev.skillbench.com/activate` to run against dev. |
| `SKILLMETER_GITHUB_CLIENT_ID`  | prod SkillMeter GitHub OAuth App                                              | Override the GitHub OAuth App used for the device-code login. Set to the dev App's `client_id` when activating against dev.                  |
| `SKILLMETER_TIMEOUT`           | `10`                                                                          | Upload timeout (seconds)                                                                                                                     |

In production the telemetry hostname is per-tenant and looks like `https://<slug>.meter.skillbench.ai` (non-prod: `https://<slug>.meter.<env>.skillbench.com`). The activation Lambda mints it into the license JWT against the tenant slug at issuance, and the plugin reads it back at upload time.

### Pointing at a non-default environment

`SKILLMETER_ACTIVATE_URL` and `SKILLMETER_GITHUB_CLIENT_ID` both also accept persistent per-project values via `.claude/settings.local.json`:

```json
{
  "skillmeter": {
    "activate_url": "https://api.dev.skillbench.com/activate",
    "github_client_id": "<dev OAuth App client_id>"
  }
}
```

Resolution order is env var → settings file → built-in default. Typically you set the env vars together when running activation against dev; once the JWT is cached, telemetry routing is read straight from its `aud` claim and doesn't need `SKILLMETER_BACKEND_URL`.

## Repo-Scoped Filtering

Telemetry is gated to repositories owned by the GitHub org your license was validated for. That org is decided by the license activator and carried in the license JWT's `org` claim (read via `getAllowedGitHubOrgs` → `getLicenseOrgs`); the client does not fetch or persist a GitHub org list. A matching `origin` is preferred. If no matching origin exists, a unique matching remote is accepted; multiple distinct matching repositories fail closed as ambiguous.

Full hook payloads are dropped — even in workdirs where the user ran
`/skillmeter:telemetry enable` — for:

- directories that are not inside a Git repository
- repositories without a recognizable GitHub remote
- repositories whose remote owner is not the org your license was validated for (the license activator issues a license for one GitHub org; the org is carried in the license JWT)

The tracked org is decided by the license activator, not the client — there is no client-side org narrowing. Org names match case-insensitively.

### Organization consent and repository overrides

After sign-in, organization telemetry remains off until the user answers one
combined onboarding question. SkillMeter scans known local repositories owned
by that organization, shows the exact repository names, and offers three
choices: enable every listed repository, authorize organization-only exclusion
diagnostics while keeping full repository telemetry off, or keep all telemetry
off. Organization authorization alone never starts full hook-event capture.
While organization authorization is on, an event excluded by the cwd gate
produces only a
`TelemetryCaptureExcluded` audit record containing the source hook type, gate
reason, and HMAC-hashed cwd. The original hook payload, raw path, repository
name, organization name, prompt, tool data, and transcript path are not copied
into that organization-scoped queue.

An eligible repository then resolves in three states:

- **Explicitly disabled** — full hook capture stops and unsent payloads for that
  repository are deleted; the organization-level minimal exclusion audit
  remains active while organization authorization is on.
- **Explicitly enabled** — capture is allowed, subject to the global, sign-in, ownership, and organization gates.
- **Unset** — remains off and asks for an explicit repository choice on first entry.

Use `/skillmeter:telemetry list` to review and toggle known repositories.
Discovery combines the current working directory, structured paths found in
Claude transcripts, and Claude Code's machine-local project registry. Registry
entries are treated only as hints: every path must still exist, resolve to a git
root, and pass the licensed GitHub remote check. Clone and worktree paths are
deduplicated by canonical GitHub repository identity.

The native Claude Code question UI supports 2-4 options per question, so longer
repository inventories are shown as sequential `Repos X/N` pages rather than a
single unbounded picker. The machine-global kill-switch overrides all repository
and organization decisions; unlike an org/repository OFF choice, it pauses
queued transfers without deleting them.

Repositories discovered after onboarding are not enabled automatically. Entering
one shows a repository setup banner; use `/skillmeter:telemetry list` to enable
it. Full event capture and repository-queue transmission both require explicit
organization and repository authorization. The minimal exclusion audit
described above requires organization authorization but never repository
authorization.

The tracked org follows your license — re-run `/skillmeter:signin` to pick up a re-issued license.
