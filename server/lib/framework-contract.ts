/**
 * framework-contract.ts — A6 / WP07: strengthen framework contracts and
 * test-drive diagnosis.
 *
 * WHY (plan §"A6. Strengthen framework contracts and test-drive diagnosis
 * (WP07)"):
 *   The reviewer's carried-forward concern is NOT that the framework has no
 *   contract — the app ALREADY carries most contract facets, each single-sourced
 *   in an existing framework-v2 module:
 *     - scoring outcomes / precedence / uncertainty-downgrade  → scoring-contract.ts
 *       (resolveScoringContract, LOW_CONFIDENCE_POSITIVE_TO_PARTIAL)
 *     - qualifying / non-qualifying evidence, yes/no examples, rationale(quote)
 *       requirement                                            → structured-guidance.ts
 *     - anti-inference rules                                   → anti-inference.ts
 *       (composeAntiInferenceRules)
 *     - decidable definition (C11)                             → framework-v2/rules.ts
 *     - entity / provenance / temporal scope                  → eligibility-decision.ts (A3)
 *     - a defect root-cause split (corpus vs framework)        → root-cause-diagnostic.ts
 *     - a Goodhart guard on BUILDER proposals                  → builder-improve.ts
 *       (applyGoodhartGuard — structural-root-cause + anti-homogenisation)
 *     - a NON-destructive "new hardened version" emitter       → scoring-contract.ts
 *       (emitHardenedFramework — bumps version, never mutates the input)
 *
 *   The GENUINE gaps A6 closes, confirmed by inspection, are:
 *     (G1) No ONE assembled per-measure CONTRACT VIEW that ties every A6 facet
 *          together AND makes the two load-bearing invariants explicit and
 *          checkable: "examples ILLUSTRATE the rule, they never silently change
 *          it" and "search hints are NOT eligibility criteria". The facets exist
 *          but nothing composes them or guards those two invariants.
 *     (G2) No test-drive defect CLASSIFIER over the seven A6 categories
 *          (framework-ambiguity / discovery / acquisition-extraction /
 *          entity-provenance / retrieval / scoring / technical) and no
 *          missed-DOCUMENT routing — the existing root-cause split is
 *          company/measure-level and does not route an individual missed
 *          document to a RESEARCH fix rather than a looser rubric (FW01).
 *     (G3) No validator that REJECTS a proposed rubric edit JUSTIFIED BY
 *          prevalence / a target yes-rate distribution (FW02), nor one that
 *          rejects a company-specific fix unless it is an explicit UNIVERSAL
 *          data correction (Q7), nor a path that forces an accepted edit to
 *          produce a NEW framework version WITH an impact preview instead of a
 *          silent rewrite of published scores.
 *
 * WHAT THIS MODULE IS:
 *   A deterministic, pure, DB-free GOVERNANCE layer that REUSES the modules
 *   above and only adds G1/G2/G3. Every exported function is total (never throws
 *   on bad input) and returns a frozen object.
 *
 * VERSIONING / KILL-SWITCH (mirrors ELIGIBILITY_POLICY / PREP_COMPUTE_CACHE_POLICY):
 *   resolveFrameworkContractPolicy() reads env FRAMEWORK_CONTRACT_POLICY.
 *     - "shadow" (DEFAULT): verdict-invariant passthrough. Attach the assembled
 *       contract metadata, the defect classification and the edit impact-preview,
 *       but mutate NO published score and apply NO rubric edit. Shipping A6 in
 *       the default state changes zero published scores BY CONSTRUCTION.
 *     - "enforce" (NOT set in prod): the same analysis, but an accepted edit is
 *       allowed to EMIT a NEW framework version (via emitHardenedFramework) whose
 *       impact preview is attached. Even here the CURRENT published version's
 *       scores are never rewritten — a new version is created instead.
 *   FRAMEWORK_CONTRACT_POLICY_VERSION pins the governance schema so a stored
 *   result can be migrated deterministically.
 *
 * SAFETY INVARIANT (both policies): runContractGovernance(...).publishedScoresMutated
 * is ALWAYS false. A6 never mutates a published score; accepted edits only ever
 * yield a NEW version.
 */

import {
  resolveScoringContract,
  emitHardenedFramework,
  LOW_CONFIDENCE_POSITIVE_TO_PARTIAL,
  type ScoringContract,
  type EmitHardenedResult,
} from "./framework-v2/scoring-contract.js";
import { composeAntiInferenceRules } from "./anti-inference.js";
import { extractGuidanceObject } from "./framework-guidance-audit.js";

// ─── Policy version / kill-switch ─────────────────────────────────────────────

export type FrameworkContractPolicy = "shadow" | "enforce";

/** DEFAULT is the non-mutating, verdict-invariant passthrough. */
export const DEFAULT_FRAMEWORK_CONTRACT_POLICY: FrameworkContractPolicy = "shadow";

/** Env var that toggles the policy. Versioned per repo convention. */
export const FRAMEWORK_CONTRACT_POLICY_ENV = "FRAMEWORK_CONTRACT_POLICY";

/** Governance schema version (bump when the serialized shape changes). */
export const FRAMEWORK_CONTRACT_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env FRAMEWORK_CONTRACT_POLICY >
 * default "shadow". Any unrecognised value falls back to the safe default
 * (fail-safe to non-mutating).
 */
export function resolveFrameworkContractPolicy(
  explicit?: FrameworkContractPolicy | null,
): FrameworkContractPolicy {
  if (explicit === "shadow" || explicit === "enforce") return explicit;
  const env = (process.env[FRAMEWORK_CONTRACT_POLICY_ENV] || "").trim().toLowerCase();
  if (env === "shadow") return "shadow";
  if (env === "enforce") return "enforce";
  return DEFAULT_FRAMEWORK_CONTRACT_POLICY;
}

/** True when the policy would APPLY hardening (emit a new version), not just shadow it. */
export function isFrameworkContractEnforced(explicit?: FrameworkContractPolicy | null): boolean {
  return resolveFrameworkContractPolicy(explicit) === "enforce";
}

// ─── Small total helpers (never throw) ────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v).trim();
    if (s) return s;
  }
  return "";
}
function arr<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function freeze<T>(v: T): T {
  return Object.freeze(v) as T;
}

// ════════════════════════════════════════════════════════════════════════════
// G1 — the assembled per-measure CONTRACT VIEW
// ════════════════════════════════════════════════════════════════════════════

/**
 * Where a measure sits on the implementation-vs-aspiration axis.
 *   "implementation" — the measure asks for an IMPLEMENTED practice; forward-
 *     looking / aspirational language (intends to, aims to, is committed to,
 *     will, plans to, by 20XX) can NEVER satisfy it on its own (FW03).
 *   "aspiration-eligible" — a stated commitment/target IS itself the thing being
 *     measured (e.g. "has a net-zero TARGET"), so aspirational phrasing qualifies.
 */
export type MeasureStance = "implementation" | "aspiration-eligible";

export interface MeasureScope {
  /** Required source types / provenance classes (from requiredSourceTypes). */
  source: string[];
  /** Entity scope: whose disclosure counts (self vs group). Free-text, generic. */
  entity: string;
  /** Temporal scope: current-state vs historical. Free-text, generic. */
  time: string;
}

/**
 * The single assembled per-measure contract. Every field is sourced from an
 * existing module where one exists (noted inline); only `construct`, `scope`,
 * `applicability`, `stance`, `searchHints` and the two `invariants` are new.
 */
export interface MeasureContract {
  contractModelVersion: number;
  measureId: string;
  /** The latent property the measure is a proxy for (construct). */
  construct: string;
  /** The decidable Yes-bar definition (resolved by scoring-contract precedence). */
  definition: string;
  /** Evidence that QUALIFIES (StructuredGuidance.qualifyingInstance). */
  qualifyingEvidence: string;
  /** Evidence that does NOT qualify (StructuredGuidance.disqualifiers). */
  nonQualifyingEvidence: string[];
  /** Source / entity / time scope. */
  scope: MeasureScope;
  /** When the measure applies at all (applicability, not nondisclosure). */
  applicability: string;
  /** Implementation-vs-aspiration axis. */
  stance: MeasureStance;
  /** Composed anti-inference rules (anti-inference.ts). */
  antiInferenceRules: string;
  /** The reused scoring contract (outcomes / precedence / downgrade). */
  scoring: ScoringContract;
  /** Rationale requirement (StructuredGuidance.yesRequiresQuote). */
  rationaleRequirement: string;
  /** How uncertainty is handled (the named downgrade rule). */
  uncertaintyHandling: string;
  /**
   * Illustrative yes/no examples (StructuredGuidance.anchors). INVARIANT: these
   * ILLUSTRATE the rule; they are never the rule. `invariants.examplesIllustrateOnly`
   * records this is enforced.
   */
  examples: { yes: string; no: string };
  /**
   * Search hints recorded SEPARATELY from the definition. INVARIANT: search
   * hints are NOT eligibility criteria and never feed the Yes-bar.
   */
  searchHints: string[];
  invariants: {
    /** Examples never mutate the rule (checked by examplesMutateRule()). */
    examplesIllustrateOnly: true;
    /** Search hints never act as eligibility criteria (checked at assembly). */
    searchHintsAreNotEligibility: true;
  };
}

const ASPIRATION_SOURCE_HINTS =
  /\b(target|commitment|pledge|ambition|aspiration|goal|intends?|aims?|plan(s|ned)? to|net[\s-]?zero by|by 20\d\d)\b/i;

/**
 * Infer the implementation-vs-aspiration stance from the measure's own text. A
 * measure whose construct is literally a target/commitment is aspiration-eligible;
 * everything else is implementation (the conservative default — aspiration can
 * NOT satisfy it). Topic-agnostic: matches generic commitment language only.
 */
function inferStance(construct: string, definition: string): MeasureStance {
  const hay = `${construct} ${definition}`;
  // Only treat as aspiration-eligible when the CONSTRUCT itself is the target/
  // commitment (e.g. "has set a reduction target"), not merely mentions one.
  if (/\b(has|have|sets?|set a|established|published|discloses?)\b[^.]*\b(target|commitment|pledge|goal)\b/i.test(hay)) {
    return "aspiration-eligible";
  }
  return "implementation";
}

/**
 * Assemble the full MeasureContract for one measure, REUSING the existing
 * single-source modules. Pure; never mutates the input measure. The optional
 * framework carries framework-level anti-inference rules + topic term.
 */
export function buildMeasureContract(
  measure: any,
  framework?: { antiInferenceRules?: string[] | null; topicTerm?: string | null } | null,
): MeasureContract {
  const measureId = firstNonEmpty(measure?.measureId, measure?.measure_id);
  const title = firstNonEmpty(measure?.title, measure?.name);

  // Scoring contract (outcomes / precedence / downgrade / uncertainty) — reuse.
  const scoring = resolveScoringContract(measure);

  // Structured guidance (qualifying / non-qualifying / examples / rationale).
  const guidanceRaw = firstNonEmpty(measure?.scoringGuidance, measure?.scoring_guidance);
  const g = guidanceRaw ? extractGuidanceObject(guidanceRaw) : null;
  const qualifyingEvidence = firstNonEmpty(
    g?.qualifyingInstance,
    measure?.whatConstitutesEvidence,
    measure?.what_constitutes_evidence,
  );
  const nonQualifyingEvidence = [
    ...arr<string>(g?.disqualifiers).map((d) => str(d).trim()).filter(Boolean),
    ...arr<string>(measure?.whatDoesNotConstituteEvidence).map((d) => str(d).trim()).filter(Boolean),
  ];
  const examples = {
    yes: firstNonEmpty(g?.anchors?.yes, arr(measure?.positiveExamples)[0]),
    no: firstNonEmpty(g?.anchors?.no, arr(measure?.negativeExamples)[0]),
  };
  const rationaleRequirement = firstNonEmpty(
    g?.yesRequiresQuote,
    "A Yes requires a verbatim quote from the assessed entity's own evidence.",
  );

  const construct = firstNonEmpty(
    measure?.construct,
    measure?.primaryAssessmentTarget,
    measure?.primary_assessment_target,
    title,
    "the latent property this measure is a proxy for",
  );
  const definition = firstNonEmpty(
    measure?.substantiveDefinition,
    measure?.substantive_definition,
    measure?.definition,
    qualifyingEvidence,
    scoring.outcomes.yes,
  );

  // Scope: source types are eligibility; search hints are NOT (kept separate).
  const scope: MeasureScope = {
    source: arr<string>(measure?.requiredSourceTypes ?? measure?.required_source_types)
      .map((s) => str(s).trim())
      .filter(Boolean),
    entity: firstNonEmpty(measure?.entityScope, measure?.entity_scope, "the assessed entity's own disclosures"),
    time: firstNonEmpty(measure?.timeScope, measure?.time_scope, "the current state at the as-of date"),
  };

  // Search hints / evidence keywords — recorded, but NEVER part of eligibility.
  const searchHints = arr<string>(measure?.evidenceKeywords ?? measure?.evidence_keywords)
    .map((s) => str(s).trim())
    .filter(Boolean);

  const applicability = firstNonEmpty(
    measure?.applicability,
    measure?.applicabilityNote,
    "Applies to every assessed entity unless its role/sector makes the measure N-A.",
  );

  const stance = inferStance(construct, definition);

  const antiInferenceRules = composeAntiInferenceRules(
    measureId,
    title,
    framework?.antiInferenceRules ?? null,
    framework?.topicTerm ?? null,
  );

  return freeze<MeasureContract>({
    contractModelVersion: FRAMEWORK_CONTRACT_POLICY_VERSION,
    measureId,
    construct,
    definition,
    qualifyingEvidence,
    nonQualifyingEvidence: freeze(nonQualifyingEvidence),
    scope: freeze({ ...scope, source: freeze(scope.source) }) as MeasureScope,
    applicability,
    stance,
    antiInferenceRules,
    scoring,
    rationaleRequirement,
    uncertaintyHandling: `${LOW_CONFIDENCE_POSITIVE_TO_PARTIAL.id}: ${LOW_CONFIDENCE_POSITIVE_TO_PARTIAL.description}`,
    examples: freeze(examples),
    searchHints: freeze(searchHints),
    invariants: freeze({ examplesIllustrateOnly: true, searchHintsAreNotEligibility: true }),
  });
}

/**
 * INVARIANT CHECK — "examples illustrate the rule; they never silently change it".
 * Returns true (a VIOLATION) if the proposed definition text is nothing more than
 * one of the contract's illustrative examples promoted into the rule. Used by the
 * edit validator so an example can never leak in as the Yes-bar.
 */
export function examplesMutateRule(contract: MeasureContract, proposedDefinition: string): boolean {
  const def = str(proposedDefinition).trim().toLowerCase();
  if (!def) return false;
  const ex = [contract.examples.yes, contract.examples.no].map((e) => str(e).trim().toLowerCase()).filter(Boolean);
  return ex.some((e) => e.length > 0 && (def === e || (e.length >= 24 && def.includes(e) && def.length <= e.length + 8)));
}

/**
 * INVARIANT CHECK — "search hints are not eligibility criteria". Returns true (a
 * VIOLATION) if a proposed Yes-criterion is satisfied ONLY by the presence of a
 * search-hint token (i.e. a keyword match standing in for substantive evidence).
 */
export function searchHintUsedAsEligibility(contract: MeasureContract, proposedCriterion: string): boolean {
  const crit = str(proposedCriterion).trim().toLowerCase();
  if (!crit) return false;
  // A criterion that literally says "contains/mentions <hint>" with no substantive
  // verb is a keyword gate masquerading as eligibility.
  const keywordGate = /\b(contains?|mentions?|includes?|matches?)\b/.test(crit) &&
    !/\b(disclos|implement|establish|operat|publish|adopt|conduct|report that|states that)\w*/.test(crit);
  if (!keywordGate) return false;
  return contract.searchHints.some((h) => h && crit.includes(h.toLowerCase()));
}

// ─── Contract serialization (FW06: export/import preserves hardening fields) ──

/** Deterministic JSON serialization preserving every hardening field. */
export function serializeMeasureContract(c: MeasureContract): string {
  return JSON.stringify(c);
}

/** Parse a serialized contract back, re-freezing. Total: returns null on garbage. */
export function parseMeasureContract(raw: string | null | undefined): MeasureContract | null {
  const s = str(raw).trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (!o || typeof o !== "object" || !("measureId" in o) || !("scoring" in o)) return null;
    return freeze(o) as MeasureContract;
  } catch {
    return null;
  }
}

/**
 * FW03 helper — can aspirational evidence satisfy this contract? For an
 * implementation-stance measure, forward-looking/aspirational text alone can
 * NEVER satisfy the Yes-bar. Returns the decision with a reason. Pure.
 */
export function aspirationalEvidenceSatisfies(
  contract: MeasureContract,
  evidenceText: string,
): { satisfies: boolean; reason: string } {
  const text = str(evidenceText);
  const looksAspirational = ASPIRATION_SOURCE_HINTS.test(text) ||
    /\b(will|intends? to|aims? to|plans? to|committed to|is working (toward|to)|by 20\d\d)\b/i.test(text);
  if (!looksAspirational) {
    return { satisfies: true, reason: "Evidence is not purely aspirational; the stance check does not block it." };
  }
  if (contract.stance === "aspiration-eligible") {
    return { satisfies: true, reason: "Measure construct is itself a target/commitment; aspirational phrasing qualifies." };
  }
  return {
    satisfies: false,
    reason:
      "Implementation-specific measure: aspirational/forward-looking language (intends/aims/will/by 20XX) " +
      "does not evidence an IMPLEMENTED practice (FW03). Route to evidence of actual implementation.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// G2 — test-drive DEFECT CLASSIFIER (seven A6 categories) + missed-doc routing
// ════════════════════════════════════════════════════════════════════════════

export type DefectCategory =
  | "framework-ambiguity"
  | "discovery"
  | "acquisition-extraction"
  | "entity-provenance"
  | "retrieval"
  | "scoring"
  | "technical";

/** Where a classified defect must be routed. */
export type FixRoute =
  | "research" // find/ingest/extract/retrieve the missing evidence — NOT a rubric change
  | "rubric-change" // a genuine definition/criteria defect (gated by the Goodhart validator)
  | "scoring-fix" // a scoring/adjudication bug (not a definition loosening)
  | "engineering"; // a technical/pipeline defect

export const ALL_DEFECT_CATEGORIES: readonly DefectCategory[] = Object.freeze([
  "framework-ambiguity",
  "discovery",
  "acquisition-extraction",
  "entity-provenance",
  "retrieval",
  "scoring",
  "technical",
]);

export interface DefectClassification {
  category: DefectCategory;
  route: FixRoute;
  reason: string;
  measureId?: string;
  /** True when this defect is NOT allowed to justify a looser rubric. */
  blocksRubricChange: boolean;
}

/**
 * The canonical category → route map. Only genuine definition ambiguity may
 * reach a rubric change; a scoring bug gets a scoring fix; everything that is a
 * MISSING-EVIDENCE problem (discovery / acquisition / entity-provenance /
 * retrieval) is a RESEARCH fix and must never loosen the rubric (FW01).
 */
const CATEGORY_ROUTE: Record<DefectCategory, FixRoute> = {
  "framework-ambiguity": "rubric-change",
  discovery: "research",
  "acquisition-extraction": "research",
  "entity-provenance": "research",
  retrieval: "research",
  scoring: "scoring-fix",
  technical: "engineering",
};

function classification(category: DefectCategory, reason: string, measureId?: string): DefectClassification {
  const route = CATEGORY_ROUTE[category];
  return freeze<DefectClassification>({
    category,
    route,
    reason,
    measureId,
    blocksRubricChange: route !== "rubric-change",
  });
}

/**
 * Signals about a single missed/under-scored observation. All optional and
 * generic — framework/topic-agnostic.
 */
export interface DefectSignals {
  measureId?: string;
  /** A relevant document exists but was never discovered/ingested. */
  documentMissing?: boolean;
  /** Document discovered but extraction produced empty/partial text. */
  extractionEmptyOrPartial?: boolean;
  /** Evidence present in corpus but did not reach the scorer's prompt. */
  passageNotRetrieved?: boolean;
  /** Source rejected on entity/provenance/temporal eligibility. */
  eligibilityRejected?: boolean;
  /** The measure's own wording is ambiguous (e.g. residual verdict flips). */
  definitionAmbiguous?: boolean;
  /** The scorer mis-adjudicated evidence that WAS in the prompt. */
  scoringError?: boolean;
  /** A pipeline/runtime/technical failure (timeout, crash, parse error). */
  technicalFailure?: boolean;
}

/**
 * Classify a test-drive defect into exactly one of the seven A6 categories,
 * precedence-ordered so an EVIDENCE-SUPPLY problem is diagnosed BEFORE the
 * measure wording is ever blamed (the core A6 discipline). Pure, total.
 */
export function classifyTestDriveDefect(signals: DefectSignals): DefectClassification {
  const m = signals.measureId;
  // Technical first — a crashed run tells us nothing about framework or evidence.
  if (signals.technicalFailure) {
    return classification("technical", "A pipeline/runtime failure occurred; diagnose the technical fault before any framework inference.", m);
  }
  // Evidence-supply chain, upstream → downstream. A missed document is a
  // DISCOVERY defect, never a definition defect (FW01).
  if (signals.documentMissing) {
    return classification("discovery", "A relevant document was never discovered/ingested — a research (discovery) fix, not a rubric change (FW01).", m);
  }
  if (signals.extractionEmptyOrPartial) {
    return classification("acquisition-extraction", "The document was found but extraction was empty/partial — fix acquisition/extraction, not the rubric.", m);
  }
  if (signals.eligibilityRejected) {
    return classification("entity-provenance", "The source was rejected on entity/provenance/temporal eligibility — an eligibility/research question, not a rubric change.", m);
  }
  if (signals.passageNotRetrieved) {
    return classification("retrieval", "Evidence is present in the corpus but never reached the scorer's prompt — a retrieval fix, not a rubric change.", m);
  }
  // Only once evidence demonstrably reached the scorer may we blame wording/scoring.
  if (signals.scoringError) {
    return classification("scoring", "Evidence reached the scorer but was mis-adjudicated — a scoring fix, not a definition loosening.", m);
  }
  if (signals.definitionAmbiguous) {
    return classification("framework-ambiguity", "Evidence reached the scorer and the measure wording is genuinely ambiguous — a candidate rubric change (subject to the Goodhart validator).", m);
  }
  // Nothing actionable asserted: default to discovery (conservative: assume a
  // missing-evidence problem, never a rubric loosening).
  return classification("discovery", "No scorer-level defect asserted; default to an evidence-supply (research) diagnosis rather than loosening the rubric.", m);
}

/**
 * FW01 — a MISSED DOCUMENT is, by construction, an evidence-supply defect and is
 * ALWAYS routed to a research fix, never a rubric change. This is a convenience
 * wrapper that encodes the rule so callers cannot accidentally mark a missed
 * document as a definition defect.
 */
export function classifyMissedDocument(measureId?: string): DefectClassification {
  return classification(
    "discovery",
    "Missed document ⇒ discovery/research fix. A missing source can never justify a looser rubric (FW01).",
    measureId,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// G3 — Goodhart / no-distribution-tuning VALIDATOR + new-version + impact preview
// ════════════════════════════════════════════════════════════════════════════

/** Language that justifies an edit by prevalence / a target distribution (FW02). */
const DISTRIBUTION_TUNING_MARKERS: RegExp[] = [
  /\b(yes[\s-]?rate|yes[\s-]?ratio|pass[\s-]?rate|hit[\s-]?rate)\b/i,
  /\b(too many|too few|not enough)\b.*\b(yes|no|pass|positives?)\b/i,
  /\b(prevalence|base[\s-]?rate|target distribution|expected distribution)\b/i,
  /\b(move|shift|nudge|bring|push|tune|calibrat\w*)\b.*\b(toward|towards|to match|in line with)\b.*\b(distribution|rate|\d{1,3}\s?%)\b/i,
  /\b\d{1,3}\s?%\b.*\b(of (the )?)?(companies|firms|issuers|peers)\b/i,
  /\b(hit|reach|match|achieve)\b.*\b(the )?(target|expected)\b.*\b(rate|distribution)\b/i,
];

/** Describes a proposed edit to a measure's rubric. Generic / framework-level. */
export interface ProposedRubricEdit {
  measureId: string;
  /** Which part of the contract is being changed. */
  field: "definition" | "qualifyingEvidence" | "nonQualifyingEvidence" | "scoring" | "expectedYesRate" | "examples" | "searchHints" | string;
  /** The proposed new text/value (for the invariant checks). */
  proposedText?: string;
  /** Free-text justification supplied by the proposer (checked for FW02). */
  justification: string;
  /** True when the edit changes the Yes/No CRITERIA or the SCORE mapping. */
  changesCriteriaOrScores: boolean;
  /** True when the fix is specific to one company rather than universal. */
  companySpecific?: boolean;
  /** True when a company-specific fix is an explicit UNIVERSAL DATA CORRECTION. */
  universalDataCorrection?: boolean;
}

export interface EditValidation {
  accepted: boolean;
  reason: string;
  /** When accepted, an accepted edit MUST yield a new version (never silent). */
  requiresNewVersion: boolean;
  /** The rejection class, for audit. */
  rejectionCode?: "distribution-tuning" | "company-specific" | "example-leak" | "search-hint-eligibility";
}

/**
 * Validate a single proposed rubric edit against the A6 hard rules. Pure, total.
 *   FW02 — reject any CRITERIA/SCORE edit justified by prevalence/target
 *          distribution. (A high/low yes-rate may trigger INVESTIGATION, but the
 *          investigation must find a structural cause; the rate itself is never a
 *          justification to move the definition.)
 *   Q7   — reject a company-specific fix unless it is an explicit UNIVERSAL data
 *          correction.
 *   Invariants — reject an edit that promotes an example into the rule, or that
 *          turns a search hint into an eligibility criterion (needs the contract).
 * An ACCEPTED edit always requires a new framework version (never a silent rewrite).
 */
export function validateRubricEdit(
  edit: ProposedRubricEdit,
  contract?: MeasureContract | null,
): EditValidation {
  const justification = str(edit?.justification);

  // FW02 — distribution tuning. Only blocks edits that change criteria/scores;
  // a pure calibration of the ADVISORY expected_yes_rate is allowed (it changes
  // no criteria and no score), matching the existing recalibration behaviour.
  if (edit?.changesCriteriaOrScores && DISTRIBUTION_TUNING_MARKERS.some((re) => re.test(justification))) {
    return freeze<EditValidation>({
      accepted: false,
      requiresNewVersion: false,
      rejectionCode: "distribution-tuning",
      reason:
        "Rejected (FW02): a criteria/score edit cannot be justified by prevalence or a target yes-rate " +
        "distribution. A high/low yes-rate may trigger investigation, but the definition may only move on a " +
        "structural root cause — never to hit a distribution.",
    });
  }

  // Q7 — company-specific fix.
  if (edit?.companySpecific && !edit?.universalDataCorrection) {
    return freeze<EditValidation>({
      accepted: false,
      requiresNewVersion: false,
      rejectionCode: "company-specific",
      reason:
        "Rejected (Q7): a company-specific fix is not allowed unless it is an explicit UNIVERSAL data " +
        "correction. Framework logic must stay generic across all companies and topics.",
    });
  }

  // Invariants (need the contract to check).
  if (contract) {
    if ((edit.field === "definition" || edit.field === "qualifyingEvidence") && edit.proposedText &&
      examplesMutateRule(contract, edit.proposedText)) {
      return freeze<EditValidation>({
        accepted: false,
        requiresNewVersion: false,
        rejectionCode: "example-leak",
        reason: "Rejected: an illustrative example cannot be promoted into the rule. Examples illustrate; they never change the definition.",
      });
    }
    if ((edit.field === "definition" || edit.field === "qualifyingEvidence") && edit.proposedText &&
      searchHintUsedAsEligibility(contract, edit.proposedText)) {
      return freeze<EditValidation>({
        accepted: false,
        requiresNewVersion: false,
        rejectionCode: "search-hint-eligibility",
        reason: "Rejected: a search hint cannot act as an eligibility criterion. Search hints find candidate evidence; they never satisfy the Yes-bar.",
      });
    }
  }

  return freeze<EditValidation>({
    accepted: true,
    requiresNewVersion: true,
    reason: "Accepted: edit has a non-distributional, universal justification. It MUST be applied as a NEW framework version with an impact preview — never a silent rewrite of published scores.",
  });
}

// ─── Impact preview (never a silent rewrite) ──────────────────────────────────

export interface MeasureImpactRow {
  measureId: string;
  verdictBefore: string;
  verdictAfter: string;
  changed: boolean;
}

export interface ImpactPreview {
  measureId: string;
  field: string;
  /** Per-(company,measure) verdict diffs the edit WOULD cause if adopted. */
  rows: MeasureImpactRow[];
  /** Count of cells flipping yes↔no (and any change), for the summary table. */
  cellsChanged: number;
  cellsYesToNo: number;
  cellsNoToYes: number;
  /** Whether this preview mutates any PUBLISHED score (always false — preview only). */
  publishedScoresMutated: false;
}

function norm(v: unknown): string {
  return str(v).trim().toLowerCase();
}

/**
 * Compute the impact preview of an edit from the before/after verdict pairs the
 * caller supplies (a dry re-score; this module does not call the scorer). Pure.
 * The preview NEVER mutates a published score — it only tabulates what WOULD
 * change, so an accepted edit is always adopted with eyes open.
 */
export function previewEditImpact(
  edit: Pick<ProposedRubricEdit, "measureId" | "field">,
  verdictPairs: Array<{ companyId?: string | number; verdictBefore: string; verdictAfter: string }>,
): ImpactPreview {
  const rows: MeasureImpactRow[] = [];
  let cellsChanged = 0;
  let cellsYesToNo = 0;
  let cellsNoToYes = 0;
  for (const p of arr(verdictPairs)) {
    const before = norm(p.verdictBefore);
    const after = norm(p.verdictAfter);
    const changed = before !== after;
    if (changed) {
      cellsChanged++;
      if (before === "yes" && after === "no") cellsYesToNo++;
      if (before === "no" && after === "yes") cellsNoToYes++;
    }
    rows.push({ measureId: str(edit.measureId), verdictBefore: before, verdictAfter: after, changed });
  }
  return freeze<ImpactPreview>({
    measureId: str(edit.measureId),
    field: str(edit.field),
    rows: freeze(rows),
    cellsChanged,
    cellsYesToNo,
    cellsNoToYes,
    publishedScoresMutated: false,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Orchestrator — the shadow/enforce governance pass
// ════════════════════════════════════════════════════════════════════════════

export interface GovernanceInput {
  framework?: { antiInferenceRules?: string[] | null; topicTerm?: string | null; version?: number; name?: string } | null;
  measures?: any[];
  /** Defect signals observed in the test-drive (optional). */
  defects?: DefectSignals[];
  /** Proposed rubric edits to validate (optional). */
  proposedEdits?: ProposedRubricEdit[];
  /** Per-edit before/after verdict pairs for the impact preview, keyed by measureId. */
  verdictPairsByMeasure?: Record<string, Array<{ companyId?: string | number; verdictBefore: string; verdictAfter: string }>>;
}

export interface GovernanceResult {
  policy: FrameworkContractPolicy;
  policyVersion: number;
  /** Assembled per-measure contracts (metadata — attached, not enforced). */
  contracts: MeasureContract[];
  /** Defect classifications for the supplied signals. */
  defectClassifications: DefectClassification[];
  /** Validation outcomes for the supplied proposed edits. */
  editValidations: EditValidation[];
  /** Impact previews for each ACCEPTED edit (never a silent rewrite). */
  impactPreviews: ImpactPreview[];
  /**
   * In "enforce", a NEW framework version carrying the accepted hardening
   * (via emitHardenedFramework). In "shadow", null (passthrough). Either way the
   * CURRENT published version is untouched.
   */
  newFrameworkVersion: EmitHardenedResult<any, any> | null;
  /** INVARIANT: always false. A6 never mutates a published score. */
  publishedScoresMutated: false;
}

/**
 * Run the A6 governance pass. In the default "shadow" policy this is a pure,
 * verdict-invariant passthrough: it attaches contract metadata, classifies
 * defects and previews edit impact, but mutates NO published score and emits NO
 * new version. In "enforce" (never set in prod) it additionally emits a NEW
 * framework version from the accepted edits. `publishedScoresMutated` is ALWAYS
 * false — shipping A6 changes zero published scores by construction.
 */
export function runContractGovernance(
  input: GovernanceInput,
  explicitPolicy?: FrameworkContractPolicy | null,
): GovernanceResult {
  const policy = resolveFrameworkContractPolicy(explicitPolicy);
  const measures = arr<any>(input?.measures);
  const framework = input?.framework ?? null;

  const contracts = measures.map((m) => buildMeasureContract(m, framework));
  const contractByMeasure = new Map(contracts.map((c) => [c.measureId, c]));

  const defectClassifications = arr<DefectSignals>(input?.defects).map((d) =>
    d?.documentMissing ? classifyMissedDocument(d.measureId) : classifyTestDriveDefect(d),
  );

  const editValidations: EditValidation[] = [];
  const impactPreviews: ImpactPreview[] = [];
  for (const edit of arr<ProposedRubricEdit>(input?.proposedEdits)) {
    const contract = contractByMeasure.get(str(edit?.measureId)) ?? null;
    const v = validateRubricEdit(edit, contract);
    editValidations.push(v);
    if (v.accepted) {
      const pairs = input?.verdictPairsByMeasure?.[str(edit.measureId)] ?? [];
      impactPreviews.push(previewEditImpact(edit, pairs));
    }
  }

  // Only "enforce" emits a new version — and only from ACCEPTED edits. In shadow,
  // this stays null (pure passthrough). Never mutates the current version.
  let newFrameworkVersion: EmitHardenedResult<any, any> | null = null;
  if (policy === "enforce" && framework && editValidations.some((v) => v.accepted)) {
    newFrameworkVersion = emitHardenedFramework(framework as any, measures, { nameSuffix: "A6 contract hardened" });
  }

  return freeze<GovernanceResult>({
    policy,
    policyVersion: FRAMEWORK_CONTRACT_POLICY_VERSION,
    contracts: freeze(contracts),
    defectClassifications: freeze(defectClassifications),
    editValidations: freeze(editValidations),
    impactPreviews: freeze(impactPreviews),
    newFrameworkVersion,
    publishedScoresMutated: false,
  });
}

// ─── FW05 / FW07 governance helpers ──────────────────────────────────────────

export interface RevisionOutcome {
  /** Adjudicated (ground-truth) failures the revision is meant to FIX. */
  adjudicatedFailBefore: number;
  adjudicatedFailAfter: number;
  /** Holdout subgroups that must NOT be harmed (e.g. other sectors/companies). */
  holdout: Array<{ subgroup: string; correctBefore: number; correctAfter: number }>;
}

export interface RevisionVerdict {
  accepted: boolean;
  reason: string;
  helpedAdjudicated: boolean;
  harmedHoldout: boolean;
}

/**
 * FW05 — a revision is accepted ONLY if it reduces adjudicated failures AND harms
 * no holdout subgroup (no net regression on held-out data). Pure, total.
 */
export function evaluateRevisionAgainstHoldout(outcome: RevisionOutcome): RevisionVerdict {
  const helpedAdjudicated = Number(outcome?.adjudicatedFailAfter) < Number(outcome?.adjudicatedFailBefore);
  const harmedHoldout = arr(outcome?.holdout).some((h) => Number(h?.correctAfter) < Number(h?.correctBefore));
  const accepted = helpedAdjudicated && !harmedHoldout;
  return freeze<RevisionVerdict>({
    accepted,
    helpedAdjudicated,
    harmedHoldout,
    reason: accepted
      ? "Accepted (FW05): revision reduces adjudicated failures and harms no holdout subgroup."
      : !helpedAdjudicated
        ? "Rejected (FW05): revision does not reduce adjudicated failures."
        : "Rejected (FW05): revision regresses at least one holdout subgroup.",
  });
}

/** Caps for a single test-drive, used by the envelope check (FW07). */
export interface TestDriveEnvelope {
  maxSampleSize: number;
  maxDeadlineMs: number;
}

/** Conservative defaults matching the existing TEST_DRIVE_SAMPLE_SIZE (50). */
export const DEFAULT_TEST_DRIVE_ENVELOPE: TestDriveEnvelope = Object.freeze({
  maxSampleSize: 50,
  maxDeadlineMs: 30 * 60 * 1000, // 30 minutes
});

export interface TestDriveRequestShape {
  sampleSize: number;
  deadlineMs: number;
}

/**
 * FW07 — a test-drive request must stay within the configured settings/deadline
 * envelope. Pure, total. Returns the decision and a reason.
 */
export function withinTestDriveEnvelope(
  req: TestDriveRequestShape,
  envelope: TestDriveEnvelope = DEFAULT_TEST_DRIVE_ENVELOPE,
): { withinEnvelope: boolean; reason: string } {
  const size = Number(req?.sampleSize);
  const deadline = Number(req?.deadlineMs);
  if (!Number.isFinite(size) || size <= 0 || size > envelope.maxSampleSize) {
    return { withinEnvelope: false, reason: `Sample size ${size} is outside the envelope (1..${envelope.maxSampleSize}).` };
  }
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > envelope.maxDeadlineMs) {
    return { withinEnvelope: false, reason: `Deadline ${deadline}ms is outside the envelope (1..${envelope.maxDeadlineMs}ms).` };
  }
  return { withinEnvelope: true, reason: "Test-drive request is within the settings/deadline envelope." };
}
