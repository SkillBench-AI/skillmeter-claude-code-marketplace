# Two-Stage Sanitization and Typed PII Placeholders

**Date:** 2026-09-11
**Status:** Accepted
**Tracker:** INF-192 (2026 Q3 Production Readiness / Telemetry pipeline)
**Related:** `skillmeter-codex-marketplace` and `session-collector` (sibling
sanitizers under the same policy), `skillmeter-vscode-extension` (shared HMAC
scheme), `skillbench-pipelines` (stage 2 lives there), GitHub issues #102 and
#103

## Context

Every record the plugin uploads passes through one sanitizer before it is
queued: hook events and harness metadata through `sanitizeEventData` in
`logger.js`, organization-audit records through the same function, and
transcript deltas line by line through `sanitizeLine` in
`transcript-delta.js`. Nothing downstream sanitizes again. The collector
Lambda truncates every string attribute to 100 characters before it reaches
ClickHouse `otel_logs` and writes transcript chunks to S3 as received; the
analysis pipeline's preprocessing step reserves a redaction stage between
parsing and projection, which is a pass-through today.

### Current behaviour (as-is)

Policy `2.0.0` in `scripts/lib/sanitize.js` and `scripts/lib/rules.js`:

- 24 secret detectors (cloud and SaaS API keys, GitHub and GitLab tokens,
  private key blocks, JWTs, credentialed database and HTTP URLs,
  `Authorization` headers, `.env`-style assignments). Six of them carry a
  Shannon-entropy floor of 3.0 bits per character, most carry a cheap
  keyword pre-filter, and a stopword allow-list skips obvious placeholders
  such as `example` or `changeme`. Matches become `[REDACTED_SECRET]`.
- One PII detector: an ASCII-only e-mail pattern that becomes `[EMAIL]`.
- Key-name forced redaction: any string whose object key matches
  `api[_-]?key`, `token`, `password`, `secret`, `credentials`, `bearer`,
  `access[_-]?key` or `\bauth(?:\b|oriz)` is replaced wholesale, whatever
  its content.
- Path handling: values under `file_path`, `filePath`, `path`,
  `notebook_path`, `cwd`, `old_cwd` and `new_cwd` are HMAC-SHA256 hashed
  wholesale with the per-device salt (12 hex characters), and the user's
  home-directory prefix is replaced by its HMAC inside every other string.
  Object keys are scrubbed the same way as values.
- Reporting: a `_sanitization` object (`policyVersion`, `secrets`, `pii`,
  detector `ids`) is attached to an event only when at least one redaction
  happened.

The Codex plugin and the standalone session collector carry the same policy
and version; a shared fixture corpus (24 seeded secrets and one e-mail) runs
in the CI of all three repositories, so a secret miss in any of them blocks
merge.

### Observed problems

1. PII coverage is a single e-mail rule. Person names, phone numbers, IP
   addresses, national identifiers, payment-card numbers, postal addresses
   and customer names pass into S3 transcripts unchanged and into `otel_logs`
   truncated. The plugin is about to be installed beyond the core team, and
   "what exactly leaves my machine" has to be answerable per category.
2. Issue #102 / #103 (reported by a consumer porting the rule table): the
   e-mail rule is ASCII-only, so `josé@example.com` survives whole and
   `renée.dubois@example.org` becomes `rené[EMAIL]`, which leaks the given
   name while looking sanitized. The sanitizer also matches its own output:
   the stopword list contains `redacted` but not the bracketed placeholders,
   so a second pass over `API_KEY=[REDACTED_SECRET]` counts a phantom
   redaction, and a placeholder sitting under a secret-labelled key is
   rewritten as `[REDACTED_SECRET]`, losing its category. Neither case is in
   the shared corpus.
3. The key-name heuristic fires on free text. Claude Code stores
   `AskUserQuestion` answers keyed by the question text, and on 2026-09-10 a
   production record carried the answer to "Keep SkillMeter telemetry
   authorized for @skillbench-ai?" as `[REDACTED_SECRET]` because
   "authorized" matches `\bauth(?:\b|oriz)`. A heuristic designed for `env`
   blocks and tool parameters destroys legitimate content when applied to
   questions, headers and labels.
4. Names, addresses and customer names cannot be found by rules; they need
   context. A named-entity model on the device is not an option for a Node
   plugin that runs inside hook latency budgets and would ship a model
   larger than the plugin itself.
5. Nothing can be measured. `_sanitization` exists only on redacted records,
   so hit rates and false-positive rates per detector cannot be read from
   ClickHouse without a full scan, and there is no negative signal at all.
6. Placeholders discard category. Collapsing everything to one token is
   acceptable for secrets, which are one class, but an e-mail, a phone
   number and a card number in a prompt are different facts for analysis
   and for measurement.
7. Wholesale path hashing removes the extension and directory depth, so the
   analysis pipeline has recorded five path-derived metrics as structurally
   unreachable in production. The identity in a path is the directory
   structure and the file name, not its extension.

## Decisions

### 1. Sanitization runs in two stages with fixed responsibilities

Stage 1 runs on the device, before any record is queued, and is
deterministic: regular expressions, format checks and the HMAC scheme. It is
fail-closed for secrets and covers the PII categories a rule can recognise
without context (decision 3). It is the only stage that sees unsanitized
data.

Stage 2 runs inside the tenant's AWS account over the uploaded objects and
uses a specialised PII-detection engine, not prompts to a general-purpose
model. The engine is Presidio, embedded in the analysis worker; Amazon
Comprehend `DetectPiiEntities` is the comparison baseline. Both are first run
over the SkillBench tenant's own data with a measurement dashboard (entities
per category, agreement between engines, sampled false positives) before
stage 2 is allowed to gate analysis input. A language model may later assist
with dictionary-type entities such as customer names, in-region only and
only after the engine pass; it is never the privacy control.

Rationale: the device is the only place where unsanitized data can be
stopped from travelling, so the local stage must exist and must be cheap.
Context-dependent entities need a model, and a model belongs where CPU,
memory and language packs are not the user's problem. Two stages also give
two independent chances to catch a secret. The engine choice reuses prior
internal evaluation of both products and the ongoing Presidio work in the
research pipeline; a prompt-based detector was rejected because the privacy
guarantee would then depend on a non-deterministic component and because
detecting PII by sending it to a model provider is itself a transfer.

### 2. Uploaded objects are "stage-1 sanitized", read only by stage 2

The object the plugin uploads is called stage-1 sanitized, never "raw":
secrets and stage-1 PII categories are already gone and paths are hashed.
Stage 2 writes a stage-2 object per input; the analysis pipeline and every
other consumer read stage-2 objects only. The stage-1 object is deleted when
stage 2 succeeds. When stage 2 fails, the stage-1 object is moved to a
quarantine prefix with a 7-day lifecycle and readable only by the
sanitizer's own role. Stage 2 is triggered per object on arrival, not by the
weekly analysis batch, so a stage-1 object lives for minutes.

`otel_logs` holds stage-1 content. It is classified internal-only, is never
a source for user-facing reports, and is not rewritten by stage 2: its
strings are truncated to 100 characters and ClickHouse mutations are the
wrong tool for row rewrites.

Rationale: the question an installer will ask is whether unsanitized text
sits in SkillBench storage. With this decision the answer is that nothing
unsanitized leaves the device, the one intermediate form is deleted within
minutes of a successful second pass, and the analysis never touches it.
Event-driven processing rather than the Monday batch is what makes "minutes"
true.

### 3. Stage 1 covers a fixed set of categories, each with a typed placeholder

The placeholder preserves the category and never the value. The generic
`[REDACTED]` is not used.

| Category | Stage | Placeholder | Rule |
| --- | --- | --- | --- |
| Secrets (24 detectors) | 1 | `[REDACTED_SECRET]` | Unchanged |
| E-mail address | 1 | `[EMAIL]` | Unicode letters in the local part and internationalised domain labels; the whole address is replaced |
| Person name in VCS metadata | 1 | `[PERSON]` | `Author:`, `Committer:`, `Signed-off-by:`, `Co-authored-by:` lines in tool output; the name before `<` is replaced, the e-mail follows the e-mail rule |
| Phone number | 1 | `[PHONE]` | `+` country code or separator-formatted national numbers with at least 9 digits; bare digit runs are not matched |
| IP address | 1 | `[IP]` | IPv4 with octets ≤ 255 and IPv6 literals; loopback, unspecified and documentation ranges are kept |
| National identifier | 1 | `[ID_NUMBER]` | Korean resident registration number and US Social Security number formats; tenant-configurable additions |
| Payment card | 1 | `[CARD]` | 13 to 19 digits with optional spaces or dashes, Luhn-valid, known issuer prefixes |
| Person name in free text | 2 | `[PERSON]` | Engine entity |
| Postal address | 2 | `[ADDRESS]` | Engine entity |
| Customer and organization names | 2 | `[CUSTOMER]`, `[ORG]` | Tenant dictionary plus engine entity |
| Other engine entities | 2 | Typed per entity | Mapping table maintained with stage 2 |

Four-part version strings such as `10.0.0.1` are indistinguishable from
IPv4 addresses and are redacted; this false positive is accepted and
documented. Every stage-1 rule ships with positive fixtures and negative
fixtures (version strings, numeric identifiers, Unicode names without an
address, the placeholders themselves, the "authorized" question key) in the
shared corpus.

Rationale: these seven categories are the ones a format identifies without
context, so a rule can hold recall high with false positives that are
measurable and acceptable. Names and addresses are left to stage 2 because a
rule that tried them would either miss almost everything or redact ordinary
prose. Typed placeholders keep the analysis able to say "the prompt
contained a phone number" and keep the dashboard of decision 1 able to
count per category.

### 4. Structural rules of stage 1

- Key-name forced redaction applies only to identifier-like keys: no
  whitespace, at most 64 characters, matching `^[A-Za-z0-9_.:-]+$`. Free-text
  keys are scrubbed by content rules only. This removes problem 3 without
  weakening the `env`-block case the heuristic exists for.
- Sanitization is idempotent. A string that is exactly a placeholder of the
  vocabulary above is never matched by any rule and is never subject to
  key-name forced redaction; `sanitize(sanitize(x))` equals `sanitize(x)`
  and adds no redaction counts. The guard trusts placeholder shape, not
  provenance, and that trade is accepted.
- Path values under the path keys are still hashed wholesale, but the file
  extension and the directory depth are recorded as separate fields before
  hashing. The hash itself, the salt and the home-prefix replacement are
  unchanged, so cross-surface correlation on the same device is preserved.
- `_sanitization` is attached to every record, with `policyVersion`, a
  per-category count map and the detector `ids`, including when every count
  is zero. This is what makes rates per detector a ClickHouse query.
- The policy version becomes `3.0.0`. As with `2.0.0`, the version is
  declared only when the Codex plugin and the session collector pass the
  extended corpus; the VS Code extension keeps the unchanged HMAC scheme.

### 5. The user-facing statement lists categories, not adjectives

`PRIVACY.md` enumerates the stage-1 categories with their placeholders,
states that a second pass runs inside the tenant account with a
purpose-built PII engine, that analysis reads only its output, and how long
the intermediate object can exist. It keeps the sentence that sanitization
is a risk-reduction control and not an anonymization guarantee. The plugin
does not claim complete PII removal anywhere.

## Consequences

- Data leaving the device carries typed PII placeholders; secrets are
  unchanged. Analysis loses the values and keeps the categories.
- Stage 1 does more work per string. New rules get a cheap pre-check (a
  digit run or an `@`) before the full expression, and the transcript path
  is measured against its existing 20 MB uncompressed chunk budget before
  release.
- Accepted false positives: four-part version strings as IPs, separator-
  formatted numeric identifiers as phone numbers when they reach 9 digits.
  Both are visible in the per-category counts and can be tuned with negative
  fixtures.
- Stage 2 is a new component in each tenant account with read, write and
  delete rights on the transcripts bucket and its own quarantine prefix;
  that is infrastructure work in the pipelines repository, tracked
  separately.
- `otel_logs` is formally internal-only. Anything shown to users must derive
  from stage-2 objects or from counts, never from `otel_logs` strings.
- Events already in ClickHouse and objects already in S3 were sanitized under
  `2.0.0`; stage 2 processes existing objects once when it is introduced.
- Rollout order: this plugin at `3.0.0` with the `PRIVACY.md` update, then
  sibling-sanitizer parity, then stage 2 with its dashboard on the SkillBench
  tenant, then stage 2 gating analysis input for every tenant.

## Implementation mapping

| Decision | Where |
| --- | --- |
| 1, 2 | Stage 2 engine, object lifecycle and dashboard: follow-up issue in the pipelines tracker, filed from INF-192 |
| 3, 4 | INF-192 (this repository, policy `3.0.0`), then parity issues for the Codex plugin and the session collector |
| 5 | INF-192 (`PRIVACY.md` ships in the same PR as `3.0.0`) |

## Open items

- Language coverage of stage 2. Presidio's default recognisers are
  English-centric; prompts in this tenant are frequently Korean, so the
  dashboard of decision 1 must report per language and a Korean model is a
  prerequisite before stage 2 gates anything.
- Source of the `[CUSTOMER]` and `[ORG]` dictionaries per tenant, and who
  maintains them.
- Whether the Korean resident registration number rule should apply the
  checksum that pre-2020 numbers carry, at the cost of missing newer ones.
- Which national identifier formats beyond the two named here each tenant
  needs; the list is configuration, not policy.
- Whether hashed paths should carry more than extension and depth (for
  example a hashed top-level directory) if the analysis pipeline shows it
  needs them.
