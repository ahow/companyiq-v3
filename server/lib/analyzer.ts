import * as storage from "../storage.js";
import { completeWithFallback, completeScoring, getProvider, getIndependentTieBreakerProvider } from "./ai-providers.js";
import { ProviderScoringError } from "./credit-breaker.js";
import { classifyProviderError, type ProviderFailureClass } from "./provider-resilience.js";
import { buildEvidencePacksForCategory, buildEvidencePackForMeasure, computePreferredAnnualUrl, chunkDocuments, tokenize, buildBM25Index, bm25Score, deriveTopicTerms, computeCorpusTopicStats, type EvidencePack, type Chunk } from "./passage-retrieval.js";
import { discoverCompanyTerminology, flattenTerms, type TerminologyMap } from "./terminology-discovery.js";
import { deriveTopicLexicon } from "./topic-lexicon.js";
import { generateDocumentHash } from "./processor.js";
import { translateDocumentsToEnglish } from "./translation.js";
import { corpusSourceTypes } from "./discovery.js";
import { createHash } from "crypto";
import type { Framework, FrameworkMeasure } from "../../shared/schema.js";

// ─── Methodology Stamping ───────────────────────────────────────────────────
// Computed once at module load; changes only when the scoring prompt template
// or pipeline code changes (i.e. on deploy).
const PIPELINE_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev";

// Hash the scoring prompt TEMPLATE (the static parts, not per-company evidence).
// This changes when prompt logic changes, enabling drift detection.
const BINARY_PROMPT_HASH = createHash("sha256")
  .update("binary-v1:" + buildBinaryScoringPrompt.toString().slice(0, 500))
  .digest("hex")
  .slice(0, 16);
const PARTIAL_PROMPT_HASH = createHash("sha256")
  .update("partial-v1:" + buildPartialScoringPrompt.toString().slice(0, 500))
  .digest("hex")
  .slice(0, 16);

export function getPromptHash(mode: string): string {
  return mode === "partial" ? PARTIAL_PROMPT_HASH : BINARY_PROMPT_HASH;
}
export function getPipelineVersion(): string {
  return PIPELINE_VERSION;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MeasureResult {
  measureId: string;
  title: string;
  definition: string | null;
  category: string;
  categoryNumber: number;
  score: number;
  coverage: string | null;
  confidence: string;
  evidenceSummary: string;
  quotes: Array<{ text: string; source: string; sourceUrl?: string; page?: number }>;
  verdict: "Yes" | "No" | "Partial" | "Insufficient evidence";
  verdictNuance: string | null;
  displayOrder: number;
  // v3e (Section 3): true when the measure was abstained because a required
  // source type was absent from the corpus (excluded from the denominator).
  abstained?: boolean;
  // v3e (Section 4): SHA1 of the sorted evidence-chunk ids used for this verdict.
  evidenceFingerprint?: string | null;
  // v3j (Bug 2): force-include provenance, used for the run-level invariant that
  // every filing-bound measure whose required document is present in corpus must
  // have had at least one genuine body chunk force-included. Transient (not
  // persisted to measure_scores).
  forceIncludedCount?: number;
  requiredDocPresent?: boolean;
  forceIncludedDocUrl?: string;
}

export interface AnalysisResult {
  totalScore: number;
  scorePercentage: number;
  summary: string;
  // v3e (Section 3): answered-measures accounting. answeredCount excludes
  // abstained measures; scorePercentage uses answeredCount as the denominator.
  answeredCount: number;
  abstainedCount: number;
  measuresTotal: number;
  categories: Array<{
    category: string;
    categoryNumber: number;
    measures: MeasureResult[];
  }>;
  // v3j (Bug 2): run-level force-include invariant result. ok=false means at
  // least one filing-bound measure whose required document was present in the
  // corpus failed to receive any genuine forced body chunk — a real regression
  // the portfolio run should gate on.
  forceIncludeInvariant?: {
    ok: boolean;
    checked: number;
    violations: Array<{ measureId: string; reason: string }>;
  };
  // I45: Scoring diagnostics for fleet-score regression investigation.
  // Exposes per-run counts of evidence passages, model responses, timeouts,
  // fallback/default-score usage, and scoring failures by framework and measure.
  scoringDiagnostics?: {
    totalMeasures: number;
    scoredMeasures: number;
    scoringFailures: number;
    timeouts: number;
    fallbackUsed: number;
    defaultScoreUsed: number;
    evidencePackCounts: { total: number; empty: number; lowTopic: number };
    modelResponseValidity: { valid: number; repaired: number; failed: number };
    selfConsistencyPasses: number;
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface AnalysisSettings {
  ensembleScoring: boolean;
  ensembleIterations: number;
  pipelineLlm1: string;
  pipelineLlm2: string;
  pipelineLlm3: string;
  scoringProvider: string;
  useBm25Retrieval: boolean;
  bm25SkipSummarizationBelowChars: number;
  terminologyDiscoveryEnabled: boolean;
  twoPromptExtractionEnabled: boolean;
  crossVerifyEnabled: boolean;
  scoringMode: string;
  lowConfidenceHandling: string; // "keep" | "downgrade" | "flag"
  // v3e (Section 4): verdict cache is OPT-IN BY DEFAULT (ON). Set
  // verdict_cache_enabled="false" to force fresh scoring for variability studies.
  verdictCacheEnabled: boolean;
}

async function loadAnalysisSettings(workspaceId?: number): Promise<AnalysisSettings> {
  const settings = await storage.getSettings(workspaceId || 1);
  return {
    ensembleScoring: settings.ensemble_scoring === "true",
    ensembleIterations: parseInt(settings.ensemble_iterations || "3"),
    pipelineLlm1: settings.pipeline_llm_1 || "deepseek",
    pipelineLlm2: settings.pipeline_llm_2 || "claude",
    pipelineLlm3: settings.pipeline_llm_3 || "openrouter", // V3.1 (independent route); replaces gemini which rate-limits under batch load
    scoringProvider: settings.scoring_provider || "deepseek",
    useBm25Retrieval: settings.use_bm25_retrieval !== "false",
    bm25SkipSummarizationBelowChars: parseInt(settings.bm25_skip_summarization_below_chars || "600000"),
    terminologyDiscoveryEnabled: settings.terminology_discovery_enabled !== "false",
    twoPromptExtractionEnabled: settings.two_prompt_extraction_enabled === "true",
    crossVerifyEnabled: settings.cross_verify_enabled === "true",
    scoringMode: settings.scoring_mode || "binary",
    lowConfidenceHandling: settings.low_confidence_handling || "downgrade",
    // v3g (Bug 1 §3 action 5): verdict cache is now OPT-IN (default OFF) until the
    // fingerprint contract is independently re-verified. The cost of recomputing a
    // few measures per re-run is trivial vs the risk of cross-company verdict reuse
    // that the old positional fingerprint allowed. Set verdict_cache_enabled="true"
    // to re-enable once the new content-stable fingerprints are confirmed unique.
    verdictCacheEnabled: settings.verdict_cache_enabled === "true", // default OFF
  };
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildBinaryScoringPrompt(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  temporalWarning?: string | null;
  framework?: Framework;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework } = opts;

  let terminologyBlock = "";
  if (terminology && flattenTerms(terminology).length > 0) {
    terminologyBlock = `\nCOMPANY TERMINOLOGY NOTE:
This company uses the following specific terms for this topic. Treat these as equivalent to the framework's canonical terms when evaluating evidence:
- Committees: ${terminology.committees.join(", ") || "None identified"}
- Roles: ${terminology.roles.join(", ") || "None identified"}
- Programmes: ${terminology.programmes.join(", ") || "None identified"}
- Products/Policies: ${terminology.productsAndPolicies.join(", ") || "None identified"}
- Other terms: ${terminology.otherTerms.join(", ") || "None identified"}
Do not penalise evidence for using these terms instead of the framework's language.\n`;
  }

  const system = `You are an expert ESG/governance analyst scoring corporate disclosures against a structured assessment framework.

Topic: ${topicDescription}

SCORING RULES (Binary Mode):
- Score 1 (Yes): The company provides clear, specific evidence that directly addresses this measure. At least one verbatim quote from the source documents must support the score.
- Score 0 (No): No evidence found, or evidence is too vague/generic to confirm the specific requirement.
- Partial verdicts: Use verdict "Partial" with score 0 when some evidence exists but does not fully satisfy the measure.

CONFIDENCE LEVELS:
- High: Clear evidence found (for Yes) or thorough search with no evidence (for No)
- Medium: Evidence is ambiguous or indirect
- Low: Document corpus may be incomplete or in a language not fully analyzed

CRITICAL ANTI-INFERENCE RULES:
1. You must score this measure based STRICTLY on explicit, verbatim disclosures made by the company in the evidence text provided.
2. DO NOT infer that a company has a specific target or policy because they are a member of an alliance or initiative. Alliance membership alone does not constitute evidence of a specific company-level commitment.
3. DO NOT infer that a policy applies to all sectors or all activities if the text only names specific sectors.
${((framework as any)?.antiInferenceRules as string[] | null || []).map((rule: string, i: number) => `${4 + i}. ${rule}`).join("\n")}
${((framework as any)?.antiInferenceRules as string[] | null || []).length + 4}. If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 (No or Partial), even if you believe the company likely has such a policy based on other context.
${((framework as any)?.antiInferenceRules as string[] | null || []).length + 5}. Pay careful attention to the TEMPORAL VALIDITY of evidence. If the evidence indicates a policy or target has been withdrawn, discontinued, or superseded, score based on the current state, not the historical commitment.

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
CRITICAL: For the "source" field in quotes, you MUST use the EXACT document title as it appears in the "--- DOCUMENT: <title> [<url>] ---" headers in the evidence text. Use the title portion (before the [url]), not an invented or paraphrased name.
${terminologyBlock}`;

  let scoringGuidance = "";
  if (measure.scoringGuidance) {
    // scoringGuidance is stored as text in DB — it may be a JSON string or plain text
    let sg: any;
    try {
      sg = typeof measure.scoringGuidance === "string" 
        ? JSON.parse(measure.scoringGuidance) 
        : measure.scoringGuidance;
    } catch {
      // If it's not valid JSON, treat as plain text guidance
      sg = { yes: measure.scoringGuidance, no: "", partial: "" };
    }
    scoringGuidance = `\nScoring guidance:\n- Yes: ${sg.yes || "Clear evidence present"}\n- No: ${sg.no || "No evidence found"}\n- Partial: ${sg.partial || "Some evidence but incomplete"}`;
    // Add explicit exclusions if present in the template
    if (sg.explicit_exclusions && Array.isArray(sg.explicit_exclusions) && sg.explicit_exclusions.length > 0) {
      scoringGuidance += `\n\nEXPLICIT EXCLUSIONS (do NOT score Yes if only this evidence exists):\n${sg.explicit_exclusions.map((e: string) => `- ${e}`).join("\n")}`;
    }
    // Add required evidence type if present
    if (sg.required_evidence_type) {
      scoringGuidance += `\n\nREQUIRED EVIDENCE TYPE: ${sg.required_evidence_type}`;
    }
    // Add temporal note if present
    if (sg.temporal_note) {
      scoringGuidance += `\n\nTEMPORAL NOTE: ${sg.temporal_note}`;
    }
  }

  const temporalBlock = temporalWarning ? `\n${temporalWarning}\n` : "";

  const prompt = `Company: ${companyName}
${temporalBlock}
MEASURE TO EVALUATE:
Title: ${measure.title}
Definition: ${measure.definition || measure.title}
${scoringGuidance}

EVIDENCE TEXT:
${evidenceText || "[No relevant evidence found in the document corpus]"}

Evaluate this measure and return a JSON object with exactly these fields:
{
  "score": 0 or 1,
  "verdict": "Yes" | "No" | "Partial",
  "confidence": "High" | "Medium" | "Low",
  "evidenceSummary": "One paragraph explaining your assessment",
  "quotes": [{"text": "verbatim quote from evidence", "source": "exact document title from --- DOCUMENT: <title> [url] --- header"}],
  "verdictNuance": "optional caveats or notes" or null
}`;

  return { system, prompt };
}

// ─── Partial Scoring Prompt ─────────────────────────────────────────────────

function buildPartialScoringPrompt(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  temporalWarning?: string | null;
  framework?: Framework;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework } = opts;

  let terminologyBlock = "";
  if (terminology) {
    terminologyBlock = `\nCOMPANY TERMINOLOGY NOTE:
This company uses the following specific terms for this topic. Treat these as equivalent to the framework's canonical terms when evaluating evidence:
- Committees: ${terminology.committees.join(", ") || "None identified"}
- Roles: ${terminology.roles.join(", ") || "None identified"}
- Programmes: ${terminology.programmes.join(", ") || "None identified"}
- Products/Policies: ${terminology.productsAndPolicies.join(", ") || "None identified"}
- Other terms: ${terminology.otherTerms.join(", ") || "None identified"}
Do not penalise evidence for using these terms instead of the framework's language.\n`;
  }

  const system = `You are an expert ESG/governance analyst scoring corporate disclosures against a structured assessment framework.

Topic: ${topicDescription}

SCORING RULES (Partial Credit Mode):
- Score 1 (Yes): The company provides clear, specific evidence that FULLY addresses this measure. At least one verbatim quote from the source documents must support the score.
- Score 0.5 (Partial): The company provides SOME evidence that partially addresses this measure, but it is incomplete, indirect, or does not fully satisfy all aspects of the requirement. A supporting quote should be provided where possible.
- Score 0 (No): No evidence found, or evidence is too vague/generic to confirm any aspect of the specific requirement.

WHEN TO USE PARTIAL (0.5):
- ${((framework as any)?.scoringExamples as string[] | null || [])[0] || "The company addresses the topic generally but not the specific requirement"}
- Evidence exists for some but not all components of a multi-part measure
- The evidence is from a related initiative or programme that implies but does not explicitly confirm the requirement
- A policy or commitment exists but lacks specificity, metrics, or implementation details
- Evidence is outdated or from a superseded document but no current replacement is found

CONFIDENCE LEVELS:
- High: Clear evidence found (for Yes) or thorough search with no evidence (for No)
- Medium: Evidence is ambiguous or indirect
- Low: Document corpus may be incomplete or in a language not fully analyzed

CRITICAL ANTI-INFERENCE RULES:
1. You must score this measure based STRICTLY on explicit, verbatim disclosures made by the company in the evidence text provided.
2. DO NOT infer that a company has a specific target or policy because they are a member of an alliance or initiative. Alliance membership alone does not constitute evidence of a specific company-level commitment.
3. DO NOT infer that a policy applies to all sectors or all activities if the text only names specific sectors.
${((framework as any)?.antiInferenceRules as string[] | null || []).map((rule: string, i: number) => `${4 + i}. ${rule}`).join("\n")}
${((framework as any)?.antiInferenceRules as string[] | null || []).length + 4}. If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 or 0.5 (not 1).
${((framework as any)?.antiInferenceRules as string[] | null || []).length + 5}. Pay careful attention to the TEMPORAL VALIDITY of evidence.

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
CRITICAL: For the "source" field in quotes, you MUST use the EXACT document title as it appears in the "--- DOCUMENT: <title> [<url>] ---" headers in the evidence text.
${terminologyBlock}`;

  let scoringGuidance = "";
  if (measure.scoringGuidance) {
    let sg: any;
    try {
      sg = typeof measure.scoringGuidance === "string"
        ? JSON.parse(measure.scoringGuidance)
        : measure.scoringGuidance;
    } catch {
      sg = { yes: measure.scoringGuidance, no: "", partial: "" };
    }
    scoringGuidance = `\nScoring guidance:\n- Yes (1): ${sg.yes || "Clear evidence fully satisfying the requirement"}\n- Partial (0.5): ${sg.partial || "Some evidence but incomplete or indirect"}\n- No (0): ${sg.no || "No evidence found"}`;
    if (sg.explicit_exclusions && Array.isArray(sg.explicit_exclusions) && sg.explicit_exclusions.length > 0) {
      scoringGuidance += `\n\nEXPLICIT EXCLUSIONS (do NOT score Yes if only this evidence exists):\n${sg.explicit_exclusions.map((e: string) => `- ${e}`).join("\n")}`;
    }
    if (sg.required_evidence_type) {
      scoringGuidance += `\n\nREQUIRED EVIDENCE TYPE: ${sg.required_evidence_type}`;
    }
    if (sg.temporal_note) {
      scoringGuidance += `\n\nTEMPORAL NOTE: ${sg.temporal_note}`;
    }
  }

  const temporalBlock = temporalWarning ? `\n${temporalWarning}\n` : "";

  const prompt = `Company: ${companyName}
${temporalBlock}
MEASURE TO EVALUATE:
Title: ${measure.title}
Definition: ${measure.definition || measure.title}
${scoringGuidance}

EVIDENCE TEXT:
${evidenceText || "[No relevant evidence found in the document corpus]"}

Evaluate this measure and return a JSON object with exactly these fields:
{
  "score": 0 or 0.5 or 1,
  "verdict": "Yes" | "No" | "Partial",
  "confidence": "High" | "Medium" | "Low",
  "evidenceSummary": "One paragraph explaining your assessment",
  "quotes": [{"text": "verbatim quote from evidence", "source": "exact document title from --- DOCUMENT: <title> [url] --- header"}],
  "verdictNuance": "optional caveats or notes" or null
}`;

  return { system, prompt };
}

// ─── JSON Parsing with Repair ────────────────────────────────────────────────

function extractAndParseJSON(text: string): any {
  // Strategy 1: Direct parse
  try {
    return JSON.parse(text);
  } catch {}

  // Strategy 2: Strip code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // Strategy 3: Find JSON object boundaries
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // Strategy 4: Fix common issues (unescaped quotes in strings)
  try {
    const cleaned = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {}

  throw new Error("Failed to parse JSON from LLM response");
}

// ─── Provenance Check ────────────────────────────────────────────────────────

export function verifyQuoteProvenance(
  quote: string,
  evidenceText: string
): { found: boolean; similarity: number } {
  if (!quote || !evidenceText) return { found: false, similarity: 0 };

  // REVIEWER FIX v3d (issue #2): strict whitespace-only normalization punished
  // companies that paraphrase or whose quotes differ only by punctuation
  // (curly vs straight quotes, em-dashes, commas) — e.g. NVIDIA 1.1 got 3/3 Yes
  // but was auto-downgraded because the quote didn't match verbatim. We now
  // normalize punctuation AND whitespace, then accept a fuzzy match: an exact
  // normalized substring, OR a longest-contiguous-substring covering >= 90% of
  // the quote, OR (final fallback) a strong consecutive-word window.
  const normalize = (s: string): string =>
    s
      .replace(/[\u2018\u2019\u201b\u2032]/g, "'")      // smart single quotes -> '
      .replace(/[\u201c\u201d\u201f\u2033]/g, '"')      // smart double quotes -> "
      .replace(/[\u2010-\u2015\u2212]/g, "-")           // various dashes -> -
      .replace(/[\u00a0]/g, " ")                          // nbsp -> space
      .replace(/[.,;:!?()\[\]{}"'\-—–]/g, " ")           // drop punctuation
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const normalizedQuote = normalize(quote);
  const normalizedEvidence = normalize(evidenceText);
  if (!normalizedQuote) return { found: false, similarity: 0 };

  // 1) Exact normalized substring.
  if (normalizedEvidence.includes(normalizedQuote)) {
    return { found: true, similarity: 1.0 };
  }

  // 2) Longest contiguous substring of the quote that appears in the evidence,
  //    measured at the character level. If it covers >= 90% of the quote, accept.
  //    We grow a candidate window from each space-aligned start to stay O(n*m)-ish
  //    in practice (quotes are short).
  const qLen = normalizedQuote.length;
  let longest = 0;
  // Try progressively shorter prefixes/suffixes via word boundaries for speed.
  const qWords = normalizedQuote.split(" ");
  for (let start = 0; start < qWords.length; start++) {
    // Extend the window as far right as still found in evidence.
    let lo = start, hi = qWords.length;
    let bestEnd = start;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cand = qWords.slice(start, mid).join(" ");
      if (normalizedEvidence.includes(cand)) { bestEnd = mid; lo = mid; }
      else { hi = mid - 1; }
      if (lo === hi) break;
    }
    const candStr = qWords.slice(start, Math.max(bestEnd, start + 1)).join(" ");
    if (normalizedEvidence.includes(candStr)) longest = Math.max(longest, candStr.length);
  }
  const coverage = qLen > 0 ? longest / qLen : 0;
  if (coverage >= 0.9) {
    return { found: true, similarity: coverage };
  }

  // 3) Final fallback: a strong consecutive-word window (>= 60% of words, min 5).
  if (qWords.length >= 5) {
    const windowSize = Math.max(5, Math.floor(qWords.length * 0.6));
    for (let i = 0; i <= qWords.length - windowSize; i++) {
      const window = qWords.slice(i, i + windowSize).join(" ");
      if (normalizedEvidence.includes(window)) {
        return { found: true, similarity: Math.max(0.8, coverage) };
      }
    }
  }

  return { found: false, similarity: coverage };
}

// ─── Source Normalization ────────────────────────────────────────────────────

/**
 * Normalize quote sources to match actual document titles from the evidence text.
 * The evidence text contains headers like: --- DOCUMENT: <title> [<url>] ---
 * If the LLM returned a source that doesn't match any document title, find the
 * best match or fall back to the document where the quote text was found.
 */
export function normalizeQuoteSources(
  quotes: Array<{ text: string; source: string; sourceUrl?: string; page?: number }>,
  evidenceText: string
): Array<{ text: string; source: string; sourceUrl?: string; page?: number }> {
  // Extract all document titles from the evidence text headers
  const headerPattern = /--- DOCUMENT: (.+?) \[(.+?)\] ---/g;
  const documentHeaders: Array<{ title: string; url: string; startIdx: number }> = [];
  let match;
  while ((match = headerPattern.exec(evidenceText)) !== null) {
    documentHeaders.push({ title: match[1].trim(), url: match[2].trim(), startIdx: match.index });
  }

  if (documentHeaders.length === 0) return quotes;

  // Build a set of valid document titles + a title->url map for quick lookup
  const validTitles = new Set(documentHeaders.map(h => h.title.toLowerCase()));
  const urlByTitle = new Map<string, string>();
  for (const h of documentHeaders) {
    // First header wins for a given title (avoids later duplicates overwriting)
    if (!urlByTitle.has(h.title.toLowerCase())) urlByTitle.set(h.title.toLowerCase(), h.url);
  }
  const resolveUrl = (title: string): string | undefined =>
    title ? urlByTitle.get(title.toLowerCase()) : undefined;

  return quotes.map(quote => {
    // Check if the source already matches a valid document title
    if (quote.source && validTitles.has(quote.source.toLowerCase())) {
      return { ...quote, sourceUrl: resolveUrl(quote.source) ?? quote.sourceUrl };
    }

    // Source doesn't match any document title — try to find the correct one
    let bestSource = quote.source;

    // Strategy 1: Find which document contains the quote text
    if (quote.text) {
      const normalizedQuote = quote.text.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizedEvidence = evidenceText.toLowerCase();
      const quoteIdx = normalizedEvidence.indexOf(normalizedQuote.slice(0, 80));

      if (quoteIdx >= 0) {
        // Find the document header that precedes this quote position
        let containingDoc = documentHeaders[0];
        for (const header of documentHeaders) {
          if (header.startIdx <= quoteIdx) {
            containingDoc = header;
          } else {
            break;
          }
        }
        bestSource = containingDoc.title;
        // Capture the authoritative URL from the containing document header
        return { ...quote, source: bestSource, sourceUrl: containingDoc.url };
      }
    }

    // Strategy 2: Fuzzy match the source string against document titles
    if (bestSource === quote.source && quote.source) {
      const sourceLower = quote.source.toLowerCase();
      let bestSimilarity = 0;
      let bestMatch = "";

      for (const header of documentHeaders) {
        const titleLower = header.title.toLowerCase();
        // Check if source is a substring of a title or vice versa
        if (titleLower.includes(sourceLower) || sourceLower.includes(titleLower)) {
          bestSource = header.title;
          break;
        }
        // Simple word overlap similarity
        const sourceWords = new Set(sourceLower.split(/\s+/));
        const titleWords = titleLower.split(/\s+/);
        const overlap = titleWords.filter(w => sourceWords.has(w)).length;
        const similarity = overlap / Math.max(sourceWords.size, titleWords.length);
        if (similarity > bestSimilarity && similarity > 0.3) {
          bestSimilarity = similarity;
          bestMatch = header.title;
        }
      }
      if (bestMatch && bestSource === quote.source) {
        bestSource = bestMatch;
      }
    }

    // Strategy 3: If still no match, use the first document as fallback
    if (bestSource === quote.source || !bestSource) {
      bestSource = documentHeaders[0].title;
    }

    return { ...quote, source: bestSource, sourceUrl: resolveUrl(bestSource) ?? quote.sourceUrl };
  });
}

// ─── Contradiction Detection + Tie-Breaker ───────────────────────────────────

async function detectAndResolvContradiction(opts: {
  measure: FrameworkMeasure;
  result: MeasureResult;
  evidenceText: string;
  primaryProvider: string;
}): Promise<MeasureResult> {
  const { measure, result, evidenceText, primaryProvider } = opts;

  // Only check NO verdicts with evidence that might suggest YES
  if (result.verdict !== "No") return result;
  if (!result.evidenceSummary) return result;

  // Check for affirmative language in a NO verdict's rationale
  const affirmativePatterns = [
    /the company has implemented/i,
    /names the .* committee as responsible/i,
    /explicitly describes/i,
    /the .* report states/i,
    /evidence of .* oversight/i,
  ];

  const hasContradiction = affirmativePatterns.some((p) => p.test(result.evidenceSummary));
  if (!hasContradiction) return result;

  // Get independent tie-breaker
  const tieBreaker = getIndependentTieBreakerProvider(primaryProvider);
  if (!tieBreaker) {
    console.warn(`[TieBreak] No independent provider available, keeping original verdict`);
    return result;
  }

  console.log(`[TieBreak] Contradiction detected for ${measure.measureId}, consulting ${tieBreaker.name}`);

  try {
    // I45: Deterministic tie-breaker call — temperature=0, no random inputs
    const { text } = await completeWithFallback(tieBreaker.name, {
      system: "You are an independent reviewer. Given a measure and evidence, determine if the evidence supports a YES or NO verdict. Return JSON: {\"verdict\": \"Yes\"|\"No\", \"reason\": \"brief explanation\"}",
      prompt: `Measure: ${measure.title}\nDefinition: ${measure.definition}\n\nEvidence:\n${evidenceText.slice(0, 8000)}\n\nDoes this evidence support a YES verdict for this measure?`,
      json: true,
      maxTokens: 500,
      temperature: 0,
    });

    const tieResult = extractAndParseJSON(text);
    if (tieResult.verdict === "Yes") {
      console.log(`[TieBreak] OVERRIDE: ${measure.measureId} changed from No to Yes`);
      return {
        ...result,
        score: 1,
        verdict: "Yes",
        confidence: "Medium",
        verdictNuance: `Tie-breaker override: ${tieResult.reason}`,
      };
    } else {
      console.log(`[TieBreak] CONFIRM: ${measure.measureId} remains No`);
      return result;
    }
  } catch (error: any) {
    console.warn(`[TieBreak] Failed: ${error.message}, keeping original`);
    return result;
  }
}

// ─── Document Summarization ──────────────────────────────────────────────────

async function summarizeDocuments(opts: {
  companyName: string;
  companyId: number;
  documentTexts: string[];
  documentUrls: string[];
  documentTitles?: string[];
  topicDescription: string;
  framework: Framework;
}): Promise<{ text: string; model: string; reservedAnnualUrl?: string; corpusTopicWarning?: string }> {
  const { companyName, companyId, documentTexts, documentUrls, documentTitles, topicDescription, framework } = opts;

  // Check summary cache. v3g: salt the cache key so the OLD header-lossy LLM
  // summaries (which dropped document URLs) are never reused; only the new
  // header-preserving retrieval corpus is served from cache going forward.
  const docHash = createHash("sha256")
    .update(generateDocumentHash(documentUrls) + ":corpus-v3n-no-govterms")
    .digest("hex")
    .slice(0, 16);
  const cached = await storage.getCachedSummary(companyId, docHash);
  if (cached) {
    console.log(`[${companyName}] Using cached summary`);
    return { text: cached, model: "cached" };
  }

  // ─── PRIORITY-BASED DOCUMENT ORDERING ───────────────────────────────────────
  // Sort documents by relevance to the topic BEFORE combining, so AI-specific
  // content appears first and doesn't get truncated.
  const topicKeywords = tokenize(topicDescription);
  // Instruction 25: Use framework-aware topic-term derivation instead of hardcoded
  // AI keywords. deriveTopicTerms produces distinctive tokens from the topic
  // description and framework name. dataPatternTokens add the exact strings the
  // framework author declared as topic-defining.
  const derivedTerms = deriveTopicTerms(topicDescription, undefined);
  const dataPatternTokens = (framework as any).dataPatterns
    ? ((framework as any).dataPatterns as string[])
        .flatMap((p: string) => p.replace(/[\\^$.|?*+()\[\]{}]/g, " ").split(/\s+/))
        .filter((t: string) => t.length >= 4)
    : [];

  // Instruction 34 REVERTED (Instruction 35): the universal governance vocabulary
  // hurt Stage-1 retrieval on document-rich corpora. Long compliance/annual-report
  // documents saturated in governance language (HSBC AR 2025 etc.) dominated the
  // ~560k character corpus pool and pushed topic-specific-evidence chunks out of
  // the top-K. Battery on 610893a: fw3 HSBC 56 → 7 (18 of 27 measures cite the
  // same weak sentence from AR-2025 vs 21 diverse quotes from Sustainability/TCFD
  // reports prior). Reverted; see Instruction 33 (semantic embedding rerank) for
  // the durable replacement.

  const allQueryTerms = [...new Set([...topicKeywords, ...derivedTerms, ...dataPatternTokens])];

  // v3g-fix: TYPE-AWARE document prioritisation. The previous pure keyword-density
  // ranking let a long, AI-keyword-dense ESG/sustainability PDF (e.g. Apple's
  // Environmental Progress Report) dominate the top slots and consume the corpus
  // budget, pushing the 10-K and proxy — where the actual AI governance/strategy
  // evidence lives — out of the pool. We classify each document by TYPE and give a
  // strong structural priority to authoritative filings and dedicated AI/governance
  // pages, while CAPPING the keyword-density contribution so no single long PDF can
  // crowd out the primary disclosures.
  // Instruction 26: Framework-declared topic-primary classification.
  // No hardcoded topic categories — recognises universal doc types (regulatory, proxy)
  // plus framework-declared requiredDocTypes as the topic-primary class.
  type DocClass = "regulatory" | "proxy" | "topic-primary" | "other";
  const classifyDoc = (url: string, title: string): DocClass => {
    const u = (url || "").toLowerCase();
    const t = (title || "").toLowerCase();
    const haystack = u + " " + t;
    // Universal: SEC primary filings
    if (/sec\.gov\/archives\/edgar/.test(u) || /\b(10-?k|20-?f|40-?f)\b/.test(haystack) || /-\d{8}\.htm/.test(u)) return "regulatory";
    // Universal: proxy statements
    if (/proxy|def.?14a/.test(haystack)) return "proxy";
    // Framework-driven: does the doc's title/URL match any of the framework's requiredDocTypes?
    const requiredDocTypes = ((framework as any).requiredDocTypes as string[] | null) || [];
    for (const docType of requiredDocTypes) {
      const words = docType.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3);
      if (words.length === 0) continue;
      const matched = words.filter((w: string) => haystack.includes(w)).length;
      if (matched >= Math.min(2, words.length)) return "topic-primary";
    }
    return "other";
  };
  // Structural priority weights (dominate keyword density, which is capped below).
  const CLASS_BOOST: Record<DocClass, number> = {
    regulatory: 100000,
    proxy: 90000,
    "topic-primary": 80000,
    other: 1000,
  };
  interface DocEntry { text: string; url: string; score: number; precision: number; idx: number; cls: DocClass }

  // 37-B.1: topic-precision score using framework dataPatterns.
  // dataPatterns are framework-declared regexes that fire only on topic-specific text.
  // This differentiates documents that mention the topic generically from documents
  // that materially discuss it.
  const dataPatterns = ((framework as any).dataPatterns as string[] | null) || [];
  const dataPatternRegexes = dataPatterns.map((p: string) => {
    try { return new RegExp(p, "gi"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);

  const docEntries: DocEntry[] = documentTexts.map((text, idx) => {
    const lower = text.toLowerCase();
    let density = 0;
    for (const term of allQueryTerms) {
      const regex = new RegExp(`\\b${term}\\b`, "gi");
      const matches = lower.match(regex);
      density += Math.min(matches?.length || 0, 10);
    }
    // 37-B.1: topic precision — hits on framework's dataPatterns, uncapped.
    // These regex are framework-declared and topic-specific by design; more hits
    // means the document is materially about the framework's actual subject.
    let precision = 0;
    for (const rx of dataPatternRegexes) {
      rx.lastIndex = 0;
      const matches = lower.match(rx);
      precision += matches?.length || 0;
    }
    const url = documentUrls[idx] || "";
    const title = documentTitles?.[idx] || "";
    const cls = classifyDoc(url, title);
    // Keyword density is CAPPED so it only breaks ties WITHIN a class, never
    // overrides the structural class priority above.
    const requiredDocSlugs = ((framework as any).requiredDocTypes as string[] | null) || [];
    const slugWords = requiredDocSlugs.flatMap((s: string) => s.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3));
    const slugRe = slugWords.length > 0 ? new RegExp(slugWords.join("|"), "i") : null;
    const slugBonus = slugRe && slugRe.test(url) ? 200 : 0;
    const score = CLASS_BOOST[cls] + Math.min(density, 800) + slugBonus;
    return { text, url, score, precision, idx, cls };
  });

  // 37-B.1: sort by (class-score DESC, precision DESC, idx ASC).
  // idx ASC breaks final ties deterministically (37-A guarantees stable idx).
  docEntries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.precision !== a.precision) return b.precision - a.precision;
    return a.idx - b.idx;
  });

  console.log(`[${companyName}] Document priority ordering (top 5):`);
  for (const d of docEntries.slice(0, 5)) {
    console.log(`  [${d.cls}] score=${d.score} ${d.url.slice(0, 60)}`);
  }

  // Combine documents in priority order with CLASS-AWARE caps. Regulatory filings
  // and proxies (where the primary AI disclosures live) get the largest cap so
  // Item 1A / governance sections survive; sustainability PDFs get a smaller cap so
  // a single long ESG report cannot consume the budget at the expense of filings.
  // v3k: the regulatory cap was 260k, but a current 10-K can exceed that
  // (Amazon FY2025 = 307k chars). Truncating at 260k could cut the Item 1A AI
  // risk paragraphs that appear deep in the filing, which is the upstream half of
  // Bug 2 (the per-measure force-include can only recover what survives here).
  // Raise the regulatory cap so a single primary annual filing is never truncated;
  // proxy similarly raised. Sustainability stays small so one long ESG PDF cannot
  // crowd out the filings.
  const CAP_BY_CLASS: Record<DocClass, number> = {
    regulatory: 480000,
    proxy: 360000,
    "topic-primary": 160000,
    other: 120000,
  };

  // 38: uncapped reserve for high-precision documents.
  // Documents with >= HIGH_PRECISION_THRESHOLD dataPattern hits are materially about
  // the framework topic. Include ALL of them in the first pass in precision-DESC order,
  // each at its full class-cap. This eliminates the "which one wins reservation"
  // non-determinism when multiple documents in the same class share high precision.
  //
  // Design note: this is not unbounded — the total corpus is capped by
  // MAX_DOCS_RETURNED (90) upstream, and the summariser's downstream 600k skip
  // threshold + 560k BM25 pool cap the total content that reaches the scorer.
  // Reserving more high-precision documents just changes which ones get full-cap
  // allocation vs which ones get second-pass class-cap fill.
  const HIGH_PRECISION_THRESHOLD = 3;
  const highPrecisionEntries = docEntries.filter(e => e.precision >= HIGH_PRECISION_THRESHOLD);

  let combined = "";
  const includedIndexes = new Set<number>();
  // First pass: include ALL high-precision documents at their full class-cap,
  // in the existing (class-score DESC, precision DESC, idx ASC) sort order.
  for (const entry of highPrecisionEntries) {
    const cap = CAP_BY_CLASS[entry.cls];
    const docTitle = documentTitles?.[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
    includedIndexes.add(entry.idx);
  }
  // Second pass: remaining documents in sort order.
  for (const entry of docEntries) {
    if (includedIndexes.has(entry.idx)) continue;
    const cap = CAP_BY_CLASS[entry.cls];
    const docTitle = documentTitles?.[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
    includedIndexes.add(entry.idx);
  }

  // 37-B.3: emit warning when the assembled corpus fires zero dataPattern hits.
  // This is a diagnostic signal, not a hard block.
  const totalPrecision = docEntries.reduce((sum, e) => sum + (includedIndexes.has(e.idx) ? e.precision : 0), 0);
  const corpusTopicWarning = totalPrecision === 0 && dataPatternRegexes.length > 0
    ? `Corpus contains zero hits on framework dataPatterns (${dataPatterns.slice(0,3).join(", ")}...). Retrieval may have failed to surface topic-material evidence.`
    : undefined;
  if (corpusTopicWarning) {
    console.warn(`[${companyName}] 37-B.3: ${corpusTopicWarning}`);
  }

  // If total is small enough, skip summarization and use BM25 directly
  if (combined.length < 600000) {
    return { text: combined, model: "raw-pass", corpusTopicWarning };
  }

  // ─── HEADER-PRESERVING BM25 PRE-FILTER (v3g quote sourceUrl fix) ─────────────
  // The corpus is too large to pass whole. PREVIOUSLY we BM25-filtered then ran an
  // LLM "summarizer" whose output became the scoring corpus. That summary DROPPED
  // the "--- DOCUMENT: <title> [<url>] ---" headers and paraphrased the text, which
  // (a) made quote.sourceUrl impossible to resolve (no URL survived) and
  // (b) degraded verbatim quote fidelity. We now select the most relevant chunks
  // with BM25 and rebuild a corpus that RE-EMITS the document header (with URL)
  // whenever the source document changes — preserving provenance AND verbatim text.
  // The document-aware chunker carries docUrl/docTitle on every chunk.
  const docChunks = chunkDocuments(combined);
  const bm25Index = buildBM25Index(docChunks.map((c) => c.text));

  const scoredChunks = docChunks.map((chunk, idx) => ({
    idx,
    score: bm25Score(allQueryTerms, idx, bm25Index),
    chunk,
  }));
  scoredChunks.sort((a, b) => b.score - a.score);

  // v3g-fix: this is the CANDIDATE POOL for the downstream per-measure BM25 packs
  // (buildEvidencePacksForCategory), NOT the text sent to the grader. The grader
  // only ever sees ~20k-char per-measure packs selected from this pool. The prior
  // 200k cap was too small for the largest filers (Amazon/Apple/Alphabet): relevant
  // AI passages for some measures fell outside the window and never reached the
  // per-measure BM25, producing spurious "No / 0 quotes". Because enlarging the pool
  // does NOT enlarge the grading prompt, we set it close to the whole-corpus
  // threshold (600k) so coverage matches the old LLM-summary path while keeping the
  // header-preserving, verbatim output. Env-tunable.
  const MAX_RETRIEVAL_INPUT = parseInt(process.env.RETRIEVAL_CORPUS_MAX_CHARS || "560000", 10);
  // Select winning chunk indices up to the budget, then RESTORE document order so
  // the re-emitted headers group each document's chunks contiguously.
  // v3g-fix: PRIORITISE high-BM25 chunks, but do NOT stop the pool at the first
  // zero-score chunk. Many measures' evidence lives in prose that lacks the AI
  // query terms (governance/committee/proxy boilerplate), which scores 0 on BM25;
  // discarding it starved measures on large filers. Instead we fill the (generous)
  // budget with the remaining chunks in document order, so the candidate pool stays
  // broad. The downstream per-measure BM25 then picks the right ~20k for each
  // question. Use a Set to avoid double-adding.
  const selectedSet = new Set<number>();
  let budget = 0;

  // ─── v3k UPSTREAM GUARANTEE: reserve the current annual filing's Item 1A ──────
  // The per-measure force-include (passage-retrieval.ts) can only recover Item 1A
  // chunks that EXIST in this retrieval corpus. For the largest filers (e.g.
  // Amazon: 3.6M chars across 82 docs) the 10-K's risk-factor chunks could lose
  // the 560k BM25 budget competition and never reach the per-measure stage, so the
  // grader saw "no 10-K in evidence" and returned No/0 quotes. Here we RESERVE the
  // genuine Item 1A body chunks of the single best (most recent, EDGAR-primary,
  // non-proxy) annual filing FIRST, with a dedicated sub-budget, regardless of
  // BM25 score or document order. This guarantees Item 1A always reaches the pool.
  const ITEM1A_RESERVE_CHARS = parseInt(process.env.RETRIEVAL_ITEM1A_RESERVE_CHARS || "90000", 10);
  // v3j-r12 FIX (NVIDIA): the URL of the annual filing chosen by THIS reserve is the
  // single source of truth for which document the per-measure force-include should
  // anchor on. The category builder otherwise re-derives it on the COMPRESSED corpus
  // (where the proxy's DEF 14A cover page may not survive, defeating content guards)
  // and can pick the wrong doc. We capture it here and thread it downstream.
  let reservedAnnualUrl: string | undefined;
  try {
    const isEdgarPrimary = (u: string) => /sec\.gov\/archives\/edgar\/data\/\d+\//.test((u||"").toLowerCase()) && /\.htm/.test((u||"").toLowerCase());
    const isAnnualFiling = (u: string, t: string) => {
      const s = ((u||"") + " " + (t||"")).toLowerCase();
      return /sec\.gov\/archives\/edgar/.test((u||"").toLowerCase()) || /\b(10-?k|20-?f|40-?f)\b/.test(s) || /-\d{8}\.htm/.test((u||"").toLowerCase());
    };
    // A chunk is a genuine Item 1A BODY chunk if section-tagged item1a and it is
    // neither a table-of-contents line nor a pure cross-reference.
    const looksToc = (txt: string) => /\.{4,}\s*\d+\b/.test(txt) || (txt.match(/item\s+\d+[a-z]?\b/gi) || []).length >= 4;
    const isItem1aBody = (c: Chunk) => c.section === "item1a" && !looksToc(c.text) && c.text.length > 240;
    // Group candidate body chunks by source document.
    const byDoc = new Map<number, { idxs: number[]; url: string; title: string }>();
    docChunks.forEach((c, i) => {
      if (!isItem1aBody(c)) return;
      if (!isAnnualFiling(c.docUrl || "", c.docTitle || "")) return;
      const e = byDoc.get(c.docIndex) || { idxs: [], url: c.docUrl || "", title: c.docTitle || "" };
      e.idxs.push(i);
      byDoc.set(c.docIndex, e);
    });
    // Pick the best annual filing: prefer non-proxy, most recent (YYYYMMDD token),
    // then EDGAR-primary, then most body chunks.
    // v3k-r3 FIX: derive the filing date ROBUSTLY. The prior regex matched any
    // "20\d{2}" substring, so Apple's 2016 10-K filename a201610-k9242016.htm with
    // accession folder ...016020309 produced a SPURIOUS 2030 date that beat the
    // real aapl-20250927, and the grader received the 8-year-old filing. We now:
    //   1) prefer the canonical EDGAR/IR document-name date <name>-YYYYMMDD.(htm|pdf)
    //      or a yyyy-mm-dd token in the path (the true period-end / filing date);
    //   2) only then fall back to a VALIDATED 8-digit YYYYMMDD (month<=12, day<=31)
    //      to reject accession-number garbage like 20300000.
    const validYmd = (v: number): boolean => {
      if (v < 19900101 || v > 20401231) return false;
      const mo = Math.floor((v % 10000) / 100), da = v % 100;
      return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
    };
    const dateOf = (s: string) => {
      const hay = (s || "").toLowerCase();
      // (1) canonical filing-document name: ...-YYYYMMDD.htm/.pdf
      let best = 0;
      for (const m of hay.matchAll(/[a-z]+-?(20\d{6})\.(?:htm|pdf)/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
      // (1b) yyyy-mm-dd anywhere in the path (IR PDF mirrors)
      if (best === 0) for (const m of hay.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)) { const v = parseInt(m[1] + m[2] + m[3], 10); if (validYmd(v) && v > best) best = v; }
      // (2) validated bare 8-digit token
      if (best === 0) for (const m of hay.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
      // (3) last-resort year only (avoids accession garbage by capping month/day to 00)
      if (best === 0) for (const m of hay.matchAll(/\b(20[12]\d)\b/g)) { const v = parseInt(m[1] + "0000", 10); if (v > best) best = v; }
      return best;
    };
    const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|proxy card|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
    // v3j-r5 FIX (Meta/Oracle): EXCLUDE 10-Q / quarterly reports from annual-filing
    // selection. A 10-Q's EDGAR URL (e.g. meta-20260331.htm, period 2026-03-31)
    // matches the -YYYYMMDD.htm / edgar-archive shape just like a 10-K, and its
    // period date is NEWER than the most recent 10-K (meta-20251231), so the
    // recency sort picked the QUARTERLY filing and the grader narrated a 10-Q as
    // "the most recent annual filing" -- Item 1A risk factors live in the 10-K, not
    // the 10-Q. URL/title alone cannot distinguish them for issuers whose EDGAR
    // titles are a bare "meta-YYYYMMDD - SEC.gov", so we detect the form type from
    // the COVER-PAGE language carried in the document's own chunks: a 10-Q says
    // "QUARTERLY REPORT PURSUANT TO SECTION 13" / "for the quarterly period ended",
    // a 10-K says "ANNUAL REPORT PURSUANT TO SECTION 13" / "for the fiscal year
    // ended". We aggregate these markers across ALL of a candidate document's
    // chunks (the cover page is its own chunk, distinct from the Item 1A body) and
    // drop any document whose QUARTERLY markers are present without a stronger
    // ANNUAL marker.
    const quarterlyRe = /quarterly report pursuant to section 13|for the quarterly period ended|\bform 10-q\b/gi;
    const annualRe = /annual report pursuant to section 13|for the fiscal year ended|\bform 10-k\b/gi;
    // v3j-r7 FIX (Oracle 10-Q): the DEFINITIVE cover page of an SEC periodic filing
    // co-locates the form token with its statutory caption. ONLY a 10-Q carries
    // "FORM 10-Q" next to "QUARTERLY REPORT PURSUANT TO SECTION 13"; ONLY a 10-K
    // carries "FORM 10-K" next to "ANNUAL REPORT PURSUANT TO SECTION 13". These
    // cover markers are authoritative and immune to body cross-references (a 10-Q's
    // body cites "our Annual Report on Form 10-K for the fiscal year ended ..." many
    // times, which previously inflated the annual-marker count and let Oracle's
    // orcl-20250831 10-Q masquerade as an annual filing). We evaluate the cover
    // markers over the JOINED document text so a chunk split between the form token
    // and its caption does not defeat detection.
    const strongQuarterlyCoverRe = /form 10-q[\s\S]{0,400}quarterly report pursuant to section 13|quarterly report pursuant to section 13[\s\S]{0,400}form 10-q/i;
    const strongAnnualCoverRe = /form 10-k[\s\S]{0,400}annual report pursuant to section 13|annual report pursuant to section 13[\s\S]{0,400}form 10-k/i;
    // Map every chunk index to its document so we can scan the WHOLE document
    // (cover page included), not just the reserved Item 1A body chunks.
    const allChunkIdxByDoc = new Map<number, number[]>();
    docChunks.forEach((c, i) => { const a = allChunkIdxByDoc.get(c.docIndex) || []; a.push(i); allChunkIdxByDoc.set(c.docIndex, a); });
    // v3j-r11 FIX (NVIDIA): EXCLUDE DEF 14A proxy statements from annual-filing
    // selection. A proxy (e.g. nvda-20260512.htm) has an EDGAR -YYYYMMDD.htm URL
    // that matches the annual shape, a period date NEWER than the latest 10-K
    // (nvda-20260125), and 20+ "annual report"/"form 10-k" cross-references (a proxy
    // discusses the fiscal year and incorporates the 10-K by reference), so it beat
    // the genuine 10-K on recency and the reserve guaranteed proxy chunks that have
    // only a HEADER reference to Item 1A, never the risk-factor body -> grader
    // returned No/0 quotes. The prior `proxyDom` guard counted boilerplate only over
    // the doc's Item 1A body chunks, of which a proxy has ~none, so it never tripped.
    // The DEFINITIVE proxy signal is the cover/EDGAR form line "DEF 14A" or the
    // statutory caption "Proxy Statement Pursuant to Section 14(a)"; we scan the
    // WHOLE joined document text (cover page included).
    const strongProxyCoverRe = /\bdef[\s\u00a0]*14a\b|proxy statement pursuant to section 14\(a\)|notice of (?:20\d{2} )?annual meeting of (?:stockholders|shareholders)/i;
    const isProxyDoc = (di: number): boolean => {
      const joined = (allChunkIdxByDoc.get(di) || []).map((ix) => docChunks[ix].text).join("\n");
      // A genuine 10-K never carries the DEF 14A cover/caption; if a strong 10-K
      // cover is present, trust it over an incidental proxy cross-reference.
      if (strongAnnualCoverRe.test(joined)) return false;
      return strongProxyCoverRe.test(joined);
    };
    const isQuarterlyDoc = (di: number): boolean => {
      const joined = (allChunkIdxByDoc.get(di) || []).map((ix) => docChunks[ix].text).join("\n");
      // 1) Definitive 10-Q cover page => quarterly outright.
      if (strongQuarterlyCoverRe.test(joined)) return true;
      // 2) Definitive 10-K cover page => annual outright (never exclude).
      if (strongAnnualCoverRe.test(joined)) return false;
      // 3) Fallback marker balance for filings whose cover caption did not survive
      //    (quarterly present and not dominated by annual markers).
      const q = (joined.match(quarterlyRe) || []).length;
      const a = (joined.match(annualRe) || []).length;
      return q > 0 && q >= a;
    };
    const cands = [...byDoc.entries()].map(([di, e]) => {
      let proxyHits = 0;
      for (const ix of e.idxs) proxyHits += (docChunks[ix].text.match(strongProxyRe) || []).length;
      return { di, idxs: e.idxs, url: e.url, title: e.title, rec: dateOf(e.url + " " + e.title), edgar: isEdgarPrimary(e.url), proxyDom: proxyHits >= 10, proxy: isProxyDoc(di), quarterly: isQuarterlyDoc(di) };
    }).filter((c) => {
      if (c.proxyDom) return false;
      if (c.proxy) { console.log(`[${companyName}] [item1a-reserve] excluded DEF 14A proxy doc ${c.url.slice(0,60)} from annual-filing candidates`); return false; }
      if (c.quarterly) { console.log(`[${companyName}] [item1a-reserve] excluded 10-Q/quarterly doc ${c.url.slice(0,60)} from annual-filing candidates`); return false; }
      return true;
    });
    // v3k-r4 FIX (NVIDIA): when two filings fall in the SAME period (<=150 days
    // apart) they are the same annual filing in different sources (e.g. the EDGAR
    // primary nvda-20260125.htm vs the fortune.com .../2026-02-25 PDF mirror of the
    // SAME FY2026 10-K). Prefer the canonical EDGAR-primary HTML so the reserved
    // Item 1A and downstream citations resolve to EDGAR, not a third-party mirror.
    // A genuinely newer filing (outside the window) still wins outright on recency.
    const SAME_PERIOD_DAYS = 150;
    const ord = (v: number): number => { if (v <= 0) return 0; const y = Math.floor(v/10000), mo = Math.floor((v%10000)/100)||1, da = (v%100)||1; return y*365 + mo*30 + da; };
    cands.sort((a, b) => {
      // v3j-r5 FIX (Oracle): a DATELESS third-party mirror (rec=0) must never outrank
      // a DATED filing of the SAME annual report, so citations resolve to the
      // canonical EDGAR HTML rather than a PDF mirror (e.g. stocklight.com).
      const aDateless = a.rec === 0, bDateless = b.rec === 0;
      if (aDateless !== bDateless) return aDateless ? 1 : -1;
      const samePeriod = Math.abs(ord(a.rec) - ord(b.rec)) <= SAME_PERIOD_DAYS || aDateless;
      if (!samePeriod) return b.rec - a.rec;             // clearly newer wins
      if (a.edgar !== b.edgar) return a.edgar ? -1 : 1;  // same period: EDGAR beats mirror
      if (a.rec !== b.rec) return b.rec - a.rec;         // then newer
      if (a.idxs.length !== b.idxs.length) return b.idxs.length - a.idxs.length; // then more body chunks
      return a.di - b.di;
    });
    if (cands.length > 0) {
      const best = cands[0];
      // Reserve earliest body chunks (document order) up to the Item 1A sub-budget.
      const ordered = best.idxs.slice().sort((x, y) => (docChunks[x].seqInDoc ?? x) - (docChunks[y].seqInDoc ?? y));
      let reserved = 0;
      for (const ix of ordered) {
        if (reserved + docChunks[ix].text.length > ITEM1A_RESERVE_CHARS) continue;
        if (!selectedSet.has(ix)) { selectedSet.add(ix); budget += docChunks[ix].text.length; reserved += docChunks[ix].text.length; }
      }
      reservedAnnualUrl = best.url || undefined;
      console.log(`[${companyName}] [item1a-reserve] reserved ${reserved} chars (${ordered.length} body chunks avail) from ${best.url.slice(0,70)}`);
    } else {
      console.log(`[${companyName}] [item1a-reserve] no genuine Item 1A body chunks found among annual filings`);
    }
  } catch (e) {
    console.warn(`[${companyName}] [item1a-reserve] skipped: ${(e as Error).message}`);
  }

  for (const sc of scoredChunks) {
    if (sc.score <= 0) continue;
    if (budget + sc.chunk.text.length > MAX_RETRIEVAL_INPUT) break;
    if (selectedSet.has(sc.idx)) continue;
    selectedSet.add(sc.idx);
    budget += sc.chunk.text.length;
  }
  // Fill remaining budget with any not-yet-selected chunks in document order so the
  // pool covers low/zero-BM25 passages too (coverage parity with the old summary).
  if (budget < MAX_RETRIEVAL_INPUT) {
    for (let i = 0; i < docChunks.length; i++) {
      if (selectedSet.has(i)) continue;
      if (budget + docChunks[i].text.length > MAX_RETRIEVAL_INPUT) continue;
      selectedSet.add(i);
      budget += docChunks[i].text.length;
    }
  }
  const selectedIdx: number[] = [...selectedSet].sort((a, b) => a - b); // document/sequence order

  let relevantText = "";
  let lastDocIndex = -1;
  for (const i of selectedIdx) {
    const ch = docChunks[i];
    if (ch.docIndex !== lastDocIndex) {
      const title = ch.docTitle || `Document ${ch.docIndex + 1}`;
      relevantText += ch.docUrl
        ? `\n\n--- DOCUMENT: ${title} [${ch.docUrl}] ---\n\n`
        : `\n\n--- DOCUMENT: ${title} ---\n\n`;
      lastDocIndex = ch.docIndex;
    }
    relevantText += ch.text + "\n\n";
  }

  console.log(`[${companyName}] Header-preserving retrieval corpus: ${relevantText.length} chars (BM25-selected from ${combined.length} total, ${selectedIdx.length} chunks)`);

  // Cache the retrieval corpus (versioned key so old header-lossy summaries are
  // never reused). The model tag documents the new provenance-preserving path.
  await storage.cacheSummary({
    companyId,
    documentHash: docHash,
    summary: relevantText,
    summarizerModel: "bm25-headers-v3l-topicaware",
  });

  return { text: relevantText, model: "bm25-headers-v3l-topicaware", reservedAnnualUrl, corpusTopicWarning };
}

// ─── Main Analysis Entry Point ───────────────────────────────────────────────

export async function analyzeCompanyMeasures(opts: {
  workspaceId: number;
  companyName: string;
  companyId: number;
  documentTexts: string[];
  documentUrls: string[];
  documentTitles?: string[];
  framework: Framework;
  measures: FrameworkMeasure[];
  temporalContext?: { withdrawals: Array<{ type: string; description: string; affectedTopics: string[]; detectedDate: string | null; confidence: string }>; temporalWarning: string | null };
  // v3e (Section 4): per-run opt-out of the verdict cache for variability studies.
  freshScoring?: boolean;
}): Promise<AnalysisResult> {
  const { workspaceId, companyName, companyId, documentTexts, documentUrls, documentTitles, framework, measures, temporalContext, freshScoring } = opts;

  // Load settings fresh for every analysis call
  const settings = await loadAnalysisSettings(workspaceId);

  console.log(`[${companyName}] Starting analysis: ${measures.length} measures, ${documentTexts.length} documents`);

  // v3e (Section 3): determine which broad SOURCE TYPES the corpus actually
  // contains (topic-agnostic). Measures that declare requiredSourceTypes none of
  // which are present will be ABSTAINED ("Insufficient evidence") rather than
  // scored a hard "No", and excluded from the answered-measures denominator.
  const declaredSourceTypes = Array.from(new Set(
    measures.flatMap((measure) => ((measure as any).requiredSourceTypes || []) as string[])
  ));
  const availableSourceTypes = corpusSourceTypes(
    (documentUrls || []).map((url, idx) => ({ url, title: documentTitles?.[idx] || "" })),
    declaredSourceTypes,
  );
  console.log(`[${companyName}] Corpus source types: [${Array.from(availableSourceTypes).join(", ") || "none"}]`);

  // v3e (Section 4): verdict cache (opt-in, ON by default). When enabled and not
  // explicitly bypassed via freshScoring, load any prior verdicts so measures with
  // an IDENTICAL evidence fingerprint can reuse the prior verdict (reproducibility).
  const verdictCacheEnabled = settings.verdictCacheEnabled && !freshScoring;
  let priorScoresByMeasure: Map<string, any> | null = null;
  if (verdictCacheEnabled) {
    try {
      const prior = await storage.getMeasureScores(companyId, framework.id);
      if (prior && prior.length > 0) {
        priorScoresByMeasure = new Map(prior.map((p: any) => [p.measureId, p]));
        console.log(`[${companyName}] Verdict cache: loaded ${prior.length} prior verdict(s) for fingerprint comparison`);
      }
    } catch (e: any) {
      console.warn(`[${companyName}] Verdict cache: could not load prior scores: ${e?.message}`);
    }
  } else {
    console.log(`[${companyName}] Verdict cache: DISABLED (${freshScoring ? "freshScoring opt-out" : "setting off"}) — fresh scoring`);
  }

  // Stage: Multilingual translation (DeepSeek). Translate only the foreign-
  // language portions of fetched documents to English BEFORE terminology,
  // summarization, BM25 retrieval, and the English topic-floor run — so the
  // whole downstream pipeline operates over English while originals are
  // preserved inline for audit. English documents pass through untouched.
  let workingTexts = documentTexts;
  try {
    const tr = await translateDocumentsToEnglish(documentTexts);
    workingTexts = tr.texts;
    if (tr.translatedCount > 0) {
      console.log(`[${companyName}] Multilingual: translated ${tr.translatedCount}/${documentTexts.length} document(s) to English (${tr.charsTranslated} chars via DeepSeek)`);
    }
  } catch (trErr: any) {
    console.warn(`[${companyName}] Multilingual translation skipped: ${trErr?.message}`);
  }

  // Stage: Terminology discovery
  let terminology: TerminologyMap | undefined;
  if (settings.terminologyDiscoveryEnabled) {
    terminology = await discoverCompanyTerminology({
      companyName,
      companyId,
      frameworkId: framework.id,
      topicDescription: framework.topicDescription || framework.name,
      documentTexts: workingTexts,
    });
  }

  // Stage: Summarization / raw-pass (operates over translated workingTexts)
  const totalChars = workingTexts.reduce((sum, t) => sum + t.length, 0);
  let combinedText: string;
  let summarizerModel: string;
  // v3j-r12 FIX (NVIDIA): the annual-filing URL chosen by the upstream item1a-reserve
  // (over the full uncompressed corpus). Threaded into the category/deep pack builders
  // so the per-measure force-include anchors on the SAME doc, not a compressed-view
  // re-derivation that a DEF 14A proxy could win.
  let reservedAnnualUrl: string | undefined;

  if (settings.useBm25Retrieval && totalChars <= settings.bm25SkipSummarizationBelowChars) {
    // BM25-skip path: use raw text directly with document title headers
    combinedText = workingTexts.map((text, idx) => {
      const title = documentTitles?.[idx] || documentUrls[idx] || `Document ${idx + 1}`;
      const url = documentUrls[idx] || "";
      return `\n\n--- DOCUMENT: ${title} [${url}] ---\n\n${text}`;
    }).join("");
    summarizerModel = "bm25-direct";
    console.log(`[${companyName}] BM25-skip path (${totalChars} chars < ${settings.bm25SkipSummarizationBelowChars})`);
  } else {
    const result = await summarizeDocuments({
      companyName,
      companyId,
      documentTexts: workingTexts,
      documentUrls,
      documentTitles,
      topicDescription: framework.topicDescription || framework.name,
      framework,
    });
    combinedText = result.text;
    summarizerModel = result.model;
    reservedAnnualUrl = result.reservedAnnualUrl;
    console.log(`[${companyName}] Summarized via ${summarizerModel} (${combinedText.length} chars)${reservedAnnualUrl ? ` reservedAnnual=${reservedAnnualUrl.slice(0,70)}` : ""}`);
  }

  // Layer B/D — derive the framework's topic lexicon and measure how much
  // topic-relevant evidence the corpus actually contains. TOPIC-AGNOSTIC: the
  // lexicon is expanded from the framework's own topic description + measure
  // wording (LLM-backed, cached per framework), so retrieval works for ANY topic
  // and catches issuers that use adjacent vocabulary (e.g. "machine learning" /
  // "generative AI" for an AI framework). Falls back to deterministic tokens.
  const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  let topicTerms = deterministicTerms;
  try {
    const lex = await deriveTopicLexicon({
      frameworkId: framework.id,
      workspaceId,
      topicDescription: framework.topicDescription,
      frameworkName: framework.name,
      measureTitles: measures.map((m) => `${m.title}${m.definition ? " — " + m.definition : ""}`),
    });
    if (lex.terms.length > 0) {
      topicTerms = [...new Set([...lex.terms, ...deterministicTerms])];
      console.log(`[${companyName}] Topic lexicon (${lex.source}): ${lex.terms.length} framework terms + ${deterministicTerms.length} deterministic -> ${topicTerms.length} total`);
    }
  } catch (lexErr: any) {
    console.warn(`[${companyName}] Topic lexicon derivation failed, using deterministic terms: ${lexErr?.message}`);
  }
  const corpusTopicStats = computeCorpusTopicStats(combinedText, topicTerms);
  console.log(`[${companyName}] Corpus topic evidence: ${corpusTopicStats.topicChunks}/${corpusTopicStats.totalChunks} chunks contain topic terms (${corpusTopicStats.topicHits} hits)`);

  // Group measures by category
  const categoryMap = new Map<string, FrameworkMeasure[]>();
  for (const measure of measures) {
    const key = measure.category;
    if (!categoryMap.has(key)) categoryMap.set(key, []);
    categoryMap.get(key)!.push(measure);
  }

  // Stage: Score each category
  const allResults: MeasureResult[] = [];
  const scoringProvider = settings.scoringProvider;

  for (const [category, categoryMeasures] of categoryMap) {
    console.log(`[${companyName}] Scoring category: ${category} (${categoryMeasures.length} measures)`);

    // Build evidence packs via BM25
    let evidencePacks: Array<{ measureId: string; text: string; topicHits?: number; fingerprint?: string; fingerprintEligible?: boolean; forceIncludedCount?: number; requiredDocPresent?: boolean; forceIncludedDocUrl?: string }>;
    if (settings.useBm25Retrieval) {
      evidencePacks = buildEvidencePacksForCategory({
        measures: categoryMeasures,
        combinedText,
        terminology,
        topicTerms,
        companyId,          // v3g (Bug 1): collision-free fingerprint identity
        frameworkId: framework.id,
        // v3j-r12 FIX (NVIDIA): anchor the per-measure annual-filing force-include on
        // the SAME document the upstream item1a-reserve chose, instead of re-deriving
        // it on the compressed corpus (where a DEF 14A proxy could win).
        reservedAnnualUrl,
      });
    } else {
      // No BM25: use full text for all measures
      const fullSlice = combinedText.slice(0, 10000);
      const sliceHits = computeCorpusTopicStats(fullSlice, topicTerms).topicHits;
      evidencePacks = categoryMeasures.map((m) => ({
        measureId: m.measureId,
        text: fullSlice,
        topicHits: sliceHits,
      }));
    }

    // Shared corpus index for the targeted deep-read second pass (built once per
    // category, reused across measures). Only built when BM25 retrieval is on.
    let deepChunks: Chunk[] | null = null;
    let deepBm25Index: ReturnType<typeof buildBM25Index> | null = null;
    const buildDeepIndex = () => {
      if (deepChunks === null) {
        deepChunks = chunkDocuments(combinedText);
        deepBm25Index = buildBM25Index(deepChunks.map((c) => c.text));
      }
    };

    // Deep-read budget (env-tunable). Much larger than the normal per-measure
    // budget; used only for measures that came back under-evidenced.
    const DEEP_TOP_K = parseInt(process.env.RETRIEVAL_DEEPREAD_TOP_K || "40", 10);
    const DEEP_MAX_CHARS = parseInt(process.env.RETRIEVAL_DEEPREAD_MAX_CHARS || "40000", 10);
    const DEEPREAD_ENABLED = (process.env.RETRIEVAL_DEEPREAD_ENABLED || "true").toLowerCase() !== "false";

    // Score measures in parallel (batch of 5 concurrent)
    const MEASURE_CONCURRENCY = 5;
    const scoreMeasure = async (measure: FrameworkMeasure): Promise<MeasureResult> => {
      const evidencePack = evidencePacks.find((e) => e.measureId === measure.measureId);
      const evidenceText = evidencePack?.text || "";

      // v3e (Section 3): ABSTAIN GATE. If this measure declares requiredSourceTypes
      // and NONE of them are present in the corpus, we cannot answer it — emit an
      // "Insufficient evidence" verdict (abstained) instead of a misleading hard
      // "No". Abstained measures are excluded from the answered-measures denominator
      // downstream. TOPIC-AGNOSTIC: requiredSourceTypes are framework-authored
      // document categories, so this behaves correctly for any framework.
      const required = ((measure as any).requiredSourceTypes as string[] | null | undefined) || [];
      if (Array.isArray(required) && required.length > 0) {
        const satisfied = required.some((t) => availableSourceTypes.has(t));
        if (!satisfied) {
          console.log(`[${companyName}] ABSTAIN ${measure.measureId}: requires [${required.join(", ")}], corpus has none`);
          return {
            measureId: measure.measureId,
            title: measure.title,
            definition: measure.definition,
            category: measure.category,
            categoryNumber: measure.categoryNumber,
            score: 0,
            coverage: "none",
            confidence: "Low",
            evidenceSummary: `Insufficient evidence: this measure requires source type(s) [${required.join(", ")}], none of which were found in the company's available documents. Excluded from the answered-measures denominator rather than scored "No".`,
            quotes: [],
            verdict: "Insufficient evidence",
            verdictNuance: "Abstained — required source type absent from corpus (not a substantive No).",
            displayOrder: measure.displayOrder,
            abstained: true,
            evidenceFingerprint: null,
          };
        }
      }

      // Fallback: if BM25 retrieval returns < 1000 chars, do NOT dump generic
      // corpus text. The old approach (combinedText.slice(0, 10000)) fed non-topic
      // text to the scorer, causing false positives when general governance language
      // was conflated with topic-specific evidence. Instead, keep the thin evidence
      // as-is — the scorer will see insufficient evidence and score accordingly.
      // The deep-read second pass (below) handles the genuine under-evidenced case
      // where topic content exists in the corpus but wasn't surfaced by normal BM25.
      const finalEvidence = evidenceText;

      let measureResult: MeasureResult;

      // Get temporal warning if available
      const tw = temporalContext?.temporalWarning || null;

      if (settings.ensembleScoring) {
        // Ensemble: run multiple passes
        measureResult = await scoreWithEnsemble({
          companyName,
          companyId,
          measure,
          evidenceText: finalEvidence,
          terminology,
          topicDescription: framework.topicDescription || framework.name,
          settings,
          temporalWarning: tw,
          framework,
        });
      } else {
        // Single pass
        measureResult = await scoreSingleMeasure({
          companyName,
          companyId,
          measure,
          evidenceText: finalEvidence,
          terminology,
          topicDescription: framework.topicDescription || framework.name,
          provider: scoringProvider,
          temporalWarning: tw,
          scoringMode: settings.scoringMode,
          framework,
        });
      }

      // Provenance check
      if (measureResult.score > 0 && measureResult.quotes.length > 0) {
        const allVerified = measureResult.quotes.every(
          (q) => verifyQuoteProvenance(q.text, finalEvidence).found
        );
        if (!allVerified) {
          // Demote to Low confidence instead of zeroing (fix for Known Issue #5)
          measureResult.confidence = "Low";
          measureResult.verdictNuance = (measureResult.verdictNuance || "") +
            " [Note: Some quotes could not be verified verbatim in source text]";
        }
      }

      // Low-confidence positive handling
      if (measureResult.score > 0 && measureResult.confidence === "Low") {
        if (settings.lowConfidenceHandling === "downgrade") {
          // Downgrade to Partial (0.5) — preserves the evidence but reduces the score
          if (measureResult.score === 1) {
            measureResult.score = 0.5;
            measureResult.verdict = "Partial";
            measureResult.verdictNuance = (measureResult.verdictNuance || "") +
              " [Auto-downgraded: Low confidence positive reduced to Partial]";
          }
        } else if (settings.lowConfidenceHandling === "flag") {
          // Flag for review — keep score but mark in nuance
          measureResult.verdictNuance = (measureResult.verdictNuance || "") +
            " [NEEDS REVIEW: Low confidence positive — manual verification recommended]";
        }
        // "keep" = do nothing, accept the score as-is
      }

      // Source normalization: ensure quote sources match actual document titles
      if (measureResult.quotes.length > 0) {
        measureResult.quotes = normalizeQuoteSources(measureResult.quotes, finalEvidence);
      }

      // Contradiction detection + tie-breaker
      measureResult = await detectAndResolvContradiction({
        measure,
        result: measureResult,
        evidenceText: finalEvidence,
        primaryProvider: scoringProvider,
      });

      // Layer D — Honest coverage signal. Previously hardcoded to null, which let
      // a 0% score coexist with a "full coverage" label. We now base coverage on
      // whether topic-relevant evidence actually reached this measure's pack and
      // whether the corpus contained any topic evidence at all. This flags the
      // genuine "under-evidenced" cases for review instead of mislabeling them.
      const packTopicHits = (evidencePack as EvidencePack | undefined)?.topicHits ?? 0;
      let coverageLabel: string;
      if (packTopicHits >= 3) coverageLabel = "full";
      else if (packTopicHits >= 1) coverageLabel = "partial";
      else if (corpusTopicStats.topicChunks === 0) coverageLabel = "none"; // corpus genuinely has no topic content
      else coverageLabel = "low"; // topic evidence exists in corpus but did not reach this pack
      measureResult.coverage = coverageLabel;

      // ─── Targeted deep-read second pass (under-evidenced measures only) ──────
      // When a measure scored 0/Partial AND coverage is "low" — meaning the
      // corpus DOES contain topic-relevant evidence but the normal-budget pack
      // failed to surface enough of it for this specific question — re-retrieve
      // this one measure with a much larger, topic-biased budget and re-score.
      // This spends extra effort precisely where evidence was thin, directly
      // attacking the "0% / under-evidenced" pattern without lowering standards
      // or wasting compute on measures that are already well-evidenced or that
      // genuinely have no topic content in the corpus ("none").
      const eligibleForDeepRead =
        DEEPREAD_ENABLED &&
        settings.useBm25Retrieval &&
        coverageLabel === "low" &&
        measureResult.score < 1;

      if (eligibleForDeepRead) {
        try {
          buildDeepIndex();
          if (deepChunks && deepBm25Index) {
            const deepPack = buildEvidencePackForMeasure({
              measure,
              chunks: deepChunks,
              bm25Index: deepBm25Index,
              terminology,
              topicTerms,
              topK: DEEP_TOP_K,
              maxChars: DEEP_MAX_CHARS,
              companyId,            // v3g (Bug 1): collision-free fingerprint identity
              frameworkId: framework.id,
              // v3j-r7 FIX (Oracle): keep the deep-read pass anchored on the same
              // canonical EDGAR annual filing as the category pass.
              // v3j-r12 FIX (NVIDIA): prefer the upstream-reserved URL when available.
              preferredAnnualUrl: reservedAnnualUrl || computePreferredAnnualUrl(deepChunks),
            });
            // Only re-score if the deep pass actually surfaced more topic evidence
            // than the original pack (otherwise re-scoring adds cost for no gain).
            if (deepPack.topicHits > packTopicHits && deepPack.text.length > 0) {
              console.log(`[${companyName}] Deep-read re-score for ${measure.measureId}: topicHits ${packTopicHits}→${deepPack.topicHits}, evidence ${finalEvidence.length}→${deepPack.text.length} chars`);
              let deepResult: MeasureResult;
              if (settings.ensembleScoring) {
                deepResult = await scoreWithEnsemble({
                  companyName,
                  companyId,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  settings,
                  temporalWarning: tw,
                  framework,
                });
              } else {
                deepResult = await scoreSingleMeasure({
                  companyName,
                  companyId,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  provider: scoringProvider,
                  temporalWarning: tw,
                  scoringMode: settings.scoringMode,
                  framework,
                });
              }
              // Verify provenance of any quotes against the deep evidence.
              if (deepResult.score > 0 && deepResult.quotes.length > 0) {
                const allVerified = deepResult.quotes.every(
                  (q) => verifyQuoteProvenance(q.text, deepPack.text).found
                );
                if (!allVerified) {
                  deepResult.confidence = "Low";
                  deepResult.verdictNuance = (deepResult.verdictNuance || "") +
                    " [Note: Some quotes could not be verified verbatim in source text]";
                }
                deepResult.quotes = normalizeQuoteSources(deepResult.quotes, deepPack.text);
              }
              // Adopt the deep result only if it is at least as strong (we never
              // lower a score via the deep pass — it can only recover missed
              // evidence, consistent with not inflating or deflating standards).
              if (deepResult.score >= measureResult.score) {
                deepResult.coverage = deepPack.topicHits >= 3 ? "full" : deepPack.topicHits >= 1 ? "partial" : coverageLabel;
                deepResult.verdictNuance = (deepResult.verdictNuance || "") +
                  " [Deep-read pass: re-scored on expanded evidence]";
                // v3j: the adopted deep pack ran its own force-include; use its
                // provenance so the invariant reflects what actually scored.
                deepResult.forceIncludedCount = (deepPack as any).forceIncludedCount ?? 0;
                deepResult.requiredDocPresent = (deepPack as any).requiredDocPresent ?? false;
                deepResult.forceIncludedDocUrl = (deepPack as any).forceIncludedDocUrl;
                measureResult = deepResult;
              }
            }
          }
        } catch (deepErr: any) {
          console.warn(`[${companyName}] Deep-read pass failed for ${measure.measureId}: ${deepErr.message}`);
          // Keep the original result on any failure.
        }
      }

      // v3e (Section 4): stamp the evidence fingerprint onto the result so it is
      // persisted and can be compared across runs for drift detection / caching.
      measureResult.evidenceFingerprint = evidencePack?.fingerprint || null;
      measureResult.abstained = false;

      // v3j (Bug 2): carry force-include provenance for the run-level invariant.
      // If the deep-read pass adopted its own pack, prefer that pack's numbers
      // (set on the deepPack above); otherwise use the normal pack's.
      if (measureResult.forceIncludedCount === undefined) {
        measureResult.forceIncludedCount = (evidencePack as any)?.forceIncludedCount ?? 0;
        measureResult.requiredDocPresent = (evidencePack as any)?.requiredDocPresent ?? false;
        measureResult.forceIncludedDocUrl = (evidencePack as any)?.forceIncludedDocUrl;
      }

      // v3g (Bug 1): an empty/degenerate pack is NOT cache-eligible — its sentinel
      // fingerprint must never satisfy a cache hit.
      const fingerprintEligible = (evidencePack as any)?.fingerprintEligible !== false;

      // v3e (Section 4) / v3g (Bug 1): VERDICT CACHE (now OPT-IN, default OFF — see
      // loadAnalysisSettings). When enabled and a prior verdict exists for this
      // company+measure with an IDENTICAL, cache-eligible evidence fingerprint,
      // reuse it for reproducibility. The freshly-computed fingerprint is always
      // persisted; drift is logged.
      if (verdictCacheEnabled && fingerprintEligible && priorScoresByMeasure) {
        const prior = priorScoresByMeasure.get(measure.measureId);
        const fp = measureResult.evidenceFingerprint;
        if (prior && fp && prior.evidenceFingerprint && prior.evidenceFingerprint === fp) {
          // v3g (Bug 1 §3 action 4): explicit, auditable cache-hit log including the
          // matching fingerprint and the prior verdict being reused, so silent
          // cross-entity reuse is impossible to miss in production.
          console.log(`[${companyName}] CACHE-HIT ${measure.measureId}: fingerprint=${fp.slice(0, 12)} reusing prior verdict="${prior.verdict}" (priorScore=${prior.score})`);
          return {
            ...measureResult,
            score: typeof prior.score === "number" ? prior.score : measureResult.score,
            verdict: (prior.verdict as MeasureResult["verdict"]) || measureResult.verdict,
            confidence: prior.confidence || measureResult.confidence,
            evidenceSummary: prior.evidenceSummary || measureResult.evidenceSummary,
            verdictNuance: (prior.verdictNuance || measureResult.verdictNuance || "") + " [Reused: identical evidence fingerprint]",
          };
        } else if (prior && fp && prior.evidenceFingerprint && prior.evidenceFingerprint !== fp) {
          console.log(`[${companyName}] EVIDENCE-DRIFT ${measure.measureId}: fingerprint changed ${prior.evidenceFingerprint.slice(0, 8)} -> ${fp.slice(0, 8)} (re-scored)`);
        }
      }

      return measureResult;
    };

    // Process measures in concurrent batches
    for (let i = 0; i < categoryMeasures.length; i += MEASURE_CONCURRENCY) {
      const batch = categoryMeasures.slice(i, i + MEASURE_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(scoreMeasure));
      allResults.push(...batchResults);
    }
  }

  // Roll up scores (works for both binary and partial mode since partial gives 0.5).
  // v3e (Section 3): ANSWERED-MEASURES DENOMINATOR. Abstained measures
  // ("Insufficient evidence") are excluded from BOTH numerator and denominator so
  // a missing required source no longer drags the score down as if it were a
  // substantive "No". scorePercentage is computed over answered measures only.
  const abstainedResults = allResults.filter((r) => r.abstained);
  const answeredResults = allResults.filter((r) => !r.abstained);
  const abstainedCount = abstainedResults.length;
  const answeredCount = answeredResults.length;
  const measuresTotal = measures.length;
  const totalScore = answeredResults.reduce((sum, r) => sum + r.score, 0);
  const denominator = answeredCount > 0 ? answeredCount : 1; // avoid /0 when all abstained
  const scorePercentage = Math.round((totalScore / denominator) * 100);
  if (abstainedCount > 0) {
    console.log(`[${companyName}] Answered-measures denominator: ${answeredCount}/${measuresTotal} answered, ${abstainedCount} abstained (insufficient evidence)`);
  }

  // ─── v3j (Bug 2): RUN-LEVEL FORCE-INCLUDE INVARIANT ─────────────────────────
  // For every NON-abstained measure whose required document WAS present in the
  // corpus, at least one genuine body chunk MUST have been force-included. If a
  // required document is present but nothing was forced, the deterministic
  // guarantee failed (the exact Bug-2 regression). We collect violations, log
  // them loudly, and surface them so the worker can gate the portfolio run.
  const fiViolations: Array<{ measureId: string; reason: string }> = [];
  let fiChecked = 0;
  for (const r of allResults) {
    if (r.abstained) continue;
    if (r.requiredDocPresent) {
      fiChecked++;
      if (!r.forceIncludedCount || r.forceIncludedCount < 1) {
        fiViolations.push({
          measureId: r.measureId,
          reason: `required document present in corpus but forceIncludedCount=${r.forceIncludedCount ?? 0}`,
        });
      }
    }
  }
  const forceIncludeInvariant = { ok: fiViolations.length === 0, checked: fiChecked, violations: fiViolations };
  if (!forceIncludeInvariant.ok) {
    console.error(`[${companyName}][invariant][FAIL] force-include invariant violated for ${fiViolations.length} measure(s): ${fiViolations.map((v) => v.measureId).join(", ")}`);
  } else {
    console.log(`[${companyName}][invariant][OK] force-include invariant satisfied (${fiChecked} filing-bound measure(s) with required doc present all received forced body chunks)`);
  }

  // Generate summary narrative
  let summary = await generateSummaryNarrative(companyName, allResults, scorePercentage, framework);

  // 41-H: Guard against contradictory 0-score summaries.
  // If measuresMet === 0 but the summary claims robustness/completeness, replace with deterministic fallback.
  const measuresMet = allResults.filter(r => r.verdict === "Yes").length;
  if (measuresMet === 0 && scorePercentage === 0) {
    const positiveClaims = /\b(robust|comprehensive|fully meet|fully meets|full alignment|strong|leading)\b/i;
    if (positiveClaims.test(summary)) {
      summary = `${companyName} scored 0% on the ${framework.name}, failing to meet any of the ${measuresTotal} assessment measures. The evidence pack did not contain material that satisfied the framework's criteria; retrieval or scoring conditions for this issuer should be reviewed before treating the zero as legitimate.`;
    }
  }

  // Group results by category for output
  const categoryResults = Array.from(categoryMap.entries()).map(([category, categoryMeasures]) => ({
    category,
    categoryNumber: categoryMeasures[0].categoryNumber,
    measures: allResults.filter((r) => r.category === category),
  }));

  // I45: Compute scoring diagnostics for fleet-score regression investigation.
  // These are persisted alongside the analysis result so Gate Report diagnostics
  // can expose score-stage input counts, evidence passage counts, model response
  // validity, timeout counts, and fallback/default-score usage.
  const allMeasureResultsFlat = allResults;
  const scoringFailures = allMeasureResultsFlat.filter((r) => (r as any)._scoringFailure).length;
  const timeoutFailures = allMeasureResultsFlat.filter((r) => (r as any)._scoringFailure === "timeout").length;
  const fallbackUsed = allMeasureResultsFlat.filter((r) => {
    const gradedBy = (r as any)._gradedBy || "";
    return gradedBy && gradedBy !== scoringProvider && !gradedBy.includes("+");
  }).length;
  const defaultScoreUsed = allMeasureResultsFlat.filter((r) => r.score === 0 && r.confidence === "Low" && !r.abstained).length;
  const selfConsistencyPasses = Math.max(1, parseInt(process.env.SCORING_SELF_CONSISTENCY || "3", 10));

  const scoringDiagnostics = {
    totalMeasures: measuresTotal,
    scoredMeasures: answeredCount,
    scoringFailures,
    timeouts: timeoutFailures,
    fallbackUsed,
    defaultScoreUsed,
    evidencePackCounts: {
      total: allMeasureResultsFlat.length,
      empty: allMeasureResultsFlat.filter((r) => r.coverage === "none").length,
      lowTopic: allMeasureResultsFlat.filter((r) => r.coverage === "low").length,
    },
    modelResponseValidity: {
      valid: allMeasureResultsFlat.filter((r) => !(r as any)._scoringFailure && r.confidence !== "Low").length,
      repaired: allMeasureResultsFlat.filter((r) => r.verdictNuance?.includes("[Note: Some quotes could not be verified")).length,
      failed: scoringFailures,
    },
    selfConsistencyPasses,
  };

  console.log(`[${companyName}] Scoring diagnostics: failures=${scoringFailures}, timeouts=${timeoutFailures}, fallback=${fallbackUsed}, defaultScore=${defaultScoreUsed}, emptyEvidence=${scoringDiagnostics.evidencePackCounts.empty}`);
  console.log(`[${companyName}] Analysis complete: ${scorePercentage}% (${totalScore}/${answeredCount} answered; ${abstainedCount} abstained of ${measuresTotal} total)`);

  return {
    totalScore,
    scorePercentage,
    summary,
    answeredCount,
    abstainedCount,
    measuresTotal,
    categories: categoryResults.sort((a, b) => a.categoryNumber - b.categoryNumber),
    forceIncludeInvariant,
    scoringDiagnostics,
  };
}

// ─── Single Measure Scoring ──────────────────────────────────────────────────

// I36-B: Verdict cache — identical evidence + measure + provider = identical result.
// Eliminates scorer non-determinism from provider-side sampling noise.
const VERDICT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const verdictCache = new Map<string, { result: MeasureResult; ts: number }>();

// I45: Include companyId in verdict cache key to prevent cross-company cache
// contamination when the same measureId+evidence hash collides across companies.
function verdictCacheKey(measureId: string, evidenceText: string, provider: string, scoringMode: string, promptText?: string, companyId?: number): string {
  const evidenceHash = createHash("sha256").update(evidenceText).digest("hex").slice(0, 16);
  // 36-B.2: Include prompt hash so cache auto-invalidates on prompt template changes
  const promptHash = promptText ? createHash("sha256").update(promptText).digest("hex").slice(0, 8) : "noprompt";
  const companyKey = companyId != null ? String(companyId) : "nocompany";
  return `${companyKey}:${measureId}:${provider}:${scoringMode}:${evidenceHash}:${promptHash}`;
}

// 36-B.1: Deterministic seed per (measureId, companyId, providerIndex).
// Gives each measure a unique seed, reducing systematic bias across measures.
function deterministicSeed(measureId: string, companyId: number, providerIndex: number): number {
  const h = createHash("sha256")
    .update(`${measureId}:${companyId}:${providerIndex}`)
    .digest();
  return h.readUInt32BE(0);
}

async function scoreSingleMeasure(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  temporalWarning?: string | null;
  scoringMode?: string;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, measure, scoringMode } = opts;
  const usePartial = scoringMode === "partial";

  // I36-B: Check verdict cache — identical evidence + measure + provider = identical result
  // The cache salt (bumped on prompt changes) is included as the promptText proxy
  // I45: companyId included to prevent cross-company cache contamination
  const vKey = verdictCacheKey(measure.measureId, opts.evidenceText, opts.provider, scoringMode || "binary", "v3n-no-govterms", opts.companyId);
  const cachedVerdict = verdictCache.get(vKey);
  if (cachedVerdict && (Date.now() - cachedVerdict.ts) < VERDICT_CACHE_TTL_MS) {
    return { ...cachedVerdict.result };
  }

  // Self-consistency: run N passes on the SAME provider (no silent cross-model
  // fallback) and take the majority verdict. This bounds the residual best-effort
  // -seed noise that drives cross-run volatility. N is env-tunable; default 3.
  // Set SCORING_SELF_CONSISTENCY=1 to disable (single pass).
  const passes = Math.max(1, parseInt(process.env.SCORING_SELF_CONSISTENCY || "3", 10));

  if (passes === 1) {
    return scoreSingleMeasurePass({ ...opts, providerIndex: 0 });
  }

  const passResults: MeasureResult[] = [];
  const gradedBy = new Set<string>();
  for (let i = 0; i < passes; i++) {
    const r = await scoreSingleMeasurePass({ ...opts, providerIndex: i });
    passResults.push(r);
    if ((r as any)._gradedBy) gradedBy.add((r as any)._gradedBy);
  }

  // Majority verdict by score bucket (0 / 0.5 / 1). Ties resolve toward the
  // HIGHER-evidence pass that has quotes, never inflating beyond what a pass found.
  const tally = new Map<number, MeasureResult[]>();
  for (const r of passResults) {
    const bucket = r.score;
    if (!tally.has(bucket)) tally.set(bucket, []);
    tally.get(bucket)!.push(r);
  }
  let winningBucket = passResults[0].score;
  let winningCount = 0;
  for (const [bucket, rs] of tally) {
    if (rs.length > winningCount || (rs.length === winningCount && bucket > winningBucket)) {
      winningBucket = bucket;
      winningCount = rs.length;
    }
  }
  const winners = tally.get(winningBucket)!;
  // Pick the winner with the richest quotes/evidence as the representative result.
  // I36-B: Deterministic tie-break: sort by (quotes.length DESC, evidenceSummary.length DESC,
  // evidenceSummary text ASC) so identical-quality results always pick the same one.
  winners.sort((a, b) => {
    const aq = a.quotes.length, bq = b.quotes.length;
    if (aq !== bq) return bq - aq;
    const ae = a.evidenceSummary?.length || 0, be = b.evidenceSummary?.length || 0;
    if (ae !== be) return be - ae;
    return (a.evidenceSummary || "").localeCompare(b.evidenceSummary || "");
  });
  const chosen = winners[0];
  const unanimous = winningCount === passes;
  const gradedByLabel = Array.from(gradedBy).join("+") || "unknown";
  chosen.confidence = unanimous ? "High" : winningCount >= Math.ceil(passes / 2) ? "Medium" : "Low";
  chosen.verdictNuance = (chosen.verdictNuance ? chosen.verdictNuance + " " : "") +
    `[Self-consistency ${winningCount}/${passes} on ${gradedByLabel}]`;
  // Propagate model identity for methodology stamping
  (chosen as any)._gradedBy = gradedByLabel;

  // I36-B: Store in verdict cache
  verdictCache.set(vKey, { result: { ...chosen }, ts: Date.now() });
  if (verdictCache.size > 10000) {
    const now = Date.now();
    for (const [k, v] of verdictCache) {
      if (now - v.ts > VERDICT_CACHE_TTL_MS) verdictCache.delete(k);
    }
  }
  return chosen;
}

// Single scoring pass (one LLM call). Kept separate so the N-pass vote above can
// reuse it. Uses completeScoring (strict same-provider retry) rather than the
// silent cross-model fallback path.
async function scoreSingleMeasurePass(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  providerIndex?: number;
  temporalWarning?: string | null;
  scoringMode?: string;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, companyId, measure, evidenceText, terminology, topicDescription, provider, providerIndex, temporalWarning, scoringMode, framework } = opts;

  // Choose prompt based on scoring mode
  const usePartial = scoringMode === "partial";
  const { system, prompt } = usePartial
    ? buildPartialScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework })
    : buildBinaryScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework });

  // 36-B.1: Deterministic seed per (measureId, companyId, providerIndex)
  const seed = companyId != null ? deterministicSeed(measure.measureId, companyId, providerIndex ?? 0) : undefined;

  try {
    const { text, provider: gradedBy } = await completeScoring(provider, {
      system,
      prompt,
      json: true,
      maxTokens: 2000,
      seed,
    });

    const parsed = extractAndParseJSON(text);

    // I45: Structured output validation — enforce expected schema fields and types.
    // If the LLM returns unexpected types, coerce to safe defaults rather than
    // propagating garbage that could cause non-deterministic downstream behaviour.
    const validConfidence = ["High", "Medium", "Low"];
    const validVerdict = ["Yes", "No", "Partial"];

    // Parse score: in partial mode allow 0, 0.5, 1; in binary mode coerce to 0 or 1
    let score: number;
    if (usePartial) {
      const rawScore = typeof parsed.score === "number" ? parsed.score : parseFloat(parsed.score);
      if (isNaN(rawScore)) score = 0;
      else if (rawScore >= 0.75) score = 1;
      else if (rawScore >= 0.25) score = 0.5;
      else score = 0;
    } else {
      score = parsed.score === 1 ? 1 : 0;
    }

    // Determine verdict from score
    let verdict: "Yes" | "No" | "Partial";
    if (parsed.verdict && validVerdict.includes(parsed.verdict)) {
      verdict = parsed.verdict as "Yes" | "No" | "Partial";
    } else {
      verdict = score === 1 ? "Yes" : score === 0.5 ? "Partial" : "No";
    }

    // I45: Validate and deterministically sort quotes by (source ASC, text ASC)
    // to eliminate ordering-dependent non-determinism from LLM responses.
    const rawQuotes = Array.isArray(parsed.quotes) ? parsed.quotes : [];
    const validatedQuotes = rawQuotes
      .filter((q: any) => q && typeof q.text === "string" && q.text.length > 0)
      .map((q: any) => ({
        text: String(q.text),
        source: String(q.source || ""),
        sourceUrl: q.sourceUrl ? String(q.sourceUrl) : undefined,
        page: typeof q.page === "number" ? q.page : undefined,
      }))
      .sort((a: any, b: any) => {
        const sc = a.source.localeCompare(b.source);
        return sc !== 0 ? sc : a.text.localeCompare(b.text);
      });

    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score,
      coverage: null,
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : "Medium",
      evidenceSummary: typeof parsed.evidenceSummary === "string" ? parsed.evidenceSummary : "No evidence found",
      quotes: validatedQuotes,
      verdict,
      verdictNuance: typeof parsed.verdictNuance === "string" ? parsed.verdictNuance : null,
      displayOrder: measure.displayOrder,
      _gradedBy: gradedBy,
    } as MeasureResult & { _gradedBy?: string };
  } catch (error: any) {
    // PROVIDER QUOTA/AUTH FAILURE: if the error is a ProviderScoringError with
    // quota_exhausted or authentication class, DO NOT convert to a zero score.
    // Re-throw so the pipeline pauses cleanly without emitting fake results.
    if (error instanceof ProviderScoringError) {
      const cls = error.failureClass as ProviderFailureClass;
      if (cls === "quota_exhausted" || cls === "authentication") {
        console.error(`[${companyName}] PROVIDER FAILURE [${cls}] for ${measure.measureId} — NOT converting to zero score, propagating for pause/retry`);
        throw error;
      }
    }
    // I45: Distinguish scoring failure from legitimate "No" verdict. The error
    // is logged with explicit failure provenance so downstream diagnostics can
    // separate timeout/model-failure zeros from genuine no-evidence zeros.
    const failureClass = classifyProviderError(error);
    const failureType = failureClass === "timeout" ? "timeout" : "scoring_error";
    console.warn(`[${companyName}] Scoring FAILED [${failureType}/${failureClass}] for ${measure.measureId}: ${error.message}`);
    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score: 0,
      coverage: null,
      confidence: "Low",
      evidenceSummary: `Scoring ${failureType}: ${error.message}`,
      quotes: [],
      verdict: "No",
      verdictNuance: `[SCORING_FAILURE:${failureType}:${failureClass}] This zero reflects a model/network failure, not a substantive assessment. Retry recommended.`,
      displayOrder: measure.displayOrder,
      _scoringFailure: failureType,
      _failureClass: failureClass,
    } as MeasureResult & { _scoringFailure?: string; _failureClass?: string };
  }
}

// ─── Ensemble Scoring ────────────────────────────────────────────────────────

async function scoreWithEnsemble(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  settings: AnalysisSettings;
  temporalWarning?: string | null;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, companyId, measure, evidenceText, terminology, topicDescription, settings, temporalWarning, framework } = opts;

  const providers = [settings.pipelineLlm1, settings.pipelineLlm2, settings.pipelineLlm3];
  const iterations = Math.min(settings.ensembleIterations, providers.length);

  const results: MeasureResult[] = [];

  for (let i = 0; i < iterations; i++) {
    const provider = providers[i] || settings.scoringProvider;
    const result = await scoreSingleMeasure({
      companyName,
      companyId,
      measure,
      evidenceText,
      terminology,
      topicDescription,
      provider,
      temporalWarning,
      scoringMode: settings.scoringMode,
      framework,
    });
    results.push(result);
  }

  // Aggregation logic that supports both binary and partial modes
  // Priority: score=1 with quotes > score=0.5 with quotes > score=0
  const positiveResults = results.filter((r) => r.score === 1 && r.quotes.length > 0);
  if (positiveResults.length > 0) {
    // Merge quotes from all positive passes
    const allQuotes = positiveResults.flatMap((r) => r.quotes);
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );
    return {
      ...positiveResults[0],
      quotes: uniqueQuotes,
      confidence: positiveResults.length >= 2 ? "High" : "Medium",
    };
  }

  // In partial mode: check for partial results (score=0.5)
  const partialResults = results.filter((r) => r.score === 0.5 && r.quotes.length > 0);
  if (partialResults.length > 0) {
    const allQuotes = partialResults.flatMap((r) => r.quotes);
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );
    return {
      ...partialResults[0],
      quotes: uniqueQuotes,
      confidence: partialResults.length >= 2 ? "Medium" : "Low",
    };
  }

  // All passes returned 0: use the one with the most detailed evidence summary
  const best = results.reduce((a, b) =>
    (a.evidenceSummary?.length || 0) > (b.evidenceSummary?.length || 0) ? a : b
  );
  return best;
}

// ─── Summary Narrative Generation ────────────────────────────────────────────

async function generateSummaryNarrative(
  companyName: string,
  results: MeasureResult[],
  scorePercentage: number,
  framework: Framework
): Promise<string> {
  const yesCount = results.filter((r) => r.verdict === "Yes").length;
  const noCount = results.filter((r) => r.verdict === "No").length;
  const partialCount = results.filter((r) => r.verdict === "Partial").length;

  try {
    // I45: Deterministic summary generation — temperature=0
    const { text } = await completeWithFallback("deepseek", {
      system: "Generate a concise 2-3 sentence executive summary of a company's assessment results.",
      prompt: `Company: ${companyName}\nFramework: ${framework.name}\nScore: ${scorePercentage}%\nYes: ${yesCount}, No: ${noCount}, Partial: ${partialCount} out of ${results.length} measures.\n\nKey findings:\n${results.filter(r => r.verdict === "Yes").slice(0, 5).map(r => `- ${r.title}`).join("\n")}\n\nWrite a 2-3 sentence summary.`,
      maxTokens: 300,
      temperature: 0,
    });
    return text.trim();
  } catch {
    return `${companyName} scored ${scorePercentage}% on the ${framework.name} assessment (${yesCount} of ${results.length} measures met).`;
  }
}
