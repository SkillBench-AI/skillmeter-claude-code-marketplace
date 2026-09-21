"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { test } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  setTestEnv,
  writeJson,
  writeTelemetryPolicy,
} = require("../testing/helpers");

const DATA_DIR = makeTempDir("skm-backfill-monitor-");
setTestEnv("CLAUDE_PLUGIN_DATA", DATA_DIR);
// credstore resolves its state directory at require time and readPolicy writes
// the policy file when none exists, so this must be set before the requires
// below and passed to every monitor subprocess.
const STATE_DIR = makeTempDir("skm-backfill-monitor-state-");
setTestEnv("SKILLMETER_STATE_DIR", STATE_DIR);

const {
  BACKFILL_LOG_FILE,
  appendBackfillLog,
} = require("../scripts/lib/backfill-log");
const { RUNNING_STALE_MS } = require("../scripts/lib/backfill-state");
const {
  backfillInFlight,
  formatDiagnostic,
  formatNotification,
  pendingBackfillChunks,
} = require("../scripts/monitors/backfill_monitor");

const MONITORS = readJson(path.resolve(__dirname, "../monitors/monitors.json"));

test("backfill monitor arms at session start and when either offer skill runs", () => {
  const backfill = MONITORS.filter((entry) =>
    entry.command.includes("backfill_monitor.js")
  );
  // Monitor commands get `${...}` substituted but nothing exported, so the
  // data dir is passed through explicitly.
  const command =
    'CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" ' +
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/monitors/backfill_monitor.js"';
  assert.deepEqual(backfill, [
    {
      name: "skillmeter-backfill-monitor",
      command,
      description: "SkillMeter history backfill",
      when: "always",
    },
    {
      name: "skillmeter-backfill-monitor-signin",
      command: `${command} --await-offer`,
      description: "SkillMeter history backfill",
      when: "on-skill-invoke:skillmeter:signin",
    },
    {
      name: "skillmeter-backfill-monitor-backfill",
      command: `${command} --await-offer`,
      description: "SkillMeter history backfill",
      when: "on-skill-invoke:skillmeter:backfill",
    },
  ]);
});

// `${pluginName}:${name}` is the host's arm-dedupe key and it is never released
// once armed, so a shared name would let the session-start entry permanently
// block the skill-armed ones. The host also rejects duplicates outright.
test("every monitor name is distinct", () => {
  const names = MONITORS.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
});

// Both skills reach `backfill.js accept`, and sign-in is the common one: it
// carries the one-time offer made during onboarding.
test("both skills that can start a backfill arm the monitor", () => {
  const armedBy = new Set(
    MONITORS.flatMap((entry) =>
      entry.when?.startsWith("on-skill-invoke:") &&
      entry.command.includes("backfill_monitor.js")
        ? [entry.when.slice("on-skill-invoke:".length)]
        : []
    )
  );
  for (const skill of ["skillmeter:signin", "skillmeter:backfill"]) {
    assert.ok(
      armedBy.has(skill),
      `no backfill monitor is armed by ${skill}`
    );
    assert.match(
      fs.readFileSync(
        path.resolve(__dirname, `../skills/${skill.split(":")[1]}/SKILL.md`),
        "utf8"
      ),
      /backfill\.js accept/
    );
  }
});

test("structured backfill log is private, append-only NDJSON", () => {
  const record = appendBackfillLog("upload_failed", {
    offerId: "offer-a",
    repository: "github.com/skillbench-ai/example",
    transcriptId: "11111111-1111-4111-8111-111111111111",
    error:
      `${process.env.HOME}/private/transcript.jsonl ` +
      "https://tenant.example/upload\nfailed",
  });
  assert.equal(record.event, "upload_failed");

  const stored = JSON.parse(
    fs.readFileSync(BACKFILL_LOG_FILE, "utf8").trim()
  );
  assert.equal(stored.offerId, "offer-a");
  assert.equal(stored.repository, "github.com/skillbench-ai/example");
  assert.match(stored.error, /\[HOME\]/);
  assert.match(stored.error, /\[ENDPOINT\]/);
  assert.doesNotMatch(stored.error, /private\/transcript/);
  assert.doesNotMatch(stored.error, /tenant\.example/);
  assert.equal(fs.statSync(BACKFILL_LOG_FILE).mode & 0o777, 0o600);
  assert.equal(appendBackfillLog("../invalid", {}), null);
});

test("monitor reports lifecycle summaries without transcript content", () => {
  assert.equal(
    formatNotification({
      event: "snapshot_completed",
      processedTranscripts: 21,
      queuedChunks: 21,
      skippedTranscripts: 15,
    }),
    "SkillMeter backfill snapshot complete: 21 sessions, 21 upload chunks queued, 15 skipped."
  );
  assert.equal(
    formatNotification({
      event: "upload_batch_completed",
      uploaded: 20,
      failed: 1,
      deferred: 0,
    }),
    "SkillMeter backfill upload pass complete: 20 sent, 1 failed, 0 deferred."
  );
  assert.equal(
    formatNotification({
      event: "upload_attempt",
      transcriptContent: "must not be shown",
    }),
    ""
  );
  assert.equal(
    formatNotification({
      event: "upload_batch_completed",
      uploaded: 0,
      failed: 0,
      deferred: 21,
    }),
    ""
  );
});

test("monitor counts only backfill upload chunks", () => {
  const chunks = path.join(
    DATA_DIR,
    "logs",
    "repositories",
    "aaaaaaaaaaaa",
    "transcripts",
    "chunks"
  );
  writeJson(path.join(chunks, "backfill.meta.json"), {
    promptId: "backfill",
  });
  writeJson(path.join(chunks, "live.meta.json"), {
    promptId: "live",
  });
  assert.equal(pendingBackfillChunks(), 1);
});

// ---- output contract -------------------------------------------------------
// Every stdout line from a plugin monitor becomes one Claude-facing
// notification, so a per-failure line is a flood: the notification re-invokes
// the session, the session's Stop hook spawns another drain, and that drain
// fails the same chunks again. Retry noise goes to stderr instead.

test("per-attempt upload failures never become Claude notifications", () => {
  assert.equal(
    formatNotification({
      event: "upload_failed",
      repository: "github.com/skillbench-ai/example",
      transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
      seq: 3,
      httpStatus: 500,
      error: "HTTP 500",
    }),
    ""
  );
  assert.equal(
    formatNotification({ event: "upload_deferred", reason: "license_unavailable" }),
    ""
  );
});

test("retry noise is still visible as monitor diagnostics on stderr", () => {
  assert.match(
    formatDiagnostic({
      event: "upload_failed",
      repository: "github.com/skillbench-ai/example",
      transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
      seq: 3,
      attempts: 4,
      error: "HTTP 500",
    }),
    /seq 3.*HTTP 500/
  );
  assert.equal(formatDiagnostic({ event: "snapshot_completed" }), "");
});

test("giving up on a chunk is announced once, because it is actionable", () => {
  assert.equal(
    formatNotification({
      event: "upload_abandoned",
      repository: "github.com/skillbench-ai/example",
      transcriptId: "e982c12e-621b-49c6-9a82-564ab0fb7f9c",
      seq: 3,
      attempts: 8,
      error: "HTTP 500",
    }),
    "SkillMeter backfill gave up on 1 upload chunk after 8 attempts " +
      "(github.com/skillbench-ai/example seq 3, HTTP 500); it is set aside, not lost."
  );
});


// ---- process lifetime ------------------------------------------------------
// The monitor is listed in the task panel for as long as its process lives, so
// "is a backfill happening" has to be a property of the process, not just of
// what it prints. These tests run the real script.

const MONITOR = path.resolve(__dirname, "../scripts/monitors/backfill_monitor.js");

function licenseFor(org) {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    org: { login: org },
  });
}

/** The state a signed-in install with telemetry on presents to the monitor. */
function permitTransmission(stateDir, org = "example-org") {
  writeTelemetryPolicy(stateDir, { enabled: true, orgs: { [org]: true } });
  writeJson(path.join(stateDir, "credentials.json"), {
    license_jwt: licenseFor(org),
  });
}

function appendLog(dataDir, record) {
  fs.appendFileSync(
    path.join(dataDir, "logs", "backfill.ndjson"),
    JSON.stringify({ schemaVersion: 1, ...record }) + "\n"
  );
}

function writeLifecycle(dataDir, state) {
  writeJson(path.join(dataDir, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "11111111-1111-4111-8111-111111111111",
    offer_id: "22222222-2222-4222-8222-222222222222",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...state,
  });
}

function startMonitor(dataDir, args = [], env = {}) {
  const child = spawn(process.execPath, [MONITOR, ...args], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      SKILLMETER_STATE_DIR: STATE_DIR,
      SKILLMETER_BACKFILL_OFFER_GRACE_MS: "4000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.resume();
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    child,
    exited,
    get stdout() { return stdout; },
    stop() { try { child.kill("SIGKILL"); } catch {} },
  };
}

function exitsWithin(monitor, ms) {
  return Promise.race([
    monitor.exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms).unref()),
  ]);
}

function monitorDataDir(name) {
  const dir = makeTempDir(`skm-monitor-${name}-`);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

test("session-start monitor exits when no backfill is in flight", async () => {
  const dir = monitorDataDir("idle");
  writeLifecycle(dir, { status: "declined", reason: "user_declined" });
  const monitor = startMonitor(dir);
  try {
    assert.ok(await exitsWithin(monitor, 10_000), "monitor did not exit");
    assert.equal(await monitor.exited, 0);
    // Nothing about backfill reaches the session.
    assert.equal(monitor.stdout, "");
    assert.equal(fs.existsSync(path.join(dir, "logs", ".backfill-monitor.lock")), false);
  } finally {
    monitor.stop();
  }
});

test("session-start monitor stays attached while a snapshot is running", async () => {
  const dir = monitorDataDir("running");
  writeLifecycle(dir, { status: "running", reason: "snapshotting" });
  const monitor = startMonitor(dir);
  try {
    assert.equal(await exitsWithin(monitor, 1_500), false, "monitor exited early");
    assert.match(monitor.stdout, /backfill monitor attached: snapshot running/);
    // Finishing the snapshot is what ends it.
    writeLifecycle(dir, { status: "completed", reason: "snapshot_queued" });
    assert.ok(await exitsWithin(monitor, 15_000), "monitor did not exit after completion");
  } finally {
    monitor.stop();
  }
});

// `claim` runs minutes before `accept`: the model has to ask, and the user has
// to answer. A monitor that exited on the first non-running state it saw would
// be gone before the backfill it was armed for ever started.
test("skill-armed monitor waits out the gap between claim and accept", async () => {
  const dir = monitorDataDir("window");
  writeLifecycle(dir, { status: "pending", reason: "one_time_offer" });
  // The grace has to be the only thing holding the instance open here: a
  // pending lifecycle is not in flight, so it is idle from the first poll and
  // a window inside IDLE_SETTLE_MS would pass without the grace existing.
  const monitor = startMonitor(dir, ["--await-offer"], {
    SKILLMETER_BACKFILL_OFFER_GRACE_MS: "20000",
  });
  try {
    assert.equal(await exitsWithin(monitor, 6_000), false, "monitor exited during the window");
    writeLifecycle(dir, { status: "running", reason: "snapshotting" });
    assert.equal(await exitsWithin(monitor, 1_500), false, "monitor exited while running");
    writeLifecycle(dir, { status: "completed", reason: "snapshot_queued" });
    assert.ok(await exitsWithin(monitor, 15_000), "monitor did not exit after completion");
  } finally {
    monitor.stop();
  }
});

test("skill-armed monitor gives up when the run was not a backfill", async () => {
  const dir = monitorDataDir("nooffer");
  writeLifecycle(dir, { status: "pending", reason: "one_time_offer" });
  const monitor = startMonitor(dir, ["--await-offer"]);
  try {
    assert.ok(await exitsWithin(monitor, 20_000), "monitor outlived the offer grace");
    assert.equal(monitor.stdout, "");
  } finally {
    monitor.stop();
  }
});

// A declined offer is answered, so the grace period must not hold the monitor
// open for its full length afterwards.
test("skill-armed monitor stops as soon as the offer is declined", async () => {
  const dir = monitorDataDir("declined");
  writeLifecycle(dir, { status: "declined", reason: "offer_consumed" });
  const monitor = startMonitor(dir, ["--await-offer"], {
    SKILLMETER_BACKFILL_OFFER_GRACE_MS: "600000",
  });
  try {
    assert.equal(await exitsWithin(monitor, 1_500), false, "monitor exited while the offer was open");
    writeLifecycle(dir, { status: "declined", reason: "user_declined" });
    assert.ok(await exitsWithin(monitor, 15_000), "monitor did not exit after the decline");
  } finally {
    monitor.stop();
  }
});

test("a second instance does not double-report the same backfill", async () => {
  const dir = monitorDataDir("lock");
  writeLifecycle(dir, { status: "running", reason: "snapshotting" });
  const first = startMonitor(dir);
  try {
    assert.equal(await exitsWithin(first, 1_500), false, "first instance exited");
    assert.match(first.stdout, /backfill monitor attached/);
    const second = startMonitor(dir, ["--await-offer"]);
    try {
      assert.ok(await exitsWithin(second, 10_000), "second instance did not stand down");
      assert.equal(second.stdout, "");
    } finally {
      second.stop();
    }
  } finally {
    first.stop();
  }
});

// A lifecycle left in either non-terminal state by a session that went away
// must not pin the monitor open in every session afterwards.
test("a stale claim or worker does not count as in flight", () => {
  // Isolate the lifecycle from the queue: pending chunks are in flight in
  // their own right and would answer for it.
  fs.rmSync(path.join(DATA_DIR, "logs", "repositories"), {
    recursive: true,
    force: true,
  });
  const stale = Date.now() - RUNNING_STALE_MS - 60_000;
  writeJson(path.join(DATA_DIR, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "33333333-3333-4333-8333-333333333333",
    offer_id: "44444444-4444-4444-8444-444444444444",
    status: "declined",
    reason: "offer_consumed",
    created_at: stale,
    updated_at: stale,
  });
  assert.equal(backfillInFlight(), false);

  writeJson(path.join(DATA_DIR, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "33333333-3333-4333-8333-333333333333",
    offer_id: "44444444-4444-4444-8444-444444444444",
    status: "declined",
    reason: "offer_consumed",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  assert.equal(backfillInFlight(), true);
});

// Three of the four ways an upload defers without recording an attempt are one
// local read — the global kill-switch, a missing license, an org not
// authorized — and sign-out is the fourth, which leaves the policy in place so
// nothing purges the queue. Age cannot stand in for this: a chunk nothing has
// tried yet is as untouched as a stranded one.
test("a queued chunk is in flight only while the queue could drain", () => {
  fs.rmSync(path.join(DATA_DIR, "logs", "repositories"), {
    recursive: true,
    force: true,
  });
  writeJson(path.join(DATA_DIR, "backfill-state.json"), {
    schema_version: 1,
    lifecycle_id: "55555555-5555-4555-8555-555555555555",
    offer_id: "66666666-6666-4666-8666-666666666666",
    status: "completed",
    reason: "snapshot_queued",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  writeJson(
    path.join(
      DATA_DIR, "logs", "repositories", "bbbbbbbbbbbb",
      "transcripts", "chunks", "queued.meta.json"
    ),
    { promptId: "backfill" }
  );

  permitTransmission(STATE_DIR);
  assert.equal(backfillInFlight(), true, "signed in with telemetry on");

  writeTelemetryPolicy(STATE_DIR, { enabled: false, orgs: { "example-org": true } });
  assert.equal(backfillInFlight(), false, "global kill-switch");

  permitTransmission(STATE_DIR);
  writeJson(path.join(STATE_DIR, "credentials.json"), {
    license_jwt: licenseFor("example-org"),
    signed_out: true,
  });
  assert.equal(backfillInFlight(), false, "signed out");

  writeJson(path.join(STATE_DIR, "credentials.json"), {});
  assert.equal(backfillInFlight(), false, "no license");

  writeTelemetryPolicy(STATE_DIR, { enabled: true, orgs: { "other-org": true } });
  writeJson(path.join(STATE_DIR, "credentials.json"), {
    license_jwt: licenseFor("example-org"),
  });
  assert.equal(backfillInFlight(), false, "org not authorized");

  // Nothing moved the chunk; only the ability to send it changed.
  assert.equal(pendingBackfillChunks(), 1);
  permitTransmission(STATE_DIR);
});

// ---- the lock ---------------------------------------------------------------
// Two instances tailing one log emit every line twice, and a repeated
// notification re-invokes the session, whose Stop hook spawns another drain
// (see the output contract above). Ownership is the pid inside the file.

function lockPath(dir) {
  return path.join(dir, "logs", ".backfill-monitor.lock");
}

async function reapedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

test("a holder that stopped refreshing keeps the lock while its process lives", async () => {
  const dir = monitorDataDir("lock-live");
  writeLifecycle(dir, { status: "running", reason: "snapshotting" });
  // Machine sleep or a load spike stalls a holder without ending it. Age alone
  // would hand its work to a second instance and double every notification.
  fs.writeFileSync(lockPath(dir), `${process.pid}\n`);
  const stalled = new Date(Date.now() - 600_000);
  fs.utimesSync(lockPath(dir), stalled, stalled);
  const monitor = startMonitor(dir);
  try {
    assert.ok(await exitsWithin(monitor, 10_000), "second instance did not stand down");
    assert.equal(monitor.stdout, "");
    assert.equal(fs.readFileSync(lockPath(dir), "utf8").trim(), String(process.pid));
  } finally {
    monitor.stop();
  }
});

test("a dead holder's lock is reclaimed without waiting out a timeout", async () => {
  const dir = monitorDataDir("lock-dead");
  writeLifecycle(dir, { status: "running", reason: "snapshotting" });
  fs.writeFileSync(lockPath(dir), `${await reapedPid()}\n`);
  const monitor = startMonitor(dir);
  try {
    assert.equal(await exitsWithin(monitor, 2_000), false, "stood down for a dead holder");
    assert.match(monitor.stdout, /backfill monitor attached/);
    assert.equal(
      fs.readFileSync(lockPath(dir), "utf8").trim(),
      String(monitor.child.pid)
    );
  } finally {
    monitor.stop();
  }
});

test("a monitor that loses the lock stops, and leaves the new holder's alone", async () => {
  const dir = monitorDataDir("lock-takeover");
  writeLifecycle(dir, { status: "running", reason: "snapshotting" });
  const monitor = startMonitor(dir);
  try {
    assert.equal(await exitsWithin(monitor, 1_500), false, "monitor exited early");
    assert.equal(
      fs.readFileSync(lockPath(dir), "utf8").trim(),
      String(monitor.child.pid)
    );
    fs.writeFileSync(lockPath(dir), `${process.pid}\n`);
    assert.ok(
      await exitsWithin(monitor, 10_000),
      "kept tailing a log it no longer owns"
    );
    assert.equal(
      fs.readFileSync(lockPath(dir), "utf8").trim(),
      String(process.pid),
      "removed a lock belonging to someone else"
    );
  } finally {
    monitor.stop();
  }
});

// transfer.js deletes a chunk on its 2xx but appends upload_batch_completed
// only once the whole batch settles, so an exit in that gap drops the one
// notification that says the backfill finished.
test("the closing upload notice survives the exit", async () => {
  const dir = monitorDataDir("settle");
  writeLifecycle(dir, { status: "completed", reason: "snapshot_queued" });
  const chunk = path.join(
    dir, "logs", "repositories", "cccccccccccc",
    "transcripts", "chunks", "last.meta.json"
  );
  writeJson(chunk, { promptId: "backfill" });
  const monitor = startMonitor(dir);
  try {
    assert.equal(await exitsWithin(monitor, 1_500), false, "monitor exited early");
    fs.rmSync(chunk);
    await new Promise((resolve) => setTimeout(resolve, 600));
    appendLog(dir, {
      event: "upload_batch_completed",
      uploaded: 7,
      failed: 0,
      deferred: 0,
    });
    assert.ok(await exitsWithin(monitor, 15_000), "monitor did not exit");
    assert.match(monitor.stdout, /upload pass complete: 7 sent/);
  } finally {
    monitor.stop();
  }
});
