/**
 * Sprint 10 P3 — Context expander (soft-mode R3.3)
 *
 * Ported from workspace Python (companyiq-runs/context_expander.py).
 *
 * When the scorer returns a Yes verdict with a quote shorter than the
 * measure's min_quote_context_chars threshold, this module:
 *
 *   1. Locates the quote in the fetched evidence text using progressive
 *      substring matching (exact → prefix → distinctive shingle).
 *   2. Expands the span to sentence boundaries until the containing span
 *      meets the min-context length.
 *   3. Re-verifies with a soft-mode LLM prompt (kept-Yes-unless-clearly-
 *      refuted) that flips Yes → No only when expanded context reveals a
 *      hard disqualifier.
 *
 * The soft-mode prompt was validated in sandbox: it preserved 80-85% of
 * TPs vs the strict prompt that regressed fw11b by -0.063 F1.
 *
 * Fires only on Yes verdicts with short quotes. Non-Yes verdicts pass through.
 */

import { completeWithFallback } from "../ai-providers.js";

export interface ContextExpanderInput {
  companyName: string;
  measureTitle: string;
  measureId: string;
  substantiveDefinition?: string;
  whatDoesNotConstituteEvidence?: string;
  topicTerm: string;
  quotes: Array<{ text: string; source?: string }>;
  fullEvidenceText: string;
  minQuoteContextChars: number;
  providerName?: string;
}

export interface ContextExpanderOutput {
  originalVerdict: "Yes";
  finalVerdict: "Yes" | "No";
  expansions: Array<{
    originalQuote: string;
    expandedQuote?: string;
    wasFound: boolean;
    stillYes: boolean;
    reason: string;
  }>;
  flipped: boolean;
}

// Utility: normalise whitespace + smart quotes for substring matching
function normaliseText(s: string): string {
  if (!s) return "";
  return s
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Progressive substring match: exact → 60-char prefix → 40-char shingle.
 * Returns the character index in the normalized source, or null.
 */
export function findQuoteInSource(quote: string, sourceText: string): number | null {
  if (!quote || !sourceText) return null;
  const qNorm = normaliseText(quote);
  const sNorm = normaliseText(sourceText);

  // 1. Exact
  let idx = sNorm.indexOf(qNorm);
  if (idx >= 0) return idx;

  // 2. Prefix (first 60 chars)
  if (qNorm.length >= 60) {
    const prefix = qNorm.slice(0, 60);
    idx = sNorm.indexOf(prefix);
    if (idx >= 0) return idx;
  }

  // 3. Distinctive shingle: any 40-char slice with capitals/digits
  for (let start = 0; start < Math.max(1, qNorm.length - 40); start += 20) {
    const shingle = qNorm.slice(start, start + 40).trim();
    if (shingle.length < 30) continue;
    if (!/[A-Z0-9]/.test(shingle)) continue;
    idx = sNorm.indexOf(shingle);
    if (idx >= 0) return Math.max(0, idx - start);
  }
  return null;
}

/**
 * Expand [start, start+quoteLen] outward to sentence boundaries until the
 * span is at least minContextChars. Hard cap prevents runaway expansion.
 */
export function expandToSentenceBoundaries(
  sourceText: string,
  startIdx: number,
  quoteLen: number,
  minContextChars: number,
): string {
  const text = sourceText;
  const n = text.length;
  if (startIdx < 0) return text.slice(0, minContextChars);
  const endIdx = startIdx + quoteLen;

  // Walk left to find sentence start
  let left = startIdx;
  while (left > 0) {
    if (endIdx - left >= minContextChars) {
      const backWindow = text.slice(Math.max(0, left - 3), left);
      if (/[.!?]\s*$/.test(backWindow) || text[left - 1] === "\n") break;
    }
    left--;
  }
  while (left < startIdx && /[ \n\t]/.test(text[left])) left++;

  // Walk right to find sentence end
  let right = endIdx;
  while (right < n) {
    if (right - left >= minContextChars) {
      const back = text[right - 1] || "";
      const nextChar = right < n ? text[right] : "";
      if (/[.!?]/.test(back) && (right >= n || /[ \n\t]/.test(nextChar) || /[A-Z]/.test(nextChar))) break;
    }
    right++;
  }

  // Hard bound: 3× min OR 400 chars, whichever larger
  const maxSpan = Math.max(minContextChars * 3, 400);
  if (right - left > maxSpan) {
    const pad = Math.floor((maxSpan - quoteLen) / 2);
    left = Math.max(0, startIdx - pad);
    right = Math.min(n, endIdx + pad);
  }

  return text.slice(left, right).trim();
}

/**
 * Soft-mode re-verification. Instructs the LLM to KEEP Yes unless expanded
 * context CLEARLY REFUTES. Ambiguity is not grounds to flip.
 */
async function reverifyExpandedContext(
  input: ContextExpanderInput,
  expandedQuote: string,
): Promise<{ stillYes: boolean; reason: string }> {
  const system = `You are performing a re-verification pass on a corporate disclosure verdict for the topic: ${input.topicTerm}. A previous verdict scored this quote Yes based on the original short quote. Given the expanded surrounding context, decide whether the evidence STILL supports Yes.

DEFAULT TO KEEPING Yes. Only flip to No if the expanded context CLEARLY REFUTES the original verdict. This means at least one of the following must be UNAMBIGUOUSLY true:
- The expanded context proves the quote's subject refers to a plainly different topic (e.g. "this training" is unambiguously identified as a different training programme)
- The expanded context directly contradicts the quote (an adjacent sentence negates it)
- The expanded context reveals a hard scope disqualifier (explicit "excludes X", "not applicable to X")
- The quote is unambiguously a third-party reference, not a company position

AMBIGUITY, MISSING DETAIL, or "the context doesn't fully confirm" are NOT grounds to flip. When in doubt, keep Yes.

Return strict JSON with keys: still_yes (bool), reasoning (1-2 sentences).`;

  const user = `COMPANY: ${input.companyName}
MEASURE: ${input.measureId} — ${input.measureTitle}
${input.substantiveDefinition ? `\nSUBSTANTIVE DEFINITION: ${input.substantiveDefinition.slice(0, 600)}\n` : ""}${input.whatDoesNotConstituteEvidence ? `\nWHAT DOES NOT CONSTITUTE EVIDENCE: ${input.whatDoesNotConstituteEvidence.slice(0, 600)}\n` : ""}
EXPANDED QUOTE (with surrounding context):
${expandedQuote.slice(0, 2000)}

Return strict JSON.`;

  try {
    const { text } = await completeWithFallback(input.providerName || "deepseek", {
      system,
      prompt: user,
      maxTokens: 300,
      temperature: 0,
      json: true,
    });
    const parsed = extractJson(text);
    return {
      stillYes: Boolean(parsed?.still_yes ?? true),
      reason: String(parsed?.reasoning || "").slice(0, 200),
    };
  } catch (err: any) {
    // On error, DO NOT flip — default to keeping Yes
    return { stillYes: true, reason: `reverification error: ${err?.message || err}` };
  }
}

/**
 * Main entry point. Expands short-quote Yes verdicts and returns the possibly-
 * updated verdict. Non-Yes verdicts short-circuit unchanged.
 */
export async function expandAndReverify(input: ContextExpanderInput): Promise<ContextExpanderOutput> {
  const expansions: ContextExpanderOutput["expansions"] = [];
  const minCtx = input.minQuoteContextChars || 120;
  let anyFlippedToNo = false;

  for (const q of input.quotes) {
    if (!q.text || q.text.length >= minCtx) {
      expansions.push({
        originalQuote: q.text || "",
        wasFound: true,
        stillYes: true,
        reason: q.text ? "quote already >= min context; not re-verified" : "empty quote skipped",
      });
      continue;
    }

    const idx = findQuoteInSource(q.text, input.fullEvidenceText);
    if (idx === null) {
      // Cannot locate; leave verdict as-is
      expansions.push({
        originalQuote: q.text,
        wasFound: false,
        stillYes: true,
        reason: "quote not locatable in evidence; verdict kept",
      });
      continue;
    }

    const expanded = expandToSentenceBoundaries(input.fullEvidenceText, idx, q.text.length, minCtx);
    const rv = await reverifyExpandedContext(input, expanded);
    expansions.push({
      originalQuote: q.text,
      expandedQuote: expanded,
      wasFound: true,
      stillYes: rv.stillYes,
      reason: rv.reason,
    });
    if (!rv.stillYes) anyFlippedToNo = true;
  }

  return {
    originalVerdict: "Yes",
    finalVerdict: anyFlippedToNo ? "No" : "Yes",
    expansions,
    flipped: anyFlippedToNo,
  };
}

function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fence ? fence[1] : text;
  try {
    return JSON.parse(source);
  } catch {
    const first = source.indexOf("{");
    const last = source.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(source.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
