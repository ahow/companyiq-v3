/**
 * Framework Creation v2 — 10-Company Test-Drive Stage
 *
 * Before a framework is finalised, it is scored against a stratified 10-company
 * sample to surface framework flaws that Stage 5 validation cannot detect.
 *
 * Test-drive is orchestrated as follows:
 *   1. LLM proposes 10 candidate companies with rationale (this module does the
 *      LLM call).
 *   2. User can override.
 *   3. Companies are enqueued for scoring via the existing pipeline.
 *   4. When all 10 complete, this module aggregates results and applies flag
 *      rules to identify measures needing review.
 *   5. The LLM then proposes a specific fix for every flagged measure.
 *   6. User accepts, rejects, or customises the fixes.
 *   7. Fixes trigger re-draft of affected measures. Loop until user confirms.
 */

import type { MeasureResult } from "../analyzer.js";

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
  rule: string; // "too-narrow" | "too-broad" | "off-expected-narrow" | "off-expected-broad" | "r33-heavy-flipping" | "adjacent-topic-contamination"
  severity: "error" | "warning";
  message: string;
  suggestedFix: string;
  observedRate?: number;
  expectedRate?: number;
}

export interface TestDriveFlagReport {
  totalCompanies: number;
  totalMeasures: number;
  flags: Flag[];
  summary: string;
  passedGracefully: boolean; // true if no error-severity flags
}

// ─── Sample selection prompt for the LLM ─────────────────────────────────

export function buildSampleSelectionPrompt(req: TestDriveSampleRequest): {
  system: string;
  user: string;
} {
  const isSectorSpecific = req.sectorScope.startsWith("specific:");
  const sectorName = isSectorSpecific ? req.sectorScope.slice("specific:".length).trim() : "";
  const modeInstruction = isSectorSpecific
    ? `The framework is sector-specific to ${sectorName}. Select 10 companies from ${sectorName}.`
    : `The framework is sector-agnostic. Select 10 companies representative of the global equity market — mix sectors, market caps, and geographies.`;

  return {
    system: `You are selecting a test-drive sample of 10 companies for a CompanyIQ framework.

Requirements:
${modeInstruction}
- Cover ≥5 sectors (if sector-agnostic)
- Cover ≥3 geographies (Americas, Europe, Asia-Pacific)
- Cover ≥2 market cap tiers (large cap and mid cap)
- Include ≥3 companies you know from research are likely to disclose on this topic (signal companies) — mark isKnownDiscloser: true
- Include ≥2 companies where the topic is peripheral (edge cases) — mark isKnownDiscloser: false

Return a JSON array of exactly 10 companies, each with: name, isin (12-char ISO 6166 identifier if you are confident it corresponds to the specific primary listing, otherwise omit; do NOT guess), ticker (exchange-qualified where non-US e.g. "HSBA.L", "NESN.SW", "7203.T"), sector, country, rationale (1 sentence), isKnownDiscloser (bool).

ISIN caution: if the same ticker is used on multiple exchanges (e.g. "PRU" → Prudential Financial US vs Prudential plc UK), it is safer to omit the ISIN and let downstream resolution disambiguate from the exchange-qualified ticker than to return a plausible-but-wrong ISIN.`,
    user: `Topic: ${req.topicTerm}
Topic synonyms: ${req.topicSynonyms.join(", ")}
Framework: ${req.frameworkName}
${req.stage1ResearchSummary ? `\nResearch context:\n${req.stage1ResearchSummary.slice(0, 2000)}` : ""}

Return a JSON array of 10 companies.`,
  };
}

// ─── Flag analysis rules ─────────────────────────────────────────────────

const FLAG_THRESHOLDS = {
  TOO_NARROW_YES_COUNT: 0,
  TOO_BROAD_YES_COUNT: 10,
  OFF_EXPECTED_MULTIPLIER: 2, // observed vs expected off by 2× triggers flag
  OFF_EXPECTED_MIN_EXPECTED: 0.20, // only flag if expected_yes_rate >= this
  OFF_EXPECTED_MAX_EXPECTED_FOR_BROAD: 0.80, // only flag broad if expected <= this
  R33_HEAVY_FLIP_RATE: 0.40, // ≥40% of Yes verdicts flipped by R3.3
  ADJACENT_CONTAMINATION_RATE: 0.30, // ≥30% of Yes verdicts backed by adjacent-topic quotes
};

export function analyseTestDrive(
  results: TestDriveCompanyResult[],
  measureMetadata: Array<{ measureId: string; expected_yes_rate?: number }>,
): TestDriveFlagReport {
  const totalCompanies = results.length;
  const measureIds = Array.from(new Set(measureMetadata.map((m) => m.measureId)));
  const flags: Flag[] = [];

  // Aggregate per-measure stats across companies
  for (const meta of measureMetadata) {
    const perCompanyVerdicts = results.map((r) => {
      const found = r.measures.find((m) => m.measureId === meta.measureId);
      return found ?? null;
    });
    const yesCount = perCompanyVerdicts.filter((v) => v && v.verdict === "Yes").length;
    const observedRate = totalCompanies > 0 ? yesCount / totalCompanies : 0;
    const expectedRate = meta.expected_yes_rate ?? 0.35;

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

    // Rule: too broad
    if (yesCount === FLAG_THRESHOLDS.TOO_BROAD_YES_COUNT) {
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
