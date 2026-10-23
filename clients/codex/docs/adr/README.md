# Architectural Decision Records

Decisions that shape the SkillMeter clients are recorded once, in the Claude
Code plugin repository's ADR set. Each file below carries the same number and
title as its canonical ADR, the link to it, and what is specific to the Codex
plugin. Since ADR 005 and ADR 006, sessions and consent are per client, so
those files describe the Codex design. A change to shared behaviour, such as
sanitization or the device identity, is made there first and mirrored here.

| # | Title | Canonical status | Codex file |
|---|---|---|---|
| 001 | License token lifecycle: lifetime, refresh, and recovery | Accepted, amended 2026-09-16 | [001](001-license-token-lifecycle.md) |
| 002 | Two-stage sanitization and typed PII placeholders | Accepted, amended 2026-09-11 | [002](002-two-stage-sanitization.md) |
| 003 | Collection state visibility: notices, monitor lifecycle, and the local status record | Accepted 2026-09-25 | [003](003-collection-state-visibility.md) |
| 004 | One consent record shared by every client on a machine | Accepted 2026-09-25; ADR 006 supersedes its shared-record decisions | [004](004-shared-consent.md) |
| 005 | Per-client sessions: a Hydra refresh token, with the license as a cache | Proposed 2026-09-27; implemented in Codex 0.11.0 (full cutover from GitHub OAuth) | [005](005-per-client-session.md) |
| 006 | Per-client consent records | Proposed 2026-09-28; implemented in Codex 0.12.1 | [006](006-per-client-consent.md) |
