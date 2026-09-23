#!/usr/bin/env node
/**
 * Announce a finished historical import from the sentinel watched by
 * SessionStart: one systemMessage plus an OSC 777 desktop notification.
 */

const credstore = require("./credstore.js");
const { getLicenseAudiences } = require("./lib/jwt");
const { takeBackfillNotice } = require("./lib/backfill-delivery");

// Claude Code writes terminalSequence verbatim, so real ESC/BEL bytes.
function osc777(title, body) {
  return `\u001b]777;notify;${title};${body}\u0007`;
}

function main() {
  const notice = takeBackfillNotice({
    audiences: getLicenseAudiences(credstore.getLicenseToken()),
  });
  if (!notice) return;
  process.stdout.write(JSON.stringify({
    systemMessage: notice.message,
    terminalSequence: osc777("SkillMeter", notice.desktop),
  }) + "\n");
}

try {
  main();
} catch {}
