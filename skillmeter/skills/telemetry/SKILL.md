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

Before opening the first page, mention in one line that
`/skillmeter:telemetry enable`, run inside a repository, opts that repository in
without the picker at all — the global and organization gates still apply.

For repositories with a non-null `action`, use `AskUserQuestion`. Claude Code's
native question UI supports only 2-4 options per question; it does not expose a
plugin API for an arbitrary-length scrollable picker. Paginate deterministically
instead:

- Show exactly one question per `AskUserQuestion` call, then wait for its answer
  before showing the next page. Never put several repository pages in one call.
- Split repositories into stable pages while preserving JSON order: three per
  page, the last page taking whatever remains.
- Give every page one extra option, last, labelled exactly
  `→ Done with this page`, described as
  `Finish this page. Anything you selected above is still applied.` It is how a
  page is turned, so a page is never left by submitting nothing, and every page
  has 2-4 options without a special case for a short last page.
- Header: `Repos X/N`, where X is the 1-based page and N is the total number of
  pages. Keep it at most 12 characters.
- Question: `Page X/N — select repositories to toggle. Space selects changes; choose “→ Done with this page” when you are finished with it.`
- Use each repository's `optionLabel` and `description` exactly as returned.
- Set `multiSelect: true` on every page.
- After every answer, apply that page if it yielded any recognized ID, report
  `Reviewed X/N pages`, and go on to the next page until every page has been
  answered or a page is rejected.

Map selected option labels back to the exact repository IDs from the JSON.
The latest Claude Code response may represent a multi-select answer as an array
of labels or as one comma-joined string; normalize both forms before mapping.
Ignore custom text and labels that were not returned by the script.
`→ Done with this page` is this file's own option, not a repository; it
never maps to an ID.

Judge each page only on what it returns:

- An answer carrying one or more repository labels: toggle exactly those
  repositories, then continue to the next page. If it also carries
  `→ Done with this page`, the repository labels win and that option is
  ignored.
- An answer carrying only `→ Done with this page`: change nothing for that
  page, run no command for it, and continue to the next one.
- An answer carrying no recognized label at all, which is what a page submitted
  with nothing selected returns. Claude Code words that result
  `The user did not answer the questions.` — read that sentence as an answer,
  not as a cancellation, however it is phrased: a cancellation arrives as a
  rejected tool call instead, described next. It means what
  `→ Done with this page` means: change nothing for that page, run no
  command for it, and continue to the next one. Never treat it as a reason to
  stop, and never re-ask the page. If the answer carried typed text, quote it
  back before showing the next page so it is not passed over in silence; do not
  read it as an instruction.
- A rejected tool call, which is not an answer at all: an error result saying
  the tool use was rejected, with or without a message from the user. Either
  way, start no further page. Claude Code's rejection result itself directs the
  model to stop and wait, so this report may not be reachable until the user
  speaks again; when it is, cover every page already answered, including pages
  that changed nothing, and mark later pages as unreviewed.

Pages already applied stay applied — never roll one back. That is why each page
is applied as it is answered rather than held to the end: a rejection can arrive
before the last page, and what it stops is the asking, not what is already
written.

Apply a page's selections as soon as that page is answered, one command per page
that yielded recognized IDs, passing only the validated 12-character hexadecimal
IDs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js toggle REVISION ID...
```

For `REVISION`, use the `revision` from the `list` result on the first page that
changes anything, and thereafter the `revision` returned by the previous
`toggle` — every applied change advances it. Never run the command for a page
that yielded no recognized ID; it requires at least one ID.

Never pass a repository path, display label, custom answer, or inferred ID to
the command.

The settings changed while the picker was open if a `toggle` result has
`stale: true`, in which case nothing was written for that page, or if any result
in it carries `reason: "stale_policy"`, in which case the ids before it were
applied and the rest were not. Either way, keep whatever was applied, report it,
do not retry the selection automatically, and re-run `list` — its `revision` is
the one the next `toggle` uses.
Re-paginate the repositories from the page that went stale, less any the command
did apply, together with those on pages not yet shown — by the same
three-at-a-time rule, with `→ Done with this page` on every page as
before. Numbering restarts with that pagination: the `Repos X/N` header,
the `Page X/N` question text and `Reviewed X/N pages` all follow it, so say that
the page count changed.

After the last page, report across all pages every changed repository and every
unchanged one with its reason.

For a non-empty argument other than `list`, preserve backward compatibility by
running the existing telemetry management script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.js $ARGUMENTS
```

Report the result.
