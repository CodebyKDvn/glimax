// ===========================================================================
// chronos-memory — living temporal memory for OpenCode. v4.0 "OMEGA-GENOME"
//
//   install:  ~/.config/opencode/plugin/chronos-memory/
//   config:   { "plugins": ["./plugin/chronos-memory"] }
//   brain:    ~/.local/share/opencode/chronos-memory/brain.sqlite
//
// v4.0 adds the Project Genome Architecture (genome.ts): every project is a
// five-chromosome genome (arch DNA / dependency graph / pattern library /
// semantic line pointers / evolution memory) capped at 2000 tokens, plus the
// Token-Darwin governance layer (darwin.ts): ROI bookkeeping, nightly pruning
// of negative-ROI artifacts, 30-day lesson GC and hard budget enforcement.
// A technical task gets a synthesized packet (<=1700 tokens) with TOP-3
// surgical code slices read by exact line ranges; greetings cost 0 tokens.
//
// v3.0 adds the enactive cerebellum (cortex.ts): tool.execute.before rewrites
// proven command mistakes with 0 context tokens, failure->fix pairs become
// [REFLEX] engrams, the workspace config is digested into memory, dead ends
// are pruned on idle and matured lessons merge (reverse token scaling).
//
// WHAT COSTS TOKENS (and what does not)
//   prompt   hook  harvest L3 + project/progress/fact mining    0 tokens out
//   tool     hook  learn habits, pair error -> fix              0 tokens out
//   before   hook  rewrite the command itself (interceptors)    0 tokens
//   context  hook  push ONE frozen block, plus at most one     0-85 tokens
//                  micro memory line and one reflex line, each
//                  only when the gate says it is relevant
//   event    stream consolidate the project story while idle    0 tokens out
//
// The block is computed once per session (l0_snapshots) and never changes
// inside it, so the provider's prompt cache keeps hitting; the memory line is
// appended at the END of the system array, so it cannot disturb the prefix.
//
// ---------------------------------------------------------------------------
// API NOTE — V1 hook names vs the live V2 API (OpenCode 2.x):
//
//   V1 name (as specified)              live V2 equivalent
//   chat.message                    ->  ctx.session.hook("prompt")
//   experimental.chat.system.transform -> ctx.session.hook("context")
//   event: session.idle             ->  ctx.event.subscribe() "session.idle"
//   tool.execute.after              ->  ctx.tool.hook("execute.after")
//   session.compacted               ->  both of the above
//   tool registration               ->  ctx.tool.transform(editor => editor.add)
//
// The V1 hook set was removed in OpenCode v2; these are the real names. The
// behaviour, the AAAK format and the token budgets are unchanged.
//
// Every entry point is defensive: a broken brain degrades to a normal
// OpenCode session, never a crashed one.
// ===========================================================================

import { basename } from "node:path";
import {
  AAAK_BEHAVIOR,
  aaakReflex,
  analyzeQuery,
  apexGraphWeight,
  calibratedMerge,
  estimateTokens,
  graphQueryCoverage,
  isoDay,
  kebab,
  projectKey,
  relTime,
} from "./aaak";
import {
  type Edge,
  type EventType,
  addOpenLoop,
  assertEdge,
  brain,
  closeOpenLoops,
  consolidate,
  edgeHistory,
  expireEdgesByObject,
  fireEngram,
  genomeGet,
  getProject,
  knownProjectNames,
  l1Clear,
  l1MarkKey,
  l3Count,
  l3ForProject,
  l3Insert,
  l3SearchExpanded,
  l3SearchHybrid,
  ledgerTouch,
  macroList,
  openLoops,
  projectScope,
  scopeFor,
  setFocus,
  setMilestone,
  setSupersededBy,
  snapshotGet,
  snapshotSet,
  touchEdges,
  upsertProject,
} from "./db";
import {
  REFLEX_THRESHOLD,
  type Snapshot,
  SNAPSHOT_TOKEN_CAP,
  buildSnapshot,
  compactRecap,
  gate,
  reflexGate,
  reflexSearch,
  search,
  snapshotText,
} from "./retriever";
import {
  type MessageAnalysis,
  analyzeMessage,
  applyCandidates,
  applyConsolidation,
  clearFailure,
  consolidateSession,
  detectProjectMentions,
  harvestBugLesson,
  implicitFromTool,
  noteFailure,
  noteFileTouched,
  workspaceAutopsy,
} from "./extractor";
import {
  TOKENS_PER_AVOIDED_STEP,
  activateMacro,
  cortexStats,
  digestWorkspaceDNA,
  hebbianConsolidate,
  interceptCommand,
  noteToolAfter,
  noteUserMessage,
  pruneSession,
  recordFastPath,
  recordInterception,
} from "./cortex";
import {
  C1_CAP,
  C2_CAP,
  C3_CAP,
  C4_CAP,
  C5_CAP,
  GENOME_CAP,
  PACKET_CAP,
  buildGenome,
  genomeIdleTick,
  genomeTokens,
  noteGenomeMessage,
  noteGenomeToolAfter,
  synthGenome,
} from "./genome";
import { ledgerActivate, runNightlyDarwinAudit } from "./darwin";
import { classifyIntent, selectEvidence } from "./strategy";

// ---------------------------------------------------------------- tuning

const L3_MAX_CHARS = 12_000; // per stored blob
const IDLE_DEBOUNCE_MS = 5_000;
const RECALL_TOKEN_CAP = 290; // `chronos` tool output (v4.1: up to ~10 evidence slices)

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);
/** Tool families the subconscious interceptor may rewrite (cortex.ts). */
const INTERCEPT_TOOLS = new Set(["shell", "bash", "sh"]);

// ------------------------------------------------------------ safe helpers

/** Never let a hook throw into OpenCode's loop. */
function safe<T>(label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    log(label, err);
    return null;
  }
}

function log(label: string, err: unknown) {
  try {
    if (process.env.CHRONOS_DEBUG) {
      console.error(`[chronos] ${label}:`, err instanceof Error ? err.message : err);
    }
  } catch {}
}

/** Fire-and-forget, so harvesting never delays a model call. */
function defer(fn: () => void) {
  try {
    queueMicrotask(() => {
      try {
        fn();
      } catch (err) {
        log("defer", err);
      }
    });
  } catch (err) {
    log("defer-enqueue", err);
  }
}

// ------------------------------------------------------------ session state

interface SessionState {
  sessionID: string;
  dir: string;
  project: string | null; // project key, null when the directory is not one
  scope: string;
  stacks: string[]; // digested tech tags (bun, ts, prisma, …) — v3
  pm: string | null; // package manager the lockfile mandates — v3
  snap: Snapshot | null; // frozen for the session -> prompt cache stays valid
  pending: { text: string; keys: string[] } | null; // armed by prompt, spent by context
  pendingReflex: { text: string; key: string; id: number } | null; // one-shot [REFLEX] — v3
  pendingGenome: { text: string; artifacts: { pointers: string[]; pattern: string | null; lessons: string[] } } | null; // armed by prompt, spent by context — v4
  genomeUsed: { pointers: string[]; pattern: string | null; lessons: string[]; at: number } | null; // for Token-Darwin activations — v4
  lastUser: string;
  files: Set<string>;
  lastIdle: number;
  turns: number;
}

const sessions = new Map<string, SessionState>();
let pluginDir = process.cwd();
/** v4: last full Token-Darwin audit (24h debounce, RAM is enough). */
let lastAuditAt = 0;

/** Channel 1: understand the directory without asking the user anything. */
function primeWorkspace(
  dir: string,
  touch: boolean,
): { dir: string; project: string | null; scope: string; stacks: string[]; pm: string | null } {
  const ws = safe("autopsy", () => workspaceAutopsy(dir));
  // A directory is a project when it has a manifest or a repository — not
  // merely because it exists, or every /tmp folder would become one.
  const named = Boolean(ws && (ws.kind || ws.branch));
  const project = named ? projectKey(ws!.name ?? basename(dir)) : null;
  if (project) {
    safe("project-upsert", () =>
      upsertProject({
        name: project,
        path: dir,
        summary: ws?.summary ?? null,
        status: "active",
        touch,
        now: Date.now(),
      }),
    );
  }
  const scope = project ? scopeFor(project, dir) : projectScope(dir);
  // v3 workspace autophagy: exact scripts, package manager, stack tags and
  // MUST/NEVER rules become memory nodes here — the user never writes a .md.
  const dna = safe("digest-dna", () => digestWorkspaceDNA(dir, scope));
  // v4: keep the genome warm in the background (0 LLM tokens, never blocks).
  maybeBuildGenome(dir, project);
  return {
    dir,
    project,
    scope,
    stacks: dna?.stacks ?? [],
    pm: dna?.pm ?? null,
  };
}

/**
 * v4: (re)build the project genome OFF the hot path. Pure Bun I/O — the
 * build is skipped while the stored genome is younger than 10 minutes.
 */
function maybeBuildGenome(dir: string, project: string | null): void {
  if (!project) return;
  const g = safe("genome-stat", () => genomeGet(project));
  if (g?.last_synthesized_at && Date.now() - g.last_synthesized_at < 10 * 60_000) return;
  defer(() => safe("genome-build", () => buildGenome(dir, project, Date.now())));
}

function ensureSession(sessionID: string, dirHint?: string): SessionState {
  let st = sessions.get(sessionID);
  if (st) return st;
  const dir = String(dirHint || pluginDir || process.cwd());
  const primed = primeWorkspace(dir, true);
  st = {
    sessionID,
    dir: primed.dir,
    project: primed.project,
    scope: primed.scope,
    stacks: primed.stacks,
    pm: primed.pm,
    snap: null,
    pending: null,
    pendingReflex: null,
    pendingGenome: null,
    genomeUsed: null,
    lastUser: "",
    files: new Set(),
    lastIdle: 0,
    turns: 0,
  };
  sessions.set(sessionID, st);
  return st;
}

/** The session's own directory beats the plugin's, when we can ask for it. */
async function refineDir(st: SessionState, get: () => Promise<any>): Promise<void> {
  if (st.dir && st.dir !== pluginDir) return;
  try {
    const info = await get();
    const dir = String(info?.directory ?? info?.path ?? "");
    if (dir && dir !== st.dir) {
      const primed = primeWorkspace(dir, false);
      st.dir = primed.dir;
      st.project = primed.project;
      st.scope = primed.scope;
      st.stacks = primed.stacks;
      st.pm = primed.pm;
      st.snap = null; // nothing frozen yet for this (new) directory
    }
  } catch {}
}

// ----------------------------------------------------------- the snapshot

/**
 * The frozen block for this session. Order of truth: in-memory freeze ->
 * the DB snapshot written when the session first asked -> build + freeze now.
 */
function frozenSnapshot(st: SessionState): Snapshot | null {
  if (st.snap) return st.snap;
  const stored = safe("snapshot-get", () => snapshotGet(st.sessionID));
  if (stored) {
    const text = snapshotText(stored.frozen_dna_aaak, stored.frozen_pulse_aaak);
    st.snap = {
      dna: stored.frozen_dna_aaak,
      pulse: stored.frozen_pulse_aaak,
      text,
      tokens: estimateTokens(text),
    };
    return st.snap;
  }
  const snap = safe("snapshot-build", () =>
    buildSnapshot({ scope: st.scope, project: st.project, cwdProject: st.project, now: Date.now() }),
  );
  if (!snap) return null;
  safe("snapshot-set", () =>
    snapshotSet({ sessionID: st.sessionID, dna: snap.dna, pulse: snap.pulse, scope: st.scope }),
  );
  st.snap = snap;
  return snap;
}

// ------------------------------------------------------ channel 2 handling

/** Scopes a message might be talking about — used by the JIT gate, sync. */
function mentionedScopes(text: string, st: SessionState): string[] {
  const known = safe("known-projects", () => knownProjectNames()) ?? [];
  const out: string[] = [];
  for (const clause of String(text).split(/[.,;\n]/)) {
    for (const m of safe("mentions", () => detectProjectMentions(clause, known)) ?? []) {
      const s = scopeFor(m.name, null);
      if (s !== st.scope && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Persist everything channel 2 learned from one user message. */
function applyAnalysis(
  analysis: MessageAnalysis,
  st: SessionState,
  sessionID: string,
  rawText: string,
  now: number,
): void {
  const project = analysis.primaryProject ?? st.project;
  const scope = scopeFor(project, st.dir);

  // --- project story
  for (const p of analysis.projects) {
    safe("project-progress", () => {
      upsertProject({
        name: p.name,
        path: p.name === st.project ? st.dir : null,
        focus: p.focus ?? null,
        milestone: p.milestone ?? null,
        status: "active",
        now,
      });
      if (p.openLoop) addOpenLoop(p.name, p.openLoop, now);
      if (p.milestone) closeOpenLoops(p.name, p.milestone, now);
    });
  }

  // --- stack claims ("đang dùng framer-motion")
  for (const c of analysis.claims) {
    safe("claim", () =>
      assertEdge({
        scope,
        category: c.category,
        subject: c.slot,
        predicate: "uses",
        object: c.value,
        aaak: `[MEM|${c.category}|${c.slot}=${c.value}]`,
        confidence: 0.7,
        now,
      }),
    );
  }

  // --- bi-temporal change of mind ("đổi từ X sang Y": X is closed, not lost)
  for (const sw of analysis.switches) {
    safe("switch", () => {
      const closed = sw.from ? expireEdgesByObject([scope, "global"], sw.from, now) : [];
      const to = sw.to || null;
      if (to) {
        const r = assertEdge({
          scope,
          category: sw.category,
          subject: sw.slot,
          predicate: "prefer",
          object: to,
          aaak: `[MEM|${sw.category}|${sw.slot}=${to}]`,
          confidence: sw.confidence,
          now,
          meta: sw.from ? { replaced: sw.from } : undefined,
        });
        if (r && closed.length) setSupersededBy(closed, r.id);
      } else if (closed.length) {
        // "không dùng X nữa" with nothing to replace it with
        setSupersededBy(closed, null);
      }
    });
  }

  // --- stated rules / preferences / atomic facts
  if (analysis.facts.length) {
    safe("facts", () =>
      applyFacts(analysis.facts, {
        scope,
        sessionID,
        projectName: project,
        projectPath: st.dir,
      }),
    );
  }

  // --- the verbatim record, always, with its entities
  safe("l3-user", () =>
    l3Insert({
      sessionID,
      projectName: project,
      projectPath: st.dir,
      eventType: "user_msg" as EventType,
      content: rawText.slice(0, L3_MAX_CHARS),
      entities: {
        projects: analysis.entities.projects,
        terms: analysis.entities.terms,
      },
      meta: { focus: analysis.projects.map((p) => p.focus).filter(Boolean) },
      timestamp: now,
    }),
  );

  // --- project summary from the workspace, if we have not stored one yet
  // (only for the session's own directory: a mention of another project must
  // not get *this* folder's summary stamped onto it)
  if (project && project === st.project) {
    const row = safe("project-get", () => getProject(project));
    if (row && !row.summary_aaak) {
      const ws = safe("autopsy2", () => workspaceAutopsy(st.dir));
      if (ws?.summary) safe("summary-set", () => upsertProject({ name: project, summary: ws.summary, touch: false }));
    }
  }
}

// ------------------------------------------------------- channel 3 (idle)

function onIdle(sessionID: string, dirHint?: string, now = Date.now()): void {
  const st = sessions.get(sessionID);
  if (st) {
    if (now - st.lastIdle < IDLE_DEBOUNCE_MS) return;
    st.lastIdle = now;
  } else if (dirHint) {
    primeWorkspace(dirHint, false);
  }

  const project = st?.project ?? null;
  safe("consolidate", () => consolidate(now));

  // v3 cortex, while nobody waits: keep only the straight line of this
  // session (intent -> core files -> verifying command) and let matured
  // lessons merge so the brain gets sharper AND smaller (reverse scaling).
  if (st && sessionID) {
    safe("cortex-prune", () =>
      pruneSession(sessionID, {
        sessionID,
        scope: st.scope,
        stacks: st.stacks,
        dir: st.dir,
        project: st.project,
        now,
      }),
    );
    safe("cortex-hebbian", () => hebbianConsolidate(st.scope, now));
  }

  // v4 Token-Darwin: sweep stale RAM journals, then run the nightly audit at
  // most once per 24h — ROI pruning, 30-day lesson GC, pointer decay and the
  // strict 2000-token cap all settle here while nobody waits. 0 tokens.
  safe("genome-idle", () => genomeIdleTick(now));
  safe("darwin-nightly", () => {
    if (now - lastAuditAt < 24 * 3_600_000) return;
    lastAuditAt = now;
    runNightlyDarwinAudit(now);
  });

  if (!project || !sessionID) return;

  const c = safe("consolidate-session", () => consolidateSession(sessionID, project, now));
  if (c) safe("apply-consolidation", () => applyConsolidation(c, now));
}

// ===========================================================================
// Plugin
// ===========================================================================

export default {
  id: "chronos-memory",

  async setup(ctx: any) {
    // Fail closed at load: with no brain there is nothing to do, and every
    // hook would just be overhead.
    const db = safe("brain-open", () => brain());
    if (!db) return;
    pluginDir = String(ctx?.location?.directory ?? process.cwd());
    log("boot", `brain ready, ${l3Count()} verbatim rows, dir=${pluginDir}`);
    const sessionGet = async (sessionID: string) => ctx?.session?.get?.({ sessionID });

    // -------------------------------------------------------------------
    // 1) HARVEST — every user prompt: the verbatim record, the project
    //    story, progress, open loops, bi-temporal changes. 0 tokens out.
    // -------------------------------------------------------------------
    safe("hook-prompt", () =>
      ctx.session.hook("prompt", async (event: any) => {
        const sessionID: string = String(event?.sessionID ?? "unknown");
        const text: string = String(event?.prompt?.text ?? "");
        const where = String(event?.location?.directory ?? "");
        const st = ensureSession(sessionID, where || pluginDir);
        if (!text) return;
        st.lastUser = text;
        st.turns++;

        // Resolve the session's real directory (a session can live anywhere)
        // before the first context call of this turn freezes the snapshot.
        await refineDir(st, () => sessionGet(sessionID));

        // ARM the micro-gate now that we know the question; the context hook
        // spends it. This is what keeps the injection turn-accurate.
        const otherScopes = mentionedScopes(text, st);
        const g = safe("gate", () =>
          gate(text, {
            scope: st.scope,
            scopes: otherScopes,
            sessionID,
            respectWorkingSet: true,
          }),
        );
        if (g?.text) {
          st.pending = { text: g.text, keys: g.keys };
          for (const k of g.keys) safe("l1-mark", () => l1MarkKey(sessionID, k, "injected"));
          defer(() => touchEdges(g.keys.map((k) => Number(k.replace("edge:", ""))).filter(Number.isFinite)));
        } else {
          st.pending = null;
        }

        // ARM the JIT reflex gate: a learned fast-path for exactly this task,
        // one line, once per session (0 tokens when nothing is proven yet).
        const rg = safe("reflex-gate", () =>
          reflexGate(text, {
            scope: st.scope,
            scopes: otherScopes,
            stacks: st.stacks,
            sessionID,
            respectWorkingSet: true,
          }),
        );
        if (rg?.text) {
          st.pendingReflex = rg;
          safe("l1-mark-rf", () => l1MarkKey(sessionID, rg.key, "injected"));
        } else {
          st.pendingReflex = null;
        }

        // ARM the genome synthesizer (v4): a technical task gets a surgical
        // packet (<=1700 tokens) assembled from the project's 5 chromosomes
        // plus Top-3 code slices read by exact line range. A greeting or
        // chit-chat returns null — exactly 0 tokens, [CHRONOS_PULSE] handles it.
        const gs = st.project
          ? safe("genome-synth", () =>
              synthGenome(text, {
                project: st.project as string,
                projectPath: st.dir,
                sessionID,
                respectWorkingSet: true,
              }),
            )
          : null;
        if (gs?.text) {
          st.pendingGenome = {
            text: gs.text,
            artifacts: { pointers: gs.pointerIds, pattern: gs.patternId, lessons: gs.lessonIds },
          };
          st.genomeUsed = { ...st.pendingGenome.artifacts, at: Date.now() };
        } else {
          st.pendingGenome = null;
        }
        // Feed the evolution engine the intent of this turn.
        safe("genome-note", () => noteGenomeMessage({ sessionID, text }));

        // "sai rồi" / "đừng làm thế": the last win was a dead end — re-role
        // the journal so the next working command becomes the fast-path.
        defer(() =>
          safe("cortex-correct", () =>
            noteUserMessage({ sessionID, scope: st.scope, dir: st.dir, project: st.project, stacks: st.stacks, text }),
          ),
        );

        const now = Date.now();
        defer(() => {
          const analysis = safe("analyze", () =>
            analyzeMessage(text, {
              knownProjects: safe("known", () => knownProjectNames()) ?? [],
              defaultProject: st.project,
            }),
          );
          if (!analysis) return;
          safe("apply", () => applyAnalysis(analysis, st, sessionID, text, now));
        });
      }),
    );

    // -------------------------------------------------------------------
    // 2) HABITS — what the hands did: commands, layout, error -> fix,
    //    file edits, git state. 0 tokens out.
    // -------------------------------------------------------------------
    safe("hook-execute", () =>
      ctx.tool.hook("execute.after", (event: any) => {
        const sessionID: string = String(event?.sessionID ?? "unknown");
        const tool: string = String(event?.tool ?? "");
        const status: string = String(event?.status ?? "");
        if (!sessionID || sessionID === "unknown") return;

        defer(() => {
          const st = ensureSession(sessionID);
          const now = Date.now();
          const input = event?.input ?? {};
          const output = stringifyResult(event?.result, event?.error);
          const files = filePathsOf(input);

          // --- verbatim record
          const type: EventType = SHELL_TOOLS.has(tool)
            ? "bash_cmd"
            : EDIT_TOOLS.has(tool)
              ? "file_edit"
              : "tool_use";
          safe("l3-tool", () =>
            l3Insert({
              sessionID,
              projectName: st.project,
              projectPath: st.dir,
              eventType: type,
              content: `$${tool} ${safeJson(input).slice(0, 600)}\n${output.slice(0, 1500)}`,
              filePaths: files,
              entities: { files },
              meta: { tool, status, callID: event?.id },
              timestamp: now,
            }),
          );

          // --- error -> fix pairing (the most valuable implicit signal)
          if (SHELL_TOOLS.has(tool)) {
            const cmd = String(input?.command ?? "");
            if (status === "error") {
              safe("note-failure", () => noteFailure(sessionID, cmd, output));
            } else if (status === "completed") {
              const lesson = safe("bug-lesson", () => harvestBugLesson(sessionID, now));
              if (lesson) {
                safe("lesson-apply", () =>
                  applyCandidates([lesson], {
                    scope: st.scope,
                    sessionID,
                    projectName: st.project,
                    projectPath: st.dir,
                    sourceMessageId: String(event?.id ?? ""),
                  }),
                );
                safe("l3-fix", () =>
                  l3Insert({
                    sessionID,
                    projectName: st.project,
                    projectPath: st.dir,
                    eventType: "error_fix",
                    content: `${lesson.object}\n--- evidence ---\n${lesson.evidence}`.slice(0, L3_MAX_CHARS),
                    meta: { subject: lesson.subject },
                    timestamp: now,
                  }),
                );
              }
            }
            // --- git state, straight from the command line
            const gitMsg = gitCommitMessage(cmd);
            if (gitMsg) {
              safe("l3-git", () =>
                l3Insert({
                  sessionID,
                  projectName: st.project,
                  projectPath: st.dir,
                  eventType: "git_state",
                  content: gitMsg,
                  timestamp: now,
                }),
              );
              if (st.project) safe("git-milestone", () => setMilestone(st.project, gitMsg, now));
            }
          }

          if (EDIT_TOOLS.has(tool) && status === "completed" && files.length) {
            for (const f of files) {
              st.files.add(f);
              safe("note-touched", () => noteFileTouched(sessionID, f));
            }
            const lesson = safe("bug-lesson-edit", () => harvestBugLesson(sessionID, now));
            if (lesson) {
              safe("lesson-apply-edit", () =>
                applyCandidates([lesson], {
                  scope: st.scope,
                  sessionID,
                  projectName: st.project,
                  projectPath: st.dir,
                  sourceMessageId: String(event?.id ?? ""),
                }),
              );
              safe("l3-fix-edit", () =>
                l3Insert({
                  sessionID,
                  projectName: st.project,
                  projectPath: st.dir,
                  eventType: "error_fix",
                  content: `${lesson.object}\n--- evidence ---\n${lesson.evidence}`.slice(0, L3_MAX_CHARS),
                  meta: { subject: lesson.subject },
                  timestamp: now,
                }),
              );
            }
            safe("clear-failure", () => clearFailure(sessionID));
          }

          // --- implicit conventions
          const imp = safe("implicit", () =>
            implicitFromTool({
              tool,
              input,
              status: status === "completed" ? "completed" : status === "error" ? "error" : "other",
              output,
            }),
          );
          if (imp?.length) {
            safe("implicit-apply", () =>
              applyCandidates(imp, {
                scope: st.scope,
                sessionID,
                projectName: st.project,
                projectPath: st.dir,
                sourceMessageId: String(event?.id ?? ""),
              }),
            );
          }

          // --- v3 cortex: trajectory journal, immediate failure -> fix
          //     pairing, macro crystallization. Deterministic, 0 tokens.
          safe("cortex-after", () =>
            noteToolAfter({
              sessionID,
              scope: st.scope,
              stacks: st.stacks,
              dir: st.dir,
              project: st.project,
              tool,
              input,
              status: status === "completed" ? "completed" : status === "error" ? "error" : String(status),
              output,
            }),
          );

          // --- v4 genome evolution: edits + a successful verify crystallize a
          //     C3 pattern and re-index ONLY the touched files; failure -> fix
          //     writes a C5 lesson. Deterministic, 0 tokens.
          const ge = safe("genome-after", () =>
            noteGenomeToolAfter({
              sessionID,
              tool,
              input,
              status: status === "completed" ? "completed" : status === "error" ? "error" : String(status),
              output,
              dir: st.dir,
              project: st.project,
            }),
          );
          if (ge && (ge.patternId || ge.lessonId) && st.genomeUsed && Date.now() - st.genomeUsed.at < 2 * 3_600_000) {
            // The armed packet just earned its keep — Token-Darwin activations.
            const used = st.genomeUsed;
            st.genomeUsed = null;
            safe("genome-activate", () => ledgerActivate(used));
          }
        });
      }),
    );

    // -------------------------------------------------------------------
    // 2b) REFLEXES — tool.execute.before. Command mistakes that were proven
    //     twice get rewritten here, before the shell ever runs them: the
    //     lesson costs 0 context tokens from then on. Sync, no LLM.
    // -------------------------------------------------------------------
    safe("hook-execute-before", () =>
      ctx.tool.hook("execute.before", (event: any) => {
        const tool = String(event?.tool ?? "");
        if (!INTERCEPT_TOOLS.has(tool)) return;
        const input = event?.input;
        if (!input || typeof input !== "object") return;
        const cmd = String(input.command ?? "");
        if (!cmd.trim()) return;

        const sessionID = String(event?.sessionID ?? "unknown");
        const st = sessions.get(sessionID) ?? ensureSession(sessionID);
        const r = safe("intercept", () =>
          interceptCommand({ tool, command: cmd, scope: st.scope, stacks: st.stacks }),
        );
        if (!r || r.command === cmd) return;

        try {
          input.command = r.command;
        } catch {}
        safe("intercept-log", () =>
          recordInterception({
            sessionID,
            scope: st.scope,
            dir: st.dir,
            project: st.project,
            original: cmd,
            rewritten: r.command,
            hits: r.hits,
          }),
        );
        // Token-Darwin: an interception that actually fires saved a proven
        // dead end — book the win against the rules that made it happen.
        safe("interceptor-darwin", () => {
          for (const id of r.hits ?? []) {
            ledgerTouch({
              artifactType: "v3_interceptor",
              artifactId: String(id),
              activations: 1,
              saved: TOKENS_PER_AVOIDED_STEP,
            });
          }
        });
      }),
    );

    // -------------------------------------------------------------------
    // 3) INJECT — the frozen snapshot, byte-identical for every turn of the
    //    session, plus at most one gated memory line. Appended at the END of
    //    system[] so the cached prefix is untouched.
    // -------------------------------------------------------------------
    safe("hook-context", () =>
      ctx.session.hook("context", (event: any) => {
        const sessionID: string = String(event?.sessionID ?? "unknown");
        if (!Array.isArray(event?.system)) return;
        const st = sessions.get(sessionID) ?? ensureSession(sessionID, String(event?.location?.directory ?? pluginDir));

        const snap = safe("snapshot", () => frozenSnapshot(st));
        if (snap) {
          safe("push-snapshot", () =>
            event.system.push({
              type: "text",
              text: snap.text.slice(0, 4000),
            }),
          );
        }

        // Spend the armed memory exactly once.
        if (st.pending) {
          const p = st.pending;
          st.pending = null;
          safe("push-mem", () => event.system.push({ type: "text", text: `[CHRONOS_MEM] ${p.text}` }));
        }

        // Spend the armed reflex exactly once (and mark the engram as fired).
        if (st.pendingReflex) {
          const p = st.pendingReflex;
          st.pendingReflex = null;
          safe("push-rf", () => {
            event.system.push({ type: "text", text: p.text });
            fireEngram(p.id);
            ledgerTouch({ artifactType: "v3_engram", artifactId: String(p.id), impressions: 1, spent: estimateTokens(p.text) });
          });
        }

        // Spend the armed genome packet exactly once (v4).
        if (st.pendingGenome) {
          const p = st.pendingGenome;
          st.pendingGenome = null;
          safe("push-gp", () => event.system.push({ type: "text", text: p.text }));
        }
      }),
    );

    // -------------------------------------------------------------------
    // 4) COMPACTION — hand back a short AAAK recap so the session keeps its
    //    memory across the boundary.
    // -------------------------------------------------------------------
    safe("hook-compaction", () =>
      ctx.session.hook("compaction", (event: any) => {
        const sessionID: string = String(event?.sessionID ?? "unknown");
        const st = sessions.get(sessionID) ?? ensureSession(sessionID);
        const snap = safe("compaction-snapshot", () => frozenSnapshot(st));
        const turns = Array.isArray(event?.messages) ? event.messages.length : st.turns;
        if (snap) {
          const recap = safe("recap", () => compactRecap(snap, turns));
          if (recap) event.result = { summary: recap };
        }
      }),
    );

    // -------------------------------------------------------------------
    // 5) IDLE — channel 3: consolidate the project story while nobody is
    //    waiting. 0 tokens out.
    // -------------------------------------------------------------------
    safe("event-subscribe", () => {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            const t = String(ev?.type ?? "");
            if (t === "session.idle" || t === "session.compacted") {
              const sessionID = String(ev?.data?.sessionID ?? "");
              const dir = String(ev?.location?.directory ?? "");
              if (sessionID) defer(() => safe("idle", () => onIdle(sessionID, dir || undefined)));
            } else if (t === "session.deleted") {
              const sessionID = String(ev?.data?.sessionID ?? "");
              if (sessionID) {
                sessions.delete(sessionID);
                defer(() => safe("l1-clear", () => l1Clear(sessionID)));
              }
            }
          }
        } catch (err) {
          log("event-stream", err);
        }
      })();
      return controller;
    });

    // -------------------------------------------------------------------
    // 6) TOOL — `chronos`: recall / timeline / remember.
    // -------------------------------------------------------------------
    safe("tool-transform", () =>
      ctx.tool.transform((editor: any) => {
        editor.add({
          name: "chronos",
          description:
            "Long-term memory of past sessions, across projects. Use ONLY when the answer needs the distant past: what we tried before, why a decision changed, what is still open in a project, or the exact code/error from an earlier session. Modes: recall (search facts + verbatim + learned reflexes), timeline (how a project or a habit evolved, including what was dropped), remember (record a milestone, focus, open loop or fact right now), reflex (the self-learning cortex: stats and saved tokens; query `activate <macro_id>` to run a crystallized macro, or `A -> B` to teach a fast-path), genome (the project's 5 chromosome genome with per-chromosome token budgets), synthesize (run the Genome Synthesizer for a task: compact context packet + Top-3 surgical code slices), darwin (run the Token-Darwin audit now: ROI ranking, pruning, caps).",
          input: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "What to look up, or what to remember, in natural language.",
              },
              mode: {
                type: "string",
                enum: ["recall", "timeline", "remember", "reflex", "genome", "synthesize", "darwin"],
                description:
                  "recall = search memory; timeline = evolution over time; remember = write to memory; reflex = self-learning cortex stats / macro activation / fast-path recording; genome = view the 5 chromosomes (C1..C5) + token certification; synthesize = compile the task context packet (1.2k-1.7k tokens) with Top-3 code slices; darwin = run the nightly ROI audit immediately.",
              },
              subject: {
                type: "string",
                description: "For mode=timeline: a project name or a fact subject (e.g. animation_lib).",
              },
              project: {
                type: "string",
                description: "For mode=remember/timeline: which project this belongs to.",
              },
              kind: {
                type: "string",
                enum: ["milestone", "focus", "loop", "fact"],
                description: "For mode=remember: what kind of memory this is (default fact).",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          execute: async (input: any, context: any) => {
            const sessionID = String(context?.sessionID ?? "");
            const st = sessionID ? sessions.get(sessionID) : undefined;
            const dir = st?.dir ?? pluginDir;
            return {
              content: safe("chronos", () =>
                runChronos(
                  {
                    query: String(input?.query ?? ""),
                    mode: String(input?.mode ?? "recall"),
                    subject: input?.subject ? String(input.subject) : undefined,
                    project: input?.project ? String(input.project) : undefined,
                    kind: input?.kind ? String(input.kind) : undefined,
                  },
                  {
                    sessionID,
                    dir,
                    project: st?.project ?? null,
                    scope: st?.scope ?? projectScope(dir),
                    stacks: st?.stacks ?? [],
                  },
                ),
              ) ?? "[CHRONOS] memory unavailable",
            };
          },
        });
      }),
    );

    return () => {
      try {
        sessions.clear();
      } catch {}
    };
  },
} as const;

// ===========================================================================
// `chronos` tool implementation — the only path that spends tokens, capped.
// ===========================================================================

export interface ChronosInput {
  query: string;
  mode: string;
  subject?: string;
  project?: string;
  kind?: string;
}

export function runChronos(
  input: ChronosInput,
  ctxc: { sessionID: string; dir: string; project: string | null; scope: string; stacks?: string[] },
): string {
  const mode = normalizeMode(input.mode);
  if (mode === "remember") return doRemember(input, ctxc);
  if (mode === "timeline") return doTimeline(input, ctxc);
  if (mode === "reflex") return doReflex(input, ctxc);
  if (mode === "genome") return doGenome(input, ctxc);
  if (mode === "synthesize") return doSynthesize(input, ctxc);
  if (mode === "darwin") return doDarwin();
  return doRecall(input, ctxc);
}

function normalizeMode(m: string): "recall" | "timeline" | "remember" | "reflex" | "genome" | "synthesize" | "darwin" {
  const s = String(m ?? "").toLowerCase();
  if (s.startsWith("time") || s === "history") return "timeline";
  if (s.startsWith("rem") || s === "note") return "remember";
  if (s.startsWith("ref")) return "reflex";
  if (s.startsWith("gen") || s.startsWith("chr")) return "genome";
  if (s.startsWith("syn")) return "synthesize";
  if (s.startsWith("dar") || s === "audit" || s === "prune") return "darwin";
  return "recall";
}

function doRecall(input: ChronosInput, ctxc: { scope: string; dir: string; stacks?: string[] }): string {
  const query = input.query.trim();
  if (!query) return "[CHRONOS|recall] empty query";

  // --- facts: T-RRF over the graph, top-25 (v5.0: window/hop expansions ride along)
  const fused = safe("recall-search", () =>
    searchEdges(query, { scope: ctxc.scope, limit: 25 }),
  ) ?? [];

  // --- reflexive: learned fast-paths that match the question
  const reflex = (
    safe("recall-reflex", () =>
      reflexSearch(query, { scope: ctxc.scope, stacks: ctxc.stacks, limit: 3 }),
    ) ?? []
  )
    .filter((h) => h.score >= REFLEX_THRESHOLD)
    .slice(0, 2);

  // --- verbatim: the exact strings from L3 (v5.0 hybrid multi-pass, v7.1
  // entity bridge: the head's rare entities seed a second pass so the second
  // hop of a multi-hop question is reachable without sharing its wording)
  const verbatim = (safe("recall-hybrid", () => l3SearchExpanded(query, 25)) ?? []).slice(0, 25);

  // --- v4.1 calibrated merge: evidence keyed by its source turn, so the same
  // memory found by both channels is one resonant item, never a dupe.
  const edgeByKey = new Map<string, Edge>();
  const factKeys: string[] = [];
  for (const f of fused) {
    const key = metaTurn(f.edge) ?? `m${f.edge.id}`;
    if (!edgeByKey.has(key)) {
      edgeByKey.set(key, f.edge);
      factKeys.push(key);
    }
  }
  const rowByKey = new Map<string, (typeof verbatim)[number]>();
  const rowKeys: string[] = [];
  for (const v of verbatim) {
    const key = metaTurn(v) ?? `v${v.id}`;
    if (!rowByKey.has(key)) {
      rowByKey.set(key, v);
      rowKeys.push(key);
    }
  }

  // v7.1 — aggregate intents ("list the order in which I brought up X",
  // "summarize how this progressed") are not answered by similarity: the gold
  // turns OPEN a topic block, so they look unlike both the question and the
  // follow-ups that repeat them. Reorder the verbatim head by topic openers
  // (relevance + novelty against earlier user turns) before the merge.
  const recallIntent = classifyIntent(query);
  if (recallIntent !== "lookup" && rowKeys.length > 3) {
    const cands = rowKeys.map((key, i) => {
      const v = rowByKey.get(key)!;
      let session: string | undefined;
      let speaker: string | undefined;
      try {
        const m = JSON.parse(v.meta_json ?? "null") as { session?: unknown; speaker?: unknown } | null;
        if (typeof m?.session === "string") session = m.session;
        if (typeof m?.speaker === "string") speaker = m.speaker;
      } catch {}
      return {
        id: key,
        session,
        speaker,
        ordinal: v.timestamp,
        score: 1 / (i + 1),
        text: v.raw_content,
      };
    });
    const pos = new Map(selectEvidence(cands, recallIntent, rowKeys.length, 6).map((id, i) => [id, i]));
    rowKeys.sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
  }

  if (!factKeys.length && !rowKeys.length && !reflex.length) {
    return `[CHRONOS|recall] nothing remembered for "${oneLine(query, 60)}"`;
  }

  // --- v5.0 APEX merge: same verbatim + graph heads as the benchmark harness
  // (25 + 25), same coverage-adaptive graph weight, so product ≡ union.
  const qa = analyzeQuery(query);
  const coverage = graphQueryCoverage(
    fused.slice(0, 10).map((f) => f.edge.object),
    qa,
  );
  const merged = calibratedMerge(rowKeys, factKeys, {
    topN: 20,
    graphWeight: apexGraphWeight(coverage),
  });

  // --- v5.0 packer: ≥10 query-anchored lossless evidence spans, evidence first.
  // The top-10 spans MUST fit the single-recall cap (product ≡ union), so the
  // packer shrinks slice sizes until they do instead of letting fit() drop a line.
  const packAt = (sliceV: number, sliceM: number): string[] => {
    const out: string[] = [];
    for (const m of merged) {
      const v = rowByKey.get(m.key);
      const e = edgeByKey.get(m.key);
      const src = v ? v.raw_content : (e?.object ?? "");
      const slice = evidenceSlice(src, query, v ? sliceV : sliceM);
      if (!slice) continue;
      if (v) {
        out.push(`[V#${v.id}|${isoDay(v.timestamp)}|${v.event_type.replace(/_/g, "")}|${slice}]`);
      } else if (e) {
        out.push(
          `[M#${e.id}|${e.scope.replace(/^project:/, "")}|${slice}|c${e.confidence.toFixed(2)}${e.valid_until ? `~${isoDay(e.valid_until)}` : ""}]`,
        );
      }
    }
    return out;
  };

  let sliceV = SLICE_V;
  let sliceM = SLICE_M;
  let ev = packAt(sliceV, sliceM).slice(0, 12);
  const estEv = (): boolean => {
    // ±body budget: header + reflex lines are short; keep 10 spans inside the cap
    const body = [...ev.slice(0, 10)];
    return estimateTokens(body.join("\n")) + 14 > RECALL_TOKEN_CAP;
  };
  for (let guard = 0; guard < 8; guard++) {
    if (!estEv() || sliceV <= 44) break;
    sliceV = Math.floor(sliceV * 0.85);
    sliceM = Math.floor(sliceM * 0.85);
    ev = packAt(sliceV, sliceM).slice(0, 12);
  }
  let fN = 0;
  let vN = 0;
  for (const l of ev) {
    if (l.startsWith("[V#")) vN++;
    else fN++;
  }
  if (!ev.length && !reflex.length) {
    return `[CHRONOS|recall] nothing remembered for "${oneLine(query, 60)}"`;
  }

  const lines: string[] = [`[CHRONOS|recall|f${fN} v${vN} r${reflex.length}]`];
  for (const h of reflex) {
    lines.push(
      aaakReflex({
        scope: h.engram.scope,
        when: oneLine(h.engram.trigger_intent, 44),
        avoid: h.engram.anti_pattern_aaak,
        win: h.engram.fast_path_aaak,
      }),
    );
  }
  lines.push(...ev);
  return fit(lines, RECALL_TOKEN_CAP);
}

function doTimeline(input: ChronosInput, ctxc: { scope: string; project: string | null; dir: string }): string {
  const subject = input.subject?.trim();
  const project = projectKey(input.project ?? input.subject ?? ctxc.project ?? "") || ctxc.project;

  const looksLikeProject = project ? !!safe("proj", () => getProject(project)) : false;

  if (!looksLikeProject && subject) {
    const rows = safe("timeline-subject", () => edgeHistory(ctxc.scope, subject)) ?? [];
    if (!rows.length) return `[CHRONOS|timeline] no history for subject=${subject}`;
    const lines = [`[CHRONOS|timeline|${subject}|${rows.length} entries]`];
    for (const e of rows.slice(0, 16)) {
      const from = isoDay(e.valid_from);
      const to = e.valid_until ? isoDay(e.valid_until) : "now";
      lines.push(`${from}->${to} ${e.subject}=${oneLine(e.object, 50)} (c${e.confidence.toFixed(2)} use${e.access_count})`);
    }
    return fit(lines, RECALL_TOKEN_CAP);
  }

  if (!project) return "[CHRONOS|timeline] nothing to look up";
  const row = safe("timeline-project", () => getProject(project));
  if (!row) return `[CHRONOS|timeline] unknown project "${project}"`;

  const scope = scopeFor(project, row.project_path);
  const lines: string[] = [
    `[CHRONOS|timeline|${row.project_name}|${isoDay(row.last_active_at)}|${relTime(row.last_active_at)}|${row.status}]`,
  ];
  if (row.summary_aaak) lines.push(`summary:${row.summary_aaak}`);
  if (row.current_focus) lines.push(`focus:${row.current_focus}`);
  if (row.last_milestone) lines.push(`milestone:${oneLine(row.last_milestone, 70)}`);
  for (const l of openLoops(project)) lines.push(`open:${oneLine(l, 70)}`);

  const events = safe("timeline-l3", () => l3ForProject(project, 80)) ?? [];
  const interesting = events.filter((e) =>
    ["user_msg", "user_prompt", "error_fix", "error_resolved", "git_state", "git_commit", "file_edit", "file_edit_diff"].includes(
      String(e.event_type),
    ),
  );
  for (const e of interesting.slice(-10)) {
    lines.push(`${isoDay(e.timestamp)} ${String(e.event_type).replace(/_/g, "")}: ${oneLine(e.raw_content, 90)}`);
  }

  const edges = safe("timeline-edges", () => edgeHistory(scope, subject || undefined)) ?? [];
  for (const e of edges.slice(0, 8)) {
    const to = e.valid_until ? isoDay(e.valid_until) : "now";
    lines.push(`${isoDay(e.valid_from)}->${to} ${e.subject}=${oneLine(e.object, 40)}`);
  }

  return fit(lines, RECALL_TOKEN_CAP);
}

function doReflex(
  input: ChronosInput,
  ctxc: { sessionID: string; dir: string; project: string | null; scope: string; stacks?: string[] },
): string {
  const query = input.query.trim();
  const cx = {
    sessionID: ctxc.sessionID,
    scope: ctxc.scope,
    dir: ctxc.dir,
    project: ctxc.project,
    stacks: ctxc.stacks ?? [],
  };

  // `activate verify_fast` (or `macro verify_fast`): hand back the frozen
  // one-step sequence, so a whole ritual costs a single tool call.
  const act = /^(?:macro|activate|run)\s+([\w.-]+)/i.exec(query);
  if (act) {
    const m = safe("macro-activate", () => activateMacro(act[1]));
    if (!m) {
      const known = safe("macro-list", () => macroList(undefined, 5)) ?? [];
      const hint = known.map((k) => k.macro_id).join(", ") || "none";
      return `[CHRONOS|reflex|macro] not found: ${oneLine(act[1], 30)} (known: ${hint})`;
    }
    const cmds = m.commands.map((c) => oneLine(c, 90)).join(" && ");
    return `[CHRONOS|reflex|macro|${m.macro.macro_id}|uses:${m.macro.usage_count}]\n${cmds}`;
  }

  // `learn avoid:X win:Y` / `learn A -> B`: record a proven fast-path now.
  const learn = query.replace(/^(?:learn|record|teach)[:\s]+/i, "");
  if (learn !== query || /->|=>|⇒/.test(learn) || /\bavoid\b[:\s]+\S+\s+\bwin\b[:\s]+\S/i.test(learn)) {
    const r = safe("fastpath", () => recordFastPath({ ...cx, spec: learn, when: input.subject }));
    if (!r) return `[CHRONOS|reflex|learn] nothing to learn from "${oneLine(learn, 60)}"`;
    return `[CHRONOS|reflex|learned|maturity:${r.maturity}${r.reinforced ? "|reinforced" : ""}] ${r.fastPath}`;
  }

  // default: the cortex report — what was learned, what fires with 0 tokens.
  const s = safe("cortex-stats", () => cortexStats());
  if (!s) return "[CHRONOS|reflex] cortex unavailable";
  const lines: string[] = [
    `[CHRONOS|reflex|engrams:${s.engrams.live}/${s.engrams.total}|matured:${s.engrams.matured}|interceptors:${s.interceptors.active}/${s.interceptors.total}|hits:${s.interceptors.hits}|macros:${s.macros.count}|saved:~${s.tokenSavings}tok]`,
  ];
  for (const e of s.top) {
    lines.push(
      aaakReflex({
        scope: e.scope,
        when: oneLine(e.trigger_intent, 40),
        avoid: e.anti_pattern_aaak,
        win: e.fast_path_aaak,
      }),
    );
  }
  for (const m of safe("macro-list2", () => macroList(undefined, 5)) ?? []) {
    lines.push(`[MACRO|${m.macro_id}] ${oneLine(m.description_aaak ?? "", 22)} uses:${m.usage_count} avg:${m.avg_duration_ms}ms`);
  }
  return fit(lines, RECALL_TOKEN_CAP);
}

function doRemember(
  input: ChronosInput,
  ctxc: { sessionID: string; dir: string; project: string | null; scope: string },
): string {
  const text = input.query.trim();
  if (!text) return "[CHRONOS|remember] nothing to remember";
  const kind = String(input.kind ?? "fact").toLowerCase();
  const project = projectKey(input.project ?? ctxc.project ?? "");
  const now = Date.now();

  if ((kind === "milestone" || kind === "focus" || kind === "loop") && !project) {
    return "[CHRONOS|remember] no project known for this session; pass project=<name>";
  }

  if (project) {
    safe("remember-project", () => {
      upsertProject({ name: project, path: project === ctxc.project ? ctxc.dir : null, now });
      if (kind === "milestone") {
        setMilestone(project, text, now);
        closeOpenLoops(project, text, now);
      } else if (kind === "focus") {
        setFocus(project, text, now);
      } else if (kind === "loop") {
        addOpenLoop(project, text, now);
      }
    });
  }

  if (kind === "fact" || kind === "milestone" || kind === "focus") {
    safe("remember-edge", () =>
      assertEdge({
        scope: project ? scopeFor(project, null) : ctxc.scope,
        category: kind === "fact" ? "domain_fact" : "workflow_habit",
        subject: kind === "fact" ? "note:" + kebab(text, 40) : `${kind}:${project || "session"}`,
        predicate: kind === "milestone" ? "achieved" : "noted",
        object: oneLine(text, 120),
        aaak: `[MEM|${kind}|${oneLine(text, 60)}]`,
        confidence: 0.8,
        now,
      }),
    );
  }

  safe("remember-l3", () =>
    l3Insert({
      sessionID: ctxc.sessionID || "tool",
      projectName: project || null,
      projectPath: ctxc.dir,
      eventType: "user_msg" as EventType,
      content: `[remember:${kind}] ${text}`,
      meta: { via: "chronos-tool" },
      timestamp: now,
    }),
  );

  return `[CHRONOS|remembered|${kind}${project ? "|" + project : ""}] ${oneLine(text, 90)}`;
}

// ---- v4 modes: genome / synthesize / darwin -------------------------------

/** mode=genome: the full 5-chromosome genome with its token certification. */
function doGenome(input: ChronosInput, ctxc: { project: string | null }): string {
  const project = String(input.project ?? input.subject ?? "").trim() || ctxc.project;
  if (!project) return "[CHRONOS|genome] no project context — open the project folder, or pass project=<name>";
  const g = safe("genome-row", () => genomeGet(project));
  if (!g) return `[CHRONOS|genome|${project}] not built yet — it is warmed at session start; try again in a moment`;
  const t = genomeTokens(g);
  const cert = t.total <= GENOME_CAP ? "certified:OK" : "OVER-BUDGET";
  const when = g.last_synthesized_at ? relTime(g.last_synthesized_at) : "never";
  const lines = [
    `[CHRONOS|genome|${project}|files:${g.file_count}|tok:${t.total}/${GENOME_CAP}|${cert}|synth:${when}]`,
    `[C1|${t.c1}/${C1_CAP}] ${g.c1_arch_dna_aaak || "-"}`,
    `[C2|${t.c2}/${C2_CAP}] ${g.c2_dep_graph_aaak || "-"}`,
    `[C3|${t.c3}/${C3_CAP}] ${g.c3_patterns_aaak || "-"}`,
    `[C4|${t.c4}/${C4_CAP}] ${g.c4_semantic_index_aaak || "-"}`,
    `[C5|${t.c5}/${C5_CAP}] ${g.c5_evolution_mem_aaak || "-"}`,
  ];
  return fit(lines, 2600);
}

/** mode=synthesize: run the Genome Synthesizer for an arbitrary task now. */
function doSynthesize(input: ChronosInput, ctxc: { project: string | null; dir: string; sessionID: string }): string {
  const project = String(input.project ?? "").trim() || ctxc.project;
  if (!project) return "[CHRONOS|synthesize] no project context — pass project=<name>";
  const g = safe("genome-row", () => genomeGet(project));
  const path = g?.project_path || ctxc.dir;
  const r = safe("synth", () =>
    synthGenome(String(input.query ?? ""), {
      project,
      projectPath: path,
      sessionID: ctxc.sessionID,
      respectWorkingSet: false,
    }),
  );
  if (!r) return "[CHRONOS|synthesize] 0 tokens — greeting/chit-chat, genome not built yet, or nothing relevant in the index";
  return `${r.text}\n[CHRONOS|synthesize|cat:${r.category}|tok:${r.tokens}/${PACKET_CAP}|slices:${r.slices.length}]`;
}

/** mode=darwin: run the Token-Darwin audit immediately and report. */
function doDarwin(): string {
  const rep = safe("darwin-run", () => runNightlyDarwinAudit(Date.now()));
  if (!rep) return "[CHRONOS|darwin] audit unavailable";
  const lines: string[] = [
    `[CHRONOS|darwin|artifacts:${rep.ledger.length}|pruned:${rep.pruned.length}|gc-lessons:${rep.lessonsDeleted}|decayed-ptr:${rep.decayedPointers}|caps:${rep.caps.length}]`,
  ];
  for (const l of rep.ledger.slice(0, 10)) {
    lines.push(
      `[ROI|${l.artifact_type}|${l.artifact_id}|roi:${Number(l.roi_score).toFixed(2)}|imp:${l.impressions}|act:${l.activations}|saved:${l.total_tokens_saved}|spent:${l.total_tokens_spent}|${l.status}]`,
    );
  }
  for (const p of rep.pruned.slice(0, 8)) {
    lines.push(`[PRUNED${p.fresh ? "!" : ""}|${p.type}|${p.id}|roi:${Number(p.roi).toFixed(2)}|sr:${Number(p.sr).toFixed(2)}]`);
  }
  for (const c of rep.caps) {
    lines.push(`[CAP|${c.project}|${c.before}->${c.after}${c.clamped.length ? `|clamped:${c.clamped.join(",")}` : ""}]`);
  }
  return fit(lines, 2200);
}

/** T-RRF search, thin wrapper so the tool has one call site to reason about. */
function searchEdges(query: string, opts: { scope: string; limit: number }) {
  return search(query, { scope: opts.scope, limit: opts.limit, respectWorkingSet: false });
}

// ---------------------------------------------------------------- helpers

function fit(lines: string[], maxTokens: number): string {
  const out: string[] = [];
  for (const l of lines) {
    const cand = out.concat(l).join("\n");
    if (estimateTokens(cand) > maxTokens - 2) break;
    out.push(l);
  }
  return out.join("\n");
}

function oneLine(s: unknown, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ------------------------------------------- v4.1 evidence packer helpers

const SLICE_V = 88; // chars per verbatim evidence slice (v5.0: 10 slices ≤ 290 tok)
const SLICE_M = 62; // chars per graph-fact evidence slice

const SLICE_STOP = new Set([
  "about", "after", "again", "also", "because", "been", "before", "being", "between", "could",
  "doing", "during", "each", "from", "have", "into", "just", "like", "made", "make", "many",
  "more", "most", "much", "must", "other", "over", "same", "should", "some", "than", "that",
  "their", "them", "then", "there", "these", "they", "this", "those", "through", "under",
  "until", "very", "want", "well", "were", "what", "when", "where", "which", "while", "will",
  "with", "would", "your", "yours",
]);

const TOOL_NOISE = new Set([
  "type", "properties", "required", "description", "enum", "default", "additionalProperties",
  "$schema", "schema", "title", "examples", "format", "anyOf", "oneOf", "allOf",
]);

/** Source turn id stored at ingest (`meta_json.turn`), when present. */
function metaTurn(row: { meta_json: string | null }): string | null {
  try {
    const m = JSON.parse(row.meta_json ?? "null") as { turn?: unknown } | null;
    return typeof m?.turn === "string" ? m.turn : null;
  } catch {
    return null;
  }
}

/** Collapse JSON/tool-shaped payloads to `key=value · …` (schema noise dropped). */
function deTool(text: string): string {
  const s = text.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return text;
  try {
    const v = JSON.parse(s) as unknown;
    const parts: string[] = [];
    const walk = (x: unknown, depth: number): void => {
      if (parts.join(" · ").length > 420 || depth > 4) return;
      if (x == null || typeof x === "number" || typeof x === "boolean") {
        parts.push(String(x));
        return;
      }
      if (typeof x === "string") {
        parts.push(x.replace(/\s+/g, " ").trim());
        return;
      }
      if (Array.isArray(x)) {
        for (const y of x.slice(0, 8)) walk(y, depth + 1);
        return;
      }
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (TOOL_NOISE.has(k)) continue;
        if (val == null || ["string", "number", "boolean"].includes(typeof val)) {
          parts.push(`${k}=${String(val)}`);
        } else {
          walk(val, depth + 1);
        }
      }
    };
    walk(v, 0);
    const out = parts.filter(Boolean).join(" · ");
    return out.length >= 20 ? out : text;
  } catch {
    return text;
  }
}

/**
 * Query-biased snippet: the densest query-term + entity (number / proper-noun)
 * window, clipped to `max`, plus a compact digest of answer-shaped values the
 * window missed — numbers, dates, names, quotes usually sit near the match.
 */
function evidenceSlice(raw: string, query: string, max: number): string {
  const t = deTool(String(raw ?? "").replace(/\s+/g, " ").trim());
  if (!t) return "";
  if (t.length <= max) return t;
  const winMax = Math.max(44, max - 38);
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_$]{4,}/gu) ?? [])]
    .filter((w) => !SLICE_STOP.has(w))
    .slice(0, 10);
  const low = t.toLowerCase();
  let bestI = 0;
  let bestS = -1;
  for (let i = 0; i < t.length; i += 24) {
    const seg = low.slice(i, i + winMax);
    let s = 0;
    for (const w of terms) if (seg.includes(w)) s += 1 + Math.min(4, w.length) / 10;
    s += 0.35 * ((seg.match(/\b\d[\d.,:%/-]{1,}\b|\b[A-Z][a-z]{3,}\b/g) ?? []).length);
    if (s > bestS) {
      bestS = s;
      bestI = i;
    }
  }
  const win = t.slice(bestI, bestI + winMax).trim();
  const cut = `${bestI > 0 ? "…" : ""}${win}${t.length > bestI + winMax ? "…" : ""}`;
  const digest = entityDigest(t, win, query, max - winMax - 3);
  return digest ? `${cut} ⧉ ${digest}` : cut;
}

const DIGEST_STOP = new Set([
  "The", "But", "And", "For", "Not", "You", "This", "That", "With", "From", "They", "There",
  "What", "When", "Where", "Which", "While", "Your", "Have", "Been", "Will", "Would", "Could",
  "Should", "About", "After", "Before", "Because", "Every", "Some", "Then", "Than", "Just",
  "Even", "Also", "Into", "Over", "Only", "Very", "Much", "Many",
]);

/** Compact tail of rare numeric/name values the slice window did not show. */
function entityDigest(text: string, shown: string, query: string, room: number): string {
  if (room < 22) return "";
  const lowShown = shown.toLowerCase();
  const lowQuery = query.toLowerCase();
  const cands: string[] = [];
  const counts = new Map<string, number>();
  for (const m of text.matchAll(
    /\b\d{2,4}(?:[-/.]\d{1,2}){0,2}\b|\b[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?\b|"[^"]{3,28}"/g,
  )) {
    const v = m[0];
    const key = v.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (cands.length < 24 && !DIGEST_STOP.has(v) && !lowShown.includes(key) && !lowQuery.includes(key)) {
      cands.push(v);
    }
  }
  const uniq: string[] = [];
  const seen = new Set<string>();
  const ranked = cands.sort(
    (a, b) => (counts.get(a.toLowerCase()) ?? 9) - (counts.get(b.toLowerCase()) ?? 9) || b.length - a.length,
  );
  for (const c of ranked) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
    if (uniq.length >= 3) break;
  }
  let out = "";
  for (const u of uniq) {
    if (out.length + u.length + 2 > room) break;
    out = out ? `${out}, ${u}` : u;
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

function stringifyResult(result: any, error: any): string {
  try {
    if (error) return String(error?.message ?? safeJson(error));
    const o = result?.output;
    if (typeof o === "string") return o;
    if (o && typeof o.output === "string") return o.output;
    const content = result?.content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return safeJson(result ?? {});
  } catch {
    return "";
  }
}

function filePathsOf(input: any): string[] {
  const out: string[] = [];
  for (const k of ["filePath", "path", "file", "target", "filepath"]) {
    if (typeof input?.[k] === "string") out.push(input[k]);
  }
  return out;
}

/** `git commit -m "message"` -> `message`, else null. */
export function gitCommitMessage(cmd: string): string | null {
  const c = String(cmd ?? "");
  if (!/\bgit\s+commit\b/.test(c)) return null;
  const m = /-m\s+(?:"([^"]{3,200})"|'([^']{3,200})'|([^\s"']{3,200}))/.exec(c);
  const msg = m ? m[1] ?? m[2] ?? m[3] : "";
  return msg ? msg.replace(/\s+/g, " ").trim().slice(0, 120) : "git commit";
}

export const __internals = {
  sessions,
  primeWorkspace,
  ensureSession,
  frozenSnapshot,
  mentionedScopes,
  applyAnalysis,
  onIdle,
  SNAPSHOT_TOKEN_CAP,
  AAAK_BEHAVIOR,
};
