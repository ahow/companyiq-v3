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
  proposeSynonymAddition,
  proposeAdjacentTopics,
  proposeAnchorFrameworks,
  proposeExpectedYesRateRecalibration,
  proposeNonDiscriminatingRetire,
  FRAMEWORK_SENTINEL,
  type EditProposal,
  type EditProposalBundle,
} from "./edit-proposer.js";
import {
  proposalKeyFromProposal,
  proposalKeyFromEditRow,
} from "./proposal-identity.js";
import { mineFrameworkCandidates } from "./framework-candidates.js";
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

  // ── Framework-level improvement proposals (ADDITIVE, non-fatal) ──────────
  // Terminology-gap synonyms (PART A), adjacent-topic registration and
  // anchor-framework coverage (PART B). These target jsonb columns on
  // `frameworks`, not per-measure fields, and carry the sentinel measureId
  // "(framework)". Candidate pools are mined (and memoised) by
  // mineFrameworkCandidates; here we re-filter each pool against the CURRENTLY
  // registered list so an apply that already added a value never re-surfaces it,
  // then build at most one proposal per type (aggregating all values). Appended
  // to edits.proposals so the results view and apply path see them identically.
  try {
    const fwRow = await db.execute(sql`
      SELECT name, topic_term, topic_synonyms, adjacent_topics, anchor_frameworks
      FROM frameworks WHERE id = ${frameworkId}
    `);
    const fw = (fwRow as any).rows?.[0];
    if (fw) {
      const topicTerm = String(fw.topic_term || "");
      const currentSynonyms = toStringArray(fw.topic_synonyms);
      const currentAdjacent = toStringArray(fw.adjacent_topics);
      const currentAnchors = toStringArray(fw.anchor_frameworks);

      // Recurrence of adjacent-topic contamination = number of DISTINCT measures
      // whose flags cited it. "Multiple measures" is the definitional threshold
      // for a FRAMEWORK-level (rather than single-measure) adjacent problem, so
      // we require ≥2 distinct flagged measures. This is derived from the flag
      // stream — never a hardcoded topic or id.
      const ADJACENT_FRAMEWORK_RECURRENCE_MIN = 2;
      const adjacentFlaggedMeasures = new Set(
        (report.flags || [])
          .filter((f: any) => f?.rule === "adjacent-topic-contamination" && f?.measureId)
          .map((f: any) => String(f.measureId)),
      );
      const adjacentRecurrence = adjacentFlaggedMeasures.size;

      const mined = await mineFrameworkCandidates(db, frameworkId, listId, workspaceId, {
        topicTerm,
        topicSynonyms: currentSynonyms,
        adjacentTopics: currentAdjacent,
        anchorFrameworks: currentAnchors,
        frameworkName: fw.name ? String(fw.name) : undefined,
      });

      const frameworkProposals: EditProposal[] = [];

      // PART A — terminology-gap synonyms. Re-filter the mined term pool against
      // the current topic_synonyms + topic_term (cache-staleness guard).
      const synonymCandidates = filterUnregistered(
        (mined.terminology || []).map((t) => t.term),
        [...currentSynonyms, topicTerm],
      );
      const synProp = proposeSynonymAddition(synonymCandidates, currentSynonyms);
      if (synProp) frameworkProposals.push(synProp);

      // PART B(1) — adjacent-topic registration, only when the contamination
      // recurs across MULTIPLE measures (framework-level, not single-measure).
      if (adjacentRecurrence >= ADJACENT_FRAMEWORK_RECURRENCE_MIN) {
        const adjacentCandidates = filterUnregistered(
          mined.adjacentPhrases || [],
          [...currentAdjacent, topicTerm, ...currentSynonyms],
        );
        const adjProp = proposeAdjacentTopics(adjacentCandidates, currentAdjacent, adjacentRecurrence);
        if (adjProp) frameworkProposals.push(adjProp);
      }

      // PART B(2) — anchor-framework coverage (ADD only).
      const anchorCandidates = filterUnregistered(mined.anchorNames || [], currentAnchors);
      const anchorProp = proposeAnchorFrameworks(anchorCandidates, currentAnchors);
      if (anchorProp) frameworkProposals.push(anchorProp);

      if (frameworkProposals.length > 0 && edits) {
        for (const p of frameworkProposals) {
          edits.proposals.push(p);
          (edits.causeBreakdown as Record<string, number>)[p.cause] =
            ((edits.causeBreakdown as Record<string, number>)[p.cause] || 0) + 1;
        }
        edits.totalWithProposals = edits.proposals.length;
      }
    }
  } catch (e: any) {
    console.warn("[deriveProposalBundle] framework-level proposals failed (non-fatal):", e?.message);
  }

  // ── Per-measure calibration / annotation proposals (ADDITIVE, non-fatal) ──
  // Feature 1: expected_yes_rate recalibration — when a measure's OBSERVED Yes-rate
  // across the scored companies diverges from its configured expected_yes_rate
  // beyond tolerance, propose recalibrating to the observed rate.
  // Feature 2: non-discriminating measure — when a measure hands the SAME verdict
  // to every scored company, surface a soft redefine/retire proposal (sets a
  // boolean annotation only; never deletes the measure).
  //
  // Both are derived from the cross-company verdict distribution the per-flag
  // proposer never sees, and both share a minimum-sample guardrail so a handful of
  // companies can never trigger a recalibration or retire recommendation. Every
  // threshold is env-tunable and each feature has an independent kill-switch.
  // GENERIC: nothing here references a framework, company, topic or numeric id.
  try {
    const recalEnabled = envFlag("EXPECTED_YES_RATE_RECALIBRATION_ENABLED", true);
    const nonDiscrimEnabled = envFlag("NON_DISCRIMINATING_PROPOSALS_ENABLED", true);
    if ((recalEnabled || nonDiscrimEnabled) && edits) {
      // Minimum scored companies before EITHER proposal may fire (guardrail).
      const minSample = envInt("PROPOSAL_MIN_SAMPLE_COMPANIES", 8, 1);
      // Absolute tolerance on |observed − expected| before recalibration proposes.
      const tolerance = envFloat("EXPECTED_YES_RATE_TOLERANCE", 0.2, 0, 1);
      const expectedByMeasure: Record<string, number> = {};
      for (const m of measureMetadata) expectedByMeasure[m.measureId] = m.expected_yes_rate;

      // Aggregate the per-company verdicts into per-measure Yes-rate + verdict set.
      const perMeasure: Record<string, { yes: number; total: number; verdicts: Set<string> }> = {};
      for (const company of results) {
        for (const mv of company.measures || []) {
          const id = String(mv.measureId);
          const verdict = String(mv.verdict || "").trim();
          if (!verdict) continue; // only companies with a real scored verdict count
          if (!perMeasure[id]) perMeasure[id] = { yes: 0, total: 0, verdicts: new Set() };
          perMeasure[id].total += 1;
          perMeasure[id].verdicts.add(verdict);
          if (verdict === "Yes") perMeasure[id].yes += 1;
        }
      }

      const calibrationProposals: EditProposal[] = [];
      for (const [measureId, agg] of Object.entries(perMeasure)) {
        if (agg.total < minSample) continue;          // guardrail: too few companies
        if (agg.total === 0) continue;                // no valid scored companies
        const nonDiscriminating = agg.verdicts.size === 1;

        // Feature 2 — non-discriminating (same verdict for every company).
        if (nonDiscrimEnabled && nonDiscriminating) {
          const onlyVerdict = [...agg.verdicts][0] || "";
          calibrationProposals.push(proposeNonDiscriminatingRetire(measureId, agg.total, onlyVerdict));
        }

        // Feature 1 — expected_yes_rate drift. Skip non-discriminating measures:
        // recalibrating a measure that returns one verdict for everyone is
        // meaningless (the retire proposal above is the correct action instead).
        if (recalEnabled && !nonDiscriminating) {
          const observed = agg.yes / agg.total;
          const expected = typeof expectedByMeasure[measureId] === "number" ? expectedByMeasure[measureId] : 0.35;
          if (Math.abs(observed - expected) > tolerance) {
            calibrationProposals.push(
              proposeExpectedYesRateRecalibration(measureId, expected, observed, agg.total),
            );
          }
        }
      }

      // Append onto edits.proposals so the results view and apply path see them
      // identically (they ride along in allProposals below). De-dupe defensively
      // on the same identity tuple proposeEditsForFlags uses.
      const existing = new Set(
        edits.proposals.map((p) => `${p.measureId}::${p.cause}::${p.fieldPath}::${p.patch?.op ?? ""}`),
      );
      for (const p of calibrationProposals) {
        const key = `${p.measureId}::${p.cause}::${p.fieldPath}::${p.patch?.op ?? ""}`;
        if (existing.has(key)) continue;
        existing.add(key);
        edits.proposals.push(p);
        (edits.causeBreakdown as Record<string, number>)[p.cause] =
          ((edits.causeBreakdown as Record<string, number>)[p.cause] || 0) + 1;
      }
      edits.totalWithProposals = edits.proposals.length;
    }
  } catch (e: any) {
    console.warn("[deriveProposalBundle] calibration/annotation proposals failed (non-fatal):", e?.message);
  }

  // Suppress proposals whose edit has already been RESOLVED — either APPLIED
  // (measure_edits.applied=true) or explicitly DISMISSED
  // (measure_edits.skip_reason='dismissed'). Without this, an applied/dismissed
  // proposal re-derives on every results load and re-inflates the "Apply N
  // edits → iterate" count, so the user can never drive the review list to
  // zero. The resolved-identity key is computed by the shared routine in
  // proposal-identity.ts on BOTH sides (persisted row and derived proposal) so
  // the two can never drift. Framework-level proposals (measureId ===
  // FRAMEWORK_SENTINEL) are EXEMPT: they aggregate many values into one
  // proposal and self-suppress per-value via filterUnregistered above, so a
  // whole-proposal suppression after a single value was added would wrongly
  // hide the still-unregistered remainder. Non-fatal: on any read error we
  // simply skip suppression (fail-open — worst case a resolved proposal shows).
  try {
    const editsRes = await db.execute(sql`
      SELECT measure_id, field, op, applied, skip_reason
      FROM measure_edits
      WHERE workspace_id = ${workspaceId}
        AND framework_id = ${frameworkId}
        AND list_id = ${listId}
    `);
    const editRows = ((editsRes as any).rows || []) as Array<any>;
    const resolvedKeys = new Set<string>();
    for (const row of editRows) {
      const applied =
        row.applied === true || row.applied === "t" || row.applied === "true" || row.applied === 1;
      const dismissed = String(row.skip_reason || "") === "dismissed";
      if (applied || dismissed) {
        resolvedKeys.add(proposalKeyFromEditRow(row));
      }
    }
    if (resolvedKeys.size > 0) {
      const keep = (p: EditProposal): boolean =>
        p.measureId === FRAMEWORK_SENTINEL || !resolvedKeys.has(proposalKeyFromProposal(p));

      if (edits && Array.isArray(edits.proposals)) {
        const kept = edits.proposals.filter(keep);
        if (kept.length !== edits.proposals.length) {
          edits.proposals = kept;
          edits.totalWithProposals = kept.length;
          const causeBreakdown: Record<string, number> = {};
          for (const p of kept) {
            causeBreakdown[p.cause] = (causeBreakdown[p.cause] || 0) + 1;
          }
          edits.causeBreakdown = causeBreakdown as any;
        }
      }
      nearDuplicateEdits = nearDuplicateEdits.filter(keep);
    }
  } catch (e: any) {
    console.warn("[deriveProposalBundle] resolved-proposal suppression failed (non-fatal):", e?.message);
  }

  // The COMPLETE proposal set the apply path resolves against. Edit proposals
  // come FIRST so legacy positional P<idx> indices (which only ever referenced
  // edit proposals) stay stable; near-duplicate merges are appended after.
  // Framework-level proposals were appended onto edits.proposals above, so they
  // ride along here automatically (kept together with the edit proposals).
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

// ─── Env helpers (generic, defensively-clamped) ────────────────────────────

/** Boolean env flag. Truthy unless explicitly "false"/"0"/"no"/"off". */
function envFlag(name: string, dflt: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return dflt;
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

/** Integer env with a default and a lower bound (invalid → default). */
function envInt(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, n);
}

/** Float env with a default clamped to [min,max] (invalid → default). */
function envFloat(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return dflt;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ─── Framework-level candidate helpers ─────────────────────────────────────

/** Coerce a jsonb column (array | null | garbage) to a clean string[]. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

/**
 * Drop candidates already present in `registered` (case-insensitive, trimmed).
 * This is the cheap per-call re-filter that keeps memoised candidate pools
 * correct after an apply has already added some values to the live list.
 */
function filterUnregistered(candidates: string[], registered: string[]): string[] {
  const reg = new Set(
    (registered || []).map((s) => (typeof s === "string" ? s.trim().toLowerCase() : "")).filter(Boolean),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates || []) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) continue;
    const k = s.toLowerCase();
    if (reg.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
