// WS6 — auto-snapshot on fresh runs.
//
// This is a deliberately DB-free leaf module (it imports nothing from db.ts /
// storage.ts / pipeline.ts) so its decision + persistence logic is unit-testable
// without a live DATABASE_URL. The caller (pipeline.ts) injects the actual
// batch_corpus insert as an `execute` closure.
//
// Purpose: when a run's fetch phase was skipped (e.g. SCORE_ONLY_REPLAY loading
// the corpus from a per-(company, framework) frozen_corpus_snapshot), the only
// existing batch_corpus INSERT — which lives at the end of the fetch phase —
// never fires, so the batch ends up with snapshot_saved=TRUE but ZERO
// batch_corpus rows. This module persists a batch_corpus snapshot for the
// current batch containing exactly the document IDs used for scoring, so every
// completed batch is self-auditable for determinism.
//
// It is purely additive, idempotent (caller uses ON CONFLICT DO NOTHING + an
// existence guard), and fully fail-safe: any error is caught and logged, never
// propagated into scoring/analysis, and it never changes which docs are scored.

/** Pure decision: should we auto-snapshot the current batch's corpus?
 *
 *  True iff ALL of:
 *   - the feature flag is enabled, AND
 *   - a concrete batchId is present (a real run with a batch context), AND
 *   - there is NO active sourceBatchId replay (those already pin their corpus via
 *     the REPLAY CORPUS PIN path — do not double-handle), AND
 *   - at least one document was resolved for scoring.
 *
 *  This is a pure function of its inputs — no side effects, no I/O. */
export function shouldAutoSnapshot(opts: {
  flagEnabled: boolean;
  batchId?: number | null;
  sourceBatchId?: number | null;
  documentIds: number[];
}): boolean {
  const { flagEnabled, batchId, sourceBatchId, documentIds } = opts;
  if (!flagEnabled) return false;
  // batchId must be a real, positive batch identifier.
  if (batchId == null || !Number.isFinite(batchId) || batchId <= 0) return false;
  // Replays already pin their corpus elsewhere — never double-handle here.
  if (sourceBatchId != null) return false;
  // Nothing to snapshot.
  if (!Array.isArray(documentIds) || documentIds.length === 0) return false;
  return dedupeDocumentIds(documentIds).length > 0;
}

/** Pure helper: dedupe document IDs while preserving first-seen order, dropping
 *  any non-finite / non-positive values. Stable order keeps the persisted set
 *  deterministic regardless of upstream ordering. */
export function dedupeDocumentIds(ids: number[]): number[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Guarded, idempotent persistence of a batch_corpus snapshot for the current
 *  batch. The actual DB work is injected via `execute` so this module stays
 *  DB-free and unit-testable.
 *
 *  Behaviour:
 *   - Empty / all-invalid document list → no-op (execute is NOT called), returns false.
 *   - Dedupes document IDs before handing them to `execute`.
 *   - Any error thrown by `execute` (or anything else) is caught, logged via
 *     console.warn, and swallowed — it NEVER throws. Returns false on error.
 *   - Returns true only when `execute` completed without throwing.
 *
 *  This is the single fail-safe boundary: callers can invoke it fire-and-forget
 *  knowing it can never break scoring/analysis. */
export async function persistAutoSnapshot(opts: {
  batchId: number;
  companyId: number;
  documentIds: number[];
  execute: (args: { batchId: number; companyId: number; documentIds: number[] }) => Promise<void>;
  logLabel?: string;
}): Promise<boolean> {
  const { batchId, companyId, documentIds, execute, logLabel } = opts;
  const label = logLabel ? `${logLabel} ` : "";
  try {
    const ids = dedupeDocumentIds(documentIds);
    if (ids.length === 0) {
      // Nothing to persist — not an error, just a no-op.
      return false;
    }
    await execute({ batchId, companyId, documentIds: ids });
    return true;
  } catch (err: any) {
    // Fail-safe: never let a snapshot error reach the caller.
    console.warn(`${label}AUTO SNAPSHOT: persist failed (non-fatal): ${err?.message ?? err}`);
    return false;
  }
}
