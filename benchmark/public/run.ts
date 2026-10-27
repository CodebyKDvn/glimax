// ===========================================================================
// run.ts — CLI dispatcher for the public-benchmark harness.
//
//   bun run run.ts --bench locomo                 # all samples (parent)
//   bun run run.ts --bench locomo --sample conv-26 --limit 25 --fresh
//   bun run run.ts --bench longmemeval --limit 50 # extends as adapters land
//
// Parent mode: one child process per sample, each with its own isolated brain
// (CHRONOS_BRAIN_PATH=work/<bench>/brain-<sample>.sqlite) so L3 global search
// can never leak across samples. Worker mode (--sample given) runs one sample,
// writes work/<bench>/s-<sample>.json; parent then aggregates via report().
// ===========================================================================

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir; // benchmark/public

interface Args {
  bench: string;
  sample?: string;
  limit?: number;
  samples?: number;
  sampleList?: string[];
  fresh: boolean;
  k: number;
}

function parse(argv: string[]): Args {
  const a: Args = { bench: "", fresh: false, k: 50 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--bench") a.bench = argv[++i] ?? "";
    else if (v === "--sample") a.sample = argv[++i] ?? "";
    else if (v === "--limit") a.limit = Number(argv[++i] ?? 0) || undefined;
    else if (v === "--samples") {
      const val = argv[++i] ?? "";
      if (/^\d+$/.test(val)) a.samples = Number(val) || undefined;
      else a.sampleList = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (v === "--k") a.k = Number(argv[++i] ?? 0) || 50;
    else if (v === "--fresh") a.fresh = true;
  }
  return a;
}

const sanitize = (s: string) => s.replace(/[^\w.-]+/g, "_");

const args = parse(Bun.argv.slice(2));
if (!args.bench) {
  console.log("usage: bun run run.ts --bench <name> [--sample <id>] [--limit N] [--fresh]");
  console.log("adapters: " + (await import("node:fs")).readdirSync(join(HERE, "adapters")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).join(", "));
  process.exit(0);
}

const benchWork = join(HERE, "work", args.bench);
mkdirSync(benchWork, { recursive: true });

const adapterPath = (bench: string) => {
  const own = join(HERE, "adapters", `${bench}.ts`);
  return existsSync(own) ? `./adapters/${bench}.ts` : "./adapters/prepared.ts";
};

// ---------------------------------------------------------------- worker mode

if (args.sample !== undefined) {
  const brain = join(benchWork, `brain-${sanitize(args.sample)}.sqlite`);
  if (args.fresh) {
    for (const p of [brain, brain + "-wal", brain + "-shm"]) rmSync(p, { force: true });
  }
  process.env.CHRONOS_BRAIN_PATH = brain;
  const mod = (await import(adapterPath(args.bench))) as { worker: (a: Args) => Promise<void> };
  await mod.worker(args);
  process.exit(0);
}

// ---------------------------------------------------------------- parent mode

const mod = (await import(adapterPath(args.bench))) as {
  listSamples: (a: Args) => string[] | Promise<string[]>;
  report: (a: Args) => Promise<void>;
};
const allSamples = (await mod.listSamples(args)) as string[];
const samples = args.sampleList ?? allSamples.slice(0, args.samples ?? Infinity);
const failed: string[] = [];
console.log(`[${args.bench}] ${samples.length} samples → one isolated brain each`);

for (const s of samples) {
  const part = join(benchWork, `s-${sanitize(s)}.json`);
  if (!args.fresh && existsSync(part) && !args.limit) {
    console.log(`[${args.bench}] skip ${s} (part exists)`);
    continue;
  }
  const cmd = [process.execPath, join(HERE, "run.ts"), "--bench", args.bench, "--sample", s];
  if (args.limit) cmd.push("--limit", String(args.limit));
  cmd.push("--fresh", "--k", String(args.k));
  const r = Bun.spawnSync({ cmd, cwd: HERE, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    // One poisoned sample must not lose the other 499: log it and keep going.
    // The report step counts only the parts that exist, so the aggregate stays
    // honest as long as the failure count is visible in the log.
    failed.push(s);
    console.error(`[${args.bench}] worker failed for ${s} (exit ${r.exitCode}) — continuing`);
  }
}

if (failed.length) console.error(`[${args.bench}] ${failed.length}/${samples.length} workers failed: ${failed.join(", ")}`);
await mod.report(args);
