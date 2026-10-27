# LoCoMo × Chronos-Palace v4

_2026-10-27T12:01:17.282Z_

```
LoCoMo — Chronos-Palace v4.1 · retrieval level · 10 conversations · 1986 questions (1982 with gold evidence)
ingested: 5882 turns → 5882 edges / 5882 L3 rows (9504.14ms total)

| channel | R@1 | R@5 | R@10 | R@50 ¹ | ANY ² | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|------:|------:|----:|-------:|-------:|
| graph   | 34.09% | 53.99% | 60.92% | 71.08% | 77.4% | 0.47 | 8.12 | 11.88 |
| verbatim | 34.48% | 59.06% | 73.64% | 87.42% | 92.03% | 0.5 | 14.24 | 22.22 |
| union   | 34.48% | 59.06% | 73.62% | — | 81.69% | 0.49 | 22.47 | 33.4 |
| product | 34.48% | 59.06% | 73.62% | — | 79.26% | 0.49 | 22.67 | 33.16 |

¹ graph/verbatim = top-50 rankers. ² ANY = gold present anywhere in what the channel returned. union = v4.1 agreement-calibrated Pareto merge of graph+verbatim (top-16; R@10 over its head); product = the v4.1 evidence-slice packet.

per category (R@10):
| category | n | graph | verbatim | union | product |
|----------|--:|------:|---------:|------:|--------:|
| 1 multi-hop | 282 | 29.32% | 38.67% | 38.46% | 38.46% |
| 2 temporal | 321 | 66.77% | 77% | 77% | 77% |
| 3 open-domain | 92 | 25.55% | 34.25% | 33.98% | 33.98% |
| 4 single-hop | 841 | 69.48% | 83.1% | 83.1% | 83.1% |
| 5 adversarial | 446 | 67.83% | 83.63% | 83.74% | 83.74% |

pareto check (v4.1): union R@10 73.62% ≥ max(graph 60.92%, verbatim 73.64%) → PASS; product R@10 73.62% → PASS

product packet: mean 275.8 tok · p95 287 tok · carries ≥1 gold turn: 79.26% · "nothing remembered": 0/1986
```
