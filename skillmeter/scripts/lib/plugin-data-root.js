/**
 * Resolve the host-provided persistent plugin data dir.
 *
 * Per the plugins reference, Claude Code exports CLAUDE_PLUGIN_ROOT /
 * CLAUDE_PLUGIN_DATA as environment variables only to hook processes and to
 * MCP/LSP subprocesses. Monitor commands and skill content instead get the
 * `${...}` placeholders substituted inline, so monitors.json and every SKILL.md
 * command passes CLAUDE_PLUGIN_DATA explicitly — that substitution is the
 * supported mechanism and the primary path here.
 *
 * Derivation below is only a backstop for a host that did not substitute. The
 * documented location is `~/.claude/plugins/data/{id}/`, where {id} is the
 * `plugin@marketplace` identifier with characters outside [a-zA-Z0-9_-] replaced
 * by `-`; the installed plugin root is
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>`, which yields the
 * same {id}. It is accepted only when the host's `plugins/data` parent already
 * exists, so an unexpected layout fails loudly rather than writing elsewhere.
 *
 * The plugin root is taken from the caller, never from the environment: a
 * monitor has no CLAUDE_PLUGIN_ROOT exported, only the substituted command text.
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
 * @param {string} pluginRoot the caller's already-resolved plugin root, which
 *   must include its own `__dirname` fallback — a monitor process has neither
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
  if (provided && !provided.includes("${")) return provided;

  const derived = derivePluginDataRoot(pluginRoot);
  if (derived) env.CLAUDE_PLUGIN_DATA = derived;
  return derived;
}

module.exports = {
  derivePluginDataRoot,
  resolvePluginDataRoot,
};
