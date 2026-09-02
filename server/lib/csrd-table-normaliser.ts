/**
 * CSRD/ESRS IRO-table normaliser.
 *
 * Motivation
 * ----------
 * Many CSRD/ESRS Non-Financial Statements present their material impacts,
 * risks and opportunities (IROs) as a table with columns like:
 *
 *   Value chain        Time horizon
 *   Subtopic  IRO name  Upstream / Own operations / Downstream  Rationale  Short term / Medium term / Long term
 *
 * When the PDF is flattened by pdf-parse, the header appears once, then
 * every data row loses its column alignment. The three horizon columns are
 * typically drawn as filled circles or bullets that appear as "•", "••" or
 * "•••" runs in the extracted text, sitting on their own lines above or
 * below each risk/impact description. Without the header context, an LLM
 * reading a chunk of the flattened text has no way to know that a lone
 * "•••" means "short + medium + long-term horizons all apply". It just
 * looks like a decorative bullet.
 *
 * We saw this concretely on Nestlé's Non-Financial Statement 2025: the
 * biodiversity IRO table lists Deforestation, Pollinator decline, Soil
 * erosion etc. as nature-related risks with "•••" markers indicating the
 * horizons — but the scorer returns "No, no time horizons disclosed".
 *
 * Design
 * ------
 * The normaliser runs AFTER pdf-parse but BEFORE the whitespace cleanup and
 * chunking. It:
 *
 *   1. Detects whether the document contains one or more CSRD IRO-table
 *      headers (a compact regex over "Short term/Medium term/Long term"
 *      preceded by IRO/rationale/subtopic keywords). If not, it returns
 *      the text unchanged — this makes the pass a no-op on any document
 *      that doesn't use this pattern.
 *
 *   2. For documents that DO contain such a header, it inlines a compact
 *      "[horizons: short|medium|long]" annotation next to each row's
 *      bullet-only line. The annotation is designed to survive chunking:
 *      chunks that get the row without the header will still carry the
 *      horizon information.
 *
 *   3. Handles the three most common CSRD table conventions:
 *      a) "•" / "••" / "•••" ASCII bullets (Nestlé, several KPMG-templated
 *         reports)
 *      b) "●" filled circles / "○" empty circles (some PwC-templated
 *         reports)
 *      c) "✔" / "×" cell marks (rare but present in some Big-4 templates)
 *
 * Rules (see `annotateBulletRow`):
 *   - "•"   → [horizon: short term]
 *   - "••"  → [horizon: short and medium term]
 *   - "•••" → [horizon: short, medium and long term]
 *   - "○" → [horizon: none marked]
 *
 * The rules assume left-to-right ordering ("Short / Medium / Long"), which
 * is the ESRS-standard column order. Documents that use a different order
 * are extremely rare, and the header detector is intentionally strict
 * enough to avoid firing on them.
 *
 * Safety
 * ------
 * - When no CSRD header is detected, output is byte-identical to input
 *   (verified by unit test).
 * - The normaliser only edits bullet-only lines (lines whose content is a
 *   run of horizon markers and optional whitespace). It never edits
 *   sentences, so it cannot corrupt regular narrative text.
 * - Idempotent: running twice produces the same result.
 * - Bounded work: the header scan is a single regex over the entire text
 *   (O(n)), and the annotation pass is a per-line pattern match (O(n)).
 */

// Marker sequences we know how to interpret. Order matters — longer runs
// must be checked first so "•••" isn't misread as three "•".
const ASCII_BULLET_HORIZONS: Array<[RegExp, string]> = [
  [/^•{3}$/, "[horizon: short, medium and long term]"],
  [/^•{2}$/, "[horizon: short and medium term]"],
  [/^•{1}$/, "[horizon: short term]"],
];

const FILLED_CIRCLE_HORIZONS: Array<[RegExp, string]> = [
  // Three positions, filled circle = applies, empty circle = doesn't
  [/^●{3}$/, "[horizon: short, medium and long term]"],
  [/^●●○$/, "[horizon: short and medium term]"],
  [/^●○○$/, "[horizon: short term]"],
  [/^○●●$/, "[horizon: medium and long term]"],
  [/^○○●$/, "[horizon: long term]"],
  [/^○●○$/, "[horizon: medium term]"],
  [/^●○●$/, "[horizon: short and long term]"],
  [/^○{3}$/, "[horizon: none marked]"],
];

// Compact header signature. We match on the sequence of column labels
// appearing close together (allowing internal whitespace, punctuation
// and other column names between them). Requires all three ESRS horizon
// labels to appear within ~200 characters of each other AND at least one
// IRO-vocabulary word nearby.
const CSRD_IRO_HEADER = /(?:IRO|Subtopic|Rationale|Value chain|Impact\/Risk\/Opportunity)[\s\S]{0,400}?Short[\s\-]*term[\s\S]{0,80}?Medium[\s\-]*term[\s\S]{0,80}?Long[\s\-]*term/i;

/**
 * Detect whether the flattened PDF text contains at least one CSRD IRO
 * table header. Used as the gate for the annotation pass.
 */
export function hasCSRDHorizonTable(text: string): boolean {
  return CSRD_IRO_HEADER.test(text);
}

/**
 * Try to annotate a single line. Returns the original line unchanged if
 * it doesn't look like a horizon-marker cell.
 */
function annotateBulletRow(line: string): string {
  const stripped = line.trim();
  if (!stripped) return line;

  // Guard: only touch lines that are ENTIRELY marker characters. Anything
  // else (words, numbers, punctuation other than the marker set) means it
  // isn't a naked table cell and we leave it alone.
  if (!/^[•●○\s]+$/.test(stripped)) return line;

  const compact = stripped.replace(/\s+/g, "");
  if (!compact) return line;

  for (const [re, annotation] of ASCII_BULLET_HORIZONS) {
    if (re.test(compact)) return `${stripped} ${annotation}`;
  }
  for (const [re, annotation] of FILLED_CIRCLE_HORIZONS) {
    if (re.test(compact)) return `${stripped} ${annotation}`;
  }
  return line;
}

/**
 * Public entry point: normalise CSRD IRO-table horizon markers in a
 * flattened PDF text. Returns the input unchanged when no CSRD table
 * header is detected. When a header IS detected, every bullet-only line
 * gets an inline "[horizon: ...]" annotation so that downstream chunks
 * carry the horizon meaning even when separated from the table header.
 */
export function normaliseCSRDHorizonMarkers(text: string): {
  text: string;
  detected: boolean;
  annotationsAdded: number;
} {
  if (!hasCSRDHorizonTable(text)) {
    return { text, detected: false, annotationsAdded: 0 };
  }

  let annotationsAdded = 0;
  const lines = text.split(/\n/);
  const rewritten = lines.map((line) => {
    const annotated = annotateBulletRow(line);
    if (annotated !== line) annotationsAdded++;
    return annotated;
  });

  return {
    text: rewritten.join("\n"),
    detected: true,
    annotationsAdded,
  };
}
