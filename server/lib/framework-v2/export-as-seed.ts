/**
 * Framework Creation v2 — Export existing framework as build seed
 *
 * Produces the Part 0 initial-input template from an existing framework so
 * the user can seed a new build. Deliberately does NOT carry over:
 *   - Individual measure titles, definitions, drafts
 *   - Adjacent topics (should be reviewed fresh)
 *   - Sub-area structure (may need reconsidering)
 *   - Coverage whitelists, fallback conditions
 *
 * Carries over:
 *   - Topic, topic term, topic synonyms (as starting point)
 *   - Entity type, sector scope, universe, reporting period
 *   - Anchor frameworks
 *   - Sensitivity preference
 *   - Aggregate positive/negative examples (top few, deduplicated)
 */

import type { Framework, FrameworkMeasure } from "../../../shared/schema.js";

export interface ExistingFrameworkForExport {
  framework: Framework & {
    // v2-extended fields, if present
    topicTerm?: string;
    topicSynonyms?: string[];
    adjacentTopics?: Array<{ name: string; example_phrases?: string[] }>;
    anchorFrameworks?: Array<{ name: string; source?: string }>;
    entityType?: string;
    sectorScope?: string;
    universe?: string;
    reportingPeriod?: string;
    sensitivityPreference?: "precision" | "recall" | "balanced";
  };
  measures: Array<
    FrameworkMeasure & {
      positive_examples?: string[];
      negative_examples?: string[];
    }
  >;
}

export function exportFrameworkAsSeedTemplate(
  input: ExistingFrameworkForExport,
): string {
  const fw = input.framework;
  const measures = input.measures || [];

  // Aggregate examples (dedupe, take top 3 each)
  const posSet = new Set<string>();
  const negSet = new Set<string>();
  for (const m of measures) {
    for (const p of m.positive_examples || []) if (p) posSet.add(p);
    for (const n of m.negative_examples || []) if (n) negSet.add(n);
  }
  const topPos = Array.from(posSet).slice(0, 3);
  const topNeg = Array.from(negSet).slice(0, 3);

  const topicSection = fw.topicDescription
    ? fw.topicDescription
    : fw.topicTerm
      ? `(Topic term: ${fw.topicTerm}${fw.topicSynonyms && fw.topicSynonyms.length ? `; synonyms: ${fw.topicSynonyms.join(", ")}` : ""})\n\nDescribe the topic in your own words in 2–5 sentences. What makes it distinct from adjacent topics?`
      : "Describe the topic in 2–5 sentences.";

  const scopeLines: string[] = [];
  scopeLines.push(`- Entity type: [${fw.entityType || "listed companies"}]`);
  scopeLines.push(`- Sector scope: [${fw.sectorScope || "agnostic"}]`);
  scopeLines.push(`- Universe: [${fw.universe || "global"}]`);
  scopeLines.push(`- Reporting period: [${fw.reportingPeriod || "last 3 years, most recent preferred"}]`);
  scopeLines.push(`- Explicit exclusions: []`);

  const anchorLines = (fw.anchorFrameworks || []).map((a) => `  - ${a.name}${a.source ? ` (${a.source})` : ""}`);

  const posLines = topPos.map((p) => `  - ${JSON.stringify(p)}`);
  const negLines = topNeg.map((n) => `  - ${JSON.stringify(n)}`);

  const sensitivity = fw.sensitivityPreference || "balanced";

  return `# Framework build brief — seeded from ${fw.name} v${fw.version}

_Seed generated from existing framework "${fw.name}". Deliberately excludes individual measure drafts and adjacent topics; review these fresh in the new build._

## 1. Topic
${topicSection}

## 2. Purpose
_(1–3 sentences. Why are you building this framework? What decision will it support?)_

## 3. Entity scope
${scopeLines.join("\n")}

## 4. Evidence anchors (all optional)
- Authoritative standards or regulations:
${anchorLines.length ? anchorLines.join("\n") : "  - _(list any that come to mind, else leave blank)_"}
- Peer methodologies or benchmarks:
- Example disclosures that would clearly count as evidence:
${posLines.length ? posLines.join("\n") : "  - _(2–4 examples, verbatim if possible, else paraphrased)_"}
- Example disclosures that would LOOK convincing but should NOT count:
${negLines.length ? negLines.join("\n") : "  - _(2–4 adversarial examples — this is the most valuable input for preventing false positives)_"}

## 5. Sensitivity and priorities
- Overall preference: [${sensitivity}]
- Practices or disclosures that MUST be captured:
- Practices or disclosures that MUST NOT be treated as evidence:
- Guardrails — decisions the framework must NOT infer:
`;
}
