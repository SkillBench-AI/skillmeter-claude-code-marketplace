# SkillMeter for Claude Code

SkillMeter is an opt-in Claude Code plugin that sends developer-workflow
telemetry to the SkillBench platform for organization-level skill analytics.
Installation and sign-in do not authorize telemetry: the user must explicitly
authorize the licensed GitHub organization and then enable each repository.

## Data access notice

The current plugin can process and transmit sanitized conversation and
developer-authored content, including prompts, tool inputs and responses,
assistant messages, transcript deltas, and selected Claude Code configuration
content. Secret and email detection plus path hashing reduce exposure, but do
not make arbitrary content anonymous or guarantee removal of every sensitive
value.

Review these documents before installing:

- [Plugin documentation](skillmeter/README.md)
- [Privacy notice](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Anthropic directory submission readiness](docs/anthropic-submission.md)

## Install from the SkillBench marketplace

```bash
claude plugin marketplace add SkillBench-AI/skillmeter-claude-code-marketplace
claude plugin install skillmeter@skillbench
```

Inside Claude Code, run `/skillmeter:signin` to authenticate and review the
organization and repository telemetry choices. Use
`/skillmeter:telemetry list` at any time to review or change repository
selection.

## Validate and test

```bash
claude plugin validate .
node --test
```

This repository is public for source review. Do not commit credentials,
license JWTs, generated telemetry logs, or test-account secrets.
