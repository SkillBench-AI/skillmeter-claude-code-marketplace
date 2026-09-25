# Two-Stage Sanitization and Typed PII Placeholders

**Date:** 2026-09-11
**Status:** Accepted (PR #107, merged 2026-09-11). Amended 2026-09-23 for colliding object keys (policy 3.1.1, PR #121) and 2026-09-11 for path
handling, repository identity and the file-name policy; see the
[amendment](#amendment-2026-09-11-path-handling-repository-identity-and-file-name-policy)
at the end.
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
memory and language packs are not the user's problem. For the PII categories
stage 2 covers, two stages also give two chances: a rule miss on the device
is caught by the engine, and the engine's findings are measurable against
the rules' own counts. Secrets are stage 1 only, which is why stage 1 is
fail-closed for them. The engine choice reuses prior
internal evaluation of both products and the ongoing Presidio work in the
research pipeline; a prompt-based detector was rejected because the privacy
guarantee would then depend on a non-deterministic component and because
detecting PII by sending it to a model provider is itself a transfer.

### 2. Uploaded objects are "stage-1 sanitized", read only by stage 2

Decided: the object the plugin uploads is called stage-1 sanitized, never
"raw": secrets and stage-1 PII categories are already gone and paths are
hashed. Stage 2 writes a stage-2 object per input; the analysis pipeline and
every other consumer read stage-2 objects only. A stage-1 object is an
intermediate form with a bounded lifetime, not a retained dataset. Stage 2 is
idempotent per input object: the stage-2 key derives from the stage-1 key, a
re-delivered object reproduces the same stage-2 object, and a stage-1 object
is removed or quarantined only after its stage-2 object is durably written.
The mechanics (conditional writes, retry policy) belong to the
implementation.

Proposed, not confirmed: how that lifetime is bounded is settled after
stage 2 exists and its failure modes and run times have been measured on the
SkillBench tenant. The working proposal, recorded so that implementation
starts from it, is: delete the stage-1 object when stage 2 succeeds; when
stage 2 fails, move it to a quarantine prefix with a 7-day lifecycle that
only the sanitizer's own role can read; trigger stage 2 per object on
arrival rather than from the weekly analysis batch, so the intermediate form
lives for minutes. This ADR is amended with a dated note when these three
parameters are confirmed or changed.

`otel_logs` holds stage-1 content. It is classified internal-only: the
ClickHouse service is reachable only over the tenant's private link, and its
readers are operators and the tenant's own analysis jobs. Permitted uses are
operational health, consent and audit events, and counts and aggregates;
its strings are never quoted in anything shown to users. It is not
rewritten by stage 2: strings are truncated to 100 characters and
ClickHouse mutations are the wrong tool for row rewrites. Its retention is
set by the table TTL and is aligned with this classification under the open
items.

Rationale: the question an installer will ask is whether unsanitized text
sits in SkillBench storage. With this decision the answer is that nothing
unsanitized leaves the device, the one intermediate form has a bounded
lifetime, and the analysis never touches it. The proposal above is what
would make that lifetime minutes rather than days; whether it holds under
real failure rates is a measurement question, which is why it is deferred
rather than fixed here.

### 3. Stage 1 covers a fixed set of categories, each with a typed placeholder

The placeholder preserves the category and never the value. The generic
`[REDACTED]` is not used.

| Category | Stage | Placeholder | Rule |
| --- | --- | --- | --- |
| Secrets (24 detectors) | 1 | `[REDACTED_SECRET]` | Handling unchanged: every detector keeps replacing its match with the placeholder |
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
- Sanitization is idempotent for content. A string that is exactly a
  placeholder of the vocabulary above is never matched by any rule and is
  never subject to key-name forced redaction; a second pass over sanitized
  text changes nothing and adds no redaction counts. The guard trusts
  placeholder shape, not provenance, and that trade is accepted because a
  placeholder is a fixed literal. *(Clarified 2026-09-11 with the 3.1.0
  implementation.)* The same trade is **not** made for hashes: a value that
  merely looks like a hash is never preserved, so path values are hashed on
  every pass and a second pass yields a hash of a hash. That discloses
  nothing and removes any way for a raw path to be kept by resembling a
  hash.
- *Superseded by the 2026-09-11 amendment; kept for history. It was not
  shipped: 0.34.0 left path handling as in 2.0.0.* Path values under the path
  keys are still hashed wholesale, but the file extension and the directory
  depth are recorded as separate fields before hashing. The hash itself, the
  salt and the home-prefix replacement are unchanged, so cross-surface
  correlation on the same device is preserved.
- `_sanitization` is attached to every record, with `policyVersion`, a
  per-category count map and the detector `ids`, including when every count
  is zero. This is what makes rates per detector a ClickHouse query.
- The policy version becomes `3.0.0`. Each surface declares `3.0.0` when it
  passes the extended corpus, so `policyVersion` on a record always states
  that record's actual coverage; this plugin declares it first. The shared
  policy counts as rolled out only when the Codex plugin and the session
  collector declare it too, as happened for `2.0.0`. The VS Code extension
  keeps the unchanged HMAC scheme.

### 5. The user-facing statement lists categories, not adjectives

`PRIVACY.md` enumerates the stage-1 categories with their placeholders,
states that a second pass runs inside the tenant account with a
purpose-built PII engine, that analysis reads only its output, and how long
the intermediate object can exist. It keeps the sentence that sanitization
is a risk-reduction control and not an anonymization guarantee. The plugin
does not claim complete PII removal anywhere.

## Consequences

- Data leaving the device carries typed PII placeholders; secret handling is
  unchanged. Analysis loses the values and keeps the categories.
- Stage 1 does more work per string. New rules get a cheap pre-check (a
  digit run or an `@`) before the full expression, and the transcript path
  is measured against its existing 20 MB uncompressed chunk budget before
  release.
- Accepted false positives: four-part version strings as IPs, separator-
  formatted numeric identifiers as phone numbers when they reach 9 digits.
  Both are visible in the per-category counts and can be tuned with negative
  fixtures.
- Stage 2 is a new component in each tenant account. Its role is scoped to
  prefixes, never to the bucket: read on the stage-1 input prefix, write on
  the stage-2 output prefix, and, if the proposed lifecycle is confirmed,
  delete on the input prefix and write on the quarantine prefix. That is
  infrastructure work in the pipelines repository, tracked separately.
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
| 1, 2 | Stage 2 engine, object lifecycle and dashboard: follow-up issue in the pipelines repository |
| 3, 4 | this repository (policy `3.0.0`), then parity issues for the Codex plugin and the session collector |
| 5 | `PRIVACY.md`, shipped in the same PR as `3.0.0` |

## Open items

- Stage-1 object lifecycle and trigger (the proposal in decision 2): confirm
  delete-on-success, the 7-day quarantine and per-object triggering after
  stage 2 has run on the SkillBench tenant, then amend this ADR.
- `otel_logs` retention. The table TTL per tenant has to be reviewed against
  the internal-only classification above, since 100-character fragments can
  still carry stage-2 categories; set it, record it here.
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
- *Resolved by the 2026-09-11 amendment (segment-wise hashing keeps the
  structure).* Whether hashed paths should carry more than extension and
  depth (for example a hashed top-level directory) if the analysis pipeline
  shows it needs them.

## Amendment 2026-09-11: path handling, repository identity and file-name policy

**Status:** Accepted with decision 4 of this ADR. Decision 8 below is a
proposal, not confirmed.

### Context

0.34.0 shipped stage 1 without the path bullet of decision 4: the extension
and depth side fields were removed before merge because the path design
deserved its own decision. What 0.34.0 therefore carries is the 2.0.0 path
behaviour, which has two properties worth changing and one worth keeping.

- Path-key values (`file_path`, `filePath`, `path`, `notebook_path`, `cwd`,
  `old_cwd`, `new_cwd`) are hashed wholesale. Nothing of the path survives
  except a stable identity per device, so the analysis pipeline has five
  path-derived metrics (`fileTypeEntropy`, `languageUsage`,
  `directoryJumpDistance`, `concernSpread`, `techStack`) it cannot compute in
  production. What those metrics need is structure, extension, per-segment
  identity and a handful of well-known file names, not the names themselves.
- Repository identity is hashed with the per-device salt (`repo_root`,
  `repo_remote_org`), so the same repository has a different identifier on
  every device and organization-level analysis per repository is
  structurally impossible. Consent, however, is granted per repository by
  name, and the recipient is the organization that owns the repository.
- Inside free text (`command`, `prompt`, tool output, object keys) only the
  home-directory prefix is hashed; the relative structure and names below it
  stay. This asymmetry with the path keys is deliberate and is kept (see
  below).

Two options were rejected. Sending file paths in clear everywhere: names in
paths are where product structure, unreleased feature names and customer
names live, and they are Tier 2 in the sanitization policy. Leaving the
wholesale hash in place: safe, but it leaves the metrics unreachable and the
inconsistency in place, and the reversibility argument below says the
stricter representation costs nothing to relax later.

### Reversibility principle

Data already sent cannot be un-sent, so tightening and widening are not
symmetric. Tightening the default (disclosing less) is an ordinary
implementation change under the normal policy-version bump. Widening the
default (disclosing more than the previous policy version did) is never done
implicitly or as a side effect of an implementation change: it requires an
ADR decision that names what becomes visible, why the recipient is entitled
to it, and that the change is irreversible for data sent afterwards; and it
is done as a tenant opt-in (decision 8) whenever the recipient's entitlement
is not already established.

Decisions 6 and 7 are deliberate widenings approved under this rule.
Decision 6 discloses path structure, extensions and allow-listed vocabulary
that 3.0.0 hid, because the analysis metrics need exactly that and no name.
Decision 7 discloses the repository name, because consent was given per
repository by name to the tenant that owns it. Clear file names, by
contrast, are the widening this rule refuses as a default and routes through
the opt-in of decision 8.

### 6. Path-key values are hashed per segment; structure and vocabulary survive

Replaces the third bullet of decision 4.

For `file_path`, `filePath` and `notebook_path`, the keys Claude Code's own
file tools use for filesystem paths:

- The home-directory prefix is hashed as one unit with the existing HMAC, so
  it stays byte-compatible with the prefix hash used inside free text.
- Every other segment is hashed individually with the device salt
  (12 hex characters), except segments that are kept in clear:
  - technical vocabulary on the shared path vocabulary list: common directory
    names such as `src`, `lib`, `test`, `docs`, `api`, `auth`, `billing`,
    `components`, `migrations`;
  - well-known file names on the same list, such as `package.json`,
    `Dockerfile`, `go.mod`, `README.md`, `Makefile`, `.env`;
  - version-like tokens (`v1`, `1.2.0`) by pattern;
  - the extension of the last segment, including known compound extensions
    (`.test.ts`, `.d.ts`, `.spec.js`, `.tar.gz`).
- Separators and segment count are preserved, so depth and hierarchy are
  readable and two paths sharing a directory share its hashed segment.

`/Users/jane/work/acme-portal/src/billing/invoice-acme.ts` therefore becomes
`000687bf6f7f/7788990011aa/2a1b3c4d5e6f/src/billing/1122334455aa.ts`.

The vocabulary list is a data file shared by the Claude plugin, the Codex
plugin and the session collector; a change to it is a policy change and bumps
the policy version. The initial list is drafted from common repository layout
conventions and from segment frequencies in this organization's own
repositories, then reviewed. Exact match, case-insensitive; anything not on
the list is hashed.

`cwd`, `old_cwd` and `new_cwd` keep the wholesale hash. They identify a
directory for the exclusion-audit record and for per-device correlation, and
one stable identifier is all those uses need.

The generic `path` key also keeps the wholesale hash. It appears in
arbitrary tool and MCP payloads, where it may be an API route
(`/customers/acme/v1`) rather than a filesystem path, and segment parsing
would expose its shape together with any allow-listed or version-like
segments. The implementation may segment a `path` value only when the
surrounding tool context establishes that it is a filesystem path (the
built-in Glob and Grep tools); without that context the value is hashed
whole.

Free text keeps the 2.0.0 behaviour: only the home-directory prefix is
hashed. Rationale: commands, prompts and tool output are read by the analysis
for what they say, and a command whose paths are turned into hash chains
loses most of its meaning; the names that remain are exactly what stage 2 is
built to find; and per the reversibility principle this can be tightened
later without cost. The asymmetry is therefore accepted and documented in
PRIVACY.md.

`_sanitization.counts` gains a `path` entry counting every HMAC applied to a
path element in the record: one per hashed segment of a segmented key, one
per whole-value hash (`cwd`, `old_cwd`, `new_cwd`, generic `path`), and one
per home-prefix replacement inside free text. All three sanitizers count the
same way, so totals are comparable in the dashboard of decision 1.

Policy version `3.1.0`, plugin 0.34.1. Only `file_path`, `filePath` and
`notebook_path` change representation: their values written under pre-`3.1.0`
policies are single whole-value hashes and do not join with `3.1.0` values,
and the policy version on each record tells the two apart. `cwd`, `old_cwd`,
`new_cwd` and the generic `path` key keep the wholesale hash and stay
comparable across policy versions. The Codex plugin, the session collector
and the VS Code extension (whose hashing service hashes whole paths) follow
under the per-surface declaration rule of decision 4.

### 7. Repository identity travels in clear to the owning tenant

Every captured event from an enabled repository carries `repo_name`
(`org/repo` as resolved from the remote) in clear, next to the existing hashed
`repo_root` and `repo_remote_org`, which are kept for continuity. The
exclusion-audit record for a repository that is not enabled does not carry
it: consent by name has not been given there.

Rationale: the user turns telemetry on for a repository by its name, and the
data goes to the tenant that owns that repository; the identifier adds
nothing the recipient does not already know. Hashing it with a per-device
salt only prevented the tenant from aggregating its own repositories. A
tenant-wide salt would restore aggregation but not the dashboard label, at
the same cost.

Classification: Tier 2 inside the tenant. It may appear in reports whose
audience is that tenant or the developer themself; it never crosses tenants,
and any cross-tenant comparison uses derived measures only.

Transport: `repo_name` is an ordinary event field. The collector flattens
event fields into OTel attributes generically, so it lands in
`LogAttributes['repo_name']` in `otel_logs` without a collector or schema
change; a dedicated column is an optional later optimisation for query
speed.

### 8. Tenant switch for file names in clear (proposed, not confirmed)

Principle decided: the data owner may choose to receive file and directory
names in clear for its own repositories, since the names are its own asset
and the trade-off (richer context for analysis against exposure inside its
own store) is its to make. The default stays decision 6.

Mechanics deferred: the plugin has no channel today through which a
tenant-level setting reaches the device. This decision is implemented once
such a channel exists, and this ADR is amended then with the setting's name,
default and audit trail.

### Consequences of the amendment

- Analysis regains extension, hierarchy, per-directory grouping and
  manifest-based stack detection. What it receives in clear is bounded to
  the allow-listed technical vocabulary, well-known file names, version-like
  tokens, extensions and, by decision 7, the repository name; every other
  segment, including arbitrary project, customer and file names, arrives
  hashed.
- Free text still carries relative paths and their names below the home
  prefix, as it does today. This is the largest remaining path exposure and
  is assigned to stage 2.
- Organization-level per-repository analysis becomes possible for the first
  time; the `repo_name` attribute is available to ClickHouse queries as soon
  as devices update.
- Two representations of `file_path`, `filePath` and `notebook_path` coexist
  in storage until pre-`3.1.0` devices are gone; consumers switch on
  `policyVersion` for those three keys and need no migration for the
  whole-hashed keys (`cwd`, `old_cwd`, `new_cwd`, generic `path`).
- The vocabulary list is a new shared artifact with its own review.

### Implementation mapping (amendment)

| Decision | Where |
| --- | --- |
| 6 | 0.34.1 plugin PR: segment hashing, vocabulary file, `counts.path`, PRIVACY.md and README |
| 7 | Same plugin PR (`repo_name` field); verification query in ClickHouse after rollout |
| 6, 7 parity | Codex plugin, session collector, VS Code extension: follow-up issues |
| 8 | Deferred until a tenant-policy channel exists |

### Open items (amendment)

- Maintenance of the vocabulary list: who reviews additions, and whether
  tenant-specific additions are allowed.
- Whether stage 2 should also normalise free-text paths (name detection in
  commands and prompts), given decision 6 leaves them in clear below the home
  prefix.
- Whether `cwd` should additionally carry `repo_name`-relative depth for the
  analysis; not needed by the five metrics named above.

## Amendment 2026-09-23: preserve colliding object keys

**Status:** Accepted (PR #121). Policy `3.1.1`.

Policy `3.1.1` preserves entries when different object keys scrub to the same
string. For example, two email-bearing file paths can both become
`/src/[EMAIL]/cart.cjs`; overwriting either value loses an observed file change.

The first entry keeps the scrubbed key. Later entries receive `[key-2]`,
`[key-3]`, etc., before the final filename extension when present, including
compound extensions from the existing vocabulary. All scrubbed input keys are
reserved first, so a generated key cannot overwrite a literal suffix-shaped
key. Nested objects use independent counters. JSON keys such as `__proto__`
remain own data properties. Values still use the original key for secret-label
and path-field rules.

These suffixes are record-local disambiguators allocated in source entry order,
not persistent file identities or additional hashes of sensitive text. They can
change when the entries or their order change. Consumers must not infer identity
across records from a suffix. Existing noncolliding keys, value redaction and
path hashing stay unchanged. The fix cannot recover entries already discarded
by earlier sanitization. Sibling sanitizers pin this policy by upstream commit;
refresh the pin to the merged commit.
