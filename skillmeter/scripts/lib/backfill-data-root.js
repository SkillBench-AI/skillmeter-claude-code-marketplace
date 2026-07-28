"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { safeReadJson } = require("./io");

const LIFECYCLE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stateMatches(dataRoot, lifecycleId) {
  const state = safeReadJson(
    path.join(dataRoot, "backfill-state.json"),
    null
  );
  return state?.lifecycle_id === lifecycleId;
}

function pluginDataRoots() {
  const roots = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    roots.push(process.env.CLAUDE_PLUGIN_DATA);
  }
  const configRoot =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const dataParent = path.join(configRoot, "plugins", "data");
  try {
    for (const entry of fs.readdirSync(dataParent, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(dataParent, entry.name));
    }
  } catch {}
  return [...new Set(roots)];
}

function resolveBackfillDataRoot(lifecycleId) {
  if (!LIFECYCLE_ID_RE.test(lifecycleId || "")) return "";
  return pluginDataRoots().find((root) => stateMatches(root, lifecycleId)) || "";
}

function bindBackfillDataRoot(lifecycleId) {
  const dataRoot = resolveBackfillDataRoot(lifecycleId);
  if (!dataRoot) return false;
  process.env.CLAUDE_PLUGIN_DATA = dataRoot;
  return true;
}

module.exports = {
  LIFECYCLE_ID_RE,
  bindBackfillDataRoot,
  resolveBackfillDataRoot,
};
