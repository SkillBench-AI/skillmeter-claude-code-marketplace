---
name: signin
description: Sign in to SkillMeter through the SkillBench sign-in service, then choose Codex telemetry for each licensed GitHub organization.
---

`<plugin-root>` in the commands below is this plugin's installed root: the
absolute path of the directory two levels above this `SKILL.md`. Substitute it
yourself; `$PLUGIN_ROOT` is not set in the shell that runs skill commands.

Run sign-in when the user wants to authenticate SkillMeter, when SkillMeter
reports that sign-in is required, or to recover rejected uploads:

```sh
node "<plugin-root>/scripts/signin.js"
```

Follow exactly one of the flows below, based on what the script prints.

## Sign-in required

The script prints a device code and a verification URL. Relay both verbatim,
tell the user to approve in their browser (choosing the workspace there when
asked) and to tell you when the browser shows success. Then run the script
again: it confirms the sign-in and prints the state for the next flow. If it
prints a new code instead, the approval did not complete; relay that code.

## Signed in

The script prints status cards and a `SkillMeter sign-in state JSON:` line.
For each organization, one card shows whether telemetry is on, off, awaiting a
choice or paused, and a second lists its local repositories as ON or OFF.
Reproduce every card in one fenced code block to preserve alignment, then
parse the JSON. Do not restate the cards in prose. The session is stored in `~/.skillbench/clients/codex/` and is not
shared with other SkillMeter clients. Report results without exposing
credentials.

If the state has `consentRecordError`, do not ask about telemetry. Report the
code and run `node "<plugin-root>/scripts/telemetry.js" status`; the consent
record must be repaired first. If `orgs` is empty, report that sign-in
succeeded but the license covers no GitHub organization, and stop.

### Asking with a form

For each organization, in the order given, first call the `onboard_organization`
tool of the `skillmeter` MCP server with the organization exactly as in the
state and `cwd` set to the absolute working directory. It shows the user a form
with a picker for the same question as below, including the repositories and
the scope statement, and saves the answer itself. Act on its `outcome`:

- `applied`: print the summary described under "Applying the choice" from
  `result`. Do not run a command for this organization.
- `unchanged`: report that the setting was kept.
- `stale`: the choices changed meanwhile; call the tool once more.
- `declined` or `cancelled`: nothing was saved. Report that, then ask the text
  question below once, in case no form was shown.
- `unavailable`, `error` with a code other than `ORGANIZATION_UNAVAILABLE`, or
  no such tool: ask the text question below.
- `error` with `ORGANIZATION_UNAVAILABLE`: report it and ask nothing for this
  organization.

### Asking in text

Each telemetry question below is one message with numbered options and the
exact labels and descriptions given here. End the message there and wait for
the user's reply; do not run a command in the same turn. If a structured
question tool such as `request_user_input` is available, you may use it with
the same text and options instead. Map the reply to one option. A reply that
names no option, or asks to skip, cancels the question: run no command, and
report that the setting was left unchanged. Never choose for the user and
never infer consent from the sign-in request.

### Telemetry for each organization

Handle organizations one at a time, in the order given. Before each question,
run a fresh repository scan from the current working directory:

```sh
node "<plugin-root>/scripts/repository_telemetry.js" list
```

Keep only repositories whose `org` exactly equals the organization. Never show
or infer local paths. If the command fails, report its error and ask nothing
for that organization. Call these repositories *listed* when `localRestriction`
is false; name any with `localRestriction: true` separately as "turned off in
this checkout's local settings" and never include them in a command.

The scope statement, used in every question that can turn telemetry on:

> This choice applies to SkillMeter for Codex on this machine and to every
> clone or worktree of these repositories. It does not change SkillMeter for
> Claude Code.

**Organization `consent` is `null`** (no choice yet). Ask:

- Question: `Choose telemetry for @ORG.`, then `Repositories found:` and every
  listed repository's exact `displayName`, one per line (or
  `No local @ORG repositories found.`), then the scope statement.
- `Enable listed repositories`: `Authorize @ORG and turn on sanitized
  telemetry for every repository listed above.` Offer only when repositories
  are listed.
- `Organization only`: `Authorize @ORG and keep every listed repository off.
  You can turn repositories on later with `$skillmeter:telemetry`.`
- `Keep telemetry off`: `Keep @ORG and its repositories off. You can choose
  later by running `$skillmeter:signin` again.`

**Organization `consent` is `true`.** Listed repositories whose `consent` is
`null` are *new*. Ask:

- Question: `Keep SkillMeter telemetry authorized for @ORG?`. When new
  repositories exist, add `New repositories:`, each `displayName` on its own
  line, and the scope statement.
- `Enable new repositories`: `Turn on sanitized telemetry for the new
  repositories listed above.` Offer only when new repositories exist.
- `Keep authorized`: `Keep @ORG authorized. Only repositories turned on
  collect telemetry.`
- `Turn telemetry off`: `Stop collecting and sending Codex telemetry for @ORG.
  You can enable it again later.`

**Organization `consent` is `false`.** Ask:

- Question: `Authorize SkillMeter telemetry for @ORG?`, then the scope
  statement.
- `Authorize @ORG`: `Re-authorize @ORG. Repositories already turned on resume
  collection.`
- `Keep off for now`: `Keep Codex telemetry off for @ORG. You can enable it
  later by running `$skillmeter:signin` again.`

### Applying the choice

Pass the exact integer `revision` from the latest `list` (or `absent`), the
organization exactly as in the state, and the exact `key` of each repository
shown in the question. Never pass display names, paths, custom input or
repositories from another organization. Choosing an option that turns
anything on confirms the scope statement shown in that question; pass
`--acknowledge-machine-scope` only then.

- `Enable listed repositories` or `Enable new repositories`:

  ```sh
  node "<plugin-root>/scripts/repository_telemetry.js" onboard REVISION ORG enabled KEY... --acknowledge-machine-scope
  ```

- `Organization only`:

  ```sh
  node "<plugin-root>/scripts/repository_telemetry.js" onboard REVISION ORG disabled KEY... --acknowledge-machine-scope
  ```

- `Authorize @ORG`:

  ```sh
  node "<plugin-root>/scripts/repository_telemetry.js" org REVISION ORG enabled --acknowledge-machine-scope
  ```

- `Keep telemetry off`, `Turn telemetry off` or `Keep off for now`:

  ```sh
  node "<plugin-root>/scripts/repository_telemetry.js" org REVISION ORG disabled
  ```

- `Keep authorized`: run nothing.

Omit `KEY...` when no repositories were listed. Before turning an organization
off, tell the user it removes the queued, unsent payloads of its repositories
and that requests already in flight may finish.

If the result has `stale: true`, the choices changed meanwhile: run `list`
again and ask one updated question. Never apply the old selection. If the
command fails, relay its code and message; for `LOCAL_CONSENT_CONFLICT`, run
`list` again and ask without the restricted repositories.

After a successful command, print a final summary from `results`:
`Telemetry ON (N)` followed by every repository whose `effective` is `on`, and
`Telemetry OFF (N)` followed by every other one, each `displayName` on its own
line. If `cleanupDeferred` is true, say that queued-data cleanup finishes at
the next upload attempt. If `globalPaused` is true and anything was turned on,
explain that Codex telemetry is paused on this machine until
`$skillmeter:telemetry enable-global` resumes it. Repositories not listed remain off;
`$skillmeter:telemetry list` changes individual repositories later.
