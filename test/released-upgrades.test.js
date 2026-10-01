"use strict";
require("../testing/bootstrap");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { releasedCode } = require("./compatibility/released-code.cjs");
const releases = require("./compatibility/releases.json");
const candidate = require("../skillmeter/scripts/lib/transcript-delta");
const resolver = require("../skillmeter/scripts/lib/plugin-data-root");
const repository = path.resolve(__dirname, "..");
const row = (uuid, text) => ({ type: "assistant", uuid, message: { content: text } });
const messages = plan => plan.chunks.flatMap(chunk => chunk.lines.map(JSON.parse)).map(record => record.message.content);

for (const release of releases) {
  test(`released ${release.version} cursor resumes without reset or lost repeats`, t => {
    const location = releasedCode(t, repository, release, "skillmeter");
    const previous = require(path.join(location, "scripts/lib/transcript-delta"));
    const prefix = [row("first", "earlier work")];
    const oldPlan = previous.buildChunkPlan(prefix, null, "fixture");
    // Only cross-version behaviour lives here; candidate-only planning and
    // derivation are covered once in transcript-delta and plugin-data-root tests.
    // The cursor round-trips through JSON exactly as the released writer stored it.
    const cursor = JSON.parse(JSON.stringify(oldPlan.newCursor));
    const input = [...prefix, row("second", "unstaged work"), row("third", "repeated work"), row("fourth", "repeated work")];
    const next = candidate.buildChunkPlan(input, cursor, "fixture");
    assert.deepEqual(messages(next), ["unstaged work", "repeated work", "repeated work"]);
    assert.equal(next.chunks[0].seq, oldPlan.newCursor.seq + 1);
    assert.ok(next.chunks.every(chunk => chunk.reset === false));

    const oldResolver = require(path.join(location, "scripts/lib/plugin-data-root"));
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "claude-upgrade-config-"));
    t.after(() => fs.rmSync(config, { recursive: true, force: true }));
    fs.mkdirSync(path.join(config, "plugins/data"), { recursive: true });
    const oldInstall = path.join(config, "plugins/cache/fixture-market/skillmeter", release.version);
    const newInstall = path.join(config, "plugins/cache/fixture-market/skillmeter/candidate");
    // A new install must find the data directory the released version wrote to.
    const oldData = oldResolver.resolvePluginDataRoot(oldInstall, {});
    assert.ok(oldData, "released resolver found no data directory");
    assert.equal(resolver.resolvePluginDataRoot(newInstall, {}), oldData);
  });
}
