# Repository conventions

This is a public repository. Write documentation, code comments and PR text in
concise English for readers who do not know the team's internal history.

- Describe current behavior and what users or maintainers need to do. Avoid
  lengthy introductions, repeated explanations and narration of obvious code.
- Do not explain every edit. Add rationale only for non-obvious decisions,
  constraints, tradeoffs or behavior that would otherwise be easy to break.
- Keep internal issue keys (such as `INF-*` and `SBEE-*`), rollout coordination,
  investigation notes and historical checkpoints in Linear, not in source
  comments or product documentation. A relevant issue link in a PR is enough.
- Keep durable documentation limited to usage, contracts, ADRs and reproducible
  checks. Do not add reports or documents for each task, fix or review pass.
- Preserve important privacy boundaries, recovery constraints and test setup
  requirements when shortening text. Verify claims against the implementation;
  avoid promises such as "always safe" or "never fails."
- Do not commit credentials, real telemetry, personal paths, device identifiers
  or generated test receipts. Use synthetic fixtures for tests.
- Follow `docs/adr/` for shared behavior. Amend the relevant ADR
  when a policy decision changes instead of duplicating policy explanations.
- Keep PR descriptions focused on the final change and relevant validation.
  Use the release-note convention below.

## Implementation and validation

- Runtime hooks live in `skillmeter/scripts/`; shared logic belongs in its `lib/` directory.
  Use CommonJS, two-space indentation, double quotes and semicolons. Follow
  existing snake_case hook names and conventional commit subjects.
- Keep queues in persistent plugin data, never the install/cache directory.
  Resolve paths through `lib/paths.js` and `lib/plugin-data-root.js`; fail when
  no persistent data root can be established.
- Hooks receive plugin environment variables. Skill commands must start with
  `node` to match `Bash(node *)`; they derive the data root from the resolved
  installation path. Do not assume skill subprocesses inherit
  `CLAUDE_PLUGIN_ROOT`.
- Tests live in `test/` and fixtures in `testing/` at the repository root,
  outside the shipped `skillmeter/` directory, so they never reach users.
- Use `testing/helpers.js` for synthetic state. It loads bootstrap
  before runtime modules and forces a temporary plugin-data root. Tests that
  do not use helpers must load bootstrap themselves. Never test against real
  credential stores or plugin data.
- Run `node --test`. When changing hooks, inspect `skillmeter/hooks/hooks.json` and
  exercise affected handlers with synthetic stdin and isolated state. Verify
  relevant sanitization and consent behavior; historical snapshots additionally
  exclude tool results and images.
- Register only events that cannot change Claude Code's behavior. Never
  register `WorktreeCreate` (the hook replaces git worktree creation) or
  `PreModelSwitch` (it is synchronous and a timed-out hook blocks the switch);
  skip `MessageDisplay` (per streamed text delta, message content). Hooks whose
  stdout reaches Claude, such as `PostModelSwitch`, must print nothing.
- Claude Code does not enforce `timeout` on `async: true` command hooks, so
  async hooks carry none; every network call bounds itself with
  `AbortSignal.timeout`. Synchronous hooks keep an explicit `timeout`.
- Keep upload, retry and cleanup failures best-effort so hooks can return.
  Preserve existing validation, privacy boundaries and recovery behavior.

## Releases

Follow [RELEASING.md](../../RELEASING.md): branches, version bump, the `vX.Y.Z`
tag and its workflow, and the Claude Code release-note rules.

- Obtain approval before publishing unless already authorized.
