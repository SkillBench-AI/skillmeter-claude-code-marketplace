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
they share on disk, a server API, or a policy. Platform-specific code (hooks,
consent stores, backfill) stays in its client.
