/**
 * Coerce a framework's declared `dataPatterns` into a flat `string[]` of
 * regex/keyword strings, regardless of the stored shape.
 *
 * v2-builder frameworks historically store `dataPatterns` as a flat `string[]`,
 * and the scoring engine (analyzer.ts / pipeline.ts) consumes it as such
 * (`.flatMap`, `.map`, `.join("|")`, `.some`). Some frameworks, however, store
 * it as a KEYED OBJECT of arrays — e.g. a multi-lexicon climate framework:
 *   { physicalClimateLexicon: [...], operationalResilienceLexicon: [...] }
 * Passing that object straight into the engine crashed with
 *   "framework.dataPatterns.flatMap is not a function"
 * which failed every company in the batch before any scoring could happen.
 *
 * This normaliser accepts any shape and always returns a flat `string[]`:
 *   - array            -> its string entries (trimmed, non-empty)
 *   - object of arrays -> concatenation of all array/string values
 *   - null/other       -> []
 *
 * It is topic-agnostic: it flattens whatever the framework author declared and
 * never hardcodes any lexicon name.
 */
export function coerceDataPatterns(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  }
  if (typeof raw === "object") {
    const out: string[] = [];
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === "string" && item.trim().length > 0) out.push(item);
        }
      } else if (typeof v === "string" && v.trim().length > 0) {
        out.push(v);
      }
    }
    return out;
  }
  return [];
}
