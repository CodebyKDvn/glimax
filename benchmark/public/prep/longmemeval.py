#!/usr/bin/env python3
"""prep/longmemeval.py — normalize LongMemEval into per-question instances.

work/longmemeval/instances/<qid>.json:
  { bench, sample, turns: [{id, session, speaker, text, ts_off}],
    questions: [{qid, type, question, gold_sessions, gold_turns, gold_text, meta}] }

ts_off = ms offset from the corpus end (<= 0). The adapter anchors the corpus
end to now, so recency decay works the way it does in real use.
"""
import json, datetime, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
SRC = os.path.join(PUB, "data", "longmemeval_s")
OUT = os.path.join(PUB, "work", "longmemeval", "instances")
os.makedirs(OUT, exist_ok=True)

fmt = "%Y/%m/%d (%a) %H:%M"
parse = lambda s: datetime.datetime.strptime(s, fmt)

data = json.load(open(SRC))
ordered = []
for q in data:
    qid = q["question_id"]
    sids = q["haystack_session_ids"]
    dates = [parse(d) for d in q["haystack_dates"]]
    end = max(dates)
    turns = []
    for i, sess in enumerate(q["haystack_sessions"]):
        sid = sids[i] if i < len(sids) else f"session_{i}"
        off = int((dates[i] - end).total_seconds() * 1000)
        for j, m in enumerate(sess):
            turns.append({
                "id": f"{sid}#{j}",
                "session": sid,
                "speaker": m.get("role", "user"),
                "text": m.get("content", ""),
                "ts_off": off + j * 1000,
            })
    is_abs = qid.endswith("_abs")
    gold_sessions = [] if is_abs else list(q.get("answer_session_ids", []))
    inst = {
        "bench": "longmemeval",
        "sample": qid,
        "turns": turns,
        "questions": [{
            "qid": qid,
            "type": q["question_type"],
            "question": q["question"],
            "gold_sessions": gold_sessions,
            "gold_turns": [],
            "gold_text": [],
            "meta": {"abstention": is_abs, "answer": q.get("answer")},
        }],
    }
    with open(os.path.join(OUT, f"{qid}.json"), "w") as f:
        json.dump(inst, f)
    ordered.append(qid)

with open(os.path.join(PUB, "work", "longmemeval", "config.json"), "w") as f:
    json.dump({"bench": "longmemeval", "ordered": ordered}, f)

n_gold = sum(1 for q in data if not q["question_id"].endswith("_abs"))
print(f"longmemeval: {len(ordered)} instances ({n_gold} scored, {len(ordered)-n_gold} abstention) -> {OUT}")
sizes = [os.path.getsize(os.path.join(OUT, f"{q}.json")) for q in ordered[:50]]
print(f"avg instance size (first 50): {sum(sizes)//50//1024} KB")
