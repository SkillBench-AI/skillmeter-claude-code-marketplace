# Selected transcript record integrity

This offline check compares an expected sanitized record set with records read
back from storage. It detects missing, unexpected, changed or conflicting
records. Exact duplicates across storage objects do not inflate coverage.
It does not read credentials, access a network, modify a queue or publish a report.

Create receipts from newline-terminated, sanitized Codex JSONL with transport
UUIDs, then compare them:

```sh
node plugins/skillmeter/integration/transcript_integrity.cjs receipt expected.jsonl > expected-receipt.json
node plugins/skillmeter/integration/transcript_integrity.cjs receipt object-a.jsonl object-b.jsonl > stored-receipt.json
node plugins/skillmeter/integration/transcript_integrity.cjs compare expected-receipt.json stored-receipt.json
```

Use `receipt -` to stream one approved input through stdin. Receipts contain
input hashes, byte counts, record identity/content hashes and error counts, never
message/tool text or input paths. Treat receipts as internal evidence: they still
reveal record counts and allow correlation. The collector's salted transport
UUID is included in each content hash. Use only explicitly scoped inputs; this
command does not discover or authorize transcript sources.

Exit codes: 0 means the receipt was produced without record errors, or the
selected nonempty record sets match; 1 means a record-integrity failure;
2 means invalid arguments, unreadable evidence or malformed receipt schema.
A zero exit from `receipt` alone is not comparison success. Empty sets cannot
pass `compare`. Malformed JSON/UTF-8, missing identity, records over 32 MiB and
incomplete final lines block comparison. Hashes use canonical JSON, so object-key
ordering does not create false differences. Array ordering and record values
remain significant. Record order across objects is not checked.

Blank lines and whitespace-only identities are invalid. Numeric tokens must
round-trip through `JSON.stringify(Number(token))` unchanged, and integer values
must be safe integers. Other forms (including `1.0`, `-0`, overflowing exponents
and excessively precise values) count as malformed for this restricted checker.
This conservative boundary prevents numeric rounding from hiding changed records.

## Evidence boundary

The expected set must be independently derived from the source/capture contract,
not copied from the observed data. Pin the producer revision, sanitizer version,
source snapshot, consent scope and reset generation in the surrounding candidate
manifest. A changed sanitizer, stale generation or incorrectly selected object
set can cause a mismatch; do not reinterpret that automatically as lost data.
The checker does not authenticate receipts or establish their provenance.

A pass establishes equality only for the selected record sets. In particular,
reconstructing records through a frozen local cursor can match storage while
capture remains stalled beyond that cursor. A separate eligible-source inventory
and capture-progress gate must establish the complete denominator. A source that
never generated a cursor must remain visible as unknown, not disappear from it.

Normalization, record ordering, tool linkage across composed sessions, original
event-time week membership, analysis coverage, model validity, backend persistence
and correct-user dashboard delivery require separate gates. Do not promote this
check's `pass` to overall end-to-end acceptance.

Tests run under the existing Node test suite. Run the command explicitly when
collecting selected-record evidence; it is not a production publication gate.
