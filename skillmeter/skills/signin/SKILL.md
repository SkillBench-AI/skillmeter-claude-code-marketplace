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

If `orgs` is empty, do not call any tool. Report that sign-in succeeded but the
license contains no telemetry organization.

For every org, run one fresh repository scan before asking about telemetry:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Parse the JSON and retain only repositories whose `org` exactly equals `ORG`.
Never show or infer local paths. If the command fails, report the error and do
not ask a question or change policy for that org.

### Ongoing telemetry

For an org whose `consent` is `null`, call `AskUserQuestion` exactly once with
one combined, single-select telemetry question:

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

Map every displayed repository back to its exact 12-character hexadecimal `id`
from the same fresh result. Never pass display labels, paths, custom input,
inferred IDs, or repositories from another org.

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

Apply the telemetry choice immediately, before handling historical data:

- `Enable listed repositories`:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" enabled ID...
  ```

- `Organization only`:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js onboard REVISION "ORG" disabled ID...
  ```

- `Keep telemetry off`, `Turn telemetry off`, or `Keep off for now`:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" disabled
  ```

- `Keep authorized` or `Authorize @ORG`:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/org_telemetry_consent.js set "ORG" enabled
  ```

Omit `ID...` when no repositories were found. If the user cancels a telemetry
question, run no telemetry command; organization and repository settings remain
unchanged. Cancellation does not cancel the separate History flow below.

Pass the exact integer `revision`, org, and IDs returned by the list result. If
an onboarding command reports `stale: true`, run `list` again and show one
updated telemetry question. Never apply the old selection to a changed list.

After a successful onboarding command, print an explicit final telemetry
summary using every entry in `results`:

- `Telemetry ON (N)` followed by every enabled repository's exact
  `displayName`, one per line.
- `Telemetry OFF (N)` followed by every disabled repository's exact
  `displayName`, one per line.

### Separate one-time historical backfill

Historical consent is independent of ongoing telemetry. When
`backfill.eligible` is true, continue this flow after the telemetry question
and command even when telemetry was kept off, turned off, organization-only,
or the telemetry question was cancelled.

Run a new repository scan so the historical scope uses the current revision:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Retain every exact repository for `ORG`; historical scope does not depend on
its current telemetry setting. Claim the one-time offer, including the exact
active session UUID only when non-empty. Pass `backfill.lifecycleId`
immediately after `claim`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js claim LIFECYCLE_ID ACTIVE_SESSION_ID
```

Omit `ACTIVE_SESSION_ID` when `backfill.activeSessionId` is empty. If no
matching repositories exist, decline the claimed offer without asking a
question and report that no historical repository scope was available.

Only when the claim result contains `claimed: true` and matching repositories
exist, call `AskUserQuestion` exactly once:

- Header: `History`
- Question: Start with
  `Send sanitized transcripts from completed sessions in these repositories?`,
  then list every matching repository's exact `displayName`, one per line.
- First option:
  - Label: `Send history`
  - Description: `Queue historical prompts and responses after removing tool results, images, secrets, personal data, and local paths. This does not enable ongoing telemetry.`
- Second option:
  - Label: `Skip`
  - Description: `Do not send historical sessions. SkillMeter will not ask again for this installation.`

On `Send history`, freeze live transcript staging for the snapshot and start
the detached worker without changing organization or repository telemetry:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js accept LIFECYCLE_ID OFFER_ID REVISION "ORG" ID...
```

Use the exact lifecycle ID, offer ID, revision, org, and IDs from the context,
claim, and fresh list.
On Skip or cancel:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js decline LIFECYCLE_ID OFFER_ID
```

If `accept` reports `stale: true`, refresh the list and reconfirm the changed
historical repository scope without changing the already-applied telemetry
choice. Never include stale repositories or repositories from another org.

The global telemetry kill-switch still pauses historical transmission. An
organization or repository telemetry OFF choice does not block a separately
accepted historical upload. Report the telemetry result and historical result
as two independent outcomes.

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
