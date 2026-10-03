/**
 * Framework Creation v2 — Construction Rules C1–C11
 *
 * Each rule is a build-time enforcement of a property that prevents a specific
 * failure mode identified in Sprint 9 FP/FN diagnostics.
 *
 * Rules are pure functions returning { passed, violations }. They do not
 * mutate the framework; the caller decides how to respond to failures.
 *
 * Design ref: CompanyIQ-Framework-Creation-Design-v2.md
 */

import { runLexiconHygiene, type SurfaceInput } from "./reliability/lexicon-hygiene.js";
import { isAdjudicated, normalizeTopicKey, type SynonymAdjudication } from "./synonym-adjudication.js";
import { buildCanonicalRule } from "./reliability/canonical-rule.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface MeasureDraft {
  measureId: string;
  title: string;
  definition?: string;
  primary_assessment_target?: string;
  substantive_definition?: string;
  whatConstitutesEvidence?: string | string[];
  whatDoesNotConstituteEvidence?: string | string[];
  scoringGuidance?: string;
  fallback_yes_criterion?: string;
  positive_examples?: string[];
  negative_examples?: string[];
  min_quote_context_chars?: number;
  expected_yes_rate?: number;
  expected_yes_rate_justification?: string;
  coverage_whitelist?: string[];
  c1_achievement_guidance?: {
    yes_cases: string[];
    no_cases: string[];
    distinguishing_test: string;
  };
  r3_1_exception_metrics?: boolean;
  r3_1_exception_coverage?: boolean;
  disclosure_vehicles?: string[];
}

export interface FrameworkDraft {
  frameworkId?: string;
  name: string;
  topicTerm: string;
  topicSynonyms?: string[];
  adjacentTopics?: Array<{
    name: string;
    example_phrases?: string[];
    cooccurrence_possible?: boolean;
  }>;
  anchorFrameworks?: Array<{ name: string; source?: string }>;
  sensitivityPreference?: "precision" | "recall" | "balanced";
  // Retrieval guard artefacts (populated at intake). Optional so the type stays
  // backward-compatible; the set-level empty-guard check emits an `info` flag
  // (never error/warning) when they are absent/empty at validation time.
  negativeKeywords?: string[];
  antiInferenceRules?: string[];
  // Recorded per-term decisions about suspect topicSynonyms (Option 3). When a
  // flagged term already carries a decision here, the lexicon-hygiene advisory
  // skips it so the notice terminates instead of recurring. Optional/additive.
  synonymAdjudications?: SynonymAdjudication[];
  measures: MeasureDraft[];
}

export interface Violation {
  measureId?: string;
  rule: string;
  // "info" is a NON-repair-triggering severity for advisory, set-level
  // diagnostics (overlap, numbering, empty guards). It is deliberately EXCLUDED
  // from the repair trigger (framework-builder-v2.ts ~L1048, which checks only
  // `severity === "error"`) and from the repairMeasuresTargeted grouping
  // (~L866, which skips anything that is not error/warning) so new checks can
  // never grow the repair payload. See the 316678be repair-loop telemetry.
  severity: "error" | "warning" | "info";
  message: string;
  suggestion?: string;
  // Optional structured payload for advisories whose consumers need machine-
  // readable detail beyond the human message (e.g. overlap pairs persisted into
  // residualWarnings). Backward-compatible: every existing consumer ignores it.
  meta?: Record<string, unknown>;
}

export interface ValidationResult {
  passed: boolean;
  violations: Violation[];
}

// ─── Constants ───────────────────────────────────────────────────────────

const ACHIEVEMENT_VERB_PATTERNS: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /\bhas achieved\b/i, verb: "has achieved" },
  { pattern: /\bhas phased out\b/i, verb: "has phased out" },
  { pattern: /\bhas eliminated\b/i, verb: "has eliminated" },
  { pattern: /\bhas excluded\b/i, verb: "has excluded" },
  { pattern: /\bcurrently excludes\b/i, verb: "currently excludes" },
  { pattern: /\bcurrently applies\b/i, verb: "currently applies" },
  { pattern: /\bhas implemented enterprise-wide\b/i, verb: "has implemented enterprise-wide" },
  { pattern: /\bcurrently operates\b/i, verb: "currently operates" },
  { pattern: /\bcurrently maintains\b/i, verb: "currently maintains" },
];

const FORBIDDEN_EXCLUSION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /forward[- ]looking (commitments? do not|commitments? does not)/i, label: "forward-looking commitment disqualifier" },
  { pattern: /\bcommitments? or plans do not qualify\b/i, label: "commitments-or-plans disqualifier" },
  { pattern: /\bforward[- ]looking language\b/i, label: "forward-looking language disqualifier" },
  { pattern: /future actions? do not count/i, label: "future-actions disqualifier" },
  { pattern: /\bplans or commitments? are not evidence\b/i, label: "plans-or-commitments disqualifier" },
  { pattern: /\ban intention to (disclose|develop|adopt|publish)/i, label: "intention-to-disclose disqualifier" },
  { pattern: /\ba commitment to (disclose|develop|adopt|publish)/i, label: "commitment-to-disclose disqualifier" },
  { pattern: /the measure requires an existing disclosure, not an intention to disclose/i, label: "existing-disclosure-only disqualifier" },
];

// Issue 2 — Tense-gate patterns. A Yes-gate must gate on in-effect-vs-aspiration,
// NOT on grammatical tense. These patterns detect a Yes-condition that REQUIRES
// present tense, or that EXCLUDES a completed/past-tense adoption — both wrongly
// drop a legitimate DATED disclosure ("The Board approved our Strategy in March
// 2024"). Topic-agnostic: the patterns match grammatical/temporal words only,
// never subject matter. Kept separate from FORBIDDEN_EXCLUSION_PATTERNS because
// this family is scanned over the *Yes-gate* (fallback_yes_criterion /
// scoringGuidance), not the exclusion field.
const TENSE_GATE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /present[- ]tense/i, label: "present-tense requirement" },
  { pattern: /\brequires? (a |an |the )?present\b/i, label: "present-tense requirement" },
  { pattern: /\bmust (be|use|be written) (in )?(the )?present\b/i, label: "present-tense requirement" },
  { pattern: /\b(past|completed|prior|historical|dated)[ -]?(tense )?(action|adoption|approval|disclosure|statement|commitment)s? (do(es)? not|are not|is not|cannot|must not|will not) (count|qualify|be accepted|be counted|suffice|apply)/i, label: "past/completed-action exclusion" },
  { pattern: /\b(completed|past)\b[^.]{0,40}\b(do(es)? not (count|qualify)|not (count|qualify|accepted|eligible))\b/i, label: "completed-action exclusion" },
];

// Returns the first tense-gate label found in `text`, or undefined. Exported so
// unit tests and callers outside validateC2 can reuse the same detection.
export function containsTenseGate(text: string): string | undefined {
  if (!text) return undefined;
  for (const { pattern, label } of TENSE_GATE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

// Canonical in-effect clause appended when tense-gating content is removed, so
// the Yes-gate still expresses its in-effect-vs-aspiration requirement. WORDED
// DELIBERATELY so it matches NO TENSE_GATE_PATTERN (no "present"; "must be
// currently" is NOT "must be ... present"). Verified by unit test.
const IN_EFFECT_CLAUSE =
  "A Yes requires the artefact to be currently in force or adopted and still in effect " +
  "(regardless of grammatical tense); only merely planned or aspirational statements fail.";

// Deterministic, idempotent, topic-agnostic LAST-RESORT neutraliser for a
// tense-gated Yes-gate (C2). When the repair LLM fails to strip tense-gating
// phrasing from fallback_yes_criterion / scoringGuidance — or omits the field so
// mergeCorrectedMeasure preserves the ORIGINAL tense-gated text — the repair loop
// calls this to guarantee convergence rather than re-emitting the same
// [ERROR][C2]. This mirrors the C7b `ensureCountableCoverageTitle` pattern.
//
// Contract:
//   - If `!text` OR `containsTenseGate(text)` is undefined → return the text
//     UNCHANGED (idempotent no-op; a clean field is never touched).
//   - Otherwise remove the offending content at sentence/clause granularity:
//     split on sentence/clause boundaries (keeping terminators), DROP any segment
//     that itself trips `containsTenseGate`, rejoin the survivors cleanly, and —
//     if anything was dropped — append the canonical in-effect clause so the gate
//     still states its requirement.
//   - HARD GUARANTEE: `containsTenseGate(neutralizeTenseGate(x))` is undefined
//     for all x, and `neutralizeTenseGate(neutralizeTenseGate(x)) ===
//     neutralizeTenseGate(x)`.
//   - Topic-agnostic: only grammatical/temporal manipulation, never subject
//     matter. Pure: the fail-loud log lives at the call site.
export function neutralizeTenseGate(text: string): string {
  if (!text) return text;
  if (!containsTenseGate(text)) return text; // idempotent no-op on a clean field
  // Split into segments, preserving the terminator on each preceding segment.
  const segments = text.split(/(?<=[.!?;])\s+/);
  const survivors = segments.filter((seg) => !containsTenseGate(seg));
  // Rejoin survivors, tidy whitespace and any leftover dangling punctuation /
  // separators created by dropping a middle segment.
  let rebuilt = survivors
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([(\[]）?)\s*([.,;:!?])/g, "$2")
    .replace(/^[\s.,;:!?)\]]+/, "")
    .trim();
  // Append the canonical in-effect clause (content was dropped by construction:
  // we only reach here when the original tripped containsTenseGate).
  rebuilt = rebuilt ? `${rebuilt} ${IN_EFFECT_CLAUSE}` : IN_EFFECT_CLAUSE;
  return rebuilt;
}

const MIN_QUOTE_CONTEXT_CHARS = 120;

const COVERAGE_KEYWORDS_IN_TITLE = [
  "enterprise-wide", "portfolio", "operations", "supply chain",
  "coverage", "applies to", "all", "%", "percent", "majority",
  "group-wide", "company-wide", "globally", "across the",
];

// Issue 3 — deterministic, STRUCTURAL coverage detection. A measure is
// coverage-type when its title or primary_assessment_target asserts SCOPE using
// the quantifier/scope vocabulary above — independent of whether the drafter
// remembered to self-flag it with r3_1_exception_coverage. This closes the
// "forgot to flag it" escape (design Issue 3). Topic-agnostic: the vocabulary is
// scope/quantifier words only, never subject matter.
export function isCoverageMeasure(m: MeasureDraft): boolean {
  const hay = `${m.title || ""} ${m.primary_assessment_target || ""}`.toLowerCase();
  return COVERAGE_KEYWORDS_IN_TITLE.some((kw) => hay.includes(kw));
}

// An EXPLICIT, countable coverage threshold. Deliberately NARROWER than the
// detection set above: a measure can be DETECTED as coverage by a vague scope
// phrase ("across the organisation") yet still FAIL C7/C11 for stating no
// countable threshold. A percentage, an "N of M" count, or a definite-proportion
// quantifier (all/every/each/majority/enterprise-wide/...) counts; a bare scope
// phrase does not. Topic-agnostic.
const COVERAGE_THRESHOLD_WORDS = [
  "all", "every", "each", "majority",
  "enterprise-wide", "company-wide", "group-wide", "globally",
];
// Exported so the repair path (server/routes/framework-builder-v2.ts) can reuse
// the SAME check byte-for-byte when deterministically guaranteeing a coverage
// title clears C7 — the repair must converge on exactly what this validator
// requires, never a near-equivalent. Behaviour unchanged.
export function hasExplicitCoverageThreshold(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (/\d+\s*%/.test(t)) return true; // "70%"
  if (/\b\d+\s*(?:percent|of|out of)\b/.test(t)) return true; // "70 percent", "8 of 10"
  return COVERAGE_THRESHOLD_WORDS.some(
    (w) => new RegExp(`\\b${w.replace(/-/g, "[- ]")}\\b`, "i").test(t),
  );
}

// Deterministic, idempotent LAST-RESORT title augmentation for C7. When the
// repair LLM has been asked to add a countable coverage threshold to a measure
// title but its rewrite STILL fails `hasExplicitCoverageThreshold`, the repair
// loop calls this to guarantee convergence rather than looping forever on the
// same [ERROR][C7]. It prefixes the definite-proportion quantifier
// "Enterprise-wide" (which the helper accepts) in a grammatical way.
//
// Contract:
//   - Prefer the caller's own title: if it ALREADY passes the check, it is
//     returned UNCHANGED (idempotent / no-op — this also prevents double-
//     prefixing, since any already-augmented title passes).
//   - Topic-agnostic: adds only a scope quantifier, never subject matter.
//   - Pure: no side effects; the fail-loud log lives at the call site so this
//     stays unit-testable.
export function ensureCountableCoverageTitle(title: string): string {
  const original = (title || "").trim();
  // Already countable (incl. a prior "Enterprise-wide " augmentation) → no-op.
  if (hasExplicitCoverageThreshold(original.toLowerCase())) return original;
  if (!original) return "Enterprise-wide coverage";
  // Lowercase the original's leading char so "Enterprise-wide " reads as a
  // grammatical modifier of the existing phrase (e.g. "Enterprise-wide coverage
  // of operations"), except when it begins with an acronym / proper token we
  // should not alter (two+ leading uppercase letters).
  const keepCase = /^[A-Z]{2,}/.test(original);
  const body = keepCase ? original : original.charAt(0).toLowerCase() + original.slice(1);
  return `Enterprise-wide ${body}`;
}

// Coverage-EXTENT degree words. Kept SEPARATE from the global DEGREE_WORDS set so
// that adding extent vocabulary here never widens the generic C11 degree check
// (which would create false positives in non-coverage measures). These are the
// words that make a coverage EXTENT unquantified ("broad coverage", "wide-
// ranging application"). Topic-agnostic: pure extent adjectives/adverbs.
const COVERAGE_EXTENT_WORDS = [
  "broad", "broadly", "wide", "wide-ranging", "widespread",
  "extensive", "extensively", "far-reaching", "sweeping",
  "comprehensive", "comprehensively", "holistic",
];
function findCoverageExtentWords(text: string): string[] {
  const t = (text || "").toLowerCase();
  const found = new Set<string>();
  for (const w of COVERAGE_EXTENT_WORDS) {
    if (new RegExp(`\\b${w.replace(/-/g, "[- ]")}\\b`, "i").test(t)) found.add(w);
  }
  return [...found];
}

// Degree / holistic-judgment words. When a Yes-condition hinges on one of
// these, two scoring models routinely read the SAME anchor sentence and split
// on whether it clears the bar — the root cause of run-to-run verdict flips.
// Curated set: err toward this list, keep editable. Whole-word, case-insensitive.
export const DEGREE_WORDS: readonly string[] = [
  "substantive", "substantively", "substantially",
  "systematic", "systematically",
  "integrated", "integration",
  "sufficient", "sufficiently",
  "robust",
  "meaningful",
  "adequate", "adequately",
  "appropriate", "appropriately",
  "comprehensive", "comprehensively",
  "holistic",
  "effective", "effectively",
  "strong",
  "well-developed",
];

// ─── Helper ──────────────────────────────────────────────────────────────

function toText(field: string | string[] | undefined): string {
  if (!field) return "";
  return Array.isArray(field) ? field.join(" ") : field;
}

function isExceptionMeasure(m: MeasureDraft): boolean {
  return Boolean(m.r3_1_exception_metrics || m.r3_1_exception_coverage);
}

// Whole-word, case-insensitive degree-word matcher. Returns the distinct
// degree words found in `text` (lower-cased). Data-driven from DEGREE_WORDS.
const DEGREE_WORD_REGEX = new RegExp(
  `\\b(${DEGREE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
);

export function findDegreeWords(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  DEGREE_WORD_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEGREE_WORD_REGEX.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

// Detects an explicit COUNTABLE decision rule — an N-of-M test over named,
// quote-verifiable artefacts. Accepts selection phrasing ("at least N of",
// "any N of", "N of the following", "any of the following") OR an enumerated
// list of >=3 named items ("(1)..(2)..(3)", "1...2...3.", "1)..2)..3)", or
// "(a)..(b)..(c)"). Pattern-based, not hardcoded to any measure.
function hasCountableRule(text: string): boolean {
  if (!text) return false;
  const numWord = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const selectionPatterns = [
    new RegExp(`\\bat least\\s+${numWord}\\s+of\\b`, "i"),
    new RegExp(`\\bany\\s+${numWord}\\s+of\\b`, "i"),
    new RegExp(`\\b${numWord}\\s+of the following\\b`, "i"),
    new RegExp(`\\b${numWord}\\s+or more of\\b`, "i"),
    /\bany of the following\b/i,
  ];
  for (const p of selectionPatterns) if (p.test(text)) return true;
  // Enumerated list of >=3 named items across common styles.
  const enumPatterns = [
    /\((\d+)\)/g,            // (1) (2) (3)
    /(?:^|\n|\.\s)(\d+)\.\s/g, // 1. 2. 3.
    /(?:^|\n)(\d+)\)\s/g,    // 1) 2) 3)
    /\(([a-z])\)/gi,         // (a) (b) (c)
  ];
  for (const pat of enumPatterns) {
    pat.lastIndex = 0;
    const seen = new Set<string>();
    let mm: RegExpExecArray | null;
    while ((mm = pat.exec(text)) !== null) seen.add(mm[1].toLowerCase());
    if (seen.size >= 3) return true;
  }
  return false;
}

// Split a fallback_yes_criterion into its TOP-LEVEL numbered conditions.
// Recognises "(1)(2)(3)", "1. 2. 3." and "1) 2) 3)" as top-level condition
// delimiters, while treating "(a)(b)(c)" as sub-items WITHIN a condition (a
// named-artefact enumeration), NOT as separate conditions. Any preamble before
// the first marker (the "Yes if ANY of the following…" OR-framing) is dropped —
// it is not a deciding test. When no numbered structure is present the whole
// text is returned as a single condition. Marker numbers are bounded to 1–20 so
// years/amounts ("by 2030.", "$10") are not mistaken for list markers.
function splitIntoConditions(text: string): string[] {
  if (!text) return [];
  const markerRe = /(?:\((\d+)\)|(?:^|\n|\s)(\d+)[.)](?=\s))/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    const numStr = m[1] !== undefined ? m[1] : m[2];
    const num = parseInt(numStr, 10);
    if (!(num >= 1 && num <= 20)) continue;
    // For the whitespace-prefixed branch, skip the leading ws char so the snippet
    // begins at the digit; the "(N)" and start-of-string branches begin already.
    const start = m[2] !== undefined && /\s/.test(text[m.index]) ? m.index + 1 : m.index;
    starts.push(start);
  }
  if (starts.length === 0) {
    const whole = text.trim();
    return whole ? [whole] : [];
  }
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : text.length;
    const seg = text.slice(s, e).trim();
    if (seg) parts.push(seg);
  }
  return parts;
}

// True when a single condition enumerates >=2 distinct named sub-items
// "(a)(b)(c)" — an in-condition artefact enumeration that makes the deciding
// test quote-verifiable even if the condition also uses a degree word.
function hasNamedArtefactEnumeration(text: string): boolean {
  if (!text) return false;
  const re = /\(([a-z])\)/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) seen.add(m[1].toLowerCase());
  return seen.size >= 2;
}

function containsTopicOrSynonym(text: unknown, topicTerm: unknown, synonyms: unknown): boolean {
  const t = typeof text === "string" ? text : "";
  const term = typeof topicTerm === "string" ? topicTerm : "";
  const syns: string[] = Array.isArray(synonyms)
    ? synonyms.filter((s): s is string => typeof s === "string")
    : [];
  const lc = t.toLowerCase();
  if (term && lc.includes(term.toLowerCase())) return true;
  for (const s of syns) {
    if (s && lc.includes(s.toLowerCase())) return true;
  }
  return false;
}

// ─── C1 — Position-testing phrasing with permissive interpretation ────────

export function validateC1(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    if (isExceptionMeasure(m)) continue;
    const combined = ((m.title || "") + " " + (m.primary_assessment_target || "")).toLowerCase();
    for (const { pattern, verb } of ACHIEVEMENT_VERB_PATTERNS) {
      if (pattern.test(combined)) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: `Title or primary_assessment_target contains achievement verb "${verb}"`,
          suggestion: `Rewrite as "does the entity disclose a policy/target/commitment on X" instead of achievement phrasing. If this is truly a metrics or coverage measure, set r3_1_exception_metrics: true or r3_1_exception_coverage: true.`,
        });
      }
    }
    // C1 also requires per-measure achievement guidance
    if (!m.c1_achievement_guidance) {
      violations.push({
        measureId: m.measureId,
        rule: "C1",
        severity: "error",
        message: "Missing c1_achievement_guidance",
        suggestion: `Add c1_achievement_guidance with yes_cases (achievement claims that entail a position), no_cases (factual outcomes without target-state language), and distinguishing_test.`,
      });
    } else {
      const g = m.c1_achievement_guidance as any;
      // Accept either array-of-strings OR a single non-empty string. Some LLM
      // outputs emit a single descriptive sentence rather than a list.
      const yesOk =
        (Array.isArray(g.yes_cases) && g.yes_cases.length > 0) ||
        (typeof g.yes_cases === "string" && g.yes_cases.trim().length >= 10);
      const noOk =
        (Array.isArray(g.no_cases) && g.no_cases.length > 0) ||
        (typeof g.no_cases === "string" && g.no_cases.trim().length >= 10);
      if (!yesOk) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: "c1_achievement_guidance.yes_cases is empty (must be non-empty array or non-empty string)",
        });
      }
      if (!noOk) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: "c1_achievement_guidance.no_cases is empty (must be non-empty array or non-empty string)",
        });
      }
      if (!g.distinguishing_test || String(g.distinguishing_test).length < 20) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "warning",
          message: "c1_achievement_guidance.distinguishing_test is missing or too brief",
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C2 — Substantive-only exclusions ─────────────────────────────────────

export function validateC2(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const excl = toText(m.whatDoesNotConstituteEvidence);
    if (!excl) {
      violations.push({
        measureId: m.measureId,
        rule: "C2",
        severity: "error",
        message: "whatDoesNotConstituteEvidence is missing",
        suggestion: "Provide substantive-only exclusions (wrong subject, missing specificity, third-party attribution, adjacent-topic evidence).",
      });
      continue;
    }
    for (const { pattern, label } of FORBIDDEN_EXCLUSION_PATTERNS) {
      if (pattern.test(excl)) {
        violations.push({
          measureId: m.measureId,
          rule: "C2",
          severity: "error",
          message: `whatDoesNotConstituteEvidence contains forbidden ${label}`,
          suggestion: "Remove tense/aspiration-based exclusions. Reject only on substantive grounds: wrong subject, missing specificity, third-party attribution, adjacent-topic evidence.",
        });
      }
    }
    // Issue 2 — the Yes-gate ITSELF must not gate on grammatical tense. C2
    // historically scanned only the exclusion field, so a tense-restrictive
    // Yes-gate (e.g. "requires a present-tense deployment verb") was invisible
    // and wrongly dropped a dated completed adoption. Scan the Yes-gate
    // (fallback_yes_criterion + scoringGuidance) with the same in-effect-vs-
    // aspiration principle. Topic-agnostic (grammatical/temporal words only).
    const yesGateText = `${toText(m.fallback_yes_criterion)} ${toText(m.scoringGuidance)}`.trim();
    const tenseGateLabel = containsTenseGate(yesGateText);
    if (tenseGateLabel) {
      violations.push({
        measureId: m.measureId,
        rule: "C2",
        severity: "error",
        message: `fallback_yes_criterion/scoringGuidance gates on tense (${tenseGateLabel}); gate on in-effect-vs-aspiration instead.`,
        suggestion: "A Yes requires the artefact to be in effect or adopted (any tense): a dated completed adoption ('the Board approved X in March 2024') satisfies the gate. Reject only aspirational statements (intent without adoption), never past-tense completed action.",
      });
    }
    // Must include some form of unspecific / aspirational / generic rejection.
    // The intent is that the framework rejects claims that lack specificity —
    // whether the LLM phrases this as "aspirational language", "generic
    // statements", "without specificity", "vague commitments", or "boilerplate",
    // all count. If the exclusion clause covers scope, third-party, adjacent-topic,
    // or subject-attribution grounds, that is also substantive rejection.
    const specificityPatterns = [
      /aspirational/i,
      /generic (statement|language|reference|mention)/i,
      /without (specific|specificity|detail|numbers|quantif|target|commitment|programme|program)/i,
      /no specific/i,
      /vague/i,
      /boilerplate/i,
      /marketing (language|copy)/i,
      /general (environmental|sustainability|corporate)/i,
      /third[- ]party|industry initiative/i,
      /adjacent topic/i,
      /without .+ specificity/i,
      /lack(s|ing) specificity/i,
      /management[- ]level (activities|only)/i,
    ];
    if (!specificityPatterns.some((p) => p.test(excl))) {
      violations.push({
        measureId: m.measureId,
        rule: "C2",
        severity: "warning",
        message: "whatDoesNotConstituteEvidence should reject unspecific/aspirational statements. Consider adding language like 'without specific programmes, targets, or quantification'.",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C3 — Quote-context requirement ───────────────────────────────────────

export function validateC3(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    if (typeof m.min_quote_context_chars !== "number" || m.min_quote_context_chars < MIN_QUOTE_CONTEXT_CHARS) {
      violations.push({
        measureId: m.measureId,
        rule: "C3",
        severity: "error",
        message: `min_quote_context_chars must be an integer ≥${MIN_QUOTE_CONTEXT_CHARS}`,
      });
    }
    const sg = m.scoringGuidance || "";
    // Accept any language that establishes the quote must include enough
    // surrounding text. Explicit character/word thresholds count, as do
    // "adjacent sentence", "full sentence", "passing mention", etc.
    const contextPatterns = [
      /adjacent sentence/i,
      /surrounding sentence/i,
      /surrounding context/i,
      /full sentence/i,
      /(?:at least |>=|≥)\s*\d{2,4}\s*characters?/i,
      /(?:at least |>=|≥)\s*\d+\s*words?/i,
      /not a passing mention/i,
      /sufficient context/i,
      /enough context/i,
      /verbatim quote/i,
    ];
    if (!contextPatterns.some((p) => p.test(sg))) {
      violations.push({
        measureId: m.measureId,
        rule: "C3",
        severity: "warning",
        message: "scoringGuidance should specify that the returned quote include enough surrounding context (adjacent sentence, minimum character count, or equivalent).",
        suggestion: "Add: 'When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.'",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C4 — Topic-anchored fallback conditions ──────────────────────────────

export function validateC4(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  const synonyms = fw.topicSynonyms || [];
  for (const m of fw.measures) {
    const fb = m.fallback_yes_criterion || "";
    if (!fb) {
      violations.push({
        measureId: m.measureId,
        rule: "C4",
        severity: "error",
        message: "fallback_yes_criterion is missing",
      });
      continue;
    }
    // Count numbered conditions. Accept multiple styles: (1) (2), 1. 2., 1) 2),
    // or list-array form if the LLM emitted an array. Bullet-style dashes are
    // not accepted — conditions must be enumerable.
    let conditions: Array<{ n: string; text: string }> = [];
    if (Array.isArray(fb)) {
      conditions = (fb as unknown as string[]).map((t, i) => ({ n: String(i + 1), text: String(t) }));
    } else {
      // Try parenthesised "(1)", then dotted "1." (allowing multi-line), then
      // paren-suffix "1)".
      const parenPattern = /\((\d+)\)\s*([\s\S]*?)(?=\(\d+\)|$)/g;
      const dottedPattern = /(?:^|\n|\.\s)(\d+)\.\s+([\s\S]*?)(?=(?:^|\n|\.\s)\d+\.\s+|$)/g;
      const suffixPattern = /(?:^|\n)(\d+)\)\s+([\s\S]*?)(?=(?:^|\n)\d+\)\s+|$)/g;
      for (const pat of [parenPattern, dottedPattern, suffixPattern]) {
        pat.lastIndex = 0;
        const found: Array<{ n: string; text: string }> = [];
        let match: RegExpExecArray | null;
        while ((match = pat.exec(fb as string)) !== null) {
          const text = String(match[2] || "").trim();
          if (text.length >= 10) found.push({ n: match[1], text });
        }
        if (found.length >= 3) {
          conditions = found;
          break;
        }
        // Keep the best partial for reporting
        if (found.length > conditions.length) conditions = found;
      }
    }
    if (conditions.length < 3) {
      violations.push({
        measureId: m.measureId,
        rule: "C4",
        severity: "error",
        message: `fallback_yes_criterion has ${conditions.length} numbered conditions; requires ≥3 (accepted formats: "(1) ...", "1. ...", or "1) ...")`,
      });
      continue;
    }
    // Fallback conditions are AND-joined — for the fallback to fire, EVERY
    // condition must be satisfied. That means scope only needs to be anchored
    // ONCE in the condition set; the remaining conditions can be general
    // prerequisites (e.g. "the described responsibility involves oversight").
    // Requiring every condition to name the topic produces stilted text like
    // "reviewing nature and biodiversity strategy or monitoring nature and
    // biodiversity performance". So: enforce at-least-one topic anchor, and
    // no warning for the remainder.
    const substantive = conditions.filter((c) => c.text.length >= 20);
    const withTopic = substantive.filter((c) => containsTopicOrSynonym(c.text, fw.topicTerm, synonyms));
    if (substantive.length > 0 && withTopic.length === 0) {
      violations.push({
        measureId: m.measureId,
        rule: "C4",
        severity: "error",
        message: `No fallback condition references the topic term "${fw.topicTerm}" or any registered synonym`,
        suggestion: "At least one numbered condition must name the topic explicitly. Fallback conditions are AND-joined; if none anchor to the topic, generic evidence can trigger a Yes.",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C5 — Adjacent-topic exclusion in substantive_definition ──────────────

export function validateC5(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  const adjacent = fw.adjacentTopics || [];
  const hasAdjacent = adjacent.length >= 2;

  for (const m of fw.measures) {
    const sd = m.substantive_definition || "";
    if (!sd) {
      violations.push({
        measureId: m.measureId,
        rule: "C5",
        severity: "error",
        message: "substantive_definition is missing",
      });
      continue;
    }
    if (hasAdjacent) {
      // Check that at least one adjacent-topic reference appears in the
      // substantive_definition. The LLM often paraphrases adjacent-topic
      // names ("climate scenario analysis" instead of "Climate Change") when
      // embedding them in a sentence — that is correct and natural, so we
      // match on ANY of:
      //   1. the full adjacent.name substring, OR
      //   2. any distinctive content token from adjacent.name (≥4 chars,
      //      excluding common stopwords like "and", "of", "the",
      //      "management", "topic", "change", "issues"), OR
      //   3. any example_phrase from the adjacent-topic entry.
      // We also require the substantive_definition to contain an "exclusion"
      // marker phrase so we do not falsely match on random topical mentions.
      const sdLower = String(sd || "").toLowerCase();
      // Require an explicit exclusion / rejection phrase, not just the word "exclusion".
      const hasExclusionMarker =
        /does not satisfy|does not count|not evidence|not sufficient|must be excluded|are excluded|are not evidence|are not sufficient|does not qualify|are not accepted|do not accept|specifically tests .+ (?:and not|not) |does NOT satisfy|adjacent topic/i.test(
          sd,
        );
      const found = adjacent.some((a) => {
        const name = typeof a?.name === "string" ? a.name : "";
        if (!name) return false;
        if (sdLower.includes(name.toLowerCase())) return true;
        // Tokenised match: any distinctive word from the adjacent-topic name.
        const tokens = name
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(
            (t) =>
              t.length >= 4 &&
              ![
                "and",
                "the",
                "of",
                "for",
                "with",
                "management",
                "topic",
                "topics",
                "change",
                "issues",
                "related",
                "policy",
                "general",
                "other",
              ].includes(t),
          );
        for (const tok of tokens) {
          if (sdLower.includes(tok)) return true;
        }
        // Example-phrase match.
        const phrases = Array.isArray(a?.example_phrases) ? a.example_phrases : [];
        for (const p of phrases) {
          if (typeof p === "string" && p.length >= 4 && sdLower.includes(p.toLowerCase())) {
            return true;
          }
        }
        return false;
      });
      if (!hasExclusionMarker) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "error",
          message: `substantive_definition is missing an exclusion clause. Add a sentence naming what does NOT count as evidence (e.g. "Evidence attributed to <adjacent topic> does not satisfy this measure").`,
          suggestion: `Reference at least one adjacent topic from the intake list [${adjacent.map((a) => (typeof a?.name === "string" ? a.name : "?")).join(", ")}].`,
        });
      } else if (!found) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "warning", // downgraded: exclusion clause exists but doesn't match intake vocabulary
          message: `substantive_definition has an exclusion clause but does not obviously reference an intake-listed adjacent topic. Verify the exclusion covers at least one of: ${adjacent.map((a) => (typeof a?.name === "string" ? a.name : "?")).join(", ")}.`,
          suggestion: `Ensure exclusion language names one of the intake's adjacent topics either by name, distinctive keyword, or example phrase.`,
        });
      }
    } else {
      // If no adjacent topics were identified, the framework must state so
      if (!/no adjacent topics identified/i.test(sd)) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "warning",
          message: "No adjacent topics were identified in intake, but substantive_definition should acknowledge this explicitly",
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C6 — Positive AND adversarial-negative examples ──────────────────────

export function validateC6(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const pos = m.positive_examples || [];
    const neg = m.negative_examples || [];
    if (pos.length < 2) {
      violations.push({
        measureId: m.measureId,
        rule: "C6",
        severity: "error",
        message: `positive_examples must have ≥2 entries (found ${pos.length})`,
      });
    }
    if (neg.length < 2) {
      violations.push({
        measureId: m.measureId,
        rule: "C6",
        severity: "error",
        message: `negative_examples must have ≥2 entries (found ${neg.length})`,
      });
    }
    // Length cap: 800 chars per example. Real corporate disclosures on
    // complex topics (TNFD/SBTN biodiversity, TCFD climate, modern-slavery
    // policy paragraphs) routinely run 400–700 chars. 800 is comfortable
    // headroom while still guarding against pasting whole reports.
    // A 1200-char hard error catches obvious mistakes.
    const CAP_WARN = 800;
    const CAP_ERROR = 1200;
    for (const p of pos) {
      if (p.length > CAP_ERROR) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "error",
          message: `positive_example exceeds ${CAP_ERROR} characters (${p.length}) — likely pasted from a full report; trim to a single substantive commitment.`,
        });
      } else if (p.length > CAP_WARN) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "warning",
          message: `positive_example longer than ${CAP_WARN} characters (${p.length}) — consider trimming to the specific substantive claim.`,
        });
      }
    }
    for (const n of neg) {
      if (n.length > CAP_ERROR) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "error",
          message: `negative_example exceeds ${CAP_ERROR} characters (${n.length}) — likely pasted from a full report; trim to a single misleading claim.`,
        });
      } else if (n.length > CAP_WARN) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "warning",
          message: `negative_example longer than ${CAP_WARN} characters (${n.length}) — consider trimming to the specific misleading claim.`,
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C7 — Coverage-explicit phrasing with per-measure whitelist ───────────

export function validateC7(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    // Issue 3 — drive C7 off STRUCTURAL detection, not the self-declared flag
    // alone. A measure whose title/target asserts scope is coverage-type even if
    // the drafter forgot to set r3_1_exception_coverage, so the whitelist/
    // threshold requirement can no longer be skipped by omission.
    if (!isCoverageMeasure(m) && !m.r3_1_exception_coverage) continue;
    // Coverage measures must have coverage_whitelist with ≥3 entries
    const wl = m.coverage_whitelist || [];
    if (wl.length < 3) {
      violations.push({
        measureId: m.measureId,
        rule: "C7",
        severity: "error",
        message: `Coverage measure requires coverage_whitelist with ≥3 plain-language equivalents (found ${wl.length})`,
        suggestion: `Add phrases like "across the group", "enterprise-wide", "all our operations", etc.`,
      });
    }
    // Issue 3 — the title must carry an EXPLICIT, COUNTABLE threshold, not merely
    // a vague scope phrase. Detection (isCoverageMeasure) is intentionally broader
    // than threshold adequacy: a title like "across the organization" flags the
    // measure as coverage-type but does NOT satisfy this check, so a vague-scope
    // coverage measure fails loudly instead of shipping without a real threshold.
    const titleLower = (m.title || "").toLowerCase();
    if (!hasExplicitCoverageThreshold(titleLower)) {
      violations.push({
        measureId: m.measureId,
        rule: "C7",
        severity: "error",
        message: "Coverage measure title must state an EXPLICIT, countable threshold (e.g. 'enterprise-wide', 'all operations', '≥70% of portfolio') — a vague scope phrase such as 'across the organization' is not a threshold",
        suggestion: "Add a countable threshold to the title: a percentage/date, an 'N of M' count, or a definite-proportion quantifier (all/every/each/majority/enterprise-wide).",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C8 — Vehicle-agnostic evidence acceptance ────────────────────────────

export function validateC8(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  // Accept ANY of the following as evidence that the framework is
  // vehicle-agnostic:
  //   1. An explicit "any vehicle" / "any document" / "regardless of vehicle"
  //      phrase in the substantive_definition, OR
  //   2. The substantive_definition enumerates >=2 disclosure vehicles from a
  //      known set (annual report, sustainability report, policy document,
  //      website, code of conduct, KPI table, ESG report, etc.), OR
  //   3. The measure has a disclosure_vehicles array with >=2 entries.
  const VEHICLE_KEYWORDS = [
    "annual report",
    "sustainability report",
    "esg report",
    "policy document",
    "code of conduct",
    "kpi table",
    "entity website",
    "company website",
    "corporate website",
    "integrated report",
    "proxy statement",
    "10-k",
    "annual filing",
    "disclosure document",
    "regulatory filing",
  ];
  const AGNOSTIC_PHRASES = /any vehicle|any disclosure vehicle|any document type|regardless of (the )?disclosure vehicle|regardless of the (report|vehicle|document|form)|whether disclosed in|any of the following (vehicles|documents|reports)/i;
  for (const m of fw.measures) {
    const sd = String(m.substantive_definition || "").toLowerCase();
    const hasAgnosticPhrase = AGNOSTIC_PHRASES.test(sd);
    const vehicleHits = VEHICLE_KEYWORDS.filter((v) => sd.includes(v)).length;
    const hasDisclosureVehiclesField =
      Array.isArray((m as any).disclosure_vehicles) && ((m as any).disclosure_vehicles as string[]).length >= 2;
    if (!hasAgnosticPhrase && vehicleHits < 2 && !hasDisclosureVehiclesField) {
      violations.push({
        measureId: m.measureId,
        rule: "C8",
        severity: "warning",
        message: `substantive_definition should describe vehicle-agnostic evidence acceptance (found ${vehicleHits} vehicle mentions and no explicit agnostic phrase).`,
        suggestion: `Either add an explicit phrase like "disclosed in any vehicle" OR mention ≥2 disclosure vehicles (annual report, sustainability report, policy document, website, etc.) OR populate disclosure_vehicles: [...].`,
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C9 — Expected Yes-rate calibration ───────────────────────────────────

/**
 * Extract explicit yes-rate claims stated in an expected_yes_rate_justification,
 * normalised to a fraction in (0,1). Picks up percentages ("20%", "20 percent")
 * and bare decimal rates ("0.2", ".65"). Topic-agnostic, pure, and unit-tested.
 *
 * Only values that plausibly denote a yes-rate are returned: percentages in
 * [1,99] and decimals in (0,1). This lets C9 catch justifications whose stated
 * rate contradicts the stored expected_yes_rate (e.g. stored 0.653 while the
 * justification says "a 20% rate"), without hard-coding any subject matter.
 */
export function extractStatedRatesFromJustification(text: string): number[] {
  const out: number[] = [];
  const s = String(text || "");
  // Percentages: "20%", "20 %", "20 percent", "20 per cent".
  const pctPattern = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = pctPattern.exec(s)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v >= 1 && v <= 99) out.push(v / 100);
  }
  // Bare decimal rates: "0.2", ".65" — but NOT a percentage already captured and
  // NOT part of a measure id like "2.3" (leading digit ≥1 is excluded by the
  // (0,1) range). Require the integer part to be 0 or absent.
  const decPattern = /(?<![\d.])(0?\.\d+)(?![\d%])/g;
  while ((m = decPattern.exec(s)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v > 0 && v < 1) out.push(v);
  }
  return out;
}

export function validateC9(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  let tooNarrow = 0;
  let tooBroad = 0;
  for (const m of fw.measures) {
    if (typeof m.expected_yes_rate !== "number") {
      violations.push({
        measureId: m.measureId,
        rule: "C9",
        severity: "error",
        message: "expected_yes_rate must be a float in [0.01, 0.99]",
      });
      continue;
    }
    if (m.expected_yes_rate < 0.01 || m.expected_yes_rate > 0.99) {
      violations.push({
        measureId: m.measureId,
        rule: "C9",
        severity: "error",
        message: `expected_yes_rate ${m.expected_yes_rate} out of range [0.01, 0.99]`,
      });
      continue;
    }
    if (m.expected_yes_rate < 0.10) tooNarrow++;
    if (m.expected_yes_rate > 0.80) tooBroad++;

    // Issue 4 — an EXTREME rate (<0.10 or >0.80) must record its base-rate
    // reasoning, so it is reviewable and regression-checkable instead of reading
    // as unjustified calibration. Mid-range rates need no justification.
    // Topic-agnostic: this checks presence/length only, never subject content.
    const isExtreme = m.expected_yes_rate < 0.10 || m.expected_yes_rate > 0.80;
    if (isExtreme) {
      const justification = (m.expected_yes_rate_justification || "").trim();
      if (justification.length < 40) {
        violations.push({
          measureId: m.measureId,
          rule: "C9",
          severity: "error",
          message: `expected_yes_rate ${m.expected_yes_rate} is extreme (<0.10 or >0.80) but expected_yes_rate_justification is ${justification.length === 0 ? "missing" : "too short (< 40 chars)"}. An extreme base rate must state WHY (the population reason), e.g. "few entities disclose an audited figure" or "nearly all large entities state a generic policy".`,
          suggestion: "Add a one-sentence expected_yes_rate_justification giving the base-rate reasoning for this extreme rate. Mid-range rates (0.10–0.80) need no justification.",
        });
      }
    }

    // Issue 4b — numeric self-consistency. If the justification itself states a
    // rate (a percentage or a bare decimal), it must not contradict the stored
    // expected_yes_rate. This catches internal contradictions such as a stored
    // rate of 0.653 while the justification reads "a 20% rate", which is a
    // copy/paste or calibration error rather than a defensible base rate.
    // Topic-agnostic: compares only numbers, never subject matter. We flag only
    // when the nearest stated rate is far (> 0.25) from the stored one, so that
    // incidental numbers and rounding never produce false positives.
    const justText = (m.expected_yes_rate_justification || "").trim();
    if (justText.length > 0) {
      const stated = extractStatedRatesFromJustification(justText);
      if (stated.length > 0) {
        let nearest = Infinity;
        for (const r of stated) {
          const d = Math.abs(r - m.expected_yes_rate);
          if (d < nearest) nearest = d;
        }
        if (nearest > 0.25) {
          violations.push({
            measureId: m.measureId,
            rule: "C9",
            severity: "error",
            message: `expected_yes_rate ${m.expected_yes_rate} contradicts the rate stated in its own justification (nearest stated rate differs by ${nearest.toFixed(2)}). The justification should explain the stored rate, not a different one.`,
            suggestion: "Reconcile expected_yes_rate with the figure quoted in expected_yes_rate_justification — either correct the stored rate or rewrite the justification so the numbers agree.",
          });
        }
      }
    }
  }
  const total = fw.measures.length;
  if (total > 0) {
    if (tooNarrow / total > 0.20) {
      violations.push({
        rule: "C9",
        severity: "warning",
        message: `${tooNarrow}/${total} measures (${((100 * tooNarrow) / total).toFixed(0)}%) have expected_yes_rate <0.10 — framework may be too narrow overall`,
      });
    }
    if (tooBroad / total > 0.20) {
      violations.push({
        rule: "C9",
        severity: "warning",
        message: `${tooBroad}/${total} measures (${((100 * tooBroad) / total).toFixed(0)}%) have expected_yes_rate >0.80 — framework may be too broad overall`,
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C10 — Topic term registration and synonym set ────────────────────────

export function validateC10(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  if (!fw.topicTerm || fw.topicTerm.trim().length < 2) {
    violations.push({
      rule: "C10",
      severity: "error",
      message: "topicTerm is missing or too short",
    });
  }
  const syn = fw.topicSynonyms || [];
  if (syn.length < 2) {
    violations.push({
      rule: "C10",
      severity: "error",
      message: `topicSynonyms must have at least 2 entries (found ${syn.length})`,
      suggestion: "Provide at least 2 substantively-equivalent alternative phrasings and all standard domain acronyms for the topic.",
    });
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C11 — Decidable threshold: degree words require a countable rule ──────
//
// fallback_yes_criterion is judged PER CONDITION: it is split into its top-level
// numbered conditions and every condition whose deciding test relies on a degree
// word MUST itself carry an in-condition countable/named decidable test. A
// countable rule sitting in a DIFFERENT condition no longer rescues it — that is
// exactly the run-to-run flip case (e.g. condition #1 "…risks are INTEGRATED into
// ERM…" while a different condition happens to enumerate "(a)…(e)").
//
// scoringGuidance and substantive_definition keep the original MEASURE-LEVEL
// behaviour: a degree word there needs a countable rule somewhere in the
// measure's decision text. To preserve one-violation-per-measure for that path,
// the secondary check only runs when the fallback conditions are clean.

export function validateC11(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    let measureErrored = false;
    const fallbackText = toText(m.fallback_yes_criterion);

    // ── fallback_yes_criterion: PER-CONDITION decidability ──
    for (const cond of splitIntoConditions(fallbackText)) {
      const words = findDegreeWords(cond);
      if (words.length === 0) continue;
      // The degree word must be made decidable WITHIN this same condition.
      if (hasCountableRule(cond) || hasNamedArtefactEnumeration(cond)) continue;
      const flat = cond.replace(/\s+/g, " ").trim();
      const snippet = flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
      violations.push({
        measureId: m.measureId,
        rule: "C11",
        severity: "error",
        message: `Degree word(s) [${words.join(", ")}] are the deciding test of a fallback_yes_criterion condition that carries no in-condition countable or named-artefact test: "${snippet}". A degree judgment is not decidable from a verbatim quote — two scoring models split on it run-to-run. A countable rule in a different condition does not rescue this one.`,
        suggestion: `Rewrite THIS condition as a countable N-of-M test over NAMED, quote-verifiable artefacts, e.g. "at least 2 of the following appear in a verbatim quote: (a) …, (b) …, (c) …".`,
      });
      measureErrored = true;
    }

    // ── scoringGuidance + substantive_definition: MEASURE-LEVEL (unchanged) ──
    // Skipped when the fallback already flagged this measure, so a measure is not
    // double-reported (matches the original rule's one-violation-per-measure).
    if (!measureErrored) {
      const secondaryFields: Array<{ name: string; text: string }> = [
        { name: "scoringGuidance", text: toText(m.scoringGuidance) },
        { name: "substantive_definition", text: toText(m.substantive_definition) },
      ];
      const hits = secondaryFields
        .map((f) => ({ field: f.name, words: findDegreeWords(f.text) }))
        .filter((h) => h.words.length > 0);
      if (hits.length > 0) {
        // A countable rule anywhere in the measure's decision text governs.
        const combined = [fallbackText, ...secondaryFields.map((f) => f.text)].join("\n");
        if (!hasCountableRule(combined)) {
          const allWords = [...new Set(hits.flatMap((h) => h.words))];
          const fieldList = hits.map((h) => `${h.field} (${h.words.join(", ")})`).join("; ");
          violations.push({
            measureId: m.measureId,
            rule: "C11",
            severity: "error",
            message: `Degree word(s) [${allWords.join(", ")}] appear in ${fieldList} but the measure carries no countable decision rule. A degree judgment is not decidable from a verbatim quote — two scoring models split on it run-to-run.`,
            suggestion: `Replace the degree judgment with a countable N-of-M test over NAMED, quote-verifiable artefacts, e.g. "Yes if at least 2 of the following are present in a verbatim quote: (a) …, (b) …, (c) …".`,
          });
          measureErrored = true;
        }
      }
    }

    // ── COVERAGE MEASURES: a coverage extent decided by a degree word needs an
    // EXPLICIT countable coverage threshold (%, N-of, or a definite-proportion
    // quantifier), not merely any number anywhere in the decision text. A
    // coverage measure can pass the generic checks above by carrying an
    // unrelated countable rule while still deciding its COVERAGE extent on a
    // vague degree word ("broad", "comprehensive", "wide-ranging"). Topic-
    // agnostic: keys off structural coverage detection + grammatical degree
    // words only. Guarded by !measureErrored so a measure is never double-
    // reported. ──
    if (!measureErrored && isCoverageMeasure(m)) {
      const coverageText = [
        toText(m.title),
        fallbackText,
        toText(m.scoringGuidance),
        toText(m.substantive_definition),
      ].join("\n");
      const dw = [...new Set([...findDegreeWords(coverageText), ...findCoverageExtentWords(coverageText)])];
      if (dw.length > 0 && !hasExplicitCoverageThreshold(coverageText)) {
        violations.push({
          measureId: m.measureId,
          rule: "C11",
          severity: "error",
          message: `This is a coverage measure whose coverage extent is decided by degree word(s) [${dw.join(", ")}] with no explicit countable coverage threshold (a percentage, an "N of" count, or a definite-proportion quantifier such as all/every/company-wide). "Broad"/"comprehensive"/"wide" coverage is not decidable from a verbatim quote — two scoring models split on it run-to-run.`,
          suggestion: `State the coverage extent as an explicit threshold, e.g. "covers at least 80% of ..." or "applies to all/every ..." or "spans at least 3 of the following named ...", so the coverage decision is countable from a quote.`,
        });
        measureErrored = true;
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C12 — Prefer a conjunctive hard-token bundle over an M-of-N soft gate ──
//
// ADVISORY (severity: "info", never error/warning). Detects a measure whose
// deciding gate is an "M-of-N" / OR-list SOFT gate — "Yes if ANY of the
// following...", "at least N of the following...", "any N of...", a low N over
// easily-satisfied single conditions — and SUGGESTS tightening it to a
// CONJUNCTIVE HARD-TOKEN BUNDLE (require the co-occurrence of ALL of a small
// set of hard, quote-verifiable tokens in a single quote).
//
// WHY: an M-of-N gate is itself a run-to-run flip source. When a disclosure
// satisfies exactly N or N±1 of the conditions, *which* soft conditions count
// and whether the count clears the bar is a degree judgement made near a
// boundary — two scoring models split on it. Empirically (fw10 → hardened
// clone, 22 Sept 2026), replacing four such gates with ALL-of hard-token
// bundles cut those measures' flip cells 31 → 14 (−55%) while the 30 untouched
// measures stayed flat. See Flip_Rate_Real_Run_Results.md.
//
// This is DISTINCT from C11 (degree words). C11 fires when a degree WORD is the
// deciding test; C12 fires on the OR-list STRUCTURE even when every listed
// condition is individually clean. C12 does NOT set passed=false, is never
// targeted by the repair loop (info-severity, like the set-level diagnostics),
// and is fully dismissible. It fires at most once per measure. A measure that
// already frames its gate conjunctively ("ALL of the following", "simultaneously
// satisfies", "BOTH (i)...AND (ii)...", "must co-occur") is treated as already
// hardened and produces NO advisory.

// A soft M-of-N / OR-list selection gate: any single (or low-N) condition out
// of a list is enough to trigger Yes. Pattern-based, not hardcoded to any
// measure. Deliberately EXCLUDES "all of the following" (a conjunctive bundle).
const SOFT_SELECTION_GATE_PATTERNS: RegExp[] = (() => {
  const numWord = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  return [
    new RegExp(`\\bat least\\s+${numWord}\\s+of the following\\b`, "i"),
    new RegExp(`\\bat least\\s+${numWord}\\s+of\\b(?!\\s+the\\s+following\\s+are\\s+all)`, "i"),
    new RegExp(`\\bany\\s+${numWord}\\s+of\\b`, "i"),
    new RegExp(`\\b${numWord}\\s+or more of the following\\b`, "i"),
    new RegExp(`\\b${numWord}\\s+of the following\\b`, "i"),
    /\bany of the following\b/i,
    /\bany one of\b/i,
    /\byes if any of\b/i,
  ];
})();

// A conjunctive hard-token bundle frame — the hardened form. Its presence means
// the gate already requires co-occurrence, so no advisory is emitted.
const CONJUNCTIVE_BUNDLE_PATTERNS: RegExp[] = [
  /\ball of the following\b/i,
  /\bsimultaneously satisf/i,
  /\bmust (?:all )?co-?occur\b/i,
  /\bco-?occur (?:in|within) (?:a|the same|one) (?:single )?(?:verbatim )?quote\b/i,
  /\brequires? all of\b/i,
  /\ball of\b[^.]{0,40}\bmust be present\b/i,
  /\bboth\b[^.]{0,80}?\band\b[^.]{0,80}?\b(?:present|co-?occur|in the same)\b/i,
  /\((?:i|1|a)\)[^.]{0,160}?\bAND\b[^.]{0,160}?\((?:ii|2|b)\)/,
];

function hasSoftSelectionGate(text: string): boolean {
  if (!text) return false;
  return SOFT_SELECTION_GATE_PATTERNS.some((p) => p.test(text));
}

function hasConjunctiveBundle(text: string): boolean {
  if (!text) return false;
  return CONJUNCTIVE_BUNDLE_PATTERNS.some((p) => p.test(text));
}

// Best-effort N (the selection threshold) and M (number of enumerated options),
// used only to enrich the advisory message. Returns nulls when not parseable.
function describeSoftGate(text: string): { n: number | null; m: number | null } {
  const numMap: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  let n: number | null = null;
  const nMatch = text.match(/\b(?:at least|any)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+of\b/i);
  if (nMatch) {
    const raw = nMatch[1].toLowerCase();
    n = /^\d+$/.test(raw) ? parseInt(raw, 10) : (numMap[raw] ?? null);
  } else if (/\bany of the following\b|\bany one of\b|\byes if any of\b/i.test(text)) {
    n = 1;
  }
  // Count top-level enumerated options via the existing condition splitter.
  const conds = splitIntoConditions(text);
  const m = conds.length > 1 ? conds.length : null;
  return { n, m };
}

export function validateC12(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const fallbackText = toText(m.fallback_yes_criterion);
    const guidanceText = toText(m.scoringGuidance);

    // The measure is already hardened (conjunctive frame) → no advisory.
    if (hasConjunctiveBundle(fallbackText) || hasConjunctiveBundle(guidanceText)) continue;

    // Prefer to anchor the advisory on the fallback_yes_criterion (the gate the
    // arbiter reads first); fall back to scoringGuidance. One advisory / measure.
    let sourceField: string | null = null;
    let sourceText = "";
    if (hasSoftSelectionGate(fallbackText)) {
      sourceField = "fallback_yes_criterion";
      sourceText = fallbackText;
    } else if (hasSoftSelectionGate(guidanceText)) {
      sourceField = "scoringGuidance";
      sourceText = guidanceText;
    }
    if (!sourceField) continue;

    const { n, m: mCount } = describeSoftGate(sourceText);
    const gateDesc =
      n !== null && mCount !== null
        ? `an M-of-N / OR-list soft gate (any ${n} of ${mCount} conditions)`
        : n === 1
          ? "an OR-list soft gate (any single listed condition triggers Yes)"
          : "an M-of-N / OR-list soft gate";

    violations.push({
      measureId: m.measureId,
      rule: "C12",
      severity: "info",
      message: `${sourceField} uses ${gateDesc}. Where the measurable signal permits, a conjunctive HARD-TOKEN BUNDLE is more flip-resistant: require the co-occurrence, in a SINGLE verbatim quote, of ALL of a small set of hard, quote-verifiable tokens (e.g. a named artefact/function AND a hard qualifier — a quantified target, a verb indicating the artefact is in effect or was adopted/implemented (adopted, implemented, operates, approved, established, in force — ANY tense), a named production indicator, or a proprietary asset tied to an explicit advantage) rather than letting any one soft condition suffice. An M-of-N count near its boundary is itself a run-to-run flip source. Advisory only — dismiss if a bundle would be too strict for this measure.`,
      suggestion: `Rewrite the gate as: "Return Yes ONLY if a single verbatim quote satisfies ALL of the following: (1) it names <the topic artefact/function + topic term>, AND (2) it contains at least one HARD qualifier bound to it — <a number/percentage/date, a verb showing the artefact is in effect or was adopted/implemented (adopted, implemented, operates, approved, established, in force — ANY tense; a dated completed adoption qualifies), a named production indicator, or a proprietary asset + explicit advantage>." If a conjunctive bundle is genuinely too strict, keep an N-of-M fallback but RAISE N and use NAMED hard tokens (avoid low-bar single-token conditions).`,
    });
  }
  // Advisory-only: never blocks. `passed` stays true (no error-severity items).
  return { passed: true, violations };
}

// ─── Set-level diagnostics (definition-of-good dimensions 2, 3, 4) ──────────
//
// These check the SET as a whole, not each measure. They implement the
// DETERMINISTIC half of the reviewer's dimensions 2 (non-overlap), 3
// (numbering continuity) and 4 (empty retrieval guards) — see
// definition-of-good.ts.
//
// CRITICAL: every violation emitted here is `severity: "info"`. `info` is
// advisory only — its resolution is a human/skeleton decision, not a mechanical
// rewrite — so it must NOT feed the repair loop. It is excluded, by
// construction, from the repair trigger (framework-builder-v2.ts checks only
// `severity === "error"`) and from the repairMeasuresTargeted grouping (which
// skips anything not error/warning). This is the whole point of the 316678be
// redesign: new checks reduce or bypass repair, they never add to it. Do NOT
// change these to error/warning.

// Named standards that, when they are the sole shared deciding evidence of two
// measures, indicate effective double-counting (both fire on the same
// disclosure sentence). Detected in addition to the framework's own
// anchorFrameworks names.
const NAMED_STANDARD_PATTERNS: RegExp[] = [
  /\bISO\/IEC\s?\d{3,}(?:[:\-]\d{2,4})?\b/gi,
  /\bISO\s?\d{3,}(?:[:\-]\d{2,4})?\b/gi,
  /\b(?:TCFD|TNFD|ISSB|GRI|SASB|SBTi|SBTN|CDP|GBF|IPBES|NIST(?:\s+AI\s+RMF)?|SOC\s?2|GDPR|CSRD|SFDR)\b/gi,
];

function extractNamedStandards(text: string, anchorNames: string[]): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  for (const re of NAMED_STANDARD_PATTERNS) {
    const matches = text.match(re);
    if (matches) for (const m of matches) found.add(m.replace(/\s+/g, " ").trim().toUpperCase());
  }
  const lc = text.toLowerCase();
  for (const name of anchorNames) {
    const n = name.trim();
    if (n.length >= 3 && lc.includes(n.toLowerCase())) found.add(n.toUpperCase());
  }
  return found;
}

function normaliseQuote(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Issue 7 (advisory): a framework's persisted `displayOrder` values should be
 * GLOBALLY unique, not restarting per category. The save path auto-fixes this
 * with a single monotonic counter; this pure helper is the detector used to
 * assert the invariant (and to flag legacy/imported frameworks that predate the
 * fix). Topic-agnostic — operates on numbers only. Returns the sorted list of
 * duplicated order values (empty ⇒ globally unique).
 */
export function findDuplicateDisplayOrders(orders: Array<number | null | undefined>): number[] {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const o of orders) {
    if (typeof o !== "number") continue;
    if (seen.has(o)) dupes.add(o);
    else seen.add(o);
  }
  return Array.from(dupes).sort((a, b) => a - b);
}

/**
 * Renumber measures' displayOrder to a globally-unique, gap-free 1..N sequence
 * in their given order. Pure; used by the save path's auto-fix and testable in
 * isolation. Returns a new array of assigned orders (input order preserved).
 */
export function renumberDisplayOrdersGlobally(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i + 1);
  return out;
}

/**
 * Deterministic, ADVISORY set-level diagnostics. Emits ONLY `severity: "info"`.
 *   - Overlap: measure pairs whose deciding evidence shares a named standard or
 *     a verbatim anchor quote (positive example) → effective double-counting.
 *   - Numbering continuity: non-contiguous within-category measure numbering.
 *   - Empty retrieval guards: negativeKeywords / antiInferenceRules absent or
 *     empty (primarily fixed at generation; flagged here only if still empty).
 */
export function validateSetLevel(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  const measures = Array.isArray(fw.measures) ? fw.measures : [];
  const anchorNames = (fw.anchorFrameworks || []).map((a) => a?.name || "").filter(Boolean);

  // ── Dimension 2: overlap / effective double-counting ──
  // Build a per-measure signature: named standards in its deciding text, plus
  // normalised positive-example anchor quotes.
  const sigs = measures.map((m) => {
    const decidingText = [
      toText(m.substantive_definition),
      toText(m.whatConstitutesEvidence),
      toText(m.fallback_yes_criterion),
      toText(m.scoringGuidance),
    ].join("\n");
    return {
      measureId: m.measureId,
      standards: extractNamedStandards(decidingText, anchorNames),
      quotes: new Set((m.positive_examples || []).map(normaliseQuote).filter((q) => q.length >= 20)),
    };
  });
  const MAX_OVERLAP_FLAGS = 25; // bound the advisory output
  outer:
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const a = sigs[i];
      const b = sigs[j];
      const sharedStandards = [...a.standards].filter((s) => b.standards.has(s));
      const sharedQuotes = [...a.quotes].filter((q) => b.quotes.has(q));
      if (sharedStandards.length === 0 && sharedQuotes.length === 0) continue;
      const parts: string[] = [];
      if (sharedStandards.length > 0) parts.push(`named standard(s) [${sharedStandards.join(", ")}]`);
      if (sharedQuotes.length > 0) parts.push(`a shared anchor quote`);
      violations.push({
        measureId: a.measureId,
        rule: "overlap",
        severity: "info",
        message: `Possible overlap: ${a.measureId} and ${b.measureId} both rely on ${parts.join(" and ")} as deciding evidence, so they may qualify on the same disclosure sentence (effective double-counting).`,
        suggestion: `Give each measure distinct qualifying evidence, or explicitly accept the correlation and note it in pillar-score interpretation. Advisory only — this does not block drafting.`,
        // Structured payload so the save path can persist this pair into the
        // framework's residualWarnings without re-parsing the message (Issue 7).
        meta: {
          measures: [a.measureId, b.measureId],
          sharedEvidence: [
            ...sharedStandards.map((s) => `standard:${s}`),
            ...(sharedQuotes.length > 0 ? ["anchor-quote"] : []),
          ],
        },
      });
      if (violations.length >= MAX_OVERLAP_FLAGS) break outer;
    }
  }

  // ── Dimension 3: within-category numbering continuity ──
  const byCategory = new Map<string, number[]>();
  for (const m of measures) {
    const match = /^(\d+)\.(\d+)/.exec(String(m.measureId || ""));
    if (!match) continue;
    const cat = match[1];
    const num = Number(match[2]);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(num);
  }
  for (const [cat, nums] of byCategory) {
    const uniq = [...new Set(nums)].sort((x, y) => x - y);
    if (uniq.length < 2) continue;
    const missing: number[] = [];
    for (let n = uniq[0]; n <= uniq[uniq.length - 1]; n++) {
      if (!uniq.includes(n)) missing.push(n);
    }
    if (missing.length > 0) {
      violations.push({
        rule: "numbering",
        severity: "info",
        message: `Category ${cat} has non-contiguous measure numbering: missing ${missing.map((n) => `${cat}.${n}`).join(", ")} (present: ${uniq.map((n) => `${cat}.${n}`).join(", ")}). This can indicate a measure unintentionally dropped during the build.`,
        suggestion: `Confirm the gap is intentional, or renumber so the category's measures are contiguous. Advisory only — this does not block drafting.`,
      });
    }
  }

  // ── Dimension 4: empty retrieval guards ──
  if (!(fw.negativeKeywords && fw.negativeKeywords.length > 0)) {
    violations.push({
      rule: "empty-guards",
      severity: "info",
      message: `negativeKeywords is empty. Negative keywords reduce false-positive retrieval; populating them matters more when adjacency risk is high.`,
      suggestion: `Populate negativeKeywords at intake (the intake schema now generates them). Advisory only — this does not block drafting.`,
    });
  }
  if (!(fw.antiInferenceRules && fw.antiInferenceRules.length > 0)) {
    violations.push({
      rule: "empty-guards",
      severity: "info",
      message: `antiInferenceRules is empty. Anti-inference rules keep scoring disclosure-grounded (no inference from absence); populating them matters more when adjacency risk is high.`,
      suggestion: `Populate antiInferenceRules at intake (the intake schema now generates them). Advisory only — this does not block drafting.`,
    });
  }

  // ── Dimension 5: lexicon hygiene (multi-surface, admission-gated) ──
  // Surfaces every SURVIVING suspect term (flagged-for-review, kept in the lexicon) as
  // one dismissible `info` violation, so drops/flags are visible in structured output
  // rather than console-only. Auto-cleaned debris is not surfaced here (it was removed
  // deterministically). Evidence keywords are checked defensively: MeasureDraft does not
  // declare the field, but frameworks carry per-measure evidenceKeywords at runtime.
  const topicLexicon = [
    fw.topicTerm,
    ...(Array.isArray(fw.topicSynonyms) ? fw.topicSynonyms : []),
    ...(Array.isArray(fw.adjacentTopics) ? fw.adjacentTopics : []),
  ].filter((t): t is string => typeof t === "string" && t.length > 0);

  const hygieneSurfaces: SurfaceInput[] = [
    { surface: "topicSynonyms", terms: fw.topicSynonyms, origin: "llm" },
  ];
  for (const m of measures) {
    const ek = (m as { evidenceKeywords?: unknown }).evidenceKeywords;
    if (Array.isArray(ek) && ek.length > 0) {
      hygieneSurfaces.push({ surface: "evidenceKeywords", terms: ek, origin: "llm" });
    }
  }

  const hygiene = runLexiconHygiene({ surfaces: hygieneSurfaces, topicTokens: topicLexicon });
  // Loop terminator: once an operator has adjudicated a flagged term (kept or removed),
  // it is no longer surfaced here. Without this, non-anchored synonyms re-flag on EVERY
  // pass ("I agree it's noise but it comes back") because the advisory is stateless.
  // The adjudication record (persisted on the framework, carried onto FrameworkDraft) is
  // the state that makes the notice dismissible-for-good. TOPIC-AGNOSTIC: keyed only on
  // the normalized topicTerm + term, never on any specific framework or vocabulary.
  const adjTopicKey = normalizeTopicKey(fw.topicTerm);
  for (const p of hygiene.provenance) {
    if (p.action !== "flagged-for-review") continue;
    if (isAdjudicated(p.term, adjTopicKey, fw.synonymAdjudications)) continue;
    violations.push({
      rule: "lexicon-hygiene",
      severity: "info",
      message: `Suspect retrieval term kept for review on ${p.surface}: "${p.term}" (${p.flagReason}). It was not auto-removed, but it may be filing/notice residue or off-topic — confirm it belongs in the lexicon.`,
      suggestion: `Review this term. If it is boilerplate or off-topic, remove it; otherwise dismiss this notice. Advisory only — this does not block drafting.`,
    });
  }

  // `passed` reflects error-severity only; info never fails validation.
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── Combined validator ───────────────────────────────────────────────────

/**
 * C13 — example ↔ canonical-rule consistency (advisory, non-blocking).
 *
 * For each measure, build the ONE canonical rule (substantive-first precedence,
 * via buildCanonicalRule) and check the measure's OWN supplied examples against
 * it: a stated POSITIVE example that does not clearly pass the canonical rule, or
 * a NEGATIVE example that does, is a contradiction between the examples and the
 * controlling rule (the reviewer's three counterexamples, e.g. 1.1's strategy
 * example failing its own strict fallback).
 *
 * TOPIC-AGNOSTIC and NON-BLOCKING: this never hardcodes a framework/topic and
 * only ever emits `warning`/`info` — it never sets passed=false and never blocks
 * a save. Because turning an example's free text into structured facts is the
 * SEPARATE uncertain step (not done here), C13 does NOT itself pass/fail examples
 * by NLP; it reports the STRUCTURAL risk: (a) rules whose Yes-bar is derived ONLY
 * from a strict fallback (flaggedForReview) while the measure also ships positive
 * examples — exactly the class where a stated positive can be rejected by the
 * controlling rule — and (b) measures that ship examples but resolve to a
 * derived-default bar. Each item is an explicit review item, never a silent pass.
 */
export function validateC13(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const positives = Array.isArray(m.positive_examples) ? m.positive_examples.filter((e) => toText(e).trim()) : [];
    const negatives = Array.isArray(m.negative_examples) ? m.negative_examples.filter((e) => toText(e).trim()) : [];
    if (positives.length === 0 && negatives.length === 0) continue; // nothing to check against

    // Build the canonical rule from the SAME precedence the runtime uses.
    const rule = buildCanonicalRule({
      measureId: m.measureId,
      substantiveDefinition: m.substantive_definition,
      fallbackYesCriterion: m.fallback_yes_criterion,
      scoringGuidance: m.scoringGuidance,
      whatConstitutesEvidence: m.whatConstitutesEvidence,
    });

    if (rule.provenance === "fallback-derived") {
      violations.push({
        measureId: m.measureId,
        rule: "C13",
        severity: "warning",
        message: `The canonical Yes-bar for this measure is derived ONLY from its strict fallback_yes_criterion (no substantive_definition / qualifyingInstance present), yet it ships ${positives.length} positive and ${negatives.length} negative example(s). A strict fallback must NOT silently become the authoritative bar: a stated positive example can be REJECTED by the controlling rule (reviewer §3 — e.g. a named-strategy positive failing a "two attribution tokens" fallback). Review each example against the canonical rule before relying on it.`,
        suggestion: `Add a substantive_definition that states the authoritative Yes-bar, or relax the fallback so the supplied positive examples pass it. Rule identity: ${rule.ruleId} (v${rule.ruleVersion}); resolved from [${rule.sourceField}]. Then re-check example↔rule consistency (candidate example repairs must be reviewed, not auto-applied).`,
      });
    } else if (rule.provenance === "derived-default") {
      violations.push({
        measureId: m.measureId,
        rule: "C13",
        severity: "info",
        message: `This measure ships ${positives.length} positive and ${negatives.length} negative example(s) but has no explicit substantive_definition / qualifyingInstance / fallback_yes_criterion, so the canonical rule fell back to a generic default bar. The examples cannot be checked against a real controlling rule until one is stated.`,
        suggestion: `Add a substantive_definition (preferred) so the examples have an authoritative rule to be consistent with. Rule identity: ${rule.ruleId} (v${rule.ruleVersion}).`,
      });
    }
  }
  // Advisory-only: never blocks. `passed` stays true (no error-severity items).
  return { passed: true, violations };
}

// ─── Definition presence (Issue 1) — fail-loud non-empty guard ─────────────
//
// `definition` is consumed widely as the short/fallback definition (analyzer,
// passage retrieval/rescore, completeness, pipeline snapshot). The drafting
// schema only emits `substantive_definition`, so save derives `definition` from
// it (framework-builder-v2.ts). This validator is the fail-loud backstop: if a
// measure carries NEITHER a `definition` NOR a `substantive_definition`, the
// derivation would persist an empty string silently. That is an error, not an
// advisory — an empty definition degrades every downstream scoring path.
//
// Topic-agnostic: no framework/company/topic-specific logic; it only checks that
// the field the persistence layer relies on is present after derivation.
export function validateDefinitionPresent(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const derived =
      (typeof m.definition === "string" && m.definition.trim()) ||
      (typeof m.substantive_definition === "string" && m.substantive_definition.trim()) ||
      "";
    if (!derived) {
      violations.push({
        measureId: m.measureId,
        rule: "DEF",
        severity: "error",
        message:
          "Measure has no definition: both `definition` and `substantive_definition` are empty. " +
          "`definition` is derived from `substantive_definition` at save, so at least one must be non-empty.",
        suggestion:
          "Author a substantive_definition for this measure (it also backfills the short `definition` used by retrieval/scoring).",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

export function validateAll(fw: FrameworkDraft): ValidationResult {
  const all: Violation[] = [];
  for (const [name, fn] of [
    // DEF — Issue 1: fail-loud guard that every measure has a derivable definition.
    ["DEF", validateDefinitionPresent],
    ["C1", validateC1],
    ["C2", validateC2],
    ["C3", validateC3],
    ["C4", validateC4],
    ["C5", validateC5],
    ["C6", validateC6],
    ["C7", validateC7],
    ["C8", validateC8],
    ["C9", validateC9],
    ["C10", validateC10],
    ["C11", validateC11],
    // C12 — advisory (info only): prefer a conjunctive hard-token bundle over an
    // M-of-N / OR-list soft gate. Never sets passed=false, never blocks.
    ["C12", validateC12],
    // C13 — advisory (warning/info): example ↔ canonical-rule consistency.
    // Flags measures whose supplied examples may contradict the ONE authoritative
    // rule (esp. strict-fallback-derived bars). Never sets passed=false.
    ["C13", validateC13],
    // Set-level advisory diagnostics — emits ONLY `severity: "info"`, which is
    // excluded from the repair trigger and grouping (see validateSetLevel).
    ["set-level", validateSetLevel],
  ] as const) {
    const r = fn(fw);
    all.push(...r.violations);
  }
  return {
    passed: all.filter((v) => v.severity === "error").length === 0,
    violations: all,
  };
}

export function summariseViolations(violations: Violation[]): string {
  if (violations.length === 0) return "All C1–C11 rules pass.";
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const byMeasure = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = v.measureId || "framework-level";
    if (!byMeasure.has(key)) byMeasure.set(key, []);
    byMeasure.get(key)!.push(v);
  }
  const lines: string[] = [
    `Validation ${errors.length === 0 ? "PASSED (with warnings)" : "FAILED"}: ${errors.length} errors, ${warnings.length} warnings.`,
    "",
  ];
  for (const [measureId, vs] of byMeasure) {
    lines.push(`## ${measureId}`);
    for (const v of vs) {
      lines.push(`- [${v.severity.toUpperCase()}][${v.rule}] ${v.message}`);
      if (v.suggestion) lines.push(`  → ${v.suggestion}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Design-issue acceptance gate (ITEM 1) ─────────────────────────────────
//
// The builder must not silently draft/save a framework that carries design
// issues. Every validation violation is transformed into a STRUCTURED,
// machine-readable issue with four decision-supporting parts, so the client can
// render an accept-or-fix gate and the intake facilitator can explain each
// issue in the same shape:
//
//   (a) issue       — what is wrong, and where (measure/field)
//   (b) reason      — WHY it harms run-to-run robustness
//   (c) solution    — the concrete countable/N-of-M rewrite to apply
//   (d) implication — what happens if it is NOT changed
//
// `id` is stable per (ruleCode, measureId, field) so the client can pass the
// SAME id back in acceptedIssueIds once the user has explicitly accepted it.

export interface StructuredIssue {
  id: string;
  ruleCode: string;              // "C1".."C11", "evidence-keyword-distinctiveness", "internal"
  severity: "error" | "warning" | "info";
  measureId: string;             // "framework-level" when the violation is not measure-scoped
  field: string;                 // best-effort source field the issue concerns
  issue: string;                 // (a) what is wrong
  reason: string;                // (b) why it harms robustness
  solution: string;              // (c) concrete fix
  implication: string;           // (d) cost of not changing
}

// Per-rule metadata used to derive the four-part explanation. `field` is the
// primary framework field a rule inspects; `reason`/`implication` explain the
// robustness cost in decision-oriented language. Rules not listed fall back to
// a generic robustness rationale.
const RULE_ISSUE_META: Record<
  string,
  { field: string; reason: string; implication: string }
> = {
  DEF: {
    field: "definition / substantive_definition",
    reason:
      "The measure has no definition at all — the field every downstream scoring path falls back to is empty, so retrieval and scoring have nothing to anchor on.",
    implication: "The measure scores on title alone, producing arbitrary and unstable verdicts across runs.",
  },
  C1: {
    field: "title / c1_achievement_guidance",
    reason:
      "The measure tests an outcome rather than a disclosed position, so whether an achievement claim 'counts' is a judgment call — two scoring models split on it.",
    implication: "Verdicts flip run-to-run between reviewers who read the achievement claim differently.",
  },
  C2: {
    field: "whatDoesNotConstituteEvidence",
    reason:
      "A tense/forward-looking exclusion rejects valid evidence on a non-substantive ground, which different runs apply inconsistently.",
    implication: "Legitimate disclosures are dropped unpredictably, lowering recall and destabilising the verdict.",
  },
  C3: {
    field: "scoringGuidance / min_quote_context_chars",
    reason:
      "Without a minimum quote-context requirement, models accept truncated snippets whose meaning is ambiguous.",
    implication: "The same disclosure is read as Yes by one run and No by another depending on how much context it quoted.",
  },
  C4: {
    field: "fallback_yes_criterion",
    reason:
      "Fallback conditions are not a numbered OR-list of ≥3 countable, topic-anchored conditions, so what triggers a Yes is under-specified.",
    implication: "Borderline companies flip Yes/No between runs because the trigger set is not decidable from the quote.",
  },
  C5: {
    field: "substantive_definition",
    reason:
      "Missing adjacent-topic exclusion lets evidence from a neighbouring topic satisfy this measure when vocabulary overlaps.",
    implication: "Adjacent-topic disclosures are counted inconsistently, inflating and destabilising the Yes rate.",
  },
  C6: {
    field: "positive_examples / negative_examples",
    reason:
      "Too few positive or adversarial-negative examples leaves the boundary between Yes and No unanchored for the scorer.",
    implication: "Runs disagree on borderline cases because they have no shared calibration examples to anchor the decision.",
  },
  C7: {
    field: "title / coverage_whitelist",
    reason:
      "A coverage measure without an explicit threshold and whitelist phrases forces the scorer to judge 'how much coverage is enough'.",
    implication: "Partial-coverage companies flip run-to-run on the unstated threshold.",
  },
  C8: {
    field: "substantive_definition",
    reason:
      "Without the vehicle-agnostic clause, the scorer may reject valid evidence for appearing in an unexpected document type.",
    implication: "The same disclosure counts or not depending on which vehicle a run happened to weight.",
  },
  C9: {
    field: "expected_yes_rate",
    reason:
      "A missing or implausible expected_yes_rate removes the sanity check that catches a measure firing far too often or too rarely.",
    implication: "Calibration drift goes undetected, so a mis-scoped measure keeps producing unstable verdicts.",
  },
  C10: {
    field: "topicTerm / topicSynonyms",
    reason:
      "Topic term and synonyms are not fully registered, so retrieval misses evidence phrased with unregistered terms.",
    implication: "Which evidence surfaces depends on run-to-run retrieval variance, changing the verdict.",
  },
  C11: {
    field: "fallback_yes_criterion / scoringGuidance / substantive_definition",
    reason:
      "A degree word (e.g. 'substantive', 'integrated') is the deciding test but is not decidable from a verbatim quote — two scoring models read the same anchor sentence and split on whether it clears the bar.",
    implication: "This is the direct cause of run-to-run verdict flips; the measure's score is not reproducible.",
  },
  C12: {
    field: "fallback_yes_criterion / scoringGuidance",
    reason:
      "The deciding gate is an M-of-N / OR-list soft gate (any one of several conditions triggers Yes), so a disclosure sitting near the count boundary depends on which soft conditions a run happens to credit — a conjunctive hard-token bundle (require ALL of a small set of quote-verifiable tokens) removes that boundary.",
    implication: "Borderline companies flip Yes/No run-to-run on the M-of-N count. Advisory — tighten to a hard-token bundle where the signal permits, or dismiss if a bundle would be too strict.",
  },
  "evidence-keyword-distinctiveness": {
    field: "evidenceKeywords",
    reason:
      "The measure's evidence keywords collapse to the topic lexicon, so BM25 cannot distinguish THIS measure from the topic in general.",
    implication: "Retrieval pulls generic topic passages, so the evidence set — and the verdict — shifts between runs.",
  },
  internal: {
    field: "(validator)",
    reason: "The validator could not complete, so robustness cannot be confirmed.",
    implication: "The framework may carry undetected design issues that flip verdicts run-to-run.",
  },
  // Set-level advisory diagnostics (info-severity; never block, never repair).
  overlap: {
    field: "substantive_definition / positive_examples / anchorFrameworks",
    reason:
      "Two measures rely on the same named standard or the same anchor quote as their deciding evidence, so both can fire on the same disclosure sentence (effective double-counting).",
    implication:
      "Boilerplate-rich reporters inflate relative to substantive-but-differently-worded ones; pillar scores over-weight the shared sentence. Advisory — resolution is a design choice.",
  },
  numbering: {
    field: "measureId",
    reason:
      "Within-category measure numbering is non-contiguous, which can indicate a measure was unintentionally dropped during the build.",
    implication:
      "A silently missing measure leaves a coverage gap. Advisory — confirm the gap is intentional or renumber.",
  },
  "empty-guards": {
    field: "negativeKeywords / antiInferenceRules",
    reason:
      "Empty negative-keywords / anti-inference rules leave retrieval unguarded against adjacent-topic false positives; this matters more when adjacency risk is high.",
    implication:
      "Adjacent-topic passages are retrieved and scored, inflating and destabilising the Yes rate. Advisory — populate at intake.",
  },
};

const GENERIC_ISSUE_META = {
  field: "(measure)",
  reason: "This design issue leaves a scoring decision under-specified.",
  implication: "Under-specified decisions are resolved differently across runs, producing verdict flips.",
};

function slugForIssueId(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

/**
 * Transform raw validation violations into the structured, four-part issue
 * shape the acceptance gate and the intake facilitator both consume.
 * `message` becomes the issue text; `suggestion` becomes the solution (the C11
 * countable-rewrite text is reused verbatim); reason/implication/field are
 * derived from the rule code.
 */
export function toStructuredIssues(violations: Violation[]): StructuredIssue[] {
  return violations.map((v, idx) => {
    const meta = RULE_ISSUE_META[v.rule] || GENERIC_ISSUE_META;
    const measureId = v.measureId || "framework-level";
    const id = `${slugForIssueId(v.rule)}__${slugForIssueId(measureId)}__${idx}`;
    return {
      id,
      ruleCode: v.rule,
      severity: v.severity,
      measureId,
      field: meta.field,
      issue: v.message,
      reason: meta.reason,
      solution:
        v.suggestion ||
        "Rewrite the deciding test so it is verifiable true/false from a single verbatim quote (a named body, document, dated/quantified metric, or explicit N-of-M list of named artefacts).",
      implication: meta.implication,
    };
  });
}

/**
 * Human-readable rendering of the structured issues, in the same four-part
 * format the facilitator uses in chat. Errors first, then warnings.
 */
export function renderStructuredIssues(issues: StructuredIssue[]): string {
  if (issues.length === 0) return "No outstanding design issues — all C1–C11 rules pass.";
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  const lines: string[] = [
    `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${infos > 0 ? `, ${infos} info` : ""} must be reviewed before drafting/saving.`,
    "",
  ];
  for (const i of sorted) {
    lines.push(`### [${i.severity.toUpperCase()}][${i.ruleCode}] ${i.measureId} — ${i.field}  (id: ${i.id})`);
    lines.push(`- **Issue:** ${i.issue}`);
    lines.push(`- **Reason:** ${i.reason}`);
    lines.push(`- **Proposed solution:** ${i.solution}`);
    lines.push(`- **Implication of not changing:** ${i.implication}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Acceptance-gate decision for the SAVE/DRAFT path.
 *
 * - error-severity issues BLOCK unless the client has explicitly accepted each
 *   one (its id present in acceptedIssueIds) or passed proceedWithWarnings for
 *   the whole set.
 * - warning-severity issues never block; they are surfaced but pass through.
 *
 * Returns the outstanding (unaccepted error) issues so the caller can 400 with
 * an actionable payload.
 */
export function evaluateAcceptanceGate(
  issues: StructuredIssue[],
  opts: { acceptedIssueIds?: string[]; proceedWithWarnings?: boolean },
): { allowed: boolean; blockingIssues: StructuredIssue[]; acceptedCount: number } {
  const accepted = new Set(opts.acceptedIssueIds || []);
  const errors = issues.filter((i) => i.severity === "error");
  // proceedWithWarnings accepts the ENTIRE current issue set at once (the user
  // explicitly chose proceed-with-warnings after reviewing them).
  const blockingIssues = opts.proceedWithWarnings
    ? []
    : errors.filter((i) => !accepted.has(i.id));
  const acceptedCount = errors.filter((i) => accepted.has(i.id)).length + (opts.proceedWithWarnings ? errors.length : 0);
  return { allowed: blockingIssues.length === 0, blockingIssues, acceptedCount };
}
