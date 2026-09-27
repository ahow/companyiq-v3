/**
 * Canonical config resolver (Workstream 3).
 *
 * `resolveConfig` folds a framework (a persisted row, an export copy, an import
 * payload, or an in-memory draft) plus its measures into the ONE canonical
 * `ResolvedConfig` defined in schemas.ts. The runtime and BOTH export surfaces
 * (canonical JSON, seed template, full-detail markdown) derive from this single
 * object, so they can never silently disagree about anchors, scope, or the
 * retrieval lexicon.
 *
 * This module is deliberately topic-, company-, and framework-agnostic: it moves
 * whatever any framework happens to carry. It is a pure function over plain
 * objects (no DB, no LLM) so it is fully unit-testable.
 *
 * Design authority: docs/builder-reliability/SCHEMAS.md §1.
 */

import {
  type AnchorFramework,
  type ResolvedConfig,
  type ResolvedMeasure,
  RESOLVED_CONFIG_VERSION,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ResolveConfigInput {
  /** The framework-shaped object (persisted row / export copy / import payload). */
  framework: Record<string, any>;
  /** The framework's measures, if held separately from the framework object. */
  measures?: Record<string, any>[];
}

/**
 * DB-surrogate / volatile identifiers that are NOT part of the operational
 * content and must be excluded from a resolved measure (and therefore from any
 * content hash taken over it). Stable LOGICAL ids like `measureId` are kept.
 */
export const VOLATILE_ID_FIELDS: readonly string[] = [
  "id",
  "frameworkId",
  "framework_id",
];

/**
 * The stable, logical identifier fields that the schema and the export/import
 * round-trip rely on. These are ALWAYS preserved.
 */
export const STABLE_ID_FIELDS: readonly string[] = ["measureId", "measure_id"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function normSource(v: unknown): string | null {
  return isNonEmptyString(v) ? v.trim() : null;
}

/** Coerce a value to a string[] surface, preserving order; non-strings dropped. */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** First non-empty string[] surface across a list of candidate values. */
function firstNonEmptyStringArray(...vals: unknown[]): string[] {
  for (const v of vals) {
    const arr = asStringArray(v);
    if (arr.length > 0) return arr;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Anchor frameworks — parse-then-coerce (no double-wrapping)
// ---------------------------------------------------------------------------

/**
 * Turn a single raw anchor entry into a typed `AnchorFramework`, or `null` when
 * it carries no usable name.
 *
 * The critical rule (see the verified defect): a root `anchorFrameworks` array
 * can contain a mix of
 *   - genuinely plain labels ("SASB", "TCFD", "GRI Standards"), and
 *   - JSON-ENCODED object strings ('{"name":"EU AI Act","source":"..."}').
 *
 * So for a string entry we PARSE FIRST: if it parses to an object carrying a
 * `name`, we use that object's fields (this is the already-structured anchor,
 * NOT a plain label — coercing it into `{name: <the whole json string>}` would
 * double-wrap it). Only when JSON.parse fails, or yields a non-object, do we
 * treat the bare string as a plain label and coerce it into `{name: <string>}`.
 *
 * An entry that is ALREADY an object (the nested typed anchor dict shape) is used
 * directly.
 */
export function coerceAnchorEntry(entry: unknown): AnchorFramework | null {
  if (entry === null || entry === undefined) return null;

  // Already a typed anchor dict — use directly (do not re-encode).
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const name = (entry as any).name;
    if (isNonEmptyString(name)) {
      return { name: name.trim(), source: normSource((entry as any).source) };
    }
    return null;
  }

  if (typeof entry === "string") {
    const s = entry.trim();
    if (!s) return null;
    // Parse-then-coerce: only a JSON object with a name is a structured anchor.
    try {
      const parsed = JSON.parse(s);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        isNonEmptyString((parsed as any).name)
      ) {
        return {
          name: (parsed as any).name.trim(),
          source: normSource((parsed as any).source),
        };
      }
      // Parsed to a non-object (number/bool/array/plain string): the ORIGINAL
      // string is a genuine plain label — coerce it, do NOT unwrap to `parsed`.
      return { name: s, source: null };
    } catch {
      // JSON.parse failed: a genuinely plain label ("SASB", "TCFD", ...).
      return { name: s, source: null };
    }
  }

  return null;
}

/**
 * Resolve the full anchor list: parse-then-coerce every root entry, merge with
 * the nested typed anchor dicts (from the intake artefact), and dedupe by name
 * (case-insensitive). First occurrence wins for ORDER; a later occurrence that
 * carries a non-null `source` upgrades an earlier null source.
 */
export function resolveAnchorFrameworks(
  framework: Record<string, any>,
): AnchorFramework[] {
  const rootRaw = Array.isArray(framework?.anchorFrameworks)
    ? framework.anchorFrameworks
    : [];
  const intake =
    framework?.intakeArtefact && typeof framework.intakeArtefact === "object"
      ? framework.intakeArtefact
      : null;
  const nestedRaw = Array.isArray(intake?.anchorFrameworks)
    ? intake.anchorFrameworks
    : [];

  // Root first (defines order), then the nested typed dicts (fill gaps / sources).
  const merged: AnchorFramework[] = [];
  const byKey = new Map<string, AnchorFramework>();

  for (const raw of [...rootRaw, ...nestedRaw]) {
    const anchor = coerceAnchorEntry(raw);
    if (!anchor) continue;
    const key = anchor.name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, anchor);
      merged.push(anchor);
    } else if (existing.source === null && anchor.source !== null) {
      // Upgrade a previously-sourceless anchor without changing its position.
      existing.source = anchor.source;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Scope fields — carry to root with precedence
// ---------------------------------------------------------------------------

/**
 * Resolve one scope field to the root, per the SCHEMAS.md authority rule:
 * the root value wins; when it is null/absent, derive it from the nested
 * measures; failing that, from the (audit-only) intake artefact. Returns a
 * trimmed string or null.
 */
export function resolveScopeField(
  field: string,
  framework: Record<string, any>,
  measures: Record<string, any>[],
  intake: Record<string, any> | null,
): string | null {
  const root = framework?.[field];
  if (isNonEmptyString(root)) return root.trim();

  for (const m of measures) {
    if (isNonEmptyString(m?.[field])) return (m[field] as string).trim();
  }

  if (intake && isNonEmptyString(intake[field])) return intake[field].trim();

  return null;
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/**
 * Resolve a single measure: carry EVERY field through (structurally open), strip
 * only the volatile DB-surrogate ids, and normalise the decision-relevant named
 * surfaces. Stable logical ids (`measureId`) are preserved.
 */
export function resolveMeasure(m: Record<string, any>): ResolvedMeasure {
  const out: Record<string, any> = { ...(m ?? {}) };
  for (const vid of VOLATILE_ID_FIELDS) delete out[vid];

  const measureId =
    (isNonEmptyString(m?.measureId) && m.measureId) ||
    (isNonEmptyString(m?.measure_id) && m.measure_id) ||
    "";
  out.measureId = measureId;

  // Normalise the named decision surfaces (accept camelCase or snake_case input).
  const substantive = m?.substantiveDefinition ?? m?.substantive_definition;
  if (substantive !== undefined) out.substantive_definition = substantive;
  const fallback = m?.fallbackYesCriterion ?? m?.fallback_yes_criterion;
  if (fallback !== undefined) out.fallback_yes_criterion = fallback;
  const evidence = m?.whatConstitutesEvidence ?? m?.what_constitutes_evidence;
  if (evidence !== undefined) out.whatConstitutesEvidence = evidence;
  const guidance = m?.scoringGuidance ?? m?.scoring_guidance;
  if (guidance !== undefined) out.scoringGuidance = guidance;

  // Per-measure evidence keywords: a DISTINCT lexicon surface, kept as-is.
  out.evidenceKeywords = asStringArray(
    m?.evidenceKeywords ?? m?.evidence_keywords,
  );

  return out as ResolvedMeasure;
}

// ---------------------------------------------------------------------------
// resolveConfig — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Fold a framework + measures into the canonical `ResolvedConfig`.
 *
 * - anchors: parse-then-coerce + merge/dedupe (see resolveAnchorFrameworks).
 * - scope: entityType/sectorScope/universe/reportingPeriod carried to root with
 *   precedence root > measures > intake.
 * - lexicon: the four surfaces (topicSynonyms / evidenceKeywords /
 *   documentFilingHints / retrievalQueryTerms) are kept DISTINCT, never merged.
 * - measures: sorted by displayOrder, volatile ids stripped, measureId kept.
 * - intakeArtefact: retained verbatim for audit ONLY.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const framework = input?.framework ?? {};
  // Measures may be passed separately or ride on the framework object.
  const rawMeasures: Record<string, any>[] = Array.isArray(input?.measures)
    ? input.measures
    : Array.isArray((framework as any).measures)
      ? (framework as any).measures
      : [];

  const intake =
    framework.intakeArtefact && typeof framework.intakeArtefact === "object"
      ? (framework.intakeArtefact as Record<string, any>)
      : null;

  const measures = [...rawMeasures]
    .map((m, idx) => ({ idx, order: Number(m?.displayOrder ?? idx), m }))
    .sort((a, b) => a.order - b.order || a.idx - b.idx)
    .map((e) => resolveMeasure(e.m));

  const frameworkName =
    (isNonEmptyString(framework.name) && framework.name.trim()) ||
    (isNonEmptyString(framework.title) && framework.title.trim()) ||
    "";
  const topicTerm =
    (isNonEmptyString(framework.topicTerm) && framework.topicTerm.trim()) ||
    (isNonEmptyString(framework.topicName) && framework.topicName.trim()) ||
    (intake && isNonEmptyString(intake.topicTerm) && intake.topicTerm.trim()) ||
    "";

  return {
    frameworkName,
    topicTerm,

    entityType: resolveScopeField("entityType", framework, measures, intake),
    sectorScope: resolveScopeField("sectorScope", framework, measures, intake),
    universe: resolveScopeField("universe", framework, measures, intake),
    reportingPeriod: resolveScopeField(
      "reportingPeriod",
      framework,
      measures,
      intake,
    ),

    // Distinct lexicon surfaces — never collapsed into one bag.
    topicSynonyms: firstNonEmptyStringArray(
      framework.topicSynonyms,
      intake?.topicSynonyms,
    ),
    evidenceKeywords: asStringArray(framework.evidenceKeywords),
    documentFilingHints: firstNonEmptyStringArray(
      framework.documentFilingHints,
      framework.requiredDocTypes,
      framework.authoritativeFilingTypes,
    ),
    retrievalQueryTerms: firstNonEmptyStringArray(
      framework.retrievalQueryTerms,
      intake?.retrievalQueryTerms,
    ),

    negativeKeywords: firstNonEmptyStringArray(
      framework.negativeKeywords,
      intake?.negativeKeywords,
    ),
    antiInferenceRules: firstNonEmptyStringArray(
      framework.antiInferenceRules,
      intake?.antiInferenceRules,
    ),

    anchorFrameworks: resolveAnchorFrameworks(framework),
    measures,

    intakeArtefact: framework.intakeArtefact ?? null,
    resolvedConfigVersion: RESOLVED_CONFIG_VERSION,
  };
}
