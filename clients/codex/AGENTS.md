# Repository conventions

This is a public repository. Write documentation, code comments and PR text in
concise English for readers who do not know the team's internal history.

- Describe current behavior and what users or maintainers need to do. Avoid
  lengthy introductions, repeated explanations and narration of obvious code.
- Do not explain every edit. Add rationale only for non-obvious decisions,
  constraints, tradeoffs or behavior that would otherwise be easy to break.
- Keep internal issue keys (such as `INF-*` and `SBEE-*`), rollout coordination,
  investigation notes and historical checkpoints in Linear, not in source
  comments or product documentation. A relevant issue link in a PR is enough.
- Keep durable documentation limited to usage, contracts, ADRs and reproducible
  checks. Do not add reports or documents for each task, fix or review pass.
- Preserve important privacy boundaries, recovery constraints and test setup
  requirements when shortening text. Verify claims against the implementation;
  avoid promises such as "always safe" or "never fails."
- Do not commit credentials, real telemetry, personal paths, device identifiers
  or generated test receipts. Use synthetic fixtures for tests.
- Follow the canonical Claude ADRs and this repository's mirrors in `docs/adr/`.
  Sessions and consent are per client (ADR 005, ADR 006); amend the relevant
  ADR when a policy decision changes instead of duplicating explanations.
- Keep PR descriptions focused on the final change and relevant validation.
  Follow `RELEASING.md` for release-note conventions.
