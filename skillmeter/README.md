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
  │  │ (Keychain /   │  │ with: timestamp, level,   │   │         │
  │  │  fallback)    │  │ event, session_id,        │   │         │
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
     >= 50 events                  Stop hook fires               │
     (auto-rotation)               (force transfer)              │
            │                             │                      │
            ▼                             ▼                      │
  ┌───────────────────────────────────────────┐                  │
  │  Atomic rename:                           │                  │
  │  events.jsonl → events.jsonl.{timestamp}  │                  │
  └────────────────────┬──────────────────────┘                  │
                       │                                         │
                       ▼                                         ▼
  ┌──────────────────────────────┐    ┌──────────────────────────────────┐
  │   transfer_log.js            │    │   session_end.js (direct)        │
  │   (background process)       │    │   (only on prompt_input_exit)    │
  │                              │    │                                  │
  │  1. Read NDJSON file         │    │  1. Build log entry with         │
  │  2. gzip compress            │    │     full conversation            │
  │  3. POST to backend          │    │  2. gzip compress                │
  │  4. Delete local file        │    │  3. POST to backend              │
  │     on success               │    │                                  │
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
│   └── .device-id           # Fallback device ID (non-macOS)
└── scripts/
    ├── logger.js            # Core logging library
    ├── session_start.js     # SessionStart hook handler
    ├── session_end.js       # SessionEnd hook handler + conversation extraction
    ├── user_prompt_submit.js# UserPromptSubmit hook handler
    ├── post_tool_use.js     # PostToolUse hook handler (Edit/Write/Read/WebSearch/WebFetch)
    ├── stop.js              # Stop hook handler + force log transfer
    └── transfer_log.js      # Background log uploader
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
- **Device ID** is a random UUID stored in the macOS Keychain (or a local fallback file), not derived from hardware.

## Log Transfer

Logs are sent to the backend via two mechanisms:

1. **Batch rotation** -- When `events.jsonl` reaches 50 entries, it is atomically renamed and uploaded in the background by `transfer_log.js`.
2. **Stop hook** -- When the user interrupts Claude, any accumulated logs are immediately transferred.
3. **Session end (direct)** -- When a session ends via `prompt_input_exit`, the full conversation is sent directly to the backend (bypassing the local log file).

All uploads use gzip compression. Successfully uploaded files are deleted locally.

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
