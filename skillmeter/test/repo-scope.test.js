"use strict";

// T1 parsing-hardening coverage for lib/repo-scope.js: robust remote → org
// extraction across every common URL form, plus git `insteadOf` rewrites and
// SSH host-alias resolution.
// Run: node --test skillmeter/test/repo-scope.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTempDir, writeFile } = require("../testing/helpers");
const scope = require("../scripts/lib/repo-scope");
const {
  extractGitHubOrgFromRemote,
  parseInsteadOf,
  applyInsteadOf,
  parseSshConfig,
  getInsteadOfRules,
  getSshHostAliases,
  getRemoteUrlsForRepo,
  _resetConfigCache,
} = scope;

// No file-backed rewrites — keeps URL-form tests pure and deterministic.
const NO_REWRITES = { insteadOf: [], aliases: {} };
const ex = (url, opts = NO_REWRITES) => extractGitHubOrgFromRemote(url, opts);

// --- extractGitHubOrgFromRemote: URL forms ---------------------------------

test("scp-like SSH remote", () => {
  assert.equal(ex("git@github.com:Owner/Repo.git"), "owner");
});

test("HTTPS remote with and without .git", () => {
  assert.equal(ex("https://github.com/Owner/Repo.git"), "owner");
  assert.equal(ex("https://github.com/Owner/Repo"), "owner");
});

test("ssh:// and git:// scheme remotes", () => {
  assert.equal(ex("ssh://git@github.com/Owner/Repo.git"), "owner");
  assert.equal(ex("git://github.com/Owner/Repo"), "owner");
});

test("HTTPS remote with embedded credentials", () => {
  assert.equal(ex("https://user:token@github.com/Owner/Repo"), "owner");
  assert.equal(ex("https://x-access-token:ghs_abc@github.com/Owner/Repo.git"), "owner");
});

test("trailing slash and mixed-case host normalize", () => {
  assert.equal(ex("https://github.com/Owner/Repo/"), "owner");
  assert.equal(ex("HTTPS://GitHub.com/Owner/Repo"), "owner");
});

test("non-GitHub hosts are rejected", () => {
  assert.equal(ex("git@gitlab.com:Owner/Repo.git"), "");
  assert.equal(ex("https://bitbucket.org/Owner/Repo"), "");
});

test("empty / malformed / non-string input returns ''", () => {
  assert.equal(ex(""), "");
  assert.equal(ex("   "), "");
  assert.equal(ex(null), "");
  assert.equal(ex(42), "");
  assert.equal(ex("https://github.com/"), "");
  assert.equal(ex("not a url at all"), "");
});

// --- insteadOf rewrites -----------------------------------------------------

test("insteadOf rewrite maps an aliased prefix to github.com", () => {
  const insteadOf = [{ prefix: "gh:", base: "git@github.com:" }];
  assert.equal(ex("gh:Owner/Repo.git", { insteadOf, aliases: {} }), "owner");
});

test("insteadOf uses the longest matching prefix (git's tie-break)", () => {
  const insteadOf = [
    { prefix: "g:", base: "git@gitlab.com:" },
    { prefix: "gh:", base: "git@github.com:" },
  ];
  // "gh:" is the longer prefix, so it wins over "g:".
  assert.equal(ex("gh:Owner/Repo", { insteadOf, aliases: {} }), "owner");
});

test("applyInsteadOf leaves unmatched URLs untouched", () => {
  const rules = [{ prefix: "gh:", base: "git@github.com:" }];
  assert.equal(applyInsteadOf("https://github.com/o/r", rules), "https://github.com/o/r");
  assert.equal(applyInsteadOf("gh:o/r", rules), "git@github.com:o/r");
});

test("parseInsteadOf reads [url] sections", () => {
  const text = [
    '[url "git@github.com:"]',
    "    insteadOf = gh:",
    '[url "https://github.com/"]',
    "    insteadOf = ghh:",
    "[user]",
    "    name = someone",
  ].join("\n");
  assert.deepEqual(parseInsteadOf(text), [
    { prefix: "gh:", base: "git@github.com:" },
    { prefix: "ghh:", base: "https://github.com/" },
  ]);
});

// --- SSH host aliases -------------------------------------------------------

test("SSH host alias resolves to github.com", () => {
  const aliases = { "github-work": "github.com" };
  assert.equal(ex("git@github-work:Owner/Repo.git", { insteadOf: [], aliases }), "owner");
});

test("SSH alias to a non-GitHub host is rejected", () => {
  const aliases = { gl: "gitlab.com" };
  assert.equal(ex("git@gl:Owner/Repo", { insteadOf: [], aliases }), "");
});

test("parseSshConfig maps literal aliases and skips wildcards", () => {
  const text = [
    "Host github-work gh2",
    "  HostName github.com",
    "Host *",
    "  HostName example.com",
    "Match host foo",
    "  HostName nope.com",
  ].join("\n");
  const aliases = parseSshConfig(text);
  assert.equal(aliases["github-work"], "github.com");
  assert.equal(aliases["gh2"], "github.com");
  assert.equal(aliases["*"], undefined);
});

// --- file-backed loaders (integration) -------------------------------------

test("getInsteadOfRules / getSshHostAliases read from HOME", (t) => {
  const home = makeTempDir("skm-scope-");
  const prevHome = process.env.HOME;
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    _resetConfigCache();
  });

  process.env.HOME = home;
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.XDG_CONFIG_HOME;
  writeFile(
    path.join(home, ".gitconfig"),
    '[url "git@github.com:"]\n    insteadOf = gh:\n'
  );
  writeFile(
    path.join(home, ".ssh", "config"),
    "Host github-work\n  HostName github.com\n"
  );
  _resetConfigCache();

  assert.deepEqual(getInsteadOfRules(), [{ prefix: "gh:", base: "git@github.com:" }]);
  assert.equal(getSshHostAliases()["github-work"], "github.com");

  // End-to-end through the default (file-backed) code path.
  assert.equal(extractGitHubOrgFromRemote("gh:Owner/Repo.git"), "owner");
  assert.equal(extractGitHubOrgFromRemote("git@github-work:Owner/Repo"), "owner");
});

// --- getRemoteUrlsForRepo ---------------------------------------------------

test("getRemoteUrlsForRepo reads every remote from .git/config", () => {
  const root = makeTempDir("skm-scope-");
  fs.mkdirSync(path.join(root, ".git"));
  writeFile(
    path.join(root, ".git", "config"),
    [
      '[remote "origin"]',
      "\turl = git@github.com:me/fork.git",
      '[remote "upstream"]',
      "\turl = https://github.com/Org/repo.git",
      "[core]",
      "\tbare = false",
    ].join("\n")
  );
  assert.deepEqual(getRemoteUrlsForRepo(root), [
    "git@github.com:me/fork.git",
    "https://github.com/Org/repo.git",
  ]);
});
