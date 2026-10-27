# memorybench × Chronos-Palace v4

_2026-10-27T13:43:34.017Z_

```
memorybench — Chronos-Palace v4.1 · retrieval level · 213 samples · 213 questions (213 scoreable: 213 structural + 0 presence-only; 0 without gold)
ingested: 1183 turns → 18405 edges / 18405 L3 rows (56140.86ms total)

note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.

| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|-----:|----:|-------:|-------:|
| graph   | 8.45% | 85.68% | 91.31% | 91.31% | 0.38 | 7.74 | 12.5 |
| verbatim | 25.59% | 95.54% | 100% | 100% | 0.54 | 14.5 | 23.92 |
| union   | 25.59% | 95.54% | 100% | — | 0.54 | 22.72 | 34.77 |
| product | 25.59% | 95.54% | 100% | — | 0.54 | 18.43 | 31.99 |

pareto check (v4.1): union R@10 100% ≥ max(graph 91.31%, verbatim 100%) → PASS; product R@10 100% → PASS

per type (R@10 / MRR):
| type | n | graph | verbatim | union | product |
|------|--:|------:|---------:|------:|--------:|
| LexEval-QA | 25 | 26% / 0.12 | 100% / 0.62 | 100% / 0.62 | 100% / 0.62 |
| LimitGen-Syn | 188 | 100% / 0.42 | 100% / 0.53 | 100% / 0.53 | 100% / 0.53 |

product packet: mean 155.3 tok · p95 197 tok · "nothing remembered": 0/213
```
