---
name: sk-telemetry
description: Enable, disable, or check SkillMeter telemetry status for the current project
argument-hint: <enable|disable|status>
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Run the telemetry management script with the user's argument:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.js $ARGUMENTS
```

Report the result to the user.
