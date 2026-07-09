"use strict";

// Regression coverage for the shared leaf helpers introduced by the E-series
// dedup (lib/io.js) and the parametrized jwt expiry check (lib/jwt.js).
// Run: node --test skillmeter/test/lib.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const io = require("../scripts/lib/io");
const { isJwtExpired, getEndpointFromTokenAllowExpired } = require("../scripts/lib/jwt");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skm-lib-"));
}

// --- io.safeReadJson -------------------------------------------------------

test("safeReadJson returns parsed content for valid JSON", () => {
  const d = tmp();
  const f = path.join(d, "x.json");
  fs.writeFileSync(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(io.safeReadJson(f), { a: 1 });
});

test("safeReadJson returns the fallback on missing/malformed file", () => {
  const d = tmp();
  assert.equal(io.safeReadJson(path.join(d, "nope.json")), null);
  assert.deepEqual(io.safeReadJson(path.join(d, "nope.json"), {}), {});
  const bad = path.join(d, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.deepEqual(io.safeReadJson(bad, { fb: true }), { fb: true });
});

// --- io.atomicWriteJson ----------------------------------------------------

test("atomicWriteJson writes JSON that safeReadJson round-trips", () => {
  const d = tmp();
  const f = path.join(d, "nested", "out.json");
  io.atomicWriteJson(f, { hello: "world" });
  assert.deepEqual(io.safeReadJson(f), { hello: "world" });
});

// --- io.findGitRoot --------------------------------------------------------

test("findGitRoot walks up to the .git marker and returns '' outside a repo", () => {
  const d = tmp();
  const nested = path.join(d, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(d, ".git"));
  // findGitRoot uses path.resolve (not realpath), matching how the callers pass
  // cwd through; compare against the resolved dir, not its symlink-resolved form.
  assert.equal(io.findGitRoot(nested), path.resolve(d));
  assert.equal(io.findGitRoot(""), "");

  const orphan = tmp(); // fresh tmp dir with no .git up its (short) chain
  // Not asserting a specific value for orphan since tmp may sit under a repo on
  // some machines; just assert the type contract.
  assert.equal(typeof io.findGitRoot(orphan), "string");
});

// --- jwt.isJwtExpired (parametrized) ---------------------------------------

const mkJwt = (expOffsetSec) =>
  "h." +
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString("base64") +
  ".s";

test("isJwtExpired default: missing token is NOT expired", () => {
  assert.equal(isJwtExpired(null), false);
  assert.equal(isJwtExpired(undefined), false);
});

test("isJwtExpired treatMissingAsExpired: missing token IS expired", () => {
  assert.equal(isJwtExpired(null, { treatMissingAsExpired: true }), true);
  assert.equal(isJwtExpired("garbage", { treatMissingAsExpired: true }), true);
});

test("isJwtExpired honors skewSeconds", () => {
  const t = mkJwt(60); // expires in 60s
  assert.equal(isJwtExpired(t, { skewSeconds: 30 }), false); // 60 > 30 → valid
  assert.equal(isJwtExpired(t, { skewSeconds: 300 }), true); // 60 < 300 → expired proactively
});

test("isJwtExpired: a long-lived token is never expired", () => {
  assert.equal(isJwtExpired(mkJwt(3600)), false);
});

// --- endpoint resolution from JWT `aud` ------------------------------------

const mkTok = (payload) =>
  "h." + Buffer.from(JSON.stringify(payload)).toString("base64") + ".s";

test("getEndpointFromTokenAllowExpired reads the `aud` claim (string)", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(mkTok({ aud: "https://x.meter.skillbench.ai" })),
    "https://x.meter.skillbench.ai"
  );
});

test("`aud` may be an array; the first http(s) URL wins", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(mkTok({ aud: ["skillbench", "https://x.meter.ai"] })),
    "https://x.meter.ai"
  );
});

test("ignores the legacy telemetry_endpoint claim — `aud` only", () => {
  // No aud URL → null even when a legacy telemetry_endpoint is present.
  assert.equal(
    getEndpointFromTokenAllowExpired(mkTok({ aud: "just-an-audience", telemetry_endpoint: "https://legacy.meter.ai" })),
    null
  );
});

test("returns null when no `aud` URL is present", () => {
  assert.equal(getEndpointFromTokenAllowExpired(mkTok({ sub: "x" })), null);
  assert.equal(getEndpointFromTokenAllowExpired(null), null);
});

// --- hook dispatch registry ↔ hooks.json contract --------------------------

test("every hook.js-dispatched event has a matching registry mapper", () => {
  const registry = require("../scripts/lib/hook-registry");
  const hooks = require("../hooks/hooks.json").hooks;

  const dispatched = [];
  for (const [event, entries] of Object.entries(hooks)) {
    const cmd = entries[0].hooks[0].command;
    const m = cmd.match(/hook\.js (\w+)/);
    if (m) dispatched.push([event, m[1]]);
  }

  assert.ok(dispatched.length >= 15, "expected many events routed through hook.js");
  for (const [event, arg] of dispatched) {
    assert.equal(event, arg, `hooks.json event ${event} must pass its own name`);
    assert.equal(
      typeof registry[arg],
      "function",
      `registry is missing a mapper for ${arg}`
    );
  }

  // No orphan registry entries (every mapper is wired in hooks.json).
  const referenced = new Set(dispatched.map((d) => d[1]));
  for (const key of Object.keys(registry)) {
    assert.ok(referenced.has(key), `registry mapper ${key} is not wired in hooks.json`);
  }
});

test("registry mappers return an object and can use ctx", () => {
  const registry = require("../scripts/lib/hook-registry");
  const ctx = { getTranscriptId: (p) => (p ? require("path").basename(p) : "") };
  assert.deepEqual(
    registry.WorktreeCreate({ worktree_name: "wt", worktree_path: "/p" }),
    { worktree_name: "wt", worktree_path: "/p" }
  );
  assert.equal(
    registry.SubagentStop({ agent_transcript_path: "/x/y-uuid.jsonl" }, ctx).agent_transcript_path,
    "y-uuid.jsonl"
  );
});

test("newly added events map their documented fields", () => {
  const registry = require("../scripts/lib/hook-registry");
  assert.deepEqual(registry.Setup({ setup_type: "init" }), { setup_type: "init" });
  assert.deepEqual(registry.CwdChanged({ path: "/a/b" }), { path: "/a/b" });
  assert.equal(registry.Elicitation({ server: "s", tool_name: "t", tool_input: {} }).server, "s");
  // user_response must NOT be captured (privacy)
  assert.ok(!("user_response" in registry.ElicitationResult({ server: "s", user_response: { x: 1 } })));
});

test("MessageDisplay logs only the final chunk, ids only (no delta)", () => {
  const registry = require("../scripts/lib/hook-registry");
  // non-final chunk → null → runHook skips logging
  assert.equal(
    registry.MessageDisplay({ turn_id: "t", message_id: "m", index: 0, final: false, delta: "hi" }),
    null
  );
  // final chunk → message_id only; delta/index/turn_id not in the mapper output
  // (turn_id is added by logger's central fields)
  const out = registry.MessageDisplay({ turn_id: "t", message_id: "m", index: 3, final: true, delta: "x" });
  assert.deepEqual(out, { message_id: "m" });
});

test("corrected field names match the current hook schema", () => {
  const registry = require("../scripts/lib/hook-registry");
  assert.equal(registry.StopFailure({ error_type: "rate_limit" }).error_type, "rate_limit");
  assert.equal(registry.TeammateIdle({ agent_type: "Explore" }).agent_type, "Explore");
  assert.equal(registry.ConfigChange({ config_source: "user_settings" }).config_source, "user_settings");
  assert.equal(registry.TaskCompleted({ completion_status: "done" }).completion_status, "done");
});
