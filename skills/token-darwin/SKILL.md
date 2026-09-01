---
name: token-darwin
description: Manage self-generated artifacts (skills, tools, patterns) with ROI-based natural selection. Use when registering, using, evolving, or inspecting artifacts so low-value artifacts are pruned and context stays lean.
---

# Token-Darwin Evolution Layer

Runs ROI-based natural selection over self-generated artifacts. Artifacts that
fail to prove value are decayed and pruned; survivors earn context budget.

Engine: `${CLAUDE_PLUGIN_ROOT}/src/token_darwin/token_darwin.py`
Config: `${CLAUDE_PLUGIN_ROOT}/src/token_darwin/config.yaml`
State: JSON file (default `.darwin_state.json` next to the config).

## Usage

Drive the engine through the CLI (see repo root `cli/glimax.py`):

```bash
python cli/glimax.py darwin register <name> <type> [--content TEXT | --file PATH] [--state PATH]
python cli/glimax.py darwin use <artifact_id> <true|false> [--state PATH]
python cli/glimax.py darwin evolve [--state PATH]
python cli/glimax.py darwin list [--type skill|tool|pattern|context_snippet] [--state PATH]
python cli/glimax.py darwin context [--max-tokens N] [--state PATH]
python cli/glimax.py darwin metrics [--state PATH]
```

`<type>` is one of: `skill`, `tool`, `pattern`, `context_snippet`.

## Rules

1. Register an artifact whenever you create a reusable skill, tool, pattern, or
   context snippet. Use a descriptive `snake_case` name.
2. Record every usage with `use <id> <success>` — honest outcomes only.
3. Run `evolve` after each batch of work; it applies decay and prunes artifacts
   below `roi_threshold` (0.3 by default).
4. Before starting a task, pull `context` and prefer high-ROI artifacts.
5. Never resurrect a pruned artifact under the same name without re-evaluation.

## ROI model

`roi = 0.8 * success_rate + 0.2 * min(use_count / 10, 1)` — success rate
dominates. Each `evolve` cycle multiplies ROI by `decay_rate` (0.95), so unused
artifacts decay toward the prune threshold. The N most recently used artifacts
(`protect_recent`) are shielded from pruning.