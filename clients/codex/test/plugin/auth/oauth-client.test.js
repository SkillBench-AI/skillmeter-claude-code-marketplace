"use strict";
// The OAuth client and scope come from shared/lib/endpoints.js, as in
// SkillMeter for Claude Code.
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../../plugins/skillmeter/scripts/lib/config");

test("sign-in uses the shared public client unless the environment names another", t => {
  const previous = process.env.SKILLMETER_OAUTH_CLIENT_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.SKILLMETER_OAUTH_CLIENT_ID;
    else process.env.SKILLMETER_OAUTH_CLIENT_ID = previous;
  });
  delete process.env.SKILLMETER_OAUTH_CLIENT_ID;
  assert.equal(config.oauthClientId(), "skillmeter-plugin");
  process.env.SKILLMETER_OAUTH_CLIENT_ID = "local-broker-client";
  assert.equal(config.oauthClientId(), "local-broker-client");
});

test("sign-in requests the shared scope", () => {
  assert.equal(config.OAUTH_SCOPE, "openid offline email");
});
