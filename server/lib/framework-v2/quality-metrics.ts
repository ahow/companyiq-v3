/**
 * Framework Creation v2 — Tier-1 Design-Time Quality Gate (N=50).
 *
 * This module implements the **Layer-1 / Tier-1** slice of the Framework Quality
 * Measurement Specification (Framework_Quality_Measurement_Spec.md, v0.1). It is
 * a pure, additive analysis layer computed AFTER a design-time test-drive run —
 * it never touches live scoring (which stays single-shot, rewrite-only, no
 * sampling) and it does not replace the existing 6-criteria robustness scorecard
 * (robustness-criteria.ts) — the two run side by side.
 *
 * What is in scope here (spec §8 "build first"):
 *   • Reliability            — MAXIMISE  (§4.1)
 *   • Coherence–redundancy   — MAXIMISE + near-duplication GATE (§4.2)
 *   • Discrimination         — GATE      (§4.5)
 *   • Coverage answerability — GATE      (§4.6, Tier-1 part only)
 *   • Auditability           — GATE      (§4.4, Tier-1 seed only)
 *   • Robustness             — GATE      (§4.7, retrieval + confidence part only)
 *   • Transparency           — GATE      (§4.10 spec-completeness only)
 *   • Q maximise objective   — reliability + coherence-redundancy + accuracy proxy (§3)
 *
 * Every metric carries a ROLE tag ("MAXIMISE" | "GATE"). Gate metrics expose
 * their raw value plus a THRESHOLD read from the single QUALITY_GATE_THRESHOLDS
 * block below. All thresholds are DEFERRED (spec §7) — they are placeholders the
 * user calibrates against real outputs, and they are editable in exactly one
 * place (that block).
 *
 * OUT OF SCOPE (deferred; see TODOs at the end of this file):
 *   • Tier-2 data capture (size / country-income / disclosure-regime /
 *     dated-source / source-type classifier) → coverage-equity, recency,
 *     source-type concentration, disclosure-capacity confound.
 *   • Layer-2 validation report (identity-share regression, group effects,
 *     factor-structure validity) — degenerate at N=50, needs the full universe.
 *   • Tier-3 assurance (spot-check adjudication UI, gold set, perturbation
 *     extra-run agreement).
 */

import type { TestDriveCompanyResult, MultiRunIteration } from "./test-drive.js";

// ════════════════════════════════════════════════════════════════════════
//  ⚙  DEFERRED GATE THRESHOLDS — EDIT HERE (and only here)
//  ────────────────────────────────────────────────────────────────────────
//  Every value below is a PLACEHOLDER (spec §7 "Deferred definitions"). The
//  user calibrates each floor/ceiling once real Tier-1 outputs are visible.
//  Gate metrics report their raw value alongside the relevant threshold and a
//  pass/fail derived from it, but the loop MUST NOT be trusted to enforce these
//  until the numbers here are set from outputs. Changing a number here changes
//  the gate everywhere it is used — there is no other copy.
// ════════════════════════════════════════════════════════════════════════
export const QUALITY_GATE_THRESHOLDS = {
  // ── Coherence–redundancy (§4.2) ──────────────────────────────────────
  /** Near-duplication: two measures flagged when raw pairwise agreement on their
   *  two N-length verdict vectors is ≥ this. High-precision / low-recall at N=50;
   *  human-overrideable. Cohen's κ is reported alongside for context. */
  NEAR_DUP_AGREEMENT: 0.9, // [DEFERRED — set from outputs]
  /** Companion κ floor for near-duplication (informational; agreement is the
   *  primary trigger because κ is unstable on imbalanced binaries at N=50). */
  NEAR_DUP_KAPPA: 0.85, // [DEFERRED]
  /** Redundancy rate: within-pillar indicator pairs with |agreement| ≥ this
   *  count as redundant (spec uses |r|≥0.8; we use agreement as the N=50-robust
   *  proxy — see §4.2 guard). */
  REDUNDANCY_PAIR_AGREEMENT: 0.8, // [DEFERRED]
  /** Contribution balance ceiling: max share of composite variance any single
   *  indicator may contribute before the framework is "one indicator does all
   *  the work". */
  CONTRIBUTION_BALANCE_MAX_SHARE: 0.4, // [DEFERRED]
  /** Cross-pillar independence ceiling: mean inter-pillar correlation above this
   *  means the pillars have collapsed into one. */
  CROSS_PILLAR_MAX_CORR: 0.8, // [DEFERRED]
  /** KR-20 gate BAND (floor, ceiling): a floor for genuine internal consistency
   *  and a ceiling that stops near-duplicate indicators being rewarded as
   *  "coherence". NOT maximised. */
  KR20_FLOOR: 0.5, // [DEFERRED]
  KR20_CEILING: 0.95, // [DEFERRED]

  // ── Discrimination (§4.5) ────────────────────────────────────────────
  /** Pass-rate band: an indicator is information-bearing when its pass rate is
   *  within [low, high]. */
  PASS_RATE_BAND_LOW: 0.1, // [DEFERRED]
  PASS_RATE_BAND_HIGH: 0.9, // [DEFERRED]
  /** Minimum share of indicators that must fall in the information-bearing band. */
  PASS_RATE_BAND_MIN_SHARE: 0.6, // [DEFERRED]
  /** Floor/ceiling share ceiling: max share of indicators pinned at 0% or 100%. */
  FLOOR_CEILING_MAX_SHARE: 0.3, // [DEFERRED]
  /** Composite Gini floor: below this the composite barely separates companies. */
  COMPOSITE_GINI_MIN: 0.1, // [DEFERRED]
  /** Effective-differentiation floor: min share of company pairs whose composite
   *  gap exceeds 1.96·√2·SEM (i.e. are statistically distinguishable). */
  EFFECTIVE_DIFFERENTIATION_MIN: 0.5, // [DEFERRED]

  // ── Coverage (§4.6, Tier-1) ──────────────────────────────────────────
  /** Answerability floor: min share of companies coded Yes/No (vs Not-evidenced)
   *  per indicator, averaged across indicators. */
  ANSWERABILITY_MIN: 0.7, // [DEFERRED]

  // ── Auditability (§4.4, Tier-1 seed) ─────────────────────────────────
  /** Quote-support floor: min share of Yes cells carrying at least one quote
   *  (seed proxy; full semantic quote-support is a Tier-1+LLM pass, deferred). */
  QUOTE_SUPPORT_MIN: 0.9, // [DEFERRED]

  // ── Robustness (§4.7, Tier-1) ────────────────────────────────────────
  /** Retrieval-stability floor: min mean Jaccard overlap of cited source-sets
   *  across runs for the same cell. */
  RETRIEVAL_STABILITY_MIN: 0.6, // [DEFERRED]

  // ── Transparency (§4.10, Tier-1) ─────────────────────────────────────
  /** Spec-completeness floor: min mean checklist score across indicators. */
  SPEC_COMPLETENESS_MIN: 0.8, // [DEFERRED]
} as const;

// ════════════════════════════════════════════════════════════════════════
//  ⚖  PRE-REGISTERED Q OBJECTIVE WEIGHTS — EDIT HERE (spec §3, §7)
//  ────────────────────────────────────────────────────────────────────────
//  Three importance weights only (spec §3.3 over-parameterisation discipline:
//  do NOT fit a large weight vector to 50 companies). Pre-registered, normative,
//  fixed; the loop may NEVER tune its own weights (Goodhart guard §3.4.1).
//  Default equal (1/3 each) until set from outputs. Accuracy's weight applies to
//  the automatic quote-support PROXY at Tier-1 (two-speed treatment, §1.1/§3.3);
//  the true accuracy checkpoint (Tier-3) recalibrates rather than being
//  hill-climbed here.
// ════════════════════════════════════════════════════════════════════════
export const Q_IMPORTANCE_WEIGHTS = {
  reliability: 1 / 3, // w_reliability [DEFERRED — set from outputs]
  coherenceRedundancy: 1 / 3, // w_coherence   [DEFERRED]
  accuracy: 1 / 3, // w_accuracy (Tier-1 = quote-support proxy) [DEFERRED]
} as const;

/** ± band used by the weight-sensitivity Goodhart guard (spec §3.4.2). */
export const Q_WEIGHT_SENSITIVITY_BAND = 0.1;

export type MetricRole = "MAXIMISE" | "GATE";

// ─── Output shape ─────────────────────────────────────────────────────────

export interface GateMetric {
  id: string;
  label: string;
  role: "GATE";
  value: number | null; // raw observed value (null when not computable)
  threshold: number | null; // the deferred placeholder it is judged against
  thresholdDirection: "min" | "max" | "band"; // how to compare value to threshold
  passed: boolean | null; // null when value is null
  observed: string; // human-readable
  detail: string;
  status?: string; // e.g. "insufficient data" when value is null
}

export interface MaximiseMetric {
  id: string;
  label: string;
  role: "MAXIMISE";
  value: number | null;
  observed: string;
  detail: string;
  status?: string;
}

export interface NearDuplicatePair {
  measureIdA: string;
  measureIdB: string;
  labelA: string;
  labelB: string;
  agreement: number; // raw pairwise agreement on the two verdict vectors
  kappa: number; // Cohen's κ (informational; imbalance-aware)
  n: number; // number of companies compared
  // Selectable/overrideable focal item for the LLM merge/differentiate flow.
  // The UI presents each pair as accept/dismiss; nothing is auto-deleted.
  recommendation: "merge-or-differentiate";
}

export interface PerIndicatorMetric {
  measureId: string;
  label: string;
  passRate: number; // Yes share across companies (binary pass)
  inInformationBand: boolean; // pass rate in [low, high]
  answerability: number; // share coded Yes/No (vs Not-evidenced)
  cellStability: number | null; // per-indicator cross-run stability (null if <2 runs)
  kappa: number | null; // per-indicator run-pair Cohen's κ (null if <2 runs)
  specCompleteness: number | null; // checklist score 0..1 (null if no spec provided)
}

export interface QDimensionScore {
  dimension: "reliability" | "coherenceRedundancy" | "accuracy";
  weight: number; // w_d
  S_d: number | null; // reliability-weighted standardised mean (spec §3.1)
  meanRho: number | null; // mean ρ_i shrinkage across indicators (reporting)
  indicatorCount: number;
  status?: string;
}

export interface WeightSensitivityGuard {
  stable: boolean;
  qBaseline: number | null;
  qRange: [number, number] | null; // [min, max] Q over perturbed weight vectors
  dimensionRankStable: boolean;
  note: string;
}

export interface QualityMetricsReport {
  n: number; // actual company count used (NEVER hardcoded)
  runs: number; // number of iterations available for cross-run metrics
  reliability: MaximiseMetric[];
  coherenceRedundancy: MaximiseMetric[];
  discrimination: GateMetric[];
  coverage: GateMetric[];
  auditability: GateMetric[];
  robustness: GateMetric[];
  transparency: GateMetric[];
  nearDuplicatePairs: NearDuplicatePair[];
  perIndicator: PerIndicatorMetric[];
  q: {
    Q: number | null;
    dimensions: QDimensionScore[];
    weightSensitivity: WeightSensitivityGuard;
    note: string;
  };
  thresholdsAreDeferred: true; // machine-readable reminder for the UI
}

// ─── Inputs ────────────────────────────────────────────────────────────────

export interface MeasureSpecFields {
  // Presence-checked for the transparency spec-completeness checklist (§4.10).
  definition?: unknown;
  inclusion?: unknown; // e.g. positive_examples / inclusion criteria
  exclusion?: unknown; // e.g. negative_examples / adjacent-topic exclusion
  evidenceStandard?: unknown; // e.g. fallback_yes_criterion / evidence rule
  borderlineExamples?: unknown; // borderline / edge-case examples
}

export interface QualityMetricsInput {
  /** Current-run per-company results (source of truth for N — use results.length,
   *  never a hardcoded sample size). */
  results: TestDriveCompanyResult[];
  /** Measure metadata; `pillar` groups measures for within-pillar KR-20 /
   *  cross-pillar independence (falls back to a single pillar when absent). */
  measureMetadata: Array<{
    measureId: string;
    expected_yes_rate?: number;
    pillar?: string;
    title?: string;
  }>;
  /** All iteration snapshots (≥2 enables cross-run reliability/robustness). */
  multiRun?: MultiRunIteration[];
  /** Per-measure spec fields for the transparency checklist. Optional. */
  measureSpecs?: Record<string, MeasureSpecFields>;
  /** Aggregate evidence-gate counts for the quote-support seed, when available
   *  (gateResult.quotesValid / quotesTotal). When absent, a quote-count proxy is
   *  derived from the current run's per-cell quoteCount. */
  quoteSupport?: { quotesValid: number; quotesTotal: number };
}

// ════════════════════════════════════════════════════════════════════════
//  Pure statistical helpers (exported for unit testing)
// ════════════════════════════════════════════════════════════════════════

/** Map a verdict to a binary pass (Yes = 1; everything else = 0). Mirrors the
 *  scoring binary semantics: No and "don't know"/Partial/Insufficient = 0. */
export function verdictToBinary(verdict: string): 0 | 1 {
  return verdict === "Yes" ? 1 : 0;
}

/** Raw pairwise agreement between two equal-length 0/1 vectors. */
export function rawAgreement(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same / n;
}

/**
 * Cohen's κ for two binary raters over N paired observations (imbalance-aware).
 * κ = (po − pe) / (1 − pe). Edge cases:
 *   • pe === 1 (both raters constant / degenerate margins): κ = 1 if perfectly
 *     agreeing, else 0 — avoids the −∞/NaN blow-up on imbalanced binaries at N=50.
 */
export function cohensKappaBinary(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let po = 0;
  let a1 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) po++;
    if (a[i] === 1) a1++;
    if (b[i] === 1) b1++;
  }
  po /= n;
  const pa1 = a1 / n;
  const pb1 = b1 / n;
  const pe = pa1 * pb1 + (1 - pa1) * (1 - pb1);
  if (pe >= 1) return po >= 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/** Pearson correlation; returns 0 when either vector has zero variance. */
export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = x[i] - mx;
    const ey = y[i] - my;
    num += ex * ey;
    dx += ex * ex;
    dy += ey * ey;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  return pearson(rankAverage(x.slice(0, n)), rankAverage(y.slice(0, n)));
}

function rankAverage(v: number[]): number[] {
  const idx = v.map((val, i) => ({ val, i })).sort((p, q) => p.val - q.val);
  const ranks = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].val === idx[i].val) j++;
    const avg = (i + j) / 2 + 1; // average rank (1-based)
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Gini coefficient of a non-negative distribution (0 = perfectly equal). */
export function gini(values: number[]): number {
  const v = values.filter((x) => x >= 0).slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  const sum = v.reduce((s, x) => s + x, 0);
  if (sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

/** Herfindahl index of a distribution of counts/shares (Σ share²). */
export function herfindahl(counts: number[]): number {
  const total = counts.reduce((s, x) => s + Math.max(0, x), 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    const share = Math.max(0, c) / total;
    h += share * share;
  }
  return h;
}

/** Jaccard overlap of two string sets (|A∩B| / |A∪B|). Empty∩empty = 1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Point-biserial correlation between a binary item and a continuous total.
 * Equivalent to Pearson(item, total); computed once and shared between the
 * Coherence item–total metric (§4.2) and Discrimination item–total (§4.5).
 */
export function pointBiserial(item: number[], total: number[]): number {
  return pearson(item, total);
}

function mean(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length;
}
function variance(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1);
}
function fmtPct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

// ════════════════════════════════════════════════════════════════════════
//  Verdict-matrix assembly
// ════════════════════════════════════════════════════════════════════════

interface VerdictMatrix {
  measureIds: string[];
  companyIds: number[];
  /** measureId → companyId(index-aligned to companyIds) → binary pass (Yes=1) */
  binary: Map<string, number[]>;
  /** measureId → companyId-index → raw verdict string */
  verdict: Map<string, string[]>;
}

function buildMatrix(
  results: TestDriveCompanyResult[],
  measureIds: string[],
): VerdictMatrix {
  const companyIds = results.map((r) => r.companyId);
  const binary = new Map<string, number[]>();
  const verdict = new Map<string, string[]>();
  for (const mid of measureIds) {
    const bin: number[] = [];
    const vs: string[] = [];
    for (const r of results) {
      const cell = r.measures.find((m) => m.measureId === mid);
      const v = cell?.verdict ?? "Insufficient evidence";
      vs.push(v);
      bin.push(verdictToBinary(v));
    }
    binary.set(mid, bin);
    verdict.set(mid, vs);
  }
  return { measureIds, companyIds, binary, verdict };
}

/** Composite score per company = Yes count across measures (binary pass sum). */
function compositeScores(matrix: VerdictMatrix): number[] {
  const n = matrix.companyIds.length;
  const totals = new Array<number>(n).fill(0);
  for (const mid of matrix.measureIds) {
    const bin = matrix.binary.get(mid)!;
    for (let i = 0; i < n; i++) totals[i] += bin[i];
  }
  return totals;
}

// ════════════════════════════════════════════════════════════════════════
//  ρ_i — inverse-variance reliability shrinkage (spec §3.1)
// ════════════════════════════════════════════════════════════════════════
//
// ρ_i = signal / (signal + noise) ∈ (0,1], computed from run-to-run variance
// already collected. Estimator (documented):
//   • NOISE_i  = mean over companies of the within-company run-to-run variance
//                of the binary verdict for measure i (how much the SAME cell
//                wobbles across identical re-runs). 0 when a cell is perfectly
//                stable across runs.
//   • SIGNAL_i = between-company variance of the per-company mean binary verdict
//                for measure i (how much the measure genuinely separates
//                companies). 0 for a dead/universal measure.
// A measure that is noisy at N=50 (high NOISE relative to SIGNAL) gets a low ρ_i
// and is shrunk toward the dimension mean, so the optimiser cannot chase noise.
// No free parameter; recomputed every run. When <2 runs exist, run-to-run noise
// is unobservable → ρ_i defaults to 1 (no shrinkage) and the caller flags the
// reliability metrics as run-limited.
function computeRhoPerMeasure(
  measureIds: string[],
  results: TestDriveCompanyResult[],
  multiRun: MultiRunIteration[],
): Map<string, number> {
  const rho = new Map<string, number>();
  const runs = multiRun?.length ?? 0;

  for (const mid of measureIds) {
    // Between-company signal from the current run.
    const currentBin = results.map((r) => {
      const cell = r.measures.find((m) => m.measureId === mid);
      return verdictToBinary(cell?.verdict ?? "Insufficient evidence");
    });
    const signal = variance(currentBin);

    if (runs < 2) {
      rho.set(mid, 1); // noise unobservable with <2 runs → no shrinkage
      continue;
    }

    // Within-company run-to-run noise: for each company, variance of its binary
    // verdict across iterations; average across companies.
    const perCompanyVerdicts = new Map<string, number[]>();
    for (const it of multiRun) {
      const pm = it.perMeasure?.[mid];
      if (!pm?.verdictsByCompany) continue;
      for (const [cid, v] of Object.entries(pm.verdictsByCompany)) {
        if (v == null) continue;
        const arr = perCompanyVerdicts.get(cid) ?? [];
        arr.push(verdictToBinary(String(v)));
        perCompanyVerdicts.set(cid, arr);
      }
    }
    const withinVars: number[] = [];
    for (const arr of perCompanyVerdicts.values()) {
      if (arr.length >= 2) withinVars.push(variance(arr));
    }
    const noise = withinVars.length > 0 ? mean(withinVars) : 0;

    const denom = signal + noise;
    rho.set(mid, denom <= 0 ? 1 : signal / denom);
  }
  return rho;
}

// ════════════════════════════════════════════════════════════════════════
//  Reliability — MAXIMISE (§4.1)
// ════════════════════════════════════════════════════════════════════════

interface PerIndicatorReliability {
  cellStability: number | null;
  kappa: number | null;
}

function reliabilityPerIndicator(
  measureIds: string[],
  multiRun: MultiRunIteration[],
): Map<string, PerIndicatorReliability> {
  const out = new Map<string, PerIndicatorReliability>();
  const runs = multiRun?.length ?? 0;
  for (const mid of measureIds) {
    if (runs < 2) {
      out.set(mid, { cellStability: null, kappa: null });
      continue;
    }
    // Gather per-company verdict sequences across runs.
    const perCompany = new Map<string, string[]>();
    for (const it of multiRun) {
      const pm = it.perMeasure?.[mid];
      if (!pm?.verdictsByCompany) continue;
      for (const [cid, v] of Object.entries(pm.verdictsByCompany)) {
        if (v == null) continue;
        const arr = perCompany.get(cid) ?? [];
        arr.push(String(v));
        perCompany.set(cid, arr);
      }
    }
    // Cell stability: share of comparable cells identical across all runs.
    let comparable = 0;
    let stable = 0;
    for (const arr of perCompany.values()) {
      if (arr.length < 2) continue;
      comparable++;
      if (new Set(arr).size === 1) stable++;
    }
    const cellStability = comparable > 0 ? stable / comparable : null;

    // Per-indicator run-pair Cohen's κ, averaged over all iteration pairs.
    const kappas: number[] = [];
    for (let i = 0; i < multiRun.length; i++) {
      for (let j = i + 1; j < multiRun.length; j++) {
        const pmi = multiRun[i].perMeasure?.[mid]?.verdictsByCompany;
        const pmj = multiRun[j].perMeasure?.[mid]?.verdictsByCompany;
        if (!pmi || !pmj) continue;
        const a: number[] = [];
        const b: number[] = [];
        for (const cid of Object.keys(pmi)) {
          if (pmj[cid] == null) continue;
          a.push(verdictToBinary(String(pmi[cid])));
          b.push(verdictToBinary(String(pmj[cid])));
        }
        if (a.length > 0) kappas.push(cohensKappaBinary(a, b));
      }
    }
    out.set(mid, { cellStability, kappa: kappas.length > 0 ? mean(kappas) : null });
  }
  return out;
}

function reliabilityMetrics(
  matrix: VerdictMatrix,
  multiRun: MultiRunIteration[],
  perInd: Map<string, PerIndicatorReliability>,
): MaximiseMetric[] {
  const runs = multiRun?.length ?? 0;
  const metrics: MaximiseMetric[] = [];

  // Overall cell-stability rate across all indicators.
  const stabilities = matrix.measureIds
    .map((mid) => perInd.get(mid)?.cellStability)
    .filter((x): x is number => x != null);
  const overallStability = stabilities.length > 0 ? mean(stabilities) : null;
  metrics.push({
    id: "cell-stability-overall",
    label: "Cell stability rate (overall)",
    role: "MAXIMISE",
    value: overallStability,
    observed: overallStability == null ? "needs ≥2 runs" : fmtPct(overallStability),
    detail:
      "Share of (company×indicator) cells with an identical verdict across all runs. Higher is better. Paired with the Discrimination gate so stability cannot be earned by a dead/universal measure.",
    status: runs < 2 ? "insufficient runs (need ≥2)" : undefined,
  });

  // Composite reproducibility: Spearman of composite scores between first & last
  // run + % of companies changing score band (tertile of composite).
  let compositeRepro: number | null = null;
  let bandChangeShare: number | null = null;
  if (runs >= 2) {
    const first = multiRun[0];
    const last = multiRun[multiRun.length - 1];
    const compositeFor = (it: MultiRunIteration): Map<string, number> => {
      const totals = new Map<string, number>();
      for (const mid of matrix.measureIds) {
        const vbc = it.perMeasure?.[mid]?.verdictsByCompany;
        if (!vbc) continue;
        for (const [cid, v] of Object.entries(vbc)) {
          totals.set(cid, (totals.get(cid) ?? 0) + verdictToBinary(String(v)));
        }
      }
      return totals;
    };
    const fa = compositeFor(first);
    const fb = compositeFor(last);
    const cids = [...fa.keys()].filter((c) => fb.has(c));
    if (cids.length >= 2) {
      compositeRepro = spearman(cids.map((c) => fa.get(c)!), cids.map((c) => fb.get(c)!));
      // Score band via tertiles of the first run.
      const band = (val: number, sorted: number[]): number => {
        const lo = sorted[Math.floor(sorted.length / 3)];
        const hi = sorted[Math.floor((2 * sorted.length) / 3)];
        return val <= lo ? 0 : val >= hi ? 2 : 1;
      };
      const sortedA = cids.map((c) => fa.get(c)!).slice().sort((x, y) => x - y);
      const sortedB = cids.map((c) => fb.get(c)!).slice().sort((x, y) => x - y);
      let changed = 0;
      for (const c of cids) {
        if (band(fa.get(c)!, sortedA) !== band(fb.get(c)!, sortedB)) changed++;
      }
      bandChangeShare = changed / cids.length;
    }
  }
  metrics.push({
    id: "composite-reproducibility",
    label: "Composite reproducibility (Spearman)",
    role: "MAXIMISE",
    value: compositeRepro,
    observed:
      compositeRepro == null
        ? "needs ≥2 runs"
        : `ρ=${compositeRepro.toFixed(2)}${bandChangeShare != null ? `, ${fmtPct(bandChangeShare)} changed band` : ""}`,
    detail:
      "Spearman rank correlation of composite scores between the first and last run, plus the share of companies changing score band. Higher correlation / lower band-change is better.",
    status: runs < 2 ? "insufficient runs (need ≥2)" : undefined,
  });

  // Instability concentration: Gini of flipped-cell counts per company (are the
  // flips concentrated in a few companies, or diffuse?).
  let instabilityConcentration: number | null = null;
  if (runs >= 2) {
    const flipsByCompany = new Map<string, number>();
    for (const mid of matrix.measureIds) {
      const perCompany = new Map<string, string[]>();
      for (const it of multiRun) {
        const vbc = it.perMeasure?.[mid]?.verdictsByCompany;
        if (!vbc) continue;
        for (const [cid, v] of Object.entries(vbc)) {
          if (v == null) continue;
          const arr = perCompany.get(cid) ?? [];
          arr.push(String(v));
          perCompany.set(cid, arr);
        }
      }
      for (const [cid, arr] of perCompany) {
        if (arr.length >= 2 && new Set(arr).size > 1) {
          flipsByCompany.set(cid, (flipsByCompany.get(cid) ?? 0) + 1);
        }
      }
    }
    if (flipsByCompany.size > 0) {
      instabilityConcentration = gini([...flipsByCompany.values()]);
    } else {
      instabilityConcentration = 0; // no flips at all
    }
  }
  metrics.push({
    id: "instability-concentration",
    label: "Instability concentration (Gini)",
    role: "MAXIMISE",
    value: instabilityConcentration,
    observed:
      instabilityConcentration == null ? "needs ≥2 runs" : instabilityConcentration.toFixed(2),
    detail:
      "Gini of the per-company flipped-cell count. High = instability concentrated in a few companies (often data-sparse); low with many flips = diffuse ambiguity. Diagnostic, reported not maximised directly.",
    status: runs < 2 ? "insufficient runs (need ≥2)" : undefined,
  });

  // Mean per-indicator κ (headline reliability signal).
  const kappas = matrix.measureIds
    .map((mid) => perInd.get(mid)?.kappa)
    .filter((x): x is number => x != null);
  const meanKappa = kappas.length > 0 ? mean(kappas) : null;
  metrics.push({
    id: "mean-run-pair-kappa",
    label: "Mean run-pair Cohen's κ",
    role: "MAXIMISE",
    value: meanKappa,
    observed: meanKappa == null ? "needs ≥2 runs" : meanKappa.toFixed(2),
    detail:
      "Chance-corrected run-to-run agreement per indicator (binary, imbalance-aware), averaged across indicators. Low-ρ indicators at N=50 are auto-shrunk in the Q objective.",
    status: runs < 2 ? "insufficient runs (need ≥2)" : undefined,
  });

  return metrics;
}

// ════════════════════════════════════════════════════════════════════════
//  Coherence–redundancy — MAXIMISE + near-duplication GATE (§4.2)
// ════════════════════════════════════════════════════════════════════════

function nearDuplicatePairs(
  matrix: VerdictMatrix,
  labelById: Map<string, string>,
): NearDuplicatePair[] {
  const pairs: NearDuplicatePair[] = [];
  const ids = matrix.measureIds;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = matrix.binary.get(ids[i])!;
      const b = matrix.binary.get(ids[j])!;
      const agreement = rawAgreement(a, b);
      const kappa = cohensKappaBinary(a, b);
      if (agreement >= QUALITY_GATE_THRESHOLDS.NEAR_DUP_AGREEMENT) {
        pairs.push({
          measureIdA: ids[i],
          measureIdB: ids[j],
          labelA: labelById.get(ids[i]) ?? ids[i],
          labelB: labelById.get(ids[j]) ?? ids[j],
          agreement,
          kappa,
          n: Math.min(a.length, b.length),
          recommendation: "merge-or-differentiate",
        });
      }
    }
  }
  // Ranked most-duplicated first.
  return pairs.sort((p, q) => q.agreement - p.agreement);
}

function coherenceMetrics(
  matrix: VerdictMatrix,
  pillarById: Map<string, string>,
  itemTotalById: Map<string, number>,
): { maximise: MaximiseMetric[]; gate: GateMetric[] } {
  const maximise: MaximiseMetric[] = [];
  const gate: GateMetric[] = [];
  const ids = matrix.measureIds;

  // Redundancy rate: within-pillar pairs with agreement ≥ threshold.
  const pillars = new Map<string, string[]>();
  for (const mid of ids) {
    const p = pillarById.get(mid) ?? "__all__";
    (pillars.get(p) ?? pillars.set(p, []).get(p)!).push(mid);
  }
  let withinPairs = 0;
  let redundantPairs = 0;
  for (const group of pillars.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        withinPairs++;
        const agr = rawAgreement(matrix.binary.get(group[i])!, matrix.binary.get(group[j])!);
        if (agr >= QUALITY_GATE_THRESHOLDS.REDUNDANCY_PAIR_AGREEMENT) redundantPairs++;
      }
    }
  }
  const redundancyRate = withinPairs > 0 ? redundantPairs / withinPairs : 0;
  // MAXIMISE contribution = minimise redundancy → report 1 − rate as "distinctness".
  maximise.push({
    id: "distinctness",
    label: "Distinctness (1 − within-pillar redundancy)",
    role: "MAXIMISE",
    value: 1 - redundancyRate,
    observed: `${redundantPairs}/${withinPairs} within-pillar pairs redundant → ${fmtPct(1 - redundancyRate)} distinct`,
    detail:
      "Redundancy is minimised, not internal consistency maximised (spec §1.1). Distinctness = 1 − share of within-pillar pairs with agreement ≥ the redundancy threshold.",
    status: withinPairs === 0 ? "no within-pillar pairs" : undefined,
  });

  // Contribution balance: max share of composite variance from any one indicator.
  const composite = compositeScores(matrix);
  const totalVar = variance(composite);
  let maxShare: number | null = null;
  if (totalVar > 0) {
    let mx = 0;
    for (const mid of ids) {
      // Variance contribution proxy: |cov(indicator, composite)| / totalVar.
      const bin = matrix.binary.get(mid)!;
      const cov = covariance(bin, composite);
      const share = Math.abs(cov) / totalVar;
      if (share > mx) mx = share;
    }
    maxShare = mx;
  }
  maximise.push({
    id: "contribution-balance",
    label: "Contribution balance (1 − max single-indicator share)",
    role: "MAXIMISE",
    value: maxShare == null ? null : 1 - Math.min(1, maxShare),
    observed: maxShare == null ? "no composite variance" : `max share ${fmtPct(Math.min(1, maxShare))}`,
    detail:
      "Higher when no single indicator dominates the composite variance. Prevents 'one indicator does all the work'.",
    status: maxShare == null ? "no composite variance" : undefined,
  });
  gate.push({
    id: "contribution-balance-gate",
    label: "Contribution balance ceiling",
    role: "GATE",
    value: maxShare,
    threshold: QUALITY_GATE_THRESHOLDS.CONTRIBUTION_BALANCE_MAX_SHARE,
    thresholdDirection: "max",
    passed: maxShare == null ? null : maxShare <= QUALITY_GATE_THRESHOLDS.CONTRIBUTION_BALANCE_MAX_SHARE,
    observed: maxShare == null ? "—" : fmtPct(maxShare),
    detail: "Max share of composite variance from any single indicator must stay below the ceiling.",
    status: maxShare == null ? "no composite variance" : undefined,
  });

  // Cross-pillar independence: mean absolute correlation between pillar composites.
  let crossPillar: number | null = null;
  const pillarComposites: number[][] = [];
  for (const group of pillars.values()) {
    if (group.length === 0) continue;
    const n = matrix.companyIds.length;
    const comp = new Array<number>(n).fill(0);
    for (const mid of group) {
      const bin = matrix.binary.get(mid)!;
      for (let i = 0; i < n; i++) comp[i] += bin[i];
    }
    pillarComposites.push(comp);
  }
  if (pillarComposites.length >= 2) {
    const corrs: number[] = [];
    for (let i = 0; i < pillarComposites.length; i++) {
      for (let j = i + 1; j < pillarComposites.length; j++) {
        corrs.push(Math.abs(pearson(pillarComposites[i], pillarComposites[j])));
      }
    }
    crossPillar = corrs.length > 0 ? mean(corrs) : null;
  }
  gate.push({
    id: "cross-pillar-independence",
    label: "Cross-pillar independence",
    role: "GATE",
    value: crossPillar,
    threshold: QUALITY_GATE_THRESHOLDS.CROSS_PILLAR_MAX_CORR,
    thresholdDirection: "max",
    passed: crossPillar == null ? null : crossPillar <= QUALITY_GATE_THRESHOLDS.CROSS_PILLAR_MAX_CORR,
    observed: crossPillar == null ? "needs ≥2 pillars" : crossPillar.toFixed(2),
    detail: "Mean inter-pillar correlation; near 1.0 means the pillars have collapsed into one construct.",
    status: crossPillar == null ? "needs ≥2 pillars" : undefined,
  });

  // KR-20 within pillar (gate band, not maximised). Report the mean across pillars.
  const kr20s: number[] = [];
  for (const group of pillars.values()) {
    const k = group.length;
    if (k < 2) continue;
    const composite = new Array<number>(matrix.companyIds.length).fill(0);
    for (const mid of group) {
      const bin = matrix.binary.get(mid)!;
      for (let i = 0; i < bin.length; i++) composite[i] += bin[i];
    }
    const totalVar = variance(composite);
    if (totalVar <= 0) continue;
    let sumPQ = 0;
    for (const mid of group) {
      const bin = matrix.binary.get(mid)!;
      const p = mean(bin);
      sumPQ += p * (1 - p);
    }
    kr20s.push((k / (k - 1)) * (1 - sumPQ / totalVar));
  }
  const kr20 = kr20s.length > 0 ? mean(kr20s) : null;
  gate.push({
    id: "kr20-band",
    label: "KR-20 within pillar (gate band)",
    role: "GATE",
    value: kr20,
    threshold: null, // band, see detail
    thresholdDirection: "band",
    passed:
      kr20 == null
        ? null
        : kr20 >= QUALITY_GATE_THRESHOLDS.KR20_FLOOR && kr20 <= QUALITY_GATE_THRESHOLDS.KR20_CEILING,
    observed: kr20 == null ? "needs ≥2 measures/pillar" : kr20.toFixed(2),
    detail: `Internal consistency as a BAND [${QUALITY_GATE_THRESHOLDS.KR20_FLOOR}, ${QUALITY_GATE_THRESHOLDS.KR20_CEILING}]. The ceiling stops near-duplicate indicators being rewarded as 'coherence'. Not maximised.`,
    status: kr20 == null ? "needs ≥2 measures/pillar" : undefined,
  });

  // Item–total (point-biserial) — computed once, shared with discrimination.
  const meanItemTotal = itemTotalById.size > 0 ? mean([...itemTotalById.values()]) : null;
  maximise.push({
    id: "item-total-mean",
    label: "Mean item–total (point-biserial)",
    role: "MAXIMISE",
    value: meanItemTotal,
    observed: meanItemTotal == null ? "—" : meanItemTotal.toFixed(2),
    detail:
      "Each indicator's point-biserial correlation with the rest-of-framework score, averaged. Shared with the Discrimination gate (computed once).",
    status: meanItemTotal == null ? "no indicators" : undefined,
  });

  return { maximise, gate };
}

function covariance(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}

/** Item–total point-biserial per measure (rest-of-framework total, leave-one-out). */
function itemTotalPerMeasure(matrix: VerdictMatrix): Map<string, number> {
  const out = new Map<string, number>();
  const n = matrix.companyIds.length;
  const composite = compositeScores(matrix);
  for (const mid of matrix.measureIds) {
    const bin = matrix.binary.get(mid)!;
    const rest = new Array<number>(n);
    for (let i = 0; i < n; i++) rest[i] = composite[i] - bin[i]; // leave-one-out
    out.set(mid, pointBiserial(bin, rest));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
//  Discrimination — GATE (§4.5)
// ════════════════════════════════════════════════════════════════════════

function discriminationMetrics(
  matrix: VerdictMatrix,
  multiRun: MultiRunIteration[],
  itemTotalById: Map<string, number>,
): GateMetric[] {
  const gate: GateMetric[] = [];
  const ids = matrix.measureIds;
  const n = matrix.companyIds.length;
  const T = QUALITY_GATE_THRESHOLDS;

  // Pass-rate band share.
  let inBand = 0;
  for (const mid of ids) {
    const p = mean(matrix.binary.get(mid)!);
    if (p >= T.PASS_RATE_BAND_LOW && p <= T.PASS_RATE_BAND_HIGH) inBand++;
  }
  const bandShare = ids.length > 0 ? inBand / ids.length : null;
  gate.push({
    id: "pass-rate-band-share",
    label: "Pass-rate band share",
    role: "GATE",
    value: bandShare,
    threshold: T.PASS_RATE_BAND_MIN_SHARE,
    thresholdDirection: "min",
    passed: bandShare == null ? null : bandShare >= T.PASS_RATE_BAND_MIN_SHARE,
    observed: bandShare == null ? "—" : `${inBand}/${ids.length} = ${fmtPct(bandShare)}`,
    detail: `Share of indicators with pass rate in the information-bearing band [${fmtPct(T.PASS_RATE_BAND_LOW)}, ${fmtPct(T.PASS_RATE_BAND_HIGH)}].`,
    status: ids.length === 0 ? "no indicators" : undefined,
  });

  // Floor/ceiling share.
  let extreme = 0;
  for (const mid of ids) {
    const p = mean(matrix.binary.get(mid)!);
    if (p === 0 || p === 1) extreme++;
  }
  const flcShare = ids.length > 0 ? extreme / ids.length : null;
  gate.push({
    id: "floor-ceiling-share",
    label: "Floor/ceiling share",
    role: "GATE",
    value: flcShare,
    threshold: T.FLOOR_CEILING_MAX_SHARE,
    thresholdDirection: "max",
    passed: flcShare == null ? null : flcShare <= T.FLOOR_CEILING_MAX_SHARE,
    observed: flcShare == null ? "—" : `${extreme}/${ids.length} = ${fmtPct(flcShare)}`,
    detail: "Share of indicators pinned at 0% or 100% pass rate (no discriminating power).",
    status: ids.length === 0 ? "no indicators" : undefined,
  });

  // Composite Gini.
  const composite = compositeScores(matrix);
  const g = composite.length > 0 ? gini(composite) : null;
  gate.push({
    id: "composite-gini",
    label: "Composite Gini",
    role: "GATE",
    value: g,
    threshold: T.COMPOSITE_GINI_MIN,
    thresholdDirection: "min",
    passed: g == null ? null : g >= T.COMPOSITE_GINI_MIN,
    observed: g == null ? "—" : g.toFixed(2),
    detail: "Gini of the composite score distribution; too low means everyone scores alike.",
    status: composite.length === 0 ? "no companies" : undefined,
  });

  // Effective differentiation: % of company pairs whose composite gap exceeds
  // 1.96·√2·SEM, where SEM is the run-to-run SD of the composite (spec §4.5).
  let sem: number | null = null;
  const runs = multiRun?.length ?? 0;
  if (runs >= 2) {
    // Per-company composite across runs → SD; average across companies = SEM proxy.
    const perCompanyComposites = new Map<string, number[]>();
    for (const it of multiRun) {
      const totals = new Map<string, number>();
      for (const mid of ids) {
        const vbc = it.perMeasure?.[mid]?.verdictsByCompany;
        if (!vbc) continue;
        for (const [cid, v] of Object.entries(vbc)) {
          totals.set(cid, (totals.get(cid) ?? 0) + verdictToBinary(String(v)));
        }
      }
      for (const [cid, tot] of totals) {
        const arr = perCompanyComposites.get(cid) ?? [];
        arr.push(tot);
        perCompanyComposites.set(cid, arr);
      }
    }
    const sds: number[] = [];
    for (const arr of perCompanyComposites.values()) {
      if (arr.length >= 2) sds.push(Math.sqrt(variance(arr)));
    }
    sem = sds.length > 0 ? mean(sds) : null;
  }
  let effDiff: number | null = null;
  if (sem != null && composite.length >= 2) {
    const crit = 1.96 * Math.SQRT2 * sem;
    let distinguishable = 0;
    let totalPairs = 0;
    for (let i = 0; i < composite.length; i++) {
      for (let j = i + 1; j < composite.length; j++) {
        totalPairs++;
        if (Math.abs(composite[i] - composite[j]) > crit) distinguishable++;
      }
    }
    effDiff = totalPairs > 0 ? distinguishable / totalPairs : null;
  }
  gate.push({
    id: "effective-differentiation",
    label: "Effective differentiation",
    role: "GATE",
    value: effDiff,
    threshold: T.EFFECTIVE_DIFFERENTIATION_MIN,
    thresholdDirection: "min",
    passed: effDiff == null ? null : effDiff >= T.EFFECTIVE_DIFFERENTIATION_MIN,
    observed: effDiff == null ? "needs ≥2 runs" : fmtPct(effDiff),
    detail: "Share of company pairs whose composite gap exceeds 1.96·√2·SEM (SEM from run-to-run SD) — i.e. are statistically distinguishable.",
    status: sem == null ? "needs ≥2 runs for SEM" : undefined,
  });

  // Score resolution: effective distinct score levels = 1 / Herfindahl.
  let resolution: number | null = null;
  if (composite.length > 0) {
    const counts = new Map<number, number>();
    for (const c of composite) counts.set(c, (counts.get(c) ?? 0) + 1);
    const h = herfindahl([...counts.values()]);
    resolution = h > 0 ? 1 / h : null;
  }
  gate.push({
    id: "score-resolution",
    label: "Score resolution (1 / Herfindahl)",
    role: "GATE",
    value: resolution,
    threshold: null,
    thresholdDirection: "min",
    passed: null, // no threshold set yet; reported for calibration
    observed: resolution == null ? "—" : resolution.toFixed(1),
    detail: "Effective number of distinct composite score levels. Reported for threshold calibration (no floor set yet).",
    status: composite.length === 0 ? "no companies" : undefined,
  });

  // Item–total correlation (shared with §4.2), reported as a discrimination gate.
  const meanItemTotal = itemTotalById.size > 0 ? mean([...itemTotalById.values()]) : null;
  gate.push({
    id: "item-total-discrimination",
    label: "Mean item–total correlation (shared)",
    role: "GATE",
    value: meanItemTotal,
    threshold: null,
    thresholdDirection: "min",
    passed: null,
    observed: meanItemTotal == null ? "—" : meanItemTotal.toFixed(2),
    detail: "Same point-biserial computation shared with Coherence §4.2 (computed once). Reported for calibration.",
    status: meanItemTotal == null ? "no indicators" : undefined,
  });

  return gate;
}

// ════════════════════════════════════════════════════════════════════════
//  Coverage — GATE (§4.6, Tier-1 answerability only)
// ════════════════════════════════════════════════════════════════════════

function coverageMetrics(
  results: TestDriveCompanyResult[],
  measureIds: string[],
): { gate: GateMetric[]; perIndicatorAnswerability: Map<string, number> } {
  const perIndicatorAnswerability = new Map<string, number>();
  const n = results.length;
  for (const mid of measureIds) {
    let evidenced = 0;
    for (const r of results) {
      const cell = r.measures.find((m) => m.measureId === mid);
      const v = cell?.verdict ?? "Insufficient evidence";
      // Answerable = coded Yes/No (spec §4.6). Partial counts as evidenced;
      // "Insufficient evidence" is the not-evidenced state.
      if (v !== "Insufficient evidence") evidenced++;
    }
    perIndicatorAnswerability.set(mid, n > 0 ? evidenced / n : 0);
  }
  const meanAns =
    perIndicatorAnswerability.size > 0 ? mean([...perIndicatorAnswerability.values()]) : null;
  const gate: GateMetric[] = [
    {
      id: "answerability",
      label: "Answerability rate",
      role: "GATE",
      value: meanAns,
      threshold: QUALITY_GATE_THRESHOLDS.ANSWERABILITY_MIN,
      thresholdDirection: "min",
      passed: meanAns == null ? null : meanAns >= QUALITY_GATE_THRESHOLDS.ANSWERABILITY_MIN,
      observed: meanAns == null ? "—" : fmtPct(meanAns),
      detail:
        "Mean share of companies coded Yes/No (vs Not-evidenced) per indicator. Low answerability means the corpus rarely lets the indicator be decided.",
      status: measureIds.length === 0 ? "no indicators" : undefined,
    },
  ];
  return { gate, perIndicatorAnswerability };
}

// ════════════════════════════════════════════════════════════════════════
//  Auditability — GATE (§4.4, Tier-1 quote-support seed)
// ════════════════════════════════════════════════════════════════════════

function auditabilityMetrics(
  results: TestDriveCompanyResult[],
  quoteSupport?: { quotesValid: number; quotesTotal: number },
): GateMetric[] {
  let value: number | null = null;
  let observed = "—";
  let source = "";
  if (quoteSupport && quoteSupport.quotesTotal > 0) {
    value = quoteSupport.quotesValid / quoteSupport.quotesTotal;
    observed = `${quoteSupport.quotesValid}/${quoteSupport.quotesTotal} = ${fmtPct(value)}`;
    source = "evidence-gate quotesValid/quotesTotal";
  } else {
    // Proxy: share of Yes cells carrying at least one quote.
    let yes = 0;
    let yesWithQuote = 0;
    for (const r of results) {
      for (const m of r.measures) {
        if (m.verdict === "Yes") {
          yes++;
          if ((m.quoteCount ?? 0) > 0) yesWithQuote++;
        }
      }
    }
    if (yes > 0) {
      value = yesWithQuote / yes;
      observed = `${yesWithQuote}/${yes} Yes cells quoted = ${fmtPct(value)}`;
      source = "quote-count proxy (gateResult not surfaced)";
    }
  }
  return [
    {
      id: "quote-support-seed",
      label: "Quote-support (seed)",
      role: "GATE",
      value,
      threshold: QUALITY_GATE_THRESHOLDS.QUOTE_SUPPORT_MIN,
      thresholdDirection: "min",
      passed: value == null ? null : value >= QUALITY_GATE_THRESHOLDS.QUOTE_SUPPORT_MIN,
      observed,
      detail: `Share of Yes evidence carrying a valid quote (${source || "no data"}). Seed only — full semantic quote-support is a Tier-1+LLM pass (deferred, §4.4).`,
      status: value == null ? "no Yes cells with data" : undefined,
    },
  ];
}

// ════════════════════════════════════════════════════════════════════════
//  Robustness — GATE (§4.7, Tier-1: retrieval + confidence-conditioned)
// ════════════════════════════════════════════════════════════════════════

function robustnessMetrics(
  measureIds: string[],
  multiRun: MultiRunIteration[],
  results: TestDriveCompanyResult[],
): GateMetric[] {
  const gate: GateMetric[] = [];
  const runs = multiRun?.length ?? 0;

  // Retrieval stability (Jaccard) — needs fingerprintsByCompany across ≥2 runs.
  let retrieval: number | null = null;
  let retrievalStatus: string | undefined;
  if (runs >= 2) {
    const jaccards: number[] = [];
    let anyFingerprints = false;
    for (const mid of measureIds) {
      // company → list of fingerprint sets (one per run that has them)
      const perCompany = new Map<string, Set<string>[]>();
      for (const it of multiRun) {
        const fp = it.perMeasure?.[mid]?.fingerprintsByCompany;
        if (!fp) continue;
        anyFingerprints = true;
        for (const [cid, sig] of Object.entries(fp)) {
          if (!sig) continue;
          // Fingerprint is a SHA1 of the sorted chunk-id set; treat each distinct
          // fingerprint string as an opaque set element. When the raw chunk-id
          // set is not available we compare fingerprint identity (Jaccard 1 if
          // identical, 0 if not) — a conservative lower bound on overlap.
          const arr = perCompany.get(cid) ?? [];
          arr.push(new Set([sig]));
          perCompany.set(cid, arr);
        }
      }
      for (const sets of perCompany.values()) {
        for (let i = 0; i < sets.length; i++) {
          for (let j = i + 1; j < sets.length; j++) {
            jaccards.push(jaccard(sets[i], sets[j]));
          }
        }
      }
    }
    if (!anyFingerprints) {
      retrievalStatus = "no evidence fingerprints stored in iterations (legacy rows)";
    } else if (jaccards.length > 0) {
      retrieval = mean(jaccards);
    }
  } else {
    retrievalStatus = "needs ≥2 runs";
  }
  gate.push({
    id: "retrieval-stability",
    label: "Retrieval stability (Jaccard)",
    role: "GATE",
    value: retrieval,
    threshold: QUALITY_GATE_THRESHOLDS.RETRIEVAL_STABILITY_MIN,
    thresholdDirection: "min",
    passed: retrieval == null ? null : retrieval >= QUALITY_GATE_THRESHOLDS.RETRIEVAL_STABILITY_MIN,
    observed: retrieval == null ? "—" : retrieval.toFixed(2),
    detail:
      "Mean Jaccard overlap of cited source-sets (evidenceFingerprint) for the same cell across runs. Low overlap means the answer rests on different evidence each time.",
    status: retrievalStatus,
  });

  // Confidence-conditioned stability: flip rate in low- vs high-confidence strata.
  // Uses the current run's per-cell confidence to stratify, and cross-run flips
  // (from confidenceByCompany when present, else verdictsByCompany) to measure.
  let lowFlip: number | null = null;
  let highFlip: number | null = null;
  let ccStatus: string | undefined;
  if (runs >= 2) {
    // Stratify each (measure, company) cell by the current-run confidence.
    const confByCell = new Map<string, string>(); // `${mid}::${cid}` → confidence
    for (const r of results) {
      for (const m of r.measures) {
        confByCell.set(`${m.measureId}::${r.companyId}`, (m.confidence || "").toLowerCase());
      }
    }
    let lowComparable = 0;
    let lowFlipped = 0;
    let highComparable = 0;
    let highFlipped = 0;
    for (const mid of measureIds) {
      const perCompany = new Map<string, string[]>();
      for (const it of multiRun) {
        const vbc = it.perMeasure?.[mid]?.verdictsByCompany;
        if (!vbc) continue;
        for (const [cid, v] of Object.entries(vbc)) {
          if (v == null) continue;
          const arr = perCompany.get(cid) ?? [];
          arr.push(String(v));
          perCompany.set(cid, arr);
        }
      }
      for (const [cid, arr] of perCompany) {
        if (arr.length < 2) continue;
        const flipped = new Set(arr).size > 1;
        const conf = confByCell.get(`${mid}::${cid}`) ?? "";
        const isLow = conf.includes("low");
        const isHigh = conf.includes("high");
        if (isLow) {
          lowComparable++;
          if (flipped) lowFlipped++;
        } else if (isHigh) {
          highComparable++;
          if (flipped) highFlipped++;
        }
      }
    }
    lowFlip = lowComparable > 0 ? lowFlipped / lowComparable : null;
    highFlip = highComparable > 0 ? highFlipped / highComparable : null;
    if (lowFlip == null && highFlip == null) ccStatus = "no stratifiable confidence data";
  } else {
    ccStatus = "needs ≥2 runs";
  }
  // The gate value we surface = high-confidence flip rate (should be LOW: a
  // confident cell that still flips is the worst case). Reported with both strata.
  gate.push({
    id: "confidence-conditioned-stability",
    label: "Confidence-conditioned stability",
    role: "GATE",
    value: highFlip,
    threshold: null, // band/context-dependent; reported for calibration
    thresholdDirection: "max",
    passed: null,
    observed:
      lowFlip == null && highFlip == null
        ? "—"
        : `low-conf flip ${fmtPct(lowFlip)} vs high-conf flip ${fmtPct(highFlip)}`,
    detail:
      "Flip rate split by stored confidence. High-confidence cells that still flip are the most concerning; low-conf flips are expected. Reported for calibration (no threshold set yet).",
    status: ccStatus,
  });

  return gate;
}

// ════════════════════════════════════════════════════════════════════════
//  Transparency — GATE (§4.10, Tier-1 spec-completeness)
// ════════════════════════════════════════════════════════════════════════

const SPEC_CHECKLIST_KEYS: Array<keyof MeasureSpecFields> = [
  "definition",
  "inclusion",
  "exclusion",
  "evidenceStandard",
  "borderlineExamples",
];

function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function transparencyMetrics(
  measureIds: string[],
  measureSpecs?: Record<string, MeasureSpecFields>,
): { gate: GateMetric[]; perIndicator: Map<string, number | null> } {
  const perIndicator = new Map<string, number | null>();
  if (!measureSpecs) {
    for (const mid of measureIds) perIndicator.set(mid, null);
    return {
      gate: [
        {
          id: "spec-completeness",
          label: "Spec completeness",
          role: "GATE",
          value: null,
          threshold: QUALITY_GATE_THRESHOLDS.SPEC_COMPLETENESS_MIN,
          thresholdDirection: "min",
          passed: null,
          observed: "—",
          detail:
            "Per-indicator checklist: definition, inclusion, exclusion, evidence standard, borderline examples. No spec fields supplied.",
          status: "no spec fields supplied",
        },
      ],
      perIndicator,
    };
  }
  const scores: number[] = [];
  for (const mid of measureIds) {
    const spec = measureSpecs[mid];
    if (!spec) {
      perIndicator.set(mid, 0);
      scores.push(0);
      continue;
    }
    let present = 0;
    for (const key of SPEC_CHECKLIST_KEYS) if (isPresent(spec[key])) present++;
    const score = present / SPEC_CHECKLIST_KEYS.length;
    perIndicator.set(mid, score);
    scores.push(score);
  }
  const meanScore = scores.length > 0 ? mean(scores) : null;
  return {
    gate: [
      {
        id: "spec-completeness",
        label: "Spec completeness",
        role: "GATE",
        value: meanScore,
        threshold: QUALITY_GATE_THRESHOLDS.SPEC_COMPLETENESS_MIN,
        thresholdDirection: "min",
        passed: meanScore == null ? null : meanScore >= QUALITY_GATE_THRESHOLDS.SPEC_COMPLETENESS_MIN,
        observed: meanScore == null ? "—" : fmtPct(meanScore),
        detail:
          "Mean per-indicator checklist score over {definition, inclusion, exclusion, evidence standard, borderline examples}.",
        status: measureIds.length === 0 ? "no indicators" : undefined,
      },
    ],
    perIndicator,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  Q maximise objective (spec §3)
// ════════════════════════════════════════════════════════════════════════

/** Standardise values to z-scores (higher = better assumed already). sd==0 → 0s. */
function zscore(values: number[]): number[] {
  const m = mean(values);
  const sd = Math.sqrt(variance(values));
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (v - m) / sd);
}

/**
 * Reliability-weighted standardised dimension mean:
 *   S_d = Σ_i (λ_i·ρ_i·z_i) / Σ_i (λ_i·ρ_i)
 * λ_i defaults equal (1) within a dimension (spec §3.1). z_i is standardised
 * across the indicator set. ρ_i is the shrinkage from computeRhoPerMeasure.
 *
 * NOTE (documented limitation at N=50 / single framework): with no historical
 * baseline the z-scores are standardised WITHIN the current indicator set, so
 * S_d reflects whether the high-reliability indicators are also the high-scoring
 * ones (a within-framework signal). Across iterations the caller can feed a
 * baseline to make Q monotone over time. This is faithful to §3.1 while honest
 * about what a single N=50 run can support.
 */
function dimensionScore(
  rawByMeasure: Map<string, number>,
  rhoByMeasure: Map<string, number>,
): { S_d: number | null; meanRho: number | null; count: number } {
  const ids = [...rawByMeasure.keys()];
  if (ids.length === 0) return { S_d: null, meanRho: null, count: 0 };
  const raw = ids.map((id) => rawByMeasure.get(id)!);
  const z = zscore(raw);
  const rho = ids.map((id) => rhoByMeasure.get(id) ?? 1);
  let num = 0;
  let den = 0;
  for (let i = 0; i < ids.length; i++) {
    const lambda = 1; // equal within dimension (spec §3.1 default)
    num += lambda * rho[i] * z[i];
    den += lambda * rho[i];
  }
  return {
    S_d: den > 0 ? num / den : null,
    meanRho: mean(rho),
    count: ids.length,
  };
}

function computeQ(
  matrix: VerdictMatrix,
  rhoByMeasure: Map<string, number>,
  reliabilityById: Map<string, PerIndicatorReliability>,
  itemTotalById: Map<string, number>,
  results: TestDriveCompanyResult[],
): QualityMetricsReport["q"] {
  const ids = matrix.measureIds;

  // Per-measure raw indicator values (direction-corrected, higher = better):
  //  • reliability          → per-indicator cell stability (fallback: 1 when no
  //                            runs, so it contributes neutrally).
  //  • coherenceRedundancy  → item–total correlation (higher = coheres with the
  //                            construct without being a duplicate; near-dups are
  //                            caught by the separate gate).
  //  • accuracy (proxy)     → per-indicator quote-support share on Yes cells.
  const relRaw = new Map<string, number>();
  const cohRaw = new Map<string, number>();
  const accRaw = new Map<string, number>();
  for (const mid of ids) {
    const stab = reliabilityById.get(mid)?.cellStability;
    relRaw.set(mid, stab == null ? 1 : stab);
    cohRaw.set(mid, itemTotalById.get(mid) ?? 0);
    // quote-support proxy per measure
    let yes = 0;
    let quoted = 0;
    for (const r of results) {
      const cell = r.measures.find((m) => m.measureId === mid);
      if (cell?.verdict === "Yes") {
        yes++;
        if ((cell.quoteCount ?? 0) > 0) quoted++;
      }
    }
    accRaw.set(mid, yes > 0 ? quoted / yes : 1); // neutral 1 when no Yes cells
  }

  const relS = dimensionScore(relRaw, rhoByMeasure);
  const cohS = dimensionScore(cohRaw, rhoByMeasure);
  const accS = dimensionScore(accRaw, rhoByMeasure);

  const dims: QDimensionScore[] = [
    {
      dimension: "reliability",
      weight: Q_IMPORTANCE_WEIGHTS.reliability,
      S_d: relS.S_d,
      meanRho: relS.meanRho,
      indicatorCount: relS.count,
    },
    {
      dimension: "coherenceRedundancy",
      weight: Q_IMPORTANCE_WEIGHTS.coherenceRedundancy,
      S_d: cohS.S_d,
      meanRho: cohS.meanRho,
      indicatorCount: cohS.count,
    },
    {
      dimension: "accuracy",
      weight: Q_IMPORTANCE_WEIGHTS.accuracy,
      S_d: accS.S_d,
      meanRho: accS.meanRho,
      indicatorCount: accS.count,
    },
  ];

  const qFor = (w: { reliability: number; coherenceRedundancy: number; accuracy: number }): number | null => {
    const parts: Array<[number, number | null]> = [
      [w.reliability, relS.S_d],
      [w.coherenceRedundancy, cohS.S_d],
      [w.accuracy, accS.S_d],
    ];
    let sum = 0;
    let wsum = 0;
    for (const [wd, sd] of parts) {
      if (sd == null) continue;
      sum += wd * sd;
      wsum += wd;
    }
    return wsum > 0 ? sum / wsum : null; // renormalise if a dimension is null
  };

  const Q = qFor(Q_IMPORTANCE_WEIGHTS);

  // ── Weight-sensitivity guard (spec §3.4.2) ──────────────────────────────
  // Perturb each w_d within ± band (re-normalised), recompute Q, and check the
  // dimension ranking (by w_d·S_d) is preserved. If Q's spread is large or the
  // ranking flips, the composite is flagged indeterminate.
  const band = Q_WEIGHT_SENSITIVITY_BAND;
  const perturbations: Array<{ reliability: number; coherenceRedundancy: number; accuracy: number }> = [];
  const base = Q_IMPORTANCE_WEIGHTS;
  const deltas = [-band, 0, band];
  for (const dR of deltas) {
    for (const dC of deltas) {
      for (const dA of deltas) {
        const w = {
          reliability: Math.max(0, base.reliability + dR),
          coherenceRedundancy: Math.max(0, base.coherenceRedundancy + dC),
          accuracy: Math.max(0, base.accuracy + dA),
        };
        const s = w.reliability + w.coherenceRedundancy + w.accuracy;
        if (s <= 0) continue;
        perturbations.push({
          reliability: w.reliability / s,
          coherenceRedundancy: w.coherenceRedundancy / s,
          accuracy: w.accuracy / s,
        });
      }
    }
  }
  const qs = perturbations.map(qFor).filter((x): x is number => x != null);
  const baseRank = dims
    .map((d) => ({ dim: d.dimension, contrib: (d.S_d ?? 0) * d.weight }))
    .sort((a, b) => b.contrib - a.contrib)
    .map((x) => x.dim)
    .join(">");
  let rankStable = true;
  for (const w of perturbations) {
    const rank = [
      { dim: "reliability", contrib: (relS.S_d ?? 0) * w.reliability },
      { dim: "coherenceRedundancy", contrib: (cohS.S_d ?? 0) * w.coherenceRedundancy },
      { dim: "accuracy", contrib: (accS.S_d ?? 0) * w.accuracy },
    ]
      .sort((a, b) => b.contrib - a.contrib)
      .map((x) => x.dim)
      .join(">");
    if (rank !== baseRank) {
      rankStable = false;
      break;
    }
  }
  const qRange: [number, number] | null =
    qs.length > 0 ? [Math.min(...qs), Math.max(...qs)] : null;
  const spread = qRange ? qRange[1] - qRange[0] : 0;
  const weightSensitivity: WeightSensitivityGuard = {
    stable: rankStable && spread < 0.5,
    qBaseline: Q,
    qRange,
    dimensionRankStable: rankStable,
    note: rankStable
      ? `Dimension ranking held across ±${band} weight perturbations (Q spread ${spread.toFixed(2)}).`
      : `Dimension ranking FLIPPED under ±${band} weight perturbation — treat Q ranking as indeterminate (spec §3.4.2).`,
  };

  return {
    Q,
    dimensions: dims,
    weightSensitivity,
    note:
      "Q = Σ w_d·S_d over {reliability, coherence-redundancy, accuracy-proxy}; S_d = Σ(λ_i·ρ_i·z_i)/Σ(λ_i·ρ_i). Weights pre-registered (Q_IMPORTANCE_WEIGHTS); λ_i equal within dimension; ρ_i automatic inverse-variance shrinkage. At N=50 with no historical baseline, z_i is standardised within the current indicator set.",
  };
}

// ════════════════════════════════════════════════════════════════════════
//  Top-level entry point
// ════════════════════════════════════════════════════════════════════════

export function computeQualityMetrics(input: QualityMetricsInput): QualityMetricsReport {
  const { results, measureMetadata, quoteSupport } = input;
  const multiRun = input.multiRun ?? [];
  const measureIds = Array.from(new Set(measureMetadata.map((m) => m.measureId)));
  const n = results.length; // actual N — never hardcoded
  const runs = multiRun.length;

  const labelById = new Map<string, string>();
  const pillarById = new Map<string, string>();
  for (const m of measureMetadata) {
    labelById.set(m.measureId, m.title || m.measureId);
    if (m.pillar) pillarById.set(m.measureId, m.pillar);
  }

  const matrix = buildMatrix(results, measureIds);
  const itemTotalById = itemTotalPerMeasure(matrix); // computed ONCE, shared
  const rhoByMeasure = computeRhoPerMeasure(measureIds, results, multiRun);
  const reliabilityById = reliabilityPerIndicator(measureIds, multiRun);

  const reliability = reliabilityMetrics(matrix, multiRun, reliabilityById);
  const coherence = coherenceMetrics(matrix, pillarById, itemTotalById);
  const discrimination = discriminationMetrics(matrix, multiRun, itemTotalById);
  const coverage = coverageMetrics(results, measureIds);
  const auditability = auditabilityMetrics(results, quoteSupport);
  const robustness = robustnessMetrics(measureIds, multiRun, results);
  const transparency = transparencyMetrics(measureIds, input.measureSpecs);
  const nearDup = nearDuplicatePairs(matrix, labelById);
  const q = computeQ(matrix, rhoByMeasure, reliabilityById, itemTotalById, results);

  // Per-indicator roll-up for the UI (pass rate / band / answerability /
  // stability / κ / spec completeness).
  const perIndicator: PerIndicatorMetric[] = measureIds.map((mid) => {
    const passRate = mean(matrix.binary.get(mid)!);
    const rel = reliabilityById.get(mid);
    return {
      measureId: mid,
      label: labelById.get(mid) ?? mid,
      passRate,
      inInformationBand:
        passRate >= QUALITY_GATE_THRESHOLDS.PASS_RATE_BAND_LOW &&
        passRate <= QUALITY_GATE_THRESHOLDS.PASS_RATE_BAND_HIGH,
      answerability: coverage.perIndicatorAnswerability.get(mid) ?? 0,
      cellStability: rel?.cellStability ?? null,
      kappa: rel?.kappa ?? null,
      specCompleteness: transparency.perIndicator.get(mid) ?? null,
    };
  });

  return {
    n,
    runs,
    reliability,
    coherenceRedundancy: coherence.maximise,
    discrimination,
    coverage: coverage.gate,
    auditability,
    robustness,
    transparency: transparency.gate,
    nearDuplicatePairs: nearDup,
    perIndicator,
    q,
    thresholdsAreDeferred: true,
  };
}

// Re-export the coherence GATE metrics (cross-pillar independence, KR-20 band,
// contribution-balance ceiling) via the report by folding them into coverage's
// sibling list would be confusing; instead they are attached here so the API can
// surface them under coherence. We expose a helper the route uses.
export function coherenceGateMetrics(input: QualityMetricsInput): GateMetric[] {
  const measureIds = Array.from(new Set(input.measureMetadata.map((m) => m.measureId)));
  const matrix = buildMatrix(input.results, measureIds);
  const pillarById = new Map<string, string>();
  for (const m of input.measureMetadata) if (m.pillar) pillarById.set(m.measureId, m.pillar);
  const itemTotalById = itemTotalPerMeasure(matrix);
  return coherenceMetrics(matrix, pillarById, itemTotalById).gate;
}

// ════════════════════════════════════════════════════════════════════════
//  DEFERRED — Tier-2 / Layer-2 / Tier-3 (NOT implemented in this slice)
//  ────────────────────────────────────────────────────────────────────────
//  TODO(Tier-2, spec §4.4/§4.6/§4.8/§4.9): once company size, country-income
//    group, disclosure regime, dated-source and source-type classification are
//    captured, add: coverage-equity gap, disclosure-capacity confound, source-
//    type concentration (Herfindahl of typed sources), recency compliance,
//    no-cell search completeness, source-proximity.
//  TODO(Layer-2, spec §2/§4.8/§4.9): validation report over the full universe
//    (300–500+ companies) — identity-share regression (R² of composite on
//    country+sector+size dummies), per-indicator group effects (η²), disclosure-
//    regime effect, convergent/discriminant factor structure. Degenerate at
//    N=50; NOT part of the loop.
//  TODO(Tier-3, spec §2/§4.3/§4.10): assurance layer — spot-check adjudication +
//    evidence-legibility UI (shared rubric), labelled gold set (gold-set
//    accuracy), perturbation-agreement robustness (paraphrase / shifted-window /
//    model-version extra runs). These are the accuracy CHECKPOINTS that
//    recalibrate the Q proxies; the loop never claims reality-match it has not
//    measured.
//  TODO(annotations, spec §7): expected-direction annotation per indicator
//    (lets the same group-gap statistic PASS validity and FAIL bias), contradiction
//    indicator-pairs (automatic contradiction rate), KR-20 gate band final
//    numbers, importance weights w_d, target universe.
// ════════════════════════════════════════════════════════════════════════
