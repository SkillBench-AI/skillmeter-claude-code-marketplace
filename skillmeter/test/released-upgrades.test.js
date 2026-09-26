"use strict";
require("../testing/bootstrap");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { releasedCode } = require("./compatibility/released-code.cjs");
const releases = require("./compatibility/releases.json");
const candidate = require("../scripts/lib/transcript-delta");
const resolver = require("../scripts/lib/plugin-data-root");
const repository = path.resolve(__dirname, "../..");
const row = (uuid, text) => ({ type: "assistant", uuid, message: { content: text } });
const messages = plan => plan.chunks.flatMap(chunk => chunk.lines.map(JSON.parse)).map(record => record.message.content);

for (const release of releases) {
  test(`released ${release.version} cursor resumes without reset or lost repeats`, t => {
    const location = releasedCode(t, repository, release, "skillmeter");
    const previous = require(path.join(location, "scripts/lib/transcript-delta"));
    const prefix = [row("first", "earlier work")];
    const oldPlan = previous.buildChunkPlan(prefix, null, "fixture");
    // Persist exactly the released planner's cursor and serialized pending lines.
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "claude-upgrade-state-"));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const cursorFile = path.join(state, "cursor.json"), pendingFile = path.join(state, "pending.jsonl");
    fs.writeFileSync(cursorFile, JSON.stringify(oldPlan.newCursor));
    fs.writeFileSync(pendingFile, oldPlan.chunks.flatMap(chunk => chunk.lines).join("\n") + "\n");
    const pendingBefore = fs.readFileSync(pendingFile);
    const input = [...prefix, row("second", "unstaged work"), row("third", "repeated work"), row("fourth", "repeated work")];
    const next = candidate.buildChunkPlan(input, JSON.parse(fs.readFileSync(cursorFile)), "fixture");
    assert.deepEqual(messages(next), ["unstaged work", "repeated work", "repeated work"]);
    assert.equal(next.chunks[0].seq, oldPlan.newCursor.seq + 1);
    assert.ok(next.chunks.every(chunk => chunk.reset === false));
    assert.deepEqual(fs.readFileSync(pendingFile), pendingBefore);
    assert.deepEqual(candidate.buildChunkPlan(input, next.newCursor, "fixture"), { chunks: [], newCursor: null });
    const reset = candidate.buildChunkPlan([row("replacement", "rewritten source")], next.newCursor, "fixture");
    assert.equal(reset.chunks[0].reset, true);
    assert.equal(reset.chunks[0].resetBaselineSeq, next.newCursor.seq + 1);
    assert.deepEqual(messages(reset), ["rewritten source"]);

    const oldResolver = require(path.join(location, "scripts/lib/plugin-data-root"));
    const config = path.join(state, "config");
    fs.mkdirSync(path.join(config, "plugins/data"), { recursive: true });
    const oldInstall = path.join(config, "plugins/cache/fixture-market/skillmeter", release.version);
    const newInstall = path.join(config, "plugins/cache/fixture-market/skillmeter/candidate");
    const oldData = oldResolver.resolvePluginDataRoot(oldInstall, {});
    assert.equal(oldData, resolver.resolvePluginDataRoot(newInstall, {}));
    assert.equal(oldData, path.join(config, "plugins/data/skillmeter-fixture-market"));
    fs.mkdirSync(oldData, { recursive: true });
    fs.writeFileSync(path.join(oldData, "queue-marker"), "synthetic state");
    fs.mkdirSync(oldInstall, { recursive: true });
    fs.rmSync(oldInstall, { recursive: true });
    assert.equal(fs.readFileSync(path.join(resolver.resolvePluginDataRoot(newInstall, {}), "queue-marker"), "utf8"), "synthetic state");
  });
}
