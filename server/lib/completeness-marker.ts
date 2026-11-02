/**
 * Completeness marking + selection (2026-11).
 *
 * After a batch finishes, companies fall into three buckets:
 *   - succeeded cleanly (complete)            → nothing to do
 *   - FAILED (job exhausted all attempts)     → should be re-run
 *   - INCOMPLETE (scored, but under-scored because document discovery/fetch was
 *     truncated — the 3M 1/37 case)           → should be re-run
 *
 * This module persists a NON-DESTRUCTIVE marker (`completenessFlag`) into each
 * company's `discovery_diagnostics` JSON for the failed + incomplete buckets, so
 * the user can re-run exactly those companies on demand without losing any
 * existing scores, quotes, or documents. The SAME deficit-signal logic is reused
 * by `server/scripts/requeue-completeness.ts`, so the automatic marker and the
 * ad-hoc selector never drift apart.
 *
 * SCORING IS NEVER TOUCHED — these are purely discovery/fetch coverage signals.
 */
import { db } from "../db.js";
import { sql } from "drizzle-orm";

export interface CompletenessThresholds {
  /** fetchRatio below this counts as a completeness deficit. */
  fetchRatioThreshold: number;
}

export function resolveThresholds(over?: Partial<CompletenessThresholds>): CompletenessThresholds {
  return {
    fetchRatioThreshold:
      over?.fetchRatioThreshold ?? parseFloat(process.env.FETCH_RATIO_THRESHOLD || "0.7"),
  };
}

export interface CompanyCompletenessRow {
  companyId: number;
  companyName: string;
  diagnostics: any;
  firstPartyDocCount: number;
  jobFailed: boolean;
}

export interface CompletenessAssessment {
  companyId: number;
  companyName: string;
  needsRerun: boolean;
  category: "failed" | "incomplete" | null;
  reasons: string[];
}

/** Canonical reason codes (also the keys of the per-signal count breakdown). */
export const COMPLETENESS_REASONS = [
  "failed_job",
  "budget_exceeded",
  "low_fetch_ratio",
  "dead_primary_filing",
  "coverage_low",
  "coverage_minimal",
  "coverage_suspect",
  "zero_first_party_docs",
] as const;

function asBool(v: any): boolean {
  return v === true || String(v).toLowerCase() === "true";
}

/**
 * PURE: derive the completeness-deficit reasons for one company from its
 * discovery diagnostics + first-party doc count + whether its job failed.
 * No scoring input. Shared by the marker and the selector.
 */
export function assessCompleteness(
  row: CompanyCompletenessRow,
  thresholds: CompletenessThresholds,
): CompletenessAssessment {
  const reasons: string[] = [];
  const diag = row.diagnostics || {};
  const fc = diag.fetchCoverage || {};
  const cov = diag.coverage || {};

  if (row.jobFailed) reasons.push("failed_job");

  if (asBool(fc.budgetExceeded)) reasons.push("budget_exceeded");

  const fetchRatio =
    typeof fc.fetchRatio === "number" ? fc.fetchRatio : parseFloat(fc.fetchRatio);
  if (Number.isFinite(fetchRatio) && fetchRatio < thresholds.fetchRatioThreshold) {
    reasons.push("low_fetch_ratio");
  }

  if (asBool(fc.deadPrimaryFiling)) reasons.push("dead_primary_filing");

  const level = String(cov.coverageLevel || "").toLowerCase();
  if (level === "low" || level === "minimal" || level === "suspect") {
    reasons.push(`coverage_${level}`);
  }

  if (row.firstPartyDocCount === 0) reasons.push("zero_first_party_docs");

  const incomplete = reasons.some(r => r !== "failed_job");
  const needsRerun = row.jobFailed || incomplete;
  // Failure takes precedence in the category label; all reasons are retained.
  const category: "failed" | "incomplete" | null = !needsRerun
    ? null
    : row.jobFailed
      ? "failed"
      : "incomplete";

  return { companyId: row.companyId, companyName: row.companyName, needsRerun, category, reasons };
}

/**
 * Load the per-company completeness inputs for every company that has a job in a
 * single batch (used by the batch-completion marker). Read-only.
 */
export async function loadBatchCompletenessRows(batchId: number): Promise<CompanyCompletenessRow[]> {
  const res = await db.execute(sql`
    SELECT
      c.id   AS company_id,
      c.name AS company_name,
      c.discovery_diagnostics AS diagnostics,
      COALESCE(fp.cnt, 0) AS first_party_count,
      j.status AS job_status
    FROM analysis_jobs j
    JOIN companies c ON c.id = j.company_id
    LEFT JOIN (
      SELECT company_id, COUNT(*)::int AS cnt
      FROM documents
      WHERE source_type = 'first_party'
      GROUP BY company_id
    ) fp ON fp.company_id = c.id
    WHERE j.batch_id = ${batchId}
  `);
  return (res.rows as any[]).map(r => ({
    companyId: Number(r.company_id),
    companyName: String(r.company_name || ""),
    diagnostics: r.diagnostics || null,
    firstPartyDocCount: Number(r.first_party_count || 0),
    jobFailed: String(r.job_status || "") === "failed",
  }));
}

/**
 * Load the per-company completeness inputs for the LATEST job per company in a
 * (workspace, framework), optionally restricted to `companyIds`. Used by the
 * requeue-completeness selector. Read-only.
 */
export async function loadWorkspaceCompletenessRows(opts: {
  workspaceId: number;
  frameworkId: number;
  companyIds?: number[];
}): Promise<CompanyCompletenessRow[]> {
  const idFilter =
    opts.companyIds && opts.companyIds.length > 0
      ? sql`AND c.id = ANY(${opts.companyIds})`
      : sql``;
  const res = await db.execute(sql`
    WITH latest_job AS (
      SELECT DISTINCT ON (company_id)
        company_id, status
      FROM analysis_jobs
      WHERE workspace_id = ${opts.workspaceId}
        AND framework_id = ${opts.frameworkId}
      ORDER BY company_id, created_at DESC
    )
    SELECT
      c.id   AS company_id,
      c.name AS company_name,
      c.discovery_diagnostics AS diagnostics,
      COALESCE(fp.cnt, 0) AS first_party_count,
      lj.status AS job_status
    FROM latest_job lj
    JOIN companies c ON c.id = lj.company_id
    LEFT JOIN (
      SELECT company_id, COUNT(*)::int AS cnt
      FROM documents
      WHERE source_type = 'first_party'
      GROUP BY company_id
    ) fp ON fp.company_id = c.id
    WHERE c.workspace_id = ${opts.workspaceId}
      ${idFilter}
  `);
  return (res.rows as any[]).map(r => ({
    companyId: Number(r.company_id),
    companyName: String(r.company_name || ""),
    diagnostics: r.diagnostics || null,
    firstPartyDocCount: Number(r.first_party_count || 0),
    jobFailed: String(r.job_status || "") === "failed",
  }));
}

/** Remove a stale completenessFlag so a now-complete company is not re-selected. */
async function clearCompletenessFlag(companyId: number, workspaceId: number): Promise<void> {
  await db.execute(sql`
    UPDATE companies
       SET discovery_diagnostics = discovery_diagnostics - 'completenessFlag'
     WHERE id = ${companyId}
       AND workspace_id = ${workspaceId}
       AND discovery_diagnostics IS NOT NULL
  `);
}

export interface MarkBatchResult {
  marked: number;
  failed: number;
  incomplete: number;
  cleared: number;
}

/**
 * PERMANENT batch-completion marker. For every company in the batch, write (or
 * refresh) a non-destructive `completenessFlag` when it FAILED or is INCOMPLETE,
 * and clear a stale flag when it is now complete. Invoked once per batch from the
 * worker's idempotent completion handler. Best-effort and self-contained: errors
 * are swallowed by the caller so marking never blocks batch finalisation.
 */
export async function markBatchCompleteness(opts: {
  batchId: number;
  frameworkId: number;
  workspaceId: number;
  thresholds?: Partial<CompletenessThresholds>;
}): Promise<MarkBatchResult> {
  const thresholds = resolveThresholds(opts.thresholds);
  const rows = await loadBatchCompletenessRows(opts.batchId);
  const markedAt = new Date().toISOString();
  const out: MarkBatchResult = { marked: 0, failed: 0, incomplete: 0, cleared: 0 };

  for (const row of rows) {
    const a = assessCompleteness(row, thresholds);
    if (!a.needsRerun) {
      await clearCompletenessFlag(row.companyId, opts.workspaceId);
      out.cleared++;
      continue;
    }
    const flag = {
      needsRerun: true,
      category: a.category,
      reasons: a.reasons,
      batchId: opts.batchId,
      frameworkId: opts.frameworkId,
      markedAt,
    };
    await db.execute(sql`
      UPDATE companies
         SET discovery_diagnostics = jsonb_set(
               COALESCE(discovery_diagnostics, '{}'::jsonb),
               '{completenessFlag}',
               ${JSON.stringify(flag)}::jsonb,
               true)
       WHERE id = ${row.companyId}
         AND workspace_id = ${opts.workspaceId}
    `);
    out.marked++;
    if (a.category === "failed") out.failed++;
    else out.incomplete++;
  }
  return out;
}

export interface CompletenessSelection {
  selected: Array<CompletenessAssessment & { flagged: boolean }>;
  signalCounts: Record<string, number>;
  total: number;
}

/**
 * SELECTOR used by requeue-completeness.ts. A company qualifies for re-run if
 * EITHER its live diagnostics show a completeness deficit (budget exceeded, low
 * fetch ratio, dead primary filing, low/minimal/suspect coverage, zero
 * first-party docs, or a failed latest job) OR it carries a persisted
 * `completenessFlag.needsRerun` from the batch-completion marker. Read-only;
 * does not reset or enqueue anything.
 */
export async function selectCompletenessDeficitCompanies(opts: {
  workspaceId: number;
  frameworkId: number;
  thresholds?: Partial<CompletenessThresholds>;
  companyIds?: number[];
  limit?: number;
}): Promise<CompletenessSelection> {
  const thresholds = resolveThresholds(opts.thresholds);
  const rows = await loadWorkspaceCompletenessRows({
    workspaceId: opts.workspaceId,
    frameworkId: opts.frameworkId,
    companyIds: opts.companyIds,
  });

  const signalCounts: Record<string, number> = {};
  for (const reason of COMPLETENESS_REASONS) signalCounts[reason] = 0;
  signalCounts["persisted_flag"] = 0;

  const selected: Array<CompletenessAssessment & { flagged: boolean }> = [];
  for (const row of rows) {
    const a = assessCompleteness(row, thresholds);
    const persisted = !!(row.diagnostics?.completenessFlag?.needsRerun);
    if (!a.needsRerun && !persisted) continue;
    for (const r of a.reasons) {
      if (r in signalCounts) signalCounts[r]++;
    }
    if (persisted) signalCounts["persisted_flag"]++;
    selected.push({ ...a, needsRerun: true, flagged: persisted });
  }

  // Deterministic ordering: failed first, then by company id.
  selected.sort((x, y) => {
    if (x.category !== y.category) {
      if (x.category === "failed") return -1;
      if (y.category === "failed") return 1;
    }
    return x.companyId - y.companyId;
  });

  const limited = opts.limit && opts.limit > 0 ? selected.slice(0, opts.limit) : selected;
  return { selected: limited, signalCounts, total: selected.length };
}
