---
name: review-export
description: Review a sanitized SkillBench export before upload.
---

Confirm the input is a sanitized export, usually
`dist/skillbench_export_sanitized_*.json`. Summarize session counts, agent families
and workspace coverage, noting missing activity or unexpected inclusions.

For a deeper review, inspect the export's patterns first. Request raw session
files only when the user explicitly wants deeper debugging and the sanitized
export is insufficient.
