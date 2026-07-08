/**
 * SkillMeter status banners (shown via the SessionStart hook `systemMessage`
 * and the /skillmeter:signin flow).
 *
 * One compact, content-sized box for every state: a marker + brand line
 * (`SkillMeter · skillbench`) and a one-line status. The box auto-sizes to its
 * longest line.
 *
 * NO ANSI color: the SessionStart `systemMessage` renderer does not interpret
 * SGR escape codes — it prints them literally as garbage. Box-drawing glyphs
 * and ✓/✗/· are plain Unicode and render fine, so structure comes from the box
 * and markers, not color.
 */

// Content-sized box (1-space padding each side). ✓/✗/·/box glyphs are all
// single-column, so [...l].length measures the visible width correctly.
function box(lines) {
  const width = Math.max(...lines.map((l) => [...l].length));
  const rule = "─".repeat(width + 2);
  const body = lines.map((l) => `│ ${l}${" ".repeat(width - [...l].length)} │`);
  return ["", `╭${rule}╮`, ...body, `╰${rule}╯`, ""].join("\n");
}

// Brand line: <marker>  SkillMeter · skillbench
function brandLine(marker) {
  return `${marker}  SkillMeter · skillbench`;
}

// Shown on /skillmeter:signin success. `scope` is a getRepoScopeDecision(cwd)
// result — we show what telemetry ACTUALLY tracks for the current repo (the
// matched org), not the user's full org membership. Outside scope, we say so.
function welcomeBanner(scope) {
  const status = scope && scope.allowed && scope.remoteOrg
    ? `Tracking this repo · @${scope.remoteOrg}`
    : "Signed in · this repo not tracked";
  return box([brandLine("✓"), status]);
}

// Shown at SessionStart when no valid license JWT is detected.
function signInRequiredBanner() {
  return box([brandLine("✗"), "Not signed in — run /skillmeter:signin"]);
}

// Shown at SessionStart when telemetry is actively capturing this session.
function telemetryActiveBanner(org) {
  return box([brandLine("✓"), org ? `Telemetry active · @${org}` : "Telemetry active"]);
}

module.exports = { welcomeBanner, signInRequiredBanner, telemetryActiveBanner };
