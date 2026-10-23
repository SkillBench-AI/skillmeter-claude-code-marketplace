# SkillMeter for Codex

SkillMeter sends repository-scoped Codex workflow and conversation telemetry to
[SkillBench](https://skillbench.com). Collection and uploads run in the background.
See the [installation and update guide](../../README.md#install) to get started.

## Sign in and controls

In Codex, run the skills by name, as the slash commands of SkillMeter for
Claude Code:

| Skill | What it does |
| --- | --- |
| `$skillmeter:signin` | Sign in, then choose telemetry for each licensed organization |
| `$skillmeter:signout` | Sign this plugin out (other SkillMeter clients stay signed in) |
| `$skillmeter:telemetry list` | Review and toggle known repositories |
| `$skillmeter:telemetry status` | Show capture state, sign-in and the local queue |
| `$skillmeter:telemetry enable` / `disable` | Turn the current repository on or off |
| `$skillmeter:telemetry enable-global` / `disable-global` | Resume or pause all Codex collection on this machine |

These three skills run only when named, so Codex never changes sign-in or
consent on its own.

The onboarding question and the repository list are shown as forms with a
picker, through the plugin's bundled MCP server (`skillmeter`, started from
`.mcp.json`) and MCP elicitation. Nothing is saved unless the form is accepted.
Codex declines forms without showing them when approvals are off (for example
`--yolo`, `approval_policy = "never"` or `codex exec`); the skills then ask in
text instead. The server can be turned off with
`[plugins."skillmeter@<marketplace>".mcp_servers.skillmeter] enabled = false`. The Codex-only `check-repo-scope`, `collect-export` and
`review-export` skills also respond to plain requests.

For terminal commands, set `PLUGIN_ROOT` to the **Installed plugin root** printed
by `codex plugin add`. Replace the placeholder below with that exact path so the
commands use the installed version rather than an older cached copy:

```sh
export PLUGIN_ROOT="/absolute/path/to/installed/skillmeter"
```

Commands use the same local queue as hooks: `PLUGIN_DATA` when set, otherwise
the directory Codex last gave this installation's hooks (recorded in
`~/.skillbench/clients/codex/plugin-data.json`), otherwise the Codex data
directory for that installation
(`~/.codex/plugins/data/skillmeter-<marketplace>`, created with owner-only access if
Codex has not made it yet). Queues are never kept
inside the versioned installation, which an update replaces. From a source
checkout, set `PLUGIN_DATA` explicitly; without it the command stops with
`persistent-plugin-data-unavailable`. If an older installation still holds
queued events, commands stop with `legacy-install-data-recovery-required`
until that data is moved or removed.

Run project controls from the repository you want to configure:

| Task | Command |
| --- | --- |
| Sign in | `node "$PLUGIN_ROOT/bin/signin"` |
| List local repositories of the licensed organizations and their choices (JSON, no paths) | `node "$PLUGIN_ROOT/scripts/repository_telemetry.js" list` |
| Toggle listed repositories, onboard an organization, or turn it on or off (the skills guide the question and summary) | `node "$PLUGIN_ROOT/scripts/repository_telemetry.js" toggle\|onboard\|org …` |
| Inspect sign-in claims and expiry (no raw token) | `node "$PLUGIN_ROOT/bin/sk-jwt"` |
| Check capture policy, authentication and local queues | `node "$PLUGIN_ROOT/bin/sk-telemetry" status` |
| Turn this repository on / off (ON needs the organization ON and `--acknowledge-machine-scope`) | `node "$PLUGIN_ROOT/bin/sk-telemetry" enable --acknowledge-machine-scope` / `disable` |
| Pause / resume Codex collection and uploads | `node "$PLUGIN_ROOT/bin/sk-telemetry" disable-global` / `enable-global` |
| Restrict this checkout locally / clear the restriction | `node "$PLUGIN_ROOT/bin/sk-telemetry" restrict` / `unrestrict` |
| Preview consent choices and local restrictions | `node "$PLUGIN_ROOT/bin/sk-telemetry" consent-preview` |
| Record one organization or repository choice against a revision | `node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set on\|off …` |
| Sign out | `node "$PLUGIN_ROOT/bin/signout"` |

`enable` and `disable` record this repository's choice, as in SkillMeter for
Claude Code. In earlier versions they wrote only a local restriction; that is now
`restrict` and `unrestrict`. `enable --global` and `disable --global` still work.

Sign-in is a device flow through the SkillBench sign-in service: open the URL
it prints, approve, and pick the workspace when asked. Repository capture is
limited to the GitHub organizations that workspace has connected (the license's
`orgs`); `SKILLMETER_REPO_SCOPE_ORGS` and `skillmeter.repoScopeOrgs` can
narrow that further but never widen it.

After sign-in, `$skillmeter:signin` asks one telemetry question per licensed
organization, as SkillMeter for Claude Code does: turn on the local
repositories it found (from the working directory, Codex's trusted projects and
past Codex sessions), authorize the organization only, or keep it off. Each
answer is saved in one write and summarized as `Telemetry ON` and
`Telemetry OFF` lists. Nothing is turned on without an explicit answer, and
signing in again asks again.

The session is this plugin's own (`~/.skillbench/clients/codex/session.json`):
the sign-in service's refresh token renews the license, and signing in or out
of SkillMeter for Claude Code does not affect it. Signing out ends the session,
revokes it at the sign-in service, and deletes event batches not yet sent. When
the workspace stops licensing you, the session ends the same way at the next
renewal. The device identity is shared by every SkillMeter client; sign-out
keeps it and the consent choices.

Consent choices and the global pause are this plugin's own too
(`~/.skillbench/clients/codex/telemetry-policy.json`). Choices made in
SkillMeter for Claude Code do not apply to Codex, and Codex choices do not
apply to Claude Code. The pause retains queued data for later delivery, but
sealed event batches are still removed 30 days after sealing, paused or not.

Upgrading from a version that signed in with GitHub starts signed out: nothing
is carried over, and event batches recorded under the old sign-in are dropped.
Cutover completion is recorded only after all legacy event batches are cleared.
A locked batch keeps capture, delivery and sign-in on hold; close older Codex
sessions and retry. An existing broker session without a completion record is
ambiguous when event batches remain: the plugin holds those batches rather than
deleting potentially new events. An empty event queue can complete cutover
without discarding data. Preserve a verified backup and resolve its disposition with support
before resetting state or signing out. This hold is not a recovery workflow and
does not disable the existing age-based cleanup. Do not run old plugin workers
alongside the upgrade: they do not honor the new completion gate.

Upgrading from a version that used the machine-wide shared consent record
starts with no Codex consent: record the organization and repository again.
Event batches queued under the shared record are held and expire at the
30-day limit without being sent.

`status` is read-only. It separates repository capture eligibility from license
freshness and reports pending event batches and current-format transcript chunks
across repositories. Expired credentials can pause delivery while eligible local
capture continues. It does not verify hook execution or server acceptance, and
this version does not track the last successful upload. An empty queue does not
prove delivery or report generation; legacy snapshots are excluded from the count.

`consent-preview` shows the organization and repository choices, local
restrictions at the repository root and along the path to the current
directory, and missing acknowledgements. Use `--json` for structured output. It
does not scan other directories or change consent settings, credentials or
queued data. It records a local observation marker so a later missing consent
record is reported.

Capture needs the organization ON, then the repository ON. Use the revision
shown by a fresh preview for each write:

```sh
node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set on \
  --organization org --revision absent --acknowledge-machine-scope
node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set on \
  --repository github.com/org/repo --revision 1 --acknowledge-machine-scope
node "$PLUGIN_ROOT/bin/sk-telemetry" consent-set off \
  --repository github.com/org/repo --revision 2
```

ON applies to Codex on this machine and to every clone or worktree of the
repository. The organization must be covered by the license. Repository ON
requires the organization ON first, and local OFF or invalid settings must be
resolved explicitly first. OFF needs no acknowledgement. Use `--revision absent`
before any choice exists. A stale revision or changed repository requires a new
preview and confirmation.

The command checks known local queue revocations without uploading, reports
deferred cleanup, and preserves privacy cursors. In-flight requests may finish.
A saved choice does not prove hook execution, delivery or report generation.

## Collection scope

ChatGPT Work transcript delivery is not supported. A transcript containing
`session_meta.originator=codex_work_desktop` is rejected during staging even in
an eligible repository. This does not purge previously queued data or change
hook-event collection. Per-task Work consent and delivery remain separate work.

A recognized GitHub repository and an allowed remote owner are required:

- Eligible repositories remain off until the organization and repository are
  both ON.
- An explicit OFF, in the record or in a local setting, stops collection even
  for an allowed owner.
- Consent cannot bring an out-of-scope repository into scope.
- The global pause overrides every choice. There is no OS consent pop-up.

`restrict` / `unrestrict` read and write
`<git-root>/.codex/settings.local.json`, including from subdirectories. Local
OFF and malformed settings restrict capture; a local ON grants nothing on its
own. Record choices cover all clones and worktrees with the same canonical
GitHub identity.

For additional narrowing, set `SKILLMETER_REPO_SCOPE_ORGS` to comma-separated
owners, or use `skillmeter.repoScopeOrgs` in the same settings file. These filters
can only restrict allowed identities. Nested repositories use their own
identity. A subdirectory OFF restricts that directory; a subdirectory ON cannot
authorize the repository.

Explicit organization or repository OFF revokes known queued payloads while
preserving privacy cursors and other repositories' data. Global pause holds
queues. Missing choices hold rather than revoke. A missing previously observed
record, an invalid record or a failed observation marker blocks capture and
delivery without repair. Event batches recorded before 0.11.0 were removed
on the first run of 0.11.0.

Observed disabled intervals and the initial transcript prefix are excluded from
staging and baseline recovery. Consent changes can also exclude uncertain
intervals, so native startup timing still matters. See the [consent contract](../../docs/repository-consent.md).

## Data and privacy

Collected data can include:

- Prompts, assistant messages, tool inputs and outputs, and session transcripts.
- Session, model and plugin metadata, lifecycle events, and subagent activity.
- Configuration names and counts, plus bounded descriptions and bodies of
  custom project/user skills. This is **not metadata-only collection**.

Policy 3.1.2 redacts recognized secrets, email addresses, VCS author names,
phone numbers, IP addresses, national identifiers and payment-card numbers with
typed placeholders. File-path fields retain hierarchy, extensions and approved
technical vocabulary; other segments are hashed. Directory fields, commands and
patches are hashed whole with a per-device salt. Free text hashes the home prefix.

Names, addresses and confidential free text may remain readable. Stage-2
sanitization is separate; this plugin does not guarantee complete PII removal.
See the [shared policy and Codex adapter](../../docs/sanitizer-parity.md).

The device ID and hash salt live in `~/.skillbench/credentials.json`, shared with
other SkillMeter clients; this plugin's session lives in
`~/.skillbench/clients/codex/`.
Queued telemetry lives under the plugin data directory's `logs/` folder.
SkillMeter sends authenticated data to the tenant endpoint in the license's
`aud` claim. Events go to the event pipeline; transcripts go to object storage
for downstream analysis.

## Uploads and troubleshooting

Uploads use durable local queues. Transcript chunks retain their order and
retry identity across interruption and restart. A send failure does not require
reinstalling the plugin or deleting its data. Each later wire chunk, including
chunks split from a large batch, opens with a `session_continuation` record that
carries only the session id, working directory, originator and lineage, so a
stored object that holds later chunks of a long session can still be attributed
to that session. This requires a usable first `session_meta` record and metadata
preservation; otherwise, later batches remain content-only.

| Symptom | Check |
| --- | --- |
| Reinstall still shows an old version | For a local marketplace, update the source checkout first; for a Git marketplace, run `marketplace upgrade`. |
| Collection is paused or the repository is excluded | Run `status`; for details run `status --details`, and check the license's GitHub organizations with `sk-jwt`. |
| Uploads fail with 401/403 | Credentials and queued uploads are retained; background recovery requests a refreshed license. Check sign-in status if failures persist. |
| Transcript delivery needs investigation | Use the [read-only inventory and recovery guide](integration/README.md#queue-and-recovery). |

Drains and the retry monitor renew the license before they send; session start
does not. Delivery waits for a valid token. Renewal uses the sign-in service's
refresh token; when the service ends the session, sign in again.

Current limitations:

- Historical transcripts are not automatically replayed.
- Multi-day transcript continuity depends on the collector's missing-baseline
  recovery support. See the [transport guide](integration/README.md).
- Report availability depends on downstream transcript processing; successful
  event uploads alone do not confirm a complete report.

## Bundled skills

| Skill | Purpose |
| --- | --- |
| [signin](skills/signin/SKILL.md) | Sign in through the SkillBench sign-in service and choose a workspace |
| [signout](skills/signout/SKILL.md) | End this plugin's session and stop uploads |
| [telemetry](skills/telemetry/SKILL.md) | Show collection status; record organization and repository consent; restrict, pause or resume collection |
| [check-repo-scope](skills/check-repo-scope/SKILL.md) | Check whether the current repository is eligible |
| [collect-export](skills/collect-export/SKILL.md) | Prepare a sanitized export for a one-off review |
| [review-export](skills/review-export/SKILL.md) | Review an export before upload |

## Development settings

The environment is fixed by the installation: the internal channel uses dev
(`~/.skillbench-dev`), the stable channel prod. No environment variable switches
it. These overrides point one endpoint or directory elsewhere, for a local stack
or isolated tests:

| Variable | Purpose |
| --- | --- |
| `SKILLMETER_BROKER_URL` | Sign-in service (HTTPS on skillbench.ai/.com, or loopback) |
| `SKILLMETER_ACTIVATE_URL` | License server `/activate` (same restriction) |
| `SKILLMETER_STATE_DIR` | State directory holding the device identity and this plugin's session and consent record |
| `SKILLMETER_BACKEND_URL` | Trusted ingest URL override; uploads still require a valid license |
| `SKILLMETER_HARNESS_HASH_SKILL_NAMES=1` | Hash skill names in harness metadata |

Project settings cannot redirect sign-in or uploads: a repository you open must
not be able to send your credentials elsewhere. There is no `backendUrl` project
setting.

For implementation details, see the [hook definitions](hooks/hooks.json),
[upload code](scripts/logger.js), [sanitizer](scripts/sanitizer.js), and
[transport and recovery guide](integration/README.md). Run `npm run check` from
the repository root when changing plugin code.

Tests live under `test/` by purpose (`sanitizer`, `consent`, `hooks`,
`transport`, `auth`) with shared fixtures in `test-support/`. Queue revocation
runs with `node --test plugins/skillmeter/test/consent/queue-revocation.test.js`
from the repository root; it uses synthetic repositories and an intercepted
fetch to check repository payload purge, mixed-batch isolation and retry
authorization against Claude's `scripts/lib/repository-queue.js` contract.
