"use strict";
// Credentials: JWT claims, the session lifecycle (ADR 005), tenant routing,
// endpoint trust, and authenticated uploads against a loopback server.
const { isolateHome, makeJwt, license, sessionFileIn, consentPolicyFileIn, tempDir, writeSettings } = require("../../../test-support/plugin.cjs");
const tmpHome = isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" });
for (const name of ["SKILLMETER_BACKEND_URL", "SKILLMETER_ACTIVATE_URL", "SKILLMETER_BROKER_URL", "SKILLMETER_STATE_DIR"]) {
  delete process.env[name];
}

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../../../plugins/skillmeter/scripts/lib/jwt");
const credstore = require("../../../plugins/skillmeter/scripts/credstore");
const logger = require("../../../plugins/skillmeter/scripts/logger");
const config = require("../../../plugins/skillmeter/scripts/lib/config");

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const sessionFile = sessionFileIn(path.join(tmpHome, ".skillbench"));
const sharedFile = path.join(tmpHome, ".skillbench", "credentials.json");
const policyFile = consentPolicyFileIn(path.join(tmpHome, ".skillbench"));
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

// Hold `token` as the signed-in license, or no license when it is empty.
function setToken(token) {
  credstore.mutateSession(session => {
    delete session.signed_out;
    if (token) Object.assign(session, { license_jwt: token, refresh_token: "synthetic-refresh" });
    else { delete session.license_jwt; delete session.refresh_token; }
  });
}

// A global pause writes the Codex consent record; remove it so later tests start
// without one.
function withGlobalPause(fn) {
  logger.setTelemetryGloballyDisabled(true);
  return Promise.resolve().then(fn).finally(() => {
    // The observed marker would make a missing policy read as tampering.
    for (const file of [policyFile, logger.CONSENT_OBSERVED_FILE]) fs.rmSync(file, { force: true });
  });
}

function tmpLogFile(contents) {
  const p = path.join(tempDir("sk-auth-log"), "events.jsonl.1700000000000");
  fs.writeFileSync(p, contents);
  return p;
}

test("isLicenseTokenExpired reflects the exp claim; an absent token is expired", () => {
  assert.equal(credstore.isLicenseTokenExpired(null), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: PAST })), true);
  assert.equal(credstore.isLicenseTokenExpired(makeJwt({ exp: FUTURE })), false);
});

test("commitSignin stores the session in this plugin's own file; signOut ends it", () => {
  const token = license({ orgs: ["Acme", "acme", " Beta ", ""] });
  const generation = credstore.markEngaged();
  assert.notEqual(credstore.commitSignin({ jwt: token, refreshToken: "synthetic-refresh", generation }), false);
  assert.equal(credstore.getLicenseToken(), token);
  assert.equal(credstore.isSignedIn(), true);
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), ["acme", "beta"], "scope is the license's orgs claim");
  assert.equal(readJson(sessionFile).refresh_token, "synthetic-refresh");
  for (const field of ["license_jwt", "refresh_token", "signed_out", "auth_generation"]) {
    assert.equal(field in readJson(sharedFile), false, `${field} never enters the shared file`);
  }

  credstore.signOut();
  assert.equal(credstore.getLicenseToken(), null);
  assert.equal(readJson(sessionFile).refresh_token, undefined);
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), []);
  assert.equal(credstore.getSignedOut(), true);
  assert.equal(credstore.getDeviceId(), "TEST-DEVICE", "device identity survives a sign-out");
});

test("commitSignin is refused while signed out or for a superseded intent; markEngaged re-arms it", () => {
  credstore.signOut();
  assert.equal(credstore.commitSignin({ jwt: license(), refreshToken: "r" }), false);

  const stale = credstore.markEngaged();
  const current = credstore.markEngaged();
  assert.equal(credstore.getSignedOut(), false);
  assert.equal(credstore.commitSignin({ jwt: license(), refreshToken: "r", generation: stale }), false);
  assert.notEqual(credstore.commitSignin({ jwt: license(), refreshToken: "r", generation: current }), false);
});

test("ensureSessionFile reports only the first creation", () => {
  const saved = fs.readFileSync(sessionFile);
  fs.rmSync(sessionFile);
  try {
    assert.equal(credstore.ensureSessionFile(), true);
    assert.equal(credstore.ensureSessionFile(), false);
    assert.equal(credstore.isSignedIn(), false, "nothing is carried over into a new session");
  } finally { fs.writeFileSync(sessionFile, saved); }
});

test("the global pause blocks event-log uploads without consuming the queue", async () => {
  let sawRequest = false;
  const srv = await startServer((_req, res) => {
    sawRequest = true;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await withGlobalPause(async () => {
      const outcome = await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
      assert.equal(outcome, "skip");
    });
    assert.equal(sawRequest, false);
    assert.equal(fs.existsSync(logFile), true, "queued batch remains for later");
    assert.equal(fs.existsSync(`${logFile}.sent`), false);
  } finally {
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

// No shared default host: without the tenant's own host there is nowhere to send.
test("getBackendUrl: a trusted env override wins, then the JWT tenant, else none", () => {
  credstore.markEngaged();
  for (const [name, { env, aud, exp = FUTURE, settings }, expected] of [
    ["trusted env override over the JWT", { env: "https://api.meter.skillbench.com/logs/codex", aud: "https://jwt.meter.skillbench.com" }, "https://api.meter.skillbench.com/logs/codex"],
    ["untrusted env override", { env: "https://evil.example.com/logs/codex", aud: "https://jwt.meter.skillbench.com" }, null],
    ["non-https env override", { env: "http://api.meter.skillbench.com/logs/codex" }, null],
    ["JWT tenant on skillbench.com", { aud: "https://acme.meter.skillbench.com" }, "https://acme.meter.skillbench.com/logs/codex"],
    ["JWT tenant on skillbench.ai", { aud: "https://acme.meter.skillbench.ai" }, "https://acme.meter.skillbench.ai/logs/codex"],
    ["expired JWT still routes", { aud: "https://acme.meter.skillbench.com", exp: PAST }, "https://acme.meter.skillbench.com/logs/codex"],
    ["untrusted JWT tenant", { aud: "https://evil.example.com" }, null],
    ["JWT tenant on a .meter.dev domain", { aud: "https://acme.meter.dev" }, null],
    ["a backendUrl settings key is ignored", { aud: "https://jwt.meter.skillbench.com", settings: { backendUrl: "https://acme.meter.dev.skillbench.com/logs/codex" } }, "https://jwt.meter.skillbench.com/logs/codex"],
    ["unauthenticated", {}, null],
  ]) {
    const cwd = tempDir("sk-auth-cwd");
    if (settings) writeSettings(cwd, settings);
    setToken(aud ? makeJwt({ aud, exp }) : "");
    if (env) process.env.SKILLMETER_BACKEND_URL = env;
    try {
      assert.equal(logger.getBackendUrl(cwd), expected, name);
    } finally {
      delete process.env.SKILLMETER_BACKEND_URL;
      setToken("");
    }
  }
});

test("an event log whose license has no trusted tenant host is held, and nothing is sent", async () => {
  credstore.markEngaged();
  setToken(makeJwt({ aud: "https://evil.example.com", exp: FUTURE }));
  const logFile = tmpLogFile('{"a":1}\n');
  const realFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error("no request expected"); };
  try {
    assert.equal(await logger.transferEventLog(logFile, undefined, 5000), "held");
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(logFile), true, "queued batch remains for later");
  } finally {
    global.fetch = realFetch;
    setToken("");
    try { fs.unlinkSync(logFile); } catch {}
  }
});

test("sign-in and renewal default to the prod skillbench.ai services", () => {
  assert.equal(config.brokerUrl(), "https://id.skillbench.ai");
  assert.equal(config.getTokenUrl(), "https://id.skillbench.ai/oauth2/token");
  assert.equal(config.getRevokeUrl(), "https://id.skillbench.ai/oauth2/revoke");
  assert.equal(config.activateUrl(), "https://api.skillbench.ai/activate");
  assert.equal(config.stateDir(), path.join(tmpHome, ".skillbench"));
});

test("an environment variable cannot switch a stable install to dev", () => {
  process.env.SKILLMETER_ENV = "dev";
  try {
    assert.equal(config.brokerUrl(), "https://id.skillbench.ai");
    assert.equal(config.activateUrl(), "https://api.skillbench.ai/activate");
    assert.equal(config.stateDir(), path.join(tmpHome, ".skillbench"));
  } finally {
    delete process.env.SKILLMETER_ENV;
  }
});

test("a trusted endpoint override is honored and an untrusted one falls back to the default", () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const [name, url, expected] of [
      ["SKILLMETER_ACTIVATE_URL", "https://api.dev.skillbench.com/activate", "https://api.dev.skillbench.com/activate"],
      ["SKILLMETER_ACTIVATE_URL", "http://127.0.0.1:8080/activate", "http://127.0.0.1:8080/activate"],
      ["SKILLMETER_ACTIVATE_URL", "https://evil.example.com/activate", "https://api.skillbench.ai/activate"],
      ["SKILLMETER_ACTIVATE_URL", "http://api.skillbench.ai/activate", "https://api.skillbench.ai/activate"],
      ["SKILLMETER_BROKER_URL", "https://id.dev.skillbench.com/", "https://id.dev.skillbench.com"],
      ["SKILLMETER_BROKER_URL", "https://id.skillbench.ai.evil.example.com", "https://id.skillbench.ai"],
    ]) {
      process.env[name] = url;
      try {
        assert.equal(name === "SKILLMETER_BROKER_URL" ? config.brokerUrl() : config.activateUrl(), expected, url);
      } finally { delete process.env[name]; }
    }
  } finally { console.error = original; }
});

test("transferEventLog attaches the JWT and marks the batch .sent on 2xx", async () => {
  const token = makeJwt({ exp: FUTURE });
  setToken(token);

  let sawAuth = null;
  const srv = await startServer((req, res) => {
    sawAuth = req.headers["authorization"] || null;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(sawAuth, `Bearer ${token}`);
    assert.equal(fs.existsSync(`${logFile}.sent`), true);
    assert.equal(fs.existsSync(logFile), false);
  } finally {
    await srv.close();
  }
});

// A rejection is not a verdict on the session: the license is kept and renewed,
// never deleted.
for (const status of [401, 402, 403]) {
  test(`transferEventLog keeps the license and the batch on HTTP ${status}`, async () => {
    const token = makeJwt({ exp: FUTURE });
    setToken(token);

    const seen = [];
    const srv = await startServer((req, res) => {
      seen.push(req.headers["authorization"] || null);
      res.writeHead(status);
      res.end("nope");
    });
    const logFile = tmpLogFile('{"a":1}\n');

    try {
      const outcome = await logger.transferEventLog(
        logFile,
        `${srv.url}/logs/codex`,
        5000
      );
      assert.equal(outcome, "auth");
      assert.deepEqual(seen, [`Bearer ${token}`], "no anonymous retry");
      assert.equal(credstore.getLicenseToken(), token, "license survives");
      assert.equal(fs.existsSync(logFile), true, "batch stays queued");
      assert.equal(fs.existsSync(`${logFile}.sent`), false);
    } finally {
      try { fs.unlinkSync(logFile); } catch {}
      await srv.close();
    }
  });
}

test("transferEventLog never sends unauthenticated with an expired JWT", async () => {
  const expired = makeJwt({ exp: PAST });
  setToken(expired);

  let sawRequest = false;
  const srv = await startServer((_req, res) => {
    sawRequest = true;
    res.writeHead(200);
    res.end("ok");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    const outcome = await logger.transferEventLog(
      logFile,
      `${srv.url}/logs/codex`,
      5000
    );
    assert.equal(outcome, "auth");
    assert.equal(sawRequest, false, "the ingest route rejects anonymous posts");
    assert.equal(credstore.getLicenseToken(), expired, "expired license is kept for renewal");
    assert.equal(fs.existsSync(logFile), true, "batch stays queued");
    assert.equal(fs.existsSync(`${logFile}.sent`), false);
  } finally {
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

// Routing and authorization come from one credential snapshot, so a concurrent
// sign-in cannot pair tenant A's endpoint with tenant B's JWT.
test("transferEventLog routes by the same token it authenticates with", async () => {
  const token = makeJwt({
    exp: FUTURE,
    aud: "https://tenantb.meter.skillbench.com",
  });
  setToken(token);

  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, options) => {
    seen = { url, auth: options.headers["Authorization"] };
    return { ok: true, status: 200 };
  };
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile);
    assert.equal(seen.url, "https://tenantb.meter.skillbench.com/logs/codex");
    assert.equal(seen.auth, `Bearer ${token}`);
  } finally {
    global.fetch = realFetch;
    try { fs.unlinkSync(`${logFile}.sent`); } catch {}
  }
});

// A rejected token that still looks fresh must not be resubmitted every sweep.
test("an authenticated rejection forces the next renewal", async () => {
  const token = makeJwt({ exp: FUTURE });
  setToken(token);
  logger.clearLicenseRejected();

  const srv = await startServer((_req, res) => {
    res.writeHead(401);
    res.end("nope");
  });
  const logFile = tmpLogFile('{"a":1}\n');

  try {
    await logger.transferEventLog(logFile, `${srv.url}/logs/codex`, 5000);
    assert.equal(logger.isLicenseRejected(), true, "a renewal is now owed");

    const fresh = makeJwt({ exp: FUTURE, jti: "rotated" });
    const realFetch = global.fetch;
    const calls = [];
    // The broker's refresh token grant, then /activate.
    global.fetch = async url => {
      calls.push(new URL(url).pathname);
      const body = url.endsWith("/oauth2/token") ? { id_token: "id-token", refresh_token: "rotated-refresh" } : { token: fresh };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    try {
      const rotated = await logger.tryRefreshLicense("TEST-DEVICE");
      assert.deepEqual(calls, ["/oauth2/token", "/activate"], "the rejection defeats the freshness short-circuit");
      assert.equal(rotated, fresh);
      assert.notEqual(rotated, token, "the rejected credential is not reused");
      assert.equal(credstore.getLicenseTokenUncached(), fresh, "rotation is persisted");
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(logger.isLicenseRejected(), false, "marker cleared once rotated");
  } finally {
    try { fs.unlinkSync(logFile); } catch {}
    await srv.close();
  }
});

// Every read goes to disk: a long-lived drain sees another process's sign-out
// or a dropped session at once.
test("a license another process removed is never resurrected", () => {
  setToken(makeJwt({ exp: FUTURE }));
  const raw = readJson(sessionFile);
  delete raw.license_jwt;
  fs.writeFileSync(sessionFile, JSON.stringify(raw) + "\n");

  assert.equal(credstore.getLicenseToken(), null);
  assert.equal(credstore.getLicenseTokenUncached(), null);
});

test("getLicenseTokenUncached returns null while signed out", () => {
  setToken(makeJwt({ exp: FUTURE }));
  assert.notEqual(credstore.getLicenseTokenUncached(), null);

  fs.writeFileSync(sessionFile, JSON.stringify({ ...readJson(sessionFile), signed_out: true }) + "\n");
  assert.equal(credstore.getLicenseTokenUncached(), null);
  setToken("");
});

test("legacy transcript snapshots remain queued without an unsequenced upload", async () => {
  const token = makeJwt({ exp: FUTURE });
  setToken(token);
  const pending = tmpLogFile('{"type":"message"}\n');
  const realFetch = global.fetch;
  global.fetch = async () => assert.fail("legacy snapshot must not be uploaded");
  try {
    const outcome = await logger.uploadPendingTranscript(pending, "TEST-DEVICE");
    assert.equal(outcome, "skip");
    assert.equal(credstore.getLicenseToken(), token, "license survives");
    assert.equal(fs.existsSync(pending), true, "snapshot stays pending");
  } finally {
    global.fetch = realFetch;
    fs.unlinkSync(pending);
  }
});

// The first run of this version (ADR 005, full cutover): nothing from a GitHub
// sign-in is carried over, and event batches recorded under it are dropped.
test("the first run starts signed out and drops queued event batches, once", () => {
  const sessionStart = require("../../../plugins/skillmeter/scripts/session_start");
  const saved = fs.readFileSync(sessionFile);
  fs.rmSync(sessionFile);
  fs.mkdirSync(logger.LOG_DIR, { recursive: true });
  const batch = path.join(logger.LOG_DIR, "events.jsonl.1700000000000");
  fs.writeFileSync(batch, '{"event":"recorded-before-cutover"}\n');
  try {
    sessionStart.prepareSession();
    assert.equal(fs.existsSync(batch), false, "the pre-cutover batch is dropped");
    assert.equal(credstore.isSignedIn(), false);

    fs.writeFileSync(batch, '{"event":"after-cutover"}\n');
    sessionStart.prepareSession();
    assert.equal(fs.existsSync(batch), true, "later runs keep their batches");
  } finally {
    fs.rmSync(batch, { force: true });
    fs.writeFileSync(sessionFile, saved);
  }
});

test("prepareSession makes no network request", () => {
  const sessionStart = require("../../../plugins/skillmeter/scripts/session_start");
  setToken(makeJwt({ exp: PAST }));
  const realFetch = global.fetch;
  global.fetch = async () => assert.fail("SessionStart must not renew; the drains do");
  try {
    sessionStart.prepareSession();
  } finally {
    global.fetch = realFetch;
    setToken("");
  }
});
