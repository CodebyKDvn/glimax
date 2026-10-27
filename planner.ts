// ===========================================================================
// planner.ts — v7.0 "OMNISCIENT" multi-operator query planner.
//
// Similarity search answers "which turn looks most like this question?".
// Five classes of question cannot be answered that way, no matter how good the
// embedding is:
//
//   multi-hop bridging   the gold turn shares no keyword with the question
//   temporal sequence    "what happened right after X" → turn X+k
//   state evolution      "what is the value *now*" → latest version, not best match
//   set enumeration      "list every <category>" → one slot per distinct event
//   causal threads       the fact lives in the tool output, not the request
//
// The lexical/semantic head stays the default answer. Each operator may only
// *replace* a weak slot — one whose text barely covers the question — and the
// number of replacements is capped by the intent. That asymmetry is deliberate:
// a wrong replacement costs a gold turn the base already had.
// ===========================================================================

import type { Database } from "bun:sqlite";
import {
  opCausal,
  opFacet,
  opGraphPpr,
  opSetCover,
  opState,
  opTemporal,
  subQueries,
  type OmniHit,
} from "./omni";

export type OpName = "sim" | "ppr" | "temporal" | "state" | "facet" | "setcover" | "causal";

export interface PlanCtx {
  db: Database;
  question: string;
  /** lexical/semantic head, best first (the pre-v7 union channel) */
  base: string[];
  textOf: (id: string) => string;
  sessionOf: (id: string) => string;
  speakerOf: (id: string) => string;
  neighbour: (id: string, delta: number) => string | null;
}

export interface Plan {
  ids: string[];
  intent: string[];
  /** which operator supplied each slot ("sim" = kept lexical, "pair" = reply) */
  origin: string[];
  ops: Record<string, number>;
  ms: number;
}

// ------------------------------------------------------------------ intents

const RE = {
  ordering:
    /\b(list the order|order in which|in what order|sequence|walk me through|timeline|in order)\b/i,
  summary: /\b(summar(y|ize|ise)|comprehensive (summary|overview)|recap|overview of (how|what))\b/i,
  state:
    /\b(current|currently|latest|now|nowadays|still|used to|previously|before switching|how many times|originally|initial|at first|no longer|switched|changed)\b/i,
  after: /\b(after|following|since|then|next|once i)\b/i,
  before: /\b(before|prior to|earlier|previous|until)\b/i,
  first: /\b(first|initially|earliest|began|started|originally)\b/i,
  last: /\b(last|latest|most recent|recently|finally)\b/i,
  causal: /\b(tool|command|output|result|returned|executed|ran|error|api|endpoint|function|script|response|log)\b/i,
  enumeration: /\b(list|all|every|each|which|what .{0,20}(have|did) i|across|both)\b/i,
  aggregate: /\b(across (our|my) (conversations|sessions|chats)|over time|progress(ed|ion)?|evolve|develop|throughout our|so far)\b/i,
};

export function detectIntents(q: string): string[] {
  const out: string[] = [];
  if (RE.ordering.test(q)) out.push("ordering");
  if (RE.summary.test(q)) out.push("summary");
  if (RE.state.test(q)) out.push("state");
  if (RE.after.test(q) || RE.before.test(q) || RE.first.test(q) || RE.last.test(q)) out.push("temporal");
  if (RE.causal.test(q)) out.push("causal");
  if (RE.enumeration.test(q)) out.push("enumeration");
  if (RE.aggregate.test(q)) out.push("aggregate");
  return out.length ? out : ["lookup"];
}

/** how many base slots the intent may give up, and to whom */
function budget(intents: string[]): { maxAdd: number; ops: OpName[] } {
  const ops: OpName[] = [];
  if (intents.includes("summary")) return { maxAdd: 6, ops: ["setcover", "temporal"] };
  if (intents.includes("ordering")) return { maxAdd: 4, ops: ["temporal"] };
  if (intents.includes("state")) return { maxAdd: 3, ops: ["state", "temporal"] };
  if (intents.includes("temporal")) return { maxAdd: 3, ops: ["temporal", "state"] };
  if (intents.includes("causal")) return { maxAdd: 2, ops: ["causal", "ppr"] };
  if (intents.includes("enumeration") || intents.includes("aggregate"))
    return { maxAdd: 4, ops: ["setcover", "facet"] };
  ops.push("ppr");
  return { maxAdd: 2, ops };
}

const CONF: Record<string, number> = {
  "temporal:after": 0.9,
  "temporal:before": 0.9,
  "temporal:first": 0.85,
  "temporal:last": 0.85,
  "temporal:topic": 0.8,
  "temporal:session": 0.6,
  "state:latest": 0.95,
  "state:history": 0.85,
  ppr: 0.7,
  causal: 0.7,
  setcover: 0.65,
  facet: 0.45,
};

// ---------------------------------------------------------------- selection

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function shingles(s: string, n = 5): Set<string> {
  const words = norm(s).match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  if (!out.size) for (const t of words) out.add(t);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const RARE_STOP = new Set(
  "what when where who which why how did does do is are was were the a an and or of to in on for with about my our your their his her its this that these those i me you we they he she it be been being have has had will would can could should may might must not no yes so as at by from into over under again just also very really there here then than all any some more most other such only own same too mention only items item order".split(
    " ",
  ),
);

export function rareTerms(q: string, max = 10): string[] {
  const words = norm(q).match(/[a-z0-9][a-z0-9'+-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (RARE_STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, max);
}

function coverageOf(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const low = norm(text);
  let hit = 0;
  for (const t of terms) if (low.includes(t)) hit++;
  return hit / terms.length;
}

export function plan(ctx: PlanCtx, k = 10): Plan {
  const t0 = Bun.nanoseconds();
  const { db, question } = ctx;
  const intents = detectIntents(question);
  const { maxAdd, ops: allowed } = budget(intents);
  const aggregate = intents.includes("summary") || intents.includes("aggregate") || intents.includes("ordering");
  const qt = rareTerms(question);
  const base = ctx.base.slice(0, Math.max(k, 10)).filter((id) => ctx.textOf(id));

  // ---- run only the operators this question class can use ----------------
  const safe = (fn: () => OmniHit[]): OmniHit[] => {
    try {
      return fn();
    } catch {
      return [];
    }
  };
  const anchors = base.slice(0, 10);
  const hits: Record<string, OmniHit[]> = {};
  // The graph is for questions that name a chain of relations ("the country of
  // citizenship of the spouse of the author of X"). On a plain lookup question
  // the bridge is a hub word and the hop-2 unit is noise.
  const chainShape = /\b(?:of|for|from|with)\s+the\s+.{3,48}?\b(?:of|for|from|with)\s+the\b/i.test(question);
  if (allowed.includes("ppr") && (chainShape || intents.includes("causal") || intents.includes("aggregate")))
    hits.ppr = safe(() => opGraphPpr(db, question, ctx.textOf, 40));
  if (allowed.includes("temporal"))
    hits.temporal = safe(() => opTemporal(db, question, anchors, ctx.textOf, (id) => ctx.speakerOf(id), 30));
  if (allowed.includes("state")) hits.state = safe(() => opState(db, question, 30));
  if (allowed.includes("causal")) hits.causal = safe(() => opCausal(db, anchors, 20));
  if (allowed.includes("facet")) hits.facet = safe(() => opFacet(db, question, 40));
  if (allowed.includes("setcover")) {
    const facets = subQueries(question);
    if (facets.length >= 2) hits.setcover = safe(() => opSetCover(db, question, buildPool(ctx, base), 12));
  }

  // ---- additions: operator hits that are not already in the head ---------
  const inBase = new Set(base);
  const add: Array<{ id: string; conf: number; op: string }> = [];
  const seenAdd = new Set<string>();
  for (const [name, list] of Object.entries(hits)) {
    const mx = Math.max(...list.map((h) => h.score), 1e-9);
    for (const h of list) {
      if (inBase.has(h.id) || seenAdd.has(h.id) || !ctx.textOf(h.id)) continue;
      const conf = (CONF[h.op] ?? CONF[name] ?? 0.5) * (0.55 + 0.45 * (h.score / mx));
      // a candidate with no overlap at all with the question only enters on a
      // very strong structural signal (state, causal sibling, bridge)
      const cov = coverageOf(qt, ctx.textOf(h.id));
      if (cov === 0 && conf < 0.75) continue;
      if (h.op === "ppr" && cov < 0.5) continue;
      seenAdd.add(h.id);
      add.push({ id: h.id, conf, op: h.op });
    }
  }
  add.sort((a, b) => b.conf - a.conf);

  // session cap: aggregate evidence must come from different places
  const cap = 3;
  const perSession = new Map<string, number>();
  for (const id of base.slice(0, 2)) perSession.set(ctx.sessionOf(id), (perSession.get(ctx.sessionOf(id)) ?? 0) + 1);
  const chosen: Array<{ id: string; conf: number; op: string }> = [];
  for (const a of add) {
    if (chosen.length >= maxAdd) break;
    const s = ctx.sessionOf(a.id);
    if ((perSession.get(s) ?? 0) >= cap) continue;
    perSession.set(s, (perSession.get(s) ?? 0) + 1);
    chosen.push(a);
  }

  // ---- replacement targets: the weakest slots of the head ----------------
  const supported = new Set<string>();
  for (const list of Object.values(hits)) for (const h of list) supported.add(h.id);
  const keepScore = base.map(
    (id, i) =>
      0.7 * coverageOf(qt, ctx.textOf(id)) +
      0.3 * (1 - i / Math.max(1, k)) +
      (supported.has(id) ? 0.25 : 0) + // an operator independently found it: keep
      (aggregate && ctx.speakerOf(id).toLowerCase() === "user" ? 0.3 : 0), // aggregate gold is user-side
  );
  const drop = new Set<number>();
  // Aggregate gold is user-side ("the order in which I brought X up"), so for
  // those intents only assistant turns are expendable; a user turn in the head
  // is more likely gold than anything an operator can add.
  const expendable = (i: number) =>
    i >= 2 && !(aggregate && ctx.speakerOf(base[i]).toLowerCase() === "user");
  const order = base
    .map((_, i) => i)
    .filter(expendable)
    .sort((a, b) => keepScore[a] - keepScore[b]);
  // A replacement has to *win*: an operator candidate only evicts a slot when
  // its confidence clears that slot's keep score by a margin. Otherwise the
  // ten slots stay exactly as the lexical head produced them.
  let accepted = 0;
  for (const i of order) {
    if (accepted >= chosen.length) break;
    const margin = supported.has(base[i]) ? 0.35 : 0.12;
    if (chosen[accepted].conf <= keepScore[i] + margin) continue;
    drop.add(i);
    accepted++;
  }
  chosen.length = accepted;
  // if the head is shorter than k there is nothing to drop
  const kept = base.filter((_, i) => !drop.has(i));

  // ---- final order: anchors, strongest additions, rest of the head -------
  const strong = chosen.filter((c) => c.conf >= 0.75);
  const weak = chosen.filter((c) => c.conf < 0.75);
  const ids = [...kept.slice(0, 2), ...strong.map((c) => c.id), ...kept.slice(2), ...weak.map((c) => c.id)];
  const origin = [
    ...kept.slice(0, 2).map(() => "sim"),
    ...strong.map((c) => c.op),
    ...kept.slice(2).map(() => "sim"),
    ...weak.map((c) => c.op),
  ];

  // ---- adjacency: aggregate gold is usually a user+assistant pair --------
  // The reply is a strong signal for summary/ordering gold, so it may take a
  // slot — but only from a weak lexical tail slot (coverage < 0.34), never from
  // an operator pick or one of the two anchors.
  if (intents.includes("summary") || intents.includes("ordering")) {
    const out = ids.slice(0, k);
    const outOrigin = origin.slice(0, k);
    const present = new Set(out);
    const weakSlot = (j: number) =>
      j >= 2 &&
      (outOrigin[j] === "sim" || outOrigin[j] === "pair") &&
      ctx.speakerOf(out[j]).toLowerCase() !== "user" &&
      coverageOf(qt, ctx.textOf(out[j])) < 0.34;
    let swaps = 0;
    for (let i = 0; i < out.length && swaps < 3; i++) {
      const id = out[i];
      const isUser = ctx.speakerOf(id).toLowerCase() === "user";
      const nb = ctx.neighbour(id, isUser ? 1 : -1);
      if (!nb || present.has(nb) || !ctx.textOf(nb)) continue;
      for (let j = out.length - 1; j >= 2; j--) {
        if (!weakSlot(j)) continue;
        present.delete(out[j]);
        out[j] = nb;
        outOrigin[j] = "pair";
        present.add(nb);
        swaps++;
        break;
      }
    }
    return { ids: out, intent: intents, origin: outOrigin, ops: countOps(hits), ms: ms(t0) };
  }

  return { ids: ids.slice(0, k), intent: intents, origin: origin.slice(0, k), ops: countOps(hits), ms: ms(t0) };
}

const ms = (t0: number) => (Bun.nanoseconds() - t0) / 1e6;
const countOps = (hits: Record<string, OmniHit[]>) =>
  Object.fromEntries(Object.entries(hits).map(([n, l]) => [n, l.length]));

/**
 * Lexical pool for set-cover: the similarity head plus every turn of the
 * sessions the head already touched. That is where the rest of an enumeration
 * lives (the second, third, fourth event of the same topic).
 */
function buildPool(ctx: PlanCtx, base: string[]): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id) || out.length >= 220) return;
    const text = ctx.textOf(id);
    if (!text) return;
    seen.add(id);
    out.push({ id, text });
  };
  base.slice(0, 40).forEach(push);
  const sessions = [...new Set(base.slice(0, 5).map((id) => ctx.sessionOf(id)))].filter(Boolean);  for (const s of sessions) {
    const rows = ctx.db
      .query("SELECT unit_id FROM omni_timeline WHERE session_id = ? ORDER BY turn_ordinal LIMIT 80")
      .all(s) as Array<{ unit_id: string }>;
    for (const r of rows) push(r.unit_id);
  }
  return out;
}
