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

const { PLUGIN_VERSION } = require("./paths");

// Content-sized box (1-space padding each side). ✓/✗/·/box glyphs are all
// single-column, so [...l].length measures the visible width correctly.
function box(lines) {
  const width = Math.max(...lines.map((l) => [...l].length));
  const rule = "─".repeat(width + 2);
  const body = lines.map((l) => `│ ${l}${" ".repeat(width - [...l].length)} │`);
  return ["", `╭${rule}╮`, ...body, `╰${rule}╯`, ""].join("\n");
}

// Brand line: <marker>  SkillMeter v<version> · skillbench. The running plugin
// version is shown so a stale session (hooks loaded from an older cached version
// than the one installed) is immediately visible.
function brandLine(marker) {
  return `${marker}  SkillMeter v${PLUGIN_VERSION} · skillbench`;
}

// Shown after sign-in and whenever /skillmeter:signin manages an existing
// consent. Authentication is deliberately distinct from telemetry permission.
function signinStatusBanner(org, consent, scopeAllowed = false) {
  let status;
  if (!org) {
    status = "Signed in · no licensed organization";
  } else if (consent === null) {
    status = `Signed in · choose telemetry for @${org}`;
  } else if (consent === false) {
    status = `Signed in · telemetry off · @${org}`;
  } else if (scopeAllowed) {
    status = `Telemetry active · @${org}`;
  } else {
    status = `Signed in · telemetry enabled · @${org}`;
  }
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

// One-line notice shown at SessionStart after a drain uploaded telemetry.
// Plain text (systemMessage renders ANSI literally); ✓ and · are plain Unicode.
function telemetrySentNotice(events, transcripts) {
  const parts = [];
  if (events > 0) parts.push(`${events} event${events === 1 ? "" : "s"}`);
  if (transcripts > 0) parts.push(`${transcripts} transcript${transcripts === 1 ? "" : "s"}`);
  const what = parts.length ? ` · ${parts.join(", ")}` : "";
  return `✓ SkillMeter · telemetry sent${what}`;
}

// One-line notice shown at SessionStart when the last drain failed to transmit.
function telemetryFailedNotice(error) {
  return `✗ SkillMeter · telemetry send failed${error ? ` · ${error}` : ""}`;
}

module.exports = {
  signinStatusBanner,
  signInRequiredBanner,
  telemetryActiveBanner,
  telemetrySentNotice,
  telemetryFailedNotice,
};
