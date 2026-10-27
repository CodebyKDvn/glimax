// ===========================================================================
// retriever.ts — Temporal Reciprocal Rank Fusion + the frozen snapshot.
//
// THREE RANKERS, ONE DECISION
//
//   BM25      FTS5 porter over subject/object/AAAK     (lexical, exact)
//   COSINE    feature-hashed 384-dim vectors           (fuzzy, paraphrase)
//   SIMHASH   384-bit Hamming similarity               (near-duplicates)
//
//   T-RRF = Σ w_r / (k + rank_r)   ×   e^(−λ·Δt / S)
//
// CRITICAL DETAIL — rankers only vote when they have real signal.
// Rank fusion assigns a rank to every candidate, so a noisy ranker that is
// merely *ordering* garbage still emits `w/(k+1)` for its "best" item. That
// floors the score above any sane threshold and the micro-gate injects
// nonsense forever. So COSINE and SIMHASH must clear a similarity floor to be
// counted at all; BM25 already only ranks genuine full-text hits.
//
// The exponential term uses each edge's own stability S as its half-life
// denominator: memories that keep getting reused stay sharp; memories that
// were superseded fade but never vanish (L3 always has them).
//
// THE SNAPSHOT is the other half: [CHRONOS_DNA] + [CHRONOS_PULSE] +
// [CHRONOS_BEHAVIOR] + [CHRONOS_CORTEX], computed once when a session first
// asks for context and then frozen byte-for-byte for the rest of that session
// (l0_snapshots), so the provider's prompt cache keeps hitting. Budget:
// < 125 tokens total, and it shrinks as the cortex learns (reverse scaling).
// ===========================================================================

import {
  AAAK_BEHAVIOR,
  AAAK_CORTEX,
  aaakDNA,
  aaakMem,
  aaakPulse,
  aaakReflexLine,
  type PulseProject,
  analyzeQuery,
  blobToVec,
  clampChars,
  clampTokens,
  cosine,
  embed,
  estimateTokens,
  neighborTurnIds,
  overlap,
  simhash384,
  simhashFromHex,
  simhashSimilarity,
  simhashToHex,
} from "./aaak";
import {
  type Edge,
  type ProceduralEngram,
  type ProjectRow,
  edgeHistory,
  edgesBySubject,
  engramsBm25,
  engramsLive,
  ftsQuery,
  getProject,
  l1Keys,
  l2SearchApex,
  l2SearchBm25,
  liveEdges,
  openLoops,
  recentProjects,
  writeStamp,
} from "./db";

export const RRF_K = 12;
const W_BM25 = 1.0;
const W_VEC = 1.1;
const W_SIM = 0.55;
const LAMBDA = 0.55; // base temporal decay
const DECAY_FLOOR = 0.3; // v5.0 — old-but-gold memories keep 30% lexical strength

// Similarity floors: below these a ranker stays silent rather than ranking
// noise. Without them the gate can never return zero tokens.
const VEC_MIN = 0.15;
const SIM_MIN = 0.6;

// v4.1 — queries that ask about change / history also see superseded edges.
const TEMPORAL_CUE =
  /\b(when|before|after|originally|previously|used to|no longer|changed?|updat(?:e|ed)|now|currently|latest|recent(?:ly)?|still)\b|\b(?:19|20)\d{2}\b/i;

// ------------------------------------------------------------ snapshot caps

export const SNAPSHOT_TOKEN_CAP = 124; // whole injected block (< 125 by contract)
export const DNA_TOKEN_CAP = 26; // persona half
export const PULSE_TOKEN_CAP = 56; // project half
export const MEM_TOKEN_CAP = 45; // one JIT memory line
export const MEM_THRESHOLD = 0.06; // below this, inject nothing
export const REFLEX_TOKEN_CAP = 40; // one JIT reflex line
export const REFLEX_THRESHOLD = 0.08; // below this, the reflex gate stays shut

export interface Scored {
  edge: Edge;
  score: number;
  parts: { bm25: number; vec: number; sim: number; decay: number };
}

export interface SearchOpts {
  /** project scope; global is always included */
  scope?: string;
  /** extra scopes to search (e.g. a project named inside the message) */
  scopes?: string[];
  /** include superseded edges — answers "why did we stop doing X?" */
  includeExpired?: boolean;
  sessionID?: string;
  /** exclude anything already injected/seen in this session */
  respectWorkingSet?: boolean;
  limit?: number;
  now?: number;
}

export function search(query: string, opts: SearchOpts): Scored[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 12;
  const qtext = String(query ?? "").trim();
  if (!qtext) return [];

  const wantHistory = opts.includeExpired || TEMPORAL_CUE.test(qtext);
  const entries = wantHistory
    ? entriesOf(edgeHistory(opts.scope ?? "global"))
    : cachedPool(opts.scope ?? "global", opts.scopes ?? []);
  if (!entries.length) return [];

  const seen = opts.respectWorkingSet && opts.sessionID ? l1Keys(opts.sessionID) : new Set<string>();

  const qv = embed(qtext);
  const qsh = simhash384(qtext);

  // ---- ranker 1: soft-quorum BM25 over the graph (v5.0 APEX multi-pass)
  const bmApex = l2SearchApex(qtext, 60);
  const bmRank = new Map<number, number>();
  bmApex.forEach((r, i) => bmRank.set(r.id, i + 1));

  // ---- ranker 2: cosine on feature-hashed vectors (floor applies)
  const vecScore = new Map<number, number>();
  for (const en of entries) {
    const c = en.vec ? cosine(qv, en.vec) : lexicalCos(en.edge, qtext);
    if (c >= VEC_MIN) vecScore.set(en.edge.id, c);
  }
  const vecRank = rankOf(vecScore);

  // ---- ranker 3: 384-bit SimHash Hamming (floor applies)
  const simScore = new Map<number, number>();
  for (const en of entries) {
    const sim = simBig(qsh, en.sig);
    if (sim >= SIM_MIN) simScore.set(en.edge.id, sim);
  }
  const simRank = rankOf(simScore);

  // ---- fuse
  const out: Scored[] = [];
  for (const en of entries) {
    const e = en.edge;
    if (seen.has(`edge:${e.id}`)) continue;

    const r1 = bmRank.get(e.id);
    const r2 = vecRank.get(e.id);
    const r3 = simRank.get(e.id);
    const bm25Part = r1 ? W_BM25 / (RRF_K + r1) : 0;
    const vecPart = r2 ? W_VEC / (RRF_K + r2) : 0;
    const simPart = r3 ? W_SIM / (RRF_K + r3) : 0;

    const base = bm25Part + vecPart + simPart;
    if (base <= 0) continue;

    //                 e^(−λ·Δt / S), Δt in days, S = stability
    // v5.0: floored at DECAY_FLOOR — an old but gold memory keeps 30% of its
    // lexical strength (dolphin/lme corpora span years; pure exp() crushed
    // graph R@10 to ~3%).
    const ageDays = Math.max(0, (now - (e.last_accessed_at ?? e.valid_from)) / 86_400_000);
    const stability = Math.max(0.2, Number(e.stability) || 1);
    const expiredPenalty = e.valid_until ? 0.45 : 1;
    const confWeight = 0.5 + 0.5 * Math.max(0, Math.min(1, Number(e.confidence) || 0));
    const decay = Math.max(DECAY_FLOOR, Math.exp((-LAMBDA * ageDays) / (stability * 7)));

    out.push({
      edge: e,
      score: base * decay * confWeight * expiredPenalty,
      parts: { bm25: bm25Part, vec: vecPart, sim: simPart, decay },
    });
  }

  out.sort((a, b) => b.score - a.score || a.edge.id - b.edge.id);
  expandDialogue(out, [opts.scope ?? "global", ...(opts.scopes ?? [])], qtext);
  return out.slice(0, limit);
}

// ------------------------------------------------- dialogue window (v4.1/v5)

// neighborTurnIds moved to aaak.ts (v5.0 fix: bumps the LAST digit run, so
// "D1:3" couples to D1:2 / D1:4 instead of D0:3 / D2:3).

function edgeTurn(e: Edge): { turn: string | null; session: string | null } {
  try {
    const m = JSON.parse(e.meta_json ?? "null") as { turn?: unknown; session?: unknown } | null;
    return {
      turn: typeof m?.turn === "string" ? m.turn : null,
      session: typeof m?.session === "string" ? m.session : null,
    };
  } catch {
    return { turn: null, session: null };
  }
}

const HOP_STOP = new Set([
  "about", "after", "again", "against", "because", "before", "being", "between", "could", "during",
  "every", "first", "found", "their", "there", "these", "thing", "those", "through", "under", "until",
  "where", "which", "while", "would", "today", "really", "still", "maybe", "going", "doing", "think",
  "thought", "wanted", "thanks", "please", "should", "friend", "people",
]);

function rareTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/\b\d{4}(?:[-/.]\d{1,2}){0,2}\b|\b[A-Z][a-z]{2,}\b|\b[a-z]{8,}\b/g)) {
    const t = m[0];
    const low = t.toLowerCase();
    if (HOP_STOP.has(low) || seen.has(low)) continue;
    seen.add(low);
    out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * v5.0 — dialogue window expansion. The top-5 direct hits propagate
 * score × 0.55 to their ±1 neighbour turns in the same session (answers often
 * sit one turn after the matched message); a 2-hop bridge over high-IDF rare
 * entities — dates, numbers, proper nouns not already in the question — adds
 * far-away evidence at score × 0.5. Bounded: ≤ 8 extra edges per query.
 */
function expandDialogue(out: Scored[], scopes: string[], query = ""): void {
  const top = out[0]?.score ?? 0;
  if (!top) return;
  const anchors = out.slice(0, 5).filter((h) => h.score >= top * 0.45);
  const have = new Set(out.map((h) => h.edge.id));
  let budget = 8;

  for (const a of anchors) {
    if (budget <= 0) break;
    const { turn, session } = edgeTurn(a.edge);
    if (!turn) continue;
    const nb = neighborTurnIds(turn);
    outer: for (const s of scopes) {
      for (const id of nb) {
        if (budget <= 0) break outer;
        for (const e of edgesBySubject(s, id, 4)) {
          if (have.has(e.id) || budget <= 0) continue;
          const m = edgeTurn(e);
          if (session && m.session && m.session !== session) continue;
          have.add(e.id);
          budget--;
          out.push({ edge: e, score: a.score * 0.55, parts: { bm25: 0, vec: 0, sim: 0, decay: 1 } });
        }
      }
    }
  }

  const qLow = query.toLowerCase();
  let bridgeTerms = 0;
  for (const a of anchors.slice(0, 3)) {
    if (budget <= 0 || bridgeTerms >= 5) break;
    for (const term of rareTerms(`${a.edge.subject} ${a.edge.object}`).slice(0, 2)) {
      if (budget <= 0 || bridgeTerms >= 5) break;
      if (qLow.includes(term.toLowerCase())) continue; // bridge vocabulary must be new
      bridgeTerms++;
      const hits = l2SearchBm25(term, 6);
      if (!hits.length || hits.length > 6) continue; // rare bridges only
      for (const e of hits) {
        if (have.has(e.id) || e.valid_until || budget <= 0) continue;
        have.add(e.id);
        budget--;
        out.push({ edge: e, score: a.score * 0.5, parts: { bm25: 0, vec: 0, sim: 0, decay: 1 } });
      }
    }
  }
  if (budget < 8) out.sort((a, b) => b.score - a.score || a.edge.id - b.edge.id);
}

function unionScopes(scopes: string[]): Scored[] {
  const seen = new Set<number>();
  const out: Scored[] = [];
  for (const s of scopes) {
    for (const e of liveEdges(s || "global")) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ edge: e, score: 0, parts: { bm25: 0, vec: 0, sim: 0, decay: 1 } });
    }
  }
  return out;
}

// ------------------------------------------------------- pool cache (v4.1)
// The live-edge pool with its 384-dim vectors is the hottest read in the
// retriever: rebuilding it per query re-reads tens of MB on large brains and
// dominates p50 latency. Cache it per (brain, scopes, structural write stamp)
// — inserts, supersedes and expiries all bump the stamp; nothing else matters.
interface PoolEntry {
  edge: Edge;
  vec: Float32Array | null;
  sig: bigint;
}

let poolStampKey = "";
const poolByScope = new Map<string, PoolEntry[]>();

function entriesOf(edges: Edge[]): PoolEntry[] {
  return edges.map((edge) => ({
    edge,
    vec: blobToVec(edge.vec),
    sig: simhashFromHex(edge.simhash_signature),
  }));
}

function cachedPool(scope: string, extra: string[]): PoolEntry[] {
  const stamp = `${process.env.CHRONOS_BRAIN_PATH ?? ""}#${writeStamp()}`;
  if (stamp !== poolStampKey) {
    poolStampKey = stamp;
    poolByScope.clear();
  }
  const key = `${scope}|${extra.join(",")}`;
  const hit = poolByScope.get(key);
  if (hit) return hit;
  const entries = entriesOf(unionScopes([scope, ...extra]).map((s) => s.edge));
  poolByScope.set(key, entries);
  return entries;
}

/** 1 − hamming/384, straight from the precomputed bigint signatures. */
function simBig(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return 1 - n / 384;
}

/** Rank map 1..n (1 = best) for RRF. */
function rankOf(scores: Map<number, number>): Map<number, number> {
  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const r = new Map<number, number>();
  entries.forEach(([id], i) => r.set(id, i + 1));
  return r;
}

/** Fallback when an edge predates vector storage: cheap token overlap. */
function lexicalCos(e: Edge, qtext: string): number {
  const qt = new Set(ftsQuery(qtext).split(" OR ").map((s) => s.replace(/"/g, "")));
  const et = new Set(
    `${e.subject} ${e.object} ${e.aaak_text ?? ""}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}_$]+/u)
      .filter(Boolean),
  );
  if (!qt.size || !et.size) return 0;
  let hit = 0;
  for (const t of qt) if (et.has(t)) hit++;
  return hit / Math.sqrt(qt.size * et.size);
}

// ------------------------------------------------------------- JIT gating

export interface GateOpts extends SearchOpts {
  /** below this fused score, inject nothing at all */
  threshold?: number;
  /** at most this many tokens added to the request */
  tokenBudget?: number;
  /** ceiling on how many memories ride along */
  maxItems?: number;
}

/**
 * The micro-gate. Returns "" (zero tokens) unless something is genuinely
 * relevant AND not already shown in this session.
 */
export function gate(query: string, opts: GateOpts): { text: string; keys: string[]; top: number } {
  const threshold = opts.threshold ?? MEM_THRESHOLD;
  const budget = opts.tokenBudget ?? MEM_TOKEN_CAP;
  const maxItems = opts.maxItems ?? 2;

  const hits = search(query, { ...opts, limit: 24 });
  if (!hits.length) return { text: "", keys: [], top: 0 };

  const top = hits[0].score;
  if (top < threshold) return { text: "", keys: [], top };

  // keep only hits within a sane band of the leader
  const chosen = hits.filter((h) => h.score >= Math.max(threshold, top * 0.55)).slice(0, maxItems);

  const parts: string[] = [];
  const keys: string[] = [];
  for (const h of chosen) {
    const line = h.edge.aaak_text ?? `[MEM#${h.edge.id}|${h.edge.subject}=${h.edge.object}]`;
    const cand = parts.concat(line).join(" ");
    if (estimateTokens(cand) > budget) break;
    parts.push(line);
    keys.push(`edge:${h.edge.id}`);
  }
  if (!parts.length) return { text: "", keys: [], top };

  return { text: clampTokens(parts.join(" "), budget), keys, top };
}

// -------------------------------------------------------- reflexive engrams

/**
 * T-RRF over the procedural cortex — same recipe as the graph search, three
 * rankers, one decision:
 *
 *   BM25     l2_engram_fts over trigger/avoid/fast-path text   (lexical)
 *   SIMHASH  384-bit Hamming on the stored trigger signature   (paraphrase)
 *   OVERLAP  significant-word intersection                     (safety net)
 *
 * Maturity and the Bayesian success rate scale the fused score instead of
 * decaying it: a proven reflex outranks a fresh hunch. A slow staleness term
 * keeps a skill usable for months without letting it shout forever.
 */
export interface ReflexHit {
  engram: ProceduralEngram;
  score: number;
}

const R_W_BM25 = 1.0;
const R_W_SIM = 0.8;
const R_W_LEX = 0.5;
const R_SIM_MIN = 0.55;
const R_LEX_MIN = 2; // at least two significant words shared

export interface ReflexOpts extends SearchOpts {
  /** stack tags of the session (bun, ts, …) — reaches stack:<tag> engrams */
  stacks?: string[];
}

export function reflexSearch(query: string, opts: ReflexOpts): ReflexHit[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 5;
  const qtext = String(query ?? "").trim();
  if (!qtext) return [];

  const scopes = [opts.scope ?? "global", ...(opts.scopes ?? []), ...(opts.stacks ?? []).map((s) => `stack:${s}`)];
  const pool = engramsLive(scopes, 60);
  if (!pool.length) return [];

  const seen = opts.respectWorkingSet && opts.sessionID ? l1Keys(opts.sessionID) : new Set<string>();
  const qsh = simhashToHex(simhash384(qtext));

  // ---- ranker 1: BM25
  const bm = engramsBm25(qtext, 40);
  const bmRank = new Map<number, number>();
  bm.forEach((r, i) => bmRank.set(r.id, i + 1));

  // ---- ranker 2: SimHash Hamming (floor applies)
  const simScore = new Map<number, number>();
  for (const e of pool) {
    const sim = simhashSimilarity(qsh, e.trigger_simhash ?? "");
    if (sim !== null && sim >= R_SIM_MIN) simScore.set(e.id, sim);
  }
  const simRank = rankOf(simScore);

  // ---- ranker 3: significant-word overlap (floor applies)
  const lexRank = new Map<number, number>();
  {
    const scored = new Map<number, number>();
    for (const e of pool) {
      const n = overlap(qtext, `${e.trigger_intent} ${e.anti_pattern_aaak ?? ""} ${e.fast_path_aaak}`);
      if (n >= R_LEX_MIN) scored.set(e.id, n);
    }
    for (const [id, r] of rankOf(scored)) lexRank.set(id, r);
  }

  // ---- fuse
  const out: ReflexHit[] = [];
  for (const e of pool) {
    if (seen.has(`engram:${e.id}`)) continue;
    const r1 = bmRank.get(e.id);
    const r2 = simRank.get(e.id);
    const r3 = lexRank.get(e.id);
    const base =
      (r1 ? R_W_BM25 / (RRF_K + r1) : 0) + (r2 ? R_W_SIM / (RRF_K + r2) : 0) + (r3 ? R_W_LEX / (RRF_K + r3) : 0);
    if (base <= 0) continue;

    const rate = 0.6 + 0.4 * Math.max(0, Math.min(1, Number(e.success_rate) || 0));
    const mature = 1 + Math.min(0.4, Math.max(0, e.maturity - 1) * 0.08);
    const ageDays = Math.max(0, (now - (e.last_fired_at ?? now)) / 86_400_000);
    const stale = Math.exp((-0.1 * ageDays) / 30); // decades-long half-life: skills stay
    out.push({ engram: e, score: base * rate * mature * stale });
  }

  out.sort((a, b) => b.score - a.score || b.engram.id - a.engram.id);
  return out.slice(0, limit);
}

/**
 * The JIT Reflex Gate — runs beside the memory micro-gate on every task
 * message. Below the threshold (or already fired this session) it returns
 * null: zero tokens. Above it: ONE line under 40 tokens, then the engram is
 * retired from this session's gate so it can never repeat.
 */
export function reflexGate(
  query: string,
  opts: ReflexOpts,
): { text: string; key: string; id: number; top: number } | null {
  const hits = reflexSearch(query, { ...opts, limit: 4 });
  if (!hits.length) return null;
  const top = hits[0];
  if (top.score < REFLEX_THRESHOLD) return null;
  const e = top.engram;
  const when = wordClamp(e.trigger_intent, 56);
  const line = aaakReflexLine({ when, avoid: e.anti_pattern_aaak, fast: e.fast_path_aaak });
  return { text: clampTokens(line, REFLEX_TOKEN_CAP), key: `engram:${e.id}`, id: e.id, top: top.score };
}

/** Truncate on a space when possible, so `when:` never ends mid-word. */
function wordClamp(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
}

// ===========================================================================
// The snapshot: [CHRONOS_DNA] + [CHRONOS_PULSE] + [CHRONOS_BEHAVIOR]
// ===========================================================================

/** Which AAAK slot each memory subject maps to in the DNA line. */
const SLOT_ORDER: Record<string, string> = {
  language: "lang",
  package_manager: "pkg",
  runtime: "pkg",
  ui_lib: "ui",
  framework: "ui",
  state_lib: "ui",
  animation_lib: "ui",
  test_runner: "wf",
  typecheck_command: "wf",
  build_command: "wf",
  dev_command: "wf",
  lint_command: "wf",
  source_layout: "arch",
  database: "arch",
  backend: "arch",
  orm: "arch",
  formatter: "ts",
  bundler: "ts",
};

export interface SnapshotInput {
  scope: string;
  project?: string | null;
  cwdProject?: string | null;
  now?: number;
}

export interface Snapshot {
  dna: string;
  pulse: string;
  text: string;
  tokens: number;
}

/** Persona bits: up to 8 stable slots, strongest edge per slot wins. */
export function dnaBits(scope: string): Record<string, string> {
  const bits: Record<string, string> = {};
  const edges = liveEdges(scope);
  for (const e of edges) {
    const k = SLOT_ORDER[e.subject];
    if (k && !bits[k]) bits[k] = e.object;
  }
  const styles = edges
    .filter((e) => e.category === "coding_style" && e.confidence >= 0.6)
    .slice(0, 3)
    .map((e) => e.object);
  if (styles.length) bits.err = styles.join(",");
  const cons = edges.filter((e) => e.category === "constraint").slice(0, 2).map((e) => e.object);
  if (cons.length) bits.con = cons.join(",");
  return bits;
}

const DROP_ORDER = ["con", "err", "wf", "arch", "ui", "ts", "pkg", "lang", "proj"];

function dropOne(bits: Record<string, string>): Record<string, string> {
  const next = { ...bits };
  for (const k of DROP_ORDER) {
    if (next[k]) {
      delete next[k];
      return next;
    }
  }
  return next;
}

/** Projects for the PULSE, newest first, with their open loops resolved. */
export function pulseProjects(limit = 3): PulseProject[] {
  return recentProjects(limit).map((r: ProjectRow) => ({
    project_name: r.project_name,
    current_focus: r.current_focus ? clampChars(r.current_focus, 30) : null,
    open_loops: openLoops(r.project_name).map((l) => clampChars(l, 24)),
    last_active_at: r.last_active_at,
    status: r.status,
  }));
}

function render(dna: string, pulse: string): string {
  return `[CHRONOS_DNA] ${dna}\n[CHRONOS_PULSE] ${pulse}\n${AAAK_BEHAVIOR}\n${AAAK_CORTEX}`;
}

/**
 * Build the injected block, degrading detail until it fits the budget:
 * full project detail -> fewer projects -> no detail -> smaller DNA.
 * The behaviour paragraph is never trimmed.
 */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const now = input.now ?? Date.now();
  const projects = pulseProjects(4);
  const baseBits = dnaBits(input.scope);
  const cwd = input.cwdProject ? clampChars(input.cwdProject, 24) : null;

  // Projects that keep focus/open detail wherever they sit: anything still
  // carrying an open loop — the greeting rule asks about exactly those.
  const loopNames = projects.filter((p) => (p.open_loops ?? []).length > 0).map((p) => p.project_name);

  const plans: Array<{ keep: number; detail: number; names: string[]; bits: Record<string, string> }> = [
    { keep: 3, detail: 1, names: loopNames, bits: baseBits },
    { keep: 2, detail: 1, names: loopNames, bits: baseBits },
    { keep: 3, detail: 0, names: [], bits: baseBits },
    { keep: 2, detail: 0, names: [], bits: dropOne(baseBits) },
    { keep: 1, detail: 0, names: [], bits: dropOne(dropOne(baseBits)) },
  ];

  let best: Snapshot | null = null;
  for (const plan of plans) {
    let bits = plan.bits;
    let dna = aaakDNA(bits);
    let pulse = aaakPulse({
      now,
      projects: projects.slice(0, plan.keep),
      cwdProject: cwd,
      detailCount: plan.detail,
      detailNames: plan.names,
    });
    while (estimateTokens(dna) > DNA_TOKEN_CAP && Object.keys(bits).length > 1) {
      bits = dropOne(bits);
      dna = aaakDNA(bits);
    }
    if (estimateTokens(pulse) > PULSE_TOKEN_CAP) {
      pulse = aaakPulse({ now, projects: projects.slice(0, Math.max(1, plan.keep - 1)), cwdProject: cwd, detailCount: 0 });
    }
    const text = render(dna, pulse);
    best = { dna, pulse, text, tokens: estimateTokens(text) };
    if (best.tokens <= SNAPSHOT_TOKEN_CAP) return best;
  }
  return best!;
}

/** Rebuild the frozen text from a stored snapshot (plugin reload, new boot). */
export function snapshotText(dna: string, pulse: string): string {
  return render(dna, pulse);
}

/** A tiny recap for compaction, from the same frozen pieces. */
export function compactRecap(snap: Snapshot, turns: number): string {
  const head = `[CTX|turns:${turns}]`;
  const parts = [snap.dna, snap.pulse, head];
  let out = parts.join(" ");
  if (estimateTokens(out) > 100) {
    out = [snap.dna, snap.pulse].join(" ");
  }
  return clampTokens(out, 100);
}

/** Number of vector dims — exported so tests can assert the contract. */
export const DIM = 384;

export { aaakMem, getProject };
