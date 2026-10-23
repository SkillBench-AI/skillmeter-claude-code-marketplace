"use strict";
// Codex sets PLUGIN_ROOT only for hook commands, so skill instructions name
// scripts relative to the plugin root the agent resolves from the skill file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");

const plugin = path.resolve(__dirname, "..", "..");
const skills = fs.readdirSync(path.join(plugin, "skills"))
  .map(name => path.join(plugin, "skills", name, "SKILL.md"))
  .filter(file => fs.existsSync(file));

test("skill commands use <plugin-root> and point at scripts that exist", () => {
  for (const file of skills) {
    const text = fs.readFileSync(file, "utf8");
    const commands = [...text.matchAll(/node "([^"]+)"/g)].map(match => match[1]);
    for (const command of commands) {
      assert.match(command, /^<plugin-root>\//, `${path.relative(plugin, file)}: ${command}`);
      const script = path.join(plugin, command.slice("<plugin-root>/".length));
      assert.equal(fs.existsSync(script), true, `${path.relative(plugin, file)}: missing ${command}`);
    }
    if (commands.length) assert.match(text, /two levels above this `SKILL\.md`/, path.relative(plugin, file));
  }
});
