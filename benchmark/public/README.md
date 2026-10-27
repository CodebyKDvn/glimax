# Chronos-Palace v4.0 — public memory benchmarks (retrieval level)

This suite measures what the Chronos memory subsystem **surfaces**, not what an LLM
answers. For every question it asks: *is the evidence a downstream model would need
inside the retrieved context?* No LLM is in the loop — the numbers are reproducible
without API keys, and they isolate retrieval quality from generation quality.

Results: see **[results/SUMMARY.md](results/SUMMARY.md)** (all benchmarks) and
`results/<bench>-report.md` for per-question-type detail.

## How a run works

```
prep/<bench>.py        dataset → work/<bench>/instances/<id>.json   (normalized)
run.ts --bench <name>  parent: one isolated brain (sqlite) per sample
                         worker: ingest turns → ask questions → write s-*.json part
                       report: aggregate parts → results/<bench>-report.md + .json
tools/summary.py       merge every bench into results/SUMMARY.md
```

- `lib.ts` — harness core: `ingest(scope, session, name, turns)`, `ask(question, …)`, stats helpers.
- `adapters/prepared.ts` — generic engine for any prepared bench. Gold regimes:
  - **structural**: `gold_turns` / `gold_sessions` → scored as fraction of required
    evidence found in top-k (R@1…R@50, MRR);
  - **presence**: `gold_text` → weak proxy: does the accepted answer string appear in
    the retrieved context at all (P@1/P@10);
  - `meta.abstention` questions are counted, not scored; `meta.self_turn` is dropped
    from retrieved lists (for probes whose own text is in the corpus).
- `adapters/locomo.ts` — bespoke adapter (LoCoMo dialog-level gold); kept as-is.
- Corpus time is anchored so the newest session is ~1 day old, so recency decay in
  the retriever behaves exactly as in real use.

### Channels

| channel | what it is |
|---------|------------|
| `graph` | T-RRF over the memory edge graph (the product's associative recall) |
| `verbatim` | BM25 + trigram over L3 raw turns (lexical floor) |
| `union` | graph top-8 + verbatim top-4 merged (what an agent would see with both) |
| `product` | the actual `<recall>` packet the plugin injects into the prompt |

### Optional semantic channel (v7.0)

`CHRONOS_SEMANTIC=1` turns on a dense-retrieval channel backed by
`@xenova/transformers` (`Xenova/multi-qa-MiniLM-L6-cos-v1`, 384d, quantized).
It is **off by default** and the plugin still runs with zero dependencies when
the package is absent. The harness embeds each parent turn once at ingest and
merges the ranking into the `verbatim` channel with a per-benchmark policy:

| benchmark | policy | why |
|-----------|--------|-----|
| BEAM | `primary` | questions paraphrase stored instructions; exact terms are often absent |
| MAB | `tail` | 900-char windows are topic-dense; semantic breaks ties |
| DolphinBench | `off` | the fact ledger + lexical head already reach 91.8% on the diag subset; semantic added 0 at 10× ingest cost |
| LoCoMo / LongMemEval / MemBench / MemoryBench | `off` | lexical + fact ledger already ≥ the semantic head (LoCoMo: 74% vs 30%) |

Set `CHRONOS_MODEL_CACHE` to reuse a downloaded model directory. The model is a
dev dependency of the benchmark harness, not of the plugin runtime.

### v7.1 — retrieval that is not similarity search

Similarity answers "which turn looks most like this question?". Several
benchmark question types are not that question, so `strategy.ts` adds a
model-free intent router and three non-similarity selectors:

| intent | trigger | selection |
|--------|---------|-----------|
| `ordering` | "list the order", "walk me through", "first mention" | all 10 slots on **topic openers** — user turns scored by relevance + novelty against earlier user turns + self-containedness |
| `summary` | "comprehensive summary", "recap" | five **opener + reply pairs**, one per topical block |
| `aggregate` / `preference` | "across my sessions", "what do I prefer" | six openers, four relevance slots |
| `lookup` | everything else | plain relevance |

Novelty is `1 − max cosine to earlier user turns`: a first mention is novel, a
follow-up ("hmm, what about the 300 ms case?") is not. The caller's vectors are
used when available; otherwise the plugin's own SimHash `embed()`.

The verbatim channel also gained an **entity bridge** (`db.l3SearchExpanded`):
search, harvest rare entities from the top three hits, search again, fuse by
rank. That is how the second hop of a multi-hop question ("what did Caroline
research?" → "adoption agencies" → "which agency did she contact?") becomes
reachable when it shares no wording with the question. One extra FTS pass, no
model, no tokens; it is on by default in `recall`.

## The ten requested benchmarks — coverage and protocols

| # | benchmark | status | what ran |
|--:|-----------|--------|----------|
| 1 | LoCoMo | **scored** | 10 conversations, 1,986 questions, turn-level gold |
| 2 | LongMemEval (`longmemeval_s`) | **scored** | 500 questions × ~550-turn histories, session-level gold (30 abstention excluded) |
| 3 | BEAM (100K tier) | **scored (235/400 q)** | `source_chat_ids` = message-level gold; abstention/summarization unscored |
| 4 | MemoryAgentBench (AR/TTL/CR) | **proxy** | dataset ships no evidence pointers → answer-string presence; LRU skipped (summarization) |
| 5 | DolphinBench | **scored** | 600 tests, gold = source messages of the required facts (0 dangling links) |
| 6 | MemBench (import-myself/Membench) | **scored** | 500 examples, gold = `QA.target_step_id` message ids |
| 7 | MemoryBench (THUIR) | **derived** | DERIVED continuity probe: earlier negative-feedback user turns as gold; official protocol needs an LLM judge — this is *not* the authors' metric |
| 8 | MemoryArena | **not scorable at retrieval level** | multi-session agentic tasks; needs an executor + tool environment; data downloaded (5 families) |
| 9 | VibeMemBench | **no public data** | repo stub (100-byte README) as of 2026-10-17 |
| 10 | AgentMemBench | **no public data** | no code/data release located as of 2026-10-17 |

Honest caveats, per benchmark:

- **BEAM 100K**: the tier is small (~190–370 messages per conversation), so retrieval is
  not the bottleneck there — the server-side memory bottleneck appears in BEAM's larger
  tiers. Numbers here are a floor, not the paper's setting.
- **MemoryAgentBench**: presence of the accepted answer string is necessary but not
  sufficient for answering; treat as retrievability, not accuracy. Contexts are cut
  into uniform ~900-char windows at line boundaries (header-based splitting was tried
  and rejected: each row has its own formatting and most rows collapsed to a single
  turn). Questions are sampled per instance — AR/CR 30, TTL 40 — because per-query cost
  on the 400–6700-chunk instances is 1–3 s.
- **MemoryBench**: derived gold (negative-feedback rounds) measures *continuity* —
  surfacing earlier instructions when the user returns — with the caveat that the
  probe's own turn was also ingested (dropped before scoring via `meta.self_turn`).
- **LongMemEval abstention** questions and **BEAM** abstention/summarization questions
  have no retrieval-level gold and are excluded from scored means (counted in reports).

## Reproduce

```sh
cd benchmark/public
python3 prep/longmemeval.py && python3 prep/beam.py && python3 prep/dolphinbench.py \
  && python3 prep/mab.py && python3 prep/membench.py && python3 prep/memorybench.py
bun run run.ts --bench longmemeval          # add --samples N / --limit Q / --fresh
bun run run.ts --bench locomo
python3 tools/summary.py                    # → results/SUMMARY.md
```

Preps need `polars` (parquet reads) and network only for MemoryBench (HF datasets-server
API). Runs need nothing but bun; each sample is an isolated `work/<bench>/brain-*.sqlite`.

## File map

```
lib.ts                 harness core (ingest/ask/stats)
run.ts                 parent/worker runner (per-sample isolated brains)
adapters/prepared.ts   generic engine (structural / presence gold)
adapters/locomo.ts     bespoke LoCoMo adapter
prep/*.py              dataset → normalized instances
tools/summary.py       cross-bench SUMMARY.md
tools/dashboard.ts     SVG + PNG dashboard (results/dashboard.{svg,png};
                       also copied to benchmark/chronos_v4_public_benchmarks.*)
work/<bench>/          instances, per-sample parts, per-sample brains
results/               reports (json + md), SUMMARY.md, dashboard
data/                  downloaded datasets (parquet/json/arrow)
```

Related: the head-to-head benchmark against other memory packages (token cost,
retrieval quality, real-package executions) lives one level up in
[`benchmark/report.md`](../report.md).
