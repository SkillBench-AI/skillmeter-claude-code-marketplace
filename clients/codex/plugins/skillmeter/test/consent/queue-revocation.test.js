"use strict";
// Repository revocation, the global pause and mixed batches, driven through
// the real queue and control code with an intercepted fetch.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { license, writeCredentials, grantConsent, transcriptLine: line } = require("../../test-support/plugin.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-revocation-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PLUGIN_DATA = path.join(root, "data");
process.env.SKILLMETER_MAX_BATCH_RETRIES = "3";
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
delete process.env.SKILLMETER_BACKEND_URL;
const licensed = orgs => license({ sub: "synthetic-tenant", broker_sub: "synthetic-user", org: { login: "synthetic" }, orgs, aud: "https://synthetic.meter.skillbench.com" });
const credentials = {
  device_id: "SYNTHETIC", hash_salt: "synthetic-salt", license_jwt: licensed(["synthetic"]), refresh_token: "synthetic-refresh",
};
const save = (patch = {}) => writeCredentials(root, { ...credentials, ...patch });
save();
const logger = require("../../scripts/logger");
const queue = require("../../scripts/lib/transcript-delta");
const realFetch = global.fetch;
const endpoint = "https://collector.invalid/logs/codex";
const repos = Object.fromEntries(["a", "b"].map(name => {
  const directory = path.join(root, name);
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", `https://github.com/synthetic/${name}.git`]);
  return [name, directory];
}));
const decode = body => zlib.gunzipSync(body).toString().trim().split("\n").map(JSON.parse);
const source = name => path.join(root, `${name}.jsonl`);

function control(name, action) {
  execFileSync(process.execPath, [path.resolve(__dirname, "../../scripts/telemetry.js"), action], {
    cwd: repos[name], env: process.env, stdio: "pipe", timeout: 5000,
  });
}

function stage(name, content = `authorized-${name}`) {
  fs.appendFileSync(source(name), line(content));
  const file = logger.stageTranscriptForUpload(source(name), { cwd: repos[name] });
  assert.ok(file, "fixture must stage a real authorized chunk");
  return file;
}

function event(name) {
  logger.logInfo("Stop", `synthetic-${name}`, {
    cwd: logger.hashHmac(repos[name], credentials.hash_salt),
    repo_root: logger.hashHmac(repos[name], credentials.hash_salt),
    repo_remote_org: logger.hashHmac("synthetic", credentials.hash_salt),
  }, credentials.device_id);
}

beforeEach(() => {
  // Start each test with acknowledged consent for both repositories and no pause.
  grantConsent(path.join(root, ".skillbench"), ["github.com/synthetic/a", "github.com/synthetic/b"]);
  save();
  fs.rmSync(logger.LOG_DIR, { recursive: true, force: true });
  for (const name of ["a", "b"]) {
    logger.saveTelemetryOptIn(repos[name], true);
    fs.writeFileSync(source(name), "");
    logger.observeTranscriptConsent(source(name), repos[name]);
  }
  global.fetch = async () => assert.fail("unexpected network attempt");
});
after(() => {
  global.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

test("transcript drain rechecks disabled A while delivering authorized B", async () => {
  stage("a"); stage("b");
  control("a", "restrict");
  const received = [];
  global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["authorized-b"]);
});

test("revocation after a request starts cannot undo it but blocks the next chunk", async () => {
  stage("a", "first"); stage("a", "second");
  const received = [];
  global.fetch = async (_, options) => {
    received.push(...decode(options.body));
    control("a", "restrict");
    return { ok: true };
  };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["first"]);
});

test("global pause retains sealed events and transcript bytes without sending", async () => {
  const chunks = [stage("a"), stage("b")];
  event("a"); event("b");
  const sealed = logger.sealEventLog();
  const files = [sealed, ...chunks];
  const before = files.map(file => fs.readFileSync(file));
  logger.setTelemetryGloballyDisabled(true);
  assert.equal(await logger.drainQueuesOnce(endpoint, 1000), 0);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});

test("repository disable does not guess ownership or destroy an unattributed legacy batch", () => {
  fs.mkdirSync(logger.LOG_DIR, { recursive: true });
  const legacy = path.join(logger.LOG_DIR, `events.jsonl.${Date.now()}`);
  const bytes = '{"hook_event_name":"Stop","data":{"fixture":"unknown-repository"}}\n';
  fs.writeFileSync(legacy, bytes);
  control("a", "restrict");
  assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
});

test("repository revocation removes A's queued transcript payloads but preserves its cursor and B", () => {
  const a = stage("a");
  const b = stage("b");
  const cursors = [a, b].map(file => path.join(path.dirname(path.dirname(file)), "cursor.json"));
  const before = [b, ...cursors].map(file => fs.readFileSync(file));
  control("a", "restrict");
  assert.equal(fs.existsSync(a), false, "revoked payload must be removed");
  assert.deepEqual([b, ...cursors].map(file => fs.readFileSync(file)), before, "B and both cursors survive byte for byte");
});

test("mixed event batch delivers B without disclosing disabled A",
  async () => {
    event("a"); event("b");
    const sealed = logger.sealEventLog();
    control("a", "restrict");
    const received = [];
    global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
    await logger.processSealedBatch(sealed, endpoint, 1000);
    assert.deepEqual(received.map(record => record.session_id), ["synthetic-b"]);
  });

test("a failed event delivery rechecks repository consent before retrying",
  async () => {
    event("a");
    const sealed = logger.sealEventLog();
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 503 }; };
    assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "retry");
    control("a", "restrict");
    await logger.processSealedBatch(sealed, endpoint, 1000);
    assert.equal(calls, 1, "a revoked repository cannot be sent again");
  });

test("private routing stays local and authorized B survives an in-flight A revocation", async () => {
  event("a"); event("b");
  const sealed = logger.sealEventLog();
  let sent;
  global.fetch = async (_, options) => {
    sent = decode(options.body);
    control("a", "restrict");
    control("a", "unrestrict");
    return { ok: false, status: 503 };
  };
  await logger.processSealedBatch(sealed, endpoint, 1000);
  assert.equal(sent.length, 2, "the request had already started");
  assert.ok(sent.every(record => !Object.hasOwn(record, "_queue")));
  global.fetch = async (_, options) => { sent = decode(options.body); return { ok: true }; };
  await logger.processSealedBatch(sealed, endpoint, 1000);
  assert.deepEqual(sent.map(record => record.session_id), ["synthetic-b"]);
});

test("disable/re-enable during a transcript request purges remaining revoked payloads", async () => {
  stage("a", "first"); const pending = stage("a", "second");
  let calls = 0;
  global.fetch = async () => {
    calls++;
    control("a", "restrict"); control("a", "unrestrict");
    return { ok: false, status: 503 };
  };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(logger.listPendingTranscripts().length, 0);
  logger.observeTranscriptConsent(source("a"), repos.a);
  stage("a", "new authorization");
  let received;
  global.fetch = async (_, options) => { received = decode(options.body); return { ok: true }; };
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received.map(record => record.payload.content), ["new authorization"]);
});

for (const damage of ["missing", "corrupt"]) {
  test(`indexed events with ${damage} routing state are retained without delivery or a retry charge`, async () => {
    event("a"); const sealed = logger.sealEventLog();
    const routing = path.join(logger.LOG_DIR, "repository-routing");
    if (damage === "missing") fs.rmSync(routing, { recursive: true });
    else for (const file of fs.readdirSync(routing)) fs.writeFileSync(path.join(routing, file), "{}");
    assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
    assert.ok(fs.existsSync(sealed));
    assert.equal(fs.existsSync(`${sealed}.meta`), false);
  });
}

test("explicit revocation during global pause removes only the selected repository", () => {
  const a = stage("a"), b = stage("b");
  event("a"); event("b"); const sealed = logger.sealEventLog();
  logger.setTelemetryGloballyDisabled(true);
  control("a", "restrict");
  assert.equal(fs.existsSync(a), false);
  assert.ok(fs.existsSync(b));
  assert.deepEqual(fs.readFileSync(sealed, "utf8").trim().split("\n").map(JSON.parse).map(r => r.session_id), ["synthetic-b"]);
});

test("a symlink checkout alias shares the revocation boundary", () => {
  const alias = path.join(root, "alias-a");
  fs.symlinkSync(repos.a, alias, "dir");
  logger.saveTelemetryOptIn(alias, true);
  logger.observeTranscriptConsent(source("a"), repos.a);
  logger.logInfo("Stop", "alias-event", {
    cwd: logger.hashHmac(alias, credentials.hash_salt),
    repo_root: logger.hashHmac(alias, credentials.hash_salt),
  }, credentials.device_id);
  const sealed = logger.sealEventLog();
  const chunk = stage("a");
  control("a", "restrict");
  assert.equal(fs.existsSync(sealed), false);
  assert.equal(fs.existsSync(chunk), false);
});

test("a hook at the disable settings-write boundary cannot inherit the revoked generation", async () => {
  const settings = path.join(repos.a, logger.SETTINGS_RELATIVE);
  const write = fs.writeFileSync, rename = fs.renameSync;
  let snapshot, injected = false;
  const intercept = () => {
    if (injected) return;
    injected = true;
    // A hook registers and checks consent while the control is paused just before publishing.
    snapshot = JSON.parse(execFileSync(process.execPath, ["-e", `
      const logger = require(process.argv[1]);
      const { createRepositoryQueue } = require(process.argv[2]);
      const cwd = process.argv[3];
      const routing = createRepositoryQueue(logger.LOG_DIR, logger.getOrCreateHashSalt, () => true);
      try {
        const route = routing.register(cwd, logger.findGitRoot(cwd));
        const allowed = logger.resolveTelemetryGate(logger.getTelemetryOptIn(cwd), logger.getRepoScopeDecision(cwd).allowed).capture;
        if (allowed) {
          logger.observeTranscriptConsent(process.argv[4], cwd);
          require("fs").appendFileSync(process.argv[4], JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"transition transcript"}}) + "\\n");
          logger.stageTranscriptForUpload(process.argv[4], { cwd });
        }
        process.stdout.write(JSON.stringify(allowed ? { epoch: route.epoch } : null));
      } catch (error) {
        if (error.message !== "repository-routing-busy") throw error;
        process.stdout.write("null");
      }
    `, path.resolve(__dirname, "../../scripts/logger.js"), path.resolve(__dirname, "../../scripts/lib/repository-queue.js"), repos.a, source("a")],
    { env: process.env, encoding: "utf8", timeout: 5000 }));
  };
  fs.writeFileSync = function(file, ...args) {
    if (file === settings) intercept();
    return write.call(this, file, ...args);
  };
  fs.renameSync = function(from, to) {
    if (to === settings) intercept();
    return rename.call(this, from, to);
  };
  try { logger.saveTelemetryOptIn(repos.a, false); }
  finally { fs.writeFileSync = write; fs.renameSync = rename; }
  assert.equal(injected, true, "must exercise the settings publication boundary");
  if (snapshot) {
    logger.logInfo("Stop", "late-hook", {
      cwd: logger.hashHmac(repos.a, credentials.hash_salt),
      repo_root: logger.hashHmac(repos.a, credentials.hash_salt),
    }, credentials.device_id, snapshot);
  }
  control("a", "unrestrict");
  const sealed = logger.sealEventLog(), received = [];
  global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
  if (sealed) await logger.processSealedBatch(sealed, endpoint, 1000);
  await logger.drainPendingTranscripts(endpoint, 1000);
  assert.deepEqual(received, [], "re-enable cannot resurrect a hook or transcript admitted during disable");
});

test("temporary missing organization authorization retains events for recovery", async () => {
  event("a"); const sealed = logger.sealEventLog(), bytes = fs.readFileSync(sealed);
  save({ license_jwt: licensed([]) });
  let blockedCalls = 0;
  global.fetch = async () => { blockedCalls++; return { ok: false, status: 503 }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
  assert.equal(blockedCalls, 0);
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  save();
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.equal(calls, 1);
});

test("missing credentials retain queued events without an upload or retry charge", async () => {
  event("a"); const sealed = logger.sealEventLog(), bytes = fs.readFileSync(sealed);
  save({ license_jwt: undefined, refresh_token: undefined });
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 503 }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "auth");
  assert.equal(calls, 0);
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  assert.equal(fs.existsSync(`${sealed}.meta`), false);
});

test("revocation removes A even when B's delivery authorization is temporarily unavailable", () => {
  event("a"); event("b"); const sealed = logger.sealEventLog();
  fs.writeFileSync(path.join(repos.b, logger.SETTINGS_RELATIVE), '{"skillmeter":{"telemetry":"hold"}}');
  control("a", "restrict");
  assert.deepEqual(fs.readFileSync(sealed, "utf8").trim().split("\n").map(JSON.parse).map(r => r.session_id), ["synthetic-b"]);
});

// An invalid local choice holds delivery without revoking queued payloads.
const HOLD = '{"skillmeter":{"telemetry":"hold"}}';
function holdA() {
  fs.writeFileSync(path.join(repos.a, logger.SETTINGS_RELATIVE), HOLD);
}
function sessions(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).map(r => r.session_id);
}

test("temporary hold of A delivers B once and recovers A separately", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  const received = [];
  global.fetch = async (_, options) => { received.push(...decode(options.body)); return { ok: true }; };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.deepEqual(received.map(r => r.session_id), ["synthetic-b"]);
  assert.deepEqual(sessions(sealed), ["synthetic-a"]);
  assert.equal(fs.existsSync(`${sealed}.sent`), false);
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held");
  control("a", "unrestrict");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.deepEqual(received.map(r => r.session_id), ["synthetic-b", "synthetic-a"]);
  assert.ok(received.every(r => !r._queue));
});

test("permanent rejection quarantines only the deliverable part of a mixed batch", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  global.fetch = async (_, options) => {
    assert.deepEqual(decode(options.body).map(r => r.session_id), ["synthetic-b"]);
    return { ok: false, status: 400 };
  };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "poison");
  assert.deepEqual(sessions(sealed), ["synthetic-a"]);
  assert.deepEqual(sessions(path.join(logger.LOG_DIR, "poison", path.basename(sealed))), ["synthetic-b"]);
});

test("expired mixed batch retains held records outside quarantine", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  const old = path.join(logger.LOG_DIR, `events.jsonl.${Date.now() - logger.BATCH_MAX_AGE_MS - 60000}`);
  fs.renameSync(sealed, old);
  assert.equal(await logger.processSealedBatch(old, endpoint, 1000), "poison");
  assert.deepEqual(sessions(old), ["synthetic-a"]);
  assert.deepEqual(sessions(path.join(logger.LOG_DIR, "poison", path.basename(old))), ["synthetic-b"]);
  assert.equal(await logger.processSealedBatch(old, endpoint, 1000), "held");
});

test("held sealed events expire at the cleanup limit even while globally paused", async () => {
  event("a"); const sealed = logger.sealEventLog(); holdA();
  const old = path.join(logger.LOG_DIR, `events.jsonl.${Date.now() - logger.CLEANUP_MAX_AGE_MS - 60000}`);
  fs.renameSync(sealed, old);
  fs.writeFileSync(old + ".meta", '{"attempts":2}');
  // A new rewrite time must not extend an immutable batch's retention.
  fs.utimesSync(old, new Date(), new Date());
  logger.setTelemetryGloballyDisabled(true);
  await logger.drainQueuesOnce(endpoint, 1000);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(old + ".meta"), false);
});

test("cleanup retains fresh held events and defers an expired locked batch", () => {
  event("a"); const fresh = logger.sealEventLog(); holdA();
  const old = path.join(logger.LOG_DIR, `events.jsonl.${Date.now() - logger.CLEANUP_MAX_AGE_MS - 60000}`);
  fs.copyFileSync(fresh, old);
  const release = queue.acquireLock(old + ".lock"); assert.ok(release);
  try {
    logger.cleanupStaleFiles();
    assert.equal(fs.existsSync(old), true);
    assert.equal(fs.existsSync(fresh), true);
  } finally { release(); }
  logger.cleanupStaleFiles();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("salvage of a rejected mixed batch never uploads held records", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  fs.appendFileSync(sealed, "broken-json\n");
  let calls = 0;
  global.fetch = async (_, options) => {
    if (++calls === 1) return { ok: false, status: 400 };
    assert.deepEqual(decode(options.body).map(r => r.session_id), ["synthetic-b"]);
    return { ok: true };
  };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.equal(calls, 2);
  assert.deepEqual(sessions(sealed), ["synthetic-a"]);
});

test("authorization is evaluated once per cwd per attempt and never during purge", () => {
  event("a"); event("b"); event("a"); const sealed = logger.sealEventLog();
  const { createRepositoryQueue } = require("../../scripts/lib/repository-queue");
  const calls = [];
  const routing = createRepositoryQueue(logger.LOG_DIR, () => credentials.hash_salt, cwd => { calls.push(cwd); return true; });
  routing.pruneFile(sealed);
  assert.deepEqual(calls.sort(), [repos.a, repos.b].sort());
  routing.purgeEvents();
  assert.equal(calls.length, 2);
  routing.pruneFile(sealed);
  assert.equal(calls.length, 4, "the next delivery must recheck authorization");
});

test("retry exhaustion quarantines B while retaining held A", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  global.fetch = async () => ({ ok: false, status: 503 });
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "retry");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "retry");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "poison");
  assert.deepEqual(sessions(sealed), ["synthetic-a"]);
  assert.deepEqual(sessions(path.join(logger.LOG_DIR, "poison", path.basename(sealed))), ["synthetic-b"]);
  control("a", "unrestrict");
  global.fetch = async () => ({ ok: true });
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
});

test("a newly eligible subset does not inherit earlier delivery failures", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  global.fetch = async () => ({ ok: false, status: 503 });
  await logger.processSealedBatch(sealed, endpoint, 1000);
  await logger.processSealedBatch(sealed, endpoint, 1000);
  assert.equal(logger.readBatchMeta(sealed).attempts, 2);
  control("a", "unrestrict");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "retry");
  assert.equal(logger.readBatchMeta(sealed).attempts, 1);
  assert.deepEqual(sessions(sealed), ["synthetic-a", "synthetic-b"]);
});

test("authentication rejection preserves both parts without spending retry budget", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  const bytes = fs.readFileSync(sealed);
  global.fetch = async (_, options) => {
    assert.deepEqual(decode(options.body).map(r => r.session_id), ["synthetic-b"]);
    return { ok: false, status: 401 };
  };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "auth");
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  assert.equal(logger.readBatchMeta(sealed).attempts, 0);
});

test("a concurrent drain cannot expire or modify a batch during delivery", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  global.fetch = async () => {
    const bytes = fs.readFileSync(sealed);
    const now = Date.now;
    Date.now = () => now() + logger.BATCH_MAX_AGE_MS + 60000;
    try { assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "held"); }
    finally { Date.now = now; }
    assert.deepEqual(fs.readFileSync(sealed), bytes);
    return { ok: true };
  };
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "sent");
  assert.deepEqual(sessions(sealed), ["synthetic-a"]);
});

test("failed local acknowledgment preserves held records and reports a retry", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  const bytes = fs.readFileSync(sealed), rename = fs.renameSync;
  global.fetch = async () => ({ ok: true });
  fs.renameSync = function(from, to) {
    if (to === sealed) throw new Error("synthetic disk failure");
    return rename.call(this, from, to);
  };
  try { assert.equal(await logger.transferEventLog(sealed, endpoint, 1000), "retry"); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(sealed), bytes);
  assert.equal(fs.existsSync(`${sealed}.sent`), false);
});

test("later quarantine of a recovered subset preserves the earlier rejected subset", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog(); holdA();
  global.fetch = async () => ({ ok: false, status: 400 });
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "poison");
  control("a", "unrestrict");
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "poison");
  assert.equal(fs.existsSync(sealed), false);
  assert.deepEqual(sessions(path.join(logger.LOG_DIR, "poison", path.basename(sealed))), ["synthetic-b", "synthetic-a"]);
});

test("global pause during rejection leaves salvage queued rather than quarantined", async () => {
  event("b"); const sealed = logger.sealEventLog();
  fs.appendFileSync(sealed, "broken-json\n");
  let calls = 0;
  global.fetch = async () => {
    calls++;
    logger.setTelemetryGloballyDisabled(true);
    return { ok: false, status: 400 };
  };
  // The pause stops the salvage before it is sent; the batch stays queued.
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "skip");
  assert.equal(calls, 1);
  assert.deepEqual(sessions(sealed), ["synthetic-b"]);
  assert.equal(fs.existsSync(path.join(logger.LOG_DIR, "poison", path.basename(sealed))), false);
});

test("repository disable removes its quarantined rows and preserves other repositories", async () => {
  event("a"); event("b"); const sealed = logger.sealEventLog();
  global.fetch = async () => ({ ok: false, status: 400 });
  assert.equal(await logger.processSealedBatch(sealed, endpoint, 1000), "poison");
  const poison = path.join(logger.LOG_DIR, "poison", path.basename(sealed));
  control("a", "restrict");
  assert.deepEqual(sessions(poison), ["synthetic-b"]);
  control("b", "restrict");
  assert.equal(fs.existsSync(poison), false);
});

test("quarantine purge shares the source lock and retries after it is released", async () => {
  event("a"); const sealed = logger.sealEventLog();
  global.fetch = async () => ({ ok: false, status: 400 });
  await logger.processSealedBatch(sealed, endpoint, 1000);
  const poison = path.join(logger.LOG_DIR, "poison", path.basename(sealed));
  const bytes = fs.readFileSync(poison);
  const release = queue.acquireLock(`${sealed}.lock`);
  assert.ok(release);
  try { control("a", "restrict"); assert.deepEqual(fs.readFileSync(poison), bytes); }
  finally { release(); }
  const { createRepositoryQueue } = require("../../scripts/lib/repository-queue");
  const routing = createRepositoryQueue(logger.LOG_DIR, () => credentials.hash_salt, () => assert.fail("purge must not authorize"));
  assert.equal(routing.purgeEvents(), true);
  assert.equal(fs.existsSync(poison), false);
});
