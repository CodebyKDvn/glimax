#!/usr/bin/env python3
"""prep/memorybench.py — MemoryBench (THUIR, arXiv 2510.17281) via the HF
datasets-server API (the .arrow blobs in the repo are not readable locally).

DERIVED PROTOCOL, clearly not the official one (the official protocol scores
final-answer quality with an LLM judge): retrieval-continuity probe where the
gold is the user's NEGATIVE-feedback turns from earlier service rounds — the
turns a memory system must resurface when the same user comes back.

Rows: LexEval-QA (zh legal) + LimitGen-Syn (en) — first MAX_ROWS each.
"""
import json, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
OUT = os.path.join(PUB, "work", "memorybench", "instances")
os.makedirs(OUT, exist_ok=True)
MAX_ROWS = 150

def as_list(v):
    """Rows API sometimes returns JSON-encoded strings for nested fields."""
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        try:
            p = json.loads(v)
            return p if isinstance(p, list) else []
        except Exception:
            return []
    return []


ordered = []
for cfg in ["LexEval-QA", "LimitGen-Syn"]:
    got = 0
    for offset in range(0, MAX_ROWS, 100):
        url = (
            "https://datasets-server.huggingface.co/rows?"
            f"dataset=THUIR%2FMemoryBench&config={cfg}&split=train&offset={offset}&length=100"
        )
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read())
        except Exception as e:
            print("fetch err", cfg, offset, e)
            break
        rows = data.get("rows", [])
        if not rows:
            break
        for row in rows:
            row = row["row"]
            dialog = as_list(row.get("dialog"))
            fb = as_list(row.get("implicit_feedback"))
            fbm = as_list(row.get("implicit_feedback_mistral"))
            if len(dialog) < 4:
                continue
            # user turns at even indices under the normal user/assistant alternation
            neg_rounds = set()
            for f in fb:
                if not isinstance(f, dict):
                    continue
                if f.get("satisfaction_score") is not None and f["satisfaction_score"] <= 4:
                    neg_rounds.add(int(f.get("round", 0)))
            for f in fbm:
                if not isinstance(f, dict):
                    continue
                if str(f.get("implicit_action", "")) == "dislike":
                    neg_rounds.add(int(f.get("round", 0)))
            if not neg_rounds:
                continue
            turns = []
            for i, t in enumerate(dialog):
                if not isinstance(t, dict):
                    t = {"role": "user", "content": str(t)}
                turns.append({
                    "id": f"t{i}",
                    "session": "dialog",
                    "speaker": t.get("role", "user"),
                    "text": t.get("content", ""),
                    "ts_off": -i * 60000,
                })
            last_user = None
            users = [i for i, t in enumerate(dialog) if isinstance(t, dict) and t.get("role") == "user"]
            if users:
                last_user = users[-1]
            if last_user is None or len(users) < 2:
                continue
            gold = []
            for r in sorted(neg_rounds):
                if 1 <= r <= len(users) - 1:
                    idx = users[r - 1]
                    if idx < last_user:
                        gold.append(f"t{idx}")
            if not gold:
                continue
            got += 1
            sample = f"{cfg}-{row.get('test_idx', offset)}"
            inst = {
                "bench": "memorybench",
                "sample": sample,
                "turns": turns,
                "questions": [{
                    "qid": f"{sample}-q",
                    "type": cfg,
                    "question": dialog[last_user].get("content", ""),
                    "gold_sessions": [],
                    "gold_turns": gold,
                    "gold_text": [],
                    "meta": {"derived": True, "lang": row.get("lang"), "self_turn": f"t{last_user}"},
                }],
            }
            with open(os.path.join(OUT, f"{sample}.json"), "w") as f:
                json.dump(inst, f)
            ordered.append(sample)
        if got >= MAX_ROWS:
            break

with open(os.path.join(PUB, "work", "memorybench", "config.json"), "w") as f:
    json.dump({"bench": "memorybench", "ordered": ordered}, f)
print(f"memorybench: {len(ordered)} derived instances -> {OUT}")
