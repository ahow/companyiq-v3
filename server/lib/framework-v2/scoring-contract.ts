/**
 * scoring-contract.ts — Change #4: ONE authoritative decision rule per measure.
 *
 * WHY (audit §3.B, §3.C, §4):
 *   The audit found "29 of 34 measures with materially different thresholds
 *   across their instructions" — a measure's Yes bar is spread across
 *   `scoringGuidance`, its embedded structured JSON, `substantiveDefinition`,
 *   `fallbackYesCriterion` and examples, with NO stated precedence between them.
 *   The reviewer's recommendation: "Maintain ONE versioned, machine-readable
 *   decision specification per measure … Do not maintain several independently
 *   editable definitions of Yes." (§3.B) and separately "define Yes, Partial,
 *   not-found and N/A" with non-overlapping meaning (§4), keeping
 *   "substantive satisfaction, evidence sufficiency, retrieval coverage, and
 *   confidence separate" and — when a validator changes Yes→Partial — to
 *   "preserve the proposed score, final score, rule identifier and reason."
 *   (§3.C)
 *
 * WHAT this module provides:
 *   1. `ScoringContract` — a single, explicit, non-overlapping definition per
 *      measure for the FIVE mutually-exclusive outcomes the pipeline can emit:
 *         Yes · Partial · N-A (not applicable) · No (evidence of absence) ·
 *         no-evidence-found (retrieval returned nothing — DISTINCT from No).
 *   2. `resolveScoringContract(measure)` — a deterministic resolver that reads
 *      ONE source of truth: a persisted contract if the measure already carries
 *      one, otherwise a contract DERIVED from the measure's existing fields via
 *      an EXPLICIT precedence order (so the runtime never has to reconcile
 *      conflicting thresholds itself).
 *   3. `LOW_CONFIDENCE_POSITIVE_TO_PARTIAL` — the confidence-downgrade rule that
 *      converts a Yes/positive verdict to Partial, expressed as a NAMED,
 *      inspectable rule, plus `describeDowngrade()` which returns a structured
 *      decision record (ruleId, proposedVerdict, finalVerdict, reason) so the
 *      downgrade is REPORTED in cell output, never silent.
 *   4. `emitHardenedFramework(framework, measures)` — a pure, NON-MUTATING
 *      mechanism that returns a NEW framework version carrying the resolved
 *      contract on every measure. The original is never mutated (standing
 *      requirement: generate a new framework version when adopting a
 *      scoring-contract change).
 *
 * GENERIC / TOPIC-AGNOSTIC: nothing here knows the topic, company, or any
 * framework by name. Every contract is derived structurally from a measure's
 * own definition fields. Pure functions over plain objects — DB-free and
 * unit-testable.
 */

import { extractGuidanceObject } from "../framework-guidance-audit.js";

// ─── Outcome vocabulary ──────────────────────────────────────────────────────
// The five mutually-exclusive, non-overlapping outcomes. "noEvidenceFound" is
// deliberately DISTINCT from "no": the audit (§3.A / §4) requires separating
// "No qualifying evidence found" (retrieval surfaced nothing) from "Evidence
// that the practice is absent" (a substantive negative). The runtime verdict
// strings these map to are also recorded so downstream code has one mapping.
export type ContractOutcome = "yes" | "partial" | "notApplicable" | "no" | "noEvidenceFound";

/** The verdict string each contract outcome corresponds to in the pipeline. */
export const OUTCOME_TO_VERDICT: Record<ContractOutcome, string> = {
  yes: "Yes",
  partial: "Partial",
  notApplicable: "Insufficient evidence", // N-A is carried as an abstain, excluded from denominator
  no: "No",
  noEvidenceFound: "Evidence absent",
};

/**
 * One explicit, non-overlapping definition per outcome. Each string states the
 * precise condition under which that outcome — and ONLY that outcome — is
 * correct, so the five are jointly exhaustive and mutually exclusive.
 */
export interface OutcomeDefinitions {
  /** Full satisfaction of the measure's substantive requirement, quote-verifiable. */
  yes: string;
  /** Some qualifying evidence, but the substantive requirement is not fully met. */
  partial: string;
  /** The measure does not apply to this entity/role (applicability, not nondisclosure). */
  notApplicable: string;
  /** Evidence was found that the practice is ABSENT / negative (substantive No). */
  no: string;
  /** Retrieval returned nothing relevant — distinct from a substantive No. */
  noEvidenceFound: string;
}

/**
 * A single per-measure decision specification. This is THE source of truth the
 * runtime reads; it is derived once (or persisted) rather than reconciled per
 * scoring call.
 */
export interface ScoringContract {
  /** Schema version so a stored contract can be migrated deterministically. */
  contractVersion: number;
  /** The measure this contract governs (measureId), for provenance/audit. */
  measureId: string;
  /** The five explicit, non-overlapping outcome definitions. */
  outcomes: OutcomeDefinitions;
  /**
   * The ORDERED precedence of source fields that fed this contract, most
   * authoritative first. When two fields state different thresholds, the earlier
   * one wins — this is the "explicit precedence" the audit §3.B asks for. Each
   * entry is a field NAME actually present on the measure (or "derived-default").
   */
  precedence: string[];
  /**
   * The confidence-downgrade rule that applies to a positive verdict for this
   * measure, named and inspectable (never silent). See
   * `LOW_CONFIDENCE_POSITIVE_TO_PARTIAL`.
   */
  downgradeRule: DowngradeRuleSpec;
  /**
   * The four axes the audit §3.C requires be kept SEPARATE. Recording them on
   * the contract makes explicit that a Partial can arise from any one of them,
   * and which axis a downgrade acted on.
   */
  separableAxes: readonly ["substantiveSatisfaction", "evidenceSufficiency", "retrievalCoverage", "confidence"];
  /** True when this contract was read from a persisted block rather than derived. */
  wasPersisted: boolean;
}

// ─── Named confidence-downgrade rule ─────────────────────────────────────────
export interface DowngradeRuleSpec {
  /** Stable identifier surfaced in cell output. */
  id: string;
  /** One-line human description of what the rule does and when. */
  description: string;
  /** The axis (of the four separable axes) this rule acts on. */
  axis: "confidence";
}

/**
 * The ONE named rule that converts a positive (Yes-worthy) verdict to Partial
 * on low confidence. This mirrors the behaviour that already lives in
 * analyzer.ts ("Low confidence positive reduced to Partial"), but names it so
 * the conversion is explicit and reportable. If a rationale meets the Yes bar
 * and this rule does NOT fire, the verdict stands as Yes — there is no other,
 * unnamed path that silently downgrades.
 */
export const LOW_CONFIDENCE_POSITIVE_TO_PARTIAL: DowngradeRuleSpec = {
  id: "LOW_CONFIDENCE_POSITIVE_TO_PARTIAL",
  description:
    "A positive verdict (score > 0) emitted at Low confidence is reduced to Partial (score 0.5) when the framework's low_confidence_handling is 'downgrade'. The proposed verdict, final verdict, rule id and reason are preserved so the change is auditable, not silent.",
  axis: "confidence",
};

/**
 * A structured record of a downgrade decision, surfaced in the cell output. When
 * `applied` is false the verdict stood on its own merits (no silent change).
 */
export interface DowngradeDecision {
  ruleId: string;
  /** The verdict the scorer proposed BEFORE the rule ran. */
  proposedVerdict: string;
  /** The verdict AFTER the rule ran (equal to proposedVerdict when not applied). */
  finalVerdict: string;
  applied: boolean;
  reason: string;
}

/**
 * Build the explicit downgrade decision record for a positive verdict. Pure and
 * deterministic — the analyzer calls this at the exact point it would otherwise
 * silently rewrite the verdict, so the decision is reported rather than hidden.
 *
 * @param proposedVerdict the verdict the scorer produced (e.g. "Yes")
 * @param confidence the confidence label ("Low" | "Medium" | "High")
 * @param lowConfidenceHandling the framework/setting policy ("downgrade" | "flag" | "keep")
 * @param score the numeric score attached to the proposed verdict
 */
export function describeDowngrade(
  proposedVerdict: string,
  confidence: string,
  lowConfidenceHandling: string,
  score: number,
): DowngradeDecision {
  const isPositive = score > 0 && (proposedVerdict === "Yes" || proposedVerdict === "Partial");
  const isLow = (confidence || "").toLowerCase() === "low";
  const applies = isPositive && isLow && lowConfidenceHandling === "downgrade" && proposedVerdict === "Yes";
  if (!applies) {
    return {
      ruleId: LOW_CONFIDENCE_POSITIVE_TO_PARTIAL.id,
      proposedVerdict,
      finalVerdict: proposedVerdict,
      applied: false,
      reason:
        !isPositive
          ? "not a positive verdict — downgrade rule not evaluated"
          : !isLow
            ? "confidence is not Low — verdict stands on its own merits"
            : lowConfidenceHandling !== "downgrade"
              ? `low_confidence_handling='${lowConfidenceHandling}' — rule does not convert to Partial`
              : "verdict already Partial — no Yes to downgrade",
    };
  }
  return {
    ruleId: LOW_CONFIDENCE_POSITIVE_TO_PARTIAL.id,
    proposedVerdict,
    finalVerdict: "Partial",
    applied: true,
    reason:
      "Low-confidence positive: rule LOW_CONFIDENCE_POSITIVE_TO_PARTIAL reduced Yes (1.0) to Partial (0.5). Substantive satisfaction preserved; the reduction reflects the CONFIDENCE axis only.",
  };
}

// ─── Contract derivation ─────────────────────────────────────────────────────

/** The measure fields the resolver reads, in the order they contribute. */
const FIELD_PRECEDENCE = [
  "substantiveDefinition",
  "fallbackYesCriterion",
  "scoringGuidance",
] as const;

function firstNonEmptyString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Read a persisted contract from a measure's scoring_guidance JSON block, if any. */
function readPersistedContract(measure: any): ScoringContract | null {
  const sg = measure?.scoringGuidance ?? measure?.scoring_guidance;
  if (typeof sg !== "string" || !sg.trim()) return null;
  const obj = extractGuidanceObject(sg);
  const dc = obj && typeof obj === "object" ? (obj as any).decisionContract : null;
  if (!dc || typeof dc !== "object" || !dc.outcomes) return null;
  const o = dc.outcomes;
  if (
    typeof o.yes === "string" &&
    typeof o.partial === "string" &&
    typeof o.notApplicable === "string" &&
    typeof o.no === "string" &&
    typeof o.noEvidenceFound === "string"
  ) {
    return {
      contractVersion: typeof dc.contractVersion === "number" ? dc.contractVersion : 1,
      measureId: String(measure?.measureId ?? measure?.measure_id ?? dc.measureId ?? ""),
      outcomes: {
        yes: o.yes,
        partial: o.partial,
        notApplicable: o.notApplicable,
        no: o.no,
        noEvidenceFound: o.noEvidenceFound,
      },
      precedence: Array.isArray(dc.precedence) ? dc.precedence.map(String) : ["persisted"],
      downgradeRule: LOW_CONFIDENCE_POSITIVE_TO_PARTIAL,
      separableAxes: ["substantiveSatisfaction", "evidenceSufficiency", "retrievalCoverage", "confidence"],
      wasPersisted: true,
    };
  }
  return null;
}

/**
 * Resolve THE scoring contract for a measure. One source of truth:
 *   - if the measure already carries a persisted `decisionContract`, use it;
 *   - otherwise DERIVE one from the measure's fields via an explicit precedence,
 *     so the runtime reads a single reconciled specification rather than several
 *     independently-editable definitions of Yes.
 *
 * Never throws; a measure with no usable fields still gets a well-formed
 * contract built from generic defaults (so the runtime always has one contract).
 */
export function resolveScoringContract(measure: any): ScoringContract {
  const measureId = String(measure?.measureId ?? measure?.measure_id ?? "");

  const persisted = readPersistedContract(measure);
  if (persisted) return persisted.measureId ? persisted : { ...persisted, measureId };

  // Derive. Pull the highest-precedence positive requirement available.
  const substantive = firstNonEmptyString(measure?.substantiveDefinition, measure?.substantive_definition);
  const fallback = firstNonEmptyString(measure?.fallbackYesCriterion, measure?.fallback_yes_criterion);
  const guidance = firstNonEmptyString(measure?.scoringGuidance, measure?.scoring_guidance);

  // Structured guidance (qualifyingInstance / disqualifiers) parsed from the
  // scoring_guidance block, if present — used to sharpen the Yes/No wording.
  const structured = guidance ? extractGuidanceObject(guidance) : null;
  const qualifying =
    structured && typeof (structured as any).qualifyingInstance === "string"
      ? (structured as any).qualifyingInstance.trim()
      : null;

  // The single authoritative Yes bar, resolved by precedence.
  const yesBar =
    substantive ||
    qualifying ||
    fallback ||
    // As a last resort, distil the prose guidance to its first sentence.
    (guidance ? guidance.split(/(?<=[.!?])\s/)[0].trim() : null) ||
    `The measure's substantive requirement is fully satisfied by an explicit, quote-verifiable disclosure by the assessed entity.`;

  const precedence: string[] = [];
  if (substantive) precedence.push("substantiveDefinition");
  if (qualifying) precedence.push("scoringGuidance.qualifyingInstance");
  if (fallback) precedence.push("fallbackYesCriterion");
  if (guidance && precedence.length === 0) precedence.push("scoringGuidance");
  if (precedence.length === 0) precedence.push("derived-default");

  const outcomes: OutcomeDefinitions = {
    yes: `Yes — ${yesBar} A Yes requires a verbatim quote from the assessed entity's own evidence containing the qualifying instance; substantive satisfaction, not mere topic mention.`,
    partial: `Partial — some qualifying evidence exists but the requirement above is not fully met (e.g. one of several required elements is present, or the disclosure is indirect/incomplete). Partial reflects incomplete SUBSTANTIVE satisfaction and is kept separate from evidence sufficiency, retrieval coverage and confidence.`,
    notApplicable: `N-A — the measure does not apply to this entity's role/sector (an applicability judgement, NOT nondisclosure). N-A is excluded from the answered-measures denominator; it must never be used to excuse a missing disclosure.`,
    no: `No — the evidence AFFIRMATIVELY shows the practice is absent, discontinued, withdrawn, or explicitly not adopted by the assessed entity (evidence of absence — a substantive negative).`,
    noEvidenceFound: `No evidence found — retrieval surfaced no relevant passage for this measure (the corpus did not contain material addressing it). This is DISTINCT from No: it records the absence of evidence, not evidence of absence.`,
  };

  return {
    contractVersion: 1,
    measureId,
    outcomes,
    precedence,
    downgradeRule: LOW_CONFIDENCE_POSITIVE_TO_PARTIAL,
    separableAxes: ["substantiveSatisfaction", "evidenceSufficiency", "retrievalCoverage", "confidence"],
    wasPersisted: false,
  };
}

// ─── Emit a NEW hardened framework carrying the contracts ─────────────────────

export interface EmitHardenedResult<F, M> {
  /** A NEW framework object (version incremented). The input is never mutated. */
  framework: F;
  /** NEW measure objects, each carrying its resolved contract. Inputs untouched. */
  measures: M[];
  /** True when at least one contract was written. */
  changed: boolean;
  /** Human-readable notes for logging/audit. */
  notes: string[];
}

/**
 * Serialise a contract into a measure's scoring_guidance so the persisted
 * measure carries ONE source of truth that `resolveScoringContract` will read
 * back verbatim. Preserves any existing prose/structured block by embedding the
 * contract under a `decisionContract` key in the trailing JSON object. Pure.
 */
function writeContractIntoGuidance(existing: string | null | undefined, contract: ScoringContract): string {
  const raw = existing == null ? "" : String(existing);
  const block = {
    contractVersion: contract.contractVersion,
    measureId: contract.measureId,
    precedence: contract.precedence,
    downgradeRuleId: contract.downgradeRule.id,
    outcomes: contract.outcomes,
  };
  // If existing is a pure JSON object, overlay decisionContract and keep the rest.
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, decisionContract: block });
    }
  } catch {
    /* not pure JSON — append a fenced block below the prose */
  }
  const fence = "```json\n" + JSON.stringify({ decisionContract: block }, null, 2) + "\n```";
  return raw.trim() ? `${raw.trim()}\n\n${fence}` : fence;
}

/**
 * Emit a NEW hardened framework version whose measures each carry an explicit,
 * resolved scoring contract. NON-DESTRUCTIVE: returns fresh copies; the input
 * framework and measures are never mutated. This is the mechanism that satisfies
 * the standing requirement to generate a new framework version when adopting a
 * scoring-contract change (never edit the original in place).
 *
 * The emitted framework's `version` is incremented and a note is appended to its
 * name so the hardened version is distinguishable. Measures keep every field;
 * only their `scoringGuidance` gains the serialised `decisionContract`.
 */
export function emitHardenedFramework<
  F extends Record<string, any>,
  M extends Record<string, any>,
>(framework: F, measures: M[], opts?: { nameSuffix?: string }): EmitHardenedResult<F, M> {
  const notes: string[] = [];
  if (!framework || typeof framework !== "object") {
    return { framework, measures: Array.isArray(measures) ? measures : [], changed: false, notes: ["no framework object — skipped"] };
  }
  const srcMeasures = Array.isArray(measures) ? measures : [];

  const priorVersion = Number(framework.version);
  const nextVersion = Number.isFinite(priorVersion) ? priorVersion + 1 : 1;
  const suffix = opts?.nameSuffix ?? "scoring-contract hardened";

  const newFramework: F = {
    ...framework,
    version: nextVersion,
    name: framework.name ? `${framework.name} (${suffix})` : framework.name,
    // Never carry the DB identity of the original onto the new version.
    id: undefined,
    isActive: false,
    productionReady: false,
  };

  const newMeasures: M[] = srcMeasures.map((m) => {
    const contract = resolveScoringContract(m);
    const merged = writeContractIntoGuidance(m.scoringGuidance ?? m.scoring_guidance, contract);
    notes.push(`${contract.measureId || "(unnamed measure)"}: contract resolved via [${contract.precedence.join(" > ")}]`);
    return { ...m, id: undefined, scoringGuidance: merged };
  });

  return {
    framework: newFramework,
    measures: newMeasures,
    changed: newMeasures.length > 0,
    notes,
  };
}
