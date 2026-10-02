"use strict";

// A session can move between directories, and one transcript then holds turns
// from several places. Each turn is sent only for the repository it ended in,
// and only when every repository it was written in is recording. Directories
// outside any repository do not count.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ORG, REPO_KEY, OTHER_KEY, HISTORY, collector, session } = require("../testing/transcript-session");

const BOTH = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true, [OTHER_KEY]: true } };
const OTHER_OFF = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: true, [OTHER_KEY]: false } };
const OTHER_ON_ONLY = { orgs: { [ORG]: true }, repositories: { [REPO_KEY]: false, [OTHER_KEY]: true } };
const GADGETS_URL = `https://github.com/${ORG}/gadgets.git`;
const FOREIGN_URL = "https://github.com/elsewhere/tools.git";

async function start(t, options) {
  const c = await collector();
  t.after(c.close);
  const s = session(c.url, options);
  await s.sessionStart("startup");
  return { c, s };
}

// What is not sent.

test("a turn outside any repository is not sent once the session enters one", async (t) => {
  const { c, s } = await start(t, { policy: BOTH, dir: "outside" });
  await s.turn("out");
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

test("a turn outside any repository is not sent on the return to one", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("rec");
  await s.drained(() => c.transcript().includes("rec-a"));
  s.cd("outside");
  await s.turn("out");
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["rec-u", "rec-a", "in-u", "in-a"]);
});

test("a turn in another enabled repository is sent once, for that repository", async (t) => {
  const { c, s } = await start(t, { policy: BOTH, dir: "other" });
  await s.turn("gadgets");
  await s.drained(() => c.transcript().includes("gadgets-a"));
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.sentFor(OTHER_KEY), ["gadgets-u", "gadgets-a"]);
  assert.deepEqual(c.sentFor(REPO_KEY), ["in-u", "in-a"]);
});

test("a turn in a repository turned off is not sent for another", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF, dir: "other" });
  await s.turn("off");
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

test("a turn in a repository the license does not cover is not sent for another", async (t) => {
  const { c, s } = await start(t, { policy: BOTH, dir: "foreign" });
  await s.turn("foreign");
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.transcript(), ["in-u", "in-a"]);
});

// A turn that reads a repository turned off is not sent at all, even though it
// began and ended in an enabled one: what it read there would go with it.
test("a turn that visits a repository turned off is not sent", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("mixed", { during: async () => { s.cd("other"); await s.tool("peek"); s.cd("repo"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

test("a turn that visits a repository the license does not cover is not sent", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("mixed", { during: async () => { s.cd("foreign"); await s.tool("peek"); s.cd("repo"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

// Turned on while the session is elsewhere: nothing seen it collect since.
test("another repository's Stop sends nothing for one last seen turned off", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_ON_ONLY });
  await s.turn("off");
  s.late("tail");
  s.setPolicy(BOTH);
  s.cd("other");
  await s.turn("g");
  await s.drained(() => c.transcript().includes("g-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), []);
  assert.deepEqual(c.sentFor(OTHER_KEY), ["g-u", "g-a"]);
});

// Turned off before its pending turn was staged, as if it had been queued.
test("a repository turned off while the session is elsewhere does not get its pending turn later", async (t) => {
  const { c, s } = await start(t, { policy: BOTH, dir: "outside" });
  await s.turn("w1", { during: async () => { s.cd("repo"); await s.tool("edit"); s.cd("outside"); } });
  s.setPolicy(OTHER_ON_ONLY);
  s.cd("other");
  await s.turn("g1");
  await s.drained(() => c.transcript().includes("g1-a"));
  s.setPolicy(BOTH);
  await s.turn("g2");
  await s.drained(() => c.transcript().includes("g2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), []);
  assert.deepEqual(c.sentFor(OTHER_KEY), ["g1-u", "g1-a", "g2-u", "g2-a"]);
  // Closed as the off path closes a period that was not recorded.
  assert.equal(s.cursor(REPO_KEY).discarded, true);
});

test("a resumed session does not send its earlier turns in a repository it returns to", async (t) => {
  const c = await collector();
  t.after(c.close);
  // The history was written in the repository; this session resumes elsewhere.
  const s = session(c.url, { policy: BOTH, history: HISTORY });
  s.cd("other");
  await s.sessionStart("resume");
  await s.turn("gadgets");
  s.cd("repo");
  await s.turn("in");
  await s.drained(() => c.transcript().includes("in-a"));
  assert.deepEqual(c.sentFor(OTHER_KEY), ["gadgets-u", "gadgets-a"]);
  assert.deepEqual(c.sentFor(REPO_KEY), ["in-u", "in-a"]);
});

// Claude Code adds user records inside a turn (hook context, skill text) that
// share its prompt id. They do not start a turn, so the turn stays whole.
test("a turn that visits a repository turned off is not sent past a record added inside it", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("mixed", { during: async () => { s.cd("other"); await s.tool("peek"); s.cd("repo"); s.context("note"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

// No hook ran there, so only the records say where the turn read.
test("a turn whose records name a repository the license does not cover is not sent", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("mixed", { during: async () => { s.cd("foreign"); await s.tool("peek", { hook: false }); s.cd("repo"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

// A directory that no longer exists cannot show it was recording.

test("a turn that read a deleted clone of a repository turned off is not sent", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  s.addDir("clone", GADGETS_URL);
  await s.turn("mixed", { during: async () => { s.cd("clone"); await s.tool("peek"); s.cd("repo"); s.rm("clone"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

test("a turn that read a deleted clone the license does not cover is not sent", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  s.addDir("clone", FOREIGN_URL);
  await s.turn("mixed", { during: async () => { s.cd("clone"); await s.tool("peek"); s.cd("repo"); s.rm("clone"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

test("a turn in a clone turned off is not sent once the clone is removed", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  s.addDir("clone", GADGETS_URL);
  s.cd("clone");
  await s.turn("peek");
  s.cd("repo");
  s.rm("clone");
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.transcript(), ["a1-u", "a1-a", "a2-u", "a2-a"]);
});

// No hook ran in the clone, so only the records say where the turn read.
test("a turn whose records name a deleted clone is not sent", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  s.addDir("clone", GADGETS_URL);
  await s.turn("mixed", { during: async () => { s.cd("clone"); await s.tool("peek", { hook: false }); s.cd("repo"); s.rm("clone"); } });
  await s.turn("after");
  await s.drained(() => c.transcript().includes("after-a"));
  assert.deepEqual(c.transcript(), ["after-u", "after-a"]);
});

test("a turn in a deleted directory outside any repository is sent for none", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  s.cd("other");
  await s.turn("b1");
  await s.drained(() => c.transcript().includes("b1-a"));
  s.addDir("scratch");
  s.cd("scratch");
  await s.turn("out");
  s.rm("scratch");
  s.cd("repo");
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
  assert.deepEqual(c.sentFor(OTHER_KEY), ["b1-u", "b1-a"]);
});

// Whether a repository was recording is decided when the turn was written:
// turning it on before the turn is staged does not release what was read
// there while it was off.

test("a turn that read a repository while it was off is not sent once that repository is on", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  // The turn ends outside any repository, so its own Stop stages nothing.
  await s.turn("dip", { during: async () => { s.cd("other"); await s.tool("peek"); s.cd("repo"); await s.tool("back"); s.cd("outside"); } });
  s.setPolicy(BOTH);
  await s.turn("cmd");
  s.cd("repo");
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
});

test("a turn that read a repository while it was off is not sent when it is turned on during the turn", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  await s.turn("dip", { during: async () => { s.cd("other"); await s.tool("peek"); s.setPolicy(BOTH); s.cd("repo"); await s.tool("back"); } });
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
});

test("an interrupted turn that read a repository while it was off is not sent once it is on", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  await s.turn("dip", { stop: false, during: async () => { s.cd("other"); await s.tool("peek"); s.cd("repo"); } });
  s.setPolicy(BOTH);
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
});

test("a turn that read a repository outside the license is not sent once the license covers it", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  await s.turn("dip", { during: async () => { s.cd("foreign"); await s.tool("peek"); s.cd("repo"); await s.tool("back"); s.cd("outside"); } });
  s.signIn([ORG, "elsewhere"]);
  s.setPolicy({
    orgs: { [ORG]: true, elsewhere: true },
    repositories: { [REPO_KEY]: true, [OTHER_KEY]: true, "github.com/elsewhere/tools": true },
  });
  s.cd("repo");
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
});

// The repository itself keeps its own timing: what it records after being
// turned on is sent for it.
test("a repository turned on during a turn sends the rest of that turn, as before", async (t) => {
  const { c, s } = await start(t, { policy: OTHER_OFF, dir: "other" });
  await s.turn("on", { during: async () => { await s.tool("first"); s.setPolicy(BOTH); await s.tool("second"); } });
  await s.drained(() => c.transcript().includes("on-a"));
  assert.deepEqual(c.sentFor(OTHER_KEY), ["on-second", "on-a"]);
});

// What a consenting user still gets: every turn, once.

test("a session in one repository throughout sends every turn once", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  for (const label of ["one", "two", "three"]) {
    await s.turn(label, { during: () => s.tool("run") });
    await s.drained(() => c.transcript().includes(`${label}-a`));
  }
  assert.deepEqual(c.sentFor(REPO_KEY), [
    "one-u", "one-run", "one-a", "two-u", "two-run", "two-a", "three-u", "three-run", "three-a",
  ]);
});

test("a turn that steps outside the repository and back is sent whole", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("span", { during: async () => { s.cd("outside"); await s.tool("ls"); s.cd("repo"); } });
  await s.drained(() => c.transcript().includes("span-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["span-u", "span-ls", "span-a"]);
});

test("a turn that moves to another enabled repository is sent once, for the one it ended in", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("move", { during: async () => { s.cd("other"); await s.tool("build"); } });
  await s.drained(() => c.transcript().includes("move-a"));
  await s.turn("there");
  await s.drained(() => c.transcript().includes("there-a"));
  assert.deepEqual(c.sentFor(OTHER_KEY), ["move-u", "move-build", "move-a", "there-u", "there-a"]);
  assert.deepEqual(c.sentFor(REPO_KEY), []);
});

test("returning to a repository that was recording sends each turn once, where it was written", async (t) => {
  const { c, s } = await start(t, { policy: BOTH });
  await s.turn("a1");
  await s.drained(() => c.transcript().includes("a1-a"));
  s.cd("other");
  await s.turn("b1");
  await s.drained(() => c.transcript().includes("b1-a"));
  s.cd("repo");
  await s.turn("a2");
  await s.drained(() => c.transcript().includes("a2-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["a1-u", "a1-a", "a2-u", "a2-a"]);
  assert.deepEqual(c.sentFor(OTHER_KEY), ["b1-u", "b1-a"]);
});

// The turn's own Stop runs outside any repository and sends nothing. The next
// Stop, in another repository, sends it for the repository it was written in.
test("a turn that ends outside any repository is sent for the repository it worked in", async (t) => {
  const { c, s } = await start(t, { policy: BOTH, dir: "outside" });
  await s.turn("work", { during: async () => { s.cd("repo"); await s.tool("edit"); s.cd("outside"); } });
  s.cd("other");
  await s.turn("next");
  await s.drained(() => c.transcript().includes("next-a") && c.transcript().includes("work-a"));
  assert.deepEqual(c.sentFor(REPO_KEY), ["work-u", "work-edit", "work-a"]);
  assert.deepEqual(c.sentFor(OTHER_KEY), ["next-u", "next-a"]);
});
