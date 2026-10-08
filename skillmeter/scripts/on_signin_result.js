#!/usr/bin/env node
/**
 * Report detached sign-in results from the sentinel watched by SessionStart.
 * Emit systemMessage and an OSC 777 desktop notification; keep ANSI color out
 * of systemMessage.
 */

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
const { readStdinJson } = require("./lib/io");
const {
  holdSigninNotice,
  lastSigninNoticeShown,
  recordSigninNoticeShown,
} = require("./lib/collection-notice");

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
  const input = await readStdinJson({ empty: {} }).catch(() => null);
  const result = credstore.readSigninResult();
  // `pending` marks a device flow in progress; only its outcome is reported.
  if (!result || result.status === "none" || result.status === "pending") return;

  // Every open session shows each result once: FileChanged may report one write
  // more than once, so each session remembers the last result it showed, and
  // its handlers take turns. The memory is written once the notice is printed,
  // so a notice killed before that leaves nothing recorded.
  const sessionId = input?.session_id;
  const shown = () => result.ts && result.ts <= lastSigninNoticeShown(sessionId);
  if (shown()) return;
  const release = holdSigninNotice(sessionId);
  if (!release) return;
  try {
    if (!shown()) await showResult(result, sessionId);
  } finally {
    release();
  }
}

async function showResult(result, sessionId) {
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
    // This session's notice says the client is signed in, so its collection
    // notice leaves the return line out (lib/collection-notice).
    recordSigninNoticeShown(sessionId, result.ts);
    return;
  }

  if (result.status === "failure") {
    // The error is a sentence already; the line adds its own full stop.
    const why = result.error ? ` — ${String(result.error).replace(/[.\s]+$/, "")}` : "";
    emit({
      systemMessage: `SkillMeter: sign-in failed${why}. Run /skillmeter:signin to retry.`,
      terminalSequence: osc777("SkillMeter", "Sign-in failed — run /skillmeter:signin to retry"),
    });
    recordSigninNoticeShown(sessionId, result.ts);
    return;
  }
  // "discarded" (signed out during poll) → intentional, no notification.
}

main().catch(() => {});
