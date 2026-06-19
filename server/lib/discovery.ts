import axios from "axios";
import { createHash } from "crypto";
import * as storage from "../storage.js";
import { completeWithFallback } from "./ai-providers.js";
import { deriveTopicLexicon } from "./topic-lexicon.js";
import type { Framework, TrustedSource } from "../../shared/schema.js";

const MAX_DOCS_RETURNED = 60;
const PRE_GATE_CAP = 180;
const SEARCH_TIMEOUT = 15000;

// ─── Document Tier Classification ──────────────────────────────────────────
// Tier 1 (mandatory): 10-K, 20-F, annual report, proxy/DEF 14A, AGM circular
// Tier 2 (priority): Investor presentations, governance pages, AI/responsible-AI policy, press releases
// Tier 3 (supplementary): ESG/sustainability reports, CDP responses, third-party assessments
// Tier 4 (noise): Podcasts, app stores, job listings, unrelated third-party content

export type DocumentTier = 1 | 2 | 3 | 4;

export function classifyDocumentTier(url: string, title: string): DocumentTier {
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  // ─── Tier 4: Noise (deny-listed sources) ─────────────────────────────
  if (isUrlDenied(urlLower)) return 4;

  // ─── Tier 1: Mandatory filings ───────────────────────────────────────
  const tier1Patterns = [
    /10-?k/i, /20-?f/i, /def.?14a/i, /proxy.?statement/i,
    /annual.?report/i, /agm.?circular/i, /annual.?general.?meeting/i,
    /integrated.?report/i,
  ];
  const tier1Domains = ["sec.gov", "sedarplus.ca", "asx.com.au", "hkexnews.hk"];

  if (tier1Domains.some(d => urlLower.includes(d))) return 1;
  if (tier1Patterns.some(p => p.test(urlLower) || p.test(titleLower))) return 1;

  // ─── Tier 2: Priority corporate disclosures ──────────────────────────
  const tier2Patterns = [
    /investor.?relation/i, /investor.?presentation/i, /investor.?day/i,
    /capital.?markets.?day/i, /earnings/i, /governance/i,
    /responsible.?ai/i, /ai.?policy/i, /ai.?ethics/i, /ai.?principles/i,
    /corporate.?governance/i, /board.?of.?directors/i,
    /press.?release/i, /newsroom/i, /media.?release/i,
    /strategy.?presentation/i, /pillar.?3/i, /risk.?factor/i,
    /r&d.?day/i, /research.?day/i, /science.?day/i,
  ];

  if (tier2Patterns.some(p => p.test(urlLower) || p.test(titleLower))) return 2;

  // ─── Tier 3: Supplementary (ESG, sustainability, CDP, etc.) ──────────
  const tier3Patterns = [
    /sustainab/i, /esg/i, /cdp/i, /tcfd/i, /tnfd/i,
    /climate/i, /environment/i, /csr/i, /social.?responsibility/i,
  ];

  if (tier3Patterns.some(p => p.test(urlLower) || p.test(titleLower))) return 3;

  // Default: Tier 3 (supplementary — unknown type, not noise)
  return 3;
}

// ─── Filing Year Detection + Recency Gating (Layer A) ───────────────────────
// Periodic filings (10-K, 20-F, annual report, proxy/DEF 14A) accumulate over
// many years on sources like SEC EDGAR. Without recency gating, a company's
// entire 10-15 year filing history floods the corpus with stale, topic-free
// boilerplate that dilutes the few recent, topic-relevant filings. We detect
// the filing year and keep only the most recent instances within a validity
// window (the framework's stated "evidence from the past N years").

const RECENCY_WINDOW_YEARS = parseInt(process.env.DISCOVERY_RECENCY_WINDOW_YEARS || "4", 10);
const MAX_PER_PERIODIC_TYPE = parseInt(process.env.DISCOVERY_MAX_PER_PERIODIC_TYPE || "2", 10);

// Patterns that identify a periodic filing and a normalized "type key" so we can
// keep the newest N of each type rather than the newest N overall.
// v3g (Bugs 3 & 5): authoritative EDGAR form-type per accession, populated by
// enrichEdgarFilingDates() from the submissions API. Lets periodicFilingType
// classify modern EDGAR primary documents (e.g. goog-20241231.htm) that carry no
// form token in the filename — the root cause of the recency gate never grouping
// Alphabet's stale 10-Ks and never recognising Salesforce's FY2025 10-K.
const edgarFormByAccession = new Map<string, string | null>();

function normalizeEdgarForm(form: string): string | null {
  const f = form.toUpperCase().replace(/\s+/g, "");
  if (/^10-?K/.test(f)) return "10-K";
  if (/^20-?F/.test(f)) return "20-F";
  if (/^40-?F/.test(f)) return "40-F";
  if (/^DEF[\s]?14A|^DEFA14A/.test(f)) return "proxy";
  return null; // 10-Q/8-K/6-K/13G etc. are not annual periodic types we gate here
}

function periodicFilingType(url: string, title: string): string | null {
  const s = (url + " " + title).toLowerCase();
  // Proxy / governance circulars (incl. Chinese 股东大会 notices).
  if (/def.?14a|proxy.?statement|agm.?circular|notice.?of.?meeting|股东大会|股東大會/.test(s)) return "proxy";
  if (/10-?k\b|10k|annual.?report.?on.?form.?10-?k/.test(s)) return "10-K";
  if (/20-?f\b|20f/.test(s)) return "20-F";
  if (/40-?f\b/.test(s)) return "40-F";
  // Annual reports across jurisdictions, incl. Chinese 年度报告/年报 and integrated reports.
  if (/annual.?report|integrated.?report|年度报告|年度報告|年报|年報/.test(s)) return "annual-report";

  // v3g (Bugs 3 & 5): EDGAR primary documents named only by period-end date
  // (e.g. /Archives/edgar/data/<cik>/<accession>/goog-20241231.htm) carry no form
  // token in the filename. Resolve the form from the authoritative per-accession
  // form map when available; this is what lets the recency gate group + trim
  // modern 10-Ks and what lets force-include treat the newest one as a 10-K.
  const isEdgarPrimary = /sec\.gov\/archives\/edgar\/data\/\d+\//.test(s) && /\.htm/.test(s) && !/-index\.htm|\/index\.htm/.test(s);
  if (isEdgarPrimary) {
    for (const acc of extractEdgarAccessions(url)) {
      if (edgarFormByAccession.has(acc)) {
        const norm = edgarFormByAccession.get(acc);
        if (norm) return norm;
      }
    }
  }
  return null;
}

// ─── Source-Type Detection (v3e Section 3 + 5) ──────────────────────────────
// TOPIC-AGNOSTIC classification of a document into broad SOURCE TYPES that a
// framework measure can REQUIRE (via framework_measures.required_source_types).
// These are document *categories*, never topic keywords, so the gate works for
// any framework. A document may match several types (e.g. a 10-K is both
// "regulatory-filing" and "10-K" and "annual-report").
export function detectSourceTypes(url: string, title: string): Set<string> {
  const types = new Set<string>();
  const s = (url + " " + (title || "")).toLowerCase();
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* relative/garbage */ }

  // Specific periodic-filing type (10-K / 20-F / 40-F / annual-report / proxy).
  const ptype = periodicFilingType(url, title);
  if (ptype) types.add(ptype);

  // Regulatory primary filings: official securities-regulator portals or filing
  // shapes. Covers SEC EDGAR, cninfo/SSE/SZSE (CN), HKEX, SEDAR (CA), RNS (UK).
  const isRegulatorHost = /(sec\.gov|cninfo\.com\.cn|sse\.com\.cn|szse\.cn|hkexnews\.hk|hkex\.com\.hk|sedarplus\.ca|sedar\.com|nationalstorage|rns-pdf|londonstockexchange)/.test(host);
  const isRegulatoryShape = /10-?k\b|10-?q\b|8-?k\b|20-?f\b|40-?f\b|def.?14a|edgar|年度报告|年度報告|年报|annual.?report.?on.?form/.test(s);
  if (ptype === "10-K" || ptype === "20-F" || ptype === "40-F" || ptype === "proxy" || isRegulatorHost || isRegulatoryShape) {
    types.add("regulatory-filing");

    // v3g (Bug 4): SPLIT the regulatory-filing class by WHO the filer is. A doc on
    // a regulator portal may be filed BY the issuer (10-K/20-F/proxy: authoritative
    // self-disclosure) or merely ABOUT the issuer by a THIRD PARTY (SC 13D/13G &
    // 13F beneficial-ownership, N-PORT/N-Q fund holdings, Form 3/4/5 insider
    // trades, 6-K exhibits). The latter mention the company but are NOT the
    // company's own narrative disclosure, so a measure that needs the issuer's
    // 10-K must NOT be satisfied merely because an ETF's N-PORT names the company.
    // This was the root cause of 360 Security/Meta etc. never abstaining.
    const aboutIssuerForms = /sc[\s_-]?13[dg]\b|schedule[\s_-]?13[dg]|\b13f\b|n-?port|n-?q\b|n-?cen|form[\s_-]?[345]\b|\b6-?k\b|\bs-?8\b|prospectus|424b/i;
    // EDGAR primary-document shape: /Archives/edgar/data/<cik>/<accession>/<file>.htm
    // (e.g. goog-20241231.htm, crm-20250131.htm). These carry no form token in the
    // filename but ARE the issuer's own primary filing document, so count as
    // by-issuer (the recency/type layer disambiguates which form/period).
    const isEdgarPrimaryDoc = /sec\.gov\/archives\/edgar\/data\/\d+\//.test(s) && /\.htm/.test(s) && !/-index\.htm|\/index\.htm/.test(s) && !aboutIssuerForms.test(s);
    const byIssuerForms = ptype === "10-K" || ptype === "20-F" || ptype === "40-F" || ptype === "proxy" ||
      /10-?k\b|10-?q\b|8-?k\b|20-?f\b|40-?f\b|def.?14a|annual.?report.?on.?form/.test(s) ||
      isEdgarPrimaryDoc;
    if (byIssuerForms && !aboutIssuerForms.test(s)) {
      types.add("regulatory-filing-by-issuer");
    } else if (aboutIssuerForms.test(s)) {
      types.add("regulatory-filing-about-issuer");
    } else {
      // On a regulator host but neither clearly by-issuer nor a known third-party
      // form (e.g. a bare EDGAR index page). Treat conservatively as about-issuer
      // so it cannot satisfy a by-issuer requirement on its own.
      types.add("regulatory-filing-about-issuer");
    }
  }

  // Sustainability / ESG / non-financial reports.
  if (/sustainability|esg|csr|responsibility|impact.?report|tcfd|gri|climate.?report/.test(s)) {
    types.add("sustainability-report");
  }

  // Press releases / news.
  if (/press.?release|news|newsroom|media\b|announcement/.test(s)) types.add("press-release");

  // Investor-relations material.
  if (/investor|\bir\b|ir\.|earnings|presentation|fact.?sheet/.test(s)) types.add("investor-relations");

  // Policy / governance documents on the company's own site.
  if (/policy|governance|charter|code.?of.?conduct|framework|principles|guidelines/.test(s)) types.add("policy");

  return types;
}

// Aggregate the set of source types present across a company's fetched corpus.
export function corpusSourceTypes(docs: Array<{ url: string; title?: string | null }>): Set<string> {
  const all = new Set<string>();
  for (const d of docs) {
    for (const t of detectSourceTypes(d.url, d.title || "")) all.add(t);
  }
  return all;
}

// In-process cache of authoritative EDGAR filing dates, keyed by 18-digit dashless
// accession. Populated by enrichEdgarFilingDates() (Section 1) so the synchronous
// recency gate can read authoritative years without per-call network I/O.
const edgarFilingYearByAccession = new Map<string, number | null>();

// Extract any EDGAR accession numbers (both dashed and 18-digit dashless forms)
// present in a URL. Returns the normalized 18-digit dashless accession strings.
export function extractEdgarAccessions(url: string): string[] {
  const out = new Set<string>();
  // Dashed: NNNNNNNNNN-YY-NNNNNN
  for (const m of url.matchAll(/(\d{10})-(\d{2})-(\d{6})/g)) {
    out.add(`${m[1]}${m[2]}${m[3]}`);
  }
  // Dashless 18-digit block (EDGAR archive folder form), but NOT part of a longer
  // digit run (avoid matching arbitrary 18+ digit ids).
  for (const m of url.matchAll(/(?<!\d)(\d{18})(?!\d)/g)) {
    out.add(m[1]);
  }
  return Array.from(out);
}

// Best-effort extraction of the filing/publication year from the URL or title.
// v3e (Section 1): now handles the 18-digit DASHLESS EDGAR accession form
// (the canonical archive-folder shape, e.g. .../data/<cik>/000162828025002993/...)
// in addition to the dashed form, compact period-end dates, and bare years.
// PRECEDENCE: authoritative cached EDGAR date > accession-derived year >
// compact period-end year > bare 4-digit year. Bare years are only used as a last
// resort and we take the MAX among them; structured sources are preferred so a
// spurious year in a title cannot inflate recency.
export function detectFilingYear(url: string, title: string): number | null {
  const nowYear = new Date().getFullYear();
  const u = url.toLowerCase();
  const t = (title || "").toLowerCase();
  const yearFromYY = (yy: number) => (yy <= (nowYear % 100) + 1 ? 2000 + yy : 1900 + yy);
  const plausible = (y: number) => y >= 2000 && y <= nowYear + 1;

  // 0) Authoritative EDGAR date, if we have pre-resolved it for an accession here.
  for (const acc of extractEdgarAccessions(url)) {
    if (edgarFilingYearByAccession.has(acc)) {
      const y = edgarFilingYearByAccession.get(acc);
      if (y != null && plausible(y)) return y; // authoritative wins outright
    }
  }

  // 1) EDGAR accession-derived year (structured, authoritative-ish).
  //    Dashed: NNNNNNNNNN-YY-NNNNNN ; Dashless 18-digit: chars 11-12 are the YY.
  const accessionYears: number[] = [];
  for (const m of u.matchAll(/\d{10}-(\d{2})-\d{6}/g)) {
    const y = yearFromYY(parseInt(m[1], 10));
    if (plausible(y)) accessionYears.push(y);
  }
  for (const m of u.matchAll(/(?<!\d)\d{10}(\d{2})\d{6}(?!\d)/g)) {
    const y = yearFromYY(parseInt(m[1], 10));
    if (plausible(y)) accessionYears.push(y);
  }
  if (accessionYears.length > 0) return Math.max(...accessionYears);

  // 2) Compact period-end dates: 8 digits YYYYMMDD where YYYY is plausible.
  const periodYears: number[] = [];
  for (const m of u.matchAll(/(20[0-3]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/g)) {
    const y = parseInt(m[1], 10);
    if (plausible(y)) periodYears.push(y);
  }
  if (periodYears.length > 0) return Math.max(...periodYears);

  // 3) Bare 4-digit years anywhere in url or title (last resort).
  const bareYears: number[] = [];
  for (const src of [u, t]) {
    for (const m of src.matchAll(/\b(20[0-3]\d)\b/g)) {
      const y = parseInt(m[1], 10);
      if (plausible(y)) bareYears.push(y);
    }
  }
  if (bareYears.length === 0) return null;
  return Math.max(...bareYears);
}

// v3e (Section 1): authoritatively resolve EDGAR filing dates for any accession
// numbers present in the given URLs and cache them, so the synchronous recency
// gate uses the REAL filing date rather than guessing from the URL/title. Uses
// the public EDGAR full-text search API (efts) already relied on elsewhere. Safe
// and best-effort: any failure simply leaves the URL on the existing heuristics.
export async function enrichEdgarFilingDates(urls: string[]): Promise<void> {
  const SEC_UA = process.env.SEC_USER_AGENT || "CompanyIQ Research admin@companyiq.example";
  const pending = new Set<string>();
  for (const url of urls) {
    for (const acc of extractEdgarAccessions(url)) {
      if (!edgarFilingYearByAccession.has(acc)) pending.add(acc);
    }
  }
  if (pending.size === 0) return;
  const nowYear = new Date().getFullYear();
  for (const acc of pending) {
    const dashed = `${acc.slice(0, 10)}-${acc.slice(10, 12)}-${acc.slice(12)}`;
    let resolvedYear: number | null = null;
    let resolvedForm: string | null = null;
    for (let attempt = 0; attempt < 3 && resolvedYear === null; attempt++) {
      try {
        const resp = await axios.get("https://efts.sec.gov/LATEST/search-index", {
          params: { q: `"${dashed}"` },
          headers: { "User-Agent": SEC_UA, Accept: "application/json" },
          timeout: 12000,
          validateStatus: () => true,
        });
        if (resp.status === 200 && resp.data?.hits?.hits?.length) {
          const src = resp.data.hits.hits[0]._source || {};
          const dateStr: string | undefined = src.file_date || src.filed || src.filing_date;
          if (dateStr && /^\d{4}/.test(dateStr)) {
            const y = parseInt(dateStr.slice(0, 4), 10);
            if (y >= 2000 && y <= nowYear + 1) resolvedYear = y;
          }
          // v3g (Bugs 3 & 5): also capture the authoritative FORM TYPE so modern
          // EDGAR primary documents (date-only filenames) can be classified.
          const formRaw: string | undefined = (Array.isArray(src.file_type) ? src.file_type[0] : src.file_type) ||
            (Array.isArray(src.root_form) ? src.root_form[0] : src.root_form) || src.form || src.type;
          if (formRaw) resolvedForm = normalizeEdgarForm(String(formRaw));
          break; // got a hit (even if no usable date) — stop retrying
        } else if (resp.status >= 500) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // backoff on 5xx
          continue;
        } else {
          break; // 4xx / no hits — nothing to retry
        }
      } catch {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    // Cache the results (including null) so we don't repeatedly hit a missing one.
    edgarFilingYearByAccession.set(acc, resolvedYear);
    edgarFormByAccession.set(acc, resolvedForm);
    if (resolvedYear !== null || resolvedForm !== null) {
      console.log(`[recency] EDGAR authoritative for ${dashed}: year=${resolvedYear ?? "?"} form=${resolvedForm ?? "?"}`);
    }
  }
}

/**
 * Layer A — Recency gate.
 * For periodic filing types, drop instances older than the validity window and
 * keep at most MAX_PER_PERIODIC_TYPE of the most recent instances per type.
 * Non-periodic documents (policies, IR pages, ESG, governance, etc.) are never
 * dropped here — only the historical-filing flood is trimmed.
 * Filings whose year cannot be determined are kept (fail-open), but de-prioritized
 * slightly so dated ones don't outrank clearly-recent ones.
 */
export function applyRecencyGate<T extends { url: string; title: string; priority: number }>(
  documents: T[],
  opts?: { windowYears?: number; maxPerType?: number; nowYear?: number }
): { kept: T[]; dropped: T[] } {
  const windowYears = opts?.windowYears ?? RECENCY_WINDOW_YEARS;
  const maxPerType = opts?.maxPerType ?? MAX_PER_PERIODIC_TYPE;
  const nowYear = opts?.nowYear ?? new Date().getFullYear();
  const minYear = nowYear - windowYears + 1; // inclusive lower bound

  const kept: T[] = [];
  const dropped: T[] = [];
  // Group periodic filings by type to keep newest-N-per-type.
  const periodicByType = new Map<string, Array<{ doc: T; year: number | null }>>();

  for (const doc of documents) {
    const ptype = periodicFilingType(doc.url, doc.title);
    if (!ptype) { kept.push(doc); continue; }
    const year = detectFilingYear(doc.url, doc.title);
    if (!periodicByType.has(ptype)) periodicByType.set(ptype, []);
    periodicByType.get(ptype)!.push({ doc, year });
  }

  for (const [ptype, entries] of periodicByType) {
    // Sort newest-first; unknown years sink to the bottom (treated as oldest).
    entries.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    let keptOfType = 0;
    for (const { doc, year } of entries) {
      const withinWindow = year === null ? true : year >= minYear;
      if (keptOfType < maxPerType && withinWindow) {
        kept.push(doc);
        keptOfType++;
      } else {
        dropped.push(doc);
        // v3g (Bug 3): make every recency-gate drop explicit and auditable so a
        // stale filing that survives (or a fresh one that is wrongly dropped) is
        // visible in logs rather than silent.
        const reason = !withinWindow ? `older than window (year=${year ?? "?"} < ${minYear})` : `exceeds max ${maxPerType} per ${ptype}`;
        console.log(`[recency] DROP ${ptype} (year=${year ?? "?"}): ${reason} — ${doc.url}`);
      }
    }
    if (keptOfType > 0) {
      console.log(`[recency] kept ${keptOfType}/${entries.length} of type ${ptype} (window>=${minYear}, max ${maxPerType})`);
    }
  }

  return { kept, dropped };
}

// ─── URL Deny List (Hard Block at Retrieval) ───────────────────────────────
// These URLs are NEVER useful for corporate disclosure analysis.
// They are excluded before entering the candidate pool.

const DENY_LIST_DOMAINS = [
  // Podcast / media platforms
  "podcasts.apple.com", "music.apple.com", "apps.apple.com", "itunes.apple.com",
  "open.spotify.com", "soundcloud.com", "anchor.fm", "podcasts.google.com",
  // App stores
  "play.google.com", "store.steampowered.com", "apps.microsoft.com",
  // Social media (non-corporate)
  "tiktok.com", "pinterest.com", "tumblr.com", "reddit.com", "quora.com",
  // Job boards
  "indeed.com", "glassdoor.com", "linkedin.com/jobs", "ziprecruiter.com",
  "lever.co", "greenhouse.io", "workday.com/en-us/careers",
  // Generic aggregators / wikis
  "wikipedia.org", "wikimedia.org", "fandom.com",
  // Video platforms (unless corporate channel)
  "youtube.com/watch", "vimeo.com",
  // Academic / non-corporate
  "arxiv.org", "ssrn.com", "researchgate.net",
  // E-commerce
  "amazon.com/dp", "amazon.com/gp", "ebay.com",
  // News aggregators (not primary sources)
  "news.google.com", "news.yahoo.com",
];

const DENY_LIST_PATH_PATTERNS = [
  /\/jobs\//i, /\/careers\//i, /\/job-listing/i,
  /\/recipe/i, /\/shop\//i, /\/store\//i,
  /\/playlist/i, /\/episode/i, /\/podcast/i,
];

function isUrlDenied(urlLower: string): boolean {
  if (DENY_LIST_DOMAINS.some(d => urlLower.includes(d))) return true;
  if (DENY_LIST_PATH_PATTERNS.some(p => p.test(urlLower))) return true;
  return false;
}

// ─── Coverage Metric ───────────────────────────────────────────────────────

export interface CoverageMetric {
  tier1Count: number; // 10-K, proxy, annual report
  tier2Count: number; // IR, governance, AI policy, press
  tier3Count: number; // ESG, sustainability
  tier4Count: number; // Noise (should be 0 after filtering)
  has10KOrAnnualReport: boolean;
  hasProxyOrDEF14A: boolean;
  hasInvestorPresentation: boolean;
  hasGovernancePage: boolean;
  hasAIPolicy: boolean;
  coverageLevel: "full" | "adequate" | "low" | "minimal";
  missingTier1Types: string[];
}

export function computeCoverageMetric(documents: DiscoveryCandidate[]): CoverageMetric {
  let tier1Count = 0, tier2Count = 0, tier3Count = 0, tier4Count = 0;
  let has10KOrAnnualReport = false;
  let hasProxyOrDEF14A = false;
  let hasInvestorPresentation = false;
  let hasGovernancePage = false;
  let hasAIPolicy = false;

  for (const doc of documents) {
    const tier = classifyDocumentTier(doc.url, doc.title);
    const urlLower = doc.url.toLowerCase();
    const titleLower = doc.title.toLowerCase();

    switch (tier) {
      case 1: tier1Count++; break;
      case 2: tier2Count++; break;
      case 3: tier3Count++; break;
      case 4: tier4Count++; break;
    }

    // Specific type detection
    if (/10-?k|20-?f|annual.?report|integrated.?report/i.test(urlLower + " " + titleLower)) {
      has10KOrAnnualReport = true;
    }
    if (/def.?14a|proxy.?statement|agm.?circular/i.test(urlLower + " " + titleLower)) {
      hasProxyOrDEF14A = true;
    }
    if (/investor.?presentation|investor.?day|capital.?markets/i.test(urlLower + " " + titleLower)) {
      hasInvestorPresentation = true;
    }
    if (/governance|board.?of.?directors/i.test(urlLower + " " + titleLower)) {
      hasGovernancePage = true;
    }
    if (/responsible.?ai|ai.?policy|ai.?ethics|ai.?principles/i.test(urlLower + " " + titleLower)) {
      hasAIPolicy = true;
    }
  }

  // Determine coverage level
  const missingTier1Types: string[] = [];
  if (!has10KOrAnnualReport) missingTier1Types.push("10-K / Annual Report");
  if (!hasProxyOrDEF14A) missingTier1Types.push("Proxy / DEF 14A");

  let coverageLevel: "full" | "adequate" | "low" | "minimal";
  if (has10KOrAnnualReport && hasProxyOrDEF14A && (hasInvestorPresentation || hasGovernancePage)) {
    coverageLevel = "full";
  } else if (has10KOrAnnualReport || hasProxyOrDEF14A) {
    coverageLevel = "adequate";
  } else if (tier1Count > 0 || tier2Count >= 3) {
    coverageLevel = "low";
  } else {
    coverageLevel = "minimal";
  }

  return {
    tier1Count, tier2Count, tier3Count, tier4Count,
    has10KOrAnnualReport, hasProxyOrDEF14A, hasInvestorPresentation,
    hasGovernancePage, hasAIPolicy,
    coverageLevel, missingTier1Types,
  };
}

// ─── Sector-Specific Source Augmentation ───────────────────────────────────

// ─── Universal Disclosure Queries (Lane 10a — runs for ALL companies) ────────
// These are document types and disclosure formats that exist across all sectors.
// Previously some were incorrectly gated behind sector checks.

function buildUniversalDisclosureQueries(
  companyName: string,
  framework: Framework
): string[] {
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();
  const frameworkName = (framework.name || "").toLowerCase();
  const queries: string[] = [];

  const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);

  // Capital markets day / investor day / strategy day — every sector holds these
  queries.push(
    `"${companyName}" capital markets day 2024 OR 2025 OR 2023`,
    `"${companyName}" strategy day OR technology day OR innovation day`,
  );

  // Risk management framework — universal
  queries.push(
    `"${companyName}" risk management framework 2024 OR 2023`,
  );

  // Digital transformation / technology strategy — universal
  queries.push(
    `"${companyName}" digital transformation strategy`,
    `"${companyName}" technology strategy OR technology investment`,
  );

  // Responsible AI / AI governance — relevant for ANY company using AI, not just tech
  if (isAIRelated) {
    queries.push(
      `"${companyName}" responsible AI report OR responsible AI principles`,
      `"${companyName}" AI governance framework OR AI policy`,
      `"${companyName}" AI safety OR AI ethics OR AI transparency`,
      `"${companyName}" AI impact assessment OR model card`,
      `"${companyName}" operational resilience AI OR automation`,
      `"${companyName}" predictive maintenance AI OR machine learning`,
      `"${companyName}" digital operations AI OR automation`,
    );
  }

  // Regulatory submissions — universal (every regulated company files with some authority)
  queries.push(
    `"${companyName}" regulatory submission OR regulatory filing 2024 OR 2023`,
  );

  return queries;
}

// ─── Sector-Specific Queries (Lane 10b — only for terminology unique to a sector) ──
// These queries use terminology that is genuinely specific to one sector and would
// produce noise or irrelevant results if applied to other sectors.

function buildSectorSpecificQueries(
  companyName: string,
  sector: string | null | undefined,
  framework: Framework
): string[] {
  if (!sector) return [];
  const sectorLower = sector.toLowerCase();
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();
  const queries: string[] = [];

  // Financials: Pillar 3 (Basel III specific), CCAR/DFAST stress testing, Solvency II
  if (/financ|bank|insurance|asset.?manage/i.test(sectorLower)) {
    queries.push(
      `"${companyName}" Pillar 3 disclosure 2024 OR 2023`,
      `"${companyName}" operational risk OR model risk management`,
    );
    if (/ai|artificial|machine/i.test(topic)) {
      queries.push(
        `"${companyName}" model risk management AI OR "machine learning" SR 11-7`,
      );
    }
  }

  // Pharma / Healthcare: R&D day, pipeline day, FDA-specific terminology
  if (/pharma|health|biotech|life.?science|medical/i.test(sectorLower)) {
    queries.push(
      `"${companyName}" R&D day OR research day OR pipeline day presentation`,
      `"${companyName}" science day presentation`,
    );
    if (/ai|artificial|machine/i.test(topic)) {
      queries.push(
        `"${companyName}" AI drug discovery OR clinical AI`,
        `"${companyName}" real world evidence AI OR machine learning`,
      );
    }
  }

  // Industrials: OT-specific terminology
  if (/industrial|manufactur|engineer|aerospace|defense|auto/i.test(sectorLower)) {
    queries.push(
      `"${companyName}" operational technology OT strategy`,
    );
    if (/ai|artificial|machine/i.test(topic)) {
      queries.push(
        `"${companyName}" autonomous systems OR digital twin`,
      );
    }
  }

  // Energy / Utilities: Grid-specific, exploration-specific
  if (/energy|utilit|oil|gas|mining|basic.?material/i.test(sectorLower)) {
    if (/ai|artificial|machine/i.test(topic)) {
      queries.push(
        `"${companyName}" grid optimization AI OR predictive analytics`,
        `"${companyName}" exploration technology AI OR seismic interpretation`,
      );
    }
  }

  // Real Estate: PropTech-specific
  if (/real.?estate|property|reit/i.test(sectorLower)) {
    if (/ai|artificial|machine/i.test(topic)) {
      queries.push(
        `"${companyName}" smart building AI OR proptech`,
      );
    }
  }

  return queries;
}

// ─── Search API Keys ────────────────────────────────────────────────────────

function getSerperApiKey(): string | null {
  return process.env.SERPER_API_KEY || null;
}

function getSerpApiKey(): string | null {
  return process.env.SERP_API_KEY || null;
}

// ─── Search Provider (Serper.dev primary, SerpAPI fallback) ─────────────────

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

async function webSearchSerper(
  query: string,
  apiKey: string,
  opts: { num?: number; tbs?: string; gl?: string; hl?: string } = {}
): Promise<SearchResult[]> {
  const body: any = {
    q: query,
    num: opts.num || 10,
  };
  // Map tbs (time-based search) to Serper's tbs parameter
  if (opts.tbs) body.tbs = opts.tbs;
  // Localization: gl = country code, hl = interface language
  if (opts.gl) body.gl = opts.gl;
  if (opts.hl) body.hl = opts.hl;

  const response = await axios.post("https://google.serper.dev/search", body, {
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    timeout: SEARCH_TIMEOUT,
  });

  const organic = response.data.organic || [];
  return organic.map((r: any, idx: number) => ({
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
    position: r.position || idx + 1,
  }));
}

async function webSearchSerpApi(
  query: string,
  apiKey: string,
  opts: { num?: number; tbs?: string; gl?: string; hl?: string } = {}
): Promise<SearchResult[]> {
  const params: any = {
    q: query,
    api_key: apiKey,
    engine: "google",
    num: opts.num || 10,
  };
  if (opts.tbs) params.tbs = opts.tbs;
  // Localization: gl = country code, hl = interface language
  if (opts.gl) params.gl = opts.gl;
  if (opts.hl) params.hl = opts.hl;

  const response = await axios.get("https://serpapi.com/search.json", {
    params,
    timeout: SEARCH_TIMEOUT,
  });

  const organic = response.data.organic_results || [];
  return organic.map((r: any, idx: number) => ({
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
    position: r.position || idx + 1,
  }));
}

async function webSearch(
  query: string,
  opts: { num?: number; tbs?: string; gl?: string; hl?: string } = {}
): Promise<SearchResult[]> {
  // Try Serper.dev first (cheaper, faster), fall back to SerpAPI
  const serperKey = getSerperApiKey();
  const serpApiKey = getSerpApiKey();

  if (serperKey) {
    try {
      return await webSearchSerper(query, serperKey, opts);
    } catch (error: any) {
      console.warn(`[Discovery] Serper.dev failed for "${query}": ${error.message}`);
      // Fall through to SerpAPI
    }
  }

  if (serpApiKey) {
    try {
      return await webSearchSerpApi(query, serpApiKey, opts);
    } catch (error: any) {
      console.warn(`[Discovery] SerpAPI failed for "${query}": ${error.message}`);
      return [];
    }
  }

  console.error("[Discovery] No search API key configured (SERPER_API_KEY or SERP_API_KEY)");
  return [];
}

// ─── Query Variant Generation ───────────────────────────────────────────────

async function generateQueryVariants(
  companyName: string,
  baseQueries: string[],
  numVariants: number,
  framework: Framework
): Promise<string[]> {
  if (numVariants <= 0) return [];

  try {
    const topicDesc = framework.topicDescription || framework.name;
    const { text } = await completeWithFallback("deepseek", {
      system: `You generate search query variants for corporate document discovery. Given base search queries about a company, generate alternative phrasings that would find the same or similar documents but using different keywords, synonyms, or angles. Focus on finding documents relevant to: ${topicDesc}. Generate queries that target the specific topic — do NOT default to generic sustainability/ESG queries unless the topic is explicitly about sustainability.`,
      prompt: `Company: ${companyName}
Topic: ${topicDesc}

Base queries:
${baseQueries.slice(0, 4).map((q, i) => `${i + 1}. ${q}`).join("\n")}

Generate ${numVariants} alternative search queries that would find corporate disclosure documents relevant to the topic described above. Use different keywords, synonyms, or angles specific to that topic. Return ONLY a JSON array of strings.

IMPORTANT: The queries MUST be relevant to the topic "${framework.name}". Do NOT generate generic sustainability/ESG queries unless that IS the topic.`,
      json: true,
      maxTokens: 500,
    });

    const variants = JSON.parse(text);
    if (Array.isArray(variants)) {
      return variants.slice(0, numVariants * 2); // Allow up to 2x variants
    }
    return [];
  } catch (error: any) {
    console.warn(`[Discovery] Query variant generation failed: ${error.message}`);
    return [];
  }
}

// ─── Query Construction ──────────────────────────────────────────────────────

interface DiscoveryCandidate {
  url: string;
  title: string;
  snippet: string;
  lane: string;
  priority: number;
}

function buildGeneralQueries(companyName: string, framework: Framework): string[] {
  const topic = framework.topicDescription || framework.name;
  const frameworkName = (framework.name || "").toLowerCase();
  
  // If framework has explicit search templates, use them
  if (framework.searchTemplates && framework.searchTemplates.length > 0) {
    return framework.searchTemplates.map((t) => t.replace(/\{company\}/g, companyName));
  }
  
  // Otherwise generate topic-aware fallback queries
  const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);
  const isClimateRelated = /climate|emission|carbon|net.?zero|fossil|coal|energy transition/i.test(topic);
  
  if (isAIRelated) {
    return [
      `"${companyName}" AI strategy`,
      `"${companyName}" artificial intelligence governance`,
      `"${companyName}" responsible AI`,
      `"${companyName}" AI policy`,
      `"${companyName}" AI annual report`,
      `"${companyName}" machine learning governance`,
    ];
  } else if (isClimateRelated) {
    return [
      `"${companyName}" sustainability report`,
      `"${companyName}" climate report`,
      `"${companyName}" TCFD report`,
      `"${companyName}" net zero target`,
      `"${companyName}" transition plan`,
      `"${companyName}" emissions report`,
    ];
  } else {
    // Generic fallback using topic words
    return [
      `"${companyName}" ${topic}`,
      `"${companyName}" annual report`,
      `"${companyName}" governance`,
      `"${companyName}" policy framework`,
      `"${companyName}" corporate responsibility report`,
      `"${companyName}" ESG report`,
    ];
  }
}

/**
 * Multi-Document Sourcing Expansion
 * 
 * Generates additional search queries targeting three distinct document classes
 * beyond the main sustainability/climate report:
 * 1. Specialized Policies: Environmental & Social Risk frameworks, coal policies,
 *    fossil fuel exclusion policies, sector-specific policies
 * 2. Ancillary Disclosures: Sustainable finance frameworks, investor presentations,
 *    press releases announcing targets, transition plans
 * 3. Regulatory Filings: TCFD reports, CDP responses, transition plan disclosures
 * 
 * This addresses the systematic sourcing gap where evidence is scattered across
 * multiple documents (e.g., coal exclusion in E&S policy, sustainable finance
 * targets in investor presentations, not in the main climate report).
 */
function buildMultiDocumentQueries(companyName: string, framework: Framework): string[] {
  const queries: string[] = [];
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();

  // Topic-gated queries for relevance (not memory — server has 8GB)
  const isClimateRelated = /climate|emission|carbon|net.?zero|fossil|coal|energy transition/i.test(topic);
  const isESGBroad = /esg|sustainability|environmental|social|governance/i.test(topic);

  if (isClimateRelated) {
    // Class 1: Specialized Policy Documents
    queries.push(
      `"${companyName}" environmental social policy framework`,
      `"${companyName}" fossil fuel policy OR coal policy`,
      `"${companyName}" sector exclusion policy`,
      `"${companyName}" environmental and social risk framework`,
      `"${companyName}" responsible lending policy`,
    );

    // Class 2: Ancillary Disclosures & Announcements
    queries.push(
      `"${companyName}" sustainable finance target OR green bond framework`,
      `"${companyName}" transition plan OR climate transition`,
      `"${companyName}" 2030 target announcement OR interim target`,
      `"${companyName}" financed emissions target OR net zero commitment`,
      `"${companyName}" investor presentation climate`,
    );

    // Class 3: Regulatory & Voluntary Framework Filings
    queries.push(
      `"${companyName}" TCFD report OR climate-related financial disclosures`,
      `"${companyName}" CDP climate response OR CDP submission`,
      `"${companyName}" NZBA progress report OR net-zero banking`,
    );
  } else if (isESGBroad) {
    // Broader ESG policy documents
    queries.push(
      `"${companyName}" sustainable finance framework OR green bond framework`,
      `"${companyName}" sustainability report 2024 OR sustainability report 2023`,
      `"${companyName}" ESG policy framework OR responsible investment`,
      `"${companyName}" TCFD report OR climate-related financial disclosures`,
      `"${companyName}" CDP response OR sustainability disclosure`,
    );
  } else {
    // Topic-aware multi-document expansion for non-climate/ESG topics
    // Extract meaningful topic keywords for search
    const topicWords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(" ");
    const frameworkName = (framework.name || "").toLowerCase();

    // AI/Technology-specific queries
    const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);
    if (isAIRelated) {
      // Class 1: AI Policy & Governance Documents
      queries.push(
        `"${companyName}" responsible AI policy OR AI ethics policy`,
        `"${companyName}" AI governance framework OR AI principles`,
        `"${companyName}" artificial intelligence strategy OR AI roadmap`,
        `"${companyName}" AI risk management OR AI risk framework`,
        `"${companyName}" AI transparency report OR algorithmic accountability`,
      );
      // Class 2: AI Deployment & Use Cases
      queries.push(
        `"${companyName}" AI use cases OR machine learning deployment`,
        `"${companyName}" generative AI OR large language model`,
        `"${companyName}" AI investment OR AI budget OR AI spending`,
        `"${companyName}" AI partnership OR AI collaboration`,
      );
      // Class 3: AI Governance & Oversight
      queries.push(
        `"${companyName}" AI board oversight OR AI committee`,
        `"${companyName}" chief AI officer OR head of AI`,
        `"${companyName}" AI bias OR AI fairness OR AI audit`,
        `"${companyName}" EU AI Act compliance OR AI regulation`,
      );
    } else {
      // Generic topic-aware queries
      queries.push(
        `"${companyName}" ${topicWords} policy OR framework`,
        `"${companyName}" ${topicWords} report OR disclosure`,
        `"${companyName}" ${topicWords} governance OR strategy`,
        `"${companyName}" ${topicWords} annual report`,
        `"${companyName}" ${topicWords} risk management`,
      );
    }
  }

  return queries;
}

function buildDomainQueries(companyName: string, domain: string, framework: Framework): string[] {
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();
  const frameworkName = (framework.name || "").toLowerCase();

  // Always include generic corporate disclosure queries
  const baseQueries = [
    `site:${domain} annual report`,
    `site:${domain} governance`,
    `site:${domain} policy`,
    `site:${domain}/investors`,
  ];

  // Topic-specific domain queries
  const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);
  const isClimateRelated = /climate|emission|carbon|net.?zero|fossil|coal|energy transition/i.test(topic);
  const isESGBroad = /esg|sustainability|environmental|social/i.test(topic);

  if (isAIRelated) {
    baseQueries.push(
      `site:${domain} responsible AI`,
      `site:${domain} AI policy`,
      `site:${domain} artificial intelligence`,
      `site:${domain} AI ethics`,
      `site:${domain} AI governance`,
      `site:${domain} AI principles`,
      `site:${domain} machine learning`,
      `site:${domain} AI risk`,
      `site:${domain} AI transparency`,
      `site:${domain} data privacy AI`,
      `site:${domain} AI strategy`,
      `site:${domain} generative AI`,
    );
  } else if (isClimateRelated) {
    baseQueries.push(
      `site:${domain} sustainability report`,
      `site:${domain} ESG`,
      `site:${domain} climate report`,
      `site:${domain} TCFD`,
      `site:${domain} net zero`,
      `site:${domain} emissions`,
      `site:${domain} transition plan`,
    );
  } else if (isESGBroad) {
    baseQueries.push(
      `site:${domain} sustainability report`,
      `site:${domain} ESG`,
      `site:${domain} corporate responsibility`,
      `site:${domain} sustainability`,
    );
  } else {
    // Generic topic-aware queries
    const topicWords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(" ");
    baseQueries.push(
      `site:${domain} ${topicWords}`,
      `site:${domain} sustainability report`,
      `site:${domain} ESG`,
    );
  }

  return baseQueries;
}

function buildTrustedSourceQueries(companyName: string, sources: TrustedSource[]): string[] {
  return sources
    .filter((s) => s.isActive)
    .map((s) => `site:${s.domain} "${companyName}"`);
}

// ─── Multilingual / Localized Sourcing ───────────────────────────────────────

/**
 * Maps a company's country (free-text name or ISO-2/ISO-3 code) to a Google
 * locale (gl), interface language (hl), and a set of native-language AI search
 * terms. Used to localize discovery so non-English issuers' AI disclosures
 * (which often live in local-language filings) are surfaced.
 *
 * Keyed by lowercase country identifiers. Returns null for US/UK/other English
 * markets where the default English lanes already provide full coverage.
 */
interface LocaleProfile {
  gl: string; // Google country code
  hl: string; // Google interface language
  lang: string; // human-readable language label
  aiTerms: string[]; // native-language AI / strategy / governance terms
  reportTerms: string[]; // native-language annual report / filing terms
}

const LOCALE_PROFILES: Record<string, LocaleProfile> = {
  france: { gl: "fr", hl: "fr", lang: "French", aiTerms: ["intelligence artificielle", "IA strat\u00e9gie", "gouvernance de l'IA", "IA responsable"], reportTerms: ["document d'enregistrement universel", "rapport annuel"] },
  germany: { gl: "de", hl: "de", lang: "German", aiTerms: ["k\u00fcnstliche Intelligenz", "KI-Strategie", "KI-Governance", "verantwortungsvolle KI"], reportTerms: ["Gesch\u00e4ftsbericht", "Jahresabschluss"] },
  switzerland: { gl: "ch", hl: "de", lang: "German/French", aiTerms: ["k\u00fcnstliche Intelligenz", "intelligence artificielle", "KI-Strategie"], reportTerms: ["Gesch\u00e4ftsbericht", "rapport annuel"] },
  spain: { gl: "es", hl: "es", lang: "Spanish", aiTerms: ["inteligencia artificial", "estrategia de IA", "gobernanza de la IA", "IA responsable"], reportTerms: ["informe anual", "cuentas anuales"] },
  mexico: { gl: "mx", hl: "es", lang: "Spanish", aiTerms: ["inteligencia artificial", "estrategia de IA", "gobernanza de la IA"], reportTerms: ["informe anual"] },
  italy: { gl: "it", hl: "it", lang: "Italian", aiTerms: ["intelligenza artificiale", "strategia di IA", "governance dell'IA"], reportTerms: ["relazione annuale", "bilancio"] },
  brazil: { gl: "br", hl: "pt", lang: "Portuguese", aiTerms: ["intelig\u00eancia artificial", "estrat\u00e9gia de IA", "governan\u00e7a de IA"], reportTerms: ["relat\u00f3rio anual"] },
  portugal: { gl: "pt", hl: "pt", lang: "Portuguese", aiTerms: ["intelig\u00eancia artificial", "estrat\u00e9gia de IA"], reportTerms: ["relat\u00f3rio anual"] },
  netherlands: { gl: "nl", hl: "nl", lang: "Dutch", aiTerms: ["kunstmatige intelligentie", "AI-strategie", "AI-governance"], reportTerms: ["jaarverslag"] },
  japan: { gl: "jp", hl: "ja", lang: "Japanese", aiTerms: ["\u4eba\u5de5\u77e5\u80fd", "AI\u6226\u7565", "AI\u30ac\u30d0\u30ca\u30f3\u30b9", "\u8cac\u4efb\u3042\u308bAI"], reportTerms: ["\u6709\u4fa1\u8a3c\u5238\u5831\u544a\u66f8", "\u7d71\u5408\u5831\u544a\u66f8"] },
  china: { gl: "cn", hl: "zh-cn", lang: "Chinese", aiTerms: ["\u4eba\u5de5\u667a\u80fd", "AI\u6218\u7565", "\u4eba\u5de5\u667a\u80fd\u6cbb\u7406"], reportTerms: ["\u5e74\u5ea6\u62a5\u544a", "\u5e74\u62a5"] },
  "hong kong": { gl: "hk", hl: "zh-tw", lang: "Chinese", aiTerms: ["\u4eba\u5de5\u667a\u80fd", "AI\u6230\u7565"], reportTerms: ["\u5e74\u5831", "\u5e74\u5ea6\u5831\u544a"] },
  taiwan: { gl: "tw", hl: "zh-tw", lang: "Chinese", aiTerms: ["\u4eba\u5de5\u667a\u6167", "AI\u7b56\u7565"], reportTerms: ["\u5e74\u5831"] },
  "south korea": { gl: "kr", hl: "ko", lang: "Korean", aiTerms: ["\uc778\uacf5\uc9c0\ub2a5", "AI \uc804\ub7b5", "AI \uac70\ubc84\ub10c\uc2a4"], reportTerms: ["\uc0ac\uc5c5\ubcf4\uace0\uc11c", "\uc5f0\ucc28\ubcf4\uace0\uc11c"] },
  korea: { gl: "kr", hl: "ko", lang: "Korean", aiTerms: ["\uc778\uacf5\uc9c0\ub2a5", "AI \uc804\ub7b5"], reportTerms: ["\uc0ac\uc5c5\ubcf4\uace0\uc11c"] },
  sweden: { gl: "se", hl: "sv", lang: "Swedish", aiTerms: ["artificiell intelligens", "AI-strategi"], reportTerms: ["\u00e5rsredovisning"] },
  finland: { gl: "fi", hl: "fi", lang: "Finnish", aiTerms: ["teko\u00e4ly", "teko\u00e4lystrategia"], reportTerms: ["vuosikertomus"] },
  denmark: { gl: "dk", hl: "da", lang: "Danish", aiTerms: ["kunstig intelligens", "AI-strategi"], reportTerms: ["\u00e5rsrapport"] },
  norway: { gl: "no", hl: "no", lang: "Norwegian", aiTerms: ["kunstig intelligens", "KI-strategi"], reportTerms: ["\u00e5rsrapport"] },
  belgium: { gl: "be", hl: "nl", lang: "Dutch/French", aiTerms: ["kunstmatige intelligentie", "intelligence artificielle"], reportTerms: ["jaarverslag", "rapport annuel"] },
  austria: { gl: "at", hl: "de", lang: "German", aiTerms: ["k\u00fcnstliche Intelligenz", "KI-Strategie"], reportTerms: ["Gesch\u00e4ftsbericht"] },
};

// ISO-2 / ISO-3 code aliases mapping to the country keys above
const COUNTRY_CODE_ALIASES: Record<string, string> = {
  fr: "france", fra: "france",
  de: "germany", deu: "germany",
  ch: "switzerland", che: "switzerland",
  es: "spain", esp: "spain",
  mx: "mexico", mex: "mexico",
  it: "italy", ita: "italy",
  br: "brazil", bra: "brazil",
  pt: "portugal", prt: "portugal",
  nl: "netherlands", nld: "netherlands",
  jp: "japan", jpn: "japan",
  cn: "china", chn: "china",
  hk: "hong kong", hkg: "hong kong",
  tw: "taiwan", twn: "taiwan",
  kr: "south korea", kor: "south korea",
  se: "sweden", swe: "sweden",
  fi: "finland", fin: "finland",
  dk: "denmark", dnk: "denmark",
  no: "norway", nor: "norway",
  be: "belgium", bel: "belgium",
  at: "austria", aut: "austria",
};

function resolveLocaleProfile(country?: string | null): LocaleProfile | null {
  if (!country) return null;
  const key = country.trim().toLowerCase();
  if (LOCALE_PROFILES[key]) return LOCALE_PROFILES[key];
  if (COUNTRY_CODE_ALIASES[key]) return LOCALE_PROFILES[COUNTRY_CODE_ALIASES[key]];
  // Loose contains-match for names like "korea, republic of" or "united states"
  for (const name of Object.keys(LOCALE_PROFILES)) {
    if (key.includes(name)) return LOCALE_PROFILES[name];
  }
  return null;
}

/**
 * Builds native-language AI search queries for a company based on its country
 * locale profile. Only emitted when the framework is AI-related and a profile
 * exists. Returns the queries plus the gl/hl to use for them.
 */
function buildLocalizedAIQueries(
  companyName: string,
  framework: Framework,
  profile: LocaleProfile
): string[] {
  const topic = framework.topicDescription || framework.name || "";
  const frameworkName = (framework.name || "").toLowerCase();
  const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);
  if (!isAIRelated) return [];
  const queries: string[] = [];
  for (const term of profile.aiTerms) {
    queries.push(`"${companyName}" ${term}`);
  }
  // Pair the strongest AI term with a native annual-report term to surface filings
  if (profile.aiTerms[0] && profile.reportTerms[0]) {
    queries.push(`"${companyName}" ${profile.aiTerms[0]} ${profile.reportTerms[0]}`);
  }
  return queries;
}

function buildCJKQueries(companyName: string, framework: Framework): string[] {
  // Detect if company name contains CJK characters
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(companyName);
  if (!hasCJK) return [];

  const topic = framework.topicDescription || framework.name;
  // Generate localized queries
  return [
    `${companyName} サステナビリティ報告書`,
    `${companyName} ESG報告`,
    `${companyName} 可持续发展报告`,
    `${companyName} 지속가능경영보고서`,
    `${companyName} ${topic}`,
  ];
}

// ─── A-share / China primary-filing Queries ──────────────────────────────────

/**
 * Derives the mainland-China exchange ticker from a CN ISIN when possible.
 * CN ISINs look like CNE100000XXX. The embedded 6-digit board code is not
 * directly recoverable from the ISIN alone, so we instead rely on the official
 * disclosure portals (cninfo / SSE / SZSE) which index by company name. We do,
 * however, use the ISIN itself as a high-precision search token.
 */
function isChinaAShare(isin?: string | null, country?: string | null): boolean {
  if (isin && /^CNE/i.test(isin)) return true;
  if ((country || "").toUpperCase().includes("CHINA")) return true;
  return false;
}

/**
 * Primary-filing lane for mainland-China (A-share) issuers. Targets the official
 * disclosure repositories — cninfo.com.cn (巨潮资讯), sse.com.cn (上交所),
 * szse.cn (深交所) — plus the issuer's annual report (年度报告) by name and ISIN.
 * These are where the genuine A-share annual report lives; generic web search
 * tends to surface news wrappers (e.g. Futubull) and wrong-entity US/HK filings
 * instead, which is why this dedicated lane is needed.
 */
/**
 * Resolve a mainland-China issuer's Chinese legal name (法定名称) and 6-digit
 * board code from its English name / ISIN via web search. This is the missing
 * ingredient for A-share discovery: the official portals (cninfo / SSE / Sina)
 * index filings by the CHINESE name, so an English-name `site:cninfo.com.cn`
 * query returns nothing, whereas the Chinese-name query returns the genuine
 * annual-report PDFs directly. Returns best-effort {chineseName, code}.
 */
async function resolveChineseLegalName(
  companyName: string,
  isin?: string | null,
): Promise<{ chineseName?: string; code?: string }> {
  const out: { chineseName?: string; code?: string } = {};
  // Chinese company legal-name: greedily capture the full leading Chinese run so
  // we get "三六零安全科技股份有限公司" rather than the generic tail
  // "安全科技有限公司". Anchored on the legal-entity suffix.
  const nameRe = /[\u4e00-\u9fff]{3,40}?(?:股份有限公司|有限责任公司|有限公司)/g;
  // Names that are too generic to disambiguate an issuer (common tails only).
  const genericNames = new Set([
    "安全科技有限公司", "科技有限公司", "安全科技股份有限公司", "信息技术有限公司",
    "网络科技有限公司", "技术有限公司", "软件有限公司",
  ]);
  // A-share board codes: 60xxxx/68xxxx (Shanghai), 00xxxx/30xxxx (Shenzhen).
  const codeRe = /\b(6[0-9]{5}|0[0-9]{5}|3[0-9]{5})\b/;
  const probes: string[] = [
    `"${companyName}" 股票代码 中文`,
    `"${companyName}" A股 年度报告`,
  ];
  if (isin) probes.unshift(`"${isin}" 年度报告 股票代码`);
  const counts = new Map<string, number>();
  for (const q of probes) {
    let results: SearchResult[] = [];
    try {
      results = await webSearch(q, { num: 8, gl: "cn", hl: "zh-cn" });
    } catch {
      continue;
    }
    for (const r of results) {
      const hay = `${r.title || ""} ${r.snippet || ""}`;
      const names = hay.match(nameRe);
      if (names) {
        for (const nm of names) {
          const clean = nm.replace(/[（）()]/g, "");
          if (genericNames.has(clean) || clean.length < 6) continue; // skip generic tails
          counts.set(clean, (counts.get(clean) || 0) + 1);
        }
      }
      if (!out.code) {
        const m = `${hay} ${r.link || ""}`.match(codeRe);
        if (m) out.code = m[1];
      }
    }
    if (counts.size > 0 && out.code) break;
  }
  if (counts.size > 0) {
    // Prefer the most frequent; break ties toward the LONGEST (most complete) name.
    out.chineseName = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
  }
  return out;
}

/**
 * ROBUST cninfo full-PDF resolver (open-item follow-up). The web-search snippet
 * approach for cninfo is volatile: cninfo's listing pages are JS-driven and the
 * snippets often point at the SPA viewer rather than the actual PDF, so the
 * genuine annual report frequently fails to fetch (the cause of 360 Security
 * dropping to a near-empty document set). cninfo exposes an OFFICIAL announcement
 * query API that returns each filing's `adjunctUrl`; the genuine PDF is then a
 * plain, static, directly-fetchable file at `https://static.cninfo.com.cn/{adjunctUrl}`.
 * We query that API by the 6-digit board code, keep the annual-report filings,
 * and return the direct static-PDF URLs so the discovery lane can PIN them (they
 * fetch as ordinary PDFs through the processor's normal path). This is the
 * robust full-PDF lane with a built-in mirror: static.cninfo.com.cn is itself a
 * CDN mirror of the filing, and we additionally accept the dfcfw/eastmoney
 * mirror when the announcement record exposes it.
 *
 * Topic-agnostic: the API is queried by issuer code/category only; no topic
 * terms are baked in here.
 */
// cninfo's announcement API requires the issuer's internal orgId paired with the
// board code (`stock="<code>,<orgId>"`). The code→orgId map is published as two
// static JSON indexes; we fetch and cache them in-process (they are ~6k rows
// each and change rarely).
const CNINFO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
let cninfoStockIndex: Map<string, string> | null = null;

async function loadCninfoStockIndex(): Promise<Map<string, string>> {
  if (cninfoStockIndex) return cninfoStockIndex;
  const map = new Map<string, string>();
  for (const idx of [
    "http://www.cninfo.com.cn/new/data/szse_stock.json",
    "http://www.cninfo.com.cn/new/data/sse_stock.json",
  ]) {
    try {
      const r = await axios.get(idx, {
        headers: { "User-Agent": CNINFO_UA, Accept: "*/*" },
        timeout: SEARCH_TIMEOUT,
        validateStatus: (s) => s < 500,
      });
      const arr: any[] = (r.data && r.data.stockList) || [];
      for (const x of arr) {
        if (x?.code && x?.orgId) map.set(String(x.code), String(x.orgId));
      }
    } catch (e: any) {
      console.warn(`[cninfo] stock index load failed (${idx}): ${e?.message}`);
    }
  }
  cninfoStockIndex = map;
  return map;
}

async function resolveCninfoStaticPdfs(
  companyName: string,
  code?: string,
): Promise<string[]> {
  if (!code) return [];
  let orgId: string | undefined;
  try {
    const index = await loadCninfoStockIndex();
    orgId = index.get(code);
  } catch (e: any) {
    console.warn(`[${companyName}] cninfo orgId lookup failed: ${e?.message}`);
  }
  if (!orgId) {
    console.warn(`[${companyName}] cninfo orgId not found for code ${code} — skipping API lane`);
    return [];
  }
  const orgQueryUrl = "http://www.cninfo.com.cn/new/hisAnnouncement/query";
  const pdfUrls: string[] = [];
  try {
    const params = new URLSearchParams({
      stock: `${code},${orgId}`,
      tabName: "fulltext",
      pageSize: "30",
      pageNum: "1",
      column: "szse", // the orgId-keyed query works for both exchanges
      category: "category_ndbg_szsh", // 年度报告 (annual report) category
      plate: "szse",
      seDate: "",
      searchkey: "",
      secid: "",
      sortName: "",
      sortType: "",
      isHLtitle: "true",
    });
    const resp = await axios.post(orgQueryUrl, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": CNINFO_UA,
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
      },
      timeout: SEARCH_TIMEOUT,
      validateStatus: (s) => s < 500,
    });
    const anns: any[] = resp.data?.announcements || [];
    for (const a of anns) {
      const title = String(a?.announcementTitle || "");
      const adj = String(a?.adjunctUrl || "");
      if (!adj) continue;
      // Keep genuine FULL annual reports; drop summaries (摘要), english versions,
      // cancellations/corrections, and ancillary audit/inquiry attachments.
      const isAnnual = /年度报告|年报/.test(title);
      const isNoise = /摘要|英文|取消|更正|已取消|核查意见|问询|公告/.test(title);
      if (!isAnnual || isNoise) continue;
      const direct = adj.startsWith("http")
        ? adj
        : `https://static.cninfo.com.cn/${adj.replace(/^\/+/, "")}`;
      pdfUrls.push(direct);
    }
  } catch (e: any) {
    console.warn(`[${companyName}] cninfo API resolve failed: ${e?.message}`);
  }
  // De-dup and cap to the most recent few (the API returns newest first).
  const unique = Array.from(new Set(pdfUrls)).slice(0, 3);
  if (unique.length > 0) {
    console.log(`[${companyName}] cninfo API resolved ${unique.length} direct static-PDF annual report(s)`);
  }
  return unique;
}

async function buildAShareFilingQueries(
  companyName: string,
  isin?: string | null,
  topicPhrases?: string[],
): Promise<{ queries: string[]; code?: string; chineseName?: string }> {
  // Resolve the Chinese legal name + board code first — without these the
  // official-portal queries match nothing (the portals index by Chinese name).
  const { chineseName, code } = await resolveChineseLegalName(companyName, isin);
  if (chineseName || code) {
    console.log(`[${companyName}] A-share resolver -> name=${chineseName || "?"} code=${code || "?"}`);
  }
  const queries: string[] = [];
  const cn = chineseName;
  // TOPIC-AGNOSTIC topic phrase: prefer a framework-derived CJK/topic phrase over
  // the previously hard-coded 人工智能. Pick the first phrase containing CJK
  // characters if present (best for a Chinese-language query), else the first
  // phrase. Falls back to 人工智能 only when no lexicon is threaded through.
  const cjkPhrase = (topicPhrases || []).find((p) => /[\u4e00-\u9fff]/.test(p));
  const topicPhraseCJK = cjkPhrase || (topicPhrases && topicPhrases[0]) || "人工智能";
  // Lead with the board-code queries: the 6-digit code is resolved reliably and
  // `site:cninfo.com.cn <code> 年度报告` returns the exact issuer's reports.
  if (code) {
    queries.push(
      `site:cninfo.com.cn ${code} 年度报告`,
      `${code} ${cn || companyName} 2024 年年度报告 pdf`,
      `site:money.finance.sina.com.cn ${code} 年度报告`,
    );
  }
  if (cn) {
    queries.push(
      `site:cninfo.com.cn ${cn} 年度报告`,
      `${cn} 年度报告 cninfo`,
      `${cn} 2024 年年度报告 filetype:pdf`,
      `${cn} ${topicPhraseCJK} 风险 年报`,
    );
  }
  // English-name fallbacks (low yield, but harmless) only if resolution failed.
  if (!cn && !code) {
    queries.push(
      `site:cninfo.com.cn "${companyName}" 年度报告`,
      `"${companyName}" 年度报告 2024 OR 2023 filetype:pdf`,
      `"${companyName}" ${topicPhraseCJK} 风险 年报`,
    );
    if (isin) queries.push(`"${isin}" 年度报告`);
  }
  return { queries, code, chineseName: cn };
}

/**
 * Returns a list of KNOWN-DISTINCT entity names that share a token with the
 * target company and must NOT be confused with it. This is the targeted fix for
 * the "360" collision: the bare token "360" matches several unrelated issuers
 * (Qifu / 360 DigiTech / 360 Finance / 360 ONE), so the generic pre-gate
 * name-match would otherwise rescue their filings. Keyed conservatively off the
 * target name so it only fires for the specific ambiguous issuers we know about.
 */
function disambiguationExclusions(companyName: string): string[] {
  const n = companyName.toLowerCase();
  // 360 Security Technology (A-share 601360) vs. the US/HK-listed "360" fintechs.
  if (/\b360\b/.test(n) && /security|三六零|360 security/.test(n)) {
    return ["qifu", "360 digitech", "360 finance", "qfin", "360 one", "360one", "360 digitech"];
  }
  return [];
}

// ─── Regulatory Filing Queries (Lane 8) ──────────────────────────────────────

/**
 * Generates search queries targeting SEC filings (10-K, DEF 14A proxy),
 * annual reports, and equivalent regulatory filings for non-US companies.
 * These are critical for topics like AI governance where evidence often
 * appears in risk factors, board oversight sections, and proxy statements
 * rather than ESG/sustainability reports.
 */
function buildRegulatoryFilingQueries(companyName: string, framework: Framework, topicPhrases?: string[]): string[] {
  const queries: string[] = [];
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();

  // Core filing queries (always run regardless of topic). EDGAR full-text search
  // (efts.sec.gov / sec.gov/cgi-bin/srqsb) is the authoritative way to locate a
  // US issuer's actual 10-K/DEF 14A, so we lead with site:sec.gov queries.
  queries.push(
    `"${companyName}" 10-K annual report filetype:pdf`,
    `"${companyName}" proxy statement DEF 14A`,
    `"${companyName}" annual report 2024 OR 2023`,
    `site:sec.gov "${companyName}" 10-K`,
    `site:sec.gov "${companyName}" DEF 14A`,
    `site:sec.gov "${companyName}" annual report 10-K filing`,
    `"${companyName}" 20-F annual report`, // non-US filers on US exchanges
  );

  // Topic-specific filing queries. TOPIC-AGNOSTIC: derive the search phrases from
  // the framework's own lexicon when provided, so this works for ANY topic and
  // catches issuers that use adjacent vocabulary (e.g. "machine learning" /
  // "generative AI" rather than the literal "artificial intelligence"). Falls back
  // to topic-description tokens when no lexicon is threaded through.
  const phrases = (topicPhrases && topicPhrases.length > 0
    ? topicPhrases
    : topic.split(/\s+/).filter((w) => w.length > 3))
    .map((p) => p.trim())
    .filter(Boolean);
  // Build an OR-group of the most distinctive phrases (cap to keep queries short).
  const orGroup = phrases.slice(0, 4).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" OR ");
  const leadPhrase = phrases[0] ? (/\s/.test(phrases[0]) ? `"${phrases[0]}"` : phrases[0]) : "";
  if (orGroup) {
    queries.push(
      `"${companyName}" 10-K ${orGroup}`,
      `"${companyName}" proxy ${orGroup} board oversight`,
      `"${companyName}" annual report ${orGroup}`,
      `"${companyName}" 20-F ${leadPhrase}`,
    );
  }

  // Non-US equivalents
  queries.push(
    `"${companyName}" annual report governance 2024 OR 2023`,
    `"${companyName}" integrated report 2024 OR 2023`,
  );

  return queries;
}

// ─── Authoritative EDGAR Annual-Filing Seed (v3g, Bug 5) ─────────────────────
// Web search is NON-deterministic and frequently fails to surface an issuer's
// MOST RECENT 10-K/20-F (observed: Salesforce FY2025). The authoritative source
// is EDGAR's structured submissions JSON, which lists every filing with its form
// type, filing date, accession and primary document. We resolve the issuer's CIK
// from the company-tickers map (by ticker, else by name) and then read
// data.sec.gov/submissions/CIK##########.json to construct the canonical primary
// -document URL for the newest annual filing. Topic- and issuer-agnostic; purely
// additive (the URL is PINNED so it survives gating). Best-effort: any failure
// silently leaves discovery on the existing web-search lanes.
let secTickerMapCache: Map<string, string> | null = null; // ticker/upperName -> 10-digit CIK

async function loadSecTickerMap(ua: string): Promise<Map<string, string>> {
  if (secTickerMapCache) return secTickerMapCache;
  const map = new Map<string, string>();
  try {
    const r = await axios.get("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": ua, Accept: "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status === 200 && r.data && typeof r.data === "object") {
      for (const k of Object.keys(r.data)) {
        const row = r.data[k];
        if (!row) continue;
        const cik = String(row.cik_str ?? row.cik ?? "").padStart(10, "0");
        if (row.ticker) map.set(String(row.ticker).toUpperCase(), cik);
        if (row.title) map.set(String(row.title).toUpperCase(), cik);
      }
    }
  } catch { /* best-effort */ }
  secTickerMapCache = map;
  return map;
}

async function resolveAuthoritativeAnnualFilings(opts: {
  companyName: string;
  ticker?: string | null;
  maxFilings?: number;
}): Promise<Array<{ url: string; form: string; date: string }>> {
  const ua = process.env.SEC_USER_AGENT || "CompanyIQ Research admin@companyiq.example";
  const out: Array<{ url: string; form: string; date: string }> = [];
  try {
    const map = await loadSecTickerMap(ua);
    let cik: string | undefined;
    if (opts.ticker) cik = map.get(opts.ticker.toUpperCase());
    if (!cik) cik = map.get(opts.companyName.toUpperCase());
    if (!cik) {
      // Try a loose name match (strip common suffixes) against map keys.
      const norm = opts.companyName.toUpperCase().replace(/[.,]/g, "").replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|GROUP|HOLDINGS|COMPANY|LIMITED)\b/g, "").trim();
      for (const [k, v] of map) { if (k.replace(/[.,]/g, "").includes(norm) && norm.length >= 4) { cik = v; break; } }
    }
    if (!cik) { console.log(`[${opts.companyName}] EDGAR submissions: no CIK resolved (ticker=${opts.ticker || "?"})`); return out; }

    const subResp = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": ua, Accept: "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (subResp.status !== 200 || !subResp.data?.filings?.recent) {
      console.log(`[${opts.companyName}] EDGAR submissions fetch failed (CIK ${cik}, status ${subResp.status})`);
      return out;
    }
    const recent = subResp.data.filings.recent;
    const forms: string[] = recent.form || [];
    const accessions: string[] = recent.accessionNumber || [];
    const primaryDocs: string[] = recent.primaryDocument || [];
    const dates: string[] = recent.filingDate || [];
    const cikNum = String(parseInt(cik, 10));
    const maxFilings = opts.maxFilings ?? 2;
    const wantForm = (f: string) => /^(10-?K|20-?F|40-?F)$/i.test(f.replace(/\s+/g, "")) && !/\/A$/i.test(f);
    // recent arrays are sorted newest-first by EDGAR.
    for (let i = 0; i < forms.length && out.length < maxFilings; i++) {
      if (!wantForm(forms[i])) continue;
      const acc18 = (accessions[i] || "").replace(/-/g, "");
      const file = primaryDocs[i];
      if (!acc18 || !file) continue;
      const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc18}/${file}`;
      out.push({ url, form: forms[i], date: dates[i] || "" });
      // Pre-seed the authoritative form/year caches so the recency gate and
      // force-include classify this primary document correctly straight away.
      edgarFormByAccession.set(acc18, normalizeEdgarForm(forms[i]));
      if (dates[i] && /^\d{4}/.test(dates[i])) edgarFilingYearByAccession.set(acc18, parseInt(dates[i].slice(0, 4), 10));
      console.log(`[${opts.companyName}] EDGAR authoritative annual filing: ${forms[i]} ${dates[i]} -> ${url}`);
    }
  } catch (e: any) {
    console.warn(`[${opts.companyName}] EDGAR submissions seed failed: ${e?.message}`);
  }
  return out;
}

// ─── Investor Relations Queries (Lane 9) ──────────────────────────────────────

/**
 * Generates queries targeting investor relations pages, earnings presentations,
 * and strategic disclosures that often contain governance/strategy evidence
 * not found in ESG reports.
 */
function buildInvestorRelationsQueries(
  companyName: string,
  effectiveDomain: string | null,
  framework: Framework
): string[] {
  const queries: string[] = [];
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();
  const frameworkName = (framework.name || "").toLowerCase();

  const isAIRelated = /artificial intelligence|\bai\b|machine learning|generative ai|responsible ai|ai governance|ai strategy/i.test(topic + " " + frameworkName);

  // Domain-anchored IR queries (most valuable — finds the actual IR page)
  if (effectiveDomain) {
    queries.push(
      `site:${effectiveDomain} investor relations`,
      `site:${effectiveDomain} annual report 2024 OR 2023`,
      `site:${effectiveDomain} proxy statement`,
    );
    if (isAIRelated) {
      queries.push(
        `site:${effectiveDomain} investor presentation AI`,
        `site:${effectiveDomain} earnings AI OR "artificial intelligence"`,
        `site:${effectiveDomain} strategy AI`,
      );
    }
  }

  // General IR queries
  queries.push(
    `"${companyName}" investor presentation 2024 OR 2025`,
    `"${companyName}" investor day OR capital markets day`,
  );

  if (isAIRelated) {
    queries.push(
      `"${companyName}" investor presentation AI strategy`,
      `"${companyName}" earnings call AI OR "artificial intelligence" transcript`,
      `"${companyName}" capital expenditure AI OR "artificial intelligence"`,
    );
  }

  return queries;
}

// ─── Auto-Domain Inference ─────────────────────────────────────────────────

/**
 * Infer the company's primary corporate domain from general search results.
 * Looks for the most common corporate domain that appears to belong to the company.
 * Excludes known generic/news/social domains.
 */
// Shared CDNs, IR-platform hosts, document repositories and cloud storage that
// host content for HUNDREDS of different companies. Anchoring a company to one
// of these (e.g. s206.q4cdn.com) is the root cause of document contamination,
// so they must NEVER be treated as a company's primary domain. Matched as a
// suffix so all subdomains (s1.q4cdn.com, s206.q4cdn.com, ...) are covered.
const SHARED_HOST_SUFFIXES = [
  "q4cdn.com", "q4web.com", "q4inc.com",
  "s3.amazonaws.com", "amazonaws.com", "cloudfront.net",
  "sharepoint.com", "blob.core.windows.net", "windows.net",
  "googleusercontent.com", "storage.googleapis.com", "firebasestorage.googleapis.com",
  "azureedge.net", "akamaihd.net", "akamaized.net", "fastly.net", "cloudflare.net",
  "wordpress.com", "squarespace.com", "wixsite.com", "weebly.com",
  "netlify.app", "vercel.app", "herokuapp.com", "github.io",
  "scribd.com", "slideshare.net", "issuu.com", "docsend.com", "box.com",
  "dropbox.com", "drive.google.com", "docs.google.com",
  "sec.report", "annualreports.com", "responsibilityreports.com",
  "businesswire.com", "prnewswire.com", "globenewswire.com", "newswire.ca",
  "investis.com", "investorroom.com", "investorrelations.com",
  "nasdaq.com", "nyse.com", "marketwatch.com", "morningstar.com", "yahoo.com",
  "seekingalpha.com", "simplywall.st", "tipranks.com",
  // Blog platforms, newsletters and third-party aggregators that frequently
  // contain an industry keyword (e.g. "semiconductor") in their subdomain and
  // would otherwise be mis-detected as a company's own site.
  "substack.com", "blogspot.com", "tumblr.com", "ghost.io", "notion.site",
  "financialreports.eu", "marketscreener.com", "alphaspread.com", "spglobal.com",
  "stockanalysis.com", "wallmine.com", "investing.com", "barchart.com",
  "gurufocus.com", "stocktitan.net", "fintel.io", "moomoo.com",
];

function isSharedHost(domain: string): boolean {
  return SHARED_HOST_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith("." + suffix)
  );
}

function inferDomainFromResults(candidates: DiscoveryCandidate[], companyName: string): string | null {
  const excludedDomains = new Set([
    "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com", "instagram.com",
    "wikipedia.org", "reuters.com", "bloomberg.com", "ft.com", "cnbc.com",
    "bbc.com", "theguardian.com", "nytimes.com", "wsj.com", "medium.com",
    "indeed.com", "glassdoor.com", "theladders.com", "builtin.com",
    "sec.gov", "companieshouse.gov.uk", "google.com", "amazon.com",
    "github.com", "reddit.com", "quora.com", "stackexchange.com",
    "sustainabilityreports.com", "relayto.com", "cdp.net",
    "sciencebasedtargets.org", "unglobalcompact.org",
    "aijobs.com", "machinelearningjobs.co.uk", "builtinnyc.com",
    "siliconangle.com", "techcrunch.com", "wired.com", "venturebeat.com",
  ]);

  // Count domain occurrences from candidates
  const domainCounts = new Map<string, number>();
  for (const c of candidates) {
    try {
      const url = new URL(c.url);
      let domain = url.hostname.replace(/^www\./, "");
      if (excludedDomains.has(domain)) continue;
      // Never anchor to shared CDNs / IR platforms / document repositories that
      // host content for many different companies (prevents contamination).
      if (isSharedHost(domain)) continue;
      // Skip very generic TLDs that are unlikely to be corporate
      if (domain.endsWith(".gov") || domain.endsWith(".edu")) continue;
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    } catch {
      continue;
    }
  }

  if (domainCounts.size === 0) return null;

  // Sort by frequency and pick the most common
  const sorted = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]);

  // The top domain should appear at least 2 times to be considered reliable
  if (sorted[0][1] < 2) return null;

  // Additional heuristic: the domain should contain part of the company name
  // or be clearly corporate (not a news/blog site)
  // Generic corporate/industry descriptors must NOT, on their own, satisfy a
  // name match — otherwise a third-party site like "tspasemiconductor.substack.com"
  // matches "Hanmi Semiconductor" via the word "semiconductor". We require at
  // least one *distinctive* company token (a non-generic word) to match.
  const GENERIC_NAME_WORDS = new Set([
    "the", "and", "for", "group", "holding", "holdings", "company", "companies",
    "corp", "corporation", "incorporated", "inc", "ltd", "limited", "llc", "plc",
    "co", "sa", "se", "ag", "nv", "spa", "oyj", "asa", "ab", "as", "bv", "kg",
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
  const topDomain = sorted[0][0];
  const companyWords = companyName.toLowerCase().split(/[\s&,.']+/).filter(w => w.length > 2);
  const distinctiveWords = companyWords.filter(w => !GENERIC_NAME_WORDS.has(w));
  // Use distinctive words when available; fall back to all words only if a company
  // name is entirely generic (rare).
  const matchWords = distinctiveWords.length > 0 ? distinctiveWords : companyWords;
  const domainLower = topDomain.toLowerCase();

  // Check if any significant word from company name appears in the domain.
  // A company-name match is now REQUIRED — we no longer accept a domain solely
  // because it "appears 3+ times", which previously caused mis-anchoring to
  // shared hosts and unrelated high-frequency domains.
  const nameMatch = matchWords.some(word => domainLower.includes(word));
  if (nameMatch) return topDomain;

  // Try other frequent domains that DO match the company name (scan the top few,
  // not just the second). This recovers cases where a news/aggregator domain is
  // the most common but the company's own domain is also present.
  for (let i = 1; i < Math.min(sorted.length, 6); i++) {
    const [candidateDomain, count] = sorted[i];
    if (count < 2) break;
    if (matchWords.some(word => candidateDomain.toLowerCase().includes(word))) {
      return candidateDomain;
    }
  }

  // No domain confidently matches the company name — return null rather than
  // guessing, so the company is left with no domain (surfaced on the Domains page).
  return null;
}

// ─── Ranking and Demotion ────────────────────────────────────────────────────

function calculatePriority(
  url: string,
  title: string,
  companyDomain: string | null,
  framework: Framework,
  topicPhrases: string[] = []
): number {
  let priority = 0;
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  // v3e (Section 2): prefer section-taggable EDGAR HTML over the same filing's PDF.
  // EDGAR primary documents in HTML (.htm/.html) retain the Item-heading structure
  // our retrieval relies on (Item 1A etc.); the PDF rendering frequently flattens
  // it. For SEC EDGAR archive URLs, boost HTML and mildly demote PDF so that when
  // both forms of a filing are discovered, the HTML wins selection.
  const isEdgar = /sec\.gov\/archives\/edgar/.test(urlLower);
  if (isEdgar) {
    if (/\.html?($|\?)/.test(urlLower)) priority -= 6;        // prefer EDGAR HTML
    else if (/\.pdf($|\?)/.test(urlLower)) priority += 4;     // demote EDGAR PDF
  }

  // On-company-domain bonus
  if (companyDomain && urlLower.includes(companyDomain)) {
    priority -= 8;
  }

  // Trusted disclosure platform bonus (Tier 1: priority domains from curated sources list)
  // These are statutory filing repositories, ESG registries, voluntary frameworks,
  // certification registries, and national company registers
  const priorityDomains = [
    // Statutory / securities filing repositories
    "sec.gov", "efts.sec.gov", "fca.org.uk", "data.fca.org.uk",
    "find-and-update.company-information.service.gov.uk", "esap.europa.eu",
    "registers.esma.europa.eu", "unternehmensregister.de", "fsma.be",
    "info-financiere.fr", "data.inpi.fr", "1info.it", "cnmv.es",
    "afm.nl", "dl.bourse.lu", "web3.cmvm.pt", "rss.knf.gov.pl",
    "direct.euronext.com", "bolagsverket.se", "brreg.no", "datacvr.virk.dk",
    "tietopalvelu.ytj.fi", "zefix.ch", "core.cro.ie", "kbopub.economie.fgov.be",
    "registradores.org", "registroimprese.it", "kvk.nl", "handelsregister.de",
    "e-justice.europa.eu", "sedarplus.ca", "connectonline.asic.gov.au",
    "asx.com.au", "www1.hkexnews.hk", "disclosure2.edinet-fsa.go.jp",
    "release.tdnet.info", "kind.krx.co.kr", "mops.twse.com.tw",
    "sgx.com", "bseindia.com", "nseindia.com", "sebi.gov.in",
    "cninfo.com.cn", "sse.com.cn", "gsxt.gov.cn", "maya.tase.co.il",
    "saudiexchange.sa", "adx.ae", "dfm.ae", "kap.org.tr",
    "clientportal.jse.co.za", "b3.com.br", "rad.cvm.gov.br", "mca.gov.in",
    // UK-specific statutory ESG
    "modern-slavery-statement-registry.service.gov.uk",
    "gender-pay-gap.service.gov.uk", "gov.uk",
    // Country-specific ESG registries
    "modernslaveryregister.gov.au", "wgea.gov.au",
    "natural-resources.canada.ca", "publicsafety.gc.ca",
    "enviro.epa.gov", "industry.eea.europa.eu", "eea.europa.eu",
    "environment.data.gov.uk", "ec.europa.eu", "ww2.arb.ca.gov",
    "hatvp.fr", "lda.senate.gov", "fec.gov",
    "transparency-register.europa.eu",
    // Voluntary global frameworks
    "cdp.net", "tnfd.global", "sciencebasedtargets.org",
    "sciencebasedtargetsnetwork.org", "unglobalcompact.org",
    // Finance-sector pledges
    "netzeroassetmanagers.org", "unepfi.org", "unpri.org",
    "equator-principles.com", "financeforbiodiversity.org",
    "frc.org.uk", "fsa.go.jp", "carbonaccountingfinancials.com",
    // UN-backed campaigns
    "climateaction.unfccc.int", "there100.org", "theclimategroup.org", "weps.org",
    // Sector-specific & certification registries
    "eiti.org", "icmm.com", "rspo.org", "search.fsc.org", "connect.fsc.org",
    "pefc.org", "responsiblesoy.org", "bonsucro.com", "rsb.org",
    "responsiblemining.net", "aluminium-stewardship.org",
    "responsiblesteel.org", "responsiblejewellery.com",
    "bettercotton.org", "fisheries.msc.org", "asc-aqua.org",
    "knowledge.rainforest-alliance.org", "flocert.net", "goodweave.org",
    "fairlabor.org", "iafcertsearch.org",
    // Certification & verified-status registries
    "bcorporation.net", "usgbc.org", "tools.breeam.com",
    "account.wellcertified.com", "dgnb.de",
    // Human rights & social
    "hrc.org", "disabilityin.org", "ungpreporting.org",
    // Other regulatory/reporting
    "oecd.org",
  ];
  if (priorityDomains.some((d) => urlLower.includes(d))) {
    priority -= 4;
  }

  // URL slug bonuses
  const slugBonuses: Record<string, number> = {
    governance: -5,
    sustainability: -4,
    "responsible-ai": -5,
    ethics: -3,
    policy: -3,
    report: -2,
    esg: -4,
    "annual-report": -4,
    proxy: -3,
    "def-14a": -5,
    "10-k": -5,
    "10k": -5,
    "20-f": -5,
    "investor-relations": -4,
    "investors": -3,
    "investor-presentation": -4,
    "earnings": -3,
    "integrated-report": -4,
  };
  for (const [slug, bonus] of Object.entries(slugBonuses)) {
    if (urlLower.includes(slug)) priority += bonus;
  }

  // v3e (Section 5/6): TOPIC bonus, framework-derived (was a hard-coded AI list).
  // The active framework's lexicon phrases (multilingual) are slugified and matched
  // against the URL so on-topic documents are boosted for ANY topic, not just AI.
  // Falls back to nothing when no lexicon was threaded through (safe no-op).
  if (topicPhrases.length > 0) {
    const slugs = new Set<string>();
    for (const p of topicPhrases) {
      const slug = p.toLowerCase().trim().replace(/\s+/g, "-");
      if (slug.length >= 2) { slugs.add(slug); slugs.add(slug.replace(/-/g, "")); }
    }
    for (const slug of slugs) {
      if (slug && urlLower.includes(slug)) { priority -= 3; break; }
    }
  }

  // Third-party blog/news penalty
  const newsDomains = ["reuters.com", "bloomberg.com", "cnbc.com", "bbc.com", "medium.com"];
  if (newsDomains.some((d) => urlLower.includes(d))) {
    priority += 5;
  }

  // Podcast / app-store / media platform penalty (high false-positive rate)
  const mediaPlatforms = [
    "podcasts.apple.com", "music.apple.com", "apps.apple.com", "itunes.apple.com",
    "open.spotify.com", "soundcloud.com", "anchor.fm",
    "play.google.com", "store.steampowered.com",
    "tiktok.com", "pinterest.com", "tumblr.com",
  ];
  if (mediaPlatforms.some((d) => urlLower.includes(d))) {
    priority += 30; // Heavy penalty — these almost never contain corporate disclosures
  }

  // Negative keywords penalty
  if (framework.negativeKeywords) {
    for (const kw of framework.negativeKeywords) {
      if (titleLower.includes(kw.toLowerCase())) {
        priority += 12;
      }
    }
  }

  // Negative domains penalty
  if (framework.negativeDomains) {
    for (const domain of framework.negativeDomains) {
      if (urlLower.includes(domain.toLowerCase())) {
        priority += 15;
      }
    }
  }

  // Customer content paths penalty
  const customerPaths = ["/wealth-management/articles/", "/insights/", "/blog/", "/news/"];
  if (companyDomain && urlLower.includes(companyDomain)) {
    if (customerPaths.some((p) => urlLower.includes(p))) {
      priority += 25;
    }
  }

  return priority;
}

// ─── Relevance Gate ──────────────────────────────────────────────────────────

async function runRelevanceGate(
  candidates: DiscoveryCandidate[],
  framework: Framework,
  companyName: string,
  companyContext?: { sector?: string | null; country?: string | null; isin?: string | null; domain?: string | null }
): Promise<DiscoveryCandidate[]> {
  // Use deepseek as primary gate model (cheap, with 3 rotating keys for rate-limit headroom).
  // Falls back through completeWithFallback chain (gpt-4o-mini, gemini, etc.) if it fails.
  const gateModel = "deepseek";
  const batchSize = 20;
  const accepted: DiscoveryCandidate[] = [];

  // Build company identity context for disambiguation
  const identityParts: string[] = [];
  if (companyContext?.sector) identityParts.push(`Sector: ${companyContext.sector}`);
  if (companyContext?.country) identityParts.push(`Country: ${companyContext.country}`);
  if (companyContext?.isin) identityParts.push(`ISIN: ${companyContext.isin}`);
  if (companyContext?.domain) identityParts.push(`Official domain: ${companyContext.domain}`);
  const identityBlock = identityParts.length > 0 ? `\nCompany identity: ${identityParts.join(", ")}` : "";

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const urlList = batch
      .map((c, idx) => `${idx + 1}. URL: ${c.url}\n   Title: ${c.title}\n   Snippet: ${c.snippet}`)
      .join("\n\n");

    // Retry up to 2 times on failure before rejecting the batch
    let gateSuccess = false;
    for (let attempt = 0; attempt < 2 && !gateSuccess; attempt++) {
      try {
        const { text } = await completeWithFallback(gateModel, {
          system: `You are a strict document relevance classifier for corporate disclosure analysis. Given a list of URLs found for a specific company, classify each as "accept" or "reject".

ACCEPT ONLY:
- Corporate reports, filings, policy documents, governance pages, sustainability reports, annual reports, and other substantive disclosures that are SPECIFICALLY ABOUT THIS EXACT COMPANY
- Documents hosted on this company's own corporate domain
- Regulatory filings specifically naming this company
- Industry reports where this company is a primary subject (not just mentioned in passing)

REJECT:
- Documents about a DIFFERENT company, even if in the same industry (e.g., if searching for BNP Paribas, reject documents about DBS Bank, AXA, Santander, etc.)
- Generic industry articles that mention multiple companies without focusing on the target company
- Documents about a DIFFERENT entity that happens to share a similar name or acronym
- News articles, marketing content, job postings, product pages
- YouTube videos, social media posts (unless they link to official disclosures)
- Documents from unrelated organizations
- Blog posts or thought-leadership articles from consulting firms unless they are a detailed case study of this specific company

CRITICAL RULES:
1. If the URL domain belongs to ANOTHER company (e.g., dbs.com, axa-im.ch when searching for BNP Paribas), REJECT it unless it explicitly discusses the target company
2. If the title mentions another company name prominently, REJECT it
3. When in doubt, REJECT rather than accept — false positives are more harmful than false negatives
4. Pay close attention to the company identity (sector, country, domain) to distinguish from similarly-named entities`,
          prompt: `Company: ${companyName}${identityBlock}\nAnalysis topic: ${framework.topicDescription || framework.name}\n\nClassify each URL as relevant to THIS SPECIFIC COMPANY's disclosures:\n\n${urlList}\n\nReturn a JSON array of objects: [{"index": 1, "verdict": "accept"|"reject", "reason": "brief reason"}]`,
          json: true,
          maxTokens: 2000,
        });

        const parsed = JSON.parse(text);
        // Handle both raw arrays and wrapped objects (e.g., {"results": [...]})
        const verdicts = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.results) ? parsed.results
          : Array.isArray(parsed.verdicts) ? parsed.verdicts
          : Array.isArray(parsed.classifications) ? parsed.classifications
          : Object.values(parsed).find(v => Array.isArray(v)) || [];
        for (const v of verdicts) {
          const idx = (v.index || v.idx) - 1;
          if (idx >= 0 && idx < batch.length) {
            if (v.verdict === "accept") {
              accepted.push(batch[idx]);
            }
          }
        }
        gateSuccess = true;
      } catch (error: any) {
        if (attempt === 0) {
          console.warn(`[Discovery] Gate batch attempt ${attempt + 1} failed: ${error.message}, retrying...`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          // FAIL-CLOSED: On persistent failure, REJECT the entire batch
          // This prevents unrelated documents from polluting the corpus
          console.warn(`[Discovery] Gate batch REJECTED (all ${batch.length} candidates) after 2 failed attempts: ${error.message}`);
        }
      }
    }
  }

  return accepted;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────

export interface DiscoveryDiagnostics {
  totalCandidates: number;
  acceptedByGate: number;
  finalCount: number;
  lanes: Record<string, number>;
  topUrls: Array<{ url: string; title: string; priority: number }>;
  coverage?: CoverageMetric;
  // v3e (Section 4): SHA1 over the sorted set of selected document URLs. Identical
  // discovery output => identical fingerprint, so a re-run can be detected as
  // having found the SAME corpus (supporting reproducibility analysis). Logged for
  // drift visibility; does NOT itself short-circuit discovery.
  candidateFingerprint?: string;
}

export interface DiscoveryResult {
  documents: DiscoveryCandidate[];
  diagnostics: DiscoveryDiagnostics;
  /** The domain used to anchor the search. Either the company's stored domain
   *  or one auto-detected from search results. Null if none could be determined. */
  effectiveDomain?: string | null;
  /** True when effectiveDomain was auto-detected (i.e. company had no stored domain).
   *  Used by the pipeline to decide whether to persist the detected domain. */
  domainAutoDetected?: boolean;
}

export async function searchCompanyDocuments(opts: {
  companyName: string;
  companyId: number;
  companyDomain?: string | null;
  isin?: string | null;
  ticker?: string | null;
  sector?: string | null;
  country?: string | null;
  pinnedUrls?: string[];
  framework: Framework;
  trustedSources: TrustedSource[];
  searchDepth?: number; // Number of results per query (default: 10)
  queryVariants?: number; // Number of LLM-generated query variants (default: 3)
}): Promise<DiscoveryResult> {
  const { companyName, companyId, companyDomain, pinnedUrls, framework, trustedSources } = opts;
  const localeProfile = resolveLocaleProfile(opts.country);
  const searchDepth = opts.searchDepth || 10;
  const queryVariants = opts.queryVariants ?? 3;
  const allCandidates: DiscoveryCandidate[] = [];
  const seenUrls = new Set<string>();
  const laneCounts: Record<string, number> = {};

  // TOPIC-AGNOSTIC: derive (cached) framework topic phrases once so the
  // regulatory/IR/CJK query builders can target the framework's own vocabulary
  // and its synonyms, instead of a hard-coded AI term list.
  let topicPhrases: string[] = [];
  try {
    const lex = await deriveTopicLexicon({
      frameworkId: framework.id,
      workspaceId: framework.workspaceId,
      topicDescription: framework.topicDescription,
      frameworkName: framework.name,
    });
    topicPhrases = lex.terms;
  } catch (lexErr: any) {
    console.warn(`[${companyName}] Discovery topic lexicon failed: ${lexErr?.message}`);
  }

  function addCandidate(result: SearchResult, lane: string) {
    if (seenUrls.has(result.link)) return;
    // Hard deny-list filter: block noise URLs before they enter the candidate pool
    if (isUrlDenied(result.link.toLowerCase())) {
      laneCounts["denied"] = (laneCounts["denied"] || 0) + 1;
      return;
    }
    seenUrls.add(result.link);
    const priority = calculatePriority(result.link, result.title, companyDomain || null, framework, topicPhrases);
    allCandidates.push({
      url: result.link,
      title: result.title,
      snippet: result.snippet,
      lane,
      priority,
    });
    laneCounts[lane] = (laneCounts[lane] || 0) + 1;
  }

  // Add pinned URLs with maximum priority
  if (pinnedUrls) {
    for (const url of pinnedUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allCandidates.push({
          url,
          title: "Pinned document",
          snippet: "",
          lane: "pinned",
          priority: -100,
        });
        laneCounts["pinned"] = (laneCounts["pinned"] || 0) + 1;
      }
    }
  }

  // Lane 1: General search (with recency filter)
  console.log(`[${companyName}] Running general search lane`);
  const generalQueries = buildGeneralQueries(companyName, framework);
  for (const query of generalQueries) {
    const results = await webSearch(query, { num: searchDepth, tbs: "qdr:y2" });
    for (const r of results) addCandidate(r, "general");

    // If too few results with recency filter, retry without
    if (results.length < 3) {
      const unfiltered = await webSearch(query, { num: searchDepth });
      for (const r of unfiltered) addCandidate(r, "general-unfiltered");
    }
  }

  // Lane 2: Domain-anchored search (with auto-detection if no domain set)
  let effectiveDomain = companyDomain || null;
  let domainAutoDetected = false;
  if (!effectiveDomain) {
    // Auto-detect domain from general search results
    effectiveDomain = inferDomainFromResults(allCandidates, companyName);
    if (effectiveDomain) {
      domainAutoDetected = true;
      console.log(`[${companyName}] Auto-detected domain: ${effectiveDomain}`);
    }
  }
  if (effectiveDomain) {
    console.log(`[${companyName}] Running domain-anchored search lane (domain: ${effectiveDomain})`);
    const domainQueries = buildDomainQueries(companyName, effectiveDomain, framework);
    for (const query of domainQueries) {
      const results = await webSearch(query, { num: searchDepth });
      for (const r of results) addCandidate(r, "domain");
    }
  } else {
    console.log(`[${companyName}] No domain available, skipping domain-anchored search`);
  }

  // Lane 3: Trusted source search (framework-specific sources take priority)
  const frameworkSourceIds = framework.trustedSourceIds as number[] | null;
  let effectiveSources = trustedSources;
  if (frameworkSourceIds && frameworkSourceIds.length > 0) {
    // Use framework-specific sources if configured, otherwise fall back to global list
    effectiveSources = trustedSources.filter((s) => frameworkSourceIds.includes(s.id));
    if (effectiveSources.length === 0) effectiveSources = trustedSources; // fallback
  }
  if (effectiveSources.length > 0) {
    console.log(`[${companyName}] Running trusted source search lane (${effectiveSources.length} sources)`);
    const tsQueries = buildTrustedSourceQueries(companyName, effectiveSources);
    // Allow up to 15 trusted source queries per company (increased from 5)
    for (const query of tsQueries.slice(0, 15)) {
      const results = await webSearch(query, { num: Math.max(5, searchDepth) });
      for (const r of results) addCandidate(r, "trusted");
    }
  }

  // Lane 4: CJK localized search
  const cjkQueries = buildCJKQueries(companyName, framework);
  if (cjkQueries.length > 0) {
    console.log(`[${companyName}] Running CJK search lane`);
    for (const query of cjkQueries) {
      const results = await webSearch(query, { num: searchDepth });
      for (const r of results) addCandidate(r, "cjk");
    }
  }

  // Lane 4b: Country-localized native-language AI search
  // Issues native-language AI/strategy/governance queries with the company's
  // home-country Google locale (gl/hl) so foreign-language AI disclosures are
  // surfaced. Gated by an env flag and only runs for non-English locales.
  if (process.env.MULTILINGUAL_DISCOVERY_ENABLED !== "false" && localeProfile) {
    const localizedQueries = buildLocalizedAIQueries(companyName, framework, localeProfile);
    if (localizedQueries.length > 0) {
      console.log(`[${companyName}] Running localized ${localeProfile.lang} search lane (gl=${localeProfile.gl}, hl=${localeProfile.hl})`);
      for (const query of localizedQueries) {
        const results = await webSearch(query, { num: searchDepth, gl: localeProfile.gl, hl: localeProfile.hl });
        for (const r of results) addCandidate(r, "localized");
      }
    }
  }

  // Lane 5: Known disclosure URLs from framework
  if (framework.knownDisclosureUrls) {
    for (const url of framework.knownDisclosureUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allCandidates.push({
          url,
          title: "Framework known disclosure",
          snippet: "",
          lane: "known",
          priority: -50,
        });
        laneCounts["known"] = (laneCounts["known"] || 0) + 1;
      }
    }
  }

  // Lane 6: Auto-generated query variants (LLM-generated alternative phrasings)
  const numVariants = queryVariants;
  if (numVariants > 0) {
    console.log(`[${companyName}] Generating ${numVariants} query variants for broader discovery`);
    const variantQueries = await generateQueryVariants(companyName, generalQueries, numVariants, framework);
    if (variantQueries.length > 0) {
      console.log(`[${companyName}] Running ${variantQueries.length} variant queries`);
      for (const query of variantQueries) {
        const results = await webSearch(query, { num: searchDepth });
        for (const r of results) addCandidate(r, "variant");
      }
    }
  }

  // Lane 7: Multi-Document Sourcing Expansion
  // Targets specialized policy documents, ancillary disclosures, and regulatory filings
  // that are often separate from the main sustainability/climate report.
  console.log(`[${companyName}] Running multi-document sourcing expansion lane`);
  const multiDocQueries = buildMultiDocumentQueries(companyName, framework);
  for (const query of multiDocQueries) {
    const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
    for (const r of results) addCandidate(r, "multi-doc");
  }

  // Lane 8: SEC / Regulatory Filings (10-K, proxy DEF 14A, annual reports)
  // These are critical for non-ESG topics where evidence lives in financial filings
  // rather than sustainability reports.
  console.log(`[${companyName}] Running SEC/regulatory filing search lane`);
  const filingQueries = buildRegulatoryFilingQueries(companyName, framework, topicPhrases);
  for (const query of filingQueries) {
    const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
    for (const r of results) addCandidate(r, "regulatory");
  }

  // Lane 8a (v3g, Bug 5): AUTHORITATIVE EDGAR submissions seed. Web search misses
  // an issuer's most-recent 10-K/20-F non-deterministically (observed: Salesforce
  // FY2025). Resolve the CIK from EDGAR's ticker map and read the structured
  // submissions JSON to PIN the canonical primary-document URL(s) for the newest
  // annual filing(s). Deterministic, issuer-agnostic, additive.
  try {
    const annual = await resolveAuthoritativeAnnualFilings({ companyName, ticker: opts.ticker, maxFilings: 2 });
    for (const f of annual) {
      if (!seenUrls.has(f.url)) {
        seenUrls.add(f.url);
        allCandidates.push({
          url: f.url,
          title: `${companyName} ${f.form} (EDGAR ${f.date})`,
          snippet: "Authoritative EDGAR primary-document filing (resolved via submissions API)",
          lane: "edgar-submissions",
          priority: -60, // very high so it survives the pre-gate cap
        });
        laneCounts["edgar-submissions"] = (laneCounts["edgar-submissions"] || 0) + 1;
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] EDGAR submissions seed lane failed: ${e?.message}`);
  }

  // Lane 8b: A-share / China primary-filing lane (cninfo / SSE / SZSE)
  // For mainland-China issuers, the genuine annual report (年度报告) lives on the
  // official disclosure portals, not on generic web search (which surfaces news
  // wrappers and wrong-entity US/HK filings). Keyed off CN ISIN + Chinese name.
  if (isChinaAShare(opts.isin, opts.country)) {
    console.log(`[${companyName}] Running A-share primary-filing search lane (cninfo/SSE/SZSE)`);
    const { queries: aShareQueries, code: aShareCode } = await buildAShareFilingQueries(
      companyName,
      opts.isin,
      topicPhrases,
    );
    for (const query of aShareQueries) {
      const results = await webSearch(query, { num: Math.min(searchDepth, 10), gl: "cn", hl: "zh-cn" });
      for (const r of results) addCandidate(r, "a-share-filing");
    }
    // ROBUST full-PDF resolution: pull the genuine annual-report PDFs straight
    // from cninfo's official announcement API and PIN them. These are direct,
    // static, fetchable PDFs (static.cninfo.com.cn), which fixes the volatility
    // that caused Chinese issuers (e.g. 360 Security) to lose their primary
    // evidence when the SPA listing pages failed to fetch.
    try {
      const cninfoPdfs = await resolveCninfoStaticPdfs(companyName, aShareCode);
      for (const pdfUrl of cninfoPdfs) {
        if (!seenUrls.has(pdfUrl)) {
          seenUrls.add(pdfUrl);
          allCandidates.push({
            url: pdfUrl,
            title: `${companyName} 年度报告 (cninfo official)`,
            snippet: "Official cninfo annual-report PDF (resolved via announcement API)",
            lane: "a-share-cninfo-api",
            // High priority (low number) so it survives the pre-gate cap.
            priority: -50,
          });
          laneCounts["a-share-cninfo-api"] = (laneCounts["a-share-cninfo-api"] || 0) + 1;
        }
      }
    } catch (cninfoErr: any) {
      console.warn(`[${companyName}] cninfo API lane failed: ${cninfoErr?.message}`);
    }
  }

  // Lane 9: Investor Relations / Annual Report direct search
  // Targets investor presentations, earnings transcripts, and annual reports
  // that often contain strategy/governance disclosures missed by ESG-focused queries.
  console.log(`[${companyName}] Running investor relations search lane`);
  const irQueries = buildInvestorRelationsQueries(companyName, effectiveDomain, framework);
  for (const query of irQueries) {
    const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
    for (const r of results) addCandidate(r, "investor-relations");
  }

  // Lane 10a: Universal disclosure queries (runs for ALL companies)
  // Cross-sector document types: capital markets day, risk frameworks,
  // responsible AI, digital transformation, regulatory filings.
  console.log(`[${companyName}] Running universal disclosure search lane`);
  const universalQueries = buildUniversalDisclosureQueries(companyName, framework);
  for (const query of universalQueries) {
    const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
    for (const r of results) addCandidate(r, "universal-disclosure");
  }

  // Lane 10b: Sector-specific terminology (only if sector is known)
  // Only queries that use jargon unique to one sector (e.g., Pillar 3 for banks,
  // R&D day for pharma, OT strategy for industrials).
  if (opts.sector) {
    console.log(`[${companyName}] Running sector-specific search lane (sector: ${opts.sector})`);
    const sectorQueries = buildSectorSpecificQueries(companyName, opts.sector, framework);
    for (const query of sectorQueries) {
      const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
      for (const r of results) addCandidate(r, "sector-specific");
    }
  }

  console.log(`[${companyName}] Discovery found ${allCandidates.length} total candidates`);

  // PRE-GATE HEURISTIC: Remove candidates whose title prominently mentions
  // a DIFFERENT company name. This catches obvious cross-company contamination
  // cheaply before the LLM gate runs.
  const companyNameLower = companyName.toLowerCase();
  const companyNameWords = companyNameLower.split(/[\s,\.\-&]+/).filter(w => w.length >= 3 && !['inc', 'ltd', 'plc', 'corp', 'group', 'the', 'and', 'company', 'limited', 'corporation', 'holdings', 'international'].includes(w));
  const KNOWN_OTHER_COMPANIES = [
    "blackrock", "vanguard", "state street", "fidelity", "jpmorgan", "goldman sachs",
    "morgan stanley", "citigroup", "bank of america", "wells fargo", "hsbc", "barclays",
    "deutsche bank", "ubs", "credit suisse", "bnp paribas", "societe generale",
    "atlassian", "salesforce", "microsoft", "google", "amazon", "meta", "apple",
    "nvidia", "tesla", "oracle", "ibm", "intel", "cisco", "adobe", "netflix",
    "glaukos", "cirrus logic", "american integrity",
  ];

  // Entity-specific exclusions: distinct issuers that share an ambiguous token
  // with the target (e.g. "360" → Qifu / 360 DigiTech / 360 Finance). These must
  // be rejected even when the title also contains the shared token, because the
  // generic name-match below would otherwise rescue them.
  const excludeEntities = disambiguationExclusions(companyName);
  const url2 = (s: string) => s.toLowerCase();

  const filteredCandidates = allCandidates.filter(c => {
    const titleLower = c.title.toLowerCase();
    const haystack = titleLower + " " + url2(c.url);
    // Hard exclude known-distinct entities sharing an ambiguous token, UNLESS
    // the candidate is from an official A-share portal (those are issuer-correct).
    if (excludeEntities.length > 0) {
      const onOfficialPortal = /cninfo\.com\.cn|sse\.com\.cn|szse\.cn/.test(url2(c.url));
      if (!onOfficialPortal && excludeEntities.some(ex => haystack.includes(ex))) {
        laneCounts["pre-gate-disambiguated"] = (laneCounts["pre-gate-disambiguated"] || 0) + 1;
        return false;
      }
    }
    // If title contains the target company name, always keep
    if (companyNameWords.some(w => titleLower.includes(w))) return true;
    // If title prominently mentions a known OTHER company, reject
    const mentionsOther = KNOWN_OTHER_COMPANIES.some(other => {
      // Don't reject if the other company name is part of our company name
      if (companyNameLower.includes(other)) return false;
      return titleLower.includes(other);
    });
    if (mentionsOther) {
      laneCounts["pre-gate-rejected"] = (laneCounts["pre-gate-rejected"] || 0) + 1;
      return false;
    }
    return true;
  });

  if ((laneCounts["pre-gate-disambiguated"] || 0) > 0) {
    console.log(`[${companyName}] Disambiguation removed ${laneCounts["pre-gate-disambiguated"]} wrong-entity candidates (${excludeEntities.join(", ")})`);
  }

  if (filteredCandidates.length < allCandidates.length) {
    console.log(`[${companyName}] Pre-gate heuristic removed ${allCandidates.length - filteredCandidates.length} candidates mentioning other companies`);
  }

  // Cap before gate to bound LLM cost
  const preGateCandidates = filteredCandidates
    .sort((a, b) => a.priority - b.priority)
    .slice(0, PRE_GATE_CAP);

  // Run relevance gate
  console.log(`[${companyName}] Running relevance gate on ${preGateCandidates.length} candidates`);
  const accepted = await runRelevanceGate(preGateCandidates, framework, companyName, {
    sector: opts.sector,
    country: opts.country,
    isin: opts.isin,
    domain: effectiveDomain || companyDomain,
  });

  console.log(`[${companyName}] Gate accepted ${accepted.length} documents`);

  // Layer A — Recency gate: trim the historical-filing flood so stale, topic-free
  // periodic filings don't dilute the corpus. Keeps newest-N-per-type within the
  // validity window; never drops non-periodic docs (policies, IR, ESG, governance).
  // v3e (Section 1): before gating, authoritatively resolve EDGAR filing dates for
  // any accession-bearing URLs (handles the 18-digit dashless archive form the URL
  // heuristics previously missed), so stale 10-Ks are gated on REAL dates instead
  // of failing open. Best-effort; failures fall back to URL/title heuristics.
  try {
    await enrichEdgarFilingDates(accepted.map((d) => d.url));
  } catch (e: any) {
    console.warn(`[${companyName}] EDGAR date enrichment skipped: ${e?.message}`);
  }
  const { kept: recencyKept, dropped: recencyDropped } = applyRecencyGate(accepted);
  if (recencyDropped.length > 0) {
    console.log(`[${companyName}] Recency gate dropped ${recencyDropped.length} stale/duplicate periodic filings (kept ${recencyKept.length})`);
  }
  const recencyFiltered = recencyKept;

  // Tier-based re-ranking: boost Tier 1 and Tier 2 documents to ensure they
  // are included even if their raw priority score is lower than ESG reports.
  for (const doc of recencyFiltered) {
    const tier = classifyDocumentTier(doc.url, doc.title);
    if (tier === 1) doc.priority -= 15; // Strong boost for mandatory filings
    else if (tier === 2) doc.priority -= 7; // Moderate boost for priority disclosures
    // Tier 3 stays as-is; Tier 4 should already be filtered by deny list
  }

  // Sort by priority and cap
  const finalDocs = recencyFiltered
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_DOCS_RETURNED);

  // Compute coverage metric
  const coverage = computeCoverageMetric(finalDocs);
  console.log(`[${companyName}] Coverage: ${coverage.coverageLevel} (Tier1: ${coverage.tier1Count}, Tier2: ${coverage.tier2Count}, Tier3: ${coverage.tier3Count})`);
  if (coverage.missingTier1Types.length > 0) {
    console.warn(`[${companyName}] Missing mandatory sources: ${coverage.missingTier1Types.join(", ")}`);
  }

  // v3e (Section 4): fingerprint the selected corpus (sorted URL set) for repeatability.
  const candidateFingerprint = createHash("sha1")
    .update(finalDocs.map((d) => d.url).sort().join("\n"))
    .digest("hex");
  console.log(`[${companyName}] Discovery corpus fingerprint: ${candidateFingerprint.slice(0, 12)} (${finalDocs.length} docs)`);

  const diagnostics: DiscoveryDiagnostics = {
    totalCandidates: allCandidates.length,
    acceptedByGate: accepted.length,
    finalCount: finalDocs.length,
    lanes: laneCounts,
    topUrls: finalDocs.slice(0, 20).map((d) => ({
      url: d.url,
      title: d.title,
      priority: d.priority,
    })),
    coverage,
    candidateFingerprint,
  };

  return { documents: finalDocs, diagnostics, effectiveDomain, domainAutoDetected };
}

// ─── Ensemble Discovery (multiple passes with varied phrasing) ───────────────

export async function searchCompanyDocumentsWithEnsemble(opts: {
  companyName: string;
  companyId: number;
  companyDomain?: string | null;
  isin?: string | null;
  pinnedUrls?: string[];
  framework: Framework;
  trustedSources: TrustedSource[];
  iterations?: number;
}): Promise<DiscoveryResult> {
  const iterations = opts.iterations || 1;

  if (iterations <= 1) {
    return searchCompanyDocuments(opts);
  }

  // Multiple passes with slightly varied queries
  const allDocs: DiscoveryCandidate[] = [];
  const seenUrls = new Set<string>();
  let effectiveDomain: string | null = opts.companyDomain || null;
  let domainAutoDetected = false;

  for (let i = 0; i < iterations; i++) {
    const result = await searchCompanyDocuments(opts);
    for (const doc of result.documents) {
      if (!seenUrls.has(doc.url)) {
        seenUrls.add(doc.url);
        allDocs.push(doc);
      }
    }
    // Capture the first auto-detected domain so the pipeline can persist it
    if (result.effectiveDomain && !effectiveDomain) {
      effectiveDomain = result.effectiveDomain;
      domainAutoDetected = !!result.domainAutoDetected;
    }
  }

  const finalDocs = allDocs
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_DOCS_RETURNED);

  return {
    documents: finalDocs,
    diagnostics: {
      totalCandidates: allDocs.length,
      acceptedByGate: allDocs.length,
      finalCount: finalDocs.length,
      lanes: {},
      topUrls: finalDocs.slice(0, 20).map((d) => ({
        url: d.url,
        title: d.title,
        priority: d.priority,
      })),
    },
    effectiveDomain,
    domainAutoDetected,
  };
}
