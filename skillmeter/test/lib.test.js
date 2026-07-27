"use strict";

// Regression coverage for the shared leaf helpers introduced by the E-series
// dedup (lib/io.js) and the parametrized jwt expiry check (lib/jwt.js).
// Run: node --test skillmeter/test/lib.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  makeTempDir,
  makeJwt,
  setTestEnv,
  writeFile,
} = require("../testing/helpers");

setTestEnv("SKILLMETER_BACKEND_URL", undefined);

const io = require("../scripts/lib/io");
const {
  isJwtExpired,
  getEndpointFromTokenAllowExpired,
  getLicenseAudiences,
} = require("../scripts/lib/jwt");

// --- io.safeReadJson -------------------------------------------------------

test("safeReadJson returns parsed content for valid JSON", () => {
  const d = makeTempDir("skm-lib-");
  const f = path.join(d, "x.json");
  writeFile(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(io.safeReadJson(f), { a: 1 });
});

test("safeReadJson returns the fallback on missing/malformed file", () => {
  const d = makeTempDir("skm-lib-");
  assert.equal(io.safeReadJson(path.join(d, "nope.json")), null);
  assert.deepEqual(io.safeReadJson(path.join(d, "nope.json"), {}), {});
  const bad = path.join(d, "bad.json");
  writeFile(bad, "{not json");
  assert.deepEqual(io.safeReadJson(bad, { fb: true }), { fb: true });
});

// --- io.atomicWriteJson ----------------------------------------------------

test("atomicWriteJson writes JSON that safeReadJson round-trips", () => {
  const d = makeTempDir("skm-lib-");
  const f = path.join(d, "nested", "out.json");
  io.atomicWriteJson(f, { hello: "world" });
  assert.deepEqual(io.safeReadJson(f), { hello: "world" });
});

// --- io.findGitRoot --------------------------------------------------------

test("findGitRoot walks up to the .git marker and handles empty input", () => {
  const d = makeTempDir("skm-lib-");
  const nested = path.join(d, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(d, ".git"));
  // findGitRoot uses path.resolve (not realpath), matching how the callers pass
  // cwd through; compare against the resolved dir, not its symlink-resolved form.
  assert.equal(io.findGitRoot(nested), path.resolve(d));
  assert.equal(io.findGitRoot(""), "");
});

// --- jwt.isJwtExpired (parametrized) ---------------------------------------

const expiringJwt = (expOffsetSec) =>
  makeJwt({ exp: Math.floor(Date.now() / 1000) + expOffsetSec });

test("isJwtExpired default: missing token is NOT expired", () => {
  assert.equal(isJwtExpired(null), false);
  assert.equal(isJwtExpired(undefined), false);
});

test("isJwtExpired treatMissingAsExpired: missing token IS expired", () => {
  assert.equal(isJwtExpired(null, { treatMissingAsExpired: true }), true);
  assert.equal(isJwtExpired("garbage", { treatMissingAsExpired: true }), true);
});

test("isJwtExpired honors skewSeconds", () => {
  const t = expiringJwt(60); // expires in 60s
  assert.equal(isJwtExpired(t, { skewSeconds: 30 }), false); // 60 > 30 → valid
  assert.equal(isJwtExpired(t, { skewSeconds: 300 }), true); // 60 < 300 → expired proactively
});

test("isJwtExpired: a long-lived token is never expired", () => {
  assert.equal(isJwtExpired(expiringJwt(3600)), false);
});

// --- endpoint resolution from JWT `aud` ------------------------------------

test("getEndpointFromTokenAllowExpired reads the `aud` claim (string)", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(makeJwt({ aud: "https://x.meter.skillbench.ai" })),
    "https://x.meter.skillbench.ai"
  );
});

test("`aud` may be an array; the first http(s) URL wins", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(makeJwt({ aud: ["skillbench", "https://x.meter.ai"] })),
    "https://x.meter.ai"
  );
});

test("ignores the legacy telemetry_endpoint claim — `aud` only", () => {
  // No aud URL → null even when a legacy telemetry_endpoint is present.
  assert.equal(
    getEndpointFromTokenAllowExpired(
      makeJwt({ aud: "just-an-audience", telemetry_endpoint: "https://legacy.meter.ai" })
    ),
    null
  );
});

test("returns null when no `aud` URL is present", () => {
  assert.equal(getEndpointFromTokenAllowExpired(makeJwt({ sub: "x" })), null);
  assert.equal(getEndpointFromTokenAllowExpired(null), null);
});

test("getLicenseAudiences returns a stable sorted unique tenant identity", () => {
  const token = makeJwt({
    aud: ["https://b.example", "https://a.example", "https://b.example"],
  });
  assert.deepEqual(getLicenseAudiences(token), [
    "https://a.example",
    "https://b.example",
  ]);
});

// --- hook dispatch registry ↔ hooks.json contract --------------------------

test("every command hook uses exec form with a bundled script", () => {
  const hooks = require("../hooks/hooks.json").hooks;
  const pluginRoot = path.resolve(__dirname, "..");
  let commandHookCount = 0;

  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        if (hook.type !== "command") continue;
        commandHookCount += 1;

        assert.equal(hook.command, "node", `${event} must use node exec form`);
        assert.ok(Array.isArray(hook.args), `${event} must declare args`);
        assert.ok(hook.args.length > 0, `${event} args must include a script`);
        assert.ok(
          hook.args.every((arg) => typeof arg === "string"),
          `${event} args must contain only strings`
        );

        const prefix = "${CLAUDE_PLUGIN_ROOT}/";
        assert.ok(
          hook.args[0].startsWith(prefix),
          `${event} script must be relative to CLAUDE_PLUGIN_ROOT`
        );
        assert.ok(
          fs.existsSync(path.join(pluginRoot, hook.args[0].slice(prefix.length))),
          `${event} script must exist`
        );
      }
    }
  }

  assert.equal(commandHookCount, 28, "expected every configured hook command");
});

test("every hook.js-dispatched event has a matching registry mapper", () => {
  const registry = require("../scripts/lib/hook-registry");
  const hooks = require("../hooks/hooks.json").hooks;

  const dispatched = [];
  for (const [event, entries] of Object.entries(hooks)) {
    const hook = entries[0].hooks[0];
    if (hook.args[0].endsWith("/hook.js")) {
      assert.equal(hook.args.length, 2, `${event} must pass exactly one event`);
      dispatched.push([event, hook.args[1]]);
    }
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
  assert.equal(
    registry.SubagentStop({ agent_transcript_path: "/x/y-uuid.jsonl" }, ctx).agent_transcript_path,
    "y-uuid.jsonl"
  );
});

test("WorktreeCreate is not registered as an observation hook", () => {
  const registry = require("../scripts/lib/hook-registry");
  const hooks = require("../hooks/hooks.json").hooks;

  assert.equal(hooks.WorktreeCreate, undefined);
  assert.equal(registry.WorktreeCreate, undefined);
});

test("registry mappers match current official hook payload fixtures", () => {
  const registry = require("../scripts/lib/hook-registry");
  const { hookPayloadFixtures } = require("../testing/hook-payloads");

  for (const { event, input, expected } of hookPayloadFixtures) {
    assert.equal(typeof registry[event], "function", `${event} mapper exists`);
    assert.deepEqual(registry[event](input), expected, `${event} maps official fields`);
  }
});

test("registry mappers do not emit legacy hook field names", () => {
  const registry = require("../scripts/lib/hook-registry");
  const { hookPayloadFixtures } = require("../testing/hook-payloads");
  const legacyFields = new Set([
    "setup_type",
    "error_type",
    "error_message",
    "agent_type",
    "task_metadata",
    "completion_status",
    "config_source",
    "path",
    "server",
    "tool_name",
    "tool_input",
    "user_response",
    "custom_instructions",
  ]);

  for (const { event, input } of hookPayloadFixtures) {
    const output = registry[event](input);
    for (const field of legacyFields) {
      assert.ok(!(field in output), `${event} must not emit legacy field ${field}`);
    }
  }
});
