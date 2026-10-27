// ===========================================================================
// benchmark/autopsy.ts — v6.0 empirical error autopsy.
//
// Reads the *current* worker output (not the rendered report) and answers one
// question per low benchmark: is the gold evidence missing from the corpus,
// missing from retrieval, or present but destroyed by the packet?
//
//   bun benchmark/autopsy.ts                 # all four low benches
//   bun benchmark/autopsy.ts --bench mab     # one bench
// ===========================================================================

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const PUB = join(HERE, "public");
const WORK = join(PUB, "work");
const RES = join(PUB, "results");

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const exists = (p: string) => existsSync(p);

function parts(bench: string): any[] {
  const dir = join(WORK, bench);
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^s-.*\.json$/.test(f))
    .map((f) => read(join(dir, f)));
}

function instance(bench: string, sample: string): any | null {
  const p = join(WORK, bench, "instances", `${sample}.json`);
  return exists(p) ? read(p) : null;
}

function latest(bench: string): any | null {
  const p = join(RES, `${bench}-latest.json`);
  return exists(p) ? read(p) : null;
}

// ---------------------------------------------------------------- structural

function structural(bench: string): void {
  const ps = parts(bench);
  if (!ps.length) {
    console.log(`\n## ${bench}: no worker parts`);
    return;
  }
  const L = latest(bench);
  const a = L?.aggregate;
  console.log(`\n## ${bench}`);
  if (a) {
    const g = a.graph?.r10;
    const v = a.verbatim?.r10;
    const u = a.union?.r10;
    const p = a.product?.r10;
    console.log(
      `baseline: graph ${g == null ? "—" : pct(g)} · verbatim ${v == null ? "—" : pct(v)} · union ${u == null ? "—" : pct(u)} · product ${p == null ? "—" : pct(p)}`,
    );
  }

  const rows: any[] = [];
  for (const part of ps) {
    const inst = instance(bench, part.sample);
    const turns = new Map<string, any>((inst?.turns ?? []).map((t: any) => [t.id, t]));
    for (const q of part.questions ?? []) {
      const gold: string[] = q.gold?.turns ?? [];
      if (!gold.length || q.abstention) continue;
      const gset = new Set(gold);
      const topV: string[] = q.verbatim?.top10 ?? [];
      const topP: string[] = q.product?.top10 ?? [];
      const topU: string[] = q.union?.top10 ?? [];
      const hitV = gold.filter((x) => topV.includes(x)).length / gold.length;
      const hitP = gold.filter((x) => topP.includes(x)).length / gold.length;
      const hitU = gold.filter((x) => topU.includes(x)).length / gold.length;
      const texts = topV.map((id) => String(turns.get(id)?.text ?? ""));
      const tool = texts.filter((t) => /^\s*[\[{]/.test(t) || /"tool_call"|"function"\s*:|tool_call_id/i.test(t)).length;
      const sessions = new Map<string, number>();
      for (const id of topV) {
        const s = String(turns.get(id)?.session ?? "?");
        sessions.set(s, (sessions.get(s) ?? 0) + 1);
      }
      const maxCluster = Math.max(0, ...sessions.values()) / Math.max(1, topV.length);
      rows.push({
        qid: q.qid,
        gold: gold.length,
        hitV,
        hitU,
        hitP,
        r50: q.verbatim?.r50 ?? null,
        toolShare: tool / Math.max(1, topV.length),
        maxCluster,
        question: q.q,
      });
    }
  }
  const n = rows.length || 1;
  console.log(`questions: ${rows.length}`);
  console.log(
    `recall: verbatim ${pct(mean(rows.map((r) => r.hitV)))} · union ${pct(mean(rows.map((r) => r.hitU)))} · product ${pct(mean(rows.map((r) => r.hitP)))}`,
  );
  console.log(`verbatim full-gold rate: ${pct(rows.filter((r) => r.hitV >= 1).length / n)}`);
  console.log(`gold found in verbatim top-50: ${pct(rows.filter((r) => (r.r50 ?? 0) > 0).length / n)}`);
  console.log(`mean top-10 tool/metadata share: ${pct(mean(rows.map((r) => r.toolShare)))}`);
  console.log(`mean top-10 largest-session share (cluster concentration): ${pct(mean(rows.map((r) => r.maxCluster)))}`);
  console.log(`mean gold items per question: ${mean(rows.map((r) => r.gold)).toFixed(2)}`);
  const byGold = new Map<number, any[]>();
  for (const r of rows) {
    const k = Math.min(5, r.gold);
    if (!byGold.has(k)) byGold.set(k, []);
    byGold.get(k)!.push(r);
  }
  console.log("recall by gold-count:");
  for (const k of [...byGold.keys()].sort((a, b) => a - b)) {
    const rr = byGold.get(k)!;
    console.log(
      `  gold=${k}${k === 5 ? "+" : ""} n=${rr.length} verbatim=${pct(mean(rr.map((r) => r.hitV)))} product=${pct(mean(rr.map((r) => r.hitP)))}`,
    );
  }
  console.log("sample misses:");
  for (const r of rows.filter((r) => r.hitV < 1).slice(0, 8)) {
    console.log(
      `  ${r.qid} gold=${r.gold} v=${pct(r.hitV)} p=${pct(r.hitP)} r50=${r.r50 == null ? "—" : pct(r.r50)} tool=${pct(r.toolShare)} cluster=${pct(r.maxCluster)} :: ${String(r.question).slice(0, 90)}`,
    );
  }
}

// ---------------------------------------------------------------------- MAB

function mab(): void {
  const ps = parts("mab");
  if (!ps.length) {
    console.log("\n## mab: no worker parts");
    return;
  }
  const L = latest("mab");
  console.log(`\n## mab`);
  if (L?.aggregate) {
    const a = L.aggregate;
    console.log(
      `baseline: graph P@10 ${pct(a.graph?.p10 ?? 0)} · verbatim ${pct(a.verbatim?.p10 ?? 0)} · union ${pct(a.union?.p10 ?? 0)} · product ${pct(a.product?.p10 ?? 0)} · product tok ${a.product?.tokensMean?.toFixed?.(1) ?? "—"}`,
    );
  }

  const fams = new Map<string, any[]>();
  for (const part of ps) {
    const inst = instance("mab", part.sample);
    const turns: any[] = inst?.turns ?? [];
    const corpus = norm(turns.map((t) => t.text).join(" \n "));
    const fam = String(part.sample).split("-")[0];
    if (!fams.has(fam)) fams.set(fam, []);
    for (const q of part.questions ?? []) {
      const gold = (q.gold?.text ?? []).map(norm).filter((g: string) => g && corpus.includes(g));
      const pres = q.verbatim?.pres;
      const ppres = q.product?.pres;
      if (!gold.length || !pres) continue;
      const goldChunks = turns.filter((t) => gold.every((g: string) => norm(t.text).includes(g)));
      const rank = goldChunks.length
        ? turns.findIndex((t) => t.id === goldChunks[0].id)
        : -1;
      const topV: string[] = q.verbatim?.top10 ?? [];
      const topText = norm(topV.map((id) => String(turns.find((t) => t.id === id)?.text ?? "")).join(" \n "));
      const fullHit = gold.filter((g: string) => topText.includes(g)).length / gold.length;
      fams.get(fam)!.push({
        qid: q.qid,
        type: q.type,
        gold: gold.length,
        v10: pres.p10,
        fullHit,
        p10: ppres?.p10 ?? 0,
        rank,
        tokens: q.product?.tokens ?? 0,
        chunkLen: goldChunks[0] ? String(goldChunks[0].text).length : 0,
      });
    }
  }
  for (const [fam, rows] of fams) {
    const n = rows.length || 1;
    console.log(`\n${fam}: n=${rows.length}`);
    console.log(
      `  verbatim P@10 ${pct(mean(rows.map((r) => r.v10)))} · full-top10 ceiling ${pct(mean(rows.map((r) => r.fullHit)))} · product P@10 ${pct(mean(rows.map((r) => r.p10)))}`,
    );
    console.log(
      `  gold chunk rank: top-10 ${pct(rows.filter((r) => r.rank >= 0 && r.rank < 10).length / n)} · top-50 ${pct(rows.filter((r) => r.rank >= 0 && r.rank < 50).length / n)} · absent ${pct(rows.filter((r) => r.rank < 0).length / n)}`,
    );
    console.log(`  product mean tokens ${mean(rows.map((r) => r.tokens)).toFixed(1)} · mean gold chunk chars ${mean(rows.map((r) => r.chunkLen)).toFixed(0)}`);
  }
  const all = [...fams.values()].flat();
  console.log(
    `\nall: verbatim P@10 ${pct(mean(all.map((r) => r.v10)))} · full-top10 ceiling ${pct(mean(all.map((r) => r.fullHit)))} · product P@10 ${pct(mean(all.map((r) => r.p10)))}`,
  );
}

// ------------------------------------------------------------------- LoCoMo

function locomo(): void {
  const ps = parts("locomo");
  if (!ps.length) {
    console.log("\n## locomo: no worker parts");
    return;
  }
  const L = latest("locomo");
  console.log(`\n## locomo`);
  if (L?.aggregate) {
    const a = L.aggregate;
    console.log(
      `baseline: graph ${pct(a.graph?.r10 ?? 0)} · verbatim ${pct(a.verbatim?.r10 ?? 0)} · union ${pct(a.union?.r10 ?? 0)} · product ${pct(a.product?.r10 ?? 0)}`,
    );
  }
  const rows: any[] = [];
  for (const part of ps) {
    for (const q of part.questions ?? []) {
      const gold: string[] = q.gold ?? [];
      if (!gold.length) continue;
      const topV: string[] = q.verbatim?.top10 ?? [];
      const hit = gold.filter((x) => topV.includes(x)).length / gold.length;
      const miss = gold.filter((x) => !topV.includes(x));
      rows.push({ ...q, hit, miss });
    }
  }
  const n = rows.length || 1;
  console.log(`questions: ${rows.length} · verbatim full-gold ${pct(rows.filter((r) => r.hit >= 1).length / n)}`);
  const miss = rows.filter((r) => r.hit < 1);
  const cat = {
    pronoun: 0,
    adjacent: 0,
    temporal: 0,
    synonym: 0,
    none: 0,
  };
  const examples: string[] = [];
  for (const r of miss.slice(0, 50)) {
    const q = String(r.q ?? "");
    const top: string[] = r.verbatim?.top10 ?? [];
    const adj = r.miss.some((g: string) => {
      const m = /^D(\d+):(\d+)$/.exec(g);
      if (!m) return false;
      const s = `D${m[1]}:`;
      const i = Number(m[2]);
      return top.some((t) => t.startsWith(s) && Math.abs(Number(t.split(":")[1]) - i) <= 1);
    });
    const pron = /\b(i|my|me|we|our|you|your|he|she|it|they|them|their)\b/i.test(q);
    const temp = /\b(when|what date|what year|what time|how long)\b/i.test(q);
    const words = [...new Set((q.toLowerCase().match(/[a-z]{5,}/g) ?? []))].slice(0, 8);
    const goldText = norm(r.miss.join(" "));
    const syn = words.length > 0 && !words.some((w) => goldText.includes(w));
    if (adj) cat.adjacent++;
    else if (pron) cat.pronoun++;
    else if (temp) cat.temporal++;
    else if (syn) cat.synonym++;
    else cat.none++;
    if (examples.length < 8) {
      examples.push(
        `  ${r.qid ?? "?"} cat=${r.category} adj=${adj} pron=${pron} temp=${temp} syn=${syn} :: ${q.slice(0, 80)}`,
      );
    }
  }
  console.log(`missset (first ${Math.min(50, miss.length)}):`, cat);
  console.log("examples:\n" + examples.join("\n"));
}

// ---------------------------------------------------------------------- main

const arg = process.argv.indexOf("--bench");
const which = arg >= 0 ? process.argv[arg + 1] : "all";
if (which === "all" || which === "beam") structural("beam");
if (which === "all" || which === "dolphinbench") structural("dolphinbench");
if (which === "all" || which === "mab") mab();
if (which === "all" || which === "locomo") locomo();
