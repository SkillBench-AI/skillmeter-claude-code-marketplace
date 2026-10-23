"use strict";

// The Claude Code client's entry to the shared repo-scope decision: it supplies
// the license's orgs and the Git root lookup. Without a license nothing is in
// scope.

const { getAllowedGitHubOrgs } = require("../credstore");
const { findGitRoot } = require("./io");
const repoScope = require("./repo-scope");

function getRepoScopeDecision(cwd) {
  // Validated org(s) from the license JWT (already normalized to lowercase).
  const allowedOrgs = getAllowedGitHubOrgs();
  if (allowedOrgs.length === 0) {
    return { allowed: false, scope: "unknown", classification: "not_activated" };
  }
  return repoScope.getRepoScopeDecision(cwd, allowedOrgs, findGitRoot);
}

module.exports = { getRepoScopeDecision };
