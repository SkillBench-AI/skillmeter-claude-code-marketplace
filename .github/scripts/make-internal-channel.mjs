#!/usr/bin/env node
// Turn a checkout of `next` into the internal channel build: the plugin
// defaults to the dev environment, its version becomes a prerelease of the
// next patch (so it sorts after the current release and before the next
// one), and the marketplace is renamed so its installation and plugin data
// never collide with the stable channel's.
// Usage: node .github/scripts/make-internal-channel.mjs [repo-root] [--build N]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const buildIndex = args.indexOf("--build");
const build = buildIndex >= 0 ? args.splice(buildIndex, 2)[1] : "0";
if (!/^(0|[1-9]\d*)$/.test(build || "")) throw new Error(`--build must be a non-negative integer, got "${build}"`);
const root = resolve(args[0] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const manifest = join(root, ".claude-plugin/marketplace.json");
const marketplace = JSON.parse(readFileSync(manifest, "utf8"));
if (marketplace.name !== "skillbench") {
  throw new Error(`.claude-plugin/marketplace.json: expected marketplace "skillbench", found "${marketplace.name}"`);
}
marketplace.name = "skillbench-internal";
marketplace.description = `${marketplace.description} Internal channel: tracks next against the dev environment.`;
writeFileSync(manifest, JSON.stringify(marketplace, null, 2) + "\n");

const pluginFile = join(root, "skillmeter/.claude-plugin/plugin.json");
const plugin = JSON.parse(readFileSync(pluginFile, "utf8"));
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(plugin.version);
if (!match) throw new Error(`plugin.json: expected a release version, found "${plugin.version}"`);
plugin.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-internal.${build}`;
writeFileSync(pluginFile, JSON.stringify(plugin, null, 2) + "\n");

writeFileSync(join(root, "skillmeter/channel.json"),
  JSON.stringify({ channel: "internal", env: "dev" }, null, 2) + "\n");
console.log(`internal channel ${plugin.version} prepared in ${root}`);
