"use strict";
// License claims (shared/lib/jwt.js): expiry, the telemetry audience, orgs and
// audiences. Merged from both clients' tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeJwt } = require("./helpers");
const jwt = require("../lib/jwt");
const { isJwtExpired, getEndpointFromTokenAllowExpired, getLicenseAudiences } = jwt;

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

// --- jwt.isJwtExpired (parametrized) ---------------------------------------

const expiringJwt = (expOffsetSec) =>
  makeJwt({ exp: Math.floor(Date.now() / 1000) + expOffsetSec });

test("isJwtExpired default: a missing or undecodable token IS expired", () => {
  // Shared with the Codex client: a malformed token is never sent.
  assert.equal(isJwtExpired(null), true);
  assert.equal(isJwtExpired(undefined), true);
  assert.equal(isJwtExpired("garbage"), true);
});

test("isJwtExpired treatMissingAsExpired: false opts out", () => {
  assert.equal(isJwtExpired(null, { treatMissingAsExpired: false }), false);
  assert.equal(isJwtExpired("garbage", { treatMissingAsExpired: false }), false);
});

test("isJwtExpired honors skewSeconds", () => {
  const t = expiringJwt(60); // expires in 60s
  assert.equal(isJwtExpired(t, { skewSeconds: 30 }), false); // 60 > 30 → valid
  assert.equal(isJwtExpired(t, { skewSeconds: 300 }), true); // 60 < 300 → expired proactively
});

test("isJwtExpired: a long-lived token is never expired", () => {
  assert.equal(isJwtExpired(expiringJwt(3600)), false);
});

// --- endpoint resolution from JWT `aud` ------------------------------------

test("getEndpointFromTokenAllowExpired reads the `aud` claim (string)", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(makeJwt({ aud: "https://x.meter.skillbench.ai" })),
    "https://x.meter.skillbench.ai"
  );
});

test("`aud` may be an array; the first https URL wins", () => {
  assert.equal(
    getEndpointFromTokenAllowExpired(makeJwt({ aud: ["skillbench", "https://x.meter.ai"] })),
    "https://x.meter.ai"
  );
});

test("ignores the legacy telemetry_endpoint claim — `aud` only", () => {
  // No aud URL → null even when a legacy telemetry_endpoint is present.
  assert.equal(
    getEndpointFromTokenAllowExpired(
      makeJwt({ aud: "just-an-audience", telemetry_endpoint: "https://legacy.meter.ai" })
    ),
    null
  );
});

test("returns null when no `aud` URL is present", () => {
  assert.equal(getEndpointFromTokenAllowExpired(makeJwt({ sub: "x" })), null);
  assert.equal(getEndpointFromTokenAllowExpired(null), null);
});

test("getLicenseAudiences returns a stable sorted unique tenant identity", () => {
  const token = makeJwt({
    aud: ["https://b.example", "https://a.example", "https://b.example"],
  });
  assert.deepEqual(getLicenseAudiences(token), [
    "https://a.example",
    "https://b.example",
  ]);
});

test("isJwtExpired: a past exp is expired", () => {
  assert.equal(isJwtExpired(makeJwt({ exp: PAST })), true);
  assert.equal(isJwtExpired(makeJwt({ exp: FUTURE })), false);
});

test("decodeJwtPayload returns claims for a well-formed token", () => {
  const payload = jwt.decodeJwtPayload(makeJwt({ sub: "u1", exp: FUTURE }));
  assert.equal(payload.sub, "u1");
  assert.equal(payload.exp, FUTURE);
});

test("decodeJwtPayload returns null for garbage", () => {
  assert.equal(jwt.decodeJwtPayload("not-a-jwt"), null);
  assert.equal(jwt.decodeJwtPayload("a.b"), null);
});

test("getEndpointFromToken returns the `aud` endpoint of a valid token", () => {
  const token = makeJwt({ exp: FUTURE, aud: "https://acme.meter.skillbench.com/" });
  assert.equal(jwt.getEndpointFromToken(token), "https://acme.meter.skillbench.com");
});

test("getEndpointFromToken rejects expired tokens, missing/non-https claims", () => {
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: PAST, aud: "https://acme.meter.skillbench.com" })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE })), null);
  assert.equal(jwt.getEndpointFromToken(makeJwt({ exp: FUTURE, aud: "http://insecure.example.com" })), null);
  assert.equal(jwt.getEndpointFromToken(null), null);
});
