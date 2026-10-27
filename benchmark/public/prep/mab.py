#!/usr/bin/env python3
"""prep/mab.py — normalize MemoryAgentBench (AR / TTL / CR) into instances.

MAB defines no per-question evidence pointers, so the retrieval-level protocol
here is the standard answer-string presence proxy: the accepted answer strings
must appear in the retrieved context for the model to be able to answer.
LRU (summarization) is skipped: a presence proxy would be meaningless there.

Chunking is format-agnostic: the context is cut into ~900-char windows at line
boundaries. (Header-based splitting was tried first and failed — each MAB row
has its own document/dialogue formatting, and most rows collapsed to a single
turn, which would make the presence metric trivial.)

  AR  = Accurate Retrieval   (documents as context)
  TTL = Test-Time Learning   (recommendation dialogues as context)
  CR  = Conflict Resolution  (numbered fact lists as context)
"""
import json, os
import polars as pl

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.dirname(HERE)
OUT = os.path.join(PUB, "work", "mab", "instances")
os.makedirs(OUT, exist_ok=True)


def window_chunks(text: str, target: int = 900) -> list[str]:
    """~target-char windows cut at line boundaries; very long lines (no
    newlines in the whole context) are hard-split at a space near the target."""
    chunks: list[str] = []
    buf: list[str] = []
    size = 0

    def flush() -> None:
        nonlocal buf, size
        s = "\n".join(buf).strip()
        if s:
            chunks.append(s)
        buf, size = [], 0

    for ln in text.split("\n"):
        while len(ln) > target:
            cut = ln.rfind(" ", 0, target)
            if cut < target // 2:
                cut = target
            piece, ln = ln[:cut], ln[cut:]
            flush()
            p = piece.strip()
            if p:
                chunks.append(p)
        if buf and size + len(ln) + 1 > target:
            flush()
        buf.append(ln)
        size += len(ln) + 1
        if size >= target:
            flush()
    flush()
    return [c for c in chunks if c]


ordered = []
for nm in ["AR", "TTL", "CR"]:
    df = pl.read_parquet(os.path.join(PUB, "data", f"mab-{nm}.parquet"))
    for r_i, row in enumerate(df.iter_rows(named=True)):
        sample = f"{nm}-{r_i}"
        chunks = window_chunks(row["context"])
        turns = []
        for k, ch in enumerate(chunks):
            turns.append({
                "id": f"c{k}",
                "session": nm,
                "speaker": "user",
                "text": ch,
                "ts_off": -k * 60000,
            })
        qtypes = (row.get("metadata") or {}).get("question_types") or []
        questions = []
        for i, q in enumerate(row["questions"]):
            accepted = row["answers"][i]
            if isinstance(accepted, str):
                accepted = [accepted]
            accepted = [str(a) for a in accepted if str(a).strip()]
            questions.append({
                "qid": f"{nm}-{r_i}-q{i}",
                "type": f"{nm}/{(qtypes[i] if i < len(qtypes) and qtypes[i] else 'qa')}",
                "question": q,
                "gold_sessions": [],
                "gold_turns": [],
                "gold_text": list(dict.fromkeys(accepted))[:6],
                "meta": {},
            })
        inst = {"bench": "mab", "sample": sample, "turns": turns, "questions": questions}
        with open(os.path.join(OUT, f"{sample}.json"), "w") as f:
            json.dump(inst, f)
        ordered.append(sample)

with open(os.path.join(PUB, "work", "mab", "config.json"), "w") as f:
    json.dump({"bench": "mab", "ordered": ordered}, f)

tot = sum(len(json.load(open(os.path.join(OUT, f"{s}.json")))["questions"]) for s in ordered)
chunk_counts = {s: len(json.load(open(os.path.join(OUT, f"{s}.json")))["turns"]) for s in ordered}
print(f"mab: {len(ordered)} instances (AR/TTL/CR), {tot} questions with answer-string gold -> {OUT}")
for fam in ["AR", "TTL", "CR"]:
    cs = sorted(v for k, v in chunk_counts.items() if k.startswith(fam + "-"))
    print(f"  {fam}: {len(cs)} instances, chunks min={cs[0]} med={cs[len(cs)//2]} max={cs[-1]}")

