import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The device identity both clients share (shared/lib/device-identity.js), run
// in child processes so each client resolves its own configuration from a
// clean environment.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLIENTS = {
  claude: join(repoRoot, "clients/claude-code/skillmeter/scripts"),
  codex: join(repoRoot, "clients/codex/plugins/skillmeter/scripts"),
};

function run(client, stateDir, script) {
  const home = mkdtempSync(join(tmpdir(), "identity-home-"));
  try {
    return execFileSync(process.execPath, ["-e", script], {
      cwd: CLIENTS[client],
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, SKILLMETER_STATE_DIR: stateDir, CLAUDE_PLUGIN_DATA: join(home, "data"), PLUGIN_DATA: join(home, "data") },
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const deviceId = (client, stateDir) => run(client, stateDir, "process.stdout.write(require('./credstore').getDeviceId())");

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "identity-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("both clients read and write the same device identity", (t) => {
  const dir = stateDir(t);
  const fromCodex = deviceId("codex", dir);
  assert.match(fromCodex, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(deviceId("claude", dir), fromCodex);
  assert.equal(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).device_id, fromCodex);
});

test("a corrupt credentials.json is kept aside before either client resets it", (t) => {
  const dir = stateDir(t);
  writeFileSync(join(dir, "credentials.json"), "{ not json");
  const id = deviceId("codex", dir);
  assert.ok(id);
  const aside = readdirSync(dir).filter((name) => name.startsWith("credentials.json.corrupt-"));
  assert.equal(aside.length, 1, "the original bytes are preserved");
  assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{ not json");
});

test("an unreadable credentials.json is never overwritten", { skip: process.getuid?.() === 0 && "root reads any file" }, (t) => {
  const dir = stateDir(t);
  const file = join(dir, "credentials.json");
  writeFileSync(file, JSON.stringify({ other_client_field: "kept" }));
  chmodSync(file, 0o000);
  t.after(() => { try { chmodSync(file, 0o600); } catch {} });
  for (const client of ["codex", "claude"]) {
    assert.throws(() => deviceId(client, dir), `${client} refuses to write over what it cannot read`);
  }
  chmodSync(file, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other_client_field: "kept" });
  assert.equal(existsSync(`${file}.lock`), false, "no lock left behind");
});
