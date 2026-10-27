// ===========================================================================
// omni.ts — v7.0 "OMNISCIENT" cognitive indexes.
//
// Five SQLite structures built at ingest, none of which is a similarity index:
//   omni_entity_mentions / omni_entity_edges  — entity co-occurrence graph
//   omni_state_ledger                          — (subject, attribute) versions
//   omni_timeline                              — absolute order + dates
//   omni_facet_index                           — taxonomic categories
//   omni_causal                                — request→tool→answer episodes
//
// They exist so the planner can answer questions that similarity search
// provably cannot: the second hop of a bridge, "what is the latest value",
// "what happened after X", "list every <category>", "what did the tool return".
// No model, no tokens.
// ===========================================================================

import type { Database } from "bun:sqlite";
import { haloEntities } from "./aaak";

export interface OmniTurn {
  id: string;
  session: string;
  speaker: string;
  text: string;
  ts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS omni_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS omni_entity_mentions (
  entity_norm TEXT NOT NULL, entity_type TEXT, unit_id TEXT NOT NULL,
  session_id TEXT, turn_ordinal INTEGER, salience REAL DEFAULT 1,
  PRIMARY KEY (entity_norm, unit_id)
);
CREATE TABLE IF NOT EXISTS omni_entity_edges (
  entity_a TEXT NOT NULL, entity_b TEXT NOT NULL, relation_cue TEXT,
  unit_id TEXT NOT NULL, turn_ordinal INTEGER, weight REAL DEFAULT 1,
  PRIMARY KEY (entity_a, entity_b, unit_id)
);
CREATE TABLE IF NOT EXISTS omni_state_ledger (
  subject_entity TEXT NOT NULL, attribute_slot TEXT NOT NULL, value_text TEXT NOT NULL,
  unit_id TEXT NOT NULL, turn_ordinal INTEGER, timestamp INTEGER,
  version_num INTEGER DEFAULT 1, is_latest INTEGER DEFAULT 1, prev_unit_id TEXT,
  PRIMARY KEY (subject_entity, attribute_slot, unit_id)
);
CREATE TABLE IF NOT EXISTS omni_timeline (
  unit_id TEXT PRIMARY KEY, session_id TEXT, session_ordinal INTEGER,
  turn_ordinal INTEGER, abs_date_iso TEXT, epoch_day INTEGER,
  prev_unit_id TEXT, next_unit_id TEXT
);
CREATE TABLE IF NOT EXISTS omni_facet_index (
  facet_category TEXT NOT NULL, sub_category TEXT, actor_entity TEXT,
  specific_value TEXT, unit_id TEXT NOT NULL, turn_ordinal INTEGER,
  PRIMARY KEY (facet_category, specific_value, unit_id)
);
CREATE TABLE IF NOT EXISTS omni_causal (
  episode_id TEXT NOT NULL, unit_id TEXT NOT NULL, role TEXT, turn_ordinal INTEGER,
  PRIMARY KEY (episode_id, unit_id)
);
CREATE INDEX IF NOT EXISTS omni_em_entity ON omni_entity_mentions(entity_norm);
CREATE INDEX IF NOT EXISTS omni_em_unit ON omni_entity_mentions(unit_id);
CREATE INDEX IF NOT EXISTS omni_ee_a ON omni_entity_edges(entity_a);
CREATE INDEX IF NOT EXISTS omni_ee_b ON omni_entity_edges(entity_b);
CREATE INDEX IF NOT EXISTS omni_sl_subject ON omni_state_ledger(subject_entity, attribute_slot);
CREATE INDEX IF NOT EXISTS omni_tl_ord ON omni_timeline(turn_ordinal);
CREATE INDEX IF NOT EXISTS omni_fi_cat ON omni_facet_index(facet_category);
CREATE INDEX IF NOT EXISTS omni_ca_ep ON omni_causal(episode_id);
`;

// ---------------------------------------------------------------- taxonomy

/** category -> member cues. A hit labels the turn with that facet. */
const FACETS: Record<string, string[]> = {
  pet: ["dog", "cat", "puppy", "kitten", "retriever", "beagle", "parrot", "hamster", "rabbit", "turtle", "goldfish", "adopted a"],
  book: ["book", "novel", "author", "chapter", "read", "reading", "memoir", "poetry", "dune", "sapiens"],
  place: ["city", "country", "visited", "trip", "travel", "hotel", "airport", "kyoto", "tokyo", "paris", "london", "vietnam", "hanoi", "saigon", "beach", "museum"],
  food: ["ate", "eat", "food", "restaurant", "dish", "pizza", "pasta", "allergy", "allergic", "peanut", "coffee", "latte", "vegan", "recipe", "cook"],
  error: ["error", "bug", "exception", "failed", "failure", "crash", "timeout", "traceback", "401", "404", "500", "unauthorized", "undefined"],
  hobby: ["hobby", "painting", "pottery", "hiking", "photography", "gardening", "knitting", "running", "yoga", "climbing", "chess"],
  vehicle: ["car", "bike", "bicycle", "motorcycle", "tesla", "toyota", "honda", "vehicle", "scooter"],
  gift: ["gift", "present", "birthday", "anniversary", "christmas", "surprise"],
  relative: ["mother", "father", "sister", "brother", "aunt", "uncle", "cousin", "wife", "husband", "partner", "daughter", "son", "grandmother", "grandfather"],
  tool: ["tool", "command", "cli", "npm", "bun", "git", "docker", "api", "endpoint", "terminal", "shell", "script"],
  project: ["project", "app", "application", "feature", "built", "implemented", "deployed", "release", "launch", "sprint"],
  job: ["job", "work", "company", "role", "hired", "interview", "manager", "team", "office", "career", "promotion"],
  health: ["doctor", "medicine", "sick", "illness", "therapy", "hospital", "diagnosis", "injury", "sleep", "diet"],
  money: ["budget", "cost", "price", "paid", "salary", "saving", "expense", "invoice", "subscription", "cheap", "expensive"],
};

const FACET_OF_QUESTION: Array<[RegExp, string]> = [
  [/\b(pets?|animals?)\b/i, "pet"],
  [/\b(books?|novels?|reading)\b/i, "book"],
  [/\b(places?|cities|countries|trips?|travel)\b/i, "place"],
  [/\b(foods?|meals?|restaurants?|allerg\w*|eat|ate)\b/i, "food"],
  [/\b(errors?|bugs?|failures?|exceptions?)\b/i, "error"],
  [/\b(hobbies|hobby|interests?)\b/i, "hobby"],
  [/\b(vehicles?|cars?|bikes?)\b/i, "vehicle"],
  [/\b(gifts?|presents?)\b/i, "gift"],
  [/\b(relatives?|family|mother|father|sister|brother|partner|wife|husband)\b/i, "relative"],
  [/\b(tools?|commands?|libraries|libraries|frameworks?|stack)\b/i, "tool"],
  [/\b(projects?|apps?|applications?|features?)\b/i, "project"],
  [/\b(jobs?|career|work|company|companies|employers?)\b/i, "job"],
  [/\b(health|illness|symptoms?|doctor)\b/i, "health"],
  [/\b(budget|money|cost|price|spend|spent|salary)\b/i, "money"],
];

const STOP_ENTITY = new Set(
  "the a an and or but if then than that this these those i me my we our you your he she it its they them their is are was were be been being do does did have has had will would can could should may might must not no yes so as at by for from in into of on to with about over under again just also very really what when where who whom which why how".split(
    " ",
  ),
);

function normEntity(s: string): string {
  return s.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Proper nouns, quoted spans, numbers, rare long words, plus the speaker. */
export function extractEntities(text: string, speaker: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const e = normEntity(raw);
    if (!e || e.length < 2 || STOP_ENTITY.has(e)) return;
    if (!out.includes(e)) out.push(e);
  };
  for (const e of haloEntities(text, 24)) add(e);
  // capitalised words the halo may miss when they are sentence-initial
  for (const m of String(text).matchAll(/\b([A-Z][a-z]{2,})\b/g)) add(m[1]);
  const sp = normEntity(speaker);
  if (sp) add(sp);
  return out.slice(0, 24);
}

// ------------------------------------------------------------- state ledger

const STATE_PATTERNS: Array<{ re: RegExp; attr: (m: RegExpMatchArray) => string; val: (m: RegExpMatchArray) => string }> = [
  { re: /\bmy ([a-z][a-z ]{2,28}?) (?:is|are|was|were) ([^.;!?\n]{2,90})/gi, attr: (m) => m[1], val: (m) => m[2] },
  { re: /\bi (?:prefer|like|love|use|now use|switched to|changed to|moved to|settled on) ([^.;!?\n]{2,90})/gi, attr: () => "preference", val: (m) => m[1] },
  { re: /\b([A-Z][a-z]{2,})(?:'s|s') ([a-z][a-z ]{2,28}?) (?:is|are|was|were) ([^.;!?\n]{2,90})/g, attr: (m) => m[2], val: (m) => m[3] },
];

interface StateRow { subject: string; attr: string; value: string }

function extractStates(text: string, speaker: string): StateRow[] {
  const rows: StateRow[] = [];
  const sp = normEntity(speaker) || "user";
  for (const p of STATE_PATTERNS) {
    for (const m of String(text).matchAll(p.re)) {
      const subject = m.length > 3 && /^[A-Z]/.test(m[1]) ? normEntity(m[1]) : sp;
      const attr = normEntity(p.attr(m)).slice(0, 40);
      const value = String(p.val(m)).trim().replace(/\s+/g, " ").slice(0, 120);
      if (!attr || !value) continue;
      rows.push({ subject, attr, value });
    }
  }
  return rows.slice(0, 4);
}

// ------------------------------------------------------------------ ingest

export interface OmniIngestStats {
  entities: number;
  edges: number;
  states: number;
  facets: number;
  episodes: number;
}

/**
 * Build the five indexes. Idempotent per unit id: re-ingesting the same turns
 * replaces their rows instead of duplicating them.
 */
export function omniIngest(db: Database, turns: OmniTurn[]): OmniIngestStats {
  const stats: OmniIngestStats = { entities: 0, edges: 0, states: 0, facets: 0, episodes: 0 };
  if (!turns.length) return stats;
  db.run(SCHEMA);

  // ordinals continue after whatever is already stored
  const prevMax = (db.query("SELECT COALESCE(MAX(turn_ordinal), -1) AS m FROM omni_timeline").get() as { m: number } | null)?.m ?? -1;
  const base = prevMax + 1;
  const sessionOrd = new Map<string, number>();
  let nextSessionOrd = 0;
  {
    const rows = db.query("SELECT session_id, MAX(session_ordinal) AS o FROM omni_timeline GROUP BY session_id").all() as Array<{ session_id: string; o: number }>;
    for (const r of rows) {
      sessionOrd.set(r.session_id, r.o);
      if (r.o > nextSessionOrd) nextSessionOrd = r.o;
    }
  }

  const insMention = db.prepare("INSERT OR REPLACE INTO omni_entity_mentions (entity_norm, entity_type, unit_id, session_id, turn_ordinal, salience) VALUES (?,?,?,?,?,?)");
  const insEdge = db.prepare("INSERT OR REPLACE INTO omni_entity_edges (entity_a, entity_b, relation_cue, unit_id, turn_ordinal, weight) VALUES (?,?,?,?,?,?)");
  const insTimeline = db.prepare("INSERT OR REPLACE INTO omni_timeline (unit_id, session_id, session_ordinal, turn_ordinal, abs_date_iso, epoch_day, prev_unit_id, next_unit_id) VALUES (?,?,?,?,?,?,?,?)");
  const insFacet = db.prepare("INSERT OR REPLACE INTO omni_facet_index (facet_category, sub_category, actor_entity, specific_value, unit_id, turn_ordinal) VALUES (?,?,?,?,?,?)");
  const insState = db.prepare("INSERT OR REPLACE INTO omni_state_ledger (subject_entity, attribute_slot, value_text, unit_id, turn_ordinal, timestamp, version_num, is_latest, prev_unit_id) VALUES (?,?,?,?,?,?,?,?,?)");
  const insCausal = db.prepare("INSERT OR REPLACE INTO omni_causal (episode_id, unit_id, role, turn_ordinal) VALUES (?,?,?,?)");

  // episode boundaries: a new user turn opens an episode, assistants attach
  let episode = "";
  let prevUnit = "";
  let prevEntities: string[] = [];
  let prevSession = "";

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const ord = base + i;
    if (!sessionOrd.has(t.session)) sessionOrd.set(t.session, ++nextSessionOrd);
    const sOrd = sessionOrd.get(t.session)!;
    const d = new Date(Number.isFinite(t.ts) ? t.ts : Date.now());
    const iso = d.toISOString().slice(0, 10);
    const day = Math.floor(d.getTime() / 86_400_000);
    insTimeline.run(t.id, t.session, sOrd, ord, iso, day, prevUnit || null, null);
    if (prevUnit) db.run("UPDATE omni_timeline SET next_unit_id = ? WHERE unit_id = ?", t.id, prevUnit);
    prevUnit = t.id;

    const ents = extractEntities(t.text, t.speaker);
    for (const e of ents) {
      const sal = e.length >= 6 ? 1.4 : 1;
      insMention.run(e, "term", t.id, t.session, ord, sal);
      stats.entities++;
    }
    // co-occurrence inside the turn + adjacency with the previous turn of the
    // same session (the second hop of a bridge often lives one turn away)
    const pairSet = new Set<string>();
    for (let a = 0; a < ents.length; a++) {
      for (let b = a + 1; b < ents.length; b++) {
        const k = `${ents[a]}\u0000${ents[b]}`;
        if (pairSet.has(k)) continue;
        pairSet.add(k);
        insEdge.run(ents[a], ents[b], null, t.id, ord, 1);
        stats.edges++;
      }
    }
    if (prevSession === t.session) {
      for (const e of ents.slice(0, 10)) {
        for (const p of prevEntities.slice(0, 10)) {
          if (e === p) continue;
          const k = `${e}\u0000${p}`;
          if (pairSet.has(k)) continue;
          pairSet.add(k);
          insEdge.run(e, p, "adjacent", t.id, ord, 0.5);
          stats.edges++;
        }
      }
    }
    prevEntities = ents;
    prevSession = t.session;

    // facets
    const low = t.text.toLowerCase();
    for (const [cat, cues] of Object.entries(FACETS)) {
      for (const cue of cues) {
        if (!low.includes(cue)) continue;
        insFacet.run(cat, cue, normEntity(t.speaker) || null, cue, t.id, ord);
        stats.facets++;
        break;
      }
    }

    // state ledger: a new value for the same (subject, attribute) supersedes
    for (const s of extractStates(t.text, t.speaker)) {
      const prev = db
        .query("SELECT unit_id, version_num FROM omni_state_ledger WHERE subject_entity = ? AND attribute_slot = ? AND value_text <> ? ORDER BY version_num DESC LIMIT 1")
        .get(s.subject, s.attr, s.value) as { unit_id: string; version_num: number } | null;
      if (prev) {
        db.run("UPDATE omni_state_ledger SET is_latest = 0 WHERE subject_entity = ? AND attribute_slot = ?", s.subject, s.attr);
        insState.run(s.subject, s.attr, s.value, t.id, ord, t.ts, (prev.version_num ?? 1) + 1, 1, prev.unit_id);
      } else {
        insState.run(s.subject, s.attr, s.value, t.id, ord, t.ts, 1, 1, null);
      }
      stats.states++;
    }

    // causal episodes
    const isUser = String(t.speaker).toLowerCase() === "user";
    if (isUser || !episode) episode = t.id;
    insCausal.run(episode, t.id, isUser ? "request" : "answer", ord);
    stats.episodes++;
  }
  return stats;
}

// ------------------------------------------------------------------- query

export interface OmniHit {
  id: string;
  score: number;
  op: string;
}

export type TextOf = (id: string) => string;

const normQ = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ");

const QSTOP = new Set(
  "what when where who which why how did does do is are was were the a an and or of to in on for with about my our your their his her its this that these those i me you we they he she it be been being have has had will would can could should may might must not no yes so as at by from into over under again just also very really there here then than all any some more most other such only own same too".split(
    " ",
  ),
);

export function termsOf(s: string): string[] {
  return (normQ(s).match(/[a-z0-9][a-z0-9'+-]{2,}/g) ?? []).filter((w) => !QSTOP.has(w));
}

function coverageOf(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const low = normQ(text);
  let hit = 0;
  for (const t of terms) if (low.includes(t)) hit++;
  return hit / terms.length;
}

function unitCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM omni_timeline").get() as { n: number } | null)?.n ?? 0;
}

function dfOf(db: Database, entity: string): number {
  return (
    (db.query("SELECT COUNT(DISTINCT unit_id) AS n FROM omni_entity_mentions WHERE entity_norm = ?").get(entity) as {
      n: number;
    } | null)?.n ?? 0
  );
}

function idfOf(db: Database, entity: string, total: number): number {
  return Math.log((total + 1) / (dfOf(db, entity) + 1)) + 1;
}

/** entities of the question only (no speaker injection) */
function questionEntities(q: string): string[] {
  return extractEntities(q, "")
    .filter((e) => e.length >= 3 && e !== "user" && e !== "assistant")
    .slice(0, 12);
}

function ordOf(db: Database, id: string): number | null {
  const r = db.query("SELECT turn_ordinal FROM omni_timeline WHERE unit_id = ?").get(id) as {
    turn_ordinal: number;
  } | null;
  return r?.turn_ordinal ?? null;
}

// -------------------------------------------------------- OP_GRAPH_PPR

/**
 * Personalized PageRank over the entity graph, executed as explicit hops:
 *
 *   hop 1  units that mention a question entity (seeds)
 *   bridge entities that occur in those units but not in the question, rare
 *          enough to be discriminative (df >= 2, df <= 25% of the brain)
 *   hop 2  units that mention a bridge AND at least a quarter of the
 *          question's predicates (a bridge alone is a hub word)
 *
 * The hop-2 constraint is the whole point: a bridge alone is a hub word, a
 * bridge *with* the question's target predicate is the missing second hop.
 */
export function opGraphPpr(db: Database, question: string, textOf: TextOf, limit = 40): OmniHit[] {
  const total = unitCount(db);
  if (!total) return [];
  const seeds = questionEntities(question);
  if (!seeds.length) return [];
  const qt = termsOf(question);
  const seedSet = new Set(seeds);
  const acc = new Map<string, number>();
  const add = (id: string, s: number) => {
    if (!id) return;
    const prev = acc.get(id) ?? 0;
    if (s > prev) acc.set(id, s);
  };

  // hop 1 — seed mentions
  const hop1 = new Map<string, number>();
  for (const s of seeds) {
    if (!dfOf(db, s)) continue;
    const w = idfOf(db, s, total);
    const rows = db
      .query("SELECT unit_id FROM omni_entity_mentions WHERE entity_norm = ? LIMIT 400")
      .all(s) as Array<{ unit_id: string }>;
    for (const r of rows) hop1.set(r.unit_id, Math.max(hop1.get(r.unit_id) ?? 0, w));
  }
  for (const [u, w] of hop1) add(u, w * (0.55 + 0.45 * coverageOf(qt, textOf(u))));

  // bridge extraction
  const bridges = new Map<string, number>();
  for (const u of hop1.keys()) {
    const rows = db
      .query("SELECT entity_norm FROM omni_entity_mentions WHERE unit_id = ?")
      .all(u) as Array<{ entity_norm: string }>;
    for (const r of rows) {
      const e = r.entity_norm;
      if (seedSet.has(e) || qt.includes(e) || e.length < 4) continue;
      const df = dfOf(db, e);
      if (df < 2 || df > Math.max(3, total * 0.05)) continue;
      bridges.set(e, Math.max(bridges.get(e) ?? 0, idfOf(db, e, total) * (hop1.get(u) ?? 1)));
    }
  }
  const topBridges = [...bridges].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // hop 2 — bridge × missing predicate
  for (const [e, bw] of topBridges) {
    const rows = db
      .query("SELECT unit_id FROM omni_entity_mentions WHERE entity_norm = ? LIMIT 300")
      .all(e) as Array<{ unit_id: string }>;
    for (const r of rows) {
      const text = textOf(r.unit_id);
      const cov = coverageOf(qt, text);
      if (cov < 0.25) continue; // the bridge must sit next to the question's own predicate
      add(r.unit_id, bw * (0.3 + 0.7 * cov));
    }
  }

  const max = Math.max(...acc.values(), 1e-9);
  return [...acc]
    .map(([id, s]) => ({ id, score: s / max, op: "ppr" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------- OP_TEMPORAL

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Temporal navigation. Three modes, all of them ordinal/absolute rather than
 * lexical:
 *   after/before an anchor  → the window of turns that follow/precede it,
 *                             scored by proximity × predicate coverage
 *   first/last mention      → MIN/MAX turn_ordinal of the entity
 *   ordering questions      → the first turns of every session, in session
 *                             order (the evidence for "walk me through the
 *                             order in which I brought X up")
 */
export function opTemporal(
  db: Database,
  question: string,
  anchors: string[],
  textOf: TextOf,
  speakerOf: (id: string) => string,
  limit = 30,
): OmniHit[] {
  const q = normQ(question);
  const after = /\b(after|following|since|then|next|once i)\b/.test(q);
  const before = /\b(before|prior to|earlier|previous|until)\b/.test(q);
  const first = /\b(when did i first|first time|first mention|earliest|initially)\b/.test(q);
  const last = /\b(last time|most recently|latest mention|finally)\b/.test(q);
  const ordering = /\b(order|sequence|timeline|walk me through|throughout our|over time|across (our|my) (conversations|sessions))\b/.test(q);
  const qt = termsOf(question);
  const scores = new Map<string, number>();
  const kinds = new Map<string, string>();
  const add = (id: string, s: number, op: string) => {
    if (!id) return;
    const prev = scores.get(id) ?? 0;
    if (s <= prev) return;
    scores.set(id, s);
    kinds.set(id, op);
  };

  const anchorOrds = anchors.map((a) => ordOf(db, a)).filter((x): x is number => x !== null);

  if ((after || before) && anchorOrds.length) {
    for (const a of anchorOrds.slice(0, 3)) {
      const rows = (
        after
          ? db.query("SELECT unit_id FROM omni_timeline WHERE turn_ordinal > ? ORDER BY turn_ordinal LIMIT 25").all(a)
          : db.query("SELECT unit_id FROM omni_timeline WHERE turn_ordinal < ? ORDER BY turn_ordinal DESC LIMIT 25").all(a)
      ) as Array<{ unit_id: string }>;
      rows.forEach((r, i) => {
        const prox = Math.pow(0.93, i);
        add(r.unit_id, prox * (0.4 + 0.6 * coverageOf(qt, textOf(r.unit_id))), after ? "temporal:after" : "temporal:before");
      });
    }
  }

  if ((first || last) && !ordering) {
    // only a named thing has a meaningful first/last mention
    const ents = questionEntities(question).filter((e) => /[A-Z0-9]/.test(e) || e.length >= 6).slice(0, 3);
    for (const e of ents) {
      const rows = db
        .query(
          `SELECT m.unit_id FROM omni_entity_mentions m JOIN omni_timeline t ON t.unit_id = m.unit_id
            WHERE m.entity_norm = ? ORDER BY t.turn_ordinal ${first ? "ASC" : "DESC"} LIMIT 3`,
        )
        .all(e) as Array<{ unit_id: string }>;
      rows.slice(0, 2).forEach((r, i) => add(r.unit_id, 0.9 - i * 0.25, first ? "temporal:first" : "temporal:last"));
    }
  }

  if (ordering) {
    // Topic-block walk. The gold evidence for "the order in which I brought X
    // up" is the run of user turns that *open* each aspect — turn 20, then 22
    // ("what about the 300ms case?"), then 24 — and those follow-ups share no
    // topic keyword with the question. Walk forward from each anchor while the
    // user turn still shares vocabulary with the anchor; stop when the topic
    // changes.
    // The probe question itself is often ingested as a turn, and so are the
    // recaps at the end of a session. Neither opens a topic block, so an anchor
    // that mostly restates the question is skipped.
    const qWords = new Set(termsOf(question));
    const restates = (id: string) => {
      const tw = termsOf(textOf(id));
      if (!tw.length || !qWords.size) return false;
      let shared = 0;
      for (const t of tw) if (qWords.has(t)) shared++;
      return shared / Math.min(tw.length, qWords.size) > 0.5;
    };
    const sOrd = (id: string) => {
      const r = db.query("SELECT session_ordinal FROM omni_timeline WHERE unit_id = ?").get(id) as {
        session_ordinal: number;
      } | null;
      return r?.session_ordinal ?? 1;
    };
    const walkAnchors = anchors
      .filter(
        (a) =>
          String(speakerOf(a)).toLowerCase() === "user" &&
          !restates(a) &&
          coverageOf(qt, textOf(a)) >= 0.2,
      )
      .slice(0, 3);
    for (const a of walkAnchors) {
      const aOrd = ordOf(db, a);
      if (aOrd === null) continue;
      const aTerms = termsOf(textOf(a));
      if (!aTerms.length) continue;
      const rows = db
        .query(
          `SELECT unit_id FROM omni_timeline
            WHERE session_id = (SELECT session_id FROM omni_timeline WHERE unit_id = ?)
              AND turn_ordinal > ? ORDER BY turn_ordinal LIMIT 14`,
        )
        .all(a, aOrd) as Array<{ unit_id: string }>;
      let taken = 0;
      let misses = 0;
      for (const r of rows) {
        if (String(speakerOf(r.unit_id)).toLowerCase() !== "user") continue;
        const tTerms = new Set(termsOf(textOf(r.unit_id)));
        let shared = 0;
        for (const t of aTerms) if (tTerms.has(t)) shared++;
        if (!shared) {
          if (++misses >= 2) break;
          continue;
        }
        misses = 0;
        // first mention wins: a later session that repeats the same topic is a
        // re-implementation, not the moment the aspect was brought up
        const chrono = Math.max(0.5, 1 - 0.2 * (sOrd(r.unit_id) - 1));
        add(r.unit_id, (0.92 - taken * 0.06) * chrono, "temporal:topic");
        if (++taken >= 2) break;
      }
    }
    // one opener per session, scored by how much of the question it covers
    const rows = db
      .query(
        `SELECT session_id, unit_id, session_ordinal, rn FROM (
           SELECT session_id, unit_id, turn_ordinal, session_ordinal,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY turn_ordinal) AS rn
           FROM omni_timeline)
         WHERE rn <= 3 ORDER BY session_ordinal, turn_ordinal`,
      )
      .all() as Array<{ session_id: string; unit_id: string; session_ordinal: number; rn: number }>;
    const sess: Array<{ id: string; s: number }> = [];
    for (const r of rows) {
      const cov = coverageOf(qt, textOf(r.unit_id));
      if (cov <= 0) continue;
      sess.push({ id: r.unit_id, s: (0.45 + 0.55 * cov) * (r.rn === 1 ? 1 : 0.8) });
    }
    sess.sort((a, b) => b.s - a.s);
    for (const r of sess.slice(0, 2)) add(r.id, r.s, "temporal:session");
  }

  // absolute dates: "in March 2024", "2023", "last summer"
  const year = q.match(/\b(20\d{2})\b/)?.[1];
  const monthIdx = MONTHS.findIndex((m) => q.includes(m));
  if (year || monthIdx >= 0) {
    const rows = db.query("SELECT unit_id, abs_date_iso FROM omni_timeline").all() as Array<{
      unit_id: string;
      abs_date_iso: string;
    }>;
    for (const r of rows) {
      const iso = r.abs_date_iso ?? "";
      if (year && !iso.startsWith(year)) continue;
      if (monthIdx >= 0 && iso.slice(5, 7) !== String(monthIdx + 1).padStart(2, "0")) continue;
      add(r.unit_id, 0.8 + 0.2 * coverageOf(qt, textOf(r.unit_id)), "temporal:session");
    }
  }

  const max = Math.max(...scores.values(), 1e-9);
  return [...scores]
    .map(([id, s]) => ({ id, score: s / max, op: kinds.get(id) ?? "temporal" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ------------------------------------------------------------- OP_STATE

/** Latest vs history from the state ledger. */
export function opState(db: Database, question: string, limit = 30): OmniHit[] {
  const q = normQ(question);
  const wantsLatest = /\b(current|currently|latest|now|nowadays|still|today|at the moment)\b/.test(q);
  const wantsHistory = /\b(before|previous|previously|used to|originally|initial|initially|changed|change|history|how many times|no longer|switched)\b/.test(q);
  const firstPerson = /\b(i|i'm|i've|my|me|mine)\b/.test(q);
  const ents = questionEntities(question);
  const subjects = new Set<string>(ents);
  if (firstPerson) subjects.add("user");
  if (!subjects.size) return [];
  const acc = new Map<string, number>();
  const qTerms = termsOf(question);
  for (const e of subjects) {
    const rows = db
      .query(
        "SELECT unit_id, is_latest, version_num, prev_unit_id, attribute_slot FROM omni_state_ledger WHERE subject_entity = ? ORDER BY version_num DESC",
      )
      .all(e) as Array<{ unit_id: string; is_latest: number; version_num: number; prev_unit_id: string | null; attribute_slot: string }>;
    for (const r of rows) {
      // the slot has to be *about* something the question names
      if (!qTerms.some((t) => r.attribute_slot.includes(t) || t.includes(r.attribute_slot))) continue;
      if (wantsLatest && !wantsHistory && !r.is_latest) continue;
      const s = wantsHistory ? 1 : r.is_latest ? 1 : 0.35;
      acc.set(r.unit_id, Math.max(acc.get(r.unit_id) ?? 0, s));
      if (wantsHistory && r.prev_unit_id) acc.set(r.prev_unit_id, Math.max(acc.get(r.prev_unit_id) ?? 0, 0.8));
    }
  }
  return [...acc]
    .map(([id, score]) => ({ id, score, op: "state:latest" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 4));
}

// ------------------------------------------------------------- OP_FACET

/** Category lookup: the question names the class, the turn names a member. */
export function opFacet(db: Database, question: string, limit = 40): OmniHit[] {
  const cats: string[] = [];
  for (const [re, cat] of FACET_OF_QUESTION) if (re.test(question)) cats.push(cat);
  if (!cats.length) return [];
  const qt = termsOf(question);
  const acc = new Map<string, number>();
  for (const c of cats) {
    const rows = db.query("SELECT unit_id, specific_value FROM omni_facet_index WHERE facet_category = ?").all(c) as Array<{
      unit_id: string;
      specific_value: string;
    }>;
    for (const r of rows) {
      // a turn that also shares the question's predicate is a much better
      // member of the category than one that only says "book".
      const cov = coverageOf(qt, r.specific_value);
      acc.set(r.unit_id, Math.max(acc.get(r.unit_id) ?? 0, 0.55 + 0.45 * cov));
    }
  }
  return [...acc]
    .map(([id, score]) => ({ id, score, op: "facet" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 6));
}

// ------------------------------------------------------------ OP_CAUSAL

/** Expand matched units to the rest of their request→tool→answer episode. */
export function opCausal(db: Database, anchors: string[], limit = 20): OmniHit[] {
  if (!anchors.length) return [];
  const acc = new Map<string, number>();
  for (const a of anchors.slice(0, 5)) {
    const ep = db.query("SELECT episode_id FROM omni_causal WHERE unit_id = ?").get(a) as { episode_id: string } | null;
    if (!ep) continue;
    const sibs = db.query("SELECT unit_id, role FROM omni_causal WHERE episode_id = ?").all(ep.episode_id) as Array<{
      unit_id: string;
      role: string;
    }>;
    for (const s of sibs) {
      if (s.unit_id === a) continue;
      const v = s.role === "answer" ? 0.6 : s.role === "tool_output" ? 0.9 : 0.4;
      acc.set(s.unit_id, Math.max(acc.get(s.unit_id) ?? 0, v));
    }
  }
  return [...acc]
    .map(([id, score]) => ({ id, score, op: "causal" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// --------------------------------------------------------- OP_SET_COVER

/**
 * Iterative residual set-cover. Each pick must cover a sub-query that no
 * earlier pick covered; covering it once reduces its weight by 85%, so slot
 * k+1 is forced to a *different* event rather than a paraphrase of slot k.
 * Turns adjacent (same session, ±2 ordinals) to a pick are damped too, except
 * for the direct reply pair (t → t+1), which aggregate gold usually wants.
 */
export function opSetCover(
  db: Database,
  question: string,
  pool: Array<{ id: string; text: string }>,
  k = 10,
): OmniHit[] {
  const facets = subQueries(question);
  if (!facets.length || !pool.length) return [];
  const fTerms = facets.map((f) => termsOf(f)).filter((t) => t.length > 0);
  if (!fTerms.length) return [];
  const weights = fTerms.map(() => 1);
  const ord = new Map<string, number | null>();
  const ordOfPool = (id: string) => {
    if (!ord.has(id)) ord.set(id, ordOf(db, id));
    return ord.get(id) ?? null;
  };
  const picked: OmniHit[] = [];
  const used = new Set<string>();
  const coverOf = new Map<string, number[]>();

  for (let round = 0; round < Math.min(k, 6); round++) {
    let best: { id: string; s: number; cov: number[] } | null = null;
    for (const p of pool) {
      if (used.has(p.id)) continue;
      let cov = coverOf.get(p.id);
      if (!cov) {
        const low = normQ(p.text);
        cov = fTerms.map((terms) => {
          let hit = 0;
          for (const t of terms) if (low.includes(t)) hit++;
          return hit / terms.length;
        });
        coverOf.set(p.id, cov);
      }
      let s = 0;
      for (let i = 0; i < cov.length; i++) s += weights[i] * cov[i];
      s /= cov.length;
      if (s <= 0) continue;
      // novelty against the current picks: adjacent turns are near-duplicates
      const o = ordOfPool(p.id);
      for (const q of picked) {
        const qo = ordOfPool(q.id);
        if (o !== null && qo !== null && Math.abs(o - qo) === 1) s *= 0.6;
        else if (o !== null && qo !== null && Math.abs(o - qo) <= 2) s *= 0.85;
      }
      if (!best || s > best.s) best = { id: p.id, s, cov };
    }
    if (!best || best.s <= 0.02) break;
    used.add(best.id);
    picked.push({ id: best.id, score: best.s, op: "setcover" });
    for (let i = 0; i < best.cov.length; i++) {
      if (best.cov[i] > 0) weights[i] *= 0.15;
    }
  }
  const max = Math.max(...picked.map((p) => p.score), 1e-9);
  return picked.map((p) => ({ ...p, score: p.score / max }));
}

/** Split an aggregate question into its evidence-seeking sub-queries. */
export function subQueries(question: string): string[] {
  const q = String(question ?? "");
  let tail = q;
  for (let i = 0; i < 4; i++) {
    const before = tail;
    tail = tail
      .replace(/^.*?\b(?:order in which|in what order|list|summary of|summarize|walk me through|overview of|tell me about|describe|different aspects of)\b/i, "")
      .replace(/\b(?:mention only|only)\s+(?:and\s+only\s+)?(?:\w+\s+)?items?\b.*$/i, "")
      .trim();
    if (tail === before) break;
  }
  const out: string[] = [];
  for (const part of tail.split(/\b(?:and|,|;|\balso\b|\bplus\b|\bas well as\b)\b/i)) {
    const p = part
      .replace(/^(?:the|a|an|my|our|how|what|which|that|in|of|to|i|did|have|had)\b/gi, "")
      .replace(/\b(?:across (our|my) (conversations|sessions|chats)|throughout our (conversations|sessions))\b/gi, "")
      .trim();
    if (p.length < 6) continue;
    if (!/[a-z]{3,}/i.test(p)) continue;
    out.push(p.slice(0, 90));
  }
  // no conjunction: the whole tail is one sub-query, plus its noun phrases
  if (!out.length) {
    const t = tail.trim();
    if (t.length >= 6) out.push(t.slice(0, 90));
  }
  return out.slice(0, 6);
}
