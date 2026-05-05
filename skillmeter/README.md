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
                 ┌──────────────────────────────┐
                 │  SkillBench Backend          │
                 │  api.meter.skillbench.com    │
                 │  POST /logs/claude           │
                 │                              │
                 │  Headers:                    │
                 │    Content-Encoding: gzip    │
                 │    Authorization: Bearer ... │
                 └──────────────────────────────┘
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
| `SessionStart`      | Claude Code session begins    | `session_id`, `permission_mode`, `source`            |
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

## Privacy

- **File paths** are SHA-256 hashed (truncated to 16 hex chars) before logging -- actual paths never leave the machine.
- **Conversation content** is filtered to only include `text` and `thinking` blocks -- tool results, images, and other content types are stripped.
- **Device ID** is a random UUID stored in `~/.skillbench/credentials.json`, not derived from hardware.

## Log Transfer

Logs are sent to the backend from durable filesystem queues:

1. **Active event log** -- Hooks append NDJSON entries to `logs/events.jsonl`.
2. **Queue sealing** -- `Stop` and `SessionEnd` atomically rename the active log to `events.jsonl.<timestamp>` and stage sanitized transcripts under `logs/transcripts/pending/`.
3. **Immediate drain** -- `Stop` triggers a detached `drain_once.js` uploader. `SessionEnd` is synchronous and attempts a bounded 5-second drain before Claude exits.
4. **Fallback retry** -- `SessionStart` and the plugin retry monitor drain any sealed event logs or pending transcripts left on disk.

All uploads use gzip compression. Successfully uploaded event batches are renamed with `.sent`; successfully uploaded pending transcripts are deleted. Failed uploads remain queued for retry.

## Credential Store

SkillMeter stores device identity, hash salt, activation JWT, and GitHub fallback cooldown metadata in `~/.skillbench/credentials.json`. Keychain and plugin-local credential fallback files are no longer supported or migrated; users with older credentials should run `/skillmeter:activate` again after upgrading.

## Configuration

| Environment Variable       | Default                                          | Description              |
|---------------------------|--------------------------------------------------|--------------------------|
| `SKILLMETER_BACKEND_URL`  | `https://api.meter.skillbench.com/logs/claude`   | Backend endpoint         |
| `SKILLMETER_TIMEOUT`      | `10`                                             | Upload timeout (seconds) |

## Repo-Scoped Filtering

SkillMeter can restrict Claude Code telemetry to repositories owned by approved GitHub orgs.

Configure this per project in `.claude/settings.local.json`:

```json
{
  "skillmeter": {
    "telemetry": true,
    "repoScope": {
      "enabled": true,
      "allowedGitHubOrgs": ["andela"],
      "includeUnapprovedRepos": false
    }
  }
}
```

What it does:

- `repoScope.enabled`: turn repo-scoped filtering on
- `repoScope.allowedGitHubOrgs`: only collect telemetry when the current repo's Git remote belongs to one of these GitHub orgs
- `repoScope.includeUnapprovedRepos`: if `true`, external repos are still collected and tagged as external; if `false`, they are skipped

When repo-scoped filtering is enabled, Claude Code events are dropped by default for:

- directories that are not inside a Git repository
- repositories without a recognizable GitHub remote
- repositories outside the approved org list, unless opt-in expansion is enabled

### Using Claude Code And VS Code Together

If you also use the SkillMeter VS Code extension, configure repo-scoped filtering there separately in `.vscode/settings.json`:

```json
{
  "skillmeter.repoScope.enabled": true,
  "skillmeter.repoScope.allowedGitHubOrgs": ["andela"],
  "skillmeter.repoScope.includeUnapprovedRepos": false
}
```

Claude Code continues to use `.claude/settings.local.json` for its own telemetry and repo-scope settings. The two clients do not automatically share configuration.
