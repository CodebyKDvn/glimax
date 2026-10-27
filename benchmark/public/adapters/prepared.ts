// ===========================================================================
// adapters/prepared.ts — generic engine for "prepared" benchmarks.
//
// A prep script normalizes a dataset into:
//   work/<bench>/config.json           { bench, ordered: [sample ids] }
//   work/<bench>/instances/<id>.json   { bench, sample, turns, questions }
//
// turn  = {id, session, speaker, text, ts_off}   (ts_off ≤ 0, ms from corpus end)
// quest = {qid, type, question, gold_sessions[], gold_turns[], gold_text[], meta}
//
// Gold regimes:
//   structural (gold_sessions/gold_turns): R@k / MRR over retrieved turn ids
//   presence   (gold_text):               answer-string presence in top-k texts
// Both can coexist. Abstention questions (meta.abstention) are counted but not
// scored structurally.
//
// Corpus time is anchored so the newest session is ~1 day old; recency decay in
// the retriever is therefore active exactly as in real use.
// ===========================================================================

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DAY, VERBATIM_BY_BENCH, ask, ingest, mean, pct, r1, recallAt, rr, nowStamp, type Turn } from "../lib";

const HERE = import.meta.dir; // benchmark/public/adapters
const PUB = join(HERE, "..");

export interface Q {
  qid: string;
  type: string;
  question: string;
  gold_sessions: string[];
  gold_turns: string[];
  gold_text: string[];
  meta?: Record<string, unknown>;
}
export interface Instance {
  bench: string;
  sample: string;
  /** raw corpus end (ISO) — maps question dates onto the re-anchored timeline */
  anchor?: string;
  turns: Array<Turn & { ts_off: number }>;
  facts?: Array<{ id: string; text: string; speaker?: string }>;
  questions: Q[];
}

const benchDir = (bench: string) => join(PUB, "work", bench);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function loadInstance(bench: string, sample: string): Instance {
  return JSON.parse(readFileSync(join(benchDir(bench), "instances", `${sample}.json`), "utf8"));
}

export function listSamples(args: { bench: string }): string[] {
  const cfg = JSON.parse(readFileSync(join(benchDir(args.bench), "config.json"), "utf8"));
  return cfg.ordered as string[];
}

// --------------------------------------------------------------------- worker

export async function worker(args: { bench: string; sample: string; limit?: number }): Promise<void> {
  const bench = args.bench;
  const inst = loadInstance(bench, args.sample);
  const scopeName = `bench-${bench}-${args.sample}`;
  const scope = `project:${scopeName}`;

  const now = Date.now();
  const anchorRaw = typeof inst.anchor === "string" ? Date.parse(inst.anchor) : NaN;
  const turns: Turn[] = inst.turns.map((t) => ({
    id: t.id,
    session: t.session,
    speaker: t.speaker,
    text: t.text,
    ts: now + t.ts_off - DAY,
  }));
  const turnById = new Map(turns.map((t) => [t.id, t]));
  const ing = await ingest(scope, args.sample, scopeName, turns, inst.facts ?? []);

  const qs = args.limit ? inst.questions.slice(0, args.limit) : inst.questions;
  // v5.0 — presence proxy guard: an answer string that occurs nowhere in the
  // corpus is unanswerable for every system on earth; it must not sit in the
  // denominator (MAB AR ceilings at best-case 18.6% without this).
  const corpusNorm = norm(turns.map((t) => t.text).join(" \n "));
  const rows: unknown[] = [];
  for (const item of qs) {
    const goldS = new Set(item.gold_sessions ?? []);
    const goldT = new Set(item.gold_turns ?? []);
    // v5.0 — presence restricted to gold strings that occur somewhere in the corpus
    const gtAll = (item.gold_text ?? []).map(norm).filter(Boolean);
    const gt = gtAll.filter((g) => corpusNorm.includes(g));
    const abst = !!(item.meta && (item.meta as Record<string, unknown>).abstention);
    const scored = !abst && (goldS.size > 0 || goldT.size > 0);
    // some probes are themselves ingested (e.g. the final user turn of a dialog):
    // drop that turn from the retrieved list before scoring so it cannot self-match.
    const selfTurn = (item.meta && (item.meta as Record<string, unknown>).self_turn) as string | undefined;
    const isHit = (turnId: string) => {
      if (goldT.has(turnId)) return true;
      const t = turnById.get(turnId);
      return t ? goldS.has(t.session) : false;
    };

    const dateRaw = (item.meta as Record<string, unknown> | undefined)?.date;
    const dateAt = typeof dateRaw === "string" ? Date.parse(dateRaw) : NaN;
    // The corpus is re-anchored to "now"; question dates must ride the same
    // offset or the recency channel sees every turn as years old (DolphinBench
    // request dates are still in the raw 2028 timeline).
    const at =
      Number.isFinite(dateAt) && Number.isFinite(anchorRaw) ? now + (dateAt - anchorRaw) - DAY : dateAt;
    const out = await ask(item.question, scope, args.sample, scopeName, 50, Number.isFinite(at) ? at : undefined, {
      verbatim: VERBATIM_BY_BENCH[bench],
    });
    const { graph, verbatim, product } = out;
    const drop = (ids: string[], texts: string[]) => {
      if (!selfTurn) return { ids, texts };
      const pairs = ids.map((id, i) => [id, texts[i] ?? ""] as const).filter((p) => p[0] !== selfTurn);
      return { ids: pairs.map((p) => p[0]), texts: pairs.map((p) => p[1]) };
    };
    const g = drop(graph.ids, graph.texts);
    const v = drop(verbatim.ids, verbatim.texts);
    const u = drop(out.union.ids, out.union.texts);
    const unionIds = u.ids;
    const unionTexts = u.texts;

    const chan = (ids: string[], texts: string[], ms: number, extra: Record<string, unknown> = {}) => {
      // session-gold questions can need several turns; count fraction of gold evidence hit in top-k
      let r1s: number | null = null, r5s: number | null = null, r10s: number | null = null, r50s: number | null = null, mrrV: number | null = null;
      if (scored) {
        const kSess = (k: number) => {
          const seenS = new Set<string>();
          for (const id of ids.slice(0, k)) {
            const t = turnById.get(id);
            if (!t) continue;
            if (goldT.has(id)) seenS.add(id);
            else if (goldS.has(t.session)) seenS.add(t.session);
          }
          const need = new Set<string>([...goldT, ...goldS]);
          return need.size ? seenS.size / need.size : null;
        };
        r1s = kSess(1);
        r5s = kSess(5);
        r10s = kSess(10);
        r50s = kSess(50);
        const firstIdx = ids.findIndex((id) => isHit(id));
        mrrV = firstIdx < 0 ? 0 : 1 / (firstIdx + 1);
      }
      const all = scored ? (r50s != null && r50s > 0 ? 1 : 0) : null;

      // presence proxy for gold_text (answer strings that should appear in
      // context), restricted to strings that exist somewhere in the corpus
      const joined = (k: number) => norm(texts.slice(0, k).join(" \n "));
      const pres = gt.length
        ? {
            p1: gt.filter((g) => joined(1).includes(g)).length / gt.length,
            p5: gt.filter((g) => joined(5).includes(g)).length / gt.length,
            p10: gt.filter((g) => joined(10).includes(g)).length / gt.length,
            pAll: gt.filter((g) => norm(texts.join(" \n ")).includes(g)).length / gt.length,
          }
        : null;

      return { r1: r1s, r5: r5s, r10: r10s, r50: r50s, all, rr: mrrV, ms, n: ids.length, pres, top10: ids.slice(0, 10), ...extra };
    };

    rows.push({
      q: item.question,
      qid: item.qid,
      type: item.type,
      abstention: abst,
      presX: gtAll.length > 0 && gt.length === 0,
      gold: { sessions: [...goldS], turns: [...goldT], text: item.gold_text ?? [] },
      graph: chan(g.ids, g.texts, graph.ms, { ctxTokens: graph.ctxTokens }),
      verbatim: chan(v.ids, v.texts, verbatim.ms),
      union: chan(unionIds, unionTexts, out.union.ms),
      product: chan(drop(product.ids, product.texts).ids, product.texts, product.ms, { tokens: product.tokens, text: product.text.slice(0, 600) }),
      // v7.0 — which cognitive operator supplied each slot
      omni: out.omni ? { intent: out.omni.intent, origin: out.omni.origin, ops: out.omni.ops, ms: out.omni.ms } : null,
    });
  }

  const part = { sample: args.sample, bench, ingest: ing, qaTotal: inst.questions.length, qaRun: qs.length, questions: rows };
  writeFileSync(join(benchDir(bench), `s-${args.sample.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(part));
  console.log(`[${bench}] ${args.sample}: ${ing.turns} turns → ${ing.edges} edges in ${r1(ing.ms)}ms; ${qs.length}q`);
}

// --------------------------------------------------------------------- report

type Ch = "graph" | "verbatim" | "union" | "product";

export async function report(args: { bench: string }): Promise<void> {
  const bench = args.bench;
  const dir = benchDir(bench);
  const parts = readdirSync(dir)
    .filter((f) => /^s-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

  const all = parts.flatMap((p) => p.questions as Array<Record<string, unknown>>);
  const hasStruct = (q: Record<string, unknown>) => (((q.gold as Record<string, unknown>).sessions as string[]).length + ((q.gold as Record<string, unknown>).turns as string[]).length) > 0;
  const hasText = (q: Record<string, unknown>) => ((((q.gold as Record<string, unknown>).text as string[]) ?? []).length) > 0;
  const scored = all.filter((q) => !q.abstention && (hasStruct(q) || hasText(q)));
  const nStruct = scored.filter(hasStruct).length;
  const nPresOnly = scored.length - nStruct;
  const absent = all.length - scored.length;

  const agg = (rows: Array<Record<string, unknown>>, ch: Ch) => {
    const num = (q: Record<string, unknown>, key: string) => (q[ch] as Record<string, unknown>)[key] as number | null;
    const nums = (key: string) => rows.map((q) => num(q, key)).filter((v): v is number => v != null);
    const mn = (xs: number[]) => (xs.length ? mean(xs) : null);
    return {
      n: rows.length,
      r1: mn(nums("r1")),
      r5: mn(nums("r5")),
      r10: mn(nums("r10")),
      r50: mn(nums("r50")),
      mrr: mn(nums("rr")),
      p1: mn(rows.map((q) => ((q[ch] as Record<string, unknown>).pres as Record<string, number> | null)?.p1 ?? NaN).filter((v) => !Number.isNaN(v))),
      p10: mn(rows.map((q) => ((q[ch] as Record<string, unknown>).pres as Record<string, number> | null)?.p10 ?? NaN).filter((v) => !Number.isNaN(v))),
      hasPresence: rows.some((q) => (q[ch] as Record<string, unknown>).pres != null),
      p50ms: pct(rows.map((q) => num(q, "ms") ?? 0), 0.5),
      p95ms: pct(rows.map((q) => num(q, "ms") ?? 0), 0.95),
    };
  };

  const lines: string[] = [];
  const ingTurns = parts.reduce((a, p) => a + p.ingest.turns, 0);
  const ingMs = parts.reduce((a, p) => a + p.ingest.ms, 0);
  lines.push(`${bench} — Chronos-Palace v4.1 · retrieval level · ${parts.length} samples · ${all.length} questions (${scored.length} scoreable: ${nStruct} structural + ${nPresOnly} presence-only; ${absent} without gold)`);
  lines.push(`ingested: ${ingTurns} turns → ${parts.reduce((a, p) => a + p.ingest.edges, 0)} edges / ${parts.reduce((a, p) => a + p.ingest.l3Rows, 0)} L3 rows (${r1(ingMs)}ms total)\n`);
  lines.push(`note: r1..r50 here = fraction of required gold EVIDENCE items (turns/sessions) found in top-k of retrieved turns.`);
  lines.push(``);
  const pc = (v: number | null) => (v == null || Number.isNaN(v) ? "—" : `${r1(v * 100)}%`);
  lines.push(`| channel | R@1 | R@5 | R@10 | R@50 | MRR | p50 ms | p95 ms |`);
  lines.push(`|---------|----:|----:|-----:|-----:|----:|-------:|-------:|`);
  for (const ch of ["graph", "verbatim", "union", "product"] as Ch[]) {
    const a = agg(scored, ch);
    const r50 = ch === "graph" || ch === "verbatim" ? pc(a.r50) : "—";
    lines.push(`| ${ch.padEnd(7)} | ${pc(a.r1)} | ${pc(a.r5)} | ${pc(a.r10)} | ${r50} | ${a.mrr == null || Number.isNaN(a.mrr) ? "—" : r1(a.mrr)} | ${r1(a.p50ms, 2)} | ${r1(a.p95ms, 2)} |`);
  }

  // presence table when the bench provides answer strings
  const anyPres = (["graph", "verbatim", "product"] as Ch[]).some((ch) => agg(scored, ch).hasPresence);
  if (anyPres) {
    lines.push(`\nanswer-string presence (weak proxy: fraction of gold answer strings visible in the retrieved context):`);
    lines.push(`| channel | P@1 | P@10 |`);
    lines.push(`|---------|----:|-----:|`);
    for (const ch of ["graph", "verbatim", "union", "product"] as Ch[]) {
      const a = agg(scored, ch);
      lines.push(`| ${ch.padEnd(7)} | ${r1(a.p1 * 100)}% | ${r1(a.p10 * 100)}% |`);
    }
  }

  // v5.0 — presence-exclusion accounting: answer strings absent from the whole
  // corpus are unanswerable; they leave the denominator above.
  const presX = all.filter((q) => q.presX).length;
  if (anyPres || presX) {
    lines.push(`presence proxy: ${presX}/${all.length} questions excluded (no gold answer string occurs anywhere in the corpus)`);
  }

  // v4.1 invariant: the merged union / product packet must never lose to the
  // best single channel (max of graph, verbatim) — checked on real output.
  {
    const aG = agg(scored, "graph");
    const aV = agg(scored, "verbatim");
    const aU = agg(scored, "union");
    const aP = agg(scored, "product");
    const fmt = (v: number | null) => (v == null || Number.isNaN(v) ? "—" : `${r1(v * 100)}%`);
    const eps = 5e-4;
    if (nStruct > 0 && aG.r10 != null && aV.r10 != null) {
      const bar = Math.max(aG.r10, aV.r10);
      lines.push(
        `\npareto check (v4.1): union R@10 ${fmt(aU.r10)} ≥ max(graph ${fmt(aG.r10)}, verbatim ${fmt(aV.r10)}) → ${(aU.r10 ?? 0) >= bar - eps ? "PASS" : "FAIL"}; product R@10 ${fmt(aP.r10)} → ${(aP.r10 ?? 0) >= bar - eps ? "PASS" : "FAIL"}`,
      );
    } else if (aG.p10 != null && aV.p10 != null && aP.p10 != null) {
      const bar = Math.max(aG.p10, aV.p10);
      lines.push(
        `\npareto check (v4.1, presence): union P@10 ${fmt(aU.p10)} / product P@10 ${fmt(aP.p10)} ≥ max(graph ${fmt(aG.p10)}, verbatim ${fmt(aV.p10)}) → union ${(aU.p10 ?? 0) >= bar - eps ? "PASS" : "FAIL"}, product ${(aP.p10 ?? 0) >= bar - eps ? "PASS" : "FAIL"}`,
      );
    }
  }

  // per question type
  const types = [...new Set(scored.map((q) => q.type as string))].sort();
  if (types.length > 1) {
    lines.push(`\nper type (R@10 / MRR):`);
    lines.push(`| type | n | graph | verbatim | union | product |`);
    lines.push(`|------|--:|------:|---------:|------:|--------:|`);
    for (const t of types) {
      const rows = scored.filter((q) => q.type === t);
      const cells = (["graph", "verbatim", "union", "product"] as Ch[]).map((ch) => {
        const a = agg(rows, ch);
        if (a.r10 != null && !Number.isNaN(a.r10)) return `${pc(a.r10)} / ${r1(a.mrr)}`;
        if (a.hasPresence && a.p10 != null && !Number.isNaN(a.p10)) return `P@10 ${pc(a.p10)}`;
        return "—";
      });
      lines.push(`| ${t} | ${rows.length} | ${cells.join(" | ")} |`);
    }
  }

  const pTok = all.map((q) => (q.product as Record<string, unknown>).tokens as number).filter((v) => v != null);
  const empty = all.filter((q) => String((q.product as Record<string, unknown>).text ?? "").startsWith("[CHRONOS|recall] nothing remembered")).length;
  lines.push(`\nproduct packet: mean ${r1(mean(pTok), 1)} tok · p95 ${pct(pTok, 0.95)} tok · "nothing remembered": ${empty}/${all.length}`);

  mkdirSync(join(PUB, "results"), { recursive: true });
  const out = { bench, stamp: nowStamp(), samples: parts.length, questions: all.length, scored: scored.length, aggregate: { graph: agg(scored, "graph"), verbatim: agg(scored, "verbatim"), union: agg(scored, "union"), product: { ...agg(scored, "product"), tokensMean: mean(pTok), tokensP95: pct(pTok, 0.95) } }, lines };
  const file = join(PUB, "results", `${bench}-${out.stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  writeFileSync(join(PUB, "results", `${bench}-latest.json`), JSON.stringify(out, null, 1));
  writeFileSync(join(PUB, "results", `${bench}-report.md`), `# ${bench} × Chronos-Palace v4\n\n_${new Date().toISOString()}_\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  console.log("\n" + lines.join("\n") + `\n\n→ ${file}`);
}
