// ===========================================================================
// corpus.ts — deterministic synthetic-project generator for the CHRONOS-PALACE
// v4.0 head-to-head benchmark.
//
// Why a generator: every contestant must see the *same* corpus at each scale,
// and the corpus must be reproducible byte-for-byte from a seed. The generated
// code is real TypeScript on disk — real files, real relative imports, real
// exported symbols — because `genome.ts` scans the filesystem: extractSymbols()
// needs real `export function` / `router.post(...)` shapes and buildEdges()
// needs real `import ... from "./x"` specifiers.
//
// Size calibration: a file is 30..200 lines (weighted, with a few hub files),
// which lands at ~300-330 tokens/file under the benchmark's token meter. A
// 500-file project therefore measures ~155k tokens of raw source, and 1,000
// files ~310k — i.e. the naive "load the repo into context" cost is real, not
// assumed.
// ===========================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "../aaak";

// ------------------------------------------------------------------ randomness

/** mulberry32 — small, fast, fully deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ------------------------------------------------------------------ vocabulary

const DOMAINS = [
  "flashcards", "auth", "billing", "catalog", "orders", "users", "reports", "notify",
  "media", "search", "spaced", "streaks", "deck", "progress", "sync", "import",
  "export", "settings", "teams", "audit", "quota", "i18n", "upload", "feed",
];

/** The two task anchors every project carries, whatever its size. */
export const ANCHORS = {
  endpoint: { rel: "src/modules/flashcards/routes.ts", symbol: "POST /api/flashcards" },
  auth: { rel: "src/modules/auth/service.ts", symbol: "verifyToken" },
} as const;

// ------------------------------------------------------------------ file bodies

function hedges(r: () => number, n: number): string[] {
  const out: string[] = [];
  const ops = ["toLowerCase", "toUpperCase", "trim", "toFixed(2)", "replace", "split", "slice"];
  for (let i = 0; i < n; i++) {
    const o = pick(r, ops);
    out.push(`  const ${pick(r, ["a", "b", "c", "tmp", "acc", "norm", "raw", "out", "buf", "meta"])}${i} = ${pick(r, ["String(v)", "opts.name", "row.id", "input.value", "this.cache", "payload.data", "idx", "Date.now()"])}.${o}();`);
  }
  return out;
}

/** A module `service.ts`: exported functions with real-ish bodies. */
function serviceFile(mod: string, deps: string[], r: () => number): string {
  const cap = mod[0].toUpperCase() + mod.slice(1);
  const L: string[] = [];
  for (const d of deps) L.push(`import { ${d.replace(/[^a-z]/gi, "")}Guard } from "./${d}";`);
  L.push(`import { httpGet, httpPost } from "../../core/http";`, ``);
  L.push(`export interface ${cap}Record {`, `  id: string;`, `  name: string;`,
    `  state: "draft" | "live" | "archived";`, `  updatedAt: number;`, `}`, ``);
  L.push(`const cache = new Map<string, ${cap}Record>();`, ``);
  L.push(`export async function load${cap}(id: string): Promise<${cap}Record | null> {`,
    `  const hit = cache.get(id);`, `  if (hit) return hit;`,
    `  const row = await httpGet<${cap}Record>(\`/api/${mod}/\${id}\`);`,
    ...hedges(r, int(r, 3, 6)),
    `  if (!row) return null;`, `  cache.set(id, row);`, `  return row;`, `}`, ``);
  L.push(`export async function save${cap}(rec: ${cap}Record): Promise<${cap}Record> {`,
    `  const body = { ...rec, updatedAt: Date.now() };`,
    ...hedges(r, int(r, 3, 5)),
    `  const saved = await httpPost<${cap}Record>(\`/api/${mod}\`, body);`,
    `  cache.set(saved.id, saved);`, `  return saved;`, `}`, ``);
  L.push(`export function invalidate${cap}(id?: string): void {`,
    `  if (id) cache.delete(id);`, `  else cache.clear();`, `}`, ``);
  L.push(`export function list${cap}Keys(): string[] {`, ...hedges(r, int(r, 2, 4)), `  return [...cache.keys()];`, `}`, ``);
  L.push(`export function validate${cap}(input: unknown): ${cap}Record {`,
    `  const raw = (input ?? {}) as Partial<${cap}Record>;`,
    ...hedges(r, int(r, 4, 7)),
    `  if (!raw.id) throw new Error("${mod}: id is required");`,
    `  if (!raw.name || raw.name.length < 1) throw new Error("${mod}: name is required");`,
    `  return {`,
    `    id: String(raw.id),`,
    `    name: String(raw.name).slice(0, 120),`,
    `    state: raw.state === "live" || raw.state === "archived" ? raw.state : "draft",`,
    `    updatedAt: raw.updatedAt ?? Date.now(),`,
    `  };`, `}`, ``);
  L.push(`export function summarize${cap}(rec: ${cap}Record): string {`,
    ...hedges(r, int(r, 2, 4)),
    `  return \`\${rec.name} [\${rec.state}] since \${new Date(rec.updatedAt).toISOString()}\`;`, `}`);
  return L.join("\n") + "\n";
}

/** A module `routes.ts`: real `router.get/post` shapes so extractSymbols() sees routes. */
function routesFile(mod: string, r: () => number): string {
  const cap = mod[0].toUpperCase() + mod.slice(1);
  const L: string[] = [];
  L.push(`import { Router } from "../core/router";`);
  L.push(`import { load${cap}, save${cap}, invalidate${cap}, type ${cap}Record } from "./service";`, ``);
  L.push(`export const router = new Router();`, ``);
  L.push(`router.get("/api/${mod}", async (req: any, res: any) => {`, ...hedges(r, int(r, 3, 5)),
    `  res.json({ items: await load${cap}(req.query.id), page: req.query.page ?? 1 });`, `});`, ``);
  L.push(`router.post("/api/${mod}", async (req: any, res: any) => {`,
    `  const rec = req.body as ${cap}Record;`, ...hedges(r, int(r, 4, 7)),
    `  const saved = await save${cap}(rec);`, `  invalidate${cap}(saved.id);`,
    `  res.status(201).json(saved);`, `});`, ``);
  L.push(`router.patch("/api/${mod}/:id", async (req: any, res: any) => {`,
    `  const current = await load${cap}(req.params.id);`,
    `  if (!current) { res.status(404).json({ error: "not found" }); return; }`,
    ...hedges(r, int(r, 3, 6)),
    `  res.json(await save${cap}({ ...current, ...req.body }));`, `});`, ``);
  L.push(`router.delete("/api/${mod}/:id", async (req: any, res: any) => {`,
    ...hedges(r, int(r, 2, 4)), `  invalidate${cap}(req.params.id);`, `  res.status(204).end();`, `});`);
  return L.join("\n") + "\n";
}

/** A module `model.ts`. */
function modelFile(mod: string, r: () => number): string {
  const cap = mod[0].toUpperCase() + mod.slice(1);
  const L: string[] = [];
  L.push(`import type { Db } from "../../core/db";`, ``);
  L.push(`export interface ${cap}Row {`, `  id: string;`, `  owner_id: string;`,
    `  payload: unknown;`, `  created_at: number;`, `}`, ``);
  L.push(`export class ${cap}Model {`, `  constructor(private readonly db: Db) {}`, ``,
    `  async find(owner: string): Promise<${cap}Row[]> {`,
    ...hedges(r, int(r, 3, 6)).map((s) => "  " + s),
    `    return this.db.query<${cap}Row>("select * from ${mod} where owner_id = ?", [owner]);`,
    `  }`, ``, `  async insert(row: ${cap}Row): Promise<void> {`,
    ...hedges(r, int(r, 2, 5)).map((s) => "  " + s),
    `    await this.db.exec("insert into ${mod} ...", row);`, `  }`, ``,
    `  async update(id: string, patch: Partial<${cap}Row>): Promise<number> {`,
    ...hedges(r, int(r, 3, 6)).map((s) => "  " + s),
    `    const rows = await this.db.query<${cap}Row>("select * from ${mod} where id = ?", [id]);`,
    `    if (!rows.length) return 0;`,
    `    await this.db.exec("update ${mod} set payload = ? where id = ?", [patch.payload, id]);`,
    `    return 1;`, `  }`, ``,
    `  async remove(id: string): Promise<boolean> {`,
    `    const rows = await this.db.query<${cap}Row>("select * from ${mod} where id = ?", [id]);`,
    `    if (!rows.length) return false;`,
    `    await this.db.exec("delete from ${mod} where id = ?", [id]);`,
    `    return true;`, `  }`, `}`);
  return L.join("\n") + "\n";
}

/** A module `index.ts` barrel + guard. */
function indexFile(mod: string, deps: string[], r: () => number): string {
  const cap = mod[0].toUpperCase() + mod.slice(1);
  const L: string[] = [];
  L.push(`export * from "./service";`, `export * from "./model";`, `export { router as ${mod}Router } from "./routes";`, ``);
  L.push(`export interface ${cap}Guard {`, `  allow(op: string): boolean;`, `}`, ``);
  L.push(`export function ${cap}Guard(): ${cap}Guard {`);
  for (const d of deps) L.push(`  void ${d.replace(/[^a-z]/gi, "")}Guard;`);
  L.push(...hedges(r, int(r, 2, 4)));
  L.push(`  return { allow: (op: string) => op.length > 0 };`, `}`, ``);
  L.push(`export const ${mod.toUpperCase()}_MODULE = "${mod}";`);
  return L.join("\n") + "\n";
}

/** `auth/service.ts` — carries the fix_auth_bug anchor. */
function authService(r: () => number): string {
  const L: string[] = [];
  L.push(`import { createHmac } from "node:crypto";`, `import { httpPost } from "../../core/http";`, ``);
  L.push(`export interface TokenClaims {`, `  sub: string;`, `  scope: string[];`, `  exp: number;`, `}`, ``);
  L.push(`const SECRET = process.env.AUTH_SECRET ?? "dev-secret";`, ``);
  L.push(`export function signToken(claims: TokenClaims): string {`,
    `  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");`,
    `  const mac = createHmac("sha256", SECRET).update(body).digest("base64url");`,
    `  return \`\${body}.\${mac}\`;`, `}`, ``);
  L.push(`export function verifyToken(token: string): TokenClaims | null {`,
    `  const [body, mac] = String(token ?? "").split(".");`,
    `  if (!body || !mac) return null;`,
    `  const expect = createHmac("sha256", SECRET).update(body).digest("base64url");`,
    `  if (expect !== mac) return null;`,
    ...hedges(r, int(r, 3, 6)),
    `  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims;`,
    `  if (claims.exp * 1000 < Date.now()) return null;`,
    `  return claims;`, `}`, ``);
  L.push(`export async function refresh(claims: TokenClaims): Promise<string> {`,
    `  const rotated = await httpPost<{ ok: boolean }>("/api/auth/refresh", claims);`,
    `  if (!rotated.ok) throw new Error("refresh rejected");`,
    `  return signToken({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });`, `}`);
  return L.join("\n") + "\n";
}

/** Supporting library / core files. */
function libFile(name: string, r: () => number): string {
  const L: string[] = [];
  L.push(`// ${name} — shared runtime helper`, `import { estimateTokens } from "./tokens";`, ``);
  L.push(`export interface ${name[0].toUpperCase() + name.slice(1)}Options {`, `  limit: number;`, `  strict?: boolean;`, `}`, ``);
  L.push(`export class ${name[0].toUpperCase() + name.slice(1)}Pool {`,
    `  private readonly items: unknown[] = [];`, ``,
    `  constructor(private readonly opts: ${name[0].toUpperCase() + name.slice(1)}Options) {}`, ``,
    `  add(item: unknown): number {`, ...hedges(r, int(r, 3, 6)), `    this.items.push(item);`,
    `    return this.items.length;`, `  }`, ``, `  size(): number { return this.items.length; }`, `}`, ``);
  L.push(`export function withRetry<T>(fn: () => Promise<T>, tries = ${int(r, 2, 4)}): Promise<T> {`,
    `  let last: unknown;`, `  return (async () => {`,
    `    for (let i = 0; i < tries; i++) {`, `      try { return await fn(); } catch (e) { last = e; }`, `    }`,
    `    throw last;`, `  })();`, `}`, ``);
  L.push(`export function meter(text: string): number {`, ...hedges(r, int(r, 2, 4)), `  return estimateTokens(text);`, `}`, ``);
  L.push(`export function debounce<A extends unknown[]>(fn: (...a: A) => void, waitMs = ${int(r, 60, 240)}): (...a: A) => void {`,
    `  let handle: ReturnType<typeof setTimeout> | null = null;`,
    `  return (...args: A) => {`, `    if (handle) clearTimeout(handle);`,
    `    handle = setTimeout(() => fn(...args), waitMs);`, `  };`, `}`, ``);
  L.push(`export function chunk<T>(items: T[], size = ${int(r, 16, 64)}): T[][] {`,
    `  const out: T[][] = [];`,
    `  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));`,
    `  return out;`, `}`);
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------ generator

export interface GeneratedProject {
  name: string;
  root: string;
  files: string[];
  /** raw source tokens of every code file (the naive full-context cost) */
  rawTokens: number;
  rawBytes: number;
  /** grep-able facts used by the token models of the rival systems */
  moduleCount: number;
  targetFileTokens: number;
  authFileTokens: number;
  /** a real grep over the corpus for the task keyword */
  grepHits: number;
  grepTokens: number;
}

/** Weighted line count: mostly 40-90, a tail of hub files up to 200. */
function lineTarget(r: () => number): number {
  const u = r();
  if (u < 0.08) return int(r, 120, 200);
  if (u < 0.45) return int(r, 30, 60);
  return int(r, 60, 120);
}

export function generateProject(root: string, name: string, nFiles: number, seed = 42): GeneratedProject {
  const r = rng(seed);
  const files: { rel: string; body: string }[] = [];

  files.push({
    rel: "package.json",
    body: JSON.stringify(
      {
        name, version: "1.0.0", type: "module",
        dependencies: { express: "^5.0.0", zod: "^3.23.0", prisma: "^6.0.0", "jsonwebtoken": "^9.0.0" },
        devDependencies: { typescript: "^5.6.0", vitest: "^2.0.0" },
      },
      null,
      2,
    ),
  });
  files.push({
    rel: "src/core/http.ts",
    body: `export async function httpGet<T>(url: string): Promise<T | null> {\n  const r = await fetch(url);\n  if (!r.ok) return null;\n  return (await r.json()) as T;\n}\n\nexport async function httpPost<T>(url: string, body: unknown): Promise<T> {\n  const r = await fetch(url, { method: "POST", body: JSON.stringify(body) });\n  return (await r.json()) as T;\n}\n`,
  });
  files.push({
    rel: "src/core/db.ts",
    body: `export interface Db {\n  query<T>(sql: string, args: unknown[]): Promise<T[]>;\n  exec(sql: string, args: unknown): Promise<void>;\n}\n\nexport function createDb(): Db {\n  return {\n    query: async <T>() => [] as T[],\n    exec: async () => {},\n  };\n}\n`,
  });
  files.push({
    rel: "src/core/tokens.ts",
    body: `export function estimateTokens(s: string): number {\n  return Math.max(1, Math.ceil(String(s).length / 4));\n}\n`,
  });

  // The auth module is always present — it carries the fix_auth_bug anchor.
  files.push({ rel: ANCHORS.auth.rel, body: authService(r) });
  for (const p of ["guards.ts", "store.ts", "refresh.ts"]) {
    files.push({ rel: `src/modules/auth/${p}`, body: libFile(p.replace(".ts", ""), r) });
  }

  // Flashcards module carries the add_endpoint anchor. It is rendered by the
  // same code path as every other module, but at index 0 of DOMAINS.
  const budget = Math.max(6, nFiles - files.length);
  const perModule = 4; // service, routes, model, index
  const modules = Math.max(1, Math.ceil((budget - 2) / perModule));

  for (let i = 0; i < modules; i++) {
    const mod = DOMAINS[i % DOMAINS.length] + (i >= DOMAINS.length ? String(Math.floor(i / DOMAINS.length) + 1) : "");
    const deps = i > 0 ? [DOMAINS[(i - 1) % DOMAINS.length]] : [];
    files.push({ rel: `src/modules/${mod}/service.ts`, body: serviceFile(mod, deps, r) });
    files.push({ rel: `src/modules/${mod}/routes.ts`, body: routesFile(mod, r) });
    files.push({ rel: `src/modules/${mod}/model.ts`, body: modelFile(mod, r) });
    files.push({ rel: `src/modules/${mod}/index.ts`, body: indexFile(mod, deps, r) });
  }

  // Pad with shared library files until the requested scale is reached.
  let k = 0;
  while (files.length < nFiles) {
    const stem = `${pick(r, DOMAINS)}${k % 7 === 0 ? "Utils" : ""}${k}`;
    files.push({ rel: `src/lib/${stem}.ts`, body: libFile(stem.toLowerCase(), r) });
    k++;
    if (k > nFiles * 3) break;
  }

  let rawTokens = 0;
  let rawBytes = 0;
  for (const f of files) {
    const abs = join(root, f.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.body, "utf8");
    rawBytes += Buffer.byteLength(f.body, "utf8");
    if (f.rel.endsWith(".ts")) rawTokens += estimateTokens(f.body);
  }

  const byRel = new Map(files.map((f) => [f.rel, f.body]));
  const targetBody = byRel.get(ANCHORS.endpoint.rel) ?? "";
  const authBody = byRel.get(ANCHORS.auth.rel) ?? "";

  // A real keyword grep over the corpus, as a sub-agent explorer would run it.
  const kw = ["flashcard", "token", "verify", "routes", "service"];
  let grepTokens = 0;
  let grepHits = 0;
  for (const f of files) {
    for (const line of f.body.split("\n")) {
      if (kw.some((w) => line.toLowerCase().includes(w))) {
        grepHits++;
        grepTokens += estimateTokens(`src/…/${f.rel.split("/").pop()}:${line.trim()}`);
      }
    }
  }

  return {
    name,
    root,
    files: files.map((f) => f.rel),
    rawTokens,
    rawBytes,
    moduleCount: modules,
    targetFileTokens: estimateTokens(targetBody),
    authFileTokens: estimateTokens(authBody),
    grepHits,
    grepTokens,
  };
}
