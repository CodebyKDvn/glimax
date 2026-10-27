// ===========================================================================
// tools/dashboard.ts — SVG + PNG dashboard for the public-benchmark suite.
//
// Reads results/<bench>-latest.json (aggregates) and the per-question parts in
// work/<bench>/s-*.json (for per-type breakdowns). Nothing is typed by hand.
//
// Panels:
//   1. coverage chips — the 10 requested benchmarks and their status
//   2. evidence recall @10 by channel — the 6 structural benches
//   3. LongMemEval by question type · MemBench by category · MAB presence
//
// PNG conversion cascades: @resvg/resvg-js → rsvg-convert → magick/convert →
// headless Chrome → cairosvg. Outputs results/dashboard.{svg,png} and copies
// to benchmark/chronos_v4_public_benchmarks.{svg,png}.
// ===========================================================================

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, "..");
const RES = join(PUB, "results");
const UP = join(PUB, "..");

const W = 1920;
const H = 1200;

const C = {
  bg: "#0a0d13", panel: "#111722", edge: "#1e2836", grid: "#1a222e",
  text: "#e8eef6", sub: "#93a2b5", faint: "#5d6b7d",
  graph: "#22d3a7", verbatim: "#f59e0b", union: "#8b5cf6", product: "#60a5fa",
  scored: "#4ade80", proxy: "#fbbf24", derived: "#a78bfa", none: "#f87171",
};

type Agg = Record<string, number | null>;

function load(bench: string): any | null {
  const p = join(RES, `${bench}-latest.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function partsOf(bench: string): any[] {
  const dir = join(PUB, "work", bench);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^s-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** mean of channel metric over questions, grouped by q.type prefix family.
 *  presence=true reads q[ch].pres[metric] (answer-string presence proxy). */
function perType(bench: string, channel: string, metric = "r10", presence = false): Map<string, number | null> {
  const groups = new Map<string, number[]>();
  for (const part of partsOf(bench)) {
    for (const q of part.questions as any[]) {
      const fam = String(q.type ?? "?").split("/")[0];
      const v = presence ? q[channel]?.pres?.[metric] : q[channel]?.[metric];
      if (v == null || Number.isNaN(v)) continue;
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam)!.push(v);
    }
  }
  const out = new Map<string, number | null>();
  for (const [k, xs] of groups) out.set(k, xs.reduce((a, b) => a + b, 0) / xs.length);
  return out;
}

// ------------------------------------------------------------------ svg bits

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 3, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;
const txt = (
  x: number, y: number, s: string, size: number, fill: string,
  anchor = "start", weight = 400, opacity = 1,
) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}" opacity="${opacity}" font-family="Inter,system-ui,-apple-system,sans-serif">${esc(s)}</text>`;

interface Row { label: string; bars: Array<{ v: number; color: string; tag?: string }>; }

function barPanel(
  x: number, y: number, w: number, h: number, title: string, rows: Row[],
  maxV = 1, valueFmt: (v: number) => string = (v) => `${Math.round(v * 100)}%`,
): string {
  let s = rect(x, y, w, h, C.panel, 10, `stroke="${C.edge}"`);
  s += txt(x + 18, y + 28, title, 15, C.text, "start", 600);
  const labelW = Math.min(210, Math.max(120, Math.max(...rows.map((r) => r.label.length)) * 8));
  const plotX = x + 18 + labelW + 10;
  const plotW = w - 18 - labelW - 10 - 74; // right gutter for value labels
  const top = y + 46;
  const rowH = (h - 46 - 16) / rows.length;
  // gridlines
  for (let g = 0; g <= 4; g++) {
    const gx = plotX + (plotW * g) / 4;
    s += `<line x1="${gx}" y1="${top}" x2="${gx}" y2="${y + h - 14}" stroke="${C.grid}" stroke-width="1"/>`;
    if (g > 0) s += txt(gx, y + h - 3, `${g * 25}%`, 10, C.faint, "middle");
  }
  rows.forEach((r, i) => {
    const ry = top + i * rowH;
    s += txt(x + 18, ry + rowH / 2 + 4, r.label, 12.5, C.sub, "start", 400);
    const n = r.bars.length;
    const slot = rowH - 10;
    const bh = Math.max(6, Math.min(13, slot / n - 3));
    r.bars.forEach((b, j) => {
      const by = ry + 5 + j * (bh + 3);
      const bv = Math.max(0, Math.min(1, b.v));
      s += rect(plotX, by, Math.max(1, plotW * bv / maxV), bh, b.color, 2);
      const lab = valueFmt(b.v);
      s += txt(plotX + plotW * bv / maxV + 6, by + bh - 1.5, lab + (b.tag ? ` ${b.tag}` : ""), 10, C.faint);
    });
  });
  return s;
}

// ------------------------------------------------------------------ assemble

const BENCHES = ["locomo", "longmemeval", "beam", "dolphinbench", "membench", "memorybench"] as const;
const d = new Map<string, any>();
for (const b of BENCHES) {
  const r = load(b);
  if (r) d.set(b, r);
}

const CH: Array<[string, string]> = [["graph", C.graph], ["verbatim", C.verbatim], ["union", C.union], ["product", C.product]];

const totalQ = [...d.values()].reduce((a: number, r: any) => a + (r.questions ?? 0), 0);
const totalScored = [...d.values()].reduce((a: number, r: any) => a + (r.scored ?? 0), 0);
const totalSamples = [...d.values()].reduce((a: number, r: any) => a + (r.samples ?? 0), 0);
const mabMeasured = partsOf("mab").length > 0;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += rect(0, 0, W, H, C.bg, 0);

// header
svg += txt(60, 56, "Chronos-Palace v4.1 — public memory benchmarks", 30, C.text, "start", 700);
svg += txt(60, 80, "retrieval level · no LLM in the loop · evidence surfaced for a downstream model to answer from", 14, C.sub);
svg += txt(1860, 56, new Date().toISOString().slice(0, 16).replace("T", " ") + "Z", 13, C.faint, "end");
svg += txt(1860, 78, "results/SUMMARY.md · per-bench reports in results/*-report.md", 12, C.faint, "end");

// coverage chips — 10 targets
const targets: Array<[string, string, string]> = [
  ["LoCoMo", "scored", C.scored], ["LongMemEval", "scored", C.scored], ["BEAM 100K", "scored", C.scored],
  ["MemoryAgentBench", "proxy", C.proxy], ["DolphinBench", "scored", C.scored], ["MemBench", "scored", C.scored],
  ["MemoryBench", "derived", C.derived], ["MemoryArena", "agentic — not scorable", C.none],
  ["VibeMemBench", "no data", C.none], ["AgentMemBench", "no data", C.none],
];
const chipW = 172, chipGap = 8.4;
targets.forEach(([name, status, color], i) => {
  const cx = 60 + i * (chipW + chipGap);
  svg += rect(cx, 100, chipW, 42, C.panel, 8, `stroke="${color}" stroke-opacity="0.55"`);
  svg += rect(cx, 100, 4, 42, color, 2);
  svg += txt(cx + 14, 118, name, 12.5, C.text, "start", 600);
  svg += txt(cx + 14, 133, status, 10.5, color);
});

// KPI cards
const kpis: Array<[string, string]> = [
  [String(totalScored), "questions scored"],
  [`${d.size + (mabMeasured ? 1 : 0)} / 10`, "benchmarks measured"],
  [`${totalSamples}`, "isolated brains"],
  ["4", "channels · graph / verbatim / union / product"],
];
kpis.forEach(([v, k], i) => {
  const cx = 60 + i * 460;
  svg += rect(cx, 156, 448, 54, C.panel, 8, `stroke="${C.edge}"`);
  svg += txt(cx + 16, 190, v, 24, C.graph, "start", 700);
  svg += txt(cx + 16 + (v.length > 6 ? 130 : 96), 189, k, 12.5, C.sub);
});

// legend for channels
svg += txt(60, 236, "channels:", 12, C.faint);
CH.forEach(([name, color], i) => {
  const lx = 128 + i * 128;
  svg += rect(lx, 226, 12, 12, color, 2);
  svg += txt(lx + 18, 236, name, 12, C.sub);
});
svg += txt(1860, 236, "R@10 = gold evidence found in top-10 retrieved turns (fraction of required items)", 11.5, C.faint, "end");

// main panel — R@10 by channel
const mainRows: Row[] = [...d.entries()].map(([b, r]) => ({
  label: b + `  (${r.samples}/${r.questions}q)`,
  bars: CH.map(([ch, color]) => ({ v: (r.aggregate?.[ch]?.r10 ?? 0) as number, color })),
}));
svg += barPanel(60, 250, 1800, 330, "Evidence recall @10 by channel", mainRows);

// three breakdown panels
const p1rows: Row[] = [...perType("longmemeval", "graph").entries()].map(([t, g]) => ({
  label: t,
  bars: [
    { v: g ?? 0, color: C.graph },
    { v: perType("longmemeval", "verbatim").get(t) ?? 0, color: C.verbatim },
  ],
}));
svg += barPanel(60, 600, 584, 330, "LongMemEval by question type — R@10", p1rows);

const mbCats = [...perType("membench", "graph").entries()];
const p2rows: Row[] = mbCats.map(([t, g]) => ({
  label: t,
  bars: [
    { v: g ?? 0, color: C.graph },
    { v: perType("membench", "verbatim").get(t) ?? 0, color: C.verbatim },
  ],
}));
svg += barPanel(668, 600, 584, 330, "MemBench by category — R@10", p2rows);

const mabFams = ["AR", "TTL", "CR"];
const p3rows: Row[] = mabFams.map((fam) => ({
  label: `${fam}${fam === "AR" ? " (docs)" : fam === "TTL" ? " (dialogues)" : " (facts)"}`,
  bars: [
    { v: perType("mab", "graph", "p10", true).get(fam) ?? 0, color: C.graph },
    { v: perType("mab", "verbatim", "p10", true).get(fam) ?? 0, color: C.verbatim },
    { v: perType("mab", "product", "p10", true).get(fam) ?? 0, color: C.product },
  ],
}));
svg += barPanel(1276, 600, 584, 330, "MemoryAgentBench — presence P@10 (proxy)", p3rows);

// footer
svg += txt(60, 972, "Fastest:", 12, C.sub, "start", 600);
const lat = [...d.entries()].map(([b, r]) => [b, (r.aggregate?.graph?.p50ms ?? 0) as number] as const).sort((a, b) => a[1] - b[1]);
svg += txt(122, 972, lat.map(([b, ms]) => `${b} ${ms.toFixed(1)}ms`).join("   ·   "), 12, C.faint);
svg += txt(60, 996, "Packet:", 12, C.sub, "start", 600);
svg += txt(122, 996, [...d.entries()].map(([b, r]) => `${b} ~${Math.round(r.aggregate?.product?.tokensMean ?? 0)} tok`).join("   ·   "), 12, C.faint);

svg += txt(60, 1036, "Honest notes:", 12.5, C.sub, "start", 600);
const notes = [
  "LongMemEval: session-level gold; 30 abstention questions excluded. · BEAM 100K: message-level gold, 235/400 questions (abstention/summarization lack gold).",
  "MemoryBench: DERIVED continuity probe (negative-feedback rounds as gold) — not the authors' LLM-judged protocol. · MAB: answer-string presence in ~900-char windows (AR/CR 30q, TTL 40q sampled).",
  "DolphinBench product gap is real: action metadata (tools) crowds verbatim evidence out of the injected packet. · MemoryArena / VibeMemBench / AgentMemBench: not retrieval-scorable / no public data (see SUMMARY.md).",
];
notes.forEach((n, i) => {
  svg += txt(60, 1058 + i * 20, "· " + n, 11.5, C.faint);
});
svg += txt(1860, 1176, "every sample an isolated brain · corpus time anchored so newest session ≈ 1 day old", 11, C.faint, "end");

svg += "</svg>";

// ------------------------------------------------------------------ write

const svgPath = join(RES, "dashboard.svg");
const pngPath = join(RES, "dashboard.png");
writeFileSync(svgPath, svg);

async function toPng(): Promise<string> {
  const tried: string[] = [];
  try {
    const mod: any = await import("@resvg/resvg-js");
    const r = new mod.Resvg(svg, { fitTo: { mode: "width", value: W } });
    writeFileSync(pngPath, r.render().asPng());
    return "@resvg/resvg-js";
  } catch (e) {
    tried.push("@resvg/resvg-js");
  }
  const shellOk = (cmd: string[]) => {
    try {
      const p = spawnSync(cmd[0], cmd.slice(1), { stdio: "ignore" });
      return p.status === 0 && existsSync(pngPath);
    } catch { return false; }
  };
  const attempts: Array<[string, () => boolean]> = [
    ["rsvg-convert", () => shellOk(["rsvg-convert", "-w", String(W), "-o", pngPath, svgPath])],
    ["magick", () => shellOk(["magick", "-background", "none", "-density", "144", svgPath, pngPath])],
    ["convert", () => shellOk(["convert", "-background", "none", "-density", "144", svgPath, pngPath])],
    ["chromium", () => shellOk(["chromium", "--headless", "--disable-gpu", "--no-sandbox", `--screenshot=${pngPath}`, `--window-size=${W},${H}`, `file://${svgPath}`])],
    ["cairosvg", () => shellOk(["python3", "-c", `import cairosvg;cairosvg.svg2png(url=${JSON.stringify(svgPath)},write_to=${JSON.stringify(pngPath)},output_width=${W})`])],
  ];
  for (const [name, run] of attempts) {
    tried.push(name);
    if (run()) return name;
  }
  throw new Error(`no SVG->PNG converter worked; tried: ${tried.join(", ")}`);
}

const via = await toPng();
for (const p of [svgPath, pngPath]) {
  if (existsSync(p)) copyFileSync(p, join(UP, "chronos_v4_public_benchmarks" + p.slice(p.lastIndexOf("."))));
}
console.log(`dashboard: ${svgPath}\ndashboard: ${pngPath} (via ${via})\ncopy: benchmark/chronos_v4_public_benchmarks.{svg,png}`);
