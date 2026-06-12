/**
 * Model-comparison benchmark for the MAIN ANALYSIS (scoring) step.
 *
 * Replays the EXACT production scoring prompt + evidence-pack assembly across
 * multiple candidate models so quality differences reflect the model alone.
 *
 * For each (company, measure, model) it records: score, verdict, confidence,
 * evidenceSummary length, number of quotes, quote-provenance rate (fraction of
 * returned quotes that are verbatim-grounded in the evidence text), input/output
 * token counts (estimated), latency, and any error.
 *
 * Usage:
 *   DATABASE_URL=... tsx server/scripts/benchmark.ts <frameworkId> <companyId,companyId,...> <maxMeasures>
 *
 * Output: writes /tmp/benchmark_<frameworkId>.json
 */
import pg from "pg";
import fs from "fs";
import { getProvider } from "../lib/ai-providers.js";
import { buildEvidencePacksForCategory } from "../lib/passage-retrieval.js";

const { Pool } = pg;

// ─── Candidate models under test ──────────────────────────────────────────────
// name = provider registry key. Each maps to a model already wired in ai-providers.ts.
const DEFAULT_CANDIDATES = [
  "claude",       // claude-sonnet-4-5  (current main-analysis primary)
  "deepseek",     // deepseek-chat (direct API) — current batch primary per user pref
  "deepseek-pro", // deepseek-v4-pro (direct API) — flagship-tier
  "deepseek-r1",  // deepseek/deepseek-r1-0528 via OpenRouter (high-tier reasoning)
  "openrouter",   // deepseek/deepseek-chat-v3.1 via OpenRouter
  "openai",       // gpt-4o
  "mistral",      // mistral-large-latest
  "gemini",       // gemini-2.5-flash
  "minimax",      // MiniMax-Text-01
];
// Allow overriding the model set for targeted re-runs, e.g. MODELS_OVERRIDE=deepseek-pro
const CANDIDATES = (process.env.MODELS_OVERRIDE
  ? process.env.MODELS_OVERRIDE.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CANDIDATES);

// ─── Prompt builder (mirrors analyzer.ts buildBinaryScoringPrompt) ────────────
function buildBinaryScoringPrompt(opts: {
  companyName: string;
  measure: any;
  evidenceText: string;
  topicDescription: string;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, topicDescription } = opts;

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
3. DO NOT infer that a policy applies to all sectors or all activities if the text only names specific sectors.
4. DO NOT conflate different types of financing activity. "Financed emissions" is distinct from "facilitated emissions".
5. DO NOT conflate absolute emissions targets with emissions intensity targets.
6. If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 (No or Partial).
7. Pay careful attention to the TEMPORAL VALIDITY of evidence.

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
CRITICAL: For the "source" field in quotes, you MUST use the EXACT document title as it appears in the "--- DOCUMENT: <title> [<url>] ---" headers in the evidence text.`;

  let scoringGuidance = "";
  if (measure.scoringGuidance) {
    let sg: any;
    try { sg = typeof measure.scoringGuidance === "string" ? JSON.parse(measure.scoringGuidance) : measure.scoringGuidance; }
    catch { sg = { yes: measure.scoringGuidance, no: "", partial: "" }; }
    scoringGuidance = `\nScoring guidance:\n- Yes: ${sg.yes || "Clear evidence present"}\n- No: ${sg.no || "No evidence found"}\n- Partial: ${sg.partial || "Some evidence but incomplete"}`;
  }

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
  "quotes": [{"text": "verbatim quote from evidence", "source": "exact document title"}],
  "verdictNuance": "optional caveats or notes" or null
}`;

  return { system, prompt };
}

function extractAndParseJSON(raw: string): any {
  // Strip reasoning-model <think> blocks (DeepSeek R1, MiniMax-M2)
  const text = (raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const f = text.indexOf("{"); const l = text.lastIndexOf("}");
  if (f !== -1 && l > f) { try { return JSON.parse(text.slice(f, l + 1)); } catch {} }
  throw new Error("Failed to parse JSON from LLM response");
}

function verbatimGrounded(quote: string, evidence: string): boolean {
  if (!quote || !evidence) return false;
  const q = quote.replace(/\s+/g, " ").trim().toLowerCase();
  const e = evidence.replace(/\s+/g, " ").trim().toLowerCase();
  if (e.includes(q)) return true;
  const words = q.split(" ");
  if (words.length >= 5) {
    const w = Math.max(5, Math.floor(words.length * 0.6));
    for (let i = 0; i <= words.length - w; i++) {
      if (e.includes(words.slice(i, i + w).join(" "))) return true;
    }
  }
  return false;
}

const estTokens = (s: string) => Math.ceil((s || "").length / 4);

async function main() {
  const frameworkId = parseInt(process.argv[2] || "7");
  const companyIds = (process.argv[3] || "44").split(",").map((x) => parseInt(x.trim()));
  const maxMeasures = parseInt(process.argv[4] || "8");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 15000 });

  // Load framework + topic
  const fw = (await pool.query("SELECT id, name, topic_description FROM frameworks WHERE id=$1", [frameworkId])).rows[0];
  const topicDescription = fw.topic_description || "";

  // Load measures (evenly sampled across categories up to maxMeasures)
  const allMeasures = (await pool.query(
    `SELECT measure_id AS "measureId", category, category_number AS "categoryNumber", title, definition,
            scoring_guidance AS "scoringGuidance", evidence_keywords AS "evidenceKeywords", display_order AS "displayOrder"
     FROM framework_measures WHERE framework_id=$1 ORDER BY display_order`, [frameworkId])).rows;
  // sample every Nth measure for breadth
  const step = Math.max(1, Math.floor(allMeasures.length / maxMeasures));
  const measures = allMeasures.filter((_: any, i: number) => i % step === 0).slice(0, maxMeasures);

  const report: any = { framework: fw.name, frameworkId, topicDescription: topicDescription.slice(0, 200), companies: [] };

  for (const companyId of companyIds) {
    const company = (await pool.query("SELECT id, name, sector FROM companies WHERE id=$1", [companyId])).rows[0];
    console.error(`\n=== ${company.name} (id ${companyId}) ===`);

    // Build combined evidence text from OK documents with content (dedup via document_content)
    const docs = (await pool.query(
      `SELECT d.title, d.url, COALESCE(dc.content, d.content) AS content
       FROM documents d LEFT JOIN document_content dc ON d.content_id = dc.id
       WHERE d.company_id=$1 AND d.fetch_status='ok' AND COALESCE(dc.content, d.content) IS NOT NULL
       ORDER BY length(COALESCE(dc.content, d.content)) DESC LIMIT 40`, [companyId])).rows;

    const combinedText = docs.map((d: any) =>
      `--- DOCUMENT: ${d.title || "Untitled"} [${d.url}] ---\n${d.content}`).join("\n\n");
    console.error(`  ${docs.length} docs, ${combinedText.length} chars combined`);

    // Build evidence packs for the sampled measures (production logic)
    const packs = buildEvidencePacksForCategory({ measures, combinedText });
    const packByMeasure: Record<string, string> = {};
    for (const p of packs) packByMeasure[p.measureId] = p.text;

    const companyResult: any = { companyId, name: company.name, sector: company.sector, measures: [] };

    for (const measure of measures) {
      const evidenceText = packByMeasure[measure.measureId] || "";
      const { system, prompt } = buildBinaryScoringPrompt({ companyName: company.name, measure, evidenceText, topicDescription });
      const inputTokens = estTokens(system + prompt);

      const measureResult: any = { measureId: measure.measureId, title: measure.title, evidenceChars: evidenceText.length, models: {} };

      // Run all candidate models concurrently for this measure (independent calls).
      await Promise.all(CANDIDATES.map(async (modelName) => {
        const provider = getProvider(modelName);
        if (!provider || !provider.isAvailable()) {
          measureResult.models[modelName] = { error: "unavailable" };
          return;
        }
        const t0 = Date.now();
        try {
          let text = await provider.complete({ system, prompt, json: true, maxTokens: 2000, temperature: 0 });
          let parsed: any;
          try {
            parsed = extractAndParseJSON(text);
          } catch {
            // One retry with an explicit JSON-only instruction (helps reasoning models)
            text = await provider.complete({
              system: system + "\n\nIMPORTANT: Respond with ONLY the JSON object. No prose, no markdown, no <think> blocks.",
              prompt, json: true, maxTokens: 2000, temperature: 0,
            });
            parsed = extractAndParseJSON(text);
          }
          const ms = Date.now() - t0;
          const quotes = Array.isArray(parsed.quotes) ? parsed.quotes : [];
          const grounded = quotes.filter((q: any) => verbatimGrounded(q.text, evidenceText)).length;
          measureResult.models[modelName] = {
            model: provider.model,
            score: parsed.score === 1 ? 1 : 0,
            verdict: parsed.verdict || null,
            confidence: parsed.confidence || null,
            summaryLen: (parsed.evidenceSummary || "").length,
            numQuotes: quotes.length,
            groundedQuotes: grounded,
            groundingRate: quotes.length ? +(grounded / quotes.length).toFixed(2) : null,
            inputTokens,
            outputTokens: estTokens(text),
            latencyMs: ms,
          };
          console.error(`  [${measure.measureId}] ${modelName}: ${parsed.verdict} (conf ${parsed.confidence}) q=${quotes.length}/${grounded} ${ms}ms`);
        } catch (e: any) {
          const msg = e.response?.data?.error?.message || e.message || String(e);
          measureResult.models[modelName] = { error: msg.slice(0, 160), latencyMs: Date.now() - t0 };
          console.error(`  [${measure.measureId}] ${modelName}: ERROR ${msg.slice(0, 100)}`);
        }
      }));
      companyResult.measures.push(measureResult);
    }
    report.companies.push(companyResult);
  }

  const outPath = `/tmp/benchmark_${frameworkId}${process.env.OUT_SUFFIX || ""}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`\nWrote ${outPath}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
