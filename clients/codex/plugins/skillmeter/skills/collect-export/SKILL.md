---
name: collect-export
description: Collect a sanitized SkillBench export from local Codex sessions.
---

Prepare an export with the installed `skillbench` CLI or an existing local
`session-collector` checkout. If neither is available, follow that project's
installation instructions.

Run `skillbench collect` or the checkout's equivalent command. Add
`--allowed-orgs ...` when the user requests organization scope. Make broader
inclusion explicit before using it.

Report the sanitized output path under `dist/`. Use that export for review and
upload; never recommend uploading raw files from `~/.codex/sessions` directly.
Sanitization does not guarantee that every sensitive detail has been removed.
