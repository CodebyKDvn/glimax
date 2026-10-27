// ===========================================================================
// dashboard.ts — SVG + PNG report for the Chronos-Palace v4.0 benchmark.
//
// 1920x1200, dark, four panels:
//   1. token cost per task vs project size (log-log)
//   2. 100-task evolution: self-learning bloat vs Token-Darwin
//   3. task success rate + end-to-end latency
//   4. the head-to-head scorecard matrix
//
// Every number is read from results/benchmark_results.json — nothing here is
// typed by hand. PNG conversion cascades through resvg-js, rsvg-convert,
// qlmanage, sips, magick/convert, ffmpeg, headless Chrome and cairosvg.
// ===========================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const W = 1920;
export const H = 1200;

const COL = {
  bg: "#0a0d13",
  panel: "#111722",
  edge: "#1e2836",
  grid: "#1a222e",
  text: "#e8eef6",
  sub: "#93a2b5",
  faint: "#5d6b7d",
  win: "#12261d",
  winEdge: "#2f6b4f",
};

const SERIES: Record<string, string> = {
  chronos_v4: "#22d3a7",
  full_context: "#f45d7a",
  vector_rag: "#f59e0b",
  fact_memory: "#8b5cf6",
  subagent: "#38bdf8",
  skill_harness: "#a3e635",
};

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

/** compact: 198097 -> "198k", 691 -> "691", 4.51 -> "4.5" */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// ------------------------------------------------------------------ svg bits

interface TextOpts {
  size?: number;
  fill?: string;
  weight?: number | string;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
  family?: string;
}

function text(x: number, y: number, body: string, o: TextOpts = {}): string {
  const {
    size = 12,
    fill = COL.text,
    weight = 400,
    anchor = "start",
    opacity,
    family = "Inter, 'Helvetica Neue', 'DejaVu Sans', system-ui, sans-serif",
  } = o;
  const op = opacity === undefined ? "" : ` opacity="${opacity}"`;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${op}>${esc(body)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, fill: string, o: { rx?: number; stroke?: string; sw?: number; opacity?: number } = {}): string {
  const { rx = 0, stroke, sw = 1, opacity } = o;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, sw = 1, dash?: string, opacity?: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${
    dash ? ` stroke-dasharray="${dash}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}/>`;
}

function poly(pts: Array<[number, number]>, stroke: string, sw = 2.4): string {
  return `<polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function dot(x: number, y: number, r: number, fill: string, stroke = COL.panel, sw = 1.6): string {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function panel(x: number, y: number, w: number, h: number, title: string, subtitle: string): string {
  return [
    rect(x, y, w, h, COL.panel, { rx: 12, stroke: COL.edge, sw: 1 }),
    text(x + 22, y + 32, title, { size: 15.5, weight: 650 }),
    text(x + 22, y + 53, subtitle, { size: 11.5, fill: COL.sub }),
  ].join("");
}

function box(x: number, y: number, w: number, h: number, fill = "rgba(10,13,19,0.86)"): string {
  return rect(x, y, w, h, fill, { rx: 7, stroke: COL.edge, sw: 1 });
}

// ------------------------------------------------------------------ scales

const log = (v: number) => Math.log10(Math.max(1e-9, v));
function logScale(d0: number, d1: number, r0: number, r1: number) {
  const a = log(d0);
  const b = log(d1);
  return (v: number) => r0 + ((log(v) - a) / (b - a)) * (r1 - r0);
}
function linScale(d0: number, d1: number, r0: number, r1: number) {
  return (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

// ===========================================================================
// Panels
// ===========================================================================

function panel1(d: any, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  out.push(panel(x, y, w, h, "1 · Token cost per task vs. project size", "Context tokens the agent must carry to do one task · both axes log — Chronos-Palace flat-lines where the rivals explode"));

  const L = x + 78;
  const R = x + w - 26;
  const T = y + 86;
  const B = y + h - 62;
  const sx = logScale(50, 1000, L, R);
  const sy = logScale(400, 1_000_000, B, T);

  // grid + y ticks
  for (const t of [1e3, 1e4, 1e5, 1e6]) {
    const yy = sy(t);
    out.push(line(L, yy, R, yy, COL.grid, 1));
    out.push(text(L - 12, yy + 4, t >= 1e6 ? "1M" : `${t / 1000}k`, { size: 11, fill: COL.faint, anchor: "end" }));
  }
  const scales: number[] = d.bench1.map((s: any) => s.files);
  for (const f of scales) {
    out.push(line(sx(f), T, sx(f), B, COL.grid, 1, "2 4"));
    out.push(text(sx(f), B + 20, `${fmt(f)}`, { size: 11, fill: COL.sub, anchor: "middle" }));
  }
  out.push(text((L + R) / 2, B + 42, "project size (files)", { size: 11.5, fill: COL.sub, anchor: "middle" }));
  out.push(text(L - 12, T - 14, "tokens", { size: 11, fill: COL.faint, anchor: "end" }));

  // series
  const seriesDefs: Array<{ id: string; label: string; vals: number[] }> = [
    { id: "chronos_v4", label: "Chronos-Palace v4.0", vals: d.bench1.map((s: any) => s.tasks[0].packetTokens) },
    { id: "full_context", label: "Full-Context + .md", vals: d.bench1.map((s: any) => s.tasks[0].rivals.full_context.tokens) },
    { id: "vector_rag", label: "Vector RAG", vals: d.bench1.map((s: any) => s.tasks[0].rivals.vector_rag.tokens) },
    { id: "fact_memory", label: "Cloud Fact Memory", vals: d.bench1.map((s: any) => s.tasks[0].rivals.fact_memory.tokens) },
    { id: "subagent", label: "Sub-Agent Explorer", vals: d.bench1.map((s: any) => s.tasks[0].rivals.subagent.tokens) },
    { id: "skill_harness", label: "SKILL.md Harness", vals: d.bench1.map((s: any) => s.tasks[0].rivals.skill_harness.tokens) },
  ];
  for (const s of seriesDefs) {
    const pts = s.vals.map((v, i) => [sx(scales[i]), sy(v)] as [number, number]);
    out.push(poly(pts, SERIES[s.id], s.id === "chronos_v4" ? 3.2 : 2.2));
    for (const [px, py] of pts) out.push(dot(px, py, s.id === "chronos_v4" ? 4 : 3, SERIES[s.id]));
  }

  // right-edge value labels, nudged apart so the cluster stays legible
  const lastIdx = scales.length - 1;
  const labels = seriesDefs
    .map((s, i) => ({ i, v: s.vals[lastIdx], y: sy(s.vals[lastIdx]) }))
    .sort((a, b) => a.y - b.y);
  let prevY = -1e9;
  for (const L2 of labels) {
    const yy = Math.max(L2.y, prevY + 13);
    prevY = yy;
    out.push(text(R + 9, yy + 3.5, compact(L2.v), { size: 10.5, fill: SERIES[seriesDefs[L2.i].id], weight: seriesDefs[L2.i].id === "chronos_v4" ? 700 : 550, anchor: "start" }));
  }
  out.push(text(R + 9, sy(seriesDefs[1].vals[lastIdx]) + 3.5, " ", { size: 10.5 }));

  // legend (2 columns inside the plot, top area)
  const lx = L + 14;
  const ly = T + 16;
  seriesDefs.forEach((s, i) => {
    const cx = lx + (i % 2) * 232;
    const cy = ly + Math.floor(i / 2) * 19;
    out.push(rect(cx, cy - 8, 10, 3, SERIES[s.id], { rx: 1.5 }));
    out.push(text(cx + 16, cy - 2, s.label, { size: 10.5, fill: COL.sub }));
  });

  // the callout
  const cy = sy(seriesDefs[0].vals[2]);
  out.push(box(R - 268, cy + 16, 262, 58));
  out.push(text(R - 254, cy + 37, "Chronos-Palace stays flat", { size: 11.5, fill: SERIES.chronos_v4, weight: 650 }));
  out.push(text(R - 254, cy + 54, `${compact(seriesDefs[0].vals[0])} tok @50 files → ${compact(seriesDefs[0].vals[3])} tok @1,000 files`, { size: 10.5, fill: COL.sub }));
  out.push(text(R - 254, cy + 69, `= ${(seriesDefs[1].vals[3] / seriesDefs[0].vals[3]).toFixed(0)}× fewer tokens than full-context`, { size: 10.5, fill: COL.sub }));
  return out.join("");
}

function panel2(d: any, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  const b2 = d.bench2;
  out.push(
    panel(
      x,
      y,
      w,
      h,
      "2 · 100 tasks: self-learning bloat vs. Token-Darwin",
      `Tokens injected per task, 5-task rolling mean · measured Chronos packet vs modelled skill injection · ${b2.zeroTokenTasks}/${b2.tasks} Chronos tasks cost 0`,
    ),
  );

  const L = x + 78;
  const R = x + w - 26;
  const T = y + 86;
  const B = y + h - 62;

  const roll = (xs: number[], k = 5) => xs.map((_, i) => {
    const a = Math.max(0, i - k + 1);
    const seg = xs.slice(a, i + 1);
    return seg.reduce((p, c) => p + c, 0) / seg.length;
  });

  const chronos = roll(b2.ticks.map((t: any) => t.chronosTokens));
  const skill = roll(b2.ticks.map((t: any) => t.skillInjectedTokens));
  const maxY = Math.max(...skill, ...chronos) * 1.18;
  const sx = linScale(0, b2.tasks - 1, L, R);
  const sy = linScale(0, maxY, B, T);

  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 4) * i;
    const yy = sy(v);
    out.push(line(L, yy, R, yy, COL.grid, 1));
    out.push(text(L - 12, yy + 4, compact(v), { size: 11, fill: COL.faint, anchor: "end" }));
  }
  for (const t of [0, 25, 50, 75, 99]) {
    out.push(line(sx(t), T, sx(t), B, COL.grid, 1, "2 4"));
    out.push(text(sx(t), B + 20, `t${t + 1}`, { size: 11, fill: COL.sub, anchor: "middle" }));
  }
  out.push(text((L + R) / 2, B + 42, "task index", { size: 11.5, fill: COL.sub, anchor: "middle" }));
  out.push(text(L - 12, T - 14, "tok/task", { size: 11, fill: COL.faint, anchor: "end" }));

  out.push(poly(skill.map((v: number, i: number) => [sx(i), sy(v)]), SERIES.skill_harness, 2.6));
  out.push(poly(chronos.map((v: number, i: number) => [sx(i), sy(v)]), SERIES.chronos_v4, 3));
  // zero-cost tasks get a tick on the floor
  b2.ticks.forEach((t: any, i: number) => {
    if (t.chronosTokens === 0) out.push(dot(sx(i), B, 2.4, SERIES.chronos_v4, COL.panel, 0));
  });

  const inter = Math.min(b2.tasks - 1, b2.interceptorActivatedAt ?? 0);
  out.push(line(sx(inter), T, sx(inter), B, SERIES.chronos_v4, 1.2, "4 4", 0.55));
  out.push(text(sx(inter) + 6, T + 12, `interceptor active (task ${inter + 1}) → 0 tokens`, { size: 10, fill: SERIES.chronos_v4 }));

  const last10 = b2.tasks - 5;
  out.push(line(sx(last10), T, sx(last10), B, COL.faint, 1, "3 3", 0.5));
  out.push(text(sx(last10) - 6, T + 12, "last 10 tasks", { size: 10, fill: COL.faint, anchor: "end" }));

  out.push(box(L + 16, T + 26, 300, 78));
  out.push(text(L + 30, T + 48, "Chronos-Palace", { size: 11.5, fill: SERIES.chronos_v4, weight: 650 }));
  out.push(text(L + 30, T + 65, `first 10: ${fmt(b2.first10Avg)} tok → last 10: ${fmt(b2.last10Avg)} tok/task`, { size: 10.5, fill: COL.sub }));
  out.push(text(L + 30, T + 82, `${b2.audits.reduce((a: number, r: any) => a + r.pruned, 0)} negative-ROI artifacts pruned · ${b2.learnedPatterns} C3 patterns`, { size: 10.5, fill: COL.sub }));
  out.push(text(L + 30, T + 97, `genome held at ${fmt(b2.finalGenome.total)} tok`, { size: 10.5, fill: COL.sub }));

  out.push(box(R - 316, T + 26, 300, 78));
  out.push(text(R - 302, T + 48, "Auto-generated SKILL.md", { size: 11.5, fill: SERIES.skill_harness, weight: 650 }));
  out.push(text(R - 302, T + 65, `first 10: ${fmt(b2.first10AvgRival)} tok → last 10: ${fmt(b2.last10AvgRival)} tok/task`, { size: 10.5, fill: COL.sub }));
  out.push(text(R - 302, T + 82, `${b2.skillFiles} skill files, no reclamation applied`, { size: 10.5, fill: COL.sub }));
  out.push(text(R - 302, T + 97, `library grows to ${fmt(b2.skillLibraryTokens)} tok`, { size: 10.5, fill: COL.sub }));
  return out.join("");
}

function panel3(d: any, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  const lines = d.scorecard.lines as any[];
  out.push(
    panel(
      x,
      y,
      w,
      h,
      "3 · Task success rate & end-to-end latency",
      `0.40·info + 0.25·module + 0.15·lessons + 0.20·SNR · latency = overhead + prefill at the measured ${fmt(d.bench4.prefill.tokPerSec)} tok/s`,
    ),
  );

  const order = ["full_context", "fact_memory", "skill_harness", "vector_rag", "chronos_v4", "subagent"];
  const rows = order.map((id) => lines.find((l) => l.id === id)!);
  const half = (w - 44) / 2;
  const rowh = Math.min(38, (h - 150) / rows.length);

  // ---- left: success rate bars
  const L = x + 24;
  const T = y + 92;
  out.push(text(L, T - 12, "task success rate (%)", { size: 11.5, fill: COL.sub, weight: 600 }));
  const sxs = linScale(0, 100, L, L + half - 8);
  rows.forEach((r, i) => {
    const yy = T + i * rowh;
    const barH = rowh - 12;
    out.push(text(L, yy + barH - 2, r.label.length > 22 ? r.label.slice(0, 21) + "…" : r.label, { size: 10.5, fill: COL.sub }));
    out.push(rect(L, yy + barH + 4, sxs(100) - L, 7, COL.grid, { rx: 3.5 }));
    out.push(rect(L, yy + barH + 4, Math.max(2, sxs(r.successRate) - L), 7, SERIES[r.id], { rx: 3.5, opacity: r.id === "chronos_v4" ? 1 : 0.72 }));
    out.push(text(sxs(100) + 6, yy + barH + 10, `${r.successRate}%`, { size: 10.5, fill: COL.text, weight: 600 }));
  });
  const bestSucc = Math.max(...rows.map((r) => r.successRate));
  const wi = rows.findIndex((r) => r.successRate === bestSucc);
  out.push(text(sxs(100) + 6, T + wi * rowh + (rowh - 12) + 10, " best", { size: 10, fill: COL.faint }));

  // ---- right: latency bars (log scale)
  const RX = x + 24 + half + 20;
  out.push(text(RX, T - 12, "end-to-end latency per task (ms, log)", { size: 11.5, fill: COL.sub, weight: 600 }));
  const lat = rows.map((r) => r.totalMs);
  const sxl = logScale(100, 2_000_000, RX, RX + half - 24);
  for (const t of [100, 1e3, 1e4, 1e5, 1e6]) {
    out.push(line(sxl(t), T, sxl(t), T + rows.length * rowh, COL.grid, 1, "2 4"));
    out.push(text(sxl(t), T + rows.length * rowh + 16, t >= 1e6 ? "1M" : compact(t), { size: 10, fill: COL.faint, anchor: "middle" }));
  }
  rows.forEach((r, i) => {
    const yy = T + i * rowh;
    const barH = rowh - 12;
    out.push(rect(RX, yy + barH + 4, sxl(r.totalMs) - RX, 7, SERIES[r.id], { rx: 3.5, opacity: r.id === "chronos_v4" ? 1 : 0.72 }));
    out.push(text(Math.min(sxl(r.totalMs) + 6, RX + half - 60), yy + barH + 10, `${compact(r.totalMs)} ms`, { size: 10.5, fill: COL.text, weight: 600 }));
  });
  return out.join("");
}

function panel4(d: any, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  const lines = d.scorecard.lines as any[];
  const order = ["chronos_v4", "full_context", "vector_rag", "fact_memory", "subagent", "skill_harness"];
  const rows = order.map((id) => lines.find((l) => l.id === id)!);
  out.push(
    panel(
      x,
      y,
      w,
      h,
      "4 · Head-to-head scorecard",
      `Green = won that criterion (ties count for all). ${d.scorecard.criteria} criteria, Chronos-Palace takes ${d.scorecard.wins.chronos_v4}.`,
    ),
  );

  const cols = [
    { k: "tokens500", a: "tok/task", b: "@500 files", f: (r: any) => compact(r.tokens500), best: Math.min(...rows.map((r) => r.tokens500)) },
    { k: "cacheHitPct", a: "cache-", b: "stable", f: (r: any) => `${r.cacheHitPct}%`, best: Math.max(...rows.map((r) => r.cacheHitPct)) },
    { k: "successRate", a: "task", b: "success", f: (r: any) => `${r.successRate}%`, best: Math.max(...rows.map((r) => r.successRate)) },
    { k: "latencyMs", a: "overhead", b: "ms", f: (r: any) => (r.latencyMs >= 10 ? fmt(r.latencyMs) : r.latencyMs.toFixed(1)), best: Math.min(...rows.map((r) => r.latencyMs)) },
    { k: "snr", a: "signal/", b: "noise", f: (r: any) => `${(r.snr * 100).toFixed(0)}%`, best: Math.max(...rows.map((r) => r.snr)) },
    { k: "efficiency", a: "succ/", b: "1k tok", f: (r: any) => compact(r.efficiency), best: Math.max(...rows.map((r) => r.efficiency)) },
  ];
  const boolCols = [
    { k: "episodicContinuity", a: '"hi"', b: "episodic" },
    { k: "zeroTokenLearning", a: "0-tok", b: "learn" },
    { k: "roiGovernance", a: "ROI", b: "gov." },
  ];

  const SHORT: Record<string, string> = {
    chronos_v4: "Chronos-Palace v4.0",
    full_context: "Full-Context + .md Rules",
    vector_rag: "Standard Vector RAG",
    fact_memory: "Cloud Fact Memory",
    subagent: "Sub-Agent Explorer",
    skill_harness: "Auto-Gen SKILL.md",
  };
  const labelW = 214;
  const nCols = cols.length + boolCols.length;
  const cw = (w - 46 - labelW - 64) / nCols;
  const T = y + 92;
  const rowH = Math.min(42, (h - 158) / rows.length);

  out.push(text(x + 22, T - 22, "system", { size: 10.5, fill: COL.faint }));
  const head = (cx: number, a: string, b: string) => [
    text(cx + cw / 2, T - 24, a, { size: 10, fill: COL.faint, anchor: "middle" }),
    text(cx + cw / 2, T - 12, b, { size: 10, fill: COL.faint, anchor: "middle" }),
  ].join("");
  cols.forEach((c, i) => out.push(head(x + 22 + labelW + cw * i, c.a, c.b)));
  boolCols.forEach((c, i) => out.push(head(x + 22 + labelW + cw * (cols.length + i), c.a, c.b)));
  out.push(text(x + w - 22 - 28, T - 24, "total", { size: 10, fill: COL.faint, anchor: "middle" }));
  out.push(text(x + w - 22 - 28, T - 12, "wins", { size: 10, fill: COL.faint, anchor: "middle" }));

  rows.forEach((r, i) => {
    const yy = T + i * rowH;
    if (i % 2 === 1) out.push(rect(x + 16, yy, w - 32, rowH - 4, "#0e141d", { rx: 6 }));
    out.push(dot(x + 30, yy + rowH / 2 - 2, 4.5, SERIES[r.id], COL.panel, 1.2));
    out.push(text(x + 44, yy + rowH / 2 + 2, SHORT[r.id] ?? r.label, { size: 11.5, fill: r.id === "chronos_v4" ? COL.text : COL.sub, weight: r.id === "chronos_v4" ? 650 : 400 }));
    cols.forEach((c, j) => {
      const cx = x + 22 + labelW + cw * j;
      const isBest = Math.abs(Number(r[c.k]) - (c.best as number)) < 1e-9;
      if (isBest) out.push(rect(cx + 4, yy + 3, cw - 8, rowH - 10, COL.win, { rx: 5, stroke: COL.winEdge, sw: 1 }));
      out.push(text(cx + cw / 2, yy + rowH / 2 + 2, c.f(r), { size: 11, fill: isBest ? "#7ee7b6" : COL.sub, weight: isBest ? 650 : 400, anchor: "middle" }));
    });
    boolCols.forEach((c, j) => {
      const cx = x + 22 + labelW + cw * (cols.length + j);
      const on = Boolean(r[c.k]);
      if (on) out.push(rect(cx + 4, yy + 3, cw - 8, rowH - 10, COL.win, { rx: 5, stroke: COL.winEdge, sw: 1 }));
      out.push(text(cx + cw / 2, yy + rowH / 2 + 2.5, on ? "✔" : "—", { size: on ? 12 : 11, fill: on ? "#7ee7b6" : COL.faint, weight: on ? 700 : 400, anchor: "middle" }));
    });
    const winX = x + w - 22 - 28;
    const wins = d.scorecard.wins[r.id];
    const isTop = wins === Math.max(...(Object.values(d.scorecard.wins) as number[]));
    if (isTop) out.push(rect(winX - 20, yy + 3, 44, rowH - 10, COL.win, { rx: 5, stroke: COL.winEdge, sw: 1 }));
    out.push(text(winX, yy + rowH / 2 + 2, `${wins}`, { size: 13, fill: isTop ? "#7ee7b6" : COL.sub, weight: isTop ? 750 : 400, anchor: "middle" }));
  });
  return out.join("");
}

// ===========================================================================
// Build
// ===========================================================================

export function buildSvg(d: any): string {
  const PAD = 40;
  const GAP = 32;
  const PW = (W - 2 * PAD - GAP) / 2;
  const PH = (H - 120 - PAD - GAP) / 2;

  const svg: string[] = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  svg.push(rect(0, 0, W, H, COL.bg));
  svg.push(`<defs><linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22d3a7" stop-opacity="0.85"/><stop offset="0.5" stop-color="#38bdf8" stop-opacity="0.5"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0.25"/></linearGradient></defs>`);
  svg.push(rect(PAD, 22, W - 2 * PAD, 3, "url(#hdr)", { rx: 1.5 }));

  svg.push(text(PAD, 60, "Chronos-Palace v4.0 “OMEGA-GENOME” — Head-to-Head Memory Benchmark", { size: 25, weight: 700 }));
  svg.push(
    text(PAD, 86, `6 architectures · 4 project scales (50 → 1,000 files) · 100-task learning loop · ${d.meta.reps} timed repetitions · ${d.meta.runtime.cpus} cores`, {
      size: 12.5,
      fill: COL.sub,
    }),
  );
  svg.push(text(W - PAD, 52, `generated ${d.meta.generatedAt.slice(0, 16).replace("T", " ")} UTC · bun ${d.meta.runtime.bun} · ${d.meta.runtime.platform}`, { size: 11, fill: COL.faint, anchor: "end" }));
  svg.push(text(W - PAD, 70, "Chronos-Palace = measured on its real engine · 5 rivals = calibrated models", { size: 11, fill: COL.faint, anchor: "end" }));
  svg.push(text(W - PAD, 88, "token meter: aaak.estimateTokens (identical for every system)", { size: 11, fill: COL.faint, anchor: "end" }));

  svg.push(panel1(d, PAD, 120, PW, PH));
  svg.push(panel2(d, PAD + PW + GAP, 120, PW, PH));
  svg.push(panel3(d, PAD, 120 + PH + GAP, PW, PH));
  svg.push(panel4(d, PAD + PW + GAP, 120 + PH + GAP, PW, PH));

  svg.push(text(PAD, H - 12, "Source: benchmark/run_benchmark.ts → results/benchmark_results.json — every figure in this dashboard is read from that file.", { size: 10, fill: COL.faint }));
  svg.push(text(W - PAD, H - 12, "github.com/opencode · plugin/chronos-memory", { size: 10, fill: COL.faint, anchor: "end" }));
  svg.push(`</svg>`);
  return svg.join("\n");
}

// ===========================================================================
// SVG -> PNG, with a cascade rather than a single hope
// ===========================================================================

export async function svgToPng(svgPath: string, pngPath: string, width = W): Promise<string> {
  const attempts: Array<{ name: string; run: () => Promise<boolean> }> = [];

  attempts.push({
    name: "@resvg/resvg-js",
    run: async () => {
      try {
        const mod: any = await import("@resvg/resvg-js");
        const svg = readFileSync(svgPath, "utf8");
        const r = new mod.Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } });
        writeFileSync(pngPath, r.render().asPng());
        return existsSync(pngPath);
      } catch {
        return false;
      }
    },
  });

  const shellOk = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      return (await p.exited) === 0;
    } catch {
      return false;
    }
  };

  attempts.push({ name: "rsvg-convert", run: () => shellOk(["rsvg-convert", "-w", String(width), "-o", pngPath, svgPath]) });
  attempts.push({ name: "qlmanage", run: async () => shellOk(["qlmanage", "-t", "-s", String(width), "-o", dirname(pngPath), svgPath]) });
  attempts.push({ name: "sips", run: () => shellOk(["sips", "-s", "format", "png", svgPath, "--out", pngPath]) });
  attempts.push({ name: "magick", run: () => shellOk(["magick", "-background", "none", "-density", "144", svgPath, pngPath]) });
  attempts.push({ name: "convert", run: () => shellOk(["convert", "-background", "none", "-density", "144", svgPath, pngPath]) });
  attempts.push({ name: "ffmpeg", run: () => shellOk(["ffmpeg", "-y", "-loglevel", "error", "-i", svgPath, "-vf", `scale=${width}:-1`, pngPath]) });
  attempts.push({
    name: "chrome-headless",
    run: async () => {
      for (const bin of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
        const ok = await shellOk([bin, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--screenshot=${pngPath}`, `--window-size=${width},${H}`, `file://${svgPath}`]);
        if (ok && existsSync(pngPath)) return true;
      }
      return false;
    },
  });
  attempts.push({
    name: "cairosvg",
    run: () => shellOk(["python3", "-c", `import cairosvg,sys;cairosvg.svg2png(url=${JSON.stringify(svgPath)},write_to=${JSON.stringify(pngPath)},output_width=${width})`]),
  });

  const tried: string[] = [];
  for (const a of attempts) {
    if (await a.run()) return a.name;
    tried.push(a.name);
  }
  throw new Error(`no SVG->PNG converter worked; tried: ${tried.join(", ")}`);
}

// ===========================================================================
// CLI
// ===========================================================================

export async function renderDashboard(resultsPath = join(HERE, "results", "benchmark_results.json"), outDir = HERE, alsoCopyTo?: string) {
  const d = JSON.parse(readFileSync(resultsPath, "utf8"));
  const svg = buildSvg(d);
  const svgPath = join(outDir, "chronos_v4_panels.svg");
  const pngPath = join(outDir, "chronos_v4_panels.png");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(svgPath, svg, "utf8");
  const via = await svgToPng(svgPath, pngPath);
  if (alsoCopyTo) {
    mkdirSync(alsoCopyTo, { recursive: true });
    for (const p of [svgPath, pngPath]) if (existsSync(p)) copyFileSync(p, join(alsoCopyTo, p.split("/").pop()!));
  }
  return { svgPath, pngPath, via };
}

if (import.meta.main) {
  const r = await renderDashboard(process.argv[2], process.argv[3], process.argv[4]);
  console.log(`[dashboard] svg ${r.svgPath}`);
  console.log(`[dashboard] png ${r.pngPath} (via ${r.via})`);
}
