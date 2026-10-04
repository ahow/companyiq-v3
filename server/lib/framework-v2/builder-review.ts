/**
 * STEP 1 — Builder-review composer.
 *
 * Composes the three deterministic detectors into the two selectable-change
 * lists the client renders as an accept-or-fix gate, mirroring the existing
 * `buildIssuePayload` / `StructuredIssue` pattern used by /v2/validate and
 * /v2/save:
 *
 *   (a) builderChanges        = D1 (builder<->validator drift proposals)
 *                               + D2 (recurring-defect ledger promotions)
 *   (b) generalisationFindings = D3 (generalisation-audit findings)
 *
 * Both lists are returned in the SAME {issues, issuesReadable, errorCount,
 * warningCount} envelope the client already knows, so the existing issue-gate
 * card renders them unchanged. Nothing here edits the builder or any framework:
 * the output is a GATED set of proposals the operator selects and confirms.
 *
 * implemented != verified-fixed: selecting + confirming a proposal produces a
 * proposed edit SET only. A builder change is VERIFIED only after an
 * operator-triggered regeneration shows the defect gone on a live validator run.
 *
 * Topic-agnostic: no hardcoded topic tokens or company names anywhere.
 */
import type { StructuredIssue } from "./rules.js";
import { detectBuilderDrift, type DriftProposal, type BuilderDriftReport } from "./builder-drift.js";
import { auditGeneralisation, type AuditFinding, type GeneralisationAuditReport } from "./generalisation-audit.js";
import {
  appendDefectRecords,
  readLedger,
  computeRecurrencePromotions,
  promoteThreshold,
  type DefectRecord,
  type LedgerPromotion,
} from "./defect-ledger.js";
import { resolveBuilderSource, type ResolvedBuilderSource } from "./builder-source.js";
import { builderImprove, type StructuralFinding, type BuilderImproveResult } from "./builder-improve.js";

/** The client-facing issue-list envelope (identical shape to buildIssuePayload). */
export interface IssueListPayload {
  issues: StructuredIssue[];
  issuesReadable: string;
  errorCount: number;
  warningCount: number;
}

export interface BuilderReviewResult {
  builderChanges: IssueListPayload; // list (a): D1 drift + D2 promotions
  generalisationFindings: IssueListPayload; // list (b): D3 audit
  drift: BuilderDriftReport;
  audit: GeneralisationAuditReport;
  promotions: LedgerPromotion[];
  ledger?: { appended: number; threshold: number; totalRecords: number };
  semantic?: BuilderImproveResult; // present only when requested
  source: { origin: ResolvedBuilderSource["origin"]; detail: string };
  note: string;
}

export interface BuilderReviewOptions {
  /** Explicit builder prompt text; otherwise resolved via env / in-repo default. */
  builderText?: string;
  /** Optional defect records from this review to append to the ledger before promoting. */
  defects?: Array<Partial<DefectRecord>>;
  /** Run the STEP-2 semantic pass over the combined findings. */
  semantic?: boolean;
  /** Override the ledger path (tests). */
  ledgerPath?: string;
  /** Override the promotion threshold (tests). */
  promoteThresholdOverride?: number;
  /** Injectable LLM completion for the semantic pass (tests). */
  semanticComplete?: Parameters<typeof builderImprove>[1] extends infer O
    ? O extends { complete?: infer C }
      ? C
      : never
    : never;
}

const IMPLEMENTED_NOT_VERIFIED =
  "Implemented != verified-fixed: confirming this proposal stages a builder edit only. " +
  "It is VERIFIED only after an operator-triggered regeneration shows the defect gone on a live validator run.";

const REVIEW_NOTE =
  "GATED builder review. Selecting proposals collates a proposed edit SET; it NEVER auto-applies to the " +
  "builder or to any framework. A builder change affects all future frameworks, so it must be human-approved " +
  "and then verified by an operator-triggered regeneration. " + IMPLEMENTED_NOT_VERIFIED;

/** Readable four-part rendering of an issue list (mirrors renderStructuredIssues' intent). */
function renderIssues(issues: StructuredIssue[]): string {
  if (issues.length === 0) return "No issues.";
  return issues
    .map((i, n) => {
      return [
        `${n + 1}. [${i.severity.toUpperCase()}] ${i.ruleCode} (${i.measureId} / ${i.field})`,
        `   (a) Issue:       ${i.issue}`,
        `   (b) Reason:      ${i.reason}`,
        `   (c) Solution:    ${i.solution}`,
        `   (d) Implication: ${i.implication}`,
      ].join("\n");
    })
    .join("\n\n");
}

function toPayload(issues: StructuredIssue[]): IssueListPayload {
  return {
    issues,
    issuesReadable: renderIssues(issues),
    errorCount: issues.filter((i) => i.severity === "error").length,
    warningCount: issues.filter((i) => i.severity === "warning").length,
  };
}

/** Map a D1 drift proposal → StructuredIssue (builder-change list). */
function driftToIssue(p: DriftProposal): StructuredIssue {
  return {
    id: p.id,
    ruleCode: p.rule,
    severity: p.blocking ? "error" : "warning",
    measureId: "builder-level",
    field: p.rule,
    issue: `Builder ${p.rule} ${p.type}: ${p.builderSays ? `builder says "${p.builderSays}"` : "builder is silent"}; validator enforces "${p.validatorEnforces}".`,
    reason: p.rationale,
    solution: `${p.proposedBuilderEdit}  [ref: ${p.ref}]`,
    implication: IMPLEMENTED_NOT_VERIFIED,
  };
}

/** Map a D2 ledger promotion → StructuredIssue (builder-change list). */
function promotionToIssue(p: LedgerPromotion): StructuredIssue {
  return {
    id: p.id,
    ruleCode: p.rule,
    // A promotion is a strong, recurrence-backed signal, but it remains a GATED
    // proposal (not a hard validator error), so it is surfaced as a warning.
    severity: "warning",
    measureId: "builder-level",
    field: p.field,
    issue: `Recurring defect class ${p.defectClass} promoted: seen across ${p.distinctSites} distinct sites (>= PROMOTE_THRESHOLD).`,
    reason: p.rationale,
    solution: p.proposedBuilderEdit,
    implication: IMPLEMENTED_NOT_VERIFIED,
  };
}

/** Map a D3 audit finding → StructuredIssue (generalisation-findings list). */
function auditToIssue(f: AuditFinding): StructuredIssue {
  return {
    id: `ga-${f.line}-${f.token}`,
    ruleCode: f.position === "output-schema-default" ? "generalisation:output-schema" : "generalisation:construction-rule",
    // Generalisation leaks are advisory — they degrade portability, they do not
    // make a single framework invalid — so they are warnings, never blocking.
    severity: "warning",
    measureId: `builder:line ${f.line}`,
    field: f.position,
    issue: `Topic-specific token "${f.token}" in ${f.position}: "${f.excerpt}"`,
    reason:
      f.position === "output-schema-default"
        ? "This sits in an output-schema default, so it is copied verbatim into every framework the builder produces — including ones on unrelated topics."
        : "This sits in a normative construction rule, so the topic-specific phrasing is applied to every measure the builder generates.",
    solution: f.proposedFix,
    implication:
      "Left unfixed, the builder is not truly topic-agnostic: unrelated frameworks inherit this topic's vocabulary. " +
      IMPLEMENTED_NOT_VERIFIED,
  };
}

/**
 * Compose the builder review. Pure except for the (optional) ledger append and
 * the (optional) semantic LLM pass; both are gated behind options.
 */
export async function composeBuilderReview(opts: BuilderReviewOptions = {}): Promise<BuilderReviewResult> {
  const source = resolveBuilderSource(opts.builderText);
  const drift = detectBuilderDrift(source.text);
  const audit = auditGeneralisation(source.text);

  // D2 — append this review's defects (if any) then compute recurrence promotions
  // across the WHOLE ledger (not just this review), honouring the threshold.
  const threshold = opts.promoteThresholdOverride ?? promoteThreshold();
  let ledgerMeta: BuilderReviewResult["ledger"] | undefined;
  if (opts.defects && opts.defects.length > 0) {
    const appended = appendDefectRecords(opts.defects, opts.ledgerPath);
    const all = readLedger(opts.ledgerPath);
    ledgerMeta = { appended: appended.appended, threshold, totalRecords: all.length };
  } else {
    // Still read the existing ledger so prior reviews can promote.
    const all = readLedger(opts.ledgerPath);
    if (all.length > 0) ledgerMeta = { appended: 0, threshold, totalRecords: all.length };
  }
  const ledgerRecords = ledgerMeta ? readLedger(opts.ledgerPath) : [];
  const promotions = computeRecurrencePromotions(ledgerRecords, threshold);

  // List (a): D1 drift proposals + D2 promotions.
  const builderChangeIssues: StructuredIssue[] = [
    ...drift.proposals.map(driftToIssue),
    ...promotions.map(promotionToIssue),
  ];
  // List (b): D3 generalisation findings.
  const generalisationIssues: StructuredIssue[] = audit.findings.map(auditToIssue);

  // STEP 2 — optional semantic pass over the COMBINED D1 + D2 + D3 findings.
  let semantic: BuilderImproveResult | undefined;
  if (opts.semantic) {
    const structural: StructuralFinding[] = [
      ...drift.proposals.map((p) => ({
        id: p.id,
        source: "D1" as const,
        rule: p.rule,
        field: p.rule,
        summary: `${p.type}: ${p.rationale}`,
      })),
      ...promotions.map((p) => ({
        id: p.id,
        source: "D2" as const,
        rule: p.rule,
        field: p.field,
        summary: p.rationale,
      })),
      ...audit.findings.map((f) => ({
        id: `ga-${f.line}-${f.token}`,
        source: "D3" as const,
        rule: f.position,
        field: f.position,
        summary: `topic token ${f.token}: ${f.excerpt}`,
      })),
    ];
    semantic = await builderImprove(structural, {
      complete: opts.semanticComplete as any,
    });
  }

  return {
    builderChanges: toPayload(builderChangeIssues),
    generalisationFindings: toPayload(generalisationIssues),
    drift,
    audit,
    promotions,
    ledger: ledgerMeta,
    semantic,
    source: { origin: source.origin, detail: source.detail },
    note: REVIEW_NOTE,
  };
}
