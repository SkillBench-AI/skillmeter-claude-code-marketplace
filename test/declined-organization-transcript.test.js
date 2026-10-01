"use strict";

// A license covers two organizations and the user turned one off. Capture is
// allowed for a repository of the other one, but sending needs every licensed
// organization, so nothing is recorded. Content from that period must not be
// sent once the organization is turned on, as for any period that was not
// recorded. Real hook entrypoints run as separate processes; Stop launches the
// real detached drain, which uploads to a loopback collector.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { makeJwt, makeTempDir, writeCredentials, writeFile, writeTelemetryPolicy } = require("../testing/helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "acme";
const OTHER = "beta";
const REPO_KEY = `github.com/${ORG}/widgets`;

// Loopback collector; records the transcript uuids it accepted.
async function collector() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => {
      let body = Buffer.concat(parts);
      if (/gzip/.test(req.headers["content-encoding"] || "")) body = zlib.gunzipSync(body);
      const lines = body.toString().split("\n").filter(Boolean).map(JSON.parse);
      requests.push({ path: req.url, lines });
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    transcript: () => requests
      .filter((r) => r.path === "/logs/claude/transcript")
      .flatMap((r) => r.lines.map((l) => l.uuid)),
  };
}

function fixture(collectorUrl, { orgs, policy, history = [] }) {
  const root = makeTempDir("skm-declined-org-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "repo");
  writeFile(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/${ORG}/widgets.git\n`);
  writeCredentials(state, {
    device_id: "11111111-2222-4333-8444-555555555555",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      sub: "test-tenant", broker_sub: "test-user", org: { login: ORG }, orgs,
      aud: "https://acme.meter.skillbench.example",
      exp: Math.floor(Date.now() / 1000) + 6 * 3600,
    }),
  }, { dataDir: data });
  writeTelemetryPolicy(state, policy);

  // A resumed session's transcript already holds the conversation it continues.
  const transcript = path.join(root, "session.jsonl");
  fs.writeFileSync(transcript, history.map((l) => JSON.stringify(l) + "\n").join(""));

  const env = {
    ...process.env,
    HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: "/dev/null",
    SKILLMETER_STATE_DIR: state,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_ROOT: path.resolve(SCRIPTS, ".."),
    SKILLMETER_BACKEND_URL: collectorUrl,
    // Nothing may reach a real service.
    SKILLMETER_ACTIVATE_URL: "http://127.0.0.1:9/activate",
    SKILLMETER_BROKER_URL: "http://127.0.0.1:9",
  };

  function run(script, args, input) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
        cwd: repo, env, stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdout.resume();
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end(JSON.stringify({ session_id: "declined-org", cwd: repo, transcript_path: transcript, ...input }));
    });
  }

  const lockFile = path.join(data, "logs", ".drain-once.lock");
  // A spawned drain holds this lock until it has finished sending.
  async function drained(predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(lockFile) && predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("drain did not finish in time");
  }

  // The repository's event log, the file a hook writes before anything else.
  const eventLog = path.join(data, "logs", "repositories",
    crypto.createHmac("sha256", "0123456789abcdef0123456789abcdef").update(REPO_KEY).digest("hex").slice(0, 12),
    "events.jsonl");

  return {
    drained,
    // Make the event write fail, as a full disk would, and undo it.
    breakEventLog: () => { fs.rmSync(eventLog, { force: true }); fs.mkdirSync(eventLog, { recursive: true }); },
    repairEventLog: () => fs.rmSync(eventLog, { recursive: true, force: true }),
    setPolicy: (next) => writeTelemetryPolicy(state, next),
    async sessionStart(source) {
      const r = await run("session_start.js", [], { source });
      assert.equal(r.status, 0, r.stderr);
    },
    // One user turn: a prompt, two transcript records, then Stop.
    async turn(label) {
      const prompt = await run("hook.js", ["UserPromptSubmit"], { prompt: `${label} prompt` });
      assert.equal(prompt.status, 0, prompt.stderr);
      fs.appendFileSync(transcript, [
        { type: "user", uuid: `${label}-u`, message: { content: `${label} prompt` } },
        { type: "assistant", uuid: `${label}-a`, message: { content: `${label} answer` } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n");
      const stop = await run("stop.js", [], { last_assistant_message: `${label} answer` });
      assert.equal(stop.status, 0, stop.stderr);
    },
  };
}

const BOTH_ENABLED = { orgs: { [ORG]: true, [OTHER]: true }, repositories: { [REPO_KEY]: true } };
const OTHER_OFF = { orgs: { [ORG]: true, [OTHER]: false }, repositories: { [REPO_KEY]: true } };
const HISTORY = [
  { type: "user", uuid: "before-u", message: { content: "from before this session" } },
  { type: "assistant", uuid: "before-a", message: { content: "from before this session" } },
];

test("turns from while another licensed organization was off are not sent once it is on", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url, { orgs: [ORG, OTHER], policy: OTHER_OFF });

  await f.sessionStart("startup");
  await f.turn("off-1");
  await f.turn("off-2");
  assert.deepEqual(c.transcript(), [], "nothing is sent while the other organization is off");

  f.setPolicy(BOTH_ENABLED);
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

test("a resumed session does not send what came before it, once the other organization is on", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url, { orgs: [ORG, OTHER], policy: OTHER_OFF, history: HISTORY });

  await f.sessionStart("resume");
  await f.turn("off");

  f.setPolicy(BOTH_ENABLED);
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

// The baseline the two tests above rely on: a session that records normally
// never sends what its transcript held before it started.
test("a resumed session that records normally sends only its own turns", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url, { orgs: [ORG, OTHER], policy: BOTH_ENABLED, history: HISTORY });

  await f.sessionStart("resume");
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

test("an organization chosen later still sends the turns after the choice", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url, { orgs: [ORG], policy: { repositories: { [REPO_KEY]: true } } });

  await f.sessionStart("startup");
  await f.turn("pending");
  assert.deepEqual(c.transcript(), []);

  f.setPolicy({ orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  await f.turn("on-1");
  await f.drained(() => c.transcript().includes("on-1-a"));
  await f.turn("on-2");
  await f.drained(() => c.transcript().includes("on-2-a"));
  assert.deepEqual(c.transcript(), ["on-1-u", "on-1-a", "on-2-u", "on-2-a"]);
});

// Only a refusal to send moves the cursor. A turn whose event could not be
// written was allowed, and its transcript goes with the next turn.
test("a turn whose event could not be written is still sent with the next turn", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = fixture(c.url, { orgs: [ORG, OTHER], policy: BOTH_ENABLED });

  await f.sessionStart("startup");
  await f.turn("first");
  await f.drained(() => c.transcript().includes("first-a"));

  f.breakEventLog();
  await f.turn("unwritten");
  f.repairEventLog();
  await f.turn("next");
  await f.drained(() => c.transcript().includes("next-a"));
  assert.deepEqual(c.transcript(), ["first-u", "first-a", "unwritten-u", "unwritten-a", "next-u", "next-a"]);
});
