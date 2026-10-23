"use strict";
// The Codex adapter and the boundaries it guards: function-call arguments,
// opaque tool fields, transcript files, the chunk queue, and the hook scripts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sandbox, readJsonl, gunzipRecords, tempDir } = require("../../test-support/plugin.cjs");
const { SAMPLES, POLICY_VERSION } = require("../../test-support/sanitizer.cjs");
const s = require("../../scripts/sanitizer");
const shared = require("../../scripts/lib/sanitize");
const { stage } = require("../../scripts/lib/transcript-delta");
const fixture = require("../fixtures/native-completion.cjs");

test("Codex records receive fresh policy metadata, preserving tool links and nested arguments", () => {
  const raw = { type: "response_item", payload: { type: "function_call", call_id: "synthetic-call", name: "read_file",
    arguments: JSON.stringify({ file_path: "/private/project/src/fixture.ts", access_token: "unguessable-value", note: "用户@example.com" }) },
    _sanitization: { policyVersion: "3.1.0", secrets: 0 } };
  const before = JSON.stringify(raw);
  const out = s.sanitizeLine(raw, "synthetic-salt");
  assert.equal(JSON.stringify(raw), before, "input is not mutated");
  assert.equal(out.type, raw.type);
  assert.equal(out.payload.call_id, raw.payload.call_id);
  assert.equal(out.payload.name, "read_file");
  const args = JSON.parse(out.payload.arguments);
  assert.equal(args.access_token, "[REDACTED_SECRET]");
  assert.equal(args.note, "[EMAIL]");
  assert.match(args.file_path, /\/src\/[a-f0-9]{12}\.ts$/);
  assert.equal(out._sanitization.policyVersion, POLICY_VERSION);
  assert.equal(out._sanitization.secrets, 1);
  assert.equal(out._sanitization.pii, 1);
  assert.ok(out._sanitization.counts.path > 0);
});

test("command, patch and custom tool input stay opaque while identity survives", () => {
  const out = s.sanitizeLine({ type: "response_item", payload: { type: "function_call", call_id: "synthetic-call", name: "exec_command",
    arguments: JSON.stringify({ command: "cat /private/fixture", patch: "private patch", timeout_ms: 1000 }) } }, "synthetic-salt");
  const args = JSON.parse(out.payload.arguments);
  assert.match(args.command, /^[a-f0-9]{12}$/);
  assert.match(args.patch, /^[a-f0-9]{12}$/);
  assert.equal(args.timeout_ms, 1000);
  const custom = s.sanitizeLine({ type: "response_item", uuid: "synthetic-source", payload: { type: "custom_tool_call",
    name: "apply_patch", call_id: "fixture", input: "*** Begin Patch\nprivate contents" } }, "synthetic-salt");
  assert.match(custom.payload.input, /^[a-f0-9]{12}$/);
  assert.equal(custom.uuid, "synthetic-source");
  assert.equal(custom.payload.call_id, "fixture");
});

test("compaction references keep their source identifier while the surrounding history is still scrubbed", () => {
  // Contains a Luhn-valid digit run, so as content it would become [CARD].
  const source = "e50a17dff2ebc4573704406067bd59ea299b57dc0ef957df4efee7e0b2d36129";
  assert.notEqual(shared.redactString(source).value, source, "fixture must be one the card rule matches");
  const out = s.sanitizeLine({ type: "response_item", payload: { type: "compacted", guardian_history: [
    { type: "skillmeter_compaction_reference", source_uuid: source, pointer: "/payload" },
    { type: "message", role: "user", content: `token ${SAMPLES["github-token"]} for alice@example.com` },
    { type: "skillmeter_compaction_reference", source_uuid: "not-an-identifier alice@example.com", pointer: "/payload" },
  ] } }, "synthetic-salt");
  const [reference, message, malformed] = out.payload.guardian_history;
  assert.equal(reference.source_uuid, source);
  assert.equal(reference.pointer, "/payload");
  assert.ok(message.content.includes("[REDACTED_SECRET]") && message.content.includes("[EMAIL]"));
  assert.equal(malformed.source_uuid, "not-an-identifier [EMAIL]", "only well-formed identifiers are exempt");
  assert.equal(out._sanitization.counts.card, 0);
  assert.equal(JSON.stringify(out).includes("skillmeter:reference:"), false, "no placeholder token leaks");
});

test("a supplied value that looks like a reference placeholder is never restored as a reference", () => {
  const source = "e50a17dff2ebc4573704406067bd59ea299b57dc0ef957df4efee7e0b2d36129";
  const out = s.sanitizeLine({ type: "response_item", payload: { type: "compacted", guardian_history: [
    { type: "skillmeter_compaction_reference", source_uuid: source, pointer: "/payload" },
    { type: "skillmeter_compaction_reference", source_uuid: "skillmeter:reference:0", pointer: "/payload" },
    { type: "message", role: "user", content: "skillmeter:reference:0" },
  ] } }, "synthetic-salt");
  const [reference, forged, message] = out.payload.guardian_history;
  assert.equal(reference.source_uuid, source);
  assert.equal(forged.source_uuid, "skillmeter:reference:0", "the supplied string stays what it was");
  assert.equal(message.content, "skillmeter:reference:0");
});

test("unsupported tool arguments are opaque with an explicit format outcome", () => {
  for (const args of ['{"password":', '"raw argument"', "123", "null", "[]"]) {
    const out = s.sanitizeLine({ type: "response_item", payload: { type: "function_call", call_id: "fixture", arguments: args } }, "synthetic-salt");
    assert.match(out.payload.arguments, /^[a-f0-9]{12}$/);
    assert.equal(out.payload._codex_arguments_format, "unsupported-json-opaque");
    assert.equal(out._sanitization.counts.path, 1);
    assert.equal(out.payload.call_id, "fixture");
  }
});

test("sanitizeTranscript hashes cwd and redacts secrets in every line, and rejects malformed lines", () => {
  const dir = tempDir("sk-transcript");
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session_meta", cwd: "/Users/dev/secret-project" }),
    JSON.stringify({ type: "message", role: "user", text: `use ${SAMPLES["openai-api-key"]}` }),
    JSON.stringify({ type: "function_call_output", output: "connected to postgres://u:p4ss@db/app, contact dev@example.com" }),
  ].join("\n") + "\n");
  const text = s.sanitizeTranscript(file, "deadbeefsalt").toString("utf8");
  for (const raw of ["/Users/dev/secret-project", SAMPLES["openai-api-key"], "p4ss@db", "dev@example.com"]) {
    assert.equal(text.includes(raw), false, raw);
  }
  assert.ok(text.includes("[REDACTED_SECRET]"));
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);
  fs.appendFileSync(file, "not json\n");
  assert.throws(() => s.sanitizeTranscript(file, "deadbeefsalt"), SyntaxError);
});

test("the chunk queue preserves native identity, statuses and multi-file evidence after redaction", t => {
  const dir = tempDir("native-sanitizer-compat");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const salt = "synthetic-native-compat-salt";
  const home = os.homedir();
  const raw = fixture.records(home);
  const source = path.join(dir, "synthetic.jsonl");
  fs.writeFileSync(source, raw.map(JSON.stringify).join("\n") + "\n");
  const scope = { owner: "fixture-owner", deviceId: "SYNTHETIC", cwd: "/synthetic", org: "synthetic" };
  const first = stage(path.join(dir, "queue"), source, scope, salt);
  assert.equal(first.status, "staged");
  assert.equal(first.cursor.lineCount, raw.length);
  assert.equal(stage(path.join(dir, "queue"), source, scope, salt).status, "unchanged");
  const out = gunzipRecords(first.files);
  assert.equal(out[0].payload.id, raw[0].payload.id);
  assert.equal(out[0].payload.cwd, s.hashHmac(raw[0].payload.cwd, salt));
  const before = raw.filter(r => r.payload.type === "item_completed").map(r => r.payload);
  const after = out.filter(r => r.payload.type === "item_completed").map(r => r.payload);
  assert.equal(after.length, 5);
  for (let i = 0; i < after.length; i++) {
    for (const field of ["thread_id", "turn_id", "started_at_ms", "completed_at_ms"]) assert.equal(after[i][field], before[i][field]);
    for (const field of ["id", "type", "status", "exit_code"]) assert.equal(after[i].item[field], before[i].item[field]);
  }
  const changes = Object.values(after[0].item.changes);
  assert.deepEqual(changes.map(c => c.type), ["update", "add", "delete", "update"]);
  assert.ok(changes[0].unified_diff.includes("+return units * price;"));
  assert.ok(changes[1].content.includes("module.exports = 1;"));
  assert.ok(changes[2].content.includes("old value"));
  assert.equal(changes[3].move_path, `${s.hashHmac(home, salt)}/synthetic-native-work/src/moved.cjs`);
  assert.ok(Object.keys(after[0].item.changes).every(p => p.startsWith(s.hashHmac(home, salt) + "/")));
  const text = JSON.stringify(out);
  for (const raw of [fixture.token, fixture.email, home]) assert.equal(text.includes(raw), false);
  assert.ok(text.includes("[REDACTED_SECRET]") && text.includes("[EMAIL]"));
  for (const item of after.slice(2).map(p => p.item)) {
    assert.ok(Array.isArray(item.command));
    assert.equal(item.command[0], "node");
    assert.equal(item.cwd, out[0].payload.cwd);
  }
  assert.equal(out[2].payload.call_id, out.at(-1).payload.call_id);
  assert.equal(out[2].payload.input, s.hashHmac(raw[2].payload.input, salt));
  assert.ok(out.every(r => r._sanitization.policyVersion === POLICY_VERSION));
  assert.equal(new Set(out.map(r => r.uuid)).size, out.length);
});

const queuedRecords = box => [
  ...readJsonl(path.join(box.data, "logs", "events.jsonl")),
  ...fs.readdirSync(path.join(box.data, "logs")).filter(n => /^events\.jsonl\.\d+$/.test(n))
    .flatMap(n => readJsonl(path.join(box.data, "logs", n))),
];

test("UserPromptSubmit redacts the raw prompt before it reaches the event queue", t => {
  const box = sandbox(t, { telemetry: true });
  const secret = SAMPLES["github-token"];
  const result = box.script("user_prompt_submit.js", { input: { session_id: "sess-1", cwd: box.repo, prompt: `Here is my key ${secret}, please use it` } });
  assert.equal(result.status, 0, result.stderr);
  const rec = queuedRecords(box).find(r => r.hook_event_name === "UserPromptSubmit");
  assert.ok(rec, "expected a UserPromptSubmit record");
  assert.equal(JSON.stringify(rec).includes(secret), false, "raw token reached the queue");
  assert.ok(rec.data.prompt.includes("[REDACTED_SECRET]"));
  assert.ok(rec.data._sanitization.secrets >= 1);
});

for (const script of ["pre_tool_use.js", "post_tool_use.js", "permission_request.js"]) {
  test(`${script} redacts secrets and hashes paths once at the event queue boundary`, t => {
    const box = sandbox(t, { telemetry: true });
    const secret = SAMPLES["slack-token"];
    const toolInput = {
      file_path: "/private/undisclosed/src/customer.ts", cwd: "/private/project", command: "cat /private/customer.txt",
      note: "用户@example.com", description: `run deploy with token ${secret}`, "Keep telemetry authorized?": "yes",
    };
    const result = box.script(script, { input: { session_id: "sess-1", cwd: box.repo, tool_name: "read_file", tool_use_id: "t1",
      tool_input: toolInput, tool_response: { stdout: `OPENAI_API_KEY=${SAMPLES["openai-api-key"]}\nDONE` } } });
    assert.equal(result.status, 0, result.stderr);
    const rec = queuedRecords(box).find(r => r.data && r.data.tool_name === "read_file");
    assert.ok(rec, "hook record missing");
    const blob = JSON.stringify(rec);
    assert.equal(blob.includes(secret) || blob.includes(SAMPLES["openai-api-key"]), false, "raw secret reached the queue");
    const salt = box.credentials.hash_salt;
    assert.equal(rec.data.tool_input.file_path, shared.hashPathSegments(toolInput.file_path, salt));
    assert.equal(rec.data.tool_input.cwd, s.hashHmac(toolInput.cwd, salt));
    assert.equal(rec.data.tool_input.command, s.hashHmac(toolInput.command, salt));
    assert.equal(rec.data.tool_input.note, "[EMAIL]");
    assert.ok(rec.data.tool_input.description.includes("[REDACTED_SECRET]"));
    assert.equal(rec.data.tool_input["Keep telemetry authorized?"], "yes");
    assert.equal(rec.data._sanitization.policyVersion, POLICY_VERSION);
    assert.equal(rec.data._sanitization.counts.email, 1);
    assert.equal(rec.data._sanitization.counts.path, 6, "event cwd, three private segments, tool cwd, opaque command");
    assert.ok(rec.data._sanitization.secrets >= 1);
    assert.equal(Object.hasOwn(rec.data.tool_input, "_sanitization"), false);
  });
}
