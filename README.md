# SkillMeter plugins

SkillMeter for Claude Code and SkillMeter for Codex, in one repository. Each
client has its own plugin, hooks and tests; the two marketplaces at the root
point at them.

| Client | Plugin | Marketplace (read by) | Docs |
| --- | --- | --- | --- |
| Claude Code | [`clients/claude-code/skillmeter`](clients/claude-code/skillmeter) | [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) (Claude Code) | [README](clients/claude-code/README.md) |
| Codex | [`clients/codex/plugins/skillmeter`](clients/codex/plugins/skillmeter) | [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) (Codex) | [README](clients/codex/README.md), [releasing](clients/codex/RELEASING.md) |

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

## Branches and channels

- `next`: development; pull requests target it.
- `main`: what customers install. A release merges `next` into `main` and
  ships both clients, so cut one only when `next` is releasable for both.
- `internal`: rebuilt from each green `next` push for both clients by
  [`make-internal-channel.mjs`](.github/scripts/make-internal-channel.mjs).

Release tags: `v*` for Claude Code, `codex-v*` for Codex.

## Development

Run each client's checks from its directory:

```sh
(cd clients/claude-code && node --test)
(cd clients/codex && npm run check)
```
