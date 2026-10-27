#!/usr/bin/env python3
"""tools/compare.py — before/after table for the v7.0 omni planner run.

Reads work/before/<bench>.json (frozen baseline results) and
results/<bench>-latest.json (current), and prints the headline deltas plus
per-type breakdowns for the structural benches.
"""
import json
import os

PUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(PUB, "results")
BEFORE = os.path.join(PUB, "work", "before")
BENCHES = ["locomo", "longmemeval", "beam", "dolphinbench", "membench", "mab", "memorybench"]


def load(path):
    try:
        return json.load(open(path))
    except Exception:
        return None


def metric(agg):
    if agg.get("p10") is not None:
        return "P@10", agg["p10"]
    if agg.get("r10") is not None:
        return "R@10", agg["r10"]
    return "—", None


rows = []
for b in BENCHES:
    before = load(os.path.join(BEFORE, f"{b}.json"))
    after = load(os.path.join(RES, f"{b}-latest.json"))
    if not before or not after:
        rows.append((b, None))
        continue
    name_b, v_b = metric(before["aggregate"]["product"])
    name_a, v_a = metric(after["aggregate"]["product"])
    rows.append(
        (
            b,
            {
                "metric": name_a,
                "before": v_b,
                "after": v_a,
                "delta": (v_a - v_b) if (v_a is not None and v_b is not None) else None,
                "n_before": before["aggregate"]["product"]["n"],
                "n_after": after["aggregate"]["product"]["n"],
                "tok_before": before["aggregate"]["product"].get("tokensMean"),
                "tok_after": after["aggregate"]["product"].get("tokensMean"),
                "ms_before": before["aggregate"]["product"].get("p50ms"),
                "ms_after": after["aggregate"]["product"].get("p50ms"),
                "stamp": after["stamp"][:16],
            },
        )
    )

print(f"{'bench':14} {'metric':6} {'before':>8} {'after':>8} {'delta':>8} {'n':>10} {'tok':>12} {'p50 ms':>13}")
for b, r in rows:
    if r is None:
        print(f"{b:14} (missing)")
        continue
    d = "—" if r["delta"] is None else f"{r['delta'] * 100:+.2f}"
    print(
        f"{b:14} {r['metric']:6} {r['before'] * 100:7.2f}% {r['after'] * 100:7.2f}% {d:>8} "
        f"{r['n_before']:>4}->{r['n_after']:<4} "
        f"{r['tok_before'] or 0:5.1f}->{r['tok_after'] or 0:<5.1f} "
        f"{r['ms_before'] or 0:5.1f}->{r['ms_after'] or 0:<5.1f}"
    )

# per-type for the structural benches
for b in ["locomo", "longmemeval", "beam", "dolphinbench"]:
    before = load(os.path.join(BEFORE, f"{b}.json"))
    after = load(os.path.join(RES, f"{b}-latest.json"))
    if not before or not after:
        continue
    bt = before.get("byType") or {}
    at = after.get("byType") or {}
    if not bt or not at:
        continue
    key = "p10" if (after["aggregate"]["product"].get("p10") is not None) else "r10"
    print(f"\n{b} per type ({key.upper()}):")
    print(f"  {'type':30} {'n':>4} {'before':>8} {'after':>8} {'delta':>8}")
    for t in sorted(at):
        if t not in bt:
            continue
        vb = (bt[t].get("product") or {}).get(key)
        va = (at[t].get("product") or {}).get(key)
        if vb is None or va is None:
            continue
        n = (at[t].get("product") or {}).get("n", 0)
        print(f"  {t[:30]:30} {n:>4} {vb * 100:7.2f}% {va * 100:7.2f}% {(va - vb) * 100:+7.2f}")
