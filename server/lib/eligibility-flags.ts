/**
 * eligibility-flags.ts — Refined entity-attribution gate.
 * 
 * Incorporates trusted-source waivers, pronoun matching, cleaned core names,
 * and rationale-quote token alignment.
 */

import { deriveAliases } from "./issuer-resolver.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EligibilityFlagId =
  | "entity-attribution"
  | "date-window"
  | "planned-vs-live"
  | "author-vs-adopter"
  | "claim-level-source-link";

export interface EligibilityFlag {
  id: EligibilityFlagId;
  label: string;
  triggered: boolean;
  severity: "advisory";
  dismissible: true;
  reason: string;
}

export interface EligibilityFlagsResult {
  flags: EligibilityFlag[];
  triggeredCount: number;
  advisoryOnly: true;
}

export interface QuoteLike {
  text: string;
  source?: string;
  sourceUrl?: string;
  page?: number;
}

export interface CompanyIdentity {
  name: string;
  ticker?: string | null;
  aliases?: string[] | null;
  domain?: string | null;
  relatedDomains?: string[] | null;
  fmp_company_name?: string | null;
  fmp_symbol?: string | null;
}

export interface EligibilityFlagsInput {
  verdict: string;
  quotes: QuoteLike[];
  evidenceSummary?: string | null;
  company: CompanyIdentity;
  window?: {
    currentYear?: number;
    yearsBack?: number;
  };
}

// ─── Generic linguistic cue sets ─────────────────────────────────────────────

const PLANNED_CUES: RegExp[] = [
  /\bplans?\s+to\b/i, /\bplanned\b/i, /\bintends?\s+to\b/i, /\bintention\s+to\b/i,
  /\baims?\s+to\b/i, /\baspires?\s+to\b/i,
  /\bwill\s+(?:establish|create|launch|introduce|develop|implement|roll\s*out|build|deploy|adopt)\b/i,
  /\bis\s+(?:planning|exploring|considering|evaluating|developing|piloting)\b/i,
  /\b(?:by|before)\s+20\d{2}\b/i,
  /\b(?:upcoming|future|forthcoming|proposed|to\s+be\s+(?:established|launched|introduced|rolled\s*out))\b/i,
  /\bpilot(?:ing)?\b/i, /\bproof[-\s]of[-\s]concept\b/i, /\btrial(?:ling|ing)?\b/i,
];

const LIVE_CUES: RegExp[] = [
  /\b(?:has|have|had)\s+(?:established|created|launched|introduced|implemented|rolled\s*out|built|deployed|adopted|developed)\b/i,
  /\b(?:established|launched|introduced|implemented|deployed|adopted|operates?|operating|maintains?|in\s+place|currently)\b/i,
  /\b(?:since|in)\s+20\d{2}\b/i,
  /\b(?:we|the\s+(?:company|group|bank|firm))\s+(?:operate|run|maintain|use|apply)\b/i,
];

const AUTHOR_CUES: RegExp[] = [
  /\bguidance\s+(?:for|to)\s+(?:our\s+)?(?:customers|clients|users|members|partners)\b/i,
  /\b(?:helps?|helping|enables?|enabling|allows?|supports?|assist(?:s|ing)?)\s+(?:our\s+)?(?:customers|clients|users|businesses|organ[iz]ations|companies)\b/i,
  /\b(?:for|to)\s+(?:our\s+)?(?:customers|clients)\b.*\b(?:can|to)\b/i,
  /\boffer(?:s|ing)?\s+(?:our\s+)?(?:customers|clients)\b/i,
  /\bour\s+(?:product|platform|solution|service|software|tool)\s+(?:helps?|enables?|allows?|lets?)\b/i,
  /\bwe\s+(?:advise|recommend|guide)\s+(?:our\s+)?(?:customers|clients)\b/i,
];

const ADOPTER_CUES: RegExp[] = [
  /\b(?:we|our\s+(?:company|group|firm|organ[iz]ation|business))\s+(?:have|has|adopted|implemented|established|use|operate|maintain|apply)\b/i,
  /\bour\s+(?:own\s+)?(?:internal|corporate|employee|workforce|governance|board|policy|policies|programme|program)\b/i,
  /\b(?:internally|across\s+(?:our|the)\s+(?:company|group|organ))/i,
];

const PRONOUNS_REGEX = /\b(we|our|us|the company|the group|the firm|the bank|this company|this group|both parties|本集团|本公司|我们|我司|双方|本行|本行及子公司)\b/i;
const REPORTS_REGEX = /\b(Annual Report|Sustainability Report|ESG Report|ESG Fact|10-K|20-F|Integrated Report|Terms & Conditions|Consent Form|Proxy Statement|Notice of Meeting|Policy|Statement|Code of Conduct|Charter|Guidelines)\b/i;
const COMMITMENT_VERBS = /\b(Establish|Implement|Ensure|Adopt|Maintain|Retain|Monitor|Protect|Secure|Disclose)\b/i;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function nonEmpty(s: any): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

const GENERIC_NAME_WORDS = new Set<string>([
  "the", "and", "for", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "incorporated", "inc", "ltd", "limited", "llc", "plc",
  "public", "co", "sa", "se", "ag", "nv", "spa", "oyj", "asa", "ab", "as", "bv", "kg",
  "international", "global", "worldwide", "industries", "industrial", "enterprise",
  "enterprises", "technologies", "technology", "systems", "solutions", "services",
  "products", "semiconductor", "semiconductors", "electronics", "electric",
  "financial", "bank", "banking", "capital", "partners", "resources", "materials",
  "energy", "power", "motors", "motor", "pharmaceutical", "pharmaceuticals",
  "chemical", "chemicals", "insurance", "asset", "management", "trust", "properties",
  "property", "realty", "real", "estate", "manufacturing", "telecom", "communications",
  "media", "retail", "foods", "food", "beverage", "automotive", "aerospace",
  "hong", "kong", "china", "japan", "korea", "america", "american", "national",
]);

/** Primary domains from domain_policies (Source Domains page) */
const PRIMARY_DOMAINS = new Set([
  "adx.ae", "annualreports.com", "asx.com.au", "bseindia.com", "cninfo.com.cn",
  "companiesmarketcap.com", "corporate-ir.net", "edgar-online.com", "euronext.com",
  "fca.org.uk", "fda.gov", "federalregister.gov", "filingreader.com", "financialfilings.com",
  "gov.uk", "hkex.com.hk", "hkexgroup.com", "hkexnews.hk", "last10k.com",
  "londonstockexchange.com", "marketscreener.com", "nasdaq.com", "nseindia.com",
  "proxyvote.com", "q4cdn.com", "scribd.com", "sec.gov", "sedarplus.ca", "sgx.com",
  "sina.com.cn", "sse.com.cn", "stocktitan.net", "sustainabilityreports.com", "szse.cn",
  "unglobalcompact.org"
]);

function isTrustedSource(url: string | undefined, company: CompanyIdentity): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (PRIMARY_DOMAINS.has(hostname)) return true;
    for (const domain of PRIMARY_DOMAINS) {
      if (hostname.endsWith("." + domain)) return true;
    }
    // Also trust company's own domains
    const targets = [company.domain, ...(company.relatedDomains || [])]
      .filter(nonEmpty)
      .map(d => d.toLowerCase().replace(/^www\./, ""));
    for (const t of targets) {
      if (hostname === t || hostname.endsWith("." + t)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function cleanCompanyName(name: string): string {
  const suffixes = [
    "Group Holding Limited", "Holding Limited", "Holdings Limited", "Group Limited",
    "Limited", "Ltd", "Inc", "Corp", "Corporation", "S.A.", "PLC", "Public Limited Company",
    "AG", "NV", "SE", "ASA", "AB"
  ];
  let cleaned = name;
  for (const s of suffixes) {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp("\\b" + escaped + "\\b", "gi"), "");
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

function getDistinctiveTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const tokens = text.match(/\b[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[A-Z]{2,}\b|\b[A-Z][a-z]{3,}\b/g) || [];
  const exclude = new Set(["Entity", "Gate", "Quotes", "Rationale", "Verdict", "Company", "No", "Yes", "High", "Partial", "Confidence", "Missing", "Supporting", "Passage", "Evidence", "Target", "Downgraded", "Score", "Internal", "Practice", "Describes", "Systems", "Models", "Framework", "Governance", "Strategic", "Objectives", "Deployment", "Operational", "Efficiency"]);
  return new Set(tokens.filter(t => !exclude.has(t) && t.length > 2));
}

function identityTokens(company: CompanyIdentity): string[] {
  const toks = new Set<string>();
  const name = (company.name || "").trim();
  if (name) {
    for (const a of deriveAliases(name, company.ticker ?? null)) {
      const t = a.toLowerCase().trim();
      if (t.length >= 3) toks.add(t);
    }
    const core = cleanCompanyName(name);
    if (core.length >= 3) toks.add(core.toLowerCase());
  }
  const tkr = (company.ticker || "").toLowerCase().trim();
  if (tkr.length >= 2) toks.add(tkr);
  
  if (company.fmp_symbol) {
    const fmpTkr = company.fmp_symbol.split(".")[0].toLowerCase();
    if (fmpTkr.length >= 2) toks.add(fmpTkr);
  }

  for (const a of company.aliases || []) {
    if (nonEmpty(a) && a.trim().length >= 3) toks.add(a.toLowerCase().trim());
  }
  
  // Non-English name tokens
  const names = [company.name, company.fmp_company_name].filter(nonEmpty);
  for (const n of names) {
    const cjk = n.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
    for (const cn of cjk) {
      if (cn.length >= 2) toks.add(cn);
    }
  }

  const filtered = Array.from(toks).filter((t) => !GENERIC_NAME_WORDS.has(t));
  return filtered.length > 0 ? filtered : Array.from(toks);
}

export function reviewQuoteAttribution(
  quotes: QuoteLike[] | null | undefined,
  company: CompanyIdentity,
  evidenceSummary?: string | null
): Array<{ index: number; attributedToTarget: boolean; reason?: string }> {
  try {
    const toks = identityTokens(company);
    const rationaleTokens = getDistinctiveTokens(evidenceSummary);
    
    return (quotes || []).map((q, index) => {
      if (!q || !nonEmpty(q.text)) return { index, attributedToTarget: false };
      
      const text = q.text;
      const lowerText = text.toLowerCase();
      
      // Rule: Direct identity token match
      if (toks.some(t => lowerText.includes(t))) {
        return { index, attributedToTarget: true };
      }

      // Rule: Trusted Source + First-Party framing
      const trusted = isTrustedSource(q.sourceUrl, company);
      if (trusted) {
        if (PRONOUNS_REGEX.test(text)) return { index, attributedToTarget: true, reason: "Trusted Source + First-Party" };
        if (REPORTS_REGEX.test(q.source || "")) {
           if (text.split(/\s+/).length > 5 || COMMITMENT_VERBS.test(text)) {
             return { index, attributedToTarget: true, reason: "Trusted Report Title" };
           }
        }
        if (cleanCompanyName(company.name).toLowerCase() === (q.source || "").toLowerCase()) {
          return { index, attributedToTarget: true, reason: "Exact Name in Source Title" };
        }
      }

      // Rule: Rationale Alignment
      for (const token of rationaleTokens) {
        if (text.includes(token)) return { index, attributedToTarget: true, reason: `Rationale Alignment (${token})` };
      }

      return { index, attributedToTarget: false };
    });
  } catch {
    return (quotes || []).map((_, index) => ({ index, attributedToTarget: true }));
  }
}

function anyCueHits(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function collectText(input: EligibilityFlagsInput): string {
  const parts: string[] = [];
  for (const q of input.quotes || []) if (nonEmpty(q?.text)) parts.push(q.text);
  if (nonEmpty(input.evidenceSummary)) parts.push(input.evidenceSummary as string);
  return parts.join(" \n ");
}

const POSITIVE_VERDICTS = new Set(["Yes", "Partial"]);
export function isPositiveVerdict(verdict: string): boolean {
  return POSITIVE_VERDICTS.has((verdict || "").trim());
}

function flagEntityAttribution(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "entity-attribution" as const, label: "Entity attribution", severity: "advisory" as const, dismissible: true as const };
  const attributions = reviewQuoteAttribution(input.quotes, input.company, input.evidenceSummary);
  const attributedCount = attributions.filter(a => a.attributedToTarget).length;
  
  if (input.quotes.length > 0 && attributedCount === 0) {
    return {
      ...base,
      triggered: true,
      reason: "None of the supporting quotes name the target company or use first-party language from a trusted source. The evidence likely describes a third party (client, vendor, or affiliate)."
    };
  }
  
  return { ...base, triggered: false, reason: `Verified attribution for ${attributedCount}/${input.quotes.length} quotes.` };
}

function flagDateWindow(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "date-window" as const, label: "Date window", severity: "advisory" as const, dismissible: true as const };
  const currentYear = input.window?.currentYear ?? new Date().getUTCFullYear();
  const yearsBack = input.window?.yearsBack ?? 3;
  const earliest = currentYear - yearsBack;
  const years = Array.from(text.matchAll(/\b(19\d{2}|20\d{2})\b/g))
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y >= 1990 && y <= currentYear + 1);
  if (years.length === 0) return { ...base, triggered: false, reason: "No explicit year found." };
  const newest = Math.max(...years);
  if (newest >= earliest) return { ...base, triggered: false, reason: `Year ${newest} is in window.` };
  return { ...base, triggered: true, reason: `Evidence from ${newest} may be stale (window: ${earliest}-${currentYear}).` };
}

function flagPlannedVsLive(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "planned-vs-live" as const, label: "Planned vs live", severity: "advisory" as const, dismissible: true as const };
  const planned = anyCueHits(PLANNED_CUES, text);
  const live = anyCueHits(LIVE_CUES, text);
  if (planned && !live) return { ...base, triggered: true, reason: "Language is primarily forward-looking." };
  return { ...base, triggered: false, reason: "Implemented/live language detected or no planning cues found." };
}

function flagAuthorVsAdopter(input: EligibilityFlagsInput, text: string): EligibilityFlag {
  const base = { id: "author-vs-adopter" as const, label: "Author vs adopter", severity: "advisory" as const, dismissible: true as const };
  const author = anyCueHits(AUTHOR_CUES, text);
  const adopter = anyCueHits(ADOPTER_CUES, text);
  if (author && !adopter) return { ...base, triggered: true, reason: "Framed as guidance for customers rather than own practice." };
  return { ...base, triggered: false, reason: "Adopter language detected or no author framing found." };
}

function flagClaimLevelSourceLink(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "claim-level-source-link" as const, label: "Claim-level source link", severity: "advisory" as const, dismissible: true as const };
  const hasLink = (input.quotes || []).some(q => nonEmpty(q?.text) && /^https?:\/\/\S+/i.test((q?.sourceUrl || "").trim()));
  return { ...base, triggered: !hasLink, reason: hasLink ? "Link present." : "No claim-level link found." };
}

export function computeEligibilityFlags(input: EligibilityFlagsInput): EligibilityFlagsResult {
  const makeUntriggered = (reason: string): EligibilityFlagsResult => ({
    flags: (["entity-attribution", "date-window", "planned-vs-live", "author-vs-adopter", "claim-level-source-link"] as EligibilityFlagId[]).map(id => ({
      id, label: id, triggered: false, severity: "advisory", dismissible: true, reason
    })),
    triggeredCount: 0,
    advisoryOnly: true,
  });

  try {
    if (!input?.company?.name || !isPositiveVerdict(input.verdict)) return makeUntriggered("Not assessed.");
    const text = collectText(input);
    const flags = [
      flagEntityAttribution(input),
      flagDateWindow(input, text),
      flagPlannedVsLive(input, text),
      flagAuthorVsAdopter(input, text),
      flagClaimLevelSourceLink(input),
    ];
    return { flags, triggeredCount: flags.filter(f => f.triggered).length, advisoryOnly: true };
  } catch {
    return makeUntriggered("Error.");
  }
}
