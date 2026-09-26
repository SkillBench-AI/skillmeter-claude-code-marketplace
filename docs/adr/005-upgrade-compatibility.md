# ADR 005: Upgrade compatibility evidence

Status: proposed

Plugin versions, durable local formats and transport formats are separate
contracts. A passing new-install test does not establish upgrade compatibility.
Both plugins retain pinned released implementations as regression inputs, using
synthetic state only. A release transition is covered only at the boundaries its
tests exercise; a green fixture matrix is not a promise of complete production
compatibility or permission to replay historical data.

## Contract

Supported upgrades preserve authorized data, sequence/record identity, pending
work, ownership and consent boundaries. Unknown state formats must be held before
mutation. A failed migration must resume safely or preserve a recoverable state.
Uncertain historical authorization requires a separate bounded decision; current
opt-in is insufficient. Previously released writers cannot be assumed to obey a
new format guard, so quiesce them before a format-changing cutover.

Backend changes must retain supported old producers and retained historical
storage formats. New producer features require verified backend support. Specify
deployment order per contract and validate the exact release composition before
exposing it through marketplace main. A downgrade is supported only when tested;
otherwise use the documented state-restore or forward-recovery procedure.

Every format-changing PR must provide its old release fixture, preservation and
interruption tests, incompatibility behavior, and rollout/recovery instructions.
Do not remove an old fixture because a new release no longer passes it. Determine
an executable-version retirement policy from deployed-version evidence; storage
read compatibility may need a longer lifetime. The fixture list is coverage,
not an adopted version-retirement schedule.

## Current automated boundary

`skillmeter/test/released-upgrades.test.js` loads actual planner and data-root
resolver code from the immutable revisions in `compatibility/releases.json`.
It persists old cursors, then checks candidate append/reset planning, distinct
authored repeats and persistent data-root identity after install-directory
replacement. It does not run released hooks, authorization, pending-queue drain,
shared-policy migration, server storage or an installer. Those require additional
contracts; do not infer their acceptance from these pure-module checks.

CI fetches full repository history and runs these tests on Node 20 and 22. Missing
historical objects or a version/pin mismatch fail the tests rather than skip
coverage. Local shallow clones must fetch the pinned objects before running
`node --test`. Tests perform no network calls and never load real credentials or
plugin data. Git history is trusted code, reviewed before adding a pin.

The Codex repository maintains its own released-queue fixtures under the same
contract. Cross-repository collector/reader verification remains a separate gate.
Required branch/release checks and hosted cross-repository execution must be
configured explicitly; this ADR does not imply they are already enabled.
