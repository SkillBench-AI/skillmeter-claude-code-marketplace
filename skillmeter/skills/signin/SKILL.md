---
description: Sign in to SkillMeter with GitHub
disable-model-invocation: true
allowed-tools: AskUserQuestion Bash(node *)
---

SkillMeter sign-in is handled locally by the plugin before this skill expands into a Claude prompt.

Use the SkillMeter sign-in status from the slash-command expansion hook. Follow
exactly one of the flows below.

## Signed in

When context contains `SkillMeter sign-in state JSON`, parse it. For every entry
in `orgs`, use `AskUserQuestion` to show one single-select question.

For an org whose `consent` is `null`, ask:

- Header: `Telemetry`
- Question: `Enable SkillMeter telemetry for all repositories owned by @ORG?`
- First option:
  - Label: `Enable for @ORG`
  - Description: `Collect sanitized telemetry only in repositories owned by @ORG. Individual repositories can still opt out.`
- Second option:
  - Label: `Keep off for now`
  - Description: `Keep telemetry off for @ORG. You can enable it later by running /skillmeter:signin again.`

For an org whose `consent` is `true`, ask the same question with:

- First option:
  - Label: `Keep enabled`
  - Description: `Continue collecting sanitized telemetry in repositories owned by @ORG.`
- Second option:
  - Label: `Turn telemetry off`
  - Description: `Stop collecting and sending telemetry for @ORG. You can enable it again later.`

For an org whose `consent` is `false`, ask the same question with:

- First option:
  - Label: `Enable for @ORG`
  - Description: `Collect sanitized telemetry only in repositories owned by @ORG. Individual repositories can still opt out.`
- Second option:
  - Label: `Keep off for now`
  - Description: `Keep telemetry off for @ORG. You can enable it later by running /skillmeter:signin again.`

If `orgs` is empty, do not call any tool. Report that sign-in succeeded but the
license contains no telemetry organization.

If the user cancels the question, do not run any command and report that the
existing setting was left unchanged. Otherwise persist the selected value with:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" enabled
```

or:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
```

Use the org value exactly as supplied in the sign-in state. Never infer or
substitute an organization. Report the script result. If
`globalTelemetryDisabled` is true and the user enables the org, also explain
that the global kill-switch still blocks transmission until
`/skillmeter:telemetry enable-global` is run.

## Interactive GitHub login required

If the hook says interactive GitHub login is required, reply with that status
and include the `!`-prefixed command exactly as provided, on its own line in a
fenced code block. Do not rephrase, shorten, or strip the leading `!`. Tell the
user to complete GitHub authorization, then run `/skillmeter:signin` again to
choose organization telemetry.
