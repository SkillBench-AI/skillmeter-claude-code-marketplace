#!/usr/bin/env node
/**
 * CLI wrapper around lib/backfill-scan.js. Prints a summary of historical
 * Claude Code sessions partitioned by org-scope eligibility. Used for local
 * verification today; will become the input feed for the detached backfill
 * uploader.
 *
 * Usage:
 *   node backfill_scan.js            # summary only
 *   node backfill_scan.js --verbose  # also list included session files
 *   node backfill_scan.js --json     # machine-readable full output
 */

const { scanHistoricalSessions } = require("./lib/backfill-scan");
const { getAllowedGitHubOrgs } = require("./credstore");

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose") || args.has("-v");
const asJson = args.has("--json");

const result = scanHistoricalSessions();

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

const orgs = getAllowedGitHubOrgs();
const orgLabel = orgs.length ? orgs.join(", ") : "(none — not signed in)";

const { projectsScanned, sessionsIncluded, sessionsSkipped, skippedByReason } = result.summary;

process.stdout.write(
  `SkillMeter historical session scan\n` +
  `  allowed orgs:      ${orgLabel}\n` +
  `  projects scanned:  ${projectsScanned}\n` +
  `  sessions included: ${sessionsIncluded}\n` +
  `  sessions skipped:  ${sessionsSkipped}\n`
);

const reasonEntries = Object.entries(skippedByReason).sort((a, b) => b[1] - a[1]);
if (reasonEntries.length > 0) {
  process.stdout.write(`  skipped by reason:\n`);
  for (const [reason, count] of reasonEntries) {
    process.stdout.write(`    ${reason}: ${count}\n`);
  }
}

if (verbose && result.included.length > 0) {
  process.stdout.write(`\nIncluded sessions:\n`);
  for (const entry of result.included) {
    process.stdout.write(`  [${entry.remoteOrg}] ${entry.cwd} -> ${entry.sessionId}\n`);
  }
}
