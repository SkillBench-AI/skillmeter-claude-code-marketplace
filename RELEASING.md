# Releasing SkillMeter

This repository releases two clients, SkillMeter for Claude Code and SkillMeter
for Codex. The stable marketplaces serve `main`, which moves only at releases.
Pull requests target `next`; the internal channel follows `next` (see below).
Version tags publish GitHub Releases.

## Branches

- `next`: the development branch and the base of feature pull requests.
- `main`: what customers install. A release bumps the version of each client
  that changes on `next`, then opens a pull request from `next` to `main`.
  Merge it with a merge commit, not a squash, so `main` and `next` keep one
  history. A merge into `main` ships both clients, so cut one only when `next`
  is releasable for both.
- A hotfix goes to `main` in its own release pull request and is merged back
  into `next` right after, so the two never diverge.

## Version and tag

| | Claude Code | Codex |
|---|---|---|
| Version | [`clients/claude-code/skillmeter/.claude-plugin/plugin.json`](clients/claude-code/skillmeter/.claude-plugin/plugin.json) | [`clients/codex/plugins/skillmeter/.codex-plugin/plugin.json`](clients/codex/plugins/skillmeter/.codex-plugin/plugin.json) |
| Tag | `vX.Y.Z` | `codex-vX.Y.Z` |
| Workflow | [`release-claude-code.yml`](.github/workflows/release-claude-code.yml) | [`release-codex.yml`](.github/workflows/release-codex.yml) |
| Release | `SkillMeter X.Y.Z`, Latest | `SkillMeter for Codex X.Y.Z`, not Latest, with a source archive |

Use `MAJOR.MINOR.PATCH` without prerelease or build suffixes: patch for fixes,
minor for features. Before 1.0, breaking changes may use a minor bump. The
tag prefixes keep the clients apart, since their version numbers overlap. Codex
tags up to `v0.13.0` were cut in the former skillmeter-codex-marketplace
repository.

After merging the release PR, for each client whose version changed:

1. Update `main` and run the checks:

   ```sh
   git checkout main
   git pull --ff-only
   node scripts/sync-shared.mjs --check
   (cd shared && node --test)
   (cd clients/claude-code && node --test)
   (cd clients/codex && npm run check)
   ```

2. Create and push an annotated tag matching the manifest:

   ```sh
   VERSION="$(node -p "require('./clients/claude-code/skillmeter/.claude-plugin/plugin.json').version")"
   git tag -a "v${VERSION}" -m "SkillMeter ${VERSION}"
   git push origin "v${VERSION}"

   VERSION="$(node -p "require('./clients/codex/plugins/skillmeter/.codex-plugin/plugin.json').version")"
   git tag -a "codex-v${VERSION}" -m "SkillMeter for Codex ${VERSION}"
   git push origin "codex-v${VERSION}"
   ```

3. Confirm the release workflow succeeds. It checks the tag against the
   manifest, runs that client's checks and tests, and publishes the release.

## Release notes

Release notes are public. They say what changed for the user; the PRs hold the
rest. Prepare and review them before pushing the tag; the workflow publishes
with generated notes, which you then replace with the approved ones. Keep
internal coordination and rollout history in Linear.

Read the latest published release before writing one;
[SkillMeter 0.42.0](https://github.com/SkillBench-AI/skillmeter-plugins/releases/tag/v0.42.0)
is the model for length and tone. Both clients follow the same rules:

- Title: `SkillMeter X.Y.Z` for Claude Code, `SkillMeter for Codex X.Y.Z` for
  Codex. Then `### What changed`, `### After updating`, `### Known
  limitations`, and a final `Details: #PR, #PR` line.
- **What changed**: the user-visible outcome, at most three bullets, one change
  each. Each bullet is one short sentence, about 20 words or fewer, in the
  present tense. No semicolons, no second clause after a colon, no "and"
  joining two changes. No command flags, retry counts, line counts,
  algorithms, file or module names, policy or schema versions, or ADR
  references. A change users cannot notice stays in its PR.
- **After updating**: numbered steps, the only part that differs by client.
  Do not add sentences about what is not needed.
  - Claude Code: always `1. claude plugin update skillmeter@skillbench` and
    `2. Quit and reopen Claude Code` (hooks load per session). Add a sign-in
    step only when the release requires one.
  - Codex: command blocks for `codex plugin marketplace upgrade skillbench`
    and `codex plugin add skillmeter@skillbench`, then restarting Codex and
    starting a new session; distinguish Git marketplaces from local checkouts
    where needed.
- **Known limitations**: only what this release adds or changes, under the
  same sentence rule, each saying what the user will see. End with
  `Otherwise unchanged from X.Y.Z.`, or use only `Unchanged from X.Y.Z.`,
  naming the release that lists them.
- **Details**: PR numbers only. ADRs and privacy documents are reachable from
  the PRs.

## Internal channel

No release step is needed for the internal channel. The `Internal channel`
workflow rebuilds the `internal` branch after CI passes on each `next` push,
using [`.github/scripts/make-internal-channel.mjs`](.github/scripts/make-internal-channel.mjs)
`--build <run number>` for both clients in one commit. Each build's version is
`<next patch>-internal.<run number>`; `next` and `main` always keep a release
version. Never commit a plugin's `channel.json`; a test fails if it is present.

## Checks

[PR CI](.github/workflows/ci.yml) runs both clients' tests on Node 22, 24 and
26, validates the Claude Code plugin and marketplace and the Codex manifests,
and checks that `shared/lib` copies are in sync. For optional local hooks,
install [pre-commit](https://pre-commit.com/) and run `pre-commit install`.
