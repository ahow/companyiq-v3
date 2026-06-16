/**
 * Company Verification
 * ────────────────────
 * LLM-based check that confirms whether a fetched document is actually about
 * the TARGET company (vs. a different company that happened to be discovered,
 * e.g. via a shared investor-relations CDN like q4cdn.com).
 *
 * WHY THIS EXISTS
 * A document can enter a company's candidate list purely from its host + title
 * (the relevance gate only sees URL/title/snippet). When a company has no
 * verified domain, discovery may auto-anchor to a SHARED CDN and pull in other
 * companies' filings (the "Lancaster ESG on 3SBio" bug). The old post-fetch
 * guard was a naive substring check (does the text contain the company name?),
 * which both over-accepts (a passing mention) and under-protects.
 *
 * WHEN IT RUNS (gating — see shouldVerifyDocument)
 *   1. The company has NO verified domain set, OR
 *   2. The document's host does NOT equal the company's verified domain.
 * Documents hosted on the company's own verified domain are trusted and skip
 * the LLM call (fast path, no cost).
 *
 * IMPORTANT: A document on a shared CDN / third-party host is NOT rejected for
 * that reason alone. If the LLM confirms the content is about the target
 * company, it is KEPT — so relevant off-domain documents are retained.
 */

import { completeWithFallback } from "./ai-providers.js";

// Primary model for batch work (user preference: Deepseek primary, others backup).
const VERIFY_MODEL = process.env.COMPANY_VERIFY_MODEL || "deepseek";

// How much of the document content to send to the verifier. The issuer of a
// corporate disclosure is almost always identifiable from the first page(s)
// (cover, header, "About <Company>", footer), so a head sample is sufficient
// and keeps cost/latency low.
const VERIFY_CONTENT_CHARS = parseInt(process.env.COMPANY_VERIFY_CHARS || "6000", 10);

export type VerificationVerdict = "match" | "different_company" | "generic" | "error";

export interface VerificationResult {
  verdict: VerificationVerdict;
  detectedIssuer: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/** Normalize a hostname: strip protocol, leading www., lowercase, trailing dot. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

/** Normalize a stored company domain value into a bare host for comparison. */
export function normalizeDomain(domain: string | null | undefined): string {
  if (!domain) return "";
  let d = domain.trim().toLowerCase();
  // Accept values stored as full URLs or bare hosts.
  if (d.includes("://")) {
    const h = hostOf(d);
    d = h || d;
  }
  return d.replace(/^www\./i, "").replace(/\.$/, "");
}

/**
 * Does a document's host belong to the company's own verified domain?
 * True when the host equals the domain or is a subdomain of it (or vice-versa,
 * to tolerate apex vs. www / ir. subdomains).
 */
export function hostMatchesDomain(url: string, verifiedDomain: string): boolean {
  const domain = normalizeDomain(verifiedDomain);
  if (!domain) return false;
  const host = hostOf(url);
  if (!host) return false;
  return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
}

export interface VerifyGateInput {
  url: string;
  verifiedDomain: string | null | undefined; // company's verified domain (may be empty/null)
}

/**
 * Decide whether the LLM verification should run for this document.
 * Triggers (per user requirement):
 *   - company has NO verified domain, OR
 *   - document host != company's verified domain.
 */
export function shouldVerifyDocument(input: VerifyGateInput): boolean {
  const domain = normalizeDomain(input.verifiedDomain);
  if (!domain) return true; // no verified domain -> verify everything
  return !hostMatchesDomain(input.url, domain); // off-domain -> verify
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  }
  return null;
}

export interface CompanyIdentity {
  name: string;
  isin?: string | null;
  sector?: string | null;
  country?: string | null;
  ticker?: string | null;
  verifiedDomain?: string | null;
}

/**
 * Ask the LLM whose corporate disclosure a document is, and whether it is the
 * target company. Returns a structured verdict; on any failure returns
 * { verdict: "error" } so the caller can decide a fail-safe policy.
 */
export async function verifyDocumentCompany(
  identity: CompanyIdentity,
  doc: { url: string; title?: string | null; content: string }
): Promise<VerificationResult> {
  const content = (doc.content || "").slice(0, VERIFY_CONTENT_CHARS);
  if (content.replace(/\s/g, "").length < 30) {
    return { verdict: "error", detectedIssuer: null, confidence: "low", reason: "insufficient content" };
  }

  const identityLines = [
    `Target company: ${identity.name}`,
    identity.ticker ? `Ticker: ${identity.ticker}` : "",
    identity.isin ? `ISIN: ${identity.isin}` : "",
    identity.sector ? `Sector: ${identity.sector}` : "",
    identity.country ? `Country: ${identity.country}` : "",
    identity.verifiedDomain ? `Known corporate domain: ${normalizeDomain(identity.verifiedDomain)}` : "",
  ].filter(Boolean).join("\n");

  const system = `You verify the SUBJECT/ISSUER of a corporate disclosure document.
Given identity details for a TARGET company and the beginning of a document, determine which company the document is primarily ABOUT (its issuer/subject), and whether that is the TARGET company.

Return ONLY a JSON object:
{
  "detected_issuer": "<the primary company/issuer this document is about, or null if it cannot be determined>",
  "verdict": "match" | "different_company" | "generic",
  "confidence": "high" | "medium" | "low",
  "reason": "<one short sentence>"
}

Definitions:
- "match": the document is primarily a disclosure of the TARGET company (allow for name variants, local-language names, former names, ticker, and subsidiaries/parent of the same group).
- "different_company": the document is primarily about a DIFFERENT company/issuer (even if same sector, similar name, or shared hosting provider).
- "generic": the document is not a single-company disclosure (e.g., an index/listing page, an industry article covering many companies, an empty/error page).

Rules:
- Judge by the DOCUMENT CONTENT (issuer named on the cover/header/footer/"About" section), NOT by the URL host. Shared CDNs (e.g., q4cdn.com) host many different companies, so the host is not proof of issuer.
- If the document is clearly about a named company that is NOT the target, return "different_company" and name that issuer in detected_issuer.
- Be strict: when the primary issuer is a different company, do not return "match" just because the target is mentioned in passing.`;

  const prompt = `${identityLines}

Document URL: ${doc.url}
Document title: ${doc.title || "(none)"}

--- DOCUMENT CONTENT (beginning) ---
${content}
--- END CONTENT ---

Which company is this document primarily about, and is it the target company? Return the JSON object.`;

  try {
    const { text } = await completeWithFallback(VERIFY_MODEL, {
      system,
      prompt,
      json: true,
      maxTokens: 300,
      temperature: 0,
    });
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed.verdict !== "string") {
      return { verdict: "error", detectedIssuer: null, confidence: "low", reason: "unparseable verifier response" };
    }
    const verdict = ["match", "different_company", "generic"].includes(parsed.verdict)
      ? (parsed.verdict as VerificationVerdict)
      : "error";
    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium";
    return {
      verdict,
      detectedIssuer: parsed.detected_issuer ?? parsed.detectedIssuer ?? null,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    };
  } catch (e: any) {
    return { verdict: "error", detectedIssuer: null, confidence: "low", reason: e?.message?.slice(0, 200) || "verifier call failed" };
  }
}
