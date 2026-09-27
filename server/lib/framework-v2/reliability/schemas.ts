/**
 * Builder-reliability shared schemas (Stage 1 foundation).
 *
 * These types are the contract that later stages (runtime execution, JSON export,
 * Markdown export, structured-rule evaluation, cross-reference integrity) all import.
 * They are intentionally minimal but precise: the goal is a single canonical shape
 * from which runtime AND both export formats derive, so the three artefacts can never
 * silently disagree.
 *
 * NOTHING here is topic-, company-, or framework-specific. All fields are generic
 * surfaces that any framework populates.
 *
 * Design notes and invariants are documented in docs/builder-reliability/SCHEMAS.md.
 */

// ---------------------------------------------------------------------------
// 1. ResolvedConfig — the single source of truth
// ---------------------------------------------------------------------------

/**
 * A retrieval anchor framework, stored as a typed record rather than a bare string
 * so that provenance (where the anchor came from) is auditable and a null source is
 * explicit rather than implied by an empty string.
 */
export interface AnchorFramework {
  name: string;
  /** Provenance of the anchor: a citation/URL/dataset id, or null when unknown. */
  source: string | null;
}

/**
 * A single measure as it appears in the resolved config. This mirrors the
 * decision-relevant surface of a framework measure without re-declaring the full
 * builder MeasureDraft — later stages that need the full draft import it from
 * ../rules.js. Kept structurally open (index signature) so callers can carry
 * additional builder fields through without loss.
 */
export interface ResolvedMeasure {
  measureId: string;
  title?: string;
  substantive_definition?: string;
  whatConstitutesEvidence?: string;
  fallback_yes_criterion?: string;
  scoringGuidance?: string;
  /** Per-measure retrieval evidence keywords (a distinct lexicon surface). */
  evidenceKeywords?: string[];
  [key: string]: unknown;
}

/**
 * ResolvedConfig is the ONE canonical, fully-resolved configuration for a framework.
 *
 * AUTHORITY / PRECEDENCE (see SCHEMAS.md): the runtime, the JSON export, and the
 * Markdown export MUST all derive from this object. Root-level fields and any nested
 * artefact (e.g. the original intake) MUST NOT be independently editable with
 * ambiguous precedence — ResolvedConfig is authoritative. The original intake artefact
 * is retained ONLY for audit (`intakeArtefact`); it is never a second live source of
 * config that runtime or exports read from.
 */
export interface ResolvedConfig {
  // -- Identity / scope ------------------------------------------------------
  frameworkName: string;
  topicTerm: string;

  /**
   * Scope surfaces. These are DISTINCT, first-class fields (not folded into a
   * free-text blob) so runtime and exports can reason about each independently.
   */
  entityType: string | null;
  sectorScope: string | null;
  universe: string | null;
  reportingPeriod: string | null;

  // -- Retrieval lexicon surfaces (kept DISTINCT on purpose) -----------------
  /**
   * These four surfaces are deliberately separate rather than a single merged
   * "keywords" bag: each is consumed differently by retrieval and each is subject
   * to hygiene independently (see Workstream 1). Collapsing them loses the ability
   * to apply the correct hygiene/admission rules per surface.
   */
  topicSynonyms: string[];
  evidenceKeywords: string[];
  documentFilingHints: string[];
  retrievalQueryTerms?: string[];

  /** Terms that must actively suppress / down-weight a match. */
  negativeKeywords: string[];
  /** Rules that forbid inferring a positive when evidence is only indirect. */
  antiInferenceRules: string[];

  // -- Framework content -----------------------------------------------------
  anchorFrameworks: AnchorFramework[];
  measures: ResolvedMeasure[];

  // -- Audit -----------------------------------------------------------------
  /**
   * The ORIGINAL intake artefact, retained verbatim for audit/traceability.
   * This is NOT a live config surface: nothing at runtime or export time should
   * read configuration from here in preference to the resolved fields above.
   * Typed as unknown so the raw artefact shape is preserved without coupling.
   */
  intakeArtefact: unknown;

  /** Schema/version marker so downstream consumers can detect shape drift. */
  resolvedConfigVersion: number;
}

export const RESOLVED_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// 2. StructuredRule — machine-evaluable rule (defined now, evaluated in Stage 3)
// ---------------------------------------------------------------------------

/** A concrete, checkable threshold bound to a measurable quantity. */
export interface RuleThreshold {
  /** What is being compared (e.g. a metric id or evidence field key). */
  subject: string;
  operator: ">=" | "<=" | ">" | "<" | "==" | "!=";
  value: number | string;
  /** Optional unit, for display and to prevent unit-mismatch false positives. */
  unit?: string | null;
}

/** Binds a rule clause to the evidence that must support it. */
export interface EvidenceBinding {
  /** Which resolved measure this evidence is drawn from. */
  measureId: string;
  /** Stable hash of the bound measure content (see StructuredReference). */
  contentHash: string;
  /** Human-readable description of the required evidence. */
  description?: string;
}

/**
 * A StructuredRule expresses builder logic explicitly and machine-readably instead
 * of as free-text prose, so it can be evaluated deterministically. Evaluation is
 * implemented in Stage 3; the TYPE is fixed now so Stage 1/2 artefacts can already
 * reference and store it.
 */
export interface StructuredRule {
  ruleId: string;
  ruleVersion: number;
  /** Clauses that must ALL hold. */
  requiredClauses: string[];
  /** Groups of clauses where at least one alternative in each group must hold. */
  orAlternatives: string[][];
  /** Clauses whose presence forces a fail (disqualifiers). */
  exclusions: string[];
  thresholds: RuleThreshold[];
  evidenceBindings: EvidenceBinding[];
}

/**
 * THREE-VALUED result. Critically, evaluation must never report a falsely-certain
 * pass/fail when the interpretation is genuinely uncertain — it returns
 * "unknown-review-required" instead, which a human dispositions.
 */
export type StructuredRuleStatus = "pass" | "fail" | "unknown-review-required";

export interface StructuredRuleResult {
  ruleId: string;
  ruleVersion: number;
  status: StructuredRuleStatus;
  /** Per-clause detail, for explainability and audit. */
  clauseResults: Array<{
    clause: string;
    status: StructuredRuleStatus;
    reason?: string;
  }>;
  /** Why the overall status is what it is (esp. for unknown-review-required). */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// 3. StructuredReference — a typed, staleness-detectable reference to a measure
// ---------------------------------------------------------------------------

/**
 * A reference to a measure stored as structured data (NOT free text), so that when
 * the referenced measure's content changes, the reference can be detected as stale.
 */
export interface StructuredReference {
  measureId: string;
  /** Stable hash of the referenced measure's decision-relevant fields. */
  contentHash: string;
  /** Optional rule version, when the reference is tied to a specific rule revision. */
  ruleVersion?: number;
}

// ---------------------------------------------------------------------------
// 4. ValidationState — keep three concepts separate
// ---------------------------------------------------------------------------

/**
 * The machine-readable outcome of a check. This is distinct from whether a draft was
 * saved and distinct from whether an operator dismissed the diagnostic.
 *
 * - "passed"                   the check evaluated and holds
 * - "failed"                   the check evaluated and does not hold
 * - "unresolved"               the check could not complete (e.g. missing input)
 * - "unknown-review-required"  the check is inherently uncertain and needs a human
 */
export type CheckStatus =
  | "passed"
  | "failed"
  | "unresolved"
  | "unknown-review-required";

/** An explicit operator override, recorded WITHOUT changing the machine status. */
export interface OperatorOverride {
  /** Who applied the override (operator id / name). */
  by: string;
  /** ISO timestamp of the override. */
  at: string;
  /** Operator's justification. */
  reason: string;
  /**
   * The disposition the operator asserts (e.g. "accept-risk", "false-positive").
   * This is the operator's OPINION; it never mutates `status`.
   */
  disposition: string;
}

/**
 * ValidationState keeps THREE concepts strictly separate:
 *   1. `status`               — the machine-readable check outcome (authoritative record)
 *   2. `dismissedByOperator`  — whether a human hid/acknowledged the diagnostic in the UI
 *   3. `operatorOverride`     — a recorded human judgement about the diagnostic
 *
 * DOCUMENTED INVARIANT (enforced by carryValidationStateIntoPayload and asserted in
 * tests): neither `dismissedByOperator` nor `operatorOverride` ever changes `status`.
 * A failed check stays failed in the record even after it is dismissed, saved, and run;
 * that status — together with any override — is carried into run and exported results.
 * Severity and dismissal never determine whether saving/running is permitted.
 */
export interface ValidationState {
  checkId: string;
  status: CheckStatus;
  dismissedByOperator: boolean;
  operatorOverride?: OperatorOverride;
}

/**
 * The shape carried into run/export payloads. It preserves the authoritative status
 * verbatim alongside the (non-authoritative) operator disposition, so downstream
 * consumers see both the machine truth and the human annotation without conflation.
 */
export interface CarriedValidationState {
  checkId: string;
  /** Authoritative machine status — copied unchanged from ValidationState.status. */
  status: CheckStatus;
  dismissedByOperator: boolean;
  operatorOverride?: OperatorOverride;
  /**
   * Convenience flag for UIs: true iff the underlying check did NOT pass, regardless
   * of dismissal/override. Derived from `status`, never from dismissal.
   */
  requiresAttention: boolean;
}

/**
 * Carry a validation state into a run/export payload while ENFORCING the invariant
 * that dismissal/override never alter the machine status.
 *
 * This is deliberately the only sanctioned way to move a ValidationState into an
 * outbound payload, so the invariant lives in one place.
 */
export function carryValidationStateIntoPayload(
  state: ValidationState,
): CarriedValidationState {
  // `status` is copied verbatim. We intentionally do NOT read dismissedByOperator or
  // operatorOverride when deciding the status — that is the whole point of the invariant.
  const requiresAttention = state.status !== "passed";
  return {
    checkId: state.checkId,
    status: state.status,
    dismissedByOperator: state.dismissedByOperator,
    ...(state.operatorOverride ? { operatorOverride: state.operatorOverride } : {}),
    requiresAttention,
  };
}

/** Carry a batch of validation states, preserving each authoritative status. */
export function carryValidationStatesIntoPayload(
  states: ValidationState[],
): CarriedValidationState[] {
  return states.map(carryValidationStateIntoPayload);
}
