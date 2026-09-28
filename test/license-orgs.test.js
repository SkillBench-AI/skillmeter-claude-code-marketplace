"use strict";

// Repository scope comes only from the license's `orgs` claim. `org.login` is
// the tenant slug on a broker license, so it must never widen scope.
// Run: node --test test/license-orgs.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeJwt } = require("../testing/helpers");
const { getLicenseOrgs, getLicenseTenantSlug } = require("../skillmeter/scripts/lib/jwt");

test("orgs claim is the repository scope, lowercased and trimmed", () => {
  const token = makeJwt({ org: { login: "acme" }, orgs: [" Acme-GH ", "Other"] });
  assert.deepEqual(getLicenseOrgs(token), ["acme-gh", "other"]);
  assert.equal(getLicenseTenantSlug(token), "acme");
});

test("a license without an orgs claim covers no organization", () => {
  assert.deepEqual(getLicenseOrgs(makeJwt({ org: { login: "acme" } })), []);
});

test("an empty or malformed orgs claim covers no organization", () => {
  assert.deepEqual(getLicenseOrgs(makeJwt({ org: { login: "acme" }, orgs: [] })), []);
  assert.deepEqual(getLicenseOrgs(makeJwt({ org: { login: "acme" }, orgs: "acme" })), []);
  assert.deepEqual(getLicenseOrgs(makeJwt({ orgs: [42, "", null] })), []);
});
