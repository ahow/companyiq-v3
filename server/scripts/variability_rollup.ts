/**
 * variability_rollup.ts — Phase 1.1 cross-company baseline roll-up (OFFLINE).
 *
 * Reads the completed frozen-corpus 5×-replay dataset in var_out/ and produces,
 * for every company with a complete run set, the per-measure Yes→No / No→Yes
 * stability table (reusing the tested pure builder buildStabilityTable), PLUS a
 * cross-company per-measure roll-up that sums the transition split across all
 * companies. Spends NO LLM budget — pure aggregation over existing artefacts.
 *
 * Framework-level: companies and measures are DISCOVERED from the files; no
 * company- or topic-specific logic. Usage:
 *   tsx server/scripts/variability_rollup.ts [--dir var_out] [--out report.md]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildStabilityTable,
  formatStabilityTableMarkdown,
  normaliseVerdict,
  type RunRecord,
  type Verdict,
} from "../lib/variability-stability.js";

const HOME = process.env.HOME || "/home/ubuntu";

function parseArgs(argv: string[]): { dir: string; out: string | null } {
  let dir = process.env.VAR_OUT_DIR || `${HOME}/var_out`;
  let out: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--out") out = argv[++i];
  }
  return { dir, out };
}

function cellsFromResult(parsed: any): { measureId: string; verdict: Verdict }[] {
  const records: any[] = Array.isArray(parsed?.records) ? parsed.records : [];
  // Framework-level identity: prefer an explicit measureId, but fall back to the
  // stable measureName/title when the active framework's measure set carries no
  // measureId (e.g. the AI Governance framework export). Without this fallback
  // every record would be dropped for such frameworks, yielding 0 comparisons
  // and a false "0 flips". Titles are unique within a framework, so they are a
  // valid stable key for per-measure run-to-run comparison.
  return records
    .map((r) => ({
      key: r?.measureId ?? r?.measureName ?? r?.title ?? null,
      verdict: normaliseVerdict(r?.cascade?.verdict ?? r?.verdict),
    }))
    .filter((c) => c.key != null)
    .map((c) => ({ measureId: String(c.key), verdict: c.verdict }));
}

/** Discover { companyId, cascade } groups each having >=2 run files. */
function discoverGroups(dir: string): { companyId: string; v2: boolean; files: string[] }[] {
  const all = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("_variability"));
  const groups = new Map<string, string[]>();
  for (const f of all) {
    const m = f.match(/^(\d+)_run(\d+)(_v2)?(?:_lim\d+)?\.json$/);
    if (!m) continue;
    const key = `${m[1]}${m[3] ? "_v2" : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const out: { companyId: string; v2: boolean; files: string[] }[] = [];
  for (const [key, files] of groups) {
    if (files.length < 2) continue;
    const v2 = key.endsWith("_v2");
    const companyId = v2 ? key.slice(0, -3) : key;
    out.push({ companyId, v2, files: files.sort() });
  }
  return out.sort((a, b) => Number(a.companyId) - Number(b.companyId) || Number(a.v2) - Number(b.v2));
}

function runsFromFiles(dir: string, files: string[]): RunRecord[] {
  const runs: RunRecord[] = [];
  for (const f of files) {
    const m = f.match(/_run(\d+)/);
    if (!m) continue;
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    runs.push({ runIndex: parseInt(m[1], 10), cells: cellsFromResult(parsed) });
  }
  return runs;
}

function main(): void {
  const { dir, out } = parseArgs(process.argv);
  if (!existsSync(dir)) {
    console.error(`FATAL: dir not found: ${dir}`);
    process.exit(1);
  }
  const groups = discoverGroups(dir);
  const detail: string[] = [];
  const header: string[] = [];
  header.push("# Phase 1.1 — Frozen-corpus variability baseline");
  header.push("");
  header.push(
    `Dataset: \`${dir}\` — ${groups.length} company run-set(s), 5 replays each on identical frozen evidence. ` +
      `Transitions are counted per measure against the baseline run (lowest run index). ` +
      `Offline aggregation (no LLM spend) via the tested \`buildStabilityTable\`.`,
  );
  header.push("");

  const roll = new Map<string, { yesToNo: number; noToYes: number; otherFlips: number; comparisons: number; companiesUnstable: number }>();
  const ensure = (id: string) => {
    let r = roll.get(id);
    if (!r) { r = { yesToNo: 0, noToYes: 0, otherFlips: 0, comparisons: 0, companiesUnstable: 0 }; roll.set(id, r); }
    return r;
  };

  let grandY2N = 0, grandN2Y = 0, grandOther = 0;
  const perCompanySummary: string[] = [];
  perCompanySummary.push("| Company | Cascade | Runs | Yes→No | No→Yes | Other | Total flips | Stable measures |");
  perCompanySummary.push("|---|---|---|---|---|---|---|---|");

  for (const g of groups) {
    const runs = runsFromFiles(dir, g.files);
    const table = buildStabilityTable(runs);
    const t = table.totals;
    grandY2N += t.yesToNo; grandN2Y += t.noToYes; grandOther += t.otherFlips;
    perCompanySummary.push(
      `| ${g.companyId} | ${g.v2 ? "v2" : "legacy"} | ${table.runCount} | ${t.yesToNo} | ${t.noToYes} | ${t.otherFlips} | ${t.totalFlips} | ${t.measuresStable}/${table.measures.length} |`,
    );
    for (const m of table.measures) {
      const r = ensure(m.measureId);
      r.yesToNo += m.yesToNo; r.noToYes += m.noToYes; r.otherFlips += m.otherFlips;
      r.comparisons += m.comparisons;
      if (m.totalFlips > 0) r.companiesUnstable++;
    }
    detail.push(`## Company ${g.companyId} (${g.v2 ? "v2" : "legacy"} cascade)`);
    detail.push("");
    detail.push(formatStabilityTableMarkdown(table));
    detail.push("");
  }

  const summary: string[] = [];
  summary.push("## Cross-company summary");
  summary.push("");
  summary.push(...perCompanySummary);
  summary.push("");
  summary.push(
    `**Grand total across all ${groups.length} run-sets — Yes→No: ${grandY2N}, No→Yes: ${grandN2Y}, Other: ${grandOther}, Total flips: ${grandY2N + grandN2Y + grandOther}.**`,
  );
  summary.push("");
  summary.push("## Per-measure roll-up across all companies");
  summary.push("");
  summary.push("| Measure | Companies unstable | Yes→No | No→Yes | Other | Total flips |");
  summary.push("|---|---|---|---|---|---|");
  const measureIds = [...roll.keys()];
  measureIds.sort((a, b) => {
    const ra = roll.get(a)!, rb = roll.get(b)!;
    const fa = ra.yesToNo + ra.noToYes + ra.otherFlips, fb = rb.yesToNo + rb.noToYes + rb.otherFlips;
    return fb - fa || a.localeCompare(b);
  });
  for (const id of measureIds) {
    const r = roll.get(id)!;
    const flips = r.yesToNo + r.noToYes + r.otherFlips;
    summary.push(`| ${id} | ${r.companiesUnstable} | ${r.yesToNo} | ${r.noToYes} | ${r.otherFlips} | ${flips} |`);
  }
  summary.push(`| **TOTAL** | | **${grandY2N}** | **${grandN2Y}** | **${grandOther}** | **${grandY2N + grandN2Y + grandOther}** |`);
  summary.push("");

  const full = [...header, ...summary, "## Per-company detail", "", ...detail].join("\n");
  console.log(full);
  if (out) {
    writeFileSync(out, full + "\n");
    console.error(`\nSAVED ${out}`);
  }
}

main();
