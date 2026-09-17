// Run: node --test skillmeter/test/chunk-retry.test.js
//
// Pure-core coverage for the per-chunk upload retry budget: the thing that
// stops a chunk the backend rejects every time from being re-uploaded forever.
// Follows the repo's no-mock convention: pure functions on plain objects.

const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../testing/bootstrap");

const {
  MAX_UPLOAD_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  isChunkEligible,
  isChunkExhausted,
  quarantinePathFor,
  recordUploadFailure,
  retryDelayMs,
} = require("../scripts/lib/chunk-retry");

// ---- retryDelayMs ----------------------------------------------------------
test("retryDelayMs: doubles per attempt from the base, capped", () => {
  assert.equal(retryDelayMs(1), RETRY_BASE_MS);
  assert.equal(retryDelayMs(2), RETRY_BASE_MS * 2);
  assert.equal(retryDelayMs(3), RETRY_BASE_MS * 4);
  assert.equal(retryDelayMs(99), RETRY_CAP_MS);
});

test("retryDelayMs: a missing or absurd attempt count still yields the base", () => {
  assert.equal(retryDelayMs(0), RETRY_BASE_MS);
  assert.equal(retryDelayMs(-4), RETRY_BASE_MS);
  assert.equal(retryDelayMs(undefined), RETRY_BASE_MS);
});

// ---- recordUploadFailure ---------------------------------------------------
test("recordUploadFailure: counts the attempt and schedules the next one", () => {
  const first = recordUploadFailure({ seq: 3 }, { now: 1_000, error: "HTTP 500" });
  assert.equal(first.seq, 3, "unrelated meta fields survive");
  assert.equal(first.uploadAttempts, 1);
  assert.equal(first.lastUploadError, "HTTP 500");
  assert.equal(first.nextAttemptAt, 1_000 + RETRY_BASE_MS);

  const second = recordUploadFailure(first, { now: 2_000, error: "HTTP 500" });
  assert.equal(second.uploadAttempts, 2);
  assert.equal(second.nextAttemptAt, 2_000 + RETRY_BASE_MS * 2);
});

test("recordUploadFailure: does not mutate the meta it is given", () => {
  const original = { seq: 1, uploadAttempts: 2 };
  recordUploadFailure(original, { now: 10, error: "HTTP 500" });
  assert.equal(original.uploadAttempts, 2);
  assert.equal(original.nextAttemptAt, undefined);
});

// ---- isChunkEligible -------------------------------------------------------
test("isChunkEligible: a never-tried chunk is eligible immediately", () => {
  assert.equal(isChunkEligible({ seq: 1 }, 0), true);
  assert.equal(isChunkEligible(null, 0), true);
});

test("isChunkEligible: a failed chunk waits out its backoff window", () => {
  const meta = recordUploadFailure({}, { now: 1_000, error: "HTTP 500" });
  assert.equal(isChunkEligible(meta, 1_000), false);
  assert.equal(isChunkEligible(meta, 1_000 + RETRY_BASE_MS - 1), false);
  assert.equal(isChunkEligible(meta, 1_000 + RETRY_BASE_MS), true);
});

test("isChunkEligible: a clock that jumped backwards does not strand a chunk", () => {
  const meta = { nextAttemptAt: Number.MAX_SAFE_INTEGER };
  assert.equal(isChunkEligible(meta, 0), false);
  assert.equal(isChunkEligible({ nextAttemptAt: "soon" }, 0), true);
});

// ---- isChunkExhausted ------------------------------------------------------
test("isChunkExhausted: true only once the budget is spent", () => {
  assert.equal(isChunkExhausted({}), false);
  assert.equal(
    isChunkExhausted({ uploadAttempts: MAX_UPLOAD_ATTEMPTS - 1 }),
    false
  );
  assert.equal(isChunkExhausted({ uploadAttempts: MAX_UPLOAD_ATTEMPTS }), true);
  assert.equal(
    isChunkExhausted({ uploadAttempts: MAX_UPLOAD_ATTEMPTS + 5 }),
    true
  );
});

test("a chunk rejected the same way every time is given up on, not retried forever", () => {
  let meta = {};
  let attempts = 0;
  let now = 0;
  while (!isChunkExhausted(meta) && attempts < 1_000) {
    now = meta.nextAttemptAt || now;
    meta = recordUploadFailure(meta, { now, error: "HTTP 500" });
    attempts++;
  }
  assert.equal(attempts, MAX_UPLOAD_ATTEMPTS);
  assert.ok(isChunkExhausted(meta), "budget is spent, chunk is set aside");
});

// ---- quarantinePathFor -----------------------------------------------------
test("quarantinePathFor: sets a chunk aside where the drain no longer lists it", () => {
  assert.equal(
    quarantinePathFor("/q/chunks/1-2.jsonl"),
    "/q/chunks/1-2.jsonl.quarantined"
  );
  assert.equal(
    quarantinePathFor("/q/chunks/1-2.meta.json"),
    "/q/chunks/1-2.meta.json.quarantined"
  );
  // The drain lists bodies by a .jsonl suffix and metas by .meta.json; a
  // quarantined pair matches neither, so it is never picked up again.
  assert.equal(quarantinePathFor("/q/chunks/1-2.jsonl").endsWith(".jsonl"), false);
  assert.equal(
    quarantinePathFor("/q/chunks/1-2.meta.json").endsWith(".meta.json"),
    false
  );
});
