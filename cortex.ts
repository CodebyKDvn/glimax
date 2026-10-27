// ===========================================================================
// cortex.ts — the self-learning cerebellum of chronos-memory v3.0.
//
// Five deterministic engines. Zero LLM calls, zero context tokens, pure
// TypeScript over the event stream and SQLite:
//
//   1  TRAJECTORY COMPILER  observes tool.execute.after; when a failed
//                           command is followed by the command that fixed
//                           it, it compiles an AAAK reflex engram:
//                           [REFLEX|scope|when:…|avoid:!cmd:…|win:do:…]
//   2  INTERCEPTOR ENGINE   promotes *proven* failure -> fix pairs into
//                           l2_subconscious_interceptors. Those rewrite
//                           commands inside tool.execute.before — the
//                           lesson costs 0 tokens from then on.
//   3  WORKSPACE AUTOPHAGY  digests package.json / lockfiles / AGENTS.md …
//                           once per workspace change, so project rules and
//                           exact commands become memory nodes, never
//                           context novelas the user had to write.
//   4  DEAD-END PRUNER      on session.idle, keeps only the winning path:
//                           intent -> core files -> verifying command.
//   5  HEBBIAN CONSOLIDATOR merges matured engrams of one topic into a
//                           single short rule and retires the rest. The
//                           brain consumes FEWER tokens as it learns more.
//
// Everything is defensive: a broken brain degrades to a normal OpenCode.
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  aaakAntiCmd,
  aaakCmd,
  engramKey,
  estimateTokens,
  hash32,
  kebab,
  tokens,
} from "./aaak";
import {
  BRAIN_PATH,
  type Interceptor,
  type L3Row,
  type Macro,
  type ProceduralEngram,
  activeInterceptors,
  assertEdge,
  bumpInterceptorHit,
  bumpMacroUse,
  engramStats,
  engramsLive,
  getMacro,
  interceptorStats,
  l3ForSession,
  l3Insert,
  macroCommands,
  macroList,
  macroStats,
  recordInterceptorProof,
  retireEngrams,
  updateEngramMerged,
  upsertEngram,
  upsertMacro,
  topEngrams,
} from "./db";
import { detectUserCorrection, filePathsOfRow, firstErrorLine } from "./extractor";

// ------------------------------------------------------------------ tuning

/** One avoided dead-end turn is worth ~45 tokens of context. */
export const TOKENS_PER_AVOIDED_STEP = 45;
const FIX_TTL_MS = 20 * 60 * 1000; // a fix must follow its failure within 20 min
const MACRO_TTL_MS = 30 * 60 * 1000; // pair members must be close in time

const SHELL_TOOLS = new Set(["shell", "bash", "sh"]);
/** Interceptor rows always live under this family name for shell tools. */
const CANON_SHELL = "bash";
const TARGET_PM = new Set(["bun", "bunx", "pnpm", "yarn"]);
const SOURCE_PM = new Set(["npm", "npx", "yarn", "pnpm"]);
const PM_TOKENS = ["bunx", "bun", "npx", "npm", "pnpm", "yarn"];

export interface CortexCtx {
  sessionID: string;
  scope: string;
  stacks?: string[];
  dir?: string;
  project?: string | null;
  now?: number;
}

// -------------------------------------------------------- session journals
//
// RAM only, per session, wiped when the plugin unloads. These are the
// "hands" buffers the compiler reads: the last failure, the recent wins,
// and how often a command pair has been seen.

interface FailureNote {
  cmd: string;
  output: string;
  at: number;
  ctx: CortexCtx;
}

interface WinNote {
  cmd: string;
  at: number;
  ms: number;
}

const pendingFailures = new Map<string, FailureNote>();
const recentWins = new Map<string, WinNote[]>();
const seqSeen = new Map<string, number>();

// ===========================================================================
// 1 + 2 — trajectory & error-to-fix compiler, interceptor proofs
// ===========================================================================

/**
 * Called from tool.execute.after (deferred). Feeds the RAM journals,
 * crystallizes macros, and pairs failure -> fix into engrams/interceptors.
 * Returns what was learned, for logging/tests.
 */
export function noteToolAfter(
  e: CortexCtx & { tool: string; input: any; status: string; output: string; durationMs?: number },
): { engramId?: number; interceptorId?: number; macroId?: string } | null {
  const tool = String(e?.tool ?? "");
  if (!SHELL_TOOLS.has(tool)) return null;
  const cmd = normCmd(String(e?.input?.command ?? ""));
  if (!cmd) return null;
  const now = e.now ?? Date.now();
  const sessionID = String(e.sessionID ?? "");
  if (!sessionID) return null;

  if (e.status === "error" || outputLooksFailed(e.output)) {
    pendingFailures.set(sessionID, {
      cmd,
      output: String(e?.output ?? "").slice(0, 1200),
      at: now,
      ctx: e,
    });
    return null;
  }
  if (e.status !== "completed") return null;

  // --- journal the win; try to crystallize a repeated pair into a macro
  const wins = recentWins.get(sessionID) ?? [];
  wins.push({ cmd, at: now, ms: e.durationMs ?? 0 });
  recentWins.set(sessionID, wins.slice(-14));
  const macroId = maybeCrystallize(e, now) ?? undefined;

  // --- failure -> fix pairing (the single most valuable signal)
  const f = pendingFailures.get(sessionID);
  let engramId: number | undefined;
  let interceptorId: number | undefined;
  if (f && now - f.at <= FIX_TTL_MS && normCmd(f.cmd) !== cmd) {
    pendingFailures.delete(sessionID);
    interceptorId = maybeInterceptorProof(f, cmd, e, now) ?? undefined;

    const when = errorSignature(f.output, f.cmd);
    const anti = aaakAntiCmd(f.cmd);
    const win = aaakCmd(cmd);
    const r = upsertEngram({
      engramKey: engramKey(e.scope, when, win),
      scope: e.scope,
      trigger: `${when} ${firstFailureLine(f.output)} ${f.cmd} ${cmd}`.slice(0, 220),
      anti,
      fastPath: `do:${win}`,
      macroId: macroId ?? null,
      tokenSaved: TOKENS_PER_AVOIDED_STEP,
      now,
    });
    if (r) {
      engramId = r.id;
      if (!r.reinforced) {
        logL3(e, {
          kind: "cortex_engram",
          content: `[REFLEX|${when}|avoid:${anti}|win:do:${win}]`,
          meta: { engram: r.id, scope: e.scope },
          now,
        });
      }
    }
  }
  return { engramId, interceptorId, macroId };
}

/**
 * The user said "sai rồi" / "đừng làm thế" / "dùng X đi": the last successful
 * command is (re)classified as a dead end, so the next different command
 * that works becomes the winning half of the reflex.
 */
export function noteUserMessage(e: CortexCtx & { text: string }): void {
  if (!detectUserCorrection(e.text)) return;
  const sessionID = String(e.sessionID ?? "");
  if (!sessionID) return;
  const now = e.now ?? Date.now();
  const wins = recentWins.get(sessionID);
  const last = wins?.[wins.length - 1];
  if (!last || now - last.at > FIX_TTL_MS) return;
  pendingFailures.set(sessionID, {
    cmd: last.cmd,
    output: `user_correction: ${normCmd(e.text).slice(0, 140)}`,
    at: now,
    ctx: e,
  });
  logL3(e, {
    kind: "cortex_correction",
    content: `[user_correction] ${normCmd(e.text).slice(0, 140)} (rejected: ${last.cmd})`,
    now,
  });
  recentWins.set(sessionID, (wins ?? []).slice(0, -1));
}

/**
 * When the failed command and the winning one are the same command under a
 * different package manager (`npm test` -> `bun test`), register an
 * interceptor proof. Two proofs activate it; from then on the rewrite
 * happens inside tool.execute.before with 0 context tokens.
 */
function maybeInterceptorProof(f: FailureNote, winCmd: string, e: CortexCtx, now: number): number | null {
  const pmA = pkgManagerOf(f.cmd);
  const pmB = pkgManagerOf(winCmd);
  if (!pmA || !pmB || pmA === pmB) return null;
  if (!SOURCE_PM.has(pmA) || !TARGET_PM.has(pmB)) return null;
  const restA = restOf(f.cmd, pmA);
  const restB = restOf(winCmd, pmB);
  if (!restA || restA !== restB) return null; // only exact-mirror swaps auto-register

  const stacks = e.stacks ?? [];
  const ruleScope = stacks.includes("bun") || pmB.startsWith("bun") ? "stack:bun" : e.scope;
  const pattern = `^${pmA}\\s+${escapeRe(restA)}(\\s|$)`;
  const payload = `${pmB} ${restA}$1`;
  const r = recordInterceptorProof({
    scope: ruleScope,
    toolName: CANON_SHELL,
    pattern,
    action: "rewrite_arg",
    payload,
    now,
  });
  if (!r) return null;
  invalidateInterceptorCache();
  logL3(e, {
    kind: "cortex_interceptor",
    content: `[IC|${pmA}->${pmB}|${restA}] conf:${r.confidence} ${r.active ? "active" : "arming"} hits:${r.hitCount}`,
    meta: { interceptor: r.id, scope: ruleScope },
    now,
  });
  return r.id;
}

// ===========================================================================
// 2b — subconscious interception (tool.execute.before, 0 tokens)
// ===========================================================================

let icCache: { key: string; at: number; rules: Interceptor[] } | null = null;
const IC_TTL_MS = 3000;

export function invalidateInterceptorCache(): void {
  icCache = null;
}

function interceptorsFor(scope: string, stacks: string[], toolName: string): Interceptor[] {
  const key = [scope, ...(stacks ?? [])].join("|") + "|" + toolName;
  const now = Date.now();
  if (icCache && icCache.key === key && now - icCache.at < IC_TTL_MS) return icCache.rules;
  const scopes = [scope, ...(stacks ?? []).map((s) => (s.startsWith("stack:") ? s : `stack:${s}`))];
  const rules = activeInterceptors(scopes, toolName);
  icCache = { key, at: now, rules };
  return rules;
}

/**
 * The 0-token rewrite. Synchronous, sub-millisecond, never throws: the hook
 * in index.ts simply assigns the returned command back onto the tool input.
 */
export function interceptCommand(e: {
  tool: string;
  command: string;
  scope: string;
  stacks?: string[];
}): { command: string; hits: number[] } {
  const cmd0 = String(e?.command ?? "");
  const out: { command: string; hits: number[] } = { command: cmd0, hits: [] };
  if (!cmd0.trim()) return out;
  const tool = String(e?.tool ?? "");
  const fam = SHELL_TOOLS.has(tool) ? CANON_SHELL : tool;
  let cmd = cmd0;
  for (const r of interceptorsFor(String(e?.scope ?? "global"), e?.stacks ?? [], fam)) {
    try {
      if (!r.match_pattern || !r.replacement_payload) continue;
      const re = new RegExp(r.match_pattern);
      if (!re.test(cmd)) continue;
      const next = applyInterceptor(cmd, r);
      if (next && next !== cmd) {
        cmd = next;
        out.hits.push(r.id);
      }
    } catch {}
  }
  out.command = cmd;
  return out;
}

function applyInterceptor(cmd: string, r: Interceptor): string {
  if (r.replacement_action === "rewrite_arg") {
    return cmd.replace(new RegExp(r.match_pattern), r.replacement_payload);
  }
  if (r.replacement_action === "append_flag") {
    return cmd.includes(r.replacement_payload) ? cmd : `${cmd} ${r.replacement_payload}`;
  }
  const p = r.replacement_payload.trim();
  if (!p || cmd.startsWith(p + " ")) return cmd;
  return `${p} ${cmd}`;
}

/** An interception actually fired: bump counters and journal it. */
export function recordInterception(e: CortexCtx & { original: string; rewritten: string; hits: number[] }): void {
  if (!e.hits?.length) return;
  for (const id of e.hits) bumpInterceptorHit(id);
  invalidateInterceptorCache();
  logL3(e, {
    kind: "cortex_intercept",
    content: `[intercept] ${normCmd(e.original)} -> ${normCmd(e.rewritten)}`,
    meta: { ids: e.hits, tokens_saved: e.hits.length * TOKENS_PER_AVOIDED_STEP },
  });
}

// ===========================================================================
// 3 — workspace autophagy: config in, memory nodes out (< 5 ms)
// ===========================================================================

export interface WorkspaceDNA {
  dir: string;
  pm: string | null;
  kind: string | null;
  stacks: string[];
  scripts: Record<string, string>;
  rules: number;
}

const DIGEST_CACHE = new Map<string, { sig: string; dna: WorkspaceDNA }>();

const MANIFEST_FILES = [
  "package.json", "tsconfig.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml",
  "yarn.lock", "package-lock.json", "Cargo.toml", "pyproject.toml", "uv.lock",
  "Makefile", "Dockerfile", "AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md",
];

/** Script name -> the DNA slot the snapshot knows how to render. */
const SCRIPT_SLOTS: Record<string, string> = {
  test: "test_command",
  build: "build_command",
  dev: "dev_command",
  lint: "lint_command",
  typecheck: "typecheck_command",
  format: "formatter",
};

const RULE_MD = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CONTRIBUTING.md"];
const RULE_LINE = /\b(MUST|NEVER|ALWAYS|luôn|không được|đừng|do not|don't|always|never)\b/i;
const CMD_IN_LINE =
  /`([^`\n]{2,90})`|(?:run|chạy|use|dùng)\s+((?:bun|npm|pnpm|yarn|npx|bunx|cargo|uv|make|git|go|docker)\b[\w./:-]*(?:\s+[\w./:-]+){0,3})/i;

/**
 * Read the workspace's own files and turn them into memory: exact commands
 * for every standard script, the package manager the lockfile mandates, the
 * stack scopes, and the MUST/NEVER rules from any agent-instruction file.
 * Cached per directory until a manifest changes.
 */
export function digestWorkspaceDNA(dir: string, scope: string, now = Date.now()): WorkspaceDNA {
  const d = String(dir ?? "");
  const out: WorkspaceDNA = { dir: d, pm: null, kind: null, stacks: [], scripts: {}, rules: 0 };
  if (!d) return out;
  try {
    const sig = digestSig(d);
    const cached = DIGEST_CACHE.get(d);
    if (cached && cached.sig === sig) return cached.dna;

    const pkg = readJson(join(d, "package.json"));
    const hasBun = existsSync(join(d, "bun.lockb")) || existsSync(join(d, "bun.lock"));
    const hasPnpm = existsSync(join(d, "pnpm-lock.yaml"));
    const hasYarn = existsSync(join(d, "yarn.lock"));
    const hasNpm = existsSync(join(d, "package-lock.json"));
    const hasCargo = existsSync(join(d, "Cargo.toml"));
    const hasUv = existsSync(join(d, "uv.lock"));
    const hasPy = existsSync(join(d, "pyproject.toml")) || existsSync(join(d, "requirements.txt"));
    const hasMake = existsSync(join(d, "Makefile"));

    let pm: string | null = null;
    if (hasBun) pm = "bun";
    else if (hasPnpm) pm = "pnpm";
    else if (hasYarn) pm = "yarn";
    else if (hasNpm) pm = "npm";
    else if (pkg) pm = "npm";
    else if (hasCargo) pm = "cargo";
    else if (hasUv) pm = "uv";
    else if (hasPy) pm = "python";
    out.pm = pm;
    out.kind = hasCargo ? "rust" : pkg ? (hasBun ? "bun" : "node") : hasPy ? "python" : null;

    // --- exact commands for the standard scripts
    if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
      const names = Object.keys(pkg.scripts).filter((n) => /^[\w:-]{1,40}$/.test(n));
      const wanted = ["dev", "build", "test", "lint", "typecheck", "check", "format"].filter((n) =>
        names.includes(n),
      );
      const dbish = names.filter((n) => n.startsWith("db:") || n.startsWith("db-")).slice(0, 3);
      for (const name of [...wanted, ...dbish].slice(0, 8)) {
        out.scripts[name] = runCmdFor(pm ?? "npm", name);
      }
    }
    if (hasCargo) {
      out.scripts.build = out.scripts.build ?? "cargo build";
      out.scripts.test = out.scripts.test ?? "cargo test";
      out.scripts.check = out.scripts.check ?? "cargo check";
    }
    if (hasPy) out.scripts.test = out.scripts.test ?? (hasUv ? "uv run pytest" : "pytest");
    if (hasMake) {
      const mf = readText(join(d, "Makefile"), 20_000) ?? "";
      for (const t of ["test", "build"]) {
        if (new RegExp(`^${t}\\s*:`, "m").test(mf)) out.scripts[t] = out.scripts[t] ?? `make ${t}`;
      }
    }

    // --- stack scopes: stack:<tech>, used to generalize interceptors
    const stack = new Set<string>();
    if (pm) stack.add(pm);
    if (pkg) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const keys = Object.keys(deps).map((k) => k.toLowerCase());
      if (keys.includes("typescript") || existsSync(join(d, "tsconfig.json"))) stack.add("ts");
      const TAGS: Array<[string, string]> = [
        ["next", "next"], ["react", "react"], ["vue", "vue"], ["svelte", "svelte"],
        ["prisma", "prisma"], ["drizzle-orm", "drizzle"], ["vitest", "vitest"],
        ["jest", "jest"], ["vite", "vite"], ["tailwindcss", "tailwind"],
      ];
      for (const [dep, tag] of TAGS) if (keys.includes(dep)) stack.add(tag);
    }
    if (hasCargo) stack.add("rust");
    if (hasPy) stack.add("python");
    out.stacks = [...stack].slice(0, 6);

    // --- persist as memory nodes (assertEdge reinforces on re-digest)
    for (const [name, run] of Object.entries(out.scripts)) {
      const subject = SCRIPT_SLOTS[name] ?? `script:${name}`;
      assertEdge({
        scope,
        category: "workflow_habit",
        subject,
        predicate: "uses",
        object: run,
        aaak: `[MEM|wfh|${subject}=${run}]`,
        confidence: 0.7,
        now,
      });
    }
    out.rules = digestRules(d, scope, now);

    DIGEST_CACHE.set(d, { sig, dna: out });
    return out;
  } catch {
    return out;
  }
}

function digestSig(dir: string): string {
  const bits: string[] = [];
  for (const f of MANIFEST_FILES) {
    try {
      const st = statSync(join(dir, f));
      bits.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      bits.push(`${f}:-`);
    }
  }
  return bits.join("|");
}

/** Digest MUST/NEVER rules from agent-instruction files into nodes + engrams. */
function digestRules(dir: string, scope: string, now: number): number {
  let n = 0;
  for (const f of RULE_MD) {
    if (n >= 12) break;
    const text = readText(join(dir, f), 32_000);
    if (!text) continue;
    for (const raw of text.split("\n")) {
      if (n >= 12) break;
      const line = raw
        .replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (line.length < 8 || line.length > 160) continue;
      if (line.startsWith("#") || line.startsWith("```")) continue;
      if (!RULE_LINE.test(line)) continue;
      const never = /(?:NEVER|không được|đừng|do not|don't|never)/i.test(line);
      const cmdM = CMD_IN_LINE.exec(line);
      const cmd = String(cmdM ? (cmdM[1] ?? cmdM[2] ?? "") : "").trim();
      assertEdge({
        scope,
        category: never ? "constraint" : "workflow_habit",
        subject: "rule:" + kebab(line, 40),
        predicate: never ? "forbid" : "require",
        object: line.slice(0, 120),
        aaak: `[MEM|${never ? "con" : "wfh"}|rule:${kebab(line, 32)}]`,
        confidence: 0.75,
        now,
      });
      if (cmd && cmd.length >= 2) {
        upsertEngram({
          engramKey: engramKey(scope, `rule:${kebab(line, 36)}`, `do:${aaakCmd(cmd)}`),
          scope,
          trigger: line.slice(0, 200),
          anti: never ? `!rule:${kebab(line, 40)}` : null,
          fastPath: `do:${aaakCmd(cmd)}`,
          tokenSaved: 0,
          now,
        });
      }
      n++;
    }
  }
  return n;
}

// ===========================================================================
// 3b — executable macro crystallizer
// ===========================================================================

/**
 * When two commands keep succeeding together (lint-ish + test-ish), seal the
 * pair into a macro and write the runnable script. Second observation seals
 * it, so a one-off coincidence never becomes a skill.
 */
function maybeCrystallize(e: CortexCtx, now: number): string | null {
  const sessionID = String(e.sessionID ?? "");
  const wins = recentWins.get(sessionID) ?? [];
  if (wins.length < 2) return null;
  const [a, b] = wins.slice(-2);
  if (now - a.at > MACRO_TTL_MS) return null;
  const famA = cmdFamily(a.cmd);
  const famB = cmdFamily(b.cmd);
  if (!famA || !famB || famA === famB) return null;
  const base = macroBase(famA, famB);
  if (!base) return null;

  const seenKey = `${e.scope}|${famA}|${famB}`;
  const seen = (seqSeen.get(seenKey) ?? 0) + 1;
  seqSeen.set(seenKey, seen);
  if (seen < 2) return null;

  const commands = [a.cmd, b.cmd];
  const macroId = macroIdFor(base, e.scope, commands);
  const r = upsertMacro({
    macroId,
    scope: e.scope,
    description: `verify:${kebab(base, 20)}`,
    commands,
    durationMs: a.ms + b.ms,
    now,
  });
  if (!r) return null;
  if (r.created) {
    writeMacroScript(macroId, commands);
    logL3(e, {
      kind: "cortex_macro",
      content: `[MACRO|${macroId}] ${commands.join(" && ")}`,
      meta: { macro: macroId, scope: e.scope },
      now,
    });
  }
  return macroId;
}

/** Only verification-style pairs get a macro; anything else is noise. */
function macroBase(famA: string, famB: string): string | null {
  const verifyish = (f: string) =>
    ["lint", "typecheck", "tsc", "check", "format"].some((n) => f.includes(n)) && !f.includes("test");
  const testish = (f: string) => f.includes("test");
  if ((verifyish(famA) && testish(famB)) || (testish(famA) && verifyish(famB))) return "verify_fast";
  return null;
}

function macroIdFor(base: string, scope: string, commands: string[]): string {
  const json = JSON.stringify(commands);
  const first = getMacro(base);
  if (!first || first.command_sequence_json === json) return base;
  return `${base}_${hash32(scope + json).toString(36).slice(0, 5)}`;
}

function writeMacroScript(id: string, commands: string[]): void {
  try {
    const dir = join(dirname(BRAIN_PATH), "macros");
    mkdirSync(dir, { recursive: true });
    const body = ["#!/usr/bin/env bash", "set -euo pipefail", ...commands, ""].join("\n");
    writeFileSync(join(dir, `${id}.sh`), body, { mode: 0o755 });
  } catch {}
}

/** Activate a macro: returns its exact command sequence, counted as used. */
export function activateMacro(id: string, now = Date.now()): { macro: Macro; commands: string[] } | null {
  const needle = String(id ?? "").trim();
  if (!needle) return null;
  const found =
    getMacro(needle) ?? macroList(undefined, 50).find((m) => m.macro_id === needle || m.macro_id.startsWith(needle));
  if (!found) return null;
  const bumped = bumpMacroUse(found.macro_id, now) ?? found;
  return { macro: bumped, commands: macroCommands(bumped) };
}

// ===========================================================================
// 4 — dead-end pruner: fast-path extraction on session.idle
// ===========================================================================

/**
 * Read the whole session back and keep only the straight line: the user's
 * intent -> the core files that were actually changed -> the command that
 * verified it. Exploration that did not lead anywhere is counted, not kept.
 */
export function pruneSession(sessionID: string, e: CortexCtx, now = Date.now()): { engramId?: number } {
  const rows = l3ForSession(sessionID, 400);
  if (rows.length < 3) return {};
  const intent = firstIntent(rows);
  if (!intent) return {};

  let lastFail = -1;
  rows.forEach((r, i) => {
    if (String(r.event_type) === "bash_cmd" && rowFailed(r)) lastFail = i;
  });

  const wins: string[] = [];
  const files: string[] = [];
  let deadEnds = 0;
  rows.forEach((r, i) => {
    const t = String(r.event_type);
    if (t === "bash_cmd") {
      const cmd = rowCommand(r);
      if (rowFailed(r)) {
        if (i <= lastFail) deadEnds++;
        return;
      }
      if (i > lastFail && cmd) wins.push(cmd);
    } else if (t === "file_edit" || t === "file_edit_diff") {
      if (i > lastFail) for (const f of filePathsOfRow(r)) files.push(basename(f));
    }
  });
  if (!wins.length && !files.length) return {};

  const win = wins[wins.length - 1] ?? "";
  const names = [...new Set(files)].slice(0, 3);
  const fastPath = win ? `do:${aaakCmd(win)}` : `open:${aaakCmd(names.join("+"), 48)}`;
  const anti = deadEnds > 0 ? `!explore:${deadEnds}_dead_ends` : null;
  const when = kebab(intent, 40);
  const r = upsertEngram({
    engramKey: engramKey(e.scope, `task:${when}`, fastPath),
    scope: e.scope,
    trigger: `${when} ${intent}${win ? " " + win : ""}${names.length ? " " + names.join(" ") : ""}`.slice(0, 220),
    anti,
    fastPath,
    tokenSaved: deadEnds * TOKENS_PER_AVOIDED_STEP,
    now,
  });
  if (r && !r.reinforced) {
    logL3(e, {
      kind: "cortex_fastpath",
      content: `[FAST-PATH|${when}] ${fastPath}${anti ? " " + anti : ""}`,
      meta: { engram: r.id, scope: e.scope },
      now,
    });
  }
  return r ? { engramId: r.id } : {};
}

function firstIntent(rows: L3Row[]): string | null {
  for (const r of rows) {
    const t = String(r.event_type);
    if (t !== "user_msg" && t !== "user_prompt") continue;
    const text = String(r.raw_content ?? "")
      .replace(/^\[remember:[^\]]*\]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 12) continue;
    if (/^(?:hi|hello|hey|chào|alo)\b/i.test(text)) continue;
    if (tokens(text).length < 3) continue;
    return text.slice(0, 140);
  }
  return null;
}

function rowMeta(r: { meta_json?: string | null }): any {
  try {
    return r.meta_json ? JSON.parse(r.meta_json) : null;
  } catch {
    return null;
  }
}

function rowFailed(r: L3Row): boolean {
  const meta = rowMeta(r);
  if (meta && typeof meta.status === "string") return meta.status === "error";
  return outputLooksFailed(String(r.raw_content ?? ""));
}

function rowCommand(r: L3Row): string {
  const meta = rowMeta(r);
  if (meta && typeof meta.command === "string" && meta.command.trim()) {
    return normCmd(meta.command).slice(0, 160);
  }
  const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(r.raw_content ?? ""));
  if (m) return normCmd(m[1].replace(/\\"/g, '"').replace(/\\n/g, " ")).slice(0, 160);
  return "";
}

// ===========================================================================
// 5 — Hebbian synaptic consolidation (reverse token scaling)
// ===========================================================================

/**
 * Engrams that matured (>= 4 wins) and share a topic collapse into ONE short
 * rule; the siblings are retired (valid_until), so retrieval keeps returning
 * a single sharp line instead of a growing pile. When the survivor's win is
 * under 12 tokens it is also promoted to a graph edge, which the DNA slot
 * can carry — the skill now costs a handful of tokens forever.
 */
export function hebbianConsolidate(scope: string, now = Date.now()): { merged: number; retired: number } {
  const mature = engramsLive([scope], 80).filter((e) => e.maturity >= 4);
  const groups = new Map<string, ProceduralEngram[]>();
  for (const e of mature) {
    const topic = topicOf(e.trigger_intent);
    if (!topic) continue;
    const list = groups.get(topic) ?? [];
    list.push(e);
    groups.set(topic, list);
  }

  let merged = 0;
  let retired = 0;
  for (const [topic, list] of groups) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) => b.maturity - a.maturity || b.success_rate - a.success_rate || b.id - a.id,
    );
    const winner = list[0];
    const losers = list.slice(1);
    const fasts = [...new Set(list.map((x) => x.fast_path_aaak).filter(Boolean))].sort(
      (a, b) => estimateTokens(a) - estimateTokens(b),
    );
    const antis = [...new Set(list.map((x) => x.anti_pattern_aaak).filter((x): x is string => !!x))].slice(0, 2);

    updateEngramMerged(
      winner.id,
      {
        anti: antis.join("+") || null,
        fastPath: fasts[0],
        maturity: Math.min(9, winner.maturity + losers.length),
      },
      now,
    );
    retireEngrams(losers.map((x) => x.id), now);
    merged++;
    retired += losers.length;

    const short = String(fasts[0] ?? "")
      .replace(/^do:/, "")
      .replace(/^open:/, "open ")
      .replace(/_/g, " ")
      .trim();
    if (short && estimateTokens(short) < 12) {
      assertEdge({
        scope,
        category: "workflow_habit",
        subject: "reflex:" + topic,
        predicate: "prefer",
        object: short.slice(0, 60),
        aaak: `[MEM|wfh|reflex:${topic}=${short.slice(0, 40)}]`,
        confidence: 0.75,
        now,
      });
    }
    logL3(
      { sessionID: "cortex", scope },
      {
        kind: "cortex_hebbian",
        content: `[HEBBIAN|${topic}] merged:${list.length} kept:#${winner.id} ${fasts[0] ?? ""}`,
        now,
      },
    );
  }
  return { merged, retired };
}

/** Topic = the first two significant words of the trigger, codes skipped. */
function topicOf(trigger: string): string {
  const words = tokens(trigger).filter((t) => t.length >= 3 && !/^[a-z]?\d+$/i.test(t));
  return words.slice(0, 2).join("-");
}

// ===========================================================================
// tool-facing helpers (chronos mode=reflex)
// ===========================================================================

/** Record a user/agent-supplied fast-path ("A -> B", or "avoid:X win:Y"). */
export function recordFastPath(
  e: CortexCtx & { spec: string; when?: string },
): { id: number; reinforced: boolean; maturity: number; fastPath: string } | null {
  const spec = normCmd(e.spec);
  if (!spec) return null;
  let anti: string | null = null;
  let win = spec;
  const arrow = spec.split(/\s*(?:->|=>|⇒)\s*/);
  if (arrow.length >= 2) {
    anti = aaakAntiCmd(arrow[0]);
    win = arrow.slice(1).join(" ");
  } else {
    const m = /\bavoid[:\s]+(.+?)\s+win[:\s]+(.+)$/i.exec(spec);
    if (m) {
      anti = aaakAntiCmd(m[1]);
      win = m[2];
    }
  }
  const when = normCmd(e.when ?? "").trim() || slugText(win).split("_").slice(0, 3).join("_") || "manual";
  const fastPath = /^(?:open|do|rule|macro)\s*:/.test(win) ? aaakCmd(win) : `do:${aaakCmd(win)}`;
  const r = upsertEngram({
    engramKey: engramKey(e.scope, `manual:${when}`, fastPath),
    scope: e.scope,
    trigger: `${when} ${spec}`.slice(0, 220),
    anti,
    fastPath,
    tokenSaved: 0,
    now: e.now ?? Date.now(),
  });
  return r ? { ...r, fastPath } : null;
}

/** Everything the reflex-mode report needs, in one call. */
export function cortexStats(): {
  engrams: ReturnType<typeof engramStats>;
  interceptors: ReturnType<typeof interceptorStats>;
  macros: ReturnType<typeof macroStats>;
  tokenSavings: number;
  top: ProceduralEngram[];
} {
  const engrams = engramStats();
  const interceptors = interceptorStats();
  const macros = macroStats();
  return {
    engrams,
    interceptors,
    macros,
    tokenSavings: engrams.tokensSaved + interceptors.hits * TOKENS_PER_AVOIDED_STEP,
    top: topEngrams(3),
  };
}

// ------------------------------------------------------------------ helpers

function normCmd(cmd: string): string {
  return String(cmd ?? "").replace(/\s+/g, " ").trim();
}

function pkgManagerOf(cmd: string): string | null {
  const first = normCmd(cmd).split(" ")[0] ?? "";
  return PM_TOKENS.includes(first) ? first : null;
}

function restOf(cmd: string, pm: string): string {
  return normCmd(cmd).slice(pm.length).trim();
}

function cmdFamily(cmd: string): string {
  return normCmd(cmd).split(" ").filter(Boolean).slice(0, 3).join(":").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

const ERR_CODE_RE = /\b(P\d{4}|TS\d{4,5}|ERR_[A-Z0-9_]+|E\d{3,4}\b|[A-Z][A-Z_]{4,}ERROR)\b/;

/** Stable, searchable name for a failure: code (or first error line) + cmd family. */
export function errorSignature(output: string, cmd = ""): string {
  const text = String(output ?? "").slice(0, 4000);
  const m = ERR_CODE_RE.exec(text);
  const base = m ? m[1].toLowerCase() : slugText(firstFailureLine(text));
  const words = normCmd(cmd).split(" ").filter(Boolean).slice(0, 4);
  const fam = slugText(words.join(" "));
  return `${base}${fam ? "_" + fam : ""}`.slice(0, 64) || "error";
}

function firstFailureLine(output: string): string {
  try {
    return firstErrorLine(output);
  } catch {
    return "unknown";
  }
}

/** Heuristic: does this output look like a failure even without an exit code? */
export function outputLooksFailed(output: string): boolean {
  const t = String(output ?? "").slice(0, 4000);
  if (!t.trim()) return false;
  return (
    /(?:^|\n)\s*(?:error|failed|failure|exception|traceback|panic|fatal)\b/i.test(t) ||
    /\b(?:ERR_|ERR!|ENOENT)(?=\W|$)/.test(t) ||
    /\bTS\d{4,5}\b/.test(t) ||
    /\bP\d{4}\b/.test(t) ||
    /\bexit(?:ed)?\s+(?:code|status)\s+[1-9]/i.test(t) ||
    /\bcommand not found\b/i.test(t)
  );
}

/** `bun run test`, `bun run lint`, … — the safest exact invocation. */
function runCmdFor(pm: string, name: string): string {
  if (pm === "cargo") return `cargo ${name === "test" ? "test" : name}`;
  if (pm === "uv") return `uv run ${name}`;
  if (pm === "python") return name === "test" ? "pytest" : name;
  return `${pm} run ${name}`;
}

function readText(path: string, max = 200_000): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): any | null {
  const t = readText(path, 400_000);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Light-weight L3 log row; never throws, never blocks. */
function logL3(
  e: { sessionID?: string; project?: string | null; dir?: string | null; scope?: string },
  m: { kind: string; content: string; meta?: unknown; now?: number },
): void {
  try {
    l3Insert({
      sessionID: e.sessionID || "cortex",
      projectName: e.project ?? null,
      projectPath: e.dir ?? null,
      eventType: "tool_use",
      content: m.content.slice(0, 2000),
      meta: { kind: m.kind, ...(m.meta && typeof m.meta === "object" ? (m.meta as object) : {}) },
      timestamp: m.now ?? Date.now(),
    });
  } catch {}
}

export const __internals = {
  pendingFailures,
  recentWins,
  seqSeen,
  errorSignature,
  cmdFamily,
  macroBase,
  topicOf,
  interceptorsFor,
  applyInterceptor,
  digestSig,
};
