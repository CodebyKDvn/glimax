process.env.CHRONOS_BRAIN_PATH = "work/mab/brain-AR-0.sqlite";
const db = await import("../../db");
const rows = db.l3Count();
console.log("l3 rows:", rows);
const qs: string[] = [
  "In what country is Normandy located?",
  "When were the Normans in Normandy?",
  "From which countries did the Norse originate?",
  "Who was the Norse leader?",
];
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
for (const q of qs) {
  const bm = db.l3SearchBm25(q, 10);
  const texts = bm.map((r) => norm(r.raw_content).slice(0, 200));
  console.log("\nQ:", q, "| hits:", bm.length, "| top ids:", bm.map((r) => r.id).join(","));
  console.log("  joined1000 contains 'france':", norm(bm.slice(0, 10).map((r) => r.raw_content).join(" ")).includes("france"));
  console.log("  fts query:", db.ftsQuery(q));
  console.log("  top1 text:", texts[0]?.slice(0, 160));
}
