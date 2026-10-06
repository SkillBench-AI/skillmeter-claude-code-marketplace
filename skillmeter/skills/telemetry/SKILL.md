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

Before asking, mention in one line that `/skillmeter:telemetry enable`, run
inside a repository, opts that repository in without this review at all — the
global and organization gates still apply.

## The question

If no repository has a non-null `action`, report that there is nothing to
change and do not call `AskUserQuestion`. Otherwise call it once, with one
single-select question (`multiSelect: false`), header `Telemetry`, question
`Change telemetry for these repositories?`, and these options in this order:

- `Enable all (N off)`, if N > 0, where N counts repositories whose `action` is
  `"enable"`. Description: `Turn on the N repositories that are off.`
- `Disable all (M on)`, if M > 0, where M counts repositories whose `action` is
  `"disable"`. Description: `Turn off the M repositories that are on.`
- `Pick individually`, always. Description:
  `Print the list and reply with numbers or names.`

Read the answer:

- `Enable all (N off)`: apply every repository whose `action` is `"enable"`,
  and no other, in one `toggle`. `Disable all (M on)`: the same for
  `"disable"`. Print no list for either.
- `Pick individually`: print the list.
- Custom text, typed into the `Other` option that Claude Code adds to every
  question: it is neither a repository name nor an instruction, and changes
  nothing. Quote it back, say that nothing changed, and offer
  `Pick individually` by doing what it does: print the list and ask.
- `The user did not answer the questions.`: change nothing, run no command,
  say so, and stop.
- A rejected tool call, which is what Esc produces — an error saying the tool
  use was rejected, with or without a message: stop. Change nothing, run no
  command, and ask nothing further.

## The list

Print it as plain text in your reply, never through `AskUserQuestion`: one
line per repository whose `action` is not `null`, grouped by current state —
off (`action` `"enable"`) first, then on (`action` `"disable"`), each in JSON
order — and numbered 1, 2, 3, … continuously across both groups. Mark lines as
the sign-in inventory does, `○ OFF` or `✓ ON`, then the `displayName`. Leave
out an empty group. Where two repositories share a `displayName`, print the
suffix their `optionLabel`s add after it. The blocked ones (`action` `null`)
come last, unnumbered, each with its `description`:

```text
Off — naming one turns it on
  1. ○ OFF  @acme/api
  2. ○ OFF  @acme/web
On — naming one turns it off
  3. ✓ ON   @acme/docs
Blocked — cannot be changed here
     ○ OFF  @other/tool  Disabled for @other.
```

Then ask, in one line, for the repositories to change in the next message: by
number, or by name or part of a name, separated by commas or spaces, or
`none`; each one named switches, off to on or on to off. End your turn there,
and run no command until the reply arrives.

## The reply

The next message is the reply, and these instructions apply to it; numbers and
names refer to the list printed last. A message that is plainly a different
request is not a reply: change nothing and handle it as that request. `none`,
or a reply that plainly declines, changes nothing.

Otherwise split the reply into tokens at commas, whitespace and the word `and`,
and resolve each to exactly one numbered line:

- A token of digits only is a line number. No such line: not a repository.
- Any other token shorter than three characters, or, ignoring case, any of
  `the`, `a`, `an`, `to`, `for`, `in`, `of`, `on`, `off`, `all`, `turn`,
  `enable`, `disable`, `please`, `repo`, `repos`, `repository`,
  `repositories`, `telemetry`, is not a repository, whatever names contain it.
- Each remaining token names every numbered line whose `displayName`
  contains it, ignoring case. One line: that repository. None: not a repository
  — if it matches only a blocked repository, say so and why. Several: ambiguous.

Never match a path, an `id`, an `optionLabel`, a `description`, or anything
else the list did not print, and never guess. A repository named twice counts
once. If any token is not a repository or is ambiguous, change nothing at all,
not even for the tokens that resolved: quote each one back, the ambiguous ones
with the numbered lines they matched, and ask for the whole selection again by
number or name. Say once that each repository switches as the list shows, off
to on and on to off, so a word like `on` or `off` is not an instruction. End
your turn. When every token resolves, apply them all in one `toggle`.

## Applying

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js toggle REVISION ID...
```

Run it once per run, with the `revision` from the `list` result and every
validated 12-character hexadecimal ID together. It applies each repository's
own `action`, so each ID switches as the list showed. Never pass a repository
path, display name, custom answer, or inferred ID to it. If it fails, report
the error and change nothing more.

The settings changed while this was open if the result has `stale: true`
(nothing was written) or an entry carries `reason: "stale_policy"` (the IDs
before it were applied, the rest were not). Report exactly what was and was not
applied, never retry the selection on your own, re-run `list`, print the list
once from it, and ask for a reply again; the next `toggle` uses its `revision`.

End with every repository changed and its new state, every one unchanged with
its reason, and the blocked ones with their `description`.

For a non-empty argument other than `list`, preserve backward compatibility by
running the existing telemetry management script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.js $ARGUMENTS
```

Report the result.
