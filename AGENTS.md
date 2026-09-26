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
- Hooks receive plugin environment variables. Monitors pass substituted
  `CLAUDE_PLUGIN_DATA` explicitly. Skill commands must start with `node` to match
  `Bash(node *)`; they derive the data root from the resolved installation path.
  Do not assume skill/monitor subprocesses inherit `CLAUDE_PLUGIN_ROOT`.
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
- Keep upload, retry and cleanup failures best-effort so hooks can return.
  Preserve existing validation, privacy boundaries and recovery behavior.

## Release notes

Release notes are public. They say what changed for the user; the PR holds the
rest. Read the latest published release before writing one.

- Title `SkillMeter X.Y.Z`, then `### What changed`, `### After updating`,
  `### Known limitations`, and a final `Details: #PR, #PR` line.
- **What changed**: the user-visible outcome, one sentence per bullet, at most
  three bullets. No retry counts, line counts, algorithms or internal names.
- **After updating**: always `1. claude plugin update skillmeter@skillbench`
  and `2. Quit and reopen Claude Code` (hooks and monitors load per session).
  Add a sign-in step only when the release requires one. Do not add sentences
  about what is not needed.
- **Known limitations**: only what this release adds or changes. Otherwise
  `Unchanged from X.Y.Z.`, naming the release that lists them.
- **Details**: PR numbers only. ADRs and privacy documents are reachable from
  the PRs.
- Cut the release on the commit that bumps `skillmeter/.claude-plugin/plugin.json`,
  in the same PR cycle. The marketplace installs `main`, so a bumped version
  without a release is what users see.
- Obtain approval before publishing unless already authorized.
