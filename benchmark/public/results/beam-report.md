# beam × Chronos-Palace v4

_2026-10-27T13:05:07.939Z_

```
beam — Chronos-Palace v4.1 · retrieval level · 20 samples · 400 questions (235 scoreable: 235 structural + 0 presence-only; 165 without gold)
ingested: 5732 turns → 32234 edges / 32234 L3 rows (507196.95ms total)

note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.

| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|-----:|----:|-------:|-------:|
| graph   | 5.2% | 15.14% | 20.04% | 30.65% | 0.17 | 16.88 | 27.27 |
| verbatim | 18.7% | 36.74% | 44.2% | 61.32% | 0.4 | 32.73 | 48.89 |
| union   | 18.7% | 36.74% | 44.2% | — | 0.39 | 50.03 | 76.49 |
| product | 18.7% | 36.74% | 44.2% | — | 0.39 | 52.66 | 75.8 |

pareto check (v4.1): union R@10 44.2% ≥ max(graph 20.04%, verbatim 44.2%) → PASS; product R@10 44.2% → PASS

per type (R@10 / MRR):
| type | n | graph | verbatim | union | product |
|------|--:|------:|---------:|------:|--------:|
| event_ordering | 40 | 4.25% / 0.08 | 21.02% / 0.29 | 21.02% / 0.28 | 21.02% / 0.28 |
| information_extraction | 40 | 37.92% / 0.21 | 58.33% / 0.45 | 58.33% / 0.45 | 58.33% / 0.44 |
| instruction_following | 40 | 13.75% / 0.07 | 51.88% / 0.44 | 51.88% / 0.44 | 51.88% / 0.44 |
| multi_session_reasoning | 40 | 26.03% / 0.29 | 51.9% / 0.57 | 51.9% / 0.56 | 51.9% / 0.56 |
| preference_following | 39 | 28.21% / 0.19 | 68.8% / 0.45 | 68.8% / 0.45 | 68.8% / 0.45 |
| summarization | 36 | 9.21% / 0.18 | 10.51% / 0.16 | 10.51% / 0.14 | 10.51% / 0.14 |

product packet: mean 274.6 tok · p95 287 tok · "nothing remembered": 0/400
```
