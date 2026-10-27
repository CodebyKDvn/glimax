// ===========================================================================
// tools/omni_eval.ts — A/B the v7.0 planner against the v6 head on one brain.
//
// One process per sample: ingest once (both indexes built), then ask every
// question twice — CHRONOS_OMNI=0 (v6 union head) and =1 (omni planner) — so
// the two columns differ only by the planner, not by ingest or model state.
//
//   bun run tools/omni_eval.ts --bench beam                 # all samples
//   bun run tools/omni_eval.ts --bench beam --samples 1,2,3
//   bun run tools/omni_eval.ts --bench beam --sample 1      # worker
// ===========================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const PUB = join(HERE, "..");

interface Args {
  bench: string;
  sample?: string;
  samples?: string[];
  limit?: number;
  fresh: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { bench: "", fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--bench") a.bench = argv[++i] ?? "";
    else if (v === "--sample") a.sample = argv[++i] ?? "";
    else if (v === "--samples") a.samples = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--limit") a.limit = Number(argv[++i] ?? 0) || undefined;
    else if (v === "--fresh") a.fresh = true;
  }
  return a;
}

const sanitize = (s: string) => s.replace(/[^\w.-]+/g, "_");
const args = parse(Bun.argv.slice(2));
if (!args.bench) {
  console.log("usage: bun run tools/omni_eval.ts --bench <name> [--sample id | --samples a,b,c] [--limit N]");
  process.exit(0);
}

const benchWork = join(PUB, "work", args.bench);
mkdirSync(benchWork, { recursive: true });

// ---------------------------------------------------------------- worker mode
if (args.sample !== undefined) {
  const sample = args.sample;
  const brain = join(benchWork, `brain-${sanitize(sample)}.sqlite`);
  for (const p of [brain, brain + "-wal", brain + "-shm"]) rmSync(p, { force: true });
  process.env.CHRONOS_BRAIN_PATH = brain;
  process.env.CHRONOS_OMNI = "1";

  const { loadInstance } = await import("../adapters/prepared");
  const { ask, ingest, VERBATIM_BY_BENCH } = await import("../lib");

  const inst = loadInstance(args.bench, sample);
  const now = Date.now();
  const DAY = 86_400_000;
  const turns = inst.turns.map((t) => ({
    id: t.id,
    session: t.session,
    speaker: t.speaker,
    text: t.text,
    ts: now + t.ts_off - DAY,
  }));
  const scope = `project:bench-${args.bench}-${sample}`;
  const scopeName = `bench-${args.bench}-${sample}`;
  const t0 = Bun.nanoseconds();
  const ing = await ingest(scope, sample, scopeName, turns, inst.facts ?? []);
  const ingestMs = (Bun.nanoseconds() - t0) / 1e6;

  const qs = args.limit ? inst.questions.slice(0, args.limit) : inst.questions;
  const rows: unknown[] = [];
  for (const item of qs) {
    const gold = [...(item.gold_turns ?? [])];
    if (!gold.length) continue;
    const vmode = VERBATIM_BY_BENCH[args.bench];
    process.env.CHRONOS_OMNI = "0";
    const base = await ask(item.question, scope, sample, scopeName, 50, undefined, { verbatim: vmode });
    process.env.CHRONOS_OMNI = "1";
    const omni = await ask(item.question, scope, sample, scopeName, 50, undefined, { verbatim: vmode });
    const hit = (ids: string[]) => gold.filter((g) => ids.slice(0, 10).includes(g)).length / gold.length;
    rows.push({
      qid: item.qid,
      type: item.type,
      q: item.question,
      gold,
      base: base.union.ids.slice(0, 10),
      omni: omni.union.ids.slice(0, 10),
      origin: omni.omni?.origin ?? [],
      intent: omni.omni?.intent ?? [],
      ops: omni.omni?.ops ?? {},
      rb: hit(base.union.ids),
      ro: hit(omni.union.ids),
    });
  }
  const out = { bench: args.bench, sample, ingest: ing, ingestMs, rows };
  writeFileSync(join(benchWork, `omni-${sanitize(sample)}.json`), JSON.stringify(out));
  const mean = (k: "rb" | "ro") => rows.reduce((a, r) => a + (r as Record<string, number>)[k], 0) / Math.max(1, rows.length);
  console.log(`[omni-eval] ${args.bench}/${sample} n=${rows.length} base=${(mean("rb") * 100).toFixed(1)} omni=${(mean("ro") * 100).toFixed(1)}`);
  process.exit(0);
}

// ---------------------------------------------------------------- parent mode
const cfg = JSON.parse(readFileSync(join(benchWork, "config.json"), "utf8")) as { ordered: string[] };
const samples = args.samples ?? cfg.ordered;
const limitArg = args.limit ? ["--limit", String(args.limit)] : [];
let done = 0;
for (const s of samples) {
  const r = Bun.spawnSync(["bun", "run", join(HERE, "omni_eval.ts"), "--bench", args.bench, "--sample", s, ...limitArg], {
    cwd: PUB,
    env: process.env,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) {
    console.error(`[omni-eval] worker failed for ${s}`);
    continue;
  }
  process.stdout.write(r.stdout.toString());
  done++;
}
console.log(`[omni-eval] ${done}/${samples.length} samples done`);
