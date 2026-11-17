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
  | "claim-level-source-link"
  // BUG 5 (advisory): a supporting quote references a year that post-dates the
  // year asserted by its own source label (mislabelled / outdated source).
  | "source-label-mismatch"
  // BUG 6 (advisory): a supporting quote is hosted on a known third-party
  // news/analyst/aggregator domain rather than the issuer's own disclosure.
  | "evidence-on-third-party-host"
  // BUG 4 (advisory): the same supporting quote is reused across multiple Yes
  // measures for this company. Set at company-result assembly (cross-measure),
  // never inside computeEligibilityFlags (which only sees one measure).
  | "quote-reuse";

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

const PRONOUNS_REGEX = /\b(we|our|us|the company|the group|the firm|the bank|the carrier|the insurer|the airline|the utility|the retailer|the manufacturer|this company|this group|both parties|本集团|本公司|我们|我司|双方|本行|本行及子公司)\b/i;
// First-party cues in CJK (Chinese / Japanese / Korean) filings. JS `\b` word
// boundaries do NOT work around CJK characters (they are non-\w), so the CJK
// entries in PRONOUNS_REGEX above never match inside a run of CJK text. This
// boundary-free pattern captures the common first-party references a company
// uses about ITSELF in its own regulatory filings — "公司/本公司/集团/本集团/
// 本行" (zh), "当社/当グループ/弊社/わが社" (ja), "당사/본사/회사" (ko). It is
// ONLY consulted behind the isTrustedSource() gate (company's own domain or a
// primary regulator domain), so it recovers first-party evidence without
// trusting third-party/case-study passages.
const CJK_FIRST_PARTY_REGEX = /(本公司|本集团|本行|我司|我公司|我集团|公司|该公司|集团|当社|当グループ|当行|弊社|わが社|当グループ|당사|본사|회사|당행)/;
const CASE_STUDY_NEGATIVES = /\b(for a client|assisted a partner|major retailer case study|customer case study|client case study|vendor to|partnered with)\b/i;
// STRICT first-party cue (BUG 1): genuine possessive / subject references the
// issuer makes about ITSELF ("we/our/us/ourselves"). Deliberately EXCLUDES the
// generic third-person descriptors "the company/the group/the bank/..." that
// PRONOUNS_REGEX allows, because an issuer's own-brand thought-leadership domain
// (e.g. a consultancy) routinely says "the company" about a CLIENT in a case
// study. The brand-domain waiver (which admits sibling-brand hosts beyond the
// exact DB domain) therefore requires this stricter cue so it recognises a
// genuine own-report passage (Adani's "a few of our operations ...") while NOT
// attributing a generic "the company ..." sentence on an own-brand marketing host.
const FIRST_PARTY_POSSESSIVE_REGEX = /\b(we|our|us|ours|ourselves)\b/i;
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

// True only when the URL's host matches the COMPANY'S OWN domain(s) — never a
// shared aggregator/regulator in PRIMARY_DOMAINS (cninfo, sina, hkexnews, …),
// which host many different companies' filings. Content a company publishes on
// its own site/domain is first-party by construction, so this is a high-precision
// attribution signal independent of the language or phrasing of the passage.
function isOwnDomainSource(url: string | undefined, company: CompanyIdentity): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const targets = [company.domain, ...(company.relatedDomains || [])]
      .filter(nonEmpty)
      .map(d => d.toLowerCase().replace(/^www\./, ""));
    for (const t of targets) {
      if (t.length >= 4 && (hostname === t || hostname.endsWith("." + t))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Known third-party news / analyst / ratings / aggregator hosts. The brand-domain
// waiver below must NEVER treat any of these as the issuer's own domain, even when
// the passage uses first-party-sounding language ("the company …"). This is the
// user's "Generic News" negative rule (gate_refinement_master_rules.md) and is
// what keeps PNC's Morningstar-sourced evidence (about a subsidiary) correctly
// rejected (BUG 6). It is consulted ONLY by the brand-domain path — it never
// affects isTrustedSource / PRIMARY_DOMAINS behaviour.
const THIRD_PARTY_HOST_SUFFIXES: string[] = [
  "morningstar.com", "forbes.com", "reuters.com", "bloomberg.com", "ft.com",
  "wsj.com", "cnbc.com", "marketwatch.com", "seekingalpha.com", "fool.com",
  "barrons.com", "investing.com", "yahoo.com", "spglobal.com", "moodys.com",
  "fitchratings.com", "msci.com", "sustainalytics.com", "refinitiv.com",
  "statista.com", "globaldata.com", "businesswire.com", "prnewswire.com",
  "globenewswire.com", "benzinga.com", "simplywall.st", "tipranks.com",
  "zacks.com", "gurufocus.com", "wikipedia.org", "linkedin.com",
  "crunchbase.com", "perplexity.ai", "nytimes.com", "theguardian.com",
  "economist.com", "bbc.co.uk", "bbc.com", "spott.com", "spcapitaliq.com",
];

/** True when the host is a known third-party news/analyst/aggregator domain. */
export function isThirdPartyHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return THIRD_PARTY_HOST_SUFFIXES.some(
      (d) => hostname === d || hostname.endsWith("." + d),
    );
  } catch {
    return false;
  }
}

/**
 * Brand tokens that identify the issuer, used to recognise own-brand domains that
 * are NOT the exact DB `domain` — e.g. a sibling brand domain
 * (adanienterprises.com when the DB row says adani.com) or a subdomain. Derived
 * from (a) the company NAME via the shared alias deriver (legal + generic
 * corporate-form words stripped) and (b) the registrable label of every known
 * company domain (adani.com → "adani"). Only tokens of length ≥4 are kept so a
 * host-substring match is high-precision (a 2–3 char ticker like "PNC" never
 * admits unrelated hosts — it is handled only by exact-domain/identity-token
 * matching, which keeps the Generic-News guard intact).
 */
function companyBrandTokens(company: CompanyIdentity): string[] {
  const toks = new Set<string>();
  try {
    for (const a of deriveAliases(company?.name || "", company?.ticker ?? null)) {
      const t = (a || "").toLowerCase().trim();
      if (t.length >= 4) toks.add(t);
    }
  } catch { /* alias derivation is best-effort */ }
  const domains = [company?.domain, ...((company?.relatedDomains) || [])].filter(nonEmpty);
  for (const d of domains) {
    const label = d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(".")[0];
    if (label.length >= 4) toks.add(label);
  }
  return Array.from(toks);
}

// True when a quote's host is the issuer's OWN brand domain — a superset of
// isOwnDomainSource that also recognises sibling brand domains and subdomains via
// the company's brand tokens (so adanienterprises.com matches a company whose DB
// `domain` is adani.com). Known third-party news/analyst/aggregator hosts are
// excluded up front (Generic News negative rule, BUG 6). High-precision: a brand
// token (≥4 chars) must appear in the host's registrable (second-level) label.
function isOwnBrandDomainSource(url: string | undefined, company: CompanyIdentity): boolean {
  if (!url) return false;
  try {
    // Negative guard FIRST — never waive a third-party host.
    if (isThirdPartyHost(url)) return false;
    // Exact / subdomain own-domain (existing high-precision path).
    if (isOwnDomainSource(url, company)) return true;
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const label = hostname.split(".")[0];
    if (!label) return false;
    const brandTokens = companyBrandTokens(company);
    // host's second-level label equals / starts-with / contains a brand token ≥4.
    return brandTokens.some((t) => t.length >= 4 && label.includes(t));
  } catch {
    return false;
  }
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
  // Extract Proper Nouns, CamelCase, and specific project-like tokens
  const tokens = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z]{2,}(?:\d+)?\b|\b[A-Z][a-z]{3,}\b/g) || [];
  const exclude = new Set(["Entity", "Gate", "Quotes", "Rationale", "Verdict", "Company", "No", "Yes", "High", "Partial", "Confidence", "Missing", "Supporting", "Passage", "Evidence", "Target", "Downgraded", "Score", "Internal", "Practice", "Describes", "Systems", "Models", "Framework", "Governance", "Strategic", "Objectives", "Deployment", "Operational", "Efficiency", "The", "This", "Our", "We", "They", "It"]);
  return new Set(tokens.filter(t => !exclude.has(t) && t.length > 2));
}

function identityTokens(company: CompanyIdentity): string[] {
  const toks = new Set<string>();
  const name = (company.name || "").trim();
  if (name) {
    for (const a of deriveAliases(name, company.ticker ?? null)) {
      const t = a.toLowerCase().trim();
      if (t.length >= 2) toks.add(t);
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
    if (nonEmpty(a) && a.trim().length >= 2) toks.add(a.toLowerCase().trim());
  }
  
  // Non-English name tokens
  const names = [company.name, company.fmp_company_name].filter(nonEmpty);
  for (const n of names) {
    const cjk = n.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
    for (const cn of cjk) {
      if (cn.length >= 2) toks.add(cn);
    }
  }

  const filtered = Array.from(toks).filter((t) => !GENERIC_NAME_WORDS.has(t) || t === tkr);
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

      // Safeguard: Case Study Penalty (Negative Rule)
      if (CASE_STUDY_NEGATIVES.test(text)) {
        // If a very strong identity match is present, we might still trust it, 
        // but the Master List says "Disqualify if...".
        // We check if the company name appears in a way that suggests OWN activity 
        // despite the case study keywords (e.g. "We partnered with X to...").
        // But Rule 1-8 are primarily about RECOVERING false negatives.
        return { index, attributedToTarget: false, reason: "Case Study Pattern (Negative Rule)" };
      }
      
      // Rule: Direct identity token match
      if (toks.some(t => lowerText.includes(t))) {
        return { index, attributedToTarget: true };
      }

      // Rule 1 (First-Party Domain Waiver): the company's OWN domain is a strong
      // first-party signal, but HOSTING ALONE does not make a passage first-party.
      // A company's own thought-leadership / marketing / insights pages routinely
      // describe OTHER entities (clients, case-study subjects) — the "Accenture
      // bug", where a consultancy's own report credits a CLIENT's outcome to the
      // client. The master-rules spec (Rule 1) accepts a reflexive/first-party
      // reference on a verified own domain, NOT arbitrary text. So attribute an
      // own-domain quote only when it also carries a first-party cue — a
      // we/our/us or "the company/the group/the bank/..." reference (PRONOUNS_REGEX,
      // the standard self-reference in an issuer's own filing), or a CJK
      // first-party reference for non-English filings where the Latin identity
      // tokens never appear in the body. Shared regulator/aggregator domains
      // (cninfo, sina, hkexnews) are explicitly NOT own-domain and fall through to
      // the stricter trusted-source rules below. Case-study negatives were already
      // excluded above. A passage that names a DIFFERENT entity with no first-party
      // language falls through (attributedToTarget=false) so the entity gate still
      // catches the client/case-study self-attribution pattern.
      if (
        isOwnDomainSource(q.sourceUrl, company) &&
        text.trim().length >= 12 &&
        (PRONOUNS_REGEX.test(text) || CJK_FIRST_PARTY_REGEX.test(text))
      ) {
        return { index, attributedToTarget: true, reason: "Company Own Domain + First-Party" };
      }

      // Rule 1 (brand-aware First-Party Domain Waiver — BUG 1 fix): the quote is
      // hosted on the issuer's OWN brand domain that is NOT the exact DB `domain`
      // — a sibling brand domain (adanienterprises.com for ADANI ENTERPRISES
      // LIMITED, whose DB domain is adani.com) or a subdomain. On such an
      // own-brand host, a passage using first-party language ("we/our/the
      // company", or a CJK first-party reference) is the issuer describing its
      // OWN practice → attribute. Known third-party news/analyst/aggregator hosts
      // are excluded inside isOwnBrandDomainSource (Generic News negative rule),
      // so this never over-attributes a Morningstar/Reuters passage. Case-study
      // negatives were already excluded above. This also ensures the first-party
      // PRONOUNS path triggers for own-brand-domain docs, not only
      // PRIMARY_DOMAINS-trusted ones.
      if (
        isOwnBrandDomainSource(q.sourceUrl, company) &&
        (FIRST_PARTY_POSSESSIVE_REGEX.test(text) || CJK_FIRST_PARTY_REGEX.test(text))
      ) {
        return { index, attributedToTarget: true, reason: "Own-Brand Domain + First-Party (Rule 1)" };
      }

      // Rule: Trusted Source + First-Party framing
      const trusted = isTrustedSource(q.sourceUrl, company);
      if (trusted) {
        if (PRONOUNS_REGEX.test(text)) return { index, attributedToTarget: true, reason: "Trusted Source + First-Party" };
        if (CJK_FIRST_PARTY_REGEX.test(text)) return { index, attributedToTarget: true, reason: "Trusted Source + First-Party (CJK)" };
        // Trusted source whose TITLE names the target (Latin) company = the
        // company's OWN filing/page (e.g. "<Company> 年度报告 (cninfo official)").
        // Its substantive CJK passages are first-party even when the passage body
        // names the company only in Chinese (保利发展控股) — a name absent from the
        // Latin-only DB record, so it never matches identity tokens directly.
        const titleNamesTarget = toks.some(t => t.length >= 3 && (q.source || "").toLowerCase().includes(t));
        if (titleNamesTarget && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{4,}/.test(text)) {
          return { index, attributedToTarget: true, reason: "Trusted Source + Title Names Target (CJK body)" };
        }
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

      // Rule: Industry-Specific Alias is now part of PRONOUNS_REGEX

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

// BUG 5 (advisory, no score change): catch a mislabelled / outdated source
// WITHOUT a network fetch. The source label often asserts a document year
// (e.g. "Annual Report 2021", "2024 10-K"); if the quote body references a LATER
// year (a 20xx that post-dates the label year), the quote almost certainly comes
// from a newer document than the label claims — a label/date mismatch worth an
// auditor's eye. Pure text; triggers only when BOTH a label year and a strictly
// greater in-quote year are present.
function flagSourceLabelMismatch(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "source-label-mismatch" as const, label: "Source label mismatch", severity: "advisory" as const, dismissible: true as const };
  const currentYear = input.window?.currentYear ?? new Date().getUTCFullYear();
  const yearOf = (s: string | undefined): number | null => {
    const years = Array.from((s || "").matchAll(/\b(19\d{2}|20\d{2})\b/g))
      .map((m) => parseInt(m[1], 10))
      .filter((y) => y >= 1990 && y <= currentYear + 1);
    return years.length ? Math.max(...years) : null;
  };
  for (const q of input.quotes || []) {
    if (!nonEmpty(q?.text)) continue;
    const labelYear = yearOf(q.source);
    if (labelYear == null) continue;
    const quoteYear = yearOf(q.text);
    if (quoteYear != null && quoteYear > labelYear) {
      return {
        ...base,
        triggered: true,
        reason: `A supporting quote references ${quoteYear} but its source is labelled ${labelYear} (${(q.source || "").trim()}). The source may be mislabelled or outdated.`,
      };
    }
  }
  return { ...base, triggered: false, reason: "No source-label/quote-year mismatch detected." };
}

// BUG 6 (advisory, no score change): surface when a supporting quote is hosted on
// a KNOWN third-party news/analyst/ratings/aggregator domain rather than on the
// issuer's own disclosure. This never gates on its own (the entity-attribution
// gate already catches genuinely wrong-entity evidence); it is an audit signal
// that the Yes may rest on third-party commentary.
function flagThirdPartyHost(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "evidence-on-third-party-host" as const, label: "Evidence on third-party host", severity: "advisory" as const, dismissible: true as const };
  const hit = (input.quotes || []).find((q) => nonEmpty(q?.text) && isThirdPartyHost(q?.sourceUrl));
  if (hit) {
    let host = "";
    try { host = new URL(hit.sourceUrl as string).hostname.replace(/^www\./, ""); } catch { /* best-effort */ }
    return { ...base, triggered: true, reason: `A supporting quote is hosted on a third-party news/analyst/aggregator domain${host ? ` (${host})` : ""} rather than the issuer's own disclosure.` };
  }
  return { ...base, triggered: false, reason: "No supporting quote is on a known third-party host." };
}

function flagClaimLevelSourceLink(input: EligibilityFlagsInput): EligibilityFlag {
  const base = { id: "claim-level-source-link" as const, label: "Claim-level source link", severity: "advisory" as const, dismissible: true as const };
  const hasLink = (input.quotes || []).some(q => nonEmpty(q?.text) && /^https?:\/\/\S+/i.test((q?.sourceUrl || "").trim()));
  return { ...base, triggered: !hasLink, reason: hasLink ? "Link present." : "No claim-level link found." };
}

export function computeEligibilityFlags(input: EligibilityFlagsInput): EligibilityFlagsResult {
  const makeUntriggered = (reason: string): EligibilityFlagsResult => ({
    flags: (["entity-attribution", "date-window", "planned-vs-live", "author-vs-adopter", "claim-level-source-link", "source-label-mismatch", "evidence-on-third-party-host"] as EligibilityFlagId[]).map(id => ({
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
      flagSourceLabelMismatch(input),
      flagThirdPartyHost(input),
    ];
    return { flags, triggeredCount: flags.filter(f => f.triggered).length, advisoryOnly: true };
  } catch {
    return makeUntriggered("Error.");
  }
}
