// Run: node --test test/transcript-delta.test.js
//
// Pure-core coverage for the uuid-cursor delta upload, plus a few real-tmpdir
// round-trips for the transfer.js chunk/cursor persistence. Follows the repo's
// no-mock convention: pure functions on plain objects + throwaway temp dirs.

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeTempDir, setTestEnv, writeFile } = require("../testing/helpers");

// transfer.js reads its dirs from CLAUDE_PLUGIN_DATA at require time, so point
// it at a throwaway dir BEFORE requiring it.
const DATA_DIR = makeTempDir("skm-delta-");
const STATE_DIR = makeTempDir("skm-delta-state-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("SKILLMETER_TRANSCRIPT_CHUNK_MAX_BYTES", undefined);

const d = require("../skillmeter/scripts/lib/transcript-delta");
const transfer = require("../skillmeter/scripts/lib/transfer");
const {
  isChunkEligible,
  quarantinePathFor,
  recordUploadFailure,
} = require("../skillmeter/scripts/lib/chunk-retry");

const SALT = "deadbeefcafe";
const TEST_REPOSITORY = {
  repoKey: "github.com/skillbench-ai/example",
  org: "skillbench-ai",
};

// ---- helpers ---------------------------------------------------------------
function content(uuid, parentUuid = null, text = "hi") {
  return { type: "assistant", uuid, parentUuid, message: { content: text } };
}
function meta(type = "mode") {
  return { type }; // metadata lines have no uuid
}
function toJsonl(objs) {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

// ---- parseJsonl ------------------------------------------------------------
test("parseJsonl: parses valid lines, skips blanks", () => {
  const raw = toJsonl([content("a"), content("b")]);
  const { objs, malformed } = d.parseJsonl(raw);
  assert.equal(objs.length, 2);
  assert.equal(malformed, 0);
  assert.equal(objs[0].uuid, "a");
});

test("parseJsonl: trailing partial line counts as malformed, earlier lines intact", () => {
  const raw = JSON.stringify(content("a")) + "\n" + '{"type":"assistant","uuid":"b"'; // truncated
  const { objs, malformed } = d.parseJsonl(raw);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].uuid, "a");
  assert.equal(malformed, 1);
});

test("parseJsonl: mid-file malformed line is skipped, not fatal", () => {
  const raw = JSON.stringify(content("a")) + "\n" + "{bad json}\n" + JSON.stringify(content("c")) + "\n";
  const { objs, malformed } = d.parseJsonl(raw);
  assert.deepEqual(objs.map((o) => o.uuid), ["a", "c"]);
  assert.equal(malformed, 1);
});

// ---- lastContentUuid -------------------------------------------------------
test("lastContentUuid: returns newest uuid", () => {
  assert.equal(d.lastContentUuid([content("a"), content("b"), content("c")]), "c");
});

test("lastContentUuid: skips trailing metadata lines", () => {
  assert.equal(d.lastContentUuid([content("a"), meta("mode"), meta("permission-mode")]), "a");
});

test("lastContentUuid: null when no content line", () => {
  assert.equal(d.lastContentUuid([meta("mode"), meta("last-prompt")]), null);
});

// ---- computeDelta ----------------------------------------------------------
test("computeDelta: no cursor -> full, no reset", () => {
  assert.deepEqual(d.computeDelta([content("a")], null), { startIndex: 0, reset: false });
});

test("computeDelta: known cursor uuid -> slice after it", () => {
  const objs = [content("a"), content("b"), content("c")];
  assert.deepEqual(d.computeDelta(objs, { lastUuid: "b" }), { startIndex: 2, reset: false });
});

test("computeDelta: unknown cursor uuid -> reset from 0", () => {
  const objs = [content("a"), content("b")];
  assert.deepEqual(d.computeDelta(objs, { lastUuid: "gone" }), { startIndex: 0, reset: true });
});

// ---- splitLinesByBudget ----------------------------------------------------
test("splitLinesByBudget: groups within budget, no line loss", () => {
  const lines = ["aaaa", "bbbb", "cccc"]; // 5 bytes each incl newline
  const groups = d.splitLinesByBudget(lines, 10); // 2 lines per group
  assert.deepEqual(groups, [["aaaa", "bbbb"], ["cccc"]]);
  assert.ok(
    groups.every((group) => Buffer.byteLength(group.join("\n") + "\n") <= 10),
    "every multi-line group stays within the byte budget"
  );
});

test("splitLinesByBudget: a single over-budget line is its own group (never dropped)", () => {
  const big = "x".repeat(100);
  const groups = d.splitLinesByBudget(["aa", big, "bb"], 10);
  assert.deepEqual(groups.flat(), ["aa", big, "bb"]);
  assert.ok(groups.some((g) => g.length === 1 && g[0] === big));
});

// ---- buildChunkPlan --------------------------------------------------------
test("buildChunkPlan: fresh (no cursor) -> one chunk, all lines, anchor=last uuid", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, null, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 2);
  assert.equal(plan.chunks[0].seq, 1);
  assert.equal(plan.chunks[0].reset, false);
  assert.deepEqual(plan.newCursor, { lastUuid: "b", seq: 1 });
});

test("buildChunkPlan: continuation sends only new lines with continued seq", () => {
  const objs = [content("a"), content("b"), content("c")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "a", seq: 1 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 2); // b, c
  assert.equal(plan.chunks[0].seq, 2);
  assert.deepEqual(plan.newCursor, { lastUuid: "c", seq: 2 });
});

test("buildChunkPlan: empty delta -> no chunks, null cursor (no-op)", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "b", seq: 3 }, SALT);
  assert.deepEqual(plan.chunks, []);
  assert.equal(plan.newCursor, null);
});

test("buildChunkPlan: reset (cursor uuid gone) -> full resend with reset+baseline", () => {
  const objs = [content("a"), content("b")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "gone", seq: 5 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].reset, true);
  assert.equal(plan.chunks[0].resetBaselineSeq, 6); // seqStart(5)+1
  assert.equal(plan.chunks[0].seq, 6);
});

test("buildChunkPlan: metadata-only tail keeps the previous content anchor", () => {
  const objs = [content("a"), meta("mode")];
  const plan = d.buildChunkPlan(objs, { lastUuid: "a", seq: 1 }, SALT);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].lines.length, 1); // the metadata line
  assert.equal(plan.newCursor.lastUuid, "a"); // anchor unchanged
  assert.equal(plan.newCursor.seq, 2);
});

test("buildChunkPlan: sanitization is applied per line (email redacted)", () => {
  const objs = [content("a", null, "mail me@x.com please")];
  const plan = d.buildChunkPlan(objs, null, SALT);
  const line = plan.chunks[0].lines[0];
  assert.ok(!line.includes("me@x.com"), "raw email must be gone");
  assert.ok(line.includes("[EMAIL]"), "redaction placeholder present");
});

test("buildChunkPlan: split produces consecutive seqs sharing reset baseline", () => {
  const objs = [content("a"), content("b"), content("c")];
  // tiny budget -> one line per chunk
  const plan = d.buildChunkPlan(objs, { lastUuid: "gone", seq: 0 }, SALT, { maxUncompressedBytes: 5 });
  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((c) => c.seq), [1, 2, 3]);
  assert.ok(plan.chunks.every((c) => c.reset === true && c.resetBaselineSeq === 1));
  assert.equal(plan.newCursor.seq, 3);
});

// ---- transfer.buildChunkHeaders (pure) -------------------------------------
test("buildChunkHeaders: reset carries baseline; non-reset sends 0", () => {
  const reset = transfer.buildChunkHeaders(
    { transcriptId: "s.jsonl", seq: 6, reset: true, resetBaselineSeq: 6, promptId: "p1" },
    "dev1",
    "tok"
  );
  assert.equal(reset["X-Chunk-Reset"], "6");
  assert.equal(reset["X-Chunk-Seq"], "6");
  assert.equal(reset["X-Prompt-ID"], "p1");
  assert.equal(reset["Authorization"], "Bearer tok");

  const plain = transfer.buildChunkHeaders(
    { transcriptId: "s.jsonl", seq: 2, reset: false, resetBaselineSeq: null },
    "dev1",
    "tok"
  );
  assert.equal(plain["X-Chunk-Reset"], "0");
  assert.equal(plain["X-Prompt-ID"], undefined, "prompt id omitted when absent");

  const idempotent = transfer.buildChunkHeaders(
    {
      transcriptId: "s.jsonl",
      seq: 3,
      reset: false,
      repoKey: TEST_REPOSITORY.repoKey,
    },
    "dev1",
    "tok",
    Buffer.from("{}\n")
  );
  assert.match(idempotent["X-Idempotency-Key"], /^[0-9a-f]{64}$/);
});

// ---- transfer cursor + chunk fs round-trips --------------------------------
test("writeCursor/readCursor round-trip", () => {
  const c = { transcriptId: "round.jsonl", lastUuid: "u9", seq: 4, updatedAt: 123 };
  transfer.writeCursor(c, TEST_REPOSITORY);
  assert.deepEqual(transfer.readCursor("round.jsonl", TEST_REPOSITORY), c);
  assert.equal(transfer.readCursor("missing.jsonl", TEST_REPOSITORY), null);
});

// Blocks far smaller than a record make every record cross a block edge.
test("transcriptTailUuid: newest uuid across block edges, past a partial line and metadata", () => {
  const file = path.join(DATA_DIR, "tail.jsonl");
  writeFile(file, [
    JSON.stringify({ uuid: "older", message: { content: "été ".repeat(40) } }),
    JSON.stringify({ uuid: "newest", message: { content: "naïve ".repeat(40) } }),
    JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
    '{"uuid":"unfinished","message":',
  ].join("\n"));
  for (const blockBytes of [7, 100, 64 * 1024]) {
    assert.equal(transfer.transcriptTailUuid(file, blockBytes), "newest", `blocks of ${blockBytes}`);
  }
});

test("transcriptTailUuid: empty without a uuid or a file", () => {
  const file = path.join(DATA_DIR, "no-uuid.jsonl");
  writeFile(file, JSON.stringify({ type: "permission-mode" }) + "\n");
  assert.equal(transfer.transcriptTailUuid(file, 5), "");
  assert.equal(transfer.transcriptTailUuid(path.join(DATA_DIR, "absent.jsonl")), "");
});

test("a signed-out mark ages out unless a cursor for its transcript remains", () => {
  const marks = path.join(DATA_DIR, "logs", "unlicensed-transcripts");
  for (const name of ["old.jsonl", "recent.jsonl", "old-cursored.jsonl", "old-cursored-elsewhere.jsonl"]) {
    const file = path.join(DATA_DIR, name);
    writeFile(file, JSON.stringify({ uuid: name }) + "\n");
    assert.equal(transfer.markUnlicensedTranscript(file), true);
  }
  // Cursors in two repositories: whichever is listed first, both count.
  transfer.writeCursor({ transcriptId: "old-cursored.jsonl", lastUuid: "u", seq: 1, updatedAt: 0 }, TEST_REPOSITORY);
  transfer.writeCursor({ transcriptId: "old-cursored-elsewhere.jsonl", lastUuid: "u", seq: 1, updatedAt: 0 },
    { repoKey: "github.com/skillbench-ai/elsewhere", org: "skillbench-ai" });
  const monthAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
  for (const name of ["old.jsonl.json", "old-cursored.jsonl.json", "old-cursored-elsewhere.jsonl.json"]) {
    fs.utimesSync(path.join(marks, name), monthAgo, monthAgo);
  }
  transfer.cleanupStaleFiles();
  // A cursor for the transcript can still be behind the mark.
  assert.deepEqual(fs.readdirSync(marks).sort(),
    ["old-cursored-elsewhere.jsonl.json", "old-cursored.jsonl.json", "recent.jsonl.json"]);
});

// ---- boundaries that could not be written where staging reads them --------
const credstore = require("../skillmeter/scripts/credstore");
const { repositoryStorageId } = require("../skillmeter/scripts/lib/paths");
const PENDING_REPOSITORY = { repoKey: "github.com/skillbench-ai/pending", org: "skillbench-ai" };
const OTHER_PENDING_REPOSITORY = { repoKey: "github.com/skillbench-ai/pending-other", org: "skillbench-ai" };

// Let the clock move, so a boundary written next is later than the last.
function tick() {
  const until = Date.now() + 2;
  while (Date.now() < until) {}
}

// Run `fn` while `dir` is replaced by a file, as a stale file or failing disk
// would leave it, then put the directory back.
function withBlocked(dir, fn) {
  const saved = `${dir}.saved`;
  const existed = fs.existsSync(dir);
  if (existed) fs.renameSync(dir, saved);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "");
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { force: true });
    if (existed) fs.renameSync(saved, dir);
  }
}

function unreadable(file, fn) {
  fs.chmodSync(file, 0o200);
  try {
    return fn();
  } finally {
    fs.chmodSync(file, 0o600);
  }
}

// The uuids `stageTranscriptDelta` seals for this repository.
function stagedUuids(file, repository) {
  const before = new Set(transfer.listDeltaChunks());
  transfer.stageTranscriptDelta(file, "prompt", "device", repository);
  return transfer.listDeltaChunks().filter((chunk) => !before.has(chunk))
    .flatMap((chunk) => fs.readFileSync(chunk, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).uuid));
}

test("closing a period tells nothing to close from a failure", () => {
  const file = path.join(DATA_DIR, "close.jsonl");
  writeFile(file, toJsonl([content("c1")]));
  unreadable(file, () => {
    assert.equal(transfer.transcriptTailUuid(file), null, "unreadable");
    assert.equal(transfer.markUnlicensedTranscript(file), null);
    assert.equal(transfer.advanceCursorToTranscriptTail(file, PENDING_REPOSITORY), null);
  });
  withBlocked(path.join(DATA_DIR, "logs", "unlicensed-transcripts"), () => {
    assert.equal(transfer.markUnlicensedTranscript(file), null, "the mark cannot be written");
  });
  const cursors = path.join(DATA_DIR, "logs", "repositories",
    repositoryStorageId(PENDING_REPOSITORY.repoKey, credstore.getOrCreateHashSalt()), "transcripts", "cursors");
  withBlocked(cursors, () => {
    assert.equal(transfer.advanceCursorToTranscriptTail(file, PENDING_REPOSITORY), null, "the cursor cannot be written");
  });

  const absent = path.join(DATA_DIR, "close-absent.jsonl");
  assert.equal(transfer.markUnlicensedTranscript(absent), false, "nothing written yet");
  assert.equal(transfer.advanceCursorToTranscriptTail(absent, PENDING_REPOSITORY), false);
});

test("recordPendingBoundary: the scope, the newest record when readable, privately", () => {
  const file = path.join(DATA_DIR, "pending-record.jsonl");
  writeFile(file, toJsonl([content("r1"), content("r2")]));
  assert.equal(transfer.recordPendingBoundary(file, null), true);
  assert.equal(transfer.recordPendingBoundary(file, PENDING_REPOSITORY), true);
  unreadable(file, () => assert.equal(transfer.recordPendingBoundary(file, null), true));

  const store = path.join(DATA_DIR, "logs", "transcript-boundaries", "pending-record.jsonl.ndjson");
  const raw = fs.readFileSync(store, "utf8");
  const entries = raw.split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(entries.map((e) => [e.scope, e.lastUuid]), [
    ["*", "r2"],
    [repositoryStorageId(PENDING_REPOSITORY.repoKey, credstore.getOrCreateHashSalt()), "r2"],
    ["*", undefined],
  ]);
  assert.ok(entries.every((e) => typeof e.at === "number"));
  assert.doesNotMatch(raw, /skillbench-ai/, "no repository name");
  assert.equal(fs.statSync(path.dirname(store)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);

  // A line a crash left partial does not swallow the next boundary.
  fs.appendFileSync(store, '{"scope":"*","at":1,"last');
  assert.equal(transfer.recordPendingBoundary(file, null), true);
  const readable = fs.readFileSync(store, "utf8").split("\n").filter(Boolean)
    .filter((line) => { try { JSON.parse(line); return true; } catch { return false; } });
  assert.equal(readable.length, 4);

  const absent = path.join(DATA_DIR, "pending-absent.jsonl");
  assert.equal(transfer.recordPendingBoundary(absent, null), true, "nothing to protect");
  assert.equal(fs.existsSync(path.join(path.dirname(store), "pending-absent.jsonl.ndjson")), false);
});

test("staging starts after a pending boundary, and holds on one without a position until it closes the period", () => {
  const file = path.join(DATA_DIR, "pending-stage.jsonl");
  writeFile(file, toJsonl([content("a1"), content("a2")]));
  transfer.recordPendingBoundary(file, null);
  fs.appendFileSync(file, toJsonl([content("b1")]));
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), ["b1"], "after the boundary, nothing lost");

  fs.appendFileSync(file, toJsonl([content("c1")]));
  unreadable(file, () => transfer.recordPendingBoundary(file, PENDING_REPOSITORY));
  fs.appendFileSync(file, toJsonl([content("c2")]));
  tick();
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), [], "nothing while the period has no end");
  const closed = transfer.readCursor("pending-stage.jsonl", PENDING_REPOSITORY);
  assert.equal(closed.lastUuid, "c2", "closed at the tail");
  assert.equal(closed.discarded, true);

  fs.appendFileSync(file, toJsonl([content("d1")]));
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), ["d1"], "then staging continues");
});

test("a pending boundary of another repository does not hold this one", () => {
  const file = path.join(DATA_DIR, "pending-scope.jsonl");
  writeFile(file, toJsonl([content("s1")]));
  unreadable(file, () => transfer.recordPendingBoundary(file, PENDING_REPOSITORY));
  tick();
  assert.deepEqual(stagedUuids(file, OTHER_PENDING_REPOSITORY), ["s1"]);
});

test("an unreadable signed-out mark holds staging until the period is closed", () => {
  const file = path.join(DATA_DIR, "corrupt-mark.jsonl");
  writeFile(file, toJsonl([content("m1")]));
  writeFile(path.join(DATA_DIR, "logs", "unlicensed-transcripts", "corrupt-mark.jsonl.json"), "{not json");
  fs.appendFileSync(file, toJsonl([content("m2")]));
  tick();
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), []);
  fs.appendFileSync(file, toJsonl([content("m3")]));
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), ["m3"]);
});

test("an unreadable cursor holds staging until the period is closed", () => {
  const file = path.join(DATA_DIR, "corrupt-cursor.jsonl");
  writeFile(file, toJsonl([content("k1")]));
  const cursor = path.join(DATA_DIR, "logs", "repositories",
    repositoryStorageId(PENDING_REPOSITORY.repoKey, credstore.getOrCreateHashSalt()),
    "transcripts", "cursors", "corrupt-cursor.jsonl.json");
  writeFile(cursor, "{not json");
  fs.appendFileSync(file, toJsonl([content("k2")]));
  tick();
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), []);
  fs.appendFileSync(file, toJsonl([content("k3")]));
  assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), ["k3"]);
});

test("an unreadable pending store holds staging until the period is closed", () => {
  const file = path.join(DATA_DIR, "locked-pending.jsonl");
  writeFile(file, toJsonl([content("l1")]));
  transfer.recordPendingBoundary(file, null);
  const store = path.join(DATA_DIR, "logs", "transcript-boundaries", "locked-pending.jsonl.ndjson");
  fs.appendFileSync(file, toJsonl([content("l2")]));
  fs.chmodSync(store, 0o000);
  try {
    tick();
    assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), []);
    fs.appendFileSync(file, toJsonl([content("l3")]));
    assert.deepEqual(stagedUuids(file, PENDING_REPOSITORY), ["l3"]);
  } finally {
    fs.chmodSync(store, 0o600);
  }
});

test("a pending boundary ages out unless a cursor for its transcript remains", () => {
  const dir = path.join(DATA_DIR, "logs", "transcript-boundaries");
  for (const name of ["pending-old", "pending-kept"]) {
    const file = path.join(DATA_DIR, `${name}.jsonl`);
    writeFile(file, toJsonl([content(name)]));
    transfer.recordPendingBoundary(file, null);
  }
  transfer.writeCursor({ transcriptId: "pending-kept.jsonl", lastUuid: "u", seq: 1, updatedAt: 0 }, TEST_REPOSITORY);
  const monthAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
  for (const name of ["pending-old", "pending-kept"]) {
    fs.utimesSync(path.join(dir, `${name}.jsonl.ndjson`), monthAgo, monthAgo);
  }
  transfer.cleanupStaleFiles();
  const left = fs.readdirSync(dir);
  assert.equal(left.includes("pending-old.jsonl.ndjson"), false);
  assert.equal(left.includes("pending-kept.jsonl.ndjson"), true);
});

test("sealDeltaChunk writes body+meta and listDeltaChunks finds it", () => {
  const before = transfer.listDeltaChunks().length;
  const body = transfer.sealDeltaChunk("seal.jsonl", ['{"uuid":"a"}'], {
    seq: 1,
    reset: false,
    resetBaselineSeq: null,
    promptId: "p",
  }, TEST_REPOSITORY);
  assert.ok(body && fs.existsSync(body), "body written");
  assert.ok(fs.existsSync(body.replace(/\.jsonl$/, ".meta.json")), "meta sidecar written");
  assert.equal(transfer.listDeltaChunks().length, before + 1);
});

test("listDeltaChunks excludes a body without a meta sidecar", () => {
  // Seal an anchor chunk first so the queue directory exists regardless of
  // which tests ran before this one.
  const anchor = transfer.sealDeltaChunk("orphan-anchor.jsonl", ['{"uuid":"o"}'], {
    seq: 1,
    reset: false,
    resetBaselineSeq: null,
    promptId: "p",
  }, TEST_REPOSITORY);
  assert.ok(anchor, "anchor chunk sealed");
  const context = transfer
    .listRepositoryQueueContexts()
    .find((c) => path.resolve(c.chunks) === path.resolve(path.dirname(anchor)));
  assert.ok(context, "anchor's queue context resolved");
  const orphan = path.join(context.chunks, "9999999999-1.jsonl");
  writeFile(orphan, "{}\n"); // no sibling .meta.json
  const listed = transfer.listDeltaChunks();
  assert.ok(listed.includes(anchor), "sealed anchor is listed");
  assert.ok(!listed.includes(orphan), "orphan body not listed");
});

// A chunk the backend rejects every time spends its retry budget and is renamed
// aside. This is the durable half of that: once renamed, no drain can pick it
// up again, and both files are still on disk to be restored by hand.
test("a quarantined chunk pair is invisible to the drain but still on disk", () => {
  const body = transfer.sealDeltaChunk("poison.jsonl", ['{"uuid":"z"}'], {
    seq: 9,
    reset: false,
    resetBaselineSeq: null,
    promptId: "backfill",
  }, TEST_REPOSITORY);
  const metaPath = body.replace(/\.jsonl$/, ".meta.json");
  assert.ok(transfer.listDeltaChunks().includes(body), "listed before quarantine");

  const quarantinedBody = quarantinePathFor(body);
  const quarantinedMeta = quarantinePathFor(metaPath);
  fs.renameSync(metaPath, quarantinedMeta);
  fs.renameSync(body, quarantinedBody);

  const listed = transfer.listDeltaChunks();
  assert.ok(!listed.includes(body), "the original path is gone");
  assert.ok(
    !listed.some((file) => file.endsWith(".quarantined")),
    "and the renamed body is not listed either"
  );
  assert.ok(fs.existsSync(quarantinedBody), "body kept, not deleted");
  assert.ok(fs.existsSync(quarantinedMeta), "meta kept, not deleted");
});

// The budget is shared through the meta sidecar, so a chunk that failed
// recently is skipped by whichever drain runs next instead of being re-sent at
// the rate drains happen to be spawned. The drain filters on exactly this
// predicate, while listDeltaChunks keeps counting the chunk so the retry
// daemon's progress check still sees the work as outstanding.
test("a chunk still inside its backoff window is not eligible, but is still queued", () => {
  const body = transfer.sealDeltaChunk("backoff.jsonl", ['{"uuid":"y"}'], {
    seq: 4,
    reset: false,
    resetBaselineSeq: null,
    promptId: "backfill",
  }, TEST_REPOSITORY);
  const metaPath = body.replace(/\.jsonl$/, ".meta.json");
  const now = Date.now();
  const failed = recordUploadFailure(
    JSON.parse(fs.readFileSync(metaPath, "utf8")),
    { now, error: "HTTP 500" }
  );
  writeFile(metaPath, JSON.stringify(failed));

  const stored = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(stored.uploadAttempts, 1, "the attempt is durable across drains");
  assert.equal(stored.seq, 4, "and the original meta survives the update");
  assert.equal(isChunkEligible(stored, now), false, "skipped by the next drain");
  assert.equal(
    isChunkEligible(stored, stored.nextAttemptAt),
    true,
    "and picked up again once the window passes"
  );
  assert.ok(
    transfer.listDeltaChunks().includes(body),
    "still counted as queued work while it waits"
  );
});
