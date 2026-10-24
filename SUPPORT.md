# SkillMeter Support

## Usage and installation help

For non-sensitive defects and feature requests, open an issue at:

<https://github.com/SkillBench-AI/skillmeter-plugins/issues>

Name the client (Claude Code or Codex) and include the command that failed,
its exit status, and sanitized error output, plus:

### SkillMeter for Claude Code

- `claude --version`;
- the SkillMeter version shown by `claude plugin list --json`;
- installation scope (`user`, `project`, or `local`).

Before filing an installation issue, run:

```bash
claude plugin marketplace update skillbench
claude plugin update skillmeter@skillbench
```

Restart Claude Code or run `/reload-plugins` after an update.

### SkillMeter for Codex

- `codex --version`;
- the SkillMeter version shown by `codex plugin list --json`.

Before filing an installation issue, run:

```bash
codex plugin marketplace upgrade skillbench
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session after an update. If SkillMeter for Codex
was installed from the archived `skillmeter-codex-marketplace`, move it first:
see [Update](clients/codex/README.md#update).

## Privacy and data requests

Contact `privacy@skillbench.com`. If your organization provides SkillMeter, it
may be the data controller and may need to handle the request.

## Security reports

Follow [SECURITY.md](SECURITY.md). Never post tokens, raw transcripts, source
code, customer identifiers, or telemetry payloads in a public issue.

## Documentation

- [Claude Code plugin guide](clients/claude-code/skillmeter/README.md)
- [Codex plugin guide](clients/codex/plugins/skillmeter/README.md)
- [Privacy](PRIVACY.md)
- [SkillBench Privacy Policy](https://skillbench.com/privacy/)
- [SkillBench subprocessors](https://skillbench.com/subprocessors/)

## Credential store is busy

A brief `credential-store-busy` error means another SkillMeter process may be
writing sign-in state: a process of the same client, or of the other client,
since both share the device identity in `~/.skillbench/credentials.json`.
Retry after that operation finishes. Neither client evicts a live writer
because its lock is old.

If the error persists, quit all Claude Code and Codex sessions and their
background plugin workers; an old process can retain its previous behavior
after an update. Restart and retry. Each client keeps its own session.

Malformed or unknown lock records, PID reuse, and repeated interrupted cleanup
can require support-assisted recovery. Preserve the credential and lock files
for local diagnosis; do not delete or edit them while any writer can run. Never
attach `credentials.json`, tokens or raw state to a public issue.
