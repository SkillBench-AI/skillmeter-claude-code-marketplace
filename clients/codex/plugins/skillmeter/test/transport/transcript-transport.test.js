"use strict";
// Only synthetic files/credentials. Never consult the user's sessions.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-transport-"));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.PLUGIN_DATA = path.join(root, "data");
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;
delete process.env.SKILLMETER_BACKEND_URL;
const repo = path.join(root, "repo");
execFileSync("git", ["init", "--quiet", repo]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/synthetic/repo.git"]);
const { writeCredentials, sessionFileIn, consentPolicyFileIn, grantConsent } = require("../../test-support/plugin.cjs");
const stateDir = path.join(root, ".skillbench"), identityFile = path.join(stateDir, "credentials.json"), sessionFile = sessionFileIn(stateDir);
// A broker license: `broker_sub` is the user, `orgs` the repository scope.
const jwt = (user = "synthetic-user", exp = 4102444800, extra = {}) => "e30." + Buffer.from(JSON.stringify({ sub: "synthetic-tenant", broker_sub: user, org: { login: "synthetic" }, orgs: ["synthetic"], exp, aud: "https://synthetic.meter.skillbench.com", ...extra })).toString("base64url") + ".fixture";
const credentials = { device_id: "SYNTHETIC-DEVICE", hash_salt: "fixture-salt", license_jwt: jwt(), refresh_token: "synthetic-refresh" };
const save = patch => writeCredentials(root, { ...credentials, ...patch }, { stateDir });
const policyFile = consentPolicyFileIn(stateDir), repoKey = "github.com/synthetic/repo";
const snapshot = () => [identityFile, sessionFile].map(file => fs.readFileSync(file));
save({});
const logger = require("../../scripts/logger");
const queue = require("../../scripts/lib/transcript-delta");
const realFetch = global.fetch;
const source = path.join(root, "synthetic.jsonl");
const line = message => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: message } }) + "\n";
const stage = () => logger.stageTranscriptForUpload(source, { cwd: repo });
const upload = file => logger.processPendingTranscript(file, credentials.device_id, "https://collector.invalid/logs/codex", 1000);
beforeEach(() => {
  // Start each test with acknowledged organization and repository consent.
  save({}); fs.rmSync(logger.LOG_DIR, { recursive: true, force: true });
  grantConsent(stateDir, repoKey);
  fs.rmSync(path.join(repo, ".codex"), { recursive: true, force: true });
  logger.saveTelemetryOptIn(repo, true);
  fs.writeFileSync(source, "");
  logger.observeTranscriptConsent(source, repo);
  fs.appendFileSync(source, line("synthetic first message"));
  global.fetch = async () => assert.fail("unexpected network attempt");
});
after(() => { global.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }); });

for (const [name, change] of [
  ["global disable", () => logger.setTelemetryGloballyDisabled(true)],
  ["signout", () => save({ signed_out: true })],
  ["org removed from the license in another process", () => save({ license_jwt: jwt("synthetic-user", 4102444800, { orgs: [] }) })],
  ["changed user", () => save({ license_jwt: jwt("another-user") })],
  ["changed device", () => save({ device_id: "ANOTHER-DEVICE" })],
  ["expired token", () => save({ license_jwt: jwt("synthetic-user", 1) })],
  ["missing token", () => save({ license_jwt: "" })],
  ["project opt-out", () => { fs.mkdirSync(path.join(repo, ".codex"), { recursive: true }); fs.writeFileSync(path.join(repo, ".codex/settings.local.json"), '{"skillmeter":{"telemetry":false}}'); }],
  ["removed repository choice", () => {
    const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    delete policy.repositories[repoKey]; policy.revision++;
    fs.writeFileSync(policyFile, JSON.stringify(policy));
  }],
]) test(`${name} blocks queued upload without consuming it`, async () => {
  const file = stage(); assert.ok(file); change();
  assert.equal(await upload(file), "skip"); assert.equal(fs.existsSync(file), true);
  assert.equal(stage(), null);
});

test("token refresh for the same principal resumes pending chunks", async () => {
  const file = stage(); save({ license_jwt: jwt("synthetic-user", 4102444800, { jti: "rotated" }) });
  global.fetch = async (_, options) => { assert.equal(options.headers.Authorization, `Bearer ${jwt("synthetic-user", 4102444800, { jti: "rotated" })}`); return { ok: true }; };
  assert.equal(await upload(file), "sent"); assert.equal(fs.existsSync(file), false);
});

for (const status of [400, 401, 402, 403, 413, 429, 500]) test(`HTTP ${status} retains chunk and credentials without anonymous retry`, async () => {
  const file = stage(), before = snapshot(); let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status }; };
  const outcome = await upload(file);
  assert.equal(outcome, [401, 402, 403].includes(status) ? "auth" : "retry");
  assert.equal(logger.isLicenseRejected(), [401, 403].includes(status));
  assert.equal(calls, 1); assert.equal(fs.existsSync(file), true);
  assert.deepEqual(snapshot(), before);
});

test("scope is rechecked between each ordered chunk", async () => {
  const file = stage(); fs.appendFileSync(source, line("second")); stage(); let calls = 0;
  global.fetch = async () => { calls++; save({ license_jwt: jwt("synthetic-user", 4102444800, { orgs: [] }) }); return { ok: true }; };
  await upload(file); assert.equal(calls, 1); assert.equal(logger.listPendingTranscripts().length, 1);
});

test("raw turn-context scope prevents an old capture hint from collecting a moved session", () => {
  fs.writeFileSync(source, JSON.stringify({type: "session_meta", payload: {cwd: repo, id: "synthetic"}}) + "\n" + line("allowed"));
  assert.ok(stage());
  fs.appendFileSync(source, JSON.stringify({type: "turn_context", payload: {cwd: root}}) + "\n" + line("out of scope"));
  assert.equal(stage(), null);
  const pending = logger.listPendingTranscripts(); assert.equal(pending.length, 1);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(pending[0])), "diagnostic.json")));
  assert.equal(diagnostic.code, "source-scope-changed");
});

test("legacy snapshots remain untouched and never enter the sequenced queue", async () => {
  fs.mkdirSync(logger.TRANSCRIPTS_PENDING_DIR, { recursive: true });
  const legacy = path.join(logger.TRANSCRIPTS_PENDING_DIR, "legacy.jsonl"); fs.writeFileSync(legacy, line("retained"));
  const before = fs.readFileSync(legacy);
  assert.equal(await upload(legacy), "skip");
  assert.deepEqual(logger.listPendingTranscripts(), []); assert.deepEqual(fs.readFileSync(legacy), before);
});

for (const event of ["session_end", "interrupt"]) test(`${event} saves a hint under three seconds without reading transcript or doing network`, () => {
  const preload = path.join(root, "preload.cjs"), marker = path.join(root, "spawned");
  fs.writeFileSync(preload, `const fs=require('node:fs'); const read=fs.readFileSync; fs.readFileSync=function(p,...args){if(p===${JSON.stringify(source)})throw Error('hook read raw transcript');return read.call(this,p,...args)}; require('node:child_process').spawn=()=>{fs.writeFileSync(${JSON.stringify(marker)},'spawned');return {pid:123,unref(){}}};global.fetch=()=>{throw Error('hook network')};`);
  const start = Date.now();
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../../scripts", event + ".js")], {
    cwd: repo, env: process.env, input: JSON.stringify({ session_id: "synthetic", transcript_path: source, cwd: repo, reason: "other", turn_id: "synthetic-turn" }), encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(Date.now() - start < 3000); assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.readdirSync(logger.TRANSCRIPT_CAPTURES_DIR).filter(n => n.endsWith(".json")).length, 1);
  assert.equal(logger.listPendingTranscripts().length, 0);
});

test("shutdown fallback uses the cached session path without scanning the sessions tree", () => {
  assert.equal(logger.requestTranscriptCapture({ cwd: repo, session_id: "cached", transcript_path: source }), 1);
  assert.equal(logger.requestTranscriptCapture({ cwd: repo, session_id: "cached" }, { discover: false }), 1);
  logger.stageRequestedTranscripts(); assert.equal(logger.listPendingTranscripts().length, 1);
});

test("cleanup and dry-run inventory preserve old transcript copies", () => {
  const pending = path.join(logger.TRANSCRIPTS_PENDING_DIR, "old.jsonl");
  const poison = path.join(logger.POISON_DIR, "old.jsonl");
  for (const file of [pending, poison]) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, line("old synthetic")); fs.utimesSync(file, new Date(0), new Date(0)); }
  const before = [pending, poison].map(f => fs.readFileSync(f));
  logger.cleanupStaleFiles();
  const result = require("../../scripts/transcript_inventory").inventory(process.env.PLUGIN_DATA);
  const { sessions, ...summary } = result;
  assert.deepEqual(summary, {dryRun:true,legacyPending:1,legacyPoisonUnknownReason:1,chunkDiagnostics:{},downstream:"unknown"});
  assert.ok(sessions.every(s => s.failures.length === 0));
  assert.deepEqual([pending, poison].map(f => fs.readFileSync(f)), before);
});


test("missing server baseline requests a durable full reset and resumes", async () => {
  let file = stage(); global.fetch = async () => ({ok:true}); await upload(file);
  fs.appendFileSync(source, line("resumed after three days")); file = stage();
  const requests=[];
  global.fetch = async (_, options) => {
    requests.push(options);
    return requests.length === 1 ? {ok:false,status:409,json:async()=>({error:"transcript-baseline-missing"})} : {ok:true};
  };
  assert.equal(await upload(file), "sent");
  assert.deepEqual(requests.map(r=>[r.headers["X-Chunk-Seq"],r.headers["X-Chunk-Reset"]]), [["2","1"],["3","3"]]);
  assert.deepEqual(requests.map(r=>r.headers["X-Transcript-Protocol"]), ["chunks-v1", "chunks-v1"]);
  const records=require("node:zlib").gunzipSync(requests[1].body).toString().trim().split("\n");
  assert.equal(records.length, 2);
  assert.equal(logger.listPendingTranscripts().length, 0);
  assert.equal(fs.existsSync(file), true, "superseded immutable chunk retained");
});

test("unrelated 409 does not replay a full snapshot", async () => {
  const file=stage();let calls=0;
  global.fetch=async()=>{calls++;return {ok:false,status:409,json:async()=>({error:"unrelated-conflict"})}};
  assert.equal(await upload(file),"retry");assert.equal(calls,1);assert.equal(fs.existsSync(file),true);
});

test("reset request survives missing source and resumes when source returns", async () => {
  const file = stage(), raw = fs.readFileSync(source);
  fs.unlinkSync(source);
  global.fetch = async () => ({ok:false,status:409,json:async()=>({error:"transcript-baseline-missing"})});
  assert.equal(await upload(file), "reset-required");
  const dir = path.dirname(path.dirname(file));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "reset-request.json"))).baseline, 1);
  assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(source, raw);
  const replacement = stage();
  global.fetch = async (_, options) => {
    assert.equal(options.headers["X-Chunk-Seq"], "2");
    assert.equal(options.headers["X-Chunk-Reset"], "2");
    return {ok:true};
  };
  assert.equal(await upload(replacement), "sent");
  assert.equal(logger.listPendingTranscripts().length, 0);
});

test("consent revoked during a 409 prevents reset staging and upload", async () => {
  const file = stage(); let calls = 0;
  global.fetch = async () => {
    calls++; save({signed_out:true});
    return {ok:false,status:409,json:async()=>({error:"transcript-baseline-missing"})};
  };
  assert.equal(await upload(file), "reset-required");
  assert.equal(calls, 1);
  const cursor = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), "cursor.json")));
  assert.equal(cursor.seq, 1);
  assert.equal(fs.existsSync(file), true);
});

test("a corrupt queue does not block other authorized transcripts", async () => {
  stage();
  const secondSource = path.join(root, "second.jsonl");
  fs.writeFileSync(secondSource, "");
  logger.observeTranscriptConsent(secondSource, repo);
  fs.appendFileSync(secondSource, line("healthy second transcript"));
  logger.stageTranscriptForUpload(secondSource, { cwd: repo });
  const directories = queue.queueDirectories(logger.TRANSCRIPT_CHUNKS_DIR);
  const damaged = directories[0];
  const cursor = path.join(damaged, "cursor.json");
  const retained = queue.pendingFiles(damaged)[0];
  fs.writeFileSync(cursor, "invalid synthetic cursor");
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true }; };
  await logger.drainPendingTranscripts("https://collector.invalid/logs/codex", 1000);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(retained), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(damaged, "diagnostic.json"))).code, "queue-unavailable");
});

test("failed transcript upload counts as queued work for the retry monitor", async () => {
  const file = stage();
  global.fetch = async () => ({ ok: false, status: 503 });
  assert.equal(await logger.drainPendingTranscripts("https://collector.invalid/logs/codex", 1000), 1);
  assert.equal(fs.existsSync(file), true);
  global.fetch = async () => ({ ok: true });
  assert.equal(await logger.drainPendingTranscripts("https://collector.invalid/logs/codex", 1000), 1);
  assert.equal(await logger.drainPendingTranscripts("https://collector.invalid/logs/codex", 1000), 0);
});


test("successful transcript delivery clears the rejected-license marker", async () => {
  const file = stage();
  global.fetch = async () => ({ ok: false, status: 401 });
  assert.equal(await upload(file), "auth");
  assert.equal(logger.isLicenseRejected(), true);
  global.fetch = async () => ({ ok: true });
  assert.equal(await upload(file), "sent");
  assert.equal(logger.isLicenseRejected(), false);
});

test("chunk routing and authorization use one current credential snapshot", async () => {
  const file = stage();
  const rotated = jwt("synthetic-user", 4102444800, { jti: "new-token" });
  save({ license_jwt: rotated });
  global.fetch = async (url, options) => {
    assert.equal(url, "https://synthetic.meter.skillbench.com/logs/codex/transcript");
    assert.equal(options.headers.Authorization, `Bearer ${rotated}`);
    return { ok: true };
  };
  assert.equal(await logger.processPendingTranscript(file, credentials.device_id), "sent");
});

for (const changedPrincipal of [false, true]) test(`broker credential rotation ${changedPrincipal ? "blocks a different user" : "preserves the same user's queue"}`, async () => {
  const brokerToken = (user, jti) => jwt(user, 4102444800, { jti });
  save({ license_jwt: brokerToken("broker-user-a", "old") });
  fs.rmSync(logger.TRANSCRIPT_CHUNKS_DIR, {recursive:true,force:true});
  fs.writeFileSync(source, ""); logger.observeTranscriptConsent(source, repo);
  fs.appendFileSync(source, line("broker-scoped message"));
  const file = stage();
  assert.ok(file);
  const rotated = brokerToken(changedPrincipal ? "broker-user-b" : "broker-user-a", "new");
  save({ license_jwt: rotated });
  let calls = 0;
  global.fetch = async (_, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${rotated}`);
    return { ok: true };
  };
  assert.equal(await upload(file), changedPrincipal ? "skip" : "sent");
  assert.equal(calls, changedPrincipal ? 0 : 1);
  assert.equal(fs.existsSync(file), changedPrincipal);
});

test("combined drain honors an explicit transcript endpoint override", async () => {
  const file = stage();
  global.fetch = async (url) => {
    assert.equal(url, "https://collector.invalid/logs/codex/transcript");
    return { ok: true };
  };
  assert.equal(await logger.drainQueuesOnce("https://collector.invalid/logs/codex", 1000), 1);
  assert.equal(fs.existsSync(file), false);
});

test("later parent hooks preserve a subagent source in the same session", async () => {
  const agentSource = path.join(root, "agent.jsonl");
  fs.writeFileSync(agentSource, "");
  logger.observeTranscriptConsent(agentSource, repo);
  fs.appendFileSync(agentSource, line("subagent message"));
  logger.requestTranscriptCapture({ cwd: repo, session_id: "parent", transcript_path: source, agent_transcript_path: agentSource });
  logger.requestTranscriptCapture({ cwd: repo, session_id: "parent", transcript_path: source });
  const transcripts = new Set();
  global.fetch = async (_, options) => {
    transcripts.add(options.headers["X-Transcript-ID"]);
    return { ok: true };
  };
  await logger.drainPendingTranscripts();
  assert.deepEqual([...transcripts].sort(), ["agent.jsonl", "synthetic.jsonl"]);
});

test("one detached sweep drains a final transcript larger than the staging budget", async () => {
  const records = Array.from({ length: 10 }, (_, i) => line(`${i}:` + "x".repeat(1024 * 1024)));
  fs.writeFileSync(source, records.join(""));
  logger.requestTranscriptCapture({ cwd: repo, session_id: "large-final", transcript_path: source });
  let delivered = 0;
  global.fetch = async (_, options) => {
    delivered += require("node:zlib").gunzipSync(options.body).toString().trim().split("\n").length;
    return { ok: true };
  };
  await logger.drainPendingTranscripts();
  assert.equal(delivered, 10);
  assert.equal(logger.listPendingTranscripts().length, 0);
});

test("a missing source in a legacy session hint does not block its surviving source", async () => {
  logger.requestTranscriptCapture({ cwd: repo, session_id: "legacy", transcript_path: source });
  const names = fs.readdirSync(logger.TRANSCRIPT_CAPTURES_DIR).filter(n => n.endsWith(".json"));
  const hint = path.join(logger.TRANSCRIPT_CAPTURES_DIR, names[0]);
  const capture = JSON.parse(fs.readFileSync(hint));
  capture.paths.unshift(path.join(root, "missing-agent.jsonl"));
  const legacyName = names[0].slice(0, 64) + ".json";
  fs.unlinkSync(hint);
  fs.writeFileSync(path.join(logger.TRANSCRIPT_CAPTURES_DIR, legacyName), JSON.stringify(capture));
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true }; };
  await logger.drainPendingTranscripts();
  assert.equal(calls, 1);
});

for (const corruption of ["chunk", "metadata", "cursor"]) test(`direct upload retains ${corruption} corruption with a retry outcome and diagnostic`, async () => {
  const file = stage();
  const dir = path.dirname(path.dirname(file));
  const damaged = corruption === "chunk" ? file : corruption === "metadata"
    ? path.join(path.dirname(file), "commit.json") : path.join(dir, "cursor.json");
  fs.writeFileSync(damaged, "invalid fixture data that must not enter diagnostics");
  const before = fs.readFileSync(file);
  assert.equal(await upload(file), "retry");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "diagnostic.json"))).code, "queue-unavailable");
  assert.ok(!fs.readFileSync(path.join(dir, "diagnostic.json"), "utf8").includes("invalid fixture"));
});

const recordsIn = files => files.flatMap(file => require("node:zlib").gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(JSON.parse));

test("repository disable/re-enable without hooks excludes the interval through a server reset", async () => {
  logger.requestTranscriptCapture({ cwd: repo, session_id: "interval", transcript_path: source });
  global.fetch = async () => ({ok:true});
  await upload(stage());
  logger.saveTelemetryOptIn(repo, false);
  fs.appendFileSync(source, line("MUST-NOT-UPLOAD-DISABLED"));
  logger.saveTelemetryOptIn(repo, true);
  fs.appendFileSync(source, line("authorized after enable"));
  const file = stage();
  assert.deepEqual(recordsIn([file]).map(r => r.payload.content), ["authorized after enable"]);
  const requests = [];
  global.fetch = async (_, options) => {
    requests.push(options);
    return requests.length === 1 ? {ok:false,status:409,json:async()=>({error:"transcript-baseline-missing"})} : {ok:true};
  };
  assert.equal(await upload(file), "sent");
  const reset = require("node:zlib").gunzipSync(requests[1].body).toString();
  assert.doesNotMatch(reset, /MUST-NOT-UPLOAD/);
  assert.doesNotMatch(reset, /synthetic first message/, "a reset must not rebuild the pre-revocation prefix");
  assert.match(reset, /authorized after enable/);
});

test("global pause retains queued chunks but excludes newly written interval", () => {
  fs.writeFileSync(source, ""); logger.observeTranscriptConsent(source, repo);
  fs.appendFileSync(source, line("synthetic first message"));
  logger.requestTranscriptCapture({ cwd: repo, session_id: "pause", transcript_path: source });
  const previous = stage(), bytes = fs.readFileSync(previous);
  logger.setTelemetryGloballyDisabled(true);
  fs.appendFileSync(source, line("GLOBAL-PAUSE-EXCLUDED"));
  logger.setTelemetryGloballyDisabled(false);
  fs.appendFileSync(source, line("authorized after global resume"));
  const file = stage();
  assert.deepEqual(fs.readFileSync(previous), bytes, "queue revocation policy is unchanged");
  assert.deepEqual(recordsIn([file]).map(r => r.payload.content), ["authorized after global resume"]);
});

for (const [sessionSource, originator] of [["cli", "codex_cli_rs"], ["vscode", "Codex Desktop"]])
test(`first discovery excludes history and preserves ${originator} source identity`, () => {
  fs.rmSync(logger.TRANSCRIPT_CHUNKS_DIR, {recursive:true,force:true});
  fs.writeFileSync(source, JSON.stringify({type:"session_meta",payload:{id:"synthetic",cwd:repo,source:sessionSource,originator,instructions:"PRIVATE-OLD-INSTRUCTION"}}) + "\n" + line("PRIVATE-OLD-PROMPT"));
  logger.observeTranscriptConsent(source, repo);
  const call = {type:"response_item",payload:{type:"function_call",name:"exec_command",call_id:"pair-1",arguments:'{"cmd":"echo SYNTHETIC"}'}};
  const result = {type:"response_item",payload:{type:"function_call_output",call_id:"pair-1",output:"SYNTHETIC"}};
  fs.appendFileSync(source, [call,result].map(JSON.stringify).join("\n") + "\n");
  const records = recordsIn([stage()]);
  assert.equal(records[0].payload.originator, originator);
  assert.equal(records[0].payload.source, sessionSource);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE-OLD/);
  assert.deepEqual(records.slice(1).map(r => r.payload), [call,result].map(r => require("../../scripts/sanitizer").sanitizeLine(r, credentials.hash_salt).payload));
  assert.deepEqual(records.slice(1).map(r => r.payload.call_id), ["pair-1","pair-1"]);
});

test("a disabled native hook observes offsets without logging content or launching a worker", () => {
  logger.saveTelemetryOptIn(repo, false);
  fs.appendFileSync(source, line("DISABLED-HOOK-CONTENT"));
  const preload = path.join(root,"blocked-hook.cjs"), marker = path.join(root,"blocked-spawn");
  fs.writeFileSync(preload, `require("child_process").spawn=()=>{require("fs").writeFileSync(${JSON.stringify(marker)},"spawned");throw Error("disabled worker")};global.fetch=()=>{throw Error("network")};`);
  const run = spawnSync(process.execPath,["--require",preload,path.join(__dirname,"../../scripts/stop.js")],{
    cwd:repo,env:process.env,encoding:"utf8",timeout:3000,
    input:JSON.stringify({cwd:repo,session_id:"disabled",transcript_path:source,last_assistant_message:"DISABLED-HOOK-CONTENT"}),
  });
  assert.equal(run.status,0,run.stderr); assert.deepEqual(JSON.parse(run.stdout),{});
  assert.equal(fs.existsSync(marker),false); assert.equal(fs.existsSync(logger.LOG_FILE),false);
  logger.saveTelemetryOptIn(repo,true);
  // No intervening enabled hook: first observation remains a conservative boundary.
  logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line("enabled hook future"));
  assert.deepEqual(recordsIn([stage()]).map(r=>r.payload.content),["enabled hook future"]);
});


test("enable advances an unselected source before any upload hint exists", () => {
  fs.rmSync(path.join(repo,".codex"),{recursive:true,force:true});
  fs.rmSync(logger.LOG_DIR,{recursive:true,force:true});
  const policy = JSON.parse(fs.readFileSync(policyFile,"utf8"));
  delete policy.repositories[repoKey];
  fs.writeFileSync(policyFile,JSON.stringify(policy));
  fs.writeFileSync(source,line("UNSELECTED-HISTORY"));
  logger.observeTranscriptConsent(source,repo);
  assert.equal(fs.existsSync(logger.TRANSCRIPT_CAPTURES_DIR),false);
  // Enable the way consent-set does: observe known sources under the writer lock.
  const { createConsentStore } = require("../../scripts/lib/consent-store");
  createConsentStore({ file: policyFile, observedFile: logger.CONSENT_OBSERVED_FILE })
    .setRepositoryOverride(repoKey, true, { expectedRevision: policy.revision, acknowledged: true,
      onCommitted: () => logger.observeKnownTranscriptConsent() });
  fs.appendFileSync(source,line("FIRST-AUTHORIZED-PROMPT"));
  assert.deepEqual(recordsIn([stage()]).map(r=>r.payload.content),["FIRST-AUTHORIZED-PROMPT"]);
});

test("same-principal signout/signin excludes the signed-out span without intervening hooks", async () => {
  const storeApi = require("../../scripts/credstore");
  const file = stage();
  global.fetch = async () => ({ok:true}); await upload(file);
  storeApi.signOut();
  fs.appendFileSync(source,line("SIGNED-OUT-EXCLUDED"));
  const generation = storeApi.markEngaged();
  assert.notEqual(storeApi.commitSignin({jwt:credentials.license_jwt,refreshToken:"synthetic-refresh",generation}),false);
  assert.equal(stage(),null, "first post-signin observation closes the unknown interval");
  fs.appendFileSync(source,line("authorized after signin observation"));
  const next=stage();
  const requests=[];
  global.fetch=async(_,options)=>{
    requests.push(options);
    return requests.length===1?{ok:false,status:409,json:async()=>({error:"transcript-baseline-missing"})}:{ok:true};
  };
  assert.equal(await upload(next),"sent");
  const reset=require("node:zlib").gunzipSync(requests[1].body).toString();
  assert.doesNotMatch(reset,/SIGNED-OUT-EXCLUDED/);
  assert.match(reset,/synthetic first message/);
  assert.match(reset,/authorized after signin observation/);
});

test("ordinary credential refresh does not close an authorized transcript interval", () => {
  const storeApi=require("../../scripts/credstore");
  stage();const before=storeApi.recoverySnapshot();
  fs.appendFileSync(source,line("captured across refresh"));
  storeApi.commitRefresh(jwt("synthetic-user",4102444800,{jti:"refresh"}),before);
  assert.deepEqual(recordsIn([stage()]).map(r=>r.payload.content),["captured across refresh"]);
});

for (const originator of ["codex_work_desktop", "line\nbreak", "\u001bcontrol", "x".repeat(81), "   ", { name: "Codex Desktop" }])
test(`metadata boundary rejects unsupported originator ${JSON.stringify(originator)}`, () => {
  fs.rmSync(logger.TRANSCRIPT_CHUNKS_DIR, {recursive:true,force:true});
  fs.writeFileSync(source, JSON.stringify({type:"session_meta",payload:{id:"synthetic",cwd:repo,source:"vscode",originator}}) + "\n");
  logger.observeTranscriptConsent(source, repo);
  fs.appendFileSync(source, line("authorized future"));
  assert.equal(stage(), null);
  assert.deepEqual(logger.listPendingTranscripts(), []);
});

for (const lateHeader of [false, true]) test(`Work metadata ${lateHeader ? "after a Codex prefix" : "at startup"} cannot enter repository transcript staging`, () => {
  const header = originator => JSON.stringify({type:"session_meta",payload:{id:"synthetic-work",cwd:repo,source:"vscode",originator}}) + "\n";
  fs.writeFileSync(source, header(lateHeader ? "codex_cli_rs" : "codex_work_desktop") + line("synthetic prompt"));
  let before;
  if (lateHeader) {
    const first = stage(); assert.ok(first);
    before = fs.readFileSync(path.join(path.dirname(path.dirname(first)), "cursor.json"));
    fs.appendFileSync(source, header("codex_work_desktop") + line("Work continuation"));
  }
  assert.equal(stage(), null);
  assert.equal(logger.listPendingTranscripts().length, lateHeader ? 1 : 0);
  const [dir] = queue.queueDirectories(logger.TRANSCRIPT_CHUNKS_DIR);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"diagnostic.json"))).code,"source-scope-changed");
  if (lateHeader) assert.deepEqual(fs.readFileSync(path.join(dir,"cursor.json")),before);
  else assert.equal(fs.existsSync(path.join(dir,"cursor.json")),false);
});
