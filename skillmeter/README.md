# SkillMeter for Claude Code

SkillMeter sends opt-in, repository-scoped workflow and conversation telemetry
to [SkillBench](https://skillbench.com). See the [installation guide](../README.md)
and [privacy notice](../PRIVACY.md) before enabling collection.

## Sign in and controls

| Command | Purpose |
| --- | --- |
| `/skillmeter:signin` | Sign in through the SkillBench identity service and review consent |
| `/skillmeter:signout` | Remove the shared license and stop authenticated uploads |
| `/skillmeter:telemetry list` | Review and toggle known repositories |
| `/skillmeter:telemetry status` | Inspect sign-in, global and current-repository state |
| `/skillmeter:telemetry disable-global` | Pause live and historical uploads |
| `/skillmeter:telemetry enable-global` | Resume transmission subject to sign-in and consent |
| `/skillmeter:backfill` | Request historical collection with separate consent |
| `/skillmeter:backfill status` | Show queued and backend-confirmed transcript chunks |

Sign-in uses a browser-approved device code from `id.skillbench.ai`. The broker
ID token is exchanged for a SkillMeter license; it is not stored. The license
is shared with other SkillMeter clients, so signing out affects those clients
too. Device identity and telemetry policy remain on disk.

## Collection scope

Live collection requires a valid license, an eligible GitHub repository,
organization authorization, repository enablement and an enabled global switch.
Installation and sign-in alone do not authorize collection. New repositories
remain off until explicitly selected.

Repository choices use canonical `github.com/org/repo` identity, so clones and
worktrees share policy. Discovery uses local repositories, transcript paths and
Claude's project registry as hints, then verifies each repository's remote.
A matching origin is preferred; ambiguous matching remotes are excluded.

Organization authorization alone permits a minimal `TelemetryCaptureExcluded`
audit for excluded hooks: source hook type, gate reason and HMAC-hashed cwd,
with the event envelope. It does not copy the original prompt, tool payload,
raw path, repository name or transcript into that audit.

Turning an organization or repository OFF deletes its queued live payloads.
Privacy cursors track observed disabled transcript intervals so enabling a
repository later does not upload those intervals. Global OFF pauses capture
and transmission while retaining queued data.

## Historical sessions

Historical collection has separate consent. Sign-in can offer completed
sessions once per installation; `/skillmeter:backfill` requests the offer
explicitly. The question names the repositories being authorized. Declining or
cancelling does not start a backfill.

An accepted offer records repository scope and a transcript cutoff. It excludes
the active sign-in session and files modified after the cutoff. Snapshotting
removes tool-result and image blocks before the shared sanitizer runs.

Historical consent neither requires nor enables ongoing organization/repository
telemetry. An accepted historical offer can upload while live telemetry is OFF;
the global switch still pauses both. Queue cleanup preserves only historical
chunks belonging to the accepted offer and its scope.

The upload runs in the background. When every historical chunk has been
acknowledged by the backend or has exhausted its retries, SkillMeter announces
the import once, with a desktop notification where the terminal supports it. If
no session is open at that moment, the notice appears at the next session start.
An import that fails before queuing anything is announced the same way; one
that queued chunks reports through the completion notice.

`/skillmeter:backfill status` distinguishes queued chunks from chunks acknowledged
by the backend. A queued snapshot alone does not prove delivery.

## Data and privacy

Collected content can include prompts, assistant messages, tool inputs/results,
transcript deltas, session metadata, configuration names/counts, permission rules
and bounded descriptions/bodies of custom project or user skills. Instruction
file bodies and MCP command/args/env are excluded from dedicated harness fields,
but sensitive values can still appear in conversation content.

Policy 3.1.0 applies before queueing:

- Recognized secrets and rule-detectable personal information receive typed
  placeholders. Names in general prose and other contextual identifiers can remain.
- The home-directory prefix is HMAC-hashed in text. Structured file-path fields
  retain hierarchy, technical vocabulary and extensions; other segments are hashed.
- Working-directory and generic path fields are hashed whole. Commands and
  ordinary text retain content after redaction and home-prefix hashing.
- Enabled repositories include their `org/repo` name in clear.
- `_sanitization` records policy version, counts and detector IDs, without the
  matched values. Content placeholders remain stable; paths are hashed again
  on another pass.

HMAC uses a local salt and 12 hexadecimal characters. Sanitization reduces
exposure; it does not guarantee anonymity or remove every sensitive detail.
See [ADR002](../docs/adr/002-two-stage-sanitization.md) for the policy and
[PRIVACY.md](../PRIVACY.md) for the full disclosure, retention and data requests.

## Uploads and recovery

Hooks append sanitized events to repository-bound queues. Stop and SessionEnd
seal events and stage transcript chunks, then start a detached drain. Startup
retries and the retry monitor handle remaining uploads. Network requests use
gzip and the license's tenant endpoint, with consent checked again before sending.

Successful event batches become `.sent`; acknowledged transcript chunks are
deleted. Transcript failures share a per-chunk retry budget across all drains:
waits double from one minute to a 30-minute cap, then the eighth failed attempt
quarantines the body and metadata. Quarantined files and delivered event logs
are eligible for cleanup after 30 days. Pending chunks are retained for retry
unless an applicable policy change removes them.

License refresh runs at session start, before uploads and during monitor sweeps.
Stop also requests a detached refresh for an enabled repository near expiry,
even when its queue is empty and no monitor is running. Hooks do not wait for
the request. This restores capture on later hooks after recovery; events skipped
while the license is stale are still lost.
Transient failures back off; repeated failure or revocation stops background
retries. A license that can no longer be refreshed requires `/skillmeter:signin`
and browser approval. See [ADR001](../docs/adr/001-license-token-lifecycle.md).

## Local state and diagnostics

| Location | Contents |
| --- | --- |
| `~/.skillbench/credentials.json` | Device ID, hash salt and license |
| `~/.skillbench/telemetry-policy.json` | Global, organization and repository choices |
| `~/.skillbench/license-status.json` | Refresh timestamps, failures and terminal reason |
| `${CLAUDE_PLUGIN_DATA}/logs/repositories/` | Repository event and transcript queues |
| `${CLAUDE_PLUGIN_DATA}/logs/backfill.ndjson` | Local backfill progress and upload outcomes |

Persistent plugin data also stores the installation's backfill decision.
Backfill diagnostics omit transcript text, local paths, JWTs, device IDs and
backend endpoints, but include repository/session identifiers. Review them
before sharing; never post real telemetry or credentials in a public issue.

Project `.claude/settings.local.json` contains development overrides, not
telemetry consent. For problems, see [SUPPORT.md](../SUPPORT.md). Report security
or privacy issues through [SECURITY.md](../SECURITY.md).

## Development

Use CommonJS and run `node --test` from the repository root. Tests isolate plugin
state through `testing/bootstrap.js` and `testing/helpers.js`. See
[AGENTS.md](../AGENTS.md) for contribution conventions and the
[ADRs](../docs/adr/README.md) for shared policy decisions.

| Environment variable | Purpose |
| --- | --- |
| `CLAUDE_PLUGIN_DATA` | Persistent plugin state; use a temporary directory for direct test runs |
| `SKILLMETER_ENV=dev` | Select development identity/activation endpoints and separate state |
| `SKILLMETER_STATE_DIR` | Override credential and policy state for isolated runs |
| `SKILLMETER_ACTIVATE_URL` | Activation URL; refresh uses the same host |
| `SKILLMETER_BROKER_URL` | Identity service URL |
| `SKILLMETER_OAUTH_CLIENT_ID` | Public device-flow client ID; default `skillmeter-plugin` |
| `SKILLMETER_BACKEND_URL` | Telemetry base URL override; authentication is still required |
| `SKILLMETER_TIMEOUT` | Event upload timeout in seconds; default 10 |
| `SKILLMETER_RETRY_DAEMON_INTERVAL_MS` | Monitor sweep interval in milliseconds; default 120000 |

Configuration precedence is environment, project string setting, development
bundle, then production default. Project keys include `activate_url`,
`broker_url` and `oauth_client_id`. Normal tenant routing comes from the license's
`aud` claim and needs no endpoint override.
