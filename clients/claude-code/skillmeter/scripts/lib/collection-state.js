/**
 * Collection state (ADR 003, decision 1): whether this client collects, and
 * if not, why, as one value computed from local files. No network.
 *
 * It reports and never gates. Capture is decided by resolveTelemetryGate on
 * token presence (ADR 001, decision 3); a state here never stops or starts it.
 *
 * States, first match wins:
 *   paused           the global kill-switch is on
 *   signed_out       the user ran /skillmeter:signout
 *   revoked          the last refresh answered 402; the license was dropped
 *   token_missing    no license, and this client was signed in before
 *   never_signed_in  no license, and no sign-in was ever recorded here
 *   delivery_paused  a license is stored but only a new sign-in can renew it
 *   unconfigured     signed in, and the gate does not capture here
 *   recording        signed in, and the gate captures here
 */

const fs = require("fs");
const path = require("path");
const credstore = require("../credstore");
const telemetryStore = require("./telemetry-store");
const { getRepoScopeDecision } = require("./repo-scope");
const { resolveTelemetryGate } = require("./telemetry-policy");
const {
  TERMINAL_REASONS,
  lastTerminalReason,
  readLicenseStatus,
} = require("./license-status");

const STATES = Object.freeze({
  PAUSED: "paused",
  SIGNED_OUT: "signed_out",
  REVOKED: "revoked",
  TOKEN_MISSING: "token_missing",
  NEVER_SIGNED_IN: "never_signed_in",
  DELIVERY_PAUSED: "delivery_paused",
  UNCONFIGURED: "unconfigured",
  RECORDING: "recording",
});

// ADR 003's groups. Capture stopped: nothing is recorded until the user
// signs in. Delivery paused: recording continues, uploads wait for a sign-in.
// Every other state is healthy or the user's own choice.
const GROUPS = Object.freeze({
  CAPTURE_STOPPED: "capture_stopped",
  DELIVERY_PAUSED: "delivery_paused",
  HEALTHY: "healthy",
});

const CAPTURE_STOPPED = new Set([STATES.SIGNED_OUT, STATES.REVOKED, STATES.TOKEN_MISSING]);

function stateGroup(state) {
  if (CAPTURE_STOPPED.has(state)) return GROUPS.CAPTURE_STOPPED;
  if (state === STATES.DELIVERY_PAUSED) return GROUPS.DELIVERY_PAUSED;
  return GROUPS.HEALTHY;
}

/**
 * Pure. `reason` is the state itself, except for delivery_paused (the
 * terminal reason) and unconfigured or recording (the gate mode), so a
 * caller can word a line without reading the files again.
 *
 * @param {object} facts
 * @param {boolean} facts.globalDisabled
 * @param {boolean} facts.signedOut
 * @param {boolean} facts.hasLicense  a license is stored, fresh or not
 * @param {object}  facts.status      the license status record
 * @param {object} [facts.gate]       resolveTelemetryGate's result for the
 *   current directory; without one, a signed-in client reads as unconfigured
 *   with the gate's reason for a hook that has no working directory
 * @returns {{ state: string, reason: string }}
 */
function resolveCollectionState({ globalDisabled, signedOut, hasLicense, status, gate = null }) {
  const is = (state, reason = state) => ({ state, reason });
  if (globalDisabled) return is(STATES.PAUSED);
  if (signedOut) return is(STATES.SIGNED_OUT);
  const terminal = lastTerminalReason(status);
  // A 402 drops the license, so revoked must be read before the states that
  // only see a missing token.
  if (terminal === TERMINAL_REASONS.REVOKED) return is(STATES.REVOKED);
  if (!hasLicense) {
    return status?.last_success_at != null ? is(STATES.TOKEN_MISSING) : is(STATES.NEVER_SIGNED_IN);
  }
  // backoff_exhausted is no longer written, and a record left by an older
  // version does not stop refresh, so it is not a pause.
  if (terminal === TERMINAL_REASONS.REACTIVATION_REQUIRED) return is(STATES.DELIVERY_PAUSED, terminal);
  if (gate?.capture) return is(STATES.RECORDING, gate.mode);
  return is(STATES.UNCONFIGURED, gate?.mode || "cwd_unavailable");
}

// The gate for `cwd`, from the same inputs runHook gives resolveTelemetryGate.
function gateForCwd(cwd) {
  let cwdAvailable = false;
  if (typeof cwd === "string" && path.isAbsolute(cwd)) {
    try { cwdAvailable = fs.statSync(cwd).isDirectory(); } catch {}
  }
  const scope = cwdAvailable ? getRepoScopeDecision(cwd) : { allowed: false };
  return resolveTelemetryGate({
    globalDisabled: telemetryStore.getGlobalDisabled(),
    signedIn: credstore.isSignedIn(),
    cwdAvailable,
    repoOrgOwned: scope.allowed,
    orgConsent: scope.remoteOrg ? telemetryStore.getOrganizationConsent(scope.remoteOrg) : null,
    projectOptIn: scope.repoKey ? telemetryStore.getRepositoryOverride(scope.repoKey) : null,
  });
}

/**
 * Read the files and resolve. Pass `gate` when the caller already resolved
 * it (a hook), or `cwd` to resolve it here. With neither, a signed-in client
 * reads as unconfigured, like a hook without a working directory.
 */
function readCollectionState({ cwd = "", gate = null } = {}) {
  return resolveCollectionState({
    globalDisabled: telemetryStore.getGlobalDisabled(),
    signedOut: credstore.getSignedOut(),
    hasLicense: credstore.isSignedIn(),
    status: readLicenseStatus(),
    gate: gate || gateForCwd(cwd),
  });
}

module.exports = {
  STATES,
  GROUPS,
  stateGroup,
  resolveCollectionState,
  readCollectionState,
};
