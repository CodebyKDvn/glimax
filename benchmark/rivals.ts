// ===========================================================================
// rivals.ts — the five rival architectures in the head-to-head.
//
// HONESTY CONTRACT (read this before quoting any number):
//
//   • CHRONOS-PALACE v4.0 is MEASURED. Every token, every millisecond and
//     every hit/miss below comes from executing its real engine (genome.ts /
//     darwin.ts / cortex.ts / retriever.ts / db.ts) in this process.
//
//   • The five rivals are MODELLED on top of MEASURED corpus facts. We do not
//     have a hosted Mem0 / Letta tenancy in this box, and a hand-rolled
//     "competitor" implementation would be a straw man — worse for credibility
//     than an explicit model. So each rival is expressed as a small formula
//     whose inputs are real measurements of the same generated project
//     (rawTokens, targetFileTokens, grepHits, module count, real BM25 hits)
//     and whose constants are documented and tuneable below.
//
//     These five are BASELINES, not products. The products —
//     opencode-mem, Simple Memory, @csuwl/opencode-memory-plugin and the
//     official MCP knowledge-graph server — are EXECUTED for real in
//     real_bench.ts, on the same corpus and the same memory set. Read that
//     file before quoting anything here.
//
//   The comparison is therefore: one measured system vs five calibrated
//   models. Report them as such. `method` travels with every number.
// ===========================================================================

import { estimateTokens } from "../aaak";
import type { GeneratedProject } from "./corpus";

// --------------------------------------------------------------- constants

export const C = {
  /** A real AGENTS.md / CLAUDE.md plus convention docs, verbatim every turn. */
  RULES_MD_TOKENS: 2400,
  /** Standard RAG chunk size for code. */
  CHUNK_TOKENS: 500,
  /** Chunks retrieved per query in a well-tuned setup. */
  RAG_TOP_K: 10,
  /** Instruction + tool-envelope overhead of a retrieval call. */
  RAG_ENVELOPE_TOKENS: 300,
  /** A tool result the harness will show before truncating. */
  TOOL_RESULT_CAP_TOKENS: 900,
  /** Sub-agent exploration: grep calls then file reads, per task. */
  SUBAGENT_GREPS: 3,
  SUBAGENT_READS: 4,
  SUBAGENT_TURNS: 6,
  /** Mem0/Letta-style dynamic system prompt: extracted facts + instructions. */
  FACT_PROMPT_TOKENS: 1250,
  /** Auto-generated skill harness: matched skill documents injected per task. */
  SKILLS_MATCHED: 2,
  SKILL_TOKENS_EACH: 450,
};

// --------------------------------------------------------------- BM25 over real chunks

export interface Chunk {
  rel: string;
  text: string;
  tokens: number;
  tf: Map<string, number>;
  len: number;
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "const", "return", "import", "export", "string", "number"]);

export function words(s: string): string[] {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Split the corpus into ~500-token chunks, on line boundaries (like a real indexer). */
export function chunkCorpus(files: Map<string, string>, cap = C.CHUNK_TOKENS): Chunk[] {
  const out: Chunk[] = [];
  for (const [rel, body] of files) {
    if (!rel.endsWith(".ts")) continue;
    let buf: string[] = [];
    let toks = 0;
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join("\n");
      const tf = new Map<string, number>();
      for (const w of words(text)) tf.set(w, (tf.get(w) ?? 0) + 1);
      out.push({ rel, text, tokens: estimateTokens(text), tf, len: [...tf.values()].reduce((a, b) => a + b, 0) });
      buf = [];
      toks = 0;
    };
    for (const line of body.split("\n")) {
      buf.push(line);
      toks = estimateTokens(buf.join("\n"));
      if (toks >= cap) flush();
    }
    flush();
  }
  return out;
}

/** Textbook BM25 (k1=1.2, b=0.75) — the real retrieval a vector RAG emulates. */
export function bm25(chunks: Chunk[], query: string, k: number): Chunk[] {
  const qs = words(query);
  const N = chunks.length || 1;
  const avg = chunks.reduce((a, c) => a + c.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const c of chunks) for (const q of qs) if (c.tf.has(q)) df.set(q, (df.get(q) ?? 0) + 1);
  const scored = chunks.map((c) => {
    let s = 0;
    for (const q of qs) {
      const f = c.tf.get(q) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / avg))));
    }
    return { c, s };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.c);
}

// --------------------------------------------------------------- task context

export interface TaskCtx {
  project: GeneratedProject;
  /** real full-context cost of the whole repository */
  rawTokens: number;
  /** what the sub-agent's grep actually prints (capped like a real tool) */
  grepOut: number;
  /** average code file size in this project */
  avgFileTokens: number;
  /** real BM25 top-K for this task */
  ragChunks: Chunk[];
  ragTokens: number;
  /** chunks that came from the task's target module */
  ragRelevantChunks: number;
  /** did the retriever actually surface the file that must be edited? */
  ragHasTargetFile: boolean;
  targetTokens: number;
  /** CHRONOS: measured synthesized packet */
  chronosPacket: number;
  chronosGenome: number;
}

export function buildTaskCtx(project: GeneratedProject, files: Map<string, string>, task: string, targetRel: string): TaskCtx {
  const chunks = chunkCorpus(files);
  const hits = bm25(chunks, task, C.RAG_TOP_K);
  const targetModule = targetRel.split("/").slice(0, 3).join("/");
  return {
    project,
    rawTokens: project.rawTokens,
    grepOut: Math.min(project.grepTokens, C.TOOL_RESULT_CAP_TOKENS),
    avgFileTokens: Math.round(project.rawTokens / Math.max(1, project.files.filter((f) => f.endsWith(".ts")).length)),
    ragChunks: hits,
    ragTokens: hits.reduce((a, c) => a + c.tokens, 0),
    ragRelevantChunks: hits.filter((c) => c.rel.startsWith(targetModule)).length,
    ragHasTargetFile: hits.some((c) => c.rel === targetRel),
    targetTokens: estimateTokens(files.get(targetRel) ?? ""),
    chronosPacket: 0,
    chronosGenome: 0,
  };
}

// --------------------------------------------------------------- rivals

export interface Rival {
  id: string;
  label: string;
  color: string;
  method: "modelled";
  /** tokens injected into the model context to accomplish ONE task */
  tokens: (c: TaskCtx) => number;
  breakdown: (c: TaskCtx) => Record<string, number>;
  /** LLM/tool round trips to accomplish the task */
  roundTrips: (c: TaskCtx) => number;
  /** retrieval / synthesis latency, excluding prompt prefill */
  overheadMs: (c: TaskCtx) => number;
  /** share of injected tokens that carry task-relevant signal (0..1) */
  snr: (c: TaskCtx) => number;
  /** does the injected context contain the exact target line range? */
  slice: boolean;
  /** is the information needed to do the task actually present? 1 = yes.
   *  Measured for RAG (did Top-K surface the file?); 1 for everyone who reads
   *  the file they are about to edit; Chronos-Palace is measured separately. */
  coverage: (c: TaskCtx) => number;
  /** share of ALL the project's modules still named in context (0..1).
   *  This is the compression-hostile reading: it punishes any store that keeps
   *  Top-K instead of a full directory listing. */
  archRecall: (c: TaskCtx) => number;
  /** is the TASK-RELEVANT module named? This is what the success score uses. */
  archTarget: (c: TaskCtx) => number;
  /** does the context still carry 30-day failure->fix lessons? */
  lessons: boolean;
  /** share of the injected block that is byte-stable across turns of a session
   *  (prompt-cache friendliness). Modelled: a frozen persona+rules header is
   *  cacheable, per-query retrieved chunks are not. */
  cacheStable: number;
  notes: string;
}

export const RIVALS: Rival[] = [
  {
    id: "full_context",
    label: "Full-Context + Static .md Rules",
    color: "#f2637b",
    method: "modelled",
    tokens: (c) => c.rawTokens + C.RULES_MD_TOKENS,
    breakdown: (c) => ({ repository_source: c.rawTokens, rules_md: C.RULES_MD_TOKENS }),
    roundTrips: () => 1,
    overheadMs: () => 35, // reading the tree off disk
    snr: (c) => Math.min(0.35, (c.targetTokens * 3 + C.RULES_MD_TOKENS) / Math.max(1, c.rawTokens + C.RULES_MD_TOKENS)),
    slice: false,
    coverage: () => 1, // the whole repository is literally present
    archRecall: () => 1,
    archTarget: () => 1,
    lessons: true,
    cacheStable: 0.6,
    notes: "Whole repo pasted every turn. Nothing is forgotten, nothing is prioritised; cost is the repo size.",
  },
  {
    id: "vector_rag",
    label: "Standard Vector RAG (Top-K)",
    color: "#f6a44b",
    method: "modelled",
    tokens: (c) => c.ragTokens + C.RAG_ENVELOPE_TOKENS + c.targetTokens,
    breakdown: (c) => ({ topk_chunks: c.ragTokens, envelope: C.RAG_ENVELOPE_TOKENS, target_file_read: c.targetTokens }),
    roundTrips: () => 3,
    overheadMs: () => 420, // embed + ANN + rerank, published RAG latencies
    snr: (c) => (c.ragTokens ? (c.ragRelevantChunks / C.RAG_TOP_K) * 0.75 + 0.2 : 0.2),
    slice: false,
    coverage: (c) => (c.ragHasTargetFile ? 1 : 0), // did Top-K surface the file to edit?
    archRecall: (c) => Math.min(1, (c.ragRelevantChunks * 2) / Math.max(1, c.project.moduleCount)),
    archTarget: (c) => (c.ragHasTargetFile ? 1 : 0),
    lessons: false,
    cacheStable: 0.2,
    notes: "BM25/vector Top-10 over 500-token chunks, then a full read of the file it decided to edit.",
  },
  {
    id: "fact_memory",
    label: "Cloud Fact Memory (Mem0 / Letta)",
    color: "#8b7bf7",
    method: "modelled",
    tokens: (c) => C.FACT_PROMPT_TOKENS + c.targetTokens,
    breakdown: (c) => ({ facts_prompt: C.FACT_PROMPT_TOKENS, target_file_read: c.targetTokens }),
    roundTrips: () => 4,
    overheadMs: () => 260, // vector/graph recall over extracted facts
    snr: (c) => Math.min(0.9, 0.35 + (c.targetTokens / Math.max(1, C.FACT_PROMPT_TOKENS + c.targetTokens)) * 0.6),
    slice: false,
    coverage: () => 1, // facts locate the file; the file itself is then read
    archRecall: (c) => Math.min(1, 0.15 + 0.05 * c.project.moduleCount / Math.max(1, c.project.moduleCount)),
    archTarget: () => 1,
    lessons: true,
    cacheStable: 0.5,
    notes: "An LLM distils each turn into facts; facts ride in the system prompt; the code itself is still read per task.",
  },
  {
    id: "subagent",
    label: "Sub-Agent Codebase Explorer",
    color: "#35b6c9",
    method: "modelled",
    tokens: (c) =>
      C.SUBAGENT_GREPS * c.grepOut + C.SUBAGENT_READS * c.avgFileTokens + C.SUBAGENT_TURNS * 120,
    breakdown: (c) => ({
      grep_results: C.SUBAGENT_GREPS * c.grepOut,
      file_reads: C.SUBAGENT_READS * c.avgFileTokens,
      tool_envelopes: C.SUBAGENT_TURNS * 120,
    }),
    roundTrips: () => C.SUBAGENT_TURNS,
    overheadMs: () => 2800, // measured-class exploration latency (grep+read+reason, multi-turn)
    snr: (c) =>
      (C.SUBAGENT_READS * c.avgFileTokens) / Math.max(1, C.SUBAGENT_GREPS * c.grepOut + C.SUBAGENT_READS * c.avgFileTokens) * 0.7 + 0.15,
    slice: false,
    coverage: () => 1, // the explorer reads the candidates it finds
    archRecall: (c) => Math.min(1, 0.3 + 0.1 * Math.min(4, c.project.moduleCount) / 4),
    archTarget: () => 1,
    lessons: false,
    cacheStable: 0.1,
    notes: "The agent delegates search to a sub-agent; only the sub-agent's summary returns, but its own reads are billed.",
  },
  {
    id: "skill_harness",
    label: "Auto-Generated SKILL.md Harness",
    color: "#43c98b",
    method: "modelled",
    tokens: (c) => C.SKILLS_MATCHED * C.SKILL_TOKENS_EACH + c.targetTokens + c.avgFileTokens,
    breakdown: (c) => ({
      matched_skills: C.SKILLS_MATCHED * C.SKILL_TOKENS_EACH,
      target_file_read: c.targetTokens,
      supporting_read: c.avgFileTokens,
    }),
    roundTrips: () => 3,
    overheadMs: () => 90, // local file reads
    snr: (c) => Math.min(0.85, 0.3 + (c.targetTokens / Math.max(1, C.SKILLS_MATCHED * C.SKILL_TOKENS_EACH + c.targetTokens)) * 0.6),
    slice: false,
    coverage: () => 1, // skills name the files, which are then read
    archRecall: () => 0.25,
    archTarget: () => 1,
    lessons: true,
    cacheStable: 0.4,
    notes: "Every task appends a hand-written skill file; matched skills are injected, and they grow without bound.",
  },
];

/** Shared scoring: presence + architecture + lessons + precision. */
export function successScore(coverage: number, archRecall: number, lessons: number, snr: number): number {
  return 0.4 * coverage + 0.25 * archRecall + 0.15 * lessons + 0.2 * snr;
}
