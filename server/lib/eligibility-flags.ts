/**
 * eligibility-flags.ts — Refined entity-attribution gate.
 * 
 * Incorporates trusted-source waivers, pronoun matching, cleaned core names,
 * and rationale-quote token alignment.
 */

import { deriveAliases } from "./issuer-resolver.js";
import {
  rc4FilingProvenanceEnabled,
  rc5SubsidiaryDisambiguationEnabled,
  rc6LowValuePageFilterEnabled,
  p2OwnDocBeforeSubsidiaryEnabled,
  p2Rc5EntityListScopedEnabled,
  p2ThirdPartyHostAttributionGateEnabled,
  z3FundEntityDisambiguationEnabled,
  fAdmissionGatePrototypeEnabled,
} from "./scoring-fix-flags.js";

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
  // P2.2 — other entity names in the same workspace company list. When present,
  // RC5 subsidiary disambiguation additionally fires when "target-core + adjacent
  // qualifier" matches one of these distinct listed reporting entities. Optional
  // and lower-cased on use; absent → RC5 keeps its geographic/subsidiary-noun
  // triggers only. Keys on the workspace entity list, never a hardcoded name.
  peerEntities?: string[] | null;
  // Z3 (fund/product entity disambiguation) — a per-company list of NAMED
  // funds/products that are DISTINCT reporting entities from this company (e.g. an
  // asset manager's individual funds whose disclosures are the fund's, not the
  // manager's). When present AND ENTITY_FUND_DISAMBIGUATION is on, a quote whose
  // text names one of these fund/product entities is treated as belonging to that
  // distinct entity, not the manager, and so does not attribute to the target.
  // GENERALISED PLUMBING ONLY: this list is NEVER populated with hardcoded or
  // invented fund names. Absent/empty → a pure no-op (legacy behaviour unchanged).
  // TODO(Z3 data input): feed a real per-company fund/product-name source into
  // this field (the fund-name list does not exist yet) — see DEFERRED note in
  // scoring-fix-flags.ts. Until that source exists, this stays empty in production.
  fundEntities?: string[] | null;
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

/** Primary domains from domain_policies (Source Domains page) and regulator hosts */
const PRIMARY_DOMAINS = new Set([
  "adx.ae", "annualreports.com", "asx.com.au", "bseindia.com", "cninfo.com.cn",
  "companiesmarketcap.com", "corporate-ir.net", "edgar-online.com", "euronext.com",
  "fca.org.uk", "fda.gov", "federalregister.gov", "filingreader.com", "financialfilings.com",
  "gov.uk", "hkex.com.hk", "hkexgroup.com", "hkexnews.hk", "last10k.com",
  "londonstockexchange.com", "marketscreener.com", "nasdaq.com", "nseindia.com",
  "proxyvote.com", "q4cdn.com", "scribd.com", "sec.gov", "sedarplus.ca", "sgx.com",
  "sina.com.cn", "sse.com.cn", "stocktitan.net", "sustainabilityreports.com", "szse.cn",
  "unglobalcompact.org", "filings.xbrl.org", "modernslaveryregister.gov.au",
  "unternehmensregister.de", "handelsregister.de", "registers.esma.europa.eu",
  "esap.europa.eu", "info-financiere.fr", "cnmv.es", "1info.it", "registroimprese.it",
  "afm.nl", "kvk.nl", "bolagsverket.se", "brreg.no", "datacvr.virk.dk", "zefix.ch",
  "core.cro.ie", "edinet-fsa.go.jp", "tdnet.info", "krx.co.kr", "twse.com.tw",
  "sebi.gov.in", "mca.gov.in", "b3.com.br", "cvm.gov.br", "saudiexchange.sa",
  "dfm.ae", "kap.org.tr", "tase.co.il", "jse.co.za", "asic.gov.au", "mziq.com",
  "precisionir.com",
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

// ─── RC4 — filing-class provenance ───────────────────────────────────────────
// A document whose TITLE/URL names a primary / statutory filing or registration
// document (annual / integrated / sustainability / ESG report, 10-K / 20-F,
// Universal Registration Document, proxy, "Form N", business report). This mirrors
// the STANDALONE_DOCTYPE_REGEX family in shared/research-state.ts (document NATURE,
// not subject matter) plus the registration-document vocabulary. By its nature such
// a document is the issuer's own disclosure about itself, so on a first-party host
// (own domain, or a trusted filing repository whose title names the issuer)
// provenance alone establishes first-party attribution — no in-span pronoun needed.
const FILING_DOCTYPE_REGEX =
  /\b(annual\s*report|integrated\s*report|sustainability\s*report|esg\s*report|responsibility\s*report|corporate\s*responsibility|universal\s*registration\s*document|registration\s*document|reference\s*document|business\s*report|10-?k|20-?f|40-?f|6-?k|8-?k|proxy\s*statement|proxy|notice\s*of\s*meeting|form\s*\d|URD)\b/i;

/** True when a quote's source (title) or URL identifies a primary/statutory filing
 *  or registration document (RC4). Keys off document nature only. */
function isFilingClassSource(q: QuoteLike): boolean {
  const title = (q.source || "");
  const url = (q.sourceUrl || "");
  return FILING_DOCTYPE_REGEX.test(title) || FILING_DOCTYPE_REGEX.test(url);
}

// ─── RC5 — subsidiary / affiliate disambiguation ─────────────────────────────
// Geographic qualifiers and subsidiary/affiliate nouns that, when adjacent to the
// target's core name, denote a MORE-SPECIFIC reporting entity than the target
// (e.g. "ING Australia", "Manulife Philippines", "<Parent> subsidiary"). Keys off
// reporting-entity identity structure, not any specific company name.
const GEO_QUALIFIER_WORDS = new Set<string>([
  "australia", "philippines", "indonesia", "malaysia", "singapore", "thailand",
  "vietnam", "india", "china", "japan", "korea", "taiwan", "canada", "mexico",
  "brazil", "argentina", "chile", "colombia", "peru", "germany", "france", "spain",
  "italy", "portugal", "netherlands", "belgium", "poland", "sweden", "norway",
  "denmark", "finland", "ireland", "switzerland", "austria", "greece", "turkey",
  "russia", "ukraine", "romania", "hungary", "czech", "slovakia", "croatia",
  "usa", "america", "uk", "britain", "england", "scotland", "wales",
  "africa", "nigeria", "kenya", "egypt", "morocco", "ghana",
  "asia", "europe", "pacific", "americas", "international", "global", "worldwide",
  "hong", "kong", "macau", "qatar", "dubai", "emirates", "saudi", "israel",
  "zealand", "bangladesh", "pakistan", "srilanka", "lanka", "myanmar", "cambodia",
]);
const SUBSIDIARY_NOUN_REGEX =
  /\b(subsidiary|subsidiaries|affiliate|affiliates|affiliated|unit|units|branch|branches|division|divisions|joint\s*venture|associate)\b/i;

/**
 * RC5 — detect when a passage names a MORE-SPECIFIC reporting entity than the
 * target: the target's core name immediately followed by a distinguishing
 * qualifier (a geographic token, or a subsidiary/affiliate/unit/branch noun) that
 * is NOT part of the target's own legal name. Conservative: the qualifier must be
 * adjacent to the core name. Returns the matched qualifier for logging, else null.
 */
function namesMoreSpecificEntity(text: string, company: CompanyIdentity): string | null {
  const core = cleanCompanyName(company.name || "").toLowerCase().trim();
  if (core.length < 3) return null;
  const lowerText = (text || "").toLowerCase();
  const fullName = (company.name || "").toLowerCase();
  // Candidate core tokens: the cleaned core name's distinctive words (≥3 chars,
  // not generic corporate-form words) plus the first word of the cleaned core.
  const coreWords = core.split(/\s+/).filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const candidates = new Set<string>(coreWords);
  if (coreWords.length > 0) candidates.add(coreWords[0]);
  for (const coreTok of candidates) {
    const esc = coreTok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // core token + one adjacent word.
    const re = new RegExp(`\\b${esc}\\b[\\s'’-]+([a-z\\u00c0-\\u024f]+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lowerText)) !== null) {
      const next = (m[1] || "").toLowerCase();
      if (!next || next.length < 2) continue;
      const isGeo = GEO_QUALIFIER_WORDS.has(next);
      const isSubNoun = SUBSIDIARY_NOUN_REGEX.test(next);
      // P2.2 (additive): when enabled and a workspace peer list is threaded, the
      // "target-core + adjacent qualifier" phrase ALSO fires RC5 when it names a
      // DISTINCT listed reporting entity (e.g. target "Acme Corp", phrase "Acme
      // Capital" is another company in the same workspace list) — catching a
      // genuinely separate listed entity that carries no geographic/subsidiary
      // qualifier. Keys off the workspace entity list, never a hardcoded name, and
      // is purely additive: it never removes the geographic/subsidiary triggers, so
      // it cannot introduce own-doc false rejects beyond those paths.
      let isPeerEntity = false;
      if (
        !isGeo && !isSubNoun &&
        p2Rc5EntityListScopedEnabled() &&
        Array.isArray(company.peerEntities) && company.peerEntities.length > 0
      ) {
        const phrase = `${coreTok} ${next}`;
        isPeerEntity = company.peerEntities.some((p) => {
          const pl = (p || "").toLowerCase().trim();
          if (pl.length < 4) return false;
          if (fullName && (fullName.includes(pl) || pl.includes(fullName))) return false; // not the target itself
          // The distinct peer's name begins with the shared core token and the
          // passage phrase is (a prefix of) that peer name → the passage names the
          // peer, not the target.
          return pl.startsWith(coreTok + " ") && (pl === phrase || pl.startsWith(phrase + " "));
        });
      }
      if (!isGeo && !isSubNoun && !isPeerEntity) continue;
      // Skip when the qualifier is part of the target's own legal name
      // (e.g. "Bank of America" — "america" belongs to the name itself).
      if (fullName.includes(`${coreTok} ${next}`) || fullName.includes(next)) continue;
      return `${coreTok} ${next}`;
    }
  }
  return null;
}

// ─── RC6 — generic low-value-page filter ─────────────────────────────────────
// Non-substantive pages that must never back a verdict, keyed on PAGE NATURE
// (title / URL), not on any specific site. Terms-of-use, cookie/privacy notices,
// login/registration walls, and 404/error/empty pages carry no first-party
// disclosure content, yet a thin corpus can leave them as the only "evidence" (the
// Michelin "Website Terms of Use" citation). This is topic/company/framework
// agnostic.
const LOW_VALUE_PAGE_REGEX =
  /\b(terms\s*(?:of\s*(?:use|service)|&?\s*conditions)|terms\s*&\s*conditions|cookie\s*(?:policy|notice|settings|preferences)|privacy\s*(?:policy|notice|statement)|legal\s*notice|disclaimer|sign\s*in|log\s*in|login|register|create\s*(?:an\s*)?account|page\s*not\s*found|404\s*(?:error|not\s*found)?|error\s*404|access\s*denied|403\s*forbidden|site\s*map|sitemap)\b/i;

/** True when a quote's source title or URL identifies a non-substantive
 *  low-value page that must not back a verdict (RC6). Keys off page nature only. */
export function isLowValuePageSource(title?: string | null, url?: string | null): boolean {
  const t = title || "";
  const u = url || "";
  if (LOW_VALUE_PAGE_REGEX.test(t)) return true;
  // URL path hints (hyphen/slug forms): /terms-of-use, /cookie-policy, /privacy, /login.
  const uLow = u.toLowerCase();
  if (/\/(terms(?:-of-(?:use|service))?|terms-and-conditions|cookie-policy|cookies?|privacy(?:-policy)?|legal|disclaimer|login|signin|sign-in|register|404|not-found|sitemap)(?:[/?#.]|$)/.test(uLow)) {
    return true;
  }
  return false;
}

// P2.1 — own-document provenance acceptance, extracted so it can run EITHER
// before the RC5 subsidiary reject (own-doc-first, the regression fix) or in its
// legacy position after the identity-token match (flag off → exact original
// ordering). Returns an attribution ({attributedToTarget:true, reason}) when the
// quote is established as the issuer's own disclosure by provenance, else null.
// Pure: keys only off document class, host (own domain / own brand), and first-
// party language — never a hardcoded company name. Case-study negatives, the
// low-value-page filter and (when enabled) the third-party-host gate are applied
// by the caller BEFORE this runs.
function attributeOwnDocument(
  q: QuoteLike,
  text: string,
  company: CompanyIdentity,
  toks: string[],
): { attributedToTarget: true; reason: string } | null {
  // Rule 1 (First-Party Domain): any document on the company's own domain is
  // attributed to the company automatically (per user steer 2026-11). Hosting
  // on own domain is the strongest possible identity signal.
  if (isOwnDomainSource(q.sourceUrl, company)) {
    return { attributedToTarget: true, reason: "Company Own Domain" };
  }

  // RC4 (Filing-class provenance): a verified primary/statutory filing or
  // registration document is, by its nature, the issuer's own disclosure about
  // itself. On a trusted host, we attribute it even without an in-span pronoun
  // or the name appearing in the title (per user steer 2026-11), trusting that
  // the retrieval process already confirmed the entity for the document.
  if (rc4FilingProvenanceEnabled() && isFilingClassSource(q) && isTrustedSource(q.sourceUrl, company)) {
    return { attributedToTarget: true, reason: "Primary filing in trusted repository (RC4)" };
  }

  // Rule 1 (brand-aware First-Party Domain Waiver — BUG 1 fix): the quote is
  // hosted on the issuer's OWN brand domain that is NOT the exact DB `domain`
  // — a sibling brand domain or a subdomain. On such an own-brand host, a
  // passage using first-party language ("we/our/ours", or a CJK first-party
  // reference) is the issuer describing its OWN practice → attribute. Known
  // third-party news/analyst/aggregator hosts are excluded inside
  // isOwnBrandDomainSource (Generic News negative rule), so this never
  // over-attributes a Morningstar/Reuters passage.
  if (
    isOwnBrandDomainSource(q.sourceUrl, company) &&
    (FIRST_PARTY_POSSESSIVE_REGEX.test(text) || CJK_FIRST_PARTY_REGEX.test(text))
  ) {
    return { attributedToTarget: true, reason: "Own-Brand Domain + First-Party (Rule 1)" };
  }

  return null;
}

/**
 * Z3 — fund/product entity disambiguation (pure, testable).
 *
 * Returns the matched fund/product name when the quote text names one of the
 * company's declared DISTINCT fund/product entities (company.fundEntities) that is
 * not the company itself, else null. GENERALISED: it reads only the per-company
 * alias list — it hardcodes and invents NO fund names, and with no fundEntities it
 * always returns null (a pure no-op). A match means the passage is about the fund,
 * a distinct reporting entity, not the manager.
 */
export function namesDistinctFundEntity(
  text: string,
  company: CompanyIdentity,
): string | null {
  const funds = company.fundEntities;
  if (!Array.isArray(funds) || funds.length === 0) return null;
  if (!nonEmpty(text)) return null;
  const lowerText = text.toLowerCase();
  const fullName = (company.name || "").toLowerCase().trim();
  for (const f of funds) {
    const fl = (f || "").toLowerCase().trim();
    if (fl.length < 4) continue; // too generic to disambiguate safely
    // Never treat the company's own name as a distinct fund entity.
    if (fullName && (fl === fullName || fl.includes(fullName) || fullName.includes(fl))) continue;
    if (lowerText.includes(fl)) return f;
  }
  return null;
}

export function reviewQuoteAttribution(
  quotes: QuoteLike[] | null | undefined,
  company: CompanyIdentity,
  evidenceSummary?: string | null
): Array<{ index: number; attributedToTarget: boolean; reason?: string }> {
  try {
    const toks = identityTokens(company);
    const rationaleTokens = getDistinctiveTokens(evidenceSummary);
    const ownDocFirst = p2OwnDocBeforeSubsidiaryEnabled();
    const thirdPartyGate = p2ThirdPartyHostAttributionGateEnabled();
    // F (PROTOTYPE) — admission-gate loosening paired with attribution tightening.
    // Default OFF (ADMISSION_GATE_PROTOTYPE), so when unset every path below is
    // byte-for-byte as today.
    const fPrototype = fAdmissionGatePrototypeEnabled();

    return (quotes || []).map((q, index) => {
      if (!q || !nonEmpty(q.text)) return { index, attributedToTarget: false };
      
      const text = q.text;
      const lowerText = text.toLowerCase();

      // RC6 (Negative rule): a non-substantive low-value page (terms-of-use,
      // cookie/privacy, login wall, 404/error) carries no disclosure and must never
      // back a verdict, regardless of host. Checked first so a thin corpus cannot
      // let such a page support a score.
      if (rc6LowValuePageFilterEnabled() && isLowValuePageSource(q.source, q.sourceUrl)) {
        return { index, attributedToTarget: false, reason: "Low-value page (terms/cookie/login/error) — not substantive evidence" };
      }

      // Safeguard: Case Study Penalty (Negative Rule)
      // F (LOOSEN): when the prototype flag is ON, the blunt case-study
      // pre-rejection no longer gates a quote out before attribution is even
      // considered — admission is loosened so the quote reaches the (now
      // stricter) attribution paths below. When the flag is OFF this rejection
      // runs exactly as today.
      if (!fPrototype && CASE_STUDY_NEGATIVES.test(text)) {
        // If a very strong identity match is present, we might still trust it, 
        // but the Master List says "Disqualify if...".
        // We check if the company name appears in a way that suggests OWN activity 
        // despite the case study keywords (e.g. "We partnered with X to...").
        // But Rule 1-8 are primarily about RECOVERING false negatives.
        return { index, attributedToTarget: false, reason: "Case Study Pattern (Negative Rule)" };
      }

      // P2.4 (Third-party host attribution gate): a quote whose host is a known
      // third-party analyst/news/ratings domain (morningstar, reuters, …) is NOT
      // the issuer's own disclosure, EVEN WHEN it mentions the target — so a
      // Morningstar report about a subsidiary cannot establish first-party
      // attribution via the identity-token or rationale paths below. Keys on host
      // nature only; the issuer's own domain and trusted filing repositories
      // (sec.gov, q4cdn, …) are never third-party hosts, so legitimate filings are
      // unaffected. Runs before every acceptance path.
      if (thirdPartyGate && isThirdPartyHost(q.sourceUrl)) {
        return { index, attributedToTarget: false, reason: "Third-party analyst/news/ratings host — not first-party disclosure" };
      }

      // P2.1 — own-document provenance wins. When enabled, the own-domain /
      // own-filing / own-brand provenance acceptance runs BEFORE the RC5 subsidiary
      // reject, so a quote lifted from the issuer's own domain or a verified
      // statutory filing is never knocked out by a third-person regional phrase
      // (fixes MAA / ING / Smiths / Gerdau own-doc false rejects). RC5 then only
      // applies to quotes NOT already established as own-document.
      if (ownDocFirst) {
        const own = attributeOwnDocument(q, text, company, toks);
        if (own) return { index, ...own };
      }

      // RC5 (Negative precision rule): the passage names a MORE-SPECIFIC reporting
      // entity than the target (target core name + adjacent geographic/subsidiary
      // qualifier, e.g. "ING Australia", "Manulife Philippines"). Runs BEFORE the
      // bare identity-token acceptance so a parent token inside a subsidiary's name
      // does not wrongly attribute subsidiary evidence to the parent. Exception:
      // when the passage ALSO establishes the target itself as the actor
      // (first-party we/our/us), the parent is genuinely speaking about its own
      // group, so attribution is not blocked.
      if (rc5SubsidiaryDisambiguationEnabled()) {
        const specific = namesMoreSpecificEntity(text, company);
        if (specific && !FIRST_PARTY_POSSESSIVE_REGEX.test(text)) {
          return {
            index,
            attributedToTarget: false,
            reason: `Names a distinct subsidiary/affiliate reporting entity (${specific})`,
          };
        }
      }

      // Z3 (fund/product entity disambiguation): when a per-company fund/product
      // alias list is threaded (company.fundEntities) and the quote names one of
      // those DISTINCT reporting entities, the passage is the fund's disclosure, not
      // the manager's, so it does not attribute to the target. Runs before the bare
      // identity-token match so a manager token inside a fund name does not wrongly
      // attribute fund evidence to the manager. GENERALISED PLUMBING: no-op unless
      // real fund-name data is present (none is in production yet — see TODO on
      // CompanyIdentity.fundEntities). Exception preserved: an explicit first-party
      // possessive keeps attribution (the manager genuinely speaking for itself).
      if (z3FundEntityDisambiguationEnabled()) {
        const fund = namesDistinctFundEntity(text, company);
        if (fund && !FIRST_PARTY_POSSESSIVE_REGEX.test(text)) {
          return {
            index,
            attributedToTarget: false,
            reason: `Names a distinct fund/product reporting entity (${fund})`,
          };
        }
      }

      // Rule: Direct identity token match
      if (toks.some(t => lowerText.includes(t))) {
        // F (TIGHTEN): when the prototype flag is ON, a bare identity-token
        // (name-mention) alone no longer attributes the quote to the target. A
        // stronger co-signal is additionally required: own-document provenance
        // (own-domain / own-filing / own-brand, via attributeOwnDocument) OR a
        // first-party possessive construction ("we/our/us…"). This is the
        // tightening paired with the admission loosening above. When the flag is
        // OFF, the bare name-mention attributes exactly as today.
        if (fPrototype) {
          const own = attributeOwnDocument(q, text, company, toks);
          if (own) return { index, ...own };
          if (FIRST_PARTY_POSSESSIVE_REGEX.test(text)) {
            return { index, attributedToTarget: true, reason: "Identity token + first-party possessive (F prototype)" };
          }
          return { index, attributedToTarget: false, reason: "Bare name-mention without own-doc provenance or first-party possessive (F prototype)" };
        }
        return { index, attributedToTarget: true };
      }

      // P2.1 (legacy ordering): when own-doc-first is DISABLED, the own-domain /
      // own-filing / own-brand provenance acceptance runs here, after the
      // identity-token match (the pre-P2.1 behaviour), so toggling the flag off
      // restores the exact original ordering.
      if (!ownDocFirst) {
        const own = attributeOwnDocument(q, text, company, toks);
        if (own) return { index, ...own };
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
