# SkillMeter plugins

SkillMeter for Claude Code and SkillMeter for Codex, in one repository. Each
client has its own plugin, hooks and tests; the two marketplaces at the root
point at them.

| Client | Plugin | Marketplace (read by) | Docs |
| --- | --- | --- | --- |
| Claude Code | [`clients/claude-code/skillmeter`](clients/claude-code/skillmeter) | [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) (Claude Code) | [README](clients/claude-code/README.md) |
| Codex | [`clients/codex/plugins/skillmeter`](clients/codex/plugins/skillmeter) | [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) (Codex) | [README](clients/codex/README.md) |

Codex reads `.agents/plugins/marketplace.json` and falls back to
`.claude-plugin/marketplace.json` only when it is missing, which would offer the
Claude Code plugin to Codex. CI fails if the Codex marketplace is missing.

## Install

Claude Code:

```sh
claude plugin marketplace add SkillBench-AI/skillmeter-plugins
claude plugin install skillmeter@skillbench
```

Codex:

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-plugins --ref main
codex plugin add skillmeter@skillbench
```

Moving from the archived `skillmeter-codex-marketplace`: see
[clients/codex/README.md](clients/codex/README.md#update).

## Documentation

- [Architectural decisions](docs/adr/README.md): one set for both clients; each
  ADR ends with how the Codex client implements it where that differs.
- [Releasing](RELEASING.md), [Privacy](PRIVACY.md), [Security](SECURITY.md) and
  [Support](SUPPORT.md) cover both clients.

## Shared code

Code both clients must run identically lives once in [`shared/lib`](shared/lib):
today the sanitizer (`sanitize.js`, `rules.js`, `path-vocabulary.json`) and the
`credentials.json` lock (`credential-lock.js`). Both CLIs install only the
plugin directory, so each plugin carries a generated copy at the same path in
its `scripts/lib`. Edit `shared/lib`, then run:

```sh
node scripts/sync-shared.mjs
```

CI fails when a copy differs from its source. Test corpora both clients run
live in [`shared/fixtures`](shared/fixtures).

## Branches and channels

- `next`: development; pull requests target it.
- `main`: what customers install. A release merges `next` into `main` and
  ships both clients, so cut one only when `next` is releasable for both.
- `internal`: rebuilt from each green `next` push for both clients by
  [`make-internal-channel.mjs`](.github/scripts/make-internal-channel.mjs).

Release tags: `v*` for Claude Code, `codex-v*` for Codex. Pushing one runs
that client's release workflow (`release-claude-code.yml` or
`release-codex.yml`), which validates the tag against the plugin version, runs
the checks and publishes the GitHub Release; the Claude Code release is always
Latest.

## Development

Run each client's checks from its directory:

```sh
(cd clients/claude-code && node --test)
(cd clients/codex && npm run check)
```
