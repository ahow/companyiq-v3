// GENERALISED per-measure verdict-stability k calibration (WS4).
//
// Given empirical per-measure flip statistics from a test-drive (multi-iteration
// scoring over a frozen corpus), compute and persist a calibrated majority-vote
// k for each measure. The core is a PURE function (unit-testable without a DB);
// the DB wrapper is a thin, fail-open idempotent UPDATE.
//
// Nothing here is framework/topic/measure specific — it operates purely on the
// measured flip rate of whatever measures are passed in, mapping each through the
// env-overridable calibration bands. Over-assigning k is safe: majority-vote with
// tie-keeps-first can never destabilise a cell.

import { verdictStabilityKBands, calibrateKFromFlipRate } from "../scoring-fix-flags.js";

/** The minimal shape of a per-measure flip statistic this calibrator reads.
 *  Mirrors the fields produced by test-drive's computeFlipStats (MeasureFlipStat),
 *  but intentionally structural so it is decoupled from that module. */
export interface FlipStatLike {
  measureId: string;
  /** Run-to-run flip rate in [0,1] over the compared companies. */
  flipRate?: number;
  /** Number of scoring iterations compared (flip stats need >= 2 to be meaningful). */
  runs?: number;
}

/** PURE: map each flip stat with a string measureId and finite flipRate to a
 *  calibrated k via the bands. Every such measure gets an entry; measures whose
 *  flip rate is below the lowest band map to 1 (a no-op lock). Stats with a
 *  non-string measureId or non-finite flipRate are skipped. */
export function computePerMeasureK(
  flipStats: FlipStatLike[],
  bands = verdictStabilityKBands(),
): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(flipStats)) return out;
  for (const stat of flipStats) {
    if (!stat || typeof stat.measureId !== "string" || stat.measureId.length === 0) continue;
    const rate = stat.flipRate;
    if (typeof rate !== "number" || !Number.isFinite(rate)) continue;
    out.set(stat.measureId, calibrateKFromFlipRate(rate, bands));
  }
  return out;
}

/** Persist calibrated per-measure k to framework_measures (idempotent UPDATE).
 *
 *  GUARD: flip stats are only meaningful with >= 2 iterations, so if flipStats is
 *  empty OR no stat reports runs >= 2, this is a no-op and returns {updated:0}.
 *
 *  For each measure in the computed map, runs
 *    UPDATE framework_measures SET verdict_stability_k = <k>
 *    WHERE framework_id = <frameworkId> AND measure_id = <measureId>
 *  using drizzle `sql` parameterisation. The write is idempotent (re-running with
 *  the same stats sets the same values) and additive (only this one column).
 *
 *  Errors are NOT swallowed here — the caller (test-drive results handler) wraps
 *  the call in a non-fatal try/catch so calibration failure never breaks scoring
 *  or the results response. */
export async function persistPerMeasureK(
  db: any,
  frameworkId: number,
  flipStats: FlipStatLike[],
): Promise<{ updated: number; kByMeasure: Record<string, number> }> {
  // Meaningfulness guard: need at least one stat measured over >= 2 iterations.
  const hasEnoughRuns =
    Array.isArray(flipStats) &&
    flipStats.some((s) => s && typeof s.runs === "number" && s.runs >= 2);
  if (!Array.isArray(flipStats) || flipStats.length === 0 || !hasEnoughRuns) {
    return { updated: 0, kByMeasure: {} };
  }

  const { sql } = await import("drizzle-orm");
  const kByMeasureMap = computePerMeasureK(flipStats);
  const kByMeasure: Record<string, number> = {};
  let updated = 0;

  for (const [measureId, k] of kByMeasureMap) {
    kByMeasure[measureId] = k;
    const res = await db.execute(sql`
      UPDATE framework_measures
      SET verdict_stability_k = ${k}
      WHERE framework_id = ${frameworkId} AND measure_id = ${measureId}
    `);
    // rowCount is available on the node-postgres result; default to 0 if absent.
    updated += (res as any)?.rowCount ?? 0;
  }

  return { updated, kByMeasure };
}
