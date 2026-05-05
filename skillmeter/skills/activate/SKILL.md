---
description: Activate SkillMeter by signing in with GitHub
disable-model-invocation: true
---

SkillMeter activation is handled locally by the plugin before this skill expands into a Claude prompt.

Use the SkillMeter activation status from the slash-command expansion hook.
Reply with that status only.

If the hook says interactive GitHub login is required, your reply MUST include
the `!`-prefixed command exactly as the hook provided it, on its own line, in a
fenced code block, so the user can copy and paste it into their next prompt
without modification. Do not rephrase, shorten, or strip the leading `!`.
