---
description: Build a project genome or synthesize task context from it
argument-hint: [build | context <task>] [project_path]
---

Parse the arguments: `$ARGUMENTS`.

- If the first token is `build` (or empty), run:
  `python "${CLAUDE_PLUGIN_ROOT}/cli/glimax.py" genome build <project_path or .>`
  and show the resulting genome.
- If the first token is `context`, treat the rest of the first quoted argument
  as the task description and run:
  `python "${CLAUDE_PLUGIN_ROOT}/cli/glimax.py" genome context "<task>" <project_path or .>`
  Show the synthesized context and base further work on it.

Report token counts from the CLI output.