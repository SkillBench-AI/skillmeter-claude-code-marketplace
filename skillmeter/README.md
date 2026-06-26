# Skillmeter

A Claude Code plugin that tracks session activity and tool usage, providing anonymized telemetry to the [SkillBench](https://skillbench.com) platform for developer skill analytics.

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
  │  2. gzip compress            │    │  2. Scan pending transcripts     │
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
                 │  `telemetry_endpoint` claim, minted    │
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
│   ├── events.jsonl         # Active event log (NDJSON)
│   ├── events.jsonl.*       # Sealed event batches awaiting upload
│   └── transcripts/pending/ # Sanitized transcripts awaiting upload
└── scripts/
    ├── logger.js            # Core logging library
    ├── harness.js           # Level 1 harness metadata detection (SessionStart)
    ├── session_start.js     # SessionStart hook handler
    ├── session_end.js       # SessionEnd hook handler + conversation extraction
    ├── user_prompt_submit.js# UserPromptSubmit hook handler
    ├── post_tool_use.js     # PostToolUse hook handler (Edit/Write/Read/WebSearch/WebFetch)
    ├── stop.js              # Stop hook handler + detached drain trigger
    ├── drain_once.js        # One-shot queue uploader
    └── monitors/
        └── retry_daemon.js  # Long-running retry monitor
```

## Hook Events

| Hook               | Trigger                        | Data Collected                                       |
|---------------------|-------------------------------|------------------------------------------------------|
| `SessionStart`      | Claude Code session begins    | `session_id`, `permission_mode`, `source`, `model`, `agent_type`, [`harness`](#harness-metadata) |
| `UserPromptSubmit`  | User submits a prompt         | `prompt`, `permission_mode`, hashed `transcript_path`|
| `PostToolUse`       | After Edit/Write/Read/WebSearch/WebFetch | `tool_name`, `tool_use_id`, hashed `file_path`|
| `Stop`              | User interrupts Claude        | `permission_mode`, `stop_hook_active`                |
| `SessionEnd`        | Session ends                  | `permission_mode`, `reason`, full conversation       |

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

## Harness Metadata

To judge a session fairly, analysis needs to know whether the developer was
working *bare* or with a sophisticated **harness** — the instruction files,
skills, hooks, plugins, and orchestration wrapped around the agent. The
`SessionStart` event carries a `harness` block describing the **presence and
shape** of that scaffolding. It is **metadata only**: SkillMeter never collects
raw `CLAUDE.md` / `AGENTS.md` / skill / hook-config contents.

Detection is split by what is actually observable:

- **Level 1 (filesystem-detectable, collected today):** instruction-file
  presence, skills, hooks, and plugin/agent info — probed once at session start
  by [`scripts/harness.js`](scripts/harness.js).
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
- **Tier 1 fail-closed at the harness boundary:** before any skill name is
  hashed or emitted it is scanned for Tier 1 secrets, and a name that embeds one
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

## Privacy

- **File paths** are SHA-256 hashed (truncated to 16 hex chars) before logging -- actual paths never leave the machine.
- **Conversation content** is filtered to only include `text` and `thinking` blocks -- tool results, images, and other content types are stripped.
- **Device ID** is a random UUID stored in `~/.skillbench/credentials.json`, not derived from hardware.
- **Harness metadata** (`SessionStart`) is presence/shape only and runs through the Tier-1/Tier-2 sanitizer; see [Harness Metadata](#harness-metadata).

## Log Transfer

Logs are sent to the backend from durable filesystem queues:

1. **Active event log** -- Hooks append NDJSON entries to `logs/events.jsonl`.
2. **Queue sealing** -- `Stop` and `SessionEnd` atomically rename the active log to `events.jsonl.<timestamp>` and stage sanitized transcripts under `logs/transcripts/pending/`.
3. **Immediate drain** -- `Stop` triggers a detached `drain_once.js` uploader. `SessionEnd` is synchronous and attempts a bounded 5-second drain before Claude exits.
4. **Fallback retry** -- `SessionStart` and the plugin retry monitor drain any sealed event logs or pending transcripts left on disk.

All uploads use gzip compression. Successfully uploaded event batches are renamed with `.sent`; successfully uploaded pending transcripts are deleted. Failed uploads remain queued for retry.

## Credential Store

SkillMeter stores device identity, hash salt, license JWT, allowed GitHub identities, the global telemetry kill-switch, and the GitHub fallback cooldown in `~/.skillbench/credentials.json`. Keychain and plugin-local credential fallback files are no longer supported or migrated; users with older credentials should run `/skillmeter:signin` after upgrading.

## Slash Commands

| Command                              | Purpose                                                            |
|--------------------------------------|--------------------------------------------------------------------|
| `/skillmeter:signin`                 | Sign in with GitHub (silent via `gh`, or device-flow fallback)     |
| `/skillmeter:signout`                | Sign out and stop all telemetry; keeps device identity intact      |
| `/skillmeter:telemetry enable`       | Opt the current project in                                         |
| `/skillmeter:telemetry disable`      | Opt the current project out                                        |
| `/skillmeter:telemetry enable-global`| Clear the machine-global telemetry kill-switch                     |
| `/skillmeter:telemetry disable-global`| Pause telemetry across every project on this machine              |
| `/skillmeter:telemetry status`       | Show global, per-project, and sign-in state                        |

## Configuration

| Environment Variable           | Default                                                                       | Description                                                                                                                                  |
|--------------------------------|-------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `SKILLMETER_BACKEND_URL`       | unset — endpoint resolved from the license JWT's `telemetry_endpoint` claim   | Base-URL override for local development / integration tests (e.g. `http://localhost:8080`). Bypasses the JWT check; callers append `/logs/claude` and `/logs/claude/transcript`. |
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

Resolution order is env var → settings file → built-in default. Typically you set the env vars together when running activation against dev; once the JWT is cached, telemetry routing is read straight from its `telemetry_endpoint` claim and doesn't need `SKILLMETER_BACKEND_URL`.

## Repo-Scoped Filtering

Telemetry is gated to repositories owned by GitHub identities captured and persisted during `/skillmeter:signin`. The allowed list includes the signed-in user's own login plus every org returned by `GET /user/orgs` at sign-in time, stored in `~/.skillbench/credentials.json` next to the device ID and license JWT. Only repositories matching an identity in this persisted allow-list are eligible for telemetry.

Events are dropped — even in workdirs where the user ran `/skillmeter:telemetry enable` — for:

- directories that are not inside a Git repository
- repositories without a recognizable GitHub remote
- repositories whose remote owner is not present in the stored allow-list (even if the user is currently a member of that org but it was excluded at sign-in time or added to their account afterward)

### Narrowing scope to specific orgs

By default every signed-in org is in scope. If an account belongs to several orgs but should only capture telemetry for some (e.g. only `skillbench-ai`), narrow it. Narrowing is intersected with the signed-in orgs, so it can only restrict the captured set — never widen it.

- **At sign-in:** `! <plugin>/bin/signin --org skillbench-ai` (repeatable / comma-separated). Only the listed orgs are persisted — the fix for the silent `gh` path enrolling every org. Re-running with `--org` while already signed in re-scopes the stored list in place; re-expanding later needs sign-out + sign-in.
- **At runtime / globally:** `SKILLMETER_REPO_SCOPE_ORGS="skillbench-ai"` (env) or `{ "skillmeter": { "repoScopeOrgs": ["skillbench-ai"] } }` in `<project>/.claude/settings.local.json`. The same values are honored both at sign-in and by the runtime repo-scope gate. Precedence: `--org` > env > setting. Org names match case-insensitively.

### Per-project opt-in & auto-enable

Whether a project emits telemetry resolves in three states:

- **Explicitly disabled** (`/skillmeter:telemetry disable`) — never sends; always wins.
- **Explicitly enabled** (`/skillmeter:telemetry enable`) — sends (still subject to the repo-scope filter above).
- **Unset** (default) — telemetry **auto-enables when the repo is owned by an allowed org** (the same `GET /user/orgs` set used for repo-scoped filtering). For any other directory it stays off until you choose. SessionStart prints `telemetry auto-enabled — repo owned by allowed org`; run `/skillmeter:telemetry disable` to opt a matching project back out.

The machine-global kill-switch (`/skillmeter:telemetry disable-global`) overrides all of the above.

To refresh the allowed identity list (e.g. after joining a new org), run `/skillmeter:signin` again.
