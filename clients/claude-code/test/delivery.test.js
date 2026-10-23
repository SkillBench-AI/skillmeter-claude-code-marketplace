"use strict";

// Delivery without a background monitor. Real hook entrypoints run as separate
// processes and Stop/SessionStart launch the real detached drain, which uploads
// to a loopback collector. Only the clock can be moved forward, for every
// process at once, so the per-chunk backoff can elapse without waiting.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const {
  makeJwt,
  makeTempDir,
  writeCredentials,
  writeFile,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "acme";
const REPO_KEY = `github.com/${ORG}/widgets`;

// Loopback collector. `status` is what it answers; every request is recorded.
async function collector() {
  const requests = [];
  const state = { status: 202 };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => {
      let body = Buffer.concat(parts);
      if (/gzip/.test(req.headers["content-encoding"] || "")) body = zlib.gunzipSync(body);
      const lines = body.toString().split("\n").filter(Boolean).map(JSON.parse);
      requests.push({ path: req.url, status: state.status, headers: req.headers, lines });
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const accepted = (suffix) =>
    requests.filter((r) => r.status < 300 && r.path === `/logs/claude${suffix}`);
  return {
    url,
    state,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
    // Hook names of every event the collector accepted.
    events: () => accepted("").flatMap((r) => r.lines.map((e) => e.hook_event_name)),
    // Transcript uuids the collector accepted, in arrival order.
    transcript: () => accepted("/transcript").flatMap((r) => r.lines.map((l) => l.uuid)),
  };
}

function fixture(collectorUrl) {
  const root = makeTempDir("skm-delivery-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "repo");
  writeFile(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/${ORG}/widgets.git\n`);
  writeCredentials(state, {
    device_id: "11111111-2222-4333-8444-555555555555",
    hash_salt: "0123456789abcdef0123456789abcdef",
    // Valid well past any clock shift below, so no refresh is attempted.
    license_jwt: makeJwt({
      sub: "test-tenant", broker_sub: "test-user", org: { login: ORG }, orgs: [ORG],
      aud: "https://acme.meter.skillbench.example",
      exp: Math.floor(Date.now() / 1000) + 6 * 3600,
    }),
  }, { dataDir: data });
  writeTelemetryPolicy(state, { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });

  const preload = path.join(root, "clock.cjs");
  writeFile(preload, `
const offset = Number(process.env.TEST_CLOCK_OFFSET_MS || 0);
const realNow = Date.now;
Date.now = () => realNow() + offset;
`);
  const transcript = path.join(root, "session.jsonl");
  let offsetMs = 0;
  const env = () => ({
    ...process.env,
    HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: "/dev/null",
    SKILLMETER_STATE_DIR: state,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_ROOT: path.resolve(SCRIPTS, ".."),
    SKILLMETER_BACKEND_URL: collectorUrl,
    // Nothing may reach a real service.
    SKILLMETER_ACTIVATE_URL: "http://127.0.0.1:9/activate",
    SKILLMETER_BROKER_URL: "http://127.0.0.1:9",
    NODE_OPTIONS: `--require=${preload}`,
    TEST_CLOCK_OFFSET_MS: String(offsetMs),
  });

  function run(script, args, input) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
        cwd: repo, env: env(), stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdout.resume();
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end(JSON.stringify({ session_id: "delivery-session", cwd: repo, ...input }));
    });
  }

  const lockFile = path.join(data, "logs", ".drain-once.lock");
  // A spawned drain holds this lock until it has finished sending.
  async function drained(predicate = () => true, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(lockFile) && predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("drain did not finish in time");
  }

  let turn = 0;
  // One user turn: a prompt, a tool call, two transcript records, then Stop.
  async function turnOf(label) {
    turn++;
    for (const [hook, input] of [
      ["UserPromptSubmit", { prompt: `${label} prompt` }],
      ["PostToolUse", { tool_name: "Read", tool_input: { file_path: "README.md" } }],
    ]) {
      const r = await run("hook.js", [hook], input);
      assert.equal(r.status, 0, r.stderr);
    }
    fs.appendFileSync(transcript, [
      { type: "user", uuid: `${label}-u`, message: { content: `${label} prompt` } },
      { type: "assistant", uuid: `${label}-a`, message: { content: `${label} answer` } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const stop = await run("stop.js", [], { transcript_path: transcript, last_assistant_message: `${label} answer` });
    assert.equal(stop.status, 0, stop.stderr);
    return stop;
  }

  function queued() {
    const root = path.join(data, "logs", "repositories");
    if (!fs.existsSync(root)) return [];
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/^events\.jsonl\.\d+$/.test(entry.name) || /\.jsonl$/.test(entry.name) && dir.endsWith("chunks")) out.push(p);
      }
    };
    walk(root);
    return out;
  }

  return {
    run, turnOf, drained, queued,
    advance(ms) { offsetMs += ms; },
    sessionStart: () => run("session_start.js", [], { source: "startup" }),
    sessionEnd: () => run("session_end.js", [], { transcript_path: transcript, reason: "exit" }),
  };
}

test("a turn's events and transcript reach the collector with no monitor", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url);

  assert.match((await f.turnOf("one")).stderr, /Drain trigger spawned/);
  await f.drained(() => c.transcript().length > 0);

  assert.deepEqual(c.events(), ["UserPromptSubmit", "PostToolUse", "Stop"]);
  assert.deepEqual(c.transcript(), ["one-u", "one-a"]);
  assert.deepEqual(f.queued(), [], "nothing is left waiting for a later retry");
});

test("every turn is delivered by its own Stop, transcript continuing from the cursor", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url);

  for (const label of ["one", "two", "three"]) {
    await f.turnOf(label);
    await f.drained(() => c.transcript().includes(`${label}-a`));
  }
  assert.deepEqual(c.transcript(), ["one-u", "one-a", "two-u", "two-a", "three-u", "three-a"]);
  assert.equal(c.events().filter((e) => e === "Stop").length, 3);
  assert.deepEqual(f.queued(), []);
});

test("after an outage, the next turn's Stop delivers what the failed turn left", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url);

  c.state.status = 503;
  await f.turnOf("one");
  await f.drained(() => c.requests.some((r) => r.path === "/logs/claude/transcript"));
  assert.deepEqual(c.events(), []);
  assert.ok(f.queued().length >= 2, "the failed turn's events and transcript stay queued");

  // The collector is back, and the failed chunk's 1-minute backoff has passed.
  c.state.status = 202;
  f.advance(61_000);
  await f.turnOf("two");
  await f.drained(() => c.transcript().includes("two-a") && c.transcript().includes("one-a"));

  assert.deepEqual(c.events().sort(), ["PostToolUse", "PostToolUse", "Stop", "Stop", "UserPromptSubmit", "UserPromptSubmit"]);
  assert.deepEqual(c.transcript(), ["one-u", "one-a", "two-u", "two-a"]);
  assert.deepEqual(f.queued(), []);
});

test("a session that ends during an outage is delivered by the next session start", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url);

  c.state.status = 503;
  await f.turnOf("one");
  await f.drained(() => c.requests.length > 0);
  assert.equal((await f.sessionEnd()).status, 0);
  await f.drained();
  assert.ok(f.queued().length >= 2);

  c.state.status = 202;
  f.advance(5 * 60_000);
  const start = await f.sessionStart();
  assert.equal(start.status, 0, start.stderr);
  await f.drained(() => c.transcript().includes("one-a"));

  assert.ok(c.events().includes("UserPromptSubmit") && c.events().includes("Stop"));
  assert.deepEqual(c.transcript(), ["one-u", "one-a"]);
  assert.deepEqual(f.queued(), []);
});
