// tools/omni_mab_fuse.ts — can the graph operator add evidence the product head
// misses on MAB? Measures P@10 for product, ppr, and product+ppr (append + cut).
//   bun run tools/omni_mab_fuse.ts --sample CR-0
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUB = join(import.meta.dir, "..");
const argv = Bun.argv.slice(2);
const get = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sample = get("--sample") ?? "CR-0";
const limit = Number(get("--limit") ?? 100);

process.env.CHRONOS_BRAIN_PATH = join(PUB, "work", "mab", `brain-${sample}.sqlite`);
const db = await import("../../../db");
const omni = await import("../../../omni");
const res = JSON.parse(readFileSync(join(PUB, "work", "mab", `s-${sample}.json`), "utf8")) as {
  questions: Array<{ q: string; gold: { text: string[] }; product: { top10: string[] }; union: { top10: string[] } }>;
};

const handle = db.brain();
if (!handle) throw new Error("no brain");
const textOf = (id: string) => {
  const r = handle
    .query("SELECT raw_content AS content FROM l3_verbatim_vault WHERE json_extract(meta_json,'$.turn') = ? LIMIT 1")
    .get(id) as { content: string } | null;
  return r?.content ?? "";
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const pres = (ids: string[], gold: string[]) => {
  const joined = norm(ids.map(textOf).join(" \n "));
  return gold.filter((g) => joined.includes(norm(g))).length / Math.max(1, gold.length);
};

let n = 0;
let p = 0;
let g = 0;
let f = 0;
const ex: string[] = [];
for (const q of res.questions.slice(0, limit)) {
  const gold = (q.gold.text ?? []).filter(Boolean);
  if (!gold.length) continue;
  const prod = q.product.top10.slice(0, 10);
  const ppr = omni.opGraphPpr(handle, q.q, textOf, 10).map((h) => h.id);
  const fused = [...prod];
  for (const id of ppr) if (!fused.includes(id)) fused.push(id);
  const sp = pres(prod, gold);
  const sg = pres(ppr, gold);
  const sf = pres(fused.slice(0, 10), gold);
  p += sp;
  g += sg;
  f += sf;
  n++;
  if (ex.length < 5 && sf > sp) ex.push(`  + ${q.q.slice(0, 80)} gold=${gold.join("|")} prod=${sp} ppr=${sg} fused=${sf}`);
}
console.log(`${sample}: n=${n} product=${((p / n) * 100).toFixed(1)}% ppr=${((g / n) * 100).toFixed(1)}% fused=${((f / n) * 100).toFixed(1)}%`);
ex.forEach((e) => console.log(e));
