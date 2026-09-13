/**
 * Framework Creation v2 — Stage 2: Chat-driven improvement workflow
 *
 * After Stage 1 has produced a root-cause report + edit proposals, this module
 * runs a focused chat conversation with the LLM to help the user:
 *   1. Understand each root cause in plain English
 *   2. Choose which measure edits to apply
 *   3. Optionally customise the wording of an edit
 *   4. Trigger a re-score against the same test-drive sample
 *
 * The chat prompt is deliberately small and structured. It ALWAYS grounds its
 * reasoning in the actual test-drive data (yes-rate, corpus stats, quotes)
 * rather than free-form speculation. The LLM is instructed to reply in
 * one of two modes:
 *   • DISCUSSION mode — plain-text answer, no actions
 *   • ACTION mode    — one or more structured `<action>` blocks the client
 *                       renders as accept/customise buttons
 *
 * Structured actions the LLM can propose:
 *   apply_edit          — apply a proposed patch (broaden fallback, add examples, etc.)
 *   apply_all_by_cause  — apply every proposal whose cause matches
 *   escalate_to_corpus  — mark a company as doc-collection issue (skip framework edits)
 *   ignore_measure      — user judges the observed low-yes is genuine, not a defect
 *   rescore_now         — trigger fresh scoring against the modified framework
 *
 * The client renders each action as a clickable button. Accepting an action
 * translates into a POST /v2/improvement/apply call server-side.
 */

import type { EditProposal } from "./edit-proposer.js";
import type { RootCauseReport } from "./root-cause-diagnostic.js";
import type { Flag } from "./test-drive.js";

export interface ImprovementChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ImprovementChatContext {
  frameworkName: string;
  topicTerm: string;
  perCompanySummary: Array<{ companyName: string; yesCount: number; yesRate: number }>;
  rootCauses: RootCauseReport | null;
  flags: Flag[];
  proposals: EditProposal[];
  passedRobustnessCriteria: number;
  totalRobustnessCriteria: number;
  terminologyGaps?: Array<{ term: string; companyCount: number; context: string }>;
  vehicleMismatches?: Array<{ measureId: string; expectedVehicles: string[]; observedTypes: string[]; companyName: string }>;
}

/**
 * Build the system prompt that primes the LLM to be a framework-improvement
 * consultant. Grounded in the actual test-drive data so the LLM cannot
 * hallucinate away from the evidence.
 */
export function buildImprovementChatSystemPrompt(ctx: ImprovementChatContext): string {
  const companySummary = ctx.perCompanySummary
    .map((c) => `  - ${c.companyName}: ${c.yesCount} Yes (${(c.yesRate * 100).toFixed(0)}%)`)
    .join("\n");

  const rcSummary = ctx.rootCauses?.summary;
  const companyClassifications = ctx.rootCauses?.companies
    .map((c) => `  - ${c.companyName} [${c.classification}]: ${c.reasoning}`)
    .join("\n") ?? "  (corpus analysis unavailable)";

  const measureIssues = ctx.rootCauses?.measures
    .filter((m) => m.classification !== "healthy")
    .map((m) => `  - ${m.measureId} [${m.classification}]: ${m.reasoning}`)
    .join("\n") ?? "";

  const terminologyGapSection = ctx.terminologyGaps && ctx.terminologyGaps.length > 0
    ? ctx.terminologyGaps.map((t) => `  - "${t.term}" (found in ${t.companyCount} company corpora near topic terms)`).join("\n")
    : "  (none detected or corpus analysis unavailable)";

  const vehicleMismatchSection = ctx.vehicleMismatches && ctx.vehicleMismatches.length > 0
    ? ctx.vehicleMismatches.map((v) =>
        `  - ${v.measureId} for ${v.companyName}: expected [${v.expectedVehicles.join(", ")}], ` +
        `found evidence in [${v.observedTypes.join(", ")}]`
      ).join("\n")
    : "  (none detected or corpus analysis unavailable)";

  const proposalSummary = ctx.proposals
    .map((p, i) => `  [P${i + 1}] measure=${p.measureId} cause=${p.cause} action=${p.action}\n         rationale: ${p.rationale}`)
    .join("\n");

  // Flag summary — includes run-to-run instability (residual-instability),
  // zero-differentiation (no-differentiation) and sparse-corpus flags so the
  // LLM can reason about them. Errors first, then warnings.
  const flagSummary = (ctx.flags && ctx.flags.length > 0)
    ? [...ctx.flags]
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
        .map((f) => `  - [${f.severity}] ${f.rule} (${f.measureId}): ${f.message}\n         fix: ${f.suggestedFix}`)
        .join("\n")
    : "  (none)";

  return `You are a framework-improvement consultant. The user has just tested a CompanyIQ v2 framework called "${ctx.frameworkName}" on ${ctx.perCompanySummary.length} sample companies. Your job is to help them understand the results and decide what to do next.

TEST-DRIVE OUTCOME:
- Robustness criteria passed: ${ctx.passedRobustnessCriteria}/${ctx.totalRobustnessCriteria}
- Root-cause split: ${rcSummary ? `${rcSummary.healthy} healthy companies, ${rcSummary.docCollectionFailures} doc-collection failures, ${rcSummary.frameworkIssues} framework issues, ${rcSummary.ambiguous} ambiguous` : "unavailable"}
- Measures classified as framework fault: ${rcSummary ? rcSummary.deadMeasuresLikelyFrameworkFault : "unavailable"}
- Measures classified as corpus fault: ${rcSummary ? rcSummary.deadMeasuresLikelyCorpusFault : "unavailable"}

PER-COMPANY YES COUNTS:
${companySummary}

PER-COMPANY DIAGNOSTIC:
${companyClassifications}

MEASURES NEEDING ATTENTION:
${measureIssues || "  (none)"}

TEST-DRIVE FLAGS (includes run-to-run instability and zero-differentiation):
${flagSummary}

AVAILABLE EDIT PROPOSALS:
${proposalSummary || "  (none)"}

TERMINOLOGY GAP CANDIDATES:
${terminologyGapSection}

DISCLOSURE VEHICLE OBSERVATIONS:
${vehicleMismatchSection}

CRITICAL RULES FOR YOUR REPLIES:
1. Ground every claim in the data above. Do NOT invent new companies, new measures, or new results.
2. If the user asks about a company classified as "doc-collection-failure", explain that framework edits will not help — the fix is retrieval. Do not propose a measure edit for it.
3. If the user asks about a measure classified as "collection-attributable", explain that the current test-drive cannot judge it — we need a company with strong disclosure on that sub-topic first.
4. Keep answers focused. If the user asks "why did Ambev score 0", one paragraph is enough.
5. When you want the user to take a concrete action, emit a structured action block. Do not describe an action in prose without emitting the block.
6. If you see terminology gap candidates, explain they represent terms companies actually use for this topic that are NOT in the framework's topicSynonyms. Suggest the user add the most relevant ones to improve BM25 retrieval. Emit an <action type="add_synonyms" terms="term1,term2,term3" /> block when suggesting additions.
7. If vehicle mismatches are present, explain that the evidence for a measure was found in document types the framework did not anticipate. Suggest the user consider updating disclosure_vehicles in the measure to include these types, if they are legitimate sources. Use the measure edit system (Re-draft with corrections) to update the measure definition to accept additional vehicle types.
8. If a measure carries a "residual-instability" flag, its verdict changed run-to-run on identical evidence. This is an AMBIGUOUS-DESIGN defect — do NOT suggest re-scoring more times or averaging; live scoring stays single-shot. The fix is to rewrite the deciding criteria to be countable and quote-verifiable (C11): replace degree words with an explicit N-of-M test over named artefacts. Steer the user to Re-draft that measure with a countable rule.
9. If a measure carries a "no-differentiation" flag, it returned the SAME verdict for every company and adds no signal. Explain it must be redesigned to test a discriminating, named artefact so the verdict can vary — not merely re-tuned.
10. If a "sparse-corpus" flag is present, the listed companies appear data-sparse for this topic. Treat their measure flags as likely retrieval failures, not wording problems: advise fixing corpus collection and re-running the test-drive before editing those measures.

ACTION BLOCK SYNTAX:
Emit each action on its own line, exactly as:

  <action type="apply_edit" proposal="P3" />
  <action type="apply_all_by_cause" cause="over-strict-fallback" />
  <action type="escalate_to_corpus" company="Ambev" />
  <action type="ignore_measure" measure="1.6-remuneration-linkage" reason="genuine non-disclosure" />
  <action type="add_synonyms" terms="nature-related risk,biodiversity net gain" />
  <action type="rescore_now" />

Emit blocks ONLY when the user should decide something. Every attribute must reference a real ID from the data above. Do not emit blocks in the middle of your prose — put them at the end.

Reply in plain English. Be direct. If the framework is broadly healthy but the user is confused about one measure or company, focus on that one.`;
}

export interface ExtractedAction {
  type: "apply_edit" | "apply_all_by_cause" | "escalate_to_corpus" | "ignore_measure" | "add_synonyms" | "rescore_now";
  attrs: Record<string, string>;
}

/**
 * Parse assistant reply text and pull out any <action .../> blocks.
 * Returns both the display text (with action blocks stripped) and the
 * structured actions the client should render as buttons.
 */
export function extractActionsFromReply(text: string): { displayText: string; actions: ExtractedAction[] } {
  const actions: ExtractedAction[] = [];
  const actionRe = /<action\s+([^/>]*?)\s*\/>/g;
  let cleaned = text;
  let m: RegExpExecArray | null;
  while ((m = actionRe.exec(text)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const type = attrs.type as ExtractedAction["type"];
    delete attrs.type;
    if (type) actions.push({ type, attrs });
  }
  cleaned = cleaned.replace(actionRe, "").trim();
  return { displayText: cleaned, actions };
}
