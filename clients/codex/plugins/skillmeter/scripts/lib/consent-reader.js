"use strict";
const { createConsentStore } = require("./consent-store");
const { consentPolicyFile, evaluateRepositoryConsent: evaluateRepository } = require("./consent-policy");

// Runtime and controls use the same strict reader and durable client marker.
// No policy repair or default grant occurs on read.
function createConsentReader(observedFile) {
  function readGlobalConsent() {
    try {
      const policy = createConsentStore({ file: consentPolicyFile(), observedFile }).readPolicy();
      if (!policy) return { disabled: false, reason: "absent", boundary: null };
      return {
        policy, disabled: !policy.global.enabled,
        reason: policy.global.enabled ? "enabled" : "paused",
        boundary: JSON.stringify([policy.global.enabled, policy.global.decided_at ?? null]),
      };
    } catch (error) {
      return { disabled: true, reason: error.code === "POLICY_MISSING" ? "missing" : "invalid",
        errorCode: error.code, boundary: error.code || "invalid" };
    }
  }
  function readRepositoryConsent(scope) {
    const shared = readGlobalConsent();
    if (shared.reason === "missing") return { allowed: false, reason: "consent_record_missing", stamp: null };
    return evaluateRepository(scope, shared);
  }
  return { readGlobalConsent, readRepositoryConsent };
}
module.exports = { createConsentReader };
