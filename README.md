# SkillMeter for Claude Code

SkillMeter is an opt-in Claude Code plugin that sends developer-workflow
telemetry to the SkillBench platform for organization-level skill analytics.
Installation and sign-in do not authorize telemetry: the user must explicitly
authorize the licensed GitHub organization and then enable each repository.

## Data access notice

The current plugin can process and transmit sanitized conversation and
developer-authored content, including prompts, tool inputs and responses,
assistant messages, transcript deltas, and selected Claude Code configuration
content. Secret/PII detection and path hashing reduce exposure, but do
not make arbitrary content anonymous or guarantee removal of every sensitive
value.

Review these documents before installing:

- [Plugin documentation](skillmeter/README.md)
- [Privacy notice](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## Install from the SkillBench marketplace

Requires Node.js 22 or later on `PATH`; the plugin's hooks run `node`.

```bash
claude plugin marketplace add SkillBench-AI/skillmeter-claude-code-marketplace
claude plugin install skillmeter@skillbench
```

Inside Claude Code, run `/skillmeter:signin` to authenticate and review the
organization and repository telemetry choices. Use
`/skillmeter:telemetry list` at any time to review or change repository
selection.

## Update

```sh
claude plugin marketplace update skillbench
claude plugin update skillmeter@skillbench
```

Restart Claude Code or run `/reload-plugins`. See [support](SUPPORT.md) for
troubleshooting and version checks.

## Internal channel

SkillBench developers can dogfood the latest `main` against the dev environment.
The `internal` branch is rebuilt from every `main` commit that passes CI; it has
the same code, defaults to the dev sign-in service, license server and
`~/.skillbench-dev` state, and is published as the `skillbench-internal`
marketplace so its installation and plugin data stay apart from the stable one.

```sh
claude plugin uninstall skillmeter@skillbench
claude plugin marketplace add SkillBench-AI/skillmeter-claude-code-marketplace#internal
claude plugin install skillmeter@skillbench-internal
```

Sign in with a dev workspace account. Uninstall the stable plugin first, or both
would record the same sessions. Cards show `internal (dev)` in the title. To
update, run `claude plugin marketplace update skillbench-internal` and
`claude plugin update skillmeter@skillbench-internal`. The
workflow that rebuilds the branch is `.github/workflows/internal-channel.yml`;
never commit `skillmeter/channel.json` to `main` (a test fails if it is present).

## Validate and test

```bash
claude plugin validate .
node --test
```

This repository is public for source review. Do not commit credentials,
license JWTs, generated telemetry logs, or test-account secrets.
