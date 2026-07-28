#!/usr/bin/env node

const credstore = require("./credstore");
const { readStdinJson } = require("./lib/io");
const {
  initializeBackfillLifecycle,
  publicBackfillState,
} = require("./lib/backfill-state");

function addContext(state) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptExpansion",
      additionalContext:
        `SkillMeter manual backfill state JSON:\n${JSON.stringify(state)}`,
    },
  }) + "\n");
}

async function main() {
  const input = await readStdinJson({ tty: {}, empty: {} });
  if (
    input.command_name !== "skillmeter:backfill" &&
    !(
      input.command_name === "backfill" &&
      input.command_source === "plugin"
    )
  ) {
    return;
  }

  initializeBackfillLifecycle();
  const token = credstore.getLicenseToken();
  if (!token || credstore.isLicenseTokenExpired(token)) {
    addContext({ status: "signed_out" });
    return;
  }

  addContext({
    status: "signed_in",
    orgs: credstore.getAllowedGitHubOrgs(),
    backfill: {
      ...publicBackfillState(),
      activeSessionId:
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          input.session_id || ""
        )
          ? input.session_id
          : "",
    },
  });
}

main().catch((err) => {
  addContext({
    status: "error",
    error: String(err?.message || err).slice(0, 240),
  });
});
