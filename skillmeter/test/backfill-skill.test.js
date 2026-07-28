"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  makeJwt,
  makeTempDir,
  readJson,
  runNode,
  writeFile,
  writeJson,
} = require("../testing/helpers");

const BACKFILL_SCRIPT = path.resolve(
  __dirname,
  "../scripts/backfill.js"
);
const LIFECYCLE_ID = "66666666-6666-4666-8666-666666666666";
const WRONG_LIFECYCLE_ID = "77777777-7777-4777-8777-777777777777";

function lifecycle(lifecycleId, status = "pending", details = {}) {
  return {
    schema_version: 1,
    lifecycle_id: lifecycleId,
    status,
    reason: status === "pending" ? "one_time_offer" : "snapshot_queued",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...details,
  };
}

function fixture() {
  const claudeConfigDir = makeTempDir("skm-backfill-skill-config-");
  const stateDir = makeTempDir("skm-backfill-skill-state-");
  const wrongData = makeTempDir("skm-backfill-skill-wrong-");
  const targetData = path.join(
    claudeConfigDir,
    "plugins",
    "data",
    "skillmeter-inline"
  );
  writeJson(
    path.join(wrongData, "backfill-state.json"),
    lifecycle(WRONG_LIFECYCLE_ID, "completed")
  );
  writeJson(
    path.join(targetData, "backfill-state.json"),
    lifecycle(LIFECYCLE_ID)
  );
  writeJson(path.join(stateDir, "credentials.json"), {
    device_id: "BACKFILL-SKILL-DEVICE",
    hash_salt: "0123456789abcdef0123456789abcdef",
    license_jwt: makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: { login: "SkillBench-AI" },
    }),
  });
  return {
    claudeConfigDir,
    stateDir,
    wrongData,
    targetData,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_PLUGIN_DATA: wrongData,
      SKILLMETER_STATE_DIR: stateDir,
    },
  };
}

test("backfill CLI binds the hook lifecycle instead of ambient plugin data", () => {
  const testFixture = fixture();
  const result = runNode(
    BACKFILL_SCRIPT,
    [
      "claim",
      LIFECYCLE_ID,
      "88888888-8888-4888-8888-888888888888",
    ],
    { env: testFixture.env }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).claimed, true);
  assert.equal(
    readJson(path.join(testFixture.targetData, "backfill-state.json")).status,
    "declined"
  );
  assert.equal(
    readJson(path.join(testFixture.wrongData, "backfill-state.json")).status,
    "completed"
  );
});

test("manual claim reopens a declined offer but never a completed backfill", () => {
  const testFixture = fixture();
  writeJson(
    path.join(testFixture.targetData, "backfill-state.json"),
    lifecycle(LIFECYCLE_ID, "declined", { reason: "user_declined" })
  );
  const reopened = runNode(
    BACKFILL_SCRIPT,
    ["manual-claim", LIFECYCLE_ID],
    { env: testFixture.env }
  );
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(reopened.stdout).claimed, true);

  writeJson(
    path.join(testFixture.targetData, "backfill-state.json"),
    lifecycle(LIFECYCLE_ID, "completed")
  );
  const completed = runNode(
    BACKFILL_SCRIPT,
    ["manual-claim", LIFECYCLE_ID],
    { env: testFixture.env }
  );
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).claimed, false);
});

test("manual backfill expansion exposes only the opaque lifecycle scope", () => {
  const testFixture = fixture();
  const result = runNode(
    path.resolve(
      __dirname,
      "../scripts/user_prompt_expansion_backfill.js"
    ),
    [],
    {
      env: {
        ...testFixture.env,
        CLAUDE_PLUGIN_DATA: testFixture.targetData,
      },
      input: JSON.stringify({
        command_name: "skillmeter:backfill",
        command_source: "plugin",
        session_id: "99999999-9999-4999-8999-999999999999",
      }),
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  const state = JSON.parse(
    context.split("SkillMeter manual backfill state JSON:\n")[1]
  );
  assert.equal(state.status, "signed_in");
  assert.deepEqual(state.orgs, ["skillbench-ai"]);
  assert.equal(state.backfill.lifecycleId, LIFECYCLE_ID);
  assert.equal(
    state.backfill.activeSessionId,
    "99999999-9999-4999-8999-999999999999"
  );
  assert.doesNotMatch(context, /skm-backfill-skill/);
});

test("status reports backend-confirmed transcript uploads by UUID", () => {
  const testFixture = fixture();
  const offerId = "offer-status";
  writeJson(
    path.join(testFixture.targetData, "backfill-state.json"),
    lifecycle(LIFECYCLE_ID, "completed", { offer_id: offerId })
  );
  const log = path.join(
    testFixture.targetData,
    "logs",
    "backfill.ndjson"
  );
  writeFile(
    log,
    [
      {
        event: "snapshot_progress",
        offerId,
        repository: "github.com/skillbench-ai/example",
        transcriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        outcome: "queued",
        chunks: 2,
      },
      {
        event: "upload_succeeded",
        offerId,
        repository: "github.com/skillbench-ai/example",
        transcriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        seq: 0,
      },
      {
        event: "upload_succeeded",
        offerId,
        repository: "github.com/skillbench-ai/example",
        transcriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        seq: 1,
      },
    ].map(JSON.stringify).join("\n") + "\n"
  );

  const result = runNode(
    BACKFILL_SCRIPT,
    ["status", LIFECYCLE_ID],
    { env: testFixture.env }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.transcripts, [
    {
      repository: "github.com/skillbench-ai/example",
      transcriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      snapshot: "queued",
      queuedChunks: 2,
      sentChunks: 2,
      failedAttempts: 0,
      deferredAttempts: 0,
      status: "sent",
    },
  ]);
});

test("manual backfill skill and expansion hook are registered", () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, "../skills/backfill/SKILL.md"),
    "utf8"
  );
  const hooks = readJson(path.resolve(__dirname, "../hooks/hooks.json"));
  assert.match(skill, /description: Manually trigger or inspect/);
  assert.match(skill, /backfill\.js status LIFECYCLE_ID/);
  assert.match(
    skill,
    /backfill\.js accept LIFECYCLE_ID OFFER_ID REVISION "ORG" ID\.\.\./
  );
  assert.ok(
    hooks.hooks.UserPromptExpansion.some(
      (entry) =>
        entry.matcher === "backfill|skillmeter:backfill" &&
        entry.hooks[0].args.includes(
          "${CLAUDE_PLUGIN_ROOT}/scripts/user_prompt_expansion_backfill.js"
        )
    )
  );
});
