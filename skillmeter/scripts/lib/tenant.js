/**
 * License tenant identity: an HMAC of the sorted org set and the JWT audience.
 * Queues that hold data authorized under one tenant compare against it so a
 * sign-in to another tenant never receives that data.
 */

const crypto = require("crypto");

const credstore = require("../credstore");
const { getLicenseAudiences, getLicenseOrgs } = require("./jwt");

function tenantFingerprint(token, hashSalt) {
  if (!token || !hashSalt) return "";
  const orgs = [...new Set(getLicenseOrgs(token))].sort();
  if (orgs.length === 0) return "";
  const audiences = getLicenseAudiences(token);
  const identity = JSON.stringify({ audiences, orgs });
  return crypto.createHmac("sha256", hashSalt)
    .update(identity)
    .digest("hex")
    .slice(0, 24);
}

function currentTenantFingerprint() {
  return tenantFingerprint(
    credstore.getLicenseTokenUncached(),
    credstore.getHashSalt()
  );
}

module.exports = { currentTenantFingerprint, tenantFingerprint };
