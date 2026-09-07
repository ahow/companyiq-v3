/**
 * Framework Creation v2 — Export existing framework as FULL detail
 *
 * Produces a comprehensive markdown document that captures a framework in its
 * entirety: every configuration field plus every measure with all of its
 * fields, and a complete intake-artefact JSON block. Unlike the seed export
 * (export-as-seed.ts), which deliberately drops per-measure detail so the user
 * can start fresh, this export is intended to let a CompanyIQ v2 builder session
 * reconstruct the framework EXACTLY — the LLM can rebuild it without asking any
 * questions.
 */

export interface FullExportInput {
  framework: any;
  measures: any[];
}

// ── small formatting helpers ──────────────────────────────────────────────

function asArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

/** Render a value for a readable "- **Label**: value" line. */
function fmtInline(v: any): string {
  if (v === null || v === undefined || v === "") return "_(not set)_";
  if (Array.isArray(v)) {
    if (v.length === 0) return "_(empty)_";
    // Array of primitives → comma list; array of objects → JSON.
    if (v.every((x) => typeof x !== "object" || x === null)) {
      return v.map((x) => String(x)).join(", ");
    }
    return "\n\n```json\n" + JSON.stringify(v, null, 2) + "\n```";
  }
  if (typeof v === "object") {
    return "\n\n```json\n" + JSON.stringify(v, null, 2) + "\n```";
  }
  return String(v);
}

/** Render a multi-line block field (definition, guidance, etc.). */
function fmtBlock(v: any): string {
  if (v === null || v === undefined || v === "") return "_(not set)_";
  if (Array.isArray(v)) {
    if (v.length === 0) return "_(empty)_";
    return v
      .map((x) =>
        typeof x === "object" && x !== null
          ? "- " + JSON.stringify(x)
          : "- " + String(x),
      )
      .join("\n");
  }
  if (typeof v === "object") {
    return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
  }
  return String(v);
}

/** Pick the first present value across a list of possible field names. */
function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Aggregate the top-N examples across all measures (deduplicated). */
function aggregateExamples(measures: any[], ...keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of measures) {
    let vals: any;
    for (const k of keys) {
      if (Array.isArray(m?.[k])) { vals = m[k]; break; }
    }
    for (const ex of asArray<string>(vals)) {
      const s = typeof ex === "string" ? ex.trim() : JSON.stringify(ex);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

// ── main export ────────────────────────────────────────────────────────────

export function exportFrameworkAsFullDetail(input: FullExportInput): string {
  const fw = input.framework || {};
  const measures = asArray<any>(input.measures);

  const name = pick(fw, "name", "title") || "Untitled Framework";
  const version = pick(fw, "version") ?? "1";
  const topicDescription =
    pick(fw, "topicDescription", "description", "topic") || "";

  // ── Intake artefact JSON (complete, so a v2 builder can reconstruct) ──────
  const intakeArtefact = {
    topicTerm: pick(fw, "topicTerm", "topicName") ?? null,
    topicDescription: topicDescription || null,
    topicSynonyms: asArray(pick(fw, "topicSynonyms")),
    adjacentTopics: asArray(pick(fw, "adjacentTopics")),
    anchorFrameworks: asArray(pick(fw, "anchorFrameworks")),
    entityType: pick(fw, "entityType") ?? null,
    sectorScope: pick(fw, "sectorScope") ?? null,
    universe: pick(fw, "universe") ?? null,
    reportingPeriod: pick(fw, "reportingPeriod") ?? null,
    sensitivityPreference: pick(fw, "sensitivityPreference") ?? null,
    subAreaStructure: pick(fw, "subAreaStructure") ?? null,
    requiredDocTypes: asArray(pick(fw, "requiredDocTypes")),
    dataPatterns: asArray(pick(fw, "dataPatterns")),
    documentPriorityUrlPatterns: asArray(pick(fw, "documentPriorityUrlPatterns")),
    negativeKeywords: asArray(pick(fw, "negativeKeywords")),
    searchTemplates: asArray(pick(fw, "searchTemplates")),
    scoringExamples: pick(fw, "scoringExamples") ?? null,
    antiInferenceRules: asArray(pick(fw, "antiInferenceRules")),
    targetMeasureCount: measures.length,
    basePositiveExamples: aggregateExamples(
      measures,
      "positiveExamples",
      "positive_examples",
    ).slice(0, 3),
    baseNegativeExamples: aggregateExamples(
      measures,
      "negativeExamples",
      "negative_examples",
    ).slice(0, 3),
    confirmed: true,
  };

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Framework Full Export — ${name}`);
  lines.push("");
  lines.push(`**Version:** ${version}`);
  lines.push("");
  lines.push(`**Topic description:** ${topicDescription || "_(not set)_"}`);
  lines.push("");
  lines.push(
    "> This is a complete, self-contained export of the framework. Paste the " +
      "intake artefact JSON block below into a CompanyIQ v2 builder session to " +
      "reconstruct this framework exactly — including every measure — without " +
      "the LLM needing to ask any intake questions.",
  );
  lines.push("");

  // ── Intake Artefact JSON ───────────────────────────────────────────────────
  lines.push("## Intake Artefact (JSON)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(intakeArtefact, null, 2));
  lines.push("```");
  lines.push("");

  // ── Framework Configuration ────────────────────────────────────────────────
  lines.push("## Framework Configuration");
  lines.push("");
  const configFields: Array<[string, any]> = [
    ["Name", name],
    ["Version", version],
    ["Topic term", pick(fw, "topicTerm", "topicName")],
    ["Topic description", topicDescription],
    ["Topic synonyms", pick(fw, "topicSynonyms")],
    ["Adjacent topics", pick(fw, "adjacentTopics")],
    ["Anchor frameworks", pick(fw, "anchorFrameworks")],
    ["Entity type", pick(fw, "entityType")],
    ["Sector scope", pick(fw, "sectorScope")],
    ["Universe", pick(fw, "universe")],
    ["Reporting period", pick(fw, "reportingPeriod")],
    ["Sensitivity preference", pick(fw, "sensitivityPreference")],
    ["Sub-area structure", pick(fw, "subAreaStructure")],
    ["Required doc types", pick(fw, "requiredDocTypes")],
    ["Data patterns", pick(fw, "dataPatterns")],
    ["Document priority URL patterns", pick(fw, "documentPriorityUrlPatterns")],
    ["Negative keywords", pick(fw, "negativeKeywords")],
    ["Search templates", pick(fw, "searchTemplates")],
    ["Legacy query templates", pick(fw, "legacyQueryTemplates")],
    ["Scoring examples", pick(fw, "scoringExamples")],
    ["Anti-inference rules", pick(fw, "antiInferenceRules")],
  ];
  for (const [label, value] of configFields) {
    lines.push(`- **${label}**: ${fmtInline(value)}`);
  }
  lines.push("");

  // ── Measures ────────────────────────────────────────────────────────────────
  lines.push(`## Measures (${measures.length})`);
  lines.push("");

  const sorted = [...measures].sort((a, b) => {
    const ao = Number(pick(a, "displayOrder") ?? 0);
    const bo = Number(pick(b, "displayOrder") ?? 0);
    return ao - bo;
  });

  sorted.forEach((m, idx) => {
    const mId = pick(m, "measureId", "measure_id") ?? `#${idx + 1}`;
    const title = pick(m, "title") ?? "(untitled)";
    lines.push(`### ${idx + 1}. ${mId} — ${title}`);
    lines.push("");

    const measureFields: Array<[string, any]> = [
      ["Measure ID", pick(m, "measureId", "measure_id")],
      ["Category", pick(m, "category")],
      ["Title", pick(m, "title")],
      ["Definition", pick(m, "definition")],
      ["Scoring guidance", pick(m, "scoringGuidance", "scoring_guidance")],
      ["Primary assessment target", pick(m, "primaryAssessmentTarget", "primary_assessment_target")],
      ["Substantive definition", pick(m, "substantiveDefinition", "substantive_definition")],
      ["What constitutes evidence", pick(m, "whatConstitutesEvidence", "what_constitutes_evidence")],
      ["What does NOT constitute evidence", pick(m, "whatDoesNotConstituteEvidence", "what_does_not_constitute_evidence")],
      ["Fallback YES criterion", pick(m, "fallbackYesCriterion", "fallback_yes_criterion")],
      ["Positive examples", pick(m, "positiveExamples", "positive_examples")],
      ["Negative examples", pick(m, "negativeExamples", "negative_examples")],
      ["Evidence keywords", pick(m, "evidenceKeywords", "evidence_keywords")],
      ["Expected YES rate", pick(m, "expectedYesRate", "expected_yes_rate")],
      ["Required source types", pick(m, "requiredSourceTypes", "required_source_types")],
      ["Display order", pick(m, "displayOrder", "display_order")],
    ];
    for (const [label, value] of measureFields) {
      const isBlockField = [
        "Definition",
        "Scoring guidance",
        "Substantive definition",
        "What constitutes evidence",
        "What does NOT constitute evidence",
        "Fallback YES criterion",
        "Positive examples",
        "Negative examples",
      ].includes(label);
      if (isBlockField) {
        lines.push(`**${label}:**`);
        lines.push("");
        lines.push(fmtBlock(value));
        lines.push("");
      } else {
        lines.push(`- **${label}**: ${fmtInline(value)}`);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}
