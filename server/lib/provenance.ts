// U17 — Source-provenance classifier.
//
// Determines whether a document is "issuer" (authored or filed by the target
// company) or "third_party" (about the target company but authored elsewhere).
//
// The pre-U17 classifier in pipeline.ts:295 uses hostname-only comparison
// against company.domain, which produced two systematic misclassifications:
//
//   (a) sec.gov EDGAR filings of the target company were tagged third_party
//       because the URL host is sec.gov, not e.g. newmont.com. This
//       under-scored issuers with rich SEC disclosure.
//
//   (b) Third-party PDFs that mention the target company as a case study
//       (e.g. Proteus Partners biodiversity training PDFs) were retained in
//       the corpus and their bullets quoted as if they were the issuer's own
//       disclosure. This produced false-positive Yes verdicts.
//
// R2 (2026-09-04) extended the classifier to a THIRD host class:
//   (c) Investor-relations CDNs and hosted-IR platforms (q4cdn.com, mziq.com,
//       precisionir.com, cloudfront-based IR distributions). These are shared
//       by many issuers but always encode the issuer's identity in the URL
//       path or filename. A Q4 Inc URL like `s24.q4cdn.com/382246808/files/...`
//       encodes the SEC CIK; an MZiQ URL like `api.mziq.com/mzfilemanager/v2/d/
//       c8182463-4b7e-408c-9d0f-42797662435e/...` carries the issuer's tenant
//       ID. Both are first-party equivalents. The pre-R2 classifier tagged
//       these as third_party because their hostname doesn't match the issuer's
//       corporate domain, which caused systematic recall loss on US-listed
//       (Q4 Inc) and Brazilian (MZiQ) issuers.
//
// Under the R2 rule set, per user steer (2026-09-04):
//   - Title + URL path is the PRIMARY signal for issuer identity.
//   - Content (if available) is the SECONDARY signal, used to corroborate
//     or as fallback when title/URL yields no signal.
//   - CDN + IR-platform hosts are treated as a distinct "ir_platform" class
//     that resolves to `issuer` when identity is confirmed and `third_party`
//     when it is not.
//
// The classifier here:
//   1. Recognises regulator/registry hosting patterns (SEC EDGAR, ASIC,
//      HKEX, SEDAR+, Australian Modern Slavery Register, LSE RNS, etc.).
//   2. Recognises IR-platform / hosted-IR CDN patterns (Q4 Inc, MZiQ, etc.).
//   3. For those hosts, applies an identity check that PREFERS title + URL
//      path signals over content.
//   4. For non-regulator, non-IR-platform hosts, retains the existing
//      hostname match against company.domain (and its related_domains).
//   5. Everything else is third_party.
//
// This module has no external dependencies beyond string parsing so it can
// be called from pipeline.ts (discovery-time tagging) and from analyzer.ts
// (verdict-time provenance gate).

export type ProvenanceClass = "issuer" | "third_party";

export interface ProvenanceInput {
  url: string;
  title?: string | null;
  content?: string | null; // may be a snippet; the first ~4KB is enough
  companyDomain?: string | null;
  relatedDomains?: string[] | null;
  companyName?: string | null;
  companyTicker?: string | null;
  companyAliases?: string[] | null; // distinctive tokens from deriveAliases()
  // R2 (2026-09-04): stable identifiers used to verify IR-platform / regulator
  // URLs whose paths encode issuer identity. All optional; classifier falls
  // back to name/ticker/alias identity when these are absent.
  companyIsin?: string | null;
  companySecCik?: string | null; // SEC EDGAR CIK, unpadded string of digits
  // R5c (2026-09-04): first-touch IR-platform tenant propagation. Callers
  // maintain a per-batch mutable map keyed by `<platform-label>:<tenant-id>`
  // with values that describe what confirmed the tenant. When the classifier
  // confirms a tenant via title/URL/content identity, it INSERTS an entry
  // into this map; subsequent sibling URLs on the same tenant match via a
  // cheap map lookup rather than needing their own identity signal.
  //
  // This closes the Newmont s24.q4cdn.com/382246808 recall gap identified in
  // the iter-14 investigation: R2 correctly recognised q4cdn.com as an IR
  // platform, but the Q4 tenant identifier (382246808) is a Q4-internal id
  // rather than a SEC CIK (Newmont's real CIK is 1164727), so the pre-R5c
  // `irPlatformPathIdentityMatch` returned false and the URL fell through to
  // third_party. With R5c, the FIRST Newmont Q4 URL that ALSO has a title
  // identity match (e.g. "Newmont 2024 Sustainability Report") writes
  // `q4:382246808 -> Newmont` into the map, and every later Q4 URL under
  // that tenant matches for free.
  //
  // The map is optional so callers that don't yet maintain one (tests, ad
  // hoc lookups) still get the pre-R5c behaviour. Stateless callers pass
  // undefined; batch-context callers pass a shared Map.
  knownIrTenants?: Map<string, IrTenantBinding>;
}

export interface IrTenantBinding {
  companyName: string; // canonical company name at the moment of binding
  companyIdentifier?: string | null; // any stable identifier available at binding time
  confirmedBy: "title" | "url-path" | "content"; // which identity tier confirmed the binding
}

export interface ProvenanceResult {
  provenance: ProvenanceClass;
  reason: string; // one-line explanation for logging / audit
  regulatorHost: string | null; // if the URL lives on a regulator host, its label
  irPlatformHost?: string | null; // if the URL lives on an IR-platform CDN, its label
  identitySignal?: "title" | "url-path" | "content" | "cik-match" | "tenant-match" | "none";
  // R5c: when this classifier call added a new (platform, tenant) binding
  // to the shared map, we surface it in the result so the caller can log
  // the propagation for audit. Undefined when no binding was written.
  boundIrTenant?: { platform: string; tenantId: string; confirmedBy: "title" | "url-path" | "content" };
}

// ─── Regulator / registry host patterns ─────────────────────────────────────

// Mirrors the STATUTORY_REGISTRY_HOSTS + REGULATORY_PRIMARY_HOST list in
// ranking.ts. Kept here as a self-contained mapping so the classifier does
// not import ranking.ts (which pulls the full issuer-profile chain).
//
// Keys are host suffixes; values are human-readable labels used only for the
// diagnostic reason string.
const REGULATOR_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)sec\.gov$/i, "SEC EDGAR"],
  [/(^|\.)sedarplus\.ca$/i, "SEDAR+"],
  [/(^|\.)sedar\.com$/i, "SEDAR"],
  [/(^|\.)asx\.com\.au$/i, "ASX"],
  [/(^|\.)hkexnews\.hk$/i, "HKEX news"],
  [/(^|\.)hkex\.com\.hk$/i, "HKEX"],
  [/(^|\.)modernslaveryregister\.gov\.au$/i, "Australian Modern Slavery Register"],
  [/(^|\.)find-and-update\.company-information\.service\.gov\.uk$/i, "UK Companies House"],
  [/(^|\.)data\.fca\.org\.uk$/i, "UK FCA"],
  [/(^|\.)fca\.org\.uk$/i, "UK FCA"],
  [/(^|\.)unternehmensregister\.de$/i, "German Unternehmensregister"],
  [/(^|\.)handelsregister\.de$/i, "German Handelsregister"],
  [/(^|\.)registers\.esma\.europa\.eu$/i, "ESMA registers"],
  [/(^|\.)esap\.europa\.eu$/i, "ESAP"],
  [/(^|\.)info-financiere\.fr$/i, "AMF (France)"],
  [/(^|\.)cnmv\.es$/i, "CNMV (Spain)"],
  [/(^|\.)1info\.it$/i, "1Info (Italy)"],
  [/(^|\.)registroimprese\.it$/i, "Registro Imprese"],
  [/(^|\.)afm\.nl$/i, "AFM (Netherlands)"],
  [/(^|\.)kvk\.nl$/i, "KvK (Netherlands)"],
  [/(^|\.)bolagsverket\.se$/i, "Bolagsverket"],
  [/(^|\.)brreg\.no$/i, "Brønnøysundregistrene"],
  [/(^|\.)datacvr\.virk\.dk$/i, "CVR (Denmark)"],
  [/(^|\.)zefix\.ch$/i, "Zefix (Switzerland)"],
  [/(^|\.)core\.cro\.ie$/i, "CRO (Ireland)"],
  [/(^|\.)disclosure2\.edinet-fsa\.go\.jp$/i, "EDINET (Japan)"],
  [/(^|\.)release\.tdnet\.info$/i, "TDnet (Japan)"],
  [/(^|\.)kind\.krx\.co\.kr$/i, "KRX (Korea)"],
  [/(^|\.)mops\.twse\.com\.tw$/i, "TWSE MOPS"],
  [/(^|\.)sgx\.com$/i, "SGX"],
  [/(^|\.)bseindia\.com$/i, "BSE India"],
  [/(^|\.)nseindia\.com$/i, "NSE India"],
  [/(^|\.)sebi\.gov\.in$/i, "SEBI"],
  [/(^|\.)cninfo\.com\.cn$/i, "CNINFO"],
  [/(^|\.)sse\.com\.cn$/i, "SSE"],
  [/(^|\.)szse\.cn$/i, "SZSE"],
  [/(^|\.)b3\.com\.br$/i, "B3 (Brazil)"],
  [/(^|\.)rad\.cvm\.gov\.br$/i, "CVM (Brazil)"],
  [/(^|\.)saudiexchange\.sa$/i, "Saudi Exchange"],
  [/(^|\.)adx\.ae$/i, "ADX"],
  [/(^|\.)dfm\.ae$/i, "DFM"],
  [/(^|\.)kap\.org\.tr$/i, "KAP (Turkey)"],
  [/(^|\.)maya\.tase\.co\.il$/i, "TASE (Israel)"],
  [/(^|\.)clientportal\.jse\.co\.za$/i, "JSE (South Africa)"],
  [/(^|\.)mca\.gov\.in$/i, "MCA (India)"],
  [/(^|\.)connectonline\.asic\.gov\.au$/i, "ASIC (Australia)"],
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function matchRegulatorHost(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [re, label] of REGULATOR_HOSTS) {
    if (re.test(host)) return label;
  }
  return null;
}

// ─── IR-platform / hosted-IR CDN patterns (R2) ───────────────────────────────
//
// These are shared platforms that host issuer-authored documents (annual
// reports, sustainability reports, proxy statements, factsheets). Each
// platform encodes the issuer's identity in the URL path so we can attribute
// a given URL to the correct issuer even though the hostname is generic.
//
// Each entry: hostname pattern → human label + optional path extractor. The
// path extractor returns a stable identifier we can compare against the
// company's known identifiers (SEC CIK, ISIN, ticker) when available.
//
// Coverage is intentionally conservative — only well-known IR platforms with
// stable path conventions are listed here. Company-owned CDNs (a company's
// own `assets.<company>.com` or `media.<company>.com`) are matched by the
// standard domain rule (Rule 1) via related_domains, not here.
export interface IrPlatformSpec {
  hostRegex: RegExp;
  label: string;
  // Extract an issuer identifier from the URL path/subdomain, if the platform
  // encodes one in a predictable way. Return null if this URL doesn't carry
  // one (e.g. a landing page or a shared marketing asset).
  //
  // R5c (2026-09-04): expanded identifier kinds to distinguish Q4's tenant
  // ID (an internal Q4 integer that identifies a Q4 customer) from a SEC
  // CIK. Prior to R5c the Q4 rule returned `kind: "cik"` for Q4 tenant IDs,
  // which caused a false mismatch when the tenant ID happened not to equal
  // the company's actual SEC CIK (e.g. Newmont: Q4 tenant=382246808, real
  // CIK=1164727). Q4 tenant IDs are now labeled `q4_tenant_id` and are only
  // trusted when the tenant appears in `knownIrTenants` (populated by a
  // prior title/URL/content identity match).
  extractIdentifier: (url: string) => { kind: "cik" | "q4_tenant_id" | "tenant" | "path-token"; value: string } | null;
}

// Q4 Inc — hosts investor relations for hundreds of US-listed issuers on
// subdomains like `s{n}.q4cdn.com/{tenant-id}/files/...`. The digit run in
// the path is a Q4-internal tenant ID (verified across cohort: Newmont
// tenant=382246808 vs SEC CIK=1164727; Corning tenant=24741 whose CIK is
// 24741 — illustrating that a coincidental match is unreliable evidence).
//
// R5c (2026-09-04): the extractor previously labeled this identifier as
// `kind: "cik"`, which caused mismatches whenever the Q4 tenant ID differed
// from the SEC CIK (the common case). The identifier is now labeled
// `q4_tenant_id`. Downstream identity is established via one of:
//   (a) three-tier identity check (title/URL/content) on this URL; or
//   (b) `knownIrTenants` cache hit from a prior URL that established (a).
const Q4_CDN_HOSTS: IrPlatformSpec = {
  hostRegex: /(^|\.)q4cdn\.com$/i,
  label: "Q4 Inc IR CDN",
  extractIdentifier: (url: string) => {
    const path = pathOf(url);
    // Path form: /<tenant-digits>/files/...  OR  /<tenant-digits>/download/...
    // Tenant IDs are 1-10 digits historically; Q4 stores the shortest unique
    // form. Match 4-10 digits at the first path segment.
    const m = path.match(/^\/(\d{4,10})(?:\/|$)/);
    if (!m) return null;
    return { kind: "q4_tenant_id", value: m[1] };
  },
};

// MZiQ — Brazilian IR platform. Path form:
//   api.mziq.com/mzfilemanager/v2/d/<tenant-uuid>/<file-uuid>?origin=<n>
// Or:
//   ri.<company>.com.br (usually cnamed to mziq.com; matched by domain rule)
const MZIQ_CDN: IrPlatformSpec = {
  hostRegex: /(^|\.)mziq\.com$/i,
  label: "MZiQ IR platform",
  extractIdentifier: (url: string) => {
    const path = pathOf(url);
    // Match the tenant UUID as the first UUID-shaped segment of the path.
    const m = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (!m) return null;
    return { kind: "tenant", value: m[1] };
  },
};

// PrecisionIR — another shared IR CDN used by non-US issuers.
const PRECISION_IR: IrPlatformSpec = {
  hostRegex: /(^|\.)precisionir\.com$/i,
  label: "PrecisionIR",
  extractIdentifier: (url: string) => {
    // Precision IR URLs typically include a ticker or ISIN as a path segment.
    // Return the first alphanumeric token that looks like a ticker or ISIN.
    const path = pathOf(url);
    const m = path.match(/\/([A-Za-z]{2}[A-Za-z0-9]{9}[0-9]|[A-Za-z]{1,6})(?:\/|$)/);
    if (!m) return null;
    return { kind: "path-token", value: m[1] };
  },
};

// Q4 legacy "corporate-solutions" URLs
const Q4_CORPORATE: IrPlatformSpec = {
  hostRegex: /(^|\.)q4inc\.com$/i,
  label: "Q4 Inc corporate",
  extractIdentifier: () => null,
};

// s3.amazonaws.com / cloudfront.net are too generic to trust on hostname
// alone; a company-owned CloudFront distribution should be listed in that
// company's `related_domains`. Do NOT add these to the IR platform list.

const IR_PLATFORMS: IrPlatformSpec[] = [
  Q4_CDN_HOSTS,
  MZIQ_CDN,
  PRECISION_IR,
  Q4_CORPORATE,
];

function matchIrPlatform(url: string): { spec: IrPlatformSpec; label: string } | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const spec of IR_PLATFORMS) {
    if (spec.hostRegex.test(host)) return { spec, label: spec.label };
  }
  return null;
}

// ─── Identity heuristics ────────────────────────────────────────────────────

// Normalise a string for substring search: lowercase, collapse whitespace,
// strip a handful of punctuation that varies across HTML/PDF extraction.
function normalise(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[\u00a0\u2007\u202f]/g, " ") // various non-breaking spaces
    .replace(/[’'`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[\s\r\n\t]+/g, " ")
    .trim();
}

// Distinctive tokens from a company name — same "distinctive words" idea as
// issuer-profile.deriveAliases but simpler and generic-safe. We only accept
// tokens ≥ 4 chars that aren't generic corporate qualifiers, because a match
// on "group" or "bank" would fire on almost every filing.
const GENERIC_TOKENS = new Set([
  "the", "and", "for", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "incorporated", "ltd", "limited", "llc", "plc",
  "international", "global", "worldwide", "industries", "industrial",
  "enterprise", "enterprises", "technologies", "technology", "systems",
  "solutions", "services", "products", "bank", "banking", "capital",
  "partners", "resources", "materials", "energy", "power", "motors",
  "financial", "pharmaceutical", "pharmaceuticals", "chemical", "chemicals",
  "insurance", "asset", "management", "trust", "australia", "america",
  "american", "national", "japan", "china", "korea", "india", "canada",
  "canadian", "british", "german", "french",
  // R2: extend generic list. These words appear in many company names but
  // are not by themselves identifying enough to justify a hostname match.
  "general", "electric", "electronics", "foods", "food", "beverage", "beverages",
  "health", "healthcare", "medical", "gold", "silver", "mining", "metals",
  "platinum", "petroleum", "petrochemicals", "telecom", "telecommunications",
  "retail", "stores", "consumer", "cosmetics", "pharma", "biotech",
]);

function distinctiveNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return normalise(name)
    .replace(/[\/\\,.'()&]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !GENERIC_TOKENS.has(w));
}

// Identity match against a single text field (title, URL path, or content).
// Applies the same ticker / alias / name-token rules as documentReferencesIssuer
// but on ONE field so the caller can control which signal fires and record
// which one it was. Returns the specific matcher label for diagnostics.
//
// The occurrence thresholds are calibrated for the input length:
//   • Titles (typically < 200 chars) fire on 1 occurrence — titles are almost
//     never long enough to spuriously match twice.
//   • URL paths (typically < 200 chars) fire on 1 occurrence for the same reason.
//   • Content (up to 8KB) fires on 2 occurrences to avoid case-study-footnote
//     false positives.
function identityMatch(
  input: ProvenanceInput,
  text: string,
  minOccurrences: number,
): { matched: boolean; matchedOn: string | null } {
  if (!text) return { matched: false, matchedOn: null };
  const nameTokens = distinctiveNameTokens(input.companyName);
  const nameTokenSet = new Set(nameTokens);
  const aliases = (input.companyAliases || [])
    .map(a => normalise(a))
    .filter(a => a.length >= 3);
  const ticker = normalise(input.companyTicker);

  // Ticker: word-bounded match. In a URL path or title, ONE occurrence is
  // enough; in body content we require the caller-supplied threshold.
  if (ticker && ticker.length >= 2) {
    const re = new RegExp(`(^|[^a-z0-9])${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "gi");
    const matches = text.match(re) || [];
    if (matches.length >= 1) {
      // Single occurrence of a ticker in a title/URL is a strong signal; single
      // occurrence in body content is weak (case studies, comparison tables).
      // Callers pass minOccurrences=1 for title/URL, 2 for body.
      if (matches.length >= minOccurrences || minOccurrences === 1) {
        return { matched: true, matchedOn: `ticker:${input.companyTicker}` };
      }
    }
  }

  // Alias whole-string match. Multi-word aliases are strong signals; single-word
  // aliases that duplicate the sole distinctive name token defer to the name-token
  // occurrence rule below.
  for (const a of aliases) {
    if (a.length < 3) continue;
    const isMultiWord = /\s/.test(a);
    const isSoleDistinctiveToken = nameTokens.length === 1 && nameTokenSet.has(a);
    if (!isMultiWord && isSoleDistinctiveToken) continue;
    if (text.includes(a)) return { matched: true, matchedOn: `alias:${a}` };
  }

  // Distinctive name-token match.
  if (nameTokens.length >= 2) {
    const hits = nameTokens.filter(t => text.includes(t));
    if (hits.length >= 2) return { matched: true, matchedOn: `name-tokens:${hits.slice(0,2).join(",")}` };
    // Fallback: at least one name-token in a title/URL is a match under
    // low-threshold mode (minOccurrences=1). Body content still requires 2.
    if (hits.length >= 1 && minOccurrences === 1) {
      return { matched: true, matchedOn: `name-token:${hits[0]}` };
    }
  } else if (nameTokens.length === 1) {
    const t = nameTokens[0];
    let count = 0;
    let idx = 0;
    while (count < minOccurrences) {
      const found = text.indexOf(t, idx);
      if (found < 0) break;
      count++;
      idx = found + t.length;
    }
    if (count >= minOccurrences) {
      return { matched: true, matchedOn: minOccurrences === 1 ? `name-token:${t}` : `name-token:${t}(x2)` };
    }
  }

  return { matched: false, matchedOn: null };
}

// True if the target company can be identified in the document based on its
// name tokens, ticker, or provided aliases appearing in title+content head.
// This is the "filer identity match" check for regulator-hosted docs.
//
// Preserved for backwards compatibility with the pre-R2 API. New code should
// prefer identityMatch() with an explicit occurrence threshold.
function documentReferencesIssuer(
  input: ProvenanceInput,
  content: string
): { matched: boolean; matchedOn: string | null } {
  return identityMatch(input, content, 2);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify a document's provenance relative to a target company.
 *
 * Rules (in order):
 *   1. If hostname matches company.domain or any related_domain → issuer.
 *   2. If hostname is a known IR-platform / hosted-IR CDN (Q4 Inc, MZiQ,
 *      PrecisionIR) AND the URL path encodes the issuer's identifier
 *      (CIK for Q4, tenant UUID we've seen before), OR the title / URL
 *      path / content confirms issuer identity → issuer.
 *      (Title + URL are checked FIRST per the R2 title-primary rule.)
 *   3. If hostname is a known regulator/registry host, apply the same
 *      title-primary → URL-path → content identity check. If issuer
 *      identified → issuer, otherwise → third_party.
 *   4. Otherwise → third_party.
 *
 * The R2 title-primary rule: for regulator and IR-platform hosts, the
 * identity check runs in three tiers, and the first positive tier wins:
 *   a. Title — fires on a single occurrence of ticker/alias/name-token.
 *   b. URL path — fires on a single occurrence (or exact CIK/tenant match).
 *   c. Content — fires on 2 occurrences to guard against case-study reuse.
 * The rationale is that titles are curated by the platform to identify the
 * filer, so they are the most reliable single-signal source. Content is
 * corroborative but weakest because case-study PDFs often mention the target
 * company by name without being authored by them.
 */
export function classifyProvenance(input: ProvenanceInput): ProvenanceResult {
  const host = hostOf(input.url);

  // Rule 1: hostname match on primary or related domain.
  const primaryDomain = (input.companyDomain || "").replace(/^www\./i, "").toLowerCase();
  const relatedDomains = (input.relatedDomains || [])
    .map(d => (d || "").replace(/^www\./i, "").toLowerCase())
    .filter(Boolean);
  const allIssuerDomains = [primaryDomain, ...relatedDomains].filter(Boolean);
  if (host) {
    for (const d of allIssuerDomains) {
      if (host === d || host.endsWith("." + d)) {
        return {
          provenance: "issuer",
          reason: `hostname matches company domain (${d})`,
          regulatorHost: null,
          irPlatformHost: null,
          identitySignal: "url-path",
        };
      }
    }
  }

  // Rule 1b (R2): brand-token-in-hostname fallback. Catches subsidiary and
  // regional-brand sites that weren't captured in related_domains but carry
  // the parent's distinctive brand token in the host label (e.g.
  // unilevernepal.com, unileverconsumercarebd.com, santandermedia.com).
  //
  // Only fires when:
  //  - the company has 1 or 2 distinctive brand tokens (companies with 3+
  //    distinctive tokens are typically compound names where any single token
  //    is not identifying — e.g. "American Water Works"), AND
  //  - at least one such token has >= 5 chars (short tokens like "nike" or
  //    "bp" would over-fire), AND
  //  - that token appears word-bounded in the hostname's registrable-domain
  //    segments (a segment either equals the token, starts with it, or
  //    ends with it — caught by segments split on '.', '-', '_').
  //
  // This preserves the pre-R2 permissive behaviour on regional subsidiaries
  // without accepting arbitrary third-party mentions. The alternative — the
  // old pre-U17 fuzzy hostname-in-hostname check — accepted too much (e.g.
  // any host containing the string "kering" including news aggregators);
  // the word-bounded check is stricter but still catches genuine subsidiaries.
  if (host) {
    const nameTokens = distinctiveNameTokens(input.companyName);
    const brandCandidates = nameTokens.filter(t => t.length >= 5);
    if (brandCandidates.length >= 1 && nameTokens.length <= 2) {
      const registrable = host.replace(/^www\./i, "");
      const segments = registrable.split(/[.\-_]/);
      for (const token of brandCandidates) {
        if (segments.some(seg => seg === token || seg.startsWith(token) || seg.endsWith(token))) {
          return {
            provenance: "issuer",
            reason: `brand-token "${token}" in hostname segment (subsidiary/regional site)`,
            regulatorHost: null,
            irPlatformHost: null,
            identitySignal: "url-path",
          };
        }
      }
    }
  }

  // Rule 2: IR-platform / hosted-IR CDN. Title-primary identity check.
  const irPlatform = matchIrPlatform(input.url);
  if (irPlatform) {
    // R5c: check the propagated-tenant cache FIRST. If a prior URL on the
    // same IR platform has been confirmed for this issuer via title/URL/
    // content match, this URL is accepted for free provided its extracted
    // tenant identifier matches the cached one. This closes the sibling-URL
    // coverage gap: e.g. once we've seen `s24.q4cdn.com/382246808/…/
    // Newmont-2024-Sustainability-report-1.pdf` (title match), we accept
    // every other `s24.q4cdn.com/382246808/…` URL as Newmont without
    // requiring each to re-establish identity.
    if (input.knownIrTenants && input.knownIrTenants.size > 0) {
      const extracted = irPlatform.spec.extractIdentifier(input.url);
      if (extracted) {
        const key = tenantCacheKey(irPlatform.label, extracted.value);
        const bound = input.knownIrTenants.get(key);
        if (bound && companyMatchesBinding(input, bound)) {
          return {
            provenance: "issuer",
            reason: `IR-platform (${irPlatform.label}) + tenant-cache hit ${extracted.value} (first-touch via ${bound.confirmedBy})`,
            regulatorHost: null,
            irPlatformHost: irPlatform.label,
            identitySignal: "tenant-match",
          };
        }
      }
    }

    const identity = threeTierIdentityCheck(input);
    if (identity.matched) {
      // R5c: write-through to the tenant cache so future sibling URLs on
      // the same tenant are accepted without re-running the identity check.
      // Only writes when the caller provided a mutable map AND the URL
      // carries an extractable tenant identifier (i.e. it's a Q4/MZiQ/etc
      // path with a stable per-issuer segment).
      let boundIrTenant: ProvenanceResult["boundIrTenant"] = undefined;
      if (input.knownIrTenants) {
        const extracted = irPlatform.spec.extractIdentifier(input.url);
        if (extracted && identity.tier) {
          const key = tenantCacheKey(irPlatform.label, extracted.value);
          if (!input.knownIrTenants.has(key)) {
            input.knownIrTenants.set(key, {
              companyName: input.companyName || "",
              companyIdentifier: input.companySecCik || input.companyIsin || input.companyTicker || null,
              confirmedBy: identity.tier,
            });
            boundIrTenant = { platform: irPlatform.label, tenantId: extracted.value, confirmedBy: identity.tier };
          }
        }
      }
      return {
        provenance: "issuer",
        reason: `IR-platform (${irPlatform.label}) + ${identity.tier} identity match on ${identity.matchedOn}`,
        regulatorHost: null,
        irPlatformHost: irPlatform.label,
        identitySignal: identity.signal,
        boundIrTenant,
      };
    }
    // IR-platform host but no identity signal from title/URL/content. Try
    // the stronger path-identifier check (Q4 CIK, MZiQ tenant UUID) if the
    // caller supplied the corresponding company identifier.
    const pathIdentity = irPlatformPathIdentityMatch(input, irPlatform.spec);
    if (pathIdentity.matched) {
      return {
        provenance: "issuer",
        reason: `IR-platform (${irPlatform.label}) + ${pathIdentity.reason}`,
        regulatorHost: null,
        irPlatformHost: irPlatform.label,
        identitySignal: pathIdentity.signal,
      };
    }
    // IR-platform but no issuer identity confirmed. Fall through to
    // third_party — could be a competitor's filing surfaced by mistake.
    return {
      provenance: "third_party",
      reason: `IR-platform (${irPlatform.label}) but no title/URL/content/CIK/tenant-cache match for issuer`,
      regulatorHost: null,
      irPlatformHost: irPlatform.label,
      identitySignal: "none",
    };
  }

  // Rule 3: regulator host with identity check. Same title-primary sequence.
  const regulatorLabel = matchRegulatorHost(input.url);
  if (regulatorLabel) {
    const identity = threeTierIdentityCheck(input);
    if (identity.matched) {
      return {
        provenance: "issuer",
        reason: `regulator-hosted (${regulatorLabel}) + ${identity.tier} identity match on ${identity.matchedOn}`,
        regulatorHost: regulatorLabel,
        irPlatformHost: null,
        identitySignal: identity.signal,
      };
    }
    // Regulator host but no identity signal — likely another issuer's filing
    // that was surfaced under this issuer by search-side entity confusion.
    return {
      provenance: "third_party",
      reason: `regulator-hosted (${regulatorLabel}) but no title/URL/content match for issuer`,
      regulatorHost: regulatorLabel,
      irPlatformHost: null,
      identitySignal: "none",
    };
  }

  // Rule 4: default.
  return {
    provenance: "third_party",
    reason: host
      ? `hostname ${host} does not match company domain, IR-platform or regulator host`
      : "invalid URL",
    regulatorHost: null,
    irPlatformHost: null,
    identitySignal: "none",
  };
}

// R2: three-tier identity check for regulator + IR-platform hosts. Runs
// title → URL path → content and returns the first positive result. Encoded
// as a named helper so both callers (regulator + IR platform) apply the
// identical rule and record which tier fired for diagnostics.
function threeTierIdentityCheck(input: ProvenanceInput): {
  matched: boolean;
  matchedOn: string | null;
  tier: "title" | "url-path" | "content" | null;
  signal: "title" | "url-path" | "content" | "none";
} {
  // Tier 1: title. Normalised to lowercase; single occurrence sufficient.
  const title = normalise(input.title || "");
  if (title) {
    const t = identityMatch(input, title, 1);
    if (t.matched) return { matched: true, matchedOn: t.matchedOn, tier: "title", signal: "title" };
  }

  // Tier 2: URL path. Percent-decoded and lowercased; single occurrence.
  // We compare against the path only (not host), because host is what put
  // us in this branch in the first place — it carries no additional signal.
  let urlPath = "";
  try {
    urlPath = decodeURIComponent(pathOf(input.url)).replace(/[-_/\\.]+/g, " ").toLowerCase();
  } catch {
    urlPath = pathOf(input.url).replace(/[-_/\\.]+/g, " ").toLowerCase();
  }
  if (urlPath) {
    const u = identityMatch(input, urlPath, 1);
    if (u.matched) return { matched: true, matchedOn: u.matchedOn, tier: "url-path", signal: "url-path" };
  }

  // Tier 3: content (fallback). Requires 2 occurrences to guard against
  // case-study PDFs that mention the target company once in a bulleted list.
  const content = normalise((input.content || "").slice(0, 8192));
  if (content) {
    const c = identityMatch(input, content, 2);
    if (c.matched) return { matched: true, matchedOn: c.matchedOn, tier: "content", signal: "content" };
  }

  return { matched: false, matchedOn: null, tier: null, signal: "none" };
}

// R2: IR-platform path-identifier match (Q4 CIK, MZiQ tenant UUID).
// Runs only when the caller supplied the corresponding company identifier
// (companySecCik for Q4, no analogue for MZiQ yet). This is the strongest
// possible signal for platforms that encode issuer identity in the URL,
// because it's an exact platform-verified match rather than a text heuristic.
function irPlatformPathIdentityMatch(
  input: ProvenanceInput,
  spec: IrPlatformSpec,
): { matched: boolean; reason: string; signal: "cik-match" | "tenant-match" | "none" } {
  const extracted = spec.extractIdentifier(input.url);
  if (!extracted) return { matched: false, reason: "no identifier in URL path", signal: "none" };

  if (extracted.kind === "cik" && input.companySecCik) {
    // Normalise both sides to unpadded digits.
    const urlCik = extracted.value.replace(/^0+/, "") || "0";
    const knownCik = input.companySecCik.replace(/^0+/, "") || "0";
    if (urlCik === knownCik) {
      return { matched: true, reason: `CIK path match (${urlCik})`, signal: "cik-match" };
    }
    return { matched: false, reason: `CIK path mismatch (url=${urlCik}, company=${knownCik})`, signal: "none" };
  }

  // For q4_tenant_id / tenant / path-token identifiers we have no company-side
  // value to compare against directly. Identity is established either via the
  // three-tier title/URL/content check (already tried by the caller) or via
  // the `knownIrTenants` cache (checked before we get here in the R5c flow).
  // R5c note (2026-09-04): pre-R5c, Q4 tenant IDs were labeled `cik` and
  // compared against `companySecCik` here, which produced false mismatches
  // that dropped legitimate first-party Q4 URLs (Newmont's Sustainability
  // Report). See `Q4_CDN_HOSTS` for the fix.
  return { matched: false, reason: `${extracted.kind} identifier present but no company-side value to compare`, signal: "none" };
}

// R5c: shared helpers for the tenant propagation cache. Exported so the
// pipeline caller can construct/inspect keys consistently (e.g. for logging
// or for cross-batch persistence in a future enhancement).
export function tenantCacheKey(platformLabel: string, tenantId: string): string {
  return `${platformLabel.toLowerCase()}:${tenantId.toLowerCase()}`;
}

/**
 * Guard the tenant-cache hit against cross-company reuse. A cached binding is
 * only valid for a URL when the input's declared company matches the company
 * that originally bound the tenant. Without this guard, two companies in the
 * same batch that happen to hit the same Q4/MZiQ tenant would be mis-classified.
 *
 * Match rule is lenient because binding is per-batch and per-issuer: exact
 * name match OR at least one shared stable identifier (SEC CIK / ISIN /
 * ticker). Returns true only when we have positive corroboration.
 */
function companyMatchesBinding(input: ProvenanceInput, bound: IrTenantBinding): boolean {
  const inName = (input.companyName || "").trim().toLowerCase();
  const boundName = (bound.companyName || "").trim().toLowerCase();
  if (inName && boundName && inName === boundName) return true;
  const inIds = [input.companySecCik, input.companyIsin, input.companyTicker]
    .filter((v): v is string => !!v)
    .map(v => v.toLowerCase());
  const boundId = (bound.companyIdentifier || "").toLowerCase();
  if (boundId && inIds.includes(boundId)) return true;
  return false;
}

// Exported for use by pipeline.ts (existing string field) — encodes the
// two-way class into the DB `source_type` column.
export function provenanceToSourceType(p: ProvenanceClass): "first_party" | "third_party" {
  return p === "issuer" ? "first_party" : "third_party";
}
