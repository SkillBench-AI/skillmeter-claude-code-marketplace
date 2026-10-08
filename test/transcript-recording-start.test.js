"use strict";

// Live telemetry sends a transcript from where recording began, never from its
// first line. Recording can begin part-way through a transcript: at a sign-in
// during the session, or when a session that already holds conversation is
// resumed. What came before that point is not sent live; a history import is
// the separate, approved route for older content.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ORG, REPO_KEY, HISTORY, collector, session } = require("../testing/transcript-session");

const ENABLED = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } };

test("a sign-in during the session sends only what follows it", async (t) => {
  const c = await collector();
  t.after(c.close);
  // Telemetry was chosen earlier, so the first turn after sign-in records.
  const s = session(c.url, { policy: ENABLED, signedIn: false });

  await s.sessionStart("startup");
  await s.turn("out-1");
  await s.turn("out-2");
  s.signIn();
  await s.turn("in-1");
  await s.drained(() => c.transcript().includes("in-1-a"));
  await s.turn("in-2");
  await s.drained(() => c.transcript().includes("in-2-a"));
  // Each turn once: the mark no longer applies once the cursor is past it.
  assert.deepEqual(c.transcript(), ["in-1-u", "in-1-a", "in-2-u", "in-2-a"]);
});

test("a resumed session signed in part-way sends neither its history nor what came before sign-in", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false, history: HISTORY });

  await s.sessionStart("resume");
  await s.turn("out");
  s.signIn();
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

test("a first sign-in, then a choice to enable, sends only what follows the choice", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: {}, signedIn: false });

  await s.sessionStart("startup");
  await s.turn("out");
  s.signIn();
  await s.turn("pending");
  s.setPolicy(ENABLED);
  await s.turn("on");
  await s.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

test("signing out and in again during a session does not send what came in between", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED });

  await s.sessionStart("startup");
  await s.turn("rec");
  await s.drained(() => c.transcript().includes("rec-a"));
  s.signOut();
  await s.turn("out");
  s.signIn();
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["rec-u", "rec-a", "in-u", "in-a"]);
});

// What must still be sent. The first turn's prompt is already in the
// transcript when its hook runs, so it would be lost if the first recorded
// hook marked where recording began.
test("a session recording from its start sends every turn", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED });

  await s.sessionStart("startup");
  await s.turn("one");
  await s.drained(() => c.transcript().includes("one-a"));
  await s.turn("two");
  await s.drained(() => c.transcript().includes("two-a"));
  assert.deepEqual(c.transcript(), ["one-u", "one-a", "two-u", "two-a"]);
});

test("a resumed session recording from its start sends its own turns, not its history", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, history: HISTORY });

  await s.sessionStart("resume");
  await s.turn("one");
  await s.drained(() => c.transcript().includes("one-a"));
  assert.deepEqual(c.transcript(), ["one-u", "one-a"]);
});

// Only a hook without a license marks the transcript: one that runs outside
// the repository while signed in does not hold back the turn it is part of.
test("a hook outside the repository does not hold back the turn around it", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED });

  await s.sessionStart("startup");
  await s.turn("one", { during: () => s.toolOutsideRepository() });
  await s.drained(() => c.transcript().includes("one-a"));
  assert.deepEqual(c.transcript(), ["one-u", "one-a"]);
});

test("an accepted history import still sends a session from before sign-in", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });

  await s.sessionStart("startup");
  await s.turn("old-1");
  await s.turn("old-2");
  assert.deepEqual(c.transcript(), []);

  s.signIn();
  await s.importHistory();
  assert.deepEqual(c.transcript(), ["old-1-u", "old-1-a", "old-2-u", "old-2-a"]);
});

// When the boundary of a period that was not recorded cannot be written where
// staging reads it, it is recorded separately, so what came before it is
// still not sent. A session closed straight after sign-in stages with no
// prompt, the shape where nothing else would set a boundary.

test("a sign-in whose signed-out mark could not be written sends nothing from before it at session end", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });
  s.blockSignedOutMarks();

  await s.sessionStart("startup");
  await s.turn("out-1");
  await s.turn("out-2");
  s.signIn();
  await s.sessionEnd();
  await s.drained(() => true);
  assert.deepEqual(c.transcript(), []);
});

test("a sign-in whose signed-out mark could not be written still sends what follows it", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });
  s.blockSignedOutMarks();

  await s.sessionStart("startup");
  await s.turn("out");
  s.signIn();
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

test("a repository turned on after its cursor could not be written sends nothing from before", async (t) => {
  const c = await collector();
  t.after(c.close);
  // Signed in, the repository not chosen yet: nothing is recorded.
  const s = session(c.url, { policy: {} });

  await s.sessionStart("startup");
  await s.turn("off-1");
  s.blockCursors();
  await s.turn("off-2");
  s.setPolicy(ENABLED);
  await s.sessionEnd();
  await s.drained(() => true);
  assert.deepEqual(c.transcript(), []);
});

// The hooks could not read where the signed-out period ended, so staging
// sends nothing until it has closed the period itself.
test("a sign-in after signed-out turns the hooks could not read sends nothing from before it", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });

  await s.sessionStart("startup");
  s.hideTranscript();
  await s.turn("out-1");
  await s.turn("out-2");
  s.showTranscript();
  s.signIn();
  await s.sessionEnd();
  await s.drained(() => true);
  assert.deepEqual(c.transcript(), []);

  await s.sessionStart("resume");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

// With no cursor for the transcript, the turn after sign-in is where the
// repository is first seen recording, so staging starts there.
test("the turn after signed-out turns the hooks could not read is sent alone", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });

  await s.sessionStart("startup");
  s.hideTranscript();
  await s.turn("out-1");
  await s.turn("out-2");
  s.showTranscript();
  s.signIn();
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

test("what a signed-out turn wrote after its hooks is not sent after signing in again", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED });

  await s.sessionStart("startup");
  await s.turn("rec");
  await s.drained(() => c.transcript().includes("rec-a"));
  s.signOut();
  await s.turn("out");
  s.late("tail");
  s.signIn();
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["rec-u", "rec-a", "in-u", "in-a"]);
});

test("what a signed-out turn wrote after its hooks is not sent at session end", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, signedIn: false });

  await s.sessionStart("startup");
  await s.turn("out");
  s.late("tail");
  s.signIn();
  await s.sessionEnd();
  await s.drained(() => true);
  assert.deepEqual(c.transcript(), []);
});

// The SessionStart hook can be killed before it places the cursor.
test("a resumed session closed without a turn sends nothing when its start never ran", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, history: HISTORY });

  await s.sessionEnd();
  await s.drained(() => true);
  assert.deepEqual(c.transcript(), []);
});

test("a session closed after an interrupted first turn still sends that turn", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED });

  await s.sessionStart("startup");
  await s.turn("only", { stop: false });
  await s.sessionEnd();
  await s.drained(() => c.transcript().includes("only-a"));
  assert.deepEqual(c.transcript(), ["only-u", "only-a"]);
});

test("a resumed session whose start could not be recorded sends its own turns, not its history", async (t) => {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, { policy: ENABLED, history: HISTORY });
  s.blockCursors();

  await s.sessionStart("resume");
  await s.turn("one");
  await s.drained(() => c.transcript().includes("one-a"));
  assert.deepEqual(c.transcript(), ["one-u", "one-a"]);
});
