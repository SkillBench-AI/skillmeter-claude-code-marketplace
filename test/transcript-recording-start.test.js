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
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
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
