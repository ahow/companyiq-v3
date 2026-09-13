/**
 * Shared test-drive proposal derivation.
 *
 * Both the READ path (GET /v2/test-drive/results) and the WRITE path
 * (POST /v2/improvement/apply) must see the EXACT SAME proposal set. Before
 * this module existed they each re-derived proposals with different inputs:
 * the results view passed the multi-run iteration history, prepended the
 * sparse-corpus flag and built near-duplicate merge proposals, while the apply
 * path re-derived with a leaner query and NO multi-run history. The result was
 * that accepted multi-run-only proposals (e.g. residual-instability) — and any
 * sparse-corpus or near-duplicate proposal — were silently skipped at apply
 * time as "proposal no longer present (flag no longer fires after rescore)".
 *
 * `deriveProposalBundle` is the single source of truth. It reproduces the full
 * results-view derivation (data load → multi-run flip analysis → sparse-corpus
 * flag → edit proposals → quality metrics → near-duplicate merges) so the two
 * endpoints can never diverge again.
 *
 * GENERIC: nothing here is specific to any framework, company, topic or numeric
 * id. Every value is read from the passed frameworkId / listId / workspaceId.
 */

import { sql } from "drizzle-orm";
import {
  analyseTestDrive,
  computeFlipStats,
  buildSparseCorpusFlag,
  type TestDriveCompanyResult,
  type MultiRunIteration,
} from "./test-drive.js";
import { computeRobustnessCriteria, type CompanyLabel } from "./robustness-criteria.js";
import {
  proposeEditsForFlags,
  proposeMergeForNearDuplicate,
  type EditProposal,
  type EditProposalBundle,
} from "./edit-proposer.js";
import {
  computeQualityMetrics,
  coherenceGateMetrics,
  type MeasureSpecFields,
  type QualityMetricsReport,
} from "./quality-metrics.js";

/** Minimal shape of the drizzle db handle we depend on (execute only). */
export interface DbLike {
  execute: (query: any) => Promise<any>;
}

export interface DerivedProposalBundle {
  /** Company-level test-drive results (same assembly as the results view). */
  results: TestDriveCompanyResult[];
  byCompany: Record<string, TestDriveCompanyResult>;
  /** Expected-yes-rate + pillar metadata per measure. */
  measureMetadata: Array<{ measureId: string; expected_yes_rate: number; title?: string; pillar?: string }>;
  /** Full measure definitions keyed by measure_id, for edit-proposal generation. */
  measuresById: Record<string, any>;
  /** Per-measure spec fields for the transparency spec-completeness checklist. */
  measureSpecs: Record<string, MeasureSpecFields>;
  /** Signal/edge labels (loaded or inferred). */
  labels: CompanyLabel[];
  labelsInferred: boolean;
  /** All iteration snapshots feeding the multi-run flip detector. */
  multiRun: MultiRunIteration[];
  flipStats: any[];
  /** Flag analysis report (includes multi-run flags + prepended sparse-corpus flag). */
  report: any;
  /** 6-criteria robustness scorecard. */
  robustness: any;
  /** Edit proposals derived from the report flags. */
  edits: EditProposalBundle;
  /** Tier-1 design-time quality metrics (with coherenceGates folded in). */
  qualityMetrics: QualityMetricsReport | null;
  /** Selectable merge/differentiate proposals for near-duplicate pairs. */
  nearDuplicateEdits: EditProposal[];
  /**
   * The COMPLETE ordered proposal set the apply path resolves accepted
   * proposals against: edit proposals first (so legacy positional P<idx>
   * indices remain stable), near-duplicate merges appended after.
   */
  allProposals: EditProposal[];
}

/**
 * Derive the full test-drive proposal bundle for a framework+list, identical to
 * what GET /v2/test-drive/results produces. Must be called AFTER any iteration
 * snapshot the caller wants reflected in the multi-run flip comparison, since it
 * loads the iteration history internally.
 */
export async function deriveProposalBundle(
  db: DbLike,
  frameworkId: number,
  listId: number,
  workspaceId: number,
): Promise<DerivedProposalBundle> {
  // 1. Fetch measure_scores for the list's companies + framework. Uses the
  //    RICH query (incl. quotes) so the sparse-corpus heuristic can see whether
  //    a company produced any evidence quotes.
  const scoresQuery = await db.execute(sql`
    SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict,
           ms.confidence, ms.quotes, ms.verdict_nuance, ms.score
    FROM measure_scores ms
    JOIN companies c ON c.id = ms.company_id
    JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
    WHERE ms.framework_id = ${frameworkId}
    ORDER BY c.name, ms.measure_id
  `);
  const rows = ((scoresQuery as any).rows || []) as Array<any>;

  // 2. Assemble TestDriveCompanyResult[]
  const byCompany: Record<string, TestDriveCompanyResult> = {};
  for (const r of rows) {
    const key = String(r.company_id);
    if (!byCompany[key]) {
      byCompany[key] = { companyId: r.company_id, companyName: r.company_name, measures: [] };
    }
    const quotes = Array.isArray(r.quotes) ? r.quotes : [];
    const nuance = String(r.verdict_nuance || "");
    byCompany[key].measures.push({
      measureId: r.measure_id,
      verdict: (r.verdict || "No") as any,
      confidence: r.confidence || "Medium",
      quoteCount: quotes.length,
      adjacentTopicHits: 0,
      r33Flipped: /R3\.3 flipped/i.test(nuance),
    });
  }
  const results: TestDriveCompanyResult[] = Object.values(byCompany);

  // 3. Fetch measure metadata (expected_yes_rate + full definition for proposals).
  const measureMetaQuery = await db.execute(sql`
    SELECT measure_id, expected_yes_rate, title, category, substantive_definition,
           fallback_yes_criterion, positive_examples, negative_examples,
           min_quote_context_chars
    FROM framework_measures
    WHERE framework_id = ${frameworkId}
  `);
  const measureRows = ((measureMetaQuery as any).rows || []) as any[];
  const measureMetadata = measureRows.map((m: any) => ({
    measureId: m.measure_id,
    expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35,
    title: m.title,
    pillar: m.category || undefined,
  }));
  const measuresById: Record<string, any> = {};
  const measureSpecs: Record<string, MeasureSpecFields> = {};
  for (const m of measureRows) {
    measuresById[m.measure_id] = {
      substantive_definition: m.substantive_definition,
      fallback_yes_criterion: m.fallback_yes_criterion,
      positive_examples: m.positive_examples,
      negative_examples: m.negative_examples,
      min_quote_context_chars: m.min_quote_context_chars,
    };
    measureSpecs[m.measure_id] = {
      definition: m.substantive_definition,
      inclusion: m.positive_examples,
      exclusion: m.negative_examples,
      evidenceStandard: m.fallback_yes_criterion,
    };
  }

  // 4. Load signal/edge labels from company_lists.test_drive_labels (non-fatal).
  let labels: CompanyLabel[] = [];
  try {
    const labelQuery = await db.execute(sql`
      SELECT test_drive_labels FROM company_lists WHERE id = ${listId} AND workspace_id = ${workspaceId}
    `);
    const raw = (labelQuery as any).rows?.[0]?.test_drive_labels;
    if (Array.isArray(raw)) {
      labels = raw.map((r: any) => ({
        companyId: Number(r.companyId),
        isKnownDiscloser: !!r.isKnownDiscloser,
      }));
    }
  } catch (e: any) {
    console.warn("[deriveProposalBundle] label load failed (non-fatal):", e?.message);
  }
  // Fallback heuristic when labels are missing: top-half Yes-rate companies are
  // treated as "signal". Inference only — MUST NOT be used to claim a
  // discrimination pass; it exists so the criterion still renders.
  let labelsInferred = false;
  if (labels.length === 0 && Object.values(byCompany).length > 0) {
    labelsInferred = true;
    const perC = Object.values(byCompany)
      .map((r) => ({
        companyId: r.companyId,
        yesRate: r.measures.length > 0 ? r.measures.filter((m) => m.verdict === "Yes").length / r.measures.length : 0,
      }))
      .sort((a, b) => b.yesRate - a.yesRate);
    const n = perC.length;
    const topN = Math.max(1, Math.floor(n / 2));
    for (let i = 0; i < n; i++) {
      labels.push({ companyId: perC[i].companyId, isKnownDiscloser: i < topN });
    }
  }

  // 5. Build the multi-run flip input from ALL iteration snapshots for this
  //    framework+list (non-fatal). Two or more iterations = the same sample
  //    scored repeatedly; the flip detector compares per-company verdicts.
  let multiRun: MultiRunIteration[] = [];
  try {
    const iterRows = await db.execute(sql`
      SELECT iteration_number, per_measure
      FROM framework_v2_iterations
      WHERE framework_id = ${frameworkId} AND list_id = ${listId}
      ORDER BY iteration_number ASC
    `);
    multiRun = ((iterRows as any).rows || []).map((r: any) => ({
      iterationNumber: Number(r.iteration_number),
      perMeasure: r.per_measure && typeof r.per_measure === "object" ? r.per_measure : {},
    }));
  } catch (e: any) {
    console.warn("[deriveProposalBundle] multi-run load failed (non-fatal):", e?.message);
  }
  const flipStats = computeFlipStats(multiRun);

  // 6. Flag analysis WITH the multi-run history (this is what surfaces
  //    residual-instability and other multi-run-only flags).
  const report: any = analyseTestDrive(results, measureMetadata, multiRun);

  // Surface data-sparse companies as an actionable design-time prompt. A company
  // that produced ZERO evidence quotes across every measure is almost certainly
  // missing source documents rather than genuinely non-disclosing.
  const sparseCompanies = results
    .filter((r) => r.measures.length > 0 && r.measures.every((m) => (m.quoteCount || 0) === 0))
    .map((r) => ({ companyId: r.companyId, companyName: r.companyName, classification: "no-evidence-in-corpus" }));
  const sparseFlag = buildSparseCorpusFlag(sparseCompanies);
  if (sparseFlag && report) {
    report.flags = [sparseFlag, ...(report.flags || [])];
    report.summary = `${report.summary}\n  • [sparse-corpus] ${sparseFlag.message}`;
  }

  const robustness = computeRobustnessCriteria(results, measureMetadata, labels);
  const edits = proposeEditsForFlags(report.flags || [], measuresById);

  // Tier-1 design-time quality gate (ADDITIVE, non-fatal).
  let qualityMetrics: QualityMetricsReport | null = null;
  let nearDuplicateEdits: EditProposal[] = [];
  try {
    qualityMetrics = computeQualityMetrics({ results, measureMetadata, multiRun, measureSpecs });
    const coherenceGates = coherenceGateMetrics({ results, measureMetadata, multiRun, measureSpecs });
    (qualityMetrics as any).coherenceGates = coherenceGates;
    // Near-duplicate pairs become selectable merge/differentiate proposals.
    nearDuplicateEdits = (qualityMetrics.nearDuplicatePairs || []).map((p) =>
      proposeMergeForNearDuplicate({
        measureIdA: p.measureIdA,
        measureIdB: p.measureIdB,
        labelA: p.labelA,
        labelB: p.labelB,
        agreement: p.agreement,
        kappa: p.kappa,
        n: p.n,
      }),
    );
  } catch (e: any) {
    console.warn("[deriveProposalBundle] quality metrics failed (non-fatal):", e?.message);
  }

  // The COMPLETE proposal set the apply path resolves against. Edit proposals
  // come FIRST so legacy positional P<idx> indices (which only ever referenced
  // edit proposals) stay stable; near-duplicate merges are appended after.
  const allProposals = [...(edits?.proposals || []), ...nearDuplicateEdits];

  return {
    results,
    byCompany,
    measureMetadata,
    measuresById,
    measureSpecs,
    labels,
    labelsInferred,
    multiRun,
    flipStats,
    report,
    robustness,
    edits,
    qualityMetrics,
    nearDuplicateEdits,
    allProposals,
  };
}
