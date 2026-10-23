#!/usr/bin/env node
// Turn a checkout of `next` into the internal channel build: each plugin
// defaults to the dev environment, its version becomes a prerelease of the
// next patch (so it sorts after the current release and before the next
// one), and each marketplace is renamed so its installation and plugin data
// never collide with the stable channel's.
//
// One build for both clients, because both read the same `internal` branch:
// Claude Code reads `.claude-plugin/marketplace.json`, Codex reads
// `.agents/plugins/marketplace.json`, and each plugin lives under its client.
// Usage: node .github/scripts/make-internal-channel.mjs [repo-root] [--build N]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const buildIndex = args.indexOf("--build");
const build = buildIndex >= 0 ? args.splice(buildIndex, 2)[1] : "0";
if (!/^(0|[1-9]\d*)$/.test(build || "")) throw new Error(`--build must be a non-negative integer, got "${build}"`);
const root = resolve(args[0] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const clients = [
  {
    marketplace: ".claude-plugin/marketplace.json",
    plugin: "clients/claude-code/skillmeter",
    pluginManifest: ".claude-plugin/plugin.json",
    // Claude Code shows the marketplace description; it has no display name.
    rename: (marketplace) => {
      marketplace.description = `${marketplace.description} Internal channel: tracks next against the dev environment.`;
    },
  },
  {
    marketplace: ".agents/plugins/marketplace.json",
    plugin: "clients/codex/plugins/skillmeter",
    pluginManifest: ".codex-plugin/plugin.json",
    rename: (marketplace) => {
      marketplace.interface = { ...marketplace.interface, displayName: "SkillBench (internal)" };
    },
  },
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

for (const client of clients) {
  const manifest = join(root, client.marketplace);
  const marketplace = readJson(manifest);
  if (marketplace.name !== "skillbench") {
    throw new Error(`${client.marketplace}: expected marketplace "skillbench", found "${marketplace.name}"`);
  }
  marketplace.name = "skillbench-internal";
  client.rename(marketplace);
  writeJson(manifest, marketplace);

  const pluginFile = join(root, client.plugin, client.pluginManifest);
  const plugin = readJson(pluginFile);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(plugin.version);
  if (!match) throw new Error(`${client.plugin}/${client.pluginManifest}: expected a release version, found "${plugin.version}"`);
  plugin.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-internal.${build}`;
  writeJson(pluginFile, plugin);

  writeJson(join(root, client.plugin, "channel.json"), { channel: "internal", env: "dev" });
  console.log(`internal channel ${client.plugin} ${plugin.version} prepared in ${root}`);
}
