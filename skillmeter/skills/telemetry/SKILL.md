---
description: Review and toggle SkillMeter telemetry for local organization repositories
argument-hint: <list>
disable-model-invocation: true
allowed-tools: AskUserQuestion Bash(node *)
---

If `$ARGUMENTS` is empty or exactly `list`, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Parse the JSON output. Repository paths are intentionally absent; never infer
or request them. The `effective` field is the current capture state after the
global, organization, ownership, and repository gates have all been applied.
If the command fails, report the error and make no changes. If no repositories
are returned, report that no local organization repositories were found and do
not call `AskUserQuestion`.

Report the global state and the enabled and disabled counts. Repositories whose
`action` is `null` are blocked by the global or organization setting: list
their `optionLabel` and `description`, but do not offer them as toggle choices.

For repositories with a non-null `action`, use `AskUserQuestion`:

- Header: `Repositories`
- Question: `Select repositories to toggle. Space selects changes; unselected repositories stay unchanged.`
- Use each repository's `optionLabel` and `description` exactly as returned.
- With two or more repositories, set `multiSelect: true`. Split choices into
  groups of 2-4 options, with at most four questions per tool call. Do not leave
  a final group of one; move one option from the previous group into it. Repeat
  tool calls until every actionable repository has been shown.
- With exactly one repository, use a single-select question with that
  repository first and `Keep unchanged` second.

Map selected option labels back to the exact repository IDs from the JSON.
Keep the exact integer `revision` returned by the same list result.
Ignore custom text and labels that were not returned by the script. If the user
cancels or selects no recognized repository, make no changes.

Apply all selected toggles in one command, passing only the validated
12-character hexadecimal IDs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js toggle REVISION ID...
```

Report every changed repository and any unchanged repository with its reason.
If the result has `stale: true`, report that the settings changed while the
picker was open and re-run `list`; do not retry the old selection automatically.
Never pass a repository path, display label, custom answer, or inferred ID to
the command.

For a non-empty argument other than `list`, preserve backward compatibility by
running the existing telemetry management script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.js $ARGUMENTS
```

Report the result.
