"use strict";
// Invoked only by the local contract runner, never through installed hooks.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const root = process.argv[2];
const url = process.argv[3];
if (!url.startsWith("http://127.0.0.1:")) throw Error("localhost collector required");
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
const appendMode = process.argv[4] === "append";
const repo = path.join(root, "repo");
const source = path.join(root, "synthetic.jsonl");
const expectedFile = path.join(root, "expected.jsonl");
const repeated = {
  type: "response_item",
  timestamp: "2026-09-04T12:00:02Z",
  payload: {
    type: "message", role: "user",
    content: [{ type: "input_text", text: "A real repeated synthetic request" }],
  },
};

function initializeFixture() {
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/synthetic/repo.git"]);
  fs.mkdirSync(path.join(root, ".skillbench"));
  const claims = { sub: "synthetic-tenant", broker_sub: "synthetic-user", org: { login: "synthetic" }, orgs: ["synthetic"], exp: 4102444800 };
  const jwt = "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture";
  fs.writeFileSync(path.join(root, ".skillbench/credentials.json"), JSON.stringify({
    device_id: "SYNTHETIC-DEVICE", hash_salt: "fixture-salt",
  }));
  fs.mkdirSync(path.join(root, ".skillbench/clients/codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".skillbench/clients/codex/session.json"), JSON.stringify({
    license_jwt: jwt, refresh_token: "synthetic-refresh",
  }));
  const fixture = process.argv[4] || path.join(__dirname, "../test/fixtures/codex-m0.jsonl");
  const records = fs.readFileSync(fixture, "utf8").trim().split("\n").map(JSON.parse);
  // Synthetic canaries have independently specified expectations in Python.
  records[0].payload.contact = "fixture.person@example.net";
  records[0].payload.api_key = "synthetic-credential-012345";
  for (const record of records) {
    if (record.payload?.cwd) record.payload.cwd = repo;
  }
  records.push(repeated, repeated);
  fs.writeFileSync(source, records.map(JSON.stringify).join("\n") + "\n");
}

if (!appendMode) initializeFixture();
// Load after setting the isolated home and synthetic credentials.
const logger = require("../scripts/logger");
const stage = () => logger.stageTranscriptForUpload(source, { cwd: repo });
const upload = file => logger.processPendingTranscript(file, "SYNTHETIC-DEVICE", url, 2000);
const realFetch = global.fetch;

async function appendAndRecover() {
  const continuation = {
    ...repeated,
    payload: { ...repeated.payload, content: [{ type: "input_text", text: "Synthetic multi-day continuation" }] },
  };
  fs.appendFileSync(source, JSON.stringify(continuation) + "\n");
  const file = stage();
  if (!file) throw Error("append did not stage");
  let expected = fs.readFileSync(expectedFile);
  const attempts = [];
  global.fetch = async (target, options) => {
    const response = await realFetch(target, options);
    const seq = options.headers["X-Chunk-Seq"];
    const reset = options.headers["X-Chunk-Reset"];
    attempts.push({ seq, reset, status: response.status });
    if (response.ok) {
      const bytes = zlib.gunzipSync(options.body);
      expected = seq === reset ? bytes : Buffer.concat([expected, bytes]);
    }
    return response;
  };
  await upload(file);
  if (logger.listPendingTranscripts().length) throw Error("resume queue did not drain");
  fs.writeFileSync(expectedFile, expected);
  console.log(JSON.stringify({ attempts }));
}

async function uploadWithLostResponse() {
  const first = stage();
  if (!first) throw Error("no chunk");
  const initial = zlib.gunzipSync(fs.readFileSync(first));
  const attempts = [];
  global.fetch = async (target, options) => {
    attempts.push({
      headers: options.headers,
      seq: options.headers["X-Chunk-Seq"], reset: options.headers["X-Chunk-Reset"],
      body: Buffer.from(options.body).toString("base64"),
    });
    return realFetch(target, options);
  };
  const lost = await upload(first);
  if (lost !== "retry" || !fs.existsSync(first)) throw Error("response-loss retention failed");
  const next = {
    ...repeated,
    payload: {
      ...repeated.payload, role: "assistant",
      content: [{ type: "output_text", text: "Synthetic continuation after lost response" }],
    },
  };
  fs.appendFileSync(source, JSON.stringify(next) + "\n");
  const second = stage();
  const expected = Buffer.concat([initial, zlib.gunzipSync(fs.readFileSync(second))]);
  await upload(first);
  if (logger.listPendingTranscripts().length) throw Error("queue did not drain");
  if (JSON.stringify(attempts[0]) !== JSON.stringify(attempts[1])) throw Error("retry mutated request");
  fs.writeFileSync(expectedFile, expected);
  // Retained only in the temporary fixture directory for delayed replay.
  fs.writeFileSync(path.join(root, "stale-request.json"), JSON.stringify(attempts.at(-1)));
  fs.writeFileSync(path.join(root, "attempts.json"), JSON.stringify(attempts.map(({ seq, reset }) => ({ seq, reset }))));
  console.log(JSON.stringify({ records: expected.toString().trim().split("\n").length, attempts: attempts.map(a => a.seq) }));
}

(appendMode ? appendAndRecover() : uploadWithLostResponse()).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { global.fetch = realFetch; });
