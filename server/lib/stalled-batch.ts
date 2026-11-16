// ─── W7: Stalled-batch detection & auto-requeue ──────────────────────────────
// A batch where companies complete with ZERO documents retrieved (e.g. result
// 864: 573 companies, avg 0, zero docs each) is a stall — a transient
// infrastructure/discovery failure — not a legitimate "these companies disclose
// nothing" result. Persisting those zeros pollutes saved results and skews
// averages. This module detects that signature so the batch-completion path can
// auto-requeue the zero-retrieval companies instead of saving false zeros.
//
// Gated by STALLED_BATCH_REQUEUE (default true). Tunable via env:
//   STALLED_BATCH_MIN_COMPANIES   (default 3)  — never act on tiny batches
//   STALLED_BATCH_MIN_FRACTION    (default 1.0) — fraction of completed companies
//                                                 that must have zero retrieval
//                                                 for the batch to count as stalled
//                                                 (1.0 = the WHOLE batch retrieved
//                                                 nothing — the clearest stall).
import { db } from "../db.js";
import { sql } from "drizzle-orm";

export const STALLED_BATCH_MIN_COMPANIES = Number(process.env.STALLED_BATCH_MIN_COMPANIES ?? "3");
export const STALLED_BATCH_MIN_FRACTION = Number(process.env.STALLED_BATCH_MIN_FRACTION ?? "1.0");

export interface StalledBatchReport {
  stalled: boolean;
  completedCompanies: number;
  zeroRetrievalCompanies: Array<{ companyId: number; companyName: string }>;
  zeroRetrievalFraction: number;
  reason: string;
}

/**
 * Inspect a just-completed batch and decide whether it is a zero-retrieval
 * stall. A company counts as "zero retrieval" when it has NO successfully
 * fetched, non-rejected documents at all — i.e. the research coverage
 * denominator is 0 (nothing to score against), which the scorer records as
 * researchStatus=unresolved_gaps with an all-abstain / forced-zero outcome.
 *
 * Pure read: never mutates. Returns the list of zero-retrieval companies so the
 * caller can requeue them.
 */
export async function detectStalledBatch(opts: {
  batchId: number;
}): Promise<StalledBatchReport> {
  const { batchId } = opts;

  // Completed companies in this batch, each annotated with its count of
  // successfully-fetched, non-rejected documents (the usable corpus).
  const rows = (await db.execute(sql`
    SELECT
      j.company_id   AS company_id,
      j.company_name AS company_name,
      COALESCE(d.ok_docs, 0) AS ok_docs
    FROM analysis_jobs j
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS ok_docs
      FROM documents
      WHERE fetch_status = 'ok'
        AND (gate_verdict IS NULL OR gate_verdict <> 'reject')
      GROUP BY company_id
    ) d ON d.company_id = j.company_id
    WHERE j.batch_id = ${batchId}
      AND j.status = 'completed'
  `)).rows as Array<{ company_id: number; company_name: string; ok_docs: number }>;

  const completedCompanies = rows.length;
  const zeroRetrievalCompanies = rows
    .filter((r) => Number(r.ok_docs) === 0)
    .map((r) => ({ companyId: Number(r.company_id), companyName: String(r.company_name) }));
  const zeroRetrievalFraction = completedCompanies > 0
    ? zeroRetrievalCompanies.length / completedCompanies
    : 0;

  let stalled = false;
  let reason = "";
  if (completedCompanies < STALLED_BATCH_MIN_COMPANIES) {
    reason = `batch too small (${completedCompanies} < ${STALLED_BATCH_MIN_COMPANIES}) — not treated as a stall`;
  } else if (zeroRetrievalFraction < STALLED_BATCH_MIN_FRACTION) {
    reason = `zero-retrieval fraction ${(zeroRetrievalFraction * 100).toFixed(0)}% below threshold ${(STALLED_BATCH_MIN_FRACTION * 100).toFixed(0)}% — treated as a real result, not a stall`;
  } else {
    stalled = true;
    reason = `${zeroRetrievalCompanies.length}/${completedCompanies} companies retrieved zero documents — stalled batch, requeueing instead of saving zeros`;
  }

  return { stalled, completedCompanies, zeroRetrievalCompanies, zeroRetrievalFraction, reason };
}
