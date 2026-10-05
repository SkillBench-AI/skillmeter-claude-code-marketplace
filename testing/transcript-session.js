"use strict";

// A Claude Code session driven through the real hook entrypoints, each a
// separate process, with Stop launching the real detached drain against a
// loopback collector. For tests of which transcript lines are sent, live or by
// an accepted history import.

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const { makeJwt, makeTempDir, writeCredentials, writeFile, writeTelemetryPolicy } = require("./helpers");

const SCRIPTS = path.resolve(__dirname, "../skillmeter/scripts");
const ORG = "acme";
const REPO_KEY = `github.com/${ORG}/widgets`;
const IDENTITY = {
  device_id: "11111111-2222-4333-8444-555555555555",
  hash_salt: "0123456789abcdef0123456789abcdef",
};
const SESSION_ID = "5e551011-0000-4000-8000-000000000001";

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

const license = (orgs) => makeJwt({
  sub: "test-tenant", broker_sub: "test-user", org: { login: ORG }, orgs,
  aud: "https://acme.meter.skillbench.example",
  exp: Math.floor(Date.now() / 1000) + 6 * 3600,
});

// `orgs` are the license's organizations; `signedIn: false` starts without a
// license. `history` is what a resumed session's transcript already holds.
function session(collectorUrl, { orgs = [ORG], policy, history = [], signedIn = true }) {
  const root = makeTempDir("skm-transcript-session-");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const repo = path.join(root, "repo");
  writeFile(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/${ORG}/widgets.git\n`);
  // A directory in no repository, for a hook the session runs from there.
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const signIn = () => writeCredentials(state, { ...IDENTITY, license_jwt: license(orgs) }, { dataDir: data });
  const signOut = () => writeCredentials(state, { ...IDENTITY, signed_out: true }, { dataDir: data });
  if (signedIn) signIn();
  else writeCredentials(state, IDENTITY, { dataDir: data });
  writeTelemetryPolicy(state, policy);

  // Where Claude Code keeps it, so a history import finds it.
  const claude = path.join(root, "claude");
  const transcript = path.join(claude, "projects", "repo", `${SESSION_ID}.jsonl`);
  const append = (records) => fs.appendFileSync(transcript,
    records.map((r) => JSON.stringify({ ...r, cwd: repo }) + "\n").join(""));
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  append(history);

  const env = {
    ...process.env,
    HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: "/dev/null",
    SKILLMETER_STATE_DIR: state,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_CONFIG_DIR: claude,
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
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ session_id: SESSION_ID, cwd: repo, transcript_path: transcript, ...input }));
    });
  }
  async function script(name, args) {
    const r = await run(name, args, {});
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
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

  const queue = path.join(data, "logs", "repositories",
    crypto.createHmac("sha256", IDENTITY.hash_salt).update(REPO_KEY).digest("hex").slice(0, 12));
  // The repository's event log, the file a hook writes before anything else.
  const eventLog = path.join(queue, "events.jsonl");
  // Put a file where a directory belongs, so nothing can be written inside it,
  // as a stale file or a failing disk would.
  const block = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, "");
  };

  return {
    drained,
    signIn,
    signOut,
    setPolicy: (next) => writeTelemetryPolicy(state, next),
    // Make the event write fail, as a full disk would, and undo it.
    breakEventLog: () => { fs.rmSync(eventLog, { force: true }); fs.mkdirSync(eventLog, { recursive: true }); },
    repairEventLog: () => fs.rmSync(eventLog, { recursive: true, force: true }),
    // Make the signed-out mark, or the repository's transcript cursor, fail
    // to be written.
    blockSignedOutMarks: () => block(path.join(data, "logs", "unlicensed-transcripts")),
    blockCursors: () => block(path.join(queue, "transcripts", "cursors")),
    // Make the transcript unreadable to hooks while it is still written, and
    // readable again.
    hideTranscript: () => fs.chmodSync(transcript, 0o200),
    showTranscript: () => fs.chmodSync(transcript, 0o600),
    // The session closing. SessionEnd carries no prompt id.
    async sessionEnd(reason = "exit") {
      const r = await run("session_end.js", [], { reason });
      assert.equal(r.status, 0, r.stderr);
    },
    async sessionStart(source) {
      const r = await run("session_start.js", [], { source });
      assert.equal(r.status, 0, r.stderr);
    },
    // One user turn. The prompt hook runs in the background, so the prompt
    // can already be in the transcript when it reads it. `during` runs
    // between the prompt and the answer.
    async turn(label, { during } = {}) {
      append([{ type: "user", uuid: `${label}-u`, message: { content: `${label} prompt` } }]);
      const prompt = await run("hook.js", ["UserPromptSubmit"], { prompt: `${label} prompt` });
      assert.equal(prompt.status, 0, prompt.stderr);
      if (during) await during();
      append([{ type: "assistant", uuid: `${label}-a`, message: { content: `${label} answer` } }]);
      const stop = await run("stop.js", [], { last_assistant_message: `${label} answer` });
      assert.equal(stop.status, 0, stop.stderr);
    },
    // A tool hook from a directory outside any repository.
    async toolOutsideRepository() {
      const r = await run("hook.js", ["PostToolUse"], {
        cwd: outside, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {},
      });
      assert.equal(r.status, 0, r.stderr);
    },
    // Accept the one-time history import for this repository, from another
    // session, and wait until its upload has finished.
    async importHistory() {
      const lifecycle = "44444444-4444-4444-8444-444444444444";
      fs.writeFileSync(path.join(data, "backfill-state.json"), JSON.stringify({
        schema_version: 1, lifecycle_id: lifecycle, status: "pending",
        reason: "one_time_offer", created_at: Date.now(), updated_at: Date.now(),
      }));
      const offer = await script("backfill.js", ["claim", lifecycle, "33333333-3333-4333-8333-333333333333"]);
      const listed = await script("repository_telemetry.js", ["list"]);
      const target = listed.repositories.find((r) => r.repoKey === REPO_KEY || r.displayName === `@${ORG}/widgets`);
      assert.ok(target, "the repository is offered");
      const accepted = await script("backfill.js",
        ["accept", lifecycle, offer.offerId, String(listed.revision), ORG, target.id]);
      assert.equal(accepted.started, true);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const status = await script("backfill.js", ["status", lifecycle]);
        if (status.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await drained(() => true);
    },
  };
}

// A resumed session's transcript: the conversation it continues.
const HISTORY = [
  { type: "user", uuid: "before-u", message: { content: "from before this session" } },
  { type: "assistant", uuid: "before-a", message: { content: "from before this session" } },
];

module.exports = { ORG, REPO_KEY, HISTORY, collector, session };
