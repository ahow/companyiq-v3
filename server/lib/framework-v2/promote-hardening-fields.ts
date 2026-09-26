/**
 * promote-hardening-fields.ts
 *
 * WHY: a framework's "hardening" configuration — the anti-inference rules and the
 * negative keywords the scorer actually reads — is produced during intake and
 * stored inside the `intakeArtefact` blob. It is ALSO meant to live in the
 * top-level `antiInferenceRules` / `negativeKeywords` columns, because that is
 * where the runtime scorer looks (`framework.antiInferenceRules`,
 * `framework.negativeKeywords`). On several persist paths the intake values were
 * never copied up, so the top-level columns landed NULL even though the intake
 * artefact was fully populated (observed on fw12: intake had 6 anti-inference
 * rules + 15 negative keywords, top-level columns were both null). A framework
 * scored with null top-level columns silently loses its hardening.
 *
 * WHAT: a single, idempotent, NON-DESTRUCTIVE helper that promotes the camelCase
 * hardening fields from the intake artefact (or an explicit source) into the
 * framework's top-level fields — but ONLY when the top-level field is empty. It
 * NEVER overwrites a populated top-level value, so a deliberately-edited
 * framework is untouched, and re-running it is a no-op.
 *
 * This is deliberately topic-agnostic: it moves whatever the intake produced for
 * ANY framework; it neither knows nor cares what the topic is.
 *
 * Pure function over plain objects (returns a shallow copy — never mutates its
 * input) so it is safe to call on every create/update/import/export path and is
 * unit-testable without a database.
 */

/** The top-level framework fields the runtime scorer reads for hardening, paired
 * with the intake-artefact field they are promoted from. Both sides are the
 * camelCase names used throughout the TS layer (the snake_case column names are a
 * Drizzle mapping detail and never appear on the in-memory objects). */
export const HARDENING_FIELDS = ["negativeKeywords", "antiInferenceRules"] as const;
export type HardeningField = (typeof HARDENING_FIELDS)[number];

export interface PromoteHardeningResult<T> {
  /** A shallow copy of the framework with any promotions applied. Input never mutated. */
  framework: T;
  /** True when at least one field was promoted. */
  changed: boolean;
  /** The field names that were promoted (empty when nothing changed). */
  promoted: HardeningField[];
  /** Human-readable notes (what was promoted / why a field was skipped). */
  notes: string[];
}

/** A non-empty array is the only shape that counts as "populated" for these
 * jsonb array columns. Anything else (null, undefined, [], non-array) is treated
 * as empty and therefore eligible to receive a promoted value. */
function isNonEmptyArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Promote the hardening fields from `intake` (or, when omitted,
 * `framework.intakeArtefact`) into the framework's top-level fields.
 *
 * For each hardening field:
 *   - promote the source value ONLY when the top-level field is empty AND the
 *     source has a non-empty array — never overwrite a populated top-level value;
 *   - otherwise leave the top-level field exactly as-is.
 *
 * Idempotent: once promoted, a second call sees a populated top-level field and
 * does nothing. Non-destructive and side-effect-free.
 *
 * @param framework the framework-shaped object (InsertFramework / persisted row /
 *   export copy). Read for existing top-level values and for `intakeArtefact`.
 * @param intake optional explicit intake artefact. When provided it takes
 *   precedence over `framework.intakeArtefact` as the promotion source.
 */
export function promoteHardeningFields<T extends Record<string, any>>(
  framework: T,
  intake?: Record<string, any> | null,
): PromoteHardeningResult<T> {
  const notes: string[] = [];
  const promoted: HardeningField[] = [];

  if (!framework || typeof framework !== "object") {
    return { framework, changed: false, promoted, notes: ["no framework object — skipped"] };
  }

  const source: Record<string, any> | null =
    (intake && typeof intake === "object" ? intake : null) ??
    (framework.intakeArtefact && typeof framework.intakeArtefact === "object" ? framework.intakeArtefact : null);

  // Work on a shallow copy so the caller's object is never mutated.
  const out: T = { ...framework };

  if (!source) {
    notes.push("no intake artefact available as promotion source — nothing promoted");
    return { framework: out, changed: false, promoted, notes };
  }

  for (const field of HARDENING_FIELDS) {
    const current = (out as Record<string, any>)[field];
    const incoming = source[field];
    if (isNonEmptyArray(current)) {
      notes.push(`${field}: top-level already populated (${current.length}) — left unchanged`);
      continue;
    }
    if (!isNonEmptyArray(incoming)) {
      notes.push(`${field}: no non-empty value in intake — nothing to promote`);
      continue;
    }
    (out as Record<string, any>)[field] = incoming;
    promoted.push(field);
    notes.push(`${field}: promoted ${incoming.length} value(s) from intake`);
  }

  return { framework: out, changed: promoted.length > 0, promoted, notes };
}
