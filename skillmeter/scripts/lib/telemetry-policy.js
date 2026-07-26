/**
 * Pure telemetry capture policy.
 *
 * Org consent is the parent authorization. A repository must also have an
 * explicit opt-in; an unset repository stays off until the user selects it.
 * Network drainers separately enforce the same global + org + repo boundary.
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
  if (projectOptIn !== true) {
    return { capture: false, mode: "repository_consent_required" };
  }
  return { capture: true, mode: "project_enabled" };
}

module.exports = { resolveTelemetryGate };
