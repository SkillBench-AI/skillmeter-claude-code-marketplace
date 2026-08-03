/**
 * Resolve the host-provided persistent plugin data dir.
 *
 * CLAUDE_PLUGIN_DATA is authoritative, but Claude Code only injects it into
 * hook processes. Monitors (monitors.json) and the `node ...` commands inside
 * SKILL.md are launched with CLAUDE_PLUGIN_ROOT substituted but no data dir, so
 * they must derive the SAME directory the hooks use. Deriving matters more than
 * merely having somewhere to write: a monitor that picked a different root
 * would drain a queue the hooks never fill.
 *
 * Layout created by the host:
 *   <config>/plugins/cache/<marketplace>/<plugin>/<version>  <- CLAUDE_PLUGIN_ROOT
 *   <config>/plugins/data/<plugin>-<marketplace>             <- CLAUDE_PLUGIN_DATA
 *
 * The derivation is a fallback, never a guess: it is accepted only when the
 * `plugins/data` parent the host owns actually exists. If the host ever changes
 * this layout we fail loudly (as before) instead of silently writing elsewhere.
 *
 * This is a LEAF module — fs/path only, so paths.js can use it without a cycle.
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

/**
 * @returns {string} the data root, or "" when it cannot be established.
 * On a successful derivation the value is written back to
 * `process.env.CLAUDE_PLUGIN_DATA` so detached children (drain_once,
 * backfill_worker) inherit the identical root instead of re-deriving it.
 */
function resolvePluginDataRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  const derived = derivePluginDataRoot(env.CLAUDE_PLUGIN_ROOT);
  if (derived) env.CLAUDE_PLUGIN_DATA = derived;
  return derived;
}

module.exports = {
  derivePluginDataRoot,
  resolvePluginDataRoot,
};
