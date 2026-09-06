/**
 * evidence-keyword-distinctiveness.ts
 *
 * Generalized quality check for measure evidenceKeywords.
 *
 * WHY: evidenceKeywords are fed into the BM25 retrieval query as a BAG OF TOKENS.
 * A keyword list can look measure-specific to a human ("nature-related
 * opportunities", "biodiversity opportunities", "natural capital opportunities")
 * yet tokenise almost entirely into GENERIC framework vocabulary — here
 * nature/opportunities/biodiversity/ecosystem — that already appears in the topic
 * lexicon and in nearly every other measure's query. Those tokens add no
 * discriminating signal; they just re-assert the shared topic, so the measure's
 * pack is chosen by topic density rather than by what makes THIS measure distinct.
 * (Observed on the Nature framework's 2.4 nature-opportunities: 13 keywords ->
 * dominant tokens nature×5, opportunities×4, biodiversity×2, ecosystem×2; only
 * biomimicry / restoration were genuinely distinctive.)
 *
 * WHAT: after the LLM drafts a framework, tokenise every measure's
 * evidenceKeywords, then classify each token as DISTINCTIVE or GENERIC:
 *   - GENERIC if it also appears in the framework topicSynonyms/lexicon, OR it
 *     appears in the evidenceKeywords of more than `maxMeasureFraction` of the
 *     measures (i.e. it is shared vocabulary, not measure-specific).
 *   - DISTINCTIVE otherwise.
 * A measure with fewer than `minDistinctive` distinctive tokens is flagged so the
 * builder review step (or the operator) can regenerate a sharper keyword list.
 *
 * This is deliberately NON-DESTRUCTIVE: it never silently drops the LLM's
 * keywords (the generic ones still help recall). It produces diagnostics the
 * review UI / robustness gate can surface, and a suggested distinctive-only view.
 */

import { tokenize } from "../passage-retrieval.js";

export interface MeasureLike {
  measureId?: string;
  id?: string;
  title?: string;
  evidenceKeywords?: string[];
}

export interface MeasureEkDiagnostic {
  measureId: string;
  title?: string;
  distinctiveTokens: string[];
  genericTokens: string[];
  distinctiveCount: number;
  totalTokens: number;
  warning?: string;
}

export interface EkDistinctivenessResult {
  perMeasure: MeasureEkDiagnostic[];
  summary: {
    measureCount: number;
    minDistinctive: number;
    maxMeasureFraction: number;
    measuresBelowMin: number;
    flaggedMeasureIds: string[];
  };
}

export interface EkDistinctivenessOptions {
  /** A measure needs at least this many distinctive tokens; else it is flagged. */
  minDistinctive?: number;
  /** A token in more than this fraction of measures counts as generic (shared). */
  maxMeasureFraction?: number;
}

/**
 * Curated retrieval-noise stoplist: generic English / soft-business tokens that
 * are NOT in the topic lexicon and are NOT shared across enough measures to be
 * caught by document-frequency, yet carry no discriminating retrieval signal.
 * Without this, filler like "based/solutions/products/markets/leadership"
 * inflates a measure's distinctive count and hides a thin keyword list
 * (observed on 2.4 nature-opportunities: 9 "distinctive" tokens, but 5 were
 * filler; only restoration/bio/inspired/biomimicry actually discriminate).
 * Kept deliberately small and domain-neutral — real domain terms never belong
 * here.
 */
export const GENERIC_FILLER_TOKENS = new Set<string>([
  "based", "solution", "solutions", "product", "products", "market", "markets",
  "leadership", "approach", "approaches", "process", "processes", "key", "area",
  "areas", "into", "information", "value", "creation", "new", "related",
  "opportunity", "opportunities", "initiative", "initiatives", "activity",
  "activities", "programme", "programmes", "program", "programs", "practice",
  "practices", "effort", "efforts", "action", "actions", "measure", "measures",
  "strategy", "strategies", "strategic", "business", "company", "organization",
  "organisation", "corporate", "group", "level", "term", "terms", "range",
  "various", "including", "example", "examples", "relevant", "specific",
  "general", "overall", "across", "within", "through", "used", "use", "using",
]);

const midOf = (m: MeasureLike): string => m.measureId || m.id || m.title || "(unknown measure)";

/** Unique retrieval tokens contributed by a measure's evidenceKeywords. */
function measureTokens(m: MeasureLike): string[] {
  const toks = new Set<string>();
  for (const kw of m.evidenceKeywords || []) for (const t of tokenize(kw)) toks.add(t);
  return [...toks];
}

export function analyzeEvidenceKeywordDistinctiveness(
  measures: MeasureLike[],
  topicSynonyms: string[] = [],
  opts: EkDistinctivenessOptions = {},
): EkDistinctivenessResult {
  // Default floor of 5: on the Nature framework the second-thinnest measure has
  // 7 distinctive tokens, so a <5 gate isolates the true outlier (2.4 at 4)
  // without false positives. Env/opts override for other frameworks.
  const minDistinctive = opts.minDistinctive ?? 5;
  const maxMeasureFraction = opts.maxMeasureFraction ?? 0.5;

  // Tokens that are part of the framework's shared topic vocabulary.
  const topicTokenSet = new Set<string>();
  for (const syn of topicSynonyms || []) for (const t of tokenize(syn)) topicTokenSet.add(t);

  // Cross-measure document frequency: in how many measures' keyword sets does a
  // token appear? A token shared across many measures is not distinctive.
  const perMeasureTokens = measures.map(measureTokens);
  const docFreq = new Map<string, number>();
  for (const toks of perMeasureTokens) {
    for (const t of toks) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }
  const sharedThreshold = Math.max(2, Math.ceil(maxMeasureFraction * measures.length));

  const perMeasure: MeasureEkDiagnostic[] = measures.map((m, i) => {
    const toks = perMeasureTokens[i];
    const distinctiveTokens: string[] = [];
    const genericTokens: string[] = [];
    for (const t of toks) {
      const isTopicWord = topicTokenSet.has(t);
      const isShared = (docFreq.get(t) || 0) >= sharedThreshold;
      const isFiller = GENERIC_FILLER_TOKENS.has(t);
      if (isTopicWord || isShared || isFiller) genericTokens.push(t);
      else distinctiveTokens.push(t);
    }
    const distinctiveCount = distinctiveTokens.length;
    const diag: MeasureEkDiagnostic = {
      measureId: midOf(m),
      title: m.title,
      distinctiveTokens,
      genericTokens,
      distinctiveCount,
      totalTokens: toks.length,
    };
    if (distinctiveCount < minDistinctive) {
      diag.warning =
        `Only ${distinctiveCount} distinctive retrieval token(s) (need ≥ ${minDistinctive}). ` +
        `evidenceKeywords tokenise mostly to generic/shared vocabulary ` +
        `[${genericTokens.slice(0, 8).join(", ")}${genericTokens.length > 8 ? ", …" : ""}]. ` +
        `Add measure-specific single-token terms that do NOT appear in the topic lexicon or in other measures.`;
    }
    return diag;
  });

  const flagged = perMeasure.filter((d) => d.warning);
  return {
    perMeasure,
    summary: {
      measureCount: measures.length,
      minDistinctive,
      maxMeasureFraction,
      measuresBelowMin: flagged.length,
      flaggedMeasureIds: flagged.map((d) => d.measureId),
    },
  };
}
