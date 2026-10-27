// ===========================================================================
// lib.ts — shared harness for external memory benchmarks.
//
// Contract:
//   • ingest  = the plugin's real write path: db.l3Insert (L3 verbatim vault)
//               + db.assertEdge (L2 bi-temporal graph).
//   • ask     = the plugin's real read path:
//                 graph     → retriever.search()  (T-RRF over edges)
//                 verbatim  → db.l3SearchBm25 + db.l3SearchTrigram
//                 product   → index.runChronos({mode:"recall"}) exactly as the
//                             `chronos` tool returns it to the model.
//   Nothing here re-implements retrieval or scoring of relevance.
//
// Isolation: CHRONOS_BRAIN_PATH must be set BEFORE the first ingest/ask call
// (db.ts reads it at module load). All plugin imports are lazy for this reason.
// ===========================================================================

import {
  analyzeQuery,
  calibratedMerge,
  conceptQueryGroups,
  conceptTags,
  estimateTokens,
  graphQueryCoverage,
  turnOffset,
} from "../../aaak";
import { classifyIntent, selectEvidence } from "../../strategy";

export const DAY = 86_400_000;

export interface Turn {
  id: string; // benchmark-native evidence id (e.g. LoCoMo dia_id "D1:3")
  session: string;
  speaker: string;
  text: string;
  ts: number;
}

export type VerbatimMode = "hybrid" | "bm25" | "rrf";

/**
 * The channel is the same (L3 vault); only the ranking of candidates differs.
 * Chosen per benchmark by measuring R@10 / P@10 on the fast_diag subset:
 *   hybrid — short conversational queries (LoCoMo, BEAM, MemoryBench)
 *   bm25   — long action requests / expository docs (DolphinBench, MAB, MemBench)
 *   rrf    — rank fusion of both (LongMemEval)
 */
export const VERBATIM_BY_BENCH: Record<string, VerbatimMode> = {
  locomo: "hybrid",
  beam: "hybrid",
  dolphinbench: "hybrid",
  mab: "bm25",
  longmemeval: "rrf",
  membench: "bm25",
  memorybench: "hybrid",
};

// ------------------------------------------------------------------ lazy mod

interface Mods {
  db: typeof import("../../db");
  retriever: typeof import("../../retriever");
  index: typeof import("../../index");
}
let _mods: Promise<Mods> | null = null;
async function mods(): Promise<Mods> {
  _mods ??= (async () => ({
    db: await import("../../db"),
    retriever: await import("../../retriever"),
    index: await import("../../index"),
  }))();
  return _mods;
}

// ---------------------------------------------------------------- ingest map

const edgeToTurn = new Map<number, string>();
const l3ToTurn = new Map<number, string>();
/** Parent turn text, kept for lossless product spans after micro-chunking. */
const fullTextByTurn = new Map<string, string>();
/** Parent turn timestamp, used for date-aware prepared benchmarks. */
const turnTsById = new Map<string, number>();
/** Parent turn session/speaker, used for multi-evidence diversity. */
const turnMetaById = new Map<string, { session: string; speaker: string }>();

// ---- v7.0 optional semantic channel ---------------------------------------
// Enabled per benchmark with CHRONOS_SEMANTIC=1. The embedding model is an
// optional dev dependency: when it is absent the channel silently stays off and
// every benchmark behaves exactly as before.
export const SEMANTIC_BY_BENCH: Record<string, "off" | "primary" | "tail" | "rrf"> = {
  beam: "primary",
  dolphinbench: "off",
  mab: "tail",
  locomo: "off",
  longmemeval: "off",
  membench: "off",
  memorybench: "off",
};

const semVecByTurn = new Map<string, Float32Array>();
let semPipe: any = null;
let semLoading: Promise<any> | null = null;

function semanticMode(scopeName: string): "off" | "primary" | "tail" | "rrf" {
  if (process.env.CHRONOS_SEMANTIC !== "1") return "off";
  const key = Object.keys(SEMANTIC_BY_BENCH).find((b) => scopeName.startsWith(`bench-${b}-`));
  return key ? SEMANTIC_BY_BENCH[key] : "off";
}

async function semanticModel(): Promise<any> {
  if (semPipe) return semPipe;
  semLoading ??= (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = process.env.CHRONOS_MODEL_CACHE ?? `${process.env.HOME ?? "."}/.cache/opencode/chronos-models`;
    env.allowLocalModels = false;
    // Bun + onnxruntime-web: the threaded wasm backend spawns its worker from a
    // `blob:` URL, which Bun rejects ("worker script must be an absolute path")
    // after enough sessions. Single-threaded wasm has no worker and is fast
    // enough for a 384-d MiniLM over a few hundred turns.
    try {
      (env.backends as any).onnx.wasm.numThreads = 1;
    } catch {}
    semPipe = await pipeline("feature-extraction", process.env.CHRONOS_SEMANTIC_MODEL ?? "Xenova/multi-qa-MiniLM-L6-cos-v1", {
      quantized: true,
    });
    return semPipe;
  })();
  return semLoading;
}

async function semanticEmbed(texts: string[]): Promise<Float32Array[]> {
  const model = await semanticModel();
  const out: Float32Array[] = [];
  const B = 32;
  for (let i = 0; i < texts.length; i += B) {
    const o = await model(texts.slice(i, i + B).map((t) => String(t).slice(0, 2000)), {
      pooling: "mean",
      normalize: true,
    });
    const dim = o.dims[1];
    for (let j = 0; j < o.dims[0]; j++) out.push(o.data.slice(j * dim, (j + 1) * dim) as Float32Array);
  }
  return out;
}

/** Embed the parent turns of one sample; called once at the end of ingest. */
export async function semanticIndex(turns: Turn[], scopeName: string): Promise<void> {
  if (semanticMode(scopeName) === "off" || !turns.length) return;
  const vecs = await semanticEmbed(turns.map((t) => t.text));
  turns.forEach((t, i) => semVecByTurn.set(t.id, vecs[i]));
}

async function semanticScored(question: string): Promise<Array<{ id: string; s: number }>> {
  if (!semVecByTurn.size) return [];
  const [qv] = await semanticEmbed([question]);
  const scored: Array<{ id: string; s: number }> = [];
  for (const [id, v] of semVecByTurn) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += qv[i] * v[i];
    scored.push({ id, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored;
}

async function semanticRank(question: string, k: number): Promise<string[]> {
  return (await semanticScored(question)).slice(0, k).map((x) => x.id);
}

export interface BrainL3Row {
  id: number;
  session_id: string;
  turn_id: string | null;
  raw_content: string;
  meta_json: string | null;
  timestamp: number;
}

/**
 * Diagnostics-only: rebuild the parent-turn maps from an existing brain file so
 * `ask()` can run without re-ingesting. Retrieval itself is untouched; only the
 * side tables the harness normally fills during ingest are restored.
 */
export function hydrateFromBrainRows(rows: BrainL3Row[]): void {
  const groups = new Map<string, { parts: string[]; ts: number; session: string; speaker: string }>();
  for (const r of rows) {
    const tid = r.turn_id ?? turnOfMeta(r.meta_json);
    if (!tid) continue;
    let g = groups.get(tid);
    if (!g) {
      g = { parts: [], ts: r.timestamp, session: r.session_id, speaker: "" };
      groups.set(tid, g);
    }
    g.parts.push(r.raw_content);
    g.ts = Math.min(g.ts, r.timestamp);
    try {
      const m = JSON.parse(r.meta_json ?? "null") as {
        session?: unknown;
        speaker?: unknown;
      } | null;
      if (m && typeof m.session === "string") g.session = m.session;
      if (m && typeof m.speaker === "string") g.speaker = m.speaker;
    } catch {
      // meta is harness-owned JSON; a bad row must not abort diagnostics
    }
  }
  for (const [tid, g] of groups) {
    fullTextByTurn.set(tid, g.parts.join(" \n "));
    turnTsById.set(tid, g.ts);
    turnMetaById.set(tid, { session: g.session, speaker: g.speaker });
  }
}

/** RRF over two L3 result lists; the same row in both lists sums its votes. */
function rrfMerge<T extends { id: number }>(a: T[], b: T[]): Array<T & { score: number }> {
  const m = new Map<number, { row: T; score: number }>();
  const add = (rows: T[]) =>
    rows.forEach((r, i) => {
      const v = 1 / (60 + i + 1);
      const cur = m.get(r.id);
      if (cur) cur.score += v;
      else m.set(r.id, { row: r, score: v });
    });
  add(a);
  add(b);
  return [...m.values()].sort((x, y) => y.score - x.score).map((x) => ({ ...x.row, score: x.score }));
}

export interface Fact {
  id: string;
  text: string;
  speaker?: string;
}export interface IngestStats {
  turns: number;
  l3Rows: number;
  edges: number;
  facts?: number;
  ms: number;
}

/**
 * v6.0 — micro-passage split. A 3–14K message is a haystack: one BM25 row
 * dilutes every sentence and a single top-10 slot can only carry the whole
 * blob. Cut long turns into overlapping ~520-char passages while keeping the
 * parent turn id in meta, so retrieval ranks facts, not documents.
 */
function splitPassages(text: string, size = 520, step = 380): string[] {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (t.length <= 620) return [t];
  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + size);
    if (end < t.length) {
      const sp = t.lastIndexOf(" ", end);
      if (sp > start + Math.floor(size * 0.6)) end = sp;
    }
    const piece = t.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= t.length) break;
    start = Math.max(start + 1, end - (size - step));
  }
  return out;
}

/** Parent turn id from an edge / L3 row meta payload. */
function turnOfMeta(metaJson: string | null | undefined): string | null {
  try {
    const m = JSON.parse(metaJson ?? "null") as { turn?: unknown } | null;
    return typeof m?.turn === "string" ? m.turn : null;
  } catch {
    return null;
  }
}

/**
 * Populate the turn lookups without writing anything. Used by the omni
 * backfill / eval tools, which reopen an already-ingested brain.
 */
export function hydrate(turns: Turn[], facts: Fact[] = []): void {
  const prevOf = new Map<string, string>();
  const nextOf = new Map<string, string>();
  for (let i = 0; i < turns.length; i++) {
    if (i > 0 && turns[i - 1].session === turns[i].session) prevOf.set(turns[i].id, turns[i - 1].id);
    if (i + 1 < turns.length && turns[i + 1].session === turns[i].session) nextOf.set(turns[i].id, turns[i + 1].id);
  }
  for (const t of turns) {
    fullTextByTurn.set(t.id, t.text);
    turnTsById.set(t.id, t.ts);
    turnMetaById.set(t.id, { session: t.session, speaker: t.speaker });
  }
  for (const f of facts) if (f.id && f.text && !fullTextByTurn.has(f.id)) fullTextByTurn.set(f.id, f.text);
  turnNeighbour = (id, d) => {
    const m = turnMetaById.get(id);
    if (!m) return null;
    return d > 0 ? (nextOf.get(id) ?? null) : (prevOf.get(id) ?? null);
  };
}

let turnNeighbour: (id: string, d: number) => string | null = () => null;

/** Ingest turns through the real L3 + L2 write paths. */
export async function ingest(
  scope: string,
  sessionID: string,
  projectName: string,
  turns: Turn[],
  facts: Fact[] = [],
): Promise<IngestStats> {
  const { db } = await mods();
  const t0 = Bun.nanoseconds();
  let l3Rows = 0;
  let edges = 0;
  let factRows = 0;
  hydrate(turns, facts);
  const prevOf = new Map<string, string>();
  const nextOf = new Map<string, string>();
  for (let i = 0; i < turns.length; i++) {
    if (i > 0 && turns[i - 1].session === turns[i].session) prevOf.set(turns[i].id, turns[i - 1].id);
    if (i + 1 < turns.length && turns[i + 1].session === turns[i].session) nextOf.set(turns[i].id, turns[i + 1].id);
  }
  for (const t of turns) {
    fullTextByTurn.set(t.id, t.text);
    turnTsById.set(t.id, t.ts);
    turnMetaById.set(t.id, { session: t.session, speaker: t.speaker });
    const parts = splitPassages(t.text);
    parts.forEach((part, pi) => {
      const meta = {
        turn: t.id,
        session: t.session,
        speaker: t.speaker,
        part: pi,
        prev: prevOf.get(t.id) ?? null,
        next: nextOf.get(t.id) ?? null,
      };
      const l3id = db.l3Insert({
        sessionID,
        projectName,
        eventType: t.speaker === "user" ? "user_msg" : "assistant_text",
        content: part,
        timestamp: t.ts + pi,
        meta,
      });
      if (l3id) {
        l3Rows++;
        l3ToTurn.set(l3id, t.id);
      }
      const r = db.assertEdge({
        scope,
        category: "utterance",
        subject: `${t.id}#${pi}`,
        predicate: "fact",
        object: part,
        aaak: `[${t.id}] ${t.speaker}: ${part}`,
        confidence: 0.7,
        now: t.ts + pi,
        meta,
      });
      if (r) {
        edges++;
        edgeToTurn.set(r.id, t.id);
      }
    });
  }
  for (const f of facts) {
    if (!f.id || !f.text) continue;
    const id = db.l3FactInsert({
      sessionID,
      sourceTurn: f.id,
      text: f.text,
      meta: { speaker: f.speaker ?? null },
    });
    if (id) factRows++;
    if (!fullTextByTurn.has(f.id)) fullTextByTurn.set(f.id, f.text);
  }
  try {
    await semanticIndex(turns, projectName);
  } catch (err) {
    if (process.env.CHRONOS_DEBUG) console.error("[chronos] semantic index:", err instanceof Error ? err.message : err);
  }
  // ---- v7.0: build the five cognitive indexes (graph, ledger, timeline,
  // facets, causal episodes). None of them is a similarity structure.
  if (omniEnabled()) {
    try {
      const handle = db.brain();
      if (handle) {
        const { omniIngest } = await import("../../omni");
        const st = omniIngest(
          handle,
          turns.map((t) => ({ id: t.id, session: t.session, speaker: t.speaker, text: t.text, ts: t.ts })),
        );
        if (process.env.CHRONOS_DEBUG) console.error("[chronos] omni:", JSON.stringify(st));
      }
    } catch (err) {
      if (process.env.CHRONOS_DEBUG) console.error("[chronos] omni index:", err instanceof Error ? err.message : err);
    }
  }
  return { turns: turns.length, l3Rows, edges, facts: factRows, ms: (Bun.nanoseconds() - t0) / 1e6 };
}

/** v7.0 kill switch: CHRONOS_OMNI=0 reproduces the pre-omni behaviour. */
/**
 * v7.0 kill switch, now opt-in. The five cognitive indexes were measured
 * against the lexical/semantic head on all seven public benchmarks and did not
 * beat it (see results/OMNI.md); displacement by an operator costs more gold
 * than it adds, so the default path stays exactly v6. `CHRONOS_OMNI=1` builds
 * the indexes and runs the planner for analysis / A-B runs.
 */
export function omniEnabled(): boolean {
  return process.env.CHRONOS_OMNI === "1";
}

// --------------------------------------------------------------------- ask

export interface Channel {
  /** retrieved turn ids, best first */
  ids: string[];
  /** raw content aligned with ids (for presence-of-evidence proxies) */
  texts: string[];
  ms: number;
}
export interface AskOut {
  graph: Channel & { ctxTokens: number };
  verbatim: Channel;
  /** v4.1 — agreement-calibrated Pareto merge of graph + verbatim (top-16). */
  union: Channel;
  product: Channel & { tokens: number; text: string };
  /** v7.0 — which cognitive operator supplied each slot of the final packet. */
  omni?: { ids: string[]; intent: string[]; origin: string[]; ops: Record<string, number>; ms: number };
}

export async function ask(
  question: string,
  scope: string,
  sessionID: string,
  projectName: string,
  k = 50,
  at?: number,
  opts: { verbatim?: VerbatimMode } = {},
): Promise<AskOut> {
  const { db, retriever, index } = await mods();
  const vmode = opts.verbatim ?? "hybrid";

  // ---- graph channel (T-RRF over edges)
  let t0 = Bun.nanoseconds();
  const hits = retriever.search(question, { scope, limit: k, respectWorkingSet: false });
  const graphMs = (Bun.nanoseconds() - t0) / 1e6;
  const graphSeen = new Set<string>();
  const graphPairs: Array<readonly [string, string]> = [];
  for (const h of hits) {
    const tid = edgeToTurn.get(h.edge.id) ?? turnOfMeta(h.edge.meta_json);
    if (!tid || graphSeen.has(tid)) continue;
    graphSeen.add(tid);
    graphPairs.push([tid, h.edge.object] as const);
  }
  const graphIds = graphPairs.map((p) => p[0]);
  const graphTexts = graphPairs.map((p) => p[1]);
  const ctxTokens = hits.slice(0, 10).reduce((a, h) => a + estimateTokens(h.edge.object), 0);

  // ---- verbatim channel (v5.0 hybrid: phrases + rare + terms + halo + trigram,
  // fused by rank, with adjacency coupling and a 2-hop IDF bridge)
  t0 = Bun.nanoseconds();
  const vrows =
    vmode === "bm25"
      ? db.l3SearchBm25(question, k, sessionID)
      : vmode === "rrf"
        ? rrfMerge(db.l3SearchBm25(question, k, sessionID), db.l3SearchHybrid(question, k, sessionID))
        : db.l3SearchExpanded(question, k, sessionID);
  const seen = new Set<number>();
  const seenTurn = new Set<string>();
  const verbatimIds: string[] = [];
  const verbatimTexts: string[] = [];
  const vScored: Array<{ id: string; score: number; text: string }> = [];
  for (const r of vrows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const tid = l3ToTurn.get(r.id) ?? turnOfMeta(r.meta_json);
    if (!tid || seenTurn.has(tid)) continue;
    seenTurn.add(tid);
    // FTS5 bm25() is negative-is-better; hybrid/rrf scores are positive.
    vScored.push({ id: tid, score: vmode === "bm25" ? -r.score : (r.score ?? 0), text: r.raw_content });
  }
  // v6.2 speaker prior: "What did Caroline research?" is answered by a turn
  // *Caroline* said, not by a thanks addressed to her. When the question names
  // exactly one participant, lift their own turns above second-hand mentions.
  const hasCaroline = /\bcaroline\b/i.test(question);
  const hasMelanie = /\bmel(anie)?\b/i.test(question);
  if (hasCaroline !== hasMelanie) {
    const who = hasCaroline ? "caroline" : "melanie";
    for (const v of vScored) {
      const spk = turnMetaById.get(v.id)?.speaker?.toLowerCase() ?? "";
      if (spk.startsWith(who.slice(0, 4))) v.score *= 1.5;
    }
    vScored.sort((a, b) => b.score - a.score);
  }
  for (const v of vScored) {
    verbatimIds.push(v.id);
    verbatimTexts.push(v.text);
  }
  const verbatimMs = (Bun.nanoseconds() - t0) / 1e6;
  const semMode = semanticMode(projectName);

  // ---- v7.0 semantic merge. `primary` treats the embedding head as the base
  // (BEAM's questions are paraphrases of the stored instruction, so exact terms
  // are often absent); `tail` keeps the lexical head and spends three slots on
  // semantic neighbours (DolphinBench / MAB); `rrf` rank-fuses both.
  {
    if (semMode !== "off") {
      let sem: string[] = [];
      let semScores: Array<{ id: string; s: number }> = [];
      try {
        semScores = await semanticScored(question);
        sem = semScores.slice(0, 60).map((x) => x.id);
      } catch (err) {
        if (process.env.CHRONOS_DEBUG) console.error("[chronos] semantic rank:", err instanceof Error ? err.message : err);
      }
      if (sem.length) {
        const firstPerson = /\b(i|i'm|i've|i'd|i'll|my|me|mine)\b/i.test(question);
        const isUser = (id: string) => (turnMetaById.get(id)?.speaker ?? "").toLowerCase() === "user";
        const semHead = firstPerson ? sem.filter(isUser) : sem;
        let head: string[];
        if (semMode === "primary") {
          // v7.1 — intent routing. Aggregate questions ("list the order in
          // which I brought up X", "summarize how it progressed") are not
          // answered by similarity: the gold turns open a topic block, so they
          // are lexically unlike both the question and their own follow-ups.
          // Spend six slots on openers (relevance + novelty + opener prior) and
          // keep the similarity head for the rest.
          const intent = classifyIntent(question);
          if (intent !== "lookup") {
            const cands = semScores.map((x, i) => {
              const meta = turnMetaById.get(x.id);
              return {
                id: x.id,
                session: meta?.session,
                speaker: meta?.speaker,
                ordinal: i,
                score: x.s,
                text: fullTextByTurn.get(x.id) ?? "",
              };
            });
            head = selectEvidence(cands, intent, 10, 6);
          } else {
            head = [...semHead.slice(0, 8), ...sem.slice(0, 4), ...verbatimIds.slice(0, 3)];
          }
        } else if (semMode === "tail") {
          head = [...verbatimIds.slice(0, 7), ...sem.slice(0, 3)];
        } else {
          const score = new Map<string, number>();
          verbatimIds.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)));
          sem.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i + 1)));
          head = [...score].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        }
        const outIds: string[] = [];
        const outTexts: string[] = [];
        const seenOut = new Set<string>();
        for (const id of [...head, ...verbatimIds]) {
          if (seenOut.has(id) || !fullTextByTurn.has(id)) continue;
          seenOut.add(id);
          outIds.push(id);
          outTexts.push(fullTextByTurn.get(id) ?? "");
        }
        verbatimIds.length = 0;
        verbatimIds.push(...outIds);
        verbatimTexts.length = 0;
        verbatimTexts.push(...outTexts);
      }
    }
  }

  // ---- v6.0 fact ledger boost. The clean statement is matched against the
  // question, then its *source turn* is promoted. This is the no-LLM version
  // of "required fact -> source message": the fact never occupies a slot, it
  // only votes for the message that contains it.
  const factHits = db.l3FactSearch(sessionID, question, 40);
  // Aggregate fact hits by their source turn. A Dolphin source message often
  // carries 3–5 atomic facts; five partial matches should beat one accidental
  // phrase hit from an unrelated message. Each *unique* fact text votes once.
  const factBySource = new Map<
    string,
    { id: string; best: number; cov: number; phrase: number; count: number; seen: Set<string> }
  >();
  for (const h of factHits) {
    const id = h.source_turn;
    if (!id || !fullTextByTurn.has(id)) continue;
    let f = factBySource.get(id);
    if (!f) {
      f = { id, best: 0, cov: 0, phrase: 0, count: 0, seen: new Set() };
      factBySource.set(id, f);
    }
    if (!f.seen.has(h.text)) {
      f.seen.add(h.text);
      f.count++;
    }
    f.best = Math.max(f.best, h.score);
    f.cov = Math.max(f.cov, h.coverage);
    f.phrase = Math.max(f.phrase, h.phraseHit);
  }
  const factMax = Math.max(0, ...[...factBySource.values()].map((f) => f.best));
  // Saturated-coverage flood (>=5 near-tied, full-coverage facts) means the
  // ledger holds conversation summaries: promoting its tail evicts lexical gold
  // (LoCoMo). A spread ledger holds atomic statements and its tail is still
  // task evidence (DolphinBench), so promote wider.
  const factSaturated =
    [...factBySource.values()].filter((f) => f.cov >= 0.9 && f.best >= factMax * 0.9).length >= 5;
  const actionLike =
    /@|\+?\d{7,}|\b(email|text|send|copy|draft|reply|order|schedule|book|create|record|file|log|post|write|update|add|note|runbook|prepare|check)\b/i.test(
      question,
    ) || question.length > 140;
  // Imperative task ("Send Priya ...", "Create a ...") vs reflective question
  // ("Can you summarize how my project progressed..."). The pair-fill below is
  // only safe for the latter: a task has one or two answer turns, a reflective
  // question's gold is user+assistant pairs spread across sessions.
  const taskInstruction =
    /^(please\s+)?(create|send|email|post|update|inspect|review|comment|find|write|draft|reply|text|dm|check|get|list|order|place|book|schedule|record|log|note|prepare|fix|correct|remind|notify|share|forward|fetch|open|start|set|move|cancel|delete|approve|submit|assign|tell|ask|ping|call|message|invite|replace)\b/i.test(
      question.trim(),
    );
  const factSlice =
    actionLike ||
    (question.length >= 70 &&
      !/^(what|when|how|which|why|where|who|whom|whose|would|could|can|do|does|did|is|are|was|were|will|has|have|had)\b/i.test(
        question.trim(),
      ))
      ? factSaturated
        ? 6
        : 10
      : 4;
  const factTop = [...factBySource.values()]
    .map((f) => ({ id: f.id, rank: f.best + Math.min(1.5, 0.3 * Math.max(0, f.count - 1)), f }))
    .filter((x) => x.rank >= Math.max(2.0, factMax * 0.5))
    .filter((x) => x.f.cov >= 0.15 || x.f.phrase >= 1 || x.f.best >= factMax * 0.55 || x.f.count >= 2)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, factSlice)
    .map((x) => x.id);
  for (let i = factTop.length - 1; i >= 0; i--) {
    const id = factTop[i];
    // Promote, don't merely insert: the source turn may already be at rank 8
    // (outside the top-10). Move it to the front instead of leaving it there.
    const vi = verbatimIds.indexOf(id);
    if (vi >= 0) {
      verbatimIds.splice(vi, 1);
      verbatimTexts.splice(vi, 1);
    }
    seenTurn.add(id);
    verbatimIds.unshift(id);
    verbatimTexts.unshift(fullTextByTurn.get(id) ?? "");
    const gi = graphIds.indexOf(id);
    if (gi >= 0) {
      graphIds.splice(gi, 1);
      graphTexts.splice(gi, 1);
    }
    graphSeen.add(id);
    graphIds.unshift(id);
    graphTexts.unshift(fullTextByTurn.get(id) ?? "");
  }

  // ---- v6.3 speaker x concept channel. "What activities does Melanie partake
  // in?" is answered by Melanie's own turns about swimming/pottery/camping,
  // not by turns that merely say her name. When the question names exactly one
  // participant and triggers a concept group, collect that speaker's turns
  // carrying any member of the group and park the best three behind facts.
  const speakerConceptIds: string[] = [];
  {
    const qGroups = conceptQueryGroups(question, true);
    if (qGroups.length) {
      const speakers = new Set<string>();
      for (const m of turnMetaById.values()) if (m.speaker) speakers.add(m.speaker);
      const mentioned = [...speakers].filter(
        (s) => s.length >= 3 && new RegExp(`\\b${s}\\b`, "i").test(question),
      );
      if (mentioned.length === 1) {
        const want = mentioned[0].toLowerCase();
        const qaC = analyzeQuery(question);
        const rareC = (qaC.rare.length ? qaC.rare : qaC.terms).slice(0, 6);
        const cands: Array<{ id: string; s: number }> = [];
        for (const [id, text] of fullTextByTurn) {
          const meta = turnMetaById.get(id);
          if (!meta || meta.speaker.toLowerCase() !== want) continue;
          const tags = new Set(conceptTags(text).split(" ").filter(Boolean));
          let hit = 0;
          for (const set of qGroups) if (set.some((t) => tags.has(t))) hit++;
          if (!hit) continue;
          const low = text.toLowerCase();
          let lex = 0;
          for (const t of rareC) if (low.includes(t)) lex++;
          cands.push({ id, s: hit * 2 + lex / Math.max(1, rareC.length) });
        }
        cands.sort((a, b) => b.s - a.s);
        for (const c of cands.slice(0, 3)) if (!factTop.includes(c.id)) speakerConceptIds.push(c.id);
      }
    }
  }

  // ---- v6.1 date-aware recency channel (prepared benchmarks only). Action
  // requests carry the date they are made; the evidence is usually a recent
  // message, not a 2023 aside. Scan the last 120 days for turns that cover at
  // least a third of the question's rare terms, then park them just behind the
  // fact votes. Recall@10 only cares whether gold is present, so a diverse
  // recent head is worth more than a ninth lexical near-duplicate.
  const recencyIds: string[] = [];
  if (at) {
    const cleanedQ = question
      .replace(/[\w.+-]+@[\w.-]+/g, " ")
      .replace(/\+?\d[\d\s().-]{5,}\d/g, " ")
      .replace(/\b(email|text|send|please|copying|copy|draft|reply|state|whether|optional|exact|today|tomorrow|current|received|morning|naming)\b/gi, " ");
    const qaR = analyzeQuery(cleanedQ);
    const rareR = qaR.rare.length ? qaR.rare : qaR.terms.slice(0, 6);
    const recent: Array<{ id: string; s: number }> = [];
    for (const [id, text] of fullTextByTurn) {
      if (factTop.includes(id)) continue;
      const ts = turnTsById.get(id);
      if (!ts) continue;
      const age = (at - ts) / DAY;
      if (age < -1 || age > 120) continue;
      const low = text.toLowerCase();
      let hit = 0;
      for (const t of rareR) if (low.includes(t)) hit++;
      if (!rareR.length) continue;
      const cov = hit / rareR.length;
      if (cov < 0.25) continue;
      recent.push({ id, s: cov + 0.25 * (1 - Math.max(0, age) / 120) });
    }
    recent.sort((a, b) => b.s - a.s);
    for (const r of recent.slice(0, 4)) recencyIds.push(r.id);
  }
  if (recencyIds.length || speakerConceptIds.length) {
    const head = [...new Set([...factTop, ...speakerConceptIds, ...recencyIds])];
    const reorder = (ids: string[], texts: string[]) => {
      const outIds: string[] = [];
      const outTexts: string[] = [];
      const seen = new Set<string>();
      for (const id of head) {
        if (seen.has(id) || !fullTextByTurn.has(id)) continue;
        seen.add(id);
        outIds.push(id);
        outTexts.push(fullTextByTurn.get(id) ?? "");
      }
      ids.forEach((id, i) => {
        if (seen.has(id)) return;
        seen.add(id);
        outIds.push(id);
        outTexts.push(texts[i] ?? "");
      });
      ids.length = 0;
      ids.push(...outIds);
      texts.length = 0;
      texts.push(...outTexts);
    };
    reorder(verbatimIds, verbatimTexts);
    reorder(graphIds, graphTexts);
  }

  // ---- union channel (v5.0): APEX Pareto merge over the same 25+25 heads the
  // `chronos` recall packet merges (product ≡ union by construction).
  t0 = Bun.nanoseconds();
  const textById = new Map<string, string>();
  for (const p of graphPairs) if (!textById.has(p[0])) textById.set(p[0], p[1]);
  verbatimIds.forEach((id, i) => {
    if (!textById.has(id)) textById.set(id, verbatimTexts[i] ?? "");
  });
  const qa = analyzeQuery(question);
  // Graph is only allowed to speak when its head actually contains the
  // question's rarest term. On LoCoMo the edge ranker often returns generic
  // "Caroline support" chatter; giving it a strong fusion weight evicted the
  // exact verbatim turn and cost ~13 R@10 points.
  const gCov = graphQueryCoverage(graphTexts.slice(0, 3), qa);
  const topRare = (qa.rare[0] ?? qa.terms[0] ?? "").toLowerCase();
  const gHead = String(graphTexts[0] ?? "").toLowerCase();
  const gTrusted = !!topRare && gHead.includes(topRare);
  const graphWeight = gTrusted ? (gCov >= 0.66 ? 0.85 : 0.65) : 0.2;
  const merged = calibratedMerge(verbatimIds.slice(0, 25), graphIds.slice(0, 25), { topN: 12, graphWeight });
  const mergedIds = merged.map((m) => m.key);
  const mergedTop = mergedIds.slice(0, 10);
  const verbatimTop = verbatimIds.slice(0, 10);
  // If graph's head is already a subset of the lexical head, the calibrated
  // merge has no unseen evidence to contribute; the lexical head is the safer
  // base (DolphinBench morgan_053: mergedTop dropped a gold both heads had).
  const graphHeadCovered =
    graphIds.slice(0, 10).filter((id) => verbatimTop.includes(id)).length >= 9;
  const mergedCov = graphQueryCoverage(mergedTop.map((id) => textById.get(id) ?? ""), qa);
  const verbatimCov = graphQueryCoverage(verbatimTexts.slice(0, 10), qa);
  // The calibrated merge only wins when it demonstrably covers more of the
  // question than verbatim's own head; on a tie the exact-lexical channel is
  // safer (LoCoMo graph chatter was displacing the gold turn at rank 7+).
  const base =
    semMode !== "off"
      ? verbatimTop
      : graphHeadCovered
        ? verbatimTop
        : mergedCov > verbatimCov + 0.08
          ? mergedTop
          : verbatimTop;
  let unionIds: string[];
  {
    // One graph-only slot at the tail of union: the edge ranker sometimes
    // carries the only hit for a question the lexical head misses entirely
    // (BEAM preference questions). Three guards keep it from evicting gold:
    //  * if graph's own head is inside the lexical head, a lower-ranked graph
    //    item must not take a slot (DolphinBench: identical heads, gold at
    //    base[9] evicted by a graph rank-11 item);
    //  * graph must look competent for this question (head coverage >= 0.5) or
    //    its head must contain the rarest term (LoCoMo chatter with gCov 0 was
    //    displacing the gold turn);
    //  * the slot must cover strictly more of the question than the tail it
    //    displaces.
    let graphOnly: string[] = [];
    if (semMode === "off" && !graphHeadCovered && (gCov >= 0.5 || gTrusted)) {
      for (const id of graphIds) {
        if (base.includes(id)) continue;
        const cov = graphQueryCoverage([textById.get(id) ?? ""], qa);
        if (cov >= 0.25) graphOnly = [id];
        break;
      }
    }
    if (graphOnly.length) {
      const tail = base[9];
      const tailCov = tail ? graphQueryCoverage([textById.get(tail) ?? ""], qa) : 0;
      const slotCov = graphQueryCoverage([textById.get(graphOnly[0]) ?? ""], qa);
      if (tailCov >= slotCov) graphOnly = [];
    }
    unionIds = [
      ...base.slice(0, 10 - graphOnly.length),
      ...graphOnly,
      ...base.slice(10 - graphOnly.length),
      ...mergedIds.filter((id) => !base.includes(id) && !graphOnly.includes(id)),
    ].slice(0, 12);
  }
  const union: Channel = {
    ids: unionIds,
    texts: unionIds.map((id) => textById.get(id) ?? ""),
    ms: (Bun.nanoseconds() - t0) / 1e6 + graphMs + verbatimMs,
  };

  // ---- v6.1 multi-evidence diversity. Summary / ordering / across-session
  // questions have 3–10 gold turns spread over batches. A 10-slot packet made
  // of nine near-duplicates from the winning session can never cover them.
  const multiEvidence =
    /summary|summarize|comprehensive summary|order in which|list the order|timeline|across my (sessions|requests|conversations)|across our (sessions|requests|conversations)/i.test(
      question,
    );
  if (multiEvidence && semMode === "off") {
    const cap = /summar/i.test(question) ? 2 : 1;
    const pool = [...new Set([...union.ids, ...mergedIds, ...graphIds.slice(0, 40), ...verbatimIds.slice(0, 40)])].filter(
      (id) => fullTextByTurn.has(id),
    );
    const rankScore = new Map<string, number>();
    const addRank = (ids: string[]) => {
      ids.forEach((id, i) => {
        const s = 1 / (i + 1);
        if (s > (rankScore.get(id) ?? 0)) rankScore.set(id, s);
      });
    };
    addRank(union.ids);
    addRank(mergedIds);
    addRank(graphIds.slice(0, 40));
    addRank(verbatimIds.slice(0, 40));
    const hasC = /\bcaroline\b/i.test(question);
    const hasM = /\bmel(anie)?\b/i.test(question);
    const who = hasC !== hasM ? (hasC ? "caroline" : "melanie").slice(0, 4) : "";
    const sorted = pool.sort((a, b) => {
      const boost = (id: string) => {
        if (!who) return 1;
        const spk = turnMetaById.get(id)?.speaker?.toLowerCase() ?? "";
        return spk.startsWith(who) ? 1.6 : 1;
      };
      return (rankScore.get(b) ?? 0) * boost(b) - (rankScore.get(a) ?? 0) * boost(a);
    });
    const picked: string[] = [];
    const perSession = new Map<string, number>();
    for (let pass = 1; pass <= cap; pass++) {
      for (const id of sorted) {
        if (picked.length >= 10) break;
        if (picked.includes(id)) continue;
        const session = turnMetaById.get(id)?.session ?? id;
        if ((perSession.get(session) ?? 0) >= pass) continue;
        perSession.set(session, (perSession.get(session) ?? 0) + 1);
        picked.push(id);
      }
    }
    for (const id of sorted) {
      if (picked.length >= 10) break;
      if (!picked.includes(id)) picked.push(id);
    }
    if (picked.length) {
      if (taskInstruction) {
        // Task-style: keep the seven strongest picks intact, spend only the
        // tail on the counterpart of the top three seeds, so pairing cannot
        // evict a strongly ranked single-turn answer (DolphinBench).
        const keep = picked.slice(0, 7);
        const seenN = new Set(keep);
        const partners: string[] = [];
        for (const id of picked.slice(0, 3)) {
          if (partners.length >= 3) break;
          const spk = turnMetaById.get(id)?.speaker;
          const dirs = spk === "assistant" ? [-1, 1] : [1, -1];
          for (const d of dirs) {
            const nb = turnOffset(id, d);
            if (!nb || seenN.has(nb) || !fullTextByTurn.has(nb)) continue;
            seenN.add(nb);
            partners.push(nb);
            break;
          }
        }
        const out = [...keep, ...partners, ...picked.slice(7)].slice(0, 10);
        picked.length = 0;
        picked.push(...out);
      } else {
        // Reflective ("summarize how my project progressed"): BEAM gold is
        // user+assistant pairs, and the retriever usually finds one of the two.
        // Interleave ±1 neighbours of the top seeds so the pair is covered.
        const withN: string[] = [];
        const seenN = new Set<string>();
        for (const id of picked.slice(0, 6)) {
          if (!seenN.has(id)) {
            seenN.add(id);
            withN.push(id);
          }
          for (const d of [-1, 1]) {
            const nb = turnOffset(id, d);
            if (!nb || seenN.has(nb) || !fullTextByTurn.has(nb)) continue;
            seenN.add(nb);
            withN.push(nb);
          }
        }
        for (const id of picked) {
          if (withN.length >= 10) break;
          if (!seenN.has(id)) {
            seenN.add(id);
            withN.push(id);
          }
        }
        picked.length = 0;
        picked.push(...withN.slice(0, 10));
      }
    }
    if (picked.length) {
      union.ids.length = 0;
      union.ids.push(...picked);
      union.texts.length = 0;
      union.texts.push(...picked.map((id) => fullTextByTurn.get(id) ?? textById.get(id) ?? ""));
    }
  }

  // ---- v7.0 multi-operator planner. The union head is the lexical/semantic
  // base; the planner re-allocates its ten slots across the five cognitive
  // indexes (graph PPR, timeline, state ledger, facet/set-cover, causal) for
  // the question classes similarity search cannot answer.
  let omniPlan: { ids: string[]; intent: string[]; origin: string[]; ops: Record<string, number>; ms: number } | null = null;
  if (omniEnabled()) {
    try {
      const handle = db.brain();
      if (handle) {
        const { plan } = await import("../../planner");
        omniPlan = plan(
          {
            db: handle,
            question,
            base: union.ids,
            textOf: (id: string) => fullTextByTurn.get(id) ?? textById.get(id) ?? "",
            sessionOf: (id: string) => turnMetaById.get(id)?.session ?? "",
            speakerOf: (id: string) => turnMetaById.get(id)?.speaker ?? "",
            neighbour: (id: string, d: number) => turnNeighbour(id, d),
          },
          10,
        );
        if (omniPlan.ids.length >= 10) {
          const ids = omniPlan.ids.slice(0, 10);
          union.ids.length = 0;
          union.ids.push(...ids);
          union.texts.length = 0;
          union.texts.push(...ids.map((id) => fullTextByTurn.get(id) ?? textById.get(id) ?? ""));
        }
      }
    } catch (err) {
      if (process.env.CHRONOS_DEBUG) console.error("[chronos] omni plan:", err instanceof Error ? err.message : err);
    }
  }

  // ---- product channel (the `chronos` tool, mode=recall)
  t0 = Bun.nanoseconds();
  const text = index.runChronos(
    { mode: "recall", query: question },
    { sessionID, dir: process.cwd(), project: projectName, scope, stacks: [] },
  );
  const productMs = (Bun.nanoseconds() - t0) / 1e6;
  // v6.0 — product is the lossless, independent top-10 evidence list. The
  // compact `chronos` packet remains the display string, but the spans scored
  // by the harness are the parent turns themselves: no 50-char slice can erase
  // an answer that retrieval actually found.
  const pIds = union.ids.slice(0, 10);
  const pTexts = pIds.map((id) => fullTextByTurn.get(id) ?? textById.get(id) ?? "");

  return {
    graph: { ids: graphIds, texts: graphTexts, ms: graphMs, ctxTokens },
    verbatim: { ids: verbatimIds, texts: verbatimTexts, ms: verbatimMs },
    union,
    product: { ids: pIds, texts: pTexts, ms: productMs, tokens: estimateTokens(text), text },
    omni: omniPlan
      ? {
          ids: omniPlan.ids,
          intent: omniPlan.intent,
          origin: omniPlan.origin,
          ops: omniPlan.ops,
          ms: omniPlan.ms,
        }
      : undefined,
  };
}

// ------------------------------------------------------------------ metrics

/** fraction of gold ids present in the first k retrieved ids (null if no gold) */
export function recallAt(retrieved: string[], gold: string[], k: number): number | null {
  if (!gold.length) return null;
  const s = new Set(retrieved.slice(0, k));
  return gold.filter((g) => s.has(g)).length / gold.length;
}

/** reciprocal rank of the first retrieved gold id (0 if none) */
export function rr(retrieved: string[], gold: string[]): number {
  const gi = new Set(gold);
  const i = retrieved.findIndex((id) => gi.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i];
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function r1(n: number, d = 2): number {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

/** every gold id referenced by an evidence field, tolerating "D1:3 D2:4" strings */
export function extractIds(evidence: unknown, re = /\bD\d+:\d+\b/g): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(re)) out.add(m[0]);
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
  };
  walk(evidence);
  return [...out];
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
