"use strict";

const path = require("path");
const { SETTINGS_RELATIVE, readTelemetryChoice: localChoice } = require("./settings");

function buildConsentPreview({ cwd, scope, policy, policyError = null, repoRoot = scope.repoRoot }) {
  const result = {
    changesApplied: false,
    repository: scope.allowed ? scope.repoKey ?? null : null,
    localChoices: [],
    notices: [],
  };
  const notice = (code, message) => result.notices.push({ code, message });
  if (repoRoot) {
    const root = path.resolve(repoRoot);
    let current = path.resolve(cwd);
    const relative = path.relative(root, current);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      while (true) {
        const choice = localChoice(current);
        if (choice !== "unset" || current === root) {
          result.localChoices.unshift({ path: path.relative(root, path.join(current, SETTINGS_RELATIVE)), choice });
        }
        if (current === root) break;
        current = path.dirname(current);
      }
    }
  }
  if (result.localChoices.some(choice => choice.choice === "invalid")) {
    notice("invalid_local_choice", "Repair invalid local settings before recording consent.");
  }
  if (result.localChoices.some(choice => choice.choice === "off")) {
    notice("local_opt_out", "A local opt-out remains a restriction; resolve it explicitly before enabling this repository.");
  }
  if (!result.repository) {
    notice("repository_unavailable", "No allowed canonical repository is available; check sign-in, organization scope and Git remotes.");
  }
  if (policyError) {
    notice(policyError.code, policyError.message);
    return result;
  }
  result.sharedRevision = policy?.revision ?? null;
  if (policy?.global.enabled === false) notice("global_pause", "Codex telemetry is paused; recording consent does not resume it.");
  if (result.repository) {
    const org = result.repository.split("/")[1];
    for (const [kind, records, key] of [
      ["organization", policy?.organizations, org],
      ["repository", policy?.repositories, result.repository],
    ]) {
      const choice = records && Object.hasOwn(records, key) ? records[key] : null;
      if (!choice) notice(`${kind}_choice_required`, `An explicit ${kind} choice is required. Local ON does not grant capture.`);
      else if (!choice.enabled) notice(`${kind}_opt_out`, `The ${kind} is OFF; this preview does not change it.`);
      else if (choice.consent_version !== 2) notice(`${kind}_acknowledgement_required`, `The ${kind} ON lacks the scope acknowledgement; record it again with --acknowledge-machine-scope.`);
    }
  }
  return result;
}

function formatConsentPreview(result) {
  return [
    "Codex consent preview. No consent settings changed.",
    `Repository: ${result.repository ?? "unavailable"}`,
    "ON applies to Codex on this machine and to every clone or worktree of the repository. It does not change SkillMeter for Claude Code.",
    `Revision: ${Object.hasOwn(result, "sharedRevision") ? result.sharedRevision ?? "absent" : "unavailable"}`,
    ...result.localChoices.map(choice => `Local choice (${choice.path}): ${choice.choice}`),
    ...result.notices.map(notice => notice.message),
    "Use consent-set to record the organization, then the repository. Local OFF settings remain in effect; this preview does not verify capture or delivery.",
  ].join("\n") + "\n";
}

module.exports = { buildConsentPreview, formatConsentPreview };
