# dolphinbench × Chronos-Palace v4

_2026-10-27T13:08:21.059Z_

```
dolphinbench — Chronos-Palace v4.1 · retrieval level · 3 samples · 600 questions (600 scoreable: 600 structural + 0 presence-only; 0 without gold)
ingested: 13539 turns → 19958 edges / 19958 L3 rows (56201.93ms total)

note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.

| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |
|---------|----:|----:|-----:|-----:|----:|-------:|-------:|
| graph   | 38.35% | 69.02% | 80.21% | 82.29% | 0.58 | 46.16 | 65.41 |
| verbatim | 38.35% | 69.02% | 80.13% | 84.38% | 0.58 | 58.2 | 83.64 |
| union   | 38.35% | 69.02% | 80.29% | — | 0.58 | 106.29 | 143.91 |
| product | 38.35% | 69.02% | 80.29% | — | 0.58 | 105.26 | 143.05 |

pareto check (v4.1): union R@10 80.29% ≥ max(graph 80.21%, verbatim 80.13%) → PASS; product R@10 80.29% → PASS

per type (R@10 / MRR):
| type | n | graph | verbatim | union | product |
|------|--:|------:|---------:|------:|--------:|
| add_crm_row | 2 | 100% / 0.6 | 100% / 0.6 | 100% / 0.6 | 100% / 0.6 |
| book_flight | 1 | 100% / 1 | 100% / 1 | 100% / 1 | 100% / 1 |
| check_project_status | 1 | 0% / 0 | 0% / 0 | 0% / 0 | 0% / 0 |
| create_calendar_event | 20 | 84.17% / 0.44 | 84.17% / 0.44 | 84.17% / 0.44 | 84.17% / 0.44 |
| create_doc | 248 | 77.99% / 0.57 | 77.79% / 0.57 | 78.19% / 0.57 | 78.19% / 0.57 |
| create_growth_brief | 1 | 33.33% / 0.5 | 33.33% / 0.5 | 33.33% / 0.5 | 33.33% / 0.5 |
| create_runbook_entry | 8 | 100% / 0.44 | 100% / 0.44 | 100% / 0.44 | 100% / 0.44 |
| embeddings_encode | 1 | 0% / 0 | 0% / 0.06 | 0% / 0 | 0% / 0 |
| get_pr | 56 | 85.71% / 0.59 | 85.71% / 0.59 | 85.71% / 0.59 | 85.71% / 0.59 |
| get_runbook | 1 | 100% / 1 | 100% / 1 | 100% / 1 | 100% / 1 |
| get_service_metrics | 1 | 50% / 0.33 | 50% / 0.33 | 50% / 0.33 | 50% / 0.33 |
| list_calendar_events | 8 | 25% / 0.08 | 25% / 0.09 | 25% / 0.08 | 25% / 0.08 |
| list_inbox | 21 | 90.48% / 0.69 | 90.48% / 0.69 | 90.48% / 0.69 | 90.48% / 0.69 |
| list_oncall_schedule | 1 | 100% / 1 | 100% / 1 | 100% / 1 | 100% / 1 |
| list_open_prs | 1 | 0% / 0 | 0% / 0 | 0% / 0 | 0% / 0 |
| metrics_fetch_batch | 1 | 100% / 0.5 | 100% / 0.5 | 100% / 0.5 | 100% / 0.5 |
| place_order | 2 | 50% / 0.17 | 50% / 0.17 | 50% / 0.17 | 50% / 0.17 |
| post_doc_comment | 26 | 62.82% / 0.37 | 62.82% / 0.37 | 62.82% / 0.37 | 62.82% / 0.37 |
| post_pr_comment | 21 | 84.92% / 0.57 | 84.92% / 0.57 | 84.92% / 0.57 | 84.92% / 0.57 |
| query_experiment_results | 2 | 50% / 0.25 | 50% / 0.25 | 50% / 0.25 | 50% / 0.25 |
| send_discord_dm | 19 | 84.21% / 0.54 | 84.21% / 0.55 | 84.21% / 0.54 | 84.21% / 0.54 |
| send_discord_message | 1 | 0% / 0 | 0% / 0.03 | 0% / 0 | 0% / 0 |
| send_email | 71 | 85.92% / 0.72 | 85.92% / 0.71 | 85.92% / 0.71 | 85.92% / 0.71 |
| send_slack_dm | 31 | 80.65% / 0.6 | 80.65% / 0.6 | 80.65% / 0.6 | 80.65% / 0.6 |
| send_slack_message | 8 | 93.75% / 0.64 | 93.75% / 0.64 | 93.75% / 0.64 | 93.75% / 0.64 |
| send_sms | 22 | 90.91% / 0.7 | 90.91% / 0.7 | 90.91% / 0.7 | 90.91% / 0.7 |
| update_calendar_event | 2 | 25% / 0.09 | 25% / 0.09 | 25% / 0.06 | 25% / 0.06 |
| update_crm_row | 6 | 88.89% / 0.86 | 88.89% / 0.86 | 88.89% / 0.86 | 88.89% / 0.86 |
| update_deck_slide | 12 | 97.22% / 0.69 | 97.22% / 0.69 | 97.22% / 0.69 | 97.22% / 0.69 |
| update_doc | 1 | 100% / 1 | 100% / 1 | 100% / 1 | 100% / 1 |
| update_experiment | 2 | 50% / 0.5 | 50% / 0.53 | 50% / 0.5 | 50% / 0.5 |
| update_runbook_entry | 2 | 100% / 0.57 | 100% / 0.57 | 100% / 0.57 | 100% / 0.57 |

product packet: mean 274.7 tok · p95 285 tok · "nothing remembered": 0/600
```
