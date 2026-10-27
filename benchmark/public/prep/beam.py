#!/usr/bin/env python3
"""prep/beam.py — normalize BEAM (100K tier) into per-conversation instances.

Probing question types with `source_chat_ids` become structural gold (those
message ids must be surfaced). Abstention / summarization are unscored at
retrieval level (no message-level evidence defined). ts_off from `time_anchor`.
"""
import json, ast, os, datetime
import polars as pl

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
OUT = os.path.join(PUB, "work", "beam", "instances")
os.makedirs(OUT, exist_ok=True)

df = pl.read_parquet(os.path.join(PUB, "data", "beam-100K.parquet"))
ordered = []
for row in df.iter_rows(named=True):
    cid = str(row["conversation_id"])
    chat = row["chat"]
    turns = []
    dates = []
    for b, batch in enumerate(chat):
        for m in batch:
            anchor = str(m.get("time_anchor") or "")
            try:
                d = datetime.datetime.strptime(anchor, "%B-%d-%Y")
            except ValueError:
                d = datetime.datetime(2024, 1, 1)
            dates.append(d)
    end = max(dates) if dates else datetime.datetime(2024, 1, 1)
    k = 0
    for b, batch in enumerate(chat):
        for m in batch:
            anchor = str(m.get("time_anchor") or "")
            try:
                d = datetime.datetime.strptime(anchor, "%B-%d-%Y")
            except ValueError:
                d = end
            turns.append({
                "id": str(m["id"]),
                "session": f"batch_{b + 1}",
                "speaker": m.get("role", "user"),
                "text": m.get("content", ""),
                "ts_off": int((d - end).total_seconds() * 1000) + k * 60000,
            })
            k += 1

    pq = ast.literal_eval(row["probing_questions"])
    questions = []
    for qtype, arr in pq.items():
        for i, item in enumerate(arr):
            src = item.get("source_chat_ids") or []
            gold_turns = [str(x) for x in src] if isinstance(src, list) else []
            meta = {"difficulty": item.get("difficulty")}
            if qtype == "abstention":
                meta["abstention"] = True
            questions.append({
                "qid": f"{cid}:{qtype}:{i}",
                "type": qtype,
                "question": item.get("question", ""),
                "gold_sessions": [],
                "gold_turns": gold_turns,
                "gold_text": [],
                "meta": meta,
            })

    inst = {"bench": "beam", "sample": cid, "turns": turns, "questions": questions}
    with open(os.path.join(OUT, f"{cid}.json"), "w") as f:
        json.dump(inst, f)
    ordered.append(cid)

with open(os.path.join(PUB, "work", "beam", "config.json"), "w") as f:
    json.dump({"bench": "beam", "ordered": ordered}, f)

scored = sum(1 for c in ordered for q in json.load(open(os.path.join(OUT, f"{c}.json")))["questions"] if q["gold_turns"])
total = sum(1 for c in ordered for q in json.load(open(os.path.join(OUT, f"{c}.json")))["questions"])
print(f"beam: {len(ordered)} conversations, {total} questions ({scored} with message-level gold) -> {OUT}")
