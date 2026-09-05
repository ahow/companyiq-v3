/**
 * R6 — Generalised discovery-rule helpers.
 *
 * See docs/R6-Discovery-Rules-Design-2026-09-05.md for the design rationale.
 * These helpers are pure and side-effect free (except for the fetch/webSearch
 * dependencies that callers inject). Each helper implements ONE rule and adds
 * candidate URLs into a caller-provided `emit` callback so the existing
 * discovery pipeline's addCandidate / gate / rank code paths are unchanged.
 *
 * Rule inventory:
 *   R6a — IR-platform tenant enumeration (Q4Inc, Nasdaq IR, Investis, ...)
 *   R6b — Locale-aware topic-term variants (extension of existing LocaleProfile)
 *   R6c — Regulator-repository targeting (ESMA ESEF, HKEX, TSX, ASX)
 *   R6d — Framework-declared regulatory doc types with jurisdiction hints
 *   R6e — Link-farming from ESG landing pages (extract same-origin PDF and DAM links)
 *   R6f — Sub-page enumeration on ESG report URL trees
 *
 * All rules are framework-agnostic (Nature, Climate, Governance, etc). They
 * only add candidates; they never reject, filter, or downweight anything.
 */

// ────────────────────────────────────────────────────────────────────────────
// R6a — IR-platform tenant enumeration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Known IR-platform CDN patterns. Each entry is a hostname suffix and the
 * regex that extracts the tenant identifier from a document URL served by that
 * platform. Tenant is the substring uniquely identifying one issuer within the
 * shared CDN.
 *
 * Adding a new IR platform requires:
 *   (a) the hostname suffix (e.g. "q4cdn.com"),
 *   (b) the regex to extract tenant from a URL,
 *   (c) the template to build a site: search query from a tenant.
 */
export const IR_PLATFORMS: {
  name: string;
  hostSuffix: string;              // matched as URL host endsWith
  tenantFromUrl: RegExp;           // capture-group 1 = tenant id
  seedSiteSearch: (tenant: string) => string;  // returns site: query fragment
}[] = [
  {
    name: "q4inc",
    hostSuffix: "q4cdn.com",
    // e.g. https://s24.q4cdn.com/382246808/files/doc_downloads/... → tenant = 382246808
    tenantFromUrl: /q4cdn\.com\/(\d{6,12})\//i,
    seedSiteSearch: (tenant) => `site:q4cdn.com/${tenant}/ filetype:pdf`,
  },
  {
    name: "investis-cloudfront",
    hostSuffix: "investisdigital.com",
    // e.g. https://<tenant>.investisdigital.com/... → tenant = subdomain
    tenantFromUrl: /https?:\/\/([a-z0-9-]+)\.investisdigital\.com\//i,
    seedSiteSearch: (tenant) => `site:${tenant}.investisdigital.com filetype:pdf`,
  },
  {
    name: "nasdaqir",
    hostSuffix: "ir.nasdaq.com",
    // Nasdaq IR uses ticker-keyed subdomains: {ticker}.q4ir.com or similar
    tenantFromUrl: /https?:\/\/([a-z]{2,5})\.q4ir\.com\//i,
    seedSiteSearch: (tenant) => `site:${tenant}.q4ir.com filetype:pdf`,
  },
  {
    name: "computershare",
    hostSuffix: "computershare.com",
    tenantFromUrl: /computershare\.com\/investor\/([a-z0-9-]+)\//i,
    seedSiteSearch: (tenant) => `site:computershare.com/investor/${tenant} filetype:pdf`,
  },
  {
    name: "westhoughton-euroland",
    hostSuffix: "euroland.com",
    tenantFromUrl: /euroland\.com\/tools\/([a-z0-9-]+)\//i,
    seedSiteSearch: (tenant) => `site:euroland.com/tools/${tenant}/ filetype:pdf`,
  },
];

/**
 * Given a set of URLs already discovered for an issuer, extract the IR-platform
 * tenants (tenant + platform) that surface in those URLs. Deduplicated.
 *
 * Used at the end of a discovery run to PERSIST tenant metadata on the company
 * record's discoveryDiagnostics.irPlatformTenants field. On subsequent runs,
 * `buildIRPlatformSeedQueries` reads the stored tenants and emits direct site:
 * queries so the tenant CDN is a first-class discovery target.
 */
export function extractIRPlatformTenants(urls: string[]): { platform: string; tenant: string }[] {
  const found = new Map<string, { platform: string; tenant: string }>();
  for (const url of urls) {
    for (const p of IR_PLATFORMS) {
      const m = url.match(p.tenantFromUrl);
      if (m && m[1]) {
        const key = `${p.name}:${m[1]}`;
        if (!found.has(key)) found.set(key, { platform: p.name, tenant: m[1] });
      }
    }
  }
  return Array.from(found.values());
}

/**
 * Given persisted IR-platform tenants (from prior runs) build the seed
 * site: search queries that surface documents from those tenants.
 *
 * We ALSO emit a generic `site:<cdn> "<companyName>"` fallback so we start
 * building up the tenant list on the FIRST discovery run for a new company.
 * That first-run fallback is bounded to a small number of queries to keep
 * budget in check.
 */
export function buildIRPlatformSeedQueries(
  companyName: string,
  persistedTenants: { platform: string; tenant: string }[],
  topicPhrases: string[],
): string[] {
  const queries: string[] = [];
  // Direct tenant queries (highest signal) — pair with topic phrases so
  // only topic-relevant documents come back
  for (const t of persistedTenants) {
    const platform = IR_PLATFORMS.find(p => p.name === t.platform);
    if (!platform) continue;
    // Plain seed to enumerate PDFs hosted for this tenant
    queries.push(platform.seedSiteSearch(t.tenant));
    // Topic-scoped seed to boost the useful ones
    for (const phrase of topicPhrases.slice(0, 2)) {
      queries.push(`${platform.seedSiteSearch(t.tenant).replace(" filetype:pdf", "")} "${phrase}"`);
    }
  }

  // First-run bootstrap: try to discover the tenant path for each known
  // platform. Cost-bounded (one query per platform per run).
  const quotedName = `"${companyName}"`;
  for (const p of IR_PLATFORMS) {
    // Only bootstrap if we don't already have a tenant persisted for this platform
    const alreadyHave = persistedTenants.some(t => t.platform === p.name);
    if (alreadyHave) continue;
    queries.push(`site:${p.hostSuffix} ${quotedName} filetype:pdf`);
  }

  return queries;
}

// ────────────────────────────────────────────────────────────────────────────
// R6b — Locale-aware topic-term variants
// ────────────────────────────────────────────────────────────────────────────

/**
 * For each ISO-2 country code, native-language terms for common ESG/sustainability
 * report vocabulary that appear in URL paths and filenames. Additive to the existing
 * LocaleProfile.reportTerms (which covers annual-report variants only).
 *
 * These are matched by URL-path substring after being URL-encoded; the actual
 * SEARCH query uses them as free-text phrases so the search engine returns
 * pages whose URL or content contains them.
 */
export const LOCALE_TOPIC_TERMS: Record<string, string[]> = {
  es: ["sostenibilidad", "informe de sostenibilidad", "responsabilidad"],
  mx: ["sostenibilidad", "responsabilidad social"],
  ar: ["sostenibilidad"],
  fr: ["durabilité", "développement durable", "extra-financier", "rapport ESG"],
  be: ["durabilité", "duurzaamheid"],
  de: ["nachhaltigkeit", "nachhaltigkeitsbericht", "ESG-Bericht"],
  at: ["nachhaltigkeit"],
  ch: ["nachhaltigkeit", "durabilité", "sostenibilità"],
  it: ["sostenibilità", "bilancio di sostenibilità"],
  pt: ["sustentabilidade", "relatório de sustentabilidade"],
  br: ["sustentabilidade", "relatório de sustentabilidade"],
  nl: ["duurzaamheid", "duurzaamheidsverslag"],
  jp: ["サステナビリティ", "統合報告書", "ESG報告書"],
  cn: ["可持续", "可持续发展报告", "环境社会治理"],
  hk: ["可持續", "可持續發展報告"],
  tw: ["永續", "永續報告書"],
  kr: ["지속가능", "지속가능경영보고서"],
  se: ["hållbarhet", "hållbarhetsrapport"],
  fi: ["kestävyys", "kestävyysraportti"],
  dk: ["bæredygtighed", "bæredygtighedsrapport"],
  no: ["bærekraft", "bærekraftsrapport"],
};

/**
 * Build locale-scoped topic queries. Uses issuer's country to pick the language.
 * Combines each locale-topic term with the company name and (optionally) an
 * effective domain constraint.
 */
export function buildLocaleTopicQueries(
  companyName: string,
  country: string | null | undefined,
  effectiveDomain: string | null | undefined,
): string[] {
  if (!country) return [];
  const key = country.trim().toLowerCase();
  const terms = LOCALE_TOPIC_TERMS[key] ?? LOCALE_TOPIC_TERMS[key.slice(0, 2)];
  if (!terms || terms.length === 0) return [];

  const queries: string[] = [];
  const quotedName = `"${companyName}"`;
  for (const term of terms.slice(0, 4)) {
    // Domain-anchored (highest precision when effective domain known)
    if (effectiveDomain) {
      queries.push(`site:${effectiveDomain} ${term}`);
    }
    // Also a general locale-topic query with company name
    queries.push(`${quotedName} ${term}`);
  }
  return queries;
}

// ────────────────────────────────────────────────────────────────────────────
// R6c — Regulator-repository targeting
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build regulator-hosted primary-filing candidate URLs for an issuer, based on
 * its known identifiers (LEI for EU ESEF, CIK for SEC — already covered
 * elsewhere, HK legal name for HKEX).
 *
 * R6c v1 emitted directory/search URLs — those got rejected by the corpus gate
 * because they aren't fetchable primary documents. R6c v2 (below in
 * `enumerateRegulatorFilings`) calls the regulator APIs directly to enumerate
 * the concrete filing URLs.
 *
 * This function is kept for backwards compatibility and as a low-priority
 * fallback for regulators whose APIs we haven't wrapped yet.
 *
 * These are DIRECT URL candidates emitted with high priority so they don't
 * need to survive Serper ranking. The gate will still verify them.
 */
export function buildRegulatorRepositoryUrls(opts: {
  companyName: string;
  lei?: string | null;
  country?: string | null;
  isin?: string | null;
}): { url: string; title: string; snippet: string }[] {
  const results: { url: string; title: string; snippet: string }[] = [];
  const country = (opts.country ?? "").trim().toLowerCase();
  const isinCountry = opts.isin && opts.isin.length >= 2 ? opts.isin.slice(0, 2).toUpperCase() : "";

  // ESMA ESEF — EU-27 issuers with LEI
  const EU_COUNTRIES = new Set([
    "at","be","bg","hr","cy","cz","dk","ee","fi","fr","de","gr","hu","ie","it","lv","lt","lu",
    "mt","nl","pl","pt","ro","sk","si","es","se","gb","uk","no","is","li",
    "austria","belgium","bulgaria","croatia","cyprus","czech republic","denmark","estonia",
    "finland","france","germany","greece","hungary","ireland","italy","latvia","lithuania",
    "luxembourg","malta","netherlands","poland","portugal","romania","slovakia","slovenia",
    "spain","sweden","united kingdom","norway","iceland","liechtenstein",
  ]);
  const inEuByCountry = EU_COUNTRIES.has(country);
  const inEuByIsin = ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
    "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","GB","NO","IS","LI"].includes(isinCountry);

  if (opts.lei && (inEuByCountry || inEuByIsin)) {
    // ESEF filings are indexed per LEI + reporting-period
    // Directory listing: https://filings.xbrl.org/<LEI>/
    // Individual periods: https://filings.xbrl.org/<LEI>/<YYYY>-12-31/
    const currentYear = new Date().getFullYear();
    for (const year of [currentYear - 1, currentYear - 2, currentYear - 3]) {
      // Emit the directory listing URL — the gate will follow the actual XHTML/XBRL from it
      results.push({
        url: `https://filings.xbrl.org/${opts.lei}/${year}-12-31/`,
        title: `${opts.companyName} ESEF filing ${year}`,
        snippet: `ESMA European Single Electronic Format filing for ${opts.companyName} (LEI ${opts.lei}) reporting period ${year}-12-31`,
      });
    }
    // Also emit the LEI directory root so link-farming can enumerate any period
    results.push({
      url: `https://filings.xbrl.org/${opts.lei}/`,
      title: `${opts.companyName} ESEF filings directory`,
      snippet: `ESEF filings directory for ${opts.companyName} (LEI ${opts.lei})`,
    });
  }

  // Hong Kong Exchange — issuers with HK country signals or HK-listing.
  // We emit a HKEX search-index URL rather than direct filing URLs (which use
  // opaque doc numbers). The evidence-expansion/link-farming lane will
  // enumerate individual filings from the search page.
  const isHkListed =
    country === "hk" || country === "hong kong" ||
    isinCountry === "HK";
  // Prudential plc listing signal: legal name matches AND we know plc is dual-listed on HK
  const isPrudentialPlcPattern = /prudential\s+p?l?c/i.test(opts.companyName);
  if (isHkListed || isPrudentialPlcPattern) {
    // HKEX news search entry — will surface annual filings under listedco/listconews/sehk
    results.push({
      url: `https://www.hkexnews.hk/listedco/listconews/advancedsearch/search_active_main.aspx?SearchText=${encodeURIComponent(opts.companyName)}&FilingType=annualreport`,
      title: `${opts.companyName} HKEX filings search`,
      snippet: `Hong Kong Exchange primary-filing search for ${opts.companyName}`,
    });
  }

  // TSX / SEDAR+ — Canadian issuers
  const isCanadian = country === "ca" || country === "canada" || isinCountry === "CA";
  if (isCanadian) {
    results.push({
      url: `https://www.sedarplus.ca/csa-party/records/document.html?issuerCik=${encodeURIComponent(opts.companyName)}`,
      title: `${opts.companyName} SEDAR+ filings`,
      snippet: `Canadian regulator SEDAR+ filings for ${opts.companyName}`,
    });
  }

  // ASX — Australian issuers
  const isAustralian = country === "au" || country === "australia" || isinCountry === "AU";
  if (isAustralian) {
    // ASX company announcements page (uses ticker; caller will need to pass ticker)
    // For now emit a search URL that surfaces announcements
    results.push({
      url: `https://www.asx.com.au/asx/1/company/${encodeURIComponent(opts.companyName)}/announcements?count=25&announcementType=all`,
      title: `${opts.companyName} ASX announcements`,
      snippet: `Australian Securities Exchange announcements for ${opts.companyName}`,
    });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// R6d — Jurisdiction-aware framework document types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Additional regulator-mandated document types by jurisdiction. These are
 * ADDITIVE to the framework's own `requiredDocTypes` (which is jurisdiction-
 * agnostic).
 *
 * Callers pass the framework's `requiredDocTypes`, the issuer's jurisdiction,
 * and get back the combined list. Each item must be quoted as a phrase in the
 * search query.
 */
export const JURISDICTION_DOC_TYPES: Record<string, string[]> = {
  // EU-27 + closely-aligned (CSRD applies)
  at: ["sustainability statement", "non-financial statement"],
  be: ["sustainability statement", "non-financial statement"],
  bg: ["sustainability statement", "non-financial statement"],
  hr: ["sustainability statement", "non-financial statement"],
  cy: ["sustainability statement", "non-financial statement"],
  cz: ["sustainability statement", "non-financial statement"],
  dk: ["sustainability statement", "non-financial statement"],
  ee: ["sustainability statement", "non-financial statement"],
  fi: ["sustainability statement", "non-financial statement"],
  fr: ["sustainability statement", "non-financial statement", "déclaration de performance extra-financière"],
  de: ["sustainability statement", "non-financial statement", "nichtfinanzielle Erklärung"],
  gr: ["sustainability statement", "non-financial statement"],
  hu: ["sustainability statement", "non-financial statement"],
  ie: ["sustainability statement", "non-financial statement"],
  it: ["sustainability statement", "non-financial statement", "dichiarazione non finanziaria"],
  lv: ["sustainability statement", "non-financial statement"],
  lt: ["sustainability statement", "non-financial statement"],
  lu: ["sustainability statement", "non-financial statement"],
  mt: ["sustainability statement", "non-financial statement"],
  nl: ["sustainability statement", "non-financial statement"],
  pl: ["sustainability statement", "non-financial statement"],
  pt: ["sustainability statement", "non-financial statement"],
  ro: ["sustainability statement", "non-financial statement"],
  sk: ["sustainability statement", "non-financial statement"],
  si: ["sustainability statement", "non-financial statement"],
  es: ["sustainability statement", "non-financial statement", "estado de información no financiera"],
  se: ["sustainability statement", "non-financial statement"],
  // Switzerland — has adopted CSRD-equivalent
  ch: ["sustainability statement", "non-financial statement"],
  // UK — Companies Act
  gb: ["strategic report", "section 172 statement", "SECR", "streamlined energy and carbon report"],
  uk: ["strategic report", "section 172 statement", "SECR"],
  // US — SEC
  us: ["10-K", "proxy statement", "climate-related disclosures"],
  // Australia
  au: ["operating and financial review", "sustainability report"],
  // Canada
  ca: ["management's discussion and analysis", "sustainability report"],
  // Japan
  jp: ["有価証券報告書", "統合報告書", "サステナビリティ情報"],
  // Hong Kong
  hk: ["ESG report", "environmental, social and governance report"],
  // South Korea
  kr: ["지속가능경영보고서"],
};

/**
 * Build framework-doctype × jurisdiction-doctype cross-product queries.
 */
export function buildJurisdictionDocTypeQueries(opts: {
  companyName: string;
  effectiveDomain?: string | null;
  country?: string | null;
  isin?: string | null;
}): string[] {
  const country = (opts.country ?? "").trim().toLowerCase();
  const isinCountry = opts.isin && opts.isin.length >= 2 ? opts.isin.slice(0, 2).toLowerCase() : "";
  const jurisdiction = country || isinCountry;
  if (!jurisdiction) return [];

  const docTypes = JURISDICTION_DOC_TYPES[jurisdiction] ?? JURISDICTION_DOC_TYPES[jurisdiction.slice(0, 2)];
  if (!docTypes || docTypes.length === 0) return [];

  const queries: string[] = [];
  const quotedName = `"${opts.companyName}"`;
  for (const dt of docTypes) {
    const phrase = `"${dt}"`;
    if (opts.effectiveDomain) {
      queries.push(`site:${opts.effectiveDomain} ${phrase} filetype:pdf`);
      queries.push(`site:${opts.effectiveDomain} ${phrase}`);
    }
    queries.push(`${quotedName} ${phrase} filetype:pdf`);
  }
  return queries;
}

// ────────────────────────────────────────────────────────────────────────────
// R6e — Link-farming from ESG landing pages
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a URL looks like an ESG / sustainability / corporate-
 * responsibility landing page (i.e. a hub page that likely links to sub-pages
 * and PDFs).
 */
export function isEsgLandingPage(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const path = u.pathname.toLowerCase();
  // ESG hub segments; match if any path segment equals or starts with one of
  // these tokens. Uses word-boundary matching, not simple substring, to avoid
  // false positives like "/pressure/" matching "esg".
  const ESG_HUB_SEGMENTS = new Set([
    "esg", "esgreport", "esg-report", "esg-hub",
    "sustainability", "sustainability-report",
    "responsibility", "corporate-responsibility", "social-responsibility",
    "purpose", "impact", "planet", "nature", "environment",
    "csr",
  ]);
  const segments = path.split("/").filter(Boolean);
  // Direct segment match anywhere in path
  if (segments.some(s => ESG_HUB_SEGMENTS.has(s))) return true;
  // Special-case: investor sub-hubs
  if (/\/investors\/(esg|sustainability|responsibility)/.test(path)) return true;
  return false;
}

/**
 * Given the HTML of a landing page, extract same-origin document links suitable
 * for evidence discovery. Follows Adobe AEM DAM (`/content/dam/*`), Drupal
 * (`/sites/default/files/*`), and generic PDF links. Also extracts same-origin
 * HTML sub-pages under the landing page's parent path (used by R6f).
 *
 * Deliberately conservative: caps the number of extracted links to avoid
 * runaway on hub pages with thousands of outlinks.
 */
export function extractLandingPageLinks(opts: {
  landingUrl: string;
  html: string;
  maxLinks?: number;
  topicPhrases?: string[];
}): { url: string; hint: "pdf" | "dam" | "subpage" }[] {
  const maxLinks = opts.maxLinks ?? 60;
  const results: { url: string; hint: "pdf" | "dam" | "subpage" }[] = [];
  const seen = new Set<string>();

  let base: URL;
  try { base = new URL(opts.landingUrl); } catch { return results; }
  const origin = base.origin;
  const landingPathParent = base.pathname.replace(/\/$/, "").replace(/\/[^/]+$/, "") || "/";

  // Extract every href on the page
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(opts.html)) && results.length < maxLinks) {
    const rawHref = match[1].trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("mailto:") || rawHref.startsWith("javascript:")) continue;
    let full: URL;
    try { full = new URL(rawHref, opts.landingUrl); } catch { continue; }
    // Same-origin only
    if (full.origin !== origin) continue;
    const url = full.toString();
    if (seen.has(url)) continue;

    const path = full.pathname.toLowerCase();
    let hint: "pdf" | "dam" | "subpage" | null = null;
    if (/\.pdf($|\?)/.test(path)) hint = "pdf";
    else if (/\/content\/dam\//.test(path) || /\/sites\/default\/files\//.test(path) || /\/media\//.test(path) || /\/downloads?\//.test(path)) hint = "dam";
    else if (full.pathname.startsWith(landingPathParent) && full.pathname !== base.pathname) hint = "subpage";
    else continue;

    // If topicPhrases are provided, up-rank sub-page URLs that contain any topic-token in their path/slug.
    // We still emit non-matching sub-pages, but the caller (addCandidate) will
    // rank them lower via the existing priority calculation.
    seen.add(url);
    results.push({ url, hint });
  }

  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// R6f — Sub-page enumeration on ESG report URL trees
// ────────────────────────────────────────────────────────────────────────────

/**
 * Given an ESG landing page URL and the framework's topic phrases, build a set
 * of second-pass `site:<domain> inurl:<parent-path> <topic>` queries. This is a
 * generalisation of the R6e link-farming — R6e uses HTML extraction, R6f uses
 * Serper site: inurl: queries which surface pages the landing page does NOT
 * explicitly link to (e.g. old versions, deep-linked topic pages).
 */
export function buildSubpageEnumerationQueries(
  landingUrl: string,
  topicPhrases: string[],
): string[] {
  let u: URL;
  try { u = new URL(landingUrl); } catch { return []; }
  const domain = u.hostname;
  // If the landing URL ends with '/', treat its pathname (minus trailing slash) as the parent.
  // Otherwise walk one segment up to get the containing directory.
  const rawPath = u.pathname;
  const endsWithSlash = rawPath.endsWith("/");
  let parent = endsWithSlash
    ? rawPath.replace(/\/$/, "")
    : rawPath.replace(/\/[^/]+$/, "");
  if (!parent || parent === "") return [];

  const queries: string[] = [];
  for (const phrase of topicPhrases.slice(0, 4)) {
    queries.push(`site:${domain} inurl:${parent} ${phrase}`);
  }
  return queries;
}

/**
 * R6c v2 — Regulator-API filing enumeration
 *
 * Directly calls regulator repository APIs (ESMA ESEF filings.xbrl.org and
 * HKEX title-search) to return concrete filing URLs for an issuer. This
 * replaces R6c v1's approach of emitting directory URLs (which the gate
 * rejected as unfetchable).
 *
 * Best-effort: each API call is time-bounded to ~5-8s and errors are
 * swallowed. Returns an empty array when the issuer has no relevant
 * identifier or the API is unreachable.
 */
export type RegulatorFilingRecord = { url: string; title: string; snippet: string; source: string };

export async function enumerateRegulatorFilings(opts: {
  companyName: string;
  lei?: string | null;
  country?: string | null;
  isin?: string | null;
  hkStockCode?: string | null;
  fetchTimeoutMs?: number;
}): Promise<RegulatorFilingRecord[]> {
  const timeout = opts.fetchTimeoutMs ?? 8000;
  const results: RegulatorFilingRecord[] = [];

  const country = (opts.country ?? "").trim().toLowerCase();
  const isinCountry = opts.isin && opts.isin.length >= 2 ? opts.isin.slice(0, 2).toUpperCase() : "";

  // ── ESMA ESEF filings via filings.xbrl.org JSON:API ──────────────────────
  const EU_COUNTRIES = new Set([
    "at","be","bg","hr","cy","cz","dk","ee","fi","fr","de","gr","hu","ie","it",
    "lv","lt","lu","mt","nl","pl","pt","ro","sk","si","es","se","gb","uk","no",
    "is","li","austria","belgium","bulgaria","croatia","cyprus","czech republic",
    "denmark","estonia","finland","france","germany","greece","hungary","ireland",
    "italy","latvia","lithuania","luxembourg","malta","netherlands","poland",
    "portugal","romania","slovakia","slovenia","spain","sweden","united kingdom",
    "norway","iceland","liechtenstein",
  ]);
  const EU_ISIN_COUNTRIES = new Set(["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR",
    "DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI",
    "ES","SE","GB","NO","IS","LI"]);
  const inEu = EU_COUNTRIES.has(country) || EU_ISIN_COUNTRIES.has(isinCountry);

  if (opts.lei && inEu) {
    try {
      const filter = encodeURIComponent(JSON.stringify([
        { name: "entity.identifier", op: "eq", val: opts.lei },
      ]));
      const apiUrl = `https://filings.xbrl.org/api/filings?filter=${filter}&page[size]=25`;
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), timeout);
      const resp = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { Accept: "application/vnd.api+json", "User-Agent": "CompanyIQ-Discovery/1.0" },
      });
      clearTimeout(to);
      if (resp.ok) {
        const data = await resp.json() as any;
        const rows: any[] = Array.isArray(data?.data) ? data.data : [];
        for (const row of rows) {
          const attrs = row?.attributes ?? {};
          const period = attrs.period_end ?? "unknown";
          const country_code = attrs.country ?? "";
          const reportRel = attrs.report_url as string | undefined;
          const packageRel = attrs.package_url as string | undefined;
          if (reportRel) {
            results.push({
              url: `https://filings.xbrl.org${reportRel}`,
              title: `${opts.companyName} ESEF filing ${period} (${country_code})`,
              snippet: `ESMA ESEF primary iXBRL report for ${opts.companyName} (LEI ${opts.lei}) period-end ${period}`,
              source: "r6c-esef-api",
            });
          }
          if (packageRel) {
            results.push({
              url: `https://filings.xbrl.org${packageRel}`,
              title: `${opts.companyName} ESEF package ${period} (${country_code})`,
              snippet: `ESMA ESEF filing package (zip) for ${opts.companyName} period-end ${period}`,
              source: "r6c-esef-api",
            });
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // ── HKEX filings via www1.hkexnews.hk title-search ──────────────────────
  const isHkListed =
    country === "hk" || country === "hong kong" || isinCountry === "HK";
  const isPrudentialPlcPattern = /prudential\s+p?l?c/i.test(opts.companyName);
  const explicitHkStock = opts.hkStockCode;

  if (isHkListed || isPrudentialPlcPattern || explicitHkStock) {
    try {
      // Step 1 — resolve stock code if not provided.
      // HKEX prefix.do returns JSONP: callback({"more":"1","stockInfo":[{stockId,code,name}]});
      let stockId = explicitHkStock ? null : null;  // stockId is numeric, distinct from ticker code
      let stockCode = explicitHkStock ?? null;

      if (!explicitHkStock) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), timeout);
        const prefixUrl = `https://www1.hkexnews.hk/search/prefix.do?callback=cb&lang=EN&type=A&name=${encodeURIComponent(opts.companyName)}`;
        const resp = await fetch(prefixUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "CompanyIQ-Discovery/1.0" },
        });
        clearTimeout(to);
        if (resp.ok) {
          const text = await resp.text();
          const jsonBody = text.replace(/^cb\(/, "").replace(/\);?\s*$/, "");
          try {
            const parsed = JSON.parse(jsonBody) as any;
            const stocks: any[] = Array.isArray(parsed?.stockInfo) ? parsed.stockInfo : [];
            if (stocks.length > 0) {
              stockId = stocks[0].stockId ?? null;
              stockCode = stocks[0].code ?? null;
            }
          } catch { /* jsonp parse failed */ }
        }
      }

      // Step 2 — pull annual + sustainability reports for the last 2 fiscal years
      if (stockId) {
        const currentYear = new Date().getFullYear();
        const fromDate = `${currentYear - 2}0101`;
        const toDate = `${currentYear}1231`;
        const params = new URLSearchParams({
          sortDir: "0",
          sortByOptions: "DateTime",
          category: "0",
          market: "SEHK",
          stockId: String(stockId),
          documentType: "-1",
          fromDate,
          toDate,
          t1code: "40000", // Financial statements / ESG information
          lang: "EN",
        });
        const searchUrl = `https://www1.hkexnews.hk/search/titleSearchServlet.do?${params.toString()}`;
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), timeout);
        const resp = await fetch(searchUrl, {
          signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": "CompanyIQ-Discovery/1.0" },
        });
        clearTimeout(to);
        if (resp.ok) {
          const text = await resp.text();
          try {
            const parsed = JSON.parse(text) as any;
            const rowsStr = parsed?.result ?? "[]";
            const rows: any[] = JSON.parse(rowsStr);
            for (const row of rows) {
              const link = row?.FILE_LINK;
              if (!link || typeof link !== "string") continue;
              const title = row?.TITLE ?? "";
              const dateTime = row?.DATE_TIME ?? "";
              results.push({
                url: `https://www.hkexnews.hk${link.startsWith("/") ? link : "/" + link}`,
                title: `${opts.companyName} ${title} (HKEX ${stockCode})`,
                snippet: `Hong Kong Exchange primary filing: ${title}, filed ${dateTime}`,
                source: "r6c-hkex-api",
              });
            }
          } catch { /* json parse failed */ }
        }
      }
    } catch { /* best-effort */ }
  }

  return results;
}

/**
 * Attempt to fetch and parse a site's sitemap.xml, returning any URLs whose
 * path is under `parentPath`. Used as a complement to R6f when a full sitemap
 * is available (deterministic enumeration).
 *
 * Callers should time-bound the fetch (2-3s) and swallow errors — sitemap
 * fetch is best-effort.
 */
export function parseSitemapForSubpaths(sitemapXml: string, parentPath: string): string[] {
  const results = new Set<string>();
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(sitemapXml))) {
    const raw = m[1].trim();
    try {
      const u = new URL(raw);
      if (u.pathname.startsWith(parentPath)) results.add(u.toString());
    } catch { /* skip malformed */ }
  }
  return Array.from(results);
}
