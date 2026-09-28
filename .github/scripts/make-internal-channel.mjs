#!/usr/bin/env node
// Turn a checkout of main into the internal channel build: the plugin defaults
// to the dev environment, and the marketplace is renamed so its installation
// and plugin data never collide with the stable channel's.
// Usage: node .github/scripts/make-internal-channel.mjs [repo-root]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const manifest = join(root, ".claude-plugin/marketplace.json");
const marketplace = JSON.parse(readFileSync(manifest, "utf8"));
if (marketplace.name !== "skillbench") {
  throw new Error(`.claude-plugin/marketplace.json: expected marketplace "skillbench", found "${marketplace.name}"`);
}
marketplace.name = "skillbench-internal";
marketplace.description = `${marketplace.description} Internal channel: tracks main against the dev environment.`;
writeFileSync(manifest, JSON.stringify(marketplace, null, 2) + "\n");

writeFileSync(join(root, "skillmeter/channel.json"),
  JSON.stringify({ channel: "internal", env: "dev" }, null, 2) + "\n");
console.log(`internal channel prepared in ${root}`);
