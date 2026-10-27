# Chronos Palace

Temporal memory for [OpenCode](https://opencode.ai): a verbatim vault, a bi-temporal
knowledge graph, and a benchmark harness that measures retrieval against seven public
memory benchmarks.

Zero extra tokens at write time. The `chronos` tool returns a ~275-token evidence
packet (10 slices) built from the exact stored strings, not a model summary.

## Benchmark results (retrieval level)

Gold evidence found in the top-10 retrieved turns. No LLM is in the loop — these are
**not** the official end-to-end scores of the benchmarks.

| benchmark | n | metric | score |
|---|---:|--------|---:|
| MemoryBench (THUIR) | 213 | R@10 | 100% |
| MemBench | 500 | R@10 | 91.10% |
| LongMemEval | 470 | R@10 | 90.64% |
| DolphinBench | 600 | R@10 | 80.29% |
| MemoryAgentBench | 3500 | P@10 (presence) | 77.17% |
| LoCoMo | 1982 | R@10 | 73.62% |
| BEAM (100K) | 235 | R@10 | 44.20% |

Per-type tables, latency and packet sizes: [`benchmark/public/results/SUMMARY.md`](benchmark/public/results/SUMMARY.md).
Dashboard: [`benchmark/public/results/dashboard.png`](benchmark/public/results/dashboard.png).

What the weak spots are, and why BEAM summarization is a hard ceiling for retrieval:
[`benchmark/public/results/OMNI.md`](benchmark/public/results/OMNI.md).

## How it works

| module | role |
|---|---|
| `db.ts` | SQLite schema: L3 verbatim vault, L2 bi-temporal graph, episodic projects, genomes |
| `index.ts` | plugin hooks + the `chronos` tool (recall / timeline / genome) |
| `retriever.ts` | T-RRF over graph edges, recency decay, reflex fast paths |
| `extractor.ts` | entity/relation extraction at write time |
| `aaak.ts` | query analysis, calibrated merge, token estimation |
| `strategy.ts` | intent routing and non-similarity evidence selection |
| `omni.ts` | optional cognitive indexes: entity PPR, timeline, state ledger, facets, causal episodes |
| `planner.ts` | optional multi-operator slot planner (opt-in, `CHRONOS_OMNI=1`) |
| `genome.ts`, `darwin.ts`, `cortex.ts` | project genomes, ROI pruning, subconscious interceptors |

The `omni`/`planner` layer is **opt-in**: measured against the lexical/semantic head it
did not improve retrieval on any benchmark, so the default path does not use it. The
measurements and the decision are in `benchmark/public/results/OMNI.md`.

## Install

```bash
git clone https://github.com/CodebyKDvn/glimax ~/.config/opencode/plugin/chronos-memory
cd ~/.config/opencode/plugin/chronos-memory && bun install
```

OpenCode loads the plugin from `~/.config/opencode/plugin/`. The brain lives in
`~/.local/share/opencode/chronos/brain.sqlite` (override with `CHRONOS_BRAIN_PATH`).

## Run the benchmarks

Datasets are not committed (several GB). Fetch them with the prep scripts, then:

```bash
cd benchmark/public
export CHRONOS_SEMANTIC=1
bun run run.ts --bench locomo --fresh
bun run run.ts --bench longmemeval --fresh
python3 tools/summary.py
bun run tools/dashboard.ts
```

Each sample runs in its own isolated brain (`CHRONOS_BRAIN_PATH=work/<bench>/brain-<sample>.sqlite`)
so retrieval can never leak across samples.

## Layout

```
*.ts                     plugin source
benchmark/public/        public-benchmark harness (adapters, prep, tools, results)
benchmark/               internal benchmarks and dashboards
```

## License

MIT — see [LICENSE](LICENSE).
