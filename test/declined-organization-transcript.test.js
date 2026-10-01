"use strict";

// A license covers two organizations and the user turned one off. Capture is
// allowed for a repository of the other one, but sending needs every licensed
// organization, so nothing is recorded. Content from that period must not be
// sent once the organization is turned on, as for any period that was not
// recorded.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ORG, REPO_KEY, HISTORY, collector, session } = require("../testing/transcript-session");

const OTHER = "beta";

const BOTH_ENABLED = { orgs: { [ORG]: true, [OTHER]: true }, repositories: { [REPO_KEY]: true } };
const OTHER_OFF = { orgs: { [ORG]: true, [OTHER]: false }, repositories: { [REPO_KEY]: true } };

test("turns from while another licensed organization was off are not sent once it is on", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = session(c.url, { orgs: [ORG, OTHER], policy: OTHER_OFF });

  await f.sessionStart("startup");
  await f.turn("off-1");
  await f.turn("off-2");
  assert.deepEqual(c.transcript(), [], "nothing is sent while the other organization is off");

  f.setPolicy(BOTH_ENABLED);
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

test("a resumed session does not send what came before it, once the other organization is on", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = session(c.url, { orgs: [ORG, OTHER], policy: OTHER_OFF, history: HISTORY });

  await f.sessionStart("resume");
  await f.turn("off");

  f.setPolicy(BOTH_ENABLED);
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

// The baseline the two tests above rely on: a session that records normally
// never sends what its transcript held before it started.
test("a resumed session that records normally sends only its own turns", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = session(c.url, { orgs: [ORG, OTHER], policy: BOTH_ENABLED, history: HISTORY });

  await f.sessionStart("resume");
  await f.turn("on");
  await f.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.transcript(), ["on-u", "on-a"]);
});

test("an organization chosen later still sends the turns after the choice", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = session(c.url, { orgs: [ORG], policy: { repositories: { [REPO_KEY]: true } } });

  await f.sessionStart("startup");
  await f.turn("pending");
  assert.deepEqual(c.transcript(), []);

  f.setPolicy({ orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true } });
  await f.turn("on-1");
  await f.drained(() => c.transcript().includes("on-1-a"));
  await f.turn("on-2");
  await f.drained(() => c.transcript().includes("on-2-a"));
  assert.deepEqual(c.transcript(), ["on-1-u", "on-1-a", "on-2-u", "on-2-a"]);
});

// Only a refusal to send moves the cursor. A turn whose event could not be
// written was allowed, and its transcript goes with the next turn.
test("a turn whose event could not be written is still sent with the next turn", async (t) => {
  const c = await collector();
  t.after(c.close);
  const f = session(c.url, { orgs: [ORG, OTHER], policy: BOTH_ENABLED });

  await f.sessionStart("startup");
  await f.turn("first");
  await f.drained(() => c.transcript().includes("first-a"));

  f.breakEventLog();
  await f.turn("unwritten");
  f.repairEventLog();
  await f.turn("next");
  await f.drained(() => c.transcript().includes("next-a"));
  assert.deepEqual(c.transcript(), ["first-u", "first-a", "unwritten-u", "unwritten-a", "next-u", "next-a"]);
});
