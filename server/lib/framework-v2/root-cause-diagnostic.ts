/**
 * Framework Creation v2 — Root Cause Diagnostic (Stage 1b)
 *
 * Separates two fundamentally different failure modes surfaced by test-drive:
 *
 * 1. Document-collection failures (a COMPANY problem, not a measure problem):
 *      The company scored Yes on 0 (or very few) measures because the corpus
 *      we retrieved does not contain the disclosures where they DO cover the
 *      topic. Symptoms: small corpus, no sustainability/thematic-report PDFs,
 *      the topic term barely appears anywhere.
 *      Correct fix: improve retrieval/gate rules for that company. NOT change
 *      the framework.
 *
 * 2. Measure-definition failures (a FRAMEWORK problem):
 *      A measure fires 0 across companies whose corpora DO discuss the topic
 *      (i.e. the topic term appears in the corpus but the measure still
 *      returns No), or fires universally (10/10) regardless of relevance.
 *      Correct fix: revise the measure (broaden/narrow/exclude adjacent).
 *
 * A row that is 0-Yes AND has a topic-poor corpus is likely a doc-collection
 * problem; a row that is 0-Yes AND has topic-rich corpus is likely a
 * measure-definition problem. This module makes that split explicit so the
 * user is not offered a framework edit for a problem that is actually about
 * document retrieval.
 *
 * All thresholds are conservative defaults; they can be tuned as we accumulate
 * empirical calibration data across topics.
 */

export interface CompanyCorpusStats {
  companyId: number;
  companyName: string;
  docCount: number;
  totalChars: number;
  pdfCount: number;                      // count of PDF-type docs (proxy for real reports)
  thematicReportCount: number;           // docs with "sustainability", "TCFD", "TNFD", or the topic term in the title
  topicTermMentions: number;             // total occurrences of topicTerm/synonyms across corpus
  topicMentioningDocs: number;           // docs where the topic term appears at least once
  yesCount: number;
  totalMeasures: number;
}

export interface CompanyDiagnostic {
  companyId: number;
  companyName: string;
  classification:
    | "healthy"                           // scored some Yes; no action needed
    | "doc-collection-failure"           // 0 Yes AND thin/topic-empty corpus
    | "framework-issue"                  // 0 Yes despite topic-rich corpus
    | "ambiguous";                       // 0 Yes but signals conflict
  yesCount: number;
  yesRate: number;
  corpusSummary: string;                 // human-readable summary of corpus size + content
  reasoning: string;                     // 1-sentence rationale for the classification
  suggestedAction: string;
  signals: {
    lowDocCount: boolean;
    smallCorpus: boolean;
    noThematicReport: boolean;
    lowTopicMentions: boolean;
    topicCoverageRatio: number;          // topicMentioningDocs / docCount
  };
}

export interface MeasureDiagnostic {
  measureId: string;
  classification:
    | "healthy"
    | "measure-definition-issue"        // dead across topic-rich corpora
    | "collection-attributable"          // dead ONLY where corpora are topic-poor
    | "over-broad"
    | "ambiguous";
  yesCount: number;
  yesRateOnTopicRichCompanies: number;   // Yes-rate restricted to companies with topic-rich corpora
  reasoning: string;
  suggestedAction: string;
}

export interface RootCauseReport {
  companies: CompanyDiagnostic[];
  measures: MeasureDiagnostic[];
  summary: {
    docCollectionFailures: number;
    frameworkIssues: number;
    healthy: number;
    ambiguous: number;
    deadMeasuresLikelyFrameworkFault: number;
    deadMeasuresLikelyCorpusFault: number;
  };
  headline: string;                      // 1-2 sentence overview for the UI
}

const DEFAULT_THRESHOLDS = {
  DOC_COUNT_LOW: 10,                     // < 10 docs = thin corpus
  CORPUS_CHARS_SMALL: 500_000,           // < 500K chars = small
  TOPIC_MENTIONS_LOW: 20,                // < 20 total topic mentions across corpus = topic-poor
  TOPIC_COVERAGE_LOW: 0.15,              // < 15% of docs mention topic
  DEAD_MEASURE_YES_MAX: 0,               // fires 0 = dead
  UNIVERSAL_MEASURE_YES_MIN_RATIO: 0.9,  // fires >= 90% of the time
};

export function diagnoseRootCauses(
  corpusStats: CompanyCorpusStats[],
  measureIds: string[],
  scoresByCompanyMeasure: Record<string, Record<string, string>>, // {companyId: {measureId: verdict}}
  thresholds = DEFAULT_THRESHOLDS,
): RootCauseReport {
  const companies: CompanyDiagnostic[] = [];

  for (const c of corpusStats) {
    const signals = {
      lowDocCount: c.docCount < thresholds.DOC_COUNT_LOW,
      smallCorpus: c.totalChars < thresholds.CORPUS_CHARS_SMALL,
      noThematicReport: c.thematicReportCount === 0,
      lowTopicMentions: c.topicTermMentions < thresholds.TOPIC_MENTIONS_LOW,
      topicCoverageRatio: c.docCount > 0 ? c.topicMentioningDocs / c.docCount : 0,
    };
    const yesRate = c.totalMeasures > 0 ? c.yesCount / c.totalMeasures : 0;

    let classification: CompanyDiagnostic["classification"];
    let reasoning: string;
    let suggestedAction: string;
    const corpusSummary =
      `${c.docCount} docs, ${(c.totalChars / 1000).toFixed(0)}K chars, ` +
      `${c.pdfCount} PDFs, ${c.thematicReportCount} thematic reports, ` +
      `${c.topicTermMentions} topic mentions across ${c.topicMentioningDocs} docs`;

    if (c.yesCount > 0) {
      classification = "healthy";
      reasoning = `Scored ${c.yesCount}/${c.totalMeasures} Yes — corpus and framework are producing evidence.`;
      suggestedAction = "No action; use as a positive reference.";
    } else {
      // 0 Yes. Classify why.
      const corpusRedFlags =
        (signals.lowDocCount ? 1 : 0) +
        (signals.smallCorpus ? 1 : 0) +
        (signals.noThematicReport ? 1 : 0) +
        (signals.lowTopicMentions ? 1 : 0) +
        (signals.topicCoverageRatio < thresholds.TOPIC_COVERAGE_LOW ? 1 : 0);

      if (corpusRedFlags >= 3) {
        classification = "doc-collection-failure";
        const reasons: string[] = [];
        if (signals.lowDocCount) reasons.push(`only ${c.docCount} docs retrieved`);
        if (signals.noThematicReport) reasons.push("no sustainability/thematic report in corpus");
        if (signals.lowTopicMentions) reasons.push(`only ${c.topicTermMentions} topic mentions across the whole corpus`);
        if (signals.topicCoverageRatio < thresholds.TOPIC_COVERAGE_LOW) {
          reasons.push(`only ${(signals.topicCoverageRatio * 100).toFixed(0)}% of docs mention the topic`);
        }
        reasoning =
          `0 Yes verdicts, but the retrieved corpus lacks topic-relevant material: ` +
          reasons.slice(0, 3).join(", ") + `.`;
        suggestedAction =
          "Improve document retrieval for this company (add sustainability-report URL, expand gate rules, or manually attach known disclosures). Do NOT change the framework based on this company's result.";
      } else if (c.topicTermMentions >= thresholds.TOPIC_MENTIONS_LOW && signals.topicCoverageRatio >= thresholds.TOPIC_COVERAGE_LOW) {
        classification = "framework-issue";
        reasoning =
          `0 Yes verdicts DESPITE topic-rich corpus (${c.topicTermMentions} mentions across ${c.topicMentioningDocs} docs). ` +
          `The framework failed to recognise disclosures the corpus actually contains.`;
        suggestedAction =
          "Review measure definitions: they are likely too narrow, over-specifying required phrasing, or misclassifying legitimate evidence as adjacent-topic.";
      } else {
        classification = "ambiguous";
        reasoning =
          `0 Yes with mixed signals: ${signals.lowDocCount ? "thin " : ""}corpus of ${c.docCount} docs, ` +
          `${c.topicTermMentions} topic mentions, ${(signals.topicCoverageRatio * 100).toFixed(0)}% coverage. ` +
          `Cannot cleanly separate corpus vs framework as root cause.`;
        suggestedAction =
          "Inspect a few Yes-candidate quotes in the corpus manually. If the topic IS discussed but scored No, treat as framework issue; if the topic is genuinely absent, treat as corpus issue.";
      }
    }

    companies.push({
      companyId: c.companyId,
      companyName: c.companyName,
      classification,
      yesCount: c.yesCount,
      yesRate,
      corpusSummary,
      reasoning,
      suggestedAction,
      signals,
    });
  }

  // ── Per-measure diagnostics ──────────────────────────────────────────
  const topicRichCompanyIds = new Set(
    corpusStats
      .filter((c) => c.topicTermMentions >= DEFAULT_THRESHOLDS.TOPIC_MENTIONS_LOW)
      .map((c) => String(c.companyId)),
  );
  const measures: MeasureDiagnostic[] = [];

  for (const measureId of measureIds) {
    let yesCount = 0, totalScored = 0;
    let yesOnTopicRich = 0, totalTopicRich = 0;
    for (const [cidStr, measureVerdicts] of Object.entries(scoresByCompanyMeasure)) {
      const verdict = measureVerdicts[measureId];
      if (!verdict) continue;
      totalScored++;
      const isYes = verdict === "Yes";
      if (isYes) yesCount++;
      if (topicRichCompanyIds.has(cidStr)) {
        totalTopicRich++;
        if (isYes) yesOnTopicRich++;
      }
    }
    const yesRateOnTopicRich = totalTopicRich > 0 ? yesOnTopicRich / totalTopicRich : 0;
    const overallRatio = totalScored > 0 ? yesCount / totalScored : 0;

    let classification: MeasureDiagnostic["classification"];
    let reasoning: string;
    let suggestedAction: string;

    if (yesCount === 0 && totalTopicRich > 0 && yesRateOnTopicRich === 0) {
      classification = "measure-definition-issue";
      reasoning =
        `Dead across ${totalTopicRich} companies with topic-rich corpora. The measure is not recognising legitimate evidence.`;
      suggestedAction =
        "Revise the measure: broaden fallback_yes_criterion, add positive_examples, or check that substantive_definition is not over-specified.";
    } else if (yesCount === 0 && totalTopicRich === 0) {
      classification = "collection-attributable";
      reasoning =
        `Dead but ONLY tested against topic-poor corpora. Cannot conclude the measure is broken — the sample doesn't discuss the topic enough to test it.`;
      suggestedAction =
        "Do not modify this measure based on the current test-drive. Add a signal company with strong disclosure on this specific sub-topic and re-test.";
    } else if (overallRatio >= DEFAULT_THRESHOLDS.UNIVERSAL_MEASURE_YES_MIN_RATIO && totalScored >= 5) {
      classification = "over-broad";
      reasoning =
        `Fires ${yesCount}/${totalScored} across companies — likely matching adjacent-topic material or generic language.`;
      suggestedAction =
        "Tighten substantive_definition to require named methodologies, quantified claims, or specific frameworks. Add negative_examples showing common adjacent-topic false positives.";
    } else {
      classification = "healthy";
      reasoning = `Fires ${yesCount}/${totalScored} with ${yesOnTopicRich}/${totalTopicRich} on topic-rich corpora — signal looks reasonable.`;
      suggestedAction = "No action.";
    }

    measures.push({
      measureId,
      classification,
      yesCount,
      yesRateOnTopicRichCompanies: yesRateOnTopicRich,
      reasoning,
      suggestedAction,
    });
  }

  const summary = {
    docCollectionFailures: companies.filter((c) => c.classification === "doc-collection-failure").length,
    frameworkIssues: companies.filter((c) => c.classification === "framework-issue").length,
    healthy: companies.filter((c) => c.classification === "healthy").length,
    ambiguous: companies.filter((c) => c.classification === "ambiguous").length,
    deadMeasuresLikelyFrameworkFault: measures.filter((m) => m.classification === "measure-definition-issue").length,
    deadMeasuresLikelyCorpusFault: measures.filter((m) => m.classification === "collection-attributable").length,
  };

  const headline =
    summary.docCollectionFailures > 0
      ? `${summary.docCollectionFailures} of ${companies.length} companies scored zero due to likely corpus problems — fix retrieval before drawing framework conclusions from them. ${summary.deadMeasuresLikelyFrameworkFault} of ${measures.length} measures are dead despite topic-rich corpora — those need framework edits.`
      : `${summary.deadMeasuresLikelyFrameworkFault} measures appear dead across topic-rich corpora (measure-definition issue). No systematic corpus failures detected.`;

  return { companies, measures, summary, headline };
}
