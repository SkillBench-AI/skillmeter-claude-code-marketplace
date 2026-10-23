"use strict";
// The MCP server asks consent questions through elicitation. These tests play
// the Codex client over stdio: they answer each `elicitation/create` as a user
// would and check what was saved.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { PLUGIN_ROOT, tempDir, writeCredentials, license, makeRepo, writeSettings, consentPolicyFileIn } = require("../../test-support/plugin.cjs");

function setup(t) {
  const home = tempDir("sk-mcp-home");
  const codexHome = path.join(home, ".codex");
  writeCredentials(home, { device_id: "DEV-1", hash_salt: "abcd", license_jwt: license({ orgs: ["acme"] }), refresh_token: "synthetic-refresh" });
  const widgets = makeRepo({ remote: "git@github.com:acme/widgets.git" });
  const gears = makeRepo({ remote: "https://github.com/acme/gears.git" });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects."${widgets}"]\n[projects."${gears}"]\n`);
  t.after(() => { for (const dir of [home, widgets, gears]) fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, PLUGIN_DATA: path.join(home, "data"),
    SKILLMETER_STATE_DIR: "", SKILLMETER_REPO_SCOPE_ORGS: "", SKILLMETER_BROKER_URL: "http://127.0.0.1:9" };
  const policyFile = consentPolicyFileIn(path.join(home, ".skillbench"));
  return { widgets, gears, env, policyFile, policy: () => JSON.parse(fs.readFileSync(policyFile, "utf8")) };
}

// A Codex-like client. `answer(params)` returns the elicitation result, or
// `{ error }` to fail the request.
function client(t, env, { elicitation = true, answer = () => ({ action: "cancel" }) } = {}) {
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "mcp_server.js")], { cwd: PLUGIN_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const waiting = new Map();
  const forms = [];
  let id = 0;
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "elicitation/create") {
      forms.push(message.params);
      const reply = answer(message.params);
      child.stdin.write(JSON.stringify(reply.error
        ? { jsonrpc: "2.0", id: message.id, error: { code: -1, message: reply.error } }
        : { jsonrpc: "2.0", id: message.id, result: reply }) + "\n");
      return;
    }
    waiting.get(message.id)?.(message);
  });
  const call = (method, params) => new Promise(resolve => {
    const requestId = ++id;
    waiting.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  const ready = call("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" },
    capabilities: elicitation ? { elicitation: { form: {} } } : {} })
    .then(() => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"));
  const tool = async (name, args) => { await ready; return (await call("tools/call", { name, arguments: args })).result.structuredContent; };
  return { call, tool, forms, ready };
}

test("the server lists its two consent tools", async t => {
  const f = setup(t);
  const c = client(t, f.env);
  await c.ready;
  const { result } = await c.call("tools/list", {});
  assert.deepEqual(result.tools.map(tool => tool.name), ["onboard_organization", "review_repositories"]);
});

test("onboarding shows a single-select form with the repositories and the scope statement, then saves the choice", async t => {
  const f = setup(t);
  const c = client(t, f.env, { answer: () => ({ action: "accept", content: { choice: "enable_listed" } }) });
  const result = await c.tool("onboard_organization", { organization: "acme", cwd: f.widgets });
  const [form] = c.forms;
  assert.match(form.message, /Choose telemetry for @acme\.[\s\S]*@acme\/gears\n@acme\/widgets[\s\S]*every clone or worktree/);
  assert.deepEqual(form.requestedSchema.properties.choice.oneOf.map(option => option.const), ["enable_listed", "organization_only", "keep_off"]);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.result.results.map(repo => [repo.displayName, repo.effective]), [["@acme/gears", "on"], ["@acme/widgets", "on"]]);
  assert.equal(f.policy().organizations.acme.consent_version, 2);
  assert.equal(f.policy().repositories["github.com/acme/widgets"].consent_version, 2);
});

for (const [name, options, expected] of [
  ["declined", { answer: () => ({ action: "decline" }) }, "declined"],
  ["cancelled", { answer: () => ({ action: "cancel" }) }, "cancelled"],
  ["refused by the client", { answer: () => ({ error: "auto-declined" }) }, "unavailable"],
  ["not supported by the client", { elicitation: false }, "unavailable"],
]) {
  test(`a form that is ${name} changes nothing`, async t => {
    const f = setup(t);
    const c = client(t, f.env, options);
    const result = await c.tool("onboard_organization", { organization: "acme", cwd: f.widgets });
    assert.equal(result.outcome, expected);
    assert.equal(fs.existsSync(f.policyFile), false);
    if (options.elicitation === false) assert.equal(c.forms.length, 0);
  });
}

test("an organization already ON offers new repositories, keep and turn off", async t => {
  const f = setup(t);
  const first = client(t, f.env, { answer: () => ({ action: "accept", content: { choice: "organization_only" } }) });
  assert.equal((await first.tool("onboard_organization", { organization: "acme" })).outcome, "applied");
  // Organization only records the listed repositories OFF, so none is new.
  const second = client(t, f.env, { answer: () => ({ action: "accept", content: { choice: "keep_authorized" } }) });
  const kept = await second.tool("onboard_organization", { organization: "acme" });
  assert.deepEqual(second.forms[0].requestedSchema.properties.choice.oneOf.map(option => option.const), ["keep_authorized", "turn_off"]);
  assert.equal(kept.outcome, "unchanged");
});

test("a checkout with a local OFF is listed apart and never turned on", async t => {
  const f = setup(t);
  writeSettings(f.widgets, { telemetry: false });
  const c = client(t, f.env, { answer: () => ({ action: "accept", content: { choice: "enable_listed" } }) });
  const result = await c.tool("onboard_organization", { organization: "acme" });
  assert.match(c.forms[0].message, /local settings \(not changed here\):\n@acme\/widgets/);
  assert.deepEqual(result.result.results.map(repo => repo.displayName), ["@acme/gears"]);
  assert.equal(f.policy().repositories["github.com/acme/widgets"], undefined);
});

test("an unknown organization is an error and asks nothing", async t => {
  const f = setup(t);
  const c = client(t, f.env);
  const result = await c.tool("onboard_organization", { organization: "other" });
  assert.deepEqual([result.outcome, result.code], ["error", "ORGANIZATION_UNAVAILABLE"]);
  assert.equal(c.forms.length, 0);
});

test("the repository review shows an ON/OFF picker per repository and saves only changes", async t => {
  const f = setup(t);
  const blocked = client(t, f.env);
  assert.equal((await blocked.tool("review_repositories", {})).outcome, "nothing_to_review");

  const onboard = client(t, f.env, { answer: () => ({ action: "accept", content: { choice: "enable_listed" } }) });
  await onboard.tool("onboard_organization", { organization: "acme" });
  const c = client(t, f.env, { answer: form => {
    const fields = Object.entries(form.requestedSchema.properties);
    // Keep @acme/gears ON and turn @acme/widgets OFF.
    return { action: "accept", content: Object.fromEntries(fields.map(([field, schema]) => [field, schema.title === "@acme/widgets" ? "off" : "on"])) };
  } });
  const result = await c.tool("review_repositories", {});
  const fields = Object.values(c.forms[0].requestedSchema.properties);
  assert.deepEqual(fields.map(field => [field.title, field.default, field.oneOf.map(option => option.title)]),
    [["@acme/gears", "on", ["ON", "OFF"]], ["@acme/widgets", "on", ["ON", "OFF"]]]);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.result.results.map(repo => [repo.displayName, repo.changed, repo.effective]), [["@acme/widgets", true, "off"]]);
  assert.equal(f.policy().repositories["github.com/acme/widgets"].enabled, false);
  assert.equal(f.policy().repositories["github.com/acme/gears"].enabled, true);
});
