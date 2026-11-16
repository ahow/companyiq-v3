// ─── W8: Variance harness ────────────────────────────────────────────────────
// Make robustness measurable. Given K repeated scoring runs (batches) over the
// SAME company list + framework, compute, per measure and per company:
//   • flip rate (No↔Yes across runs) — the headline instability signal
//   • score stddev (per-company total-score spread across runs)
//   • corpus-size variance (per-company document-count spread across runs)
// Two modes are supported by the caller: FROZEN corpus (replay via W1 — isolates
// rubric/grader determinism) and LIVE discovery (real end-to-end variance). This
// module is pure aggregation over already-completed batches; orchestration lives
// in the API routes. Gated by VARIANCE_HARNESS.
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { normaliseVerdict, type Verdict } from "./variability-stability.js";

// Acceptability thresholds (env-overridable). A framework's variance is
// "acceptable" when its worst per-measure flip rate and mean per-company score
// stddev are at or below these. Defaults are deliberately strict for binary (0/1)
// scoring where runs SHOULD be near-identical on a frozen corpus.
export const VARIANCE_MAX_FLIP_RATE = Number(process.env.VARIANCE_MAX_FLIP_RATE ?? "0.05");
export const VARIANCE_MAX_SCORE_STDDEV = Number(process.env.VARIANCE_MAX_SCORE_STDDEV ?? "1.0");

export interface MeasureVariance {
  measureId: string;
  /** (company,measure) units observed for this measure. */
  units: number;
  /** units that flipped No↔Yes vs the baseline run at least once. */
  flippedYesNo: number;
  /** units that had any other verdict change vs baseline. */
  flippedOther: number;
  /** flippedYesNo / units (0..1). */
  flipRate: number;
}

export interface VarianceReport {
  mode: "frozen" | "live" | "mixed";
  batchIds: number[];
  runCount: number;
  companyCount: number;
  measureCount: number;
  /** worst per-measure No↔Yes flip rate (0..1). */
  maxFlipRate: number;
  /** mean per-measure No↔Yes flip rate (0..1). */
  meanFlipRate: number;
  /** mean across companies of their total-score stddev. */
  meanScoreStddev: number;
  /** worst (max) per-company total-score stddev. */
  maxScoreStddev: number;
  /** mean across companies of their corpus-size variance. */
  meanCorpusSizeVariance: number;
  perMeasure: MeasureVariance[];
  thresholds: { maxFlipRate: number; maxScoreStddev: number };
  /** true when within both thresholds. */
  acceptable: boolean;
  computedAt: string;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varc = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(varc);
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
}

/**
 * Aggregate a variance report from a set of completed batches (K runs of the
 * same list+framework). Pure read; never mutates. `mode` is supplied by the
 * caller (it knows whether these were frozen-corpus replays or live runs).
 */
export async function computeVarianceReport(opts: {
  batchIds: number[];
  mode: "frozen" | "live" | "mixed";
}): Promise<VarianceReport> {
  const batchIds = [...opts.batchIds].filter((b) => Number.isInteger(b)).sort((a, b) => a - b);
  const computedAt = new Date().toISOString();
  const empty: VarianceReport = {
    mode: opts.mode, batchIds, runCount: batchIds.length, companyCount: 0, measureCount: 0,
    maxFlipRate: 0, meanFlipRate: 0, meanScoreStddev: 0, maxScoreStddev: 0, meanCorpusSizeVariance: 0,
    perMeasure: [], thresholds: { maxFlipRate: VARIANCE_MAX_FLIP_RATE, maxScoreStddev: VARIANCE_MAX_SCORE_STDDEV },
    acceptable: true, computedAt,
  };
  if (batchIds.length < 2) return empty;

  // Per-batch per-company per-measure verdicts + scores.
  const scoreRows = (await db.execute(sql`
    SELECT batch_id, company_id, measure_id, verdict, score
    FROM measure_scores
    WHERE batch_id = ANY(${batchIds})
  `)).rows as Array<{ batch_id: number; company_id: number; measure_id: string; verdict: string; score: number }>;
  if (scoreRows.length === 0) return empty;

  // Per-batch per-company corpus sizes.
  const corpusRows = (await db.execute(sql`
    SELECT batch_id, company_id, COUNT(DISTINCT document_id) AS n
    FROM batch_corpus
    WHERE batch_id = ANY(${batchIds})
    GROUP BY batch_id, company_id
  `)).rows as Array<{ batch_id: number; company_id: number; n: number }>;

  const baselineBatch = batchIds[0];

  // unit key = company:measure -> { batch -> verdict }
  const unitVerdicts = new Map<string, Map<number, Verdict>>();
  const measureOf = new Map<string, string>();
  // company -> { batch -> total score }
  const companyScoreByBatch = new Map<number, Map<number, number>>();
  const companies = new Set<number>();
  const measures = new Set<string>();

  for (const r of scoreRows) {
    companies.add(Number(r.company_id));
    measures.add(String(r.measure_id));
    const ukey = `${r.company_id}:${r.measure_id}`;
    if (!unitVerdicts.has(ukey)) unitVerdicts.set(ukey, new Map());
    unitVerdicts.get(ukey)!.set(Number(r.batch_id), normaliseVerdict(r.verdict));
    measureOf.set(ukey, String(r.measure_id));
    if (!companyScoreByBatch.has(Number(r.company_id))) companyScoreByBatch.set(Number(r.company_id), new Map());
    const m = companyScoreByBatch.get(Number(r.company_id))!;
    m.set(Number(r.batch_id), (m.get(Number(r.batch_id)) ?? 0) + Number(r.score || 0));
  }

  // Per-measure flip accounting (vs baseline run).
  const perMeasureAcc = new Map<string, MeasureVariance>();
  const ensureM = (mid: string): MeasureVariance => {
    let mm = perMeasureAcc.get(mid);
    if (!mm) { mm = { measureId: mid, units: 0, flippedYesNo: 0, flippedOther: 0, flipRate: 0 }; perMeasureAcc.set(mid, mm); }
    return mm;
  };

  for (const [ukey, byBatch] of unitVerdicts) {
    const mid = measureOf.get(ukey)!;
    const base = byBatch.get(baselineBatch);
    const mm = ensureM(mid);
    mm.units++;
    if (base == null) continue;
    let yesNo = false, other = false;
    for (const bId of batchIds) {
      if (bId === baselineBatch) continue;
      const v = byBatch.get(bId);
      if (v == null || v === base) continue;
      if ((base === "Yes" && v === "No") || (base === "No" && v === "Yes")) yesNo = true;
      else other = true;
    }
    if (yesNo) mm.flippedYesNo++;
    else if (other) mm.flippedOther++;
  }
  const perMeasure = [...perMeasureAcc.values()].map((mm) => {
    mm.flipRate = mm.units > 0 ? mm.flippedYesNo / mm.units : 0;
    return mm;
  }).sort((a, b) => b.flipRate - a.flipRate);

  const maxFlipRate = perMeasure.reduce((mx, m) => Math.max(mx, m.flipRate), 0);
  const meanFlipRate = perMeasure.length ? perMeasure.reduce((s, m) => s + m.flipRate, 0) / perMeasure.length : 0;

  // Per-company total-score stddev across runs.
  const perCompanyStddev: number[] = [];
  for (const [, byBatch] of companyScoreByBatch) {
    const xs = batchIds.map((b) => byBatch.get(b)).filter((x): x is number => typeof x === "number");
    if (xs.length >= 2) perCompanyStddev.push(stddev(xs));
  }
  const meanScoreStddev = perCompanyStddev.length ? perCompanyStddev.reduce((a, b) => a + b, 0) / perCompanyStddev.length : 0;
  const maxScoreStddev = perCompanyStddev.reduce((mx, x) => Math.max(mx, x), 0);

  // Per-company corpus-size variance across runs.
  const corpusByCompany = new Map<number, Map<number, number>>();
  for (const r of corpusRows) {
    if (!corpusByCompany.has(Number(r.company_id))) corpusByCompany.set(Number(r.company_id), new Map());
    corpusByCompany.get(Number(r.company_id))!.set(Number(r.batch_id), Number(r.n));
  }
  const perCompanyCorpusVar: number[] = [];
  for (const [, byBatch] of corpusByCompany) {
    const xs = batchIds.map((b) => byBatch.get(b) ?? 0);
    if (xs.length >= 2) perCompanyCorpusVar.push(variance(xs));
  }
  const meanCorpusSizeVariance = perCompanyCorpusVar.length ? perCompanyCorpusVar.reduce((a, b) => a + b, 0) / perCompanyCorpusVar.length : 0;

  const acceptable = maxFlipRate <= VARIANCE_MAX_FLIP_RATE && meanScoreStddev <= VARIANCE_MAX_SCORE_STDDEV;

  return {
    mode: opts.mode, batchIds, runCount: batchIds.length,
    companyCount: companies.size, measureCount: measures.size,
    maxFlipRate, meanFlipRate, meanScoreStddev, maxScoreStddev, meanCorpusSizeVariance,
    perMeasure,
    thresholds: { maxFlipRate: VARIANCE_MAX_FLIP_RATE, maxScoreStddev: VARIANCE_MAX_SCORE_STDDEV },
    acceptable, computedAt,
  };
}
