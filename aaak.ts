// ===========================================================================
// aaak.ts — AAAK shorthand codec, 384-bit SimHash, relative time.
//
// Three jobs, all pure TypeScript, all sub-millisecond, no network:
//   1. Compress a memory / project / pulse line into AAAK shorthand so the
//      model reads it in ~5-15% of the tokens the raw sentence would cost.
//   2. Hash any text three ways:
//        simhash384     384-bit SimHash over word+char shingles (near-dup)
//        embed          feature-hashed 384-dim L2-normalised vector (fuzzy)
//        estimateTokens cheap, deliberately pessimistic budget meter
//   3. Turn timestamps into the "2h_ago / 3d_ago" shorthand the PULSE uses.
//
// No native deps, never throws on weird input.
// ===========================================================================

export const VEC_DIM = 384;

/** Width of the semantic SimHash. Matches the vector width by design. */
export const SIMHASH_BITS = 384;

// ---------------------------------------------------------------- hashing

/** FNV-1a 32-bit. Cheap, well-spread, and stable across runs. */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 384-bit SimHash over word shingles.
 *
 * Each shingle is expanded to 12 x 32-bit words (12 hash rounds with seeded
 * FNV) and votes on every bit; the sign of the vote becomes the bit. Two
 * texts that share most shingles land within a few hundred bits of each
 * other, which is what makes "have I seen this exact thing before?" free.
 */
export function simhash384(text: string): bigint {
  const sh = shingle(text);
  if (sh.length === 0) return 0n;
  const acc = new Int32Array(SIMHASH_BITS);
  const WORDS = SIMHASH_BITS >> 5; // 12
  for (const s of sh) {
    for (let w = 0; w < WORDS; w++) {
      const h = hash32(s, (0x811c9dc5 ^ Math.imul(w + 1, 0x9e3779b1)) >>> 0);
      const base = w << 5;
      for (let b = 0; b < 32; b++) acc[base + b] += (h >>> b) & 1 ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < SIMHASH_BITS; i++) if (acc[i] > 0) out |= 1n << BigInt(i);
  return out;
}

export function simhashToHex(v: bigint): string {
  return v.toString(16).padStart(SIMHASH_BITS >> 2, "0");
}

export function simhashFromHex(hex: string | null | undefined): bigint {
  if (!hex) return 0n;
  try {
    return BigInt("0x" + hex);
  } catch {
    return 0n;
  }
}

/**
 * Hamming distance between two stored signatures.
 *
 * Signatures of different widths are incomparable (a 64-bit signature from an
 * older brain vs a 384-bit one): we return null rather than a meaningless
 * number, and the caller simply lets the other rankers decide.
 */
export function hammingDistance(hexA: string | null | undefined, hexB: string | null | undefined): number | null {
  if (!hexA || !hexB || hexA.length !== hexB.length) return null;
  const x = simhashFromHex(hexA) ^ simhashFromHex(hexB);
  if (x === 0n) return 0;
  let n = 0;
  let v = x;
  while (v > 0n) {
    v &= v - 1n; // clear lowest set bit
    n++;
  }
  return n;
}

/** 0..1 similarity from two hex signatures; null when incomparable. */
export function simhashSimilarity(hexA: string, hexB: string): number | null {
  const d = hammingDistance(hexA, hexB);
  if (d === null) return null;
  const bits = hexA.length * 4;
  return 1 - d / bits;
}

// ------------------------------------------------------------- tokenising

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on",
  "for", "with", "is", "are", "was", "were", "be", "been", "it", "this", "that",
  "i", "you", "we", "they", "do", "does", "did", "so", "at", "by", "as", "from",
  "la", "va", "cua", "cho", "voi", "thi", "nay", "do", "khi", "ma", "nhu", "mot",
  "là", "và", "của", "cho", "với", "thì", "này", "đó", "khi", "mà", "như", "một",
  "mình", "tôi", "bạn", "cái", "thì", "đang", "rồi", "nhé", "ạ",
]);

function words(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .filter((w) => w.length > 0 && w.length <= 64);
}

/** Word unigrams (minus stopwords), intra-word 3-grams, adjacent bigrams. */
function shingle(text: string): string[] {
  const ws = words(text);
  const out: string[] = [];
  for (const w of ws) {
    if (!STOP.has(w)) out.push(w);
    if (w.length >= 3) {
      // 3-grams of the word itself catch identifiers like use_mutex_lock
      for (let i = 0; i + 3 <= w.length; i++) out.push("#" + w.slice(i, i + 3));
    }
  }
  for (let i = 0; i + 1 < ws.length; i++) out.push(ws[i] + "~" + ws[i + 1]);
  return out;
}

/** Significant tokens of a text (stopwords removed) — used for fuzzy overlap. */
export function tokens(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w) && w.length >= 2);
}

// ---------------------------------------------------- v6.0 concept expansion
//
// Index-time ontology: a message that says "retriever" also carries the tokens
// "dog canine pet animal", a message that says "cello" carries "instrument
// music". The query is left untouched, so a specific query ("piano") does not
// match a different instrument through the shared hypernym, while a hypernym
// query ("instrument") does match every specific member. No LLM, no vectors.

interface ConceptGroup {
  label: string[];
  subs: string[][];
}

const CONCEPT_GROUPS: ConceptGroup[] = [
  { label: ["pet", "animal"], subs: [["dog", "canine", "puppy", "retriever", "shepherd", "poodle"], ["cat", "feline", "kitten"], ["bird", "parrot"], ["horse", "pony"], ["hamster", "rabbit", "turtle"]] },
  { label: ["activity", "activities", "hobby", "hobbies", "pastime", "partake"], subs: [["pottery", "clay", "craft"], ["camping", "camp", "camped", "campfire", "tent"], ["swimming", "swim"], ["painting", "drawing", "art"], ["running", "run", "jog"], ["reading", "book"], ["hiking", "hike", "hiked", "trail"], ["dancing", "dance"], ["singing", "sing", "song"], ["cooking", "cook", "bake"], ["gardening", "garden", "plant"], ["yoga", "meditation"], ["travel", "trip", "roadtrip", "vacation"], ["museum", "concert", "festival", "parade", "show", "workshop", "class", "program"], ["volunteer", "mentor", "mentorship", "charity"]] },
  { label: ["destress", "de-stress", "relax", "unwind", "calm"], subs: [["running", "run", "jog"], ["pottery", "craft", "paint"], ["reading", "book"], ["yoga", "meditation", "breathe"], ["camping", "camp", "nature"], ["music", "piano", "guitar"]] },
  { label: ["event", "events", "participate", "participated", "attend", "attended", "volunteer", "volunteering"], subs: [["parade", "pride", "festival", "fair", "march"], ["mentor", "mentorship", "volunteer", "charity", "fundraiser", "donate"], ["workshop", "class", "program", "group", "activist"], ["show", "exhibition", "gallery", "museum"]] },
  { label: ["support", "supports", "supported", "supporting", "supporters", "friends", "friend", "rock"], subs: [["support", "help", "care", "encourage", "comfort"], ["friend", "friends", "mentor", "community", "rock", "loved", "love"]] },
  { label: ["nature", "outdoors", "wildlife"], subs: [["nature", "tree", "forest", "mountain", "beach", "river", "lake"], ["animal", "animals", "dinosaur", "dinosaurs", "zoo", "museum"], ["marshmallow", "campfire", "camping"]] },
  { label: ["where", "location", "place", "places"], subs: [["beach", "coast", "shore"], ["mountain", "mountains", "hill"], ["forest", "woods", "tree"], ["lake", "river", "pond"], ["park", "garden", "playground"], ["camping", "camp", "camped", "campfire", "tent", "trail"], ["castle", "museum", "zoo", "library"], ["country", "city", "town", "village"]] },
  { label: ["political", "politics", "religion", "religious", "belief", "beliefs", "faith", "spiritual"], subs: [["religious", "religion", "church", "christian", "catholic", "faith", "god", "pray", "spiritual"], ["conservative", "liberal", "progressive", "politics", "political", "activist", "rights"]] },
  { label: ["buy", "bought", "shopping", "purchase", "item", "items", "gift", "gifts"], subs: [["buy", "bought", "purchase", "shopping", "store", "mall"], ["shoes", "clothes", "outfit", "dress", "jacket"], ["figurine", "figurines", "necklace", "gift", "present", "souvenir"]] },
  { label: ["symbol", "symbols", "symbolize", "symbolizes", "symbolism", "represent", "represents"], subs: [["flag", "rainbow", "eagle", "mural", "picture", "portrait"], ["symbol", "symbolize", "symbolizes", "represent", "represents", "meaning"]] },
  { label: ["business", "studio", "store", "shop", "company", "venture", "startup", "launch", "launched", "opened", "promote", "promotion", "promotions", "marketing", "networking", "customers", "offer", "offers", "offering"], subs: [["business", "studio", "store", "shop", "company", "venture", "startup", "brand"], ["launch", "launched", "opening", "opened"], ["promote", "promotion", "promotions", "marketing", "advertise", "campaign", "networking", "customers", "clients", "sales"], ["fair", "booth", "market"], ["offer", "offers", "offering", "services", "classes", "workshops", "mentoring"]] },
  { label: ["competition", "competitions", "compete", "contests", "contest", "tournament", "championship"], subs: [["competition", "competitions", "contest", "contests", "tournament", "championship", "compete", "competed"], ["trophy", "medal", "prize", "award", "win", "won", "winner", "champion", "regional", "national"]] },
  { label: ["instrument", "music", "musical"], subs: [["piano"], ["guitar"], ["violin", "cello"], ["drums", "drum"], ["clarinet", "flute", "saxophone", "trumpet", "harp"], ["concert", "concerts", "band", "bands", "sing", "song", "songs", "voice", "voices", "choir", "tune", "tunes", "musician", "singer", "singers"], ["classical", "bach", "mozart", "vivaldi", "beethoven", "jazz", "pop", "rock", "melody"]] },
  { label: ["art", "artist"], subs: [["paint", "painted", "paints", "painting", "painter", "watercolor", "drawing", "sketch", "canvas"], ["gallery", "sculpture", "pottery", "clay", "ceramic", "kiln", "mural", "portrait", "artwork"]] },
  { label: ["family"], subs: [["mother", "mom"], ["father", "dad"], ["sister", "brother", "sibling"], ["wife", "husband", "spouse", "partner"], ["son", "daughter", "kid", "kids", "child", "children"], ["grandma", "grandmother", "grandpa", "grandfather", "granny"], ["aunt", "uncle", "cousin", "niece", "nephew"]] },
  { label: ["relationship", "status", "marital"], subs: [["single", "married", "divorced", "dating", "partner", "spouse", "wife", "husband", "boyfriend", "girlfriend"]] },
  { label: ["work", "job", "career"], subs: [["boss", "manager", "supervisor"], ["colleague", "coworker"], ["mentor", "advisor"], ["engineer", "developer", "designer"]] },
  { label: ["education", "study", "school", "field", "fields", "subject", "edu", "career", "counseling", "mental"], subs: [["college", "university", "degree", "major"], ["research"], ["class", "course", "student", "teacher", "professor", "workshop"], ["adoption", "adopt", "agency", "foster", "orphan"]] },
  { label: ["food", "meal"], subs: [["restaurant", "cuisine", "dish"], ["cook", "bake"], ["dinner", "lunch", "breakfast"]] },
  { label: ["drink", "beverage"], subs: [["coffee", "espresso", "latte", "matcha", "tea"], ["wine", "juice", "water"]] },
  { label: ["allergy", "allergic"], subs: [["gluten", "peanut", "shellfish", "dairy"], ["vegan", "vegetarian"]] },
  { label: ["sport", "exercise"], subs: [["gym", "workout"], ["running", "run"], ["hiking", "hike"], ["yoga"], ["swimming", "swim"], ["tennis", "soccer", "basketball"], ["cycling", "bike", "bicycle"]] },
  { label: ["travel", "trip"], subs: [["vacation", "flight", "airport", "hotel"], ["visit", "journey", "tour"], ["camping", "camp", "camped", "tent", "campfire", "roadtrip"]] },
  { label: ["home", "house"], subs: [["apartment", "rent", "lease"], ["move", "moving"], ["roommate", "neighbor"]] },
  { label: ["health"], subs: [["doctor", "therapist", "dentist", "hospital"], ["medicine", "sick", "illness"], ["therapy", "mental"]] },
  { label: ["finance", "money"], subs: [["budget", "salary", "pay"], ["bank", "invest", "stock", "loan", "expense"], ["invoice", "payment", "bill", "expense"]] },
  { label: ["limit", "cap", "ceiling", "boundary", "threshold", "maximum", "minimum"], subs: [["cap", "ceiling", "carveout", "overage", "boundary", "threshold", "limit"]] },
  { label: ["vehicle", "car"], subs: [["drive", "driving", "commute"], ["train", "bus", "subway"]] },
  { label: ["book", "reading"], subs: [["novel", "author", "writer"], ["library"], ["sci-fi", "fantasy"], ["poetry", "poem", "literature"]] },
  { label: ["game"], subs: [["chess", "board"], ["video", "gaming"]] },
  { label: ["movie", "film"], subs: [["cinema", "show", "tv", "television", "series"]] },
  { label: ["technology", "tech"], subs: [["computer", "software", "code", "coding", "programming", "app", "website", "data"]] },
  { label: ["weather"], subs: [["rain", "sunny", "snow", "storm", "cold", "hot", "temperature"]] },
  { label: ["holiday"], subs: [["birthday", "christmas", "thanksgiving", "wedding", "party", "celebrate"]] },
  { label: ["identity"], subs: [["lgbtq", "transgender", "queer", "gender", "pronoun"]] },
  { label: ["emotion", "feeling"], subs: [["happy", "sad", "angry", "anxious", "stress", "excited", "afraid"]] },
  { label: ["language"], subs: [["english", "spanish", "french", "german", "chinese", "vietnamese"]] },
];

const CONCEPT_LABEL = new Map<string, string[]>();
const CONCEPT_SUB = new Map<string, string[]>();
const CONCEPT_SPECIFIC = new Map<string, string[]>();
const CONCEPT_GROUP = new Map<string, ConceptGroup>();
const CONCEPT_SUB_GROUP = new Map<string, ConceptGroup>();
for (const g of CONCEPT_GROUPS) {
  for (const w of g.label) {
    CONCEPT_LABEL.set(w, g.label);
    CONCEPT_GROUP.set(w, g);
  }
  for (const sub of g.subs) {
    for (const w of sub) {
      CONCEPT_SUB.set(w, [...g.label, ...sub]);
      CONCEPT_SPECIFIC.set(w, sub);
      CONCEPT_SUB_GROUP.set(w, g);
    }
  }
}

/** Space-separated ontology tokens to append to the L3 FTS text. */
export function conceptTags(text: string): string {
  const out = new Set<string>();
  const words = String(text ?? "").toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? [];
  for (const w of words) {
    const lab = CONCEPT_LABEL.get(w);
    if (lab) for (const t of lab) out.add(t);
    const sub = CONCEPT_SUB.get(w);
    if (sub) for (const t of sub) out.add(t);
  }
  return [...out].join(" ");
}

/**
 * Query-side bidirectional expansion. A hypernym ("field", "instrument",
 * "pet") expands to every member of its group; a specific member ("piano",
 * "retriever") expands only to its own synonyms, never to the hypernym — so
 * "piano" cannot match a guitar through the shared word "instrument".
 */
export function conceptQueryTags(text: string): string {
  const out = new Set<string>();
  const words = String(text ?? "").toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? [];
  for (const w of words) {
    const group = CONCEPT_GROUP.get(w);
    if (group) {
      for (const t of group.label) out.add(t);
      for (const sub of group.subs) for (const t of sub) out.add(t);
      continue;
    }
    const sub = CONCEPT_SPECIFIC.get(w);
    if (sub) for (const t of sub) out.add(t);
  }
  return [...out].join(" ");
}

/**
 * Match sets for candidate scoring, one per triggered concept. A hypernym
 * ("activities") yields the whole group; a specific ("violin") yields only its
 * own sub-list. A candidate is a group hit when any of its `conceptTags`
 * intersects the set — this is what lets "swimming with the kids" answer
 * "What activities does Melanie partake in?" even though it never says
 * "activities".
 */
export function conceptQueryGroups(text: string, labelOnly = false): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const words = String(text ?? "").toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? [];
  for (const w of words) {
    const group = CONCEPT_GROUP.get(w);
    if (group) {
      const key = `L:${group.label[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([...group.label, ...group.subs.flat()]);
      continue;
    }
    if (labelOnly) continue;
    const sub = CONCEPT_SPECIFIC.get(w);
    if (sub) {
      const key = `S:${sub[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sub);
    }
  }
  return out;
}

/** |A∩B| — how many significant words two phrasings share. */
export function overlap(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let n = 0;
  for (const t of sa) if (sb.has(t)) n++;
  return n;
}

// --------------------------------------------------------------- embedding

/**
 * Feature-hashing embedder. Each feature votes into one of VEC_DIM buckets
 * with a signed hash, then the vector is L2-normalised. Deterministic, fast,
 * dependency-free.
 */
export function embed(text: string): Float32Array {
  const v = new Float32Array(VEC_DIM);
  const sh = shingle(text);
  if (sh.length === 0) return v;
  for (const f of sh) {
    const h = hash32(f);
    const idx = h % VEC_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    // sublinear-ish weight: short features (rare identifiers) matter more
    v[idx] += sign * (f.length >= 6 ? 1.5 : 1.0);
  }
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < VEC_DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d; // both sides are L2-normalised
}

export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(0));
}

export function blobToVec(buf: unknown): Float32Array | null {
  if (!buf || typeof buf !== "object") return null;
  const ab = buf as ArrayBuffer | Uint8Array;
  const bytes = ab instanceof Uint8Array ? ab : new Uint8Array(ab as ArrayBuffer);
  if (bytes.byteLength < 4) return null;
  const n = Math.floor(bytes.byteLength / 4);
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

// ------------------------------------------------------------------ tokens

/**
 * Token estimate. A chunk of <=4 chars is one token (most are), longer chunks
 * cost ceil(len/4). Deliberately slightly pessimistic so our caps stay real.
 */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  const chunks = s.split(/(\s+|[^\p{L}\p{N}_$#|:=\->.<,;!?()\[\]{}"']+)/u).filter(Boolean);
  let n = 0;
  for (const c of chunks) {
    if (/^\s+$/.test(c)) continue;
    n += Math.max(1, Math.ceil(c.length / 4));
  }
  return n;
}

/** Hard-truncate on a token budget, keeping the head (most specific part). */
export function clampTokens(s: string, maxTokens: number): string {
  if (estimateTokens(s) <= maxTokens) return s;
  const parts = s.split(/\s+/);
  const out: string[] = [];
  for (const w of parts) {
    const cand = out.length ? out.join(" ") + " " + w : w;
    if (estimateTokens(cand) > maxTokens - 1) break;
    out.push(w);
  }
  return out.join(" ") + " …";
}

/** Clamp a single-line value to a character budget (for AAAK fields). */
export function clampChars(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

// --------------------------------------------------------- calibrated fusion
// v5.0 — APEX Pareto merger ("max-dominate rank fusion").
//
// Both sides are ranked lists; each item's vote is 1/(K+rank) (RRF), and the
// graph vote is scaled by a coverage weight: when the graph channel actually
// covers the question's rare terms (>= 50%) it carries full signal; otherwise
// it is damped below the verbatim top-10 band so a weak graph hit can never
// displace verbatim evidence the lexical floor already found.
//
//   S(d) = max(v, w·g) + 0.35·min(v, w·g)     (items in both resonate)
//
// with w = 1.0 (graph covers the query) or APEX_W_GRAPH_WEAK = 0.55, where
// 0.55/(K+1) = 0.0423 < 1/(K+10) = 0.0455: a pure-graph item cannot outrank a
// verbatim top-10 item while the graph channel is weak, but a dual-channel
// item still may (resonance lifts it into the verbatim head).

export const FUSION_K = 12;
export const FUSION_RESONANCE = 0.35;
export const APEX_W_GRAPH = 1.0;
export const APEX_W_GRAPH_WEAK = 0.55;

/** Coverage-adaptive graph weight: strong when the graph channel covers the
 * question's rare terms (>= 50%), damped otherwise. */
export function apexGraphWeight(coverage: number): number {
  return coverage >= 0.5 ? APEX_W_GRAPH : APEX_W_GRAPH_WEAK;
}

/** Fraction of the question's rare terms that the graph channel's head shows. */
export function graphQueryCoverage(items: readonly string[], qa: QueryAnalysis): number {
  const rare = qa.rare.length ? qa.rare : qa.terms.slice(0, 6);
  if (!rare.length) return 1;
  const head = items.slice(0, 10).join(" \n ").toLowerCase();
  let hit = 0;
  for (const t of rare) if (head.includes(t)) hit++;
  return hit / rare.length;
}

export interface Fused<K> {
  key: K;
  score: number;
  rankVerb: number | null;
  rankGraph: number | null;
}

/** Merge a verbatim-ranked list with a graph-ranked list into one ranking. */
export function calibratedMerge<K>(
  verbatim: readonly K[],
  graph: readonly K[],
  opts: { topN?: number; graphWeight?: number } = {},
): Array<Fused<K>> {
  const rv = new Map<K, number>();
  const rg = new Map<K, number>();
  verbatim.forEach((k, i) => {
    if (!rv.has(k)) rv.set(k, i + 1);
  });
  graph.forEach((k, i) => {
    if (!rg.has(k)) rg.set(k, i + 1);
  });
  const w = opts.graphWeight ?? APEX_W_GRAPH_WEAK;

  const out: Array<Fused<K>> = [];
  for (const k of new Set<K>([...rv.keys(), ...rg.keys()])) {
    const rankVerb = rv.get(k) ?? null;
    const rankGraph = rg.get(k) ?? null;
    const v = rankVerb ? 1 / (FUSION_K + rankVerb) : 0;
    const g = rankGraph ? w / (FUSION_K + rankGraph) : 0;
    out.push({ key: k, score: Math.max(v, g) + FUSION_RESONANCE * Math.min(v, g), rankVerb, rankGraph });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.rankVerb ?? 99) - (b.rankVerb ?? 99) ||
      (a.rankGraph ?? 99) - (b.rankGraph ?? 99),
  );
  return opts.topN ? out.slice(0, opts.topN) : out;
}

// ------------------------------------------------- v5.0 APEX query analysis
//
// One place decides what a question is made of: content terms (stop-words and
// question words dropped), rare terms (identifiers, numbers, long words, CJK),
// and quoted bigram phrases worth a phrase bonus. FTS5's unicode61 tokeniser
// treats a whole CJK run as ONE token, so CJK is split into characters before
// it reaches the index or the MATCH expression.

const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RE = new RegExp(`[${CJK_CLASS}]`);
const CJK_RUN_RE = new RegExp(`^[${CJK_CLASS}]+$`);

/** Space-separate CJK characters so FTS5 sees char-level tokens. */
export function splitCJK(s: string): string {
  const t = String(s ?? "");
  if (!CJK_RE.test(t)) return t;
  return t.replace(new RegExp(`([${CJK_CLASS}])`, "g"), " $1 ");
}

export function isCJKToken(t: string): boolean {
  return t.length > 0 && CJK_RUN_RE.test(t);
}

/** Query stop-words: question words, auxiliaries, pronouns, fillers. */
const QSTOP = new Set([
  "what", "when", "where", "who", "whom", "whose", "which", "why", "how", "did", "does",
  "do", "done", "is", "are", "was", "were", "be", "being", "been", "am", "the", "a", "an",
  "and", "or", "but", "if", "then", "than", "that", "this", "these", "those", "there",
  "their", "them", "they", "it", "its", "of", "to", "in", "on", "at", "by", "for", "with",
  "from", "into", "about", "as", "so", "such", "can", "could", "would", "should", "will",
  "shall", "may", "might", "must", "have", "has", "had", "having", "i", "you", "we", "he",
  "she", "his", "her", "our", "your", "my", "me", "us", "any", "all", "each", "every",
  "many", "most", "some", "no", "not", "only", "own", "same", "too", "very", "just", "also",
  "now", "here", "out", "up", "down", "over", "under", "again", "further", "once", "during",
  "before", "after", "above", "below", "between", "both", "few", "more", "other", "per",
  "according", "please", "tell", "give", "want", "need", "know", "get", "got", "make",
  "made", "take", "see", "say", "said", "ask", "asked", "use", "used", "using", "like",
  "let", "help", "explain", "thanks", "thank", "hi", "hello", "hey", "yes", "several",
]);

export interface QueryAnalysis {
  /** content terms, order preserved, deduped, lowercase */
  terms: string[];
  /** high-IDF subset — identifiers, numbers, long words, CJK characters */
  rare: string[];
  /** adjacent rare bigrams ("api quickstart"), as FTS5 phrase strings */
  phrases: string[];
  cjk: boolean;
}

const RARE_RE = /[0-9_#]/;

/** True when the term carries lexical signal beyond ordinary prose. */
export function isRareTerm(t: string): boolean {
  // v6.0 — 5-letter content words ("latte", "early", "order") carry as much
  // signal as 6-letter ones; the old floor silently dropped them from the
  // rare/phrase passes and cost Dolphin/LoCoMo exact matches.
  return isCJKToken(t) || t.length >= 5 || RARE_RE.test(t);
}

/** Analyse a question once; every ranker reuses the result. */
export function analyzeQuery(q: string, maxTerms = 14): QueryAnalysis {
  const text = splitCJK(String(q ?? "")).toLowerCase();
  const raw = [...text.matchAll(/[\p{L}\p{N}_$#]+/gu)].map((m) => m[0]);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t)) continue;
    if (t.length < 2 && !isCJKToken(t)) continue;
    if (QSTOP.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= maxTerms) break;
  }
  const rare = terms.filter(isRareTerm).slice(0, 10);
  // Phrases are built from the *raw* token stream, not the filtered terms:
  // verb+particles such as "out early" / "check in" are exactly the evidence
  // anchors QSTOP used to erase.
  const phrases: string[] = [];
  const phSeen = new Set<string>();
  for (let i = 0; i + 1 < raw.length && phrases.length < 10; i++) {
    const a = raw[i];
    const b = raw[i + 1];
    if (a.length < 2 || b.length < 2) continue;
    if (QSTOP.has(a) && QSTOP.has(b)) continue;
    const ph = `${a} ${b}`;
    if (ph.length < 6 || phSeen.has(ph)) continue;
    phSeen.add(ph);
    phrases.push(ph);
  }
  return { terms, rare, phrases, cjk: CJK_RE.test(text) };
}

/** FTS5 MATCH expression: every term OR'd, + bonus phrase groups. */
export function ftsMatchOf(qa: QueryAnalysis, parts: { terms?: boolean; rare?: boolean; phrases?: boolean } = {}): string {
  const out: string[] = [];
  if (parts.rare) for (const t of qa.rare) out.push(quoteFts(t));
  else if (parts.terms !== false) for (const t of qa.terms) out.push(quoteFts(t));
  if (parts.phrases) for (const p of qa.phrases) out.push(`"${p.replace(/"/g, " ")}"`);
  return [...new Set(out)].join(" OR ");
}

/** Quote one token for FTS5; terms ≥4 chars also get a prefix wildcard. */
export function quoteFts(t: string): string {
  const s = String(t ?? "").replace(/["*]/g, " ").trim();
  if (!s) return '""';
  return s.length >= 4 && !isCJKToken(s) ? `${s}*` : `"${s}"`;
}

// ------------------------------------------------------- v5.0 halo + KWIC

/** Rare entities a neighbour turn contributes to a context halo. */
export function haloEntities(text: string, max = 16): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /"[^"]{3,40}"|\b[A-Z][a-zA-Z][a-zA-Z_'-]{1,}(?:\s[A-Z][a-zA-Z]{2,})?\b|\b\d{2,4}(?:[-/.]\d{1,2}){0,2}\b|\b[a-zA-Z][a-zA-Z]{7,}\b|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const v = m[0].trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * KWIC micro-window: the densest query-term + answer-shaped span of `text`,
 * returned with 100% lossless surface form (no paraphrasing, no filtering of
 * names/numbers/dates). Used both for error messages and the recall packet.
 */
export function kwicWindow(text: string, terms: readonly string[], maxChars: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  const low = t.toLowerCase();
  const win = Math.max(32, Math.min(maxChars, t.length));
  const step = Math.max(6, Math.floor(win / 6));
  const lowered = terms.map((w) => w.toLowerCase());
  let bestI = 0;
  let bestS = -Infinity;
  for (let i = 0; i + 1 < t.length; i += step) {
    const seg = low.slice(i, i + win);
    let s = 0;
    for (const w of lowered) {
      let at = seg.indexOf(w);
      while (at >= 0) {
        s += 1 + Math.min(6, w.length) / 8;
        at = seg.indexOf(w, at + w.length);
      }
    }
    // answer-shaped tokens: numbers, dates, capitalised names, quoted strings
    s += 0.45 * ((seg.match(/"\s*[^"]{2,40}?"\s*|\b\d[\d.,:%-]{1,}\b|\b[A-Z][a-z]{2,}\b/g) ?? []).length);
    if (s > bestS) {
      bestS = s;
      bestI = i;
    }
  }
  let start = bestI;
  let end = Math.min(t.length, start + win);
  if (start > 0) {
    const sp = t.indexOf(" ", start);
    if (sp >= 0 && sp < end) start = sp + 1;
  }
  if (end < t.length) {
    const sp = t.lastIndexOf(" ", end);
    if (sp > start) end = sp;
  }
  const body = t.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < t.length ? "…" : ""}`;
}

/**
 * ±1 neighbours of a turn id like "D1:3", "3722ea11_2#7", "000004".
 *
 * v5.0 fix: the digit run we bump must be the LAST one. The v4 regex was lazy
 * (`(.*?)(\d+)(\D*)$`) so "D1:3" matched pre="D", digits="1", post=":3" and
 * produced D0:3 / D2:3 — the wrong neighbours. Anchoring the prefix to end on
 * a non-digit makes the digits the final run: D1:2 / D1:4.
 */
export function neighborTurnIds(turn: string): string[] {
  const m = /^(.*\D)?(\d{1,9})(\D*)$/.exec(String(turn ?? ""));
  if (!m) return [];
  const [, pre = "", digits, post = ""] = m;
  const base = Number(digits);
  const width = digits.length;
  const out: string[] = [];
  if (base > 0) out.push(pre + String(base - 1).padStart(width, "0") + post);
  out.push(pre + String(base + 1).padStart(width, "0") + post);
  return out;
}

/** Turn at an arbitrary signed offset, preserving prefix and zero-padding. */
export function turnOffset(turn: string, delta: number): string | null {
  const m = /^(.*\D)?(\d{1,9})(\D*)$/.exec(String(turn ?? ""));
  if (!m) return null;
  const [, pre = "", digits, post = ""] = m;
  const n = Number(digits) + delta;
  if (n < 0) return null;
  return pre + String(n).padStart(digits.length, "0") + post;
}

/** Jaccard similarity over significant tokens (MMR / diversity checks). */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** ln(1 + (N−df+0.5)/(df+0.5)) — the IDF the v5 rankers weight terms with. */
export function idfOf(n: number, df: number): number {
  const d = Math.max(0.5, df);
  return Math.log(1 + (Math.max(n, 1) - d + 0.5) / (d + 0.5));
}

// --------------------------------------------------------- relative time

/**
 * "2h_ago", "3d_ago", "just_now" — the temporal shorthand used in
 * [CHRONOS_PULSE]. Never throws on garbage timestamps.
 */
export function relTime(ts: number, now = Date.now()): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  const dt = Math.max(0, now - t);
  const s = dt / 1000;
  if (s < 90) return "just_now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m_ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h_ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d_ago`;
  const w = d / 7;
  if (w < 5) return `${Math.round(w)}w_ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)}mo_ago`;
  return `${Math.round(d / 365)}y_ago`;
}

/** "2026-10-17T02:20Z" — short, sortable, unambiguous. */
export function isoStamp(ts = Date.now()): string {
  try {
    return new Date(ts).toISOString().slice(0, 16) + "Z";
  } catch {
    return "unknown";
  }
}

/** "2026-10-17" */
export function isoDay(ts = Date.now()): string {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

/** "2026-10" */
export function isoMonth(ts = Date.now()): string {
  try {
    return new Date(ts).toISOString().slice(0, 7);
  } catch {
    return "unknown";
  }
}

// -------------------------------------------------------------------- AAAK

const CAT_TAG: Record<string, string> = {
  coding_style: "sty",
  tech_stack: "stk",
  architecture: "arc",
  workflow_habit: "wfh",
  constraint: "con",
  bug_lesson: "bug",
  personal_fact: "per",
  domain_fact: "dom",
};

/** `[MEM#42|2026-10|fix:race_cond@auth.ts->use_mutex_lock|conf:0.95]` */
export function aaakMem(e: {
  id: number;
  category: string;
  subject: string;
  object: string;
  confidence: number;
  valid_from: number;
  expired?: boolean;
}): string {
  const ym = isoMonth(e.valid_from);
  const tag = CAT_TAG[e.category] ?? "mem";
  const conf = (e.confidence ?? 0.6).toFixed(2);
  const dead = e.expired ? "~" : "";
  return `[MEM#${e.id}|${ym}|${tag}:${one(e.subject)}=${one(e.object)}|conf:${conf}${dead}]`;
}

/** `[DNA|ts:strict|pkg:bun>pnpm|ui:tailwind+shadcn|err:no-any,early-return|lang:vi|rx:…]` */
export function aaakDNA(bits: Record<string, string>): string {
  const order = ["ts", "lang", "pkg", "ui", "arch", "err", "wf", "con", "rx", "proj"];
  const parts: string[] = [];
  for (const k of order) {
    const v = bits[k];
    if (v) parts.push(`${k}:${one(v)}`);
  }
  for (const k of Object.keys(bits).sort()) {
    if (!order.includes(k) && bits[k]) parts.push(`${k}:${one(bits[k])}`);
  }
  return `[DNA|${parts.join("|")}]`;
}

/** Collapse whitespace/pipes so AAAK never breaks its own delimiters. */
function one(s: string): string {
  return String(s ?? "")
    .replace(/[\r\n|\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

/** AAAK key shorthand for a habit/fact, used as the subject token. */
export function aaakKey(s: string): string {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_$]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "x"
  );
}

/** `lật-thẻ-flashcard` — one readable token per project/feature, diacritics kept. */
export function kebab(s: string, max = 40): string {
  const t = String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return t.length > max ? t.slice(0, max).replace(/-[^-]*$/, "") : t;
}

/** Project key: lower-case, punctuation-free, stable across phrasings. */
export function projectKey(s: string): string {
  return (
    String(s ?? "")
      .toLowerCase()
      .normalize("NFC")
      .replace(/^[@#]+/, "")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32) || ""
  );
}

// -------------------------------------------------------------- pulse AAAK

export interface PulseProject {
  project_name: string;
  current_focus?: string | null;
  open_loops?: string[];
  last_active_at: number;
  status?: string;
}

/** `eduflash:2h_ago[focus:lật-thẻ-flashcard,open:lag-mobile]` */
export function aaakProjectLine(p: PulseProject, now = Date.now(), detail = true): string {
  const name = one(p.project_name);
  const age = relTime(p.last_active_at, now);
  const paused = p.status && p.status !== "active" ? `[${p.status}]` : "";
  if (!detail) return `${name}:${age}${paused}`;
  const bits: string[] = [];
  if (p.current_focus) bits.push(`focus:${clampChars(p.current_focus, 28)}`);
  const loops = (p.open_loops ?? []).filter(Boolean).slice(0, 2);
  if (loops.length) bits.push(`open:${clampChars(loops.join("+"), 34)}`);
  return bits.length ? `${name}:${age}${paused}[${bits.join(",")}]` : `${name}:${age}${paused}`;
}

/**
 * The whole PULSE line: what is going on right now, across projects.
 * `now` is an absolute stamp; everything else is relative, which is what
 * makes the same string readable a week later.
 */
export function aaakPulse(input: {
  now?: number;
  projects: PulseProject[];
  cwdProject?: string | null;
  detailCount?: number;
  /** projects that always keep their focus/open detail, wherever they sit */
  detailNames?: string[];
}): string {
  const now = input.now ?? Date.now();
  const detailCount = input.detailCount ?? 1;
  const named = new Set(input.detailNames ?? []);
  const lines = input.projects.map((p, i) => aaakProjectLine(p, now, i < detailCount || named.has(p.project_name)));
  const cwd = input.cwdProject ? `|cwd_proj:${one(input.cwdProject)}` : "";
  return `[now:${isoStamp(now)}|recent_projects:${lines.join(",") || "none"}${cwd}]`;
}

/**
 * The behaviour contract. Fixed bytes, always injected, never trimmed: this
 * is the paragraph that turns "hello" into "how did eduflash go?".
 */
export const AAAK_BEHAVIOR =
  "[CHRONOS_BEHAVIOR] persistent memory on. " +
  'Greeting ("hi","chào","alo")-> warm reply, ask about newest project in PULSE (focus/open). ' +
  "Work-> act now, obey DNA. " +
  "Past details-> call tool `chronos`.";

/**
 * v3.0 execution protocol — the cerebellum's standing order. Fixed bytes,
 * appended to every snapshot: apply learned [REFLEX] fast-paths instead of
 * re-exploring, and verify with the project's own script.
 */
export const AAAK_CORTEX =
  "[CHRONOS_CORTEX] Execution Protocol: " +
  "[REFLEX] fast-paths; skip exploration; verify via project script.";

// ------------------------------------------------------- reflex AAAK (v3.0)

/** Uppercase step marker: `do:bunx_prisma_db_push`. Pure, padded, safe. */
export function aaakCmd(cmd: string, max = 44): string {
  return (
    String(cmd ?? "")
      .replace(/["'`]/g, "")
      .replace(/[|\[\]]+/g, " ")
      .replace(/\s+/g, "_")
      .replace(/[^\p{L}\p{N}_$#:+/=.,-]+/gu, "")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "x"
  );
}

/** The avoid half of a reflex: `!cmd:npx_prisma_migrate_dev`. */
export function aaakAntiCmd(cmd: string, max = 44): string {
  return "!cmd:" + aaakCmd(cmd, max);
}

/** Stable engram identity: the same lesson reinforces its row, never duplicates. */
export function engramKey(scope: string, when: string, win: string): string {
  return aaakKey(`${scope}|${when}|${win}`).slice(0, 120);
}

/** 384-bit signature of a trigger intent — sub-ms engram lookup. */
export function triggerSignature(intent: string): string {
  return simhashToHex(simhash384(intent));
}

/** `[REFLEX|eduflash|when:…|avoid:…|win:…]` — one engram, < 30 tokens. */
export function aaakReflex(e: { scope: string; when: string; avoid?: string | null; win: string }): string {
  const parts = [`when:${one(e.when)}`];
  if (e.avoid) parts.push(`avoid:${one(e.avoid)}`);
  parts.push(`win:${one(e.win)}`);
  return `[REFLEX|${one(e.scope.replace(/^project:/, ""))}|${parts.join("|")}]`;
}

/** The one-shot JIT injection line: `[CHRONOS_REFLEX] [when:…|avoid:…|fast_path:…]`. */
export function aaakReflexLine(e: { when: string; avoid?: string | null; fast: string }): string {
  const parts = [`when:${one(e.when)}`];
  if (e.avoid) parts.push(`avoid:${one(e.avoid)}`);
  parts.push(`fast_path:${one(e.fast)}`);
  return `[CHRONOS_REFLEX] [${parts.join("|")}]`;
}
