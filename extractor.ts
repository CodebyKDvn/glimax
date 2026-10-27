// ===========================================================================
// extractor.ts — turns raw activity into knowledge, out of band. 3 channels.
//
//   CHANNEL 1  workspace & git autopsy
//              reads package.json / pyproject / Cargo / README / .git by
//              itself, so "eduflash, TypeScript + React, branch feat/flip"
//              is known without the user ever saying it.
//
//   CHANNEL 2  conversational project / progress / open-loop / bi-temporal
//              VI + EN natural language: "đang làm dự án X", "đang bị lỗi",
//              "mượt rồi", "đổi từ A sang B", "từ giờ dùng C".
//
//   CHANNEL 3  idle episodic consolidation
//              when the session goes quiet: what did the hands actually do?
//              which files, which failures, which milestones.
//
// Deterministic, local, no model calls, no network. A miss costs nothing; a
// wrong memory costs trust, so every rule below is conservative.
// ===========================================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { kebab, projectKey, tokens } from "./aaak";
import {
  type EventType,
  addOpenLoop,
  assertEdge,
  getProject,
  l3ForSession,
  l3Insert,
  upsertProject,
} from "./db";

export type Category =
  | "coding_style"
  | "tech_stack"
  | "architecture"
  | "workflow_habit"
  | "constraint"
  | "bug_lesson"
  | "personal_fact"
  | "domain_fact";

export interface Candidate {
  category: Category;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  evidence: string;
}

// ===========================================================================
// shared language helpers (unicode-correct: JS \b is ASCII-only, so `\bđang`
// would never match Vietnamese — every rule here uses explicit lookarounds)
// ===========================================================================

const LB = "(?<![\\p{L}\\p{N}_])";
const RB = "(?![\\p{L}\\p{N}_])";
const rx = (src: string, flags = "iu"): RegExp => new RegExp(src, flags);

function anyMatch(pats: RegExp[], s: string): boolean {
  return pats.some((p) => p.test(s));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a message into clause-sized pieces we can reason about locally. */
export function clauses(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?;…])|\n+|(?:\s*,\s*)|\s+(?:nhưng|but|tuy nhiên|however|và|and|then|rồi thì|thì|nên)\s+/iu)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

function tidy(raw: string): string {
  return String(raw ?? "")
    .replace(/^[\s,:;"'`\-–—•*]+|[\s,:;"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const FILLER = new Set([
  "cái", "con", "phần", "bên", "mình", "tôi", "em", "anh", "chị", "nó", "thì", "là", "và",
  "nhưng", "hôm", "nay", "qua", "mai", "giờ", "bây", "rồi", "nhé", "nha", "ạ", "vẫn", "còn",
  "đang", "đã", "vừa", "chỗ", "việc", "này", "đó", "kia", "cho", "với", "của", "về", "the",
  "a", "an", "my", "our", "and", "but", "then", "so", "let", "lets", "hãy", "xong", "thêm",
  "bị", "hơi", "khá", "rất", "quá", "nhiều", "cũng", "được",
]);

const TRAILING_VERBS = new Set([
  "fix", "sửa", "làm", "viết", "code", "dùng", "xài", "đổi", "chuyển", "thêm", "bỏ",
  "test", "build", "deploy", "optimize", "tối", "ưu",
]);

/** Drop articles/pronouns/time words and trailing verbs from a phrase. */
function stripFillers(s: string): string {
  const ws = String(s ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER.has(w));
  while (ws.length && TRAILING_VERBS.has(ws[ws.length - 1])) ws.pop();
  return ws.join(" ").trim();
}

// ===========================================================================
// tech lexicon — one table, three uses: detect a claimed stack, detect a
// switch (X -> Y), and know which slot a switch belongs to so that closing
// the old edge is possible.
// ===========================================================================

interface TechInfo {
  slot: string;
  canonical: string;
  category: Category;
}

const TECH_TERMS: Array<[string, TechInfo]> = [
  ...mapTerms(["framer-motion", "framer motion", "css 3d", "css3d", "css3", "gsap", "three.js", "threejs",
    "lottie", "react-spring", "animate.css", "canvas"], { slot: "animation_lib", category: "tech_stack" }),
  ...mapTerms(["tailwind", "tailwindcss", "shadcn", "mui", "material ui", "bootstrap", "chakra", "antd", "sass", "scss"],
    { slot: "ui_lib", category: "tech_stack" }),
  ...mapTerms(["react", "react native", "expo", "next.js", "nextjs", "next", "vue", "nuxt", "svelte", "sveltekit",
    "astro", "remix", "flutter", "electron", "tauri"], { slot: "framework", category: "tech_stack" }),
  ...mapTerms(["express", "fastify", "nestjs", "hono", "django", "flask", "fastapi", "laravel", "spring"],
    { slot: "backend", category: "tech_stack" }),
  ...mapTerms(["supabase", "firebase", "appwrite"], { slot: "backend", category: "tech_stack" }),
  ...mapTerms(["prisma", "drizzle", "typeorm", "sequelize", "kysely"], { slot: "orm", category: "tech_stack" }),
  ...mapTerms(["postgres", "postgresql", "sqlite", "mysql", "mongodb", "mongo", "redis", "dynamodb"],
    { slot: "database", category: "tech_stack" }),
  ...mapTerms(["zustand", "redux", "jotai", "recoil", "pinia", "mobx", "tanstack query", "react query"],
    { slot: "state_lib", category: "tech_stack" }),
  ...mapTerms(["typescript", "ts"], { slot: "language", category: "tech_stack" }),
  ...mapTerms(["javascript", "python", "dart", "swift", "kotlin", "golang", "go", "rust", "php", "c#", "java"],
    { slot: "language", category: "tech_stack" }),
  ...mapTerms(["vite", "webpack", "esbuild", "turbo"], { slot: "bundler", category: "tech_stack" }),
  ...mapTerms(["bun", "pnpm", "yarn", "npm"], { slot: "package_manager", category: "tech_stack" }),
  ...mapTerms(["vitest", "jest", "pytest", "playwright", "cypress"], { slot: "test_runner", category: "tech_stack" }),
];

function mapTerms(terms: string[], info: Omit<TechInfo, "canonical">): Array<[string, TechInfo]> {
  return terms.map((t) => [t, { ...info, canonical: kebab(t, 24) }]);
}

const TECH_INDEX = new Map<string, TechInfo>(TECH_TERMS);

/** All lexicon hits inside a clause, in order of appearance. */
export function techMentions(clause: string): Array<{ term: string; info: TechInfo; at: number }> {
  const low = String(clause ?? "").toLowerCase();
  if (!low) return [];
  const out: Array<{ term: string; info: TechInfo; at: number }> = [];
  for (const [term, info] of TECH_INDEX) {
    let from = 0;
    for (;;) {
      const at = low.indexOf(term, from);
      if (at < 0) break;
      const before = at === 0 ? " " : low[at - 1];
      const after = low[at + term.length] ?? " ";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
        out.push({ term, info, at });
      }
      from = at + term.length;
      if (out.length > 12) break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ===========================================================================
// CHANNEL 2a — project / entity detection
// ===========================================================================

/** Strong triggers: whatever follows is almost certainly a project name. */
const STRONG_PROJECT = [
  rx(LB + "(?:d[uự]\\s*[aá]n|project|con\\s+app|[uứ]ng\\s*d[uụ]ng|app)\\s+([^\\s,;.!?]{2,40}(?:\\s+[\\p{L}\\p{N}_\\-.]{2,20}){0,2})" + RB),
];

/** Weak triggers: only accepted when the capture looks like a code name. */
const WEAK_PROJECT = [
  rx(LB + "(?:b[eê]n|l[aà]m\\s+c[aá]i|trong)\\s+([^\\s,;.!?]{2,40})" + RB),
  rx(LB + "(?:working\\s+on|on)\\s+([A-Za-z][\\w.-]{1,30})" + RB),
];

const NOT_A_NAME = new Set([
  "này", "nay", "đó", "kia", "gì", "sao", "thế", "mình", "tôi", "bạn", "nó", "hôm", "mai",
  "qua", "giờ", "bây", "phần", "chỗ", "việc", "lỗi", "code", "web", "mobile", "app", "cái",
  "this", "that", "it", "them", "the", "a", "test", "tests", "dev", "build",
]);

function looksLikeCodeName(s: string): boolean {
  return /^[A-Za-z][\w.-]{1,}$/.test(s.replace(/\s+/g, ""));
}

/** `dự án eduflash, phần ...` -> `eduflash` */
function cleanProjectCapture(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/^[\s"'`(\[]+|[\s"'`)\].,:;]+$/g, "");
  s = s.replace(/^(?:d[uự]\s*[aá]n|project|con\s+app|[uứ]ng\s*d[uụ]ng|app)\s+/iu, "");
  const ws = s.split(/\s+/).filter(Boolean);
  // keep at most 3 words, dropping trailing particles ("eduflash mình",
  // "eduflash đang làm" -> "eduflash") — fillers and verbs alternate
  for (;;) {
    const last = ws.length ? ws[ws.length - 1].toLowerCase() : "";
    if (ws.length && (FILLER.has(last) || TRAILING_VERBS.has(last))) {
      ws.pop();
      continue;
    }
    break;
  }
  while (ws.length > 3) ws.pop();
  s = ws.join(" ").trim();
  if (!s || s.length < 2) return "";
  if (!/[\p{L}\p{N}]/u.test(s)) return "";
  return s;
}

/**
 * Projects this clause is talking about: explicit phrasing first, then any
 * project we already know that is mentioned by name (works from any folder).
 */
export function detectProjectMentions(
  clause: string,
  known: string[] = [],
): Array<{ name: string; confidence: number; evidence: string }> {
  const out: Array<{ name: string; confidence: number; evidence: string }> = [];
  const seen = new Set<string>();

  for (const p of STRONG_PROJECT) {
    const m = p.exec(clause);
    const cand = m ? cleanProjectCapture(m[1]) : "";
    const key = projectKey(cand);
    if (key && !NOT_A_NAME.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push({ name: key, confidence: 0.85, evidence: clause });
    }
  }

  for (const p of WEAK_PROJECT) {
    const m = p.exec(clause);
    const cand = m ? cleanProjectCapture(m[1]) : "";
    const key = projectKey(cand);
    if (!key || seen.has(key) || NOT_A_NAME.has(key)) continue;
    if (!looksLikeCodeName(cand)) continue;
    seen.add(key);
    out.push({ name: key, confidence: 0.6, evidence: clause });
  }

  // a known project named anywhere in the text — even mid-sentence
  const low = clause.toLowerCase();
  for (const name of known) {
    const key = projectKey(name);
    if (!key || seen.has(key)) continue;
    if (low.includes(key)) {
      seen.add(key);
      out.push({ name: key, confidence: 0.9, evidence: clause });
    }
  }

  return out;
}

// ===========================================================================
// CHANNEL 2b — progress: focus, open loops, milestones
// ===========================================================================

const FOCUS_TRIGGER = rx(
  LB +
    "(?:[đd]ang|đã|vừa)\\s+(?:l[aà]m|s[uử]a|fix|vi[eế]t|code|t[aạ]o|th[eê]m|build|implement|debug|refactor|thi[eế]t\\s*k[eế]|x[aâ]y|test|ki[eể]m\\s*tra|t[oố]i\\s*[uư]u|n[aâ]ng\\s*c[aấ]p|ch[uỉ]nh)" +
    RB +
    "|" +
    LB +
    "(?:implementing|debugging|working\\s+on|adding|refactoring|fixing|building|writing|tweaking)" +
    RB,
);

const DONE_TRIGGER = rx(
  LB +
    "(?:xong|ho[aà]n\\s*th[aà]nh|ho[aà]n\\s*t[aấ]t|m[uư][oợ]t|ngon|ổn|ch[aạ]y\\s*[đd][uư][oợ]c|l[aà]m\\s*[đd][uư][oợ]c|fix\\s*[đd][uư][oợ]c|s[uử]a\\s*[đd][uư][oợ]c|gi[aả]i\\s*quy[eế]t\\s*[đd][uư][oợ]c|x[uử]\\s*l[yý]\\s*[đd][uư][oợ]c|đã\\s*fix|done|fixed|works\\s+now|worked|passing|passes|complete[d]?|shipped)" +
    RB,
);

const LOOP_TRIGGER = rx(
  LB +
    "(?:l[oỗ]i|bug|lag|gi[aậ]t|ch[aậ]m|[đd][oơ]|k[eẹ]t|treo|crash|ch[uư]a\\s*(?:xong|ch[aạ]y|[đd][uư][oợ]c|ho[aạ]t\\s*[đd][oộ]ng)|kh[oô]ng\\s*(?:ch[aạ]y|[đd][uư][oợ]c|ho[aạ]t\\s*[đd][oộ]ng|l[aà]m\\s*[đd][uư][oợ]c)|b[iị]\\s*(?:l[oỗ]i|sai)|fail(?:ed|ing)?|not\\s+working|doesn'?t\\s+work|stuck|broken|issue|problem|flaky)" +
    RB,
);

/** Subject of a problem: the words right before the trigger. */
function subjectBefore(clause: string, at: number, projectNames: string[]): string {
  let pre = clause.slice(0, Math.max(0, at));
  for (const n of projectNames) {
    pre = pre.replace(new RegExp(escapeRe(n), "giu"), " ");
  }
  pre = pre.replace(/^\s*(?:h[oô]m\\s*nay|today|sang nay)?\s*/iu, "");
  const cleaned = stripFillers(pre);
  return cleaned && tokens(cleaned).length >= 2 ? kebab(cleaned, 40) : "";
}

/** Milestone text: the clause that said it was done, minus pure filler. */
function milestoneOf(clause: string): string {
  return tidy(clause).slice(0, 140);
}

export interface Progress {
  name: string;
  focus?: string;
  openLoop?: string;
  milestone?: string;
  evidence: string;
}

// ===========================================================================
// CHANNEL 2c — bi-temporal change of mind
// ===========================================================================

export interface Switch {
  from: string;
  to: string;
  slot: string;
  category: Category;
  confidence: number;
  evidence: string;
}

const SWITCH_PATTERNS: Array<{ re: RegExp; from: number | null; to: number | null; conf: number }> = [
  { re: rx("(?:[đd][oổ]i|chuy[eể]n|switch(?:ed|ing)?|migrat(?:e|ed|ing)|move[ds]?)\\s+(?:t[uừ]|from)\\s+(.{2,60}?)\\s+(?:sang|to|th[aà]nh|->)\\s+(.{2,60})"), from: 1, to: 2, conf: 0.9 },
  { re: rx("(?:thay(?:\\s+th[eế])?|replace[ds]?)\\s+(.{2,60}?)\\s+(?:b[aằ]ng|with|cho)\\s+(.{2,60})"), from: 1, to: 2, conf: 0.85 },
  { re: rx("(?:b[oỏ]|drop(?:ped)?|remov(?:e|ed))\\s+(.{2,60}?)(?:\\s+(?:[đd]i|h[aẳ]n|lu[oô]n))?\\s+(?:chuy[eể]n\\s+sang|sang|d[uù]ng|for)\\s+(.{2,60})"), from: 1, to: 2, conf: 0.8 },
  { re: rx("(?:t[uừ]\\s*gi[oờ]|from\\s*now\\s*on)\\s+(?:d[uù]ng|use|x[aà]i|s[uử]\\s*d[uụ]ng)\\s+(.{2,60})"), from: null, to: 1, conf: 0.8 },
  { re: rx("(?:kh[oô]ng\\s*d[uù]ng|no\\s*longer\\s*use|ng[uừ]ng\\s*d[uù]ng|b[oỏ]\\s+h[aẳ]n)\\s+(.{2,60}?)(?:\\s+n[uữ]a)?\\s*$"), from: 1, to: null, conf: 0.8 },
];

/** Fold a spoken tech name into a stable AAAK value: `CSS 3D thuần` -> `css-3d`. */
export function techValue(raw: string): string {
  let s = tidy(raw).toLowerCase();
  // cut a trailing purpose/reason clause: "css 3d cho nhẹ hơn" -> "css 3d"
  s = s.replace(/\s+(?:cho|để|vì|bởi|nên|khi|mà|nhưng|và|rồi)\s+.*$/u, " ");
  s = s.replace(/\b(?:thu[aầ]n|pure|only|nh[eé]|nha|ạ|[đd]i|h[aẳ]n|lu[oô]n|thay|v[aà]o)\b/gu, " ");
  s = s.replace(/[^\p{L}\p{N}+.#-]+/gu, " ");
  return kebab(s, 28);
}

/** Which slot does this tech name belong to? From the lexicon, else unknown. */
function slotOf(term: string): TechInfo | null {
  const key = String(term ?? "").toLowerCase().trim();
  if (!key) return null;
  const direct = TECH_INDEX.get(key);
  if (direct) return direct;
  for (const [t, info] of TECH_INDEX) {
    if (key.includes(t) || t.includes(key)) return info;
  }
  return null;
}

export function detectSwitches(clause: string, liveObjects: string[] = []): Switch[] {
  const out: Switch[] = [];
  for (const p of SWITCH_PATTERNS) {
    const m = p.re.exec(clause);
    if (!m) continue;
    const fromRaw = p.from ? m[p.from] : "";
    const toRaw = p.to ? m[p.to] : "";
    const from = fromRaw ? techValue(fromRaw) : "";
    const to = toRaw ? techValue(toRaw) : "";
    if (!from && !to) continue;

    // Slot: from the lexicon, else from an active edge that used the old value,
    // else a generic slot so the change is still recorded.
    const info = slotOf(fromRaw) ?? slotOf(toRaw);
    const knownEdge = from ? liveObjects.find((o) => o && (o.includes(from) || from.includes(o))) : undefined;
    const slot = info?.slot ?? (knownEdge ? subjectOfObject(knownEdge) : "tech_choice");
    out.push({
      from,
      to,
      slot,
      category: info?.category ?? "tech_stack",
      confidence: p.conf,
      evidence: tidy(clause),
    });
    break;
  }
  return out;
}

function subjectOfObject(_objectText: string): string {
  return "tech_choice";
}

/** "eduflash đang dùng framer-motion" -> slot animation_lib = framer-motion */
export function detectTechClaims(clause: string): Array<{ slot: string; value: string; category: Category; evidence: string }> {
  const out: Array<{ slot: string; value: string; category: Category; evidence: string }> = [];
  if (!/(?:d[uù]ng|x[aà]i|s[uử]\\s*d[uụ]ng|use|using|ch[aạ]y\\s+b[aằ]ng)/iu.test(clause)) return [];
  for (const m of techMentions(clause)) {
    out.push({ slot: m.info.slot, value: m.info.canonical, category: m.info.category, evidence: tidy(clause) });
  }
  return out.slice(0, 3);
}

// ===========================================================================
// CHANNEL 2 — one message in, structure out
// ===========================================================================

export interface MessageAnalysis {
  projects: Progress[];
  switches: Switch[];
  claims: Array<{ slot: string; value: string; category: Category; evidence: string }>;
  facts: Candidate[];
  primaryProject: string | null;
  entities: { projects: string[]; files: string[]; terms: string[] };
}

/**
 * Read one user message. `knownProjects` lets a bare "eduflash" resolve even
 * when the user is standing in an unrelated directory; `defaultProject` keeps
 * follow-up clauses attached to the project already under discussion.
 */
export function analyzeMessage(
  text: string,
  opts: { knownProjects?: string[]; defaultProject?: string | null; liveObjects?: string[] } = {},
): MessageAnalysis {
  const known = opts.knownProjects ?? [];
  const out: MessageAnalysis = {
    projects: [],
    switches: [],
    claims: [],
    facts: [],
    primaryProject: null,
    entities: { projects: [], files: [], terms: [] },
  };
  const src = String(text ?? "");
  if (!src.trim()) return out;

  let sticky = opts.defaultProject && projectKey(opts.defaultProject) ? projectKey(opts.defaultProject) : null;
  const byProject = new Map<string, Progress>();

  for (const clause of clauses(src)) {
    const mentions = detectProjectMentions(clause, known);
    const names = mentions.map((m) => m.name);
    const project = names[0] ?? sticky;
    if (names.length) {
      sticky = names[names.length - 1];
      for (const n of names) if (!out.entities.projects.includes(n)) out.entities.projects.push(n);
    }

    // --- progress signals (only meaningful once we know whose project it is)
    const focusM = FOCUS_TRIGGER.exec(clause);
    const doneM = DONE_TRIGGER.exec(clause);
    const loopM = LOOP_TRIGGER.exec(clause);

    if (project) {
      let p = byProject.get(project);
      const ensure = (): Progress => {
        if (!p) {
          p = { name: project, evidence: tidy(clause) };
          byProject.set(project, p);
        }
        return p;
      };

      if (doneM) {
        const g = ensure();
        g.milestone = milestoneOf(clause);
        const subj = subjectBefore(clause, doneM.index, names);
        if (subj) g.focus = g.focus ?? subj;
      } else if (loopM) {
        const g = ensure();
        g.openLoop = tidy(clause)
          .replace(/^(?:nhưng|mà|và|nên|thì|rồi|but|and|so)\s+/iu, "")
          .slice(0, 120);
        const subj = subjectBefore(clause, loopM.index, names);
        if (subj) g.focus = g.focus ?? subj;
      } else if (focusM) {
        const rest = clause.slice(focusM.index + focusM[0].length);
        let cleaned = rest;
        for (const n of names) cleaned = cleaned.replace(new RegExp(escapeRe(n), "giu"), " ");
        const subj = stripFillers(cleaned) || subjectBefore(clause, focusM.index, names);
        const g = ensure();
        if (subj && tokens(subj).length >= 1) g.focus = g.focus ?? kebab(subj, 40);
      } else if (names.length) {
        ensure();
      }
    }

    // --- bi-temporal change of mind (may or may not name a project)
    const sw = detectSwitches(clause, opts.liveObjects);
    for (const s of sw) {
      out.switches.push(s);
      if (project && !byProject.has(project)) {
        byProject.set(project, { name: project, evidence: tidy(clause) });
      }
    }

    // --- stack claims
    const claims = detectTechClaims(clause);
    for (const c of claims) {
      out.claims.push(c);
      if (!out.entities.terms.includes(c.value)) out.entities.terms.push(c.value);
    }
  }

  out.facts = extractExplicit(src);
  out.projects = [...byProject.values()];
  out.primaryProject = sticky ?? out.projects[0]?.name ?? null;
  return out;
}

// ===========================================================================
// CHANNEL 1 — workspace & git autopsy
// ===========================================================================

export interface Workspace {
  dir: string;
  name: string | null;
  path: string;
  summary: string | null;
  stack: string[];
  description: string | null;
  branch: string | null;
  commit: string | null;
  kind: string | null;
}

const STACK_TAGS: Array<[string, string]> = [
  ["typescript", "ts"], ["react-native", "rn"], ["react", "react"], ["next", "next"], ["vue", "vue"],
  ["svelte", "svelte"], ["astro", "astro"], ["remix", "remix"], ["nuxt", "nuxt"], ["expo", "expo"],
  ["tailwindcss", "tailwind"], ["@mui/material", "mui"], ["bootstrap", "bootstrap"], ["shadcn", "shadcn"],
  ["express", "express"], ["fastify", "fastify"], ["@nestjs/core", "nest"], ["hono", "hono"],
  ["prisma", "prisma"], ["drizzle-orm", "drizzle"], ["better-sqlite3", "sqlite"], ["pg", "postgres"],
  ["mongoose", "mongo"], ["zustand", "zustand"], ["redux", "redux"], ["@reduxjs/toolkit", "redux"],
  ["vite", "vite"], ["framer-motion", "framer"], ["gsap", "gsap"], ["vitest", "vitest"], ["jest", "jest"],
  ["playwright", "playwright"], ["tailwind", "tailwind"], ["electron", "electron"], ["flutter", "flutter"],
];

const WS_CACHE = new Map<string, { at: number; ws: Workspace }>();
const WS_TTL = 60_000;

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

/** Strip a scope and a redundant prefix: `@acme/web` -> `web`, `opencode-x` -> `x`. */
function shortName(pkgName: string, dirBase: string): string {
  let n = pkgName.includes("/") ? pkgName.split("/").pop()! : pkgName;
  n = n.replace(/^node_modules$/, "");
  if (dirBase && n.endsWith(dirBase) && n.length > dirBase.length) n = dirBase;
  return projectKey(n);
}

/**
 * Everything we can learn about the working directory without asking anyone.
 * Cached for a minute: package.json does not change that fast.
 */
export function workspaceAutopsy(dir: string, now = Date.now()): Workspace {
  const cached = WS_CACHE.get(dir);
  if (cached && now - cached.at < WS_TTL) return cached.ws;

  const base = basename(String(dir ?? "")) || "root";
  const ws: Workspace = {
    dir,
    path: dir,
    name: projectKey(base),
    summary: null,
    stack: [],
    description: null,
    branch: null,
    commit: null,
    kind: null,
  };

  // --- node / bun
  const pkg = readJson(join(dir, "package.json"));
  if (pkg && typeof pkg === "object") {
    ws.kind = existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "node";
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      ws.name = shortName(pkg.name.trim(), projectKey(base));
    }
    if (typeof pkg.description === "string" && pkg.description.trim()) {
      ws.description = pkg.description.trim().slice(0, 120);
    }
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    const keys = Object.keys(deps).map((k) => k.toLowerCase());
    for (const [dep, tag] of STACK_TAGS) {
      if (keys.includes(dep) && !ws.stack.includes(tag)) ws.stack.push(tag);
      if (ws.stack.length >= 4) break;
    }
    if (!ws.stack.includes("ts") && keys.includes("typescript")) ws.stack.unshift("ts");
  }

  // --- python
  const pyproject = readText(join(dir, "pyproject.toml"), 100_000);
  if (pyproject) {
    ws.kind = ws.kind ?? "python";
    const nm = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject);
    if (nm && !ws.name) ws.name = projectKey(nm[1]);
    if (/^\s*requires-python/m.test(pyproject) || /\[project\]/.test(pyproject)) {
      if (!ws.stack.includes("python")) ws.stack.unshift("python");
    }
  } else if (existsSync(join(dir, "requirements.txt"))) {
    ws.kind = ws.kind ?? "python";
    if (!ws.stack.includes("python")) ws.stack.unshift("python");
  }

  // --- rust / go
  const cargo = readText(join(dir, "Cargo.toml"), 100_000);
  if (cargo) {
    ws.kind = ws.kind ?? "rust";
    const nm = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo);
    if (nm && !ws.name) ws.name = projectKey(nm[1]);
    if (!ws.stack.includes("rust")) ws.stack.unshift("rust");
  }
  const gomod = readText(join(dir, "go.mod"), 100_000);
  if (gomod) {
    ws.kind = ws.kind ?? "go";
    const nm = /^\s*module\s+(\S+)/m.exec(gomod);
    if (nm && !ws.name) ws.name = projectKey(nm[1].split("/").pop() ?? "");
    if (!ws.stack.includes("go")) ws.stack.unshift("go");
  }

  // --- README title
  const readme =
    readText(join(dir, "README.md"), 40_000) ??
    readText(join(dir, "readme.md"), 40_000) ??
    readText(join(dir, "README.MD"), 40_000);
  if (readme) {
    const m = /^\s*#\s+(.{2,80})$/m.exec(readme) ?? /^\s*([^\n#].{2,80})$/m.exec(readme);
    if (m) ws.description = ws.description ?? tidy(m[1]).slice(0, 100);
  }

  // --- git, straight off the disk (no subprocess, no network)
  const head = readText(join(dir, ".git", "HEAD"), 2000);
  if (head) {
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
    ws.branch = m ? m[1].trim() : head.trim().slice(0, 12);
    const msg = readText(join(dir, ".git", "COMMIT_EDITMSG"), 4000);
    if (msg) {
      const first = msg.split("\n").find((l) => l.trim());
      if (first) ws.commit = tidy(first).slice(0, 90);
    }
  }

  // --- AAAK summary: `eduflash|ts+react+tailwind`
  const purpose = ws.name ? projectKey(ws.name).slice(0, 28) : "";
  const stack = ws.stack.slice(0, 4).join("+");
  if (purpose || stack) ws.summary = `${purpose || "unknown"}|${stack || "?"}`;

  WS_CACHE.set(dir, { at: now, ws });
  return ws;
}

// ===========================================================================
// CHANNEL 2d — explicit rules & preferences (atomic facts, v1 rules kept)
// ===========================================================================

const ALWAYS = [
  rx(LB + "lu[oô]n\\s+(?:lu[oô]n\\s+)?(?:d[uù]ng|ph[aả]i|vi[eế]t|th[eê]m|c[oó]|l[aà]m)" + RB),
  rx(LB + "t[uừ]\\s*(?:gi[oờ]|nay)\\s+(?:tr[oở]\\s+đi\\s+)?"),
  rx(LB + "always" + RB),
  rx(LB + "from now on" + RB),
  rx(LB + "prefer" + RB),
  rx(LB + "t[aô]i th[ií]ch"),
  rx(LB + "m[iì]nh th[ií]ch"),
  rx(LB + "t[aô]i mu[oố]n" + RB),
  rx(LB + "m[iì]nh mu[oố]n" + RB),
];

const NEVER = [
  rx(LB + "đ[uừ]ng bao gi[oờ]" + RB),
  rx(LB + "kh[oô]ng bao gi[oờ]" + RB),
  rx(LB + "đ[uừ]ng\\s+(?:d[uù]ng|vi[eế]t|th[eê]m|l[aà]m)" + RB),
  rx(LB + "never" + RB),
  rx(LB + "do ?n'?t" + RB),
  rx(LB + "avoid" + RB),
  rx(LB + "kh[oô]ng (?:n[eê]n|đ[uư][oợ]c)" + RB),
];

const REMEMBER = [
  rx(LB + "nh[oớ] (?:r[aằ]ng|l[aà]|gi[uù]p)" + RB),
  rx(LB + "ghi nh[oớ]" + RB),
  rx(LB + "l[uư]u [ýy]" + RB),
  rx(LB + "remember" + RB),
  rx(LB + "note that" + RB),
  rx(LB + "keep in mind" + RB),
];

const SWITCH_HINT = [
  rx(LB + "chuy[eể]n sang" + RB),
  rx(LB + "đ[oổ]i sang" + RB),
  rx(LB + "switch(?:ing)? to" + RB),
  rx(LB + "migrate(?:d)? to" + RB),
  rx(LB + "thay v[ìi]" + RB),
  rx(LB + "thay cho" + RB),
  rx(LB + "instead of" + RB),
  rx(LB + "t[ừ] b[oỏ]" + RB),
  rx(LB + "(?:no longer|kh[oô]ng d[uù]ng)" + RB),
];

function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?;])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && s.length < 600);
}

function stripTrigger(s: string): string {
  return s
    .replace(/^(?:lu[oô]n(?: lu[oô]n)?|t[uừ] (?:gi[oờ]|nay)|t[aô]i|m[iì]nh|b[aạ]n|h[aã]y)\s+/iu, "")
    .replace(/^(?:always|never|please|from now on|remember(?: that)?|note that|keep in mind)\s+/iu, "")
    .replace(/^(?:đ[uừ]ng bao gi[oờ]|kh[oô]ng bao gi[oờ]|đ[uừ]ng|kh[oô]ng n[eê]n)\s+/iu, "")
    .replace(/^(?:chuy[eể]n sang|đ[oổ]i sang|switch(?:ing)? to|migrate(?:d)? to|d[uù]ng)\s+/iu, "")
    .replace(/^(?:r[aằ]ng|l[aà])\s+/iu, "");
}

/**
 * Mine one message for stated rules, preferences, prohibitions.
 * Deterministic and conservative: a miss costs nothing, a wrong fact costs
 * the model's trust, so thresholds favour precision.
 */
export function extractExplicit(text: string): Candidate[] {
  const out: Candidate[] = [];
  if (!text || text.length < 4) return out;

  for (const s of sentences(text)) {
    const isNever = anyMatch(NEVER, s);
    const isAlways = anyMatch(ALWAYS, s);
    const isRemember = anyMatch(REMEMBER, s);
    const isSwitch = anyMatch(SWITCH_HINT, s);
    if (!isNever && !isAlways && !isRemember && !isSwitch) continue;

    const mention = techMentions(s)[0];
    const obj = tidy(stripTrigger(s));
    if (!obj || obj.length < 2) continue;

    if (mention) {
      out.push({
        category: isNever ? "constraint" : mention.info.category,
        subject: mention.info.slot,
        predicate: isNever ? "avoid" : "prefer",
        object: mention.info.canonical,
        confidence: isSwitch ? 0.9 : isNever ? 0.85 : 0.75,
        evidence: s,
      });
    } else {
      const category: Category = isNever
        ? "constraint"
        : isRemember
          ? "personal_fact"
          : isSwitch
            ? "tech_stack"
            : "coding_style";
      out.push({
        category,
        subject: "rule:" + kebab(obj, 40),
        predicate: isNever ? "forbid" : "require",
        object: obj,
        confidence: isRemember ? 0.7 : isNever ? 0.8 : 0.65,
        evidence: s,
      });
    }
  }

  return dedupe(out);
}

function dedupe(cs: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of cs) {
    const k = `${c.subject}|${c.predicate}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ===========================================================================
// CHANNEL 1b — implicit habits from tool calls
// ===========================================================================

const PKG_OF_FILE: Array<[RegExp, string]> = [
  [/package\.json$/i, "node"],
  [/bun\.lockb?$/i, "bun"],
  [/pnpm-lock\.yaml$/i, "pnpm"],
  [/yarn\.lock$/i, "yarn"],
  [/Cargo\.toml$/i, "cargo"],
  [/pyproject\.toml$|requirements\.txt$/i, "python"],
  [/go\.mod$/i, "go"],
];

const CMD_PATTERNS: Array<{ re: RegExp; subject: string; category: Category; object: string }> = [
  { re: /^\s*(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b/i, subject: "test_command", category: "workflow_habit", object: "" },
  { re: /\b(?:vitest|jest|pytest)\b/i, subject: "test_command", category: "workflow_habit", object: "" },
  { re: /^\s*(?:bun|npm|pnpm|yarn)\s+run\s+build\b/i, subject: "build_command", category: "workflow_habit", object: "" },
  { re: /^\s*(?:bun|npm|pnpm|yarn)\s+run\s+(?:dev|start)\b/i, subject: "dev_command", category: "workflow_habit", object: "" },
  { re: /^\s*git\s+commit\b/i, subject: "vcs", category: "workflow_habit", object: "git" },
  { re: /\bbun\s+(?:add|install|i)\b/i, subject: "package_manager", category: "tech_stack", object: "bun" },
  { re: /\bpnpm\s+(?:add|install|i)\b/i, subject: "package_manager", category: "tech_stack", object: "pnpm" },
  { re: /\bnpm\s+(?:install|i)\b/i, subject: "package_manager", category: "tech_stack", object: "npm" },
  { re: /\byarn\s+(?:add|install)\b/i, subject: "package_manager", category: "tech_stack", object: "yarn" },
  { re: /\btsc\b|--noEmit\b/i, subject: "typecheck_command", category: "workflow_habit", object: "" },
  { re: /\b(?:eslint|biome|prettier|ruff)\b/i, subject: "lint_command", category: "workflow_habit", object: "" },
];

export function implicitFromTool(e: {
  tool: string;
  input: any;
  status: "completed" | "error" | "other";
  output: string;
}): Candidate[] {
  const out: Candidate[] = [];
  const tool = String(e.tool ?? "");
  const input = e.input ?? {};

  if (tool === "shell" || tool === "bash") {
    const cmd = String(input.command ?? "").trim();
    if (cmd && cmd.length < 400 && e.status === "completed") {
      for (const p of CMD_PATTERNS) {
        if (p.re.test(cmd)) {
          out.push({
            category: p.category,
            subject: p.subject,
            predicate: "uses",
            object: p.object || firstMeaningful(cmd),
            confidence: 0.55,
            evidence: cmd.slice(0, 200),
          });
        }
      }
    }
  }

  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "multiedit") {
    const fp = String(input.filePath ?? input.path ?? "");
    if (fp) {
      const base = fp.split("/").pop() ?? "";
      const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
      const dir = fp.split("/").slice(0, -1).join("/");
      if (ext) {
        out.push({ category: "coding_style", subject: "file_extension", predicate: "uses", object: ext, confidence: 0.4, evidence: fp });
      }
      const casing = detectCasing(base);
      if (casing) {
        out.push({ category: "coding_style", subject: "file_naming", predicate: "uses", object: casing, confidence: 0.45, evidence: base });
      }
      const layer = detectLayer(dir);
      if (layer) {
        out.push({ category: "architecture", subject: "source_layout", predicate: "uses", object: layer, confidence: 0.45, evidence: fp });
      }
      for (const [re, pkg] of PKG_OF_FILE) {
        if (re.test(base)) {
          out.push({ category: "tech_stack", subject: "package_manager", predicate: "uses", object: pkg, confidence: 0.6, evidence: fp });
        }
      }
    }
  }

  return dedupe(out);
}

function firstMeaningful(cmd: string): string {
  return tidy(cmd.split(/\s+/).filter(Boolean).slice(0, 3).join(" "));
}

function detectCasing(base: string): string | null {
  const stem = base.replace(/\.[^.]+$/, "");
  if (!stem) return null;
  if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(stem)) return "kebab-or-snake";
  if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return "camelCase";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(stem)) return "PascalCase";
  if (/^[a-z0-9]+$/.test(stem)) return "lowercase";
  return null;
}

function detectLayer(dir: string): string | null {
  const layers = ["src", "lib", "app", "components", "pages", "routes", "server", "client", "api", "db", "test", "tests", "__tests__", "utils", "hooks", "plugins"];
  const hits = dir.split("/").filter((p) => layers.includes(p.toLowerCase()));
  return hits.length ? hits.join("+") : null;
}

// ------------------------------------------------------- error -> fix pair

interface PendingError {
  sessionID: string;
  command: string;
  output: string;
  at: number;
  filesTouched: Set<string>;
}

const pending = new Map<string, PendingError>();
const ERROR_TTL = 20 * 60 * 1000;

export function noteFailure(sessionID: string, command: string, output: string): void {
  if (!command) return;
  pending.set(sessionID, {
    sessionID,
    command,
    output: String(output ?? "").slice(0, 800),
    at: Date.now(),
    filesTouched: new Set(),
  });
}

export function noteFileTouched(sessionID: string, filePath: string): void {
  const p = pending.get(sessionID);
  if (p && filePath) p.filesTouched.add(filePath);
}

export function clearFailure(sessionID: string): void {
  pending.delete(sessionID);
}

/**
 * A failed command later followed by a file edit is the single most valuable
 * implicit signal we get: "this error, in this file, was fixed this way".
 */
export function harvestBugLesson(sessionID: string, now = Date.now()): Candidate | null {
  const p = pending.get(sessionID);
  if (!p) return null;
  if (now - p.at > ERROR_TTL) {
    pending.delete(sessionID);
    return null;
  }
  const files = [...p.filesTouched];
  if (!files.length) return null;
  pending.delete(sessionID);

  const errLine = firstErrorLine(p.output);
  const where = files.slice(0, 2).join(",");
  return {
    category: "bug_lesson",
    subject: "bug:" + kebab(errLine, 44),
    predicate: "fixed_by",
    object: `${errLine} @ ${where} (via \`${p.command.slice(0, 80)}\`)`,
    confidence: 0.7,
    evidence: `${p.command}\n${p.output}`.slice(0, 700),
  };
}

/** First line that names a failure, else the first non-empty line. Shared with cortex. */
export function firstErrorLine(output: string): string {
  const lines = String(output ?? "").split("\n");
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (/(error|exception|failed|failure|cannot|undefined|Traceback|panic)/i.test(t)) {
      return t.replace(/^(?:at\s+)?/, "").slice(0, 140);
    }
  }
  return (lines.find((l) => l.trim()) ?? "unknown error").trim().slice(0, 140);
}

/**
 * The user is rejecting the last approach ("sai rồi", "đừng làm thế", "dùng X
 * đi", "that's wrong"). Deterministic phrase list: this is a reflex trigger,
 * not a sentiment problem — a false positive only re-roles one journal entry.
 */
export function detectUserCorrection(text: string): boolean {
  const t = String(text ?? "").slice(0, 300).toLowerCase();
  if (!t) return false;
  return (
    /(?:^|[^\p{L}])(?:sai(?:\s+(?:rồi|be|bét|rồi mà))?|không\s+(?:đúng|phải)|đừng\s+(?:làm|dùng|chạy|sửa)|thay\s+vì|làm\s+lại|sửa\s+lại|thử\s+(?:lại|cách khác))(?=[^\p{L}]|$)/u.test(
      t,
    ) ||
    /\b(?:that'?s (?:wrong|not (?:it|right))|not what i|don'?t (?:do|use|run)|instead (?:use|do|try)|wrong (?:approach|way)|undo that|revert (?:that|it))\b/.test(
      t,
    )
  );
}


// ------------------------------------------------------------------ apply

/** Persist candidates as bi-temporal edges + keep the verbatim evidence. */
export function applyCandidates(
  candidates: Candidate[],
  opts: { scope: string; sessionID: string; projectName?: string | null; projectPath?: string | null; sourceMessageId?: string },
): number {
  let n = 0;
  for (const c of candidates) {
    try {
      const aaak = `[MEM|${c.category}|${c.subject}=${c.object}]`;
      const r = assertEdge({
        scope: opts.scope,
        category: c.category,
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        aaak,
        confidence: c.confidence,
        // v4.1: every edge carries the message it came from.
        meta: { subject: c.subject, predicate: c.predicate, object: c.object, source_msg: opts.sourceMessageId ?? null },
      });
      if (r && !r.reinforced) {
        l3Insert({
          sessionID: opts.sessionID,
          projectName: opts.projectName ?? null,
          projectPath: opts.projectPath ?? null,
          eventType: "tool_use" as EventType,
          content: `[${c.category}] ${c.evidence}`,
          meta: { subject: c.subject, predicate: c.predicate, object: c.object, edgeId: r.id },
        });
        n++;
      }
    } catch {}
  }
  return n;
}

// ===========================================================================
// CHANNEL 3 — idle episodic consolidation
// ===========================================================================

export interface Consolidation {
  sessionID: string;
  project: string | null;
  files: string[];
  focus: string | null;
  loops: string[];
  milestone: string | null;
  commits: string[];
  counts: { edits: number; commands: number; failures: number };
}

/**
 * Read what this session actually did (files touched, commands run, failures,
 * commits) and distil it into the project's episodic memory. Runs on idle, so
 * nobody is waiting for it.
 */
export function consolidateSession(
  sessionID: string,
  project: string | null,
  now = Date.now(),
): Consolidation {
  const rows = l3ForSession(sessionID, 300);
  const fileCount = new Map<string, number>();
  const loops: string[] = [];
  const commits: string[] = [];
  let edits = 0;
  let commands = 0;
  let failures = 0;

  for (const r of rows) {
    const type = String(r.event_type);
    if (type === "file_edit" || type === "file_edit_diff") {
      edits++;
      for (const f of filePathsOfRow(r)) {
        const stem = kebab(basename(f).replace(/\.[^.]+$/, ""), 40);
        if (stem) fileCount.set(stem, (fileCount.get(stem) ?? 0) + 1);
      }
    } else if (type === "bash_cmd") {
      commands++;
      const meta = parseJson(r.meta_json);
      const cmd = commandOfRow(r);
      if (meta?.status === "error") {
        failures++;
        if (cmd) loops.push(`lệnh lỗi: ${cmd.slice(0, 50)}`);
      }
    } else if (type === "error_fix" || type === "error_resolved") {
      // a resolved error closes loops rather than opening them: nothing to do
      // here, the open loop was already removed when the fix was recognised.
      failures = Math.max(0, failures - 1);
    } else if (type === "git_state" || type === "git_commit") {
      const first = String(r.raw_content ?? "").split("\n")[0];
      if (first) commits.push(tidy(first).slice(0, 90));
    }
  }

  const topFile = [...fileCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const c: Consolidation = {
    sessionID,
    project,
    files: [...fileCount.keys()].slice(0, 8),
    focus: topFile,
    loops: dedupeStrings(loops).slice(0, 3),
    milestone: commits[0] ?? null,
    commits: dedupeStrings(commits).slice(0, 3),
    counts: { edits, commands, failures },
  };
  return c;
}

/** Apply a consolidation to the project story — only fills gaps, never lies. */
export function applyConsolidation(c: Consolidation, now = Date.now()): string[] {
  if (!c.project) return [];
  const applied: string[] = [];
  const row = getProject(c.project);
  if ((!row?.current_focus || row.current_focus.length < 3) && c.focus) {
    upsertProject({ name: c.project, focus: c.focus, now });
    applied.push(`focus=${c.focus}`);
  }
  for (const l of c.loops) {
    if (addOpenLoop(c.project, l, now)) applied.push(`open=${l}`);
  }
  if (c.milestone && row?.last_milestone !== c.milestone) {
    upsertProject({ name: c.project, milestone: c.milestone, now });
    applied.push(`milestone=${c.milestone}`);
  }
  return applied;
}

function parseJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** File paths a stored row mentions, from either JSON column. Shared with cortex. */
export function filePathsOfRow(r: { file_paths_json?: string | null; entities_json?: string | null }): string[] {
  const out: string[] = [];
  for (const j of [r.file_paths_json, r.entities_json]) {
    const v = parseJson(j);
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
    else if (v && Array.isArray((v as any).files)) for (const x of (v as any).files) if (typeof x === "string") out.push(x);
  }
  return out;
}

function commandOfRow(r: { raw_content?: string }): string {
  const t = String(r.raw_content ?? "");
  const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").slice(0, 80);
  return t.replace(/\s+/g, " ").slice(0, 60);
}

function dedupeStrings(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim()))];
}

export const __internals = {
  pending,
  stripFillers,
  subjectBefore,
  slotOf,
  clauses,
  cleanProjectCapture,
  techValue,
  TECH_INDEX,
};
