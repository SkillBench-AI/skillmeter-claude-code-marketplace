/**
 * SkillMeter status banners (shown via the SessionStart hook `systemMessage`
 * and the /skillmeter:signin flow).
 *
 * One content-sized card for every state. The title lives in the border while
 * the body gives the state, scope, privacy posture, and one next action. The
 * card auto-sizes to its longest line.
 *
 * NO ANSI color: the SessionStart `systemMessage` renderer does not interpret
 * SGR escape codes — it prints them literally as garbage. Box-drawing glyphs
 * and ✓/✗/· are plain Unicode and render fine, so structure comes from the box
 * and markers, not color.
 */

const { PLUGIN_VERSION } = require("./paths");

// Content-sized card (2-space body padding). All glyphs used here are
// single-column, so [...value].length measures the visible width correctly.
function card(lines) {
  const title = `SkillMeter v${PLUGIN_VERSION}`;
  const bodyWidth = Math.max(
    [...title].length,
    ...lines.map((line) => [...line].length)
  );
  const innerWidth = bodyWidth + 4;
  const titleRule = `─ ${title} `;
  const top = `╭${titleRule}${"─".repeat(innerWidth - [...titleRule].length)}╮`;
  const body = lines.map((line) => {
    const padding = " ".repeat(bodyWidth - [...line].length);
    return `│  ${line}${padding}  │`;
  });
  return [top, ...body, `╰${"─".repeat(innerWidth)}╯`].join("\n");
}

function orgLine(org) {
  return `Organization  @${org}`;
}

function manageLine(command) {
  return `Manage        ${command}`;
}

function telemetryConsentRequiredBanner(org) {
  return card([
    "[ TELEMETRY SETUP ]",
    "",
    orgLine(org),
    "Status        OFF — nothing is being sent",
    "",
    "→ /skillmeter:signin to review",
  ]);
}

function telemetryRepositoryRequiredBanner(org, repository = "") {
  const lines = [
    "[ REPOSITORY SETUP ]",
    "",
    orgLine(org),
  ];
  if (repository) lines.push(`Repository    ${repository}`);
  lines.push(
    "Status        OFF — full repository telemetry not selected",
    "Audit         Excluded hooks send HMAC cwd only",
    "",
    "→ /skillmeter:telemetry list"
  );
  return card(lines);
}

function signinRepositoryInventoryBanner(org, repositories = []) {
  const enabled = repositories.filter(
    (repository) => repository.effective === "enabled"
  );
  const lines = [
    "[ REPOSITORY REVIEW ]",
    "",
    orgLine(org),
    `Telemetry ON  ${enabled.length}`,
    `Discovered    ${repositories.length}`,
    "",
  ];
  if (repositories.length === 0) {
    lines.push("No local organization repositories found.");
  } else {
    for (const repository of repositories) {
      const marker = repository.effective === "enabled" ? "✓ ON " : "○ OFF";
      lines.push(`${marker}  ${repository.displayName}`);
    }
  }
  lines.push("", "→ /skillmeter:signin to review");
  return card(lines);
}

// Shown after sign-in and whenever /skillmeter:signin manages an existing
// consent. Authentication is deliberately distinct from telemetry permission.
function signinStatusBanner(org, consent, repositoryEnabled = false) {
  if (!org) {
    return card([
      "[ SIGNED IN ]",
      "",
      "No licensed organization was found.",
    ]);
  }
  if (consent === null) return telemetryConsentRequiredBanner(org);
  if (consent === false) {
    return card([
      "[ TELEMETRY OFF ]",
      "",
      orgLine(org),
      "No telemetry is being sent.",
      "",
      manageLine("/skillmeter:signin"),
    ]);
  }
  if (repositoryEnabled) return telemetryActiveBanner(org);
  return card([
    "[ REPOSITORY OFF ]",
    "",
    orgLine(org),
    "Organization authorized.",
    "No full repository telemetry is active here.",
    "Excluded hooks send type, reason, and HMAC cwd.",
    "",
    manageLine("/skillmeter:telemetry list"),
  ]);
}

// Shown at SessionStart when no valid license JWT is detected.
function signInRequiredBanner() {
  return card([
    "[ ACTION REQUIRED ]",
    "",
    "Sign in to verify this repository.",
    "Telemetry remains OFF until you choose.",
    "",
    "→ /skillmeter:signin",
  ]);
}

// Shown at SessionStart when telemetry is actively capturing this session.
function telemetryActiveBanner(org) {
  const lines = [
    "[ TELEMETRY ON ]",
    "",
  ];
  if (org) lines.push(orgLine(org));
  lines.push(
    "Sanitized telemetry is active in this repository.",
    "",
    manageLine("/skillmeter:telemetry list")
  );
  return card(lines);
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
  telemetryConsentRequiredBanner,
  telemetryRepositoryRequiredBanner,
  signinRepositoryInventoryBanner,
  telemetryActiveBanner,
  telemetrySentNotice,
  telemetryFailedNotice,
};
