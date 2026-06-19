import * as storage from "../storage.js";
import { completeWithFallback, completeScoring, getProvider, getIndependentTieBreakerProvider } from "./ai-providers.js";
import { buildEvidencePacksForCategory, buildEvidencePackForMeasure, chunkText, chunkDocuments, tokenize, buildBM25Index, bm25Score, deriveTopicTerms, computeCorpusTopicStats, type EvidencePack, type Chunk } from "./passage-retrieval.js";
import { discoverCompanyTerminology, flattenTerms, type TerminologyMap } from "./terminology-discovery.js";
import { deriveTopicLexicon } from "./topic-lexicon.js";
import { generateDocumentHash } from "./processor.js";
import { translateDocumentsToEnglish } from "./translation.js";
import type { Framework, FrameworkMeasure } from "../../shared/schema.js";

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
  quotes: Array<{ text: string; source: string; page?: number }>;
  verdict: "Yes" | "No" | "Partial";
  verdictNuance: string | null;
  displayOrder: number;
}

export interface AnalysisResult {
  totalScore: number;
  scorePercentage: number;
  summary: string;
  categories: Array<{
    category: string;
    categoryNumber: number;
    measures: MeasureResult[];
  }>;
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
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning } = opts;

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
2. DO NOT infer that a company has a specific target or policy because they are a member of an alliance or initiative (e.g., NZBA, SBTi, Climate Action 100+). Alliance membership alone does not constitute evidence of a specific company-level commitment.
3. DO NOT infer that a policy applies to all sectors or all activities if the text only names specific sectors. If a measure asks about "oil and gas" but the evidence only mentions "energy", you must evaluate whether the evidence explicitly confirms oil and gas is included.
4. DO NOT conflate different types of financing activity. "Financed emissions" (balance-sheet lending, PCAF Part A) is distinct from "facilitated emissions" (capital markets underwriting, PCAF Part B). Score each strictly according to what the measure asks for.
5. DO NOT conflate absolute emissions targets (measured in MtCO2e or % absolute reduction) with emissions intensity targets (measured in gCO2e/kWh, kgCO2e/$M invested). If the measure asks for an absolute target, an intensity-only target does not satisfy it.
6. If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 (No or Partial), even if you believe the company likely has such a policy based on other context.
7. Pay careful attention to the TEMPORAL VALIDITY of evidence. If the evidence indicates a policy or target has been withdrawn, discontinued, or superseded, score based on the current state, not the historical commitment.

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
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning } = opts;

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
- The company addresses the topic generally but not the specific requirement (e.g., mentions AI but not AI governance specifically)
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
4. DO NOT conflate different types of financing activity.
5. DO NOT conflate absolute emissions targets with emissions intensity targets.
6. If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 or 0.5 (not 1).
7. Pay careful attention to the TEMPORAL VALIDITY of evidence.

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
function normalizeQuoteSources(
  quotes: Array<{ text: string; source: string; page?: number }>,
  evidenceText: string
): Array<{ text: string; source: string; page?: number }> {
  // Extract all document titles from the evidence text headers
  const headerPattern = /--- DOCUMENT: (.+?) \[(.+?)\] ---/g;
  const documentHeaders: Array<{ title: string; url: string; startIdx: number }> = [];
  let match;
  while ((match = headerPattern.exec(evidenceText)) !== null) {
    documentHeaders.push({ title: match[1].trim(), url: match[2].trim(), startIdx: match.index });
  }

  if (documentHeaders.length === 0) return quotes;

  // Build a set of valid document titles for quick lookup
  const validTitles = new Set(documentHeaders.map(h => h.title.toLowerCase()));

  return quotes.map(quote => {
    // Check if the source already matches a valid document title
    if (quote.source && validTitles.has(quote.source.toLowerCase())) {
      return quote;
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

    return { ...quote, source: bestSource };
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
    const { text } = await completeWithFallback(tieBreaker.name, {
      system: "You are an independent reviewer. Given a measure and evidence, determine if the evidence supports a YES or NO verdict. Return JSON: {\"verdict\": \"Yes\"|\"No\", \"reason\": \"brief explanation\"}",
      prompt: `Measure: ${measure.title}\nDefinition: ${measure.definition}\n\nEvidence:\n${evidenceText.slice(0, 8000)}\n\nDoes this evidence support a YES verdict for this measure?`,
      json: true,
      maxTokens: 500,
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
}): Promise<{ text: string; model: string }> {
  const { companyName, companyId, documentTexts, documentUrls, documentTitles, topicDescription } = opts;

  // Check summary cache
  const docHash = generateDocumentHash(documentUrls);
  const cached = await storage.getCachedSummary(companyId, docHash);
  if (cached) {
    console.log(`[${companyName}] Using cached summary`);
    return { text: cached, model: "cached" };
  }

  // ─── PRIORITY-BASED DOCUMENT ORDERING ───────────────────────────────────────
  // Sort documents by relevance to the topic BEFORE combining, so AI-specific
  // content appears first and doesn't get truncated.
  const topicKeywords = tokenize(topicDescription);
  const aiKeywords = [
    "ai", "artificial", "intelligence", "ethics", "responsible", "governance",
    "transparency", "accountability", "risk", "bias", "fairness", "privacy",
    "workforce", "training", "security", "algorithm", "machine", "learning",
    "automated", "decision", "oversight", "committee", "policy", "framework",
  ];
  const allQueryTerms = [...new Set([...topicKeywords, ...aiKeywords])];

  // Score each document by keyword density
  interface DocEntry { text: string; url: string; score: number; idx: number }
  const docEntries: DocEntry[] = documentTexts.map((text, idx) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of allQueryTerms) {
      // Count occurrences (capped at 10 per term to avoid over-weighting)
      const regex = new RegExp(`\\b${term}\\b`, "gi");
      const matches = lower.match(regex);
      score += Math.min(matches?.length || 0, 10);
    }
    // Boost documents from the company's own domain or with AI in URL
    const url = documentUrls[idx] || "";
    if (/ai|ethics|responsible|governance|policy/i.test(url)) score += 50;
    return { text, url, score, idx };
  });

  // Sort by relevance score descending
  docEntries.sort((a, b) => b.score - a.score);

  console.log(`[${companyName}] Document priority ordering (top 5):`);
  for (const d of docEntries.slice(0, 5)) {
    console.log(`  score=${d.score} ${d.url.slice(0, 60)}`);
  }

  // Combine documents in priority order with caps
  const RAW_PASS_CAP_DEFAULT = 120000;
  const RAW_PASS_CAP_PROXY = 200000;

  let combined = "";
  for (const entry of docEntries) {
    const isProxy = /proxy|def.?14a|annual.?report|20-f|40-f/i.test(entry.url);
    const cap = isProxy ? RAW_PASS_CAP_PROXY : RAW_PASS_CAP_DEFAULT;
    const docTitle = documentTitles?.[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
  }

  // If total is small enough, skip summarization and use BM25 directly
  if (combined.length < 600000) {
    return { text: combined, model: "raw-pass" };
  }

  // ─── TWO-PASS APPROACH: BM25 pre-filter + LLM summarization ─────────────────
  // Instead of naively truncating to 120K chars, use BM25 to extract the most
  // relevant passages from the full corpus, then summarize those.
  const chunks = chunkText(combined);
  const bm25Index = buildBM25Index(chunks);
  
  // Score all chunks against topic keywords
  const scoredChunks = chunks.map((chunk, idx) => ({
    idx,
    score: bm25Score(allQueryTerms, idx, bm25Index),
    text: chunk,
  }));
  scoredChunks.sort((a, b) => b.score - a.score);

  // Take top chunks up to 200K chars (much more than before)
  const MAX_SUMMARIZATION_INPUT = 200000;
  let relevantText = "";
  for (const chunk of scoredChunks) {
    if (chunk.score <= 0) break;
    if (relevantText.length + chunk.text.length > MAX_SUMMARIZATION_INPUT) break;
    relevantText += chunk.text + "\n\n";
  }

  // Fallback: if BM25 found very little, use first 200K of priority-sorted combined
  if (relevantText.length < 20000) {
    relevantText = combined.slice(0, MAX_SUMMARIZATION_INPUT);
  }

  console.log(`[${companyName}] Summarization input: ${relevantText.length} chars (BM25-filtered from ${combined.length} total)`);

  // Summarize with cheap LLM
  const { text: summary, provider } = await completeWithFallback("deepseek", {
    system: `You are a document summarizer. Extract all content relevant to: ${topicDescription}. Preserve verbatim quotes, specific names, dates, committee names, and policy titles. Do not add interpretation.`,
    prompt: `Summarize the following corporate documents for ${companyName}, focusing on content relevant to ${topicDescription}. Preserve all specific details, names, quotes, and evidence.\n\n${relevantText}`,
    maxTokens: 16000,
  });

  // Cache the summary
  await storage.cacheSummary({
    companyId,
    documentHash: docHash,
    summary,
    summarizerModel: provider,
  });

  return { text: summary, model: provider };
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
}): Promise<AnalysisResult> {
  const { workspaceId, companyName, companyId, documentTexts, documentUrls, documentTitles, framework, measures, temporalContext } = opts;

  // Load settings fresh for every analysis call
  const settings = await loadAnalysisSettings(workspaceId);

  console.log(`[${companyName}] Starting analysis: ${measures.length} measures, ${documentTexts.length} documents`);

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
    });
    combinedText = result.text;
    summarizerModel = result.model;
    console.log(`[${companyName}] Summarized via ${summarizerModel} (${combinedText.length} chars)`);
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
    let evidencePacks: Array<{ measureId: string; text: string; topicHits?: number }>;
    if (settings.useBm25Retrieval) {
      evidencePacks = buildEvidencePacksForCategory({
        measures: categoryMeasures,
        combinedText,
        terminology,
        topicTerms,
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

      // Fallback: if BM25 retrieval returns < 1000 chars, use more text
      const finalEvidence = evidenceText.length < 1000 && combinedText.length > 1000
        ? combinedText.slice(0, 10000)
        : evidenceText;

      let measureResult: MeasureResult;

      // Get temporal warning if available
      const tw = temporalContext?.temporalWarning || null;

      if (settings.ensembleScoring) {
        // Ensemble: run multiple passes
        measureResult = await scoreWithEnsemble({
          companyName,
          measure,
          evidenceText: finalEvidence,
          terminology,
          topicDescription: framework.topicDescription || framework.name,
          settings,
          temporalWarning: tw,
        });
      } else {
        // Single pass
        measureResult = await scoreSingleMeasure({
          companyName,
          measure,
          evidenceText: finalEvidence,
          terminology,
          topicDescription: framework.topicDescription || framework.name,
          provider: scoringProvider,
          temporalWarning: tw,
          scoringMode: settings.scoringMode,
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
            });
            // Only re-score if the deep pass actually surfaced more topic evidence
            // than the original pack (otherwise re-scoring adds cost for no gain).
            if (deepPack.topicHits > packTopicHits && deepPack.text.length > 0) {
              console.log(`[${companyName}] Deep-read re-score for ${measure.measureId}: topicHits ${packTopicHits}→${deepPack.topicHits}, evidence ${finalEvidence.length}→${deepPack.text.length} chars`);
              let deepResult: MeasureResult;
              if (settings.ensembleScoring) {
                deepResult = await scoreWithEnsemble({
                  companyName,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  settings,
                  temporalWarning: tw,
                });
              } else {
                deepResult = await scoreSingleMeasure({
                  companyName,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  provider: scoringProvider,
                  temporalWarning: tw,
                  scoringMode: settings.scoringMode,
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
                measureResult = deepResult;
              }
            }
          }
        } catch (deepErr: any) {
          console.warn(`[${companyName}] Deep-read pass failed for ${measure.measureId}: ${deepErr.message}`);
          // Keep the original result on any failure.
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

  // Roll up scores (works for both binary and partial mode since partial gives 0.5)
  const maxPossibleScore = measures.length; // 1 per measure max
  const totalScore = allResults.reduce((sum, r) => sum + r.score, 0);
  const scorePercentage = Math.round((totalScore / maxPossibleScore) * 100);

  // Generate summary narrative
  const summary = await generateSummaryNarrative(companyName, allResults, scorePercentage, framework);

  // Group results by category for output
  const categoryResults = Array.from(categoryMap.entries()).map(([category, categoryMeasures]) => ({
    category,
    categoryNumber: categoryMeasures[0].categoryNumber,
    measures: allResults.filter((r) => r.category === category),
  }));

  console.log(`[${companyName}] Analysis complete: ${scorePercentage}% (${totalScore}/${maxPossibleScore})`);

  return {
    totalScore,
    scorePercentage,
    summary,
    categories: categoryResults.sort((a, b) => a.categoryNumber - b.categoryNumber),
  };
}

// ─── Single Measure Scoring ──────────────────────────────────────────────────

async function scoreSingleMeasure(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  temporalWarning?: string | null;
  scoringMode?: string;
}): Promise<MeasureResult> {
  const { companyName, measure, scoringMode } = opts;
  const usePartial = scoringMode === "partial";

  // Self-consistency: run N passes on the SAME provider (no silent cross-model
  // fallback) and take the majority verdict. This bounds the residual best-effort
  // -seed noise that drives cross-run volatility. N is env-tunable; default 3.
  // Set SCORING_SELF_CONSISTENCY=1 to disable (single pass).
  const passes = Math.max(1, parseInt(process.env.SCORING_SELF_CONSISTENCY || "3", 10));

  if (passes === 1) {
    return scoreSingleMeasurePass(opts);
  }

  const passResults: MeasureResult[] = [];
  const gradedBy = new Set<string>();
  for (let i = 0; i < passes; i++) {
    const r = await scoreSingleMeasurePass(opts);
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
  const chosen = winners.reduce((a, b) => {
    const aScore = a.quotes.length * 1000 + (a.evidenceSummary?.length || 0);
    const bScore = b.quotes.length * 1000 + (b.evidenceSummary?.length || 0);
    return bScore > aScore ? b : a;
  });
  const unanimous = winningCount === passes;
  const gradedByLabel = Array.from(gradedBy).join("+") || "unknown";
  chosen.confidence = unanimous ? "High" : winningCount >= Math.ceil(passes / 2) ? "Medium" : "Low";
  chosen.verdictNuance = (chosen.verdictNuance ? chosen.verdictNuance + " " : "") +
    `[Self-consistency ${winningCount}/${passes} on ${gradedByLabel}]`;
  return chosen;
}

// Single scoring pass (one LLM call). Kept separate so the N-pass vote above can
// reuse it. Uses completeScoring (strict same-provider retry) rather than the
// silent cross-model fallback path.
async function scoreSingleMeasurePass(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  temporalWarning?: string | null;
  scoringMode?: string;
}): Promise<MeasureResult> {
  const { companyName, measure, evidenceText, terminology, topicDescription, provider, temporalWarning, scoringMode } = opts;

  // Choose prompt based on scoring mode
  const usePartial = scoringMode === "partial";
  const { system, prompt } = usePartial
    ? buildPartialScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning })
    : buildBinaryScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning });

  try {
    const { text, provider: gradedBy } = await completeScoring(provider, {
      system,
      prompt,
      json: true,
      maxTokens: 2000,
    });

    const parsed = extractAndParseJSON(text);

    // Parse score: in partial mode allow 0, 0.5, 1; in binary mode coerce to 0 or 1
    let score: number;
    if (usePartial) {
      const rawScore = parseFloat(parsed.score);
      if (rawScore >= 0.75) score = 1;
      else if (rawScore >= 0.25) score = 0.5;
      else score = 0;
    } else {
      score = parsed.score === 1 ? 1 : 0;
    }

    // Determine verdict from score
    let verdict: "Yes" | "No" | "Partial";
    if (parsed.verdict && ["Yes", "No", "Partial"].includes(parsed.verdict)) {
      verdict = parsed.verdict;
    } else {
      verdict = score === 1 ? "Yes" : score === 0.5 ? "Partial" : "No";
    }

    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score,
      coverage: null,
      confidence: parsed.confidence || "Medium",
      evidenceSummary: parsed.evidenceSummary || "No evidence found",
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      verdict,
      verdictNuance: parsed.verdictNuance || null,
      displayOrder: measure.displayOrder,
      _gradedBy: gradedBy,
    } as MeasureResult & { _gradedBy?: string };
  } catch (error: any) {
    console.warn(`[${companyName}] Scoring failed for ${measure.measureId}: ${error.message}`);
    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score: 0,
      coverage: null,
      confidence: "Low",
      evidenceSummary: `Scoring error: ${error.message}`,
      quotes: [],
      verdict: "No",
      verdictNuance: "Scoring failed - this may not reflect actual company disclosure",
      displayOrder: measure.displayOrder,
    };
  }
}

// ─── Ensemble Scoring ────────────────────────────────────────────────────────

async function scoreWithEnsemble(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  settings: AnalysisSettings;
  temporalWarning?: string | null;
}): Promise<MeasureResult> {
  const { companyName, measure, evidenceText, terminology, topicDescription, settings, temporalWarning } = opts;

  const providers = [settings.pipelineLlm1, settings.pipelineLlm2, settings.pipelineLlm3];
  const iterations = Math.min(settings.ensembleIterations, providers.length);

  const results: MeasureResult[] = [];

  for (let i = 0; i < iterations; i++) {
    const provider = providers[i] || settings.scoringProvider;
    const result = await scoreSingleMeasure({
      companyName,
      measure,
      evidenceText,
      terminology,
      topicDescription,
      provider,
      temporalWarning,
      scoringMode: settings.scoringMode,
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
    const { text } = await completeWithFallback("deepseek", {
      system: "Generate a concise 2-3 sentence executive summary of a company's assessment results.",
      prompt: `Company: ${companyName}\nFramework: ${framework.name}\nScore: ${scorePercentage}%\nYes: ${yesCount}, No: ${noCount}, Partial: ${partialCount} out of ${results.length} measures.\n\nKey findings:\n${results.filter(r => r.verdict === "Yes").slice(0, 5).map(r => `- ${r.title}`).join("\n")}\n\nWrite a 2-3 sentence summary.`,
      maxTokens: 300,
    });
    return text.trim();
  } catch {
    return `${companyName} scored ${scorePercentage}% on the ${framework.name} assessment (${yesCount} of ${results.length} measures met).`;
  }
}
