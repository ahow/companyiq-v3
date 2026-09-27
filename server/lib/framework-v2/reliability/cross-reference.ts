/**
 * Workstream 2 — cross-reference integrity.
 *
 * A warning (or any finding) that references a measure must be stored as a
 * StructuredReference `{ measureId, contentHash }`, NOT as free text, so that when the
 * referenced measure's decision-relevant content changes we can detect the reference is
 * stale instead of silently continuing to show a finding about content that no longer
 * says what it used to.
 *
 * On validation/export we recompute the hashes:
 *   - content changed  -> mark the reference/warning `superseded` (never silently drop),
 *                          and regenerate against the current measure where cheap;
 *   - measureId gone   -> surface a loud (dismissible) mismatch;
 *   - unchanged        -> `current`.
 * In every case the old finding + its disposition are preserved in an audit trail — we
 * never delete history.
 *
 * Overlap diagnostics are regenerated from CURRENT measures every run (not persisted as
 * stale prose). NOTE: recomputing overlap does NOT define the score-contribution of
 * overlapping measures — that is a scoring-policy decision tracked as OI-5 in
 * docs/builder-reliability/OPEN-ISSUES-REGISTER.md.
 */

import { createHash } from "node:crypto";
import type { FrameworkDraft, MeasureDraft, Violation } from "../rules.js";
import { validateSetLevel } from "../rules.js";
import type { StructuredReference } from "./schemas.js";

/** Version of the hashing scheme; bump if the field set / normalisation changes. */
export const MEASURE_CONTENT_HASH_VERSION = 1;

/**
 * The decision-relevant fields of a measure. These are the fields whose change should
 * invalidate a reference — i.e. the content a finding actually depends on. Title is
 * included because a finding often quotes/names the measure by title.
 */
const DECISION_RELEVANT_FIELDS = [
  "title",
  "substantive_definition",
  "whatConstitutesEvidence",
  "fallback_yes_criterion",
  "scoringGuidance",
] as const;

function normaliseField(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Compute a stable content hash over a measure's decision-relevant fields. Stable means:
 * insensitive to surrounding whitespace and case, and independent of field ordering
 * (fields are hashed in a fixed order with explicit separators so two different field
 * values cannot collide by concatenation).
 */
export function computeMeasureContentHash(measure: Partial<MeasureDraft> | Record<string, unknown>): string {
  const h = createHash("sha256");
  h.update(`v${MEASURE_CONTENT_HASH_VERSION}`);
  for (const field of DECISION_RELEVANT_FIELDS) {
    h.update("\x1f"); // unit separator between fields
    h.update(field);
    h.update("\x1e"); // record separator between key and value
    h.update(normaliseField((measure as Record<string, unknown>)[field]));
  }
  return h.digest("hex");
}

/** Build a StructuredReference pointing at a measure's current content. */
export function buildStructuredReference(
  measure: Partial<MeasureDraft> | Record<string, unknown>,
  ruleVersion?: number,
): StructuredReference {
  const measureId = String((measure as Record<string, unknown>).measureId ?? "");
  return {
    measureId,
    contentHash: computeMeasureContentHash(measure),
    ...(ruleVersion != null ? { ruleVersion } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReferenceStatus = "current" | "superseded" | "measure-missing";

export interface ReconciledReference {
  reference: StructuredReference;
  status: ReferenceStatus;
  /** The measure's current hash, or null when the measure no longer exists. */
  currentHash: string | null;
  /** Whether a measure with this id currently exists. */
  measureExists: boolean;
}

function indexMeasures(
  measures: Array<Partial<MeasureDraft> | Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const m of measures) {
    const id = String((m as Record<string, unknown>).measureId ?? "");
    if (id) map.set(id, m as Record<string, unknown>);
  }
  return map;
}

/**
 * Reconcile a set of references against the current measures. Never drops a reference:
 * a stale one becomes `superseded`, a dangling one becomes `measure-missing`. Both
 * remain in the returned list so callers can preserve an audit trail.
 */
export function reconcileReferences(
  references: StructuredReference[],
  measures: Array<Partial<MeasureDraft> | Record<string, unknown>>,
): ReconciledReference[] {
  const index = indexMeasures(measures);
  return references.map((reference) => {
    const measure = index.get(reference.measureId);
    if (!measure) {
      return { reference, status: "measure-missing", currentHash: null, measureExists: false };
    }
    const currentHash = computeMeasureContentHash(measure);
    const status: ReferenceStatus = currentHash === reference.contentHash ? "current" : "superseded";
    return { reference, status, currentHash, measureExists: true };
  });
}

// ---------------------------------------------------------------------------
// Warning reconciliation (warnings carry a StructuredReference + audit trail)
// ---------------------------------------------------------------------------

/** A stored warning that references a measure via a StructuredReference. */
export interface ReferencedWarning {
  id: string;
  reference: StructuredReference;
  /** The original warning payload (message, severity, etc.) — preserved verbatim. */
  warning: Violation;
  /** Operator disposition recorded against the warning; carried through, not mutated. */
  disposition?: { dismissedByOperator: boolean; note?: string };
}

export interface ReconciledWarning extends ReferencedWarning {
  status: ReferenceStatus;
  currentHash: string | null;
  measureExists: boolean;
  /** A fresh reference regenerated against current content (cheap: id + new hash). */
  regeneratedReference: StructuredReference | null;
}

/**
 * Reconcile stored warnings against current measures. Superseded/missing warnings are
 * NOT dropped — they are returned with an updated status and (for superseded) a
 * regenerated reference, preserving the original warning + disposition as an audit trail.
 */
export function reconcileWarnings(
  warnings: ReferencedWarning[],
  measures: Array<Partial<MeasureDraft> | Record<string, unknown>>,
): ReconciledWarning[] {
  const index = indexMeasures(measures);
  return warnings.map((w) => {
    const measure = index.get(w.reference.measureId);
    if (!measure) {
      return { ...w, status: "measure-missing", currentHash: null, measureExists: false, regeneratedReference: null };
    }
    const currentHash = computeMeasureContentHash(measure);
    if (currentHash === w.reference.contentHash) {
      return { ...w, status: "current", currentHash, measureExists: true, regeneratedReference: null };
    }
    return {
      ...w,
      status: "superseded",
      currentHash,
      measureExists: true,
      regeneratedReference: buildStructuredReference(measure, w.reference.ruleVersion),
    };
  });
}

// ---------------------------------------------------------------------------
// Overlap diagnostics — regenerated from CURRENT measures every run
// ---------------------------------------------------------------------------

/**
 * Recompute overlap diagnostics from the CURRENT framework measures, rather than
 * reading persisted (possibly stale) overlap prose. This reuses validateSetLevel's
 * overlap dimension as the single source of the overlap heuristic, filtering to the
 * `overlap` rule only.
 *
 * IMPORTANT: recomputing overlap here tells you which measures MAY double-count the same
 * disclosure sentence. It deliberately does NOT decide how overlapping measures should
 * share score contribution — that is a scoring-policy question tracked as OI-5 in the
 * open-issues register, not something this function establishes.
 */
export function regenerateOverlapDiagnostics(fw: FrameworkDraft): Violation[] {
  return validateSetLevel(fw).violations.filter((v) => v.rule === "overlap");
}
