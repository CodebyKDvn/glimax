#!/usr/bin/env python3
"""prep/dolphinbench.py — normalize DolphinBench into per-persona instances.

Gold = the source messages of each test's required facts (facts/source_message_ids
join tests/required_fact_ids). Gold is message-level; all 1,247 required-fact
links resolve to at least one source message.
"""
import json, os, datetime
import polars as pl

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
OUT = os.path.join(PUB, "work", "dolphinbench", "instances")
os.makedirs(OUT, exist_ok=True)

facts = pl.read_parquet(os.path.join(PUB, "data", "dolphin-facts.parquet"))
tests = pl.read_parquet(os.path.join(PUB, "data", "dolphin-tests.parquet"))
msgs = pl.read_parquet(os.path.join(PUB, "data", "dolphin-messages.parquet"))


def parse_dt(s: str) -> datetime.datetime:
    try:
        d = datetime.datetime.fromisoformat(s)
        if d.tzinfo is not None:
            d = d.astimezone(datetime.timezone.utc).replace(tzinfo=None)
        return d
    except ValueError:
        return datetime.datetime(2024, 1, 1)


ordered = []
for persona in ["morgan", "alex", "riley"]:
    pm = msgs.filter(pl.col("persona") == persona).sort("date").to_dicts()
    dates = [parse_dt(m["date"]) for m in pm]
    end = max(dates) if dates else datetime.datetime(2024, 1, 1)
    turns = []
    for m, d in zip(pm, dates):
        turns.append({
            "id": m["message_id"],
            "session": str(m["date"])[:7],
            "speaker": "user",
            "text": m["content"],
            "ts_off": int((d - end).total_seconds() * 1000),
        })

    pf = {f["fact_id"]: f for f in facts.filter(pl.col("persona") == persona).to_dicts()}
    # v6.0 fact ledger: every statement is already linked to its source message.
    # Index it separately so a request like "order one small latte" can match the
    # Blue Bottle fact without the raw message having to repeat the question.
    fact_rows = []
    for f in pf.values():
        text = str(f.get("statement") or "").strip()
        if f.get("applies_when"):
            text += " " + str(f["applies_when"]).strip()
        for sid in f.get("source_message_ids") or []:
            if text and sid:
                fact_rows.append({"id": str(sid), "text": text, "speaker": "fact"})
    questions = []
    for t in tests.filter(pl.col("persona") == persona).to_dicts():
        gold = []
        for fid in t.get("required_fact_ids") or []:
            f = pf.get(fid)
            if f:
                gold.extend(f.get("source_message_ids") or [])
        tools = t.get("expected_tools") or []
        questions.append({
            "qid": f"{persona}_{t['test_id']}",
            "type": (tools[0] if tools else "action"),
            "question": t["request"],
            "gold_sessions": [],
            "gold_turns": list(dict.fromkeys(gold)),
            "gold_text": [],
            "meta": {"required_fact_ids": t.get("required_fact_ids"), "expected_tools": tools, "date": str(t.get("date"))},
        })

    inst = {
        "bench": "dolphinbench",
        "sample": persona,
        # raw corpus end: the adapter maps question dates onto the re-anchored
        # timeline (newest turn = now-1d) with the same offset as the turns.
        "anchor": end.isoformat(),
        "turns": turns,
        "facts": fact_rows,
        "questions": questions,
    }
    with open(os.path.join(OUT, f"{persona}.json"), "w") as f:
        json.dump(inst, f)
    ordered.append(persona)

with open(os.path.join(PUB, "work", "dolphinbench", "config.json"), "w") as f:
    json.dump({"bench": "dolphinbench", "ordered": ordered}, f)

sc = sum(1 for p in ordered for q in json.load(open(os.path.join(OUT, f"{p}.json")))["questions"] if q["gold_turns"])
print(f"dolphinbench: {len(ordered)} personas, {sc} scored tests (message-level gold) -> {OUT}")
