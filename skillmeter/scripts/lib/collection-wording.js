/**
 * The words for the collection state (ADR 003, decision 5): one table, read
 * by the SessionStart card, /skillmeter:telemetry status and the notices that
 * collection stopped or can resume. A new terminal reason adds a row here.
 * Plain text: systemMessage shows ANSI escape codes literally.
 */

const SIGN_IN = "/skillmeter:signin";

// Why the client is not collecting, by state, or by terminal reason for
// delivery_paused. Decision 5's table, with the pause its amendment added.
const REASONS = Object.freeze({
  never_signed_in: "not signed in",
  token_missing: "license token missing",
  signed_out: "signed out",
  revoked: "organization license inactive",
  reactivation_required: "sign-in expired",
  backoff_exhausted: "license refresh failed repeatedly",
  paused: "paused for every repository",
});

// The capture gate's mode, which is the reason of unconfigured and recording.
const GATE_REASONS = Object.freeze({
  global_disabled: "telemetry globally disabled",
  not_signed_in: "not signed in",
  cwd_unavailable: "hook cwd missing or invalid",
  out_of_scope: "repository outside the licensed org",
  org_consent_required: "organization telemetry choice required",
  org_disabled: "telemetry disabled for this organization",
  project_disabled: "telemetry disabled for this project",
  repository_consent_required: "repository telemetry choice required",
  project_enabled: "telemetry enabled for this repository",
});
const GATE_FALLBACK = "telemetry not enabled";

// What a repository that does not record needs next: its setup card's command,
// or, for a setting the user turned off, the command that turns it back on.
const GATE_COMMANDS = Object.freeze({
  org_consent_required: SIGN_IN,
  org_disabled: SIGN_IN,
  repository_consent_required: "/skillmeter:telemetry list",
  project_disabled: "/skillmeter:telemetry list",
});

function gateReason(mode) {
  return GATE_REASONS[mode] || GATE_FALLBACK;
}

// A resolved state ({ state, reason }) in words.
function reasonText({ state, reason }) {
  if (state === "unconfigured" || state === "recording") return gateReason(reason);
  if (state === "delivery_paused") return REASONS[reason] || reason;
  return REASONS[state] || state;
}

// The one command that changes the state, or "" when there is none.
function nextCommand({ state, reason }) {
  switch (state) {
    case "paused":
      return "/skillmeter:telemetry enable-global";
    case "signed_out":
    case "never_signed_in":
    case "token_missing":
    case "revoked":
    case "delivery_paused":
      return SIGN_IN;
    case "unconfigured":
      return GATE_COMMANDS[reason] || "";
    default:
      return "";
  }
}

// A revoked license is restored by an administrator, not by signing in alone
// (decision 5): the card, the status command and the stop line say so.
const ADMINISTRATOR = "contact your administrator";

function needsAdministrator({ state }) {
  return state === "revoked";
}

// Decision 2's lines. `group` is the one the client entered.
const STOPPED = Object.freeze({
  capture_stopped: "telemetry cannot be collected on this device",
  delivery_paused: "uploads paused on this device",
});

function stoppedNotice(result, group) {
  const administrator = needsAdministrator(result) ? ` · ${ADMINISTRATOR}` : "";
  return `✗ SkillMeter · ${reasonText(result)} · ${STOPPED[group]} · run ${SIGN_IN}${administrator}`;
}

// The one line without a next command: there is none to give.
const RESUMED_NOTICE = "✓ SkillMeter · signed in · telemetry can be collected on this device";

module.exports = {
  REASONS,
  GATE_REASONS,
  ADMINISTRATOR,
  gateReason,
  reasonText,
  nextCommand,
  needsAdministrator,
  stoppedNotice,
  RESUMED_NOTICE,
};
