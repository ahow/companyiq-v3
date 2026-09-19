/**
 * Pure prune-merge helper for targeted measure repair.
 *
 * Extracted into its own module (no express/DB imports) so it can be unit-tested
 * directly. Consumed by repairMeasuresTargeted in server/routes/framework-builder-v2.ts
 * at the splice site that rebuilds categories/measures after an LLM repair pass.
 */

/**
 * Core measure fields whose loss turns a complete measure into a validation-
 * failing stub. Used by the completeness-regression guard in mergeCorrectedMeasure.
 */
export const CORE_MEASURE_FIELDS = [
  "c1_achievement_guidance",
  "fallback_yes_criterion",
  "positive_examples",
  "negative_examples",
  "expected_yes_rate",
  "min_quote_context_chars",
  "title",
  "definition",
  "substantive_definition",
  "scoringGuidance",
  "whatConstitutesEvidence",
  "whatDoesNotConstituteEvidence",
] as const;

/** A value counts as populated if it is non-null, non-empty-string, non-empty-array. */
export function isPopulatedFieldValue(v: any): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * PRUNE-MERGE a model-returned "corrected" measure onto the ORIGINAL measure.
 *
 * Root cause this fixes: the repair prompt asks the model to "Rewrite ONLY the
 * fields that trigger these violations; leave every other field unchanged", so
 * models routinely echo back only a couple of fields (a partial measure). The
 * previous splice did `{ ...corrected, measureId }`, which REPLACED the whole
 * measure — silently discarding every field the model omitted and turning a
 * complete measure into a stub (observed: 34 complete measures -> 21 stubs ->
 * 142 validation errors after a refine pass).
 *
 * This overlays ONLY the corrected fields that carry a real value, so a
 * correction can add or improve fields but never delete one the model omitted
 * or blanked. A defensive completeness-regression guard then keeps the ORIGINAL
 * measure if the merge would somehow reduce the number of populated core fields.
 *
 * Pure and side-effect free so it can be unit-tested directly.
 */
export function mergeCorrectedMeasure(
  original: any,
  corrected: any,
): { merged: any; fieldsPreserved: number; regressionPrevented: boolean } {
  const orig = original || {};
  const corr = corrected || {};

  // Build an overlay of ONLY the corrected fields that carry a real value.
  const overlay: any = {};
  for (const [k, v] of Object.entries(corr)) {
    if (isPopulatedFieldValue(v)) overlay[k] = v;
  }

  // Count original fields that survive because the overlay omitted/blanked them
  // (i.e. the original had a populated value and the overlay does not replace it).
  let fieldsPreserved = 0;
  for (const [k, v] of Object.entries(orig)) {
    if (isPopulatedFieldValue(v) && !(k in overlay)) fieldsPreserved++;
  }

  const merged = { ...orig, ...overlay, measureId: orig.measureId };

  // Defensive completeness-regression guard: never let a repair reduce the
  // number of populated core fields. With the prune-merge above this should
  // essentially never trigger, but it is a safety net against pathological input.
  const countCore = (obj: any) =>
    CORE_MEASURE_FIELDS.reduce((n, f) => n + (isPopulatedFieldValue(obj?.[f]) ? 1 : 0), 0);
  const origCore = countCore(orig);
  const mergedCore = countCore(merged);
  if (mergedCore < origCore) {
    return { merged: orig, fieldsPreserved, regressionPrevented: true };
  }

  return { merged, fieldsPreserved, regressionPrevented: false };
}
