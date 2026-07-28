"use strict";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeTempDir, writeFile } = require("../testing/helpers");
const { scanHistoricalSessions } = require("../scripts/lib/backfill-scan");

const TENANT_SESSION = "11111111-1111-4111-8111-111111111111.jsonl";
const TENANT_SESSION_2 = "22222222-2222-4222-8222-222222222222.jsonl";
const EXTERNAL_SESSION = "33333333-3333-4333-8333-333333333333.jsonl";
const NO_CWD_SESSION = "44444444-4444-4444-8444-444444444444.jsonl";

function writeSession(projectsDir, projectName, sessionName, cwd) {
  const projectDir = path.join(projectsDir, projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  writeFile(
    path.join(projectDir, sessionName),
    cwd ? `${JSON.stringify({ type: "user", cwd })}\n` : '{"type":"system"}\n'
  );
}

test("backfill scan includes only sessions whose repository passes org scope", () => {
  const projectsDir = makeTempDir("skm-backfill-");
  writeSession(projectsDir, "tenant-project", TENANT_SESSION, "/repos/tenant");
  writeSession(projectsDir, "tenant-project", TENANT_SESSION_2, "/repos/tenant");
  writeSession(projectsDir, "external-project", EXTERNAL_SESSION, "/repos/external");
  writeSession(projectsDir, "unknown-project", NO_CWD_SESSION, "");
  writeFile(path.join(projectsDir, "tenant-project", "not-a-session.txt"), "ignored");

  const result = scanHistoricalSessions({
    projectsDir,
    getScopeDecision(cwd) {
      if (cwd === "/repos/tenant") {
        return {
          allowed: true,
          classification: "github_org_match",
          repoRoot: cwd,
          remoteOrg: "skillbench-ai",
        };
      }
      return {
        allowed: false,
        classification: "github_org_mismatch",
        repoRoot: cwd,
        remoteOrg: "external-org",
      };
    },
  });

  assert.deepEqual(
    result.included.map((entry) => entry.sessionId).sort(),
    [TENANT_SESSION, TENANT_SESSION_2].map((name) => path.basename(name, ".jsonl"))
  );
  assert.ok(result.included.every((entry) => entry.remoteOrg === "skillbench-ai"));
  assert.deepEqual(result.summary, {
    projectsScanned: 3,
    sessionsIncluded: 2,
    sessionsSkipped: 2,
    skippedByReason: {
      github_org_mismatch: 1,
      no_cwd: 1,
    },
  });
});

test("backfill scan honors selected repositories, cutoff, and active session", () => {
  const projectsDir = makeTempDir("skm-backfill-filter-");
  writeSession(projectsDir, "tenant-project", TENANT_SESSION, "/repos/tenant");
  writeSession(projectsDir, "tenant-project", TENANT_SESSION_2, "/repos/tenant");
  writeSession(projectsDir, "external-project", EXTERNAL_SESSION, "/repos/other");

  const cutoffAt = Date.now() - 5_000;
  fs.utimesSync(
    path.join(projectsDir, "tenant-project", TENANT_SESSION),
    new Date(cutoffAt - 1_000),
    new Date(cutoffAt - 1_000)
  );
  fs.utimesSync(
    path.join(projectsDir, "tenant-project", TENANT_SESSION_2),
    new Date(cutoffAt + 1_000),
    new Date(cutoffAt + 1_000)
  );

  const result = scanHistoricalSessions({
    projectsDir,
    allowedRepoKeys: new Set(["github.com/skillbench-ai/tenant"]),
    cutoffAt,
    excludeSessionId: path.basename(TENANT_SESSION, ".jsonl"),
    getScopeDecision(cwd) {
      return {
        allowed: true,
        classification: "github_org_match",
        repoRoot: cwd,
        remoteOrg: "skillbench-ai",
        repoKey: cwd === "/repos/tenant"
          ? "github.com/skillbench-ai/tenant"
          : "github.com/skillbench-ai/other",
      };
    },
  });

  assert.deepEqual(result.included, []);
  assert.deepEqual(result.summary.skippedByReason, {
    active_session: 1,
    modified_after_cutoff: 1,
    repository_not_selected: 1,
  });
});
