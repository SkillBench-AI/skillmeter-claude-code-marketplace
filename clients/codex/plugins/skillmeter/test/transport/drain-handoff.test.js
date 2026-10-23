"use strict";
// The detached drain worker: Stop-hook handoff, trigger coalescing and lock
// ownership, driven with real nested processes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sandbox, SCRIPTS } = require("../../test-support/plugin.cjs");

function preloadFixture() {
  const fs = require("fs"), cp = require("child_process"), path = require("path");
  const root = process.env.TEST_ROOT;
  const record = (file, value) => fs.appendFileSync(path.join(root, file), JSON.stringify(value) + "\n");
  cp.execSync = () => { throw Error("unexpected shell access"); };
  cp.spawn = (_, args) => {
    if (!args[0].endsWith("/drain_once.js")) throw Error("unexpected background worker");
    record("spawns.jsonl", {});
    return { pid: 999999, unref() {} };
  };
  const injectStop = () => {
    if (!fs.existsSync(path.join(root, "injected"))) {
      fs.writeFileSync(path.join(root, "injected"), "");
      if (process.env.TEST_INJECT === "paused") {
        // Another process pauses Codex in its consent record; the grants stay.
        const file = path.join(root, ".skillbench/clients/codex/telemetry-policy.json");
        const policy = JSON.parse(fs.readFileSync(file, "utf8"));
        policy.global = { enabled: false, decided_at: 2, source: "user" }; policy.revision++;
        fs.writeFileSync(file, JSON.stringify(policy));
      }
      fs.appendFileSync(process.env.TEST_SOURCE, JSON.stringify({ type: "response_item",
        payload: { type: "message", role: "user", content: "final overlapping turn" } }) + "\n");
      // The real Stop hook runs after this worker staged its snapshot; no sleeps or sweeps.
      const hook = cp.spawnSync(process.execPath, ["--require", __filename,
        path.join(process.env.PLUGIN_ROOT, "scripts/stop.js")], {
        cwd: process.cwd(), input: process.env.TEST_INPUT, encoding: "utf8", timeout: 5000,
        env: process.env,
      });
      if (hook.status !== 0 || hook.stdout.trim() !== "{}") throw Error("overlapping Stop failed: " + hook.stderr);
      record("requests.jsonl", fs.readFileSync(path.join(process.env.PLUGIN_DATA, "logs/.drain-once.request"), "utf8"));
    }
  };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    const result = unlink(file);
    if (["release", "release-completed"].includes(process.env.TEST_INJECT) && file === path.join(process.env.PLUGIN_DATA, "logs/.drain-once.worker.lock") && !fs.existsSync(path.join(root, "injected"))) {
      injectStop();
      if (process.env.TEST_INJECT === "release-completed") {
        const next = cp.spawnSync(process.execPath, ["--require", __filename,
          path.join(process.env.PLUGIN_ROOT, "scripts/drain_once.js"), "--requested"], {
          cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 5000,
        });
        if (next.status !== 0) throw Error(next.stderr);
      }
    }
    return result;
  };
  global.fetch = async (url, options) => {
    if (!String(url).startsWith("https://acme.meter.skillbench.ai/logs/codex")) throw Error("unexpected endpoint");
    const records = require("zlib").gunzipSync(options.body).toString().trim().split("\n").map(JSON.parse);
    record("uploads.jsonl", { url, records });
    const transcript = String(url).endsWith("/transcript");
    if (process.env.TEST_INJECT === "competing" && !fs.existsSync(path.join(root, "injected"))) {
      fs.writeFileSync(path.join(root, "injected"), "");
      const competing = cp.spawnSync(process.execPath, ["--require", __filename,
        path.join(process.env.PLUGIN_ROOT, "scripts/drain_once.js"), "--requested"], {
        cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 5000,
      });
      if (competing.status !== 0) throw Error(competing.stderr);
    }
    if (process.env.TEST_INJECT === "aged" && transcript && !fs.existsSync(path.join(root, "injected"))) {
      const lock = path.join(process.env.PLUGIN_DATA, "logs/.drain-once.worker.lock");
      const before = fs.readFileSync(lock, "utf8");
      fs.utimesSync(lock, new Date(0), new Date(0));
      injectStop();
      record("ownership.jsonl", { before, after: fs.readFileSync(lock, "utf8") });
    }
    if (["transcript", "paused"].includes(process.env.TEST_INJECT) && transcript || process.env.TEST_INJECT === "event" && !transcript) injectStop();
    return { ok: process.env.TEST_STATUS === "200", status: Number(process.env.TEST_STATUS) };
  };
}

function handoff(t, inject = "transcript", status = 200) {
  const box = sandbox(t, { prefix: "codex-drain-handoff", telemetry: true, preload: "(" + preloadFixture.toString() + ")();\n" });
  const source = path.join(box.root, "rollout.jsonl");
  const input = { session_id: "synthetic", cwd: box.repo, transcript_path: source };
  const message = text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } }) + "\n";
  fs.writeFileSync(source, JSON.stringify({ type: "session_meta", payload: { id: "synthetic", cwd: box.repo } }) + "\n");
  const env = { TEST_ROOT: box.root, TEST_SOURCE: source, TEST_INPUT: JSON.stringify(input), TEST_INJECT: inject || "none", TEST_STATUS: String(status) };
  function run(args, extra = {}) {
    const result = box.spawn(args, { input, env: { ...env, ...extra } });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result;
  }
  const records = name => fs.existsSync(path.join(box.root, name))
    ? fs.readFileSync(path.join(box.root, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  run(["-e", "require(" + JSON.stringify(path.join(SCRIPTS, "logger.js")) + ").requestTranscriptCapture(JSON.parse(process.env.TEST_INPUT))"]);
  fs.appendFileSync(source, message("first eligible turn"));
  const initial = run([path.join(SCRIPTS, "stop.js")]);
  assert.ok(records("spawns.jsonl").length >= 1, initial.stderr);
  const initialSpawns = records("spawns.jsonl").length;
  return { root: box.root, data: box.data, run, records, initialSpawns, drain() {
    let count = 0;
    while (count < records("spawns.jsonl").length) {
      assert.ok(count < 8, "worker must not reschedule forever without new triggers");
      count++;
      run([path.join(SCRIPTS, "drain_once.js"), "--requested"]);
    }
    return records("uploads.jsonl").filter(x => x.url.endsWith("/transcript")).length;
  } };
}

for (const phase of ["transcript", "event", "release"]) test("a final Stop at " + phase + " boundary drains without another hook or monitor", t => {
  const f = handoff(t, phase);
  f.drain();
  const uploads = f.records("uploads.jsonl");
  assert.deepEqual(uploads.filter(x => x.url.endsWith("/transcript")).flatMap(x => x.records)
    .filter(x => x.type === "response_item").map(x => x.payload.content), ["first eligible turn", "final overlapping turn"]);
  assert.equal(uploads.flatMap(x => x.records).filter(x => x.hook_event_name === "Stop").length, 2);
  assert.equal(fs.existsSync(path.join(f.data, "logs/.drain-once.worker.lock")), false);
  assert.equal(fs.readFileSync(path.join(f.data, "logs/.drain-once.request"), "utf8"), f.records("requests.jsonl")[0],
    "worker handoff must not manufacture a new capture request");
});

test("a paused final hook cannot authorize a follow-up upload", t => {
  const f = handoff(t, "paused");
  assert.equal(f.drain(), 1);
  const records = f.records("uploads.jsonl").flatMap(x => x.records);
  assert.deepEqual(records.filter(x => x.type === "response_item").map(x => x.payload.content), ["first eligible turn"]);
  assert.equal(records.filter(x => x.hook_event_name === "Stop").length, 1);
});

test("new triggers during failed delivery cause only one additional pass", t => {
  const f = handoff(t, "transcript", 503);
  assert.equal(f.drain(), 2);
  assert.ok(fs.readdirSync(path.join(f.data, "logs")).some(name => /^events\.jsonl\.\d+$/.test(name)));
});

test("a successful drain without newer triggers schedules no successor", t => {
  const f = handoff(t, false);
  assert.equal(f.drain(), 1);
});

test("failed delivery without newer triggers stays queued instead of spawning a retry loop", t => {
  const f = handoff(t, false, 503);
  assert.equal(f.drain(), 1);
  assert.ok(fs.readdirSync(path.join(f.data, "logs")).some(name => /^events\.jsonl\.\d+$/.test(name)));
});

test("a live drain older than the coalescing window retains its lock", t => {
  const f = handoff(t, "aged");
  f.drain();
  const [ownership] = f.records("ownership.jsonl");
  assert.equal(ownership.after, ownership.before);
});

test("a successor completed during release is not retried by its predecessor", t => {
  const f = handoff(t, "release-completed", 503);
  f.run([path.join(SCRIPTS, "drain_once.js"), "--requested"]);
  assert.equal(f.records("spawns.jsonl").length, f.initialSpawns * 2,
    "the completed successor must consume the trigger even when delivery failed");
});

test("a competing process cannot drain while the owner is uploading", t => {
  const f = handoff(t, "competing");
  assert.equal(f.drain(), 1);
  assert.equal(f.records("uploads.jsonl").length, 2);
});
