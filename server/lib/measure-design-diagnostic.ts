// ─── Measure-Definition Design-Time Diagnostic ──────────────────────────────
//
// GENERIC, framework-agnostic. This module SURFACES measure-definition defects
// FOR REVIEW. It NEVER auto-edits a measure definition and NEVER runs scoring or
// any LLM call. There are no measure/company/framework ids baked into the logic.
//
// Three analyses:
//   1. PRE-TEST (static, no run): flags measures whose DEFINITIONS are internally
//      conflicted/ambiguous:
//        (a) whitelist_vs_exclusion_conflict — the substantive definition /
//            fallback / what-constitutes-evidence whitelists an artefact class
//            that the exclusions (what-does-not-constitute-evidence / negative
//            examples) could ALSO match, with no precedence stated.
//        (b) existence_strength_conflation — the target/definition conflates
//            EXISTENCE/disclosure with STRENGTH/quality (both language families
//            present).
//        (c) non_json_scoring_guidance — scoring_guidance is non-empty but not a
//            usable structured JSON object (reuses the Change B audit).
//   2. POST-TEST (given ≥1 analysis_results batch ids): per-measure stored-cell
//      signals — verdict distribution, split/low-confidence rate (Medium +
//      Review-required), rationale-score-inconsistency flag rate (Change D).
//   3. MULTI-RUN (given ≥2 batch ids of the same framework + company list):
//      per-measure run-to-run verdict FLIP rate; ranks measures by a composite
//      "definitional instability" score.
//
// Output: a structured JSON report + a human-readable summary.

import { db } from "../db.js";
import { frameworkMeasures, frameworks, analysisResults } from "../../shared/schema.js";
import { eq, inArray } from "drizzle-orm";
import { auditFrameworkGuidance, classifyGuidance, type GuidanceAuditIssue } from "./framework-guidance-audit.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DefectPattern =
  | "whitelist_vs_exclusion_conflict"
  | "existence_strength_conflation"
  | "non_json_scoring_guidance";

export interface PreTestFinding {
  measureId: string;
  title: string;
  pattern: DefectPattern;
  evidence: string;
  suggestedClarification: string;
}

export interface PostTestSignal {
  measureId: string;
  title: string;
  cellsAnalyzed: number;
  verdictDistribution: Record<string, number>;
  lowConfidenceRate: number; // (Medium + Review-required) / cells
  reviewRequiredRate: number; // Review-required / cells
  rationaleInconsistentRate: number; // Change D flag rate
}

export interface MultiRunSignal {
  measureId: string;
  title: string;
  companiesCompared: number;
  flipRate: number; // fraction of companies whose verdict changed across runs
}

export interface FlaggedMeasure {
  measureId: string;
  title: string;
  patterns: DefectPattern[];
  instabilityScore: number; // composite 0..1, higher = more unstable/ambiguous
  evidence: {
    preTest: PreTestFinding[];
    postTest?: PostTestSignal;
    multiRun?: MultiRunSignal;
  };
  suggestedClarifications: string[];
}

export interface DiagnosticReport {
  frameworkId: number;
  frameworkName: string | null;
  generatedAt: string;
  batchIds: number[];
  measuresAnalyzed: number;
  preTest: PreTestFinding[];
  postTest: PostTestSignal[];
  multiRun: MultiRunSignal[];
  flaggedMeasures: FlaggedMeasure[]; // ranked by instabilityScore DESC
  humanSummary: string;
}

// ─── Lexical resources (generic families, no rubric-specific terms) ──────────

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "which", "have", "has",
  "not", "any", "all", "are", "was", "were", "will", "would", "should", "must",
  "such", "these", "those", "into", "onto", "than", "then", "when", "where",
  "what", "whom", "whose", "does", "done", "being", "been", "there", "their",
  "them", "they", "your", "yours", "about", "above", "below", "under", "over",
  "each", "other", "some", "more", "most", "only", "also", "very", "e.g", "i.e",
  "measure", "company", "companies", "evidence", "disclosure", "disclosures",
  "score", "scoring", "yes", "partial", "example", "examples", "including",
  "include", "includes", "specific", "specifically", "clear", "clearly",
]);

// Existence / disclosure language family (presence-of-a-thing).
const EXISTENCE_CUES: RegExp[] = [
  /\bexist(?:s|ence)?\b/i,
  /\bpresence\b/i,
  /\b(?:has|have|having)\b/i,
  /\bdisclos\w+/i,
  /\bmention(?:s|ed|ing)?\b/i,
  /\breference(?:s|d)?\b/i,
  /\b(?:in place|adopt\w+|publish\w+|establish\w+|implement\w+)\b/i,
  /\bstat(?:e|es|ed|ement)\b/i,
  /\bidentif\w+/i,
  /\bwhether\b.*\b(?:a|an|any)\b/i,
];

// Strength / quality language family (how-good-the-thing-is).
const STRENGTH_CUES: RegExp[] = [
  /\brobust\b/i,
  /\bcomprehensive\b/i,
  /\beffective(?:ness)?\b/i,
  /\bstrong\b/i,
  /\badequa(?:te|cy)\b/i,
  /\brigor(?:ous)?\b/i,
  /\bquality\b/i,
  /\bsufficient\b/i,
  /\bmeaningful\b/i,
  /\bsubstant(?:ive|ial)\b/i,
  /\bdetailed\b/i,
  /\bthorough\b/i,
  /\bmaterial(?:ity)?\b/i,
  /\bwell[- ]defined\b/i,
  /\bhigh[- ]quality\b/i,
  /\bmatur(?:e|ity)\b/i,
];

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 4 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function anyCue(text: string, cues: RegExp[]): string[] {
  const hits: string[] = [];
  for (const c of cues) {
    const m = (text || "").match(c);
    if (m) hits.push(m[0].trim().toLowerCase());
  }
  return hits;
}

function joinFields(...parts: Array<string | null | undefined | string[]>): string {
  const flat: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p)) flat.push(...p.filter(Boolean).map(String));
    else flat.push(String(p));
  }
  return flat.join("\n");
}

// ─── 1. PRE-TEST: static definition analysis ────────────────────────────────

export interface DiagnosticMeasure {
  measureId: string;
  title?: string | null;
  definition?: string | null;
  primaryAssessmentTarget?: string | null;
  substantiveDefinition?: string | null;
  whatConstitutesEvidence?: string | null;
  whatDoesNotConstituteEvidence?: string | null;
  fallbackYesCriterion?: string | null;
  positiveExamples?: string[] | null;
  negativeExamples?: string[] | null;
  scoringGuidance?: string | null;
}

export function analyzeMeasureDefinition(measure: DiagnosticMeasure): PreTestFinding[] {
  const findings: PreTestFinding[] = [];
  const title = measure.title || "";

  // (a) whitelist vs exclusion overlap
  const whitelistText = joinFields(
    measure.substantiveDefinition,
    measure.fallbackYesCriterion,
    measure.whatConstitutesEvidence,
    measure.positiveExamples
  );
  const exclusionText = joinFields(
    measure.whatDoesNotConstituteEvidence,
    measure.negativeExamples
  );
  if (whitelistText.trim() && exclusionText.trim()) {
    const wl = tokenize(whitelistText);
    const ex = tokenize(exclusionText);
    const overlap: string[] = [];
    for (const t of wl) if (ex.has(t)) overlap.push(t);
    if (overlap.length > 0) {
      findings.push({
        measureId: measure.measureId,
        title,
        pattern: "whitelist_vs_exclusion_conflict",
        evidence: `Content term(s) appear in BOTH the qualifying/whitelist definition and the exclusions with no stated precedence: ${overlap.slice(0, 12).join(", ")}${overlap.length > 12 ? " …" : ""}.`,
        suggestedClarification:
          "State which side wins when both match the same evidence. Recommended: a specific, named, on-topic qualifying instance is NOT defeated by generic/aspirational language elsewhere — assess the qualifying instance first, apply exclusions to the residual.",
      });
    }
  }

  // (b) existence vs strength conflation in target/definition
  const targetText = joinFields(measure.primaryAssessmentTarget, measure.definition);
  if (targetText.trim()) {
    const existHits = anyCue(targetText, EXISTENCE_CUES);
    const strengthHits = anyCue(targetText, STRENGTH_CUES);
    if (existHits.length > 0 && strengthHits.length > 0) {
      findings.push({
        measureId: measure.measureId,
        title,
        pattern: "existence_strength_conflation",
        evidence: `Target/definition mixes EXISTENCE/disclosure language (${existHits.slice(0, 5).join(", ")}) with STRENGTH/quality language (${strengthHits.slice(0, 5).join(", ")}). A scorer cannot tell whether mere existence, or a quality bar, is being assessed.`,
        suggestedClarification:
          "Split into two decisions: (1) does the disclosed thing EXIST (binary), and only if so (2) does it meet the quality bar. Score existence and strength separately, or pick one as the measure's primary target.",
      });
    }
  }

  // (c) non-JSON scoring_guidance
  const g = classifyGuidance(measure.scoringGuidance);
  if (!g.ok && g.issue) {
    findings.push({
      measureId: measure.measureId,
      title,
      pattern: "non_json_scoring_guidance",
      evidence: g.detail || "scoring_guidance is not a usable structured JSON object.",
      suggestedClarification:
        "Convert scoring_guidance to a JSON object with yes/no/partial buckets (and optional explicit_exclusions / required_evidence_type). Until then the scorer renders it as neutral prose rather than as Yes/No/Partial guidance.",
    });
  }

  return findings;
}

// ─── Stored-cell extraction from analysis_results ───────────────────────────

interface StoredCell {
  companyId?: number | string;
  measureId: string;
  verdict?: string | null;
  confidence?: string | null;
  score?: number | null;
  rationaleScoreInconsistent?: boolean;
}

// results_data is an array of company objects, each with a measureScores array.
function extractCells(resultsData: any): StoredCell[] {
  const cells: StoredCell[] = [];
  const companies = Array.isArray(resultsData) ? resultsData : [];
  for (const company of companies) {
    const cid = company?.companyId ?? company?.company_id ?? company?.companyName;
    const scores = Array.isArray(company?.measureScores) ? company.measureScores : [];
    for (const s of scores) {
      if (!s || typeof s.measureId !== "string") continue;
      cells.push({
        companyId: cid,
        measureId: s.measureId,
        verdict: s.verdict ?? null,
        confidence: s.confidence ?? null,
        score: typeof s.score === "number" ? s.score : null,
        rationaleScoreInconsistent: s.rationaleScoreInconsistent === true,
      });
    }
  }
  return cells;
}

// ─── 2. POST-TEST: per-measure stored-cell signals ──────────────────────────

export function computePostTestSignals(
  cellsByMeasure: Map<string, StoredCell[]>,
  titles: Map<string, string>
): PostTestSignal[] {
  const out: PostTestSignal[] = [];
  for (const [measureId, cells] of cellsByMeasure) {
    const n = cells.length;
    if (n === 0) continue;
    const verdictDistribution: Record<string, number> = {};
    let lowConf = 0;
    let reviewReq = 0;
    let inconsistent = 0;
    for (const c of cells) {
      const v = (c.verdict || "unknown").toString();
      verdictDistribution[v] = (verdictDistribution[v] || 0) + 1;
      const conf = (c.confidence || "").toLowerCase();
      if (conf === "medium" || conf === "review-required" || conf === "low") lowConf++;
      if (conf === "review-required") reviewReq++;
      if (c.rationaleScoreInconsistent) inconsistent++;
    }
    out.push({
      measureId,
      title: titles.get(measureId) || "",
      cellsAnalyzed: n,
      verdictDistribution,
      lowConfidenceRate: lowConf / n,
      reviewRequiredRate: reviewReq / n,
      rationaleInconsistentRate: inconsistent / n,
    });
  }
  return out;
}

// ─── 3. MULTI-RUN: per-measure verdict flip rate ────────────────────────────

export function computeMultiRunSignals(
  runs: Array<Map<string, StoredCell[]>>, // one map (measureId → cells) per batch
  titles: Map<string, string>
): MultiRunSignal[] {
  if (runs.length < 2) return [];
  const out: MultiRunSignal[] = [];

  // Collect the union of measure ids.
  const measureIds = new Set<string>();
  for (const r of runs) for (const k of r.keys()) measureIds.add(k);

  for (const measureId of measureIds) {
    // Build, per run, a map of companyId → verdict for this measure.
    const perRunVerdicts: Array<Map<string, string>> = runs.map((r) => {
      const m = new Map<string, string>();
      for (const c of r.get(measureId) || []) {
        if (c.companyId === undefined || c.companyId === null) continue;
        m.set(String(c.companyId), (c.verdict || "unknown").toString());
      }
      return m;
    });

    // Companies present in ALL runs (comparable).
    const common = perRunVerdicts.reduce<Set<string> | null>((acc, m) => {
      const keys = new Set(m.keys());
      if (acc === null) return keys;
      const next = new Set<string>();
      for (const k of acc) if (keys.has(k)) next.add(k);
      return next;
    }, null) || new Set<string>();

    if (common.size === 0) continue;

    let flipped = 0;
    for (const companyId of common) {
      const verdicts = perRunVerdicts.map((m) => m.get(companyId)!);
      const allSame = verdicts.every((v) => v === verdicts[0]);
      if (!allSame) flipped++;
    }
    out.push({
      measureId,
      title: titles.get(measureId) || "",
      companiesCompared: common.size,
      flipRate: flipped / common.size,
    });
  }
  return out;
}

// ─── Composite ranking + human summary ──────────────────────────────────────

function buildFlaggedMeasures(
  preTest: PreTestFinding[],
  postTest: PostTestSignal[],
  multiRun: MultiRunSignal[]
): FlaggedMeasure[] {
  const byMeasure = new Map<string, FlaggedMeasure>();

  const ensure = (measureId: string, title: string): FlaggedMeasure => {
    let f = byMeasure.get(measureId);
    if (!f) {
      f = {
        measureId,
        title,
        patterns: [],
        instabilityScore: 0,
        evidence: { preTest: [] },
        suggestedClarifications: [],
      };
      byMeasure.set(measureId, f);
    }
    return f;
  };

  for (const p of preTest) {
    const f = ensure(p.measureId, p.title);
    if (!f.patterns.includes(p.pattern)) f.patterns.push(p.pattern);
    f.evidence.preTest.push(p);
    if (!f.suggestedClarifications.includes(p.suggestedClarification)) {
      f.suggestedClarifications.push(p.suggestedClarification);
    }
  }
  const postByMeasure = new Map(postTest.map((p) => [p.measureId, p]));
  const multiByMeasure = new Map(multiRun.map((m) => [m.measureId, m]));

  for (const p of postTest) {
    const f = ensure(p.measureId, p.title);
    f.evidence.postTest = p;
  }
  for (const m of multiRun) {
    const f = ensure(m.measureId, m.title);
    f.evidence.multiRun = m;
  }

  // Composite instability score (0..1). Weights are generic and documented.
  for (const f of byMeasure.values()) {
    const post = postByMeasure.get(f.measureId);
    const multi = multiByMeasure.get(f.measureId);
    const preSignal = Math.min(1, f.patterns.length / 3); // 0, .33, .66, 1
    const flip = multi?.flipRate ?? 0;
    const inconsistent = post?.rationaleInconsistentRate ?? 0;
    const review = post?.reviewRequiredRate ?? 0;
    // Weighted blend — pre-test definition defects and run-to-run flips dominate.
    f.instabilityScore = Number(
      (0.35 * preSignal + 0.35 * flip + 0.20 * inconsistent + 0.10 * review).toFixed(4)
    );
  }

  return Array.from(byMeasure.values())
    .filter((f) => f.patterns.length > 0 || f.instabilityScore > 0)
    .sort((a, b) => b.instabilityScore - a.instabilityScore);
}

function buildHumanSummary(report: Omit<DiagnosticReport, "humanSummary">): string {
  const lines: string[] = [];
  lines.push(`Measure-design diagnostic — framework ${report.frameworkId}${report.frameworkName ? ` (${report.frameworkName})` : ""}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Measures analyzed: ${report.measuresAnalyzed}; batches: ${report.batchIds.length > 0 ? report.batchIds.join(", ") : "none (pre-test only)"}`);
  lines.push("");
  lines.push(`PRE-TEST definition defects: ${report.preTest.length}`);
  lines.push(`POST-TEST measures with stored-cell signals: ${report.postTest.length}`);
  lines.push(`MULTI-RUN measures compared: ${report.multiRun.length}`);
  lines.push("");
  if (report.flaggedMeasures.length === 0) {
    lines.push("No measures flagged. (Nothing to review.)");
    return lines.join("\n");
  }
  lines.push(`FLAGGED MEASURES (ranked by definitional instability) — FOR REVIEW, no auto-edits applied:`);
  for (const f of report.flaggedMeasures) {
    lines.push("");
    lines.push(`• ${f.measureId} — ${f.title}  [instability ${f.instabilityScore}]`);
    if (f.patterns.length > 0) lines.push(`    patterns: ${f.patterns.join(", ")}`);
    for (const p of f.evidence.preTest) {
      lines.push(`    - ${p.pattern}: ${p.evidence}`);
    }
    if (f.evidence.postTest) {
      const pt = f.evidence.postTest;
      const dist = Object.entries(pt.verdictDistribution).map(([k, v]) => `${k}=${v}`).join(" ");
      lines.push(`    - post-test (${pt.cellsAnalyzed} cells): verdicts {${dist}}; low-confidence ${(pt.lowConfidenceRate * 100).toFixed(0)}%; inconsistency-flag ${(pt.rationaleInconsistentRate * 100).toFixed(0)}%`);
    }
    if (f.evidence.multiRun) {
      const mr = f.evidence.multiRun;
      lines.push(`    - multi-run: verdict flipped for ${(mr.flipRate * 100).toFixed(0)}% of ${mr.companiesCompared} companies across runs`);
    }
    for (const s of f.suggestedClarifications) {
      lines.push(`    → suggestion: ${s}`);
    }
  }
  return lines.join("\n");
}

// ─── Public entry point ─────────────────────────────────────────────────────

export interface RunDiagnosticOptions {
  frameworkId: number;
  /** analysis_results batch ids. 0 = pre-test only; 1 = pre+post; ≥2 = pre+post+multi-run. */
  batchIds?: number[];
}

/**
 * Run the full diagnostic against a framework, optionally incorporating stored
 * batch results. Reads through the app's existing db layer (server/db.ts).
 * Returns a structured report; performs NO writes and NO auto-edits.
 */
export async function runMeasureDesignDiagnostic(opts: RunDiagnosticOptions): Promise<DiagnosticReport> {
  const { frameworkId } = opts;
  const batchIds = Array.from(new Set((opts.batchIds || []).filter((n) => Number.isInteger(n) && n > 0)));

  // Load framework + measures.
  const fwRows = await db.select().from(frameworks).where(eq(frameworks.id, frameworkId));
  const frameworkName = fwRows[0]?.name ?? null;

  const measures = await db
    .select()
    .from(frameworkMeasures)
    .where(eq(frameworkMeasures.frameworkId, frameworkId));

  const titles = new Map<string, string>();
  for (const m of measures) titles.set(m.measureId, m.title || "");

  // PRE-TEST (always).
  const preTest: PreTestFinding[] = [];
  for (const m of measures) {
    preTest.push(...analyzeMeasureDefinition(m as unknown as DiagnosticMeasure));
  }

  // POST-TEST + MULTI-RUN (only if batches supplied).
  let postTest: PostTestSignal[] = [];
  let multiRun: MultiRunSignal[] = [];

  if (batchIds.length > 0) {
    const resultRows = await db
      .select()
      .from(analysisResults)
      .where(inArray(analysisResults.batchId, batchIds));

    // Group rows by batch (a batch may have one row holding all companies).
    const cellsPerBatch = new Map<number, StoredCell[]>();
    for (const row of resultRows) {
      if (row.frameworkId !== frameworkId) continue; // scope to this framework
      const cells = extractCells(row.resultsData);
      const existing = cellsPerBatch.get(row.batchId) || [];
      cellsPerBatch.set(row.batchId, existing.concat(cells));
    }

    // POST-TEST: aggregate ALL cells across the supplied batches per measure.
    const allCellsByMeasure = new Map<string, StoredCell[]>();
    for (const cells of cellsPerBatch.values()) {
      for (const c of cells) {
        const arr = allCellsByMeasure.get(c.measureId) || [];
        arr.push(c);
        allCellsByMeasure.set(c.measureId, arr);
      }
    }
    postTest = computePostTestSignals(allCellsByMeasure, titles);

    // MULTI-RUN: one measure→cells map per batch, only if ≥2 batches have data.
    if (cellsPerBatch.size >= 2) {
      const runs: Array<Map<string, StoredCell[]>> = [];
      for (const cells of cellsPerBatch.values()) {
        const byMeasure = new Map<string, StoredCell[]>();
        for (const c of cells) {
          const arr = byMeasure.get(c.measureId) || [];
          arr.push(c);
          byMeasure.set(c.measureId, arr);
        }
        runs.push(byMeasure);
      }
      multiRun = computeMultiRunSignals(runs, titles);
    }
  }

  const flaggedMeasures = buildFlaggedMeasures(preTest, postTest, multiRun);

  const base: Omit<DiagnosticReport, "humanSummary"> = {
    frameworkId,
    frameworkName,
    generatedAt: new Date().toISOString(),
    batchIds,
    measuresAnalyzed: measures.length,
    preTest,
    postTest,
    multiRun,
    flaggedMeasures,
  };

  return { ...base, humanSummary: buildHumanSummary(base) };
}

// Re-export the guidance audit for callers that only want the (c) check.
export { auditFrameworkGuidance };
export type { GuidanceAuditIssue };
