---
description: Activate SkillMeter by signing in with GitHub
disable-model-invocation: true
---

SkillMeter activation is handled locally by the plugin before this skill expands into a Claude prompt.

Use the SkillMeter activation status from the slash-command expansion hook.
Reply with that status only.
If interactive GitHub login is required, tell the user to run the exact command path provided by the hook.
