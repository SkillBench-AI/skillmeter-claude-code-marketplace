/**
 * Pure telemetry capture policy.
 *
 * Org consent is the parent authorization. Project settings may opt a repo out
 * (or record an explicit opt-in), but can never override missing/disabled org
 * consent. Network drainers separately enforce the same global + org boundary.
 */

function resolveTelemetryGate({
  globalDisabled,
  hasValidLicense,
  repoOrgOwned,
  orgConsent,
  projectOptIn,
}) {
  if (globalDisabled) return { capture: false, mode: "global_disabled" };
  if (!hasValidLicense) return { capture: false, mode: "not_signed_in" };
  if (!repoOrgOwned) return { capture: false, mode: "out_of_scope" };
  if (orgConsent === null) return { capture: false, mode: "org_consent_required" };
  if (orgConsent !== true) return { capture: false, mode: "org_disabled" };
  if (projectOptIn === false) return { capture: false, mode: "project_disabled" };
  return {
    capture: true,
    mode: projectOptIn === true ? "project_enabled" : "org_enabled",
  };
}

module.exports = { resolveTelemetryGate };
