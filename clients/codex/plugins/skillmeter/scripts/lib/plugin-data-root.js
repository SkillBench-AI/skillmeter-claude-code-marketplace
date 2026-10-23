"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Queue data a previous version may have left inside its own installation.
// Observation markers and routing indexes written by skill commands are not
// queued payloads and do not hold inference.
function hasQueuedData(logs) {
  let entries;
  try { entries = fs.readdirSync(logs, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return entries.some(entry => {
    if (/^events\.jsonl/.test(entry.name)) return true;
    if (entry.name !== "transcripts" || !entry.isDirectory()) return false;
    return fs.readdirSync(path.join(logs, entry.name), { recursive: true })
      .some(name => fs.statSync(path.join(logs, entry.name, String(name))).isFile());
  });
}

// The installation's versionless plugin directory when `pluginRoot` has the
// documented host layout `plugins/cache/<marketplace>/<plugin>/<version>`.
function installedPlugin(pluginRoot) {
  if (!pluginRoot) return null;
  const plugin = path.dirname(path.resolve(pluginRoot)), marketplace = path.dirname(plugin), cache = path.dirname(marketplace);
  const plugins = path.dirname(cache);
  return path.basename(cache) === "cache" && path.basename(plugins) === "plugins"
    ? { plugin, marketplace, plugins } : null;
}

// Codex documents PLUGIN_DATA for hook commands only. Hooks record the value
// they were given so skill commands, which get no PLUGIN_DATA, use the same
// directory instead of inferring an undocumented one.
const recordFile = () => path.join(require("./config").sessionDir(), "plugin-data.json");

function readRecorded(install) {
  try {
    const record = JSON.parse(fs.readFileSync(recordFile(), "utf8"));
    if (record && record.plugin === install.plugin && typeof record.data === "string" &&
        path.isAbsolute(record.data) && fs.statSync(record.data).isDirectory()) return record.data;
  } catch {}
  return "";
}

// Best effort: a failed write leaves skill commands on inference.
function recordHookData(install, data) {
  try {
    const file = recordFile();
    try {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      if (current.plugin === install.plugin && current.data === data) return;
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ plugin: install.plugin, data }) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {}
}

// Hooks supply PLUGIN_DATA; skill commands and monitors run without it. They
// use the directory hooks recorded for this installation, else the host layout
// `plugins/cache/<marketplace>/<plugin>/<version>`, whose data directory is
// `plugins/data/<plugin>-<marketplace>`. Durable queues never live in a
// versioned installation, which an update replaces.
function resolvePluginDataRoot(pluginRoot, env = process.env) {
  const explicit = typeof env.PLUGIN_DATA === "string" && env.PLUGIN_DATA && !env.PLUGIN_DATA.includes("${")
    ? env.PLUGIN_DATA : "";
  const install = installedPlugin(pluginRoot);
  let data = explicit ? path.resolve(explicit) : "";
  if (data && install) recordHookData(install, data);
  if (!data && install) data = readRecorded(install);
  if (!data && install) {
    const { plugin, marketplace, plugins } = install;
    // Do not silently switch queues an older direct invocation wrote
    // beside its executable to an empty persistent directory.
    let versions = [];
    try { versions = fs.readdirSync(plugin, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const entry of versions) {
      const logs = path.join(plugin, entry.name, "logs");
      if (entry.isDirectory() && hasQueuedData(logs)) {
        throw new Error(`legacy-install-data-recovery-required: queued data remains in ${logs}; move it into the plugin data directory or remove it`);
      }
    }
    // Codex creates plugins/cache on install but plugins/data only when a
    // hook first runs, so a skill command may be the first to need it.
    data = path.join(plugins, "data", `${path.basename(plugin)}-${path.basename(marketplace)}`);
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  }
  if (!data) {
    throw new Error("persistent-plugin-data-unavailable: set PLUGIN_DATA to a writable directory; this plugin root is not a Codex plugin installation");
  }
  // Background drains inherit the exact resolved path.
  env.PLUGIN_DATA = data;
  return data;
}
module.exports = { resolvePluginDataRoot };
