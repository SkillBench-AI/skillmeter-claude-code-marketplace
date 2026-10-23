---
name: telemetry
description: Review and toggle SkillMeter telemetry for local organization repositories, show status, turn the current repository on or off, or pause and resume Codex telemetry.
---

`<plugin-root>` in the commands below is this plugin's installed root: the
absolute path of the directory two levels above this `SKILL.md`. Substitute it
yourself; `$PLUGIN_ROOT` is not set in the shell that runs skill commands.

The user runs this skill as `$skillmeter:telemetry`, optionally followed by one
of `list` (the default), `status`, `enable`, `disable`, `enable-global` or
`disable-global`, the same commands as `/skillmeter:telemetry` in SkillMeter
for Claude Code. Map a request in other words to one of them. These controls
change only SkillMeter for Codex; Claude Code keeps its own choices.

Run the commands from the repository the user is asking about; the scripts
resolve the nearest Git root and take no path. Show each command's output
verbatim in a fenced code block and add nothing it does not say. Change a
choice only when the user explicitly asks; never pick ON or OFF for them.

The scope statement, shown before anything is turned on:

> This choice applies to SkillMeter for Codex on this machine and to every
> clone or worktree of the repository. It does not change SkillMeter for
> Claude Code.

Pass `--acknowledge-machine-scope` only after the user has seen that statement
in this conversation and confirmed the change that turns something on.

## list

First call the `review_repositories` tool of the `skillmeter` MCP server with
`cwd` set to the absolute working directory. It shows the user a form with an
ON/OFF picker per repository and the scope statement, and saves only the
changes. Act on its `outcome`:

- `applied`: report every entry of `result.results` (`changed`, `effective`,
  `reason`) and every `blocked` repository with its `blockedBy`, as below.
  If `result.cleanupDeferred` is true, say that queued-data cleanup finishes at
  the next upload attempt.
- `unchanged` or `nothing_to_review`: report the current state and the
  `blocked` repositories.
- `stale`: call the tool once more.
- `declined` or `cancelled`: report that nothing was saved, then offer the text
  list below once, in case no form was shown.
- `unavailable`, `error`, or no such tool: use the text list below.

The text list:

```sh
node "<plugin-root>/scripts/repository_telemetry.js" list
```

Parse the JSON. It has no local paths; never infer or request them. If the
command fails, report the error and change nothing. If `repositories` is
empty, report that no local repositories of the licensed organizations were
found.

Report the global state and how many repositories are on and off. List every
repository with an `action` as a numbered line: `ON` or `OFF` (its
`effective`), its exact `displayName`, and what selecting it does (`action`).
List repositories without an `action` separately with their `blockedBy`:
`paused` (resume with `enable-global`), `organization_off` or
`organization_choice_required` (choose with `$skillmeter:signin`), or
`local_restriction` (this checkout's local OFF; see `unrestrict`). Before the
numbered list, mention that `enable` inside a repository turns that one on
without the list.

Ask the user which numbers to toggle; when any selected entry would turn on,
show the scope statement with the question. End the message and wait for the
reply. A reply with no recognizable number changes nothing. Then run one
command with the exact `key` of every selected entry and the `revision` from
the same list:

```sh
node "<plugin-root>/scripts/repository_telemetry.js" toggle REVISION KEY... --acknowledge-machine-scope
```

Omit `--acknowledge-machine-scope` when every selected entry turns off. Never
pass display names, paths, numbers or custom text as keys. If the result has
`stale: true`, run `list` again, show the new list and ask again; never apply
the old selection. Report every result: `changed`, `effective`, and `reason`
for a repository that was not changed. If `cleanupDeferred` is true, say that
queued-data cleanup finishes at the next upload attempt.

## status

```sh
node "<plugin-root>/scripts/telemetry.js" status
```

`status` is read-only. It prints a short card: the capture state for this
repository, the reason when capture is not on, sign-in, and the local upload
queue. Run `status --details` only when the user asks for diagnostics; it adds
transcript health and delivery lines. Neither verifies hook execution, server
acceptance or report generation; do not claim delivery from an empty queue.

## enable and disable

Turn the current repository on or off:

```sh
node "<plugin-root>/scripts/telemetry.js" enable --acknowledge-machine-scope
node "<plugin-root>/scripts/telemetry.js" disable
```

Before `enable`, show the scope statement and wait for confirmation. Before
`disable`, tell the user that it removes the queued, unsent payloads this
plugin attributed to the repository, for every clone and worktree; that
requests already in flight may finish; and that turning it on again does not
restore removed payloads. Each command prints a result card.

If a command fails, relay the code and message, then act on it:

- `ORGANIZATION_CONSENT_REQUIRED`: the organization has no ON choice yet. Tell
  the user to run `$skillmeter:signin`, which asks for it.
- `ACKNOWLEDGEMENT_REQUIRED`: the scope statement was not confirmed.
- `LOCAL_CONSENT_CONFLICT`: a local OFF or invalid setting in this checkout
  restricts it. `unrestrict` clears a root-level OFF; a descendant or
  unparsable `.codex/settings.local.json` must be edited by the user. Do not
  edit or delete these files yourself unless the user asks.
- `REPOSITORY_UNAVAILABLE`: no licensed GitHub repository resolves here;
  suggest `status` and the check-repo-scope skill.
- `STALE_POLICY`: run the command again once; another writer changed the
  record.

## enable-global and disable-global

Pause or resume all Codex collection on this machine:

```sh
node "<plugin-root>/scripts/telemetry.js" disable-global
node "<plugin-root>/scripts/telemetry.js" enable-global
```

The pause stops Codex capture and uploads for every repository and keeps
queued data. It does not pause SkillMeter for Claude Code. Requests already in
flight may finish. Resuming allows later delivery attempts when sign-in and
consent permit; it does not guarantee delivery. Run `status` afterwards and
show its card.

## Codex-only controls

Use these only when the user asks for them by name or the steps above point to
them.

- `restrict` / `unrestrict`: write or clear a local OFF in this checkout's
  `.codex/settings.local.json`. A local OFF blocks capture in this checkout even
  when the repository is ON; `unrestrict` never turns anything on. Before
  `restrict`, give the same warning as for `disable`.

  ```sh
  node "<plugin-root>/scripts/telemetry.js" restrict
  node "<plugin-root>/scripts/telemetry.js" unrestrict
  ```

- `consent-preview` shows the repository key, the record revision, every
  local choice along the path, and notices. It is read-only. `consent-set`
  records one organization or repository choice against that revision;
  `consent-set --help` prints its arguments. Prefer `$skillmeter:signin` for
  organizations and `enable`/`disable` for repositories.

  ```sh
  node "<plugin-root>/scripts/telemetry.js" consent-preview --json
  ```

A saved choice does not prove hook execution or delivery.
