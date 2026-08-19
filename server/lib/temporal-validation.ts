/**
 * Temporal Validation Module
 * 
 * Detects policy withdrawals, target rollbacks, and material temporal changes
 * that affect the currency of evidence used in scoring. This prevents a
 * completed assessment from relying on evidence after a company has explicitly
 * withdrawn, removed, or superseded the commitment being assessed.
 * 
 * Two-stage approach:
 * 1. DOCUMENT SCAN: Scan fetched documents for withdrawal language
 * 2. WEB SEARCH: Run targeted withdrawal-detection queries
 */

import axios from "axios";
import { completeWithFallback } from "./ai-providers.js";
import type { Framework } from "../../shared/schema.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolicyWithdrawal {
  type: "withdrawal" | "rollback" | "removal" | "superseded";
  description: string;
  affectedTopics: string[]; // Framework topics or measure labels implicated by evidence
  detectedDate: string | null; // ISO date string if available
  source: string; // URL or "document scan"
  confidence: "high" | "medium" | "low";
}

export interface TemporalContext {
  withdrawals: PolicyWithdrawal[];
  latestDisclosureDate: string | null; // Most recent document date detected
  temporalWarning: string | null; // Human-readable warning to inject into scoring
}

// ─── Withdrawal Detection Queries ─────────────────────────────────────────────

// 41-C: Framework-agnostic withdrawal query builder.
// Universal queries apply to any framework. Topic-specific queries come
// EXCLUSIVELY from framework.withdrawalPatterns.queries (declared per-framework).
function buildWithdrawalQueries(companyName: string, framework: Framework): string[] {
  // Universal queries apply to any framework and contain no topic-specific terms.
  const universal = [
    `"${companyName}" discontinues target OR abandons commitment OR withdraws pledge`,
    `"${companyName}" removes policy OR drops framework OR retires goal`,
  ];
  // Framework-specific queries from withdrawalPatterns config
  const frameworkSpecific = (((framework as any).withdrawalPatterns?.queries ?? []) as string[])
    .map((q: string) => q.replace(/\{companyName\}/g, companyName));
  return [...universal, ...frameworkSpecific];
}

// ─── Document Scan for Withdrawal Language ────────────────────────────────────

// Universal patterns only. Topic-specific document patterns come from
// framework.withdrawalPatterns.documentRegex.
const UNIVERSAL_WITHDRAWAL_PATTERNS: RegExp[] = [
  /(?:we have|the (?:company|group|issuer|organisation|organization) has?) (?:discontinued|withdrawn|removed|dropped|scrapped|abandoned|exited)/i,
  /no longer (?:commit|target|pursue|maintain)/i,
  /(?:target|commitment|goal|pledge) (?:has been|was) (?:discontinued|withdrawn|removed|superseded)/i,
  /(?:effective|as of) .{0,30}(?:discontinued|no longer|withdrawn)/i,
];

// 41-C: Accepts framework to merge universal + framework-specific document patterns.
function scanDocumentsForWithdrawals(
  documentTexts: string[],
  documentUrls: string[],
  framework?: Framework
): Array<{ text: string; url: string; pattern: string }> {
  // Merge universal + framework-specific document regex patterns
  const frameworkRegex = (((framework as any)?.withdrawalPatterns?.documentRegex ?? []) as string[])
    .map((p: string) => { try { return new RegExp(p, "i"); } catch { return null; } })
    .filter((r): r is RegExp => r !== null);
  const allPatterns = [...UNIVERSAL_WITHDRAWAL_PATTERNS, ...frameworkRegex];

  const matches: Array<{ text: string; url: string; pattern: string }> = [];

  for (let i = 0; i < documentTexts.length; i++) {
    const text = documentTexts[i];
    const url = documentUrls[i] || "unknown";

    for (const pattern of allPatterns) {
      const match = text.match(pattern);
      if (match) {
        // Extract surrounding context (200 chars before and after)
        const idx = match.index || 0;
        const start = Math.max(0, idx - 200);
        const end = Math.min(text.length, idx + match[0].length + 200);
        const context = text.slice(start, end);
        matches.push({ text: context, url, pattern: pattern.source });
      }
    }
  }

  return matches;
}

// ─── Web Search for Withdrawals ───────────────────────────────────────────────

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

async function webSearchForWithdrawals(query: string): Promise<SearchResult[]> {
  const serperKey = process.env.SERPER_API_KEY;
  const serpApiKey = process.env.SERP_API_KEY;

  if (serperKey) {
    try {
      const response = await axios.post(
        "https://google.serper.dev/search",
        { q: query, num: 5, tbs: "qdr:y" }, // Last year only
        {
          headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
          timeout: 10000,
        }
      );
      return (response.data.organic || []).map((r: any) => ({
        title: r.title || "",
        link: r.link || "",
        snippet: r.snippet || "",
      }));
    } catch {
      // Fall through to SerpAPI
    }
  }

  if (serpApiKey) {
    try {
      const response = await axios.get("https://serpapi.com/search.json", {
        params: { q: query, api_key: serpApiKey, engine: "google", num: 5, tbs: "qdr:y" },
        timeout: 10000,
      });
      return (response.data.organic_results || []).map((r: any) => ({
        title: r.title || "",
        link: r.link || "",
        snippet: r.snippet || "",
      }));
    } catch {
      return [];
    }
  }

  return [];
}

// ─── LLM-Based Withdrawal Classification ─────────────────────────────────────

async function classifyWithdrawals(
  companyName: string,
  evidenceSnippets: Array<{ text: string; source: string }>,
  framework: Framework
): Promise<PolicyWithdrawal[]> {
  if (evidenceSnippets.length === 0) return [];

  const snippetList = evidenceSnippets
    .map((s, i) => `[${i + 1}] Source: ${s.source}\nText: ${s.text}`)
    .join("\n\n");

  try {
    const { text } = await completeWithFallback("deepseek", {
      system: `You are an analyst detecting explicit withdrawals, removals, supersessions, or rollbacks of commitments in a structured company assessment. Given evidence snippets about a company, determine whether any represent a genuine change that affects the current assessment.

Return a JSON array of confirmed withdrawals. Each object must have:
- "type": "withdrawal" | "rollback" | "removal" | "superseded"
- "description": brief description of what was withdrawn/changed
- "affectedTopics": array of framework topics or measure labels implicated by the evidence
- "detectedDate": ISO date string if mentioned, or null
- "source": the source URL or "document scan"
- "confidence": "high" | "medium" | "low"

IMPORTANT:
- Only flag GENUINE withdrawals where the company has explicitly reversed, discontinued, or removed a prior commitment.
- Do NOT flag routine target updates, methodology changes, or restatements as withdrawals.
- If no genuine withdrawals are found, return an empty array [].`,
      prompt: `Company: ${companyName}
Framework: ${framework.name}

Evidence snippets that may indicate explicit commitment changes:

${snippetList}

Classify each snippet. Return a JSON array of confirmed changes (or [] if none are genuine):`,
      json: true,
      maxTokens: 2000,
    });

    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (w: any) => w.type && w.description && w.affectedTopics
      ) as PolicyWithdrawal[];
    }
    return [];
  } catch (error: any) {
    console.warn(`[TemporalValidation] Classification failed: ${error.message}`);
    return [];
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runTemporalValidation(opts: {
  companyName: string;
  companyId: number;
  framework: Framework;
  documentTexts: string[];
  documentUrls: string[];
}): Promise<TemporalContext> {
  const { companyName, companyId, framework, documentTexts, documentUrls } = opts;

  console.log(`[${companyName}] Running temporal validation...`);

  const allSnippets: Array<{ text: string; source: string }> = [];

  // Stage 1: Scan fetched documents for withdrawal language
  const docMatches = scanDocumentsForWithdrawals(documentTexts, documentUrls, framework);
  for (const match of docMatches) {
    allSnippets.push({ text: match.text, source: match.url });
  }
  if (docMatches.length > 0) {
    console.log(`[${companyName}] Document scan found ${docMatches.length} potential withdrawal signals`);
  }

  // Stage 2: Run targeted web searches for withdrawal news
  const withdrawalQueries = buildWithdrawalQueries(companyName, framework);
  for (const query of withdrawalQueries.slice(0, 3)) { // Limit to 3 queries to control cost
    try {
      const results = await webSearchForWithdrawals(query);
      for (const r of results) {
        // Only consider results that mention the company name
        const combined = `${r.title} ${r.snippet}`.toLowerCase();
        if (combined.includes(companyName.toLowerCase().split(" ")[0].toLowerCase())) {
          allSnippets.push({
            text: `${r.title}. ${r.snippet}`,
            source: r.link,
          });
        }
      }
    } catch {
      // Non-fatal: continue with other queries
    }
  }

  console.log(`[${companyName}] Temporal validation: ${allSnippets.length} total snippets to classify`);

  // Stage 3: Classify snippets via LLM (only if we found potential signals)
  let withdrawals: PolicyWithdrawal[] = [];
  if (allSnippets.length > 0) {
    // Deduplicate and cap at 10 snippets
    const uniqueSnippets = allSnippets
      .filter((s, i, arr) => arr.findIndex((x) => x.text === s.text) === i)
      .slice(0, 10);
    
    withdrawals = await classifyWithdrawals(companyName, uniqueSnippets, framework);
  }

  // Build temporal warning string for injection into scorer
  let temporalWarning: string | null = null;
  if (withdrawals.length > 0) {
    const warnings = withdrawals.map(
      (w) => `${w.description} (${w.type}, confidence: ${w.confidence}, affects: ${w.affectedTopics.join(", ")})`
    );
    temporalWarning = `TEMPORAL WARNING: The following policy changes have been detected for this company:\n${warnings.map((w) => `- ${w}`).join("\n")}\nScore measures based on the CURRENT state of commitments, not historical ones.`;
  }

  return {
    withdrawals,
    latestDisclosureDate: null, // Could be enhanced later with date extraction
    temporalWarning,
  };
}
