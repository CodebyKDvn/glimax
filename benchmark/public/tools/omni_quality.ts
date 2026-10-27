// tools/omni_quality.ts — per-operator precision against gold, and how much
// gold each operator can add that the lexical base missed.
//   bun run tools/omni_quality.ts --bench beam --samples 1,2,3
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUB = join(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const get = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bench = get("--bench") ?? "beam";
const sample = get("--sample") ?? "1";
process.env.CHRONOS_BRAIN_PATH = join(PUB, "work", bench, `brain-${sample}.sqlite`);
const db = await import("../../../db");
const { hydrate } = await import("../lib");
const omni = await import("../../../omni");

const inst = JSON.parse(readFileSync(join(PUB, "work", bench, "instances", `${sample}.json`), "utf8"));
const now = Date.now();
const turns = inst.turns.map((t: any) => ({ id: t.id, session: t.session, speaker: t.speaker, text: t.text, ts: now + t.ts_off - 86_400_000 }));
hydrate(turns, inst.facts ?? []);
const textOf = (id: string) => turns.find((t: any) => t.id === id)?.text ?? "";
const speakerOf = (id: string) => turns.find((t: any) => t.id === id)?.speaker ?? "";
const handle = db.brain()!;

const out: any[] = [];
for (const q of inst.questions) {
  const gold = new Set<string>(q.gold_turns ?? []);
  if (!gold.size) continue;
  const base: string[] = [];
  const ops: Record<string, string[]> = {
    ppr: omni.opGraphPpr(handle, q.question, textOf, 12).map((h) => h.id),
    temporal: omni.opTemporal(handle, q.question, [], textOf, speakerOf, 12).map((h) => h.id),
    state: omni.opState(handle, q.question, 12).map((h) => h.id),
    facet: omni.opFacet(handle, q.question, 12).map((h) => h.id),
    setcover: omni.opSetCover(handle, q.question, turns.map((t: any) => ({ id: t.id, text: t.text })), 12).map((h) => h.id),
  };
  const row: any = { qid: q.qid, type: q.type, gold: [...gold], n: gold.size, ops: {} };
  for (const [k, ids] of Object.entries(ops)) {
    const hits = ids.filter((id) => gold.has(id));
    row.ops[k] = { returned: ids.length, hits: hits.length, precision: ids.length ? hits.length / ids.length : 0, ids };
  }
  out.push(row);
}
console.log(JSON.stringify({ bench, sample, rows: out }));
