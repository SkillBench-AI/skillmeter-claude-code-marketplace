#!/usr/bin/env node
/**
 * Report detached sign-in results from the sentinel watched by SessionStart.
 * Emit systemMessage and an OSC 777 desktop notification; keep ANSI color out
 * of systemMessage.
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
const { readStdinJson } = require("./lib/io");
const { recordSigninNoticeShown } = require("./lib/collection-notice");
const { acquireLock } = require("./lib/credential-lock");

// Dedupe marker: FileChanged can fire more than once per change, and re-fires
// on unrelated writes. We notify once per result `ts`. Kept next to the sentinel
// (in this client's account directory) and never itself watched, so writing it
// can't re-trigger us.
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

// Claim result `ts` for this session. Every open session's handler starts at
// the same moment, so the check and the claim are one step under a lock.
function claimResult(ts) {
  const deadline = Date.now() + 2000;
  let release;
  while (!(release = acquireLock(`${NOTIFIED_MARKER}.lock`))) {
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    let lastTs = null;
    try {
      lastTs = Number(fs.readFileSync(NOTIFIED_MARKER, "utf8")) || null;
    } catch {}
    if (ts && ts === lastTs) return false;
    try {
      fs.writeFileSync(NOTIFIED_MARKER, String(ts || ""), { mode: 0o600 });
    } catch {}
    return true;
  } finally {
    release();
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const input = await readStdinJson({ empty: {} }).catch(() => null);
  const result = credstore.readSigninResult();
  // `pending` marks a device flow in progress; only its outcome is reported.
  if (!result || result.status === "none" || result.status === "pending") return;

  // Only notify once per distinct result, in one session.
  if (!claimResult(result.ts)) return;

  if (result.status === "success") {
    // This session's notice says the client is signed in, so its collection
    // notice leaves the line out (lib/collection-notice).
    recordSigninNoticeShown(input?.session_id, result.ts);
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
