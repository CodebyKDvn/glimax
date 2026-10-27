// ===========================================================================
// db.ts — the Chronos brain. One SQLite file, five tiers + the v3 cortex.
//
//   L3  l3_verbatim_vault        every interaction, verbatim, never deleted
//   L2  l2_temporal_graph        bi-temporal facts: valid_from / valid_until
//   L2  l2_episodic_projects     the project story: focus, open loops, milestones
//   L2  l2_procedural_engrams    v3: self-learned reflexes (fast-path / avoid)
//   L2  l2_subconscious_interceptors  v3: 0-token tool.execute.before rewrites
//   L2  l2_executable_macros     v3: crystallized one-step command sequences
//   L1  l1_session_working_set   what this session already saw (anti-repeat)
//   L0  l0_snapshots             per-session frozen AAAK: prompt-cache safety
//
// Full-text search runs on FTS5 mirrors of L3: `porter unicode61` for BM25
// relevance and `trigram` for exact code/variable lookups. Vectors are stored
// as raw Float32 blobs; semantic hashes as 384-bit hex. The v3 engram mirror
// (l2_engram_fts) makes reflex lookup a single MATCH away.
//
// SCOPE — "global" or "project:<name>" (v3 adds "stack:<tech>"). Names (not
// paths) are the identity, so eduflash is the same project whether you open
// it from ~/code or /tmp. Paths are only a fallback for unnamed directories.
//
// Every public function is wrapped: a broken brain must degrade to a working
// OpenCode, never the other way round. Migration from v1/v2 is in-place and
// non-destructive (see migrate()); v3 only ever ADDS tables.
// ===========================================================================

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FUSION_K,
  VEC_DIM,
  analyzeQuery,
  blobToVec,
  conceptQueryGroups,
  conceptQueryTags,
  conceptTags,
  embed,
  ftsMatchOf,
  haloEntities,
  idfOf,
  projectKey,
  quoteFts,
  simhash384,
  simhashToHex,
  splitCJK,
  triggerSignature,
  turnOffset,
  vecToBlob,
} from "./aaak";

export const BRAIN_PATH =
  process.env.CHRONOS_BRAIN_PATH ??
  join(homedir(), ".local", "share", "opencode", "chronos-memory", "brain.sqlite");

/** Bumped whenever the schema changes; recorded in chronos_meta. */
export const SCHEMA_VERSION = 4;

let db: Database | null = null;

// ------------------------------------------------------------------ tables

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS chronos_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- L3: the verbatim vault ---------------------------------------------------
CREATE TABLE IF NOT EXISTS l3_verbatim_vault (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT    NOT NULL,
  project_name      TEXT,
  project_path      TEXT,
  timestamp         INTEGER NOT NULL,
  event_type        TEXT    NOT NULL,
  raw_content       TEXT    NOT NULL,
  entities_json     TEXT,
  file_paths_json   TEXT,
  simhash_signature TEXT,
  vec               BLOB,
  meta_json         TEXT,
  -- v5.0: tokenizer-friendly surface (CJK char-split, tool-noise flattened)
  fts_text          TEXT,
  -- v5.0: contextual halo — rare entities of turns t-2..t+1 of the session
  halo              TEXT,
  -- v5.0: source turn id (meta.turn), indexed for neighbour coupling
  turn_id           TEXT
);

-- v6.0: fact ledger -------------------------------------------------------
-- Clean, pronoun-free fact statements mapped to the source turn they came
-- from. It is a separate table on purpose: facts boost their source turn in
-- retrieval, but never compete with verbatim turns for a top-10 slot.
CREATE TABLE IF NOT EXISTS l3_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  source_turn TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  meta_json   TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l3_facts_session ON l3_facts(session_id, source_turn);

-- L2: bi-temporal knowledge graph ------------------------------------------
CREATE TABLE IF NOT EXISTS l2_temporal_graph (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scope            TEXT    NOT NULL,
  category         TEXT    NOT NULL,
  subject          TEXT    NOT NULL,
  predicate        TEXT    NOT NULL,
  object           TEXT    NOT NULL,
  aaak_text        TEXT,
  confidence       REAL    NOT NULL DEFAULT 0.6,
  stability        REAL    NOT NULL DEFAULT 1.0,
  access_count     INTEGER NOT NULL DEFAULT 0,
  valid_from       INTEGER NOT NULL,
  valid_until      INTEGER,
  superseded_by    INTEGER,
  last_accessed_at INTEGER,
  created_at       INTEGER NOT NULL,
  meta_json        TEXT,
  vec              BLOB,
  simhash_signature TEXT
);

-- L2: episodic project memory ---------------------------------------------
CREATE TABLE IF NOT EXISTS l2_episodic_projects (
  project_name      TEXT PRIMARY KEY,
  project_path      TEXT,
  summary_aaak      TEXT,
  current_focus     TEXT,
  open_loops_json   TEXT,
  last_milestone    TEXT,
  last_active_at    INTEGER NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','completed'))
);

-- L1: per-session anti-repeat working set ---------------------------------
CREATE TABLE IF NOT EXISTS l1_session_working_set (
  session_id  TEXT    NOT NULL,
  memory_key  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  injected_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, memory_key)
);

-- L0: frozen per-session snapshot (prompt-cache contract) ------------------
CREATE TABLE IF NOT EXISTS l0_snapshots (
  session_id       TEXT PRIMARY KEY,
  frozen_dna_aaak  TEXT NOT NULL,
  frozen_pulse_aaak TEXT NOT NULL,
  scope            TEXT,
  created_at       INTEGER NOT NULL
);

-- v3: procedural reflex engrams — the self-learned skills -------------------
-- One row = one lesson: "when <trigger>, avoid <wrong>, do <right>".
CREATE TABLE IF NOT EXISTS l2_procedural_engrams (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  engram_key           TEXT    NOT NULL UNIQUE,
  scope                TEXT    NOT NULL,
  trigger_intent       TEXT    NOT NULL,
  trigger_simhash      TEXT,
  anti_pattern_aaak    TEXT,
  fast_path_aaak       TEXT    NOT NULL,
  macro_id             TEXT,
  maturity             INTEGER NOT NULL DEFAULT 0,
  token_saved_estimate INTEGER NOT NULL DEFAULT 0,
  success_rate         REAL    NOT NULL DEFAULT 0.6,
  last_fired_at        INTEGER,
  valid_until          INTEGER
);

-- v3: subconscious interceptors — 0-token rewrites in tool.execute.before ----
CREATE TABLE IF NOT EXISTS l2_subconscious_interceptors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT    NOT NULL,
  tool_name           TEXT    NOT NULL,
  match_pattern       TEXT    NOT NULL,
  replacement_action  TEXT    NOT NULL
                      CHECK (replacement_action IN ('rewrite_arg','append_flag','inject_env')),
  replacement_payload TEXT    NOT NULL,
  confidence          REAL    NOT NULL DEFAULT 0.6,
  hit_count           INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, tool_name, match_pattern)
);

-- v3: executable macros — crystallized command sequences (skill-free skills) -
CREATE TABLE IF NOT EXISTS l2_executable_macros (
  macro_id              TEXT PRIMARY KEY,
  scope                 TEXT NOT NULL,
  description_aaak      TEXT,
  command_sequence_json TEXT NOT NULL,
  avg_duration_ms       INTEGER NOT NULL DEFAULT 0,
  usage_count           INTEGER NOT NULL DEFAULT 0,
  last_used_at          INTEGER
);

-- v4: PGA — the project genome: 5 chromosomes, hard cap 2000 tokens --------
CREATE TABLE IF NOT EXISTS pga_project_genomes (
  project_name           TEXT PRIMARY KEY,
  project_path           TEXT,
  file_count             INTEGER NOT NULL DEFAULT 0,
  c1_arch_dna_aaak       TEXT NOT NULL DEFAULT '',
  c2_dep_graph_aaak      TEXT NOT NULL DEFAULT '',
  c3_patterns_aaak       TEXT NOT NULL DEFAULT '',
  c4_semantic_index_aaak TEXT NOT NULL DEFAULT '',
  c5_evolution_mem_aaak  TEXT NOT NULL DEFAULT '',
  total_genome_tokens    INTEGER NOT NULL DEFAULT 0,
  last_synthesized_at    INTEGER,
  last_nightly_audit_at  INTEGER
);

-- v4: PGA C2 — dependency edges (centrality + adjacency compression source) -
CREATE TABLE IF NOT EXISTS pga_c2_dependency_edges (
  project_name     TEXT NOT NULL,
  source_file      TEXT NOT NULL,
  target_file      TEXT NOT NULL,
  import_symbols   TEXT,
  centrality_score REAL NOT NULL DEFAULT 0,
  last_updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_name, source_file, target_file)
);

-- v4: PGA C3 — the pattern library learned from finished tasks -------------
CREATE TABLE IF NOT EXISTS pga_c3_pattern_library (
  pattern_id               TEXT PRIMARY KEY,
  project_name             TEXT NOT NULL,
  task_category            TEXT NOT NULL,
  trigger_keywords         TEXT,
  blueprint_aaak           TEXT,
  target_files_template    TEXT,
  usage_count              INTEGER NOT NULL DEFAULT 1,
  success_count            INTEGER NOT NULL DEFAULT 1,
  success_rate             REAL NOT NULL DEFAULT 1.0,
  avg_tokens_consumed      INTEGER NOT NULL DEFAULT 450,
  baseline_tokens_estimate INTEGER NOT NULL DEFAULT 8000,
  darwin_roi               REAL NOT NULL DEFAULT 1.0,
  last_used_at             INTEGER
);

-- v4: PGA C4 — semantic pointers: symbol -> file:Lstart-Lend ----------------
CREATE TABLE IF NOT EXISTS pga_c4_semantic_pointers (
  pointer_id      TEXT PRIMARY KEY,
  project_name    TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  symbol_name     TEXT NOT NULL,
  symbol_kind     TEXT NOT NULL DEFAULT 'function',
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  semantic_tags   TEXT,
  relevance_score REAL NOT NULL DEFAULT 1.0,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_hit_at     INTEGER
);

-- v4: PGA C5 — evolution memory: lessons with a 30-day shelf life -----------
CREATE TABLE IF NOT EXISTS pga_c5_evolution_lessons (
  lesson_id       TEXT PRIMARY KEY,
  project_name    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  bug_summary     TEXT,
  fix_method_aaak TEXT,
  file_pointer    TEXT,
  severity        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (severity IN ('normal','critical')),
  hit_count       INTEGER NOT NULL DEFAULT 0,
  darwin_roi      REAL NOT NULL DEFAULT 1.0
);

-- v4: Token-Darwin ledger — ROI bookkeeping for every self-made artifact ----
CREATE TABLE IF NOT EXISTS darwin_artifact_ledger (
  artifact_type      TEXT NOT NULL,
  artifact_id        TEXT NOT NULL,
  impressions        INTEGER NOT NULL DEFAULT 0,
  activations        INTEGER NOT NULL DEFAULT 0,
  total_tokens_spent INTEGER NOT NULL DEFAULT 0,
  total_tokens_saved INTEGER NOT NULL DEFAULT 0,
  roi_score          REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'thriving'
                     CHECK (status IN ('thriving','probation','pruned')),
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (artifact_type, artifact_id)
);
`;

/**
 * Indexes run AFTER migrate(): on a v1 brain the new columns (project_name,
 * entities_json, …) do not exist yet when the tables are first ensured, so
 * creating their indexes too early would abort the whole open.
 */
const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_l3_session ON l3_verbatim_vault(session_id);
CREATE INDEX IF NOT EXISTS idx_l3_time    ON l3_verbatim_vault(timestamp);
CREATE INDEX IF NOT EXISTS idx_l3_type    ON l3_verbatim_vault(event_type);
CREATE INDEX IF NOT EXISTS idx_l3_project ON l3_verbatim_vault(project_name);
CREATE INDEX IF NOT EXISTS idx_l3_turn    ON l3_verbatim_vault(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_l2_sp       ON l2_temporal_graph(scope, subject, predicate);
CREATE INDEX IF NOT EXISTS idx_l2_live     ON l2_temporal_graph(valid_until);
CREATE INDEX IF NOT EXISTS idx_l2_category ON l2_temporal_graph(category);
CREATE INDEX IF NOT EXISTS idx_proj_active ON l2_episodic_projects(last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_proj_path   ON l2_episodic_projects(project_path);
CREATE INDEX IF NOT EXISTS idx_l1_session ON l1_session_working_set(session_id);
CREATE INDEX IF NOT EXISTS idx_eng_scope  ON l2_procedural_engrams(scope, valid_until);
CREATE INDEX IF NOT EXISTS idx_eng_mature ON l2_procedural_engrams(maturity DESC);
CREATE INDEX IF NOT EXISTS idx_ic_tool    ON l2_subconscious_interceptors(tool_name, active);
CREATE INDEX IF NOT EXISTS idx_macro_scope ON l2_executable_macros(scope);
CREATE INDEX IF NOT EXISTS idx_pga_c2_proj   ON pga_c2_dependency_edges(project_name);
CREATE INDEX IF NOT EXISTS idx_pga_c3_proj   ON pga_c3_pattern_library(project_name, task_category);
CREATE INDEX IF NOT EXISTS idx_pga_c4_proj   ON pga_c4_semantic_pointers(project_name, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_pga_c4_file   ON pga_c4_semantic_pointers(project_name, file_path);
CREATE INDEX IF NOT EXISTS idx_pga_c5_proj   ON pga_c5_evolution_lessons(project_name, expires_at);
CREATE INDEX IF NOT EXISTS idx_darwin_status ON darwin_artifact_ledger(status, roi_score DESC);
`;

const L3_FTS_SQL = `
-- BM25 relevance mirror (stemmed) -----------------------------------------
-- v5.0: indexes fts_text (CJK char-split + tool-noise flattened), so a Han
-- run is a sequence of char tokens and JSON boilerplate stops winning BM25.
CREATE VIRTUAL TABLE IF NOT EXISTS l3_fts USING fts5(
  fts_text,
  content='l3_verbatim_vault',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS l3_fts_ai AFTER INSERT ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts(rowid, fts_text) VALUES (new.id, COALESCE(new.fts_text, new.raw_content));
END;
CREATE TRIGGER IF NOT EXISTS l3_fts_ad AFTER DELETE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts(l3_fts, rowid, fts_text) VALUES ('delete', old.id, COALESCE(old.fts_text, old.raw_content));
END;
CREATE TRIGGER IF NOT EXISTS l3_fts_au AFTER UPDATE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts(l3_fts, rowid, fts_text) VALUES ('delete', old.id, COALESCE(old.fts_text, old.raw_content));
  INSERT INTO l3_fts(rowid, fts_text) VALUES (new.id, COALESCE(new.fts_text, new.raw_content));
END;

-- v5.0: context-halo mirror — matches the neighbours' rare entities ---------
CREATE VIRTUAL TABLE IF NOT EXISTS l3_halo_fts USING fts5(
  halo,
  content='l3_verbatim_vault',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS l3_halo_ai AFTER INSERT ON l3_verbatim_vault BEGIN
  INSERT INTO l3_halo_fts(rowid, halo) VALUES (new.id, COALESCE(new.halo, ''));
END;
CREATE TRIGGER IF NOT EXISTS l3_halo_ad AFTER DELETE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_halo_fts(l3_halo_fts, rowid, halo) VALUES ('delete', old.id, COALESCE(old.halo, ''));
END;
CREATE TRIGGER IF NOT EXISTS l3_halo_au AFTER UPDATE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_halo_fts(l3_halo_fts, rowid, halo) VALUES ('delete', old.id, COALESCE(old.halo, ''));
  INSERT INTO l3_halo_fts(rowid, halo) VALUES (new.id, COALESCE(new.halo, ''));
END;

-- exact-substring mirror for identifiers / error codes ---------------------
CREATE VIRTUAL TABLE IF NOT EXISTS l3_fts_tri USING fts5(
  raw_content,
  content='l3_verbatim_vault',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS l3_tri_ai AFTER INSERT ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts_tri(rowid, raw_content) VALUES (new.id, new.raw_content);
END;
CREATE TRIGGER IF NOT EXISTS l3_tri_ad AFTER DELETE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts_tri(l3_fts_tri, rowid, raw_content) VALUES ('delete', old.id, old.raw_content);
END;
CREATE TRIGGER IF NOT EXISTS l3_tri_au AFTER UPDATE ON l3_verbatim_vault BEGIN
  INSERT INTO l3_fts_tri(l3_fts_tri, rowid, raw_content) VALUES ('delete', old.id, old.raw_content);
  INSERT INTO l3_fts_tri(rowid, raw_content) VALUES (new.id, new.raw_content);
END;
`;

const L2_FTS_SQL = `
-- BM25 mirror over the knowledge graph itself -----------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS l2_fts USING fts5(
  subject,
  object,
  aaak_text,
  content='l2_temporal_graph',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS l2_fts_ai AFTER INSERT ON l2_temporal_graph BEGIN
  INSERT INTO l2_fts(rowid, subject, object, aaak_text)
  VALUES (new.id, new.subject, new.object, COALESCE(new.aaak_text,''));
END;
CREATE TRIGGER IF NOT EXISTS l2_fts_ad AFTER DELETE ON l2_temporal_graph BEGIN
  INSERT INTO l2_fts(l2_fts, rowid, subject, object, aaak_text)
  VALUES ('delete', old.id, old.subject, old.object, COALESCE(old.aaak_text,''));
END;
CREATE TRIGGER IF NOT EXISTS l2_fts_au AFTER UPDATE ON l2_temporal_graph BEGIN
  INSERT INTO l2_fts(l2_fts, rowid, subject, object, aaak_text)
  VALUES ('delete', old.id, old.subject, old.object, COALESCE(old.aaak_text,''));
  INSERT INTO l2_fts(rowid, subject, object, aaak_text)
  VALUES (new.id, new.subject, new.object, COALESCE(new.aaak_text,''));
END;
`;

const ENGRAM_FTS_SQL = `
-- BM25 mirror over procedural engrams (v3 cortex) --------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS l2_engram_fts USING fts5(
  trigger_intent,
  anti_pattern_aaak,
  fast_path_aaak,
  content='l2_procedural_engrams',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS l2e_fts_ai AFTER INSERT ON l2_procedural_engrams BEGIN
  INSERT INTO l2_engram_fts(rowid, trigger_intent, anti_pattern_aaak, fast_path_aaak)
  VALUES (new.id, new.trigger_intent, COALESCE(new.anti_pattern_aaak,''), COALESCE(new.fast_path_aaak,''));
END;
CREATE TRIGGER IF NOT EXISTS l2e_fts_ad AFTER DELETE ON l2_procedural_engrams BEGIN
  INSERT INTO l2_engram_fts(l2_engram_fts, rowid, trigger_intent, anti_pattern_aaak, fast_path_aaak)
  VALUES ('delete', old.id, old.trigger_intent, COALESCE(old.anti_pattern_aaak,''), COALESCE(old.fast_path_aaak,''));
END;
CREATE TRIGGER IF NOT EXISTS l2e_fts_au AFTER UPDATE ON l2_procedural_engrams BEGIN
  INSERT INTO l2_engram_fts(l2_engram_fts, rowid, trigger_intent, anti_pattern_aaak, fast_path_aaak)
  VALUES ('delete', old.id, old.trigger_intent, COALESCE(old.anti_pattern_aaak,''), COALESCE(old.fast_path_aaak,''));
  INSERT INTO l2_engram_fts(rowid, trigger_intent, anti_pattern_aaak, fast_path_aaak)
  VALUES (new.id, new.trigger_intent, COALESCE(new.anti_pattern_aaak,''), COALESCE(new.fast_path_aaak,''));
END;
`;

const PGA_FTS_SQL = `
-- BM25 mirror over semantic pointers (v4 genome, sub-ms symbol lookup) ------
CREATE VIRTUAL TABLE IF NOT EXISTS pga_c4_fts USING fts5(
  symbol_name,
  semantic_tags,
  file_path,
  content='pga_c4_semantic_pointers',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS pga_c4_fts_ai AFTER INSERT ON pga_c4_semantic_pointers BEGIN
  INSERT INTO pga_c4_fts(rowid, symbol_name, semantic_tags, file_path)
  VALUES (new.rowid, new.symbol_name, COALESCE(new.semantic_tags,''), new.file_path);
END;
CREATE TRIGGER IF NOT EXISTS pga_c4_fts_ad AFTER DELETE ON pga_c4_semantic_pointers BEGIN
  INSERT INTO pga_c4_fts(pga_c4_fts, rowid, symbol_name, semantic_tags, file_path)
  VALUES ('delete', old.rowid, old.symbol_name, COALESCE(old.semantic_tags,''), old.file_path);
END;
CREATE TRIGGER IF NOT EXISTS pga_c4_fts_au AFTER UPDATE ON pga_c4_semantic_pointers BEGIN
  INSERT INTO pga_c4_fts(pga_c4_fts, rowid, symbol_name, semantic_tags, file_path)
  VALUES ('delete', old.rowid, old.symbol_name, COALESCE(old.semantic_tags,''), old.file_path);
  INSERT INTO pga_c4_fts(rowid, symbol_name, semantic_tags, file_path)
  VALUES (new.rowid, new.symbol_name, COALESCE(new.semantic_tags,''), new.file_path);
END;
`;

// ------------------------------------------------------------------- open

export function brain(): Database | null {
  if (db) return db;
  try {
    mkdirSync(dirname(BRAIN_PATH), { recursive: true });
    const d = new Database(BRAIN_PATH, { create: true });
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA synchronous = NORMAL");
    d.exec("PRAGMA busy_timeout = 4000");
    d.exec("PRAGMA foreign_keys = ON");
    // v4.1: keep hot edge/L3 pages resident — large brains (100K-token corpora)
    // otherwise re-read ~25MB per graph search and p50 latency blows up.
    d.exec("PRAGMA cache_size = -48000");
    d.exec("PRAGMA mmap_size = 268435456");
    d.exec(TABLES_SQL);
    const droppedMirror = migrate(d); // fixes column names on brains written by v1, then
    d.exec(INDEXES_SQL);
    d.exec(L3_FTS_SQL);
    d.exec(L2_FTS_SQL);
    d.exec(ENGRAM_FTS_SQL);
    d.exec(PGA_FTS_SQL);
    if (droppedMirror) {
      try {
        d.exec("INSERT INTO l3_fts(l3_fts) VALUES('rebuild')");
        d.exec("INSERT INTO l3_halo_fts(l3_halo_fts) VALUES('rebuild')");
      } catch {}
    }
    backfillV5(d);
    try {
      d.query(`INSERT OR REPLACE INTO chronos_meta (key, value) VALUES ('schema_version', ?)`).run(
        String(SCHEMA_VERSION),
      );
    } catch {}
    db = d;
    return db;
  } catch (err) {
    try {
      if (process.env.CHRONOS_DEBUG) console.error("[chronos] brain-open:", err instanceof Error ? err.message : err);
    } catch {}
    return null;
  }
}

/**
 * v5 one-time backfill: brains written before v5 have fts_text / halo / turn_id
 * NULL. Fill them in bounded batches so a 100K-row brain opens without a stall
 * and every legacy row is still findable by the new rankers.
 */
function backfillV5(d: Database): void {
  try {
    const todo = d
      .query(`SELECT COUNT(*) AS n FROM l3_verbatim_vault WHERE fts_text IS NULL LIMIT 1`)
      .get() as { n: number } | null;
    if (!todo || !todo.n) return;
    const rows = d
      .query(`SELECT id, raw_content, meta_json FROM l3_verbatim_vault WHERE fts_text IS NULL ORDER BY id LIMIT 4000`)
      .all() as Array<{ id: number; raw_content: string; meta_json: string | null }>;
    if (!rows.length) return;
    const upd = d.query(`UPDATE l3_verbatim_vault SET fts_text = ?, turn_id = COALESCE(turn_id, ?) WHERE id = ?`);
    d.exec("BEGIN IMMEDIATE");
    for (const r of rows) {
      upd.run(searchSurface(r.raw_content), turnFromMeta(r.meta_json), r.id);
    }
    d.exec("COMMIT");
  } catch {
    try {
      d.exec("ROLLBACK");
    } catch {}
  }
}

function tableCols(d: Database, table: string): Set<string> {
  try {
    const rows = d.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

/**
 * In-place, non-destructive migration of a v1 brain:
 *   l3  += project_name, entities_json, fts_text, halo, turn_id   (v5)
 *   l2   aaak_compressed -> aaak_text, superseded_by_id -> superseded_by
 *   l1   memory_id+kind key -> memory_key
 * Nothing is dropped except the FTS mirrors, which are rebuilt from L3/L2.
 */
function migrate(d: Database): void {
  const l3 = tableCols(d, "l3_verbatim_vault");
  if (l3.size) {
    if (!l3.has("project_name")) d.exec("ALTER TABLE l3_verbatim_vault ADD COLUMN project_name TEXT");
    if (!l3.has("entities_json")) d.exec("ALTER TABLE l3_verbatim_vault ADD COLUMN entities_json TEXT");
    if (!l3.has("fts_text")) d.exec("ALTER TABLE l3_verbatim_vault ADD COLUMN fts_text TEXT");
    if (!l3.has("halo")) d.exec("ALTER TABLE l3_verbatim_vault ADD COLUMN halo TEXT");
    if (!l3.has("turn_id")) d.exec("ALTER TABLE l3_verbatim_vault ADD COLUMN turn_id TEXT");
  }

  // v5: the L3 mirrors changed shape (raw_content -> fts_text, + halo mirror).
  // A v4 brain still carries the old one; drop it and let L3_FTS_SQL rebuild.
  let l3Mirror = "";
  try {
    l3Mirror = String(
      (d.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='l3_fts'`).get() as { sql?: string } | null)?.sql ?? "",
    );
  } catch {}
  if (l3Mirror && !l3Mirror.includes("fts_text")) {
    for (const t of ["l3_fts_ai", "l3_fts_ad", "l3_fts_au", "l3_halo_ai", "l3_halo_ad", "l3_halo_au"]) {
      try {
        d.exec(`DROP TRIGGER IF EXISTS ${t}`);
      } catch {}
    }
    for (const t of ["l3_fts", "l3_halo_fts"]) {
      try {
        d.exec(`DROP TABLE IF EXISTS ${t}`);
      } catch {}
    }
  }

  const l2 = tableCols(d, "l2_temporal_graph");
  let renamed = false;
  if (l2.size) {
    if (l2.has("aaak_compressed") && !l2.has("aaak_text")) {
      d.exec("ALTER TABLE l2_temporal_graph RENAME COLUMN aaak_compressed TO aaak_text");
      renamed = true;
    }
    if (l2.has("superseded_by_id") && !l2.has("superseded_by")) {
      d.exec("ALTER TABLE l2_temporal_graph RENAME COLUMN superseded_by_id TO superseded_by");
      renamed = true;
    }
  }
  if (renamed) {
    // the old triggers reference the old names; drop mirror + triggers and
    // let L2_FTS_SQL rebuild them against the renamed table.
    for (const t of ["l2_fts_ai", "l2_fts_ad", "l2_fts_au"]) {
      try {
        d.exec(`DROP TRIGGER IF EXISTS ${t}`);
      } catch {}
    }
    try {
      d.exec("DROP TABLE IF EXISTS l2_fts");
    } catch {}
    d.exec(L2_FTS_SQL);
    try {
      d.exec("INSERT INTO l2_fts(l2_fts) VALUES('rebuild')");
    } catch {}
  }

  const l1 = tableCols(d, "l1_session_working_set");
  if (l1.size && !l1.has("memory_key")) {
    try {
      d.exec("BEGIN IMMEDIATE");
      d.exec(`CREATE TABLE l1_ws_v2 (
        session_id  TEXT    NOT NULL,
        memory_key  TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        injected_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, memory_key)
      )`);
      d.exec(`INSERT OR IGNORE INTO l1_ws_v2 (session_id, memory_key, kind, injected_at)
              SELECT session_id, 'edge:' || memory_id, kind, injected_at FROM l1_session_working_set`);
      d.exec("DROP TABLE l1_session_working_set");
      d.exec("ALTER TABLE l1_ws_v2 RENAME TO l1_session_working_set");
      d.exec("COMMIT");
    } catch {
      try {
        d.exec("ROLLBACK");
      } catch {}
    }
  }
}

export function closeBrain(): void {
  try {
    db?.close();
  } catch {}
  db = null;
}

function q<T = any>(sql: string, ...params: any[]): T[] {
  const d = brain();
  if (!d) return [];
  try {
    return d.query(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function q1<T = any>(sql: string, ...params: any[]): T | null {
  const rows = q<T>(sql, ...params);
  return rows.length ? rows[0] : null;
}

let writes = 0;

/** v4.1 — monotonic write stamp; lets the retriever cache its live-edge pool. */
export function writeStamp(): number {
  return writes;
}

function run(sql: string, ...params: any[]): number {
  const d = brain();
  if (!d) return 0;
  try {
    const r = d.query(sql).run(...params);
    writes++;
    return Number(r.lastInsertRowid ?? 0);
  } catch {
    return 0;
  }
}

export function tx<T>(fn: () => T): T | null {
  const d = brain();
  if (!d) return null;
  try {
    d.exec("BEGIN IMMEDIATE");
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch {
    try {
      d.exec("ROLLBACK");
    } catch {}
    return null;
  }
}

// ------------------------------------------------------- scope + project

/** Fallback identity for a directory we could not name: a path hash. */
export function projectScope(root: string | null | undefined): string {
  if (!root) return "global";
  let h = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "project:" + (h >>> 0).toString(36);
}

/**
 * Scope for a memory write. A named project wins over its path, so facts
 * learned about eduflash in /tmp still surface when you open ~/code/eduflash.
 */
export function scopeFor(projectName: string | null | undefined, path: string | null | undefined): string {
  const n = projectName ? projectKey(projectName) : "";
  if (n) return "project:" + n;
  return projectScope(path);
}

/** Every scope a query should also look in, project first. */
export function scopesFor(projectName: string | null | undefined, path: string | null | undefined): string[] {
  return [scopeFor(projectName, path)];
}

// ------------------------------------------------------------ L3 verbatim

export type EventType =
  | "user_msg"
  | "file_edit"
  | "bash_cmd"
  | "error_fix"
  | "git_state"
  | "tool_use"
  | "assistant_text"
  // legacy v1 names: still present in old brains, still accepted on write
  | "user_prompt"
  | "file_edit_diff"
  | "error_resolved"
  | "git_commit";

/** Event families: querying "file_edit" must also find v1 "file_edit_diff". */
export const EVENT_ALIASES: Record<string, string[]> = {
  user_msg: ["user_msg", "user_prompt"],
  file_edit: ["file_edit", "file_edit_diff"],
  bash_cmd: ["bash_cmd"],
  error_fix: ["error_fix", "error_resolved"],
  git_state: ["git_state", "git_commit"],
  tool_use: ["tool_use"],
  assistant_text: ["assistant_text"],
};

export function eventFamily(eventType: string): string[] {
  return EVENT_ALIASES[eventType] ?? [eventType];
}

export interface L3Row {
  id: number;
  session_id: string;
  project_name: string | null;
  project_path: string | null;
  timestamp: number;
  event_type: string;
  raw_content: string;
  entities_json: string | null;
  file_paths_json: string | null;
  simhash_signature: string | null;
  vec: unknown;
  meta_json: string | null;
}

export function l3Insert(e: {
  sessionID: string;
  projectName?: string | null;
  projectPath?: string | null;
  eventType: EventType;
  content: string;
  filePaths?: string[];
  entities?: unknown;
  meta?: unknown;
  timestamp?: number;
}): number {
  const content = String(e.content ?? "");
  if (!content.trim()) return 0;
  const sh = simhash384(content);
  const v = embed(content);
  const ts = e.timestamp ?? Date.now();
  const metaTurn = metaField(e.meta, "turn");
  const speaker = metaField(e.meta, "speaker");
  const halo = buildHalo(e.sessionID, ts, speaker);
  // v6.0 — index-time speaker projection + ontology tags. A turn spoken by
  // Caroline becomes findable by "Caroline" even when it only says "I", and a
  // "retriever" turn becomes findable by "dog"/"pet" without query expansion.
  const indexText = [flatIndexText(content), speaker ?? "", conceptTags(content)]
    .filter((s) => s && s.trim())
    .join(" ");
  const id = run(
    `INSERT INTO l3_verbatim_vault
       (session_id, project_name, project_path, timestamp, event_type, raw_content,
        entities_json, file_paths_json, simhash_signature, vec, meta_json,
        fts_text, halo, turn_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.sessionID,
    e.projectName ? projectKey(e.projectName) : null,
    e.projectPath ?? null,
    ts,
    e.eventType,
    content,
    e.entities ? JSON.stringify(e.entities).slice(0, 2000) : null,
    e.filePaths?.length ? JSON.stringify(e.filePaths.slice(0, 40)) : null,
    simhashToHex(sh),
    vecToBlob(v),
    e.meta ? JSON.stringify(e.meta).slice(0, 4000) : null,
    indexText,
    halo || null,
    metaTurn,
  );
  if (id) backfillPrevHalo(e.sessionID, id, content);
  return id;
}

// --------------------------------------------------- v6.0 fact ledger

export interface FactRow {
  id: number;
  session_id: string;
  source_turn: string;
  text: string;
  meta_json: string | null;
  created_at: number;
}

/** Store a clean fact statement and the source turn it was extracted from. */
export function l3FactInsert(e: {
  sessionID: string;
  sourceTurn: string;
  text: string;
  meta?: unknown;
  now?: number;
}): number {
  const text = String(e.text ?? "").trim();
  const source = String(e.sourceTurn ?? "").trim();
  if (!text || !source) return 0;
  return run(
    `INSERT INTO l3_facts (session_id, source_turn, text, meta_json, created_at)
     VALUES (?,?,?,?,?)`,
    e.sessionID,
    source,
    text,
    e.meta ? JSON.stringify(e.meta).slice(0, 2000) : null,
    e.now ?? Date.now(),
  );
}

/**
 * Query the fact ledger and return the clean statements + source turn ids.
 * No LLM: rare-term coverage, exact phrases, and ontology expansion. The
 * caller decides how much to trust a hit; `coverage` is the fraction of the
 * question's rare terms present in the fact.
 */
export function l3FactSearch(
  sessionID: string,
  query: string,
  limit = 12,
): Array<FactRow & { score: number; coverage: number; phraseHit: number }> {
  const rows = q<FactRow>(`SELECT * FROM l3_facts WHERE session_id = ?`, sessionID);
  if (!rows.length) return [];
  // Action/contact scaffolding ("email Sarah at x@y", "text +1415…") is not
  // evidence. Strip it before scoring so the object of the request (Evergreen
  // August cap, Mercury setup-copy, invoice boundary) drives the match.
  const cleaned = String(query ?? "")
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, " ")
    .replace(/\b(email|text|send|please|copying|copy|draft|reply|state|whether|optional|exact|today|tomorrow|current|received|morning|naming)\b/gi, " ");
  const qa = analyzeQuery(cleaned);
  if (!qa.terms.length) return [];
  const expanded = conceptQueryTags(cleaned).split(/\s+/).filter((t) => t.length >= 3);
  const qGroups = conceptQueryGroups(cleaned);
  const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const has = (txt: string, t: string) =>
    t.includes(" ")
      ? txt.includes(t)
      : new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(txt);
  const indexText = (r: FactRow) => norm(`${r.text} ${conceptTags(r.text)}`);
  const df = new Map<string, number>();
  for (const t of qa.terms) df.set(t, 0);
  for (const r of rows) {
    const txt = indexText(r);
    for (const t of qa.terms) if (has(txt, t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = rows.length;
  const rareBase = qa.rare.length ? qa.rare : qa.terms.slice(0, 4);
  const rare = rareBase.filter((t) => !QUERY_LOW_INFO.has(t));
  if (!rare.length) rare.push(...rareBase.slice(0, 2));
  const rareIdf = new Map<string, number>();
  let rareMass = 0;
  for (const t of rare) {
    const w = idfOf(N, df.get(t) ?? 0);
    rareIdf.set(t, w);
    rareMass += w;
  }
  const out: Array<FactRow & { score: number; coverage: number; phraseHit: number }> = [];
  for (const r of rows) {
    const txt = indexText(r);
    let rareHit = 0;
    for (const t of rare) if (has(txt, t)) rareHit += rareIdf.get(t) ?? 1;
    const coverage = rareMass ? rareHit / rareMass : 0;
    let phraseHit = 0;
    for (const p of qa.phrases.slice(0, 8)) if (txt.includes(p)) phraseHit++;
    let termScore = 0;
    for (const t of qa.terms) {
      if (!has(txt, t)) continue;
      termScore += idfOf(N, df.get(t) ?? 0);
    }
    let conceptHit = 0;
    for (const t of expanded) if (has(txt, t)) conceptHit++;
    let groupHit = 0;
    if (qGroups.length) {
      const ftags = new Set(conceptTags(r.text).split(" ").filter(Boolean));
      for (const set of qGroups) if (set.some((t) => ftags.has(t))) groupHit++;
    }
    const score =
      coverage * 3 +
      phraseHit * 1.6 +
      Math.min(2.2, termScore / 3) +
      Math.min(1.5, conceptHit * 0.2) +
      Math.min(1.2, groupHit * 0.6);
    if (score <= 0) continue;
    out.push({ ...r, score, coverage, phraseHit });
  }
  return out.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
}

// ------------------------------------------------ v5.0 L3 index evolution

/** Read one string field from a meta payload without throwing on junk. */
function metaField(meta: unknown, key: string): string | null {
  if (meta == null || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

/** UTC day stamp, "2026-10-17" — the PULSE/AAAK date format. */
function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const TOOL_NOISE_KEYS = new Set([
  "type", "properties", "required", "description", "enum", "default", "additionalProperties",
  "$schema", "schema", "title", "examples", "format", "anyOf", "oneOf", "allOf",
]);

/**
 * v5.0 — the FTS mirror surface of a row. Two transforms:
 *   1. JSON/tool payloads collapse to `key=value · …` (schema boilerplate out),
 *      so action metadata stops crowding verbatim evidence in BM25.
 *   2. CJK text is char-split so FTS5's unicode61 tokenizer sees characters
 *      instead of one opaque run (rescues LexEval / any han query).
 * raw_content is never touched — this surface is for matching only.
 */
function flatIndexText(content: string): string {
  let s = content.trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const v = JSON.parse(s) as unknown;
      const parts: string[] = [];
      const walk = (x: unknown, depth: number): void => {
        if (parts.join(" · ").length > 8000 || depth > 4) return;
        if (x == null || typeof x === "number" || typeof x === "boolean") {
          parts.push(String(x));
          return;
        }
        if (typeof x === "string") {
          parts.push(x.replace(/\s+/g, " ").trim());
          return;
        }
        if (Array.isArray(x)) {
          for (const y of x.slice(0, 40)) walk(y, depth + 1);
          return;
        }
        for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
          if (TOOL_NOISE_KEYS.has(k)) continue;
          if (val == null || ["string", "number", "boolean"].includes(typeof val)) {
            parts.push(`${k}=${String(val)}`);
          } else {
            walk(val, depth + 1);
          }
        }
      };
      walk(v, 0);
      const flat = parts.filter(Boolean).join(" · ");
      if (flat.length >= 20) s = flat;
    } catch {
      /* not JSON after all — index the raw text */
    }
  }
  return splitCJK(s.replace(/\s+/g, " ")).slice(0, 20_000);
}

/**
 * v5.0 — the contextual halo of the row about to be written: day + speaker of
 * the turn itself plus the rare entities of the two preceding turns of the
 * session (the t+1 half is patched in when that turn arrives). This is what
 * lets "I painted it last Tuesday" be found by "Melanie's sunrise painting".
 */
function buildHalo(sessionID: string, ts: number, speaker: string | null): string {
  const prev = q<{ id: number; raw_content: string }>(
    `SELECT id, raw_content FROM l3_verbatim_vault WHERE session_id = ? ORDER BY id DESC LIMIT 2`,
    sessionID,
  );
  const ents: string[] = [];
  const seen = new Set<string>();
  for (const p of prev) {
    for (const en of haloEntities(p.raw_content, 12)) {
      const k = en.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      ents.push(en);
    }
  }
  const head = [dayStamp(ts), speaker ?? ""].filter(Boolean).join(" ");
  const body = ents.slice(0, 20).join(" ");
  return `${head}${body ? ` ${body}` : ""}`.trim().slice(0, 320);
}

/** When turn t arrives, hand t-1 the new turn's rare entities (its t+1). */
function backfillPrevHalo(sessionID: string, insertedID: number, content: string): void {
  const ents = haloEntities(content, 10);
  if (!ents.length) return;
  const prev = q1<{ id: number }>(
    `SELECT id FROM l3_verbatim_vault WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT 1`,
    sessionID,
    insertedID,
  );
  if (!prev) return;
  run(
    `UPDATE l3_verbatim_vault SET halo = trim(COALESCE(halo, '') || ' ' || ?) WHERE id = ?`,
    ents.join(" ").slice(0, 160),
    prev.id,
  );
}

export function l3Row(id: number): L3Row | null {
  return q1<L3Row>(`SELECT * FROM l3_verbatim_vault WHERE id = ?`, id);
}

/** BM25 search over the stemmed mirror. Returns rows with a relevance score. */
export function l3SearchBm25(match: string, limit = 20, sessionID?: string): Array<L3Row & { score: number }> {
  return l3Match(ftsQuery(match), limit, sessionID);
}

/** v5.0 — raw FTS5 MATCH over the main mirror (the caller built the expression). */
export function l3Match(match: string, limit = 20, sessionID?: string): Array<L3Row & { score: number }> {
  const m = String(match ?? "").trim();
  if (!m) return [];
  try {
    if (sessionID) {
      return q(
        `SELECT v.*, bm25(l3_fts) AS score FROM l3_fts
           JOIN l3_verbatim_vault v ON v.id = l3_fts.rowid
          WHERE l3_fts MATCH ? AND v.session_id = ?
          ORDER BY score LIMIT ?`,
        m,
        sessionID,
        limit,
      );
    }
    return q(
      `SELECT v.*, bm25(l3_fts) AS score FROM l3_fts
         JOIN l3_verbatim_vault v ON v.id = l3_fts.rowid
        WHERE l3_fts MATCH ?
        ORDER BY score LIMIT ?`,
      m,
      limit,
    );
  } catch {
    return [];
  }
}

// ------------------------------------------------ v5.0 hybrid L3 retrieval
//
// One query, several passes, fused by rank (RRF K=12):
//   1. rare bigram phrases           — precision on "entity phrase" matches
//   2. high-IDF terms                — identifiers, numbers, long words, CJK
//   3. all content terms             — recall floor
//   4. the contextual halo mirror    — a neighbour's shared entities
//   5. one trigram pass              — exact substrings of a rare needle
// Then two structural boosts straight out of the v5.0 spec:
//   • adjacency coupling: the top-5 hits hand 0.55 × their score to their ±1
//     turns of the session (answer usually sits one turn away).
//   • 2-hop high-IDF bridge: rare entities of the top-3 hits (not in the
//     question) run one more pass — finds far-away evidence in 100K corpora.

/** BM25 over the halo mirror: matched rows share entities with their neighbours. */
export function l3HaloMatch(match: string, limit = 30): Array<L3Row & { score: number }> {
  const m = String(match ?? "").trim();
  if (!m) return [];
  try {
    return q(
      `SELECT v.*, bm25(l3_halo_fts) AS score FROM l3_halo_fts
         JOIN l3_verbatim_vault v ON v.id = l3_halo_fts.rowid
        WHERE l3_halo_fts MATCH ?
        ORDER BY score LIMIT ?`,
      m,
      limit,
    );
  } catch {
    return [];
  }
}

/** Rows whose source turn is exactly `turnID` in `sessionID` (coupling lookup). */
function l3BySessionTurn(sessionID: string, turnID: string, limit = 3): L3Row[] {
  return q<L3Row>(
    `SELECT * FROM l3_verbatim_vault WHERE session_id = ? AND turn_id = ? ORDER BY id LIMIT ?`,
    sessionID,
    turnID,
    limit,
  );
}

/** Document frequency of one term in the L3 mirror (for IDF ranking). */
function l3Df(term: string): number {
  const t = String(term ?? "").replace(/["*]/g, " ").trim();
  if (!t) return 0;
  const r = q1<{ n: number }>(`SELECT COUNT(*) AS n FROM l3_fts WHERE l3_fts MATCH ?`, `"${t}"`);
  return r?.n ?? 0;
}

/**
 * Verbs/adverbs/temporal scaffolding ("likely", "pursue", "years", "ago") are
 * useful to *generate* candidates but must not drive *coverage* scoring: they
 * make "three years ago" beat "moved from my home country" for a "where did X
 * move from 4 years ago" question.
 */
const QUERY_LOW_INFO = new Set([
  "likely", "probably", "maybe", "would", "could", "should", "want", "wants", "wanted",
  "planning", "plan", "plans", "pursue", "pursuing", "looking", "look", "think", "going",
  "gonna", "get", "gets", "make", "makes", "help", "helps", "need", "needs", "like",
  "prefer", "prefers", "year", "years", "ago", "current", "currently", "now",
]);

export function l3SearchHybrid(query: string, limit = 50, sessionID?: string): Array<L3Row & { score: number }> {
  const qa = analyzeQuery(query);
  if (!qa.terms.length) return l3SearchBm25(query, limit, sessionID);

  const acc = new Map<number, { row: L3Row; score: number }>();
  const add = (rows: Array<L3Row & { score: number }>, weight: number): void => {
    rows.forEach((r, i) => {
      const v = weight / (FUSION_K + i + 1);
      const cur = acc.get(r.id);
      if (cur) cur.score += v;
      else acc.set(r.id, { row: r, score: v });
    });
  };

  // v6.0 — bidirectional ontology pass: "fields" -> education/major/degree,
  // "instrument" -> piano/guitar, "pet" -> dog/cat. One extra low-weight FTS
  // query, no LLM.
  const cq = conceptQueryTags(query);
  if (cq) add(l3SearchBm25(cq, 80, sessionID), 0.5);

  // v6.0 — per-phrase / per-term IDF soft quorum. OR-ing every phrase into
  // one BM25 query lets common bigrams ("order one") drown a rare evidence
  // anchor ("out early"); each facet now votes with its own IDF weight.
  const N0 = l3Count();
  for (const p of qa.phrases.slice(0, 8)) {
    const df = l3Df(p);
    const w = 0.65 + Math.min(1.15, Math.log(1 + N0 / (df + 1)) / 5);
    add(l3Match(`"${p.replace(/"/g, " ")}"`, 24, sessionID), w);
  }
  for (const t of qa.rare.slice(0, 8)) {
    const df = l3Df(t);
    const w = 0.45 + Math.min(0.9, Math.log(1 + N0 / (df + 1)) / 7);
    add(l3Match(quoteFts(t), 24, sessionID), w);
  }
  const termM = ftsMatchOf(qa, { terms: true });
  if (termM) add(l3Match(termM, 40, sessionID), 0.5);
  const rareM = ftsMatchOf(qa, { rare: true });
  if (rareM) add(l3HaloMatch(rareM, 30), 0.7);

  // one exact-substring pass for a distinctive needle (phrase or long rare term)
  const needle =
    (qa.phrases[0] && qa.phrases[0].length >= 4 ? qa.phrases[0] : null) ??
    qa.rare.find((t) => t.length >= 5 && t.length <= 64) ??
    null;
  if (needle) add(l3SearchTrigram(needle, 30), 0.6);

  if (acc.size < 5) add(l3SearchBm25(query, 30, sessionID), 0.4);

  // ---- 2-hop bridge: rare entities of the top-3 hits, ranked by IDF
  const N = l3Count();
  const seed = [...acc.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  const hopSeen = new Set(qa.terms);
  const hop: Array<{ term: string; idf: number }> = [];
  for (const c of seed) {
    for (const en of haloEntities(c.row.raw_content, 8)) {
      const low = en.toLowerCase();
      if (hopSeen.has(low) || low.length < 3) continue;
      hopSeen.add(low);
      hop.push({ term: en, idf: idfOf(N, l3Df(en)) });
    }
  }
  hop.sort((a, b) => b.idf - a.idf);
  const bridgeM = hop
    .slice(0, 5)
    .map((h) => (/\s/.test(h.term) ? `"${h.term.replace(/"/g, " ")}"` : quoteFts(h.term)))
    .join(" OR ");
  if (bridgeM) add(l3Match(bridgeM, 30, sessionID), 0.8);

  // v6.0 — coverage rerank. Rank fusion rewards "contains many query words";
  // the evidence we need is "contains *all* the rare ones". A soft-AND over
  // rare terms + exact phrases pulls the one turn that mentions Caroline AND
  // research above twenty turns that only mention Caroline.
  const cand = [...acc.values()];
  const maxFusion = Math.max(1e-9, ...cand.map((c) => c.score));
  const rareBase = qa.rare.length ? qa.rare : qa.terms.slice(0, 4);
  const rare = rareBase.filter((t) => !QUERY_LOW_INFO.has(t));
  if (!rare.length) rare.push(...rareBase.slice(0, 2));
  const phrases = qa.phrases.slice(0, 6);
  // Group-level concept match: a candidate carrying *any* member of a
  // triggered hypernym group ("activities" -> swimming / pottery / camping)
  // gets a fixed vote. Word coverage alone can never reward "swimming with the
  // kids" for "What activities does Melanie partake in?".
  const qGroups = conceptQueryGroups(query);
  for (const c of cand) {
    const txt = c.row.raw_content.toLowerCase();
    let rareHit = 0;
    for (const t of rare) if (txt.includes(t)) rareHit++;
    let termHit = 0;
    for (const t of qa.terms) if (txt.includes(t)) termHit++;
    let phraseHit = 0;
    for (const p of phrases) if (txt.includes(p)) phraseHit++;
    let groupHit = 0;
    if (qGroups.length) {
      const ctags = new Set(conceptTags(c.row.raw_content).split(" ").filter(Boolean));
      for (const set of qGroups) if (set.some((t) => ctags.has(t))) groupHit++;
    }
    const lex =
      0.5 * (rare.length ? rareHit / rare.length : 0) +
      0.2 * (qa.terms.length ? termHit / qa.terms.length : 0) +
      0.15 * (phrases.length ? phraseHit / phrases.length : 0) +
      0.15 * Math.min(1, groupHit);
    c.score = 0.42 * (c.score / maxFusion) + 0.58 * lex;
  }

  // Adjacency runs AFTER coverage rerank so its structural vote is not erased
  // by the lexical rescore. Top-8 direct hits radiate to t±1 (0.85) and t±2
  // (0.55); LoCoMo often golds the setup turn two slots before the answer.
  const ranked = [...acc.values()].sort((a, b) => b.score - a.score);
  for (const c of ranked.slice(0, 8)) {
    const turn = c.row.turn_id;
    if (!turn) continue;
    for (const delta of [-2, -1, 1, 2]) {
      const nb = turnOffset(turn, delta);
      if (!nb) continue;
      const weight = Math.abs(delta) === 1 ? 0.85 : 0.55;
      for (const r of l3BySessionTurn(c.row.session_id, nb, 3)) {
        const v = weight * c.score;
        const cur = acc.get(r.id);
        if (cur) cur.score += v;
        else acc.set(r.id, { row: r, score: v });
      }
    }
  }

  // One row per parent turn: the adapter indexes both the raw turn and its
  // observation summary under the same turn_id. Without this, half of the
  // fusion head is the same evidence twice and the packet loses real slots.
  const seenTurn = new Set<string>();
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
    .filter((c) => {
      const key = c.row.turn_id ?? String(c.row.id);
      if (seenTurn.has(key)) return false;
      seenTurn.add(key);
      return true;
    })
    .slice(0, limit)
    .map((c) => ({ ...c.row, score: c.score }));
}

/**
 * v7.1 — entity-bridge retrieval (multi-hop).
 *
 * The second evidence of a multi-hop question ("what did Caroline research?" ->
 * "adoption agencies" -> "which agency did she contact?") shares almost no
 * words with the question. It does share entities with the *first* evidence.
 * So: search, harvest rare entities from the head, search again, fuse by rank.
 * One extra FTS pass, no model, no tokens.
 */
export function l3SearchExpanded(
  query: string,
  limit = 50,
  sessionID?: string,
  weight = 0.5,
): Array<L3Row & { score: number }> {
  const base = l3SearchHybrid(query, limit, sessionID);
  if (base.length < 2) return base;
  const ents: string[] = [];
  for (const r of base.slice(0, 3)) {
    for (const e of haloEntities(String(r.raw_content ?? ""), 8)) {
      if (!ents.includes(e)) ents.push(e);
    }
  }
  if (ents.length < 2) return base;
  const prf = l3SearchHybrid(`${query} ${ents.slice(0, 8).join(" ")}`, limit, sessionID);
  if (!prf.length) return base;

  const acc = new Map<string, { row: L3Row; score: number }>();
  const keyOf = (r: L3Row) => r.turn_id ?? String(r.id);
  base.forEach((r, i) => {
    const k = keyOf(r);
    if (!acc.has(k)) acc.set(k, { row: r, score: 1 / (FUSION_K + i + 1) });
  });
  prf.forEach((r, i) => {
    const k = keyOf(r);
    const v = weight / (FUSION_K + i + 1);
    const cur = acc.get(k);
    if (cur) cur.score += v;
    else acc.set(k, { row: r, score: v });
  });
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
    .slice(0, limit)
    .map((c) => ({ ...c.row, score: c.score }));
}
export function l3SearchTrigram(needle: string, limit = 20): Array<L3Row & { score: number }> {
  const term = String(needle ?? "").replace(/["*]/g, " ").trim();
  if (term.length < 3) return [];
  try {
    return q(
      `SELECT v.*, bm25(l3_fts_tri) AS score FROM l3_fts_tri
         JOIN l3_verbatim_vault v ON v.id = l3_fts_tri.rowid
        WHERE l3_fts_tri MATCH ?
        ORDER BY score LIMIT ?`,
      `"${term}"`,
      limit,
    );
  } catch {
    return [];
  }
}

export function l3Recent(limit = 30, sessionID?: string): L3Row[] {
  return sessionID
    ? q<L3Row>(
        `SELECT * FROM l3_verbatim_vault WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
        sessionID,
        limit,
      )
    : q<L3Row>(`SELECT * FROM l3_verbatim_vault ORDER BY id DESC LIMIT ?`, limit);
}

/** Everything this session did, oldest first — channel 3 reads this. */
export function l3ForSession(sessionID: string, limit = 200): L3Row[] {
  return q<L3Row>(
    `SELECT * FROM l3_verbatim_vault WHERE session_id = ? ORDER BY id ASC LIMIT ?`,
    sessionID,
    limit,
  );
}

/** The project story: every row tagged with that project, oldest first. */
export function l3ForProject(projectName: string, limit = 60): L3Row[] {
  return q<L3Row>(
    `SELECT * FROM l3_verbatim_vault WHERE project_name = ? ORDER BY id ASC LIMIT ?`,
    projectKey(projectName),
    limit,
  );
}

export function l3Count(): number {
  return q1<{ n: number }>(`SELECT COUNT(*) AS n FROM l3_verbatim_vault`)?.n ?? 0;
}

/** Turn free text into an FTS5 MATCH expression of OR'd quoted terms. */
export function ftsQuery(text: string): string {
  const toks = String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 18);
  if (!toks.length) return "";
  return toks.map((t) => `"${t}"`).join(" OR ");
}

// ------------------------------------------------- bi-temporal graph (L2)

export interface Edge {
  id: number;
  scope: string;
  category: string;
  subject: string;
  predicate: string;
  object: string;
  aaak_text: string | null;
  confidence: number;
  stability: number;
  access_count: number;
  valid_from: number;
  valid_until: number | null;
  superseded_by: number | null;
  last_accessed_at: number | null;
  created_at: number;
  meta_json: string | null;
  vec: unknown;
  simhash_signature: string | null;
}

/**
 * Bi-temporal write. If an ACTIVE edge exists for (scope, subject, predicate):
 *   - same object  -> reinforce it (confidence up, stability up)
 *   - new object   -> close the old edge (valid_until = now) and open a new one
 * This is what makes "I used to prefer X, now I prefer Y" answerable forever.
 */
export function assertEdge(e: {
  scope: string;
  category: string;
  subject: string;
  predicate: string;
  object: string;
  aaak: string;
  confidence?: number;
  now?: number;
  meta?: unknown;
}): { id: number; superseded: number | null; reinforced: boolean } | null {
  const now = e.now ?? Date.now();
  const conf = clamp01(e.confidence ?? 0.6);

  return tx(() => {
    const existing = q<Edge>(
      `SELECT * FROM l2_temporal_graph
        WHERE scope = ? AND subject = ? AND predicate = ? AND valid_until IS NULL
        ORDER BY id DESC LIMIT 1`,
      e.scope,
      e.subject,
      e.predicate,
    )[0];

    if (existing && norm(existing.object) === norm(e.object)) {
      run(
        `UPDATE l2_temporal_graph
            SET confidence = MIN(1.0, confidence + 0.05),
                stability  = stability + 0.25,
                access_count = access_count + 1,
                aaak_text = ?,
                last_accessed_at = ?
          WHERE id = ?`,
        e.aaak,
        now,
        existing.id,
      );
      return { id: existing.id, superseded: null, reinforced: true };
    }

    const newId = run(
      `INSERT INTO l2_temporal_graph
         (scope, category, subject, predicate, object, aaak_text,
          confidence, stability, access_count, valid_from, valid_until,
          created_at, meta_json, vec, simhash_signature)
       VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,?,?,?)`,
      e.scope,
      e.category,
      e.subject,
      e.predicate,
      e.object,
      e.aaak,
      conf,
      1.0,
      now,
      now,
      e.meta ? JSON.stringify(e.meta).slice(0, 4000) : null,
      vecToBlob(embed(`${e.subject} ${e.predicate} ${e.object} ${e.aaak}`)),
      simhashToHex(simhash384(`${e.subject} ${e.object}`)),
    );
    if (!newId) return null;

    if (existing) {
      run(
        `UPDATE l2_temporal_graph
            SET valid_until = ?, superseded_by = ?, last_accessed_at = ?
          WHERE id = ?`,
        now,
        newId,
        now,
        existing.id,
      );
    }
    return { id: newId, superseded: existing?.id ?? null, reinforced: false };
  });
}

/**
 * "I dropped X for Y": close every active edge in these scopes whose object
 * looks like `objectText`, without guessing which slot it lived in. Returns
 * the ids that were closed.
 */
export function expireEdgesByObject(
  scopes: string[],
  objectText: string,
  now = Date.now(),
  supersededBy: number | null = null,
): number[] {
  const target = norm(objectText);
  if (!target || target.length < 2) return [];
  const pool = q<Edge>(
    `SELECT * FROM l2_temporal_graph WHERE valid_until IS NULL AND scope IN (${scopes.map(() => "?").join(",")})`,
    ...scopes,
  );
  const closed: number[] = [];
  for (const e of pool) {
    const o = norm(e.object);
    if (o === target || o.includes(target) || target.includes(o)) {
      run(
        `UPDATE l2_temporal_graph SET valid_until = ?, superseded_by = COALESCE(?, superseded_by)
          WHERE id = ?`,
        now,
        supersededBy,
        e.id,
      );
      closed.push(e.id);
    }
  }
  return closed;
}

/** Point closed edges at the edge that replaced them. */
export function setSupersededBy(ids: number[], supersededBy: number | null): void {
  for (const id of ids) {
    run(`UPDATE l2_temporal_graph SET superseded_by = ? WHERE id = ? AND valid_until IS NOT NULL`, supersededBy, id);
  }
}

/** Currently-true edges for a scope (global + project, project wins on ties). */
export function liveEdges(scope: string, category?: string): Edge[] {
  const scopes = scope === "global" ? ["global"] : ["global", scope];
  const ph = scopes.map(() => "?").join(",");
  const args: any[] = [...scopes];
  let sql = `SELECT * FROM l2_temporal_graph WHERE valid_until IS NULL AND scope IN (${ph})`;
  if (category) {
    sql += ` AND category = ?`;
    args.push(category);
  }
  sql += ` ORDER BY confidence DESC, stability DESC, id DESC`;
  return q<Edge>(sql, ...args);
}

/** Full history of one subject+predicate, newest first — including expired. */
export function edgeHistory(scope: string, subject?: string, predicate?: string): Edge[] {
  const scopes = scope === "global" ? ["global"] : ["global", scope];
  const ph = scopes.map(() => "?").join(",");
  const args: any[] = [...scopes];
  let sql = `SELECT * FROM l2_temporal_graph WHERE scope IN (${ph})`;
  if (subject) {
    sql += ` AND subject = ?`;
    args.push(subject);
  }
  if (predicate) {
    sql += ` AND predicate = ?`;
    args.push(predicate);
  }
  sql += ` ORDER BY valid_from DESC, id DESC LIMIT 200`;
  return q<Edge>(sql, ...args);
}

/** BM25 search over the graph — active or expired, the caller decides. */
/**
 * v4.1 — live edges for one subject (uses idx_l2_sp). Powers the ±1 dialogue
 * turn window expansion in the retriever.
 */
export function edgesBySubject(scope: string, subject: string, limit = 8): Edge[] {
  if (!scope || !subject) return [];
  try {
    return q<Edge>(
      `SELECT * FROM l2_temporal_graph
        WHERE scope = ? AND subject = ? AND valid_until IS NULL
        ORDER BY confidence DESC, id DESC LIMIT ?`,
      scope,
      subject,
      limit,
    );
  } catch {
    return [];
  }
}

export function l2SearchBm25(match: string, limit = 30): Array<Edge & { score: number }> {
  return l2SearchRaw(ftsQuery(match), limit);
}

/** v5.0 — raw FTS5 MATCH over the graph mirror. */
export function l2SearchRaw(match: string, limit = 30): Array<Edge & { score: number }> {
  const m = String(match ?? "").trim();
  if (!m) return [];
  try {
    return q(
      `SELECT g.*, bm25(l2_fts) AS score FROM l2_fts
         JOIN l2_temporal_graph g ON g.id = l2_fts.rowid
        WHERE l2_fts MATCH ?
        ORDER BY score LIMIT ?`,
      m,
      limit,
    );
  } catch {
    return [];
  }
}

/**
 * v5.0 — APEX query builder for the graph: soft-quorum BM25 instead of one
 * blunt OR. Passes: rare bigram phrases (precision) → high-IDF terms → all
 * content terms (recall floor), fused by RRF. Question words and stop-words
 * never reach the MATCH expression; prefix wildcards ride along via quoteFts.
 */
export function l2SearchApex(query: string, limit = 60): Array<Edge & { score: number }> {
  const qa = analyzeQuery(query);
  if (!qa.terms.length) return l2SearchBm25(query, limit);
  const acc = new Map<number, { row: Edge & { score: number }; score: number }>();
  const add = (rows: Array<Edge & { score: number }>, weight: number): void => {
    rows.forEach((r, i) => {
      const v = weight / (FUSION_K + i + 1);
      const cur = acc.get(r.id);
      if (cur) cur.score += v;
      else acc.set(r.id, { row: r, score: v });
    });
  };
  const phraseM = ftsMatchOf(qa, { phrases: true, terms: false, rare: false });
  const rareM = ftsMatchOf(qa, { rare: true });
  const termM = ftsMatchOf(qa, { terms: true });
  if (phraseM) add(l2SearchRaw(phraseM, 60), 1.15);
  if (rareM) add(l2SearchRaw(rareM, 60), 1.0);
  if (termM && termM !== rareM) add(l2SearchRaw(termM, 60), 0.55);
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
    .slice(0, limit)
    .map((c) => ({ ...c.row, score: c.score }));
}

export function touchEdges(ids: number[]): void {
  if (!ids.length) return;
  const now = Date.now();
  for (const id of ids) {
    run(
      `UPDATE l2_temporal_graph
          SET access_count = access_count + 1, last_accessed_at = ?, stability = stability + 0.1
        WHERE id = ?`,
      now,
      id,
    );
  }
}

/** FSRS-ish consolidation sweep, run when the session goes idle. */
export function consolidate(now = Date.now()): { decayed: number; pruned: number } {
  const thirtyDays = 30 * 24 * 3600 * 1000;
  const decayed = run(
    `UPDATE l2_temporal_graph
        SET stability = MAX(0.2, stability * (
              CASE WHEN last_accessed_at IS NULL THEN 0.9 ELSE 1.02 END))
      WHERE valid_until IS NULL AND (? - created_at) > ?`,
    now,
    thirtyDays,
  );
  // never delete: low-confidence dead edges are retained but lose weight,
  // because "why did I stop using X?" needs them.
  const pruned = run(
    `UPDATE l2_temporal_graph
        SET confidence = MAX(0.05, confidence * 0.9)
      WHERE valid_until IS NOT NULL AND confidence > 0.05 AND (? - valid_until) > ?`,
    now,
    thirtyDays,
  );
  return { decayed, pruned };
}

// ------------------------------------------- episodic projects (L2 story)

export type ProjectStatus = "active" | "paused" | "completed";

export interface ProjectRow {
  project_name: string;
  project_path: string | null;
  summary_aaak: string | null;
  current_focus: string | null;
  open_loops_json: string | null;
  last_milestone: string | null;
  last_active_at: number;
  interaction_count: number;
  status: ProjectStatus;
}

export function getProject(name: string): ProjectRow | null {
  const key = projectKey(name);
  if (!key) return null;
  return q1<ProjectRow>(`SELECT * FROM l2_episodic_projects WHERE project_name = ?`, key);
}

export function openLoops(name: string): string[] {
  const row = getProject(name);
  return parseLoops(row?.open_loops_json);
}

function parseLoops(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * Create or update a project's slice of episodic memory. Only the fields you
 * pass are written; everything else is preserved (`??` = leave alone).
 */
export function upsertProject(e: {
  name: string;
  path?: string | null;
  summary?: string | null;
  focus?: string | null;
  milestone?: string | null;
  status?: ProjectStatus;
  touch?: boolean;
  now?: number;
}): void {
  const key = projectKey(e.name);
  if (!key) return;
  const now = e.now ?? Date.now();
  run(
    `INSERT INTO l2_episodic_projects
       (project_name, project_path, summary_aaak, current_focus, open_loops_json,
        last_milestone, last_active_at, interaction_count, status)
     VALUES (?,?,?,?,NULL,?,?,?,?)
     ON CONFLICT(project_name) DO UPDATE SET
       project_path    = COALESCE(excluded.project_path, l2_episodic_projects.project_path),
       summary_aaak    = COALESCE(excluded.summary_aaak, l2_episodic_projects.summary_aaak),
       current_focus   = COALESCE(excluded.current_focus, l2_episodic_projects.current_focus),
       last_milestone  = COALESCE(excluded.last_milestone, l2_episodic_projects.last_milestone),
       last_active_at  = MAX(excluded.last_active_at, l2_episodic_projects.last_active_at),
       interaction_count = l2_episodic_projects.interaction_count + excluded.interaction_count,
       status = CASE WHEN excluded.status = 'active' THEN 'active' ELSE l2_episodic_projects.status END`,
    key,
    e.path ?? null,
    e.summary ?? null,
    e.focus ?? null,
    e.milestone ?? null,
    e.touch === false ? 0 : now,
    e.touch === false ? 0 : 1,
    e.status ?? "active",
  );
}

export function setFocus(name: string, focus: string, now = Date.now()): void {
  const key = projectKey(name);
  if (!key || !focus) return;
  upsertProject({ name: key, focus, now });
}

export function setMilestone(name: string, milestone: string, now = Date.now()): void {
  const key = projectKey(name);
  if (!key || !milestone) return;
  upsertProject({ name: key, milestone, now });
}

export function setProjectStatus(name: string, status: ProjectStatus, now = Date.now()): void {
  const key = projectKey(name);
  if (!key) return;
  run(
    `UPDATE l2_episodic_projects SET status = ?, last_active_at = MAX(last_active_at, ?)
      WHERE project_name = ?`,
    status,
    now,
    key,
  );
}

/** Add an open loop, ignoring near-duplicates of one we already track. */
export function addOpenLoop(name: string, loop: string, now = Date.now()): boolean {
  const key = projectKey(name);
  const text = String(loop ?? "").replace(/\s+/g, " ").trim();
  if (!key || text.length < 3) return false;
  const loops = openLoops(key);
  const low = text.toLowerCase();
  for (const l of loops) {
    const ll = l.toLowerCase();
    if (ll === low || ll.includes(low) || low.includes(ll)) {
      upsertProject({ name: key, now, touch: true });
      return false;
    }
  }
  const next = [...loops, text.slice(0, 120)].slice(-5);
  run(
    `UPDATE l2_episodic_projects SET open_loops_json = ?, last_active_at = MAX(last_active_at, ?)
      WHERE project_name = ?`,
    JSON.stringify(next),
    now,
    key,
  );
  return true;
}

/** Drop open loops that the milestone clearly resolved (shared vocabulary). */
export function closeOpenLoops(name: string, done: string, now = Date.now()): string[] {
  const key = projectKey(name);
  if (!key) return [];
  const loops = openLoops(key);
  if (!loops.length) return [];
  const doneTokens = new Set(tokens(done));
  if (!doneTokens.size) return [];
  const closed: string[] = [];
  const kept: string[] = [];
  for (const l of loops) {
    let shared = 0;
    for (const t of tokens(l)) if (doneTokens.has(t)) shared++;
    if (shared >= 2) closed.push(l);
    else kept.push(l);
  }
  if (!closed.length) return [];
  run(
    `UPDATE l2_episodic_projects SET open_loops_json = ?, last_active_at = MAX(last_active_at, ?)
      WHERE project_name = ?`,
    JSON.stringify(kept),
    now,
    key,
  );
  return closed;
}

/** Projects to put in the PULSE: active first, most recent first. */
export function recentProjects(limit = 4): ProjectRow[] {
  return q<ProjectRow>(
    `SELECT * FROM l2_episodic_projects
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, last_active_at DESC
      LIMIT ?`,
    limit,
  );
}

/** The project a directory belongs to (exact or parent path). */
export function projectForPath(dir: string | null | undefined): ProjectRow | null {
  const d = String(dir ?? "").replace(/\/+$/, "");
  if (!d) return null;
  const exact = q1<ProjectRow>(`SELECT * FROM l2_episodic_projects WHERE project_path = ?`, d);
  if (exact) return exact;
  try {
    return q1<ProjectRow>(
      `SELECT * FROM l2_episodic_projects
        WHERE project_path IS NOT NULL AND project_path <> '' AND (? LIKE project_path || '/%')
        ORDER BY LENGTH(project_path) DESC LIMIT 1`,
      d,
    );
  } catch {
    return null;
  }
}

/** Just the names — used to spot a known project mentioned in free text. */
export function knownProjectNames(): string[] {
  return q<{ project_name: string }>(`SELECT project_name FROM l2_episodic_projects`).map(
    (r) => r.project_name,
  );
}

// ================================================== v3 procedural cortex
//
// Three v3 tables, one idea: the cerebellum learns from executing, not from
// being told. An ENGRAM is a lesson (avoid X, do Y). An INTERCEPTOR is a
// lesson promoted to the tool.execute.before layer — it rewrites commands
// with 0 context tokens. A MACRO is a proven command sequence crystallized
// into one script. All three are deterministic SQL; no model is involved.
// ==================================================

export interface ProceduralEngram {
  id: number;
  engram_key: string;
  scope: string;
  trigger_intent: string;
  trigger_simhash: string | null;
  anti_pattern_aaak: string | null;
  fast_path_aaak: string;
  macro_id: string | null;
  maturity: number;
  token_saved_estimate: number;
  success_rate: number;
  last_fired_at: number | null;
  valid_until: number | null;
}

/**
 * Write a reflex. Same engram_key -> reinforce (maturity +1, Bayesian success
 * rate up), so Hebbian learning is a fact of the schema, not a convention.
 * A retired (valid_until set) engram with the same key is revived: knowledge
 * that became true again is alive again.
 */
export function upsertEngram(e: {
  engramKey: string;
  scope: string;
  trigger: string;
  anti?: string | null;
  fastPath: string;
  macroId?: string | null;
  tokenSaved?: number;
  now?: number;
}): { id: number; reinforced: boolean; maturity: number } | null {
  const now = e.now ?? Date.now();
  const sig = triggerSignature(e.trigger);
  return tx(() => {
    const existing = q1<ProceduralEngram>(
      `SELECT * FROM l2_procedural_engrams WHERE engram_key = ?`,
      e.engramKey,
    );
    if (existing) {
      const maturity = existing.maturity + 1;
      const rate = Math.min(1, round3((existing.success_rate * existing.maturity + 1) / Math.max(1, maturity)));
      run(
        `UPDATE l2_procedural_engrams
            SET maturity = ?, success_rate = ?, last_fired_at = ?,
                token_saved_estimate = token_saved_estimate + ?,
                trigger_intent = ?, trigger_simhash = ?,
                anti_pattern_aaak = COALESCE(?, anti_pattern_aaak),
                fast_path_aaak = ?, macro_id = COALESCE(?, macro_id),
                valid_until = NULL
          WHERE id = ?`,
        maturity,
        rate,
        now,
        Math.max(0, e.tokenSaved ?? 0),
        e.trigger,
        sig,
        e.anti ?? null,
        e.fastPath,
        e.macroId ?? null,
        existing.id,
      );
      return { id: existing.id, reinforced: true, maturity };
    }
    const id = run(
      `INSERT INTO l2_procedural_engrams
         (engram_key, scope, trigger_intent, trigger_simhash, anti_pattern_aaak,
          fast_path_aaak, macro_id, maturity, token_saved_estimate, success_rate, last_fired_at, valid_until)
       VALUES (?,?,?,?,?,?,?,1,?,?,?,NULL)`,
      e.engramKey,
      e.scope,
      e.trigger,
      sig,
      e.anti ?? null,
      e.fastPath,
      e.macroId ?? null,
      Math.max(0, e.tokenSaved ?? 0),
      0.6,
      now,
    );
    if (!id) return null;
    return { id, reinforced: false, maturity: 1 };
  });
}

/** Live engrams reachable from any of these scopes (global always included). */
export function engramsLive(scopes: string[], limit = 20): ProceduralEngram[] {
  const list = (scopes ?? []).filter(Boolean);
  const ph = list.map(() => "?").join(",");
  const where = list.length ? `(scope IN (${ph}) OR scope = 'global')` : `scope = 'global'`;
  return q<ProceduralEngram>(
    `SELECT * FROM l2_procedural_engrams
      WHERE valid_until IS NULL AND ${where}
      ORDER BY maturity DESC, success_rate DESC, id DESC LIMIT ?`,
    ...list,
    limit,
  );
}

/** BM25 over trigger / avoid / fast-path text. */
export function engramsBm25(match: string, limit = 30): Array<ProceduralEngram & { score: number }> {
  const m = ftsQuery(match);
  if (!m) return [];
  try {
    return q(
      `SELECT e.*, bm25(l2_engram_fts) AS score FROM l2_engram_fts
         JOIN l2_procedural_engrams e ON e.id = l2_engram_fts.rowid
        WHERE l2_engram_fts MATCH ?
        ORDER BY score LIMIT ?`,
      m,
      limit,
    );
  } catch {
    return [];
  }
}

export function engramById(id: number): ProceduralEngram | null {
  return q1<ProceduralEngram>(`SELECT * FROM l2_procedural_engrams WHERE id = ?`, id);
}

/** Mark an engram as just-used (JIT injection or macro firing). */
export function fireEngram(id: number, now = Date.now()): void {
  run(`UPDATE l2_procedural_engrams SET last_fired_at = ? WHERE id = ?`, now, id);
}

/** After a Hebbian merge: the survivor absorbs the retired siblings. */
export function updateEngramMerged(
  id: number,
  merged: { anti?: string | null; fastPath?: string; maturity?: number },
  now = Date.now(),
): void {
  run(
    `UPDATE l2_procedural_engrams
        SET anti_pattern_aaak = COALESCE(?, anti_pattern_aaak),
            fast_path_aaak    = COALESCE(?, fast_path_aaak),
            maturity          = COALESCE(?, maturity),
            last_fired_at     = ?
      WHERE id = ?`,
    merged.anti ?? null,
    merged.fastPath ?? null,
    merged.maturity ?? null,
    now,
    id,
  );
}

/** Retire engrams whose lesson has been absorbed — the brain shrinks. */
export function retireEngrams(ids: number[], now = Date.now()): void {
  for (const id of ids) {
    run(`UPDATE l2_procedural_engrams SET valid_until = ? WHERE id = ? AND valid_until IS NULL`, now, id);
  }
}

/** The sharpest live reflexes, best first — for reflex-mode reporting. */
export function topEngrams(limit = 3): ProceduralEngram[] {
  return q<ProceduralEngram>(
    `SELECT * FROM l2_procedural_engrams
      WHERE valid_until IS NULL
      ORDER BY maturity DESC, success_rate DESC, id DESC LIMIT ?`,
    limit,
  );
}

export function engramStats(): {
  total: number;
  live: number;
  matured: number;
  tokensSaved: number;
} {
  const row = q1<{ total: number; live: number; matured: number; saved: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN valid_until IS NULL AND maturity >= 4 THEN 1 ELSE 0 END) AS matured,
            COALESCE(SUM(token_saved_estimate), 0) AS saved
       FROM l2_procedural_engrams`,
  );
  return {
    total: Number(row?.total ?? 0),
    live: Number(row?.live ?? 0),
    matured: Number(row?.matured ?? 0),
    tokensSaved: Number(row?.saved ?? 0),
  };
}

// ------------------------------------------------- subconscious interceptors

export interface Interceptor {
  id: number;
  scope: string;
  tool_name: string;
  match_pattern: string;
  replacement_action: "rewrite_arg" | "append_flag" | "inject_env";
  replacement_payload: string;
  confidence: number;
  hit_count: number;
  active: number;
}

/**
 * One empirical proof that a rule is right (a failure->fix pair directly
 * demonstrated the rewrite). Confidence rises Bayesian; activation needs
 * confidence >= 0.90 AND hit_count >= 2 — one fluke never rewrites commands.
 */
export function recordInterceptorProof(e: {
  scope: string;
  toolName: string;
  pattern: string;
  action: Interceptor["replacement_action"];
  payload: string;
  now?: number;
}): { id: number; confidence: number; hitCount: number; active: boolean } | null {
  return tx(() => {
    const existing = q1<Interceptor>(
      `SELECT * FROM l2_subconscious_interceptors WHERE scope = ? AND tool_name = ? AND match_pattern = ?`,
      e.scope,
      e.toolName,
      e.pattern,
    );
    if (existing) {
      const confidence = round3(existing.confidence + (1 - existing.confidence) * 0.5);
      const hitCount = existing.hit_count + 1;
      const active = confidence >= 0.9 && hitCount >= 2 ? 1 : existing.active;
      run(
        `UPDATE l2_subconscious_interceptors
            SET confidence = ?, hit_count = ?, active = ?,
                replacement_action = ?, replacement_payload = ?
          WHERE id = ?`,
        confidence,
        hitCount,
        active,
        e.action,
        e.payload,
        existing.id,
      );
      return { id: existing.id, confidence, hitCount, active: active === 1 };
    }
    const id = run(
      `INSERT INTO l2_subconscious_interceptors
         (scope, tool_name, match_pattern, replacement_action, replacement_payload, confidence, hit_count, active)
       VALUES (?,?,?,?,?,0.6,1,0)`,
      e.scope,
      e.toolName,
      e.pattern,
      e.action,
      e.payload,
    );
    if (!id) return null;
    return { id, confidence: 0.6, hitCount: 1, active: false };
  });
}

/** Rules cleared to fire, for this tool family, in any reachable scope. */
export function activeInterceptors(scopes: string[], toolName: string): Interceptor[] {
  const list = (scopes ?? []).filter(Boolean);
  const ph = list.map(() => "?").join(",");
  const scopeClause = list.length ? `(scope = 'global' OR scope IN (${ph}))` : `scope = 'global'`;
  return q<Interceptor>(
    `SELECT * FROM l2_subconscious_interceptors
      WHERE active = 1 AND tool_name = ? AND ${scopeClause}
      ORDER BY confidence DESC, hit_count DESC LIMIT 40`,
    toolName,
    ...list,
  );
}

/** An interception actually fired at runtime. */
export function bumpInterceptorHit(id: number): void {
  run(`UPDATE l2_subconscious_interceptors SET hit_count = hit_count + 1 WHERE id = ?`, id);
}

export function interceptorRows(limit = 20): Interceptor[] {
  return q<Interceptor>(
    `SELECT * FROM l2_subconscious_interceptors ORDER BY confidence DESC, hit_count DESC LIMIT ?`,
    limit,
  );
}

export function interceptorStats(): { total: number; active: number; hits: number } {
  const row = q1<{ total: number; active: number; hits: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(hit_count), 0) AS hits
       FROM l2_subconscious_interceptors`,
  );
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    hits: Number(row?.hits ?? 0),
  };
}

// --------------------------------------------------------- executable macros

export interface Macro {
  macro_id: string;
  scope: string;
  description_aaak: string | null;
  command_sequence_json: string;
  avg_duration_ms: number;
  usage_count: number;
  last_used_at: number | null;
}

export function upsertMacro(e: {
  macroId: string;
  scope: string;
  description?: string | null;
  commands: string[];
  durationMs?: number;
  now?: number;
}): { created: boolean; usage: number; avgMs: number } | null {
  const now = e.now ?? Date.now();
  const ms = Math.max(0, Math.round(e.durationMs ?? 0));
  const json = JSON.stringify(e.commands.slice(0, 6));
  return tx(() => {
    const existing = q1<Macro>(`SELECT * FROM l2_executable_macros WHERE macro_id = ?`, e.macroId);
    if (existing) {
      const usage = existing.usage_count + 1;
      const avgMs = Math.round((existing.avg_duration_ms * existing.usage_count + ms) / Math.max(1, usage));
      run(
        `UPDATE l2_executable_macros
            SET usage_count = ?, avg_duration_ms = ?, last_used_at = ?,
                description_aaak = COALESCE(?, description_aaak),
                command_sequence_json = ?
          WHERE macro_id = ?`,
        usage,
        avgMs,
        now,
        e.description ?? null,
        json,
        e.macroId,
      );
      return { created: false, usage, avgMs };
    }
    const ok = run(
      `INSERT INTO l2_executable_macros
         (macro_id, scope, description_aaak, command_sequence_json, avg_duration_ms, usage_count, last_used_at)
       VALUES (?,?,?,?,?,1,?)`,
      e.macroId,
      e.scope,
      e.description ?? null,
      json,
      ms,
      now,
    );
    if (!ok) return null;
    return { created: true, usage: 1, avgMs: ms };
  });
}

export function getMacro(id: string): Macro | null {
  return q1<Macro>(`SELECT * FROM l2_executable_macros WHERE macro_id = ?`, id);
}

export function macroList(scope?: string, limit = 12): Macro[] {
  if (scope) {
    return q<Macro>(
      `SELECT * FROM l2_executable_macros WHERE scope = ? OR scope = 'global'
        ORDER BY usage_count DESC, last_used_at DESC LIMIT ?`,
      scope,
      limit,
    );
  }
  return q<Macro>(
    `SELECT * FROM l2_executable_macros ORDER BY usage_count DESC, last_used_at DESC LIMIT ?`,
    limit,
  );
}

export function bumpMacroUse(id: string, now = Date.now()): Macro | null {
  const m = getMacro(id);
  if (!m) return null;
  run(
    `UPDATE l2_executable_macros SET usage_count = usage_count + 1, last_used_at = ? WHERE macro_id = ?`,
    now,
    id,
  );
  return { ...m, usage_count: m.usage_count + 1, last_used_at: now };
}

export function macroStats(): { count: number; uses: number } {
  const row = q1<{ count: number; uses: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(usage_count), 0) AS uses FROM l2_executable_macros`,
  );
  return { count: Number(row?.count ?? 0), uses: Number(row?.uses ?? 0) };
}

/** Commands of a macro, parsed; [] when the row is malformed. */
export function macroCommands(m: Macro | null): string[] {
  if (!m) return [];
  try {
    const v = JSON.parse(m.command_sequence_json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------- L1

export function l1MarkKey(sessionID: string, memoryKey: string, kind: "injected" | "seen"): void {
  run(
    `INSERT OR REPLACE INTO l1_session_working_set (session_id, memory_key, kind, injected_at)
     VALUES (?,?,?,?)`,
    sessionID,
    memoryKey,
    kind,
    Date.now(),
  );
}

/** Back-compat: an edge id becomes the key `edge:<id>`. */
export function l1Mark(sessionID: string, memoryID: number, kind: "injected" | "seen"): void {
  l1MarkKey(sessionID, `edge:${memoryID}`, kind);
}

export function l1HasKey(sessionID: string, memoryKey: string): boolean {
  return !!q1(
    `SELECT 1 AS x FROM l1_session_working_set WHERE session_id = ? AND memory_key = ?`,
    sessionID,
    memoryKey,
  );
}

export function l1Keys(sessionID: string): Set<string> {
  const rows = q<{ memory_key: string }>(
    `SELECT memory_key FROM l1_session_working_set WHERE session_id = ?`,
    sessionID,
  );
  return new Set(rows.map((r) => r.memory_key));
}

export function l1Clear(sessionID: string): void {
  run(`DELETE FROM l1_session_working_set WHERE session_id = ?`, sessionID);
}

// -------------------------------------------------------------------- L0

/** Freeze this session's AAAK snapshot — the prompt-cache contract. */
export function snapshotSet(e: {
  sessionID: string;
  dna: string;
  pulse: string;
  scope: string;
  now?: number;
}): void {
  run(
    `INSERT OR REPLACE INTO l0_snapshots
       (session_id, frozen_dna_aaak, frozen_pulse_aaak, scope, created_at)
     VALUES (?,?,?,?,?)`,
    e.sessionID,
    e.dna,
    e.pulse,
    e.scope,
    e.now ?? Date.now(),
  );
}

export function snapshotGet(
  sessionID: string,
): { session_id: string; frozen_dna_aaak: string; frozen_pulse_aaak: string; scope: string | null; created_at: number } | null {
  return q1(
    `SELECT * FROM l0_snapshots WHERE session_id = ?`,
    sessionID,
  );
}

// ===========================================================================
// v4 — PGA (project genomes) + Token-Darwin ledger. The db layer stays dumb:
// genome.ts builds and darwin.ts audits; everything here is plain CRUD.
// ===========================================================================

export interface GenomeRow {
  project_name: string;
  project_path: string | null;
  file_count: number;
  c1_arch_dna_aaak: string;
  c2_dep_graph_aaak: string;
  c3_patterns_aaak: string;
  c4_semantic_index_aaak: string;
  c5_evolution_mem_aaak: string;
  total_genome_tokens: number;
  last_synthesized_at: number | null;
  last_nightly_audit_at: number | null;
}

/** Full write of one project genome (initial build / re-synthesis). */
export function genomeUpsert(e: {
  projectName: string;
  projectPath?: string | null;
  fileCount?: number;
  c1?: string;
  c2?: string;
  c3?: string;
  c4?: string;
  c5?: string;
  totalTokens: number;
  synthesizedAt?: number | null;
}): void {
  run(
    `INSERT INTO pga_project_genomes
       (project_name, project_path, file_count, c1_arch_dna_aaak, c2_dep_graph_aaak,
        c3_patterns_aaak, c4_semantic_index_aaak, c5_evolution_mem_aaak,
        total_genome_tokens, last_synthesized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_name) DO UPDATE SET
       project_path = excluded.project_path,
       file_count = excluded.file_count,
       c1_arch_dna_aaak = excluded.c1_arch_dna_aaak,
       c2_dep_graph_aaak = excluded.c2_dep_graph_aaak,
       c3_patterns_aaak = excluded.c3_patterns_aaak,
       c4_semantic_index_aaak = excluded.c4_semantic_index_aaak,
       c5_evolution_mem_aaak = excluded.c5_evolution_mem_aaak,
       total_genome_tokens = excluded.total_genome_tokens,
       last_synthesized_at = excluded.last_synthesized_at`,
    e.projectName,
    e.projectPath ?? null,
    e.fileCount ?? 0,
    e.c1 ?? "",
    e.c2 ?? "",
    e.c3 ?? "",
    e.c4 ?? "",
    e.c5 ?? "",
    e.totalTokens,
    e.synthesizedAt ?? Date.now(),
  );
}

export function genomeGet(projectName: string): GenomeRow | null {
  return q1<GenomeRow>(`SELECT * FROM pga_project_genomes WHERE project_name = ?`, projectName);
}

export function genomesAll(limit = 50): GenomeRow[] {
  return q<GenomeRow>(
    `SELECT * FROM pga_project_genomes ORDER BY last_synthesized_at DESC LIMIT ?`,
    limit,
  );
}

export function genomeTouchAudit(projectName: string, now = Date.now()): void {
  run(`UPDATE pga_project_genomes SET last_nightly_audit_at = ? WHERE project_name = ?`, now, projectName);
}

// ---------------------------------------------------------------- C2 edges

export interface DepEdgeRow {
  project_name: string;
  source_file: string;
  target_file: string;
  import_symbols: string | null;
  centrality_score: number;
  last_updated_at: number;
}

export function depEdgesReplace(
  projectName: string,
  edges: Array<{ source: string; target: string; symbols?: string | null; centrality?: number }>,
  now = Date.now(),
): void {
  tx(() => {
    run(`DELETE FROM pga_c2_dependency_edges WHERE project_name = ?`, projectName);
    for (const e of edges.slice(0, 4000)) {
      run(
        `INSERT OR REPLACE INTO pga_c2_dependency_edges
           (project_name, source_file, target_file, import_symbols, centrality_score, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        projectName,
        e.source,
        e.target,
        e.symbols ?? null,
        e.centrality ?? 0,
        now,
      );
    }
  });
}

/** Drop the outgoing edges of files that are about to be re-indexed. */
export function depEdgesDeleteForFiles(projectName: string, files: string[]): void {
  for (const f of files.slice(0, 200)) {
    run(`DELETE FROM pga_c2_dependency_edges WHERE project_name = ? AND source_file = ?`, projectName, f);
  }
}

/** Re-add the outgoing edges of a small set of freshly re-indexed files. */
export function depEdgesAdd(
  projectName: string,
  edges: Array<{ source: string; target: string; symbols?: string | null; centrality?: number }>,
  now = Date.now(),
): void {
  for (const e of edges.slice(0, 500)) {
    run(
      `INSERT OR REPLACE INTO pga_c2_dependency_edges
         (project_name, source_file, target_file, import_symbols, centrality_score, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      projectName,
      e.source,
      e.target,
      e.symbols ?? null,
      e.centrality ?? 0,
      now,
    );
  }
}

export function depEdgesFor(projectName: string, sourceFiles?: string[]): DepEdgeRow[] {
  if (sourceFiles && sourceFiles.length) {
    const marks = sourceFiles.map(() => "?").join(",");
    return q<DepEdgeRow>(
      `SELECT * FROM pga_c2_dependency_edges WHERE project_name = ? AND source_file IN (${marks})`,
      projectName,
      ...sourceFiles,
    );
  }
  return q<DepEdgeRow>(`SELECT * FROM pga_c2_dependency_edges WHERE project_name = ?`, projectName);
}

// ------------------------------------------------------------- C3 patterns

export interface PatternRow {
  pattern_id: string;
  project_name: string;
  task_category: string;
  trigger_keywords: string | null;
  blueprint_aaak: string | null;
  target_files_template: string | null;
  usage_count: number;
  success_count: number;
  success_rate: number;
  avg_tokens_consumed: number;
  baseline_tokens_estimate: number;
  darwin_roi: number;
  last_used_at: number | null;
}

export function patternUpsert(e: {
  patternId: string;
  projectName: string;
  taskCategory: string;
  triggerKeywords?: string;
  blueprintAaak?: string;
  targetFiles?: string[];
  avgTokens?: number;
  baselineTokens?: number;
  reinforce?: boolean;
  now?: number;
}): void {
  const now = e.now ?? Date.now();
  const files = e.targetFiles ? JSON.stringify(e.targetFiles.slice(0, 12)) : null;
  const cur = q1<PatternRow>(`SELECT * FROM pga_c3_pattern_library WHERE pattern_id = ?`, e.patternId);
  if (!cur) {
    run(
      `INSERT INTO pga_c3_pattern_library
         (pattern_id, project_name, task_category, trigger_keywords, blueprint_aaak,
          target_files_template, usage_count, success_count, success_rate,
          avg_tokens_consumed, baseline_tokens_estimate, darwin_roi, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1.0, ?, ?, 1.0, ?)`,
      e.patternId,
      e.projectName,
      e.taskCategory,
      e.triggerKeywords ?? null,
      e.blueprintAaak ?? null,
      files,
      Math.max(50, Math.round(e.avgTokens ?? 450)),
      Math.max(500, Math.round(e.baselineTokens ?? 8000)),
      now,
    );
    return;
  }
  if (!e.reinforce) {
    run(
      `UPDATE pga_c3_pattern_library
          SET blueprint_aaak = COALESCE(?, blueprint_aaak),
              target_files_template = COALESCE(?, target_files_template),
              avg_tokens_consumed = ?,
              last_used_at = ?
        WHERE pattern_id = ?`,
      e.blueprintAaak ?? null,
      files,
      Math.max(50, Math.round(e.avgTokens ?? cur.avg_tokens_consumed)),
      now,
      e.patternId,
    );
    return;
  }
  const usage = cur.usage_count + 1;
  const success = cur.success_count + 1;
  const rate = round3(success / usage);
  const avg = Math.round(
    (cur.avg_tokens_consumed * (usage - 1) + Math.max(50, Math.round(e.avgTokens ?? cur.avg_tokens_consumed))) / usage,
  );
  run(
    `UPDATE pga_c3_pattern_library
        SET usage_count = ?, success_count = ?, success_rate = ?,
            avg_tokens_consumed = ?, blueprint_aaak = COALESCE(?, blueprint_aaak),
            target_files_template = COALESCE(?, target_files_template),
            last_used_at = ?
      WHERE pattern_id = ?`,
    usage,
    success,
    rate,
    avg,
    e.blueprintAaak ?? null,
    files,
    now,
    e.patternId,
  );
}

export function patternGet(patternId: string): PatternRow | null {
  return q1<PatternRow>(`SELECT * FROM pga_c3_pattern_library WHERE pattern_id = ?`, patternId);
}

/** The best live pattern for a task category — pruned ones never surface. */
export function patternFor(projectName: string, category: string): PatternRow | null {
  return q1<PatternRow>(
    `SELECT * FROM pga_c3_pattern_library
      WHERE project_name = ? AND task_category = ? AND darwin_roi >= 0 AND success_rate >= 0.4
      ORDER BY success_rate DESC, usage_count DESC LIMIT 1`,
    projectName,
    category,
  );
}

export function patternsTop(projectName: string, limit = 12): PatternRow[] {
  return q<PatternRow>(
    `SELECT * FROM pga_c3_pattern_library
      WHERE project_name = ? AND darwin_roi >= 0 AND success_rate >= 0.4
      ORDER BY (success_rate * usage_count) DESC, usage_count DESC LIMIT ?`,
    projectName,
    limit,
  );
}

export function patternMarkRoi(patternId: string, roi: number): void {
  run(`UPDATE pga_c3_pattern_library SET darwin_roi = ? WHERE pattern_id = ?`, roi, patternId);
}

// ------------------------------------------------------------- C4 pointers

export interface PointerRow {
  pointer_id: string;
  project_name: string;
  file_path: string;
  symbol_name: string;
  symbol_kind: string;
  line_start: number;
  line_end: number;
  semantic_tags: string | null;
  relevance_score: number;
  hit_count: number;
  last_hit_at: number | null;
}

export interface PointerInput {
  pointerId: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  lineStart: number;
  lineEnd: number;
  tags?: string;
}

function pointerInsert(projectName: string, rows: PointerInput[]): void {
  const seen = new Set<string>();
  for (const r of rows.slice(0, 8000)) {
    if (seen.has(r.pointerId)) continue;
    seen.add(r.pointerId);
    run(
      `INSERT INTO pga_c4_semantic_pointers
         (pointer_id, project_name, file_path, symbol_name, symbol_kind, line_start, line_end, semantic_tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.pointerId,
      projectName,
      r.filePath,
      r.symbolName,
      r.symbolKind,
      Math.max(1, Math.round(r.lineStart)),
      Math.max(1, Math.round(r.lineEnd)),
      r.tags ?? "",
    );
  }
}

/** Replace the full pointer set of a project (initial genome build). */
export function pointerReplaceForProject(projectName: string, rows: PointerInput[]): void {
  tx(() => {
    run(`DELETE FROM pga_c4_semantic_pointers WHERE project_name = ?`, projectName);
    pointerInsert(projectName, rows);
  });
}

/** Incremental re-index: refresh only the given files (edited files). */
export function pointerReplaceForFiles(projectName: string, files: string[], rows: PointerInput[]): void {
  tx(() => {
    for (const f of files.slice(0, 100)) {
      run(`DELETE FROM pga_c4_semantic_pointers WHERE project_name = ? AND file_path = ?`, projectName, f);
    }
    pointerInsert(projectName, rows);
  });
}

export function pointersTop(projectName: string, limit = 60): PointerRow[] {
  return q<PointerRow>(
    `SELECT * FROM pga_c4_semantic_pointers
      WHERE project_name = ?
      ORDER BY relevance_score DESC, hit_count DESC, line_start ASC LIMIT ?`,
    projectName,
    limit,
  );
}

export function pointersForFiles(projectName: string, files: string[]): PointerRow[] {
  if (!files.length) return [];
  const marks = files.map(() => "?").join(",");
  return q<PointerRow>(
    `SELECT * FROM pga_c4_semantic_pointers WHERE project_name = ? AND file_path IN (${marks})`,
    projectName,
    ...files,
  );
}

export function pointerHit(pointerIds: string[], now = Date.now()): void {
  for (const id of pointerIds.slice(0, 200)) {
    run(
      `UPDATE pga_c4_semantic_pointers SET hit_count = hit_count + 1, last_hit_at = ? WHERE pointer_id = ?`,
      now,
      id,
    );
  }
}

/** 0.92 temporal decay for pointers untouched since `staleBefore`. */
export function pointerDecayAll(factor = 0.92, staleBefore: number): number {
  const row = q1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pga_c4_semantic_pointers WHERE COALESCE(last_hit_at, 0) < ?`,
    staleBefore,
  );
  run(
    `UPDATE pga_c4_semantic_pointers SET relevance_score = relevance_score * ?
      WHERE COALESCE(last_hit_at, 0) < ?`,
    factor,
    staleBefore,
  );
  return Number(row?.n ?? 0);
}

function ftsOr(query: string, max = 8): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out.join(" OR ");
}

/** FTS symbol lookup with a LIKE fallback; best match first. */
export function pointerSearch(projectName: string, query: string, limit = 8): PointerRow[] {
  const match = ftsOr(query);
  if (match) {
    try {
      const rows = q<PointerRow>(
        `SELECT p.* FROM pga_c4_fts f
           JOIN pga_c4_semantic_pointers p ON p.rowid = f.rowid
          WHERE pga_c4_fts MATCH ? AND p.project_name = ?
          ORDER BY bm25(pga_c4_fts), p.relevance_score DESC LIMIT ?`,
        match,
        projectName,
        limit,
      );
      if (rows.length) return rows;
    } catch {}
  }
  const like = `%${String(query ?? "").trim().toLowerCase().slice(0, 60)}%`;
  if (like === "%%") return [];
  return q<PointerRow>(
    `SELECT * FROM pga_c4_semantic_pointers
      WHERE project_name = ?
        AND (lower(symbol_name) LIKE ? OR lower(file_path) LIKE ? OR lower(COALESCE(semantic_tags,'')) LIKE ?)
      ORDER BY relevance_score DESC, hit_count DESC LIMIT ?`,
    projectName,
    like,
    like,
    like,
    limit,
  );
}

// -------------------------------------------------------------- C5 lessons

export interface LessonRow {
  lesson_id: string;
  project_name: string;
  created_at: number;
  expires_at: number;
  bug_summary: string | null;
  fix_method_aaak: string | null;
  file_pointer: string | null;
  severity: string;
  hit_count: number;
  darwin_roi: number;
}

export function lessonUpsert(e: {
  lessonId?: string;
  projectName: string;
  bugSummary: string;
  fixAaak?: string;
  filePointer?: string | null;
  severity?: "normal" | "critical";
  now?: number;
  ttlMs?: number;
}): string {
  const now = e.now ?? Date.now();
  const id = e.lessonId ?? `lesson:${e.projectName}:${now.toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  run(
    `INSERT OR REPLACE INTO pga_c5_evolution_lessons
       (lesson_id, project_name, created_at, expires_at, bug_summary, fix_method_aaak, file_pointer, severity, hit_count, darwin_roi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0)`,
    id,
    e.projectName,
    now,
    now + (e.ttlMs ?? 30 * 86_400_000),
    String(e.bugSummary ?? "").slice(0, 300),
    e.fixAaak ?? null,
    e.filePointer ?? null,
    e.severity ?? "normal",
  );
  return id;
}

export function lessonGet(lessonId: string): LessonRow | null {
  return q1<LessonRow>(`SELECT * FROM pga_c5_evolution_lessons WHERE lesson_id = ?`, lessonId);
}

export function lessonsFor(projectName: string, now = Date.now(), limit = 12): LessonRow[] {
  return q<LessonRow>(
    `SELECT * FROM pga_c5_evolution_lessons
      WHERE project_name = ? AND expires_at > ? AND darwin_roi >= 0
      ORDER BY severity DESC, created_at DESC LIMIT ?`,
    projectName,
    now,
    limit,
  );
}

/** Expired lessons that were never proven hot (hit_count < 3). */
export function lessonsExpired(now = Date.now(), limit = 200): string[] {
  const rows = q<{ lesson_id: string }>(
    `SELECT lesson_id FROM pga_c5_evolution_lessons
      WHERE expires_at <= ? AND hit_count < 3 LIMIT ?`,
    now,
    limit,
  );
  return rows.map((r) => r.lesson_id);
}

export function lessonDelete(ids: string[]): void {
  for (const id of ids.slice(0, 500)) {
    run(`DELETE FROM pga_c5_evolution_lessons WHERE lesson_id = ?`, id);
  }
}

export function lessonMarkRoi(lessonId: string, roi: number): void {
  run(`UPDATE pga_c5_evolution_lessons SET darwin_roi = ? WHERE lesson_id = ?`, roi, lessonId);
}

export function lessonHit(lessonIds: string[]): void {
  for (const id of lessonIds.slice(0, 100)) {
    run(`UPDATE pga_c5_evolution_lessons SET hit_count = hit_count + 1 WHERE lesson_id = ?`, id);
  }
}

// ---------------------------------------------------------- darwin ledger

export type ArtifactType = "c3_pattern" | "c4_pointer" | "c5_lesson" | "v3_engram" | "v3_macro" | "v3_interceptor";

export interface LedgerRow {
  artifact_type: string;
  artifact_id: string;
  impressions: number;
  activations: number;
  total_tokens_spent: number;
  total_tokens_saved: number;
  roi_score: number;
  status: string;
  updated_at: number;
}

/** Add usage counters; ROI/status are recomputed provisionally on every touch. */
export function ledgerTouch(e: {
  artifactType: ArtifactType | string;
  artifactId: string;
  impressions?: number;
  activations?: number;
  spent?: number;
  saved?: number;
  now?: number;
}): void {
  const now = e.now ?? Date.now();
  tx(() => {
    const cur = q1<LedgerRow>(
      `SELECT * FROM darwin_artifact_ledger WHERE artifact_type = ? AND artifact_id = ?`,
      e.artifactType,
      e.artifactId,
    );
    const impressions = Number(cur?.impressions ?? 0) + (e.impressions ?? 0);
    const activations = Number(cur?.activations ?? 0) + (e.activations ?? 0);
    const spent = Number(cur?.total_tokens_spent ?? 0) + (e.spent ?? 0);
    const saved = Number(cur?.total_tokens_saved ?? 0) + (e.saved ?? 0);
    const sr = impressions > 0 ? Math.min(1, activations / impressions) : 1;
    const roi = (saved * sr - spent) / Math.max(1, spent);
    const status = cur?.status === "pruned" ? "pruned" : roi >= 0.5 ? "thriving" : "probation";
    run(
      `INSERT OR REPLACE INTO darwin_artifact_ledger
         (artifact_type, artifact_id, impressions, activations, total_tokens_spent, total_tokens_saved, roi_score, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.artifactType,
      e.artifactId,
      impressions,
      activations,
      spent,
      saved,
      roi,
      status,
      now,
    );
  });
}

export function ledgerSet(e: {
  artifactType: string;
  artifactId: string;
  roi?: number;
  status?: string;
  now?: number;
}): void {
  run(
    `UPDATE darwin_artifact_ledger
        SET roi_score = COALESCE(?, roi_score), status = COALESCE(?, status), updated_at = ?
      WHERE artifact_type = ? AND artifact_id = ?`,
    e.roi ?? null,
    e.status ?? null,
    e.now ?? Date.now(),
    e.artifactType,
    e.artifactId,
  );
}

export function ledgerGet(artifactType: string, artifactId: string): LedgerRow | null {
  return q1<LedgerRow>(
    `SELECT * FROM darwin_artifact_ledger WHERE artifact_type = ? AND artifact_id = ?`,
    artifactType,
    artifactId,
  );
}

export function ledgerAll(limit = 200): LedgerRow[] {
  return q<LedgerRow>(
    `SELECT * FROM darwin_artifact_ledger ORDER BY roi_score DESC, impressions DESC LIMIT ?`,
    limit,
  );
}

/** Darwinian kill switch for a proven-bad subconscious interceptor. */
export function interceptorDeactivate(ids: number[]): void {
  for (const id of ids.slice(0, 100)) {
    run(`UPDATE l2_subconscious_interceptors SET active = 0 WHERE id = ?`, id);
  }
}

// ------------------------------------------------------------------ misc

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
}

/** Confidence arithmetic must land on clean decimals (0.80 -> 0.90, not 0.9000000000000001). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function norm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2 && !["và", "của", "cho", "với", "thì", "này", "đang", "rồi", "cái", "phần"].includes(t));
}

export const __internals = { q, q1, run, norm, clamp01, tokens, parseLoops, migrate, VEC_DIM, blobToVec };
