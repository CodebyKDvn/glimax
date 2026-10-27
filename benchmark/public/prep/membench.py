#!/usr/bin/env python3
"""prep/membench.py — normalize MemBench (import-myself/Membench, arXiv 2506.21605)
into per-example instances.

ThirdAgent/simple.json, categories: roles/events/items/places/hybrid.
Gold = QA.target_step_id (the message ids that contain the evidence).
One question per example; each example gets its own isolated brain.
Default: first 100 examples per category (--all for 500).
"""
import json, os, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
OUT = os.path.join(PUB, "work", "membench", "instances")
os.makedirs(OUT, exist_ok=True)

N = 5000 if "--all" in sys.argv else 100
src = json.load(open(os.path.join(PUB, "data", "membench-third-simple.json")))


def parse_t(s: str):
    try:
        core = s.strip().strip("'").split("'")[-1].strip() if "'" in s else s.strip()
        if core == "":
            core = s.strip().strip("'").split("'")[0]
        return datetime.datetime.strptime(core[:16], "%Y-%m-%d %H:%M")
    except Exception:
        return None


ordered = []
for cat, arr in src.items():
    n = 0
    for ex in arr:
        qa = ex.get("QA")
        if not isinstance(qa, dict) or not qa.get("target_step_id"):
            continue
        if n >= N:
            break
        n += 1
        tid = ex.get("tid", n)
        sample = f"{cat}-{tid}"
        ms = ex.get("message_list") or []
        dates = [parse_t(m.get("time", "")) for m in ms]
        dates = [d for d in dates if d]
        end = max(dates) if dates else datetime.datetime(2024, 10, 1)
        turns = []
        for m in ms:
            d = parse_t(m.get("time", "")) or end
            turns.append({
                "id": str(m["mid"]),
                "session": cat,
                "speaker": "user",
                "text": m.get("message", ""),
                "ts_off": int((d - end).total_seconds() * 1000),
            })
        questions = [{
            "qid": f"{sample}-q",
            "type": cat,
            "question": qa.get("question", ""),
            "gold_sessions": [],
            "gold_turns": [str(x) for x in qa.get("target_step_id", [])],
            "gold_text": [],
            "meta": {"answer": qa.get("answer"), "ground_truth": qa.get("ground_truth")},
        }]
        inst = {"bench": "membench", "sample": sample, "turns": turns, "questions": questions}
        with open(os.path.join(OUT, f"{sample}.json"), "w") as f:
            json.dump(inst, f)
        ordered.append(sample)

with open(os.path.join(PUB, "work", "membench", "config.json"), "w") as f:
    json.dump({"bench": "membench", "ordered": ordered}, f)
print(f"membench: {len(ordered)} instances (ThirdAgent/simple, {N}/category cap) -> {OUT}")
