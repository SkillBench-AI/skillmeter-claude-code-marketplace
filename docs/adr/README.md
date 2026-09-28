# Architectural Decision Records

Decisions that shape this plugin. IaC and platform-level ADRs live in
`skillbench-infra/docs/adr/` and `skillbench-docs/adr/`.

Conventions: ADRs are point-in-time artifacts. Amend with a dated note or
supersede with a new ADR rather than rewriting history. Every ADR carries a
`**Status:**` line; when superseded, both ends link to each other.

| # | Title | Date | Status |
|---|---|---|---|
| [001](001-license-token-lifecycle.md) | License token lifecycle: lifetime, refresh, and recovery | 2026-09-10 | Accepted, amended 2026-09-16 (broker sign-in, decision 4 retired); consent moved to ADR 004 on 2026-09-25 |
| [002](002-two-stage-sanitization.md) | Two-stage sanitization and typed PII placeholders | 2026-09-11 | Accepted, amended 2026-09-11 (paths, repository identity), 2026-09-23 (policy 3.1.1) and 2026-09-26 (policy 3.1.2) |
| [003](003-collection-state-visibility.md) | Collection state visibility: notices, monitor lifecycle, and the local status record | 2026-09-14 | Accepted |
| [004](004-shared-consent.md) | One consent record shared by every client on a machine | 2026-09-25 | Accepted |
| [005](005-per-client-session.md) | Per-client sessions: a Hydra refresh token, with the license as a cache | 2026-09-27 | Proposed |
