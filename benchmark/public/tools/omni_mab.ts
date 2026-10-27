// tools/omni_mab.ts — does the entity graph answer MAB's multi-hop questions?
// Scores answer-string presence in each operator's top-k documents.
//   bun run tools/omni_mab.ts --sample CR-0 --limit 40
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUB = join(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const get = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sample = get("--sample") ?? "CR-0";
const limit = Number(get("--limit") ?? 40);
const brain = join(PUB, "work", "mab", `brain-${sample}.sqlite`);
process.env.CHRONOS_BRAIN_PATH = brain;
const db = await import("../../../db");
const { hydrate } = await import("../lib");
const omni = await import("../../../omni");
const { plan } = await import("../../../planner");

const inst = JSON.parse(readFileSync(join(PUB, "work", "mab", "instances", `${sample}.json`), "utf8"));
const now = Date.now();
const turns = inst.turns.map((t: any) => ({ id: t.id, session: t.session, speaker: t.speaker, text: t.text, ts: now + t.ts_off - 86_400_000 }));
hydrate(turns, []);
const textOf = (id: string) => turns.find((t: any) => t.id === id)?.text ?? "";
const handle = db.brain()!;
const have = handle.query("SELECT name FROM sqlite_master WHERE name='omni_timeline'").get();
if (!have) omni.omniIngest(handle, turns);
else if (!(handle.query("SELECT COUNT(*) n FROM omni_timeline").get() as any).n) omni.omniIngest(handle, turns);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const qs = inst.questions.slice(0, limit);
const score = (ids: string[], gold: string[]) => {
  const joined = ids.map(textOf).join(" \n ").toLowerCase();
  return gold.filter((g) => joined.includes(norm(g))).length / Math.max(1, gold.length);
};
let pprP = 0, baseP = 0, planP = 0, n = 0;
const examples: string[] = [];
for (const q of qs) {
  const gold = (q.gold_text ?? []).filter(Boolean);
  if (!gold.length) continue;
  const corpus = norm(turns.map((t: any) => t.text).join(" \n "));
  if (!gold.every((g: string) => corpus.includes(norm(g)))) continue;
  const ppr = omni.opGraphPpr(handle, q.question, textOf, 10).map((h) => h.id);
  const base: string[] = [];
  const p = plan(
    {
      db: handle,
      question: q.question,
      base,
      textOf,
      sessionOf: (id) => turns.find((t: any) => t.id === id)?.session ?? "",
      speakerOf: (id) => turns.find((t: any) => t.id === id)?.speaker ?? "",
      neighbour: () => null,
    },
    10,
  );
  pprP += score(ppr, gold);
  planP += score(p.ids, gold);
  n++;
  if (examples.length < 6) examples.push(`${q.qid} gold=${gold.join("|")} ppr=${score(ppr, gold)} plan=${score(p.ids, gold)} :: ${q.question.slice(0, 90)}`);
}
console.log(`${sample}: n=${n}  pprP@10=${((pprP / n) * 100).toFixed(1)}%  planP@10=${((planP / n) * 100).toFixed(1)}%`);
examples.forEach((e) => console.log(" ", e));
