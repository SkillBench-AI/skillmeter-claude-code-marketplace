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
The `backfill` object contains only the one-time offer status and an optional
active session UUID.

For an org whose `consent` is `null`, run one fresh repository scan before
asking anything:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Parse the JSON and retain only repositories whose `org` exactly equals `ORG`.
Never show or infer local paths. If the command fails, report the error and do
not ask a question or change policy.

Call `AskUserQuestion` exactly once with one combined, single-select telemetry
question:

- Header: `Telemetry`
- Question: Start with `Choose telemetry for @ORG.`, then add
  `Repositories found:` and every matching repository's exact `displayName`,
  one per line. If none were found, add
  `No local @ORG repositories found.`
- When matching repositories exist, first option:
  - Label: `Enable listed repositories`
  - Description: `Authorize @ORG and enable sanitized full telemetry for every repository listed above.`
- Next option:
  - Label: `Organization only`
  - Description: `Authorize only path-HMAC exclusion diagnostics for @ORG; keep full repository telemetry off.`
- Last option:
  - Label: `Keep telemetry off`
  - Description: `Keep organization and repository telemetry off. You can choose later by running /skillmeter:signin again.`

When no matching repositories exist, omit `Enable listed repositories` and
show only `Organization only` and `Keep telemetry off`. Do not use multi-select.
If the user cancels this combined question, run no command; organization and
repository settings remain unchanged.

Map every displayed repository back to its exact 12-character hexadecimal `id`
from the same fresh result. Never pass display labels, paths, custom input,
inferred IDs, or repositories from another org.

On `Keep telemetry off`, persist organization OFF:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
```

On `Organization only`, atomically authorize the organization and explicitly
keep every displayed repository disabled:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" disabled ID...
```

Omit `ID...` when no repositories were found.

On `Enable listed repositories` with `backfill.eligible: false`, atomically
authorize the organization and enable exactly the displayed IDs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" enabled ID...
```

If `backfill.eligible` is true and the user chooses either OFF option, consume
the offer without displaying a History question:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js claim ACTIVE_SESSION_ID
```

Omit `ACTIVE_SESSION_ID` when `backfill.activeSessionId` is empty.

For an org whose `consent` is `true`, do not run the first-onboarding flow
above. Call `AskUserQuestion` exactly once:

- Header: `Telemetry`
- Question: `Keep SkillMeter telemetry authorized for @ORG?`
- First option:
  - Label: `Keep authorized`
  - Description: `Keep @ORG authorized. Full events are collected only for enabled repositories; excluded events send only hook type, gate reason, and HMAC cwd.`
- Second option:
  - Label: `Turn telemetry off`
  - Description: `Stop collecting and sending telemetry for @ORG. You can enable it again later.`

For an org whose `consent` is `false`, do not run the first-onboarding flow
above. Call `AskUserQuestion` exactly once:

- Header: `Telemetry`
- Question: `Authorize SkillMeter telemetry for @ORG?`
- First option:
  - Label: `Authorize @ORG`
  - Description: `Re-authorize @ORG. Enabled repositories resume full collection; excluded events send only hook type, gate reason, and HMAC cwd.`
- Second option:
  - Label: `Keep off for now`
  - Description: `Keep telemetry off for @ORG. You can enable it later by running /skillmeter:signin again.`

If the user cancels either existing-consent question, run no command and report
that the existing setting was left unchanged.

If `orgs` is empty, do not call any tool. Report that sign-in succeeded but the
license contains no telemetry organization.

Pass the exact integer `revision`, org, and IDs returned by the list result.
If an onboarding command reports `stale: true`, settings changed while the
question was open: run `list` again and show one updated combined question.
Never apply the old selection to a changed list.

### One-time historical backfill

On `Enable listed repositories` with `backfill.eligible: true`, do not apply
onboarding yet. Claim the offer, including the exact active session UUID only
when non-empty:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js claim ACTIVE_SESSION_ID
```

Only when the JSON result contains `claimed: true`, call `AskUserQuestion`
exactly once:

- Header: `History`
- Question: `Send sanitized transcripts from completed sessions in the repositories you just enabled?`
- First option:
  - Label: `Send history`
  - Description: `Queue historical prompts and responses after removing tool results, images, secrets, personal data, and local paths.`
- Second option:
  - Label: `Skip`
  - Description: `Do not send historical sessions. SkillMeter will not ask again for this installation.`

If the user chooses `Send history`, atomically freeze live transcript staging,
apply onboarding, and start the local snapshot worker:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js accept OFFER_ID REVISION "ORG" onboard ID...
```

Use the exact `offerId` returned by `claim`. If the user chooses Skip or
cancels, record the explicit decline and then run the normal
`repository_telemetry.js onboard ... enabled ID...` command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js decline OFFER_ID
```

A cancelled backfill question cancels only historical backfill; it does not
undo the repository choice already made. If `accept` reports `stale: true`,
refresh the repository list and reconfirm its exact scope, then reuse the same
offer ID without asking the History question again.

After a successful onboarding command, always print an explicit final summary
using every entry in `results`, never only a count:

- `Telemetry ON (N)` followed by every enabled repository's exact
  `displayName`, one per line.
- `Telemetry OFF (N)` followed by every disabled repository's exact
  `displayName`, one per line.

For `Enable listed repositories`, the ON list must contain every repository
that was displayed. For `Organization only`, the OFF list must contain every
displayed repository. If a result was unchanged, print it separately with its
returned reason.

For existing `consent: true` or `consent: false`, normally persist the selected
organization value with:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" enabled
```

or:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
```

When `backfill.eligible` is true and an existing-consent choice would leave the
organization enabled, run a fresh `repository_telemetry.js list` before
changing the org:

- For `consent: true`, historical candidates are this org's entries whose
  `projectSetting` value is `enabled`; use policy action `preserve`.
- For `consent: false`, historical candidates are this org's entries whose
  `projectSetting` value is `enabled`; use policy action `reauthorize`.

If the chosen final state is off or there are no enabled candidates, consume
the offer with `backfill.js claim`, do not ask about history, and run the normal
org command. Otherwise claim and show the same History question. On Send
history, replace the normal org command with:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js accept OFFER_ID REVISION "ORG" POLICY_ACTION ID...
```

On Skip or cancel, decline the offer and run the normal org command. Never
include disabled, unselected, stale, or another org's repository IDs.

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
