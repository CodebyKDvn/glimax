// ===========================================================================
// adapters/locomo.ts — LoCoMo (ACL 2024, Snap Research) on Chronos-Palace v4.
//
// Data: data/locomo10.json — 10 conversations, 1,986 QA pairs with turn-level
// evidence ids (dia_id "D<session>:<turn>"). Questions are asked "after the
// conversation", so retrieval is scored against the real gold evidence.
//
// Retrieval-level protocol (no LLM):
//   R@k / MRR over gold dia_ids for three real channels of the plugin:
//     graph     → retriever.search() (T-RRF, top-50)
//     verbatim  → l3SearchBm25 + l3SearchTrigram (top-50 each, merged)
//     product   → runChronos(mode=recall) packet, as the model would see it
//
// Time normalization: sessions are re-anchored so the last session is ~1 day
// old, preserving order and one-session-per-day spacing. Decay in the
// retriever is therefore active the way it is in real use. Documented in the
// report; raw corpus dates are 2023 and would decay to ~0 for every edge.
// ===========================================================================

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DAY, VERBATIM_BY_BENCH, ask, ingest, mean, pct, r1, recallAt, rr, extractIds, nowStamp, type Turn } from "../lib";

const HERE = import.meta.dir; // benchmark/public/adapters
const PUB = join(HERE, "..");
const DATA = join(PUB, "data", "locomo10.json");
const WORK = join(PUB, "work", "locomo");
const RESULTS = join(PUB, "results");

const CAT: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

interface QaRow {
  question: string;
  evidence?: unknown;
  category?: number;
  answer?: unknown;
  adversarial_answer?: unknown;
}

export interface Sample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: QaRow[];
  observation?: Record<string, Record<string, Array<[string, string]>>>;
}

export function loadData(): Sample[] {
  if (!existsSync(DATA)) throw new Error(`missing ${DATA} — run download.sh`);
  return JSON.parse(readFileSync(DATA, "utf8")) as Sample[];
}

export function listSamples(): string[] {
  return loadData().map((s) => s.sample_id);
}

/** turns of one conversation, re-anchored so the last session is ~1 day old */
export function buildTurns(sample: Sample): Turn[] {
  const conv = sample.conversation;
  const sessKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const base = Date.now() - (sessKeys.length + 1) * DAY;
  const turns: Turn[] = [];
  sessKeys.forEach((sk, i) => {
    const arr = conv[sk] as Array<{ dia_id?: string; speaker?: string; text?: string }>;
    (arr ?? []).forEach((t, j) => {
      if (!t?.text || !t?.dia_id) return;
      turns.push({
        id: t.dia_id,
        session: sk,
        speaker: t.speaker ?? "?",
        text: t.text,
        ts: base + i * DAY + j * 60_000,
      });
    });
  });
  return turns;
}

/**
 * v6.0 — the dataset ships a fact layer (`observation`) whose statements are
 * already linked to their source dia_id. Index it in the separate fact ledger:
 * query -> clean fact statement -> source turn id. The raw turn stays intact,
 * so BM25 is not diluted by the extra prose.
 */
export function buildFacts(sample: Sample): Array<{ id: string; text: string; speaker: string }> {
  const out: Array<{ id: string; text: string; speaker: string }> = [];
  for (const bySpeaker of Object.values(sample.observation ?? {})) {
    for (const [speaker, facts] of Object.entries(bySpeaker ?? {})) {
      for (const [text, dia] of facts ?? []) {
        if (!text || !dia) continue;
        out.push({ id: String(dia), text: `${speaker}: ${text}`, speaker });
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------- worker

export async function worker(args: { sample: string; limit?: number }): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const sample = loadData().find((s) => s.sample_id === args.sample);
  if (!sample) throw new Error(`unknown locomo sample ${args.sample}`);

  const scopeName = `bench-locomo-${sample.sample_id}`;
  const scope = `project:${scopeName}`;
  const turns = buildTurns(sample);
  const facts = buildFacts(sample);
  const ing = await ingest(scope, sample.sample_id, scopeName, turns, facts);

  const qa = args.limit ? sample.qa.slice(0, args.limit) : sample.qa;
  const rows: unknown[] = [];
  for (const item of qa) {
    const gold = extractIds(item.evidence);
    const out = await ask(item.question, scope, sample.sample_id, scopeName, 50, undefined, {
      verbatim: VERBATIM_BY_BENCH.locomo,
    });
    const { graph, verbatim, product } = out;
    const ch = (ids: string[], ms: number, extra: Record<string, unknown> = {}) => ({
      r1: recallAt(ids, gold, 1),
      r5: recallAt(ids, gold, 5),
      r10: recallAt(ids, gold, 10),
      r50: recallAt(ids, gold, 50),
      all: gold.length ? (ids.some((i) => gold.includes(i)) ? 1 : 0) : null,
      rr: gold.length ? rr(ids, gold) : null,
      ms,
      n: ids.length,
      ...extra,
    });
    // union: v4.1 agreement-calibrated Pareto merge (graph + verbatim heads)
    const unionIds = out.union.ids;
    rows.push({
      q: item.question,
      category: item.category ?? 0,
      gold,
      graph: ch(graph.ids, graph.ms, { ctxTokens: graph.ctxTokens, top10: graph.ids.slice(0, 10) }),
      verbatim: ch(verbatim.ids, verbatim.ms, { top10: verbatim.ids.slice(0, 10) }),
      union: ch(unionIds, out.union.ms, { top12: unionIds.slice(0, 12) }),
      product: ch(product.ids, product.ms, { tokens: product.tokens, top10: product.ids.slice(0, 10), text: product.text.slice(0, 600) }),
    });
  }

  const part = {
    sample: sample.sample_id,
    sessions: Object.keys(sample.conversation).filter((k) => /^session_\d+$/.test(k)).length,
    ingest: ing,
    qaTotal: sample.qa.length,
    qaRun: qa.length,
    questions: rows,
  };
  writeFileSync(join(WORK, `s-${sample.sample_id}.json`), JSON.stringify(part, null, 1));
  console.log(`[locomo] ${sample.sample_id}: ${ing.turns} turns → ${ing.edges} edges / ${ing.l3Rows} L3 rows in ${r1(ing.ms)}ms; ${qa.length} questions asked`);
}

// --------------------------------------------------------------------- report

type Ch = "graph" | "verbatim" | "union" | "product";

export async function report(): Promise<void> {
  const parts = readdirSync(WORK)
    .filter((f) => /^s-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(WORK, f), "utf8")));

  const all = parts.flatMap((p) => p.questions as Array<Record<string, unknown>>);
  const scored = all.filter((q) => (q.gold as string[]).length > 0);

  const agg = (rows: Array<Record<string, unknown>>, ch: Ch) => {
    const get = (q: Record<string, unknown>, key: string) => (q[ch] as Record<string, unknown>)[key] as number | null;
    const nums = (key: string) => rows.map((q) => get(q, key)).filter((v): v is number => v != null);
    return {
      n: rows.length,
      r1: mean(nums("r1")),
      r5: mean(nums("r5")),
      r10: mean(nums("r10")),
      r50: mean(nums("r50")),
      all: mean(nums("all")),
      mrr: mean(nums("rr")),
      p50ms: pct(rows.map((q) => get(q, "ms") ?? 0), 0.5),
      p95ms: pct(rows.map((q) => get(q, "ms") ?? 0), 0.95),
    };
  };

  const catAgg = (ch: Ch, cat: number) => agg(scored.filter((q) => q.category === cat), ch);

  const lines: string[] = [];
  lines.push(`LoCoMo — Chronos-Palace v4.1 · retrieval level · ${parts.length} conversations · ${all.length} questions (${scored.length} with gold evidence)`);
  const ingTot = parts.reduce((a, p) => a + p.ingest.turns, 0);
  const ingMs = parts.reduce((a, p) => a + p.ingest.ms, 0);
  lines.push(`ingested: ${ingTot} turns → ${parts.reduce((a, p) => a + p.ingest.edges, 0)} edges / ${parts.reduce((a, p) => a + p.ingest.l3Rows, 0)} L3 rows (${r1(ingMs)}ms total)\n`);

  lines.push(`| channel | R@1 | R@5 | R@10 | R@50 ¹ | ANY ² | MRR | p50 ms | p95 ms |`);
  lines.push(`|---------|----:|----:|-----:|------:|------:|----:|-------:|-------:|`);
  for (const ch of ["graph", "verbatim", "union", "product"] as Ch[]) {
    const a = agg(scored, ch);
    const r50 = ch === "graph" || ch === "verbatim" ? `${r1(a.r50 * 100)}%` : "—";
    lines.push(`| ${ch.padEnd(7)} | ${r1(a.r1 * 100)}% | ${r1(a.r5 * 100)}% | ${r1(a.r10 * 100)}% | ${r50} | ${r1(a.all * 100)}% | ${r1(a.mrr)} | ${r1(a.p50ms, 2)} | ${r1(a.p95ms, 2)} |`);
  }
  lines.push(`\n¹ graph/verbatim = top-50 rankers. ² ANY = gold present anywhere in what the channel returned. union = v4.1 agreement-calibrated Pareto merge of graph+verbatim (top-16; R@10 over its head); product = the v4.1 evidence-slice packet.`);

  lines.push(`\nper category (R@10):`);
  lines.push(`| category | n | graph | verbatim | union | product |`);
  lines.push(`|----------|--:|------:|---------:|------:|--------:|`);
  for (const c of [1, 2, 3, 4, 5]) {
    const rows = scored.filter((q) => q.category === c);
    if (!rows.length) continue;
    const g = catAgg("graph", c);
    const v = catAgg("verbatim", c);
    const u = catAgg("union", c);
    const p = catAgg("product", c);
    lines.push(`| ${c} ${CAT[c]} | ${rows.length} | ${r1(g.r10 * 100)}% | ${r1(v.r10 * 100)}% | ${r1(u.r10 * 100)}% | ${r1(p.r10 * 100)}% |`);
  }

  const pTok = all.map((q) => (q.product as Record<string, unknown>).tokens as number).filter((v) => v != null);
  const pAny = scored.map((q) => (q.product as Record<string, unknown>).all as number | null).filter((v): v is number => v != null);
  const empty = all.filter((q) => ((q.product as Record<string, unknown>).text as string).startsWith("[CHRONOS|recall] nothing remembered")).length;

  // v4.1 invariant: merged union / product packet must not lose to the best
  // single channel (max of graph, verbatim) — checked on real output.
  {
    const aG = agg(scored, "graph");
    const aV = agg(scored, "verbatim");
    const aU = agg(scored, "union");
    const aP = agg(scored, "product");
    const bar = Math.max(aG.r10, aV.r10);
    lines.push(
      `\npareto check (v4.1): union R@10 ${r1(aU.r10 * 100)}% ≥ max(graph ${r1(aG.r10 * 100)}%, verbatim ${r1(aV.r10 * 100)}%) → ${aU.r10 >= bar - 5e-4 ? "PASS" : "FAIL"}; product R@10 ${r1(aP.r10 * 100)}% → ${aP.r10 >= bar - 5e-4 ? "PASS" : "FAIL"}`,
    );
  }
  lines.push(`\nproduct packet: mean ${r1(mean(pTok), 1)} tok · p95 ${pct(pTok, 0.95)} tok · carries ≥1 gold turn: ${r1(mean(pAny) * 100)}% · "nothing remembered": ${empty}/${all.length}`);

  const out = { bench: "locomo", stamp: nowStamp(), samples: parts.length, questions: all.length, scored: scored.length, aggregate: { graph: agg(scored, "graph"), verbatim: agg(scored, "verbatim"), union: agg(scored, "union"), product: { ...agg(scored, "product"), tokensMean: mean(pTok), tokensP95: pct(pTok, 0.95) } }, lines };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `locomo-${out.stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  writeFileSync(join(RESULTS, "locomo-latest.json"), JSON.stringify(out, null, 1));

  const md = lines.join("\n");
  console.log("\n" + md + `\n\n→ ${file}`);
  writeFileSync(join(RESULTS, "locomo-report.md"), `# LoCoMo × Chronos-Palace v4\n\n_${new Date().toISOString()}_\n\n\`\`\`\n${md}\n\`\`\`\n`);
}
