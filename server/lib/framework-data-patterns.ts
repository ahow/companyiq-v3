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

/**
 * Coerce a framework's declared `authoritativeRegistries` into a flat
 * `string[]` of registry domains/URLs, regardless of the stored shape.
 *
 * The discovery engine consumes this list as plain strings — it iterates each
 * entry and calls `.trim().replace(/^https?:\/\//i, "")...` to extract a bare
 * domain for `site:` searches and authority-class ranking. v2-builder
 * frameworks store it as a flat `string[]` of domains ("oecd.ai", ...), but
 * some frameworks (including imported climate frameworks) store it as an array
 * of OBJECTS — e.g. `[{ name: "CDP Climate Change", source: "https://www.cdp.net/" }]`.
 * Passing those objects straight into the engine crashed with
 *   "registry.trim is not a function"
 * which failed every company in the batch before any discovery could happen.
 *
 * This normaliser accepts any shape and always returns a flat `string[]`:
 *   - string entry        -> the string
 *   - object entry        -> its source/url/domain/host/link, else name/title/id
 *   - object of arrays    -> same treatment applied to every nested entry
 *   - null/other          -> []
 *
 * It is topic-agnostic and never hardcodes any registry name.
 */
export function coerceRegistries(raw: unknown): string[] {
  const out: string[] = [];
  const pushEntry = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (entry.trim().length > 0) out.push(entry);
      return;
    }
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const candidate =
        rec.source ?? rec.url ?? rec.domain ?? rec.host ?? rec.link ??
        rec.name ?? rec.title ?? rec.id;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        out.push(candidate);
      }
    }
  };
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) pushEntry(entry);
    return out;
  }
  if (typeof raw === "object") {
    for (const v of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const entry of v) pushEntry(entry);
      } else {
        pushEntry(v);
      }
    }
    return out;
  }
  return out;
}
