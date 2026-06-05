import * as storage from "../storage.js";
import { completeWithFallback, getProvider, getIndependentTieBreakerProvider } from "./ai-providers.js";
import { buildEvidencePacksForCategory, chunkText, tokenize, buildBM25Index, bm25Score } from "./passage-retrieval.js";
import { discoverCompanyTerminology, flattenTerms, type TerminologyMap } from "./terminology-discovery.js";
import { generateDocumentHash } from "./processor.js";
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
}

async function loadAnalysisSettings(workspaceId?: number): Promise<AnalysisSettings> {
  const settings = await storage.getSettings(workspaceId || 1);
  return {
    ensembleScoring: settings.ensemble_scoring === "true",
    ensembleIterations: parseInt(settings.ensemble_iterations || "3"),
    pipelineLlm1: settings.pipeline_llm_1 || "deepseek",
    pipelineLlm2: settings.pipeline_llm_2 || "claude",
    pipelineLlm3: settings.pipeline_llm_3 || "gemini",
    scoringProvider: settings.scoring_provider || "deepseek",
    useBm25Retrieval: settings.use_bm25_retrieval !== "false",
    bm25SkipSummarizationBelowChars: parseInt(settings.bm25_skip_summarization_below_chars || "600000"),
    terminologyDiscoveryEnabled: settings.terminology_discovery_enabled !== "false",
    twoPromptExtractionEnabled: settings.two_prompt_extraction_enabled === "true",
    crossVerifyEnabled: settings.cross_verify_enabled === "true",
    scoringMode: settings.scoring_mode || "binary",
  };
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildBinaryScoringPrompt(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription } = opts;

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

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
${terminologyBlock}`;

  const scoringGuidance = measure.scoringGuidance
    ? `\nScoring guidance:\n- Yes: ${measure.scoringGuidance.yes || "Clear evidence present"}\n- No: ${measure.scoringGuidance.no || "No evidence found"}\n- Partial: ${measure.scoringGuidance.partial || "Some evidence but incomplete"}`
    : "";

  const prompt = `Company: ${companyName}

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
  "quotes": [{"text": "verbatim quote from evidence", "source": "document URL or title"}],
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

function verifyQuoteProvenance(
  quote: string,
  evidenceText: string
): { found: boolean; similarity: number } {
  if (!quote || !evidenceText) return { found: false, similarity: 0 };

  // Normalize whitespace for comparison
  const normalizedQuote = quote.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedEvidence = evidenceText.replace(/\s+/g, " ").trim().toLowerCase();

  // Exact match
  if (normalizedEvidence.includes(normalizedQuote)) {
    return { found: true, similarity: 1.0 };
  }

  // Substring match (allow minor differences)
  const words = normalizedQuote.split(" ");
  if (words.length >= 5) {
    // Check if a significant portion of consecutive words appear
    const windowSize = Math.max(5, Math.floor(words.length * 0.6));
    for (let i = 0; i <= words.length - windowSize; i++) {
      const window = words.slice(i, i + windowSize).join(" ");
      if (normalizedEvidence.includes(window)) {
        return { found: true, similarity: 0.8 };
      }
    }
  }

  return { found: false, similarity: 0 };
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
      prompt: `Measure: ${measure.title}\nDefinition: ${measure.definition}\n\nEvidence:\n${evidenceText.slice(0, 3000)}\n\nDoes this evidence support a YES verdict for this measure?`,
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
  topicDescription: string;
}): Promise<{ text: string; model: string }> {
  const { companyName, companyId, documentTexts, documentUrls, topicDescription } = opts;

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
    combined += `\n\n--- DOCUMENT: ${entry.url} ---\n\n` + entry.text.slice(0, cap);
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
  framework: Framework;
  measures: FrameworkMeasure[];
}): Promise<AnalysisResult> {
  const { workspaceId, companyName, companyId, documentTexts, documentUrls, framework, measures } = opts;

  // Load settings fresh for every analysis call
  const settings = await loadAnalysisSettings(workspaceId);

  console.log(`[${companyName}] Starting analysis: ${measures.length} measures, ${documentTexts.length} documents`);

  // Stage: Terminology discovery
  let terminology: TerminologyMap | undefined;
  if (settings.terminologyDiscoveryEnabled) {
    terminology = await discoverCompanyTerminology({
      companyName,
      companyId,
      frameworkId: framework.id,
      topicDescription: framework.topicDescription || framework.name,
      documentTexts,
    });
  }

  // Stage: Summarization / raw-pass
  const totalChars = documentTexts.reduce((sum, t) => sum + t.length, 0);
  let combinedText: string;
  let summarizerModel: string;

  if (settings.useBm25Retrieval && totalChars <= settings.bm25SkipSummarizationBelowChars) {
    // BM25-skip path: use raw text directly
    combinedText = documentTexts.join("\n\n");
    summarizerModel = "bm25-direct";
    console.log(`[${companyName}] BM25-skip path (${totalChars} chars < ${settings.bm25SkipSummarizationBelowChars})`);
  } else {
    const result = await summarizeDocuments({
      companyName,
      companyId,
      documentTexts,
      documentUrls,
      topicDescription: framework.topicDescription || framework.name,
    });
    combinedText = result.text;
    summarizerModel = result.model;
    console.log(`[${companyName}] Summarized via ${summarizerModel} (${combinedText.length} chars)`);
  }

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
    let evidencePacks: Array<{ measureId: string; text: string }>;
    if (settings.useBm25Retrieval) {
      evidencePacks = buildEvidencePacksForCategory({
        measures: categoryMeasures,
        combinedText,
        terminology,
      });
    } else {
      // No BM25: use full text for all measures
      evidencePacks = categoryMeasures.map((m) => ({
        measureId: m.measureId,
        text: combinedText.slice(0, 10000),
      }));
    }

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

      if (settings.ensembleScoring) {
        // Ensemble: run multiple passes
        measureResult = await scoreWithEnsemble({
          companyName,
          measure,
          evidenceText: finalEvidence,
          terminology,
          topicDescription: framework.topicDescription || framework.name,
          settings,
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

      // Contradiction detection + tie-breaker
      measureResult = await detectAndResolvContradiction({
        measure,
        result: measureResult,
        evidenceText: finalEvidence,
        primaryProvider: scoringProvider,
      });

      return measureResult;
    };

    // Process measures in concurrent batches
    for (let i = 0; i < categoryMeasures.length; i += MEASURE_CONCURRENCY) {
      const batch = categoryMeasures.slice(i, i + MEASURE_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(scoreMeasure));
      allResults.push(...batchResults);
    }
  }

  // Roll up scores
  const maxPossibleScore = measures.length; // binary mode: 1 per measure
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
}): Promise<MeasureResult> {
  const { companyName, measure, evidenceText, terminology, topicDescription, provider } = opts;

  const { system, prompt } = buildBinaryScoringPrompt({
    companyName,
    measure,
    evidenceText,
    terminology,
    topicDescription,
  });

  try {
    const { text } = await completeWithFallback(provider, {
      system,
      prompt,
      json: true,
      maxTokens: 2000,
    });

    const parsed = extractAndParseJSON(text);

    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score: parsed.score === 1 ? 1 : 0,
      coverage: null,
      confidence: parsed.confidence || "Medium",
      evidenceSummary: parsed.evidenceSummary || "No evidence found",
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      verdict: parsed.verdict || (parsed.score === 1 ? "Yes" : "No"),
      verdictNuance: parsed.verdictNuance || null,
      displayOrder: measure.displayOrder,
    };
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
}): Promise<MeasureResult> {
  const { companyName, measure, evidenceText, terminology, topicDescription, settings } = opts;

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
    });
    results.push(result);
  }

  // Aggregation: "Any Valid Pass" for binary
  // If any pass produces score=1 with verified quotes, use it
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
