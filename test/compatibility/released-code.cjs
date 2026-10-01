"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Only pinned repository code is extracted. Runtime modules are loaded explicitly
// by each test; release hooks, installers and credentials are never invoked.
function releasedCode(t, repository, release, plugin) {
  if (!/^[a-f0-9]{40}$/.test(release.revision)) throw Error("invalid-release-pin");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "released-plugin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = execFileSync("git", ["archive", release.revision, "--", plugin], { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", root], { input: archive });
  const location = path.join(root, plugin);
  const manifest = fs.existsSync(path.join(location, ".codex-plugin/plugin.json")) ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  if (JSON.parse(fs.readFileSync(path.join(location, manifest))).version !== release.version) throw Error("release-version-mismatch");
  return location;
}
module.exports = { releasedCode };
