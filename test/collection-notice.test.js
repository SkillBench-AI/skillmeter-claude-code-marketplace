"use strict";

// ADR 003 decision 2: one line when this client stops collecting, one when it
// can collect again, nothing in between. Each case changes the state through
// the real writers and runs the real FileChanged handler with the stdin
// Claude Code gives it, for one or more sessions that SessionStart opened.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { ORG, REPO_KEY, SCRIPTS, collectionClient, license } = require("../testing/collection-client");
const { makeJwt } = require("../testing/helpers");

const signedIn = `signIn(${JSON.stringify(license())});`;
const STOPPED = (reason) => `✗ SkillMeter · ${reason} · telemetry cannot be collected on this device · run /skillmeter:signin`;
const PAUSED = (reason) => `✗ SkillMeter · ${reason} · uploads paused on this device · run /skillmeter:signin`;
const RESUMED = "✓ SkillMeter · signed in · telemetry can be collected on this device";
const REVOKED = `${STOPPED("organization license inactive")} · contact your administrator`;

// The lines a session shows after a change, from either watched file: every
// file the change wrote fires the handler, and only one of them may speak.
function lines(f, sessionId) {
  return ["session.json", "license-status.json"]
    .map((file) => f.notice(sessionId, file))
    .filter(Boolean)
    .map((out) => out.systemMessage);
}

// The state a session last stored.
const storedState = (f, id) => JSON.parse(fs.readFileSync(path.join(f.sessionStateDir(), `${id}.json`), "utf8")).state;

// A client whose sessions opened signed in and recording.
function recordingClient(...sessions) {
  const f = collectionClient();
  f.write(signedIn);
  for (const id of sessions) f.sessionStart(id);
  return f;
}

test("signing out shows the stop line once, with a desktop notification", () => {
  const f = recordingClient("s");
  f.write("signOut();");
  const out = f.notice("s");
  assert.equal(out.systemMessage, STOPPED("signed out"));
  assert.equal(out.terminalSequence,
    "\u001b]777;notify;SkillMeter;signed out · telemetry cannot be collected on this device · run /skillmeter:signin\u0007");
  assert.deepEqual(lines(f, "s"), [], "a second fire with no change says nothing");
});

// Decision 5: signing in alone does not restore an organization's license.
test("a revoked license shows the stop line, naming the administrator", () => {
  const f = recordingClient("s");
  f.write("revoke();");
  const out = f.notice("s");
  assert.equal(out.systemMessage,
    "✗ SkillMeter · organization license inactive · telemetry cannot be collected on this device · run /skillmeter:signin · contact your administrator");
  assert.equal(out.terminalSequence,
    "\u001b]777;notify;SkillMeter;organization license inactive · telemetry cannot be collected on this device · run /skillmeter:signin · contact your administrator\u0007");
  assert.deepEqual(lines(f, "s"), []);
});

// A 402 drops the license from the session before it records the reason, so a
// hook between the two writes reads a lost license. The reason that follows
// corrects the line, once, with the administrator.
test("a revocation first read as a lost license is corrected once", () => {
  const f = recordingClient("s");
  f.write("cs.dropRevokedLicense(cs.recoverySnapshot(), () => {});");
  assert.deepEqual(lines(f, "s"), [STOPPED("license token missing")]);
  f.write("ls.recordTerminal({ source: 'drain', reason: 'revoked', status: 402 });");
  assert.deepEqual(lines(f, "s"), [REVOKED]);
  assert.deepEqual(lines(f, "s"), []);

  // Both writes before any hook reads: the revoked line, once.
  const g = recordingClient("s");
  g.write("revoke();");
  assert.deepEqual(lines(g, "s"), [REVOKED]);
  assert.deepEqual(lines(g, "s"), []);
});

test("an ended session shows the uploads-paused line", () => {
  const f = recordingClient("s");
  f.write("endSession();");
  assert.deepEqual(lines(f, "s"), [PAUSED("sign-in expired")]);
});

test("a sign-in after a lost license shows the return line, in a repository never chosen too", () => {
  // The common path: the license is gone, and the sign-in leaves this client
  // unconfigured, because no repository was ever chosen.
  const f = collectionClient({ policy: { orgs: { [ORG]: true } } });
  f.write(`${signedIn} loseLicense();`);
  f.sessionStart("s");
  f.write(signedIn);
  assert.deepEqual(lines(f, "s"), [RESUMED]);
  assert.deepEqual(lines(f, "s"), []);
});

test("token_missing, then signed in, then token_missing again is two lines", () => {
  const f = collectionClient();
  f.write(`${signedIn} loseLicense();`);
  f.sessionStart("s");
  f.write(signedIn);
  const first = lines(f, "s");
  f.write("loseLicense();");
  assert.deepEqual([...first, ...lines(f, "s")], [RESUMED, STOPPED("license token missing")]);
});

test("a change within the stopped group says nothing", () => {
  // A license lost, then a sign-out: token_missing becomes signed_out.
  const f = recordingClient("s");
  f.write("loseLicense();");
  assert.deepEqual(lines(f, "s"), [STOPPED("license token missing")]);
  f.write("signOut();");
  assert.deepEqual(lines(f, "s"), []);
});

test("routine writes say nothing, each on its own", () => {
  const writers = {
    "refresh-token rotation": "cs.commitRotation(cs.recoverySnapshot(), 'next-refresh-token');",
    "license renewal": `cs.commitRefresh(${JSON.stringify(license(1800))}, cs.recoverySnapshot());`,
    "renewal recorded": "ls.recordRefreshSuccess({ source: 'drain', outcome: 'rotated' });",
    "a transient failure": "ls.recordRefreshFailure({ source: 'drain', message: 'offline' });",
    "the whole renewal": `renew(${JSON.stringify(license(1800))});`,
  };
  for (const [name, code] of Object.entries(writers)) {
    const f = recordingClient("s");
    f.write(code);
    assert.deepEqual(lines(f, "s"), [], name);
  }
});

test("another session's start clears the terminal state and says nothing", () => {
  // Healthy, with a backoff to clear.
  const healthy = recordingClient("s");
  healthy.write("ls.recordRefreshFailure({ source: 'drain', message: 'offline' });");
  healthy.sessionStart("other");
  assert.deepEqual(lines(healthy, "s"), []);

  // Uploads paused: the clear keeps the reason, so the state stays.
  const ended = recordingClient("s");
  ended.write("endSession();");
  assert.deepEqual(lines(ended, "s"), [PAUSED("sign-in expired")]);
  ended.write("ls.clearTerminal();");
  ended.sessionStart("other");
  assert.deepEqual(lines(ended, "s"), []);
});

test("the pause is the user's choice and says nothing", () => {
  const f = recordingClient("s");
  f.setPolicy({ enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  f.write("ls.recordRefreshSuccess({ source: 'drain' });");
  assert.deepEqual(lines(f, "s"), []);
});

test("two handlers of one session started together show one line", async () => {
  const f = recordingClient("s");
  f.write("signOut();");
  const outs = await Promise.all(["session.json", "license-status.json", "session.json"]
    .map((file) => f.started("on_collection_state.js", "s", file)));
  assert.deepEqual(outs.filter(Boolean).map((out) => out.systemMessage), [STOPPED("signed out")]);
});

test("pausing a client whose uploads wait is not a return", () => {
  const f = recordingClient("s");
  f.write("endSession();");
  assert.deepEqual(lines(f, "s"), [PAUSED("sign-in expired")]);
  f.setPolicy({ enabled: false, orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  assert.deepEqual(lines(f, "s"), [], "the pause does not sign anyone in");
  assert.equal(storedState(f, "s"), "delivery_paused");
  f.setPolicy({ orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  assert.deepEqual(lines(f, "s"), [], "uploads still wait, as the session was told");
});

// The policy is watched too. A toggle or the pause changes no group, so it
// costs each session one silent run.
test("toggling a repository, and the pause itself, say nothing", () => {
  const f = recordingClient("s");
  for (const action of ["disable", "enable", "disable-global"]) {
    f.telemetry(action);
    assert.deepEqual(f.fire("s", "telemetry-policy.json"), [], action);
  }
  assert.equal(storedState(f, "s"), "paused");
});

// The pause masks every other state, so a sign-out while paused shows nothing
// until the pause is lifted, and then once in each session.
test("a sign-out while paused is announced when the pause is lifted", () => {
  const f = recordingClient("s-a", "s-b");
  f.telemetry("disable-global");
  f.write("signOut();");
  for (const id of ["s-a", "s-b"]) {
    assert.deepEqual([...f.fire(id, "telemetry-policy.json"), ...f.fire(id, "session.json")], []);
  }
  f.telemetry("enable-global");
  for (const id of ["s-a", "s-b"]) assert.deepEqual(f.fire(id, "telemetry-policy.json"), [STOPPED("signed out")]);
  for (const id of ["s-a", "s-b"]) assert.deepEqual(f.fire(id, "telemetry-policy.json"), []);
});

test("every open session shows each line once", () => {
  const f = recordingClient("s-a", "s-b");
  f.write("signOut();");
  assert.deepEqual(lines(f, "s-a"), [STOPPED("signed out")]);
  assert.deepEqual(lines(f, "s-b"), [STOPPED("signed out")]);
  assert.deepEqual([...lines(f, "s-a"), ...lines(f, "s-b")], []);
});

test("a session that started stopped is not told again what its card said", () => {
  const f = collectionClient();
  f.write(`${signedIn} signOut();`);
  assert.match(f.sessionStart("s"), /Reason {8}signed out/);
  f.write("ls.clearLicenseStatus({ source: 'signin' });");
  assert.deepEqual(lines(f, "s"), []);
});

test("the client is resolved without a working directory", () => {
  // Signed in to a repository that records, the client is only unconfigured:
  // the notices know nothing about this repository.
  const f = recordingClient("s");
  f.write("ls.recordRefreshSuccess({ source: 'drain' });");
  assert.deepEqual(lines(f, "s"), []);
  const stored = JSON.parse(fs.readFileSync(path.join(f.sessionStateDir(), "s.json"), "utf8"));
  assert.deepEqual(stored, { state: "unconfigured" });
});

// (b) A sign-in already shows its result in one session. There the return
// line would say the same again; every other session still gets it.
test("the session that shows the sign-in notice gets no second line", () => {
  const f = collectionClient();
  f.write(`${signedIn} signOut(); startSignin();`);
  f.sessionStart("s-a");
  f.sessionStart("s-b");
  f.write(signedIn);
  assert.match(f.signinNotice("s-a").systemMessage, /SIGNED IN|TELEMETRY|REPOSITORY/);
  assert.equal(f.signinNotice("s-b"), null, "the sign-in notice is shown once");
  assert.deepEqual(lines(f, "s-a"), []);
  assert.deepEqual(lines(f, "s-b"), [RESUMED]);
});

test("two sessions handling one sign-in together: one sign-in notice, one return line", async () => {
  // A race shows in about one round in four without the claim, so twenty
  // rounds miss it about once in a hundred runs.
  for (let round = 0; round < 20; round++) {
    const f = collectionClient();
    f.write(`${signedIn} signOut(); startSignin();`);
    f.sessionStart("s-a");
    f.sessionStart("s-b");
    f.write(signedIn);
    const outs = await Promise.all(["s-a", "s-b"].flatMap((id) => [
      f.started("on_signin_result.js", id, "signin-result.json").then((out) => out && "signin"),
      f.started("on_collection_state.js", id, "session.json").then((out) => out && "return"),
      f.started("on_collection_state.js", id, "license-status.json").then((out) => out && "return"),
    ]));
    assert.deepEqual(outs.filter(Boolean).sort(), ["return", "signin"], `round ${round}`);
  }
});

test("a revoked license, then a sign-in: one stop line, then one return line", () => {
  const f = recordingClient("s-a", "s-b");
  f.write("revoke();");
  for (const id of ["s-a", "s-b"]) assert.deepEqual(lines(f, id), [REVOKED]);
  f.write("startSignin();");
  assert.deepEqual(lines(f, "s-a"), [], "a started sign-in keeps the revoked reason");
  assert.equal(storedState(f, "s-a"), "revoked");
  // The session is committed before the record that clears the reason.
  f.write(`cs.commitSignin({ jwt: ${JSON.stringify(license())} });`);
  assert.equal(f.notice("s-a", "session.json"), null);
  assert.equal(storedState(f, "s-a"), "revoked");
  f.write("ls.recordSignin({ source: 'signin' }); cs.writeSigninResult({ status: 'success' });");
  assert.ok(f.signinNotice("s-a"));
  assert.deepEqual(lines(f, "s-a"), []);
  assert.deepEqual(lines(f, "s-b"), [RESUMED]);
  for (const id of ["s-a", "s-b"]) assert.equal(storedState(f, id), "unconfigured");
});

test("an ended session, then a sign-in: one uploads-paused line, then one return line", () => {
  const f = recordingClient("s-a", "s-b");
  f.write("endSession();");
  for (const id of ["s-a", "s-b"]) assert.deepEqual(lines(f, id), [PAUSED("sign-in expired")]);
  f.write("startSignin();");
  assert.deepEqual(lines(f, "s-a"), []);
  assert.equal(storedState(f, "s-a"), "delivery_paused");
  f.write(signedIn);
  assert.ok(f.signinNotice("s-b"));
  assert.deepEqual(lines(f, "s-a"), [RESUMED]);
  assert.deepEqual(lines(f, "s-b"), []);
  for (const id of ["s-a", "s-b"]) assert.equal(storedState(f, id), "unconfigured");
});

test("token_missing, unconfigured, token_missing: the state stored at each step", () => {
  const f = collectionClient();
  f.write(`${signedIn} loseLicense();`);
  f.sessionStart("s");
  assert.equal(storedState(f, "s"), "token_missing");
  f.write(signedIn);
  assert.deepEqual(lines(f, "s"), [RESUMED]);
  assert.equal(storedState(f, "s"), "unconfigured");
  f.write("loseLicense();");
  assert.deepEqual(lines(f, "s"), [STOPPED("license token missing")]);
  assert.equal(storedState(f, "s"), "token_missing");
});

// The hook's timeout can kill the sign-in notice during its walk over the
// transcripts, after it claimed the result and before it printed anything.
// Its session must still be told.
test("a sign-in notice killed before it shows leaves the return line", async () => {
  const f = collectionClient();
  f.write(`${signedIn} signOut(); startSignin();`);
  f.sessionStart("s");
  f.write(signedIn);
  // A walk that never finishes.
  const stall = path.join(f.root, "stall-walk.cjs");
  fs.writeFileSync(stall, `
    const Module = require("module");
    const load = Module._load;
    Module._load = function (request) {
      const exported = load.apply(this, arguments);
      if (!/repository-telemetry$/.test(request)) return exported;
      return { ...exported, loadRepositoryTelemetryState: () => new Promise(() => setInterval(() => {}, 1000)) };
    };
  `);
  const marker = path.join(f.account, ".signin-notified");
  const { ts } = JSON.parse(fs.readFileSync(path.join(f.account, "signin-result.json"), "utf8"));
  const child = spawn(process.execPath, ["-r", stall, path.join(SCRIPTS, "on_signin_result.js")], { cwd: f.repo, env: f.env });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal)));
  child.stdin.end(JSON.stringify({ session_id: "s", hook_event_name: "FileChanged", file_path: path.join(f.account, "signin-result.json"), event: "change" }));
  const claimed = () => { try { return fs.readFileSync(marker, "utf8") === String(ts); } catch { return false; } };
  for (const deadline = Date.now() + 5000; !claimed() && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 20));
  assert.ok(claimed(), "the notice claimed the result");
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");
  assert.equal(stdout, "", "killed before it showed anything");
  assert.deepEqual(lines(f, "s"), [RESUMED]);
});

test("with no sign-in notice shown anywhere, the return line still comes", () => {
  const f = collectionClient();
  f.write(`${signedIn} signOut(); startSignin();`);
  f.sessionStart("s");
  f.write(signedIn);
  assert.deepEqual(lines(f, "s"), [RESUMED]);
});

test("an earlier sign-in's notice does not hide a later return", () => {
  // The notice for the first sign-in was shown here. The session is then
  // paused by an ended session and resumed by a renewal, with no new sign-in.
  const f = collectionClient();
  f.write(`${signedIn} signOut(); startSignin();`);
  f.sessionStart("s");
  f.write(signedIn);
  f.signinNotice("s");
  assert.deepEqual(lines(f, "s"), []);
  f.write("endSession();");
  assert.deepEqual(lines(f, "s"), [PAUSED("sign-in expired")]);
  f.write("ls.recordRefreshSuccess({ source: 'drain' });");
  assert.deepEqual(lines(f, "s"), [RESUMED]);
});

// (c) and (f): a client that never signed in. Signing out still marks it
// signed out, and the sign-out holds until a sign-in commits.
test("a sign-in that has started is not a return, until it completes", () => {
  const f = collectionClient();
  f.sessionStart("s");
  const signout = spawnSync(process.execPath, [path.join(SCRIPTS, "signout.js")], {
    encoding: "utf8", cwd: f.repo, env: f.env,
  });
  assert.equal(signout.stdout, "SkillMeter: already signed out.\n");
  assert.deepEqual(lines(f, "s"), [STOPPED("signed out")]);

  // A started sign-in, then its pending result, then its failure: the
  // sign-out holds throughout.
  f.write("cs.markEngaged();");
  assert.deepEqual(lines(f, "s"), []);
  f.write("ls.clearLicenseStatus({ source: 'signin' }); cs.writeSigninPending(600000, { generation: cs.recoverySnapshot().generation, deviceId: cs.getDeviceId() });");
  assert.deepEqual(lines(f, "s"), []);
  f.write("cs.writeSigninResult({ status: 'failure', error: 'denied' });");
  assert.deepEqual(lines(f, "s"), [], "a failed sign-in leaves the stop as it was");
  const stored = JSON.parse(fs.readFileSync(path.join(f.sessionStateDir(), "s.json"), "utf8"));
  assert.deepEqual(stored, { state: "signed_out" });

  f.write(signedIn);
  assert.deepEqual(lines(f, "s"), [RESUMED]);
});

test("signing out a client that never collected says signed out, and nothing else", () => {
  const f = collectionClient();
  f.sessionStart("s");
  f.sessionStart("other");
  const signout = spawnSync(process.execPath, [path.join(SCRIPTS, "signout.js")], {
    encoding: "utf8", cwd: f.repo, env: f.env,
  });
  assert.equal(signout.stdout + signout.stderr, "SkillMeter: already signed out.\n");
  for (const id of ["s", "other"]) assert.deepEqual(lines(f, id), [STOPPED("signed out")]);
  const card = f.sessionStart("next");
  assert.match(card, /Reason {8}signed out/);
  assert.doesNotMatch(card + signout.stdout, /stopped/i);
});

// (a) and (e): the state is kept per session id, in a private file holding the
// state name only, and ages out with the other local files.
test("each session keeps its state in a private file of its own", () => {
  const f = recordingClient("3f2b9c1e-0000-4000-8000-000000000001");
  f.notice("not a session id");
  const dir = f.sessionStateDir();
  assert.equal(path.dirname(dir), f.account);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(),
    ["3f2b9c1e-0000-4000-8000-000000000001.json", "_client.json"]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), ["state"]);
  }
});

test("a session's state file ages out after 30 days", () => {
  const f = recordingClient("old", "fresh");
  const old = path.join(f.sessionStateDir(), "old.json");
  const when = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, when, when);
  // A hook killed while holding its session's lock leaves the lock behind,
  // and only a later hook of that session would reap it. A session that has
  // ended has none, so its lock ages out with the state.
  const owner = (pid) => JSON.stringify({ version: 2, pid, token: "00000000-0000-4000-8000-000000000000" });
  const leftLock = path.join(f.sessionStateDir(), "old.json.lock");
  const freshLock = path.join(f.sessionStateDir(), "fresh.json.lock");
  fs.writeFileSync(leftLock, owner(2147483646));
  fs.utimesSync(leftLock, when, when);
  fs.writeFileSync(freshLock, owner(process.pid));
  f.sessionStart("third");
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(leftLock), false);
  assert.equal(fs.existsSync(path.join(f.sessionStateDir(), "fresh.json")), true);
  assert.equal(fs.existsSync(freshLock), true, "a lock a hook may still hold stays");
});

test("SessionStart watches the session, its status record and the telemetry policy, creating the record if needed", () => {
  const f = collectionClient();
  const status = path.join(f.account, "license-status.json");
  assert.equal(fs.existsSync(status), false);
  const out = spawnSync(process.execPath, [path.join(SCRIPTS, "session_start.js")], {
    encoding: "utf8", cwd: f.repo, env: f.env,
    input: JSON.stringify({ session_id: "s", cwd: f.repo, source: "startup" }),
  });
  const watched = JSON.parse(out.stdout.trim().split("\n").pop()).hookSpecificOutput.watchPaths;
  assert.ok(watched.includes(path.join(f.account, "session.json")));
  assert.ok(watched.includes(status));
  assert.ok(watched.includes(path.join(f.root, "state", "telemetry-policy.json")));
  assert.equal(fs.existsSync(status), true);
  // Each of them runs the handler, synchronously: Claude Code discards the
  // output of an async hook.
  const fileChanged = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "../hooks/hooks.json"), "utf8")).hooks.FileChanged;
  for (const file of ["session.json", "license-status.json", "telemetry-policy.json"]) {
    const handlers = fileChanged
      .filter((entry) => new RegExp(`^(?:${entry.matcher})$`).test(file))
      .flatMap((entry) => entry.hooks);
    assert.ok(handlers.some((hook) => hook.args.at(-1).endsWith("/scripts/on_collection_state.js") && !hook.async), file);
  }
  assert.deepEqual(lines(f, "s"), [], "a client that never signed in is told by its card, not a notice");
});

// A license that names no organization puts every repository outside it, so
// that client can never collect. Signing in with one is not a return: the
// stop stays stored until a sign-in with a license that names one.
test("a sign-in with a license naming no organization is not a return", () => {
  const f = recordingClient("s-a", "s-b");
  f.write("signOut();");
  for (const id of ["s-a", "s-b"]) assert.deepEqual(lines(f, id), [STOPPED("signed out")]);
  const noOrganization = makeJwt({ exp: Math.floor(Date.now() / 1000) + 900, org: { login: ORG }, orgs: [] });
  f.write(`signIn(${JSON.stringify(noOrganization)});`);
  assert.match(f.signinNotice("s-a").systemMessage, /No licensed organization was found/);
  for (const id of ["s-a", "s-b"]) {
    assert.deepEqual(lines(f, id), [], `${id}: nothing can be collected`);
    assert.equal(storedState(f, id), "signed_out");
  }
  f.write(signedIn);
  assert.ok(f.signinNotice("s-a"));
  assert.deepEqual(lines(f, "s-a"), []);
  assert.deepEqual(lines(f, "s-b"), [RESUMED]);
  for (const id of ["s-a", "s-b"]) assert.equal(storedState(f, id), "unconfigured");
});

// A sign-in commits the license before it clears an ended session's reason, so
// a client signed out after its session ended reads as uploads paused for a
// moment on its way back. A stop does not announce that moment.
test("an ended session, a sign-out, then a sign-in: no pause line on the way back", () => {
  const f = recordingClient("s");
  f.write("endSession();");
  assert.deepEqual(lines(f, "s"), [PAUSED("sign-in expired")]);
  f.write("signOut();");
  assert.deepEqual(lines(f, "s"), [STOPPED("signed out")]);
  f.write("startSignin();");
  assert.deepEqual(lines(f, "s"), []);
  // The session is committed before the record that clears the reason.
  f.write(`cs.commitSignin({ jwt: ${JSON.stringify(license())} });`);
  assert.equal(f.notice("s", "session.json"), null);
  f.write("ls.recordSignin({ source: 'signin' }); cs.writeSigninResult({ status: 'success' });");
  assert.deepEqual(lines(f, "s"), [RESUMED]);
});
