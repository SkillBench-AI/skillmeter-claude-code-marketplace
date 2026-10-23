# Two-Stage Sanitization and Typed PII Placeholders

**Status:** Adopted by reference. Canonical text:
[Claude Code plugin ADR 002](../../../claude-code/docs/adr/002-two-stage-sanitization.md)
(Accepted 2026-09-11; amended 2026-09-11 for path handling, repository
identity and file-name policy, and 2026-09-23 for colliding object keys,
policy `3.1.2`).
**Related:** `docs/sanitizer-parity.md` (the adapter this plugin keeps over
the shared rule table)

## What is the same

Stage 1 runs on the device before anything is queued: policy `3.1.2` in
both clients, the same 24 secret detectors, the same typed placeholders, the same path hashing with the shared
per-device salt, and the shared fixture corpus in CI
(`test/sanitizer-parity.test.js`). Every record carries the `_sanitization`
stamp with counts per category and no values. Stage 2 does not exist yet for
either client.

## Differences in the Codex plugin

- The argument adapter: a `function_call` record's `arguments` is a JSON
  string in Codex transcripts;
  the sanitizer parses it so labelled secrets and path rules see its
  structure, then re-serializes. Arguments that do not parse are hashed
  whole, marked `_codex_arguments_format: unsupported-json-opaque`, and
  tallied as one path hash (`codex-opaque-tool`).
- Transcript records from plugin 0.5.1 carry no stamp; 0.6.1 and later stamp
  every record. Counters read from stored objects undercount 0.5.1 devices.
- The consent prefix rule (which parts of the first `session_meta` record may
  cross an excluded interval) is a consent boundary, not a sanitization
  rule; see ADR 004.

## Open items

- None specific to this plugin. Stage 2 and its measurement dashboard are
  canonical open items.
