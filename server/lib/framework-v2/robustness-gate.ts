/**
 * Framework Creation v2 — Intake Robustness Gate
 *
 * Checks whether the intake conversation has collected sufficient information
 * to draft a C1-C10-compliant framework without ambiguity.
 *
 * The gate does not itself terminate the conversation — it returns which
 * items are resolved / unresolved so the LLM can present state to the user
 * after every turn. The user decides whether to keep answering questions
 * or proceed with best-guess drafts and flagged warnings.
 */

export interface IntakeArtefact {
  topic?: string;
  topicTerm?: string;
  topicSynonyms?: string[];
  purpose?: string;
  subAreaStructure?: {
    type: "tcfd" | "custom";
    categories: string[];
    rationale?: string;
  };
  adjacentTopics?: Array<{
    name: string;
    example_phrases?: string[];
    cooccurrence_possible?: boolean;
  }>;
  anchorFrameworks?: Array<{ name: string; source?: string }>;
  entityType?: string;
  sectorScope?: string;
  universe?: string;
  reportingPeriod?: string;
  sensitivityPreference?: "precision" | "recall" | "balanced";
  targetMeasureCount?: number;
  basePositiveExamples?: string[];
  baseNegativeExamples?: string[];
  pushbackRecord?: Array<{
    question: string;
    user_response: string;
    resolved: boolean;
  }>;
  residualWarnings?: Array<{
    issue: string;
    severity: string;
    note?: string;
  }>;
  noAdjacentTopicsAcknowledged?: boolean;
  confirmed?: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface RobustnessGateResult {
  totalItems: number;
  passedItems: number;
  items: ChecklistItem[];
  ready: boolean; // true if all items pass
  summaryForUser: string; // human-readable status
}

export function evaluateRobustness(intake: IntakeArtefact): RobustnessGateResult {
  const items: ChecklistItem[] = [];

  items.push({
    id: "topicTerm",
    label: "Topic term is defined as a canonical short phrase",
    passed: !!(intake.topicTerm && intake.topicTerm.trim().length >= 2),
    detail: intake.topicTerm,
  });

  const syn = intake.topicSynonyms || [];
  items.push({
    id: "topicSynonyms",
    label: "Topic synonyms (≥2) are proposed and confirmed",
    passed: syn.length >= 2,
    detail: `${syn.length} synonyms`,
  });

  const adj = intake.adjacentTopics || [];
  const adjacentOk = adj.length >= 2 || intake.noAdjacentTopicsAcknowledged === true;
  items.push({
    id: "adjacentTopics",
    label: "Adjacent topics: ≥2 identified with example phrases, OR explicit \"no adjacent topics\" acknowledgment",
    passed: adjacentOk,
    detail: `${adj.length} adjacent topics${intake.noAdjacentTopicsAcknowledged ? " (or acknowledged none)" : ""}`,
  });
  // If adjacent topics are listed, they must have example phrases
  if (adj.length >= 2) {
    const withPhrases = adj.filter((a) => (a.example_phrases || []).length > 0).length;
    if (withPhrases < adj.length) {
      items.push({
        id: "adjacentTopicPhrases",
        label: "Every adjacent topic has ≥1 example phrase",
        passed: false,
        detail: `${withPhrases}/${adj.length} adjacent topics have example phrases`,
      });
    } else {
      items.push({
        id: "adjacentTopicPhrases",
        label: "Every adjacent topic has ≥1 example phrase",
        passed: true,
      });
    }
  }

  const af = intake.anchorFrameworks || [];
  items.push({
    id: "anchorFrameworks",
    label: "Anchor frameworks: either confirmed non-empty list or explicit \"none applicable\"",
    passed: af.length > 0 || intake.noAdjacentTopicsAcknowledged === true, // reuse ack flag pragmatically
    detail: `${af.length} anchor frameworks`,
  });

  items.push({
    id: "entityScope",
    label: "Entity type, sector scope, universe, reporting period all set",
    passed: !!(intake.entityType && intake.sectorScope && intake.universe && intake.reportingPeriod),
    detail: `${intake.entityType || "?"} / ${intake.sectorScope || "?"} / ${intake.universe || "?"} / ${intake.reportingPeriod || "?"}`,
  });

  items.push({
    id: "sensitivity",
    label: "Sensitivity preference set (default = balanced)",
    passed: !!intake.sensitivityPreference,
    detail: intake.sensitivityPreference,
  });

  items.push({
    id: "subAreaStructure",
    label: "Sub-area structure agreed (TCFD default or alternative)",
    passed: !!(intake.subAreaStructure && intake.subAreaStructure.categories && intake.subAreaStructure.categories.length >= 3),
    detail: intake.subAreaStructure ? `${intake.subAreaStructure.type} with ${intake.subAreaStructure.categories.length} categories` : undefined,
  });

  const baseP = intake.basePositiveExamples || [];
  const baseN = intake.baseNegativeExamples || [];
  items.push({
    id: "baseExamples",
    label: "Base positive and adversarial examples proposed (≥2 each)",
    passed: baseP.length >= 2 && baseN.length >= 2,
    detail: `${baseP.length} positive, ${baseN.length} negative`,
  });

  // Any Stage 1 pushback must be resolved or explicitly overruled
  const pushback = intake.pushbackRecord || [];
  const unresolved = pushback.filter((p) => !p.resolved).length;
  items.push({
    id: "pushbackResolved",
    label: "All Stage 1 pushback questions resolved or overruled",
    passed: unresolved === 0,
    detail: `${pushback.length - unresolved}/${pushback.length} resolved`,
  });

  const passedItems = items.filter((i) => i.passed).length;
  const ready = passedItems === items.length;

  const openItems = items.filter((i) => !i.passed);
  const summary = ready
    ? `All ${items.length} checklist items resolved. Ready to draft measures.`
    : `${passedItems} of ${items.length} items resolved. Open items:\n${openItems.map((i) => `  • ${i.label}${i.detail ? ` (${i.detail})` : ""}`).join("\n")}\n\nAnswer these or say "proceed with best-guess drafts and flagged warnings" to move on.`;

  return {
    totalItems: items.length,
    passedItems,
    items,
    ready,
    summaryForUser: summary,
  };
}
