# SkillMeter Claude Code Plugin Privacy Notice

Effective: July 28, 2026

Status: disclosure draft pending approval by the SkillBench privacy/legal
owner. It is intended to describe the current client implementation accurately;
the server-retention language must be confirmed before directory submission.

This notice describes data processing performed by the SkillMeter Claude Code
plugin. It supplements the [SkillBench Privacy
Policy](https://skillbench.com/privacy/) and the
[SkillBench subprocessor list](https://skillbench.com/subprocessors/). If this
plugin is provided through an organization, that organization's notices and
agreement with SkillBench may also apply.

## Consent and scope

Installing the plugin does not enable telemetry. There are two independent
consent paths, and neither one implies the other.

### Ongoing telemetry

Telemetry from current sessions is sent only when all of the following are
true:

1. a valid SkillMeter license is present;
2. the user has explicitly authorized the licensed GitHub organization;
3. the user has explicitly enabled the repository; and
4. the machine-global telemetry kill-switch is not active.

Organization authorization never silently enables a newly discovered
repository. The plugin checks the current repository's Git remote against the
organization encoded in the license before capture and again before transfer.

The plugin may create local device and policy state, inspect repository
ownership, and display consent UI before telemetry is enabled. That local
processing is not uploaded as telemetry.

### One-time historical backfill

A plugin installation may separately ask **once** whether to send completed
historical transcripts. This is a distinct decision with its own conditions:

1. a valid SkillMeter license is present;
2. the offered repositories belong to a GitHub organization encoded in that
   license;
3. the user has explicitly approved the one-time historical question for the
   named set of repositories shown; and
4. the machine-global telemetry kill-switch is not active — it pauses
   historical transmission just as it pauses ongoing telemetry.

Because this consent is independent, the offer covers every repository of the
licensed organization that the plugin can discover locally, **including
repositories whose ongoing telemetry is off**, and approving it neither
requires nor grants organization authorization or repository enablement.
Conversely, ongoing telemetry consent never causes historical transcripts to be
sent.

Approval applies only to the specific repositories and the transcript cutoff
recorded when the question was answered; sessions modified after that point are
excluded. Declining or cancelling does not enable historical processing, and
the plugin does not ask again during that installation lifecycle. The user may
still start a backfill deliberately with `/skillmeter:backfill`, which asks the
same question again before doing anything.

## Data processed

The current plugin processes the following categories.

### Authentication and account data

- a randomly generated device identifier;
- a locally generated hashing salt;
- a SkillMeter license JWT and the organization encoded in it;
- a GitHub OAuth access token obtained from `gh auth token` or GitHub's device
  flow, transmitted as a bearer credential to the SkillMeter activation
  service together with the device identifier.

The plugin does not intentionally persist the GitHub access token. It stores
the SkillMeter license JWT locally for authenticated uploads and refresh.

### Session and workflow telemetry

- timestamps, session and prompt correlation identifiers, Claude Code event
  names, model, permission mode, effort level, and agent identifiers/types;
- user prompt text and notification text;
- tool names, tool inputs, tool responses, tool errors, and tool-use
  identifiers;
- assistant messages exposed by lifecycle hooks;
- task descriptions and metadata, compact instructions, and failure messages;
- sanitized transcript records added since the last local transcript cursor;
- when separately approved, sanitized historical prompt and response records
  through a fixed transcript UUID boundary; historical tool-result and image
  blocks are removed before sanitization;
- repository classification and pseudonymous path/repository identifiers.

### Claude Code environment and configuration

At session start, the plugin can inspect and report configuration shape,
counts, names, and selected content, including:

- the presence and size bucket of `CLAUDE.md`, `CLAUDE.local.md`, and
  `AGENTS.md`;
- skill, subagent, slash-command, hook, plugin, marketplace, and MCP server
  names and counts;
- permission modes and permission rule strings;
- bodies and descriptions of custom project/user `SKILL.md` files, capped by
  the plugin's size and count limits.

The plugin does not intentionally collect MCP command arguments or environment
variable values as dedicated harness fields. Those values can nevertheless
appear inside prompts, tool payloads, errors, or transcript records.

## Sanitization and its limits

Before telemetry is queued, the plugin:

- attempts to replace recognized secrets with `[REDACTED_SECRET]`;
- replaces recognized email addresses with `[EMAIL]`;
- HMAC-hashes the home-directory prefix and path-bearing fields;
- records detector identifiers and redaction counts without the original
  matched values.

Sanitization is a risk-reduction control, not an anonymization guarantee.
Pattern-based detection can have false negatives. Prompts, tool responses,
transcripts, task descriptions, custom skills, and similar free-form content
may still contain personal, confidential, copyrighted, or proprietary
information after sanitization. Users and organizations should enable
telemetry only for repositories where that processing is authorized.

## Purposes

SkillBench uses plugin data to:

- provide organization-level developer workflow and skill analytics;
- measure Claude Code and harness usage patterns;
- operate, secure, troubleshoot, and improve the SkillBench service; and
- enforce organization licensing and repository scope.

SkillBench states in its general privacy policy that it does not sell or rent
personal information.

## Recipients and network destinations

The plugin communicates with:

- GitHub, for OAuth device authorization when needed;
- `api.skillbench.ai`, for license activation and refresh; and
- the tenant-specific HTTPS telemetry endpoint encoded in the license JWT.

Telemetry is authenticated with a SkillMeter license JWT and sent using HTTPS
with gzip compression. SkillBench's published subprocessor list identifies
Amazon Web Services as infrastructure used to host and process platform data.

## Local storage and retention

Local credentials and consent state are stored under `~/.skillbench/`.
Repository-bound event and transcript queues are stored in Claude Code's
persistent plugin data directory when available.

The installation-scoped historical-backfill decision is also stored in that
plugin data directory. A machine-local rollout marker under `~/.skillbench/`
prevents an existing installation from being mistaken for a new install when
the feature is introduced.

- successfully uploaded transcript chunks are deleted locally after a
  successful HTTP acknowledgement;
- successfully uploaded event batches can remain locally for up to 30 days for
  diagnostics;
- failed or paused uploads remain queued until a later success or an applicable
  organization/repository OFF decision deletes the payload;
- the global kill-switch pauses queued uploads rather than deleting them;
- repository and organization OFF decisions delete queued payloads for that
  scope, while privacy cursors can remain to prevent later upload of content
  created while telemetry was disabled;
- sign-out removes the license but retains the random device identifier,
  hashing salt, and telemetry policy;
- uninstalling the plugin may not remove `~/.skillbench/`.

To remove the retained local identity and policy files, sign out first, close
Claude Code sessions and background monitors, and then remove the SkillMeter
state directory. Removing local files does not delete data already received by
SkillBench.

## Server retention, access, and deletion

Server-side retention is governed by the applicable SkillBench customer
agreement and account configuration. The public SkillBench privacy policy does
not currently state one fixed retention period for all plugin telemetry.

To request access, correction, portability, restriction, or deletion, contact
`privacy@skillbench.com`. Users accessing SkillBench through an organization
may be directed to that organization as the data controller.

## User controls

- `/skillmeter:signin` authenticates and presents organization/repository
  choices.
- `/skillmeter:telemetry list` reviews and changes repository selection.
- `/skillmeter:signout` removes the local license and stops authenticated
  transmission.
- The global kill-switch pauses all transmission.

Disabling telemetry does not retroactively delete server-side data. Contact
SkillBench or the applicable organization for a server-side request.

## Security and incident reporting

See [SECURITY.md](SECURITY.md). Do not include credentials, raw transcripts, or
other sensitive data in a public issue.

## Changes

Material changes to plugin data collection or use should be reflected in this
notice before release. The effective date above identifies the current
revision.

## Contact

Privacy requests and questions: `privacy@skillbench.com`
