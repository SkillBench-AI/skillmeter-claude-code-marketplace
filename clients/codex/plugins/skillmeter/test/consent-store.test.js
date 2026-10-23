"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const modulePath = path.resolve(__dirname, "../scripts/lib/consent-store.js");
const repo = "github.com/acme/widgets";
const otherRepo = "github.com/acme/other";
const policy = () => ({
  schema_version: 1, revision: 4, global: { enabled: true },
  organizations: { acme: { enabled: true, consent_version: 1, decided_at: 10 } },
  repositories: { [repo]: { enabled: false, decided_at: 20 } },
});

function fixture(t, initial = policy()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "shared", "telemetry-policy.json");
  const observedFile = path.join(root, "codex-data", "policy-observed");
  fs.mkdirSync(path.dirname(file));
  if (initial !== null) fs.writeFileSync(file, JSON.stringify(initial));
  const { createConsentStore } = require(modulePath);
  return { root, file, observedFile, store: createConsentStore({ file, observedFile }) };
}

test("first-use reads do not create a shared grant or policy", t => {
  const f = fixture(t, null);
  assert.equal(f.store.readPolicy(), null);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.observedFile), false);
});

test("a repository write requires a preview revision and explicit acknowledgement for ON", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.store.setRepositoryOverride(repo, true, { expectedRevision: 4 }), { code: "ACKNOWLEDGEMENT_REQUIRED" });
  assert.throws(() => f.store.setRepositoryOverride(repo, false), { code: "EXPECTED_REVISION_REQUIRED" });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("an acknowledged choice uses canonical keys and version 2 without granting an organization", t => {
  const f = fixture(t, null);
  const updated = f.store.setRepositoryOverride("ACME/Widgets.git", true, { expectedRevision: null, acknowledged: true });
  assert.equal(updated.revision, 1);
  assert.equal(updated.repositories[repo].enabled, true);
  assert.equal(updated.repositories[repo].consent_version, 2);
  assert.deepEqual(updated.organizations, {});
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test("a stale confirmation cannot overwrite another process's OFF", t => {
  const f = fixture(t);
  const preview = f.store.readPolicy();
  const off = policy(); off.revision++; off.repositories[repo] = { enabled: false, decided_at: 30 };
  fs.writeFileSync(f.file, JSON.stringify(off));
  assert.throws(() => f.store.setRepositoryOverride(repo, true, { expectedRevision: preview.revision, acknowledged: true }), { code: "STALE_POLICY" });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), off);
});

test("an absent preview cannot overwrite a record created by another process", t => {
  const f = fixture(t, null);
  assert.equal(f.store.readPolicy(), null);
  fs.writeFileSync(f.file, JSON.stringify(policy()));
  assert.throws(() => f.store.setRepositoryOverride(repo, true, { expectedRevision: null, acknowledged: true }), { code: "STALE_POLICY" });
});

test("unrelated choices and nested extension fields survive writes", t => {
  const initial = policy();
  initial.global.extension = "preserve";
  initial.repositories[otherRepo] = { enabled: true, consent_version: 2, decided_at: 12, extension: { value: 1 } };
  const f = fixture(t, initial);
  const updated = f.store.setRepositoryOverride(repo, false, { expectedRevision: 4 });
  assert.equal(updated.revision, 5);
  assert.equal(updated.repositories[repo].consent_version, undefined, "OFF needs no acknowledgement, but must not claim one");
  assert.deepEqual(updated.global, initial.global);
  assert.deepEqual(updated.organizations, initial.organizations);
  assert.deepEqual(updated.repositories[otherRepo], initial.repositories[otherRepo]);
});

test("explicit reaffirmation advances the decision timestamp; unrelated edits leave it alone", t => {
  const initial = policy();
  initial.repositories[repo].decided_at = Date.now() + 60_000;
  const f = fixture(t, initial);
  const reaffirmed = f.store.setRepositoryOverride(repo, false, { expectedRevision: 4 });
  assert.ok(reaffirmed.repositories[repo].decided_at > initial.repositories[repo].decided_at);
  const unrelated = f.store.setRepositoryOverride(otherRepo, false, { expectedRevision: 5 });
  assert.deepEqual(unrelated.repositories[repo], reaffirmed.repositories[repo]);
});

for (const [name, raw] of [
  ["malformed JSON", "{"],
  ["array", "[]"],
  ["unsupported schema", JSON.stringify({ ...policy(), schema_version: 2 })],
  ["unknown top-level field", JSON.stringify({ ...policy(), future_restriction: true })],
  ["invalid revision", JSON.stringify({ ...policy(), revision: -1 })],
  ["invalid global", JSON.stringify({ ...policy(), global: { enabled: "true" } })],
  ["array of organizations", JSON.stringify({ ...policy(), organizations: [] })],
  ["malformed repository", JSON.stringify({ ...policy(), repositories: { [repo]: { enabled: "false" } } })],
  ["unsupported consent version", JSON.stringify({ ...policy(), repositories: { [repo]: { enabled: true, consent_version: 3 } } })],
]) {
  test(`${name} is preserved and cannot be repaired by an ordinary write`, t => {
    const f = fixture(t); fs.writeFileSync(f.file, raw);
    assert.throws(() => f.store.readPolicy(), { code: "INVALID_POLICY" });
    assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "INVALID_POLICY" });
    assert.equal(fs.readFileSync(f.file, "utf8"), raw);
  });
}

test("a disappeared observed policy remains blocked across store instances", t => {
  const f = fixture(t); f.store.readPolicy(); fs.unlinkSync(f.file);
  const restarted = require(modulePath).createConsentStore(f);
  assert.throws(() => restarted.readPolicy(), { code: "POLICY_MISSING" });
  assert.throws(() => restarted.setRepositoryOverride(repo, true, { expectedRevision: null, acknowledged: true }), { code: "POLICY_MISSING" });
  assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, JSON.stringify(policy()));
  assert.equal(restarted.readPolicy().revision, 4);
});

test("failure to persist the observation marker blocks a write", t => {
  const f = fixture(t);
  fs.writeFileSync(path.dirname(f.observedFile), "not a directory");
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "POLICY_OBSERVATION_FAILED" });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

for (const kind of ["directory", "dangling link", "file link"]) {
  test(`${kind} at the policy path is preserved on write`, t => {
    const f = fixture(t); fs.unlinkSync(f.file);
    if (kind === "directory") fs.mkdirSync(f.file);
    else {
      const target = path.join(f.root, "target");
      if (kind === "file link") fs.writeFileSync(target, JSON.stringify(policy()));
      fs.symlinkSync(target, f.file);
    }
    assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "INVALID_POLICY" });
    assert.equal(fs.lstatSync(f.file).isDirectory(), kind === "directory");
  });
}

test("ordinary writes never reclaim an existing lock, even an old one", t => {
  const f = fixture(t); const lock = `${f.file}.lock`;
  fs.writeFileSync(lock, ""); const past = new Date(Date.now() - 60_000); fs.utimesSync(lock, past, past);
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "POLICY_BUSY" });
  assert.equal(fs.existsSync(lock), true);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("global pause changes only policy, preserving credentials and queued bytes", t => {
  const f = fixture(t);
  const credentials = path.join(path.dirname(f.file), "credentials.json");
  const queue = path.join(f.root, "queue.jsonl");
  fs.writeFileSync(credentials, '{"synthetic":"credentials"}'); fs.writeFileSync(queue, "synthetic queue\n");
  const paused = f.store.setGlobalEnabled(false, { expectedRevision: 4 });
  assert.equal(paused.global.enabled, false);
  assert.deepEqual(paused.repositories, policy().repositories);
  assert.equal(fs.readFileSync(credentials, "utf8"), '{"synthetic":"credentials"}');
  assert.equal(fs.readFileSync(queue, "utf8"), "synthetic queue\n");
});

test("a replaced lock aborts the commit and is not deleted by the former owner", t => {
  const f = fixture(t); f.store.readPolicy();
  const before = fs.readFileSync(f.file);
  const originalFsync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", fd => {
    originalFsync(fd);
    if (fs.existsSync(`${f.file}.lock`)) fs.writeFileSync(`${f.file}.lock`, "replacement-owner");
  });
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "POLICY_BUSY" });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.readFileSync(`${f.file}.lock`, "utf8"), "replacement-owner");
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), ["telemetry-policy.json", "telemetry-policy.json.lock"]);
});

test("failed atomic replacement preserves the old policy and releases its own lock", t => {
  const f = fixture(t); const before = fs.readFileSync(f.file);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic disk failure"), { code: "EIO" }); });
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "EIO" });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["telemetry-policy.json"]);
});

test("an unreadable policy cannot be overwritten", t => {
  const f = fixture(t); const before = fs.readFileSync(f.file); const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.file) throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    return read(file, ...args);
  });
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: 4 }), { code: "INVALID_POLICY" });
  assert.deepEqual(read(f.file), before);
});

test("revision overflow is rejected without changing the stored choice", t => {
  const initial = policy(); initial.revision = Number.MAX_SAFE_INTEGER;
  const f = fixture(t, initial); const before = fs.readFileSync(f.file);
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: initial.revision }), { code: "INVALID_POLICY" });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("concurrent confirmations of the same revision commit exactly one choice", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const children = [];
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const script = `
    const store = require(process.argv[1]).createConsentStore(JSON.parse(process.argv[2]));
    process.send('ready');
    process.on('message', () => {
      try { store.setRepositoryOverride(process.argv[3], false, { expectedRevision: 4 }); process.send('ok'); }
      catch (error) { process.send(error.code); }
      process.disconnect();
    });
  `;
  const pending = [repo, otherRepo].map(key => {
    const child = spawn(process.execPath, ["-e", script, modulePath, JSON.stringify({ file: f.file, observedFile: f.observedFile }), key], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    return {
      ready: new Promise(resolve => child.once("message", resolve)),
      result: new Promise((resolve, reject) => {
        let outcome;
        child.on("message", value => { if (value !== "ready") outcome = value; });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve(outcome) : reject(new Error(`writer exited ${code}`)));
      }),
    };
  });
  await Promise.all(pending.map(p => p.ready));
  children.forEach(child => child.send("write"));
  assert.deepEqual((await Promise.all(pending.map(p => p.result))).sort(), ["STALE_POLICY", "ok"]);
  assert.equal(f.store.readPolicy().revision, 5);
});


test("a failed first replacement can be retried without a false observation", t => {
  const f = fixture(t, null);
  const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("disk"), { code: "EIO" }); });
  assert.throws(() => f.store.setRepositoryOverride(repo, true, { expectedRevision: null, acknowledged: true }), { code: "EIO" });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.observedFile), false);
  rename.mock.restore();
  assert.equal(f.store.readPolicy(), null);
  assert.equal(f.store.setRepositoryOverride(repo, true, { expectedRevision: null, acknowledged: true }).revision, 1);
  assert.equal(fs.readFileSync(f.observedFile, "utf8"), "1\n");
});

test("OFF never claims enablement acknowledgement, even if the caller supplies it", t => {
  const f = fixture(t);
  const result = f.store.setRepositoryOverride(repo, false, { expectedRevision: 4, acknowledged: true });
  assert.equal(result.repositories[repo].consent_version, undefined);
});


test("failed first write preserves an observation marker replaced by another observer", t => {
  const f = fixture(t, null);
  t.mock.method(fs, "renameSync", () => {
    const replacement = f.observedFile + ".replacement";
    fs.writeFileSync(replacement, "1\n");
    fs.unlinkSync(f.observedFile);
    fs.linkSync(replacement, f.observedFile);
    throw Object.assign(new Error("disk"), { code: "EIO" });
  });
  assert.throws(() => f.store.setGlobalEnabled(false, { expectedRevision: null }), { code: "EIO" });
  assert.equal(fs.readFileSync(f.observedFile, "utf8"), "1\n");
  assert.throws(() => f.store.readPolicy(), { code: "POLICY_MISSING" });
});

function failTempCleanup(t) {
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (target, ...rest) => {
    if (/\.tmp(?:\.|$)/.test(String(target))) throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    return unlink(target, ...rest);
  });
}

test("a failed marker temp cleanup does not block observation", t => {
  const f = fixture(t); failTempCleanup(t);
  assert.equal(f.store.readPolicy().revision, 4);
  assert.equal(fs.readFileSync(f.observedFile, "utf8"), "1\n");
});

test("a failed temp cleanup neither hides a committed write nor replaces the original error", t => {
  const f = fixture(t); failTempCleanup(t);
  assert.equal(f.store.setGlobalEnabled(false, { expectedRevision: 4 }).revision, 5);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).global.enabled, false);
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("disk"), { code: "EIO" }); });
  assert.throws(() => f.store.setGlobalEnabled(true, { expectedRevision: 5 }), { code: "EIO" });
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).revision, 5);
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
});

test("publishing the policy and the observation marker syncs their parent directories", t => {
  const f = fixture(t, null);
  const open = fs.openSync, synced = [];
  t.mock.method(fs, "openSync", (target, flags, ...rest) => {
    try { if (flags === "r" && fs.statSync(target).isDirectory()) synced.push(path.resolve(String(target))); } catch {}
    return open(target, flags, ...rest);
  });
  assert.equal(f.store.setRepositoryOverride(repo, false, { expectedRevision: null }).revision, 1);
  assert.ok(synced.includes(path.resolve(path.dirname(f.file))), "policy directory synced");
  assert.ok(synced.includes(path.resolve(path.dirname(f.observedFile))), "marker directory synced");
});

test("a first write whose marker directory sync fails leaves no marker and can be retried", t => {
  const f = fixture(t, null);
  const open = fs.openSync, markerDir = path.resolve(path.dirname(f.observedFile));
  const failing = t.mock.method(fs, "openSync", (target, flags, ...rest) => {
    if (flags === "r" && path.resolve(String(target)) === markerDir) throw Object.assign(new Error("synthetic sync failure"), { code: "EIO" });
    return open(target, flags, ...rest);
  });
  assert.throws(() => f.store.setRepositoryOverride(repo, false, { expectedRevision: null }), { code: "POLICY_OBSERVATION_FAILED" });
  assert.equal(fs.existsSync(f.observedFile), false);
  assert.equal(fs.existsSync(f.file), false);
  failing.mock.restore();
  assert.equal(f.store.readPolicy(), null);
  assert.equal(f.store.setRepositoryOverride(repo, false, { expectedRevision: null }).revision, 1);
});

test("a marker published by another process between lookups counts as observed", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.observedFile), { recursive: true });
  const lstat = fs.lstatSync;
  let raced = false;
  t.mock.method(fs, "lstatSync", (target, ...rest) => {
    if (!raced && path.resolve(String(target)) === path.resolve(f.observedFile)) {
      raced = true;
      const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      fs.writeFileSync(f.observedFile, "1\n"); // the other writer wins the race
      throw missing;
    }
    return lstat(target, ...rest);
  });
  assert.equal(f.store.readPolicy().revision, 4);
  assert.ok(raced);
});

test("a failed policy directory sync still reconciles under the lock and reports uncertain durability", t => {
  const f = fixture(t);
  const open = fs.openSync, policyDir = path.resolve(path.dirname(f.file));
  t.mock.method(fs, "openSync", (target, flags, ...rest) => {
    if (flags === "r" && path.resolve(String(target)) === policyDir) throw Object.assign(new Error("synthetic sync failure"), { code: "EIO" });
    return open(target, flags, ...rest);
  });
  const observed = [];
  assert.throws(() => f.store.setRepositoryOverride(repo, false, { expectedRevision: 4, onCommitted: policy => {
    observed.push({ revision: policy.revision, locked: fs.existsSync(`${f.file}.lock`) });
  } }), error => error.code === "POLICY_COMMITTED_DURABILITY_UNCERTAIN" && error.cause?.code === "EIO");
  assert.deepEqual(observed, [{ revision: 5, locked: true }], "reconciliation ran once, under the writer lock");
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).revision, 5);
  assert.equal(fs.existsSync(`${f.file}.lock`), false);
});

function onPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

test("a synced write reports confirmed durability", t => {
  const f = fixture(t);
  assert.equal(f.store.setRepositoryOverride(repo, false, { expectedRevision: 4 }).durability, "synced");
});

test("an organization write requires a revision and acknowledgement for ON and upgrades a legacy grant", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.store.setOrganizationConsent("acme", true, { expectedRevision: 4 }), { code: "ACKNOWLEDGEMENT_REQUIRED" });
  assert.throws(() => f.store.setOrganizationConsent("acme", false), { code: "EXPECTED_REVISION_REQUIRED" });
  assert.throws(() => f.store.setOrganizationConsent("acme", true, { expectedRevision: 3, acknowledged: true }), { code: "STALE_POLICY" });
  assert.throws(() => f.store.setOrganizationConsent("acme/widgets", true, { expectedRevision: 4, acknowledged: true }), /organization is required/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const updated = f.store.setOrganizationConsent(" ACME ", true, { expectedRevision: 4, acknowledged: true });
  assert.equal(updated.revision, 5);
  assert.equal(updated.organizations.acme.consent_version, 2);
  assert.ok(updated.organizations.acme.decided_at > 10);
  assert.deepEqual(updated.repositories, policy().repositories);
});

test("organization OFF drops the acknowledgement and runs the commit observer under the lock", t => {
  const f = fixture(t, null);
  let observed = 0;
  const saved = f.store.setOrganizationConsent("acme", false, { expectedRevision: null, onCommitted: committed => {
    observed++;
    assert.equal(committed.organizations.acme.enabled, false);
    assert.throws(() => f.store.setOrganizationConsent("acme", true, { expectedRevision: 1, acknowledged: true }), { code: "POLICY_BUSY" });
  } });
  assert.equal(observed, 1);
  assert.deepEqual(Object.keys(saved.organizations.acme).sort(), ["decided_at", "enabled", "source"]);
  assert.deepEqual(saved.repositories, {});
});

test("on Windows, directory sync is not attempted and durability is reported as unconfirmed", t => {
  const f = fixture(t, null);
  onPlatform(t, "win32");
  const open = fs.openSync, directoryOpens = [];
  t.mock.method(fs, "openSync", (target, flags, ...rest) => {
    try { if (flags === "r" && fs.statSync(target).isDirectory()) directoryOpens.push(String(target)); } catch {}
    return open(target, flags, ...rest);
  });
  let committed = 0;
  const saved = f.store.setRepositoryOverride(repo, false, { expectedRevision: null, onCommitted: () => { committed++; } });
  assert.equal(saved.revision, 1);
  assert.equal(saved.durability, "unconfirmed");
  assert.equal(committed, 1);
  assert.deepEqual(directoryOpens, []);
  assert.equal(fs.readFileSync(f.observedFile, "utf8"), "1\n", "the marker is still published");
  assert.equal(f.store.readPolicy().revision, 1);
});
