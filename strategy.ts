// ===========================================================================
// strategy.ts — query-intent routing and non-similarity evidence selection.
//
// Similarity search answers "which turn looks most like this question?". That
// is the wrong question for aggregate intents: "list the order in which I
// brought up X", "summarize how the project progressed". There the gold
// evidence is the *first* turn of each topical block — a turn that opens a
// subject and is therefore lexically unlike the question and unlike the
// follow-ups that repeat it.
//
// This module adds the missing signal, with no model and no tokens:
//   • classifyIntent()  — aggregate / preference / lookup
//   • selectEvidence()  — for aggregate intents, rank user turns by
//                         relevance + novelty-against-earlier-user-turns +
//                         self-containedness, then fill the rest with the
//                         plain similarity head so fact questions keep working.
//
// Novelty uses the caller's vectors when it has them (the benchmark harness
// passes sentence embeddings) and falls back to the plugin's own SimHash
// `embed()` so the runtime path needs nothing extra.
// ===========================================================================

import { cosine, embed } from "./aaak";

export type Intent = "ordering" | "summary" | "aggregate" | "preference" | "lookup";

const ORDERING_RE =
  /\b(list the order|order in which|in what order|sequence|walk me through|when did i first|first mention|timeline)\b/i;

const SUMMARY_RE = /\b(summar(y|ize|ise)|comprehensive (summary|overview)|recap|overview of (how|what))\b/i;

const AGGREGATE_RE =
  /\b(list|across (our|my) (conversations|sessions|chats)|over time|progress(ed|ion)?|how (has|did|have) .{0,40}(evolve|develop|change|progress)|what did i learn|history|so far)\b/i;

const PREFERENCE_RE =
  /\b(prefer|preference|rather|favorite|favourite|like better|style|tone|convention|always use|never use)\b/i;

export function classifyIntent(question: string): Intent {
  const q = String(question ?? "");
  if (ORDERING_RE.test(q)) return "ordering";
  if (SUMMARY_RE.test(q)) return "summary";
  if (AGGREGATE_RE.test(q)) return "aggregate";
  if (PREFERENCE_RE.test(q)) return "preference";
  return "lookup";
}

export interface Candidate {
  /** stable evidence id */
  id: string;
  /** conversation / batch the turn belongs to */
  session?: string;
  /** "user" | "assistant" | ... */
  speaker?: string;
  /** position in the conversation, ascending */
  ordinal: number;
  /** relevance score from whatever channel produced the candidate */
  score: number;
  text: string;
  /** optional embedding; falls back to SimHash */
  vec?: Float32Array;
}

const isUser = (c: Candidate): boolean => String(c.speaker ?? "").toLowerCase() === "user";

/** A turn that opens a subject: first person, declarative, not a one-liner. */
function openerPrior(text: string): number {
  const t = String(text ?? "").trim();
  let p = 0;
  if (/^(i'?m trying|i'?m having|i want|i need|i'?m working|i'?d like|i'?m looking|i'?ve been|i am)/i.test(t)) p += 0.08;
  if (t.length >= 120) p += 0.04;
  if (t.length < 40) p -= 0.04;
  return p;
}

/**
 * Novelty of each candidate against the user turns that came before it:
 * 1 - max cosine similarity. A first mention is novel; a follow-up ("hmm,
 * what about the 300ms case?") is not.
 */
function noveltyOf(cands: Candidate[]): Map<string, number> {
  const vecs = new Map<string, Float32Array>();
  for (const c of cands) vecs.set(c.id, c.vec ?? embed(c.text));
  const ordered = [...cands].sort((a, b) => a.ordinal - b.ordinal);
  const out = new Map<string, number>();
  const seen: Candidate[] = [];
  for (const c of ordered) {
    const v = vecs.get(c.id)!;
    if (!isUser(c)) {
      out.set(c.id, 0);
      continue;
    }
    let mx = 0;
    for (const p of seen) {
      if (p.session && c.session && p.session !== c.session) continue;
      const s = cosine(v, vecs.get(p.id)!);
      if (s > mx) mx = s;
    }
    out.set(c.id, seen.length ? 1 - mx : 1);
    seen.push(c);
  }
  return out;
}

/**
 * Select up to `k` evidence ids.
 *
 * ordering: spend every slot on user-turn openers — the gold is the list of
 *   first mentions, so replies would waste half the packet.
 * summary:  five opener+reply pairs, one per topical block — the gold is
 *   user/assistant pairs spread across the conversation.
 * aggregate / preference: `openerSlots` openers, then plain relevance.
 * lookup: pure relevance.
 */
export function selectEvidence(cands: Candidate[], intent: Intent, k = 10, openerSlots = 6): string[] {
  const byScore = [...cands].sort((a, b) => b.score - a.score);
  if (intent === "lookup" || cands.length <= k) return byScore.slice(0, k).map((c) => c.id);

  const novelty = noveltyOf(cands);
  const lam = intent === "preference" ? 0.15 : 0.3;
  const slots = intent === "ordering" ? k : intent === "summary" ? Math.ceil(k / 2) : Math.min(openerSlots, k);
  const openers = byScore
    .filter(isUser)
    .slice()
    .sort(
      (a, b) =>
        b.score + lam * (novelty.get(b.id) ?? 0) + openerPrior(b.text) -
        (a.score + lam * (novelty.get(a.id) ?? 0) + openerPrior(a.text)),
    )
    .slice(0, slots);

  const byOrdinal = new Map(cands.map((c) => [c.ordinal, c]));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id) || out.length >= k) return;
    seen.add(id);
    out.push(id);
  };
  for (const o of openers) {
    push(o.id);
    if (intent !== "summary") continue;
    const reply = byOrdinal.get(o.ordinal + 1);
    if (reply && !isUser(reply)) push(reply.id);
  }
  for (const c of byScore) push(c.id);
  return out;
}
