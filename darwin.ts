// ===========================================================================
// darwin.ts — CHRONOS-PALACE v4.0: Token-Darwin governance.
//
// Every artifact this system invents (C3 patterns, C4 pointers, C5 lessons,
// v3 engrams / macros / interceptors) lives on a ledger that records what it
// cost to inject and what it saved. The nightly audit recomputes, for each:
//
//      ROI(a) = ( TokensSaved(a) * SuccessRate(a) - TokensSpent(a) )
//               / max(1, TokensSpent(a))
//
//   * patterns / engrams / lessons / interceptors with impressions >= 3 and
//     (ROI < 0 or success_rate < 0.40) are pruned: removed from the active
//     genome (patterns/lessons are cloaked with a negative darwin_roi, v3
//     engrams are retired, interceptors are deactivated).
//   * lessons older than 30 days (now > expires_at) that never proved hot
//     are garbage-collected — the originals stay safe in l3_verbatim_vault.
//   * pointers untouched for 14 days decay: relevance_score *= 0.92.
//   * every chromosome is measured against its budget and hard-clamped:
//     C1<=200, C2<=300, C3<=500, C4<=500, C5<=300, total<=2000 tokens.
//
// Runs on session.idle at most once per 24h, or on demand via the `chronos`
// tool mode=darwin. Zero LLM tokens.
// ===========================================================================

import { clampTokens, estimateTokens as tok } from "./aaak";
import {
  engramById,
  genomeGet,
  genomeTouchAudit,
  genomeUpsert,
  genomesAll,
  interceptorDeactivate,
  ledgerAll,
  ledgerSet,
  ledgerTouch,
  lessonDelete,
  lessonMarkRoi,
  lessonsExpired,
  patternGet,
  patternMarkRoi,
  pointerDecayAll,
  retireEngrams,
  type LedgerRow,
} from "./db";
import { C1_CAP, C2_CAP, C3_CAP, C4_CAP, C5_CAP, GENOME_CAP } from "./genome";

const AUDIT_INTERVAL_MS = 24 * 3_600_000;
const DECAY_FACTOR = 0.92;
const DECAY_IDLE_MS = 14 * 86_400_000;
const PRUNE_MIN_IMPRESSIONS = 3;
const PRUNE_SUCCESS_FLOOR = 0.4;
/** Kinds whose bad ROI actually removes them from active service. */
const PRUNABLE = new Set(["c3_pattern", "v3_engram", "c5_lesson", "v3_interceptor"]);

/** The Token-Darwin formula, in one place. */
export function darwinRoi(saved: number, spent: number, sr: number): number {
  const rate = Number.isFinite(sr) ? Math.max(0, Math.min(1, sr)) : 1;
  return (saved * rate - spent) / Math.max(1, spent);
}

export interface DarwinPrune {
  type: string;
  id: string;
  roi: number;
  sr: number;
  /** true when this audit run delivered the killing blow. */
  fresh: boolean;
}

export interface DarwinReport {
  now: number;
  ledger: LedgerRow[];
  pruned: DarwinPrune[];
  lessonsDeleted: number;
  decayedPointers: number;
  caps: Array<{ project: string; before: number; after: number; clamped: string[] }>;
}

function successRateOf(l: LedgerRow): number {
  if (l.artifact_type === "c3_pattern") {
    const p = patternGet(l.artifact_id);
    return p ? p.success_rate : 0.5;
  }
  if (l.artifact_type === "v3_engram") {
    const e = engramById(Number(l.artifact_id));
    return e ? e.success_rate : 0.5;
  }
  return l.impressions > 0 ? Math.min(1, l.activations / l.impressions) : 1;
}

/** Measure + clamp all five chromosomes; returns null when no genome exists. */
export function enforceGenomeCap(
  projectName: string,
  now = Date.now(),
): { before: number; after: number; clamped: string[] } | null {
  const g = genomeGet(projectName);
  if (!g) return null;
  const cols: Array<[string, string, number]> = [
    ["c1", g.c1_arch_dna_aaak ?? "", C1_CAP],
    ["c2", g.c2_dep_graph_aaak ?? "", C2_CAP],
    ["c3", g.c3_patterns_aaak ?? "", C3_CAP],
    ["c4", g.c4_semantic_index_aaak ?? "", C4_CAP],
    ["c5", g.c5_evolution_mem_aaak ?? "", C5_CAP],
  ];
  const before = Number(g.total_genome_tokens ?? 0);
  const clamped: string[] = [];
  const out: Record<string, string> = {};
  let total = 0;
  for (const [name, text, cap] of cols) {
    let t = text;
    if (tok(t) > cap) {
      // Top-K truncation onto the logarithmic budget: keep the head.
      t = clampTokens(t, cap);
      clamped.push(name);
    }
    out[name] = t;
    total += tok(t);
  }
  const after = Math.min(total, GENOME_CAP);
  if (clamped.length || before !== after) {
    genomeUpsert({
      projectName,
      projectPath: g.project_path,
      fileCount: g.file_count,
      c1: out.c1,
      c2: out.c2,
      c3: out.c3,
      c4: out.c4,
      c5: out.c5,
      totalTokens: after,
      synthesizedAt: g.last_synthesized_at,
    });
  }
  genomeTouchAudit(projectName, now);
  return { before, after, clamped };
}

/** Should this artifact be reclaimed? */
function verdict(l: LedgerRow): { roi: number; sr: number; status: string } {
  const sr = successRateOf(l);
  const roi = darwinRoi(l.total_tokens_saved, l.total_tokens_spent, sr);
  let status: string;
  if (PRUNABLE.has(l.artifact_type) && l.impressions >= PRUNE_MIN_IMPRESSIONS && (roi < 0 || sr < PRUNE_SUCCESS_FLOOR)) {
    status = "pruned";
  } else if (roi >= 0.5) {
    status = "thriving";
  } else {
    status = "probation";
  }
  return { roi, sr, status };
}

/**
 * The Nightly / Idle Audit. Idempotent; safe to run at any time.
 */
export function runNightlyDarwinAudit(now = Date.now()): DarwinReport {
  const ledger = ledgerAll(200);
  const pruned: DarwinPrune[] = [];

  for (const l of ledger) {
    const { roi, sr, status } = verdict(l);
    ledgerSet({ artifactType: l.artifact_type, artifactId: l.artifact_id, roi, status, now });
    const fresh = status === "pruned" && l.status !== "pruned";

    if (status === "pruned") {
      pruned.push({ type: l.artifact_type, id: l.artifact_id, roi, sr, fresh });
      // Side effects: cloaking (patterns/lessons), retirement (engrams),
      // deactivation (interceptors). Patterns keep negative ROI so the C3
      // export and the synthesizer cannot resurface them.
      try {
        if (l.artifact_type === "c3_pattern") patternMarkRoi(l.artifact_id, Math.min(roi, -0.01));
        else if (l.artifact_type === "c5_lesson") lessonMarkRoi(l.artifact_id, Math.min(roi, -0.01));
        else if (l.artifact_type === "v3_engram") retireEngrams([Number(l.artifact_id)], now);
        else if (l.artifact_type === "v3_interceptor") interceptorDeactivate([Number(l.artifact_id)]);
      } catch {}
    } else {
      // survivors get their score written back so the genome export can rank
      try {
        if (l.artifact_type === "c3_pattern") patternMarkRoi(l.artifact_id, Math.max(0, roi));
        else if (l.artifact_type === "c5_lesson") lessonMarkRoi(l.artifact_id, Math.max(0, roi));
      } catch {}
    }
  }

  // 30-day garbage collection: expired lessons nobody ever activated.
  let lessonsDeleted = 0;
  try {
    const expired = lessonsExpired(now);
    if (expired.length) {
      lessonDelete(expired);
      lessonsDeleted = expired.length;
    }
  } catch {}

  // Temporal decay of stale semantic pointers.
  let decayedPointers = 0;
  try {
    decayedPointers = pointerDecayAll(DECAY_FACTOR, now - DECAY_IDLE_MS);
  } catch {}

  // Strict 2000-token cap enforcement on every genome (O(log N) compression).
  const caps: DarwinReport["caps"] = [];
  try {
    for (const g of genomesAll(50)) {
      const r = enforceGenomeCap(g.project_name, now);
      if (r && (r.clamped.length || r.before !== r.after)) caps.push({ project: g.project_name, ...r });
    }
  } catch {}

  return { now, ledger: ledgerAll(200), pruned, lessonsDeleted, decayedPointers, caps };
}

/**
 * Called after a task that used a synthesized packet verifies successfully:
 * the artifacts that rode along just earned activations and saved tokens.
 */
export function ledgerActivate(
  items: { pointers?: string[]; pattern?: string | null; lessons?: string[] },
  now = Date.now(),
): void {
  for (const id of items.pointers ?? []) {
    ledgerTouch({ artifactType: "c4_pointer", artifactId: id, activations: 1, saved: 120, now });
  }
  if (items.pattern) {
    const p = patternGet(items.pattern);
    const saved = Math.max(200, (p?.baseline_tokens_estimate ?? 8000) - (p?.avg_tokens_consumed ?? 450));
    ledgerTouch({ artifactType: "c3_pattern", artifactId: items.pattern, activations: 1, saved, now });
  }
  for (const id of items.lessons ?? []) {
    ledgerTouch({ artifactType: "c5_lesson", artifactId: id, activations: 1, saved: 300, now });
  }
}

export const __internals = { AUDIT_INTERVAL_MS, DECAY_FACTOR, DECAY_IDLE_MS, verdict };
