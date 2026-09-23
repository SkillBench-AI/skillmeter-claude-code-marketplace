"use strict";

const credstore = require("../credstore");
const telemetryStore = require("./telemetry-store");
const { getRetryDaemonIntervalMs } = require("./config");
const { readLicenseStatus, refreshBlockedReason } = require("./license-status");
const { ensureFreshLicense } = require("./license-activation");

// Reuse the monitor's look-ahead and backoff. A Stop hook can request a worker
// even when an expired capture gate left nothing to drain.
function needsRecovery(repoKey) {
  if (credstore.getSignedOut()) return false;
  const token = credstore.getLicenseTokenUncached();
  if (!token || refreshBlockedReason(readLicenseStatus())) return false;
  const keys = repoKey ? [repoKey] : Object.keys(telemetryStore.readPolicy().repositories);
  if (!keys.some(key => credstore.isTelemetryTransmissionAllowed(key))) return false;
  return credstore.isLicenseTokenExpired(
    token,
    credstore.LICENSE_EXPIRY_SKEW_SECONDS + Math.ceil(getRetryDaemonIntervalMs() / 1000)
  );
}

function requestLicenseRecovery(input, deviceId, repository) {
  if (!repository?.repoKey || !needsRecovery(repository.repoKey)) return;
  require("./transfer").spawnDetachedDrain();
}

async function refreshForEnabledRepositories() {
  if (!needsRecovery()) return;
  await ensureFreshLicense(credstore.getDeviceId(), {
    source: "drain",
    aheadMs: getRetryDaemonIntervalMs(),
  });
}

module.exports = { requestLicenseRecovery, refreshForEnabledRepositories };
