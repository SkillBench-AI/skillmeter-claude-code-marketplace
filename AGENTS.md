# Repository Guidelines

## Project Structure & Module Organization

This repository contains the `skillmeter/` Claude Code plugin. Runtime hook handlers live in `skillmeter/scripts/*.js`; shared logic belongs in `skillmeter/scripts/lib/` rather than alongside the handlers. Telemetry output is written under `${CLAUDE_PLUGIN_DATA}/logs/`, never inside the repository or the plugin install dir; avoid committing generated log data.

## Build, Test, and Development Commands

There is no package manager manifest or build step. Use direct Node commands for local validation:

- `node --test`: run the complete automated test suite.
- `CLAUDE_PLUGIN_DATA=$(mktemp -d) node skillmeter/scripts/session_start.js < sample.json`: run a hook handler with fixture stdin.
- `CLAUDE_PLUGIN_DATA=$(mktemp -d) node skillmeter/scripts/telemetry.js`: exercise the telemetry command script.

`CLAUDE_PLUGIN_DATA` is the persistent plugin data dir and is **required** — Claude Code provides it when a hook runs, and `scripts/lib/paths.js` throws without it. It has no fallback on purpose: the install dir changes on every plugin update and is reclaimed afterwards, so a queue written there would be stranded. Point it at a throwaway dir for direct runs; never at a real `~/.claude/plugins/data/*` entry.

When changing hook mappings, inspect `skillmeter/hooks/hooks.json` and run the affected script directly with representative JSON input.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and Node shebangs for executable scripts. Keep indentation at two spaces, strings double-quoted, and semicolons enabled, matching the existing code. Hook files should be named after their Claude Code event in snake_case, for example `post_tool_use.js` or `permission_denied.js`. Put reusable transport, sanitization, settings, JWT, and path logic in `scripts/lib/` rather than expanding `logger.js`.

## Testing Guidelines

Automated tests live under `skillmeter/test/*.test.js` and use Node's built-in test runner. Put reusable temp-directory, JSON, JWT, and child-process fixtures in `skillmeter/testing/helpers.js`; fixtures must isolate state through `SKILLMETER_STATE_DIR` or `CLAUDE_PLUGIN_DATA` and clean up temporary files.

`skillmeter/testing/bootstrap.js` forces `CLAUDE_PLUGIN_DATA` to a fresh temp dir and must load before any `scripts/` module — requiring `testing/helpers` pulls it in, so only a test file that uses no helpers needs to require it directly. It overrides rather than defaults the variable, so an ambient value exported for a real plugin cannot make the suite touch that plugin's data. Run `node --test` after changes, then perform focused manual checks for modified hooks by feeding representative JSON stdin and verifying exit codes, stderr messages, and NDJSON output. For privacy-sensitive changes, confirm file paths are hashed and transcript sanitization excludes tool results, images, and unrelated content.

## Commit & Pull Request Guidelines

Recent history uses conventional commit prefixes such as `feat(hooks): ...`, `fix(transcript): ...`, and `refactor(logger): ...`. Follow that format with a concise imperative subject and a relevant scope. Pull requests should describe the behavior change, list manual validation commands, mention any telemetry or privacy impact, and link the related issue. Include screenshots only when changing user-visible command output or documentation rendering.

## Security & Configuration Tips

Do not commit secrets, JWTs, device IDs, or generated logs. Configuration is read from `.claude/settings.local.json` and environment variables such as `SKILLMETER_BACKEND_URL` and `SKILLMETER_TIMEOUT`; keep examples sanitized. Treat upload, retry, and cleanup paths as privacy-sensitive code and keep failures best-effort so hooks do not block Claude Code sessions.
