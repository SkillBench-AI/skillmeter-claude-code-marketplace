# License Token Lifecycle: Lifetime, Refresh, and Recovery

**Status:** Adopted by reference. Canonical text:
[Claude Code plugin ADR 001](../../../claude-code/docs/adr/001-license-token-lifecycle.md)
(Accepted 2026-09-10, amended 2026-09-16: sign-in moved to the broker).
Decisions 1 and 5 (the refresh path and the shared session) are superseded for
this plugin by [ADR 005](005-per-client-session.md).

## What is the same

The device id and hash salt in `~/.skillbench/credentials.json` are shared with
the Claude Code plugin; the session is not (ADR 005). The retry daemon
(`scripts/monitors/retry_daemon.js`) renews the license in the background
independent of queue state (decision 2). Hooks record while a token exists;
freshness is enforced at transmission (decision 3, covered by #46). `status`
separates capture policy from delivery readiness (#47).

## Differences in the Codex plugin

- Sign-out sets `signed_out` and a new `auth_generation` in this plugin's
  session file and revokes the refresh token; the consent journal reads the
  generation. It does not pause other clients. Sign-out and a 402 (or a 404 for
  the pinned tenant) delete unsent event batches; transcripts are held by their
  queue owner, which names the tenant and user, instead of being deleted.
- There is no `/refresh` and no re-activation without a stored session: the
  license is renewed only through the broker refresh token (ADR 005).
- Same-principal sign-out and sign-in closes a consent-journal interval
  (`docs/repository-consent.md`); an ordinary refresh does not.

## Open items

- Resolved 2026-09-28: broker sign-in and identity-bound re-activation (ADR 005),
  and the purge on sign-out and on 402. Unsent data follows the queue limits in
  `docs/repository-consent.md` (14-day retry age, sealed batches removed after
  30 days), not a 7-day bound.
