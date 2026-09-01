---
description: Register, use, evolve, or inspect artifacts in the token-darwin evolution pool
argument-hint: [register <name> <type> | use <id> <success> | evolve | list | metrics]
---

Parse the arguments: `$ARGUMENTS`. Dispatch to the CLI at
`${CLAUDE_PLUGIN_ROOT}/cli/glimax.py`:

- `register <name> <type>` → `darwin register <name> <type>` (read artifact
  content from stdin or the current selection; pass via `--content`).
- `use <id> <true|false>` → `darwin use <id> <success>`.
- `evolve` → `darwin evolve` (report pruned artifacts).
- `list` → `darwin list`.
- `metrics` → `darwin metrics`.

Default state file: `.darwin_state.json` in the current directory. After any
mutating command, summarize the resulting generation, active count, and success
rate.