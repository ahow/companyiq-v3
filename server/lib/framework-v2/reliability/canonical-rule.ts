/**
 * canonical-rule.ts — Workstream 4 (Stage 3): the canonical decision rule.
 *
 * WHY (reviewer, "CompanyIQ developer proposal — approve the direction, amend the
 * design", §3 "C13 and rule precedence", and the framework-13 follow-up §"three
 * counterexamples"):
 *   A measure's Yes-bar is spread across substantiveDefinition, scoringGuidance,
 *   an embedded qualifyingInstance and a strict fallbackYesCriterion, with no
 *   exported precedence. The reviewer requires ONE authoritative rule per measure,
 *   derived by an EXPLICIT precedence, and — critically — that a strict fallback
 *   MUST NOT silently become the canonical bar when a substantive criterion is
 *   present (else a supplied positive example, e.g. 1.1's "Our AI Strategic
 *   Plan…", is presented as positive yet rejected by its own fallback for lacking
 *   a second attribution token).
 *
 * WHAT this module provides:
 *   1. buildCanonicalRule(measure): StructuredRule
 *      — wraps resolveScoringContract so there is ONE precedence source of truth
 *        (substantiveDefinition → scoringGuidance.qualifyingInstance →
 *         fallbackYesCriterion → derived-default). Records which field won
 *        (sourceField), the provenance, and — where ONLY a strict fallback
 *        existed — flags the rule for review rather than trusting its bar.
 *      — decomposes the single authoritative Yes-bar into an explicit, machine-
 *        readable clause structure (requiredClauses / orAlternatives / exclusions
 *        / thresholds). The decomposition is GENERIC and topic-agnostic — it
 *        hardcodes no framework, company or topic.
 *   2. evaluateCanonicalRule(rule, facts): StructuredRuleResult
 *      — a THREE-VALUED Boolean evaluator (Kleene AND over required clauses, OR
 *        groups, exclusions and thresholds) over STRUCTURED FACTS. It is NOT a
 *        semantic/NLP evaluator: turning free text into facts is a separate,
 *        uncertain step that happens before this. A missing/ambiguous fact yields
 *        "unknown-review-required", never a falsely-certain pass/fail.
 *
 * PURE / DB-FREE / NON-MUTATING: every function is a pure function over plain
 * objects. Inputs are never mutated; a NEW rule/result is always returned.
 */

import { createHash } from "crypto";
import { resolveScoringContract } from "../scoring-contract.js";
import type {
  StructuredRule,
  StructuredRuleResult,
  StructuredRuleStatus,
  StructuredFacts,
  RuleThreshold,
} from "./schemas.js";

// ─── Provenance mapping ───────────────────────────────────────────────────────

/** Map the winning precedence field to a provenance category. */
function provenanceFor(sourceField: string): NonNullable<StructuredRule["provenance"]> {
  if (sourceField === "substantiveDefinition") return "substantive";
  if (sourceField === "scoringGuidance.qualifyingInstance") return "qualifying";
  if (sourceField === "fallbackYesCriterion") return "fallback-derived";
  return "derived-default";
}

// ─── Yes-bar decomposition (generic, topic-agnostic) ──────────────────────────

/** Trim + collapse whitespace; drop leading enumerators/bullets. */
function tidy(s: string): string {
  return s
    .replace(/^\s*(?:\(?\d+\)?[.)]|[-*•])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a prose bar into candidate atomic phrases on sentence + list boundaries. */
function splitPhrases(text: string): string[] {
  return text
    // split on sentence terminators, semicolons, and hard "and"/"AND" conjunctions
    .split(/(?<=[.!?;])\s+|\s*;\s*|\s+\band\b\s+|\s+\bAND\b\s+/)
    .map(tidy)
    .filter((p) => p.length > 0);
}

/** Detect an OR-list phrase ("either … or", "any of", "at least one of"). */
function isOrPhrase(p: string): boolean {
  return /\b(either|any (?:one )?of|at least one of|one or more of|or)\b/i.test(p);
}

/** Split an OR phrase into its alternatives. */
function splitOrAlternatives(p: string): string[] {
  return p
    .replace(/^\s*(?:either|any (?:one )?of|at least one of|one or more of)\s*:?\s*/i, "")
    .split(/\s*,\s*|\s+\bor\b\s+/i)
    .map(tidy)
    .filter((a) => a.length > 0);
}

/** Detect an exclusion / disqualifier phrase. */
function isExclusionPhrase(p: string): boolean {
  return /\b(must not|does not|do not|excluding|except|disqualif|not count|not qualify|mere(?:ly)? (?:mention|topic))\b/i.test(p);
}

/** Extract a numeric-count threshold ("at least two X", "3 named …") if present. */
function extractThreshold(p: string): RuleThreshold | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const m = p.match(/\b(?:at least|minimum of|no fewer than)\s+(\d+|one|two|three|four|five|six)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const value = /^\d+$/.test(raw) ? parseInt(raw, 10) : (words[raw] ?? NaN);
  if (!Number.isFinite(value)) return null;
  // Subject = the noun-ish tail after the count, tidied to a short key.
  const tail = p.slice((m.index ?? 0) + m[0].length).trim();
  const subject = tail.split(/\s+/).slice(0, 4).join(" ") || "count";
  return { subject, operator: ">=", value, unit: null };
}

interface Decomposition {
  requiredClauses: string[];
  orAlternatives: string[][];
  exclusions: string[];
  thresholds: RuleThreshold[];
}

/**
 * Decompose a single authoritative Yes-bar into machine-readable clauses.
 * GENERIC: nothing here is topic/framework specific — it keys only off structural
 * cues (list markers, "or", negation, count words). The result is deliberately
 * conservative: a bar that cannot be split stays a single required clause.
 */
export function decomposeYesBar(yesBar: string): Decomposition {
  const requiredClauses: string[] = [];
  const orAlternatives: string[][] = [];
  const exclusions: string[] = [];
  const thresholds: RuleThreshold[] = [];

  for (const phrase of splitPhrases(yesBar)) {
    const threshold = extractThreshold(phrase);
    if (threshold) thresholds.push(threshold);

    if (isExclusionPhrase(phrase)) {
      exclusions.push(phrase);
      continue;
    }
    if (isOrPhrase(phrase)) {
      const alts = splitOrAlternatives(phrase);
      if (alts.length >= 2) {
        orAlternatives.push(alts);
        continue;
      }
    }
    requiredClauses.push(phrase);
  }

  // A rule must have at least one positive obligation. If everything landed in
  // exclusions/thresholds, keep the whole bar as one required clause.
  if (requiredClauses.length === 0 && orAlternatives.length === 0) {
    requiredClauses.push(tidy(yesBar));
  }
  return { requiredClauses, orAlternatives, exclusions, thresholds };
}

// ─── buildCanonicalRule ───────────────────────────────────────────────────────

/** Stable content hash of a measure's decision-relevant fields. Exported so the
 *  per-decision traceability layer (decision-trace.ts) can compose an immutable
 *  framework-content hash from the SAME per-measure hash used inside the rule,
 *  keeping the two in lockstep. */
export function measureContentHash(measure: any): string {
  const decisionFields = {
    measureId: measure?.measureId ?? measure?.measure_id ?? "",
    substantiveDefinition: measure?.substantiveDefinition ?? measure?.substantive_definition ?? "",
    scoringGuidance: measure?.scoringGuidance ?? measure?.scoring_guidance ?? "",
    fallbackYesCriterion: measure?.fallbackYesCriterion ?? measure?.fallback_yes_criterion ?? "",
    whatConstitutesEvidence: measure?.whatConstitutesEvidence ?? "",
  };
  return createHash("sha256").update(JSON.stringify(decisionFields)).digest("hex").slice(0, 16);
}

/**
 * Build THE canonical, machine-readable decision rule for a measure.
 *
 * Precedence is delegated to resolveScoringContract (the single source of truth),
 * so this never re-implements the ordering. `sourceField` is the precedence
 * winner; `provenance` records whether a substantive criterion won or only a
 * strict fallback existed. When ONLY a strict fallback exists the rule is
 * `provenance: "fallback-derived"` and `flaggedForReview: true` — the reviewer's
 * critical correction that a strict fallback must not silently become the bar.
 */
export function buildCanonicalRule(measure: any): StructuredRule {
  const contract = resolveScoringContract(measure);
  const measureId = contract.measureId || String(measure?.measureId ?? measure?.measure_id ?? "");
  const sourceField = contract.precedence[0] ?? "derived-default";
  const provenance = provenanceFor(sourceField);
  const flaggedForReview = provenance === "fallback-derived" || provenance === "derived-default";

  // The authoritative Yes-bar prose lives on the contract's `yes` outcome; strip
  // the boilerplate suffix resolveScoringContract appends so we decompose the bar.
  const yesText = contract.outcomes.yes
    .replace(/^Yes\s*[—-]\s*/, "")
    .replace(/\s*A Yes requires a verbatim quote.*$/s, "")
    .trim();

  const decomp = decomposeYesBar(yesText);
  const contentHash = measureContentHash(measure);

  return {
    ruleId: `canon:${measureId || contentHash}`,
    ruleVersion: contract.contractVersion,
    requiredClauses: decomp.requiredClauses,
    orAlternatives: decomp.orAlternatives,
    exclusions: decomp.exclusions,
    thresholds: decomp.thresholds,
    evidenceBindings: [
      {
        measureId,
        contentHash,
        description: `Yes-bar resolved from [${contract.precedence.join(" > ")}].`,
      },
    ],
    sourceField,
    provenance,
    flaggedForReview,
  };
}

// ─── Clause identity ──────────────────────────────────────────────────────────

/**
 * Deterministic clause IDs for a rule, so StructuredFacts can key facts to
 * clauses stably: required → r0,r1…; or-group g → o{g}, alternatives o{g}a{k};
 * exclusions → x0,x1…; thresholds → t0,t1…
 */
export function clauseIdsFor(rule: StructuredRule): {
  required: string[];
  orGroups: string[][];
  exclusions: string[];
  thresholds: string[];
} {
  return {
    required: rule.requiredClauses.map((_, i) => `r${i}`),
    orGroups: rule.orAlternatives.map((group, g) => group.map((_, k) => `o${g}a${k}`)),
    exclusions: rule.exclusions.map((_, i) => `x${i}`),
    thresholds: rule.thresholds.map((_, i) => `t${i}`),
  };
}

// ─── Three-valued Kleene evaluation ───────────────────────────────────────────

/** Look up a clause fact; a missing key is "unknown", never silently false. */
function factOf(facts: StructuredFacts, clauseId: string): boolean | "unknown" {
  const v = facts?.clausePresence?.[clauseId];
  return v === true || v === false ? v : "unknown";
}

/** Evaluate a threshold against a measurement; missing measurement ⇒ unknown. */
function evalThreshold(t: RuleThreshold, facts: StructuredFacts): boolean | "unknown" {
  const m = facts?.measurements?.[t.subject];
  if (m === undefined || m === null) return "unknown";
  const a = typeof m === "number" ? m : Number(m);
  const b = typeof t.value === "number" ? t.value : Number(t.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    // Non-numeric comparison — only == / != are meaningful.
    if (t.operator === "==") return String(m) === String(t.value);
    if (t.operator === "!=") return String(m) !== String(t.value);
    return "unknown";
  }
  switch (t.operator) {
    case ">=": return a >= b;
    case "<=": return a <= b;
    case ">": return a > b;
    case "<": return a < b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return "unknown";
  }
}

/**
 * Evaluate the canonical rule against structured facts, three-valued.
 *
 * Semantics — a top-level AND of: every required clause, every OR-group, the
 * absence of every exclusion, and every threshold. Under Kleene three-valued
 * AND: any DEFINITE false ⇒ overall "fail"; else any "unknown" ⇒ overall
 * "unknown-review-required"; else "pass". An OR-group passes if any alternative
 * is definitely true, fails only if ALL are definitely false, else unknown.
 * Missing/ambiguous facts never produce a falsely-certain pass/fail.
 */
export function evaluateCanonicalRule(rule: StructuredRule, facts: StructuredFacts): StructuredRuleResult {
  const ids = clauseIdsFor(rule);
  const clauseResults: StructuredRuleResult["clauseResults"] = [];
  let anyFail = false;
  let anyUnknown = false;

  const record = (
    clause: string,
    clauseId: string,
    expression: string,
    factRefs: string[],
    status: StructuredRuleStatus,
    reason: string,
  ) => {
    clauseResults.push({ clause, clauseId, expression, factRefs, status, reason });
    if (status === "fail") anyFail = true;
    else if (status === "unknown-review-required") anyUnknown = true;
  };

  // Required clauses (AND).
  rule.requiredClauses.forEach((clause, i) => {
    const id = ids.required[i];
    const f = factOf(facts, id);
    const status: StructuredRuleStatus =
      f === true ? "pass" : f === false ? "fail" : "unknown-review-required";
    record(clause, id, "required", [id], status,
      status === "pass" ? "required clause satisfied"
        : status === "fail" ? "required clause NOT satisfied"
          : "required clause fact missing/ambiguous — needs review");
  });

  // OR groups (each group must hold).
  rule.orAlternatives.forEach((group, g) => {
    const altIds = ids.orGroups[g];
    const vals = group.map((_, k) => factOf(facts, altIds[k]));
    const anyTrue = vals.some((v) => v === true);
    const allFalse = vals.every((v) => v === false);
    const status: StructuredRuleStatus = anyTrue ? "pass" : allFalse ? "fail" : "unknown-review-required";
    record(`(one of) ${group.join(" | ")}`, `o${g}`, "or-group", altIds, status,
      anyTrue ? "at least one alternative satisfied"
        : allFalse ? "no alternative satisfied"
          : "no alternative confirmed and some are unknown — needs review");
  });

  // Exclusions (presence ⇒ fail).
  rule.exclusions.forEach((clause, i) => {
    const id = ids.exclusions[i];
    const f = factOf(facts, id);
    // f===true means the disqualifier IS present ⇒ fail; false ⇒ ok; unknown ⇒ review.
    const status: StructuredRuleStatus =
      f === true ? "fail" : f === false ? "pass" : "unknown-review-required";
    record(clause, id, "exclusion", [id], status,
      f === true ? "disqualifier present ⇒ fail"
        : f === false ? "disqualifier absent"
          : "disqualifier presence unknown — needs review");
  });

  // Thresholds (AND).
  rule.thresholds.forEach((t, i) => {
    const id = ids.thresholds[i];
    const r = evalThreshold(t, facts);
    const status: StructuredRuleStatus =
      r === true ? "pass" : r === false ? "fail" : "unknown-review-required";
    record(`${t.subject} ${t.operator} ${t.value}`, id, "threshold", [t.subject], status,
      r === true ? "threshold met" : r === false ? "threshold not met" : "measurement missing — needs review");
  });

  const status: StructuredRuleStatus = anyFail ? "fail" : anyUnknown ? "unknown-review-required" : "pass";
  const rationale =
    status === "fail"
      ? "At least one required clause / OR-group / threshold is definitely not satisfied, or a disqualifier is present."
      : status === "unknown-review-required"
        ? "No definite failure, but one or more clauses could not be determined from the supplied facts — a human must adjudicate rather than assume a pass."
        : "Every required clause, OR-group and threshold is satisfied and no disqualifier is present.";

  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    status,
    clauseResults,
    rationale,
  };
}

// ─── Runtime trace (attached to every scored MeasureResult) ───────────────────

/**
 * The compact, exported record proving WHICH canonical rule governed a runtime
 * decision — its identity, version, the field its Yes-bar was resolved from, the
 * clauses used, and the basis of the final decision. Attached to every scored
 * MeasureResult so the reviewer's requirement ("export its identity, version and
 * the clauses used in each final decision") is met on the live scoring path.
 */
export interface CanonicalRuleTrace {
  ruleId: string;
  ruleVersion: number;
  sourceField: string;
  provenance: string;
  /** True when the Yes-bar came ONLY from a strict fallback and needs review. */
  flaggedForReview: boolean;
  /** Human-readable list of the clauses that make up the canonical Yes-bar. */
  clausesUsed: string[];
  /** One-line statement of what governed the final decision. */
  finalDecisionBasis: string;
  /** Stable hash of the measure's decision-relevant content, for staleness detection. */
  frameworkHash?: string;
  /** Any operator override recorded on the decision (never mutates the machine outcome). */
  override?: string;
}

/**
 * Build the runtime trace for a measure. Pure; safe to call on the scoring path.
 * `finalVerdict` (when known) is folded into finalDecisionBasis for the record.
 */
export function buildCanonicalRuleTrace(
  measure: any,
  opts?: { finalVerdict?: string; override?: string },
): CanonicalRuleTrace {
  const rule = buildCanonicalRule(measure);
  const clausesUsed = [
    ...rule.requiredClauses,
    ...rule.orAlternatives.map((g) => `(one of) ${g.join(" | ")}`),
    ...rule.exclusions.map((e) => `NOT: ${e}`),
    ...rule.thresholds.map((t) => `${t.subject} ${t.operator} ${t.value}`),
  ];
  const basis =
    rule.provenance === "fallback-derived"
      ? "Yes-bar derived ONLY from a strict fallbackYesCriterion (no substantive criterion present) — FLAGGED for review; NOT treated as an authoritative substantive bar."
      : `Yes-bar governed by ${rule.sourceField} (provenance: ${rule.provenance}).`;
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    sourceField: rule.sourceField ?? "derived-default",
    provenance: rule.provenance ?? "derived-default",
    flaggedForReview: rule.flaggedForReview ?? false,
    clausesUsed,
    finalDecisionBasis: opts?.finalVerdict ? `${basis} Final verdict: ${opts.finalVerdict}.` : basis,
    frameworkHash: rule.evidenceBindings[0]?.contentHash,
    ...(opts?.override ? { override: opts.override } : {}),
  };
}
