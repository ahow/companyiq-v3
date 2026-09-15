// ─── Shared rubric-tightening STRUCTURED scoring_guidance contract ───────────
//
// SINGLE SOURCE OF TRUTH for the four per-measure structured fields the framework
// builder authors inside each measure's `scoring_guidance`:
//   - qualifyingInstance : positive definition of what SPECIFICALLY counts
//   - disqualifiers      : generic/aspirational/forward-looking mentions that do NOT count
//   - anchors            : EXACTLY one canonical Yes + one canonical No (NEVER a Partial)
//   - yesRequiresQuote   : the Yes-requires-a-verbatim-quote precondition line
//
// The CREATE path (server/routes/framework-builder.ts), the INTAKE/DRAFT path
// (server/lib/framework-v2/intake-prompt.ts) and the REFINE/regeneration path
// (server/lib/framework-v2/edit-applier.ts) all reference the ONE authoring
// definition below, and the refine path uses `normaliseStructuredGuidance` +
// `mergeStructuredIntoScoringGuidance` here to persist what it authors. The scorer
// (server/lib/analyzer.ts) and the audit (server/lib/framework-guidance-audit.ts)
// parse these fields via `extractGuidanceObject`, so the shapes produced here MUST
// stay parseable by that tolerant extractor (pure JSON object, ```json fence, or a
// trailing balanced {...} blob).
//
// GENERIC: nothing here is framework/measure/company-specific. All content is
// derived per measure by the LLM from that measure's own definition.

import { extractGuidanceObject, stripStructuredGuidanceBlock } from "../framework-guidance-audit.js";

export interface StructuredGuidance {
  qualifyingInstance: string;
  disqualifiers: string[];
  anchors: { yes: string; no: string };
  yesRequiresQuote: string;
}

// Canonical, generic description of the four fields + their rules. Reused by the
// authoring prompts so create / intake / refine share ONE definition. Topic-agnostic.
export const STRUCTURED_GUIDANCE_FIELDS_SPEC = `The four PER-MEASURE structured scoring_guidance fields (all derived from THIS measure's own definition — never a generic template reused across measures):
- "qualifyingInstance" (string): the POSITIVE definition of what SPECIFICALLY counts as satisfying THIS measure — a named programme/policy/system, a quantified commitment, or a dated milestone, phrased for this measure's exact requirement. Do NOT restate the topic in general terms; describe the concrete SHAPE a qualifying instance takes.
- "disqualifiers" (array of strings): generic or boilerplate mentions of the topic with no specific instance, aspirational or forward-looking intent without a named in-place instance, and the topic named in passing without the specific qualifying instance this measure requires — none of which may score Yes on their own.
- "anchors" (object): EXACTLY ONE canonical "yes" worked example (say why it qualifies) and EXACTLY ONE canonical "no" worked example (say why it superficially looks relevant but fails). NEVER author a "partial" anchor.
- "yesRequiresQuote" (string): one sentence stating that a Yes is permissible only when a verbatim quote from the evidence contains the qualifyingInstance above.`;

// The canonical fenced-JSON example the authoring prompts show the LLM. Kept as a
// string constant so create + intake render an identical example. (Escaped so it
// can be embedded inside a template literal in the consuming prompt strings.)
export const STRUCTURED_GUIDANCE_JSON_EXAMPLE = [
  "```json",
  "{",
  '  "qualifyingInstance": "Positive definition of what SPECIFICALLY counts as satisfying THIS measure — a named programme/policy/system, a quantified commitment, or a dated milestone.",',
  '  "disqualifiers": ["Generic or boilerplate mention of the topic with no specific instance", "Aspirational or forward-looking intent without a named, in-place instance", "The topic named in passing without the specific qualifying instance this measure requires"],',
  '  "anchors": { "yes": "ONE short worked example that clearly SATISFIES this measure (say why).", "no": "ONE short worked example that superficially looks relevant but FAILS (say why)." },',
  '  "yesRequiresQuote": "A Yes is permissible only when a verbatim quote from the evidence contains the qualifyingInstance above."',
  "}",
  "```",
].join("\n");

// Full authoring instruction used by the INTAKE/DRAFT path (appends the fenced
// JSON block to each measure's prose scoringGuidance) and reused by the REFINE
// regenerators. One definition — no divergent copies.
export const STRUCTURED_GUIDANCE_AUTHORING_BLOCK = `RUBRIC-TIGHTENING STRUCTURED GUIDANCE — append to EVERY measure's scoringGuidance, after the prose above, a fenced \`\`\`json block with four PER-MEASURE fields derived from THIS measure's definition (never a generic template):

${STRUCTURED_GUIDANCE_JSON_EXAMPLE}

"anchors" has EXACTLY ONE "yes" and ONE "no" — NEVER a Partial anchor. All four fields are mandatory and measure-specific. The prose scoringGuidance (with the canonical quote-context sentence) comes first; this JSON block is appended last. The scorer parses this block generically; it is stored inside scoring_guidance.`;

// Instruction fragment for the REFINE regenerators (which return a JSON `updates`
// array rather than appending prose). Tells the LLM to ALSO return a
// `scoring_guidance` object with the four fields, re-derived from the rewritten
// deciding criteria. Uses the shared field spec so the definition never diverges.
export const STRUCTURED_GUIDANCE_REGEN_INSTRUCTION = `In ADDITION to rewriting the definition, author a fresh per-measure "scoring_guidance" object re-derived from THIS measure's REWRITTEN deciding criteria.

${STRUCTURED_GUIDANCE_FIELDS_SPEC}`;

// The `scoring_guidance` schema fragment to embed in a regenerator's JSON schema.
export const STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT =
  '"scoring_guidance": { "qualifyingInstance": "<string>", "disqualifiers": ["<string>", "..."], "anchors": { "yes": "<one canonical Yes>", "no": "<one canonical No>" }, "yesRequiresQuote": "<one sentence>" }';

/**
 * Validate + clean an LLM-produced structured-guidance object. Returns ONLY the
 * fields that are present and well-shaped (a Partial), or null when nothing usable
 * was supplied — so a caller can degrade gracefully (leave the prior value) rather
 * than persist malformed/empty guidance. A `partial` anchor is NEVER carried
 * through (anchors are Yes/No only). Never throws.
 */
export function normaliseStructuredGuidance(raw: any): Partial<StructuredGuidance> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Partial<StructuredGuidance> = {};

  if (typeof raw.qualifyingInstance === "string" && raw.qualifyingInstance.trim().length > 0) {
    out.qualifyingInstance = raw.qualifyingInstance.trim();
  }
  if (Array.isArray(raw.disqualifiers)) {
    const d = raw.disqualifiers
      .filter((x: any) => typeof x === "string" && x.trim().length > 0)
      .map((x: string) => x.trim());
    if (d.length > 0) out.disqualifiers = d;
  }
  if (raw.anchors && typeof raw.anchors === "object" && !Array.isArray(raw.anchors)) {
    const a: { yes?: string; no?: string } = {};
    if (typeof raw.anchors.yes === "string" && raw.anchors.yes.trim().length > 0) a.yes = raw.anchors.yes.trim();
    if (typeof raw.anchors.no === "string" && raw.anchors.no.trim().length > 0) a.no = raw.anchors.no.trim();
    // NEVER carry a Partial anchor through, regardless of what the LLM returned.
    if (a.yes || a.no) out.anchors = a as { yes: string; no: string };
  }
  if (typeof raw.yesRequiresQuote === "string" && raw.yesRequiresQuote.trim().length > 0) {
    out.yesRequiresQuote = raw.yesRequiresQuote.trim();
  }

  return Object.keys(out).length > 0 ? out : null;
}

// Keep only the four structured keys from an arbitrary parsed object.
function pickStructured(o: any): Partial<StructuredGuidance> {
  const out: Partial<StructuredGuidance> = {};
  if (typeof o?.qualifyingInstance === "string" && o.qualifyingInstance.trim()) out.qualifyingInstance = o.qualifyingInstance.trim();
  if (Array.isArray(o?.disqualifiers)) {
    const d = o.disqualifiers.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim());
    if (d.length) out.disqualifiers = d;
  }
  if (o?.anchors && typeof o.anchors === "object" && !Array.isArray(o.anchors)) {
    const a: { yes?: string; no?: string } = {};
    if (typeof o.anchors.yes === "string" && o.anchors.yes.trim()) a.yes = o.anchors.yes.trim();
    if (typeof o.anchors.no === "string" && o.anchors.no.trim()) a.no = o.anchors.no.trim();
    if (a.yes || a.no) out.anchors = a as { yes: string; no: string };
  }
  if (typeof o?.yesRequiresQuote === "string" && o.yesRequiresQuote.trim()) out.yesRequiresQuote = o.yesRequiresQuote.trim();
  return out;
}

/**
 * Merge freshly authored structured fields INTO a measure's existing
 * scoring_guidance and return the new scoring_guidance string to persist. Fully
 * additive and backward-compatible:
 *   - if `incoming` carries nothing usable, the existing value is returned UNCHANGED
 *     (never blanks out prior guidance on a degraded LLM response);
 *   - only the fields the LLM actually returned overwrite the prior ones; any field
 *     it omitted keeps its prior value;
 *   - shape is preserved so `extractGuidanceObject` still parses the result:
 *       • existing pure-JSON object  → merged fields written back as a JSON object
 *         (yes/no/partial buckets and any other keys are retained);
 *       • prose (± an appended ```json block) → the prose is kept and a refreshed
 *         ```json fence with the merged four fields is appended.
 * Never throws.
 */
export function mergeStructuredIntoScoringGuidance(
  existing: string | null | undefined,
  incoming: Partial<StructuredGuidance> | null | undefined,
): string {
  const clean = normaliseStructuredGuidance(incoming);
  const rawExisting = existing == null ? "" : String(existing);
  if (!clean) return rawExisting; // graceful degrade — leave prior value intact

  // Shape (a): existing is a pure JSON object (V1 create path). Overlay the four
  // fields and keep every other key (yes/no/partial, explicit_exclusions, ...).
  try {
    const parsed = JSON.parse(rawExisting.trim());
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const merged: any = { ...parsed, ...clean };
      if (clean.anchors) merged.anchors = { ...(parsed.anchors && typeof parsed.anchors === "object" ? parsed.anchors : {}), ...clean.anchors };
      // Defensive: a Partial anchor must never survive.
      if (merged.anchors && typeof merged.anchors === "object") delete merged.anchors.partial;
      return JSON.stringify(merged);
    }
  } catch {
    /* not pure JSON — fall through to the prose+fence path */
  }

  // Shape (b/c): prose with an optional appended structured block. Preserve prose,
  // overlay onto any prior structured fields, and re-append a refreshed fence.
  const prior = extractGuidanceObject(rawExisting) || {};
  const mergedStructured: Partial<StructuredGuidance> = { ...pickStructured(prior), ...clean };
  if (clean.anchors) {
    const priorAnchors = prior && typeof prior.anchors === "object" && !Array.isArray(prior.anchors) ? prior.anchors : {};
    mergedStructured.anchors = { ...priorAnchors, ...clean.anchors } as { yes: string; no: string };
  }
  // Defensive: a Partial anchor must never survive the merge, even if it existed
  // in the prior prose block.
  if (mergedStructured.anchors && typeof mergedStructured.anchors === "object") {
    delete (mergedStructured.anchors as any).partial;
  }
  const prose = stripStructuredGuidanceBlock(rawExisting);
  const fence = "```json\n" + JSON.stringify(mergedStructured, null, 2) + "\n```";
  return prose ? `${prose}\n\n${fence}` : fence;
}
