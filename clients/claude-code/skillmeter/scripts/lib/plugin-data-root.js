/**
 * Resolve persistent plugin data from CLAUDE_PLUGIN_DATA or the installed layout.
 * Hooks receive the variable.
 * Skill commands start with node to match their tool grant, so they rely on
 * derivation from the caller's resolved plugin root.
 *
 * Derive <config>/plugins/data/<plugin>-<marketplace> only from a recognized
 * cache layout with an existing data parent. Never use the install directory as
 * a queue fallback. Keep this module independent of paths and credentials.
 */

const fs = require("fs");
const path = require("path");

function derivePluginDataRoot(pluginRoot) {
  if (!pluginRoot) return "";
  const versionDir = path.resolve(pluginRoot);
  const pluginDir = path.dirname(versionDir);
  const marketplaceDir = path.dirname(pluginDir);
  const cacheDir = path.dirname(marketplaceDir);
  if (path.basename(cacheDir) !== "cache") return "";

  const plugin = path.basename(pluginDir);
  const marketplace = path.basename(marketplaceDir);
  if (!plugin || !marketplace) return "";

  const dataParent = path.join(path.dirname(cacheDir), "data");
  try {
    if (!fs.statSync(dataParent).isDirectory()) return "";
  } catch {
    return "";
  }
  return path.join(dataParent, `${plugin}-${marketplace}`);
}

// Another plugin's SessionStart hook can export its own CLAUDE_PLUGIN_DATA
// through CLAUDE_ENV_FILE, and every `!` and Bash command in the session then
// inherits it. A provided root that sits beside ours in the host's data dir
// but names a different plugin is that leak, not an override.
function belongsToOtherPlugin(provided, derived, pluginRoot) {
  if (!derived) return false;
  const resolved = path.resolve(provided);
  if (path.dirname(resolved) !== path.dirname(derived)) return false;
  const plugin = path.basename(path.dirname(path.resolve(pluginRoot)));
  return !path.basename(resolved).startsWith(`${plugin}-`);
}

/**
 * @param {string} pluginRoot the caller's already-resolved plugin root, which
 *   must include its own `__dirname` fallback — a skill process has neither
 *   CLAUDE_PLUGIN_DATA nor CLAUDE_PLUGIN_ROOT in its environment.
 * @returns {string} the data root, or "" when it cannot be established.
 * On a successful derivation the value is written back to
 * `process.env.CLAUDE_PLUGIN_DATA` so detached children (drain_once,
 * backfill_worker) inherit the identical root instead of re-deriving it.
 */
function resolvePluginDataRoot(pluginRoot, env = process.env) {
  // A host that does not substitute the placeholder hands us the literal
  // "${CLAUDE_PLUGIN_DATA}". Creating a directory by that name would be worse
  // than falling through to derivation.
  const provided = env.CLAUDE_PLUGIN_DATA;
  const derived = derivePluginDataRoot(pluginRoot);
  if (provided && !provided.includes("${") && !belongsToOtherPlugin(provided, derived, pluginRoot)) {
    return provided;
  }

  if (derived) env.CLAUDE_PLUGIN_DATA = derived;
  return derived;
}

module.exports = {
  derivePluginDataRoot,
  resolvePluginDataRoot,
};
