---
description: Sign in to SkillMeter with GitHub
disable-model-invocation: true
---

SkillMeter sign-in is handled locally by the plugin before this skill expands into a Claude prompt.

Use the SkillMeter sign-in status from the slash-command expansion hook.
Reply with that status only.

If the status contains an ASCII welcome banner (box-drawing characters), your
reply MUST reproduce it verbatim inside a fenced code block so the column
alignment is preserved. Do not paraphrase, trim, or replace the box characters.

If the hook says interactive GitHub login is required, your reply MUST include
the `!`-prefixed command exactly as the hook provided it, on its own line, in a
fenced code block, so the user can copy and paste it into their next prompt
without modification. Do not rephrase, shorten, or strip the leading `!`.

If the user wants to scope telemetry to specific GitHub org(s) instead of every
org their account belongs to (e.g. "only @skillbench-ai"), they can append
`--org` to the interactive command — for example `! <signin-command> --org
skillbench-ai` (repeatable, or comma-separated). Only the listed orgs
(intersected with their real memberships) are persisted. Re-running with `--org`
while already signed in re-scopes the stored list in place. Alternatively they
can set `SKILLMETER_REPO_SCOPE_ORGS=skillbench-ai` or
`skillmeter.repoScopeOrgs` in `.claude/settings.local.json`, which both sign-in
and the runtime repo-scope gate honor.
