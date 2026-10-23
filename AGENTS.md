# Repository conventions

This repository holds two clients. Follow the conventions of the client you
change: [clients/claude-code/AGENTS.md](clients/claude-code/AGENTS.md) or
[clients/codex/AGENTS.md](clients/codex/AGENTS.md).

- Run commands from the client directory; each has its own tests and checks.
- Root files serve both clients: the two marketplaces, CI and the internal
  channel build. A change to them must keep both clients' checks green.
- Keep `.agents/plugins/marketplace.json` in place; Codex would otherwise read
  the Claude Code marketplace.
