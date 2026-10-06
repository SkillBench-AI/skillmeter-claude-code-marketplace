#!/usr/bin/env node
/**
 * Announce that this client stopped collecting, or can collect again (ADR
 * 003, decision 2), when the session, its status record or the telemetry
 * policy changes; SessionStart watches all three. One systemMessage plus an
 * OSC 777 desktop notification, and nothing when the state's group did not
 * change, except to correct a lost license that was a revocation.
 */

const { readStdinJson } = require("./lib/io");
const { collectionNotice } = require("./lib/collection-notice");

// Claude Code writes terminalSequence verbatim, so real ESC/BEL bytes.
function osc777(title, body) {
  return `\u001b]777;notify;${title};${body}\u0007`;
}

async function main() {
  // FileChanged gives each session's own id, which keys the dedupe.
  const input = await readStdinJson({ empty: {} }).catch(() => null);
  const line = collectionNotice(input?.session_id);
  if (!line) return;
  process.stdout.write(JSON.stringify({
    systemMessage: line,
    terminalSequence: osc777("SkillMeter", line.replace(/^[✗✓] SkillMeter · /, "")),
  }) + "\n");
}

main().catch(() => {});
