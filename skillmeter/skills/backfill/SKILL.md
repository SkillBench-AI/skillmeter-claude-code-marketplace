---
description: Manually trigger or inspect SkillMeter historical transcript backfill
argument-hint: <status>
disable-model-invocation: true
allowed-tools: AskUserQuestion Bash(node *)
---

Parse `SkillMeter manual backfill state JSON` from the expansion hook.

If its status is `signed_out`, tell the user to run `/skillmeter:signin` first.
If it is `error`, report the error and stop. Require exactly one licensed
organization; otherwise report that manual backfill currently requires one
organization and make no changes.

## Status

When `$ARGUMENTS` is exactly `status`, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js status LIFECYCLE_ID
```

Use the exact `backfill.lifecycleId`. Report the lifecycle status and every
transcript entry grouped by repository. `sentChunks` records backend-confirmed
2xx uploads; never infer sent status from queued chunks. Do not show or request
local paths.

## Trigger

When `$ARGUMENTS` is empty, first inspect `backfill.status`:

- `running`: run the status command and report that the worker is already
  running.
- `completed`: run the status command and report the completed audit. Do not
  resend transcripts that were already processed.
- `pending`: continue with `claim`.
- `declined` or `failed`: continue with `manual-claim`.

For any other argument, report that only the empty trigger and `status` are
supported.

Run a fresh repository inventory:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repository_telemetry.js list
```

Retain only repositories whose `org` exactly matches the licensed organization,
regardless of ongoing telemetry state. If none match, report that no historical
repository scope is available and stop.

Claim the snapshot cutoff with the exact lifecycle ID. Include the active
session UUID only when non-empty:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js claim LIFECYCLE_ID ACTIVE_SESSION_ID
```

For a `declined` or `failed` lifecycle, replace `claim` with `manual-claim`.
Continue only when the result has `claimed: true`.

Ask exactly one single-select question:

- Header: `History`
- Question: Start with
  `Send sanitized transcripts from completed sessions in these repositories?`,
  then list every matching repository `displayName`, one per line.
- First option:
  - Label: `Send history`
  - Description: `Queue sanitized historical prompts and responses without enabling ongoing telemetry.`
- Second option:
  - Label: `Cancel`
  - Description: `Do not start this manual backfill.`

On Cancel or question cancellation, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js decline LIFECYCLE_ID OFFER_ID
```

On `Send history`, map the displayed repositories to exact IDs from the same
inventory and run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/backfill.js accept LIFECYCLE_ID OFFER_ID REVISION "ORG" ID...
```

Never pass paths, labels, custom input, inferred IDs, or repositories from
another organization. If `stale: true`, refresh the inventory and reconfirm the
changed scope; do not reuse the old selection.

Report the detached worker PID and explain that `/skillmeter:backfill status`
shows transcript UUIDs, queued chunks, and backend-confirmed sent chunks.
Ongoing telemetry remains unchanged. The global telemetry kill-switch still
pauses historical transmission.
