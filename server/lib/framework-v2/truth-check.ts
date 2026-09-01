/**
 * Framework Creation v2 — Truth Check ("Explore truth")
 *
 * Independent verification of a single company × measure verdict. Uses
 * Perplexity's Sonar (via OpenRouter) so the query executes a fresh web search
 * over primary sources — the company's own annual/sustainability reports,
 * press releases, and regulatory filings. Returns a verdict PLUS the primary
 * sources and quotes so the user can spot-check.
 *
 * This is NOT the same as the scoring pipeline:
 *   - Scoring uses the pre-fetched batch_corpus for the company
 *   - Truth check does a fresh online search, bounded to primary domains
 *   - Scoring uses the framework's fallback + regeneration modules
 *   - Truth check uses ONLY the measure definition, verbatim
 *
 * Divergence between the two is the useful signal: if the app says No but the
 * truth-check finds Yes with quoted evidence, the app is likely missing a
 * document from its corpus, or the retrieval failed for that measure.
 */

export interface TruthCheckInput {
  companyName: string;
  companyDomain?: string;              // if known, biases search to this domain
  measureId: string;
  measureTitle: string;
  measureSubstantiveDefinition: string;
  measureFallbackYesCriterion?: string;
  measurePositiveExamples?: string[];
  measureNegativeExamples?: string[];
  topicTerm: string;
  adjacentTopics?: string[];
}

export interface TruthCheckSource {
  url: string;
  title?: string;
}

export interface TruthCheckResult {
  verdict: "Yes" | "No" | "Partial" | "Evidence absent";
  confidence: "High" | "Medium" | "Low";
  reasoning: string;                  // 2-4 sentence rationale
  quotes: string[];                   // 1-3 quoted passages that support the verdict
  sources: TruthCheckSource[];        // Perplexity's cited URLs
  rawResponse?: string;               // for debugging
  provider: string;
  modelId: string;
}

/**
 * Build the prompt for the Perplexity sonar model. We instruct it to:
 *   - Only draw evidence from PRIMARY sources (the company's own filings)
 *   - Use the exact same measure definition the app uses
 *   - Return structured JSON so the client can render both verdict and quotes
 */
function buildTruthCheckPrompt(input: TruthCheckInput): { system: string; user: string } {
  const negatives = (input.measureNegativeExamples || []).slice(0, 3);
  const positives = (input.measurePositiveExamples || []).slice(0, 3);

  const system = `You are an independent verification assistant. Your task is to answer ONE specific yes/no/partial question about ONE company based ONLY on evidence you can retrieve from that company's own primary disclosures.

CRITICAL RULES:
1. Search only PRIMARY sources: the company's annual report, sustainability/CSR/ESG report, TCFD/TNFD report, integrated report, or SEC/regulatory filings. Prefer PDFs on the company's own domain. Never use third-party summaries, ratings agencies, media coverage, or Wikipedia as your primary evidence.
2. Use the exact measure definition provided. Do NOT relax or reinterpret sufficiency conditions.
3. If the disclosure names a specific methodology, framework, or quantified target, quote it verbatim.
4. If you cannot find primary evidence within a reasonable search, return "Evidence absent" (NOT "No"). "No" means you found evidence that the company does NOT do this. "Evidence absent" means you searched but did not find primary evidence either way.
5. Output MUST be valid JSON in the exact schema below. No prose outside the JSON.

Schema:
{
  "verdict": "Yes" | "No" | "Partial" | "Evidence absent",
  "confidence": "High" | "Medium" | "Low",
  "reasoning": "2-4 sentence explanation grounding the verdict in the evidence you cited",
  "quotes": ["primary-source quote 1", "primary-source quote 2"]
}

Confidence levels:
  High   = multiple primary sources agree, quantified/methodology-named evidence
  Medium = one primary source with clear evidence but no cross-corroboration
  Low    = weak or indirect evidence, or inference from adjacent sections`;

  const posBlock = positives.length
    ? `\nExamples of disclosure that WOULD count as Yes:\n${positives.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
    : "";
  const negBlock = negatives.length
    ? `\nExamples of disclosure that would NOT satisfy the measure (common false positives):\n${negatives.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
    : "";
  const adjBlock = input.adjacentTopics && input.adjacentTopics.length
    ? `\nAdjacent topics that must be EXCLUDED (evidence of these does not satisfy the measure): ${input.adjacentTopics.join(", ")}`
    : "";

  const user = `Company: ${input.companyName}${input.companyDomain ? ` (primary domain: ${input.companyDomain})` : ""}

Framework topic: ${input.topicTerm}${adjBlock}

Measure ID: ${input.measureId}
Measure title: ${input.measureTitle}

Measure definition:
${input.measureSubstantiveDefinition}
${input.measureFallbackYesCriterion ? `\nFallback (partial) criterion: ${input.measureFallbackYesCriterion}` : ""}
${posBlock}${negBlock}

Search the company's primary disclosures and answer whether they satisfy this measure. Return JSON only.`;

  return { system, user };
}

/**
 * Call Perplexity's sonar-pro model via OpenRouter. This model does native
 * web search and returns citations. We then parse the JSON verdict out of the
 * response.
 */
export async function runTruthCheck(input: TruthCheckInput): Promise<TruthCheckResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set on this server");
  }
  const { system, user } = buildTruthCheckPrompt(input);
  const model = "perplexity/sonar-pro";

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // sonar-pro supports temperature; low value keeps verdict stable across reruns.
    temperature: 0.1,
    max_tokens: 3000,
    // Sonar returns citations in a "citations" or "sources" field on OpenRouter.
    // OpenRouter surfaces these as `citations` at the top level of the response.
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.PUBLIC_URL || "https://app-sprint-10-preview.up.railway.app",
      "X-Title": "CompanyIQ v2 Truth Check",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenRouter/Perplexity error ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const message = json?.choices?.[0]?.message?.content || "";

  // OpenRouter surfaces Perplexity/Sonar citations in `message.annotations[]`
  // as { type: "url_citation", url_citation: { url, title } }. Older shape used
  // top-level `citations` (kept as fallback). We accept either.
  const annotations: Array<any> = json?.choices?.[0]?.message?.annotations || [];
  const legacyCitations: Array<any> = json?.citations || [];
  const rawSources: Array<any> = annotations.length ? annotations : legacyCitations;
  const sources: TruthCheckSource[] = rawSources
    .map((c: any) => {
      if (typeof c === "string") return { url: c };
      if (c?.url_citation?.url) return { url: c.url_citation.url, title: c.url_citation.title };
      if (typeof c?.url === "string") return { url: c.url, title: c.title };
      return null;
    })
    .filter(Boolean) as TruthCheckSource[];

  // Parse the model's JSON verdict.
  const parsed = safeParseJSON(message);
  if (!parsed || typeof parsed.verdict !== "string") {
    // Fall back: return raw text as reasoning, no structured verdict.
    return {
      verdict: "Evidence absent",
      confidence: "Low",
      reasoning: `The truth-check response was not valid JSON. Raw model output: ${message.slice(0, 400)}`,
      quotes: [],
      sources,
      rawResponse: message,
      provider: "openrouter",
      modelId: model,
    };
  }

  const verdict = normaliseVerdict(parsed.verdict);
  const confidence = normaliseConfidence(parsed.confidence);
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const quotes: string[] = Array.isArray(parsed.quotes)
    ? parsed.quotes.map((q: any) => String(q)).filter((q: string) => q.length > 0)
    : [];

  return {
    verdict,
    confidence,
    reasoning,
    quotes,
    sources,
    rawResponse: message,
    provider: "openrouter",
    modelId: model,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function normaliseVerdict(v: string): TruthCheckResult["verdict"] {
  const lc = String(v).toLowerCase().trim();
  if (lc.startsWith("yes")) return "Yes";
  if (lc.startsWith("partial")) return "Partial";
  if (lc.includes("absent") || lc.includes("insufficient") || lc.includes("not found") || lc.includes("no evidence")) return "Evidence absent";
  return "No";
}

function normaliseConfidence(c: any): TruthCheckResult["confidence"] {
  const lc = String(c || "").toLowerCase().trim();
  if (lc.startsWith("high")) return "High";
  if (lc.startsWith("low")) return "Low";
  return "Medium";
}

function safeParseJSON(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(trimmed); } catch { /* fallthrough */ }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}
