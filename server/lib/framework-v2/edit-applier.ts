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
import {
  STRUCTURED_GUIDANCE_REGEN_INSTRUCTION,
  STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT,
  normaliseStructuredGuidance,
  type StructuredGuidance,
} from "./structured-guidance.js";

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
  // The measure's current scoring_guidance (TEXT column) — threaded through so a
  // regenerator's freshly authored structured fields can be merged onto it
  // additively rather than blanking prior guidance. Optional/back-compat.
  scoring_guidance?: string;
}

export interface MeasureAfter {
  measureId: string;
  substantive_definition?: string;
  positive_examples?: string[];
  negative_examples?: string[];
  // Freshly authored structured scoring_guidance fields (only the fields the LLM
  // actually returned; a Partial). Undefined when the regenerator does not author
  // guidance or the LLM omitted it. The caller merges this into the measure's
  // existing scoring_guidance via mergeStructuredIntoScoringGuidance().
  scoring_guidance?: Partial<StructuredGuidance>;
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

${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}

Schema:
{
  "updates": [
    { "measureId": "<id>", "substantive_definition": "<revised definition text>", ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT} }
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
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim(), scoring_guidance: normaliseStructuredGuidance(u.scoring_guidance) ?? undefined }))
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

${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}

Schema: { "updates": [ { "measureId": "<id>", "substantive_definition": "<full revised text>", ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT} } ] }`;

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
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim(), scoring_guidance: normaliseStructuredGuidance(u.scoring_guidance) ?? undefined }))
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

/**
 * C11 decidability rewrite. Rewrite substantive_definition for a batch of
 * measures so the DECIDING criteria are countable / quote-verifiable — an
 * explicit N-of-M test over NAMED artefacts rather than a matter of degree.
 * This is the design-time fix for run-to-run verdict instability: it removes
 * the judgment-word ambiguity that makes two passes split on the same anchor
 * sentence. Preserves each measure's original scope; never introduces
 * live-scoring sampling.
 *
 * The spec text below is the canonical DECIDABLE THRESHOLD rule used at
 * intake-drafting time (intake-prompt.ts), reproduced here so rewrites match
 * the wording measures are first drafted against. It is topic-agnostic.
 */
export async function batchRewriteCountable(
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  providerName?: string,
): Promise<RegenerationResult> {
  const system = `You are a framework editor. Your job is to REWRITE the substantive_definition of each provided measure so its DECIDING criteria are countable and quote-verifiable — decidable true/false from a single verbatim quote — rather than a matter of degree.

Framework context:
- Topic: ${ctx.topicTerm}${ctx.topicSynonyms && ctx.topicSynonyms.length ? ` (synonyms: ${ctx.topicSynonyms.join(", ")})` : ""}
${ctx.adjacentTopics && ctx.adjacentTopics.length ? `- Adjacent topics to exclude: ${ctx.adjacentTopics.join(", ")}` : ""}

DECIDABLE THRESHOLD (each Yes-condition must be countable from a verbatim quote):
- Do NOT phrase any Yes-condition as a matter of DEGREE. Forbidden judgment words include: substantive, substantially, systematic, integrated, integration, sufficient, robust, meaningful, adequate, appropriate, comprehensive, holistic, effective, strong, well-developed. Two scoring models read the same anchor sentence and split on whether it clears a degree bar — that produces run-to-run verdict flips.
- Write every condition as a COUNTABLE / NAMED test that a reader can verify true or false from a single verbatim quote: a named body, a named document/register/process step, a quantified or dated metric, an explicit percentage/threshold, or a named framework alignment.
- When a substantive/quality bar is genuinely unavoidable, express it as an explicit N-of-M test over NAMED artefacts rather than as a judgment word. Format: "Yes if at least N of the following NAMED artefacts are present in a verbatim quote: (a) …, (b) …, (c) …". Each artefact must be individually checkable from the quote.

CRITICAL RULES:
1. Preserve the ORIGINAL scope of each measure. Do NOT change what the measure is asking about.
2. Rewrite ONLY the deciding rule into the countable N-of-M form above; keep any existing adjacent-topic exclusion clause intact.
3. Keep each definition under 600 characters.
4. Output MUST be valid JSON in the exact schema below. No prose outside the JSON.

${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}

Schema: { "updates": [ { "measureId": "<id>", "substantive_definition": "<revised definition text>", ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT} } ] }`;

  const measureList = measures
    .map((m) => `Measure ${m.measureId} (${m.title || "untitled"}):\n  current substantive_definition: ${JSON.stringify(m.substantive_definition)}`)
    .join("\n\n");

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt: `Please rewrite the deciding criteria of the following ${measures.length} measures into a countable, quote-verifiable N-of-M test over named artefacts, per the rules above.\n\n${measureList}\n\nReturn JSON only.`,
    maxTokens: 24000,
    temperature: 0.15,
  });
  const parsed = safeParseJSON(text);
  const updates: MeasureAfter[] = Array.isArray(parsed?.updates)
    ? parsed.updates
        .filter((u: any) => u && typeof u.measureId === "string" && typeof u.substantive_definition === "string")
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim(), scoring_guidance: normaliseStructuredGuidance(u.scoring_guidance) ?? undefined }))
    : [];
  return { updates, raw: text, provider };
}

/**
 * Redefine non-discriminating measures. A measure that hands the SAME verdict to
 * every scored company carries no signal. Rewrite its substantive_definition to
 * test a NAMED, quote-verifiable artefact that only SOME companies disclose, so
 * the verdict can vary across companies. Preserves the measure's topic scope.
 */
export async function batchBroadenOrRedefine(
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  providerName?: string,
): Promise<RegenerationResult> {
  const system = `You are a framework editor. Each provided measure currently returns the SAME verdict for every company — it does not discriminate. REWRITE the substantive_definition of each so it tests a NAMED, quote-verifiable artefact that only SOME entities in this topic disclose, restoring the measure's power to separate companies.

Framework context:
- Topic: ${ctx.topicTerm}${ctx.topicSynonyms && ctx.topicSynonyms.length ? ` (synonyms: ${ctx.topicSynonyms.join(", ")})` : ""}
${ctx.adjacentTopics && ctx.adjacentTopics.length ? `- Adjacent topics to exclude: ${ctx.adjacentTopics.join(", ")}` : ""}

CRITICAL RULES:
1. Preserve the measure's TOPIC scope — redefine the deciding artefact, not the subject of the measure.
2. Anchor the Yes-condition on a specific, named, quote-verifiable artefact (a named programme, a quantified/dated metric, a named governance body, an explicit threshold) that is realistically disclosed by SOME but not all entities — not a near-universal boilerplate statement.
3. Keep the criteria countable and decidable from a single verbatim quote (no degree words: substantive, robust, meaningful, adequate, comprehensive, etc.).
4. Keep any existing adjacent-topic exclusion clause intact. Keep each definition under 600 characters.
5. Output MUST be valid JSON in the exact schema below. No prose outside the JSON.

${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}

Schema: { "updates": [ { "measureId": "<id>", "substantive_definition": "<revised definition text>", ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT} } ] }`;

  const measureList = measures
    .map((m) => `Measure ${m.measureId} (${m.title || "untitled"}):\n  current substantive_definition: ${JSON.stringify(m.substantive_definition)}`)
    .join("\n\n");

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt: `Please redefine the following ${measures.length} non-discriminating measures around a named, discriminating artefact per the rules above.\n\n${measureList}\n\nReturn JSON only.`,
    maxTokens: 24000,
    temperature: 0.2,
  });
  const parsed = safeParseJSON(text);
  const updates: MeasureAfter[] = Array.isArray(parsed?.updates)
    ? parsed.updates
        .filter((u: any) => u && typeof u.measureId === "string" && typeof u.substantive_definition === "string")
        .map((u: any) => ({ measureId: u.measureId, substantive_definition: u.substantive_definition.trim(), scoring_guidance: normaliseStructuredGuidance(u.scoring_guidance) ?? undefined }))
    : [];
  return { updates, raw: text, provider };
}

// ─── Near-duplicate resolution (spec §4.2) ─────────────────────────────────
// The user resolves a near-duplicate pair either by MERGING (retire one measure,
// keep the other — count changes; the route keeps framework_measures rows and
// measure_scores consistent) or by DIFFERENTIATING (rewrite one measure's
// substantive_definition so it tests a distinct artefact from its twin).

/**
 * Rewrite `target`'s substantive_definition so it tests something `other` does
 * NOT, breaking a near-duplicate pair without removing either measure.
 */
export async function differentiateMeasureDefinition(
  target: MeasureBefore,
  other: MeasureBefore,
  ctx: FrameworkContext,
  providerName?: string,
): Promise<{ value: string | null; scoringGuidance?: Partial<StructuredGuidance>; raw: string; provider: string }> {
  const system = `You are a framework editor. Two measures in this framework are near-duplicates — they give the same verdict to most companies. REWRITE the substantive_definition of the TARGET measure so it tests a DISTINCT, named, quote-verifiable artefact that the OTHER measure does not, so the two measures stop overlapping.

Framework context:
- Topic: ${ctx.topicTerm}${ctx.adjacentTopics && ctx.adjacentTopics.length ? `\n- Adjacent topics to exclude: ${ctx.adjacentTopics.join(", ")}` : ""}

CRITICAL RULES:
1. Keep the TARGET within the framework's topic scope; sharpen it onto an artefact the OTHER measure does not already cover.
2. Keep criteria countable and decidable from a single verbatim quote (no degree words).
3. Do not modify the OTHER measure. Keep the definition under 600 characters.

${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}

4. Output MUST be valid JSON: { "substantive_definition": "<revised target definition>", ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT} }`;

  const prompt = `TARGET measure ${target.measureId} (${target.title || "untitled"}):\n  substantive_definition: ${JSON.stringify(target.substantive_definition)}\n\nOTHER measure ${other.measureId} (${other.title || "untitled"}):\n  substantive_definition: ${JSON.stringify(other.substantive_definition)}\n\nReturn JSON only.`;

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt,
    maxTokens: 4000,
    temperature: 0.2,
  });
  const parsed = safeParseJSON(text);
  const value = parsed && typeof parsed.substantive_definition === "string" ? parsed.substantive_definition.trim() : null;
  const scoringGuidance = normaliseStructuredGuidance(parsed?.scoring_guidance) ?? undefined;
  return { value, scoringGuidance, raw: text, provider };
}

// ─── Framework-level candidate generation (design-time mining) ─────────────
// These two generators support the framework-level improvement proposals
// (adjacent_topics, anchor_frameworks). They read a BOUNDED corpus sample and
// return a list of candidate strings the caller filters against what is already
// registered and hands to the edit-proposer builders. They are DESIGN-TIME only
// (results panel / apply derivation), never part of live scoring, and the caller
// treats any failure as non-fatal (zero candidates). Both are topic-agnostic:
// the topic, its synonyms and the already-registered lists come from ctx.

/**
 * From a bounded corpus sample, name the NEIGHBOURING subject areas that sit
 * next to the framework's topic and are most likely to be mistaken for it
 * (adjacent-topic contamination). Excludes the topic itself and anything
 * already registered as an adjacent topic. Returns de-duplicated phrases.
 */
export async function generateAdjacentTopicCandidates(
  corpusSample: string,
  ctx: FrameworkContext,
  providerName?: string,
): Promise<string[]> {
  if (!corpusSample || !corpusSample.trim()) return [];
  const already = (ctx.adjacentTopics && ctx.adjacentTopics.length)
    ? ctx.adjacentTopics.join(", ")
    : "(none registered yet)";
  const system = `You are a framework analyst. Given a sample of company disclosures and a TOPIC, identify NEIGHBOURING subject areas ("adjacent topics") that appear in the corpus, are distinct from the topic, and are commonly CONFUSED with it — i.e. text about them could be misread as being about the topic.

Topic: ${ctx.topicTerm}${ctx.topicSynonyms && ctx.topicSynonyms.length ? ` (synonyms: ${ctx.topicSynonyms.join(", ")})` : ""}
Already-registered adjacent topics (do NOT repeat these): ${already}

CRITICAL RULES:
1. Return SHORT noun phrases (2-5 words) naming a distinct adjacent subject area, using the corpus's own terminology.
2. Do NOT return the topic itself, its synonyms, or already-registered adjacent topics.
3. Only include an adjacent topic if the corpus actually contains text about it. Return at most 8.
4. Output MUST be valid JSON in exactly this schema, no prose outside it:
{ "adjacent_topics": ["phrase 1", "phrase 2"] }`;

  try {
    const { text } = await completeWithFallback(providerName || "claude", {
      system,
      prompt: `Corpus sample:\n\n${corpusSample}\n\nReturn JSON only.`,
      maxTokens: 1200,
      temperature: 0.2,
    });
    const parsed = safeParseJSON(text);
    return normaliseStringList(parsed?.adjacent_topics);
  } catch {
    return [];
  }
}

/**
 * From a bounded corpus sample, name the external STANDARDS / FRAMEWORKS /
 * CERTIFICATIONS that the corpus references for this topic (e.g. named
 * standards, regulations, certification schemes). Excludes anything already
 * registered as an anchor framework. Returns de-duplicated names. ADD-only —
 * this never suggests removing an existing anchor.
 */
export async function generateAnchorFrameworkCandidates(
  corpusSample: string,
  ctx: FrameworkContext,
  providerName?: string,
): Promise<string[]> {
  if (!corpusSample || !corpusSample.trim()) return [];
  const system = `You are a framework analyst. Given a sample of company disclosures and a TOPIC, identify the external STANDARDS, FRAMEWORKS, REGULATIONS or CERTIFICATION SCHEMES the corpus explicitly references in connection with this topic. These are named, recognised anchors companies align to.

Topic: ${ctx.topicTerm}${ctx.topicSynonyms && ctx.topicSynonyms.length ? ` (synonyms: ${ctx.topicSynonyms.join(", ")})` : ""}

CRITICAL RULES:
1. Return the OFFICIAL name (and common acronym if used) of each standard/framework/regulation/certification, exactly as evidenced in the corpus.
2. Only include a name if it is explicitly present in the sample text. Do NOT invent or infer well-known standards that are not actually cited.
3. Return at most 8, most-frequently-cited first.
4. Output MUST be valid JSON in exactly this schema, no prose outside it:
{ "anchor_frameworks": ["Name 1", "Name 2"] }`;

  try {
    const { text } = await completeWithFallback(providerName || "claude", {
      system,
      prompt: `Corpus sample:\n\n${corpusSample}\n\nReturn JSON only.`,
      maxTokens: 1200,
      temperature: 0.1,
    });
    const parsed = safeParseJSON(text);
    return normaliseStringList(parsed?.anchor_frameworks);
  } catch {
    return [];
  }
}

function normaliseStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s || s.length > 120) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ─── Free-text ("custom") field edit (requirement C) ───────────────────────
// A user can describe ANY concrete change to a measure in the improvement chat.
// The change is executed as a single-field regeneration: the LLM rewrites the
// named field for the named measure per the user's instruction. This is the
// generic escape hatch that guarantees a described edit always produces an
// executable result — no described edit is left in prose.

export const CUSTOM_EDIT_FIELDS = [
  "substantive_definition",
  "fallback_yes_criterion",
  "positive_examples",
  "negative_examples",
  "expected_yes_rate",
  "min_quote_context_chars",
] as const;
export type CustomEditField = (typeof CUSTOM_EDIT_FIELDS)[number];

export interface CustomEditMeasure extends MeasureBefore {
  expected_yes_rate?: number;
  min_quote_context_chars?: number;
}

/**
 * Regenerate ONE field of ONE measure per a free-text user instruction.
 * Returns the new value (typed per field) plus the raw LLM output. The caller
 * validates the field name against CUSTOM_EDIT_FIELDS, persists, and reports the
 * before/after diff. Never invents new measures or touches other fields.
 */
export async function regenerateMeasureField(
  measure: CustomEditMeasure,
  field: CustomEditField,
  instruction: string,
  ctx: FrameworkContext,
  providerName?: string,
): Promise<{ value: any; scoringGuidance?: Partial<StructuredGuidance>; raw: string; provider: string }> {
  const isArrayField = field === "positive_examples" || field === "negative_examples";
  const isNumberField = field === "expected_yes_rate" || field === "min_quote_context_chars";
  // Only when the deciding criteria (substantive_definition) are rewritten do we
  // also re-author the structured scoring_guidance in the SAME call — no extra
  // round-trip. Other fields (examples, rates) leave scoring_guidance untouched.
  const authorGuidance = field === "substantive_definition";
  const guidanceInstruction = authorGuidance ? `\n\n${STRUCTURED_GUIDANCE_REGEN_INSTRUCTION}` : "";
  const guidanceSchema = authorGuidance ? `, ${STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT}` : "";
  const valueShape = isArrayField
    ? `an array of 2-4 strings (each 100-500 chars, echoing real disclosure language)`
    : isNumberField
      ? (field === "expected_yes_rate" ? `a number between 0 and 1 (a probability)` : `a positive integer (a character count)`)
      : `a single string`;

  const current =
    field === "positive_examples" ? measure.positive_examples :
    field === "negative_examples" ? measure.negative_examples :
    field === "fallback_yes_criterion" ? measure.fallback_yes_criterion :
    field === "expected_yes_rate" ? measure.expected_yes_rate :
    field === "min_quote_context_chars" ? measure.min_quote_context_chars :
    measure.substantive_definition;

  const system = `You are a framework editor. Apply the user's requested change to ONE field of ONE measure and return the new value. Change ONLY the "${field}" field. Do not alter the measure's topic scope beyond what the instruction asks.

Framework context: topic = ${ctx.topicTerm}${ctx.adjacentTopics && ctx.adjacentTopics.length ? `; adjacent topics to exclude: ${ctx.adjacentTopics.join(", ")}` : ""}.

RULES:
1. Honour the user's instruction precisely; keep the measure decidable from a verbatim quote (avoid degree words for deciding criteria).
2. The value for "${field}" must be ${valueShape}.${guidanceInstruction}
3. Output MUST be valid JSON in exactly this schema, with no prose outside it: { "value": <new value for ${field}>${guidanceSchema} }`;

  const prompt = `Measure ${measure.measureId} (${measure.title || "untitled"}).
Field to edit: ${field}
Current value: ${JSON.stringify(current ?? null)}
Other context — substantive_definition: ${JSON.stringify(measure.substantive_definition)}

User instruction: ${instruction}

Return JSON only.`;

  const { text, provider } = await completeWithFallback(providerName || "claude", {
    system,
    prompt,
    maxTokens: 8000,
    temperature: 0.2,
  });
  const parsed = safeParseJSON(text);
  let value: any = parsed ? parsed.value : undefined;
  // Coerce/validate per field type.
  if (isArrayField) {
    value = Array.isArray(value) ? value.map((s: any) => String(s).trim()).filter(Boolean) : null;
    if (Array.isArray(value) && value.length === 0) value = null;
  } else if (field === "expected_yes_rate") {
    const n = typeof value === "number" ? value : parseFloat(String(value));
    value = Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  } else if (field === "min_quote_context_chars") {
    const n = typeof value === "number" ? value : parseInt(String(value), 10);
    value = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } else {
    value = typeof value === "string" ? value.trim() : (value == null ? null : String(value).trim());
    if (value === "") value = null;
  }
  const scoringGuidance = authorGuidance ? (normaliseStructuredGuidance(parsed?.scoring_guidance) ?? undefined) : undefined;
  return { value, scoringGuidance, raw: text, provider };
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

// ─── Apply registry (single source of truth for the apply path + guardrail) ──
// Every batched LLM regeneration is keyed by "<patch.op>::<patch.path>" — the
// same key groupProposalsByPatch() produces. runBatchedRegenerations() looks the
// group up here instead of a hardcoded if/else chain, so adding a proposer op
// only requires adding a registry entry. The guardrail test enumerates every op
// the proposer can emit and asserts each is reachable through APPLY_HANDLED_OPS.

export type BatchRegenerator = (
  measures: MeasureBefore[],
  ctx: FrameworkContext,
  providerName?: string,
) => Promise<RegenerationResult>;

export const BATCH_REGENERATORS: Record<string, BatchRegenerator> = {
  "tighten_definition::substantive_definition": (m, ctx, p) => batchTightenDefinitions(m, ctx, p),
  "append_exclusion::substantive_definition": (m, ctx, p) => batchAppendExclusions(m, ctx, p),
  "regenerate_examples::positive_examples": (m, ctx, p) => batchRegenerateExamples(m, ctx, "positive", p),
  "regenerate_examples::negative_examples": (m, ctx, p) => batchRegenerateExamples(m, ctx, "negative", p),
  "rewrite_countable::substantive_definition": (m, ctx, p) => batchRewriteCountable(m, ctx, p),
  "broaden_or_redefine::substantive_definition": (m, ctx, p) => batchBroadenOrRedefine(m, ctx, p),
};

/**
 * How each proposer patch.op is applied. Consumed by the guardrail test as the
 * authoritative "is this op wired?" map, and self-documenting for readers.
 *   direct_replace   — written straight to a DB column in the /apply route
 *   batch_regenerate — LLM regeneration via BATCH_REGENERATORS (one or more keys)
 *   pair_resolve     — near-duplicate merge/differentiate, handled in the route
 */
export type ApplyHandlerKind = "direct_replace" | "batch_regenerate" | "pair_resolve";

export const APPLY_HANDLED_OPS: Record<string, ApplyHandlerKind> = {
  replace: "direct_replace",
  regenerate_examples: "batch_regenerate",
  tighten_definition: "batch_regenerate",
  append_exclusion: "batch_regenerate",
  rewrite_countable: "batch_regenerate",
  broaden_or_redefine: "batch_regenerate",
  merge_or_differentiate: "pair_resolve",
  // Per-measure calibration/annotation ops. Written straight to a
  // framework_measures column by applyProposal() in the /apply route (no LLM
  // regeneration): set_expected_yes_rate updates expected_yes_rate to the observed
  // rate; flag_non_discriminating sets the soft flagged_non_discriminating boolean.
  set_expected_yes_rate: "direct_replace",
  flag_non_discriminating: "direct_replace",
  // Framework-level additive ops. Each appends mined values to a jsonb column on
  // `frameworks` (topic_synonyms / adjacent_topics / anchor_frameworks). They are
  // written directly by applyFrameworkLevelProposal() in the /apply route — a
  // DISTINCT jsonb append, not a per-measure column write — so they classify as
  // direct_replace (no LLM regeneration on apply). The candidate MINING that
  // feeds their patch.value happens at derivation time, not here.
  add_synonyms: "direct_replace",
  add_adjacent_topics: "direct_replace",
  add_anchor_frameworks: "direct_replace",
};
