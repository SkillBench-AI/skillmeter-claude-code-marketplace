# SkillMeter Support

## Usage and installation help

For non-sensitive defects and feature requests, open an issue at:

<https://github.com/SkillBench-AI/skillmeter-claude-code-marketplace/issues>

Include:

- `claude --version`;
- the SkillMeter version shown by `claude plugin list --json`;
- installation scope (`user`, `project`, or `local`);
- the command that failed and its exit status; and
- sanitized error output.

Before filing an installation issue, run:

```bash
claude plugin marketplace update skillbench
claude plugin update skillmeter@skillbench
```

Restart Claude Code or run `/reload-plugins` after an update.

## Privacy and data requests

Contact `privacy@skillbench.com`. If your organization provides SkillMeter, it
may be the data controller and may need to handle the request.

## Security reports

Follow [SECURITY.md](SECURITY.md). Never post tokens, raw transcripts, source
code, customer identifiers, or telemetry payloads in a public issue.

## Documentation

- [Plugin guide](skillmeter/README.md)
- [Privacy notice](PRIVACY.md)
- [SkillBench Privacy Policy](https://skillbench.com/privacy/)
- [SkillBench subprocessors](https://skillbench.com/subprocessors/)

## Credential store is busy

A brief `credential-store-busy` error means another process may be writing the
shared sign-in state. Retry after that operation finishes. The plugin will not
evict a live writer because its lock is old.

If the error persists, quit all Claude and Codex sessions and their background
plugin workers. Mixed use requires both plugins to have compatible credential
locking; an old process can retain its previous behavior after an update.
Restart using the supported versions and retry.

Malformed or unknown lock records, PID reuse, and repeated interrupted cleanup
can require support-assisted recovery. Preserve the credential and lock files
for local diagnosis; do not delete or edit them while any writer can run. Never
attach `credentials.json`, tokens or raw state to a public issue.
