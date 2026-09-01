---
name: project-genome
description: Compress a codebase into a ~2k-token genome and synthesize ~1.2k-token task-relevant context. Use before exploring or working in an unfamiliar project to cut context usage by 70%+.
---

# Project Genome Architecture

Builds a compressed "genome" of a project — architecture DNA, dependency graph,
pattern library, semantic index, evolution memory — under 2000 tokens, then
synthesizes a task-relevant context slice (~1200 tokens) on demand.

Engine: `${CLAUDE_PLUGIN_ROOT}/src/project_genome/project_genome.py`
Config: `${CLAUDE_PLUGIN_ROOT}/src/project_genome/config.yaml`

## Usage

```bash
python cli/glimax.py genome build [PROJECT_PATH]
python cli/glimax.py genome context "task description" [PROJECT_PATH]
python cli/glimax.py genome metrics [PROJECT_PATH]
```

`PROJECT_PATH` defaults to the current directory.

## Rules

1. Run `genome build` first when entering an unfamiliar project; read the
   genome instead of scanning the whole tree.
2. For each task, run `genome context "<task>"` and work from that slice; only
   open source files the slice points to.
3. Rebuild the genome after major refactors (it reads live source, so a fresh
   build is always current).
4. Targets: genome ≤ 2000 tokens, synthesized context ≤ 1200 tokens, ≥ 70%
   reduction vs a raw ~30k-token context dump.