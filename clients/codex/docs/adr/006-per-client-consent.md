# Per-Client Consent Records

**Status:** Adopted by reference. Canonical text:
[Claude Code plugin ADR 006](../../../claude-code/docs/adr/006-per-client-consent.md)
(Proposed 2026-09-28). Implemented in Codex 0.12.1 (#109). Supersedes the
shared-record decisions of
[ADR 004](004-shared-consent.md).
**Related:** `docs/repository-consent.md` (the boundary it documents)

## In the Codex plugin

| Area | Codex |
| --- | --- |
| Record | `<state>/clients/codex/telemetry-policy.json`, next to the session (ADR 005). `<state>/telemetry-policy.json` is never read. |
| Grant | Organization ON and repository ON, both at `consent_version: 2`, recorded by `consent-set` with `--acknowledge-machine-scope`. |
| Organization control | `consent-set on\|off --organization ORG`; the organization must be covered by the license after narrowing. |
| Local settings | `.codex/settings.local.json` OFF or invalid restricts; local ON grants nothing. |
| Global pause | `global.enabled` in the Codex record; pauses only Codex. |
| Observation marker | `<PLUGIN_DATA>/logs/consent-policy-observed`, a new name so a marker left by the shared record does not make the new record look deleted. |
| Upgrade | No choices are imported. Event batches stamped under the shared record are held and expire at the 30-day limit. |
