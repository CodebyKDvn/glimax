// ===========================================================================
// fast_diag.ts — rapid failure autopsy for the seven retention benchmarks.
//
//   bun run benchmark/fast_diag.ts                 # fixed subset, reuse brains
//   bun run benchmark/fast_diag.ts --fresh         # re-ingest the subset
//   bun run benchmark/fast_diag.ts --bench locomo,mab
//   bun run benchmark/fast_diag.ts --child --bench locomo --sample conv-26 --n 60
//
// It runs the REAL retrieval path (`lib.ask`: graph T-RRF + L3 hybrid + union
// + product) over a fixed, stratified subset of each benchmark and prints, for
// every bench: channel R@10 / P@10, the union-vs-verbatim regressions, and the
// five worst questions with the exact gold evidence the top-10 missed and the
// rank at which that evidence actually sits (e.g. `D1:9 @ #14`, `not in 50`).
//
// One child process per sample: db.ts reads CHRONOS_BRAIN_PATH at load, and the
// harness isolates each benchmark brain in its own file. In reuse mode the
// parent-turn side tables are hydrated from the existing L3 vault, so retrieval
// can be re-tested without paying ingest again.
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  VERBATIM_BY_BENCH,
  ask,
  extractIds,
  hydrateFromBrainRows,
  ingest,
  type BrainL3Row,
  type Turn,
} from "./public/lib.ts";
import { buildFacts, buildTurns, loadData } from "./public/adapters/locomo.ts";
import { loadInstance } from "./public/adapters/prepared.ts";

const HERE = import.meta.dir; // <plugin>/benchmark
const PUB = join(HERE, "public");
const WORK = join(PUB, "work");
const DAY = 86_400_000;
const sanitize = (s: string) => s.replace(/[^\w.-]+/g, "_");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f1 = (n: number | null) => (n == null || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(1)}%`);

type ChName = "graph" | "verbatim" | "union" | "product";
const CHANNELS: ChName[] = ["graph", "verbatim", "union", "product"];

// ---------------------------------------------------------------- plan

interface PlanItem {
  bench: string;
  samples?: string[];
  take?: number;
  n: number;
}

// Fixed diagnostic subset: one or two representative brains per benchmark,
// spread across the question stream (dolphin/mab repeat one brain many times).
const PLAN: PlanItem[] = [
  { bench: "locomo", samples: ["conv-26", "conv-30"], n: 60 },
  { bench: "longmemeval", take: 30, n: 1 },
  { bench: "membench", take: 30, n: 1 },
  { bench: "memorybench", take: 30, n: 1 },
  { bench: "beam", samples: ["1", "2"], n: 20 },
  { bench: "dolphinbench", samples: ["alex", "morgan"], n: 60 },
  { bench: "mab", samples: ["AR-0", "AR-1", "TTL-0", "CR-0"], n: 40 },
];

interface Args {
  child: boolean;
  bench: string;
  sample?: string;
  n?: number;
  fresh: boolean;
  benches?: string[];
}

function parse(argv: string[]): Args {
  const a: Args = { child: false, bench: "", fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--child") a.child = true;
    else if (v === "--bench") a.bench = argv[++i] ?? "";
    else if (v === "--sample") a.sample = argv[++i] ?? "";
    else if (v === "--n") a.n = Number(argv[++i] ?? 0) || undefined;
    else if (v === "--fresh") a.fresh = true;
  }
  return a;
}

function spreadPick<T>(xs: T[], n: number): T[] {
  if (n >= xs.length) return xs.slice();
  const out: T[] = [];
  for (let j = 0; j < n; j++) out.push(xs[Math.floor((j * xs.length) / n)]);
  return out;
}

// ---------------------------------------------------------------- question types

interface DQ {
  qid: string;
  type: string;
  question: string;
  goldT: Set<string>;
  goldS: Set<string>;
  goldText: string[];
  abstention: boolean;
  selfTurn?: string;
  at?: number;
}

interface ChScore {
  r10: number | null;
  p10: number | null;
  miss: Array<{ g: string; rank: number | null }>;
  ids: string[];
  ids10: string[];
}

interface DiagRow {
  bench: string;
  sample: string;
  qid: string;
  type: string;
  question: string;
  abstention: boolean;
  scored: boolean;
  hasPresence: boolean;
  presX: boolean;
  /** presence is not a valid proxy for item-id answers (MAB TTL) */
  presUnscored: boolean;
  gold: { sessions: string[]; turns: string[]; text: string[] };
  graph: ChScore;
  verbatim: ChScore;
  union: ChScore;
  product: ChScore;
  unionTexts10: string[];
}

// ---------------------------------------------------------------- child

async function child(args: Args): Promise<void> {
  const bench = args.bench;
  const sample = args.sample as string;
  if (!bench || !sample) throw new Error("child needs --bench and --sample");
  const dir = join(WORK, bench);
  mkdirSync(dir, { recursive: true });
  const brain = join(dir, `brain-${sanitize(sample)}.sqlite`);
  process.env.CHRONOS_BRAIN_PATH = brain;

  const now = Date.now();
  let turns: Turn[] = [];
  let facts: Array<{ id: string; text: string; speaker?: string }> = [];
  let questions: DQ[] = [];
  const sessionOf = new Map<string, string>();

  if (bench === "locomo") {
    const sampleData = loadData().find((s) => s.sample_id === sample);
    if (!sampleData) throw new Error(`unknown locomo sample ${sample}`);
    turns = buildTurns(sampleData);
    facts = buildFacts(sampleData);
    questions = sampleData.qa.map((item, i) => {
      const gold = extractIds(item.evidence);
      return {
        qid: `${sample}-${i}`,
        type: `cat${item.category ?? 0}`,
        question: item.question,
        goldT: new Set(gold),
        goldS: new Set<string>(),
        goldText: [],
        abstention: false,
      };
    });
  } else {
    const inst = loadInstance(bench, sample);
    const anchorRaw = typeof inst.anchor === "string" ? Date.parse(inst.anchor) : NaN;
    turns = inst.turns.map((t) => ({
      id: t.id,
      session: t.session,
      speaker: t.speaker,
      text: t.text,
      ts: now + t.ts_off - DAY,
    }));
    facts = inst.facts ?? [];
    questions = inst.questions.map((q) => {
      const meta = (q.meta ?? {}) as Record<string, unknown>;
      const dateAt = typeof meta.date === "string" ? Date.parse(meta.date) : NaN;
      const at =
        Number.isFinite(dateAt) && Number.isFinite(anchorRaw) ? now + (dateAt - anchorRaw) - DAY : dateAt;
      return {
        qid: q.qid,
        type: q.type,
        question: q.question,
        goldT: new Set(q.gold_turns ?? []),
        goldS: new Set(q.gold_sessions ?? []),
        goldText: q.gold_text ?? [],
        abstention: !!meta.abstention,
        selfTurn: typeof meta.self_turn === "string" ? meta.self_turn : undefined,
        at: Number.isFinite(at) ? at : undefined,
      };
    });
  }
  for (const t of turns) sessionOf.set(t.id, t.session);

  const t0 = Bun.nanoseconds();
  let ingestMs = 0;
  let corpusNorm: string;
  if (args.fresh || !existsSync(brain)) {
    for (const p of [brain, brain + "-wal", brain + "-shm"]) rmSync(p, { force: true });
    const scopeName = `bench-${bench}-${sample}`;
    const scope = `project:${scopeName}`;
    const ing = await ingest(scope, sample, scopeName, turns, facts);
    ingestMs = ing.ms;
    corpusNorm = norm(turns.map((t) => t.text).join(" \n "));
  } else {
    const raw = new Database(brain, { readonly: true });
    const cols = raw.query("PRAGMA table_info(l3_verbatim_vault)").all() as Array<{ name: string }>;
    const hasTurn = cols.some((c) => c.name === "turn_id");
    const hasMeta = cols.some((c) => c.name === "meta_json");
    const rows = raw
      .query(
        `SELECT id, session_id, ${hasTurn ? "turn_id" : "NULL AS turn_id"}, raw_content,
                ${hasMeta ? "meta_json" : "NULL AS meta_json"}, timestamp
           FROM l3_verbatim_vault ORDER BY id`,
      )
      .all() as BrainL3Row[];
    raw.close();
    hydrateFromBrainRows(rows);
    for (const r of rows) {
      let tid = r.turn_id;
      let sess = r.session_id;
      if (hasMeta) {
        try {
          const m = JSON.parse(r.meta_json ?? "null") as { turn?: unknown; session?: unknown } | null;
          if (!tid && typeof m?.turn === "string") tid = m.turn;
          if (typeof m?.session === "string") sess = m.session;
        } catch {
          // meta is harness-owned; ignore malformed rows
        }
      }
      if (tid && !sessionOf.has(tid)) sessionOf.set(tid, sess);
    }
    corpusNorm = norm(rows.map((r) => r.raw_content).join(" \n "));
  }

  const scopeName = `bench-${bench}-${sample}`;
  const scope = `project:${scopeName}`;
  const picked = spreadPick(questions, args.n ?? questions.length);
  const rows: DiagRow[] = [];
  const tq = Bun.nanoseconds();

  for (const q of picked) {
    const goldT = q.goldT;
    const goldS = q.goldS;
    const scored = !q.abstention && (goldT.size > 0 || goldS.size > 0);
    const gtAll = q.goldText.map(norm).filter(Boolean);
    const gt = gtAll.filter((g) => corpusNorm.includes(g));
    const presX = gtAll.length > 0 && gt.length === 0;
    const presUnscored = bench === "mab" && q.type.startsWith("TTL");
    const out = await ask(q.question, scope, sample, scopeName, 50, q.at, {
      verbatim: (process.env.DIAG_VERBATIM as "hybrid" | "bm25" | "rrf" | undefined) ?? VERBATIM_BY_BENCH[bench],
    });
    const side = (texts: string[], k: number) => norm(texts.slice(0, k).join(" \n "));

    const score = (ids: string[], texts: string[]): ChScore => {
      const pairs = q.selfTurn
        ? ids.map((id, i) => [id, texts[i] ?? ""] as const).filter((p) => p[0] !== q.selfTurn)
        : ids.map((id, i) => [id, texts[i] ?? ""] as const);
      const cleanIds = pairs.map((p) => p[0]);
      const cleanTexts = pairs.map((p) => p[1]);
      const ids10 = cleanIds.slice(0, 10);
      let r10: number | null = null;
      const miss: Array<{ g: string; rank: number | null }> = [];
      if (scored) {
        const seen = new Set<string>();
        for (const id of ids10) {
          if (goldT.has(id)) seen.add(id);
          else {
            const s = sessionOf.get(id);
            if (s && goldS.has(s)) seen.add(s);
          }
        }
        const need = new Set<string>([...goldT, ...goldS]);
        r10 = need.size ? seen.size / need.size : null;
        for (const g of goldS) {
          const i = cleanIds.findIndex((id) => sessionOf.get(id) === g);
          miss.push({ g: `session:${g}`, rank: i < 0 ? null : i + 1 });
        }
        for (const g of goldT) {
          const i = cleanIds.indexOf(g);
          miss.push({ g: `turn:${g}`, rank: i < 0 ? null : i + 1 });
        }
      }
      let p10: number | null = null;
      if (gt.length) {
        const j10 = side(cleanTexts, 10);
        p10 = gt.filter((g) => j10.includes(g)).length / gt.length;
        for (const g of gt) {
          let rank: number | null = null;
          for (let i = 0; i < cleanTexts.length; i++) {
            if (norm(cleanTexts[i]).includes(g)) {
              rank = i + 1;
              break;
            }
          }
          miss.push({ g: `text:${g}`, rank });
        }
      }
      return { r10, p10, miss, ids: cleanIds, ids10 };
    };

    rows.push({
      bench,
      sample,
      qid: q.qid,
      type: q.type,
      question: q.question,
      abstention: q.abstention,
      scored,
      hasPresence: gt.length > 0,
      presX,
      presUnscored,
      gold: {
        sessions: [...goldS],
        turns: [...goldT],
        text: q.goldText,
      },
      graph: score(out.graph.ids, out.graph.texts),
      verbatim: score(out.verbatim.ids, out.verbatim.texts),
      union: score(out.union.ids, out.union.texts),
      product: score(out.product.ids, out.product.texts),
      unionTexts10: out.union.texts.slice(0, 10).map((t) => t.replace(/\s+/g, " ").slice(0, 110)),
    });
  }

  const file = join(dir, `diag-${sanitize(sample)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      bench,
      sample,
      ingestMs,
      qaTotal: questions.length,
      qaRun: rows.length,
      ms: (Bun.nanoseconds() - t0) / 1e6,
      qMs: (Bun.nanoseconds() - tq) / 1e6,
      rows,
    }),
  );
  console.log(
    `[diag] ${bench}/${sample}: ${rows.length}q · ingest ${ingestMs ? `${Math.round(ingestMs)}ms` : "reused"} · ask ${Math.round((Bun.nanoseconds() - tq) / 1e6)}ms`,
  );
}

// ---------------------------------------------------------------- parent

interface Part {
  bench: string;
  sample: string;
  ingestMs: number;
  qaTotal: number;
  qaRun: number;
  rows: DiagRow[];
}

function agg(rows: DiagRow[], ch: ChName) {
  const vals = rows.map((r) => r[ch]);
  return {
    r10: mean(vals.map((v) => v.r10).filter((v): v is number => v != null)),
    p10: mean(rows.filter((r) => !r.presUnscored).map((r) => r[ch].p10).filter((v): v is number => v != null)),
  };
}

/** Rank of a gold id (or any turn of a gold session) in a full channel list. */
function goldRank(ids: string[], g: string): number | null {
  if (g.startsWith("session:")) {
    const s = g.slice(8);
    const i = ids.findIndex((id) => id === s || id.startsWith(s + "#") || id.startsWith(s + ":"));
    return i < 0 ? null : i + 1;
  }
  const id = g.replace(/^turn:/, "").replace(/^text:/, "");
  const i = ids.indexOf(id);
  return i < 0 ? null : i + 1;
}

function listSamples(item: PlanItem): string[] {
  if (item.samples) return item.samples;
  const cfg = JSON.parse(readFileSync(join(WORK, item.bench, "config.json"), "utf8"));
  return spreadPick(cfg.ordered as string[], item.take ?? 20);
}

function fmtQuestion(q: string, n = 150): string {
  const s = q.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function parent(args: Args): Promise<void> {
  const only = args.benches?.length ? new Set(args.benches) : null;
  const plans = PLAN.filter((p) => !only || only.has(p.bench));
  const summary: Array<Record<string, unknown>> = [];
  mkdirSync(WORK, { recursive: true });

  for (const item of plans) {
    const samples = listSamples(item);
    const n = args.n ?? item.n;
    const diagFiles: string[] = [];
    for (const s of samples) {
      const f = join(WORK, item.bench, `diag-${sanitize(s)}.json`);
      rmSync(f, { force: true });
    }
    console.log(`[diag] ${item.bench}: ${samples.length} brain(s) × ${n} q${args.fresh ? " (fresh)" : ""}`);
    for (const s of samples) {
      const cmd = [
        process.execPath,
        import.meta.path,
        "--child",
        "--bench",
        item.bench,
        "--sample",
        s,
        "--n",
        String(n),
      ];
      if (args.fresh) cmd.push("--fresh");
      const r = Bun.spawnSync({ cmd, cwd: HERE, stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) throw new Error(`diag child failed: ${item.bench}/${s} (exit ${r.exitCode})`);
      diagFiles.push(join(WORK, item.bench, `diag-${sanitize(s)}.json`));
    }
    const parts: Part[] = diagFiles.filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
    const rows = parts.flatMap((p) => p.rows);

    const structural = rows.filter((r) => r.scored);
    const presence = rows.filter((r) => r.hasPresence && !r.presUnscored);
    const g = agg(rows, "graph");
    const v = agg(rows, "verbatim");
    const u = agg(rows, "union");
    const p = agg(rows, "product");
    const regressV = structural.filter((r) => (r.union.r10 ?? 0) < (r.verbatim.r10 ?? 0) - 1e-9).length;
    const regressP = structural.filter((r) => (r.product.r10 ?? 0) < (r.union.r10 ?? 0) - 1e-9).length;
    const oracle = structural.length
      ? mean(
          structural.map((r) =>
            Math.min(1, 10 / Math.max(1, r.gold.turns.length + r.gold.sessions.length)),
          ),
        )
      : null;

    console.log(
      `\n┌─ ${item.bench.toUpperCase()} · ${rows.length} q (${structural.length} structural, ${presence.length} presence) · ${samples.length} brains`,
    );
    console.log(
      `│ graph ${f1(g.r10)}${g.p10 != null ? ` / P ${f1(g.p10)}` : ""} · verbatim ${f1(v.r10)}${v.p10 != null ? ` / P ${f1(v.p10)}` : ""} · union ${f1(u.r10)}${u.p10 != null ? ` / P ${f1(u.p10)}` : ""} · product ${f1(p.r10)}${p.p10 != null ? ` / P ${f1(p.p10)}` : ""}`,
    );
    if (oracle != null) {
      console.log(`│ oracle R@10 ceiling ${f1(oracle)} (gold evidence per question ≤ 10)`);
    }
    if (structural.length) {
      console.log(`│ union < verbatim: ${regressV}/${structural.length} q · product < union: ${regressP}/${structural.length} q`);
    }
    const unscoredPres = rows.filter((r) => r.presUnscored).length;
    if (unscoredPres) {
      console.log(`│ ${unscoredPres} TTL/qa excluded from presence: answers are MovieLens item ids, not corpus strings`);
    }

    // per type
    const types = [...new Set(rows.map((r) => r.type))].sort();
    if (types.length > 1) {
      console.log(`│ type                       n    graph   verb   union   prod${presence.length ? "  uP@10" : ""}`);
      for (const t of types) {
        const rs = rows.filter((r) => r.type === t);
        const a = agg(rs, "graph");
        const b = agg(rs, "verbatim");
        const c = agg(rs, "union");
        const d = agg(rs, "product");
        console.log(
          `│ ${t.slice(0, 24).padEnd(24)} ${String(rs.length).padStart(3)}  ${f1(a.r10).padStart(6)} ${f1(b.r10).padStart(6)} ${f1(c.r10).padStart(6)} ${f1(d.r10).padStart(6)}${presence.length ? `  ${f1(c.p10)}` : ""}`,
        );
      }
    }

    // five worst failures (union structural, else presence)
    const fails = structural
      .filter((r) => (r.union.r10 ?? 1) < 1)
      .sort((a, b) => (a.union.r10 ?? 0) - (b.union.r10 ?? 0));
    const pfails = presence
      .filter((r) => (r.union.p10 ?? 1) < 1)
      .sort((a, b) => (a.union.p10 ?? 0) - (b.union.p10 ?? 0));
    const worst = (fails.length ? fails : pfails).slice(0, 5);
    if (worst.length) {
      console.log(`│\n│ worst ${worst.length} (gold evidence missed by union top-10):`);
      for (const r of worst) {
        console.log(`│  ✗ ${r.qid} [${r.type}] ${fmtQuestion(r.question)}`);
        const gold = [
          r.gold.turns.length ? `turns ${r.gold.turns.join(",")}` : "",
          r.gold.sessions.length ? `sessions ${r.gold.sessions.join(",")}` : "",
          r.gold.text.length ? `text ${r.gold.text.slice(0, 3).join(" | ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        console.log(`│    gold: ${gold}`);
        const missT = r.union.miss.filter((m) => m.rank == null || m.rank > 10);
        if (missT.length) {
          const lines = missT.slice(0, 6).map((m) => {
            const vr = goldRank(r.verbatim.ids, m.g);
            const gr = goldRank(r.graph.ids, m.g);
            const ur = goldRank(r.union.ids, m.g);
            return `${m.g} → verb ${vr ? `#${vr}` : ">50"} · graph ${gr ? `#${gr}` : ">50"} · union ${ur ? `#${ur}` : ">12"}`;
          });
          console.log(`│    missed: ${lines.join(" · ")}`);
        }
        if (r.hasPresence && !r.scored) {
          const hit = r.union.miss.filter((m) => m.rank != null && m.rank <= 10).length;
          const tot = r.union.miss.length;
          console.log(`│    presence: ${hit}/${tot} gold strings in union top-10`);
        }
        console.log(
          `│    union top10: ${r.union.ids10
            .map((id, i) => {
              const t = r.unionTexts10[i] ?? "";
              return `${i + 1}.${id}(${t.slice(0, 42)}${t.length > 42 ? "…" : ""})`;
            })
            .join(" ")}`,
        );
      }
    }
    console.log(`└─`);

    summary.push({
      bench: item.bench,
      samples,
      n,
      questions: rows.length,
      structural: structural.length,
      presence: presence.length,
      channels: { graph: g, verbatim: v, union: u, product: p },
      unionBelowVerbatim: regressV,
      productBelowUnion: regressP,
    });
  }

  writeFileSync(join(WORK, "diag-summary.json"), JSON.stringify({ stamp: new Date().toISOString(), plan: summary }, null, 1));
  console.log(`\n[diag] summary → ${join(WORK, "diag-summary.json")}`);
}

// ---------------------------------------------------------------- entry

const args = parse(Bun.argv.slice(2));
if (args.child) {
  await child(args);
} else {
  // --bench accepts a comma list for the parent; the child always gets one.
  args.benches = args.bench ? args.bench.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  await parent(args);
}
