# Repository Guidelines

## Project Structure & Module Organization

This repository contains the `skillmeter/` Claude Code plugin. Runtime hook handlers live in `skillmeter/scripts/*.js`; shared logic belongs in `skillmeter/scripts/lib/`. The plugin manifest is `skillmeter/.claude-plugin/plugin.json`, hook wiring is in `skillmeter/hooks/hooks.json`, monitor wiring is in `skillmeter/monitors/monitors.json`, and user-facing slash-command skills live under `skillmeter/skills/*`. CLI entrypoints are in `skillmeter/bin/`. Local telemetry output is written under `skillmeter/logs/`; avoid committing generated log data.

## Build, Test, and Development Commands

There is no package manager manifest or build step. Use direct Node commands for local validation:

- `node skillmeter/scripts/session_start.js < sample.json`: run a hook handler with fixture stdin.
- `node skillmeter/scripts/telemetry.js`: exercise the telemetry command script.
- `node -c skillmeter/scripts/logger.js`: syntax-check a script without running it.
- `git diff --check`: detect whitespace errors before committing.

When changing hook mappings, inspect `skillmeter/hooks/hooks.json` and run the affected script directly with representative JSON input.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and Node shebangs for executable scripts. Keep indentation at two spaces, strings double-quoted, and semicolons enabled, matching the existing code. Hook files should be named after their Claude Code event in snake_case, for example `post_tool_use.js` or `permission_denied.js`. Put reusable transport, sanitization, settings, JWT, and path logic in `scripts/lib/` rather than expanding `logger.js`.

## Testing Guidelines

No automated test suite is currently present. For changes, perform focused manual checks by feeding JSON fixtures to the modified hook scripts and verifying exit codes, stderr messages, and any NDJSON written to `skillmeter/logs/events.jsonl`. For privacy-sensitive changes, confirm file paths are hashed and transcript sanitization excludes tool results, images, and unrelated content.

## Commit & Pull Request Guidelines

Recent history uses conventional commit prefixes such as `feat(hooks): ...`, `fix(transcript): ...`, and `refactor(logger): ...`. Follow that format with a concise imperative subject and a relevant scope. Pull requests should describe the behavior change, list manual validation commands, mention any telemetry or privacy impact, and link the related issue. Include screenshots only when changing user-visible command output or documentation rendering.

## Security & Configuration Tips

Do not commit secrets, JWTs, device IDs, or generated logs. Configuration is read from `.claude/settings.local.json` and environment variables such as `SKILLMETER_BACKEND_URL` and `SKILLMETER_TIMEOUT`; keep examples sanitized. Treat upload, retry, and cleanup paths as privacy-sensitive code and keep failures best-effort so hooks do not block Claude Code sessions.
