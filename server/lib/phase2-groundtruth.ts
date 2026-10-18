/**
 * phase2-groundtruth.ts — WP05/Phase 2 (Ground truth, Issue 2).
 *
 * WHY (readiness-review plan §"Phase 2 — Ground truth (Issue 2)"):
 *   Today the scorer grades its own homework: the A5/B5 "recall"/"decisive"
 *   proofs use the SAME keyword oracle (`evidence-recall.ts`) the scorer uses, so
 *   they are CIRCULAR and cannot catch the scorer's blind spots. Phase 2 builds a
 *   small, FIXED, human-labelled answer key (the holdout) and makes it the
 *   STANDING REGRESSION GATE for every later scoring/retrieval change. The gate's
 *   authoritative truth is HUMAN-adjudicated — never the scorer's own logic.
 *
 * WHAT THIS MODULE IS (pure, offline, framework-level):
 *   1. HOLDOUT SELECTION — `selectHoldout()` deterministically draws a stratified
 *      ~250–300-cell (company × measure) holdout from supplied run observations +
 *      a config roster. Same seed ⇒ identical set (reproducible). No I/O.
 *   2. LABEL SCHEMA — `HoldoutLabel` with an AUTHORITATIVE `human_label`
 *      (Yes/No/Unsure, default PENDING), a SEPARATE non-authoritative
 *      `provisional_suggestion`, labeller id, doc/passage, timestamp, 20%-overlap
 *      flag; validated by `validateHoldoutLabel()` / `validateLabelFile()`.
 *   3. STANDING GATE — `computeGate()` computes Yes precision & recall (with
 *      Wilson confidence intervals), split by complete/incomplete research, AND
 *      the TOTAL cells flipping Yes→No / No→Yes vs the oracle-era baseline
 *      (constraint 4 — the split, not the net). Emits pass/fail vs configurable
 *      (clearly-illustrative) thresholds, and returns "ground-truth-pending — gate
 *      not armed" when no authoritative human labels exist — it NEVER fabricates a
 *      pass or invents precision/recall numbers.
 *
 * HONESTY / ANTI-CIRCULARITY (hard constraint):
 *   The gate's authoritative label is `human_label`. A `provisional_suggestion`
 *   (optionally produced by an INDEPENDENT model family, stored separately) is for
 *   analyst triage ONLY — `computeGate()` never reads it as truth. With human
 *   labels absent the gate is "not armed".
 *
 * SCOPE / SAFETY:
 *   - PURE / total: no DB, no network, no live LLM. Fully unit-testable offline
 *     with synthetic labels (see phase2-groundtruth.test.ts).
 *   - FRAMEWORK-LEVEL: no company-specific or topic-specific branches. The company
 *     roster and stratification parameters are DATA/CONFIG passed in.
 *   - INERT AT RUNTIME: nothing here is wired into the scoring pipeline. It runs in
 *     the builder/CI against the FIXED holdout only ⇒ production scoring of ANY
 *     volume triggers ZERO per-company human input (constraint 7). No scoring
 *     surface is touched ⇒ Total cells Y→N = 0, N→Y = 0 at runtime by construction.
 */

import { normaliseVerdict, type Verdict } from "./variability-stability.js";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic, seedable PRNG (xmur3 seed hash → mulberry32). Pure, no deps.
// Same seed string ⇒ identical stream ⇒ reproducible selection.
// ─────────────────────────────────────────────────────────────────────────────
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A seeded RNG from a string seed. Deterministic across runs & platforms. */
export function seededRng(seed: string): () => number {
  const s = xmur3(seed);
  return mulberry32(s());
}
/** Deterministic Fisher–Yates shuffle driven by a seeded RNG (pure; copies input). */
export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection inputs (DATA/CONFIG — framework-level, no hardcoded company branches)
// ─────────────────────────────────────────────────────────────────────────────

/** One observation of a (company × measure) cell in ONE replay run. */
export interface RunCellObservation {
  companyId: number;
  companyName: string;
  /** Measure identity = the measure title (the run artifacts carry no measureId). */
  measureTitle: string;
  category?: string | null;
  runIndex: number;
  /** The model verdict for this cell in this run (cascade.verdict). */
  verdict: Verdict;
  /** Document the verdict relied on (top evidence doc), where present. */
  docRef?: string | null;
  /** Passage/fingerprint the verdict relied on (top evidence passage), where present. */
  passageRef?: string | null;
  /** Research-complete vs incomplete for this cell, where derivable. null = unknown. */
  researchComplete?: boolean | null;
}

/** A roster entry (config/data). Non-English filers with NO run artifacts are kept
 *  as placeholders flagged `needs-evidence` so the selection logic stays generic. */
export interface RosterCompany {
  companyId: number;
  companyName: string;
  /** Marks a non-English filer for coverage constraint (e). Framework-level flag. */
  nonEnglish?: boolean;
  /** Optional: restrict placeholder cells to these measure titles; else all seen. */
  placeholderMeasures?: string[];
}

export type HoldoutStratum =
  | "current-yes" // (a) all current Yes cells
  | "unstable" // (b) historically-unstable cells (flip across runs)
  | "low-yield-company" // (c) ≤N-of-M ("0/36-type") companies' cells
  | "random-no" // (d) random sample of No cells
  | "non-english-placeholder"; // (e) placeholder cells for non-English filers w/o artifacts

export interface HoldoutSelectionConfig {
  /** Reproducibility seed. Same seed + inputs ⇒ identical manifest. */
  seed: string;
  /** Target holdout size (plan: ~250–300). Selection fills up to this budget. */
  targetSize?: number;
  /** A company is "low-yield" (0/36-type) if its current-Yes count ≤ this. */
  lowYieldYesThreshold?: number;
  /** Minimum number of non-English filers that must be represented. */
  minNonEnglishFilers?: number;
  /** Roster (config/data). Drives non-English coverage + placeholder cells. */
  roster?: RosterCompany[];
  /** Framework version string recorded in the manifest header (provenance). */
  frameworkVersion?: string;
}

export const DEFAULT_SELECTION_CONFIG: Required<
  Omit<HoldoutSelectionConfig, "seed" | "roster" | "frameworkVersion">
> = {
  targetSize: 280,
  lowYieldYesThreshold: 2,
  minNonEnglishFilers: 2,
};

/** A single selected holdout cell (the fixed yardstick's unit). */
export interface HoldoutCell {
  /** Stable, content-independent key: `${companyId}::${slug(measureTitle)}`. */
  cellKey: string;
  companyId: number;
  companyName: string;
  measureTitle: string;
  category: string | null;
  /** The CURRENT model verdict (baseline run), or null for needs-evidence placeholders. */
  modelVerdict: Verdict | null;
  /** The stratum this cell was drawn from (primary; priority a>b>c>d, e separate). */
  stratum: HoldoutStratum;
  /** Document the model verdict relied on (from run artifacts), where present. */
  docRef: string | null;
  /** Passage/fingerprint the model verdict relied on, where present. */
  passageRef: string | null;
  /** Research-complete vs incomplete where available; null = unknown. */
  researchComplete: boolean | null;
  /** True if this filer is non-English (coverage constraint e). */
  nonEnglish: boolean;
  /** True for roster placeholders with no run artifacts (flagged needs-evidence). */
  needsEvidence: boolean;
  /** Per-cell flip count across the supplied runs (0 ⇒ stable). */
  runFlips: number;
}

export interface HoldoutManifest {
  version: 1;
  generatedFromSeed: string;
  frameworkVersion: string | null;
  config: Required<Omit<HoldoutSelectionConfig, "seed" | "roster" | "frameworkVersion">>;
  counts: {
    total: number;
    byStratum: Record<HoldoutStratum, number>;
    nonEnglishFilers: number;
    needsEvidence: number;
  };
  cells: HoldoutCell[];
}

/** Stable slug for a measure title (lowercase, alnum→-, collapse). Pure. */
export function slugifyMeasure(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Stable cell key for a (company, measure) pair. */
export function makeCellKey(companyId: number, measureTitle: string): string {
  return `${companyId}::${slugifyMeasure(measureTitle)}`;
}

interface CellAgg {
  companyId: number;
  companyName: string;
  measureTitle: string;
  category: string | null;
  baselineRunIndex: number;
  baselineVerdict: Verdict;
  verdicts: Verdict[];
  docRef: string | null;
  passageRef: string | null;
  researchComplete: boolean | null;
  runFlips: number;
}

/**
 * Deterministically select a stratified holdout from run observations + roster.
 *
 * Strata are assigned by PRIORITY so each cell appears exactly once:
 *   (a) current-yes  →  (b) unstable  →  (c) low-yield-company  →  (d) random-no.
 * Then (e) ensures ≥ minNonEnglishFilers non-English filers are represented,
 * appending roster placeholders (needs-evidence) for non-English filers that have
 * no run artifacts. Pure & reproducible: same seed + inputs ⇒ identical manifest.
 */
export function selectHoldout(
  observations: readonly RunCellObservation[],
  cfg: HoldoutSelectionConfig,
): HoldoutManifest {
  const config = {
    targetSize: cfg.targetSize ?? DEFAULT_SELECTION_CONFIG.targetSize,
    lowYieldYesThreshold:
      cfg.lowYieldYesThreshold ?? DEFAULT_SELECTION_CONFIG.lowYieldYesThreshold,
    minNonEnglishFilers:
      cfg.minNonEnglishFilers ?? DEFAULT_SELECTION_CONFIG.minNonEnglishFilers,
  };
  const roster = cfg.roster ?? [];
  const nonEnglishIds = new Set(
    roster.filter((r) => r.nonEnglish).map((r) => r.companyId),
  );

  // 1. Aggregate observations → one CellAgg per (company, measure).
  const cells = new Map<string, CellAgg>();
  for (const o of observations) {
    const key = makeCellKey(o.companyId, o.measureTitle);
    let c = cells.get(key);
    if (!c) {
      c = {
        companyId: o.companyId,
        companyName: o.companyName,
        measureTitle: o.measureTitle,
        category: o.category ?? null,
        baselineRunIndex: o.runIndex,
        baselineVerdict: normaliseVerdict(o.verdict),
        verdicts: [],
        docRef: o.docRef ?? null,
        passageRef: o.passageRef ?? null,
        researchComplete: o.researchComplete ?? null,
        runFlips: 0,
      };
      cells.set(key, c);
    }
    // Baseline = lowest runIndex (deterministic), capture its doc/passage refs.
    if (o.runIndex < c.baselineRunIndex) {
      c.baselineRunIndex = o.runIndex;
      c.baselineVerdict = normaliseVerdict(o.verdict);
      c.docRef = o.docRef ?? c.docRef;
      c.passageRef = o.passageRef ?? c.passageRef;
      if (o.researchComplete != null) c.researchComplete = o.researchComplete;
    }
    c.verdicts.push(normaliseVerdict(o.verdict));
  }

  // 2. Per-cell flip count across runs (vs baseline verdict).
  for (const c of cells.values()) {
    c.runFlips = c.verdicts.filter((v) => v !== c.baselineVerdict).length;
  }

  // 3. Per-company current-Yes counts (for low-yield / 0-of-M detection).
  const yesByCompany = new Map<number, number>();
  const measuresByCompany = new Map<number, number>();
  for (const c of cells.values()) {
    measuresByCompany.set(c.companyId, (measuresByCompany.get(c.companyId) ?? 0) + 1);
    if (c.baselineVerdict === "Yes")
      yesByCompany.set(c.companyId, (yesByCompany.get(c.companyId) ?? 0) + 1);
  }
  const lowYieldCompanies = new Set<number>();
  for (const [cid, total] of measuresByCompany) {
    if (total > 0 && (yesByCompany.get(cid) ?? 0) <= config.lowYieldYesThreshold)
      lowYieldCompanies.add(cid);
  }

  // 4. Assign a primary stratum by priority. Iterate cells in a STABLE key order.
  const sortedKeys = [...cells.keys()].sort();
  const yesCells: string[] = [];
  const unstableCells: string[] = [];
  const lowYieldCells: string[] = [];
  const noCells: string[] = [];
  for (const key of sortedKeys) {
    const c = cells.get(key)!;
    if (c.baselineVerdict === "Yes") yesCells.push(key);
    else if (c.runFlips > 0) unstableCells.push(key);
    else if (lowYieldCompanies.has(c.companyId)) lowYieldCells.push(key);
    else noCells.push(key);
  }

  // 5. Fill the holdout up to targetSize: take all of (a),(b),(c), then a
  //    deterministic random sample of (d) No cells to reach the budget.
  const rng = seededRng(cfg.seed);
  const chosen: Array<{ key: string; stratum: HoldoutStratum }> = [];
  for (const k of yesCells) chosen.push({ key: k, stratum: "current-yes" });
  for (const k of unstableCells) chosen.push({ key: k, stratum: "unstable" });
  for (const k of lowYieldCells) chosen.push({ key: k, stratum: "low-yield-company" });
  const remaining = Math.max(0, config.targetSize - chosen.length);
  const shuffledNo = seededShuffle(noCells, rng);
  for (const k of shuffledNo.slice(0, remaining))
    chosen.push({ key: k, stratum: "random-no" });

  // 6. Materialise chosen cells.
  const out: HoldoutCell[] = chosen.map(({ key, stratum }) => {
    const c = cells.get(key)!;
    return {
      cellKey: key,
      companyId: c.companyId,
      companyName: c.companyName,
      measureTitle: c.measureTitle,
      category: c.category,
      modelVerdict: c.baselineVerdict,
      stratum,
      docRef: c.docRef,
      passageRef: c.passageRef,
      researchComplete: c.researchComplete,
      nonEnglish: nonEnglishIds.has(c.companyId),
      needsEvidence: false,
      runFlips: c.runFlips,
    };
  });

  // 7. (e) Non-English coverage. Count filers already represented; if below the
  //    minimum, append placeholder cells (needs-evidence) for roster non-English
  //    filers that have NO run artifacts — keeping selection logic generic.
  const representedNonEnglish = new Set(
    out.filter((c) => c.nonEnglish).map((c) => c.companyId),
  );
  if (representedNonEnglish.size < config.minNonEnglishFilers) {
    const measureUniverse = [...new Set([...cells.values()].map((c) => c.measureTitle))].sort();
    for (const r of roster) {
      if (representedNonEnglish.size >= config.minNonEnglishFilers) break;
      if (!r.nonEnglish) continue;
      if (representedNonEnglish.has(r.companyId)) continue;
      const hasArtifacts = [...cells.values()].some((c) => c.companyId === r.companyId);
      if (hasArtifacts) continue; // already eligible via normal strata
      const placeholderMeasures =
        r.placeholderMeasures && r.placeholderMeasures.length
          ? r.placeholderMeasures
          : measureUniverse;
      for (const m of placeholderMeasures) {
        out.push({
          cellKey: makeCellKey(r.companyId, m),
          companyId: r.companyId,
          companyName: r.companyName,
          measureTitle: m,
          category: null,
          modelVerdict: null,
          stratum: "non-english-placeholder",
          docRef: null,
          passageRef: null,
          researchComplete: null,
          nonEnglish: true,
          needsEvidence: true,
          runFlips: 0,
        });
      }
      representedNonEnglish.add(r.companyId);
    }
  }

  // 8. Counts + stable final order (by stratum priority, then cellKey).
  const stratumOrder: HoldoutStratum[] = [
    "current-yes",
    "unstable",
    "low-yield-company",
    "random-no",
    "non-english-placeholder",
  ];
  out.sort((a, b) => {
    const sa = stratumOrder.indexOf(a.stratum);
    const sb = stratumOrder.indexOf(b.stratum);
    if (sa !== sb) return sa - sb;
    return a.cellKey < b.cellKey ? -1 : a.cellKey > b.cellKey ? 1 : 0;
  });
  const byStratum = stratumOrder.reduce(
    (acc, s) => ((acc[s] = out.filter((c) => c.stratum === s).length), acc),
    {} as Record<HoldoutStratum, number>,
  );

  return {
    version: 1,
    generatedFromSeed: cfg.seed,
    frameworkVersion: cfg.frameworkVersion ?? null,
    config,
    counts: {
      total: out.length,
      byStratum,
      nonEnglishFilers: new Set(out.filter((c) => c.nonEnglish).map((c) => c.companyId)).size,
      needsEvidence: out.filter((c) => c.needsEvidence).length,
    },
    cells: out,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Label schema (typed) + validation
// ─────────────────────────────────────────────────────────────────────────────

/** Authoritative human label. PENDING = not yet adjudicated (default). */
export type HumanLabel = "Yes" | "No" | "Unsure" | "PENDING";
export const HUMAN_LABELS: readonly HumanLabel[] = ["Yes", "No", "Unsure", "PENDING"];

/**
 * A holdout label record. `human_label` is the ONLY authoritative truth used by
 * the gate. `provisional_suggestion` is non-authoritative triage help (optionally
 * from an INDEPENDENT model family) and is NEVER read as ground truth.
 */
export interface HoldoutLabel {
  cellKey: string;
  /** AUTHORITATIVE human adjudication. Default PENDING until an analyst sets it. */
  human_label: HumanLabel;
  /** Who adjudicated (analyst id / initials). null while PENDING. */
  labeller_id: string | null;
  /** Document the human relied on. */
  document: string | null;
  /** Passage the human relied on. */
  passage: string | null;
  /** ISO-8601 timestamp of adjudication. null while PENDING. */
  timestamp: string | null;
  /** True if this cell is in the 20% double-labelled overlap (inter-labeller agreement). */
  overlap: boolean;
  /** OPTIONAL, non-authoritative pre-annotation (separate model family). */
  provisional_suggestion?: {
    label: "Yes" | "No" | "Unsure";
    source: string; // e.g. "openrouter:<model>" — MUST differ from the scorer family
    note?: string;
  } | null;
}

export interface LabelValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a single label record's shape/values. Pure. */
export function validateHoldoutLabel(x: unknown): LabelValidationResult {
  const errors: string[] = [];
  const o = x as Partial<HoldoutLabel> | null | undefined;
  if (!o || typeof o !== "object") {
    return { valid: false, errors: ["label is not an object"] };
  }
  if (typeof o.cellKey !== "string" || !o.cellKey.includes("::"))
    errors.push("cellKey must be a non-empty `companyId::measure-slug` string");
  if (!HUMAN_LABELS.includes(o.human_label as HumanLabel))
    errors.push(`human_label must be one of ${HUMAN_LABELS.join("/")}`);
  if (o.overlap != null && typeof o.overlap !== "boolean")
    errors.push("overlap must be a boolean");
  const adjudicated = o.human_label && o.human_label !== "PENDING";
  if (adjudicated) {
    if (!o.labeller_id || typeof o.labeller_id !== "string")
      errors.push("an adjudicated label (non-PENDING) requires a labeller_id");
    if (!o.timestamp || typeof o.timestamp !== "string" || Number.isNaN(Date.parse(o.timestamp)))
      errors.push("an adjudicated label requires a valid ISO-8601 timestamp");
  }
  if (o.provisional_suggestion != null) {
    const p = o.provisional_suggestion;
    if (typeof p !== "object") errors.push("provisional_suggestion must be an object or null");
    else {
      if (!["Yes", "No", "Unsure"].includes((p as { label?: string }).label ?? ""))
        errors.push("provisional_suggestion.label must be Yes/No/Unsure");
      if (!(p as { source?: string }).source)
        errors.push("provisional_suggestion.source is required (must name an independent model)");
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validate a whole label file against a manifest (shape + coverage). Pure. */
export function validateLabelFile(
  labels: readonly unknown[],
  manifest?: HoldoutManifest,
): LabelValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(labels)) return { valid: false, errors: ["labels must be an array"] };
  const seen = new Set<string>();
  labels.forEach((l, i) => {
    const r = validateHoldoutLabel(l);
    if (!r.valid) errors.push(`label[${i}]: ${r.errors.join("; ")}`);
    const key = (l as HoldoutLabel)?.cellKey;
    if (key) {
      if (seen.has(key)) errors.push(`duplicate label for cellKey ${key}`);
      seen.add(key);
    }
  });
  if (manifest) {
    const manifestKeys = new Set(manifest.cells.map((c) => c.cellKey));
    for (const k of seen) if (!manifestKeys.has(k)) errors.push(`label cellKey ${k} not in manifest`);
  }
  return { valid: errors.length === 0, errors };
}

/** Build a blank, analyst-ready label template (all PENDING) from a manifest. Pure. */
export function buildLabelTemplate(manifest: HoldoutManifest): HoldoutLabel[] {
  return manifest.cells.map((c) => ({
    cellKey: c.cellKey,
    human_label: "PENDING" as HumanLabel,
    labeller_id: null,
    document: c.docRef,
    passage: c.passageRef,
    timestamp: null,
    overlap: false,
    provisional_suggestion: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Standing regression gate
// ─────────────────────────────────────────────────────────────────────────────

/** Model verdict for a holdout cell (the system under test). */
export interface ModelVerdictEntry {
  cellKey: string;
  verdict: Verdict;
  /** Research-complete vs incomplete, where derivable (for the complete/incomplete split). */
  researchComplete?: boolean | null;
}

/** Oracle-era baseline verdict for a cell (the pre-change acceptance basis). */
export interface OracleBaselineEntry {
  cellKey: string;
  verdict: Verdict;
}

export interface GateThresholds {
  /** Illustrative default from the review — OVERRIDABLE. */
  minYesPrecision: number;
  /** Illustrative default from the review — OVERRIDABLE. */
  minYesRecall: number;
  /** Are the thresholds illustrative placeholders (vs analyst-ratified)? */
  illustrative: boolean;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minYesPrecision: 0.85,
  minYesRecall: 0.75,
  illustrative: true,
};

export interface PrecisionRecallStats {
  /** Cells counted (human label is Yes or No; Unsure/PENDING excluded). */
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  /** 95% Wilson score interval [low, high] for precision/recall, or null if undefined. */
  precisionCI: [number, number] | null;
  recallCI: [number, number] | null;
}

export type GateStatus = "pass" | "fail" | "not-armed";

export interface GateResult {
  status: GateStatus;
  /** Human-readable reason (esp. for not-armed). */
  reason: string;
  thresholds: GateThresholds;
  /** Count of authoritative (non-PENDING, Yes/No) human labels available. */
  armedLabelCount: number;
  overall: PrecisionRecallStats | null;
  byResearch: {
    complete: PrecisionRecallStats | null;
    incomplete: PrecisionRecallStats | null;
  } | null;
  /** Model vs oracle-era baseline — the SPLIT (constraint 4), not the net. */
  vsOracleBaseline: {
    comparedCells: number;
    yesToNo: number;
    noToYes: number;
    totalFlips: number;
  } | null;
}

/** 95% Wilson score interval for a binomial proportion. Pure. */
export function wilsonInterval(successes: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.959963984540054; // 95%
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  const low = (center - margin) / denom;
  const high = (center + margin) / denom;
  return [Math.max(0, low), Math.min(1, high)];
}

function computePR(
  pairs: Array<{ human: "Yes" | "No"; model: Verdict }>,
): PrecisionRecallStats {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const { human, model } of pairs) {
    const modelYes = model === "Yes";
    const humanYes = human === "Yes";
    if (modelYes && humanYes) tp++;
    else if (modelYes && !humanYes) fp++;
    else if (!modelYes && humanYes) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return {
    n: pairs.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    precisionCI: tp + fp > 0 ? wilsonInterval(tp, tp + fp) : null,
    recallCI: tp + fn > 0 ? wilsonInterval(tp, tp + fn) : null,
  };
}

/**
 * Compute the standing gate result.
 *
 * - Reads ONLY `human_label` as truth (PENDING/Unsure excluded from precision/recall).
 * - If NO authoritative human labels exist ⇒ returns status "not-armed" with NO
 *   fabricated numbers (honesty constraint).
 * - Reports Yes precision & recall (+ Wilson CIs), split by complete/incomplete
 *   research where derivable, AND the Yes→No / No→Yes split of model vs the
 *   oracle-era baseline (constraint 4).
 * - Emits pass/fail only when armed AND precision & recall are both defined.
 *
 * Pure. No I/O. Framework-level.
 */
export function computeGate(opts: {
  labels: readonly HoldoutLabel[];
  modelVerdicts: readonly ModelVerdictEntry[];
  oracleBaseline?: readonly OracleBaselineEntry[];
  thresholds?: GateThresholds;
}): GateResult {
  const thresholds = opts.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const modelByKey = new Map(opts.modelVerdicts.map((m) => [m.cellKey, m]));
  const researchByKey = new Map(
    opts.modelVerdicts.map((m) => [m.cellKey, m.researchComplete ?? null]),
  );

  // Armed labels = authoritative human Yes/No that we also have a model verdict for.
  const armed = opts.labels.filter(
    (l) => (l.human_label === "Yes" || l.human_label === "No") && modelByKey.has(l.cellKey),
  );

  if (armed.length === 0) {
    return {
      status: "not-armed",
      reason:
        "ground truth pending — gate not armed: no authoritative human labels (Yes/No) " +
        "present for any cell with a model verdict. Adjudicate the fixed holdout to arm the gate. " +
        "No precision/recall fabricated.",
      thresholds,
      armedLabelCount: 0,
      overall: null,
      byResearch: null,
      vsOracleBaseline: oracleSplit(opts.labels, modelByKey, opts.oracleBaseline),
    };
  }

  const pairs = armed.map((l) => ({
    human: l.human_label as "Yes" | "No",
    model: modelByKey.get(l.cellKey)!.verdict,
  }));
  const overall = computePR(pairs);

  const completePairs: typeof pairs = [];
  const incompletePairs: typeof pairs = [];
  for (const l of armed) {
    const rc = researchByKey.get(l.cellKey);
    const pair = { human: l.human_label as "Yes" | "No", model: modelByKey.get(l.cellKey)!.verdict };
    if (rc === true) completePairs.push(pair);
    else if (rc === false) incompletePairs.push(pair);
  }
  const byResearch = {
    complete: completePairs.length ? computePR(completePairs) : null,
    incomplete: incompletePairs.length ? computePR(incompletePairs) : null,
  };

  // Pass/fail: both precision & recall must be defined AND meet thresholds.
  let status: GateStatus;
  let reason: string;
  if (overall.precision == null || overall.recall == null) {
    status = "not-armed";
    reason =
      "ground truth pending — gate not armed: too few Yes predictions/labels to define " +
      "precision and/or recall. No pass fabricated.";
  } else {
    const pOk = overall.precision >= thresholds.minYesPrecision;
    const rOk = overall.recall >= thresholds.minYesRecall;
    status = pOk && rOk ? "pass" : "fail";
    reason =
      `${status.toUpperCase()}: Yes precision ${overall.precision.toFixed(3)} ` +
      `(≥${thresholds.minYesPrecision}? ${pOk}), Yes recall ${overall.recall.toFixed(3)} ` +
      `(≥${thresholds.minYesRecall}? ${rOk})` +
      (thresholds.illustrative ? " [thresholds illustrative — overridable]" : "");
  }

  return {
    status,
    reason,
    thresholds,
    armedLabelCount: armed.length,
    overall,
    byResearch,
    vsOracleBaseline: oracleSplit(opts.labels, modelByKey, opts.oracleBaseline),
  };
}

/** Model-vs-oracle-era-baseline flip split over cells present in both. Pure. */
function oracleSplit(
  labels: readonly HoldoutLabel[],
  modelByKey: Map<string, ModelVerdictEntry>,
  oracleBaseline?: readonly OracleBaselineEntry[],
): GateResult["vsOracleBaseline"] {
  if (!oracleBaseline || oracleBaseline.length === 0) return null;
  const oracleByKey = new Map(oracleBaseline.map((o) => [o.cellKey, o.verdict]));
  let yesToNo = 0,
    noToYes = 0,
    compared = 0;
  // Iterate over the holdout cells (labels) to keep the comparison scoped to the fixed set.
  for (const l of labels) {
    const m = modelByKey.get(l.cellKey);
    const base = oracleByKey.get(l.cellKey);
    if (!m || base == null) continue;
    compared++;
    if (base === "Yes" && m.verdict === "No") yesToNo++;
    else if (base === "No" && m.verdict === "Yes") noToYes++;
  }
  return { comparedCells: compared, yesToNo, noToYes, totalFlips: yesToNo + noToYes };
}
