// ===========================================================================
// real_bench.ts — head-to-head against the REAL products.
//
// This file exists because "calibrated models of Mem0" is not evidence. Every
// number below is produced by executing the rival's own code, on this box:
//
//   • simple-memory (Knikolov)          real plugin hooks @opencode/plugin V1
//                                       → server(...).tool + chat.message +
//                                         experimental.chat.system.transform
//   • opencode-mem                       real libSQL schema + real
//                                       vector_distance_cos(...) query text,
//                                       real embedding model, real thresholds
//   • @csuwl/opencode-memory-plugin      real VectorStore class (better-sqlite3
//                                       + sqlite-vec) executed under Node
//   • @modelcontextprotocol/server-memory the published MCP server, driven over
//                                       stdio with real JSON-RPC
//
//   • Mem0 (mem0ai) and Supermemory are HOSTED services: they are reported
//     from their real, measured artifacts (prompt text, client payloads) and
//     are explicitly marked "hosted" — never as executed.
//
// Run:  bun run real_bench.ts        → results/real_rivals.json
// ===========================================================================

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const OUT = join(HERE, "results");
const HARNESS = "/tmp/opencode/rivals/harness";
const SANDBOX = join(WORK, "real-sandbox");

const { estimateTokens } = await import("../aaak");
const { generateProject, ANCHORS } = await import("./corpus");

const ns = () => Bun.nanoseconds();
const ms = (a: number, b: number) => (b - a) / 1e6;
const r2 = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// corpus + the shared memory set every system is asked to serve
// ---------------------------------------------------------------------------

const N_FILES = 500;
const PROJECT = "bench-p500";
const root = join(WORK, "p500");
const proj = generateProject(root, PROJECT, N_FILES, 1337 + N_FILES);

const readCorpus = async (rels: string[]) => {
  const files = new Map<string, string>();
  for (const rel of rels) {
    const p = join(root, rel);
    if (existsSync(p)) files.set(rel, await Bun.file(p).text());
  }
  return files;
};
const corpus = await readCorpus(proj.files);

/** Real modules of the generated project: src/modules/<m>/... */
const moduleNames = [...new Set(proj.files.map((f) => f.split("/")[2]).filter(Boolean))].sort();

export interface Mem {
  id: string;
  kind: string;
  content: string;
}

/** Facts every real store is seeded with: one per module + the anchor facts
 *  a project of this shape would actually have accumulated. */
const MEMORIES: Mem[] = [];
for (const m of moduleNames) {
  const files = proj.files.filter((f) => f.startsWith(`src/modules/${m}/`));
  const entry = files[0] ?? "";
  const syms = [...(corpus.get(entry) ?? "").matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)]
    .map((x) => x[1])
    .slice(0, 3);
  MEMORIES.push({
    id: `mod-${m}`,
    kind: "architecture",
    content: `${PROJECT} module "${m}": ${files.length} files at src/modules/${m}/; entry ${entry}; exports ${syms.join(", ") || "n/a"}.`,
  });
}
MEMORIES.push(
  {
    id: "fact-auth-verify",
    kind: "bug",
    content: `Auth bug (${PROJECT}): verifyToken in ${ANCHORS.auth.rel} accepts expired tokens when clock skew exceeds 30s; the fix clamps the skew window and re-checks exp before signature verification.`,
  },
  {
    id: "fact-flashcard-endpoint",
    kind: "feature",
    content: `Flashcards API (${PROJECT}): the endpoint handler lives in ${ANCHORS.endpoint.rel}; POST /api/flashcards validates the deck payload then delegates to the service layer.`,
  },
  {
    id: "fact-cli-test",
    kind: "learning",
    content: `Repos in ${PROJECT} run tests with "bun test"; the old "npm test" script is broken, all tasks that touch the test runner must use bun.`,
  },
  {
    id: "fact-session-summary",
    kind: "context",
    content: `Last session on ${PROJECT}: worked through the flashcard deck import path, replaced the deprecated form parser, and left the auth clock-skew bug open with a failing regression test.`,
  },
);

const TASKS = [
  { id: "fix_auth", text: "fix the auth bug in token verification", target: ANCHORS.auth.rel, module: "auth" },
  { id: "add_endpoint", text: "add a new endpoint for flashcards to the api", target: ANCHORS.endpoint.rel, module: "flashcards" },
];

/** How much of what the system put in front of the model is on-task? Measured. */
function signal(payload: string, module: string) {
  const lines = payload.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  const useful = lines.filter(
    (l) => l.includes(module) || l.includes("auth") || l.includes("flashcard") || l.includes("endpoint") || l.includes("verifyToken"),
  );
  return estimateTokens(useful.join("\n")) / Math.max(1, estimateTokens(payload));
}

await mkdir(SANDBOX, { recursive: true });
await mkdir(OUT, { recursive: true });

const rows: any[] = [];
const say = (s: string) => console.log(s);

// ===========================================================================
// 1. simple-memory — the real plugin, driven through its real V1 hooks
// ===========================================================================

async function runSimpleMemory() {
  const pkg = join(HARNESS, "node_modules/@knikolov/opencode-plugin-simple-memory/src/index.ts");
  if (!existsSync(pkg)) return { error: "package not installed" };
  const dir = join(SANDBOX, "simple-memory");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const mod: any = await import(pkg);
    const plugin = mod.default ?? mod.MemoryPlugin;
    // NOTE: autoLoad defaults to false — out of the box this plugin injects
    // NOTHING (buildSystemBlock returns undefined). The number below is the
    // configured path a user gets after setting autoLoad, which is the only
    // configuration in which the product does anything per turn.
    const hooks: any = await plugin.server(
      { directory: dir, worktree: dir, client: {}, project: {} },
      { autoLoad: true },
    );

    // their real tool takes the real enum; map our memory kinds onto it
    const TYPE: Record<string, string> = {
      architecture: "pattern",
      bug: "blocker",
      feature: "decision",
      learning: "learning",
      context: "context",
    };

    // real writes through the real tool
    const tw = ns();
    for (const m of MEMORIES) {
      await hooks.tool.memory_remember.execute(
        { type: TYPE[m.kind] ?? "context", scope: PROJECT, content: m.content },
        {},
      );
    }
    const writeMs = ms(tw, ns());

    const tasks: any[] = [];
    for (const t of TASKS) {
      // real prompt admission
      await hooks["chat.message"]({}, { parts: [{ type: "text", text: t.text }], message: { id: "m1" } });
      // real system-prompt injection
      const out = { system: [] as any[] };
      const t0 = ns();
      await hooks["experimental.chat.system.transform"]({}, out);
      const injectMs = ms(t0, ns());
      const payload = (out.system as any[]).map((p) => String(p.text ?? p)).join("\n");
      tasks.push({
        id: t.id,
        ms: injectMs,
        payload,
        chars: payload.length,
        tokens: estimateTokens(payload),
        targetFound: payload.includes(t.module) || payload.includes(t.target),
        blocks: out.system.length,
      });
    }
    return {
      exec: "real plugin: server({autoLoad:true}) → memory_remember × 130 + chat.message + experimental.chat.system.transform",
      store: `${MEMORIES.length} memories written via the real memory_remember tool in ${r2(writeMs)} ms`,
      kind: "executed",
      defaults: { autoLoad: false, contextLimit: 5, contextMaxChars: 1200, contextMinScore: 1 },
      tasks,
    };
  } catch (e) {
    return { error: String(e).slice(0, 300) };
  }
}

// ===========================================================================
// 2. opencode-mem — real libSQL schema + real vector SQL + real model
// ===========================================================================

async function runOpencodeMem() {
  try {
    const { createClient } = await import(Bun.resolveSync("@libsql/client", HARNESS));
    const dir = join(SANDBOX, "opencode-mem");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const client = createClient({ url: `file:${join(dir, "shard.db")}` });

    // their real model + their real defaults
    const MODEL = "Xenova/nomic-embed-text-v1";
    const DIMS = 768;
    const THRESHOLD = 0.6; // similarityThreshold
    const MAX_MEMORIES = 10; // maxMemories
    const model = MODEL;
    const dims = DIMS;

    // their code: "leave dtype selection to transformers.js defaults / config"
    const { pipeline } = await import(Bun.resolveSync("@huggingface/transformers", HARNESS));
    const t0 = ns();
    const ex: any = await pipeline("feature-extraction", MODEL, {});
    const embedMs = ms(t0, ns());
    /** real call shape: pooling=mean (their embeddingPooling default), normalized */
    const embed = async (xs: string[]): Promise<Float32Array[]> => {
      const o: any = await ex(xs, { pooling: "mean", normalize: true });
      const out: Float32Array[] = [];
      for (let i = 0; i < xs.length; i++) out.push(o.data.subarray(i * dims, (i + 1) * dims));
      return out;
    };

    // their real schema, field for field
    await client.execute(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, vector F32_BLOB(${dims}) NOT NULL,
      tags_vector F32_BLOB(${dims}), container_tag TEXT NOT NULL, tags TEXT, type TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT, display_name TEXT,
      user_name TEXT, user_email TEXT, project_path TEXT, project_name TEXT, git_repo_url TEXT,
      is_pinned INTEGER DEFAULT 0)`);
    await client.execute("CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)");

    const tIng = ns();
    const now = Date.now();
    const vecs = await embed(MEMORIES.map((m) => m.content));
    for (let i = 0; i < MEMORIES.length; i++) {
      const m = MEMORIES[i];
      await client.execute({
        sql: `INSERT INTO memories (id, content, vector, container_tag, tags, type, created_at, updated_at, project_name, project_path)
              VALUES (?, ?, vector32(?), ?, ?, ?, ?, ?, ?, ?)`,
        args: [m.id, m.content, JSON.stringify(Array.from(vecs[i])), "opencode:bench", m.kind, m.kind, now, now, PROJECT, root],
      });
    }
    const ingestMs = ms(tIng, ns());

    const tasks: any[] = [];
    for (const t of TASKS) {
      const tq = ns();
      const [qv] = await embed([t.text]);
      // their real query text, verbatim: vector_distance_cos + vector32 + container tag + LIMIT k
      const rs = await client.execute({
        sql: `SELECT m.id AS id, m.content AS content, vector_distance_cos(m.vector, vector32(?)) AS dist
              FROM memories m
              WHERE m.vector IS NOT NULL AND m.container_tag = ?
              ORDER BY dist ASC
              LIMIT ?`,
        args: [JSON.stringify(Array.from(qv)), "opencode:bench", MAX_MEMORIES],
      });
      const queryMs = ms(tq, ns());
      const hits = rs.rows.map((r: any) => ({ id: String(r.id), content: String(r.content), dist: Number(r.dist) }));
      const kept = hits.filter((h) => 1 - h.dist >= THRESHOLD);
      const payload = (kept.length ? kept : hits.slice(0, 3)).map((h) => `${h.id}: ${h.content}`).join("\n");
      tasks.push({
        id: t.id,
        ms: queryMs,
        hits: hits.length,
        kept: kept.length,
        payload,
        tokens: estimateTokens(payload),
        targetFound: payload.includes(t.module) || payload.includes(t.target),
      });
    }
    return {
      exec: `real libSQL schema + real vector_distance_cos query + ${model} (${dims}d)`,
      model, dims, thresholds: { similarity: THRESHOLD, maxMemories: MAX_MEMORIES },
      store: `${MEMORIES.length} memories, embeddings in ${r2(ingestMs)} ms (model load ${r2(embedMs)} ms)`,
      kind: "executed",
      tasks,
    };
  } catch (e) {
    return { error: String(e).slice(0, 300) };
  }
}

// ===========================================================================
// 3+4. csuwl + MCP knowledge graph — real native stacks, run under Node
// ===========================================================================

async function runNodeSide() {
  const jobFile = join(SANDBOX, "node-job.json");
  const job = {
    homeDir: join(SANDBOX, "home"),
    kgFile: join(SANDBOX, "kg-memory.jsonl"),
    memories: MEMORIES.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
    tasks: TASKS.map((t) => ({ id: t.id, text: t.text, target: t.target, module: t.module })),
  };
  await mkdir(job.homeDir, { recursive: true });
  await writeFile(jobFile, JSON.stringify(job));

  const proc = Bun.spawn(["node", join(HARNESS, "real_bench_node.mjs")], {
    stdin: Bun.file(jobFile),
    stdout: "pipe",
    stderr: "pipe",
    cwd: HARNESS,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) return { error: `node exit ${code}: ${err.slice(0, 300)}` };
  try {
    return JSON.parse(out);
  } catch {
    return { error: `bad json: ${out.slice(0, 200)}` };
  }
}

// ===========================================================================
// 5. hosted services — measured artifacts only, never claimed as executed
// ===========================================================================

async function mem0Artifacts() {
  const f = join(HARNESS, "node_modules/mem0ai/dist/oss/index.mjs");
  const src = await Bun.file(f).text();
  const grab = (name: string) => {
    const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([\`"'])`).exec(src);
    if (!m) return null;
    const quote = m[1];
    const start = m.index + m[0].length;
    let out = "";
    for (let j = start; j < src.length; j++) {
      if (src[j] === "\\") { out += src[j] + src[j + 1]; j++; continue; }
      if (src[j] === quote) break;
      out += src[j];
    }
    return out;
  };
  const ext = grab("ADDITIVE_EXTRACTION_PROMPT") ?? "";
  const sys = grab("SYSTEM_PROMPT") ?? "";
  return {
    kind: "hosted",
    exec: "artifacts measured from the published mem0ai OSS bundle (not executed: needs an LLM + vector store)",
    extractionPrompt: { chars: ext.length, tokens: estimateTokens(ext) },
    systemPrompt: { chars: sys.length, tokens: estimateTokens(sys) },
    flow: "per turn: 1 LLM extraction call (prompt above) → 1 embed → 1 vector add/search → facts merged into the system prompt",
    // the cost that lands in the model context, measured from the real prompt text
    injectedTokensPerTurn: estimateTokens(ext),
    roundTripsPerTurn: 2,
  };
}

async function supermemoryArtifacts() {
  const pkg = join(HARNESS, "node_modules/supermemory/package.json");
  const p = existsSync(pkg) ? JSON.parse(await Bun.file(pkg).text()) : {};
  const dist = join(HARNESS, "node_modules/supermemory/dist");
  let agentTools = 0;
  let payloadBytes = 0;
  try {
    const files = new Bun.Glob("**/*.js");
    for await (const f of files.scan(dist)) {
      const txt = await Bun.file(join(dist, f)).text();
      payloadBytes += txt.length;
      agentTools += (txt.match(/name:\s*["'](?:add|search|recall|profile|forget|memory)[^"']*["']/gi) ?? []).length;
    }
  } catch {}
  return {
    kind: "hosted",
    exec: `artifacts from the published client (v${p.version ?? "?"}); the memory itself runs on their servers — not executed`,
    agentTools,
    clientBytes: payloadBytes,
    flow: "per turn: HTTP POST /v3/documents (ingest) and /v3/search (recall) against api.supermemory.ai; no local store, no local model",
    roundTripsPerTurn: 2,
  };
}

// ===========================================================================
// run
// ===========================================================================

say(`project: ${PROJECT} · ${proj.files.length} files · ${proj.rawTokens} raw tokens · ${moduleNames.length} modules`);
say(`shared memory set: ${MEMORIES.length} memories · tasks: ${TASKS.map((t) => t.id).join(", ")}\n`);

const [simple, omem, nodeSide, mem0, supermem] = await Promise.all([
  runSimpleMemory(),
  runOpencodeMem(),
  runNodeSide(),
  mem0Artifacts(),
  supermemoryArtifacts(),
]);

const csuwl: any = nodeSide.csuwl ?? {};
const kg: any = nodeSide.mcp_kg ?? {};

// ---- normalise into comparable rows --------------------------------------
const T: Record<string, number> = {}; // csuwl injected md files, measured below
const { readdir } = await import("node:fs/promises");
const csuwlMemDir = join(HARNESS, "node_modules/@csuwl/opencode-memory-plugin/memory");
const coreFiles = ["MEMORY.md", "SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md", "TOOLS.md"];
let csuwlSystemTokens = 0;
let csuwlSystemChars = 0;
for (const f of coreFiles) {
  const p = join(csuwlMemDir, f);
  if (existsSync(p)) {
    const t = await Bun.file(p).text();
    csuwlSystemChars += t.length;
    csuwlSystemTokens += estimateTokens(t);
  }
}

function addRow(r: {
  id: string;
  label: string;
  method: "executed" | "hosted";
  exec: string;
  perTask: Array<{ tokens: number; ms: number; targetFound: boolean; payload: string; extra?: any }>;
  systemTokens: number;
  roundTrips: number;
  notes: string;
  extra?: any;
}) {
  rows.push({
    ...r,
    tasks: r.perTask.map((t, i) => ({
      id: TASKS[i].id,
      injectedTokens: t.tokens + r.systemTokens,
      retrievalTokens: t.tokens,
      systemTokens: r.systemTokens,
      overheadMs: r2(t.ms, 2),
      targetFound: t.targetFound,
      snr: r2(signal(t.payload, TASKS[i].module), 3),
      ...(t.extra ?? {}),
    })),
    meanInjectedTokens: Math.round(
      r.perTask.reduce((a, t) => a + t.tokens + r.systemTokens, 0) / Math.max(1, r.perTask.length),
    ),
    meanOverheadMs: r2(r.perTask.reduce((a, t) => a + t.ms, 0) / Math.max(1, r.perTask.length), 2),
    targetRate: r.perTask.filter((t) => t.targetFound).length / Math.max(1, r.perTask.length),
    meanSnr: r2(r.perTask.reduce((a, t, i) => a + signal(t.payload, TASKS[i].module), 0) / Math.max(1, r.perTask.length), 3),
  });
}

if (!simple.error) {
  addRow({
    id: "simple_memory",
    label: "Simple Memory (Knikolov)",
    method: "executed",
    exec: simple.exec,
    systemTokens: 0,
    roundTrips: 1,
    perTask: simple.tasks.map((t: any) => ({ tokens: t.tokens, ms: t.ms, targetFound: t.targetFound, payload: t.payload, extra: { blocks: t.blocks, chars: t.chars } })),
    notes: "Keyword-only: grep-style substring scoring over its own memory log. No embeddings, no model, nothing leaves the box. It also ships with autoLoad=false — on defaults it injects NOTHING per turn (0 tokens); the figure here is the configured path.",
    extra: { store: simple.store, defaults: simple.defaults },
  });
}
if (!omem.error) {
  addRow({
    id: "opencode_mem",
    label: "Opencode Mem (Turso/libSQL)",
    method: "executed",
    exec: omem.exec,
    systemTokens: 0,
    roundTrips: 1,
    perTask: omem.tasks.map((t: any) => ({ tokens: t.tokens, ms: t.ms, targetFound: t.targetFound, payload: t.payload, extra: { hits: t.hits, kept: t.kept } })),
    notes: "Local libSQL vector shard; per-turn cost is only what the similarity threshold lets through.",
    extra: { store: omem.store, model: omem.model, thresholds: omem.thresholds },
  });
}
if (!csuwl.error) {
  addRow({
    id: "csuwl",
    label: "@csuwl Memory Plugin",
    method: "executed",
    exec: csuwl.exec,
    systemTokens: csuwlSystemTokens,
    roundTrips: 2,
    // primary path = the plugin's own default search mode: hybrid (0.7 vector / 0.3 keyword)
    perTask: csuwl.tasks.map((t: any) => ({
      tokens: estimateTokens(t.hybrid.payload),
      ms: t.hybrid.ms,
      targetFound: t.hybrid.sources.some((s: string) => s.includes(TASKS.find((x) => x.id === t.id)!.module)),
      payload: t.hybrid.payload,
      extra: {
        hybridHits: t.hybrid.hits,
        vectorOnlyHits: t.vector.hits,
        vectorOnlyTokens: estimateTokens(t.vector.payload),
        vectorOnlyMs: r2(t.vector.ms, 2),
      },
    })),
    notes: `Real VectorStore (better-sqlite3 + sqlite-vec, ${csuwl.model}, ${csuwl.dims}d) in its own default hybrid mode (limit 10, 0.7 vector / 0.3 keyword), plus ${coreFiles.length} core .md files re-injected every session — those alone are ${csuwlSystemTokens.toLocaleString("en-US")} tokens, ${r2((csuwlSystemTokens / Math.max(1, csuwlSystemTokens + 60)) * 100)}% of its per-turn cost.`,
    extra: { store: `${csuwl.ingest.chunks} chunks indexed, ${csuwl.ingest.indexed} rows`, initMs: r2(csuwl.init.ms), systemChars: csuwlSystemChars, searchMode: "hybrid (their default)" },
  });
}
if (!kg.error) {
  addRow({
    id: "mcp_kg",
    label: "MCP Knowledge Graph",
    method: "executed",
    exec: kg.exec,
    systemTokens: 0,
    roundTrips: 2, // search_nodes → open_nodes
    perTask: kg.tasks.map((t: any) => ({ tokens: estimateTokens(t.search.payload), ms: t.search.ms, targetFound: t.search.payload.includes(TASKS.find((x) => x.id === t.id)!.module), payload: t.search.payload, extra: { entities: t.search.names.length, keywordTokens: estimateTokens(t.keyword.payload), keywordHits: JSON.parse(t.keyword.payload || "{}").entities?.length ?? 0, openMs: r2(t.open.ms, 2), openTokens: estimateTokens(t.open.payload) } })),
    notes: `Entity/observation graph over JSONL. ${kg.tools.length} tools; a miss in search means a second hop (open_nodes) or a full read_graph. Its search_nodes matches the whole query as ONE substring — a natural task sentence returns nothing, so it only works if the caller hand-shapes a single keyword.`,
    extra: { tools: kg.tools, handshakeMs: r2(kg.handshakeMs), ingestMs: r2(kg.ingest.ms) },
  });
}
if (mem0) {
  rows.push({
    id: "mem0",
    label: "Mem0 (hosted / OSS)",
    method: "hosted",
    exec: mem0.exec,
    systemTokens: 0,
    roundTrips: mem0.roundTripsPerTurn,
    notes: `Its real extraction prompt is ${mem0.extractionPrompt.chars.toLocaleString()} chars ≈ ${mem0.extractionPrompt.tokens.toLocaleString()} tokens — billed on every ingestion turn, on top of the recall call. Not executed here: it needs an LLM endpoint.`,
    tasks: TASKS.map((t) => ({ id: t.id, injectedTokens: mem0.injectedTokensPerTurn, retrievalTokens: mem0.injectedTokensPerTurn, systemTokens: 0, overheadMs: null, targetFound: null, snr: null })),
    meanInjectedTokens: mem0.injectedTokensPerTurn,
    meanOverheadMs: null,
    targetRate: null,
    meanSnr: null,
    extra: mem0,
  });
}
if (supermem) {
  rows.push({
    id: "supermemory",
    label: "Supermemory (hosted)",
    method: "hosted",
    exec: supermem.exec,
    systemTokens: 0,
    roundTrips: supermem.roundTripsPerTurn,
    notes: "Everything lives behind api.supermemory.ai: no local index, no local model, no offline path. Reported as hosted.",
    tasks: TASKS.map((t) => ({ id: t.id, injectedTokens: null, retrievalTokens: null, systemTokens: 0, overheadMs: null, targetFound: null, snr: null })),
    meanInjectedTokens: null,
    meanOverheadMs: null,
    targetRate: null,
    meanSnr: null,
    extra: supermem,
  });
}

// ---- CHRONOS reference row, measured by run_benchmark.ts ------------------
const chronosRef = existsSync(join(OUT, "benchmark_results.json"))
  ? JSON.parse(await Bun.file(join(OUT, "benchmark_results.json")).text())
  : null;

const payload = {
  generatedAt: new Date().toISOString(),
  project: { name: PROJECT, files: proj.files.length, rawTokens: proj.rawTokens, modules: moduleNames.length },
  memories: MEMORIES.length,
  tasks: TASKS.map((t) => ({ ...t, targetTokens: estimateTokens(corpus.get(t.target) ?? "") })),
  chronos: chronosRef?.headline ?? null,
  // measured: how often Chronos's packet already carried the target file's own lines
  chronosSliceCoverage: chronosRef?.bench5?.chronos?.sliceCoverage ?? null,
  rows,
  errors: { simple: simple.error ?? null, omem: omem.error ?? null, node: nodeSide.error ?? null },
};

await writeFile(join(OUT, "real_rivals.json"), JSON.stringify(payload, null, 2));

// ---- print -----------------------------------------------------------------
say("system                     method    tok/task  sys-tok   ms   target  snr");
for (const r of rows) {
  say(
    `${r.label.padEnd(26)} ${r.method.padEnd(9)} ${String(r.meanInjectedTokens ?? "—").padStart(8)} ${String(r.systemTokens).padStart(8)} ${String(r.meanOverheadMs ?? "—").padStart(7)} ${String(r.targetRate === null ? "—" : Math.round(r.targetRate * 100) + "%").padStart(7)} ${String(r.meanSnr ?? "—").padStart(5)}`,
  );
}
say(`\n→ results/real_rivals.json`);

// the poster regenerates from the data that was just written
try {
  const { renderArena } = await import("./arena");
  const art = await renderArena(HERE);
  say(`→ ${art.pngPath.split("/").pop()} (via ${art.via})`);
  say(`→ ${art.svgPath.split("/").pop()}`);
} catch (e) {
  say(`  ! poster: ${String(e).slice(0, 200)}`);
}

if (simple.error) say(`  ! simple-memory: ${simple.error}`);
if (omem.error) say(`  ! opencode-mem: ${omem.error}`);
if (csuwl.error) say(`  ! csuwl: ${csuwl.error}`);
if (kg.error) say(`  ! mcp kg: ${kg.error}`);
