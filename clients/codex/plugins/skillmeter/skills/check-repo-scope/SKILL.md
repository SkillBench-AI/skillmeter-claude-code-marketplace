---
name: check-repo-scope
description: Check whether the current repo belongs to a GitHub organization the SkillMeter license covers.
---

`<plugin-root>` in the commands below is this plugin's installed root: the
absolute path of the directory two levels above this `SKILL.md`. Substitute it
yourself; `$PLUGIN_ROOT` is not set in the shell that runs skill commands.

Inspect the nearest Git repository, resolve its GitHub remote owner and compare
it with the GitHub organizations the signed-in workspace has connected (the
license's `orgs`). Report whether it matches, is excluded, has
no Git repository, or has no recognizable GitHub remote. Non-GitHub remotes are
outside GitHub-owner filtering.

An allowed owner only makes the repository eligible. Capture also requires
organization and repository ON in Codex's consent record and no global pause.
Check with `node "<plugin-root>/scripts/telemetry.js" status`; do not equate
an in-scope result with active capture or successful delivery.

Scope can be narrowed through:

- `SKILLMETER_REPO_SCOPE_ORGS`: comma-separated environment filter.
- `skillmeter.repoScopeOrgs` in `.codex/settings.local.json`: project filter.

Filters intersect with the license's organizations; they cannot add access. An
organization missing from the license is connected in the SkillBench workspace,
not here. If the
user requests a batch export, use the matching
`skillbench collect --allowed-orgs ...` command.
