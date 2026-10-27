// ===========================================================================
// tools/leaderboard.ts — Arena-style leaderboard image for the public suite.
//
// Style reference: ~/template_bench.jpeg (cream paper, serif title with a
// yellow-highlighted phrase, circled ranks, solid navy bars, value labels,
// bottom axis, source/note footer).
//
// Reads results/<bench>-latest.json (aggregates) — nothing typed by hand.
// Bar = union recall @10 (presence P@10 for mab); grey suffix = product
// (the evidence slice actually injected into the model).
//
// Outputs results/leaderboard.{svg,png} and copies to
// benchmark/chronos_v4_leaderboard.{svg,png}.
// PNG conversion cascades: @resvg/resvg-js → rsvg-convert → magick/convert →
// headless Chrome → cairosvg.
// ===========================================================================

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, "..");
const RES = join(PUB, "results");
const UP = join(PUB, "..");

const W = 1500;
const H = 920;

const C = {
  bg: "#FBFAF6",      // paper
  ink: "#100F0D",     // near-black warm
  navy: "#121F86",    // bars
  yellow: "#F3C307",  // highlight
  gray: "#55554D",    // values, axis
  muted: "#6E6A5E",   // subtitles, footer
  faint: "#8C887A",   // honest notes
  grid: "#E3E0D4",    // gridlines
  ring: "#C6C1B2",    // rank circle stroke, bar-end nub
};

const SERIF = "IBM Plex Serif, serif";
const SANS = "IBM Plex Sans, sans-serif";

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 4, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 1) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`;
const txt = (
  x: number, y: number, s: string, size: number, fill: string,
  opts: { anchor?: string; weight?: number; italic?: boolean; family?: string; spacing?: number } = {},
) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${opts.anchor ?? "start"}" font-weight="${opts.weight ?? 400}" font-family="${opts.family ?? SANS}"${opts.italic ? ' font-style="italic"' : ""}${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ""}>${esc(s)}</text>`;

// ------------------------------------------------------------------ data

function load(bench: string): any | null {
  const p = join(RES, `${bench}-latest.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

interface Row { name: string; suffix: string; union: number; product: number; }

const SPEC: Array<[string, string]> = [
  ["memorybench", "MemoryBench (THUIR)"],
  ["membench", "MemBench"],
  ["longmemeval", "LongMemEval"],
  ["locomo", "LoCoMo"],
  ["dolphinbench", "DolphinBench"],
  ["mab", "MemoryAgentBench"],
  ["beam", "BEAM (100K)"],
];

const rows: Row[] = [];
let totalQ = 0, totalSamples = 0;

for (const [key, name] of SPEC) {
  const d = load(key);
  if (!d) throw new Error(`missing aggregate: ${key}-latest.json`);
  const ag = d.aggregate;
  const union = (ag.union?.r10 ?? ag.union?.p10) as number;
  const product = (ag.product?.r10 ?? ag.product?.p10) as number;
  const q = d.questions as number;
  const scored = d.scored as number;
  const flag = key === "memorybench" ? "derived probe · " : key === "mab" ? "presence proxy · " : "";
  const gold = scored && scored < q ? `${scored} scored · ` : "";
  rows.push({ name, suffix: `${flag}${gold}${q.toLocaleString("en-US")} questions`, union, product });
  totalQ += q;
  totalSamples += d.samples as number;
}

rows.sort((a, b) => b.union - a.union);

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

// ------------------------------------------------------------------ layout

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += rect(0, 0, W, H, C.bg, 0);

// header — title, yellow-highlight phrase, subtitle
svg += txt(76, 102, "Chronos-Palace: Public Benchmarks", 44, C.ink, { family: SERIF, weight: 500 });
const phrase = "evidence recall:";
const phraseW = 18 + phrase.length * 20 + 18; // italic serif ~20px/char at 42px
svg += rect(76, 122, phraseW, 62, C.yellow, 3);
svg += txt(76 + 18, 168, phrase, 42, C.ink, { family: SERIF, weight: 500, italic: true });
svg += txt(76 + phraseW + 22, 168, `7 suites · ${totalQ.toLocaleString("en-US")} questions`, 42, C.ink, { family: SERIF, weight: 500 });
svg += txt(76, 214, `retrieval level — no LLM in the loop · each of ${totalSamples.toLocaleString("en-US")} samples ran in its own isolated brain · ${new Date().toISOString().slice(0, 10)}`, 16.5, C.muted);

// header — wordmark (stacked memory layers + name)
svg += rect(1180, 58, 46, 9, C.navy, 2);
svg += rect(1180, 72, 46, 9, C.navy, 2);
svg += rect(1180, 86, 32, 9, C.navy, 2);
svg += txt(1424, 100, "Chronos", 42, C.ink, { family: SERIF, weight: 500, anchor: "end" });
svg += txt(1424, 126, "CHRONOS-MEMORY", 11, C.muted, { anchor: "end", spacing: 1.5 });

// list
const rowTop = 252, rowH = 78, barX0 = 640, barW = 560, barH = 32;
const gridTop = 240, gridBot = 806;

for (let g = 0; g <= 4; g++) {
  const gx = barX0 + (barW * g) / 4;
  svg += line(gx, gridTop, gx, gridBot, C.grid, 1.2);
  svg += txt(gx, 830, g === 0 ? "0" : `${g * 25}%`, 15.5, C.gray, { anchor: "middle" });
}

rows.forEach((r, i) => {
  const y = rowTop + i * rowH;
  const mid = y + rowH / 2 - 5;
  svg += `<circle cx="104" cy="${mid}" r="19" fill="none" stroke="${C.ring}" stroke-width="1.8"/>`;
  svg += txt(104, mid + 7, String(i + 1), 20, C.ink, { anchor: "middle", family: SERIF, weight: 500 });
  svg += txt(148, mid - 3, r.name, 26, C.ink, { weight: 500 });
  svg += txt(148, mid + 19, r.suffix, 15, C.faint);

  const by = mid - barH / 2;
  const xend = barX0 + barW * r.union;
  svg += rect(barX0, by, barW * r.union, barH, C.navy, 4);
  svg += rect(xend + 4, by + 3, 5, barH - 6, C.ring, 2.5);
  const v = pct(r.union);
  svg += txt(xend + 20, by + barH - 7, v, 23, C.ink, { weight: 600 });
  const vW = v.length * 12.8;
  svg += txt(xend + 20 + vW + 10, by + barH - 7.5, `· packet ${pct(r.product)}`, 16, C.faint);
});

// honest notes + footer
svg += txt(76, 854, "Union = agreement-calibrated merge of graph + verbatim (the retrieval head). Packet = the evidence slice actually injected into the model.", 12.5, C.faint);
svg += txt(76, 874, "MemoryBench = derived continuity probe (not the authors' LLM-judged protocol). MemoryAgentBench = answer-string presence proxy (no evidence labels).", 12.5, C.faint);
svg += txt(76, 902, `SOURCE: CHRONOS-PALACE V4.1 — BENCHMARK/PUBLIC/RESULTS/SUMMARY.MD · ${totalQ.toLocaleString("en-US")} QUESTIONS · ${totalSamples.toLocaleString("en-US")} ISOLATED BRAINS · ${new Date().toISOString().slice(0, 10)}`, 11, C.muted, { spacing: 1 });
svg += txt(1424, 902, "NOTE: MERGED RECALL @10 · EXCEPT MAB (PRESENCE P@10)", 11, C.muted, { anchor: "end", spacing: 1 });

svg += "</svg>";

// ------------------------------------------------------------------ write

const svgPath = join(RES, "leaderboard.svg");
const pngPath = join(RES, "leaderboard.png");
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
  if (existsSync(p)) copyFileSync(p, join(UP, "chronos_v4_leaderboard" + p.slice(p.lastIndexOf("."))));
}
console.log(`leaderboard: ${svgPath}\nleaderboard: ${pngPath} (via ${via})\ncopy: benchmark/chronos_v4_leaderboard.{svg,png}`);
