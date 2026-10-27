// ===========================================================================
// test.ts — the CHRONOS-PALACE v3.0 contract suite.
//
//   run:  ~/.bun/bin/bun test test.ts     (or `bun run test`)
//
// Bun's glob only auto-discovers `*.test.ts` / `*.spec.ts`, so this file is
// named explicitly in package.json — that is why plain `bun test` alone (no
// argument) would report "0 tests".
//
// The suite never touches the live brain: CHRONOS_BRAIN_PATH points at a tmp
// file BEFORE the modules are imported (hence the dynamic imports below).
//
// Covered contracts:
//   T1  one Vietnamese message -> project row (focus + open loop); a brand-new
//       session in an unrelated directory saying only "hi" gets a frozen PULSE
//       that names eduflash, its lag loop, and the greeting rule, < 125 tokens
//   T2  progress update closes loops + sets milestone; a bi-temporal switch
//       closes the framer-motion edge (valid_until + superseded_by) in favour
//       of CSS 3D
//   T3  five consecutive turns in one session -> byte-identical injected
//       snapshot (incl. [CHRONOS_CORTEX]); micro-gate injects 0 extra tokens;
//       DB round-trip identical
//   T4  failure -> fix compiles an AAAK reflex engram with 0 LLM calls, and
//       the JIT reflex gate serves it as one < 40-token line, once per session
//   T5  interceptor proves out (2x failure->fix) and tool.execute.before
//       rewrites `npm test` -> `bun test` at runtime: 0 context tokens
//   T6  Hebbian consolidation merges matured lessons (reverse token scaling):
//       the brain shrinks, the frozen snapshot bytes do not change
//   core  AAAK primitives, L3 BM25 + trigram verbatim search, JIT gate,
//       `chronos` tool (recall/timeline/remember/reflex), v1 -> v2 migration
//
// v4.0 contracts added below:
//   T7  PGA: a scanned project yields 5 chromosomes, each under its cap,
//       genome total <= 2000 tokens (C4 points at file:Lstart-Lend)
//   T8  Genome Synthesizer: greeting/chit-chat -> 0 tokens (null packet);
//       "add new flashcard endpoint" -> packet <= 1700 tokens carrying
//       C1 + the C3 winner + C4 pointers + C5 lessons + Top-3 surgical code
//       slices read by exact line range; once per session per category
//   T9  O(log N): 500 files still produce a genome under every cap (the
//       dependency graph folds into module hubs, C3/C4/C5 stay Top-K)
//   T10 Evolution engine: edit + green verify -> C3 pattern + incremental
//       re-index; failure -> fix -> C5 lesson with file:line, 30-day TTL
//   T11 Token-Darwin: ROI<0 pattern pruned + cloaked from active genome,
//       expired lesson GC'd, high-ROI pattern promoted to thriving
//   T12 `chronos` tool v4 modes: genome / synthesize / darwin
// ===========================================================================

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "chronos-test-"));
process.env.CHRONOS_BRAIN_PATH = join(TMP, "brain.sqlite");

const aaak = await import("./aaak");
const db = await import("./db");
const ex = await import("./extractor");
const ret = await import("./retriever");
const cortex = await import("./cortex");
const genome = await import("./genome");
const darwin = await import("./darwin");
const strategy = await import("./strategy");
const plugin = await import("./index");

afterAll(() => {
  try {
    db.closeBrain();
  } catch {}
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

// --------------------------------------------------------------- helpers

interface FakeCtx {
  ctx: any;
  hooks: Record<string, (event: any) => any>;
  tools: any[];
}

function fakeCtx(directory: string): FakeCtx {
  const hooks: Record<string, (event: any) => any> = {};
  const tools: any[] = [];
  const ctx = {
    location: { directory },
    session: {
      hook: (name: string, cb: (event: any) => any) => {
        hooks[name] = cb;
      },
      get: async () => ({ directory }),
    },
    tool: {
      hook: (name: string, cb: (event: any) => any) => {
        hooks[name] = cb;
      },
      transform: (cb: (editor: any) => void) => cb({ add: (t: any) => tools.push(t) }),
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
  };
  return { ctx, hooks, tools };
}

/** A session state stand-in for applyAnalysis (it only reads .project/.dir). */
const stLike = (dir: string) =>
  ({ sessionID: "sess-eduflash", dir, project: null as string | null, scope: db.projectScope(dir), snap: null, pending: null, lastUser: "", files: new Set<string>(), lastIdle: 0, turns: 0 }) as any;

const SID1 = "sess-eduflash";
const MSG1 = "Dự án eduflash đang làm phần lật thẻ flashcard, nhưng bị lag khi lật nhiều thẻ.";

// ===========================================================================
// core primitives
// ===========================================================================

test("core · AAAK codec, relative time, 384-bit SimHash", () => {
  const now = Date.now();
  expect(aaak.relTime(now - 2 * 3600_000, now)).toBe("2h_ago");
  expect(aaak.relTime(now - 3 * 86400_000, now)).toBe("3d_ago");
  expect(aaak.relTime(now - 30_000, now)).toBe("just_now");
  expect(aaak.projectKey("EduFlash!")).toBe("eduflash");
  expect(aaak.kebab("Lật thẻ flashcard")).toBe("lật-thẻ-flashcard");

  const h1 = aaak.simhashToHex(aaak.simhash384("thẻ flashcard bị lag khi lật"));
  const h2 = aaak.simhashToHex(aaak.simhash384("thẻ flashcard bị lag khi lật"));
  expect(h1).toHaveLength(aaak.SIMHASH_BITS / 4); // 96 hex chars = 384 bits
  expect(h1).toBe(h2);
  expect(aaak.hammingDistance(h1, h2)).toBe(0);
  expect(aaak.simhashSimilarity(h1, h2)).toBe(1);
  expect(aaak.hammingDistance("deadbeef".repeat(2), h1)).toBeNull(); // widths incomparable
  expect(aaak.estimateTokens("[CHRONOS_DNA] [DNA|]")).toBeGreaterThan(0);
  expect(aaak.estimateTokens(aaak.AAAK_BEHAVIOR)).toBeLessThan(60);
});

// ===========================================================================
// T1 — the eduflash message becomes a project, and "hi" elsewhere recalls it
// ===========================================================================

test("T1 · one eduflash message -> project row with focus + open loop", () => {
  const analysis = ex.analyzeMessage(MSG1, { knownProjects: db.knownProjectNames() });
  expect(analysis.primaryProject).toBe("eduflash");
  expect(analysis.projects[0]?.focus).toBe("lật-thẻ-flashcard");
  expect(analysis.projects[0]?.openLoop ?? "").toContain("lag");

  const before = db.l3Count();
  plugin.__internals.applyAnalysis(analysis, stLike(TMP), SID1, MSG1, Date.now());

  const row = db.getProject("eduflash");
  expect(row).toBeTruthy();
  expect(row!.current_focus).toBe("lật-thẻ-flashcard");
  expect(db.openLoops("eduflash").join(" ")).toContain("lag");

  // the verbatim record exists, findable both by relevance and by substring
  expect(db.l3Count()).toBeGreaterThan(before);
  expect(db.l3SearchBm25("flashcard lag", 5).length).toBeGreaterThan(0);
  expect(db.l3SearchTrigram("flashcard", 5).length).toBeGreaterThan(0);
});

test("T1 · new session, unrelated directory, just 'hi' -> PULSE names eduflash + lag + greeting rule", async () => {
  const dir2 = join(TMP, "somewhere-else");
  mkdirSync(dir2, { recursive: true });
  const f = fakeCtx(dir2);
  await plugin.default.setup(f.ctx);

  const SID = "sess-hi-elsewhere";
  await f.hooks.prompt({ sessionID: SID, prompt: { text: "hi" }, location: { directory: dir2 } });
  const ev: any = { sessionID: SID, system: [], location: { directory: dir2 } };
  f.hooks.context(ev);

  const block = ev.system.map((s: any) => String(s.text)).join("\n");
  expect(block).toContain("[CHRONOS_DNA]");
  expect(block).toContain("[CHRONOS_PULSE]");
  expect(block).toContain("[CHRONOS_BEHAVIOR]");

  // eduflash is carried over, with its focus and its lag loop, from another folder
  expect(block).toMatch(/eduflash:[^,\]]*\[focus:[^\]]*open:[^\]]*lag/i);

  // the greeting contract itself
  expect(block.toLowerCase()).toContain("greeting");
  expect(block.toLowerCase()).toContain("ask about newest project");
  expect(block).toContain("`chronos`");

  // v3: the execution protocol rides along, fixed bytes
  expect(block).toContain("[CHRONOS_CORTEX]");
  expect(block).toContain("[REFLEX] fast-path");

  // the whole injected block stays under the token budget
  expect(aaak.estimateTokens(block)).toBeLessThan(125);

  // and it was frozen into L0
  const snap = db.snapshotGet(SID);
  expect(snap).toBeTruthy();
  expect(snap!.frozen_pulse_aaak).toContain("eduflash");
});

test("T1 · an older project with an open loop keeps its detail next to a newer one", () => {
  db.upsertProject({ name: "newthing", path: join(TMP, "newthing"), now: Date.now() + 60_000 });
  const snap = ret.buildSnapshot({ scope: db.projectScope(TMP), project: null, cwdProject: null, now: Date.now() + 61_000 });
  expect(snap.pulse).toContain("newthing");
  expect(snap.pulse).toMatch(/eduflash:[^,\]]*\[focus:[^\]]*open:/);
});

// ===========================================================================
// T2 — progress closes loops; a switch closes the old technology for good
// ===========================================================================

test("T2 · progress update: milestone set, the lag loop closes", () => {
  const msg = "Eduflash mượt rồi ở phần lật thẻ.";
  const analysis = ex.analyzeMessage(msg, { knownProjects: db.knownProjectNames(), defaultProject: "eduflash" });
  expect(analysis.projects[0]?.milestone ?? "").toContain("mượt");

  plugin.__internals.applyAnalysis(analysis, stLike(TMP), SID1, msg, Date.now());

  const row = db.getProject("eduflash")!;
  expect(row.last_milestone ?? "").toContain("mượt");
  expect(db.openLoops("eduflash").filter((l) => /lag/i.test(l))).toEqual([]);
});

test("T2 · claim then switch: framer-motion closes (valid_until) in favour of CSS 3D", () => {
  const msgA = "Eduflash đang dùng framer-motion cho hiệu ứng lật thẻ.";
  const aA = ex.analyzeMessage(msgA, { knownProjects: db.knownProjectNames() });
  expect(aA.claims.some((c) => c.value === "framer-motion" && c.slot === "animation_lib")).toBe(true);
  plugin.__internals.applyAnalysis(aA, stLike(TMP), SID1, msgA, Date.now());

  const msgB = "Eduflash đổi từ framer-motion sang CSS 3D.";
  const aB = ex.analyzeMessage(msgB, { knownProjects: db.knownProjectNames() });
  expect(aB.switches[0]?.from).toBe("framer-motion");
  expect(aB.switches[0]?.to).toBe("css-3d");
  expect(aB.switches[0]?.slot).toBe("animation_lib");
  plugin.__internals.applyAnalysis(aB, stLike(TMP), SID1, msgB, Date.now());

  const hist = db.edgeHistory("project:eduflash", "animation_lib");
  const old = hist.find((e) => e.object === "framer-motion");
  const neo = hist.find((e) => e.object === "css-3d");
  expect(old).toBeTruthy();
  expect(neo).toBeTruthy();
  expect(old!.valid_until ?? 0).toBeGreaterThan(0); // closed…
  expect(old!.superseded_by).toBe(neo!.id); // …by the new edge
  expect(neo!.valid_until).toBeNull();

  const live = db.liveEdges("project:eduflash", "tech_stack").map((e) => e.object);
  expect(live).toContain("css-3d");
  expect(live).not.toContain("framer-motion");
});

// ===========================================================================
// T3 — the frozen snapshot: byte-identical across turns, 0 extra tokens
// ===========================================================================

test("T3 · five turns, one session: byte-identical block, no extra tokens", async () => {
  const dirX = join(TMP, "five-turns");
  mkdirSync(dirX, { recursive: true });
  const f = fakeCtx(dirX);
  await plugin.default.setup(f.ctx);

  const SID = "sess-five-turns";
  const texts: string[] = [];
  for (let i = 0; i < 5; i++) {
    await f.hooks.prompt({ sessionID: SID, prompt: { text: "hi" }, location: { directory: dirX } });
    const ev: any = { sessionID: SID, system: [], location: { directory: dirX } };
    f.hooks.context(ev);
    // exactly one pushed block: the frozen snapshot. The micro-gate added 0.
    expect(ev.system.length).toBe(1);
    texts.push(String(ev.system[0]?.text ?? ""));
    if (i === 1) {
      // the world moves mid-session; the frozen block must not
      db.upsertProject({ name: "eduflash", focus: "đổi-focus-mới", now: Date.now() + 9999 });
    }
  }
  expect(texts[0].length).toBeGreaterThan(0);
  expect(texts.every((t) => t === texts[0])).toBe(true);
  expect(f.tools.map((t) => t.name)).toContain("chronos");

  // reload safety: the persisted L0 snapshot rebuilds the exact same bytes
  const stored = db.snapshotGet(SID);
  expect(stored).toBeTruthy();
  expect(ret.snapshotText(stored!.frozen_dna_aaak, stored!.frozen_pulse_aaak)).toBe(texts[0]);
});

test("T3 · micro-gate: irrelevant -> 0 tokens, relevant -> once per session", () => {
  const edge = db.assertEdge({
    scope: "project:eduflash",
    category: "bug_lesson",
    subject: "bug:lag-khi-lật-thẻ",
    predicate: "fixed_by",
    object: "lazy-mount-thẻ-để-hết-lag",
    aaak: "[MEM|bug|lag-khi-lật-thẻ=lazy-mount]",
    confidence: 0.7,
  });
  expect(edge).toBeTruthy();

  const g0 = ret.gate("zxqy blorp", { scope: "project:eduflash", sessionID: "gate-a", respectWorkingSet: true });
  expect(g0.text).toBe("");

  const g1 = ret.gate("lag lật thẻ", { scope: "project:eduflash", sessionID: "gate-a", respectWorkingSet: true });
  expect(g1.text.length).toBeGreaterThan(0);
  expect(g1.keys).toContain(`edge:${edge!.id}`);

  for (const k of g1.keys) db.l1MarkKey("gate-a", k, "injected");
  const g2 = ret.gate("lag lật thẻ", { scope: "project:eduflash", sessionID: "gate-a", respectWorkingSet: true });
  expect(g2.text).toBe("");

  const g3 = ret.gate("lag lật thẻ", { scope: "project:eduflash", sessionID: "gate-b", respectWorkingSet: true });
  expect(g3.text.length).toBeGreaterThan(0);
});

// ===========================================================================
// T4 — the cortex: failure -> fix compiles a reflex engram (0 LLM tokens)
// ===========================================================================

test("T4 · failure -> fix becomes an AAAK reflex engram; the gate serves one line", () => {
  const sess = {
    sessionID: "sess-cortex-fix",
    scope: "project:eduflash",
    stacks: ["prisma", "bun"],
    dir: TMP,
    project: "eduflash",
  };

  // the failing turn: npx prisma migrate dev dies on a non-TTY terminal
  const rFail = cortex.noteToolAfter({
    ...sess,
    tool: "bash",
    input: { command: "npx prisma migrate dev" },
    status: "error",
    output: "Error: P1001 database unreachable\nnon-TTY migrate dev cannot run in this terminal",
  });
  expect(rFail).toBeNull(); // failures only arm the RAM journal

  // the next turn fixes it: bunx prisma db push completes
  const rFix = cortex.noteToolAfter({
    ...sess,
    tool: "bash",
    input: { command: "bunx prisma db push" },
    status: "completed",
    output: "The database is now in sync.",
  });
  expect(rFix?.engramId).toBeTruthy();

  const e = db.engramById(rFix!.engramId!);
  expect(e).toBeTruthy();
  expect(e!.anti_pattern_aaak).toBe("!cmd:npx_prisma_migrate_dev");
  expect(e!.fast_path_aaak).toBe("do:bunx_prisma_db_push");
  expect(e!.trigger_simhash).toBeTruthy();
  expect(e!.maturity).toBeGreaterThanOrEqual(1);

  // the JIT reflex gate answers a similar task with ONE tiny line…
  const g = ret.reflexGate("prisma migrate dev failed non-tty", {
    scope: "project:eduflash",
    stacks: ["prisma", "bun"],
    sessionID: "sess-cortex-gate",
    respectWorkingSet: true,
  });
  expect(g).toBeTruthy();
  expect(g!.text).toContain("[CHRONOS_REFLEX]");
  expect(g!.text).toContain("avoid:!cmd:npx_prisma_migrate_dev");
  expect(g!.text).toContain("fast_path:do:bunx_prisma_db_push");
  expect(aaak.estimateTokens(g!.text)).toBeLessThan(40);

  // …exactly once per session: mark it injected and the gate stays shut.
  db.l1MarkKey("sess-cortex-gate", g!.key, "injected");
  const g2 = ret.reflexGate("prisma migrate dev failed non-tty", {
    scope: "project:eduflash",
    stacks: ["prisma", "bun"],
    sessionID: "sess-cortex-gate",
    respectWorkingSet: true,
  });
  expect(g2).toBeNull();

  // noise never fires the gate: 0 tokens.
  const g3 = ret.reflexGate("chuyện phiếm về thời tiết hôm nay", {
    scope: "project:eduflash",
    stacks: [],
    sessionID: "sess-cortex-gate2",
    respectWorkingSet: true,
  });
  expect(g3).toBeNull();
});

test("core · a user correction re-roles the last win (sai rồi -> try another way)", () => {
  expect(ex.detectUserCorrection("sai rồi, đừng làm thế")).toBe(true);
  expect(ex.detectUserCorrection("that's wrong, don't do that")).toBe(true);
  expect(ex.detectUserCorrection("ok cảm ơn nhé")).toBe(false);

  const sess = { sessionID: "sess-correct", scope: "project:eduflash", stacks: [], dir: TMP, project: "eduflash" };
  cortex.noteToolAfter({ ...sess, tool: "bash", input: { command: "pnpm build" }, status: "completed", output: "done" });
  cortex.noteUserMessage({ ...sess, text: "sai rồi, đừng làm thế" });
  const r = cortex.noteToolAfter({
    ...sess,
    tool: "bash",
    input: { command: "bun run build" },
    status: "completed",
    output: "done",
  });
  expect(r?.engramId).toBeTruthy();
  const e = db.engramById(r!.engramId!);
  expect(String(e!.anti_pattern_aaak)).toContain("pnpm_build");
  expect(e!.fast_path_aaak).toContain("bun_run_build");
});

// ===========================================================================
// T5 — subconscious interception: tool.execute.before rewrites, 0 ctx tokens
// ===========================================================================

test("T5 · npm test -> bun test: proven interceptor rewrites at the hook, 0 tokens", async () => {
  const sess = { sessionID: "sess-npm-bun", scope: "project:bunapp", stacks: ["bun"], dir: TMP, project: "bunapp" };
  for (let i = 0; i < 3; i++) {
    cortex.noteToolAfter({
      ...sess,
      tool: "bash",
      input: { command: "npm test" },
      status: "error",
      output: "npm ERR! code ELIFECYCLE\ncommand failed in this repo",
    });
    cortex.noteToolAfter({
      ...sess,
      tool: "bash",
      input: { command: "bun test" },
      status: "completed",
      output: " 3 pass\n 0 fail",
    });
  }

  const ic = db.interceptorRows(20).find((r) => r.match_pattern === "^npm\\s+test(\\s|$)");
  expect(ic).toBeTruthy();
  expect(ic!.scope).toBe("stack:bun");
  expect(ic!.confidence).toBeGreaterThanOrEqual(0.9);
  expect(ic!.hit_count).toBeGreaterThanOrEqual(3);
  expect(ic!.active).toBe(1);

  // now the live path: a project whose lockfile mandates bun, a session in it
  const dirBun = join(TMP, "bunapp");
  mkdirSync(dirBun, { recursive: true });
  writeFileSync(join(dirBun, "package.json"), JSON.stringify({ name: "bunapp", scripts: { test: "bun test" } }));
  writeFileSync(join(dirBun, "bun.lockb"), "");

  const f = fakeCtx(dirBun);
  await plugin.default.setup(f.ctx);
  const SID = "sess-before-hook";
  await f.hooks.prompt({
    sessionID: SID,
    prompt: { text: "chạy test cho dự án đi" },
    location: { directory: dirBun },
  });

  const ev: any = { tool: "bash", sessionID: SID, input: { command: "npm test" } };
  f.hooks["execute.before"](ev);
  expect(ev.input.command).toBe("bun test"); // rewritten before the shell ever saw it

  // the interception was journaled — and cost zero context tokens.
  const log = db.l3ForSession(SID, 50);
  expect(log.some((r) => String(r.raw_content).includes("[intercept] npm test -> bun test"))).toBe(true);
  const ic2 = db.interceptorRows(20).find((r) => r.match_pattern === "^npm\\s+test(\\s|$)");
  expect(ic2!.hit_count).toBe(4); // 3 proofs + 1 real firing
});

// ===========================================================================
// T6 — Hebbian consolidation: fewer rows, same prompt bytes (reverse scaling)
// ===========================================================================

test("T6 · matured engrams merge into one sharp rule; frozen prompt bytes hold", () => {
  const scope = "project:eduflash";
  const mk = (key: string, trigger: string, anti: string, win: string) => {
    for (let i = 0; i < 4; i++) {
      db.upsertEngram({ engramKey: key, scope, trigger, anti, fastPath: win, tokenSaved: 10 });
    }
  };
  mk("hb-a", "prisma migrate dev non-tty failure npx way", "!cmd:npx_prisma_migrate_dev", "do:bunx_prisma_db_push");
  mk("hb-b", "prisma migrate push fast bunx way", "!cmd:npx_prisma_migrate", "do:bunx_db_push_short");

  const liveBefore = db.engramsLive([scope], 80).filter((e) => e.engram_key === "hb-a" || e.engram_key === "hb-b");
  expect(liveBefore.length).toBe(2);
  expect(liveBefore.every((e) => e.maturity >= 4)).toBe(true);

  // frozen-session contract: same instant, same scope -> same bytes.
  const nowB = Date.now();
  const snapA = ret.buildSnapshot({ scope, project: "eduflash", cwdProject: "eduflash", now: nowB });

  const r = cortex.hebbianConsolidate(scope);
  expect(r.merged).toBeGreaterThanOrEqual(1);
  expect(r.retired).toBeGreaterThanOrEqual(1);

  const live = db.engramsLive([scope], 80).filter((e) => e.engram_key === "hb-a" || e.engram_key === "hb-b");
  expect(live.length).toBe(1); // two piles collapsed into one
  expect(live[0].maturity).toBeGreaterThanOrEqual(5);

  const rows: any[] = db.__internals.q(
    "SELECT engram_key, valid_until FROM l2_procedural_engrams WHERE engram_key IN ('hb-a','hb-b')",
  );
  expect(rows.filter((x) => x.valid_until).length).toBe(1); // sibling retired, not deleted

  // the merge did not bloat the block: same bytes, and still exactly ONE
  // reflex line under the 40-token cap for the topic.
  const snapB = ret.buildSnapshot({ scope, project: "eduflash", cwdProject: "eduflash", now: nowB });
  expect(snapB.text).toBe(snapA.text);

  const g = ret.reflexGate("prisma migrate non-tty failure", {
    scope,
    sessionID: "hb-gate",
    respectWorkingSet: true,
  });
  expect(g).toBeTruthy();
  expect(aaak.estimateTokens(g!.text)).toBeLessThan(40);
});

// ===========================================================================
// core — the `chronos` tool, and the v1 -> v2 migration
// ===========================================================================

test("core · tool `chronos`: timeline shows the dropped tech, remember writes", async () => {
  const f = fakeCtx(TMP);
  await plugin.default.setup(f.ctx);
  const tool = f.tools.find((t) => t.name === "chronos");
  expect(tool).toBeTruthy();
  expect(tool.input.properties.mode.enum).toEqual(["recall", "timeline", "remember", "reflex", "genome", "synthesize", "darwin"]);

  const tl = await tool.execute(
    { query: "animation", mode: "timeline", subject: "animation_lib", project: "eduflash" },
    { sessionID: "tool-sess" },
  );
  expect(tl.content).toContain("framer-motion");
  expect(tl.content).toContain("css-3d");
  expect(tl.content).toContain("->");

  const w = await tool.execute(
    { query: "thêm dark mode", mode: "remember", kind: "loop", project: "eduflash" },
    { sessionID: "tool-sess" },
  );
  expect(w.content).toContain("remembered");
  expect(db.openLoops("eduflash").join(" ")).toContain("dark mode");

  // v3 reflex mode: the cortex reports what it learned (and what it saved)
  const rf = await tool.execute({ query: "", mode: "reflex" }, { sessionID: "tool-sess" });
  expect(rf.content).toContain("[CHRONOS|reflex|");
  expect(rf.content).toContain("engrams:");
  expect(rf.content).toContain("saved:~");

  // …and it can teach a fast-path on demand, or run a crystallized macro
  const lr = await tool.execute(
    { query: "learn npm install -> bun install", mode: "reflex" },
    { sessionID: "tool-sess" },
  );
  expect(lr.content).toContain("[CHRONOS|reflex|learned");
  expect(lr.content).toContain("bun_install");

  db.upsertMacro({ macroId: "verify_fast", scope: "global", description: "lint+test", commands: ["bun run lint", "bun test"] });
  const act = await tool.execute({ query: "activate verify_fast", mode: "reflex" }, { sessionID: "tool-sess" });
  expect(act.content).toContain("[CHRONOS|reflex|macro|verify_fast");
  expect(act.content).toContain("bun run lint && bun test");

  // idle-time dead-end pruner: signature lock (deterministic, never throws)
  const pr = cortex.pruneSession("sess-cortex-fix", {
    sessionID: "sess-cortex-fix",
    scope: "project:eduflash",
    stacks: ["prisma", "bun"],
    dir: TMP,
    project: "eduflash",
  });
  expect(typeof pr).toBe("object");
});

test("core · migration: a v1 brain is bridged in place, non-destructively", () => {
  const p = join(TMP, "legacy.sqlite");
  const d = new Database(p, { create: true });
  d.exec(`
    CREATE TABLE l3_verbatim_vault (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL, raw_content TEXT NOT NULL, file_paths_json TEXT,
      simhash_signature TEXT, vec BLOB, meta_json TEXT);
    CREATE TABLE l2_temporal_graph (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, category TEXT NOT NULL,
      subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, aaak_compressed TEXT,
      confidence REAL NOT NULL DEFAULT 0.6, stability REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0, valid_from INTEGER NOT NULL, valid_until INTEGER,
      superseded_by_id INTEGER, last_accessed_at INTEGER, created_at INTEGER NOT NULL,
      meta_json TEXT, vec BLOB, simhash_signature TEXT);
    CREATE TABLE l1_session_working_set (
      session_id TEXT NOT NULL, memory_id INTEGER NOT NULL, kind TEXT NOT NULL,
      injected_at INTEGER NOT NULL, PRIMARY KEY (session_id, memory_id));
    INSERT INTO l2_temporal_graph
      (scope, category, subject, predicate, object, aaak_compressed, confidence, valid_from, created_at)
      VALUES ('global','tech_stack','animation_lib','uses','framer-motion',
              '[MEM|tech_stack|animation_lib=framer-motion]', 0.7, 1, 1);
    INSERT INTO l1_session_working_set (session_id, memory_id, kind, injected_at)
      VALUES ('old-sess', 42, 'injected', 1);
  `);

  db.__internals.migrate(d);

  const cols = (t: string) =>
    new Set((d.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name));

  // renames happened, no duplicates left behind
  const l2 = cols("l2_temporal_graph");
  expect(l2.has("aaak_text")).toBe(true);
  expect(l2.has("superseded_by")).toBe(true);
  expect(l2.has("aaak_compressed")).toBe(false);
  expect(l2.has("superseded_by_id")).toBe(false);

  // v1 L3 gained the v2 columns
  const l3 = cols("l3_verbatim_vault");
  expect(l3.has("project_name")).toBe(true);
  expect(l3.has("entities_json")).toBe(true);

  // L1 was rebuilt around memory_key, old rows preserved as edge ids
  const l1 = cols("l1_session_working_set");
  expect(l1.has("memory_key")).toBe(true);
  const kept = d.query(`SELECT memory_key FROM l1_session_working_set WHERE session_id = 'old-sess'`).all() as Array<{ memory_key: string }>;
  expect(kept.map((r) => r.memory_key)).toEqual(["edge:42"]);

  // the L2 FTS mirror was rebuilt and searches the renamed column
  const hit = d
    .query(`SELECT g.object AS object, g.aaak_text AS aaak FROM l2_fts JOIN l2_temporal_graph g ON g.id = l2_fts.rowid WHERE l2_fts MATCH '"framer-motion"'`)
    .all() as Array<{ object: string; aaak: string }>;
  expect(hit.length).toBe(1);
  expect(hit[0].object).toBe("framer-motion");
  expect(hit[0].aaak).toBe("[MEM|tech_stack|animation_lib=framer-motion]");

  d.close();
});

// ===========================================================================
// v4.0 — Project Genome Architecture (PGA) + Token-Darwin governance
// ===========================================================================

const GDIR = join(TMP, "gauntlet");

function writeGauntletFixture(): void {
  mkdirSync(join(GDIR, "src", "api"), { recursive: true });
  mkdirSync(join(GDIR, "src", "auth"), { recursive: true });
  mkdirSync(join(GDIR, "src", "core"), { recursive: true });
  writeFileSync(
    join(GDIR, "package.json"),
    JSON.stringify({
      name: "gauntlet",
      dependencies: { next: "15", react: "19", "@prisma/client": "6", jsonwebtoken: "9" },
      devDependencies: { vitest: "2" },
      scripts: { test: "vitest run" },
    }),
  );
  writeFileSync(join(GDIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(
    join(GDIR, "src", "core", "db.ts"),
    `import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\nexport function findUser(id: string) {\n  return prisma.user.findUnique({ where: { id } });\n}\n`,
  );
  writeFileSync(
    join(GDIR, "src", "auth", "jwt.ts"),
    `import { prisma } from "../core/db";\nexport function signToken(userId: string) {\n  return \`t.\${userId}\`;\n}\nexport function verifyToken(token: string) {\n  return token.length > 0;\n}\n`,
  );
  writeFileSync(
    join(GDIR, "src", "api", "flashcard.ts"),
    `import { prisma } from "../core/db";\nimport { verifyToken } from "../auth/jwt";\nexport async function listFlashcards(req: any) {\n  verifyToken(req.token);\n  return prisma.flashcard.findMany();\n}\nexport async function addFlashcard(req: any) {\n  return prisma.flashcard.create({ data: req.body });\n}\n`,
  );
}

// ===========================================================================
// T7 — the 5 chromosomes are built under their caps, total <= 2000 tokens
// ===========================================================================

test("T7 · PGA: 5 chromosomes, per-cap verified, total genome <= 2000 tokens", () => {
  writeGauntletFixture();
  const g = genome.buildGenome(GDIR, "gauntlet", Date.now());
  expect(g.ok).toBe(true);
  expect(g.fileCount).toBe(3);

  const row = db.genomeGet("gauntlet")!;
  expect(row).toBeTruthy();
  expect(row.file_count).toBe(3);

  const t = genome.genomeTokens(row);
  expect(t.c1).toBeLessThanOrEqual(genome.C1_CAP); // 200
  expect(t.c2).toBeLessThanOrEqual(genome.C2_CAP); // 300
  expect(t.c3).toBeLessThanOrEqual(genome.C3_CAP); // 500
  expect(t.c4).toBeLessThanOrEqual(genome.C4_CAP); // 500
  expect(t.c5).toBeLessThanOrEqual(genome.C5_CAP); // 300
  expect(t.total).toBeLessThanOrEqual(2000);
  expect(row.total_genome_tokens).toBe(t.total);

  // C1 reads the manifests: framework, db, auth, test runner
  expect(row.c1_arch_dna_aaak).toContain("fw:next");
  expect(row.c1_arch_dna_aaak).toContain("db:prisma");
  expect(row.c1_arch_dna_aaak).toContain("auth:jsonwebtoken");

  // C2 knows the compressed adjacency (who imports core/db)
  expect(row.c2_dep_graph_aaak).toContain("src/core/db.ts");

  // C4 is a line-coordinate index: symbol@file:Lstart-Lend
  expect(row.c4_semantic_index_aaak).toContain("listFlashcards@src/api/flashcard.ts:");

  // the backing pointer store answers sub-ms FTS and carries real line ranges
  const ptr = db.pointerSearch("gauntlet", "flashcard", 5);
  expect(ptr.length).toBeGreaterThan(0);
  expect(ptr[0].file_path).toContain("flashcard");
  expect(ptr[0].line_start).toBeGreaterThan(0);
  expect(ptr[0].line_end).toBeGreaterThanOrEqual(ptr[0].line_start);
});

// ===========================================================================
// T8 — the synthesizer: 0 tokens for "hi", a surgical packet for a task
// ===========================================================================

test("T8 · Genome Synthesizer: greeting costs 0 tokens; a task gets Top-3 surgical slices", () => {
  const sid = "gs-1";

  // greeting / chit-chat -> NULL packet (the PULSE covers the greeting)
  expect(genome.synthGenome("hi", { project: "gauntlet", projectPath: GDIR, sessionID: "gs-0" })).toBeNull();
  expect(genome.synthGenome("chào bạn", { project: "gauntlet", projectPath: GDIR, sessionID: "gs-0b" })).toBeNull();
  expect(genome.synthGenome("chuyện phiếm về thời tiết", { project: "gauntlet", projectPath: GDIR, sessionID: "gs-0c" })).toBeNull();

  // teach the genome a winning pattern + a fresh lesson first
  db.patternUpsert({
    patternId: "gauntlet:add_endpoint",
    projectName: "gauntlet",
    taskCategory: "add_endpoint",
    triggerKeywords: "add endpoint flashcard",
    blueprintAaak: "route->controller->prisma",
    targetFiles: ["src/api/flashcard.ts"],
    now: Date.now(),
  });
  db.lessonUpsert({
    lessonId: "gauntlet:flashcard-token",
    projectName: "gauntlet",
    bugSummary: "flashcard list crash on missing token",
    fixAaak: "do:verify_exp_claim",
    filePointer: "src/api/flashcard.ts:3-6",
    now: Date.now(),
  });

  const r = genome.synthGenome("add new flashcard endpoint", {
    project: "gauntlet",
    projectPath: GDIR,
    sessionID: sid,
    respectWorkingSet: true,
    now: Date.now(),
  });
  expect(r).toBeTruthy();
  expect(r!.category).toBe("add_endpoint");

  // the packet carries the chromosomes it needs…
  expect(r!.text).toContain("[GENOME|gauntlet|add_endpoint");
  expect(r!.text).toContain("[C1|");
  expect(r!.text).toContain("[C3|winner]");
  expect(r!.text).toContain("[C4|pointers]");
  expect(r!.text).toContain("[C5|lessons]");
  expect(r!.text).toContain("listFlashcards@src/api/flashcard.ts:");

  // …plus exactly Top-3 surgical slices, read by line range only
  expect(r!.slices.length).toBe(3);
  expect((r!.text.match(/\[CODE\|/g) ?? []).length).toBe(3);
  expect(r!.text).toContain("[CODE|src/api/flashcard.ts:");
  expect(r!.text).toContain("[CODE|src/core/db.ts:"); // pulled in via the C2 dependency graph
  expect(r!.text).toContain("[CODE|src/auth/jwt.ts:");
  expect(/verifyToken\(req\.token\)|req\.body/.test(r!.text)).toBe(true); // real source lines

  // the packet never exceeds the hard ceiling
  expect(r!.tokens).toBeLessThan(1700);
  expect(r!.tokens).toBeGreaterThan(100);

  // Token-Darwin saw the impressions
  expect(db.ledgerGet("c4_pointer", r!.pointerIds[0])!.impressions).toBeGreaterThan(0);
  expect(db.ledgerGet("c3_pattern", "gauntlet:add_endpoint")!.impressions).toBeGreaterThan(0);

  // once per session per category: the same armed packet never repeats
  const r2 = genome.synthGenome("add new flashcard endpoint", {
    project: "gauntlet",
    projectPath: GDIR,
    sessionID: sid,
    respectWorkingSet: true,
  });
  expect(r2).toBeNull();

  // a fresh session may receive it again
  const r3 = genome.synthGenome("add new flashcard endpoint", {
    project: "gauntlet",
    projectPath: GDIR,
    sessionID: "gs-2",
    respectWorkingSet: true,
  });
  expect(r3).toBeTruthy();
});

// ===========================================================================
// T9 — logarithmic scaling: 500 files, still <= 2000 genome tokens
// ===========================================================================

test("T9 · O(log N): 500 files across 25 modules keep every chromosome under cap", () => {
  const BIG = join(TMP, "bigapp");
  mkdirSync(join(BIG, "src"), { recursive: true });
  for (let m = 0; m < 25; m++) mkdirSync(join(BIG, "src", `mod${m}`), { recursive: true });
  for (let i = 0; i < 500; i++) {
    const dir = join(BIG, "src", `mod${i % 25}`);
    const content = [
      `import { fn0 } from "../mod0/f0";`,
      `export function fn${i}(x: number) {`,
      `  return x + ${i};`,
      `}`,
      `export class Klass${i} {}`,
    ].join("\n");
    writeFileSync(join(dir, `f${i}.ts`), content);
  }
  writeFileSync(join(BIG, "package.json"), JSON.stringify({ name: "bigapp", dependencies: { express: "4" }, scripts: { test: "jest" } }));

  const g = genome.buildGenome(BIG, "bigapp", Date.now());
  expect(g.fileCount).toBe(500);
  expect(g.pointers).toBeGreaterThanOrEqual(1000); // 2 symbols x 500 files

  const row = db.genomeGet("bigapp")!;
  expect(row.file_count).toBe(500);
  const t = genome.genomeTokens(row);
  expect(t.c1).toBeLessThanOrEqual(200);
  expect(t.c2).toBeLessThanOrEqual(300);
  expect(t.c3).toBeLessThanOrEqual(500);
  expect(t.c4).toBeLessThanOrEqual(500);
  expect(t.c5).toBeLessThanOrEqual(300);
  expect(t.total).toBeLessThanOrEqual(2000);

  // the dependency graph folded to module hubs — it did NOT grow linearly
  expect(row.c2_dep_graph_aaak).toContain("src/mod0<-");
  expect((row.c2_dep_graph_aaak.match(/<-/g) ?? []).length).toBeLessThan(30);

  // the semantic index stayed Top-K
  expect((row.c4_semantic_index_aaak.match(/@/g) ?? []).length).toBeLessThanOrEqual(140);
});

// ===========================================================================
// T10 — evolution engine: edit+verify -> pattern; failure->fix -> lesson
// ===========================================================================

test("T10 · evolution: edit+verify crystallizes C3 + re-indexes only the edits; fail->fix writes a C5 lesson", () => {
  const dirE = join(TMP, "evoapp");
  mkdirSync(join(dirE, "src"), { recursive: true });
  writeFileSync(join(dirE, "package.json"), JSON.stringify({ name: "evoapp", scripts: { test: "bun test" } }));
  writeFileSync(
    join(dirE, "src", "util.ts"),
    `export function clamp(n: number) {\n  return Math.max(0, n);\n}\nexport function slug(s: string) {\n  return s.trim();\n}\n`,
  );

  // a technical intent parks the task category for this session
  genome.noteGenomeMessage({ sessionID: "evo-1", text: "thêm endpoint flashcard cho evoapp" });
  genome.noteGenomeToolAfter({ sessionID: "evo-1", tool: "edit", input: { filePath: join(dirE, "src", "util.ts") }, status: "completed" });
  const ev = genome.noteGenomeToolAfter({
    sessionID: "evo-1",
    tool: "bash",
    input: { command: "bun test" },
    status: "completed",
    output: "2 pass",
    dir: dirE,
    project: "evoapp",
  });
  expect(ev?.patternId).toBe("evoapp:add_endpoint");
  expect(ev?.reindexed).toBeGreaterThan(0);

  const p = db.patternGet("evoapp:add_endpoint")!;
  expect(p.task_category).toBe("add_endpoint");
  expect(String(p.target_files_template)).toContain("src/util.ts");
  expect(String(p.blueprint_aaak)).toContain("verify:bun");
  // the incremental re-index knows the freshly edited file
  expect(db.pointerSearch("evoapp", "clamp", 3).length).toBeGreaterThan(0);

  // failure -> fix: a lesson with the coordinates of the repair, 30-day TTL
  genome.noteGenomeToolAfter({
    sessionID: "evo-2",
    tool: "bash",
    input: { command: "bun test" },
    status: "error",
    output: "Error: jwt expiry unvalidated\n  at src/util.ts",
    dir: dirE,
    project: "evoapp",
  });
  genome.noteGenomeToolAfter({ sessionID: "evo-2", tool: "edit", input: { filePath: join(dirE, "src", "util.ts") }, status: "completed" });
  const fixEv = genome.noteGenomeToolAfter({
    sessionID: "evo-2",
    tool: "bash",
    input: { command: "bun run build" },
    status: "completed",
    output: "done",
    dir: dirE,
    project: "evoapp",
  });
  expect(fixEv?.lessonId).toBeTruthy();
  const les = db.lessonGet(fixEv!.lessonId!)!;
  expect(les.severity).toBe("critical"); // jwt in the error -> critical
  expect(String(les.file_pointer)).toContain("src/util.ts:");
  expect(les.expires_at - les.created_at).toBe(30 * 86_400_000);
});

// ===========================================================================
// T11 — Token-Darwin: ROI pruning, 30-day GC, promotion
// ===========================================================================

test("T11 · Token-Darwin audit: ROI<0 pattern pruned + cloaked, expired lesson GC'd, winner promoted", () => {
  const now = Date.now();

  db.patternUpsert({
    patternId: "gauntlet:good",
    projectName: "gauntlet",
    taskCategory: "test_suite",
    triggerKeywords: "run tests",
    blueprintAaak: "bun:test",
    targetFiles: [],
    now,
  });
  db.patternUpsert({
    patternId: "gauntlet:bad",
    projectName: "gauntlet",
    taskCategory: "perf_opt",
    triggerKeywords: "optimize loop",
    blueprintAaak: "guess->retry",
    targetFiles: [],
    now,
  });

  // the winner earns its keep; the loser burns tokens and never helps
  for (let i = 0; i < 3; i++) {
    db.ledgerTouch({ artifactType: "c3_pattern", artifactId: "gauntlet:good", impressions: 1, spent: 40, activations: 1, saved: 6000, now });
  }
  for (let i = 0; i < 4; i++) {
    db.ledgerTouch({ artifactType: "c3_pattern", artifactId: "gauntlet:bad", impressions: 1, spent: 500, now });
  }

  // one lesson is 31 days old (expired), one is fresh
  const oldId = db.lessonUpsert({
    lessonId: "gauntlet:old-bug",
    projectName: "gauntlet",
    bugSummary: "stale bug",
    filePointer: "src/core/db.ts:1-2",
    now: now - 31 * 86_400_000,
  });
  const freshId = db.lessonUpsert({
    lessonId: "gauntlet:fresh-bug",
    projectName: "gauntlet",
    bugSummary: "fresh bug",
    filePointer: "src/auth/jwt.ts:1-2",
    now,
  });

  const rep = darwin.runNightlyDarwinAudit(now);

  // the loser was pruned: ledger says pruned, the pattern is cloaked (ROI<0)
  // and the active genome export refuses to carry it any more
  expect(rep.pruned.some((x) => x.id === "gauntlet:bad")).toBe(true);
  expect(db.ledgerGet("c3_pattern", "gauntlet:bad")!.status).toBe("pruned");
  const bad = db.patternGet("gauntlet:bad")!;
  expect(bad.darwin_roi).toBeLessThan(0);
  expect(db.patternsTop("gauntlet", 20).some((x) => x.pattern_id === "gauntlet:bad")).toBe(false);

  // the winner was promoted and keeps its seat
  const good = db.patternGet("gauntlet:good")!;
  expect(good.darwin_roi).toBeGreaterThan(2);
  expect(db.ledgerGet("c3_pattern", "gauntlet:good")!.status).toBe("thriving");
  expect(db.patternsTop("gauntlet", 20).some((x) => x.pattern_id === "gauntlet:good")).toBe(true);

  // the expired lesson is garbage-collected; the fresh one survives
  expect(rep.lessonsDeleted).toBeGreaterThanOrEqual(1);
  expect(db.lessonGet(oldId)).toBeNull();
  expect(db.lessonGet(freshId)).toBeTruthy();

  // the 2000-token cap certificate still holds after the audit
  for (const g of db.genomesAll(10)) {
    expect(genome.genomeTokens(g).total).toBeLessThanOrEqual(2000);
  }
});

// ===========================================================================
// T12 — the `chronos` tool: genome / synthesize / darwin modes
// ===========================================================================

test("core · tool `chronos` v4: genome certificate, synthesize packet, darwin audit", async () => {
  const f = fakeCtx(TMP);
  await plugin.default.setup(f.ctx);
  const tool = f.tools.find((t) => t.name === "chronos");
  expect(tool).toBeTruthy();
  expect(tool.input.properties.mode.enum).toEqual(["recall", "timeline", "remember", "reflex", "genome", "synthesize", "darwin"]);

  const gOut = await tool.execute({ query: "", mode: "genome", project: "gauntlet" }, { sessionID: "tool-v4" });
  expect(gOut.content).toContain("[CHRONOS|genome|gauntlet|");
  expect(gOut.content).toContain("certified:OK");
  expect(gOut.content).toContain("[C4|");
  expect(gOut.content).toContain("listFlashcards@");

  const sOut = await tool.execute(
    { query: "add new flashcard endpoint", mode: "synthesize", project: "gauntlet" },
    { sessionID: "tool-v4" },
  );
  expect(sOut.content).toContain("[GENOME|gauntlet|add_endpoint");
  expect(sOut.content).toContain("[CHRONOS|synthesize|cat:add_endpoint");

  const dOut = await tool.execute({ query: "", mode: "darwin" }, { sessionID: "tool-v4" });
  expect(dOut.content).toContain("[CHRONOS|darwin|");
  expect(dOut.content).toContain("[ROI|");
});

// ---------------------------------------------------------------------------
// v7.1 · strategy: intent routing + non-similarity evidence selection
// ---------------------------------------------------------------------------
test("T12 · intent router separates ordering / summary / preference / lookup", () => {
  expect(strategy.classifyIntent("Can you list the order in which I brought up the aspects?")).toBe("ordering");
  expect(strategy.classifyIntent("Give me a comprehensive summary of how the project progressed")).toBe("summary");
  expect(strategy.classifyIntent("I prefer terse answers, what tone do you use?")).toBe("preference");
  expect(strategy.classifyIntent("What did Caroline research?")).toBe("lookup");
});

test("T12 · ordering spends every slot on user-turn openers, never on replies", () => {
  const cands = [
    { id: "a1", session: "s1", speaker: "assistant", ordinal: 0, score: 0.99, text: "Sure, here is how" },
    { id: "u1", session: "s1", speaker: "user", ordinal: 1, score: 0.62, text: "I'm trying to implement city autocomplete with a debounce delay and I need help structuring the module." },
    { id: "a2", session: "s1", speaker: "assistant", ordinal: 2, score: 0.98, text: "Use a debounce" },
    { id: "u2", session: "s1", speaker: "user", ordinal: 3, score: 0.55, text: "hmm, what about the 300ms case?" },
    { id: "u3", session: "s1", speaker: "user", ordinal: 4, score: 0.60, text: "I'm having trouble with unhandled promise rejections in fetchWeatherData and want to fix them." },
  ];
  const picked = strategy.selectEvidence(cands, "ordering", 3);
  expect(picked.every((id) => id.startsWith("u"))).toBe(true);
  expect(picked).toContain("u1");
  expect(picked).toContain("u3");
});

test("T12 · summary pairs each opener with its assistant reply", () => {
  const cands = [
    { id: "u1", session: "s1", speaker: "user", ordinal: 0, score: 0.7, text: "I'm trying to build a weather app and I need help structuring the code." },
    { id: "a1", session: "s1", speaker: "assistant", ordinal: 1, score: 0.4, text: "Here are the improvements" },
    { id: "u2", session: "s2", speaker: "user", ordinal: 2, score: 0.6, text: "I'm trying to add a caching layer to keep the bundle small." },
    { id: "a2", session: "s2", speaker: "assistant", ordinal: 3, score: 0.3, text: "Use localStorage" },
  ];
  const picked = strategy.selectEvidence(cands, "summary", 4);
  expect(picked.slice(0, 4).sort()).toEqual(["a1", "a2", "u1", "u2"]);
});

test("T12 · lookup keeps the plain relevance order", () => {
  const cands = [
    { id: "a", session: "s", speaker: "assistant", ordinal: 0, score: 0.9, text: "x" },
    { id: "b", session: "s", speaker: "user", ordinal: 1, score: 0.8, text: "y" },
    { id: "c", session: "s", speaker: "user", ordinal: 2, score: 0.1, text: "z" },
  ];
  expect(strategy.selectEvidence(cands, "lookup", 2)).toEqual(["a", "b"]);
});
