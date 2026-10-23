# SkillMeter for Codex

Connect Codex sessions to [SkillBench](https://skillbench.com) for
organization-level developer skill analytics. SkillMeter collects
repository-scoped workflow and conversation telemetry, sanitizes it locally,
and uploads it in the background.

## Before you start

Collected data can include prompts, assistant messages, tool inputs and outputs,
transcripts, and custom skill content. Sanitization reduces exposure; it does
not make arbitrary content anonymous. Read the [data and scope guide](plugins/skillmeter/README.md#data-and-privacy)
before enabling collection.

New capture requires explicit organization and repository choices in Codex as
well as an allowed GitHub owner. Installation and sign-in alone do not enable
capture, and choices made in SkillMeter for Claude Code do not apply here. See
[collection scope](plugins/skillmeter/README.md#collection-scope) for controls.

## Install

Requires Codex with plugin support, Node.js 22 or later, and a SkillMeter license.

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref main
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session. Review and enable the plugin's hooks if
Codex prompts you. Then run:

> $skillmeter:signin

After sign-in it asks which of your organization's repositories send
telemetry. Change them later with `$skillmeter:telemetry`; see the
[project controls](plugins/skillmeter/README.md#sign-in-and-controls).

Sign-in opens the SkillBench sign-in service, where you pick your workspace.
This plugin keeps its own session, separate from SkillMeter for Claude Code. See
[sign-in and collection controls](plugins/skillmeter/README.md#sign-in-and-controls).

## Update

For the Git marketplace installed above:

```sh
codex plugin marketplace upgrade skillbench
codex plugin add skillmeter@skillbench
```

Restart Codex and start a new session. Run `codex plugin list --json` to check
the installed SkillMeter version.

**Installed from a local checkout?** Update that checkout first, then run
`codex plugin add skillmeter@skillbench`. `marketplace upgrade` only refreshes
Git marketplaces; it does not pull a locally registered repository.

## Internal channel

SkillBench developers can dogfood the code under development against the dev
environment. Development happens on `next`; `main` moves only at releases. The
`internal` branch is rebuilt from every `next` commit that passes CI. It is
versioned as a prerelease of the next patch (for example `0.12.4-internal.37`,
which sorts after `0.12.3` and before `0.12.4`), defaults to the dev sign-in
service, license server and `~/.skillbench-dev` state, and is published as the
`skillbench-internal` marketplace so its installation and queues stay apart from
the stable one.

```sh
codex plugin marketplace add SkillBench-AI/skillmeter-codex-marketplace --ref internal
codex plugin add skillmeter@skillbench-internal
```

Sign in with a dev workspace account. Remove the stable plugin first
(`codex plugin remove skillmeter@skillbench`), or both would record the same
sessions. Status cards show `internal (dev)` in the title. To update, run
`codex plugin marketplace upgrade skillbench-internal` and add the plugin again.

## Using SkillMeter

- [Sign in, pause collection, or sign out](plugins/skillmeter/README.md#sign-in-and-controls)
- [Understand collection scope and privacy](plugins/skillmeter/README.md#data-and-privacy)
- [Review releases and known limitations](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/releases)
- [Report an issue](https://github.com/SkillBench-AI/skillmeter-codex-marketplace/issues)

## Development

```sh
npm run check
```

See the [transport and recovery guide](plugins/skillmeter/integration/README.md)
for local integration checks and [RELEASING.md](RELEASING.md) for versioning and
release steps. Do not commit credentials or generated telemetry.
