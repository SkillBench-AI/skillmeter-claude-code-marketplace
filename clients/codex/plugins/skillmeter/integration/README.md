# Transcript transport and local verification

Run `npm run check` from the repo root for plugin-only checks. They cover chunk
headers, scope/consent, auth containment, response loss, concurrent drains and
SIGKILL recovery. No collector or pipeline deployment is required.

## Consent record

The consent store is Codex's own record in `~/.skillbench/clients/codex/`. It
requires an expected revision and explicit acknowledgement before writing ON.
`consent-set` writes through it, and the capture and delivery gates and
`consent-preview` read through its strict `readPolicy`. The unit suite covers
concurrent confirmations, stale revisions and I/O failures.

Codex refuses invalid or unsupported records and record symlinks instead of
rewriting them. It does not reclaim an old lock by age, so an interrupted writer
may require explicit lock recovery.

## Optional cross-repository contract

Run with the pipeline's locked Python 3.14 environment (`moto[s3]`, boto3 and
skillbench-preprocessor installed), Node >=20, and collector Go 1.25.5 dependencies.
No Docker or real credentials are needed. The runner binds loopback ports only.

From the collector checkout, build the helper using the current collector source:

```sh
go build -o /tmp/skillbench-collector-bridge /path/to/plugin/plugins/skillmeter/integration/collector_bridge.go
```

From the plugin checkout:

```sh
/path/to/pipelines/.venv/bin/python plugins/skillmeter/integration/run_contract.py \
  --bridge /tmp/skillbench-collector-bridge \
  --pipeline /path/to/pipelines --out /tmp/contract-evidence.json
```

The uploader sends gzip chunks through the collector handler and storage code
into a local S3 emulator. Checks cover lost-response retries, append ordering,
midnight and multi-day resumes, baseline resets, stale generations and stored
bytes. Expected records and redaction checks are independent of the uploader.

`--pipeline` uses the larger Codex fixture, scripted analyzer responses and the
report schema validator. Omit it for parser/transport checks. Multi-day recovery
requires collector missing-baseline support.

The adapter omits API Gateway JWT verification. It does not exercise real
credentials, installed hooks, live storage, model services or a dashboard.
Fixture state is temporary; `--out` contains test results without transcript text.

Measure capture cost without network or credentials:

```sh
node plugins/skillmeter/integration/measure_capture.cjs
```

This creates and removes a synthetic 64 MiB source. It reports bytes read and
warm-cache elapsed time for unchanged and appended captures. It is an observation,
not a platform-independent performance threshold; prefix verification remains
linear in source size.

## Queue and recovery

Capture hints live in `logs/transcripts/captures-v1/`. Immutable gzip chunks,
transaction manifests and raw-byte cursors live in `logs/transcripts/chunks-v1/`.
Transactions publish chunks before advancing the cursor; restart recovery finishes
published transactions. Rewrites start a higher reset generation. Transport UUIDs
use raw position/content to preserve distinct records that sanitize identically.

Chunks budget gzip/base64 bytes below 5 MiB including a 128 KiB envelope reserve;
decoded records must remain below 32 MiB. Malformed/oversized input retains the
source and cursor with a content-free diagnostic. Failed chunks and superseded
reset generations are retained; historical transcripts are not replayed automatically.

### Compaction context references

`compacted` records can contain copies of earlier conversation history large
enough to exceed the wire budget. Within `replacement_history` and
`guardian_history`, the producer can replace an exact earlier match with
`{type: "skillmeter_compaction_reference", source_uuid, pointer}`. `pointer`
is a JSON Pointer into an earlier record in the same source/reset generation.
Array positions, unmatched entries, timestamps and other compaction metadata
remain intact. `_codex_compaction_projection.version = 1` records each field's
entry count, referenced entry count and compact JSON-serialized entry bytes
represented by references (before sanitization, excluding source whitespace). Byte counts are accounting, not claims about analyzed coverage.

Matching uses a salted canonical-content digest before sanitization. Only
earlier eligible `response_item.payload` or compaction-history entries are
targets; excluded intervals are never decoded or indexed. The temporary index
is bounded to 50,000 entries. Eviction or a missing match preserves full content.
The source file is unchanged. Retry and crash recovery use the ordinary chunk
transaction and raw-position identities.

This changes compaction context representation, not authored message/tool
records. Consumers that need compaction context must resolve references against
the composed session, preserving unresolved references as incomplete context.
The current analysis reader ignores compaction context; it still receives the
original authored records. Multi-object composition remains required. Do not
interpret a projected compaction as proof all source objects were stored or
analyzed. Oversized unmatched/authored records still hold capture explicitly;
fragmentation needs a separate producer/reader contract before release.

Queues created with an earlier owner-identity formula remain preserved but may
not be eligible for delivery. Never edit their owner fields to force migration;
select still-authorized source files for explicit recovery instead.

Read-only inventory (from the plugin directory):

```sh
PLUGIN_DATA=/path/to/plugin-data node scripts/transcript_inventory.js
```

Capture and delivery have separate content-free `capture-status.json` and
`delivery-status.json` records per source queue. They retain the latest failure,
active failure, attempt identity, last successful attempt and last progress.
Capture reports observed raw source bytes and the committed raw cursor; delivery
records the last HTTP-acknowledged sequence/baseline. These byte positions do not
measure eligible content, and HTTP acceptance does not prove stored completeness.

`telemetry.js status --details` includes capture blockage even with zero pending chunks.
Successful staging resolves only the capture error; a delivery error remains
until delivery succeeds, and the converse also holds. Legacy diagnostics remain
visible until the corresponding phase succeeds. Observations can be stale, and
sources that never reached the queue are outside this inventory. Event delivery,
source discovery, analysis and report acceptance need separate evidence.

Uploads send `X-Transcript-Protocol: chunks-v1`. The on-disk `chunks-v1/`
queue format is separate from this header. Missing-baseline recovery requires
the collector to return 409 for an append without a baseline; the client then
sends a full reset. Without that support, multi-day resumes may produce partial
snapshots.

Rollback: pause telemetry and retain the plugin data directory. The old client
cannot read `chunks-v1`; do not relabel chunks as legacy snapshots or run old
cleanup against them. Resume with a compatible client or select still-authorized
sources for explicit recovery. Verify installed-client behavior, storage and
report correctness separately from these local tests.

## Stored-record reconciliation

Use the [selected transcript integrity check](TRANSCRIPT-INTEGRITY.md) to compare
expected sanitized records with approved stored objects using content-free
receipts. This is a record-set gate; it does not establish full-source coverage
or weekly-report acceptance.
