/**
 * build_gate3_labels.ts — offline GATE3 label set from persisted batch evidence.
 *
 * WHY THIS EXISTS
 * ---------------
 * The A3 / WP04 redesign makes the eligibility guardrail operate over the WHOLE
 * supporting-quote set of a cell (not a single-quote sample), with quote
 * correction as the primary remedy and verdict change only as a last resort.
 * Before enforcement is ever enabled, we need a label set that answers — for
 * every POSITIVE cell in a known batch — what A3 would do:
 *
 *   STAY           cited (first) quote is already eligible → no action
 *   QUOTE_CORRECT  some supporting quote is eligible but it is NOT the cited one
 *                  → promote it to first; verdict & score unchanged (primary remedy)
 *   VERDICT_CHANGE every supporting quote is hard-excluded → would downgrade to No
 *                  (last resort, the only verdict-mutating path)
 *   REVIEW         no quote is eligible but at least one is unknown-provenance
 *                  → flag for human review; verdict unchanged
 *
 * This is produced OFFLINE from the immutable `analysis_results` snapshot and
 * runs the SAME pure composer the analyzer uses (composeCellEligibility), so
 * the labels equal what the live A3 block would decide for the same evidence.
 *
 * DATA SOURCE
 * -----------
 * Per-batch verdicts AND supporting quotes are read from the immutable
 * `analysis_results` snapshot (results_data jsonb) — the authoritative per-batch
 * source (same as compare_run_flips.ts / full_verdict_diff.py). The live
 * `measure_scores` table only retains the most-recent run. Target identity
 * fields that the snapshot does not carry (domain, ticker, related domains) are
 * joined READ-ONLY from the `companies` table so the composer sees the exact
 * same target the analyzer builds. All reads are strictly read-only.
 *
 * USAGE
 * -----
 *   DATABASE_URL=postgresql://... \
 *     node --import tsx server/scripts/build_gate3_labels.ts [batchId] [companyIdsCsv] [outPrefix]
 *
 * Defaults: batchId=1284, companyIds=9..18, outPrefix=/home/ubuntu/gate3_labels
 *
 * OUTPUT
 * ------
 *   <outPrefix>.json  — machine-readable: every POSITIVE cell + its label +
 *                       per-source decisions, plus aggregate & per-company counts
 *   <outPrefix>.md    — Markdown summary (bucket counts + per-company table)
 * Deterministic: companies sorted by numeric id, measures by measureId.
 */

import pg from "pg";
import { writeFileSync } from "fs";
import {
  composeCellEligibility,
  type EligibilitySource,
  type EligibilityTarget,
} from "../lib/eligibility-decision.js";
import { isPositiveVerdict } from "../lib/eligibility-flags.js";

const { Pool } = pg;

type Label = "STAY" | "QUOTE_CORRECT" | "VERDICT_CHANGE" | "REVIEW";

interface SnapshotQuote {
  text?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  page?: number | null;
}

interface TargetRow {
  id: number;
  name: string;
  ticker: string | null;
  domain: string | null;
  relatedDomains: string[] | null;
  isin: string | null;
}

interface CellLabel {
  companyId: number;
  companyName: string;
  measureId: string;
  verdict: string;
  quoteCount: number;
  cellStatus: string;
  anyEligible: boolean;
  allExcluded: boolean;
  representativeIndex: number;
  label: Label;
  representative: {
    entityRelation: string;
    sourceClass: string;
    status: string;
    reason: string | null;
  } | null;
  decisions: {
    index: number;
    status: string;
    entityRelation: string;
    sourceClass: string;
    url: string | null;
  }[];
}

interface CompanyBucket {
  companyId: number;
  companyName: string;
  positiveCells: number;
  stay: number;
  quoteCorrect: number;
  verdictChange: number;
  review: number;
}

interface Report {
  batchId: number;
  analysisResultId: number;
  generatedAt: string;
  companyIds: number[];
  policy: string; // ELIGIBILITY_POLICY resolution note
  totals: {
    positiveCells: number;
    stay: number;
    quoteCorrect: number;
    verdictChange: number;
    review: number;
  };
  perCompany: CompanyBucket[];
  cells: CellLabel[];
}

/**
 * Classify a POSITIVE cell exactly as the A3 enforce block would act on it.
 * Mirrors analyzer.ts: anyEligible → quote-correction (STAY if already first,
 * else QUOTE_CORRECT); allExcluded → VERDICT_CHANGE (downgrade); else REVIEW.
 */
function classify(cell: {
  anyEligible: boolean;
  allExcluded: boolean;
  representativeIndex: number;
}): Label {
  if (cell.anyEligible) {
    return cell.representativeIndex === 0 ? "STAY" : "QUOTE_CORRECT";
  }
  if (cell.allExcluded) return "VERDICT_CHANGE";
  return "REVIEW";
}

async function loadSnapshot(
  pool: pg.Pool,
  batchId: number,
): Promise<{ analysisResultId: number; companies: any[] }> {
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
      `analysis_results.results_data for batch ${batchId} is not an array (got ${typeof data}).`,
    );
  }
  return { analysisResultId: row.id, companies: data };
}

/** Read-only join of the target identity fields the snapshot does not carry. */
async function loadTargets(
  pool: pg.Pool,
  companyIds: number[],
): Promise<Map<number, TargetRow>> {
  const res = await pool.query(
    `SELECT id, name, ticker, domain, related_domains AS "relatedDomains", isin
       FROM companies
      WHERE id = ANY($1::int[])`,
    [companyIds],
  );
  const map = new Map<number, TargetRow>();
  for (const r of res.rows as any[]) {
    map.set(r.id, {
      id: r.id,
      name: r.name,
      ticker: r.ticker ?? null,
      domain: r.domain ?? null,
      relatedDomains: Array.isArray(r.relatedDomains) ? r.relatedDomains : null,
      isin: r.isin ?? null,
    });
  }
  return map;
}

function buildReport(
  batchId: number,
  analysisResultId: number,
  companies: any[],
  companyIds: number[],
  targets: Map<number, TargetRow>,
): Report {
  const wanted = new Set(companyIds);
  const cells: CellLabel[] = [];
  const perCompany = new Map<number, CompanyBucket>();

  // Deterministic order: companies by numeric id.
  const sortedCompanies = companies
    .filter((co) => wanted.has(Number(co.companyId)))
    .sort((a, b) => Number(a.companyId) - Number(b.companyId));

  for (const co of sortedCompanies) {
    const companyId = Number(co.companyId);
    const companyName: string = co.companyName ?? co.name ?? String(companyId);
    const t = targets.get(companyId);
    // Target mirrors analyzer's A3 block. isin: prefer the live companies row,
    // fall back to the snapshot's company-level isin.
    const target: EligibilityTarget = {
      id: companyId,
      name: t?.name || companyName,
      ticker: t?.ticker ?? null,
      domain: t?.domain ?? null,
      relatedDomains: t?.relatedDomains ?? null,
      isin: t?.isin ?? co.isin ?? null,
    };

    const bucket: CompanyBucket = {
      companyId,
      companyName,
      positiveCells: 0,
      stay: 0,
      quoteCorrect: 0,
      verdictChange: 0,
      review: 0,
    };
    perCompany.set(companyId, bucket);

    const measures = co.measureScores ?? co.measures ?? [];
    if (!Array.isArray(measures)) continue;

    const sortedMeasures = [...measures].sort((a, b) =>
      String(a.measureId).localeCompare(String(b.measureId)),
    );

    for (const m of sortedMeasures) {
      const verdict: string = m.verdict ?? "";
      if (!isPositiveVerdict(verdict)) continue; // A3 only acts on positive cells

      // Exclude non-scoring diagnostic sidecar quotes (sourceUrl scheme
      // `diag://`, e.g. diag://retrieval-v1, diag://evidence-gate-v1). These are
      // telemetry blobs persisted alongside the real evidence (pipeline.ts) and
      // are NOT part of the verdict's supporting-quote set — the live analyzer A3
      // block filters them identically, so the label basis matches live behaviour.
      const quotes: SnapshotQuote[] = (Array.isArray(m.quotes) ? m.quotes : []).filter(
        (q: SnapshotQuote) => !String(q?.sourceUrl ?? "").startsWith("diag://"),
      );
      const sources: EligibilitySource[] = quotes.map((q) => ({
        url: q?.sourceUrl ?? null,
        title: q?.source ?? null,
        content: q?.text ?? null,
      }));

      const cell = composeCellEligibility({ target, sources });
      const label = classify(cell);

      bucket.positiveCells += 1;
      if (label === "STAY") bucket.stay += 1;
      else if (label === "QUOTE_CORRECT") bucket.quoteCorrect += 1;
      else if (label === "VERDICT_CHANGE") bucket.verdictChange += 1;
      else bucket.review += 1;

      const rep = cell.representative;
      cells.push({
        companyId,
        companyName,
        measureId: String(m.measureId),
        verdict,
        quoteCount: cell.sourceCount,
        cellStatus: cell.status,
        anyEligible: cell.anyEligible,
        allExcluded: cell.allExcluded,
        representativeIndex: cell.representativeIndex,
        label,
        representative: rep
          ? {
              entityRelation: rep.entityRelation,
              sourceClass: rep.sourceClass,
              status: rep.status,
              reason: rep.reasons.length ? rep.reasons[rep.reasons.length - 1] : null,
            }
          : null,
        decisions: cell.decisions.map((d, i) => ({
          index: i,
          status: d.status,
          entityRelation: d.entityRelation,
          sourceClass: d.sourceClass,
          url: sources[i]?.url ?? null,
        })),
      });
    }
  }

  const totals = { positiveCells: 0, stay: 0, quoteCorrect: 0, verdictChange: 0, review: 0 };
  const perCompanyArr: CompanyBucket[] = [];
  for (const cid of companyIds) {
    const b = perCompany.get(cid);
    if (!b) continue;
    perCompanyArr.push(b);
    totals.positiveCells += b.positiveCells;
    totals.stay += b.stay;
    totals.quoteCorrect += b.quoteCorrect;
    totals.verdictChange += b.verdictChange;
    totals.review += b.review;
  }

  return {
    batchId,
    analysisResultId,
    generatedAt: new Date().toISOString(),
    companyIds,
    policy: `ELIGIBILITY_POLICY=${process.env.ELIGIBILITY_POLICY || "(default v2)"}`,
    totals,
    perCompany: perCompanyArr,
    cells,
  };
}

function pct(n: number, d: number): string {
  if (d <= 0) return "0.0%";
  return ((n / d) * 100).toFixed(1) + "%";
}

function toMarkdown(r: Report): string {
  const t = r.totals;
  const lines: string[] = [];
  lines.push(`### GATE3 label set — batch ${r.batchId}`);
  lines.push("");
  lines.push(
    `Source: \`analysis_results\` snapshot id ${r.analysisResultId}. ` +
      `Companies: ${r.companyIds.join(", ")}. ${r.policy}. ` +
      `Composer: \`composeCellEligibility\` (full supporting-quote set). Generated ${r.generatedAt}.`,
  );
  lines.push("");
  lines.push(
    `Labels classify what A3 would do with each POSITIVE cell: **STAY** (cited quote already eligible), ` +
      `**QUOTE_CORRECT** (an eligible quote exists but is not cited first — promote it; verdict unchanged), ` +
      `**VERDICT_CHANGE** (all quotes ineligible — downgrade to No; last resort), ` +
      `**REVIEW** (none eligible but some unknown-provenance — flag, verdict unchanged).`,
  );
  lines.push("");
  lines.push("| Bucket | Cells | Share of positive cells |");
  lines.push("|---|---|---|");
  lines.push(`| STAY | ${t.stay} | ${pct(t.stay, t.positiveCells)} |`);
  lines.push(`| QUOTE_CORRECT | ${t.quoteCorrect} | ${pct(t.quoteCorrect, t.positiveCells)} |`);
  lines.push(`| VERDICT_CHANGE | ${t.verdictChange} | ${pct(t.verdictChange, t.positiveCells)} |`);
  lines.push(`| REVIEW | ${t.review} | ${pct(t.review, t.positiveCells)} |`);
  lines.push(`| **Total positive cells** | **${t.positiveCells}** | **100%** |`);
  lines.push("");
  lines.push("#### Per-company breakdown");
  lines.push("");
  lines.push("| Company ID | Company | Positive cells | STAY | QUOTE_CORRECT | VERDICT_CHANGE | REVIEW |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const c of r.perCompany) {
    lines.push(
      `| ${c.companyId} | ${c.companyName} | ${c.positiveCells} | ${c.stay} | ${c.quoteCorrect} | ${c.verdictChange} | ${c.review} |`,
    );
  }
  lines.push(
    `| **ALL** | **Aggregate** | **${t.positiveCells}** | **${t.stay}** | **${t.quoteCorrect}** | **${t.verdictChange}** | **${t.review}** |`,
  );
  lines.push("");
  lines.push(
    `Note: QUOTE_CORRECT and VERDICT_CHANGE are the actionable buckets. A3 eligibility ` +
      `enforcement is DEFAULT-ON (unset/empty ELIGIBILITY_ENFORCE enforces; an explicit ` +
      `ELIGIBILITY_ENFORCE=off is the kill switch that restores shadow mode). This label ` +
      `set is a standalone forecast of the A3 actions, independent of the live batch env.`,
  );
  return lines.join("\n") + "\n";
}

function parseCompanyIds(csv: string | undefined): number[] {
  if (!csv || !csv.trim()) {
    // Default roster: companies 9..18 (the FW18 ten-company validation set).
    return Array.from({ length: 10 }, (_, i) => 9 + i);
  }
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

async function main() {
  const batchId = parseInt(process.argv[2] || "1284", 10);
  const companyIds = parseCompanyIds(process.argv[3]);
  const outPrefix = process.argv[4] || "/home/ubuntu/gate3_labels";

  if (!Number.isInteger(batchId)) {
    console.error("usage: build_gate3_labels.ts [batchId] [companyIdsCsv] [outPrefix]");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL is required (read-only access to the batch snapshot).");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
  });

  try {
    const { analysisResultId, companies } = await loadSnapshot(pool, batchId);
    const targets = await loadTargets(pool, companyIds);
    const report = buildReport(batchId, analysisResultId, companies, companyIds, targets);

    const jsonPath = `${outPrefix}.json`;
    const mdPath = `${outPrefix}.md`;
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(mdPath, toMarkdown(report));

    console.log(toMarkdown(report));
    console.log(`JSON written to ${jsonPath}`);
    console.log(`Markdown written to ${mdPath}`);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("build_gate3_labels failed:", err);
  process.exit(1);
});
