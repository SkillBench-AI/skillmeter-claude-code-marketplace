"use strict";
// Repository eligibility: the license's organizations, org-scope narrowing,
// and linked worktrees. Scope can only narrow what the license covers.
const { isolateHome, makeRepo, writeSettings, tempDir, license } = require("../../test-support/plugin.cjs");
isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeef" });
delete process.env.SKILLMETER_REPO_SCOPE_ORGS;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const credstore = require("../../scripts/credstore");
const logger = require("../../scripts/logger");
const { normalizeOrgList, resolveOrgScope } = require("../../scripts/lib/org-scope");

function signInWithOrgs(orgs) {
  const generation = credstore.markEngaged();
  assert.notEqual(credstore.commitSignin({ jwt: license({ orgs }), refreshToken: "synthetic-refresh", generation }), false);
}
const repo = remote => makeRepo({ remote, prefix: "sk-scope-repo" });
function project(skillmeter) {
  const root = tempDir("sk-scope-project");
  if (skillmeter) writeSettings(root, skillmeter);
  return root;
}
function withEnvFilter(value, fn) {
  process.env.SKILLMETER_REPO_SCOPE_ORGS = value;
  try { return fn(); } finally { delete process.env.SKILLMETER_REPO_SCOPE_ORGS; }
}

test("normalizeOrgList lowercases, trims, dedupes, drops empties", () => {
  assert.deepEqual(normalizeOrgList(["  SkillBench-AI ", "acme", "ACME", "", null, 3]), ["skillbench-ai", "acme"]);
  assert.deepEqual(normalizeOrgList("not-an-array"), []);
});

test("resolveOrgScope returns null when nothing is configured", () => {
  assert.equal(resolveOrgScope({ cwd: project(null) }), null);
});

test("resolveOrgScope: env wins over settings", () => {
  withEnvFilter("SkillBench-AI, octocat", () => {
    assert.deepEqual(resolveOrgScope({ cwd: project({ repoScopeOrgs: ["from-settings"] }) }), ["skillbench-ai", "octocat"]);
  });
});

test("resolveOrgScope: per-project setting as array or string", () => {
  assert.deepEqual(resolveOrgScope({ cwd: project({ repoScopeOrgs: ["SkillBench-AI"] }) }), ["skillbench-ai"]);
  assert.deepEqual(resolveOrgScope({ cwd: project({ repoScopeOrgs: "skillbench-ai, acme" }) }), ["skillbench-ai", "acme"]);
});

test("no signed-in organizations means not_activated, even in an allowed-looking repository", () => {
  credstore.signOut();
  assert.deepEqual(credstore.getAllowedGitHubOrgs(), []);
  for (const setup of [() => {}, () => signInWithOrgs([])]) {
    setup();
    const decision = logger.getRepoScopeDecision(repo("git@github.com:acme/widgets.git"));
    assert.equal(decision.allowed, false);
    assert.equal(decision.classification, "not_activated");
  }
});

test("a remote in an allowed organization is approved, case-insensitively, for ssh and https remotes", () => {
  signInWithOrgs(["acme", "octocat"]);
  const ssh = logger.getRepoScopeDecision(repo("git@github.com:acme/widgets.git"));
  assert.deepEqual([ssh.allowed, ssh.scope, ssh.classification, ssh.remoteOrg], [true, "approved", "github_org_match", "acme"]);
  const https = logger.getRepoScopeDecision(repo("https://github.com/ACME/widgets.git"));
  assert.deepEqual([https.allowed, https.classification], [true, "github_org_match"]);
});

test("a remote in a non-member organization is dropped as github_org_mismatch", () => {
  signInWithOrgs(["acme"]);
  const decision = logger.getRepoScopeDecision(repo("git@github.com:someoneelse/widgets.git"));
  assert.deepEqual([decision.allowed, decision.scope, decision.classification, decision.remoteOrg],
    [false, "external", "github_org_mismatch", "someoneelse"]);
});

test("no GitHub remote, no remote at all, or no repository is dropped with the matching reason", () => {
  signInWithOrgs(["acme"]);
  for (const [dir, classification] of [
    [repo("https://gitlab.com/acme/widgets.git"), "no_github_remote"],
    [repo(null), "no_github_remote"],
    [tempDir("sk-scope-plain"), "no_repository"],
  ]) {
    const decision = logger.getRepoScopeDecision(dir);
    assert.equal(decision.allowed, false);
    assert.equal(decision.classification, classification);
  }
});

test("the env filter narrows a multi-org account and can never widen it", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  withEnvFilter("skillbench-ai", () => {
    const inScope = logger.getRepoScopeDecision(repo("git@github.com:skillbench-ai/widgets.git"));
    assert.deepEqual([inScope.allowed, inScope.classification, inScope.remoteOrg], [true, "github_org_match", "skillbench-ai"]);
    const filteredOut = logger.getRepoScopeDecision(repo("git@github.com:acme/widgets.git"));
    assert.deepEqual([filteredOut.allowed, filteredOut.classification, filteredOut.remoteOrg], [false, "github_org_mismatch", "acme"]);
  });
  signInWithOrgs(["acme"]);
  withEnvFilter("skillbench-ai", () => {
    const decision = logger.getRepoScopeDecision(repo("git@github.com:skillbench-ai/widgets.git"));
    assert.deepEqual([decision.allowed, decision.classification], [false, "github_org_mismatch"], "filter names an org the user is not in");
  });
});

test("per-project repoScopeOrgs narrows scope as an array or a comma-separated string", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  for (const value of [["skillbench-ai"], "skillbench-ai, octocat"]) {
    const allowed = repo("git@github.com:skillbench-ai/widgets.git");
    writeSettings(allowed, { repoScopeOrgs: value });
    assert.deepEqual([logger.getRepoScopeDecision(allowed).allowed, logger.getRepoScopeDecision(allowed).classification], [true, "github_org_match"]);
    const other = repo("git@github.com:acme/widgets.git");
    writeSettings(other, { repoScopeOrgs: value });
    assert.deepEqual([logger.getRepoScopeDecision(other).allowed, logger.getRepoScopeDecision(other).classification], [false, "github_org_mismatch"]);
  }
});

test("the env filter takes precedence over the per-project setting", () => {
  signInWithOrgs(["skillbench-ai", "acme"]);
  const dir = repo("git@github.com:acme/widgets.git");
  writeSettings(dir, { repoScopeOrgs: ["acme"] });
  withEnvFilter("skillbench-ai", () => {
    const decision = logger.getRepoScopeDecision(dir);
    assert.deepEqual([decision.allowed, decision.classification], [false, "github_org_mismatch"]);
  });
});

test("an empty or whitespace filter is ignored", () => {
  signInWithOrgs(["acme"]);
  withEnvFilter("   ", () => {
    assert.equal(logger.getRepoScopeOrgFilter(tempDir("sk-scope-plain")), null);
    const decision = logger.getRepoScopeDecision(repo("git@github.com:acme/widgets.git"));
    assert.deepEqual([decision.allowed, decision.classification], [true, "github_org_match"]);
  });
});

// Real Git layouts catch what hand-written .git/config fixtures miss.
function makeWorktree(t, remoteUrl) {
  const root = tempDir("sk-scope-worktree");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  const worktree = path.join(root, "linked");
  const git = (...args) => execFileSync("git", args, {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe",
  }).toString().trim();
  git("init", "-q", main);
  git("-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture");
  git("-C", main, "remote", "add", "origin", remoteUrl);
  git("-C", main, "worktree", "add", "--detach", worktree);
  const gitDir = git("-C", worktree, "rev-parse", "--absolute-git-dir");
  return { repo: main, worktree, gitDir };
}

for (const absolute of [false, true]) {
  test(`a linked worktree resolves the ${absolute ? "absolute" : "relative"} commondir remote`, t => {
    signInWithOrgs(["acme"]);
    const { repo: main, worktree, gitDir } = makeWorktree(t, "https://github.com/acme/widgets.git");
    const commonFile = path.join(gitDir, "commondir");
    assert.equal(path.isAbsolute(fs.readFileSync(commonFile, "utf8").trim()), false);
    if (absolute) fs.writeFileSync(commonFile, path.join(main, ".git") + "\n");
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\n`);
    const nested = path.join(worktree, "src");
    fs.mkdirSync(nested);
    assert.deepEqual(logger.getRepoScopeDecision(nested), { ...logger.getRepoScopeDecision(main), repoRoot: worktree });
    assert.equal(logger.getRepoScopeDecision(nested).allowed, true);
  });
}

test("a linked worktree inherits the main repository's verdict and honors the project filter", t => {
  signInWithOrgs(["acme"]);
  const blocked = makeWorktree(t, "https://github.com/other/widgets.git");
  assert.deepEqual(logger.getRepoScopeDecision(blocked.worktree), { ...logger.getRepoScopeDecision(blocked.repo), repoRoot: blocked.worktree });
  assert.equal(logger.getRepoScopeDecision(blocked.worktree).allowed, false);
  signInWithOrgs(["acme", "other"]);
  const filtered = makeWorktree(t, "https://github.com/acme/widgets.git");
  writeSettings(filtered.worktree, { repoScopeOrgs: ["other"] });
  const decision = logger.getRepoScopeDecision(filtered.worktree);
  assert.deepEqual([decision.allowed, decision.classification], [false, "github_org_mismatch"]);
});

for (const broken of ["missing-common-directory", "missing-config", "unreadable-commondir", "empty-commondir"]) {
  test(`a linked worktree fails closed with ${broken}`, t => {
    signInWithOrgs(["acme"]);
    const { repo: main, worktree, gitDir } = makeWorktree(t, "https://github.com/acme/widgets.git");
    const commonFile = path.join(gitDir, "commondir");
    if (broken === "missing-common-directory") fs.writeFileSync(commonFile, "missing\n");
    if (broken === "empty-commondir") fs.writeFileSync(commonFile, "\n");
    if (broken === "missing-config") fs.unlinkSync(path.join(main, ".git", "config"));
    if (broken === "unreadable-commondir") { fs.unlinkSync(commonFile); fs.mkdirSync(commonFile); }
    // A private config must never stand in for invalid shared metadata.
    fs.writeFileSync(path.join(gitDir, "config"), '[remote "origin"]\nurl = https://github.com/acme/widgets.git\n');
    const decision = logger.getRepoScopeDecision(worktree);
    assert.deepEqual([decision.allowed, decision.classification], [false, "no_github_remote"]);
  });
}
