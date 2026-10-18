/**
 * variability-stability.ts — Phase 1.1: pure per-cell / per-measure stability
 * table with Yes→No and No→Yes transition totals per measure.
 *
 * WHY (plan §"Phase 1 — Reproducibility", step 1.1):
 *   "Run it N× on identical evidence and chart which answers move." This module
 *   takes the per-(company,run) verdict records (as produced by
 *   server/scripts/variability_run.ts) and builds the stability table the plan's
 *   acceptance bar requires: Yes→No / No→Yes totals per measure (standing
 *   constraint 4 — the SPLIT, not the net).
 *
 * SCOPE / SAFETY:
 *   - PURE/total: no I/O, no DB, no model call. Runs fully offline on synthetic
 *     or fixture records, so it is unit-testable WITHOUT any live LLM-spending
 *     replay run. The aggregator script (variability_stability_table.ts) and the
 *     live harness (variability_run.ts) both feed it; this module never runs a
 *     scoring pass itself.
 *   - FRAMEWORK-LEVEL: keyed only by measureId + verdict; no company/topic logic.
 *
 * TRANSITION SEMANTICS:
 *   Transitions are counted against a BASELINE run (by default the first run in
 *   the list, run index ascending). For every other run, each cell whose verdict
 *   differs from its baseline verdict contributes to that measure's Yes→No or
 *   No→Yes total. This directly answers "how many cells would flip on a re-run"
 *   per measure, which is exactly the borderline set 1.4 labels.
 */

/** A single cell's verdict in one run. Verdict is normalised to Yes/No/Partial. */
export type Verdict = "Yes" | "No" | "Partial";

/** Normalise a raw verdict/score to the canonical label. Unknowns → "No". */
export function normaliseVerdict(raw: unknown): Verdict {
  if (raw === "Yes" || raw === "No" || raw === "Partial") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return "Yes";
    if (raw === 0) return "No";
    return "Partial";
  }
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "yes") return "Yes";
  if (s === "partial") return "Partial";
  return "No";
}

export interface CellRecord {
  measureId: string;
  verdict: Verdict;
}

export interface RunRecord {
  /** Monotonic run index; the lowest is the baseline unless baselineRunIndex set. */
  runIndex: number;
  cells: CellRecord[];
}

export interface MeasureStability {
  measureId: string;
  /** Number of non-baseline runs this measure appeared in (comparisons made). */
  comparisons: number;
  /** Cells that were Yes at baseline and No in a later run. */
  yesToNo: number;
  /** Cells that were No at baseline and Yes in a later run. */
  noToYes: number;
  /** Any other transition (e.g. involving Partial), reported for completeness. */
  otherFlips: number;
  /** Total flips (yesToNo + noToYes + otherFlips). */
  totalFlips: number;
  /** True when no run flipped this measure's verdict vs baseline. */
  stable: boolean;
  /** The baseline verdict used for the comparisons. */
  baselineVerdict: Verdict | null;
}

export interface StabilityTable {
  baselineRunIndex: number;
  runCount: number;
  measures: MeasureStability[];
  totals: {
    yesToNo: number;
    noToYes: number;
    otherFlips: number;
    totalFlips: number;
    measuresWithFlips: number;
    measuresStable: number;
  };
}

/**
 * Build the per-measure stability table from a set of run records.
 *
 * @param runs  per-run cell verdicts (one entry per replay run).
 * @param opts.baselineRunIndex  which run is the baseline (default: lowest index).
 *
 * Deterministic and pure. Measures are emitted in first-seen order of the
 * baseline run, then any extra measures seen only in later runs (sorted), so the
 * output order is stable across invocations.
 */
export function buildStabilityTable(
  runs: readonly RunRecord[],
  opts?: { baselineRunIndex?: number },
): StabilityTable {
  const sorted = [...(runs || [])].sort((a, b) => a.runIndex - b.runIndex);
  const baselineRunIndex =
    opts?.baselineRunIndex ?? (sorted.length ? sorted[0].runIndex : 0);
  const baseline = sorted.find((r) => r.runIndex === baselineRunIndex) || sorted[0] || null;

  // Baseline verdict per measure + emission order.
  const baselineVerdict = new Map<string, Verdict>();
  const order: string[] = [];
  if (baseline) {
    for (const c of baseline.cells) {
      if (!baselineVerdict.has(c.measureId)) {
        baselineVerdict.set(c.measureId, normaliseVerdict(c.verdict));
        order.push(c.measureId);
      }
    }
  }

  // Accumulators.
  const acc = new Map<string, MeasureStability>();
  const ensure = (measureId: string): MeasureStability => {
    let m = acc.get(measureId);
    if (!m) {
      m = {
        measureId,
        comparisons: 0,
        yesToNo: 0,
        noToYes: 0,
        otherFlips: 0,
        totalFlips: 0,
        stable: true,
        baselineVerdict: baselineVerdict.has(measureId) ? baselineVerdict.get(measureId)! : null,
      };
      acc.set(measureId, m);
    }
    return m;
  };
  for (const measureId of order) ensure(measureId);

  // Compare every non-baseline run cell against its baseline verdict.
  for (const run of sorted) {
    if (baseline && run.runIndex === baseline.runIndex) continue;
    for (const c of run.cells) {
      const base = baselineVerdict.get(c.measureId);
      const m = ensure(c.measureId);
      m.comparisons++;
      if (base == null) continue; // measure not in baseline — cannot classify a flip
      const now = normaliseVerdict(c.verdict);
      if (now === base) continue;
      // A flip.
      if (base === "Yes" && now === "No") m.yesToNo++;
      else if (base === "No" && now === "Yes") m.noToYes++;
      else m.otherFlips++;
      m.totalFlips++;
      m.stable = false;
    }
  }

  // Deterministic order: baseline order first, then any extras sorted.
  const extraMeasures = [...acc.keys()].filter((k) => !order.includes(k)).sort();
  const measures = [...order, ...extraMeasures].map((k) => ensure(k));

  const totals = measures.reduce(
    (t, m) => {
      t.yesToNo += m.yesToNo;
      t.noToYes += m.noToYes;
      t.otherFlips += m.otherFlips;
      t.totalFlips += m.totalFlips;
      if (m.totalFlips > 0) t.measuresWithFlips++;
      else t.measuresStable++;
      return t;
    },
    { yesToNo: 0, noToYes: 0, otherFlips: 0, totalFlips: 0, measuresWithFlips: 0, measuresStable: 0 },
  );

  return { baselineRunIndex, runCount: sorted.length, measures, totals };
}

/**
 * Render the stability table as a compact Markdown table (for CI / ledger output).
 * Pure string builder — no I/O.
 */
export function formatStabilityTableMarkdown(table: StabilityTable): string {
  const lines: string[] = [];
  lines.push(`Stability table — baseline run ${table.baselineRunIndex}, ${table.runCount} run(s)`);
  lines.push("");
  lines.push("| Measure | Comparisons | Yes→No | No→Yes | Other | Total flips | Stable |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const m of table.measures) {
    lines.push(
      `| ${m.measureId} | ${m.comparisons} | ${m.yesToNo} | ${m.noToYes} | ${m.otherFlips} | ${m.totalFlips} | ${m.stable ? "yes" : "NO"} |`,
    );
  }
  const t = table.totals;
  lines.push(
    `| **TOTAL** | | **${t.yesToNo}** | **${t.noToYes}** | **${t.otherFlips}** | **${t.totalFlips}** | ${t.measuresStable}/${table.measures.length} |`,
  );
  return lines.join("\n");
}
