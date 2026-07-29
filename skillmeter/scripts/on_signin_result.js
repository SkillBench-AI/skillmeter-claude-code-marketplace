#!/usr/bin/env node
/**
 * FileChanged handler for the sign-in sentinel (STATE_DIR/signin-result.json).
 *
 * When the detached background sign-in poller finishes, it records the outcome
 * in the sentinel. SessionStart registers that file via `watchPaths`, so this
 * hook fires here and surfaces the result — a welcome banner + desktop
 * notification on success, an error nudge on failure — WITHOUT the user having
 * to re-run /skillmeter:signin.
 *
 * Output: `systemMessage` (in-UI notice) + `terminalSequence` (OSC 777 desktop
 * notification). No color in systemMessage (the renderer prints ANSI literally).
 */

const fs = require("fs");
const path = require("path");
const credstore = require("./credstore.js");
const {
  signinRepositoryInventoryBanner,
  signinStatusBanner,
} = require("./lib/banner.js");
const { getRepoScopeDecision } = require("./lib/repo-scope");
const {
  loadRepositoryTelemetryState,
  publicRepositoryState,
} = require("./lib/repository-telemetry");
const telemetryStore = require("./lib/telemetry-store");

// Dedupe marker: FileChanged can fire more than once per change, and re-fires
// on unrelated writes. We notify once per result `ts`. Kept next to the sentinel
// (in STATE_DIR) and never itself watched, so writing it can't re-trigger us.
const NOTIFIED_MARKER = path.join(
  path.dirname(credstore.SIGNIN_RESULT_FILE),
  ".signin-notified"
);

// OSC 777 desktop notification. Real ESC/BEL bytes; Claude Code emits the
// terminalSequence to the terminal verbatim (this field DOES honor escapes,
// unlike systemMessage).
function osc777(title, body) {
  return `\u001b]777;notify;${title};${body}\u0007`;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const result = credstore.readSigninResult();
  if (!result || result.status === "none") return;

  // Only notify once per distinct result.
  let lastTs = null;
  try {
    lastTs = Number(fs.readFileSync(NOTIFIED_MARKER, "utf8")) || null;
  } catch {}
  if (result.ts && result.ts === lastTs) return;
  try {
    fs.writeFileSync(NOTIFIED_MARKER, String(result.ts || ""), { mode: 0o600 });
  } catch {}

  if (result.status === "success") {
    const scope = getRepoScopeDecision(process.cwd());
    const org = credstore.getAllowedGitHubOrgs()[0] || "";
    const consent = org ? telemetryStore.getOrganizationConsent(org) : null;
    const repositoryEnabled =
      !telemetryStore.getGlobalDisabled() &&
      scope.allowed &&
      scope.remoteOrg === org &&
      telemetryStore.getRepositoryOverride(scope.repoKey) === true;
    const body = !org
      ? "Signed in — license has no telemetry organization"
      : consent === null
        ? `Signed in to @${org} — run /skillmeter:signin to choose telemetry`
        : consent
          ? `Signed in to @${org} — choose repositories for telemetry`
          : `Signed in — telemetry off for @${org}`;
    let repositories = [];
    if (org) {
      try {
        const state = publicRepositoryState(
          await loadRepositoryTelemetryState()
        );
        repositories = state.repositories.filter(
          (repository) => repository.org === org
        );
      } catch {}
    }
    const messages = [signinStatusBanner(org, consent, repositoryEnabled)];
    if (org) {
      messages.push(signinRepositoryInventoryBanner(org, repositories));
    }
    emit({
      systemMessage: messages.join("\n"),
      terminalSequence: osc777("SkillMeter", body),
    });
    return;
  }

  if (result.status === "failure") {
    const why = result.error ? ` — ${result.error}` : "";
    emit({
      systemMessage: `SkillMeter: sign-in failed${why}. Run /skillmeter:signin to retry.`,
      terminalSequence: osc777("SkillMeter", "Sign-in failed — run /skillmeter:signin to retry"),
    });
    return;
  }
  // "discarded" (signed out during poll) → intentional, no notification.
}

main().catch(() => {});
