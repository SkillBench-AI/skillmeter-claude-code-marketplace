---
name: sk-activate
description: Activate SkillMeter by signing in with GitHub
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Run the activation script and relay its output to the user:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/activate.js
```

Report the result verbatim.
