// tools/omni_locomo.ts — measure the graph operator on LoCoMo multi-hop only.
//   bun run tools/omni_locomo.ts --sample conv-26 --category 1
//
// Reads the already-ingested brain (omni tables included) and the stored
// per-question results, then compares:
//   union   = the v6 calibrated graph+verbatim head (already computed)
//   ppr     = opGraphPpr alone
//   fused   = union, with ppr hits appended and the weakest tail slots dropped
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUB = join(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const get = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sample = get("--sample") ?? "conv-26";
const category = Number(get("--category") ?? 1);

process.env.CHRONOS_BRAIN_PATH = join(PUB, "work", "locomo", `brain-${sample}.sqlite`);
const db = await import("../../../db");
const omni = await import("../../../omni");
const res = JSON.parse(readFileSync(join(PUB, "work", "locomo", `s-${sample}.json`), "utf8")) as {
  questions: Array<{ q: string; category: number; gold: string[]; union: { top12: string[]; r10: number | null }; verbatim: { top10: string[] } }>;
};

const handle = db.brain();
if (!handle) throw new Error("no brain");
const have = handle.query("SELECT name FROM sqlite_master WHERE name='omni_timeline'").get();
if (!have) throw new Error("brain has no omni index — rerun the sample with CHRONOS_OMNI=1");

const textOf = (id: string) => {
  const r = handle
    .query("SELECT raw_content AS content FROM l3_verbatim_vault WHERE json_extract(meta_json,'$.turn') = ? LIMIT 1")
    .get(id) as { content: string } | null;
  return r?.content ?? "";
};

const hit = (ids: string[], gold: string[]) => gold.filter((g) => ids.slice(0, 10).includes(g)).length / Math.max(1, gold.length);
let n = 0;
let u = 0;
let p = 0;
let f = 0;
const rows: string[] = [];
for (const q of res.questions) {
  if (q.category !== category) continue;
  const gold = q.gold;
  if (!gold.length) continue;
  const union = q.union.top12.slice(0, 10);
  const ppr = omni.opGraphPpr(handle, q.q, textOf, 10).map((h) => h.id);
  // fuse: keep the union order, then append ppr hits and cut the tail
  const fused: string[] = [...union];
  for (const id of ppr) if (!fused.includes(id)) fused.push(id);
  const fu = fused.slice(0, 10);
  u += hit(union, gold);
  p += hit(ppr, gold);
  f += hit(fu, gold);
  n++;
  if (rows.length < 5 && hit(fu, gold) > hit(union, gold)) {
    rows.push(`  + ${q.q.slice(0, 70)}\n    gold=${gold.join(",")} union=${union.join(",")} ppr=${ppr.join(",")}`);
  }
}
console.log(`${sample} cat${category}: n=${n} union=${((u / n) * 100).toFixed(1)}% ppr=${((p / n) * 100).toFixed(1)}% fused=${((f / n) * 100).toFixed(1)}%`);
rows.forEach((r) => console.log(r));
