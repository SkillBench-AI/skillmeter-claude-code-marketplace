---
description: Sign in to SkillMeter with GitHub
disable-model-invocation: true
allowed-tools: AskUserQuestion Bash(node *)
---

SkillMeter sign-in is handled locally by the plugin before this skill expands into a Claude prompt.

Use the SkillMeter sign-in status from the slash-command expansion hook. Follow
exactly one of the flows below.

## Signed in

When context contains `SkillMeter sign-in state JSON`, parse it. The
`repositoryTelemetry` object is a sanitized scan result with no local paths.
For every entry in `orgs`, use `AskUserQuestion` to show one single-select
question.

For an org whose `consent` is `null`, ask:

- Header: `Telemetry`
- Question: Start with
  `Allow SkillMeter telemetry for repositories owned by @ORG?`, then add
  `Repositories found:` and every `repositoryTelemetry.repositories` entry
  whose `org` exactly equals `ORG`, using its exact `displayName` one per line.
  If none were found, add `No local @ORG repositories found.`
- First option:
  - Label: `Allow for @ORG`
  - Description: `Authorize repository telemetry for @ORG plus path-HMAC-only diagnostics when events are excluded. You will review the exact local repositories before full event capture is enabled.`
- Second option:
  - Label: `Keep off for now`
  - Description: `Keep telemetry off for @ORG. You can enable it later by running /skillmeter:signin again.`

For an org whose `consent` is `true`, ask the same question with:

- First option:
  - Label: `Keep authorized`
  - Description: `Keep @ORG authorized. Full events are collected only for enabled repositories; excluded events send only hook type, gate reason, and HMAC cwd.`
- Second option:
  - Label: `Turn telemetry off`
  - Description: `Stop collecting and sending telemetry for @ORG. You can enable it again later.`

For an org whose `consent` is `false`, ask the same question with:

- First option:
  - Label: `Authorize @ORG`
  - Description: `Re-authorize @ORG. Enabled repositories resume full collection; excluded events send only hook type, gate reason, and HMAC cwd.`
- Second option:
  - Label: `Keep off for now`
  - Description: `Keep telemetry off for @ORG. You can enable it later by running /skillmeter:signin again.`

If `orgs` is empty, do not call any tool. Report that sign-in succeeded but the
license contains no telemetry organization.

If the user cancels the question, do not run any command and report that the
existing setting was left unchanged.

For `consent: null`, choosing `Keep off for now` persists:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
```

For `consent: null`, choosing `Allow for @ORG` does not persist the organization
choice yet. Run a fresh scan so the final picker cannot rely on a stale
sign-in-time snapshot:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Parse the JSON and retain only repositories whose `org` exactly equals `ORG`.
Never show or infer local paths. If the command fails, report the error; the org
and repository settings remain unchanged.

If no matching repositories are returned, do not call `AskUserQuestion`.
Atomically authorize the organization with no repositories enabled:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" disabled
```

Report that @ORG is authorized, no local org repositories were found, and
full repository telemetry remains off until a repository is selected. The
organization-level exclusion audit described in the consent choice is active.

If matching repositories are returned, call `AskUserQuestion` exactly once with
one single-select question:

- Header: `Repositories`
- Question: Start with `Enable telemetry for these repositories?`, then include
  every matching repository's exact `displayName`, one per line. This exact
  displayed list is the complete scope of the choice.
- First option:
  - Label: `Yes, enable telemetry`
  - Description: `Enable sanitized telemetry for every repository listed above.`
- Second option:
  - Label: `No, keep telemetry off`
  - Description: `Keep telemetry off for every repository listed above.`

Do not use multi-select. If the user cancels this repository question, do not
run any command; both the organization and repository settings remain
unchanged.

Map every displayed repository back to its exact 12-character hexadecimal `id`
from the same JSON result. On Yes, atomically authorize the organization and
enable exactly those IDs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" enabled ID...
```

On No, atomically authorize the organization and explicitly disable exactly
those IDs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" disabled ID...
```

Pass the exact integer `revision`, org, and IDs returned by the list result.
Never pass display labels, paths, custom input, inferred IDs, or repositories
from another org. If the command reports `stale: true`, settings changed while
the question was open: run `list` again and show the updated exact list in a new
Yes/No question. Never apply the old selection to a changed list.

After a successful onboarding command, always print an explicit final summary
using every entry in `results`, never only a count:

- `Telemetry ON (N)` followed by every enabled repository's exact
  `displayName`, one per line.
- `Telemetry OFF (N)` followed by every disabled repository's exact
  `displayName`, one per line.

For Yes, the ON list must contain every repository that was displayed in the
question. For No, the OFF list must contain every displayed repository. If a
result was unchanged, print it separately with its returned reason.

For existing `consent: true` or `consent: false`, persist the selected
organization value with:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" enabled
```

or:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
```

Use the org value exactly as supplied in the sign-in state. Never infer or
substitute an organization. Report each script result. If
`globalTelemetryDisabled` is true and the user authorizes the org/repositories,
also explain that the global kill-switch still blocks transmission until
`/skillmeter:telemetry enable-global` is run. Repositories not shown in the
onboarding list remain off and will ask for an explicit choice when first
entered; use `/skillmeter:telemetry list` for granular changes.

## Interactive GitHub login required

If the hook says interactive GitHub login is required, reply with that status
and include the `!`-prefixed command exactly as provided, on its own line in a
fenced code block. Do not rephrase, shorten, or strip the leading `!`. Tell the
user to complete GitHub authorization, then run `/skillmeter:signin` again to
choose organization telemetry.
