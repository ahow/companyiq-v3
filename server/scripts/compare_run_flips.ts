/**
 * compare_run_flips.ts — cell-level verdict-flip comparison between two batches.
 *
 * WHY THIS EXISTS
 * ---------------
 * Summary tables that report only the NUMBER of Yes verdicts per run hide
 * offsetting cell changes. If 9 cells flip No->Yes and 7 flip Yes->No, the net
 * is +2 Yes but SIXTEEN cells actually changed. Net Yes alone therefore both
 * understates churn and can mask a regression (a measure that broke) behind an
 * unrelated improvement elsewhere. This script computes the directional flip
 * breakdown (Y->N, N->Y, Total Flips) per company and in aggregate over the
 * shared company x measure cell set.
 *
 * DATA SOURCE
 * -----------
 * Per-batch verdicts are read from the immutable `analysis_results` snapshots
 * (results_data jsonb) — the same authoritative per-batch source used by
 * server/scripts/full_verdict_diff.py. The live `measure_scores` table only
 * retains the most-recent run's rows, so historical batches must come from the
 * snapshot. Reads are strictly read-only.
 *
 * USAGE
 * -----
 *   DATABASE_URL=postgresql://... \
 *     node --import tsx server/scripts/compare_run_flips.ts <baselineBatchId> <variantBatchId> [outPrefix]
 *
 * Example (A2 vs baseline):
 *   node --import tsx server/scripts/compare_run_flips.ts 1284 1286 /home/ubuntu/a2_vs_baseline
 *
 * OUTPUT
 * ------
 *   <outPrefix>.json  — machine-readable per-company + aggregate figures
 *   <outPrefix>.md    — Markdown table (per-company rows + aggregate row)
 * Both are deterministic: companies are sorted by numeric company id.
 *
 * INTERNAL CONSISTENCY CHECK
 * --------------------------
 * For every company and for the aggregate, the script asserts
 *   Net == N->Y - Y->N   (equivalently Yes(variant) - Yes(baseline)).
 * It also asserts the two runs cover the IDENTICAL cell set and fails loudly,
 * listing any cell present in only one run, rather than silently dropping it.
 */

import pg from "pg";
import { writeFileSync } from "fs";

const { Pool } = pg;

type Verdict = string;
// cellKey = `${companyId}|${measureId}`
type CellMap = Map<string, Verdict>;

interface BatchData {
  batchId: number;
  analysisResultId: number;
  companyNames: Map<number, string>;
  cells: CellMap; // cellKey -> verdict
  cellCompany: Map<string, number>; // cellKey -> companyId (for grouping)
}

function cellKey(companyId: number, measureId: string): string {
  return `${companyId}|${measureId}`;
}

function isYes(v: Verdict): boolean {
  // Verdict domain is Yes | No | Partial | Insufficient evidence | Scoring error.
  // The flip model is binary on the Yes axis: anything that is not exactly "Yes"
  // is treated as not-Yes (i.e. "No" for flip-counting purposes).
  return (v || "").trim().toLowerCase() === "yes";
}

async function loadBatch(pool: pg.Pool, batchId: number): Promise<BatchData> {
  // Prefer the immutable snapshot. If multiple snapshots exist for a batch, use
  // the most recent (highest id) — matches the dashboard's "latest accepted".
  const res = await pool.query(
    `SELECT id, results_data
       FROM analysis_results
      WHERE batch_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [batchId],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `No analysis_results snapshot found for batch_id=${batchId}. ` +
        `Batch rows are NOT fully retrievable — aborting rather than guessing.`,
    );
  }
  const row = res.rows[0];
  const raw = row.results_data;
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(data)) {
    throw new Error(
      `analysis_results.results_data for batch ${batchId} is not an array of companies (got ${typeof data}).`,
    );
  }

  const cells: CellMap = new Map();
  const cellCompany = new Map<string, number>();
  const companyNames = new Map<number, string>();

  for (const co of data) {
    const companyId: number = co.companyId;
    if (typeof companyId !== "number") {
      throw new Error(`Batch ${batchId}: company entry missing numeric companyId.`);
    }
    companyNames.set(companyId, co.companyName ?? co.name ?? String(companyId));
    const measures = co.measureScores ?? co.measures ?? [];
    if (!Array.isArray(measures)) {
      throw new Error(`Batch ${batchId}: company ${companyId} has no measureScores array.`);
    }
    for (const m of measures) {
      const measureId: string = m.measureId;
      if (!measureId) {
        throw new Error(`Batch ${batchId}: company ${companyId} has a measure with no measureId.`);
      }
      const k = cellKey(companyId, measureId);
      if (cells.has(k)) {
        throw new Error(`Batch ${batchId}: duplicate cell ${k} in snapshot.`);
      }
      cells.set(k, m.verdict);
      cellCompany.set(k, companyId);
    }
  }

  return { batchId, analysisResultId: row.id, companyNames, cells, cellCompany };
}

interface CompanyFlip {
  companyId: number;
  companyName: string;
  cells: number;
  yesBaseline: number;
  yesVariant: number;
  net: number; // yesVariant - yesBaseline
  yToN: number; // Yes in baseline, No in variant
  nToY: number; // No in baseline, Yes in variant
  totalFlips: number; // yToN + nToY
  flipCells: { cell: string; from: Verdict; to: Verdict; dir: "Y->N" | "N->Y" }[];
}

interface Report {
  baselineBatchId: number;
  variantBatchId: number;
  baselineAnalysisResultId: number;
  variantAnalysisResultId: number;
  generatedAt: string;
  cellCount: number;
  companyCount: number;
  measureCount: number;
  perCompany: CompanyFlip[];
  aggregate: Omit<CompanyFlip, "companyId" | "companyName" | "flipCells"> & {
    flipCells: CompanyFlip["flipCells"];
  };
  consistencyOk: boolean;
}

function compare(baseline: BatchData, variant: BatchData): Report {
  // ── Assert identical cell set; flag (do not drop) any asymmetric cells. ──
  const onlyInBaseline: string[] = [];
  const onlyInVariant: string[] = [];
  for (const k of baseline.cells.keys()) if (!variant.cells.has(k)) onlyInBaseline.push(k);
  for (const k of variant.cells.keys()) if (!baseline.cells.has(k)) onlyInVariant.push(k);
  if (onlyInBaseline.length || onlyInVariant.length) {
    throw new Error(
      `Cell-set mismatch between batch ${baseline.batchId} and ${variant.batchId}.\n` +
        `  Only in baseline (${onlyInBaseline.length}): ${onlyInBaseline.slice(0, 20).join(", ")}\n` +
        `  Only in variant  (${onlyInVariant.length}): ${onlyInVariant.slice(0, 20).join(", ")}\n` +
        `Refusing to compute flips over a non-identical cell set.`,
    );
  }

  const companyIds = Array.from(new Set(Array.from(baseline.cellCompany.values()))).sort(
    (a, b) => a - b,
  );
  const companies = new Map<number, CompanyFlip>();
  for (const cid of companyIds) {
    companies.set(cid, {
      companyId: cid,
      companyName: variant.companyNames.get(cid) ?? baseline.companyNames.get(cid) ?? String(cid),
      cells: 0,
      yesBaseline: 0,
      yesVariant: 0,
      net: 0,
      yToN: 0,
      nToY: 0,
      totalFlips: 0,
      flipCells: [],
    });
  }

  const measureSet = new Set<string>();
  const aggFlipCells: CompanyFlip["flipCells"] = [];

  // Deterministic iteration: sort cell keys by (companyId, measureId).
  const keys = Array.from(baseline.cells.keys()).sort((a, b) => {
    const [ca, ma] = a.split("|");
    const [cb, mb] = b.split("|");
    const ci = Number(ca) - Number(cb);
    return ci !== 0 ? ci : ma.localeCompare(mb);
  });

  for (const k of keys) {
    const cid = baseline.cellCompany.get(k)!;
    const measureId = k.split("|").slice(1).join("|");
    measureSet.add(measureId);
    const c = companies.get(cid)!;
    const vb = baseline.cells.get(k)!;
    const vv = variant.cells.get(k)!;
    const yb = isYes(vb);
    const yv = isYes(vv);
    c.cells += 1;
    if (yb) c.yesBaseline += 1;
    if (yv) c.yesVariant += 1;
    if (yb && !yv) {
      c.yToN += 1;
      const fc = { cell: k, from: vb, to: vv, dir: "Y->N" as const };
      c.flipCells.push(fc);
      aggFlipCells.push(fc);
    } else if (!yb && yv) {
      c.nToY += 1;
      const fc = { cell: k, from: vb, to: vv, dir: "N->Y" as const };
      c.flipCells.push(fc);
      aggFlipCells.push(fc);
    }
  }

  const perCompany: CompanyFlip[] = [];
  let consistencyOk = true;
  const agg = { cells: 0, yesBaseline: 0, yesVariant: 0, net: 0, yToN: 0, nToY: 0, totalFlips: 0 };
  for (const cid of companyIds) {
    const c = companies.get(cid)!;
    c.net = c.yesVariant - c.yesBaseline;
    c.totalFlips = c.yToN + c.nToY;
    // Internal consistency: Net MUST equal N->Y - Y->N.
    if (c.net !== c.nToY - c.yToN) {
      consistencyOk = false;
      console.error(
        `CONSISTENCY FAILURE company ${cid}: net=${c.net} but N->Y - Y->N = ${c.nToY - c.yToN}`,
      );
    }
    perCompany.push(c);
    agg.cells += c.cells;
    agg.yesBaseline += c.yesBaseline;
    agg.yesVariant += c.yesVariant;
    agg.yToN += c.yToN;
    agg.nToY += c.nToY;
  }
  agg.net = agg.yesVariant - agg.yesBaseline;
  agg.totalFlips = agg.yToN + agg.nToY;
  if (agg.net !== agg.nToY - agg.yToN) {
    consistencyOk = false;
    console.error(
      `CONSISTENCY FAILURE aggregate: net=${agg.net} but N->Y - Y->N = ${agg.nToY - agg.yToN}`,
    );
  }

  return {
    baselineBatchId: baseline.batchId,
    variantBatchId: variant.batchId,
    baselineAnalysisResultId: baseline.analysisResultId,
    variantAnalysisResultId: variant.analysisResultId,
    generatedAt: new Date().toISOString(),
    cellCount: agg.cells,
    companyCount: companyIds.length,
    measureCount: measureSet.size,
    perCompany,
    aggregate: { ...agg, flipCells: aggFlipCells },
    consistencyOk,
  };
}

function toMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(
    `### Cell-flip comparison — variant batch ${r.variantBatchId} vs baseline batch ${r.baselineBatchId}`,
  );
  lines.push("");
  lines.push(
    `Cell set: ${r.companyCount} companies × ${r.measureCount} measures = ${r.cellCount} cells. ` +
      `Source: \`analysis_results\` snapshots (baseline id ${r.baselineAnalysisResultId}, variant id ${r.variantAnalysisResultId}).`,
  );
  lines.push("");
  lines.push(
    "| Company ID | Company | Yes (baseline) | Yes (variant) | Net | Y→N | N→Y | Total Flips |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const c of r.perCompany) {
    lines.push(
      `| ${c.companyId} | ${c.companyName} | ${c.yesBaseline} | ${c.yesVariant} | ${c.net >= 0 ? "+" + c.net : c.net} | ${c.yToN} | ${c.nToY} | ${c.totalFlips} |`,
    );
  }
  const a = r.aggregate;
  lines.push(
    `| **ALL** | **Aggregate (${r.companyCount} companies)** | **${a.yesBaseline}** | **${a.yesVariant}** | **${a.net >= 0 ? "+" + a.net : a.net}** | **${a.yToN}** | **${a.nToY}** | **${a.totalFlips}** |`,
  );
  lines.push("");
  lines.push(
    `Consistency check (Net == N→Y − Y→N): ${r.consistencyOk ? "PASS" : "FAIL"}.`,
  );
  return lines.join("\n") + "\n";
}

async function main() {
  const baselineBatchId = parseInt(process.argv[2] || "", 10);
  const variantBatchId = parseInt(process.argv[3] || "", 10);
  const outPrefix = process.argv[4] || `/home/ubuntu/flips_${baselineBatchId}_vs_${variantBatchId}`;

  if (!Number.isInteger(baselineBatchId) || !Number.isInteger(variantBatchId)) {
    console.error(
      "usage: compare_run_flips.ts <baselineBatchId> <variantBatchId> [outPrefix]",
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL is required (read-only access to the batch snapshots).");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
  });

  try {
    const baseline = await loadBatch(pool, baselineBatchId);
    const variant = await loadBatch(pool, variantBatchId);
    const report = compare(baseline, variant);

    const jsonPath = `${outPrefix}.json`;
    const mdPath = `${outPrefix}.md`;
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(mdPath, toMarkdown(report));

    console.log(toMarkdown(report));
    console.log(`JSON written to ${jsonPath}`);
    console.log(`Markdown written to ${mdPath}`);
    const a = report.aggregate;
    console.log(
      `\nAGGREGATE: Yes(baseline ${report.baselineBatchId})=${a.yesBaseline}  Yes(variant ${report.variantBatchId})=${a.yesVariant}  ` +
        `Net=${a.net}  Y->N=${a.yToN}  N->Y=${a.nToY}  TotalFlips=${a.totalFlips}`,
    );
    if (!report.consistencyOk) {
      console.error("\nINTERNAL CONSISTENCY CHECK FAILED — see messages above.");
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("compare_run_flips failed:", err);
  process.exit(1);
});
