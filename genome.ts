// ===========================================================================
// genome.ts — CHRONOS-PALACE v4.0: the Project Genome Architecture (PGA).
//
// Every project is represented by five chromosomes under a hard budget:
//
//   C1 Architecture DNA   <= 200 tokens   manifests, services, db, auth, api
//   C2 Dependency Graph   <= 300 tokens   compressed adjacency + hub centrality
//   C3 Pattern Library    <= 500 tokens   winning task blueprints (learned)
//   C4 Semantic Index     <= 500 tokens   symbol -> file:Lstart-Lend pointers
//   C5 Evolution Memory   <= 300 tokens   failure lessons, 30-day shelf life
//                                         total <= 2000 tokens, always.
//
// Scaling: C2 folds file edges into module-level hubs once a project passes
// 120 files, C3/C4/C5 export only Top-K by ROI/relevance and every chromosome
// is hard-clamped (O(log N) growth, O(1) ceiling). All of this is plain Bun
// I/O — zero LLM tokens are ever spent building or maintaining a genome.
//
// Modules:
//   buildGenome()          scan + index + compress + store (background)
//   synthGenome()          task intent -> surgical packet (<=1700 tokens)
//                          with Top-3 line-range code slices; greetings and
//                          chit-chat return null, i.e. exactly 0 tokens.
//   noteGenomeMessage()    remember the current task intent (RAM, per session)
//   noteGenomeToolAfter()  evolution: success -> C3 pattern + incremental
//                          re-index; failure -> fix -> C5 lesson.
//   genomeIdleTick()       drop stale RAM journals.
// ===========================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  aaakCmd,
  clampTokens,
  estimateTokens as tok,
  isoDay,
  kebab,
  tokens as wordTokens,
} from "./aaak";
import {
  depEdgesAdd,
  depEdgesDeleteForFiles,
  depEdgesFor,
  depEdgesReplace,
  genomeGet,
  genomeUpsert,
  l1Keys,
  l1MarkKey,
  ledgerTouch,
  lessonHit,
  lessonUpsert,
  lessonsFor,
  patternGet,
  patternFor,
  patternsTop,
  patternUpsert,
  pointerHit,
  pointerReplaceForFiles,
  pointerReplaceForProject,
  pointerSearch,
  pointersForFiles,
  pointersTop,
  type GenomeRow,
  type LessonRow,
  type PointerInput,
  type PointerRow,
} from "./db";

// -------------------------------------------------------------- chromosome caps

export const C1_CAP = 200;
export const C2_CAP = 300;
export const C3_CAP = 500;
export const C4_CAP = 500;
export const C5_CAP = 300;
export const GENOME_CAP = C1_CAP + C2_CAP + C3_CAP + C4_CAP + C5_CAP; // 2000
/** Hard ceiling for one synthesized packet; the spec allows 350–1600. */
export const PACKET_CAP = 1700;

const MAX_FILES = 800;
const MAX_FILE_BYTES = 220_000;
const MAX_DEPTH = 8;
const READ_BUDGET_BYTES = 8 * 1024 * 1024;
const MODULE_FOLD_THRESHOLD = 120; // files above which C2 folds to module hubs

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".vue", ".svelte"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo", "coverage",
  "vendor", "target", "__pycache__", ".venv", "venv", ".cache", "tmp", ".idea", ".vscode",
]);

// ===========================================================================
// Scanning — bounded, skip build/vendor junk, read each file at most once.
// ===========================================================================

export interface ScanFile {
  rel: string;
  abs: string;
}

export function scanProject(dir: string, limit = MAX_FILES): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    if (out.length >= limit || depth > MAX_DEPTH) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const name = e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
        walk(join(d, name), rel ? `${rel}/${name}` : name, depth + 1);
      } else if (e.isFile()) {
        if (!CODE_EXT.has(name.slice(name.lastIndexOf(".")))) continue;
        const abs = join(d, name);
        try {
          if (statSync(abs).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        out.push({ rel: rel ? `${rel}/${name}` : name, abs });
      }
    }
  };
  walk(dir, "", 0);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function readTexts(files: ScanFile[]): Map<string, string> {
  const out = new Map<string, string>();
  let budget = READ_BUDGET_BYTES;
  for (const f of files) {
    if (budget <= 0) break;
    try {
      const t = readFileSync(f.abs, "utf8");
      budget -= t.length;
      out.set(f.rel, t);
    } catch {}
  }
  return out;
}

// ===========================================================================
// Symbol extraction — TS/JS, Python, Go, Rust. Line-accurate, regex-fast.
// ===========================================================================

export interface SymHit {
  name: string;
  kind: string;
  start: number; // 1-based inclusive
  end: number; // 1-based inclusive
  tags: string;
}

function words(s: string): string[] {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

function tagsOf(name: string, rel: string): string {
  const set = new Set<string>([...words(name), ...words(rel)]);
  return [...set].slice(0, 16).join(" ");
}

function indentOf(l: string): number {
  let n = 0;
  while (n < l.length && (l[n] === " " || l[n] === "\t")) n++;
  return n;
}

/** End of a brace-delimited body starting at `start` (0-based). 1-based line. */
function braceEnd(lines: string[], start: number): number {
  let depth = 0;
  let seen = false;
  const max = Math.min(lines.length, start + 400);
  for (let i = start; i < max; i++) {
    const l = lines[i].replace(/\\./g, " ").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/\/\/.*$/, "");
    let opens = 0;
    let closes = 0;
    for (const ch of l) {
      if (ch === "{") opens++;
      else if (ch === "}") closes++;
    }
    if (!seen && opens === 0 && closes === 0) {
      if (/;\s*$/.test(l) && i > start) return i + 1;
      continue;
    }
    seen = true;
    depth += opens - closes;
    if (depth <= 0) return i + 1;
  }
  return Math.min(lines.length, start + 30);
}

/** Python body end by indentation. 1-based line. */
function pyEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]);
  let last = start;
  for (let i = start + 1; i < Math.min(lines.length, start + 300); i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) <= base) return last + 1;
    last = i;
  }
  return last + 1;
}

export function extractSymbols(rel: string, text: string): SymHit[] {
  const lines = text.split("\n");
  const out: SymHit[] = [];
  const py = /\.py$/.test(rel);
  const go = /\.go$/.test(rel);
  const rs = /\.rs$/.test(rel);

  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const l = lines[i];
    if (l.length > 400) continue; // minified
    let name: string | null = null;
    let kind = "function";

    if (py) {
      let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(l);
      if (m) name = m[1];
      else {
        m = /^class\s+([A-Za-z_]\w*)/.exec(l);
        if (m) {
          name = m[1];
          kind = "class";
        }
      }
      if (name) out.push({ name, kind, start: i + 1, end: pyEnd(lines, i), tags: tagsOf(name, rel) });
      continue;
    }
    if (go) {
      const m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(l);
      if (m) out.push({ name: m[1], kind: "function", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      else {
        const st = /^type\s+([A-Za-z_]\w*)\s+struct/.exec(l);
        if (st) out.push({ name: st[1], kind: "class", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(st[1], rel) });
      }
      continue;
    }
    if (rs) {
      let m = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(l);
      if (m) out.push({ name: m[1], kind: "function", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      else {
        m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/.exec(l);
        if (m) out.push({ name: m[1], kind: "class", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      }
      continue;
    }

    // TS / JS — routes first (the most valuable anchors in a web project)
    let m = /\b(?:app|router|server|api|route)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/.exec(l);
    if (m) {
      out.push({
        name: `${m[1].toUpperCase()} ${m[2]}`,
        kind: "route",
        start: i + 1,
        end: braceEnd(lines, i),
        tags: tagsOf(m[2], rel),
      });
      continue;
    }
    m = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) {
      out.push({ name: m[1], kind: "class", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      continue;
    }
    m = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) {
      out.push({ name: m[1], kind: "type", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      continue;
    }
    m = /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(l);
    if (m) {
      out.push({ name: m[1], kind: "type", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      continue;
    }
    m = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) {
      out.push({ name: m[1], kind: "function", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
      continue;
    }
    m = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(l);
    if (m) out.push({ name: m[1], kind: "function", start: i + 1, end: braceEnd(lines, i), tags: tagsOf(m[1], rel) });
  }
  return out;
}

// ===========================================================================
// C1 — Architecture DNA (<= 200 tokens)
// ===========================================================================

function readJsonSafe(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function buildC1(dir: string, files: ScanFile[]): string {
  const pkg = readJsonSafe(join(dir, "package.json"));
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const names = Object.keys(deps);
  const pick = (list: string[]): string | null => list.find((l) => names.includes(l)) ?? null;
  const scriptTest = String(pkg?.scripts?.test ?? "");

  const fw =
    pick(["next", "nuxt", "@nestjs/core", "remix", "@remix-run/node", "astro", "@sveltejs/kit", "svelte", "vue", "react-native", "expo", "react", "express", "fastify", "hono", "elysia", "koa"]) ??
    (files.some((f) => /\.py$/.test(f.rel)) ? "python" : files.some((f) => /\.go$/.test(f.rel)) ? "go" : files.some((f) => /\.rs$/.test(f.rel)) ? "rust" : "unknown");
  const dbAlias: Record<string, string> = {
    "@prisma/client": "prisma",
    "drizzle-orm": "drizzle",
    "better-sqlite3": "sqlite",
    sqlite3: "sqlite",
    pg: "postgres",
    mongoose: "mongo",
  };
  const dbPicked = pick(["prisma", "@prisma/client", "drizzle-orm", "typeorm", "sequelize", "mongoose", "pg", "better-sqlite3", "sqlite3"]);
  const db =
    (dbPicked ? (dbAlias[dbPicked] ?? dbPicked) : null) ??
    (files.some((f) => /schema\.prisma$/.test(f.rel)) ? "prisma" : files.some((f) => /\.(sqlite3?|db)$/.test(f.rel)) ? "sqlite" : "none");
  const auth =
    pick(["next-auth", "@auth/core", "@clerk/nextjs", "better-auth", "jsonwebtoken", "jose", "lucia", "passport", "@supabase/supabase-js"]) ?? "none";
  const api = names.includes("@trpc/server")
    ? "trpc"
    : names.includes("graphql") || names.includes("@apollo/server")
      ? "graphql"
      : names.some((n) => /^(express|hono|fastify|koa)$/.test(n) || n === "@nestjs/core")
        ? "rest"
        : "rest-ish";
  const test = /vitest/.test(scriptTest)
    ? "vitest"
    : /jest/.test(scriptTest)
      ? "jest"
      : /bun test/.test(scriptTest) || names.includes("bun-types")
        ? "bun"
        : names.includes("@playwright/test")
          ? "playwright"
          : /pytest/.test(scriptTest)
            ? "pytest"
            : names.includes("vitest")
              ? "vitest"
              : names.includes("jest")
                ? "jest"
                : "none";
  const strict = readJsonSafe(join(dir, "tsconfig.json"))?.compilerOptions?.strict === true ? "on" : "off";

  const topdirs = new Set<string>();
  for (const f of files) {
    const seg = f.rel.split("/");
    if (seg.length > 1) topdirs.add(seg[0] === "src" && seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0]);
  }
  const dirs = [...topdirs].sort().slice(0, 12).join(",");
  const docker = existsSync(join(dir, "docker-compose.yml")) || existsSync(join(dir, "Dockerfile")) ? "|docker" : "";

  const text = `[C1|fw:${fw}|svc:${topdirs.size}|db:${db}|auth:${auth}|api:${api}|test:${test}|ts:${strict}${docker}|dirs:${dirs}]`;
  return clampTokens(text, C1_CAP);
}

// ===========================================================================
// C2 — Dependency graph: edges, hub centrality, compressed adjacency.
// `A<-b,c` means b and c import A; `A->d,e` means A imports d and e.
// ===========================================================================

function importSpecifiers(text: string, rel: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  if (/\.py$/.test(rel)) {
    const re2 = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
    while ((m = re2.exec(text))) out.push(m[1] ?? m[2]);
  }
  return out;
}

function resolveLocal(relFile: string, dir: string, spec: string, known: Set<string>): string | null {
  let s = spec;
  if (/\.py$/.test(relFile)) {
    if (!s.startsWith(".")) return null; // absolute python import — not a local edge
    let up = 0;
    let rest = s;
    while (rest.startsWith(".")) {
      up++;
      rest = rest.slice(1);
    }
    if (up === 1 && !rest) return null; // `from . import x` — package itself
    s = "../".repeat(Math.max(0, up - 1)) + rest.replace(/\./g, "/");
  } else if (!s.startsWith(".")) {
    return null; // external package import
  }
  let base = normalize(join(dir, s)).replace(/\\/g, "/");
  if (base.endsWith("/")) base = base.slice(0, -1);
  const cands = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.py`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/__init__.py`,
  ];
  for (const c of cands) if (known.has(c)) return c;
  return null;
}

export interface RawEdge {
  source: string;
  target: string;
  symbols: string;
}

export function buildEdges(files: ScanFile[], texts: Map<string, string>): RawEdge[] {
  const known = new Set(files.map((f) => f.rel));
  const out: RawEdge[] = [];
  for (const f of files) {
    const t = texts.get(f.rel);
    if (!t) continue;
    const dir = dirname(f.rel).replace(/\\/g, "/");
    for (const spec of importSpecifiers(t, f.rel)) {
      const target = resolveLocal(f.rel, dir, spec, known);
      if (target && target !== f.rel) out.push({ source: f.rel, target, symbols: "" });
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function aggregateEdges(files: ScanFile[], edges: RawEdge[]): Array<{ source: string; target: string; symbols: string | null; centrality: number }> {
  const indeg = new Map<string, number>();
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  let max = 1;
  for (const v of indeg.values()) if (v > max) max = v;
  return edges.slice(0, 4000).map((e) => ({
    source: e.source,
    target: e.target,
    symbols: e.symbols || null,
    centrality: round2((indeg.get(e.target) ?? 0) / max),
  }));
}

export function buildC2(files: ScanFile[], edges: RawEdge[]): string {
  const fold = files.length > MODULE_FOLD_THRESHOLD;
  const node = (rel: string) => (fold ? rel.split("/").slice(0, 2).join("/") : rel);
  const nodes = new Map<string, { in: Set<string>; out: Set<string> }>();
  const touch = (n: string) => {
    let e = nodes.get(n);
    if (!e) {
      e = { in: new Set<string>(), out: new Set<string>() };
      nodes.set(n, e);
    }
    return e;
  };
  for (const e of edges) {
    const a = node(e.source);
    const b = node(e.target);
    if (a === b) {
      touch(a);
      continue;
    }
    touch(a).out.add(b);
    touch(b).in.add(a);
  }
  const ranked = [...nodes.entries()].sort((x, y) => y[1].in.size + y[1].out.size - (x[1].in.size + x[1].out.size));
  const parts: string[] = [];
  for (const [name, e] of ranked.slice(0, fold ? 10 : 14)) {
    const ins = [...e.in].slice(0, 6).join(",");
    const outs = [...e.out].slice(0, 5).join(",");
    if (ins && outs) parts.push(`${name}<-${ins}->${outs}`);
    else if (ins) parts.push(`${name}<-${ins}`);
    else if (outs) parts.push(`${name}->${outs}`);
    if (parts.join(" | ").length > 1400) break;
  }
  const text = `[C2|files:${files.length}|hubs:${parts.length}] ${parts.join(" | ")}`;
  return clampTokens(text, C2_CAP);
}

// ===========================================================================
// C3 / C4 / C5 — exports from the learned artifacts (Top-K, clamped).
// ===========================================================================

export function buildC3(projectName: string, limit = 12): string {
  const rows = patternsTop(projectName, limit);
  const parts = rows.map(
    (p) =>
      `${p.task_category} [uses:${p.usage_count}|sr:${Math.round(p.success_rate * 100)}%|~${p.avg_tokens_consumed}tok] ${String(p.blueprint_aaak ?? "").slice(0, 80)}`.trim(),
  );
  const text = `[C3|pat:${rows.length}] ${parts.join(" | ")}`;
  return clampTokens(text, C3_CAP);
}

export function buildC4(projectName: string, limit = 70): string {
  const rows = pointersTop(projectName, limit);
  const parts = rows.map((r) => `${r.symbol_name}@${r.file_path}:${r.line_start}-${r.line_end}`);
  const text = `[C4|ptr:${rows.length}] ${parts.join(" | ")}`;
  return clampTokens(text, C4_CAP);
}

export function buildC5(projectName: string, now = Date.now(), limit = 12): string {
  const rows = lessonsFor(projectName, now, limit);
  const parts = rows.map((l) => {
    const at = l.file_pointer ? `@${l.file_pointer}` : "";
    return `[${isoDay(l.created_at)}|bug:${kebab(l.bug_summary ?? "bug", 28)}|fix:${l.fix_method_aaak ?? "fix?"}${at}]`;
  });
  const text = `[C5|less:${rows.length}] ${parts.join(" | ")}`;
  return clampTokens(text, C5_CAP);
}

// ===========================================================================
// Genome build — the whole pipeline, one call.
// ===========================================================================

export interface GenomeBuildResult {
  ok: boolean;
  fileCount: number;
  pointers: number;
  edges: number;
  tokens: { c1: number; c2: number; c3: number; c4: number; c5: number; total: number };
}

export function genomeTokens(g: GenomeRow): { c1: number; c2: number; c3: number; c4: number; c5: number; total: number } {
  const c1 = tok(g.c1_arch_dna_aaak ?? "");
  const c2 = tok(g.c2_dep_graph_aaak ?? "");
  const c3 = tok(g.c3_patterns_aaak ?? "");
  const c4 = tok(g.c4_semantic_index_aaak ?? "");
  const c5 = tok(g.c5_evolution_mem_aaak ?? "");
  return { c1, c2, c3, c4, c5, total: c1 + c2 + c3 + c4 + c5 };
}

export function buildGenome(dir: string, projectName: string, now = Date.now()): GenomeBuildResult {
  const files = scanProject(dir);
  const texts = readTexts(files);

  const pointerRows: PointerInput[] = [];
  for (const f of files) {
    const t = texts.get(f.rel);
    if (!t) continue;
    for (const s of extractSymbols(f.rel, t)) {
      pointerRows.push({
        pointerId: `${projectName}:${f.rel}:${s.name}:${s.start}`,
        filePath: f.rel,
        symbolName: s.name,
        symbolKind: s.kind,
        lineStart: s.start,
        lineEnd: s.end,
        tags: s.tags,
      });
    }
  }
  pointerReplaceForProject(projectName, pointerRows);

  const edges = buildEdges(files, texts);
  depEdgesReplace(projectName, aggregateEdges(files, edges), now);

  const c1 = buildC1(dir, files);
  const c2 = buildC2(files, edges);
  const c3 = buildC3(projectName);
  const c4 = buildC4(projectName);
  const c5 = buildC5(projectName, now);
  const tokens = { c1: tok(c1), c2: tok(c2), c3: tok(c3), c4: tok(c4), c5: tok(c5), total: 0 };
  tokens.total = tokens.c1 + tokens.c2 + tokens.c3 + tokens.c4 + tokens.c5;
  genomeUpsert({
    projectName,
    projectPath: dir,
    fileCount: files.length,
    c1,
    c2,
    c3,
    c4,
    c5,
    totalTokens: tokens.total,
    synthesizedAt: now,
  });
  return { ok: true, fileCount: files.length, pointers: pointerRows.length, edges: edges.length, tokens };
}

/** Make a path project-relative, posix style (absolute paths welcome). */
function normalizeRel(p: string, dir?: string | null): string {
  let rel = String(p ?? "").replace(/\\/g, "/");
  if (dir) {
    const d = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
    if (rel.startsWith(`${d}/`)) rel = rel.slice(d.length + 1);
  }
  return rel.replace(/^\/+/, "").replace(/^\.\//, "");
}

/** Incremental AST re-index of just the edited files: pointers + edges. */
export function reindexFiles(dir: string, projectName: string, relFiles: string[], now = Date.now()): number {
  const want = new Set(relFiles.map((f) => normalizeRel(f, dir)).filter(Boolean));
  if (!want.size) return 0;
  const files = scanProject(dir).filter((f) => want.has(f.rel));
  if (!files.length) return 0;
  const texts = readTexts(files);
  const rows: PointerInput[] = [];
  for (const f of files) {
    const t = texts.get(f.rel);
    if (!t) continue;
    for (const s of extractSymbols(f.rel, t)) {
      rows.push({
        pointerId: `${projectName}:${f.rel}:${s.name}:${s.start}`,
        filePath: f.rel,
        symbolName: s.name,
        symbolKind: s.kind,
        lineStart: s.start,
        lineEnd: s.end,
        tags: s.tags,
      });
    }
  }
  const names = files.map((f) => f.rel);
  pointerReplaceForFiles(projectName, names, rows);
  depEdgesDeleteForFiles(projectName, names);
  depEdgesAdd(projectName, aggregateEdges(files, buildEdges(files, texts)), now);
  return rows.length;
}

// ===========================================================================
// Intent triage + the Genome Synthesizer.
// ===========================================================================

const GREET_RE =
  /^\s*(?:hi+|hello+|hey+|yo+|chào(?:\s+bạn|\s+ạ|\s+nhé)?|chao|alo+|xin chào|good\s+(?:morning|afternoon|evening))[\s!.?]*$/i;

const CATEGORIES: Array<[string, RegExp]> = [
  ["add_endpoint", /\b(endpoint|route|api|controller|handler)\b/i],
  ["fix_bug", /\b(fix|bug|lỗi|sửa|sai|error|crash|broken|fail(?:ing|s|ed)?)\b/i],
  ["schema_change", /\b(schema|migration|migrate|model|table|prisma|database|db)\b/i],
  ["ui_component", /\b(component|ui|page|view|screen|modal|button|form)\b/i],
  ["test_suite", /\b(test|tests|spec|coverage)\b/i],
  ["perf_opt", /\b(perf|performance|optimi[sz]e|slow|lag|cache|n\+1)\b/i],
  ["refactor", /\b(refactor|cleanup|restructure|rename|tách)\b/i],
  ["fix_auth", /\b(auth|jwt|token|security|login|session)\b/i],
];

/** Greeting / chit-chat -> null. Technical task -> its category. */
export function taskCategory(text: string): string | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  if (GREET_RE.test(t)) return null;
  for (const [cat, re] of CATEGORIES) if (re.test(t)) return cat;
  return null;
}

export interface SynthOptions {
  project: string;
  projectPath: string;
  sessionID?: string;
  scope?: string;
  /** true in the live prompt hook: once per session per category; false for explicit tool calls. */
  respectWorkingSet?: boolean;
  now?: number;
}

export interface SynthResult {
  category: string;
  text: string;
  tokens: number;
  pointerIds: string[];
  patternId: string | null;
  lessonIds: string[];
  slices: Array<{ file: string; from: number; to: number }>;
}

function pickLessons(project: string, query: string, files: string[], now: number): LessonRow[] {
  const rows = lessonsFor(project, now, 10);
  const qt = new Set(wordTokens(query));
  const scored: Array<{ l: LessonRow; score: number }> = [];
  for (const l of rows) {
    const blob = `${l.bug_summary ?? ""} ${l.fix_method_aaak ?? ""} ${l.file_pointer ?? ""}`;
    let score = 0;
    for (const t of wordTokens(blob)) if (qt.has(t)) score++;
    if (l.severity === "critical") score += 0.5;
    if (l.file_pointer && files.some((f) => String(l.file_pointer).startsWith(f))) score += 2;
    if (score >= 1) scored.push({ l, score });
  }
  scored.sort((a, b) => b.score - a.score || b.l.created_at - a.l.created_at);
  return scored.slice(0, 3).map((s) => s.l);
}

function impactZone(project: string, regionFiles: string[]): string | null {
  if (!regionFiles.length) return null;
  const edges = depEdgesFor(project);
  const rel = edges.filter((e) => regionFiles.includes(e.target_file) || regionFiles.includes(e.source_file)).slice(0, 10);
  if (!rel.length) return null;
  const lines = rel.map((e) => `${e.source_file}->${e.target_file}`);
  return `[C2|impact] ${[...new Set(lines)].slice(0, 8).join(" | ")}`;
}

function readSlice(abs: string, start: number, end: number, maxLines = 40): string | null {
  try {
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const from = Math.max(1, start);
    const to = Math.min(lines.length, Math.max(end, from), from + maxLines - 1);
    if (to < from) return null;
    return lines.slice(from - 1, to).join("\n").slice(0, 4000);
  } catch {
    return null;
  }
}

/**
 * The 5-step protocol: triage -> query chromosomes -> pick Top-3 line ranges
 * -> read ONLY those lines from disk -> assemble the gated packet.
 * Returns null (0 tokens) for greetings, chit-chat and unknown projects.
 */
export function synthGenome(query: string, opts: SynthOptions): SynthResult | null {
  const now = opts.now ?? Date.now();
  const project = String(opts.project ?? "").trim();
  if (!project) return null;

  let category = taskCategory(query);
  const g = genomeGet(project);
  if (!g) return null;
  const pointers = pointerSearch(project, query, 8);
  if (!category) {
    // not a keyword task — only a clear symbol hit justifies spending tokens
    if (!pointers.length) return null;
    category = "general";
  }

  const wsKey = `gpack:${project}:${category}`;
  if (opts.sessionID && opts.respectWorkingSet) {
    try {
      if (l1Keys(opts.sessionID).has(wsKey)) return null;
    } catch {}
  }

  const files = [...new Set(pointers.map((p) => p.file_path))].slice(0, 3);
  const pattern = patternFor(project, category);
  const lessons = pickLessons(project, query, files, now);
  const slicePts: PointerRow[] = [];
  const seenF = new Set<string>();
  for (const p of pointers) {
    if (slicePts.length >= 3) break;
    if (seenF.has(p.file_path)) continue;
    seenF.add(p.file_path);
    slicePts.push(p);
  }
  // C2 assists: pull in each top file's local dependencies for the slices.
  for (const p of slicePts) {
    if (slicePts.length >= 3) break;
    for (const e of depEdgesFor(project, [p.file_path])) {
      if (slicePts.length >= 3) break;
      if (seenF.has(e.target_file)) continue;
      const cand = pointersForFiles(project, [e.target_file]).sort(
        (a, b) => b.relevance_score - a.relevance_score || b.hit_count - a.hit_count || a.line_start - b.line_start,
      )[0];
      if (cand) {
        seenF.add(cand.file_path);
        slicePts.push(cand);
      }
    }
  }
  const regionFiles = [...new Set([...files, ...slicePts.map((p) => p.file_path)])];
  const impact = impactZone(project, regionFiles);

  const parts: string[] = [`[GENOME|${project}|${category}|files:${g.file_count}|synth:${isoDay(now)}]`];
  if (g.c1_arch_dna_aaak) parts.push(g.c1_arch_dna_aaak);
  if (impact) parts.push(impact);
  if (pattern) {
    parts.push(
      `[C3|winner] ${pattern.task_category} [uses:${pattern.usage_count}|sr:${Math.round(pattern.success_rate * 100)}%|~${pattern.avg_tokens_consumed}tok] ${String(pattern.blueprint_aaak ?? "").slice(0, 90)}`,
    );
  }
  if (pointers.length) {
    parts.push(
      `[C4|pointers] ${pointers.slice(0, 8).map((p) => `${p.symbol_name}@${p.file_path}:${p.line_start}-${p.line_end}`).join(" | ")}`,
    );
  }
  if (lessons.length) {
    parts.push(
      `[C5|lessons] ${lessons.map((l) => `[${isoDay(l.created_at)}|bug:${kebab(l.bug_summary ?? "bug", 24)}|fix:${l.fix_method_aaak ?? "fix?"}${l.file_pointer ? `@${l.file_pointer}` : ""}]`).join(" | ")}`,
    );
  }

  let base = parts.join("\n");
  if (tok(base) > PACKET_CAP - 80) base = clampTokens(base, PACKET_CAP - 80);

  // Top-3 surgical slices: read ONLY line_start..line_end, cap ~40 lines each.
  const snippets: string[] = [];
  const slices: Array<{ file: string; from: number; to: number }> = [];
  for (const p of slicePts) {
    if (slices.length >= 3) break;
    const code = readSlice(join(opts.projectPath, p.file_path), p.line_start, p.line_end);
    if (!code) continue;
    const snippet = `[CODE|${p.file_path}:${p.line_start}-${p.line_end}]\n${clampTokens(code, 240)}`;
    if (tok(`${base}\n${[...snippets, snippet].join("\n")}`) > PACKET_CAP) break;
    snippets.push(snippet);
    slices.push({ file: p.file_path, from: p.line_start, to: p.line_end });
  }

  let text = [base, ...snippets].join("\n");
  if (tok(text) > PACKET_CAP) text = clampTokens(text, PACKET_CAP);
  const tokens = tok(text);

  // Token-Darwin: what we injected just paid this price; what helped will be
  // repaid with activations once the task verifies.
  try {
    for (const p of pointers.slice(0, 8)) ledgerTouch({ artifactType: "c4_pointer", artifactId: p.pointer_id, impressions: 1, spent: 6, now });
    if (pattern) ledgerTouch({ artifactType: "c3_pattern", artifactId: pattern.pattern_id, impressions: 1, spent: 14, now });
    for (const l of lessons) ledgerTouch({ artifactType: "c5_lesson", artifactId: l.lesson_id, impressions: 1, spent: 10, now });
    pointerHit(pointers.slice(0, 8).map((p) => p.pointer_id), now);
    lessonHit(lessons.map((l) => l.lesson_id));
  } catch {}

  if (opts.sessionID && opts.respectWorkingSet) {
    try {
      l1MarkKey(opts.sessionID, wsKey, "injected");
    } catch {}
  }

  return {
    category,
    text,
    tokens,
    pointerIds: pointers.slice(0, 8).map((p) => p.pointer_id),
    patternId: pattern?.pattern_id ?? null,
    lessonIds: lessons.map((l) => l.lesson_id),
    slices,
  };
}

// ===========================================================================
// Genome Evolution Engine — fed by tool.execute.after, per session (RAM).
// ===========================================================================

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);
const VERIFY_RE = /\b(?:test|tests|build|lint|typecheck|tsc|check|vitest|jest|pytest)\b/i;
const FAIL_TTL_MS = 2 * 3_600_000;

interface GenomeSess {
  edits: Set<string>;
  lastFail: { cmd: string; output: string; at: number } | null;
  task: { category: string; text: string; at: number } | null;
  touchedAt: number;
}

const gstate = new Map<string, GenomeSess>();

function gst(sid: string): GenomeSess {
  let s = gstate.get(sid);
  if (!s) {
    s = { edits: new Set(), lastFail: null, task: null, touchedAt: 0 };
    gstate.set(sid, s);
  }
  return s;
}

function filePaths(input: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v);
  };
  if (input && typeof input === "object") {
    push(input.filePath);
    push(input.path);
    push(input.file);
    if (Array.isArray(input.files)) input.files.forEach((f: any) => push(typeof f === "string" ? f : f?.path));
    if (Array.isArray(input.edits)) input.edits.forEach((f: any) => push(f?.filePath ?? f?.path));
  }
  return [...new Set(out)];
}

function normCmd(cmd: string): string {
  return String(cmd ?? "").replace(/\s+/g, " ").trim();
}

function cmdFamily(cmd: string): string {
  const m = /^(?:cd\s+\S+\s*&&\s*)?([a-z0-9_.-]+)/i.exec(normCmd(cmd));
  return m ? m[1].slice(0, 16) : "cmd";
}

function bestPointerFor(project: string, files: string[], dir: string | null | undefined, err: string): string | null {
  const rels = files.map((f) => normalizeRel(f, dir)).filter(Boolean).slice(0, 6);
  if (!rels.length) return null;
  const rows = pointersForFiles(project, rels);
  if (!rows.length) return `${rels[rels.length - 1]}:1-1`;
  const et = new Set(wordTokens(err));
  let best = rows[0];
  let bestScore = -1;
  for (const r of rows) {
    let sc = 0;
    for (const t of wordTokens(r.symbol_name)) if (et.has(t)) sc++;
    if (sc > bestScore) {
      bestScore = sc;
      best = r;
    }
  }
  return `${best.file_path}:${best.line_start}-${best.line_end}`;
}

function recordLesson(
  e: { project?: string | null; dir?: string | null; input: any; output?: string },
  s: GenomeSess,
  now: number,
): string | undefined {
  const project = e.project ? String(e.project) : null;
  if (!project || !s.lastFail) return undefined;
  const err = String(s.lastFail.output ?? "").trim();
  const bug = String(err.split("\n").find((l) => l.trim() && /error|err!|fail|exception|traceback|panic/i.test(l)) ?? err.split("\n")[0] ?? "failed command").slice(0, 200);
  const pointer = bestPointerFor(project, [...s.edits], e.dir, err);
  const severity = /\b(security|auth|jwt|xss|injection|secret|token|csrf)\b/i.test(err) ? "critical" : "normal";
  const lessonId = `lesson:${project}:${kebab(bug || String(s.lastFail.cmd), 36)}`;
  lessonUpsert({
    lessonId,
    projectName: project,
    bugSummary: bug || `failed: ${s.lastFail.cmd.slice(0, 80)}`,
    fixAaak: aaakCmd(normCmd(String(e.input?.command ?? ""))),
    filePointer: pointer,
    severity,
    now,
  });
  return lessonId;
}

function recordPattern(
  e: { project?: string | null; dir?: string | null; input: any },
  s: GenomeSess,
  now: number,
): string | undefined {
  const project = e.project ? String(e.project) : null;
  const task = s.task;
  if (!project || !task) return undefined;
  const files = [...s.edits].map((f) => normalizeRel(f, e.dir)).filter(Boolean);
  const bases = files.map((f) => f.split("/").pop()).filter(Boolean).slice(0, 3);
  const blueprint = `${bases.join("->")}|verify:${cmdFamily(String(e.input?.command ?? ""))}`.slice(0, 120);
  const patternId = `${project}:${task.category}`;
  const prev = patternGet(patternId);
  patternUpsert({
    patternId,
    projectName: project,
    taskCategory: task.category,
    triggerKeywords: wordTokens(task.text).slice(0, 8).join(" "),
    blueprintAaak: blueprint,
    targetFiles: files.slice(0, 12),
    avgTokens: 320 + files.length * 90,
    baselineTokens: 8000,
    reinforce: prev != null,
    now,
  });
  return patternId;
}

/**
 * Evolution input: remember the intent of the current user message so a later
 * verify can name the pattern.
 */
export function noteGenomeMessage(e: { sessionID: string; text: string; now?: number }): void {
  const sid = String(e.sessionID ?? "");
  if (!sid) return;
  const s = gst(sid);
  s.touchedAt = e.now ?? Date.now();
  const cat = taskCategory(e.text);
  if (cat) s.task = { category: cat, text: String(e.text ?? "").slice(0, 240), at: s.touchedAt };
}

/**
 * Evolution bookkeeping after every tool call. Edits are buffered; a
 * successful verify after edits crystallizes a C3 pattern and re-indexes
 * ONLY those files; a successful command after a failure writes a C5 lesson.
 */
export function noteGenomeToolAfter(e: {
  sessionID: string;
  tool: string;
  input: any;
  status: string;
  output?: string;
  dir?: string | null;
  project?: string | null;
  now?: number;
}): { patternId?: string; lessonId?: string; reindexed?: number } | null {
  const sid = String(e.sessionID ?? "");
  const tool = String(e.tool ?? "");
  if (!sid || !tool) return null;
  const now = e.now ?? Date.now();
  const s = gst(sid);
  s.touchedAt = now;

  if (EDIT_TOOLS.has(tool)) {
    if (e.status === "completed") for (const f of filePaths(e.input)) s.edits.add(f);
    return null;
  }
  if (!SHELL_TOOLS.has(tool)) return null;
  const cmd = normCmd(String(e.input?.command ?? ""));
  if (!cmd) return null;

  if (e.status === "error") {
    s.lastFail = { cmd, output: String(e.output ?? "").slice(0, 800), at: now };
    return null;
  }
  if (e.status !== "completed") return null;

  const out: { patternId?: string; lessonId?: string; reindexed?: number } = {};

  // failure -> fix: a lesson with the coordinates of the repair (30-day TTL)
  if (s.lastFail && now - s.lastFail.at < FAIL_TTL_MS && s.lastFail.cmd !== cmd) {
    const lessonId = recordLesson(e, s, now);
    if (lessonId) out.lessonId = lessonId;
    s.lastFail = null;
  }

  // edit -> verify: crystallize the winning pattern, re-index just the edits
  if (s.task && s.edits.size && VERIFY_RE.test(cmd) && e.dir && e.project) {
    const patternId = recordPattern(e, s, now);
    if (patternId) out.patternId = patternId;
    out.reindexed = reindexFiles(String(e.dir), String(e.project), [...s.edits], now);
    s.edits.clear();
    s.task = null;
  }

  return Object.keys(out).length ? out : null;
}

/** Idle hygiene: forget RAM journals nobody has touched for 6 hours. */
export function genomeIdleTick(now = Date.now()): number {
  let dropped = 0;
  for (const [sid, s] of gstate) {
    if (now - s.touchedAt > 6 * 3_600_000) {
      gstate.delete(sid);
      dropped++;
    }
  }
  return dropped;
}

export const __internals = { scanProject, extractSymbols, buildC1, buildC2, buildEdges, taskCategory, readSlice, normalizeRel, GREET_RE };
