# longmemeval × Chronos-Palace v4

_2026-10-27T12:55:48.290Z_

```
longmemeval — Chronos-Palace v4.1 · retrieval level · 500 samples · 500 questions (470 scoreable: 470 structural + 0 presence-only; 30 without gold)
ingested: 246930 turns → 718424 edges / 718424 L3 rows (3178869.28ms total)

note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.

| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|-----:|----:|-------:|-------:|
| graph   | 42.85% | 66.96% | 74.29% | 85.83% | 0.73 | 35.4 | 45.47 |
| verbatim | 52.93% | 83.02% | 90.45% | 97.89% | 0.88 | 16.54 | 23.98 |
| union   | 53.14% | 83.02% | 90.64% | — | 0.88 | 51.69 | 67.04 |
| product | 53.14% | 83.02% | 90.64% | — | 0.88 | 45.02 | 58.93 |

pareto check (v4.1): union R@10 90.64% ≥ max(graph 74.29%, verbatim 90.45%) → PASS; product R@10 90.64% → PASS

per type (R@10 / MRR):
| type | n | graph | verbatim | union | product |
|------|--:|------:|---------:|------:|--------:|
| knowledge-update | 72 | 69.44% / 0.74 | 99.31% / 0.99 | 98.61% / 0.99 | 98.61% / 0.99 |
| multi-session | 121 | 68% / 0.71 | 87.89% / 0.9 | 87.41% / 0.9 | 87.41% / 0.9 |
| single-session-assistant | 56 | 94.64% / 0.87 | 98.21% / 0.93 | 100% / 0.93 | 100% / 0.93 |
| single-session-preference | 30 | 66.67% / 0.44 | 73.33% / 0.48 | 73.33% / 0.49 | 73.33% / 0.48 |
| single-session-user | 64 | 92.19% / 0.82 | 100% / 0.94 | 100% / 0.94 | 100% / 0.94 |
| temporal-reasoning | 127 | 66.82% / 0.72 | 83.66% / 0.86 | 84.45% / 0.86 | 84.45% / 0.86 |

product packet: mean 274.9 tok · p95 286 tok · "nothing remembered": 0/500
```
