# Security Policy

## Supported version

Security fixes are applied to the latest released SkillMeter plugin version.
Users should update to the latest version before reporting an issue that may
already be resolved.

## Report a vulnerability

Send security and privacy reports to `privacy@skillbench.com` with the subject
`[SkillMeter Security]`. Do not open a public issue for a suspected
vulnerability.

Include:

- the affected SkillMeter and Claude Code versions;
- the operating system;
- a minimal reproduction using synthetic data;
- expected and observed behavior; and
- the potential privacy or security impact.

Do not send GitHub access tokens, SkillMeter license JWTs, raw transcripts,
customer source code, generated telemetry logs, or other production secrets.
If sensitive evidence is necessary, first ask for a secure transfer method.

SkillBench will investigate reports with reasonable care and may ask for
additional reproduction details. This repository does not currently operate a
public bug-bounty program.

## Security boundaries

- Plugin hooks run with the user's local permissions.
- Telemetry requires a valid license plus explicit organization and repository
  authorization.
- Network requests use HTTPS and authenticated endpoints.
- Secret redaction is defense in depth and is not a guarantee that arbitrary
  content is free of sensitive information.
- Local telemetry queues can contain sanitized but still confidential content
  and should be protected like other developer data.

## Disclosure

Please allow reasonable time for investigation and remediation before public
disclosure. SkillBench may coordinate disclosure timing when users need an
update before details are published.
