# Shared code

`lib/` holds modules both SkillMeter clients must run byte for byte: what
leaves the machine (the sanitizer) and how they share `~/.skillbench`
(`credential-lock.js`). `fixtures/` holds test corpora both clients' tests run.

A plugin cannot load files outside its own directory once installed, so
`node scripts/sync-shared.mjs` copies each `lib/` file to the same name in
`clients/claude-code/skillmeter/scripts/lib` and
`clients/codex/plugins/skillmeter/scripts/lib`. JavaScript copies start with a
`// GENERATED` line. CI runs the script with `--check` and fails on any
difference, missing copy, or copy whose source was removed.

A module belongs here when both clients implement the same contract: a file
they share on disk, a server API, or a policy. Code that follows its host's
contract stays in its client, even when it looks similar: hooks, consent stores
(ADR 006), backfill, and `plugin-data-root.js`, since Claude Code and Codex
hand plugins their data directory in different ways. When only part of a
module is common, share that part: `card.js` draws the status card, and each
client's `banner.js` decides what the card says.

## Tests

`test/` tests `lib/` once, against the source both plugins copy:
`(cd shared && node --test)`; CI runs it as "Shared tests". A client's own tests
cover only that client's code and how it wires the shared modules in (its
config, its adapters, its hooks), never a shared module's behaviour again.
`test/shared-identity.test.mjs` runs both clients against one state directory.
