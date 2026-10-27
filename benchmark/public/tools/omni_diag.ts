// tools/omni_diag.ts — print one question's operator output against its gold.
//   bun run tools/omni_diag.ts --bench beam --sample 2 --qid 2:event_ordering:0
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
const qid = get("--qid");

process.env.CHRONOS_BRAIN_PATH = join(PUB, "work", bench, `brain-${sample}.sqlite`);
const dbmod = await import("../../../db");
console.log("DBMOD", Object.keys(dbmod).slice(0,8), typeof (dbmod as any).brain);
const db = dbmod as typeof import("../../../db");
const { hydrate } = await import("../lib");
const omni = await import("../../../omni");
const { plan, detectIntents } = await import("../../../planner");

const inst = JSON.parse(readFileSync(join(PUB, "work", bench, "instances", `${sample}.json`), "utf8"));
const now = Date.now();
const turns = inst.turns.map((t: any) => ({ id: t.id, session: t.session, speaker: t.speaker, text: t.text, ts: now + t.ts_off - 86_400_000 }));
hydrate(turns, inst.facts ?? []);
const textOf = (id: string) => turns.find((t: any) => t.id === id)?.text ?? "";
const byId = new Map(turns.map((t: any) => [t.id, t]));
const q = inst.questions.find((x: any) => x.qid === qid) ?? inst.questions.find((x: any) => (x.gold_turns ?? []).length);
const handle = db.brain()!;

console.log("Q:", q.question);
console.log("gold:", q.gold_turns, "type:", q.type);
console.log("intents:", detectIntents(q.question));
const base: string[] = (get("--base") ?? "").split(",").filter(Boolean);
const p = plan({
  db: handle,
  question: q.question,
  base,
  textOf,
  sessionOf: (id) => (byId.get(id) as any)?.session ?? "",
  speakerOf: (id) => (byId.get(id) as any)?.speaker ?? "",
  neighbour: (id, d) => {
    const t = byId.get(id) as any;
    if (!t) return null;
    const idx = turns.findIndex((x: any) => x.id === id);
    const nb = turns[idx + d] as any;
    return nb && nb.session === t.session ? nb.id : null;
  },
}, 10);
console.log("plan:", p.ids, p.origin);

const show = (name: string, hits: Array<{ id: string; score: number }>) => {
  const gold = new Set(q.gold_turns);
  console.log(
    `\n${name} (${hits.length}):`,
    hits.slice(0, 12).map((h) => `${h.id}${gold.has(h.id) ? "*" : ""}:${h.score.toFixed(2)}`).join(" "),
  );
};
show("ppr", omni.opGraphPpr(handle, q.question, textOf, 40));
show("temporal", omni.opTemporal(handle, q.question, base, textOf, (id: string) => (byId.get(id) as any)?.speaker ?? "", 30));
show("state", omni.opState(handle, q.question, 30));
show("facet", omni.opFacet(handle, q.question, 40));
show("setcover", omni.opSetCover(handle, q.question, turns.map((t: any) => ({ id: t.id, text: t.text })), 12));
console.log("\nsubqueries:", omni.subQueries(q.question));
