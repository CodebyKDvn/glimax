# OMNISCIENT — the five cognitive indexes, and what they actually bought

_v1 draft · 2026-10-25 · measured against the seven public benchmarks_

> This is the v7.0 work line of the plugin (package version stays 4.0.0). The
> layer is opt-in; nothing below changes the default recall path.

## What was built

`omni.ts` maintains five indexes that are not similarity structures, built at
ingest time from the same turns the L3 vault stores:

| index | table | what it answers |
|---|---|---|
| entity graph | `omni_entity_mentions` / `omni_entity_edges` | who/what is connected to whom (multi-hop bridges) |
| timeline | `omni_timeline` | session/turn ordinals, absolute dates, prev/next pointers |
| state ledger | `omni_state_ledger` | attribute versions: what is true *now* vs before |
| facet index | `omni_facet_index` | category → member ("which libraries" → each library turn) |
| causal episodes | `omni_causal` | request → tool output → answer runs |

`planner.ts` runs six operators over them (`opGraphPpr`, `opTemporal`,
`opState`, `opFacet`, `opSetCover`, `opCausal`), detects the question's intent,
and re-allocates the ten packet slots with a budget and a replacement margin.

Both are opt-in: `CHRONOS_OMNI=1`. The default path is unchanged v6.

## Why opt-in: the measurements

**1. Operator precision is too low to displace lexical evidence.**
BEAM, 3 samples / 36 questions, precision@12 against gold turn ids:

| operator | precision | hits / returned |
|---|---:|---:|
| temporal | 22% | 4 / 18 |
| set-cover | 8% | 6 / 76 |
| graph PPR | 6% | 23 / 394 |
| facet | 2% | 3 / 162 |
| state | 0% | 0 / 47 |

A slot given to an operator is a slot taken from the lexical head, which finds
gold at 44.2% R@10. At 2–22% precision the trade is negative by construction.

**2. On the one class the graph should own — multi-hop — it loses badly.**
LoCoMo conv-26, category 1 (multi-hop, n=32), id-based R@10:

| channel | R@10 |
|---|---:|
| lexical/semantic union (v6) | 50.3% |
| graph PPR alone | 11.2% |
| union + PPR fused | 50.3% (adds nothing) |

The graph's hop-2 constraint (bridge entity *and* question predicate) is too
strict to reach the second hop, and relaxing it returns hub-word chatter.

**3. End-to-end, the planner is neutral-to-negative.**
- LoCoMo (1986 questions): 73.67% → 73.58%. The planner changed 30 questions:
  18 worse, 12 better. Pareto guard FAIL (union < verbatim).
- BEAM (6 samples, semantic on): mean 50.22% → 49.80%.
- MAB CR-0: union 71.02% → 71.88%, product 74.62% → 74.74% — inside noise.

**4. It costs ingest time.** ~+35% on LoCoMo (conv-26: 2.2s → 3.1s per 419
turns) for no retrieval gain.

## What survives

The indexes are correct and cheap, and they answer questions the packet path
does not: `chronos` timeline/state queries, causal episode expansion, and the
`--omni` A/B harness (`tools/omni_eval.ts`, `tools/omni_quality.ts`,
`tools/omni_diag.ts`). They stay behind the flag, and the harness can still
reproduce every number above with `CHRONOS_OMNI=1`.

## What would make it win

1. **Answer-level scoring.** Every metric here is turn retrieval. A reordered,
   deduplicated packet can produce a better answer without moving R@10; without
   an LLM judge we cannot see that, and we should not ship on faith.
2. **A learned router, not a hand-written one.** The intent regexes are the weak
   link: "list the order in which I brought up X" fires ordering + enumeration +
   aggregate at once, and the budget then tries to satisfy all three.
3. **A precision-first operator.** The only operator with usable precision is
   temporal (22%). A planner that fires *only* when an operator's confidence is
   high and the slot it would take is empty (head shorter than k) cannot lose;
   that is the shape to build next.

## Decision

`CHRONOS_OMNI` defaults to `0`. v7.0 ships the indexes and the measurement
harness, not a change to the retrieval path. The headline numbers in
`SUMMARY.md` remain the v6 path, verified identical on LoCoMo (73.67%).
