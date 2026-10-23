/**
 * Terminal cards for sign-in, status and consent results. Box-drawing glyphs,
 * the checkmark and the arrow are assumed to occupy one terminal column each.
 */
const path = require("path");

let version = "";
try { version = require(path.join(__dirname, "..", "..", ".codex-plugin", "plugin.json")).version || ""; }
catch { /* An unreadable manifest only drops the version from the title. */ }

// Names a non-stable channel and its environment so the destination is visible.
function channelLabel() {
  const { channel, env } = require("./config").channel();
  return channel === "stable" ? "" : ` · ${channel} (${env})`;
}

// Content-sized card with a titled top border, as in the Claude plugin.
function card(lines) {
  const title = `${version ? `SkillMeter v${version}` : "SkillMeter"}${channelLabel()}`;
  const bodyWidth = Math.max([...title].length, ...lines.map(line => [...line].length));
  const innerWidth = bodyWidth + 4;
  const titleRule = `─ ${title} `;
  const top = `╭${titleRule}${"─".repeat(innerWidth - [...titleRule].length)}╮`;
  const body = lines.map(line => `│  ${line}${" ".repeat(bodyWidth - [...line].length)}  │`);
  return ["", top, ...body, `╰${"─".repeat(innerWidth)}╯`, ""].join("\n");
}

const row = (label, value) => `${label.padEnd(14)}${value}`;

const SIGNED_IN = row("Sign-in", "✓ signed in");

// The organization's state for this sign-in, as the Claude plugin's
// signinStatusBanner: authentication is shown apart from telemetry permission.
// `current` is the working directory's repository when it belongs to `org`.
function organizationStatusCard({ org, consent, globalPaused, repositories, current }) {
  const on = repositories.filter(repo => repo.effective === "on").length;
  const lines = (title, status, next, extra = []) => card([title, "", SIGNED_IN, row("Organization", `@${org}`),
    ...(current ? [row("Repository", current.displayName.slice(1))] : []), ...extra, row("Status", status), "", next]);
  if (globalPaused) {
    return lines("[ PAUSED ]", "OFF — Codex telemetry is paused on this machine", "→ $skillmeter:telemetry enable-global");
  }
  if (consent === null) return lines("[ TELEMETRY SETUP ]", "OFF — nothing is being sent", "→ Choose below, or later with $skillmeter:signin");
  if (consent === false) return lines("[ TELEMETRY OFF ]", `OFF — @${org} is turned off`, "→ $skillmeter:signin to turn it on");
  if (current?.effective === "on") return lines("[ TELEMETRY ON ]", "ON — sanitized telemetry is active here", "→ $skillmeter:telemetry list");
  if (current) {
    const why = current.localRestriction ? "OFF — turned off in this checkout's local settings" : "OFF — this repository is not on";
    return lines("[ REPOSITORY OFF ]", why, current.localRestriction ? "→ $skillmeter:telemetry unrestrict" : "→ $skillmeter:telemetry enable");
  }
  return lines("[ ORGANIZATION ON ]", `ON for ${on} of ${repositories.length} local repositories`, "→ $skillmeter:telemetry list");
}

// Every local repository of the organization with its state, as the Claude
// plugin's signinRepositoryInventoryBanner.
function repositoryReviewCard(org, repositories) {
  const on = repositories.filter(repo => repo.effective === "on").length;
  const lines = ["[ REPOSITORY REVIEW ]", "", row("Organization", `@${org}`), row("Telemetry ON", String(on)),
    row("Discovered", String(repositories.length)), ""];
  if (!repositories.length) lines.push("No local organization repositories found.");
  for (const repo of repositories) lines.push(`${repo.effective === "on" ? "✓ ON " : "○ OFF"}  ${repo.displayName}`);
  lines.push("", "→ $skillmeter:telemetry list");
  return card(lines);
}

/**
 * Cards printed right after sign-in. `inventory` is a repository-inventory
 * result, `currentKey` the working directory's repository key, and `error` the
 * code when the consent record cannot be read.
 */
function signinBanner({ inventory, currentKey, error }) {
  if (error) {
    return card(["[ SIGNED IN ]", "", SIGNED_IN, row("Status", `OFF — consent record unavailable (${error})`),
      "", "→ $skillmeter:telemetry status"]);
  }
  if (!inventory.orgs.length) {
    // Without a connected organization no repository is in scope; say where
    // to fix that rather than welcoming nobody.
    return card(["[ SIGNED IN ]", "", SIGNED_IN, "No GitHub organization is connected to this workspace,",
      "so nothing is recorded. Connect one in SkillBench."]);
  }
  return inventory.orgs.map(({ org, consent }) => {
    const repositories = inventory.repositories.filter(repo => repo.org === org);
    const current = repositories.find(repo => repo.key === currentKey);
    return organizationStatusCard({ org, consent, globalPaused: inventory.globalPaused, repositories, current }) +
      repositoryReviewCard(org, repositories);
  }).join("");
}

const STATUS_TITLES = {
  on: "[ TELEMETRY ON ]",
  off: "[ TELEMETRY OFF ]",
  consent: "[ CONSENT REQUIRED ]",
  paused: "[ PAUSED ]",
  scope: "[ OUT OF SCOPE ]",
  signin: "[ SIGN IN REQUIRED ]",
};

const NEXT_STEPS = {
  consent: "→ Run $skillmeter:signin to choose telemetry",
  signin: "→ Run $skillmeter:signin",
  paused: "→ status --details for the cause",
  off: "→ Run $skillmeter:telemetry list to review choices",
  scope: "→ Ask Codex to check SkillMeter repository scope",
  on: "→ status --details for diagnostics",
};

// `capture` is { state, text } from the telemetry CLI; `text` is shown only
// when capture is not on, so a healthy status stays short.
function statusBanner({ capture, repository, signIn, queue }) {
  const lines = [STATUS_TITLES[capture.state] || STATUS_TITLES.paused, ""];
  if (repository) lines.push(row("Repository", repository));
  if (capture.state !== "on") lines.push(row("Reason", capture.text));
  lines.push(row("Sign-in", signIn));
  if (queue) lines.push(row("Queue", queue));
  lines.push("", NEXT_STEPS[capture.state] || NEXT_STEPS.paused);
  return card(lines);
}

// Result of one consent-set write.
function consentSavedBanner({ kind, target, enabled, revision, capture, cleanupDeferred, durabilityUnconfirmed }) {
  const title = kind === "organization"
    ? `[ ORGANIZATION ${enabled ? "ON" : "OFF"} ]`
    : enabled && capture?.state === "on" ? STATUS_TITLES.on : `[ REPOSITORY ${enabled ? "ON" : "OFF"} ]`;
  const lines = [title, "", row(kind === "organization" ? "Organization" : "Repository", target), row("Revision", String(revision))];
  if (!enabled) lines.push(row("Queued data", cleanupDeferred ? "cleanup deferred; delivery rechecks consent" : "removed"));
  if (kind === "repository" && enabled && capture?.state !== "on") lines.push(row("Reason", capture?.text || "unknown"));
  if (durabilityUnconfirmed) lines.push("Save not confirmed to survive a crash; check consent-preview.");
  lines.push("");
  if (kind === "organization" && enabled) lines.push("→ Next: $skillmeter:telemetry enable in the repository");
  else if (enabled && capture?.state === "on") lines.push("→ Start a new Codex session to capture from the beginning");
  else lines.push("→ status for the current state");
  return card(lines);
}

module.exports = { card, signinBanner, statusBanner, consentSavedBanner };
