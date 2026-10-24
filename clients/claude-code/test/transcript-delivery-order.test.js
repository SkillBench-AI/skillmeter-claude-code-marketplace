"use strict";

// The collector merges a transcript's chunks by generation baseline, so a
// transcript's chunks go in seq order and a chunk that is not delivered holds
// back the ones after it. Failures that say nothing about the chunk (no
// network, an unavailable collector, a refused license) back off without
// spending its retry budget.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  makeJwt,
  makeTempDir,
  setTestEnv,
  writeCredentials,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const STATE_DIR = makeTempDir("skm-order-state-");
const DATA_DIR = makeTempDir("skm-order-data-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
setTestEnv("SKILLMETER_ACTIVATE_URL", "http://127.0.0.1:9/activation/activate");
setTestEnv("SKILLMETER_BROKER_URL", "http://127.0.0.1:9/id");
setTestEnv("SKILLMETER_BACKEND_URL", "http://127.0.0.1:9/collector");

const ORG = "skillbench-ai";
const REPO = { repoKey: `github.com/${ORG}/ordered`, org: ORG };

const store = require("../skillmeter/scripts/lib/telemetry-store");
const transfer = require("../skillmeter/scripts/lib/transfer");
const licenseStatus = require("../skillmeter/scripts/lib/license-status");
const { MAX_UPLOAD_ATTEMPTS } = require("../skillmeter/scripts/lib/chunk-retry");
const { REPOSITORIES_LOG_DIR, LOG_DIR } = require("../skillmeter/scripts/lib/paths");

const realFetch = global.fetch;
process.on("exit", () => { global.fetch = realFetch; });

let sent;
beforeEach(() => {
  writeCredentials(STATE_DIR, {
    device_id: "ORDER-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: ORG },
      orgs: [ORG],
      aud: "https://acme.meter.skillbench.example",
    }),
    refresh_token: "ory_rt_fixture",
  });
  writeTelemetryPolicy(STATE_DIR, { orgs: { [ORG]: true }, repositories: { [REPO.repoKey]: true } });
  licenseStatus.clearLicenseStatus({ source: "test" });
  fs.rmSync(REPOSITORIES_LOG_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(LOG_DIR, ".license-refresh.lock"), { force: true });
  store.setRepositoryOverride(REPO.repoKey, true);
  sent = [];
});

// Each transcript POST answers with the next entry of `answers`: a status, or
// an Error to throw as a network failure. Other requests (license renewal)
// fail, which leaves the stored license in place.
function stubFetch(answers) {
  global.fetch = async (url, init = {}) => {
    if (!String(url).endsWith("/logs/claude/transcript")) {
      return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    }
    sent.push({
      id: init.headers["X-Transcript-ID"],
      seq: Number(init.headers["X-Chunk-Seq"]),
      reset: Number(init.headers["X-Chunk-Reset"]),
    });
    const answer = answers.shift() ?? 202;
    if (answer instanceof Error) throw answer;
    return { ok: answer < 300, status: answer, text: async () => "", json: async () => ({}) };
  };
}

function seal(transcriptId, seq, extra = {}) {
  return transfer.sealDeltaChunk(
    transcriptId,
    [JSON.stringify({ uuid: `${transcriptId}-${seq}` })],
    { seq, reset: false, resetBaselineSeq: null, promptId: "live", ...extra },
    REPO
  );
}

const metaOf = (body) => JSON.parse(fs.readFileSync(body.replace(/\.jsonl$/, ".meta.json"), "utf8"));

test("a transcript's chunks are sent in seq order", async () => {
  // Sealed in reverse, so file names sort against seq order.
  const third = seal("s.jsonl", 3);
  const second = seal("s.jsonl", 2);
  const first = seal("s.jsonl", 1);
  stubFetch([]);

  const result = await transfer.drainDeltaChunks(100);

  assert.equal(result.ok, 3);
  assert.deepEqual(sent.map((r) => r.seq), [1, 2, 3]);
  for (const body of [first, second, third]) assert.equal(fs.existsSync(body), false);
});

test("a chunk that is not delivered holds back the rest of its transcript only", async () => {
  const first = seal("held.jsonl", 1);
  const second = seal("held.jsonl", 2);
  const other = seal("free.jsonl", 1);
  stubFetch([500]);

  await transfer.drainDeltaChunks(100);

  const heldSent = sent.filter((r) => r.id === "held.jsonl").map((r) => r.seq);
  assert.deepEqual(heldSent, [1], "seq 2 waits for seq 1");
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
  assert.ok(!metaOf(second).uploadAttempts, "the held chunk spent nothing");
  assert.equal(fs.existsSync(other), false, "another transcript is not held");
});

test("a chunk waiting out its backoff holds back the chunks after it", async () => {
  const first = seal("wait.jsonl", 1, { uploadAttempts: 1, nextAttemptAt: Date.now() + 60_000 });
  const second = seal("wait.jsonl", 2);
  stubFetch([]);

  await transfer.drainDeltaChunks(100);

  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
});

for (const [label, answer] of [
  ["no network", new TypeError("fetch failed")],
  ["HTTP 503", 503],
  ["HTTP 403", 403],
  ["HTTP 402", 402],
]) {
  test(`${label} backs off without spending the retry budget`, async () => {
    const body = seal("offline.jsonl", 1);
    stubFetch([answer]);

    await transfer.drainDeltaChunks(100);

    const meta = metaOf(body);
    assert.ok(!meta.uploadAttempts);
    assert.equal(meta.uploadDeferrals, 1);
    assert.ok(meta.nextAttemptAt > Date.now(), "backed off");
  });
}

test("a chunk offline far longer than the retry budget is never set aside", async () => {
  const body = seal("long.jsonl", 1);
  for (let i = 0; i < MAX_UPLOAD_ATTEMPTS + 2; i++) {
    const meta = metaOf(body);
    fs.writeFileSync(body.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ ...meta, nextAttemptAt: 0 }));
    stubFetch([new TypeError("fetch failed")]);
    await transfer.drainDeltaChunks(100);
  }
  assert.equal(fs.existsSync(body), true);
  assert.equal(metaOf(body).uploadDeferrals, MAX_UPLOAD_ATTEMPTS + 2);
});

test("every chunk of a generation carries its baseline", async () => {
  seal("gen.jsonl", 5, { reset: true, resetBaselineSeq: 5 });
  seal("gen.jsonl", 6, { resetBaselineSeq: 5 });
  seal("gen.jsonl", 7, { resetBaselineSeq: 5 });
  stubFetch([]);

  await transfer.drainDeltaChunks(100);

  assert.deepEqual(sent.map((r) => [r.seq, r.reset]), [[5, 5], [6, 5], [7, 5]]);
});
