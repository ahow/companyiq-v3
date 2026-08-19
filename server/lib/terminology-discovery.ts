import { completeWithFallback } from "./ai-providers.js";
import * as storage from "../storage.js";

const TERMINOLOGY_PREFIX_CHARS = 15000;
const TERMINOLOGY_MODEL = "deepseek";

export interface TerminologyMap {
  committees: string[];
  roles: string[];
  programmes: string[];
  productsAndPolicies: string[];
  otherTerms: string[];
}

export function flattenTerms(terms: TerminologyMap): string[] {
  return [
    ...terms.committees,
    ...terms.roles,
    ...terms.programmes,
    ...terms.productsAndPolicies,
    ...terms.otherTerms,
  ];
}

export async function discoverCompanyTerminology(opts: {
  companyName: string;
  companyId: number;
  frameworkId: number;
  topicDescription: string;
  documentTexts: string[];
}): Promise<TerminologyMap> {
  const { companyName, companyId, frameworkId, topicDescription, documentTexts } = opts;

  // Check cache first — even empty results are valid cache hits
  const cached = await storage.getCompanyTerminology(companyId, frameworkId);
  if (cached) {
    console.log(`[${companyName}] Using cached terminology (${flattenTerms(cached.terms).length} terms)`);
    return cached.terms;
  }

  // Take first TERMINOLOGY_PREFIX_CHARS from each document (typically covers TOC, committee charters, executive summary)
  const prefixes = documentTexts
    .filter((t) => t.length > 100)
    .slice(0, 3) // Max 3 documents for terminology scan
    .map((t) => t.slice(0, TERMINOLOGY_PREFIX_CHARS));

  if (prefixes.length === 0) {
    // Cache empty result to prevent re-running
    const emptyTerms: TerminologyMap = {
      committees: [],
      roles: [],
      programmes: [],
      productsAndPolicies: [],
      otherTerms: [],
    };
    await storage.upsertCompanyTerminology({
      companyId,
      frameworkId,
      terms: emptyTerms,
      sourceDocCount: 0,
      modelUsed: TERMINOLOGY_MODEL,
    });
    return emptyTerms;
  }

  const combinedPrefixes = prefixes.join("\n\n---DOCUMENT BOUNDARY---\n\n");

  const prompt = `You are reading corporate disclosure documents for ${companyName}.

The analysis framework covers the following topic:
${topicDescription}

Your task is to identify the specific internal vocabulary this company uses when discussing this topic. Look for:
- Committee names (e.g., "Innovation and Technology Committee", "Digital Risk Committee")
- Named roles or titles (e.g., "Chief Operating Officer", "Head of Compliance")
- Programme or initiative names (e.g., "Enterprise Responsibility Program", "Digital Trust Initiative")
- Products and policies (e.g., "Supplier Policy", "Model Risk Management Framework")
- Any other recurring terms specific to this company for this topic

Return ONLY a JSON object in this exact format:
{
  "committees": ["...", "..."],
  "roles": ["...", "..."],
  "programmes": ["...", "..."],
  "productsAndPolicies": ["...", "..."],
  "otherTerms": ["...", "..."]
}

Only include terms that actually appear in the text. If no relevant terms are found, return empty arrays. Do not invent or infer terms.

DOCUMENT TEXT:
${combinedPrefixes}`;

  try {
    const { text, provider } = await completeWithFallback(TERMINOLOGY_MODEL, {
      system: "You are a corporate disclosure analyst identifying company-specific terminology. Return only valid JSON.",
      prompt,
      json: true,
      maxTokens: 2000,
    });

    const parsed = JSON.parse(text);
    const terms: TerminologyMap = {
      committees: Array.isArray(parsed.committees) ? parsed.committees : [],
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      programmes: Array.isArray(parsed.programmes) ? parsed.programmes : [],
      productsAndPolicies: Array.isArray(parsed.productsAndPolicies) ? parsed.productsAndPolicies : [],
      otherTerms: Array.isArray(parsed.otherTerms) ? parsed.otherTerms : [],
    };

    console.log(`[${companyName}] Discovered ${flattenTerms(terms).length} terminology terms via ${provider}`);

    // Persist (even empty results)
    await storage.upsertCompanyTerminology({
      companyId,
      frameworkId,
      terms,
      sourceDocCount: prefixes.length,
      modelUsed: provider,
    });

    return terms;
  } catch (error: any) {
    console.warn(`[${companyName}] Terminology discovery failed: ${error.message}`);
    // Cache empty result on failure to prevent re-running
    const emptyTerms: TerminologyMap = {
      committees: [],
      roles: [],
      programmes: [],
      productsAndPolicies: [],
      otherTerms: [],
    };
    await storage.upsertCompanyTerminology({
      companyId,
      frameworkId,
      terms: emptyTerms,
      sourceDocCount: 0,
      modelUsed: "failed",
    });
    return emptyTerms;
  }
}
