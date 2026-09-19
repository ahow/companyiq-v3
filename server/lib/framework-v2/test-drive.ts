/**
 * Framework Creation v2 — Test-Drive Stage
 *
 * Before a framework is finalised, it is scored against a stratified sample of
 * TEST_DRIVE_SAMPLE_SIZE companies to surface framework flaws that Stage 5
 * validation cannot detect.
 *
 * Test-drive is orchestrated as follows:
 *   1. LLM proposes TEST_DRIVE_SAMPLE_SIZE candidate companies with rationale
 *      (this module does the LLM call).
 *   2. User can override.
 *   3. Companies are enqueued for scoring via the existing pipeline.
 *   4. When all sampled companies complete, this module aggregates results and
 *      applies flag rules to identify measures needing review.
 *   5. The LLM then proposes a specific fix for every flagged measure.
 *   6. User accepts, rejects, or customises the fixes.
 *   7. Fixes trigger re-draft of affected measures. Loop until user confirms.
 */

import type { MeasureResult } from "../analyzer.js";
import { DEGREE_WORDS } from "./rules.js";

// ─── Module constants ────────────────────────────────────────────────────

/**
 * Number of companies in a test-drive sample. Sizing this larger gives the flag
 * rules a more statistically meaningful base and keeps the sample well
 * stratified across sectors, geographies and cap tiers. Referenced everywhere a
 * sample count is needed — do not hard-code the number elsewhere.
 */
export const TEST_DRIVE_SAMPLE_SIZE = 50;

// ─── Types ───────────────────────────────────────────────────────────────

export interface TestDriveCandidateCompany {
  name: string;
  isin?: string;
  ticker?: string;
  sector?: string;
  country?: string;
  rationale: string; // why this company was selected
  isKnownDiscloser: boolean; // true if Stage 1 research indicated this company discloses on the topic
}

export interface TestDriveSampleRequest {
  frameworkName: string;
  topicTerm: string;
  topicSynonyms: string[];
  sectorScope: string; // "agnostic" or "specific:<sector>"
  stage1ResearchSummary?: string; // any research the LLM has already produced
}

export interface TestDriveCompanyResult {
  companyId: number;
  companyName: string;
  measures: Array<{
    measureId: string;
    verdict: "Yes" | "No" | "Partial" | "Insufficient evidence";
    confidence: string;
    quoteCount: number;
    adjacentTopicHits?: number; // count of quotes coming from adjacent-topic sections
    r33Flipped?: boolean; // whether R3.3 context expansion flipped Yes→No
  }>;
}

export interface Flag {
  measureId: string;
  // "too-narrow" | "too-broad" | "off-expected-narrow" | "off-expected-broad"
  // | "r33-heavy-flipping" | "adjacent-topic-contamination"
  // | "residual-instability"  (ITEM 2: verdict flips across identical re-runs)
  // | "no-differentiation"    (ITEM 3: measure gives the SAME verdict to every company)
  // | "sparse-corpus"         (ITEM 3: companies are data-sparse for this topic)
  rule: string;
  severity: "error" | "warning";
  message: string;
  suggestedFix: string;
  observedRate?: number;
  expectedRate?: number;
  flipRate?: number; // ITEM 2: fraction of companies whose verdict differs across runs
  flippedCompanies?: Array<{ companyId: string; verdicts: string[] }>; // ITEM 2 detail
}

export interface TestDriveFlagReport {
  totalCompanies: number;
  totalMeasures: number;
  flags: Flag[];
  summary: string;
  passedGracefully: boolean; // true if no error-severity flags
}

// ─── Multi-run flip detection (ITEM 2) ────────────────────────────────────
//
// Run-to-run verdict instability is a DESIGN defect, not a scoring-runtime one:
// live scoring stays single-shot. In the test-drive design loop we deliberately
// score the SAME sample k times (each completed batch = one iteration row in
// framework_v2_iterations) and compare verdicts per company across those
// iterations. A measure whose verdict changes for a company given identical
// evidence is under-specified and must be rewritten to a countable, quote-
// verifiable rule (C11). This is a design-time diagnostic only.

export interface MultiRunIteration {
  iterationNumber: number;
  // measureId → { companyId(string) → verdict } for that iteration.
  // Mirrors framework_v2_iterations.per_measure[measureId].verdictsByCompany.
  //
  // Tier-1 quality-metrics extension (quality-metrics.ts): iterations may
  // additionally carry per-cell confidence and evidence-fingerprint maps so the
  // retrieval-stability (Jaccard) and confidence-conditioned stability metrics
  // can be computed across runs. Both are OPTIONAL and backward-compatible —
  // legacy iteration rows written before this field existed simply omit them,
  // and the dependent metrics degrade gracefully to a null/insufficient-data
  // status. These are persisted copies of already-computed scoring fields
  // (measure_scores.confidence / evidence_fingerprint), NOT new pipeline capture.
  perMeasure: Record<
    string,
    {
      verdictsByCompany: Record<string, string>;
      // companyId(string) → confidence label (e.g. "High"/"Medium"/"Low")
      confidenceByCompany?: Record<string, string>;
      // companyId(string) → SHA1 evidence fingerprint of the cited chunk-id set
      fingerprintsByCompany?: Record<string, string>;
    }
  >;
}

export interface MeasureFlipStat {
  measureId: string;
  runs: number; // number of iterations that scored this measure
  companiesCompared: number; // companies present in >=2 iterations
  flippedCount: number; // companies whose verdict was not identical across runs
  flipRate: number; // flippedCount / companiesCompared (0 when nothing to compare)
  flippedCompanies: Array<{ companyId: string; verdicts: string[] }>;
}

/**
 * Compare per-company verdicts for each measure across k iterations and report
 * how many companies received a non-identical verdict run-to-run (a "flip").
 * Only companies that appear in >=2 iterations are compared.
 */
export function computeFlipStats(multiRun: MultiRunIteration[]): MeasureFlipStat[] {
  if (!multiRun || multiRun.length < 2) return [];
  const measureIds = new Set<string>();
  for (const it of multiRun) {
    for (const mid of Object.keys(it.perMeasure || {})) measureIds.add(mid);
  }

  const stats: MeasureFlipStat[] = [];
  for (const measureId of measureIds) {
    // companyId → list of verdicts (one per iteration that scored it)
    const byCompany = new Map<string, string[]>();
    let runs = 0;
    for (const it of multiRun) {
      const pm = it.perMeasure?.[measureId];
      if (!pm || !pm.verdictsByCompany) continue;
      runs++;
      for (const [companyId, verdict] of Object.entries(pm.verdictsByCompany)) {
        if (verdict == null) continue;
        const list = byCompany.get(companyId) ?? [];
        list.push(String(verdict));
        byCompany.set(companyId, list);
      }
    }

    const flippedCompanies: Array<{ companyId: string; verdicts: string[] }> = [];
    let companiesCompared = 0;
    for (const [companyId, verdicts] of byCompany) {
      if (verdicts.length < 2) continue; // not comparable
      companiesCompared++;
      if (new Set(verdicts).size > 1) {
        flippedCompanies.push({ companyId, verdicts });
      }
    }

    stats.push({
      measureId,
      runs,
      companiesCompared,
      flippedCount: flippedCompanies.length,
      flipRate: companiesCompared > 0 ? flippedCompanies.length / companiesCompared : 0,
      flippedCompanies,
    });
  }
  return stats;
}

// ─── Sparse-corpus surfacing (ITEM 3) ─────────────────────────────────────
//
// A measure can look "broken" (all-No / off-expected) simply because the
// test-drive companies had no substantive corpus for the topic. The root-cause
// diagnostic already classifies companies as "doc-collection-failure"; here we
// surface that as an actionable design-time prompt so the designer revisits
// whether key sources were missed BEFORE editing measure wording.

export interface SparseCompanySignal {
  companyId: string | number;
  companyName?: string;
  classification: string; // e.g. "doc-collection-failure"
}

/**
 * Build a single actionable sparse-corpus flag from root-cause company
 * classifications. Returns null when no company is data-sparse.
 */
export function buildSparseCorpusFlag(sparse: SparseCompanySignal[]): Flag | null {
  if (!sparse || sparse.length === 0) return null;
  const names = sparse
    .map((s) => s.companyName || `company ${s.companyId}`)
    .filter(Boolean);
  const list = names.slice(0, 8).join(", ") + (names.length > 8 ? `, +${names.length - 8} more` : "");
  return {
    measureId: "*",
    rule: "sparse-corpus",
    severity: "warning",
    message:
      `${sparse.length} test-drive ${sparse.length === 1 ? "company appears" : "companies appear"} data-sparse for this topic ` +
      `(${list}). Flags on these companies may reflect missing source documents, not measure wording.`,
    suggestedFix:
      "Before editing measures, revisit corpus collection for these companies: confirm the expected disclosure sources (annual report, sustainability report, relevant filings) were actually collected. Re-run the test-drive once the corpus is complete, then re-assess measure-level flags.",
  };
}

// ─── Sample selection prompt for the LLM ─────────────────────────────────

export function buildSampleSelectionPrompt(req: TestDriveSampleRequest): {
  system: string;
  user: string;
} {
  const isSectorSpecific = req.sectorScope.startsWith("specific:");
  const sectorName = isSectorSpecific ? req.sectorScope.slice("specific:".length).trim() : "";
  const n = TEST_DRIVE_SAMPLE_SIZE;

  // Stratification minimums scale with the sample size so a larger sample stays
  // well spread and preserves the signal (known-discloser) vs edge-case split.
  const minSectors = Math.max(8, Math.round(n * 0.16)); // ≥8 sectors at n=50
  const minSignal = Math.round(n * 0.3); // ~30% known disclosers → 15 at n=50
  const minEdge = Math.round(n * 0.2); // ~20% edge cases → 10 at n=50

  const modeInstruction = isSectorSpecific
    ? `The framework is sector-specific to ${sectorName}. Select ${n} companies from ${sectorName}.`
    : `The framework is sector-agnostic. Select ${n} companies representative of the global equity market — mix sectors, market caps, and geographies.`;

  return {
    system: `You are selecting a test-drive sample of ${n} companies for a CompanyIQ framework.

Requirements:
${modeInstruction}
- Cover ≥${minSectors} sectors (if sector-agnostic)
- Cover ≥3 geographies — span all major regions (Americas, Europe, Asia-Pacific)
- Cover ≥2 market cap tiers (large cap and mid cap)
- Include ≥${minSignal} companies you know from research are likely to disclose on this topic (signal companies) — mark isKnownDiscloser: true
- Include ≥${minEdge} companies where the topic is peripheral (edge cases) — mark isKnownDiscloser: false

Return a JSON array of exactly ${n} companies, each with: name, ticker (if known), sector, country, rationale (1 sentence), isKnownDiscloser (bool).`,
    user: `Topic: ${req.topicTerm}
Topic synonyms: ${req.topicSynonyms.join(", ")}
Framework: ${req.frameworkName}
${req.stage1ResearchSummary ? `\nResearch context:\n${req.stage1ResearchSummary.slice(0, 2000)}` : ""}

Return a JSON array of ${n} companies.`,
  };
}

// ─── Flag analysis rules ─────────────────────────────────────────────────

const FLAG_THRESHOLDS = {
  TOO_NARROW_YES_COUNT: 0, // fired for zero companies → too narrow (sample-size agnostic)
  // "too broad" means the measure fired for EVERY scored company, so it is
  // compared to totalCompanies at runtime rather than a fixed count.
  OFF_EXPECTED_MULTIPLIER: 2, // observed vs expected off by 2× triggers flag
  OFF_EXPECTED_MIN_EXPECTED: 0.20, // only flag if expected_yes_rate >= this
  OFF_EXPECTED_MAX_EXPECTED_FOR_BROAD: 0.80, // only flag broad if expected <= this
  R33_HEAVY_FLIP_RATE: 0.40, // ≥40% of Yes verdicts flipped by R3.3
  ADJACENT_CONTAMINATION_RATE: 0.30, // ≥30% of Yes verdicts backed by adjacent-topic quotes
  NO_DIFFERENTIATION_MIN_COMPANIES: 3, // need ≥3 scored companies before "no differentiation" is meaningful
  RESIDUAL_INSTABILITY_ERROR_RATE: 0.30, // flip rate ≥30% of compared companies → error severity
};

// C11-style rewrite guidance reused when a measure flips run-to-run (ITEM 2).
// Live scoring stays single-shot; the fix is to remove design ambiguity so
// identical evidence always yields the same verdict.
const C11_REWRITE_SUGGESTION =
  "Verdict is unstable across identical re-runs — the measure leaves a judgment call that two scoring passes resolve differently. " +
  "Rewrite the deciding criteria to be countable and quote-verifiable (C11): replace degree words " +
  `(${DEGREE_WORDS.slice(0, 8).join(", ")}, …) with an explicit N-of-M test over NAMED artefacts, ` +
  'e.g. "Yes if at least 2 of the following appear in a verbatim quote: (a) …, (b) …, (c) …". Then re-run the test-drive to confirm the flips are gone.';

export function analyseTestDrive(
  results: TestDriveCompanyResult[],
  measureMetadata: Array<{ measureId: string; expected_yes_rate?: number }>,
  multiRun?: MultiRunIteration[],
): TestDriveFlagReport {
  const totalCompanies = results.length;
  const measureIds = Array.from(new Set(measureMetadata.map((m) => m.measureId)));
  const flags: Flag[] = [];

  // ITEM 2: per-measure flip stats across k iterations (design-time diagnostic).
  const flipStats = computeFlipStats(multiRun ?? []);
  const flipByMeasure = new Map(flipStats.map((s) => [s.measureId, s]));

  // Aggregate per-measure stats across companies
  for (const meta of measureMetadata) {
    const perCompanyVerdicts = results.map((r) => {
      const found = r.measures.find((m) => m.measureId === meta.measureId);
      return found ?? null;
    });
    const yesCount = perCompanyVerdicts.filter((v) => v && v.verdict === "Yes").length;
    const observedRate = totalCompanies > 0 ? yesCount / totalCompanies : 0;
    const expectedRate = meta.expected_yes_rate ?? 0.35;

    // Rule: no differentiation (ITEM 3)
    // The measure hands the SAME verdict to every scored company (all-Yes,
    // all-No, all-Partial, …) — it has zero discriminating power regardless of
    // what that single verdict is. Distinct from off-expected (which compares to
    // an expected rate): here the problem is that the measure cannot tell any two
    // companies apart, so the framework gains no information from it.
    const recordedVerdicts = perCompanyVerdicts.filter((v) => v != null).map((v) => v!.verdict);
    const distinctVerdicts = new Set(recordedVerdicts);
    if (
      recordedVerdicts.length >= FLAG_THRESHOLDS.NO_DIFFERENTIATION_MIN_COMPANIES &&
      distinctVerdicts.size === 1
    ) {
      const only = [...distinctVerdicts][0];
      flags.push({
        measureId: meta.measureId,
        rule: "no-differentiation",
        severity: "error",
        message: `Measure returned "${only}" for all ${recordedVerdicts.length} scored companies — it does not differentiate between them and adds no signal to the framework.`,
        suggestedFix:
          only === "Yes"
            ? "The bar is so low every company clears it. Redesign the measure to test a specific, discriminating artefact (name the disclosure that only some companies make) so the verdict can vary."
            : only === "No"
            ? "The bar is so high no company clears it, or the criterion tests something companies never disclose. Redesign around an artefact that leading companies actually report, so Yes is achievable and the verdict can vary."
            : `Every company resolves to "${only}". Redesign the measure so its criterion discriminates — test a named, quote-verifiable artefact that only some companies disclose.`,
        observedRate,
        expectedRate,
      });
    }

    // Rule: residual instability across re-runs (ITEM 2)
    // The same sample scored k times produced different verdicts for one or more
    // companies. This is a DESIGN defect (ambiguous criteria), not scoring noise
    // to be sampled away — live scoring stays single-shot. Route to the C11
    // countable-rewrite proposal.
    const flip = flipByMeasure.get(meta.measureId);
    if (flip && flip.companiesCompared > 0 && flip.flippedCount > 0) {
      const detail = flip.flippedCompanies
        .slice(0, 5)
        .map((c) => `company ${c.companyId} [${c.verdicts.join(" → ")}]`)
        .join(", ");
      flags.push({
        measureId: meta.measureId,
        rule: "residual-instability",
        severity: flip.flipRate >= FLAG_THRESHOLDS.RESIDUAL_INSTABILITY_ERROR_RATE ? "error" : "warning",
        message:
          `Verdict flipped run-to-run for ${flip.flippedCount}/${flip.companiesCompared} companies across ${flip.runs} identical re-runs ` +
          `(${(flip.flipRate * 100).toFixed(0)}% flip rate): ${detail}${flip.flippedCompanies.length > 5 ? ", …" : ""}. ` +
          `Identical evidence must always yield the same verdict.`,
        suggestedFix: C11_REWRITE_SUGGESTION,
        flipRate: flip.flipRate,
        flippedCompanies: flip.flippedCompanies,
      });
    }

    // Rule: too narrow
    if (yesCount === FLAG_THRESHOLDS.TOO_NARROW_YES_COUNT) {
      flags.push({
        measureId: meta.measureId,
        rule: "too-narrow",
        severity: "warning",
        message: `Measure fired 0/${totalCompanies} in test-drive — probably too narrow.`,
        suggestedFix:
          "Consider softening fallback_yes_criterion (broaden acceptance) or expanding c1_achievement_guidance yes_cases. Verify substantive_definition is not over-constrained.",
        observedRate,
        expectedRate,
      });
    }

    // Rule: too broad — fired for EVERY scored company (sample-size agnostic).
    if (totalCompanies > 0 && yesCount === totalCompanies) {
      flags.push({
        measureId: meta.measureId,
        rule: "too-broad",
        severity: "warning",
        message: `Measure fired ${totalCompanies}/${totalCompanies} in test-drive — probably too broad.`,
        suggestedFix:
          "Tighten adjacent-topic exclusion in substantive_definition. Consider adding negative_examples that specifically reject the pattern this measure is matching.",
        observedRate,
        expectedRate,
      });
    }

    // Rule: off-expected (narrow)
    if (
      expectedRate >= FLAG_THRESHOLDS.OFF_EXPECTED_MIN_EXPECTED &&
      observedRate < expectedRate / FLAG_THRESHOLDS.OFF_EXPECTED_MULTIPLIER
    ) {
      flags.push({
        measureId: meta.measureId,
        rule: "off-expected-narrow",
        severity: "warning",
        message: `Observed Yes rate ${(observedRate * 100).toFixed(0)}% is much lower than expected ${(expectedRate * 100).toFixed(0)}%.`,
        suggestedFix: "Review measure phrasing; likely under-firing. Check whether fallback conditions are too strict.",
        observedRate,
        expectedRate,
      });
    }

    // Rule: off-expected (broad)
    if (
      expectedRate <= FLAG_THRESHOLDS.OFF_EXPECTED_MAX_EXPECTED_FOR_BROAD &&
      observedRate > expectedRate * FLAG_THRESHOLDS.OFF_EXPECTED_MULTIPLIER
    ) {
      flags.push({
        measureId: meta.measureId,
        rule: "off-expected-broad",
        severity: "warning",
        message: `Observed Yes rate ${(observedRate * 100).toFixed(0)}% is much higher than expected ${(expectedRate * 100).toFixed(0)}%.`,
        suggestedFix: "Review adjacent-topic exclusion. Measure may be matching adjacent-topic evidence.",
        observedRate,
        expectedRate,
      });
    }

    // Rule: R3.3 heavy flipping
    const yesVerdicts = perCompanyVerdicts.filter((v) => v && v.verdict === "Yes");
    const flipCount = perCompanyVerdicts.filter((v) => v && v.r33Flipped === true).length;
    const flipDenom = yesVerdicts.length + flipCount; // initial Yes count before some got flipped
    if (flipDenom > 0 && flipCount / flipDenom >= FLAG_THRESHOLDS.R33_HEAVY_FLIP_RATE) {
      flags.push({
        measureId: meta.measureId,
        rule: "r33-heavy-flipping",
        severity: "warning",
        message: `${flipCount}/${flipDenom} initial Yes verdicts were flipped by context expansion — scoringGuidance may be under-specifying required context.`,
        suggestedFix:
          "Strengthen scoringGuidance quote-context instruction; consider raising min_quote_context_chars to 160 or 200 for this measure.",
      });
    }

    // Rule: adjacent-topic contamination
    const adjHits = yesVerdicts.reduce((sum, v) => sum + (v?.adjacentTopicHits ?? 0), 0);
    if (yesVerdicts.length > 0 && adjHits / yesVerdicts.length >= FLAG_THRESHOLDS.ADJACENT_CONTAMINATION_RATE) {
      flags.push({
        measureId: meta.measureId,
        rule: "adjacent-topic-contamination",
        severity: "warning",
        message: `${adjHits} of ${yesVerdicts.length} Yes verdicts backed by adjacent-topic quotes — C5 exclusion may need tightening.`,
        suggestedFix: "Expand substantive_definition adjacent-topic exclusion to name the specific adjacent topic surfaced in this measure's evidence.",
      });
    }
  }

  const summary = flags.length === 0
    ? `Test-drive passed cleanly: 0 flags across ${measureIds.length} measures on ${totalCompanies} companies.`
    : `Test-drive raised ${flags.length} flag${flags.length === 1 ? "" : "s"} across ${new Set(flags.map((f) => f.measureId)).size} measures on ${totalCompanies} companies:\n${flags.map((f) => `  • [${f.rule}] ${f.measureId}: ${f.message}`).join("\n")}`;

  return {
    totalCompanies,
    totalMeasures: measureIds.length,
    flags,
    summary,
    passedGracefully: flags.filter((f) => f.severity === "error").length === 0,
  };
}

export interface TerminologyGapResult {
  missingTerms: Array<{ term: string; companyCount: number; context: string }>;
  // terms found in corpus text that aren't in topicSynonyms, with how many companies use them
}

/**
 * Stopword set used to detect synonym-list pollution (function-word n-gram
 * artefacts). Module-scoped so the pollution predicate can be reused and unit-
 * tested independently of the corpus-mining path.
 */
export const SYNONYM_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "has", "have",
  "been", "not", "its", "our", "their", "we", "to", "of", "in", "on", "at",
  "by", "as", "an", "a", "or", "be", "is", "was", "will", "it", "which",
]);

/**
 * Deterministic synonym-pollution predicate over pre-tokenised words. A phrase
 * is polluted (must be rejected from the synonym list) if it is empty, its
 * leading OR trailing token is a stopword, or it contains no topic-relevant
 * (non-stopword) token. e.g. "the board", "operations and", "and other" → true;
 * "algorithmic accountability" → false. No LLM, no violation emitted.
 */
export function isPollutedSynonymTokens(
  tokens: string[],
  stopwords: Set<string> = SYNONYM_STOPWORDS,
): boolean {
  if (!tokens || tokens.length === 0) return true;
  if (stopwords.has(tokens[0])) return true;
  if (stopwords.has(tokens[tokens.length - 1])) return true;
  if (tokens.every((w) => stopwords.has(w))) return true;
  return false;
}

/** Convenience wrapper: tokenise a phrase string, then apply the predicate. */
export function isPollutedSynonymPhrase(
  phrase: string,
  stopwords: Set<string> = SYNONYM_STOPWORDS,
): boolean {
  return isPollutedSynonymTokens(
    String(phrase || "").toLowerCase().split(/\s+/).filter(Boolean),
    stopwords,
  );
}

/**
 * Mine the test-drive corpus for terms that companies actually use for the topic
 * but that are NOT already in topicSynonyms. Returns candidate additions ranked
 * by frequency across companies.
 *
 * @param corpusTexts  Map of companyName → full corpus text (lowercased)
 * @param topicSynonyms  Current synonym list (lowercased for comparison)
 * @param topicTerm  The main topic term
 */
export function detectTerminologyGaps(
  corpusTexts: Map<string, string>,
  topicSynonyms: string[],
  topicTerm: string,
): TerminologyGapResult {
  // Build a set of all current known terms (normalised)
  const knownTermsLc = new Set([
    topicTerm.toLowerCase(),
    ...topicSynonyms.map((s) => s.toLowerCase()),
  ]);

  // We look for multi-word phrases (2–5 words) that:
  //  1. Co-occur within 200 chars of any known term
  //  2. Appear in ≥2 company corpora
  //  3. Are NOT already in knownTermsLc
  //  4. Pass a basic relevance heuristic (≥3 chars, not pure stopwords)

  const STOPWORDS = SYNONYM_STOPWORDS;

  // ── Hard resource bounds ────────────────────────────────────────────────
  // This function previously had no caps and mined every phrase around every
  // occurrence of every known term across the full concatenated corpus. On a
  // real test-drive (TEST_DRIVE_SAMPLE_SIZE companies × up to ~1MB each × ~20 synonyms, each
  // appearing hundreds of times) that allocated millions of phrase strings and
  // exhausted the Node heap (OOM crash). Every value below is a hard ceiling so
  // the worst case is a few tens of thousands of allocations, not millions.
  const MAX_TEXT_PER_COMPANY = 200_000;   // chars scanned per company
  const MAX_OCCURRENCES_PER_TERM = 40;    // windows examined per known term per company
  const MAX_DISTINCT_PHRASES = 20_000;    // total distinct candidate phrases held at once
  const WINDOW_RADIUS = 80;               // chars either side of a match

  // Extract candidate phrases: for each company corpus, find windows around known terms
  const termCounts = new Map<string, Set<string>>(); // term → set of company names
  let capped = false; // stop growing the map once the phrase ceiling is hit

  // ── Synonym-pollution auto-fix (definition-of-good dimension 4) ──
  // Reject n-gram artefacts whose LEADING or TRAILING token is a stopword
  // (e.g. "the board", "operations and", "and other", "our global") or that
  // contain no topic-relevant (non-stopword) token. These function-word phrases
  // cause severe false-positive retrieval. This is a DETERMINISTIC filter, not a
  // violation: polluted candidates are dropped here and logged, so they never
  // reach the synonym list, validation, or the repair loop.
  const removedPollutedPhrases = new Set<string>();
  const isPolluted = (tokens: string[]): boolean => isPollutedSynonymTokens(tokens, STOPWORDS);

  outer:
  for (const [companyName, rawText] of corpusTexts) {
    const text = rawText.length > MAX_TEXT_PER_COMPANY ? rawText.slice(0, MAX_TEXT_PER_COMPANY) : rawText;
    for (const knownTerm of knownTermsLc) {
      if (!knownTerm) continue;
      let pos = 0;
      let occurrences = 0;
      while (occurrences < MAX_OCCURRENCES_PER_TERM) {
        const idx = text.indexOf(knownTerm, pos);
        if (idx === -1) break;
        pos = idx + knownTerm.length; // advance past the full match (no overlap)
        occurrences++;
        // Look at a bounded window around this occurrence
        const windowStart = Math.max(0, idx - WINDOW_RADIUS);
        const windowEnd = Math.min(text.length, idx + knownTerm.length + WINDOW_RADIUS);
        const window = text.slice(windowStart, windowEnd);

        // Extract 2–3 word sequences from the window that aren't the known term
        const words = window.split(/\s+/).filter((w) => /^[a-z][a-z-]{2,}/.test(w));
        for (let wi = 0; wi < words.length - 1; wi++) {
          for (let len = 2; len <= 3 && wi + len <= words.length; len++) {
            const phraseTokens = words.slice(wi, wi + len);
            const phrase = phraseTokens.join(" ");
            if (phrase === knownTerm) continue;
            if (knownTermsLc.has(phrase)) continue;
            // Reject function-word / n-gram pollution: leading or trailing
            // stopword, or no topic-relevant token at all. Logged, not a
            // violation — dropped here so it never reaches the synonym list.
            if (isPolluted(phraseTokens)) {
              if (removedPollutedPhrases.size < 200) removedPollutedPhrases.add(phrase);
              continue;
            }
            if (phrase.length < 4 || phrase.length > 60) continue;
            let bucket = termCounts.get(phrase);
            if (!bucket) {
              // Only create new phrase buckets while under the ceiling. Once the
              // ceiling is reached we keep counting phrases we've already seen
              // (so ≥2-company detection still works) but stop adding new ones.
              if (termCounts.size >= MAX_DISTINCT_PHRASES) { capped = true; continue; }
              bucket = new Set();
              termCounts.set(phrase, bucket);
            }
            bucket.add(companyName);
          }
        }
      }
      if (capped && termCounts.size >= MAX_DISTINCT_PHRASES) break outer;
    }
  }

  if (removedPollutedPhrases.size > 0) {
    const sample = Array.from(removedPollutedPhrases).slice(0, 20);
    console.log(
      `[test-drive] synonym-pollution filter dropped ${removedPollutedPhrases.size} function-word candidate phrase(s) (leading/trailing stopword or no topic-relevant token). Sample: ${sample.join(", ")}`,
    );
  }

  // Filter: must appear in ≥2 companies, rank by company coverage
  const candidates = Array.from(termCounts.entries())
    .filter(([, companies]) => companies.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10); // top 10 candidates

  return {
    missingTerms: candidates.map(([term, companies]) => ({
      term,
      companyCount: companies.size,
      context: `Found in ${companies.size} company corpora near existing topic terms`,
    })),
  };
}
