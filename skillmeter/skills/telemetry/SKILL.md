---
description: Review and toggle SkillMeter telemetry for local organization repositories
argument-hint: <list>
disable-model-invocation: true
allowed-tools: AskUserQuestion Bash(node *)
---

## Current repository state

The following command is dynamic context. Claude Code runs it before this skill
is sent to the model:

```!
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

If `$ARGUMENTS` is empty or exactly `list`, first parse the JSON emitted in
`Current repository state`. If dynamic skill shell execution was disabled, the
output is missing, or it is not valid JSON, run the fallback:

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

For repositories with a non-null `action`, use `AskUserQuestion`. Claude Code's
native question UI supports only 2-4 options per question; it does not expose a
plugin API for an arbitrary-length scrollable picker. Paginate deterministically
instead:

- Show exactly one question per `AskUserQuestion` call, then wait for its answer
  before showing the next page. Never put several repository pages in one call.
- Split repositories into stable pages while preserving JSON order: take four
  at a time, except take three when five remain, leaving a final page of two.
  Every page therefore has 2-4 options.
- Header: `Repos X/N`, where X is the 1-based page and N is the total number of
  pages. Keep it at most 12 characters.
- Question: `Page X/N — select repositories to toggle. Space selects changes; unselected repositories stay unchanged.`
- Use each repository's `optionLabel` and `description` exactly as returned.
- Set `multiSelect: true` on every page with two or more repositories.
- With exactly one repository, use a single-select question with that
  repository first and `Keep unchanged` second.
- After every answer, report `Reviewed X/N pages` and immediately show the next
  page until all pages have been answered. A cancellation on any page cancels
  the entire operation and makes no changes.

Map selected option labels back to the exact repository IDs from the JSON.
Keep the exact integer `revision` returned by the same list result.
The latest Claude Code response may represent a multi-select answer as an array
of labels or as one comma-joined string; normalize both forms before mapping.
Ignore custom text and labels that were not returned by the script. Accumulate
recognized IDs across every page. If the user cancels or selects no recognized
repository, make no changes.

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
