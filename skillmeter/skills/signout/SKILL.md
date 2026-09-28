---
description: Sign this plugin out of SkillMeter and stop its telemetry; other SkillMeter clients stay signed in
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Run the SkillMeter sign-out script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/signout.js"
```

Report the result to the user.
