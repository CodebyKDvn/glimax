#!/usr/bin/env python3
"""tools/summary.py — merge results/*-latest.json into results/SUMMARY.md.

Produces the single front-page table: every benchmark target, its status
(scored / proxy / derived / not scorable), and the headline numbers. Detailed
per-bench reports stay in results/<bench>-report.md.
"""
import json, os, glob

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
RES = os.path.join(PUB, "results")


def load(bench):
    p = os.path.join(RES, f"{bench}-latest.json")
    if not os.path.exists(p):
        return None
    return json.load(open(p))


def f(v, pct=False, d=2):
    if v is None:
        return "—"
    if isinstance(v, float) and (v != v):
        return "—"
    if pct:
        return f"{v * 100:.{d}f}%".replace(".00%", "%")
    return f"{v:.{d}f}" if isinstance(v, float) else str(v)


ORDER = ["locomo", "longmemeval", "beam", "dolphinbench", "membench", "mab", "memorybench"]

# status / protocol notes per benchmark (10 targets incl. the un-scorable ones)
TARGETS = [
    ("LoCoMo", "locomo", "scored", "turn-level gold evidence (dialog ids)"),
    ("LongMemEval", "longmemeval", "scored", "session-level gold evidence"),
    ("BEAM (100K)", "beam", "scored", "message-level gold (source_chat_ids; 235/400 questions)"),
    ("MemoryAgentBench (AR/TTL/CR)", "mab", "proxy", "no evidence labels → answer-string presence in ~900-char windows (AR/CR 30q, TTL 40q per instance; sampled)"),
    ("DolphinBench", "dolphinbench", "scored", "message-level gold (required facts → source messages)"),
    ("MemBench (import-myself)", "membench", "scored", "message-level gold (QA.target_step_id)"),
    ("MemoryBench (THUIR)", "memorybench", "derived", "DERIVED continuity probe: negative-feedback rounds as gold (official protocol needs an LLM judge; not the authors' metric)"),
    ("MemoryArena", None, "not scorable", "multi-session AGENTIC tasks: needs an executor + tool environment; no retrieval labels. Data downloaded (5 families)."),
    ("VibeMemBench", None, "no public data", "repo dir (AlibabaResearch/DAMO-ConvAI) is a 100-byte README stub as of 2026-10-17."),
    ("AgentMemBench", None, "no public data", "no code/data release located as of 2026-10-17."),
]

RESULT_EXTRA = {  # benches that exist in results but aren't among the 10 targets
    "mab-lru": "skipped: summarization split; presence proxy meaningless",
}

lines = []
lines.append("# Chronos-Palace v4.1 — benchmark results (retrieval level)")
lines.append("")
lines.append(f"_generated {__import__('datetime').datetime.utcnow().isoformat(timespec='minutes')}Z_")
lines.append("")
lines.append("![leaderboard](leaderboard.png)")
lines.append("")
lines.append("![dashboard](dashboard.png)")
lines.append("")
lines.append("Scope: **retrieval level only** — can the memory subsystem surface the evidence a")
lines.append("downstream LLM would need to answer? No LLM is in the loop; these numbers are")
lines.append("not the official end-to-end scores of the benchmarks below.")
lines.append("")
lines.append("## Coverage of the ten requested benchmarks")
lines.append("")
lines.append("| # | benchmark | status | protocol / note |")
lines.append("|--:|-----------|--------|-----------------|")
for i, (name, bench, status, note) in enumerate(TARGETS, 1):
    lines.append(f"| {i} | {name} | {status} | {note} |")

lines.append("")
lines.append("## Headline numbers (scored/proxy/derived benches)")
lines.append("")
lines.append("| benchmark | samples | questions | gold | graph R@10 | verbatim R@10 | union R@10 | product R@10 | product MRR | packet tok (mean) |")
lines.append("|-----------|--------:|----------:|------|-----------:|--------------:|-----------:|-------------:|------------:|------------------:|")

avail = []
for bench in ORDER:
    d = load(bench)
    if d is None:
        continue
    avail.append(bench)
    ag = d.get("aggregate", {})
    g, v, u, p = ag.get("graph", {}), ag.get("verbatim", {}), ag.get("union", {}), ag.get("product", {})
    nq = d.get("questions")
    scored_n = d.get("scored", nq)
    gold = "scored" if d.get("scored", 0) and scored_n == nq else f"{scored_n}/{nq}"
    ptok = p.get("tokensMean")
    lines.append(
        f"| {bench} | {d.get('samples')} | {nq} | {gold} | {f(g.get('r10'), True)} | {f(v.get('r10'), True)} | "
        f"{f(u.get('r10'), True)} | {f(p.get('r10'), True)} | {f(p.get('mrr'))} | {f(ptok, d=0)} |"
    )

# presence-proxy table for benches that have it
pres_rows = []
for bench in avail:
    d = load(bench)
    ag = d.get("aggregate", {})
    for ch in ["graph", "verbatim", "product"]:
        a = ag.get(ch) or {}
        if a.get("hasPresence"):
            pres_rows.append((bench, ch, a.get("p1"), a.get("p10")))

if pres_rows:
    lines.append("")
    lines.append("### Answer-string presence (weak proxy — subset of MemoryAgentBench)")
    lines.append("")
    lines.append("Fraction of accepted answer strings visible in the retrieved context (the model could answer from it):")
    lines.append("")
    lines.append("| benchmark | channel | P@1 | P@10 |")
    lines.append("|-----------|---------|----:|-----:|")
    for bench, ch, p1, p10 in pres_rows:
        lines.append(f"| {bench} | {ch} | {f(p1, True)} | {f(p10, True)} |")

lines.append("")
lines.append("## Notes")
lines.append("")
for bench, note in RESULT_EXTRA.items():
    lines.append(f"- {bench}: {note}")
lines.append("- `r1..r50` (structural benches) = mean fraction of the required gold evidence found in top-k.")
lines.append("- `union` = agreement-calibrated merge of graph + verbatim (top-12). `product` = the actual recall packet the plugin injects.")
lines.append("- Every sample ran in its own isolated brain; corpus time anchored so the newest session is ~1 day old.")
lines.append("- Per-bench detail (per-question-type tables, latency, packet size): `results/<bench>-report.md`.")
lines.append("- v7.0 cognitive indexes (opt-in, `CHRONOS_OMNI=1`) and why they are not in the default path: `results/OMNI.md`.")
lines.append("")
lines.append("## Per-bench reports")
lines.append("")
for bench in avail:
    lines.append(f"- [{bench}]({bench}-report.md)")

out = os.path.join(RES, "SUMMARY.md")
with open(out, "w") as fh:
    fh.write("\n".join(lines) + "\n")
print("\n".join(lines))
print(f"\n→ {out}")
