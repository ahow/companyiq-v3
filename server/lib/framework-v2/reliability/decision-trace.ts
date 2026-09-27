/**
 * decision-trace.ts — WS-B (P1): per-decision traceability record.
 *
 * WHY (reviewer): every scored measure/cell must carry, and be able to EXPORT, a
 * complete, immutable record of WHAT governed the decision, so a run can be
 * audited and reproduced long after it was executed:
 *   - the run/analysis ID it belongs to;
 *   - an immutable framework hash (a content hash of the framework + its measures
 *     AS EXECUTED) plus the framework id/version;
 *   - the canonical rule ID + version + provenance + sourceField;
 *   - the selected clauses used;
 *   - the fallback-activation reason (when a strict fallback governed the bar);
 *   - the evidence passage bound to THIS decision (a quote tied to the clauses);
 *   - the validation status (flaggedForReview + a THREE-VALUED pass/fail/unknown).
 *
 * FAIL-LOUD: if a decision lacks a bound canonical rule, or a positive verdict has
 * no bound evidence passage, the `diagnostics` array records exactly why and the
 * validation status becomes "fail". The record is NEVER silently blanked — an
 * un-attributable decision is surfaced, not hidden.
 *
 * PURE / DB-FREE / NON-MUTATING: every function is pure over plain objects. Inputs
 * are never mutated; a NEW trace object is always returned. Nothing here is
 * framework/measure/company/topic-specific.
 */

import { createHash } from "crypto";
import { measureContentHash } from "./canonical-rule.js";
import type { CanonicalRuleTrace } from "./canonical-rule.js";

/** A single evidence passage bound to a decision (a verbatim quote + its source). */
export interface DecisionTraceEvidence {
  quote: string;
  source: string;
  sourceUrl?: string;
  page?: number;
}

/** Three-valued validation status of the decision record (Kleene-style). */
export type DecisionValidationStatus = "pass" | "fail" | "unknown";

/** The complete, exportable, immutable per-decision traceability record. */
export interface DecisionTrace {
  /** Bump when the record shape changes; lets exporters/consumers migrate safely. */
  schemaVersion: 1;

  // ── Run / analysis + framework identity ──────────────────────────────────
  /** Run/analysis (batch) ID this decision belongs to; null for ad-hoc scoring. */
  runId: number | null;
  companyId: number;
  measureId: string;
  frameworkId: number;
  frameworkVersion: number | null;
  /** Immutable content hash of the framework + measures AS EXECUTED. */
  frameworkHash: string;
  /** Content hash of THIS measure's decision-relevant fields (staleness detection). */
  measureContentHash: string | null;

  // ── Canonical rule that governed the decision ────────────────────────────
  canonicalRule: {
    ruleId: string;
    ruleVersion: number;
    provenance: string;
    sourceField: string;
    /** The selected clauses that make up the canonical Yes-bar used here. */
    clausesUsed: string[];
    finalDecisionBasis: string;
  } | null;

  // ── Fallback activation ──────────────────────────────────────────────────
  /** True when the Yes-bar was derived ONLY from a strict fallback criterion. */
  fallbackActivated: boolean;
  /** Human-readable reason a fallback governed the bar; null when it did not. */
  fallbackReason: string | null;

  // ── Decision + bound evidence ────────────────────────────────────────────
  verdict: string;
  /** Evidence passages bound to THIS decision (diagnostic sidecar quotes excluded). */
  evidencePassages: DecisionTraceEvidence[];
  /** The clauses the bound evidence is tied to (the canonical rule's clausesUsed). */
  evidenceBoundToClauses: string[];
  /** Any operator override recorded on the decision (never mutates the outcome). */
  override: string | null;

  // ── Validation ───────────────────────────────────────────────────────────
  validation: {
    flaggedForReview: boolean;
    status: DecisionValidationStatus;
  };

  /** FAIL-LOUD: concrete reasons the record could not be fully attributed. Empty
   *  array when the decision is fully bound; NEVER left undefined/blank. */
  diagnostics: string[];
}

/** Minimal framework shape needed to compute the immutable framework hash. */
export interface FrameworkHashInput {
  id: number;
  version?: number | null;
  topicTerm?: string | null;
  topicSynonyms?: string[] | null;
}

/**
 * Compute the IMMUTABLE framework-content hash for a run: a stable digest of the
 * framework's identity/topic anchoring plus the per-measure decision-relevant
 * content hashes of every measure AS EXECUTED (in the order supplied). Reuses the
 * same `measureContentHash` the canonical rule uses, so the framework hash moves
 * in lockstep with the per-measure hashes. Pure; order-sensitive by design (a
 * reordered measure set is a different executed framework).
 */
export function computeFrameworkContentHash(framework: FrameworkHashInput, measures: any[]): string {
  const measureHashes = (Array.isArray(measures) ? measures : []).map((m) => measureContentHash(m));
  const payload = {
    frameworkId: framework?.id ?? null,
    frameworkVersion: framework?.version ?? null,
    topicTerm: framework?.topicTerm ?? null,
    topicSynonyms: Array.isArray(framework?.topicSynonyms) ? framework!.topicSynonyms : null,
    measureHashes,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

/** A diagnostic sidecar quote (never real evidence) — excluded from bound evidence. */
function isDiagnosticQuote(q: { sourceUrl?: string } | null | undefined): boolean {
  const u = (q?.sourceUrl || "").trim().toLowerCase();
  return u.startsWith("diag://");
}

const POSITIVE_VERDICTS = new Set(["Yes", "Partial"]);
const INDETERMINATE_VERDICTS = new Set(["Insufficient evidence", "Scoring error"]);

/**
 * Build the per-decision traceability record for one scored measure. Pure; safe on
 * the scoring/persistence path. `canonicalRuleTrace` is the trace already attached
 * to the MeasureResult (see canonical-rule.buildCanonicalRuleTrace); `frameworkHash`
 * is the run-level immutable hash from computeFrameworkContentHash. FAIL-LOUD:
 * missing rule/evidence is recorded in `diagnostics`, never silently dropped.
 */
export function buildDecisionTrace(input: {
  companyId: number;
  measureId: string;
  verdict: string;
  quotes?: Array<{ text: string; source: string; sourceUrl?: string; page?: number }> | null;
  canonicalRuleTrace?: CanonicalRuleTrace | null;
  runId?: number | null;
  frameworkId: number;
  frameworkVersion?: number | null;
  frameworkHash: string;
  override?: string | null;
}): DecisionTrace {
  const trace = input.canonicalRuleTrace ?? null;
  const diagnostics: string[] = [];

  // Bind ONLY real evidence passages (drop diagnostic sidecar quotes).
  const evidencePassages: DecisionTraceEvidence[] = (input.quotes || [])
    .filter((q) => q && typeof q.text === "string" && q.text.trim().length > 0 && !isDiagnosticQuote(q))
    .map((q) => ({
      quote: q.text,
      source: q.source,
      ...(q.sourceUrl ? { sourceUrl: q.sourceUrl } : {}),
      ...(typeof q.page === "number" ? { page: q.page } : {}),
    }));

  // FAIL-LOUD 1: a decision must have a bound canonical rule.
  if (!trace) {
    diagnostics.push(
      "No canonical rule trace bound to this decision — the Yes-bar that governed it cannot be attributed.",
    );
  }

  // FAIL-LOUD 2: a positive verdict must have at least one bound evidence passage.
  const isPositive = POSITIVE_VERDICTS.has(input.verdict);
  if (isPositive && evidencePassages.length === 0) {
    diagnostics.push(
      `Positive verdict ("${input.verdict}") has no bound evidence passage — the evidence-to-decision binding is missing.`,
    );
  }

  const fallbackActivated = trace?.provenance === "fallback-derived";
  const fallbackReason = fallbackActivated
    ? trace?.finalDecisionBasis ??
      "Yes-bar derived only from a strict fallback criterion (no substantive criterion present)."
    : null;

  const flaggedForReview = trace?.flaggedForReview ?? false;

  // Three-valued validation status:
  //   fail    → a fail-loud integrity problem was recorded above
  //   unknown → the rule was flagged for review, or the verdict is indeterminate
  //   pass    → fully bound, not flagged, and a determinate verdict
  let status: DecisionValidationStatus;
  if (diagnostics.length > 0) {
    status = "fail";
  } else if (flaggedForReview || INDETERMINATE_VERDICTS.has(input.verdict)) {
    status = "unknown";
  } else {
    status = "pass";
  }

  return {
    schemaVersion: 1,
    runId: input.runId ?? null,
    companyId: input.companyId,
    measureId: input.measureId,
    frameworkId: input.frameworkId,
    frameworkVersion: input.frameworkVersion ?? null,
    frameworkHash: input.frameworkHash,
    measureContentHash: trace?.frameworkHash ?? null,
    canonicalRule: trace
      ? {
          ruleId: trace.ruleId,
          ruleVersion: trace.ruleVersion,
          provenance: trace.provenance,
          sourceField: trace.sourceField,
          clausesUsed: trace.clausesUsed ?? [],
          finalDecisionBasis: trace.finalDecisionBasis,
        }
      : null,
    fallbackActivated,
    fallbackReason,
    verdict: input.verdict,
    evidencePassages,
    evidenceBoundToClauses: trace?.clausesUsed ?? [],
    override: input.override ?? trace?.override ?? null,
    validation: { flaggedForReview, status },
    diagnostics,
  };
}
