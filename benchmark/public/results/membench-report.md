# membench × Chronos-Palace v4

_2026-10-27T13:09:02.099Z_

```
membench — Chronos-Palace v4.1 · retrieval level · 500 samples · 500 questions (500 scoreable: 500 structural + 0 presence-only; 0 without gold)
ingested: 6789 turns → 7299 edges / 7299 L3 rows (17418.64ms total)

note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.

| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|-----:|----:|-------:|-------:|
| graph   | 29.43% | 76.8% | 91.23% | 96.47% | 0.66 | 3.43 | 5.34 |
| verbatim | 24.3% | 66.1% | 89.23% | 99.33% | 0.61 | 0.44 | 0.77 |
| union   | 24.3% | 66.4% | 91.1% | — | 0.61 | 4.16 | 6.34 |
| product | 24.3% | 66.4% | 91.1% | — | 0.6 | 10.5 | 14.14 |

pareto check (v4.1): union R@10 91.1% ≥ max(graph 91.23%, verbatim 89.23%) → FAIL; product R@10 91.1% → FAIL

per type (R@10 / MRR):
| type | n | graph | verbatim | union | product |
|------|--:|------:|---------:|------:|--------:|
| events | 100 | 99% / 0.36 | 96% / 0.26 | 98% / 0.26 | 98% / 0.25 |
| hybrid | 100 | 71.67% / 0.53 | 76.17% / 0.63 | 79% / 0.63 | 79% / 0.63 |
| items | 100 | 97.5% / 0.98 | 98.5% / 0.93 | 99.5% / 0.93 | 99.5% / 0.93 |
| places | 100 | 100% / 0.98 | 99.5% / 0.96 | 100% / 0.96 | 100% / 0.96 |
| roles | 100 | 88% / 0.45 | 76% / 0.26 | 79% / 0.26 | 79% / 0.25 |

product packet: mean 184.5 tok · p95 271 tok · "nothing remembered": 0/500
```
