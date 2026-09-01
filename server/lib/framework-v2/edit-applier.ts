/**
 * Framework Creation v2 — Stage 2b: LLM-driven measure regeneration.
 *
 * The edit-proposer emits patches of three flavours:
 *   - replace     → direct DB write (already handled in the /apply route)
 *   - regenerate_examples → LLM writes 2-3 new positive/negative examples per measure
 *   - tighten_definition  → LLM rewrites substantive_definition to require named
 *                            methodologies, quantified claims, or specific frameworks
 *   - append_exclusion    → LLM appends an adjacent-topic exclusion clause
 *
 * We batch by patch op + framework context (topicTerm, adjacentTopics) so the
 * LLM sees all relevant measures at once and produces coherent revisions across
 * them. This also gives us global consistency: exclusion clauses share
 * wording, example styles align, etc.
 */
import { completeWithFallback } from "../ai-providers.js";
import type { EditProposal } from "./edit-proposer.js";

export interface FrameworkContext {
  topicTerm: string;
  topicSynonyms?: string[];
  adjacentTopics?: string[];
  frameworkName?: string;
}

export interface MeasureBefore {
  measureId: string;
  title?: string;
  substantive_definition: string;
  fallback_yes_criterion?: string;
  positive_examples?: string[];
  negative_examples?: string[];
}

export interface MeasureAfter {
  measureId: string;
  substantive_definition?: string;
  positive_examples?: string[];
  negative_examples?: string[];
}

export interface RegenerationResult {
  updates: MeasureAfter[];
  raw: string;      // raw LLM output for debugging
  provider: string;
}

/**
 * Rewrite substantive_definition for a batch of measures so each requires
 * named methodologies, quantified claims, or specific frameworks — preserving
 * the ORIGINAL scope of each measure. Returns one revised definition per
 * measure. Never invents new measures.
 */
export async function batchTightenDefinitions(
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  providerName?: string,
): Promise<RegenerationResult> {
  const system = `You are a framework editor. Your job is to REWRITE the substantive_definition of each provided measure so it distinguishes SUBSTANTIVE disclosure (named methodologies, quantified claims, named frameworks/standards, specific programme names) from GENERIC or ASPIRATIONAL language.

Framework context:
- Topic: ${ctx.topicTerm}${ctx.topicSynonyms && ctx.topicSynonyms.length ? ` (synonyms: ${ctx.topicSynonyms.join(", ")})` : ""}
${ctx.adjacentTopics && ctx.adjacentTopics.length ? `- Adjacent topics to exclude: ${ctx.adjacentTopics.join(", ")}` : ""}

CRITICAL RULES:
1. Preserve the ORIGINAL scope of each measure. Do NOT change what the measure is asking about.
2. Add explicit sufficiency conditions in the form: "For Yes, the disclosure must name a specific methodology (e.g. ...), quantify (e.g. ...), or reference a named framework (e.g. ...)."
3. If a measure already has sufficiency conditions, sharpen them; do not duplicate.
4. Keep each definition under 400 characters.
5. Do NOT emit adjacent-topic exclusion clauses here (that is a separate operation).
6. Output MUST be valid JSON in the exact schema below. No prose outside the JSON.

Schema:
{
  "updates": [
    { "measureId": "<id>", "substantive_definition": "<revised definition text>" }
  ]
}`;

  const measureList = measures
    .map((m) => `Measure ${m.measureId} (${m.title || "untitled"}):\n  current substantive_definition: ${JSON.stringify(m.substantive_definition)}`)
    .join("\n\n");

  const prompt = `Please rewrite the substantive_definition of the following ${measures.length} measures per the rules above.\n\n${measureList}\n\nReturn JSON only.`;

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt,
    maxTokens: 24000,
    temperature: 0.15,
  });
  const parsed = safeParseJSON(text);
  const updates: MeasureAfter[] = Array.isArray(parsed?.updates)
    ? parsed.updates
        .filter((u: any) => u && typeof u.measureId === "string" && typeof u.substantive_definition === "string")
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim() }))
    : [];
  return { updates, raw: text, provider };
}

/**
 * Append an adjacent-topic exclusion clause to each measure's
 * substantive_definition. LLM picks the SPECIFIC adjacent topic each measure
 * is contaminated by (evident from the proposals) and appends a "This measure
 * does NOT include X" clause.
 */
export async function batchAppendExclusions(
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  providerName?: string,
): Promise<RegenerationResult> {
  const system = `You are a framework editor. For each provided measure, APPEND ONE exclusion clause to its substantive_definition that names the specific adjacent topic most likely being confused with this measure. Do not restate the definition; only add the clause.

Framework context:
- Topic: ${ctx.topicTerm}
${ctx.adjacentTopics && ctx.adjacentTopics.length ? `- Common adjacent topics: ${ctx.adjacentTopics.join(", ")}` : ""}

CRITICAL RULES:
1. Return the FULL revised substantive_definition (original + appended clause).
2. Use the form: " Evidence of [adjacent topic] does NOT satisfy this measure."
3. Pick ONE adjacent topic per measure, most relevant to that measure's scope.
4. Do not add other content.

Schema: { "updates": [ { "measureId": "<id>", "substantive_definition": "<full revised text>" } ] }`;

  const measureList = measures
    .map((m) => `Measure ${m.measureId} (${m.title || "untitled"}):\n  current substantive_definition: ${JSON.stringify(m.substantive_definition)}`)
    .join("\n\n");

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt: `${measureList}\n\nReturn JSON only.`,
    maxTokens: 16000,
    temperature: 0.15,
  });
  const parsed = safeParseJSON(text);
  const updates: MeasureAfter[] = Array.isArray(parsed?.updates)
    ? parsed.updates
        .filter((u: any) => u && typeof u.measureId === "string" && typeof u.substantive_definition === "string")
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim() }))
    : [];
  return { updates, raw: text, provider };
}

/**
 * Regenerate positive OR negative examples for a batch of measures.
 * `kind` selects which array to write into.
 */
export async function batchRegenerateExamples(
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  kind: "positive" | "negative",
  providerName?: string,
): Promise<RegenerationResult> {
  const system = `You are a framework editor. For each provided measure, produce 2-3 ${kind === "positive" ? "REALISTIC POSITIVE examples of disclosure that clearly satisfy the measure" : "REALISTIC NEGATIVE examples of disclosure that look topic-related but DO NOT satisfy the measure (common false positives)"}.

Framework context: topic = ${ctx.topicTerm}. Framework: ${ctx.frameworkName || "n/a"}.

CRITICAL RULES:
1. Each example should be 100-500 characters, echo real disclosure language, and include specifics (numbers, standard names, dates, geographic scope).
2. ${kind === "positive" ? "The example must clearly satisfy the measure's substantive_definition." : "The example must LOOK topic-related but fail the measure (e.g. mentions the topic but no methodology, or applies to an adjacent topic, or is aspirational-only)."}
3. Return valid JSON with the exact schema below. No prose outside the JSON.

Schema: { "updates": [ { "measureId": "<id>", "${kind}_examples": ["ex1", "ex2", "ex3"] } ] }`;

  const measureList = measures
    .map((m) => `Measure ${m.measureId} (${m.title || "untitled"}):\n  substantive_definition: ${JSON.stringify(m.substantive_definition)}\n  existing ${kind}_examples count: ${(kind === "positive" ? m.positive_examples : m.negative_examples)?.length || 0}`)
    .join("\n\n");

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt: `${measureList}\n\nReturn JSON only.`,
    maxTokens: 24000,
    temperature: 0.25,
  });
  const parsed = safeParseJSON(text);
  const key = kind === "positive" ? "positive_examples" : "negative_examples";
  const updates: MeasureAfter[] = Array.isArray(parsed?.updates)
    ? parsed.updates
        .filter((u: any) => u && typeof u.measureId === "string" && Array.isArray(u[key]))
        .map((u: any) => ({ measureId: u.measureId, [key]: u[key].map((s: any) => String(s).trim()).filter(Boolean) }))
    : [];
  return { updates, raw: text, provider };
}

// Robust JSON parse that strips code fences and trailing junk.
function safeParseJSON(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(trimmed); } catch { /* fallthrough */ }
  // Extract first {...} block if the model added prose
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}

/**
 * Group proposals by their patch op + path so we can call the batch regenerator
 * once per group. Returns { key: proposals[] }.
 * Key format: "<op>::<path>"
 */
export function groupProposalsByPatch(proposals: EditProposal[]): Record<string, EditProposal[]> {
  const groups: Record<string, EditProposal[]> = {};
  for (const p of proposals) {
    const key = `${p.patch?.op || "unknown"}::${p.patch?.path || "unknown"}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }
  return groups;
}
