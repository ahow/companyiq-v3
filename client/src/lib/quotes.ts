// Shared helpers for filtering measure "quotes" shown in detailed analysis outputs.
//
// The `quotes` jsonb array on each measure score mixes two very different things:
//   1. Real evidence quotes  -> { text: "<verbatim quote>", source: "<doc title>", sourceUrl: "https://..." }
//   2. Internal diagnostic blobs -> raw JSON traces emitted by the retrieval / evidence-gate
//      pipeline, e.g. { text: '{"v":1,"topChunks":[...]}', source: "retrieval-diagnostic",
//      sourceUrl: "diag://retrieval-v1" }.
//
// The diagnostic blobs are machine-readable traces, not human-readable evidence, so they render
// as illegible walls of JSON on the detailed analysis pages. We filter them out of the
// user-facing evidence sections (detail page + CSV export) while keeping the real verbatim
// quotes and their source links. Nothing is deleted from the database — these entries remain
// available via the dedicated Diagnostics tab (which reads company.discoveryDiagnostics).

export interface QuoteLike {
  text?: string;
  source?: string;
  sourceUrl?: string;
}

// Sentinels used by the pipeline to tag diagnostic entries.
const DIAG_SOURCE_URL_PREFIX = "diag://";
const DIAG_SOURCES = new Set(["retrieval-diagnostic", "evidence-gate"]);

/**
 * True when a quote entry is a genuine, human-readable evidence quote (not an internal
 * diagnostic trace). Belt-and-braces: we exclude anything tagged as a diagnostic by its
 * sourceUrl prefix OR its source name, and anything whose text is an empty/JSON blob.
 */
export function isRealQuote(q: QuoteLike | null | undefined): boolean {
  if (!q) return false;
  const url = (q.sourceUrl || "").trim();
  if (url.toLowerCase().startsWith(DIAG_SOURCE_URL_PREFIX)) return false;
  const src = (q.source || "").trim().toLowerCase();
  if (DIAG_SOURCES.has(src)) return false;
  const text = (q.text || "").trim();
  if (!text) return false;
  // A diagnostic blob's text is raw JSON (e.g. {"v":1,...} or [ ... ]). Real quotes are prose.
  if (text.startsWith('{"v":') || text.startsWith('{"topChunks"') || text.startsWith('{"quotesTotal"')) return false;
  return true;
}

/** Keep only the real evidence quotes from a (possibly undefined) quotes array. */
export function realQuotes<T extends QuoteLike>(quotes: T[] | null | undefined): T[] {
  return (quotes || []).filter(isRealQuote);
}
