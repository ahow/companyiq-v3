import axios from "axios";
import { createHash } from "crypto";
import { db } from "../db";
import { sql } from "drizzle-orm";
import * as storage from "../storage.js";
import { completeWithFallback } from "./ai-providers.js";
import { deriveTopicLexicon } from "./topic-lexicon.js";
import {
  computeRankSignals,
  compareSignals,
  collapseNearDuplicates,
  computeRankerDiagnostics,
  type RankSignals,
  type ComputeOpts,
} from "./ranking.js";
import type { Framework, TrustedSource } from "../../shared/schema.js";
import { deriveAliases, resolveCompanyFIGI } from "./issuer-resolver.js";
import { resolveViaFmp, fmpWebsiteToDomain } from "./fmp-resolver.js";
import { PIPELINE_VERSION } from "./pipeline-version.js";
import { resolveIssuerProfile, scoreEntityMatch, type IssuerProfile } from "./issuer-profile.js";
import {
  extractIRPlatformTenants,
  buildIRPlatformSeedQueries,
  buildLocaleTopicQueries,
  buildRegulatorRepositoryUrls,
  buildJurisdictionDocTypeQueries,
  isEsgLandingPage,
  extractLandingPageLinks,
  buildSubpageEnumerationQueries,
  enumerateRegulatorFilings,
  parseSitemapForSubpaths,
  enumerateTenantDirectory,
  probeLandingPages,
  fetchWithGzipFallback,
} from "./r6-discovery.js";
import { expandQueries, type QueryExpansionResult } from "./query-expansion.js";
import {
  buildRegistrySearchTerms,
  processRegistryResults,
  aggregateRegistryResults,
  emptyRegistrySummary,
  type RegistrySearchSummary,
} from "./registry-adapter.js";
import {
  RetrievalDiagnosticsBuilder,
  mergeRetrievalDiagnostics,
  type RetrievalDiagnostics,
} from "./retrieval-diagnostics.js";

const MAX_DOCS_RETURNED = 90;
const PRE_GATE_CAP = 180;
const SEARCH_TIMEOUT = 15000;

// ─── Document Tier Classification ──────────────────────────────────────────
// Tier 1 (mandatory): 10-K, 20-F, annual report, proxy/DEF 14A, AGM circular
// Tier 2 (priority): Investor presentations, governance pages, AI/responsible-AI policy, press releases
// Tier 3 (supplementary): ESG/sustainability reports, CDP responses, third-party assessments
// Tier 4 (noise): Podcasts, app stores, job listings, unrelated third-party content

export type DocumentTier = 1 | 2 | 3 | 4;

export function classifyDocumentTier(
  url: string,
  title: string,
  frameworkSignals?: {
    /** Slugified topic phrases from deriveTopicLexicon */
    topicSlugs?: string[];
    /** Required doc-type slugs from the framework's requiredDocTypes */
    requiredDocSlugs?: string[];
  },
): DocumentTier {
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();
  const combined = urlLower + " " + titleLower;

  // ─── Tier 4: Noise (deny-listed sources) ─────────────────────
  if (isUrlDenied(urlLower)) return 4;

  // ─── Tier 1: Universal mandatory filings ─ genuinely topic-agnostic ───
  const tier1Patterns = [
    /10-?k/i, /20-?f/i, /def.?14a/i, /proxy.?statement/i,
    /annual.?report/i, /agm.?circular/i, /annual.?general.?meeting/i,
    /integrated.?report/i,
  ];
  const tier1Domains = ["sec.gov", "sedarplus.ca", "asx.com.au", "hkexnews.hk"];
  if (tier1Domains.some(d => urlLower.includes(d))) return 1;
  if (tier1Patterns.some(p => p.test(combined))) return 1;

  // ─── Tier 2a: Framework-declared required-doc slugs ─────────────
  if (frameworkSignals?.requiredDocSlugs?.length) {
    for (const slug of frameworkSignals.requiredDocSlugs) {
      const rx = new RegExp(slug.replace(/[-_\s]+/g, "[.\\-_\\s]?"), "i");
      if (rx.test(combined)) return 2;
    }
  }

  // ─── Tier 2b: Universal priority disclosures ─ topic-agnostic types only
  const tier2Patterns = [
    /investor.?relation/i, /investor.?presentation/i, /investor.?day/i,
    /capital.?markets.?day/i, /earnings/i,
    /governance/i, /corporate.?governance/i, /board.?of.?directors/i,
    /press.?release/i, /newsroom/i, /media.?release/i,
    /strategy.?presentation/i, /pillar.?3/i, /risk.?factor/i,
    /r&d.?day/i, /research.?day/i, /science.?day/i,
  ];
  if (tier2Patterns.some(p => p.test(combined))) return 2;

  // ─── Tier 3: Framework-derived topic slugs (replaces hardcoded climate/AI list)
  if (frameworkSignals?.topicSlugs?.length) {
    for (const slug of frameworkSignals.topicSlugs) {
      const rx = new RegExp(slug.replace(/[-_\s]+/g, "[.\\-_\\s]?"), "i");
      if (rx.test(combined)) return 3;
    }
  }

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

// Recency-gate window: keep every periodic filing whose year is >= (now - windowYears + 1).
// Default 4 years → window covers current year plus 3 back, so a truth doc from 2024 stays
// alongside 2025 and 2026 disclosures for analyst-cited-evidence evaluation.
const RECENCY_WINDOW_YEARS = parseInt(process.env.DISCOVERY_RECENCY_WINDOW_YEARS || "4", 10);
// Cap only applies to filings OUTSIDE the recency window: we keep the newest
// OUT_OF_WINDOW_SOFT_CAP historical instances per type as context (previously the cap
// applied to all filings including in-window ones, which was silently dropping analyst-cited docs).
const OUT_OF_WINDOW_SOFT_CAP = parseInt(process.env.DISCOVERY_OUT_OF_WINDOW_SOFT_CAP || "2", 10);
// Legacy env var kept for backwards-compatibility (unused for in-window filings now).
const MAX_PER_PERIODIC_TYPE = parseInt(process.env.DISCOVERY_MAX_PER_PERIODIC_TYPE || "999", 10);

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
export function detectSourceTypes(url: string, title: string, declaredSourceTypes: string[] = []): Set<string> {
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

  // Framework-declared source categories are matched from their persisted labels.
  // This keeps topic-specific document classes in framework data, not executable
  // discovery logic.
  for (const sourceType of declaredSourceTypes) {
    const tokens = sourceType.toLowerCase().split(/[\s_\-/]+/).filter((token) => token.length >= 3);
    const matched = tokens.filter((token) => s.includes(token)).length;
    if (tokens.length > 0 && matched >= Math.min(2, tokens.length)) {
      types.add(sourceType);
    }
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
export function corpusSourceTypes(
  docs: Array<{ url: string; title?: string | null }>,
  declaredSourceTypes: string[] = [],
): Set<string> {
  const all = new Set<string>();
  for (const d of docs) {
    for (const t of detectSourceTypes(d.url, d.title || "", declaredSourceTypes)) all.add(t);
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
  opts?: { windowYears?: number; maxPerType?: number; outOfWindowSoftCap?: number; nowYear?: number }
): { kept: T[]; dropped: T[] } {
  const windowYears = opts?.windowYears ?? RECENCY_WINDOW_YEARS;
  // maxPerType kept for backward-compat but only used as an absolute ceiling; the
  // primary behaviour is to keep ALL in-window filings + at most `outOfWindowSoftCap`
  // historical instances per type.
  const absoluteMaxPerType = opts?.maxPerType ?? MAX_PER_PERIODIC_TYPE;
  const outOfWindowSoftCap = opts?.outOfWindowSoftCap ?? OUT_OF_WINDOW_SOFT_CAP;
  const nowYear = opts?.nowYear ?? new Date().getFullYear();
  const minYear = nowYear - windowYears + 1; // inclusive lower bound

  const kept: T[] = [];
  const dropped: T[] = [];
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

    // Split into in-window and out-of-window buckets.
    const inWindow: Array<{ doc: T; year: number | null }> = [];
    const outOfWindow: Array<{ doc: T; year: number | null }> = [];
    for (const entry of entries) {
      // Unknown year fails open into the in-window bucket (existing behaviour).
      const withinWindow = entry.year === null || entry.year >= minYear;
      (withinWindow ? inWindow : outOfWindow).push(entry);
    }

    // Keep ALL in-window filings up to the absolute ceiling. The ceiling exists
    // only to prevent runaway corpus growth on issuers with dozens of near-duplicate
    // filings; it should rarely trigger with default settings.
    let keptOfType = 0;
    for (const { doc, year } of inWindow) {
      if (keptOfType < absoluteMaxPerType) {
        kept.push(doc);
        keptOfType++;
      } else {
        dropped.push(doc);
        console.log(`[recency] DROP ${ptype} (year=${year ?? "?"}): exceeds absolute cap ${absoluteMaxPerType} per type — ${doc.url}`);
      }
    }

    // Historical context: keep the newest OUT_OF_WINDOW_SOFT_CAP filings older than the window.
    // Prevents complete loss of historical context (e.g. 5-year trend analysis) while
    // still preventing the corpus being dominated by ancient filings.
    let historicalKept = 0;
    for (const { doc, year } of outOfWindow) {
      if (historicalKept < outOfWindowSoftCap) {
        kept.push(doc);
        historicalKept++;
        console.log(`[recency] keep-historical ${ptype} (year=${year ?? "?"}): within soft cap ${outOfWindowSoftCap} — ${doc.url}`);
      } else {
        dropped.push(doc);
        console.log(`[recency] DROP ${ptype} (year=${year ?? "?"}): older than window (< ${minYear}) and beyond soft cap ${outOfWindowSoftCap} — ${doc.url}`);
      }
    }

    if (keptOfType + historicalKept > 0) {
      console.log(`[recency] kept ${keptOfType} in-window + ${historicalKept} historical of type ${ptype} (window>=${minYear})`);
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
  /** Framework-agnostic: which requiredDocTypes were found in the corpus */
  requiredDocsFound: Record<string, boolean>;
  coverageLevel: "full" | "adequate" | "low" | "minimal";
  missingTier1Types: string[];
}

export function computeCoverageMetric(
  documents: DiscoveryCandidate[],
  frameworkSignals?: { topicSlugs?: string[]; requiredDocSlugs?: string[]; requiredDocTypes?: string[] },
): CoverageMetric {
  let tier1Count = 0, tier2Count = 0, tier3Count = 0, tier4Count = 0;
  let has10KOrAnnualReport = false;
  let hasProxyOrDEF14A = false;
  let hasInvestorPresentation = false;
  let hasGovernancePage = false;
  const requiredDocsFound: Record<string, boolean> = {};
  const requiredDocTypes = frameworkSignals?.requiredDocTypes || [];

  for (const doc of documents) {
    const tier = classifyDocumentTier(doc.url, doc.title, frameworkSignals);
    const urlLower = doc.url.toLowerCase();
    const titleLower = doc.title.toLowerCase();
    const combined = urlLower + " " + titleLower;

    switch (tier) {
      case 1: tier1Count++; break;
      case 2: tier2Count++; break;
      case 3: tier3Count++; break;
      case 4: tier4Count++; break;
    }

    // Universal type detection
    if (/10-?k|20-?f|annual.?report|integrated.?report/i.test(combined)) {
      has10KOrAnnualReport = true;
    }
    if (/def.?14a|proxy.?statement|agm.?circular/i.test(combined)) {
      hasProxyOrDEF14A = true;
    }
    if (/investor.?presentation|investor.?day|capital.?markets/i.test(combined)) {
      hasInvestorPresentation = true;
    }
    if (/governance|board.?of.?directors/i.test(combined)) {
      hasGovernancePage = true;
    }
    // Framework-agnostic: check each requiredDocType
    for (const docType of requiredDocTypes) {
      if (requiredDocsFound[docType]) continue;
      const words = docType.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3);
      if (words.length === 0) continue;
      const matched = words.filter((w: string) => combined.includes(w)).length;
      if (matched >= Math.min(2, words.length)) {
        requiredDocsFound[docType] = true;
      }
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
    hasGovernancePage, requiredDocsFound,
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

  // Instruction 21b: No topic-specific branches. Universal queries only.
  // Topic-specific queries are handled by legacyQueryTemplates and searchTemplates.

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
  framework: Framework,
  topicPhrases?: string[],
): string[] {
  if (!sector) return [];
  const sectorLower = sector.toLowerCase();
  const queries: string[] = [];
  const topPhrase = topicPhrases && topicPhrases[0];
  const topPhrase2 = topicPhrases && topicPhrases[1];

  // Financials: legitimately universal anchors
  if (/financ|bank|insurance|asset.?manage/i.test(sectorLower)) {
    queries.push(
      `"${companyName}" Pillar 3 disclosure 2024 OR 2023`,
      `"${companyName}" operational risk OR model risk management`,
    );
    // Sector × topic — fires for ANY topic if topicPhrases were supplied
    if (topPhrase) {
      queries.push(
        `"${companyName}" ${topPhrase} risk framework`,
        `"${companyName}" ${topPhrase} disclosure Pillar 3`,
      );
    }
    if (topPhrase2) {
      queries.push(`"${companyName}" ${topPhrase2} risk management`);
    }
  }

  // Pharma / Healthcare
  if (/pharma|health|biotech|life.?science|medical/i.test(sectorLower)) {
    queries.push(
      `"${companyName}" R&D day OR research day OR pipeline day presentation`,
      `"${companyName}" science day presentation`,
    );
    if (topPhrase) {
      queries.push(`"${companyName}" ${topPhrase} clinical development`);
    }
  }

  // Industrials
  if (/industrial|manufactur|engineer|aerospace|defense|auto/i.test(sectorLower)) {
    queries.push(`"${companyName}" operational technology OT strategy`);
    if (topPhrase) {
      queries.push(`"${companyName}" ${topPhrase} operations`);
    }
  }

  // Energy / Utilities — topic-agnostic
  if (/energy|utilit|oil|gas|mining|basic.?material/i.test(sectorLower)) {
    if (topPhrase) {
      queries.push(
        `"${companyName}" ${topPhrase} operations`,
        `"${companyName}" ${topPhrase} exploration`,
      );
    }
  }

  // Real Estate
  if (/real.?estate|property|reit/i.test(sectorLower)) {
    if (topPhrase) {
      queries.push(`"${companyName}" ${topPhrase} portfolio`);
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

// ─── Search Result Cache (I36-A: eliminate cross-battery non-determinism) ────
// Caches search results by query+opts for 24 hours. Two batteries on the same
// commit within 24h will see identical discovery candidates, making the only
// remaining variance source the fetch phase (which is already stabilised by
// the document pool and batch_corpus snapshot).

const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const searchCache = new Map<string, { results: SearchResult[]; ts: number }>();

function searchCacheKey(query: string, opts: Record<string, any>): string {
  return createHash("sha256").update(JSON.stringify({ q: query, ...opts })).digest("hex").slice(0, 16);
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

// ─── Global Search Rate Limiter (Token Bucket) ─────────────────────────────
// Shared across all workers in this process. Prevents concurrent batch runs
// from collectively overwhelming the search provider with 300+ simultaneous calls.
const SEARCH_RATE_LIMIT = {
  tokens: 8,           // Max concurrent in-flight searches
  maxTokens: 8,
  refillRate: 4,       // Tokens restored per second
  lastRefill: Date.now(),
  waitQueue: [] as Array<() => void>,
};

async function acquireSearchToken(): Promise<void> {
  // Refill tokens based on elapsed time
  const now = Date.now();
  const elapsed = (now - SEARCH_RATE_LIMIT.lastRefill) / 1000;
  SEARCH_RATE_LIMIT.tokens = Math.min(
    SEARCH_RATE_LIMIT.maxTokens,
    SEARCH_RATE_LIMIT.tokens + elapsed * SEARCH_RATE_LIMIT.refillRate
  );
  SEARCH_RATE_LIMIT.lastRefill = now;

  if (SEARCH_RATE_LIMIT.tokens >= 1) {
    SEARCH_RATE_LIMIT.tokens -= 1;
    return;
  }

  // Wait for a token to become available
  return new Promise<void>((resolve) => {
    SEARCH_RATE_LIMIT.waitQueue.push(resolve);
    // Safety timeout: never wait more than 30s
    setTimeout(() => {
      const idx = SEARCH_RATE_LIMIT.waitQueue.indexOf(resolve);
      if (idx >= 0) { SEARCH_RATE_LIMIT.waitQueue.splice(idx, 1); resolve(); }
    }, 30000);
  });
}

function releaseSearchToken(): void {
  SEARCH_RATE_LIMIT.tokens = Math.min(SEARCH_RATE_LIMIT.maxTokens, SEARCH_RATE_LIMIT.tokens + 1);
  SEARCH_RATE_LIMIT.lastRefill = Date.now();
  if (SEARCH_RATE_LIMIT.waitQueue.length > 0) {
    const next = SEARCH_RATE_LIMIT.waitQueue.shift()!;
    SEARCH_RATE_LIMIT.tokens -= 1;
    next();
  }
}

async function webSearch(
  query: string,
  opts: { num?: number; tbs?: string; gl?: string; hl?: string } = {}
): Promise<SearchResult[]> {
  // I36-A: Check in-memory search cache first (24h TTL)
  const cKey = searchCacheKey(query, opts);
  const cached = searchCache.get(cKey);
  if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL_MS) {
    return cached.results;
  }

  // Global rate limiter: acquire a token before making any search API call
  await acquireSearchToken();
  try {
    const results = await webSearchInner(query, opts);
    // Store in cache
    searchCache.set(cKey, { results, ts: Date.now() });
    // Evict stale entries periodically (keep cache bounded)
    if (searchCache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of searchCache) {
        if (now - v.ts > SEARCH_CACHE_TTL_MS) searchCache.delete(k);
      }
    }
    return results;
  } finally {
    releaseSearchToken();
  }
}

async function webSearchInner(
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
      // On 429 (rate limit), wait and retry once
      if (error?.response?.status === 429) {
        console.warn(`[Discovery] Serper 429 rate-limited, backing off 5s for "${query.slice(0, 60)}"`);
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 2000));
        try { return await webSearchSerper(query, serperKey, opts); } catch { /* fall through */ }
      }
      console.warn(`[Discovery] Serper.dev failed for "${query}": ${error.message}`);
      // Fall through to SerpAPI
    }
  }

  if (serpApiKey) {
    try {
      return await webSearchSerpApi(query, serpApiKey, opts);
    } catch (error: any) {
      if (error?.response?.status === 429) {
        console.warn(`[Discovery] SerpAPI 429 rate-limited, backing off 5s for "${query.slice(0, 60)}"`);
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 2000));
        try { return await webSearchSerpApi(query, serpApiKey, opts); } catch { /* give up */ }
      }
      console.warn(`[Discovery] SerpAPI failed for "${query}": ${error.message}`);
      return [];
    }
  }

  console.error("[Discovery] No search API key configured (SERPER_API_KEY or SERP_API_KEY)");
  return [];
}

// ─── Authoritative Registry Search Lane (framework-driven) ────────────────────
// Frameworks declare authoritative registry domains as data. Discovery uses the
// same broad site-search strategy for every declared domain; no registry-specific
// URL construction or topic branch is embedded in the pipeline.
async function discoverRegistryLane(
  companyName: string,
  aliases: string[],
  isin: string | null | undefined,
  frameworkRegistries: string[],
): Promise<{ url: string; title: string; source: string }[]> {
  const terms = Array.from(new Set([
    companyName,
    ...aliases,
    ...(isin ? [isin] : []),
  ].map((value) => value.trim()).filter(Boolean))).slice(0, 5);
  const results: { url: string; title: string; source: string }[] = [];
  const seen = new Set<string>();

  for (const registry of frameworkRegistries) {
    const domain = registry
      .trim()
      .replace(/^https?:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .toLowerCase();
    if (!domain) continue;

    for (const term of terms) {
      try {
        const siteResults = await webSearch(`site:${domain} "${term}"`, { num: 15 });
        for (const result of siteResults) {
          if (!result.link || seen.has(result.link)) continue;
          seen.add(result.link);
          results.push({ url: result.link, title: result.title, source: "registry-search" });
        }
      } catch {
        // An unavailable registry is non-fatal; other declared sources still run.
      }
    }
  }

  return results.sort((a, b) =>
    a.url.localeCompare(b.url) || a.title.localeCompare(b.title)
  );
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

export interface DiscoveryCandidate {
  url: string;
  title: string;
  snippet: string;
  lane: string;
  priority: number;
  /** v3l: layered ranking signals (authorityClass, fineScore, urlHash). Set
   *  by the final selection step; absent on raw candidates. */
  rank?: RankSignals;
}

interface GeneralQueryResult {
  queries: string[];
  templateCount: number;
  legacyCount: number;
  metadataCount: number;
}

function buildGeneralQueries(companyName: string, framework: Framework, companyDomain?: string): GeneralQueryResult {
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  const allQueries: string[] = [];
  const seen = new Set<string>();
  const addQuery = (q: string) => {
    const key = q.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); allQueries.push(q); }
  };

  // LAYER 1: searchTemplates (user-authored, framework-specific)
  if (framework.searchTemplates && framework.searchTemplates.length > 0) {
    for (const t of framework.searchTemplates) {
      addQuery(t.replace(/\{company\}/g, companyName));
    }
  }
  const templateEnd = allQueries.length;

  // LAYER 2: Data-driven legacy queries from framework.legacyQueryTemplates.
  // These are topic-tuned queries stored as data on the framework record.
  // Placeholders: {company}, {currentYear}, {lastYear}
  const legacyTemplates = (framework as any).legacyQueryTemplates as string[] | null;
  if (legacyTemplates && legacyTemplates.length > 0) {
    for (const t of legacyTemplates) {
      addQuery(t.replace(/\{company\}/g, companyName)
                .replace(/\{currentYear\}/g, String(currentYear))
                .replace(/\{lastYear\}/g, String(lastYear)));
    }
  } else {
    // Generic fallback for frameworks that haven't been configured with legacyQueryTemplates.
    // Uses the framework's topic description to build broad queries.
    const topic = (framework.topicDescription || framework.name || "");
    const topicWords = topic.split(/\s+/).filter((w: string) => w.length > 3).slice(0, 5).join(" ");
    for (const q of [
      `"${companyName}" ${topicWords}`,
      `"${companyName}" ${topicWords} ${currentYear}`,
      `"${companyName}" annual report`,
      `"${companyName}" governance`,
      `"${companyName}" policy framework`,
      `"${companyName}" corporate responsibility report`,
    ]) addQuery(q);
  }

  const legacyEnd = allQueries.length;
  const legacyCount = legacyEnd - templateEnd;

  // LAYER 3: ADDITIVE metadata-driven queries from requiredDocTypes.
  // These AUGMENT the above layers. Deduplication via the seen set.
  //
  // R1 (2026-09-04): the query patterns for this layer were moved to a
  // separate helper `buildDisclosureVehicleQueries` so the same query
  // construction can be reused by other lanes (domain, multi-doc) and by
  // unit tests. The old three-pattern set (quoted / filetype:pdf /
  // unquoted+year) survives as the default, plus the caller passes in the
  // requiredDocTypes list unchanged.
  //
  // I61: also emits queries against derived aliases (initialism, concatenated
  // form) so parent-brand documents surface under acronym-branded issuers
  // (e.g. SMFG / MUFG / BSCH). Alias generation happens inside
  // buildDisclosureVehicleQueries.
  const requiredDocTypes = (framework as any).requiredDocTypes as string[] | null;
  if (requiredDocTypes && requiredDocTypes.length > 0) {
    const aliases = deriveAliases(companyName, null)
      .filter((a) => a && a.length >= 2 && a.toLowerCase() !== companyName.toLowerCase())
      .slice(0, 2);
    const vehicleQueries = buildDisclosureVehicleQueries(companyName, framework, aliases, { maxVehicles: 8 });
    for (const q of vehicleQueries) addQuery(q);
    // Retain the site: query — buildDisclosureVehicleQueries deliberately
    // omits site: patterns because those belong to buildDomainQueries.
    const domain = companyDomain || "";
    if (domain) {
      for (const docType of requiredDocTypes.slice(0, 5)) {
        addQuery(`site:${domain} ${docType}`);
      }
    }
  }

  const metadataCount = allQueries.length - legacyEnd;
  return { queries: allQueries, templateCount: templateEnd, legacyCount, metadataCount };
}

/**
 * R1 (2026-09-04) — Disclosure-vehicle discovery queries.
 *
 * Generates queries whose PATTERNS target the titles / filenames of typical
 * disclosure documents (e.g. "sustainability report", "annual report",
 * "TNFD report") rather than the contents of those documents. Framework-
 * agnostic — reads from `framework.requiredDocTypes`, which is populated
 * from the aggregated per-measure disclosureVehicles list.
 *
 * The pre-R1 discovery pipeline had a subtle failure mode where
 * `evidence_keywords` (biodiversity impact, cross-functional team, stress
 * testing) shaped both scoring AND retrieval. Those keywords appear INSIDE
 * disclosures, not in their titles, so `"Newmont" biodiversity impact 2025`
 * failed to surface the actual Sustainability Report. This function fills
 * the gap by explicitly querying for the vehicle types.
 *
 * Rationale for the multi-pattern approach:
 *   - `"{company}" {vehicleType} filetype:pdf` — forces the actual PDF
 *   - `"{company}" {vehicleType} {yearRange}` — recency-constrained variant
 *   - `site:{domain} {vehicleType}` — IR-site-scoped variant (handled by
 *     buildDomainQueries, not here)
 *   - unquoted `{company} {vehicleType} filetype:pdf` — fuzzy fallback for
 *     companies whose full name doesn't appear verbatim in PDF titles
 *
 * @param companyName company display name
 * @param framework   framework record with requiredDocTypes populated
 * @param aliases     optional derived aliases (initialism, concatenated form)
 * @param opts.maxVehicles cap on vehicle types consumed (default 10)
 */
export function buildDisclosureVehicleQueries(
  companyName: string,
  framework: Framework,
  aliases: string[] = [],
  opts: { maxVehicles?: number } = {},
): string[] {
  const maxVehicles = opts.maxVehicles ?? 10;
  const requiredDocTypes = (framework as any).requiredDocTypes as string[] | null;
  if (!requiredDocTypes || requiredDocTypes.length === 0) return [];

  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  const nameVariants = [companyName, ...aliases.filter(a => a && a.length >= 2 && a.toLowerCase() !== companyName.toLowerCase())].slice(0, 3);

  const queries: string[] = [];
  const seen = new Set<string>();
  const addQuery = (q: string) => {
    const key = q.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); queries.push(q); }
  };

  const vehicles = requiredDocTypes.slice(0, maxVehicles);
  for (const vehicle of vehicles) {
    const v = vehicle.trim();
    if (!v) continue;

    // R7f: compound doc-type splitting. Some frameworks declare doc types as
    // compound phrases like "board committee charters or terms of reference".
    // Serper matches the full quoted phrase poorly. Split on " or " / ", " / " and " / " & "
    // and generate per-clause queries so each clause gets its own precise match.
    const clauses = v
      .split(/\s+(?:or|and|&)\s+|,\s+|\s*\/\s*/i)
      .map(s => s.trim())
      .filter(s => s.length >= 4);
    // Always include the original phrase too (some doc types read as a phrase, e.g. "10-K filing")
    const allVehicleForms = Array.from(new Set([v, ...clauses]));

    for (const vf of allVehicleForms) {
      for (const nameVariant of nameVariants) {
        // Pattern A — quoted name + vehicle + filetype (forces the PDF)
        addQuery(`"${nameVariant}" "${vf}" filetype:pdf`);
        // Pattern B — quoted name + vehicle + year range (recency-constrained)
        addQuery(`"${nameVariant}" "${vf}" ${currentYear} OR ${lastYear}`);
      }
      // Pattern C — unquoted, filetype:pdf. Fuzzy fallback.
      addQuery(`${nameVariants[0]} ${vf} filetype:pdf`);
      // Pattern D — unquoted, no filetype.
      addQuery(`${nameVariants[0]} ${vf} ${currentYear}`);

      // Pattern E (R7f) — inurl: fallback for compound-phrase clauses that
      // often appear as URL slugs but not in titles. E.g. "terms of reference"
      // → inurl:terms-of-reference; "committee charter" → inurl:charter.
      // Skip Pattern E for single-word or numeric-heavy vehicles (10-K etc)
      // where the inurl pattern is either uninformative or ambiguous.
      if (vf.split(/\s+/).length >= 2 && !/\d/.test(vf)) {
        const slug = vf.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
        // Use the strongest single word of the phrase as inurl anchor + full phrase in quotes
        const anchor = slug.split("-").filter(w => w.length >= 5).sort((a, b) => b.length - a.length)[0] || slug;
        addQuery(`"${nameVariants[0]}" inurl:${anchor} filetype:pdf`);
      }
    }
  }

  return queries;
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
  // Instruction 21b: Data-driven multi-document queries from framework record.
  // No hardcoded topic branches — reads from framework.multiDocumentQueryTemplates.
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  const templates = (framework as any).multiDocumentQueryTemplates as string[] | null;
  if (templates && templates.length > 0) {
    return templates.map(t =>
      t.replace(/\{company\}/g, companyName)
       .replace(/\{currentYear\}/g, String(currentYear))
       .replace(/\{lastYear\}/g, String(lastYear))
    );
  }
  // Generic fallback for frameworks without multiDocumentQueryTemplates
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();
  const topicWords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(" ");
  return [
    `"${companyName}" ${topicWords} policy OR framework`,
    `"${companyName}" ${topicWords} report OR disclosure`,
    `"${companyName}" ${topicWords} governance OR strategy`,
    `"${companyName}" ${topicWords} annual report`,
    `"${companyName}" ${topicWords} risk management`,
  ];
}

function buildDomainQueries(companyName: string, domain: string, framework: Framework, topicPhrases?: string[]): string[] {
  // Instruction 21b: Fully data-driven domain queries. No hardcoded topic branches.
  // Uses topicPhrases (derived from framework's topic lexicon) + requiredDocTypes.
  //
  // R1 (2026-09-04): raised the requiredDocTypes consumption cap from 5 to 10
  // to match the aggregated framework.requiredDocTypes size after the R1
  // backfill. Also added a filetype:pdf variant per vehicle type for
  // subdomains that only surface PDFs (e.g. investors.newmont.com).
  const baseQueries = [
    `site:${domain} annual report`,
    `site:${domain} governance`,
    `site:${domain} policy`,
    `site:${domain} investor relations`,
  ];

  // Add requiredDocTypes as domain queries (both plain and filetype:pdf)
  const requiredDocTypes = (framework as any).requiredDocTypes as string[] | null;
  if (requiredDocTypes && requiredDocTypes.length > 0) {
    for (const docType of requiredDocTypes.slice(0, 10)) {
      const q1 = `site:${domain} ${docType}`;
      const q2 = `site:${domain} ${docType} filetype:pdf`;
      if (!baseQueries.includes(q1)) baseQueries.push(q1);
      if (!baseQueries.includes(q2)) baseQueries.push(q2);
    }
  }

  // Topic-lexicon-driven queries (topic-agnostic, works for any framework)
  // 2026-09-05: raised the slice from 8 to 20 after the topic-lexicon
  // ordering fix. Previously slice(0, 8) commonly cut off before reaching
  // the topic-specific terms (Framework 3's cache had "nature" at position 9
  // and "biodiversity" at position 10, so no nature/biodiversity queries
  // were being issued for any of the 10 companies). With ordering fixed to
  // put LLM-derived topic terms first, slice(0, 20) captures the full
  // topic-specific vocabulary while still bounded on the number of Serper
  // calls per domain.
  const LEXICON_SLICE_CAP = 20;
  if (topicPhrases && topicPhrases.length > 0) {
    const lexiconQueries = topicPhrases.slice(0, LEXICON_SLICE_CAP).map(term => `site:${domain} ${term}`);
    for (const q of lexiconQueries) {
      if (!baseQueries.includes(q)) baseQueries.push(q);
    }
  }

  // Fallback: extract topic words from framework description
  if ((!topicPhrases || topicPhrases.length === 0) && (!requiredDocTypes || requiredDocTypes.length === 0)) {
    const topic = (framework.topicDescription || framework.name || "").toLowerCase();
    const topicWords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 4);
    for (const w of topicWords) {
      baseQueries.push(`site:${domain} ${w}`);
    }
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
  reportTerms: string[]; // native-language annual report / filing terms
  // Instruction 32: aiTerms removed. Rely on framework-derived topicPhrases
  // (from deriveTopicLexicon, which produces native-language synonyms) instead
  // of hardcoded per-topic vocabulary.
}

const LOCALE_PROFILES: Record<string, LocaleProfile> = {
  france: { gl: "fr", hl: "fr", lang: "French", reportTerms: ["document d'enregistrement universel", "rapport annuel"] },
  germany: { gl: "de", hl: "de", lang: "German", reportTerms: ["Gesch\u00e4ftsbericht", "Jahresabschluss"] },
  switzerland: { gl: "ch", hl: "de", lang: "German/French", reportTerms: ["Gesch\u00e4ftsbericht", "rapport annuel"] },
  spain: { gl: "es", hl: "es", lang: "Spanish", reportTerms: ["informe anual", "cuentas anuales"] },
  mexico: { gl: "mx", hl: "es", lang: "Spanish", reportTerms: ["informe anual"] },
  italy: { gl: "it", hl: "it", lang: "Italian", reportTerms: ["relazione annuale", "bilancio"] },
  brazil: { gl: "br", hl: "pt", lang: "Portuguese", reportTerms: ["relat\u00f3rio anual"] },
  portugal: { gl: "pt", hl: "pt", lang: "Portuguese", reportTerms: ["relat\u00f3rio anual"] },
  netherlands: { gl: "nl", hl: "nl", lang: "Dutch", reportTerms: ["jaarverslag"] },
  japan: { gl: "jp", hl: "ja", lang: "Japanese", reportTerms: ["\u6709\u4fa1\u8a3c\u5238\u5831\u544a\u66f8", "\u7d71\u5408\u5831\u544a\u66f8"] },
  china: { gl: "cn", hl: "zh-cn", lang: "Chinese", reportTerms: ["\u5e74\u5ea6\u62a5\u544a", "\u5e74\u62a5"] },
  "hong kong": { gl: "hk", hl: "zh-tw", lang: "Chinese", reportTerms: ["\u5e74\u5831", "\u5e74\u5ea6\u5831\u544a"] },
  taiwan: { gl: "tw", hl: "zh-tw", lang: "Chinese", reportTerms: ["\u5e74\u5831"] },
  "south korea": { gl: "kr", hl: "ko", lang: "Korean", reportTerms: ["\uc0ac\uc5c5\ubcf4\uace0\uc11c", "\uc5f0\ucc28\ubcf4\uace0\uc11c"] },
  korea: { gl: "kr", hl: "ko", lang: "Korean", reportTerms: ["\uc0ac\uc5c5\ubcf4\uace0\uc11c"] },
  sweden: { gl: "se", hl: "sv", lang: "Swedish", reportTerms: ["\u00e5rsredovisning"] },
  finland: { gl: "fi", hl: "fi", lang: "Finnish", reportTerms: ["vuosikertomus"] },
  denmark: { gl: "dk", hl: "da", lang: "Danish", reportTerms: ["\u00e5rsrapport"] },
  norway: { gl: "no", hl: "no", lang: "Norwegian", reportTerms: ["\u00e5rsrapport"] },
  belgium: { gl: "be", hl: "nl", lang: "Dutch/French", reportTerms: ["jaarverslag", "rapport annuel"] },
  austria: { gl: "at", hl: "de", lang: "German", reportTerms: ["Gesch\u00e4ftsbericht"] },
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
function buildLocalizedTopicQueries(
  companyName: string,
  framework: Framework,
  profile: LocaleProfile,
  topicPhrases?: string[]
): string[] {
  // Instruction 32: Fully topic-agnostic. Uses topicPhrases for any framework.
  const queries: string[] = [];
  if (!topicPhrases || topicPhrases.length === 0) return queries;

  // Pair topic phrases with native report term
  if (profile.reportTerms[0]) {
    queries.push(`"${companyName}" ${topicPhrases[0]} ${profile.reportTerms[0]}`);
    if (topicPhrases[1]) {
      queries.push(`"${companyName}" ${topicPhrases[1]} ${profile.reportTerms[0]}`);
    }
  }

  // Use any topic phrases that appear to be in the locale's language.
  // Heuristic: CJK char present → CJK profile; non-ASCII Latin → European profile.
  const localeTopicPhrases = topicPhrases.filter(p => {
    if (profile.hl.startsWith("zh") || profile.hl === "ja" || profile.hl === "ko") {
      return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(p);
    }
    if (profile.hl === "en") return true;
    return /[àâçéèêëîïôùûüÿñæœäöüß]/i.test(p) || /^[a-z\s]+$/i.test(p);
  });
  for (const phrase of localeTopicPhrases.slice(0, 3)) {
    queries.push(`"${companyName}" ${phrase}`);
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
  // Instruction 32: skip CJK lane rather than fall back to hardcoded AI term.
  const cjkPhrase = (topicPhrases || []).find((p) => /[\u4e00-\u9fff]/.test(p));
  const topicPhraseCJK = cjkPhrase || (topicPhrases && topicPhrases[0]);
  if (!topicPhraseCJK) {
    console.warn(`[${companyName}] CJK query lane skipped: no topic phrases available`);
    return { queries, code, chineseName };
  }
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

/**
 * R2 (2026-09-04): Resolve a company's SEC CIK from ticker or company name.
 *
 * Wraps the cached SEC ticker → CIK map so callers outside discovery.ts can
 * look up CIKs for the R2 IR-platform provenance check (Q4 Inc CDN URLs
 * encode issuer CIK in the path). Returns the padded 10-digit CIK on hit,
 * or null when no match is found or when EDGAR is unreachable.
 *
 * SAFETY: only queries EDGAR when a US-country hint exists. For non-US
 * issuers (GB/FR/CH/etc.), returns null immediately — this prevents the
 * FM-4 failure where a UK PRU-tickered issuer resolves to Prudential
 * Financial Inc (US).
 */
export async function resolveCikForCompany(opts: {
  companyName: string;
  ticker?: string | null;
  country?: string | null;
  isin?: string | null;
}): Promise<string | null> {
  // Country / ISIN gate: only US-listed issuers should hit EDGAR. The
  // ISIN's country prefix is the most reliable signal; fall back to the
  // stored `country` field only when ISIN is absent.
  const isinCountry = (opts.isin || "").slice(0, 2).toUpperCase();
  const countryLower = (opts.country || "").toLowerCase();
  const isUsListed =
    isinCountry === "US" ||
    countryLower === "us" ||
    countryLower === "united states" ||
    countryLower === "usa" ||
    // If ISIN is missing AND country is missing, allow lookup but require
    // an exact ticker match (below). This preserves the pre-R2 behaviour
    // for edge cases without over-firing on non-US issuers.
    (!isinCountry && !countryLower);
  if (!isUsListed) return null;

  const ua = process.env.SEC_USER_AGENT || "CompanyIQ Research admin@companyiq.example";
  try {
    const map = await loadSecTickerMap(ua);
    let cik: string | undefined;
    if (opts.ticker) cik = map.get(opts.ticker.toUpperCase());
    if (!cik && opts.companyName) cik = map.get(opts.companyName.toUpperCase());
    if (!cik && opts.companyName) {
      // Loose name match — same strategy as resolveAuthoritativeAnnualFilings.
      const norm = opts.companyName
        .toUpperCase()
        .replace(/[.,]/g, "")
        .replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|GROUP|HOLDINGS|COMPANY|LIMITED)\b/g, "")
        .trim();
      if (norm.length >= 4) {
        for (const [k, v] of map) {
          if (k.replace(/[.,]/g, "").includes(norm)) { cik = v; break; }
        }
      }
    }
    return cik || null;
  } catch {
    return null;
  }
}

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

/**
 * R7c: default per-form limits for the multi-form EDGAR enumerator.
 *
 * These bound the maximum number of filings pulled per form type from a
 * single issuer's EDGAR submissions. The choice reflects sustainability
 * disclosure patterns:
 *   - 10-K / 20-F / 40-F: 3 recent annual filings (last 3 fiscal years).
 *     Multiple years let recency gate pick the correct one for the report period.
 *   - DEF 14A / DEFA14A / PRE 14A: 3 recent proxies (governance disclosures).
 *   - 6-K: 8 recent material-event filings from foreign private issuers.
 *     FPIs disclose sustainability updates via 6-K rather than 10-Q.
 *   - 10-Q: 4 recent quarterly filings.
 *   - 8-K: 6 recent current-report filings.
 *
 * Total worst-case per US-listed issuer: ~24 pinned filings. Bounded and
 * predictable.
 */
const EDGAR_FORM_LIMITS: Array<{ pattern: RegExp; cap: number; label: string }> = [
  { pattern: /^(10-?K|20-?F|40-?F)$/i, cap: 3, label: "annual" },
  { pattern: /^(DEF|DEFA|PRE)\s?14A$/i, cap: 3, label: "proxy" },
  { pattern: /^6-?K$/i, cap: 8, label: "6-K" },
  { pattern: /^10-?Q$/i, cap: 4, label: "quarterly" },
  { pattern: /^8-?K$/i, cap: 6, label: "8-K" },
];

async function resolveAuthoritativeAnnualFilings(opts: {
  companyName: string;
  ticker?: string | null;
  /** Legacy: max total annual filings. Applies only to 10-K/20-F/40-F caps. */
  maxFilings?: number;
  /**
   * R7c: extend the enumerator to pull other form types too. When true, the
   * function returns up to EDGAR_FORM_LIMITS[form].cap filings per form type
   * (annual + proxy + 6-K + 10-Q + 8-K). When false (legacy default), only
   * annual filings are returned and only up to `maxFilings`.
   */
  extendedForms?: boolean;
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

    // R7c: choose which form-type caps apply
    const legacyMax = opts.maxFilings ?? 2;
    const perFormCaps = opts.extendedForms
      ? EDGAR_FORM_LIMITS.map(f => ({ ...f, cap: f.label === "annual" ? Math.max(legacyMax, f.cap) : f.cap }))
      : [{ pattern: /^(10-?K|20-?F|40-?F)$/i, cap: legacyMax, label: "annual" }];
    const perFormSeen: Record<string, number> = {};

    // recent arrays are sorted newest-first by EDGAR.
    for (let i = 0; i < forms.length; i++) {
      const rawForm = (forms[i] || "").trim();
      if (!rawForm || /\/A$/i.test(rawForm)) continue; // skip amendments
      // Find the first cap that matches this form
      const cap = perFormCaps.find(c => c.pattern.test(rawForm.replace(/\s+/g, "")));
      if (!cap) continue;
      const seenKey = cap.label;
      const seenCount = perFormSeen[seenKey] || 0;
      if (seenCount >= cap.cap) continue;

      const acc18 = (accessions[i] || "").replace(/-/g, "");
      const file = primaryDocs[i];
      if (!acc18 || !file) continue;
      const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc18}/${file}`;
      out.push({ url, form: rawForm, date: dates[i] || "" });
      perFormSeen[seenKey] = seenCount + 1;
      // Pre-seed authoritative form/year caches (only for annual filings — the
      // recency gate uses this to detect stale 10-Ks; not needed for 6-K/8-K).
      if (cap.label === "annual") {
        edgarFormByAccession.set(acc18, normalizeEdgarForm(rawForm));
        if (dates[i] && /^\d{4}/.test(dates[i])) edgarFilingYearByAccession.set(acc18, parseInt(dates[i].slice(0, 4), 10));
      }
      console.log(`[${opts.companyName}] EDGAR ${cap.label} filing: ${rawForm} ${dates[i]} -> ${url}`);
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
  framework: Framework,
  topicPhrases?: string[]
): string[] {
  // Instruction 21b: No topic-specific branches. Uses topicPhrases for topic-aware IR queries.
  const queries: string[] = [];
  // Domain-anchored IR queries (most valuable — finds the actual IR page)
  if (effectiveDomain) {
    queries.push(
      `site:${effectiveDomain} investor relations`,
      `site:${effectiveDomain} annual report 2024 OR 2023`,
      `site:${effectiveDomain} proxy statement`,
    );
    // Topic-aware domain queries from topicPhrases
    if (topicPhrases && topicPhrases.length > 0) {
      for (const term of topicPhrases.slice(0, 3)) {
        queries.push(`site:${effectiveDomain} ${term}`);
      }
    }
  }
  // General IR queries
  queries.push(
    `"${companyName}" investor presentation 2024 OR 2025`,
    `"${companyName}" investor day OR capital markets day`,
  );
  // Topic-aware general queries from topicPhrases
  if (topicPhrases && topicPhrases.length > 0) {
    queries.push(
      `"${companyName}" investor presentation ${topicPhrases[0]}`,
      `"${companyName}" earnings call ${topicPhrases[0]} transcript`,
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

// 39-A: normalise a hostname to its registrable root domain.
// Handles common patterns: subdomain.example.com → example.com,
// example.co.uk → example.co.uk (preserve second-level ccTLD),
// stories.td.com → td.com, about.bankofamerica.com → bankofamerica.com.
function normaliseToRegistrableDomain(hostname: string): string {
  const clean = hostname.toLowerCase().replace(/^www\./, "");
  const parts = clean.split(".");

  // Handle common two-part ccTLDs (co.uk, com.au, co.jp, etc.) plus
  // sector-specific ccTLD zones (bank.in for HDFC etc.).
  // I56b: Added .bank.in / .bank.cn / bank.br for regulated banking
  // domains, .co.in / .org.in for Indian corporate, .com.tr / .co.kr
  // for other regions that host bank IR sites.
  const twoPartCcTlds = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk",
    "com.au", "org.au", "gov.au",
    "co.jp", "or.jp", "ne.jp",
    "co.nz", "com.sg", "com.hk", "com.mx", "com.br",
    // I56b extensions:
    "bank.in", "co.in", "org.in", "net.in",           // India
    "bank.cn", "com.cn", "net.cn", "gov.cn", "edu.cn", // China
    "co.kr", "or.kr", "go.kr",                          // South Korea
    "com.tr", "gov.tr", "org.tr",                       // Turkey
    "co.za", "org.za",                                  // South Africa
    "com.ph", "com.my", "com.tw",                       // SE Asia
  ]);

  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartCcTlds.has(lastTwo)) {
      return parts.slice(-3).join(".");
    }
  }
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return clean;
}

function inferDomainFromResults(
  candidates: DiscoveryCandidate[],
  companyName: string,
  aliases: string[] = []
): string | null {
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
  // 40-A: Check both distinctive tokens AND derived aliases against each candidate domain.
  const allMatchTerms = [...matchWords, ...aliases.filter(a => a.length >= 2)];

  // I52: TOKEN-BOUNDARY MATCHING (fix acronym / substring-collision failure).
  // Previously `dl.includes(alias)` accepted any substring, so "sumitomo" matched
  // sumitomocorp.com (Sumitomo Corporation) as if it were SMFG's domain.
  // Now we split the domain root into token-boundary segments (by `-`, `.`, digits
  // and case boundaries) and require an ALIAS to equal one of those tokens, OR
  // require the alias to be a strict prefix separated by `-` / `.`. This preserves
  // legitimate matches (e.g. rbc-royalbank.com contains token "rbc") while rejecting
  // pure substring collisions. Framework-agnostic and topic-agnostic.
  const splitDomainTokens = (domain: string): string[] => {
    // Take the second-level domain root (strip TLDs) then split on non-alphanumerics
    // and on digit boundaries. e.g. "sumitomocorp" -> ["sumitomocorp"], but if it were
    // "sumitomo-corp" -> ["sumitomo", "corp"]. We also add the FULL root as one token.
    const parts = domain.toLowerCase().split(".");
    const roots: string[] = [];
    for (const p of parts) {
      if (p.length < 2) continue;
      roots.push(p);
      // Also split on non-alphabetic characters
      const subs = p.split(/[^a-z]+/).filter(s => s.length >= 2);
      for (const s of subs) roots.push(s);
    }
    return [...new Set(roots)];
  };

  // I54: use the shared discriminative-token boundary helper.
  // Rejects both substring collisions (sumitomo -> sumitomocorp.com) AND
  // generic-token boundary matches (canada -> canada.ca for RBC, nova/scotia
  // -> novascotia.ca for BNS, bank -> bank.in for HDFC).
  // Short-alias freq guard preserved (<=3 char alias needs freq>=5).
  const domainMatchesTerms = (domain: string, freq: number): boolean => {
    const check = domainMatchesIssuerDistinctively(domain, aliases, matchWords);
    if (!check.ok) return false;
    // Short-alias frequency guard: if the ONLY match is a 2-3 char alias,
    // require freq >= 5 to prevent tiny-alias noise from dominating.
    if (check.matchedOn && check.matchedOn.startsWith("alias:")) {
      const matched = check.matchedOn.slice("alias:".length);
      if (matched.length <= 3 && freq < 5) return false;
    }
    return true;
  };

  if (domainMatchesTerms(topDomain, sorted[0][1])) {
    const normalised = normaliseToRegistrableDomain(topDomain);
    console.log(`[${companyName}] Auto-detected domain: ${topDomain} \u2192 normalised to ${normalised}`);
    return normalised;
  }

  // Try other frequent domains that DO match the company name or aliases
  for (let i = 1; i < Math.min(sorted.length, 6); i++) {
    const [candidateDomain, count] = sorted[i];
    if (count < 2) break;
    if (domainMatchesTerms(candidateDomain, count)) {
      const normalised = normaliseToRegistrableDomain(candidateDomain);
      console.log(`[${companyName}] Auto-detected domain: ${candidateDomain} \u2192 normalised to ${normalised}`);
      return normalised;
    }
  }

  // 40-B: Frequency-dominance fallback.
  // If no candidate matches tokens or aliases, accept the top domain if it
  // dominates by >= 3x the runner-up AND has >= 10 hits.
  if (sorted[0][1] >= 10) {
    const runnerUp = sorted.length > 1 ? sorted[1][1] : 0;
    if (sorted[0][1] >= 3 * Math.max(runnerUp, 1)) {
      const normalised = normaliseToRegistrableDomain(sorted[0][0]);
      console.log(`[${companyName}] 40-B frequency-dominance: ${sorted[0][0]} (${sorted[0][1]} hits, runner-up ${runnerUp}) \u2192 ${normalised}`);
      return normalised;
    }
  }

  // No domain confidently matches the company name \u2014 return null.
  // Control passes to 40-C (explicit corporate-domain query) in the caller.
  return null;
}


/**
 * 40-C: Explicit corporate-domain query.
 * When 40-A and 40-B both fail, issue one Serper query to find the company's
 * official website via real-index anchoring.
 */
/**
 * I56: Annual-report Serper lane.
 *
 * Runs one Serper query: `"<companyName>" annual report`
 * The top organic results almost always come from the company's own corporate
 * site (or a well-known IR platform). We compute a frequency map of root
 * domains across the top 10 hits and pick the most-frequent one — tie-broken
 * by rank if freq is tied. This resolves acronym/brand cases without needing
 * an authoritative external mapping.
 *
 * TOPIC-agnostic: 'annual report' is a generic disclosure term used by every
 * public issuer. No framework/company/jurisdiction literals.
 *
 * Returns null when no candidate passes a discriminative-token OR
 * frequency-dominance gate.
 */
async function discoverPrimaryDomainViaAnnualReportSearch(
  issuerName: string,
  companyName: string,
  aliases: string[] = [],
): Promise<string | null> {
  const query = `"${issuerName}" annual report`;
  let results;
  try {
    results = await webSearch(query, { num: 10 });
  } catch (err: any) {
    console.warn(`[${companyName}] 40-Y annual-report search failed: ${err.message}`);
    return null;
  }
  if (!results || results.length === 0) return null;

  // Same shared/aggregator/exchange deny-list as elsewhere.
  const excluded = new Set([
    "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com",
    "wikipedia.org", "reuters.com", "bloomberg.com", "ft.com", "cnbc.com",
    "bbc.com", "theguardian.com", "nytimes.com", "wsj.com", "medium.com",
    "google.com", "amazon.com", "github.com", "reddit.com", "quora.com",
    "sustainabilityreports.com", "annualreports.com", "relayto.com",
    "nasdaq.com", "marketwatch.com", "finance.yahoo.com", "yahoo.com",
    "moomoo.com", "seekingalpha.com", "stockanalysis.com", "tipranks.com",
    "ssga.com", "ishares.com", "blackrock.com", "vanguard.com",
    "morningstar.com", "fool.com", "investing.com", "stocktwits.com",
    "sec.gov", "companieshouse.gov.uk", "canada.ca", "gov.uk", "gov.au",
  ]);

  // Score each host: freq*10 - firstRank (earlier rank wins ties).
  const scores = new Map<string, { freq: number; firstRank: number }>();
  results.forEach((r, idx) => {
    try {
      const u = new URL(r.link);
      const root = normaliseToRegistrableDomain(u.hostname);
      if (excluded.has(root)) return;
      if (isSharedHost(root)) return;
      if (root.endsWith(".gov") || root.endsWith(".edu")) return;
      const s = scores.get(root) || { freq: 0, firstRank: idx };
      s.freq += 1;
      if (idx < s.firstRank) s.firstRank = idx;
      scores.set(root, s);
    } catch { /* skip malformed URL */ }
  });

  if (scores.size === 0) return null;

  // Sort: highest freq, then earliest rank.
  const sorted = [...scores.entries()].sort((a, b) => {
    if (b[1].freq !== a[1].freq) return b[1].freq - a[1].freq;
    return a[1].firstRank - b[1].firstRank;
  });

  // Same combined-signal gate as the FMP lane: accept when EITHER (a) the
  // domain contains an alias/name-token boundary (discriminative rule) OR
  // (b) the top candidate has ≥3 hits (strong search-frequency evidence).
  const nameTokens = issuerName.toLowerCase().split(/[\s&,.']+/).filter((w: string) => w.length >= 3);
  for (const [candidate, s] of sorted) {
    const check = domainMatchesIssuerDistinctively(candidate, aliases, nameTokens);
    if (check.ok) {
      console.log(`[${companyName}] 40-Y annual-report resolved domain: ${candidate} (matched-on ${check.matchedOn}, freq=${s.freq}, firstRank=${s.firstRank})`);
      return candidate;
    }
  }
  // Frequency-dominance fallback: if the top candidate has ≥3 hits AND is
  // >=2x the runner-up, accept even without token match (catches brand-name
  // domains like commbank.com.au for CBA).
  if (sorted.length > 0 && sorted[0][1].freq >= 3) {
    const runnerUp = sorted.length > 1 ? sorted[1][1].freq : 0;
    if (sorted[0][1].freq >= 2 * Math.max(runnerUp, 1)) {
      console.log(`[${companyName}] 40-Y annual-report resolved by frequency dominance: ${sorted[0][0]} (freq=${sorted[0][1].freq}, runner-up=${runnerUp})`);
      return sorted[0][0];
    }
  }
  console.warn(`[${companyName}] 40-Y annual-report: no candidate passed gate. Top: [${sorted.slice(0,5).map(([d,s])=>`${d}(${s.freq})`).join(', ')}]`);
  return null;
}

// I54: DOMAIN-TOKEN DENY LIST for boundary matching.
// A domain-token equality that matches ONLY these generic words is NOT
// discriminative enough to prove the domain belongs to the issuer. For
// example, canada.ca matches ROYAL BANK OF CANADA on token "canada" — but
// canada.ca is not RBC. Same for novascotia.ca vs BANK OF NOVA SCOTIA,
// bank.in vs HDFC BANK, ssga.com's token "com" vs any bank.
// This list is CLOSED and generic (country names, jurisdiction tokens,
// generic-industry words). No company/topic/framework literals.
const GENERIC_DOMAIN_TOKENS = new Set([
  "the", "and", "for", "of", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "incorporated", "inc", "ltd", "limited", "llc", "plc",
  "co", "sa", "se", "ag", "nv", "spa", "international", "global", "worldwide",
  "industries", "industrial", "enterprise", "enterprises", "technologies",
  "technology", "systems", "solutions", "services", "products",
  "bank", "banking", "capital", "partners", "resources", "materials", "energy",
  "power", "motors", "financial", "insurance", "asset", "management", "trust",
  "real", "estate", "realty", "food", "foods", "beverage", "retail", "media",
  "telecom", "communications", "pharmaceutical", "pharmaceuticals", "chemical",
  "chemicals", "aerospace", "automotive", "manufacturing",
  // Country / jurisdiction tokens — present in many issuer names AND in
  // government / country-domain roots; NOT discriminative on their own.
  "australia", "america", "american", "national", "japan", "china", "korea",
  "hong", "kong", "india", "indian", "canada", "canadian", "uk", "british",
  "nova", "scotia", "montreal", "toronto", "vancouver", "sydney", "melbourne",
  "london", "paris", "tokyo", "mumbai", "delhi", "beijing", "shanghai",
]);

/**
 * I54: Return TRUE only when the domain contains an issuer-token boundary
 * that is DISCRIMINATIVE — i.e. equal to an alias/name-token that is NOT
 * on the generic-word deny-list. Used by all three domain-resolution lanes.
 */
function domainMatchesIssuerDistinctively(
  domain: string,
  aliases: string[],
  nameTokens: string[],
): { ok: boolean; matchedOn: string | null } {
  const parts = domain.toLowerCase().split(".");
  const domainTokens: string[] = [];
  for (const p of parts) {
    if (p.length < 2) continue;
    domainTokens.push(p);
    for (const s of p.split(/[^a-z]+/)) if (s.length >= 2) domainTokens.push(s);
  }
  const dt = new Set(domainTokens);
  // Prefer an ALIAS match (aliases include tickers + concatenations and are
  // strong identity signals). Then fall back to a distinctive name token.
  for (const a of aliases) {
    if (a.length < 3) continue; // never accept 2-char alias match here
    const al = a.toLowerCase();
    if (GENERIC_DOMAIN_TOKENS.has(al)) continue;
    if (dt.has(al)) return { ok: true, matchedOn: `alias:${al}` };
  }
  for (const w of nameTokens) {
    if (w.length < 4) continue;
    if (GENERIC_DOMAIN_TOKENS.has(w)) continue;
    if (dt.has(w)) return { ok: true, matchedOn: `nameToken:${w}` };
  }
  return { ok: false, matchedOn: null };
}

async function discoverPrimaryDomainViaExplicitQuery(
  issuerName: string,
  companyName: string,
  aliases: string[] = [],
): Promise<string | null> {
  const query = `"${issuerName}" official website OR investor relations OR sustainability`;
  try {
    const results = await webSearch(query, { num: 5 });
    if (results.length === 0) return null;

    const excludedForExplicit = new Set([
      "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com",
      "wikipedia.org", "reuters.com", "bloomberg.com", "ft.com", "cnbc.com",
      "google.com", "amazon.com", "reddit.com", "medium.com",
      // I53-B: also exclude common SERP-noise domains for explicit-query lane.
      "nasdaq.com", "marketwatch.com", "finance.yahoo.com", "yahoo.com",
      "moomoo.com", "seekingalpha.com", "stockanalysis.com", "tipranks.com",
      "ssga.com", "ishares.com", "blackrock.com", "vanguard.com",
      "morningstar.com", "fool.com", "investing.com", "stocktwits.com",
      "finbox.com", "simplywall.st", "gurufocus.com", "zacks.com",
    ]);

    const rootCounts = new Map<string, number>();
    for (const r of results) {
      try {
        const url = new URL(r.link);
        const root = normaliseToRegistrableDomain(url.hostname);
        if (excludedForExplicit.has(root)) continue;
        rootCounts.set(root, (rootCounts.get(root) || 0) + 1);
      } catch {}
    }

    if (rootCounts.size === 0) return null;

    // I53-B / I54: BOUNDARY CHECK via shared discriminative helper.
    // Rejects substring-collision SERP wins like ssga.com for CBA, canada.ca
    // for RBC, novascotia.ca for BNS, or bank.in for HDFC.
    const nameTokens = issuerName.toLowerCase().split(/[\s&,.']+/).filter((w) => w.length >= 3);
    const sorted = [...rootCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [candidate, hits] of sorted) {
      const check = domainMatchesIssuerDistinctively(candidate, aliases, nameTokens);
      if (check.ok) {
        console.log(`[${companyName}] 40-C explicit query resolved domain: ${candidate} (matched-on ${check.matchedOn}, ${hits} hits)`);
        return candidate;
      }
    }
    console.warn(`[${companyName}] 40-C explicit query rejected all candidates (no discriminative token match): [${sorted.map(([d,c]) => d+':'+c).join(', ')}]`);
    return null;
  } catch (err: any) {
    console.warn(`[${companyName}] 40-C explicit query failed: ${err.message}`);
    return null;
  }
}

/**
 * 40-D: Evidence-gated related-domain discovery.
 * Scans Lane 1 candidate domains and includes any domain that shares a coreToken
 * with the primary domain and appears >= 3 times.
 */
// Shared exclusion set for related-domain discovery
const EXCLUDED_DOMAINS_FOR_RELATED = new Set([
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com",
  "wikipedia.org", "reuters.com", "bloomberg.com", "ft.com", "cnbc.com",
  "google.com", "amazon.com", "reddit.com", "medium.com", "sec.gov",
  "companieshouse.gov.uk", "indeed.com", "glassdoor.com",
]);

/**
 * 41-G: Test whether a candidate domain is a "family TLD variant" of the primary,
 * i.e. same registrable-name stem but a different TLD.
 *   primary=hsbc.com,  candidate=hsbc.co.uk    → true
 *   primary=hsbc.com,  candidate=hsbc.com.hk   → true
 *   primary=hsbc.com,  candidate=hsbcbank.com  → false (different stem)
 *
 * No topic or company semantics — pure string comparison on domain shape.
 */
function isFamilyTldVariant(candidate: string, primary: string): boolean {
  const primaryStem = primary.split(".")[0];
  const candidateStem = candidate.split(".")[0];
  if (primaryStem !== candidateStem) return false;
  const primaryTld = primary.slice(primaryStem.length + 1);
  const candidateTld = candidate.slice(candidateStem.length + 1);
  return primaryTld !== candidateTld && candidateTld.length > 0;
}

function discoverRelatedDomains(
  primaryDomain: string,
  candidates: DiscoveryCandidate[],
  coreTokens: string[]
): string[] {
  const domainCounts = new Map<string, number>();
  for (const c of candidates) {
    try {
      const url = new URL(c.url);
      const root = normaliseToRegistrableDomain(url.hostname);
      if (root === primaryDomain) continue;
      if (EXCLUDED_DOMAINS_FOR_RELATED.has(root)) continue;
      domainCounts.set(root, (domainCounts.get(root) || 0) + 1);
    } catch {}
  }
  // I73 (Fix 2A): also harvest SUBDOMAINS of the primary that consistently appear
  // in candidates. Companies commonly host material disclosures on subdomains like
  // library.e.abb.com, investorfactbook.spglobal.com, investor.aflac.com,
  // press.spglobal.com, etc. Because these collapse to the primary registrable
  // root under normaliseToRegistrableDomain, the old code discarded them at line
  // 2267 (root === primaryDomain → continue). We now retain any non-www subdomain
  // of the primary that appears ≥2 times so it can be used as a distinct `site:`
  // target later. Framework-agnostic; no company or topic literals.
  const subdomainCounts = new Map<string, number>();
  for (const c of candidates) {
    try {
      const url = new URL(c.url);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const root = normaliseToRegistrableDomain(url.hostname);
      if (root !== primaryDomain) continue;      // not a subdomain of primary
      if (host === primaryDomain) continue;      // primary itself (already handled)
      subdomainCounts.set(host, (subdomainCounts.get(host) || 0) + 1);
    } catch {}
  }

  // I52: strict token-boundary sharing (not substring) to reject acronym
  // collisions like sumitomocorp.com matching "sumitomo" for SMFG.
  const domainTokenOf = (d: string): string[] => {
    const parts = d.toLowerCase().split(".");
    const roots: string[] = [];
    for (const p of parts) {
      if (p.length < 2) continue;
      roots.push(p);
      for (const s of p.split(/[^a-z]+/)) if (s.length >= 2) roots.push(s);
    }
    return [...new Set(roots)];
  };
  const related: string[] = [];
  for (const [domain, count] of domainCounts) {
    const dTokens = domainTokenOf(domain);
    const sharesToken = coreTokens.some(token => token.length >= 2 && dTokens.includes(token.toLowerCase()));
    if (!sharesToken) continue;

    // 41-G: Two-tier evidence gate:
    //   - Family-TLD variant (same stem, different TLD): accept with ≥ 1 hit.
    //   - Other cross-token siblings: require ≥ 3 hits (existing gate).
    const isVariant = isFamilyTldVariant(domain, primaryDomain);
    const threshold = isVariant ? 1 : 3;
    if (count < threshold) continue;

    related.push(domain);
  }

  // I73 (Fix 2A): admit subdomains of the primary that appear ≥2 times.
  // Threshold 2 (rather than 1) avoids adding random one-off subdomains from
  // an unrelated news article that quoted the company. Filter to exclude generic
  // marketing subdomains (careers.*, jobs.*) that don't host disclosure content.
  const GENERIC_SUBDOMAIN_PREFIXES = new Set(["careers", "jobs", "support", "help", "blog", "community"]);
  for (const [host, count] of subdomainCounts) {
    if (count < 2) continue;
    const firstLabel = host.split(".")[0];
    if (GENERIC_SUBDOMAIN_PREFIXES.has(firstLabel)) continue;
    related.push(host);
  }

  related.sort();
  return related;
}

/**
 * 41-F: Cross-brand sibling discovery. Captures brand-sibling domains that
 * don't share a core token with the primary (e.g. chase.com for JPMorgan Chase).
 * Uses a targeted Serper query AND a name-token scan of Lane 1 candidates.
 *
 * Framework-agnostic: query text mentions no topic. Company name is a parameter.
 */
async function discoverCrossBrandSiblings(
  issuerName: string,
  primaryDomain: string,
  existingFamily: string[],
  laneOneCandidates: DiscoveryCandidate[]
): Promise<string[]> {
  // Build a frequency map of all Lane 1 candidate domains
  const laneOneFrequency = new Map<string, number>();
  for (const c of laneOneCandidates) {
    try {
      const root = normaliseToRegistrableDomain(new URL(c.url).hostname);
      laneOneFrequency.set(root, (laneOneFrequency.get(root) || 0) + 1);
    } catch {}
  }

  const alreadyKnown = new Set([primaryDomain, ...existingFamily]);
  const siblings: string[] = [];

  // Method 1: Serper query for subsidiary/brand pages
  try {
    const query = `"${issuerName}" official website subsidiary OR brand OR "operates as"`;
    const results = await webSearch(query, { num: 5 });
    for (const r of results) {
      try {
        const root = normaliseToRegistrableDomain(new URL(r.link).hostname);
        if (alreadyKnown.has(root)) continue;
        if (EXCLUDED_DOMAINS_FOR_RELATED.has(root)) continue;
        // Evidence gate: must appear at least 2x in the Lane 1 pool
        if ((laneOneFrequency.get(root) || 0) < 2) continue;
        siblings.push(root);
        alreadyKnown.add(root);
      } catch {}
    }
  } catch (e: any) {
    console.warn(`[discovery] Cross-brand Serper query failed: ${e.message}`);
  }

  // 42-D: Name-token scan of Lane 1 candidates.
  // For composite-stem primaries (jpmorganchase contains both "jpmorgan" and
  // "chase"), every individual token IS in the stem — so the old
  // "tokensNotInPrimary" filter was empty and Method 2 contributed nothing.
  //
  // Fix: detect composite stems (2+ distinctive tokens in the stem) and treat
  // each individual token as a sibling candidate. For single-brand stems,
  // only tokens NOT in the stem qualify (original logic).
  const nameTokens = deriveAliases(issuerName, null).filter(a => a.length >= 4);
  const primaryStem = primaryDomain.split(".")[0].toLowerCase();
  const primaryTokenCount = nameTokens.filter(t => primaryStem.includes(t)).length;
  const isCompositeStem = primaryTokenCount >= 2;

  // If composite: every individual token is a sibling candidate (except the
  // full stem itself). If single-brand: only tokens not in the stem qualify.
  const siblingTokens = isCompositeStem
    ? nameTokens.filter(t => t.length >= 4 && t !== primaryStem)
    : nameTokens.filter(t => t.length >= 4 && !primaryStem.includes(t));

  for (const [domain, count] of laneOneFrequency) {
    if (alreadyKnown.has(domain) || EXCLUDED_DOMAINS_FOR_RELATED.has(domain)) continue;
    if (count < 2) continue;
    const dl = domain.split(".")[0].toLowerCase();
    if (dl === primaryStem) continue; // don't re-add the primary
    if (siblingTokens.some(t => dl.includes(t))) {
      siblings.push(domain);
      alreadyKnown.add(domain);
    }
  }

  return siblings;
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
  // B2: Universal priority domains — statutory filers, national registries, and
  // cross-topic frameworks. These apply on any topic.
  const UNIVERSAL_PRIORITY_DOMAINS = [
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
    "asx.com.au", "www1.hkexnews.hk", "www.hkexnews.hk", "hkexnews.hk",
    "filings.xbrl.org",  // R6c v2: ESMA ESEF filings repository
    "disclosure2.edinet-fsa.go.jp",
    "release.tdnet.info", "kind.krx.co.kr", "mops.twse.com.tw",
    "sgx.com", "bseindia.com", "nseindia.com", "sebi.gov.in",
    "cninfo.com.cn", "sse.com.cn", "gsxt.gov.cn", "maya.tase.co.il",
    "saudiexchange.sa", "adx.ae", "dfm.ae", "kap.org.tr",
    "clientportal.jse.co.za", "b3.com.br", "rad.cvm.gov.br", "mca.gov.in",
    // Cross-topic voluntary frameworks and multilateral bodies
    "unglobalcompact.org", "oecd.org", "gov.uk", "frc.org.uk", "fsa.go.jp",
    // Cross-topic gov / regulator disclosure surfaces
    "gender-pay-gap.service.gov.uk",
    "natural-resources.canada.ca", "publicsafety.gc.ca",
    "hatvp.fr", "lda.senate.gov", "fec.gov", "transparency-register.europa.eu",
    // Cross-topic certifications
    "bcorporation.net", "usgbc.org", "tools.breeam.com",
    "account.wellcertified.com", "dgnb.de",
    // Sector-specific & certification registries (universal across topics)
    "eiti.org", "icmm.com", "rspo.org", "search.fsc.org", "connect.fsc.org",
    "pefc.org", "responsiblesoy.org", "bonsucro.com", "rsb.org",
    "responsiblemining.net", "aluminium-stewardship.org",
    "responsiblesteel.org", "responsiblejewellery.com",
    "bettercotton.org", "fisheries.msc.org", "asc-aqua.org",
    "knowledge.rainforest-alliance.org", "flocert.net", "goodweave.org",
    "fairlabor.org", "iafcertsearch.org",
    // Human rights & social (universal)
    "hrc.org", "disabilityin.org", "ungpreporting.org", "unpri.org", "weps.org",
  ];
  // Framework-scoped priority domains from framework.authoritativeRegistries
  const frameworkRegistries = ((framework as any).authoritativeRegistries as string[] | null) || [];
  const allPriorityDomains = [...UNIVERSAL_PRIORITY_DOMAINS, ...frameworkRegistries];
  if (allPriorityDomains.some((d) => urlLower.includes(d))) {
    priority -= 4;
  }

  // URL slug bonuses — universal document-shape hints only (no topic-specific slugs)
  const slugBonuses: Record<string, number> = {
    governance: -5,
    ethics: -3,
    policy: -3,
    report: -2,
    "annual-report": -4,
    proxy: -3,
    "def-14a": -5,
    "10-k": -5,
    "10k": -5,
    "20-f": -5,
    "investor-relations": -4,
    investors: -3,
    "investor-presentation": -4,
    earnings: -3,
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

  // Fix 6 (Dead-fetch diagnosis): Bias toward direct document URLs over landing pages.
  // PDFs on the company's own domain are almost always the actual report (not a
  // landing page), and fetch at ~97% success rate vs ~50% for IR HTML pages.
  if (companyDomain && urlLower.includes(companyDomain)) {
    if (/\.pdf($|\?)/.test(urlLower)) {
      priority -= 6; // Strong boost: direct company PDF (ESG report, annual report)
    }
    // Penalize landing-page patterns that often fail to fetch (JS-rendered IR pages)
    if (/\/ir\/|investor-relations|investors\..*\.com/.test(urlLower) && !/\.pdf($|\?)/.test(urlLower) && !/\.htm/.test(urlLower)) {
      priority += 3; // Mild penalty: likely a JS landing page, not a document
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
- Documents hosted on this company's own corporate domain that are RELEVANT TO THE ANALYSIS TOPIC
- Regulatory filings specifically naming this company
- Industry reports where this company is a primary subject (not just mentioned in passing)
- The document must be plausibly relevant to the ANALYSIS TOPIC described below — not just any page about the company

REJECT:
- Documents about a DIFFERENT company, even if in the same industry (e.g., if searching for a specific bank, reject documents about a different bank or a different financial services company)
- Generic industry articles that mention multiple companies without focusing on the target company
- Documents about a DIFFERENT entity that happens to share a similar name or acronym
- News articles, marketing content, job postings, product pages
- YouTube videos, social media posts (unless they link to official disclosures)
- Documents from unrelated organizations
- Blog posts or thought-leadership articles from consulting firms unless they are a detailed case study of this specific company
- Pages that are about the company but CLEARLY UNRELATED to the analysis topic (e.g., product catalogs, careers pages, investor relations boilerplate with no topic content)

CRITICAL RULES:
1. If the URL domain belongs to ANOTHER company's corporate site, REJECT it unless it explicitly discusses the target company
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
  // v3l (CORPUS_DRIFT_REDESIGN_V3 §4): SHA1 over the sorted set of ALL gated
  // candidate URLs BEFORE the cap. Lets a reviewer distinguish "different
  // candidate pool" (world drift) from "same pool, different cut" (pipeline).
  candidatePoolFingerprint?: string;
  // v3l: alias of candidateFingerprint for clarity in the manifest; SHA1 of the
  // KEPT (post-cap) URL set. Identical => scoring should be identical.
  finalCorpusFingerprint?: string;
  // v3l §4: direct measure of whether the ranker is working in production.
  rankerDiagnostics?: {
    distinctPrioritiesInTop20: number;
    largestTieCountPreUrlHash: number;
    urlhashDecisionFraction: number;
    totalDocs: number;
  };
  // v3l §2.1: how many near-duplicate groups were collapsed before ranking.
  nearDupCollapsedGroups?: number;
  // v3l: the cap applied to this run (MAX_DOCS_RETURNED at selection time).
  capUsed?: number;
  // Generalised recency check: per-requiredDocType status
  recencyStatus?: Record<string, { status: string; bestYear: number | null; researchAttempted: boolean }>;
  // Instruction 46: Issuer profile and retrieval diagnostics
  issuerProfile?: IssuerProfile;
  retrievalDiagnostics?: RetrievalDiagnostics;
  registrySearchSummary?: RegistrySearchSummary;
  queryExpansionResult?: QueryExpansionResult;
  /**
   * PR 1 · Change 1a: telemetry for the latest-primary-disclosure repair pass.
   * Populated ONLY by pipeline.ts (post-discovery); the internal discovery
   * path never sets this. `missing` is the list of requirement ids that were
   * absent from the initial corpus; `queriesFired` is the number of targeted
   * follow-up queries actually issued to close those gaps.
   */
  primaryDisclosureRepair?: {
    missing: string[];
    queriesFired: number;
  };
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
  /** Instruction 46: Resolved issuer profile for downstream entity verification */
  issuerProfile?: IssuerProfile;
}

// P0 fix: Per-company discovery timeout (10 minutes). If discovery takes longer
// than this, it fails the job with a clear reason rather than hanging the batch.
const DISCOVERY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * PR 1 · Change 1a: run a single targeted web-search query for a company
 * (used by pipeline.ts to close latest-primary-disclosure gaps identified by
 * verifyLatestPrimaryDisclosure). Wraps the internal `webSearch` helper so
 * the caller does not need to know which search provider is configured
 * (Serper.dev vs SerpAPI) and gets the same rate-limiting and caching as
 * the rest of discovery.
 *
 * Returns DiscoveryCandidate rows tagged with lane="primary-disclosure-repair"
 * and a lower-than-average priority so they merge into the corpus without
 * disturbing the existing ranking key. Never throws — returns [] on error.
 */
export async function runTargetedDisclosureQuery(
  query: string,
  companyName: string,
  opts: { num?: number } = {},
): Promise<DiscoveryCandidate[]> {
  try {
    const results = await webSearch(query, { num: opts.num ?? 10 });
    return results.map((r) => ({
      url: r.link,
      title: r.title || "",
      snippet: r.snippet || "",
      lane: "primary-disclosure-repair",
      priority: 55, // between IR (60+) and secondary (40) — rank layer decides final order
    }));
  } catch (e: any) {
    console.warn(`[${companyName}] Targeted disclosure query failed for "${query.slice(0, 80)}": ${e?.message}`);
    return [];
  }
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
  peerCompanyNames?: string[]; // Fix C: workspace-derived peer list for anti-contamination
  companyRow?: any; // 40-G: full company row for cached FIGI/domain fields
  evidenceKeywords?: string[]; // Instruction 46: aggregated from measures
  /** PR 1 · Change 1b: enable retrievalV2 ranking penalties (subsidiary /
   *  vintage / press-page). Threaded down to the ComputeOpts used by the
   *  layered ranker. Off by default — pre-1b behaviour is preserved. */
  retrievalV2?: boolean;
}): Promise<DiscoveryResult> {
  // Wrap the entire discovery in a hard timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Discovery timeout: ${opts.companyName} exceeded ${DISCOVERY_TIMEOUT_MS / 1000}s`)), DISCOVERY_TIMEOUT_MS);
  });
  return Promise.race([searchCompanyDocumentsInner(opts), timeoutPromise]);
}

async function searchCompanyDocumentsInner(opts: {
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
  searchDepth?: number;
  queryVariants?: number;
  peerCompanyNames?: string[];
  companyRow?: any; // 40-G: full company row for cached FIGI/domain fields
  evidenceKeywords?: string[]; // Instruction 46: aggregated from measures
  /** PR 1 · Change 1b: forwarded from searchCompanyDocuments. */
  retrievalV2?: boolean;
}): Promise<DiscoveryResult> {
  const { companyName, companyId, companyDomain, pinnedUrls, framework, trustedSources } = opts;
  const localeProfile = resolveLocaleProfile(opts.country);
  const searchDepth = opts.searchDepth || 30;
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

  // ── Instruction 46: Resolve canonical issuer profile ─────────────────────
  const diagBuilder = new RetrievalDiagnosticsBuilder();
  let issuerProfile: IssuerProfile | undefined;
  let queryExpansionResult: QueryExpansionResult | undefined;
  let registrySummary: RegistrySearchSummary = emptyRegistrySummary();
  try {
    const profileResult = await resolveIssuerProfile({
      companyId,
      companyName,
      isin: opts.isin || null,
      ticker: opts.ticker || null,
      domain: companyDomain || null,
      sector: opts.sector || null,
      country: opts.country || null,
      companyRow: opts.companyRow,
    });
    issuerProfile = profileResult.profile;
    diagBuilder.setIssuerProfile(issuerProfile, profileResult.diagnostics);
    console.log(`[${companyName}] Issuer profile resolved: aliases=${profileResult.diagnostics.aliasCount}, domains=${profileResult.diagnostics.verifiedDomainCount}, path=[${profileResult.diagnostics.resolutionPath.join(",")}]`);
  } catch (profileErr: any) {
    console.warn(`[${companyName}] Issuer profile resolution failed (non-fatal): ${profileErr?.message}`);
  }

  // ── Instruction 46: Framework-driven query expansion ────────────────────
  if (issuerProfile && (opts.evidenceKeywords?.length || topicPhrases.length > 0)) {
    try {
      queryExpansionResult = expandQueries({
        profile: issuerProfile,
        evidenceKeywords: opts.evidenceKeywords || [],
        requiredDocTypes: ((framework as any).requiredDocTypes as string[] | null) || [],
        topicPhrases,
        maxTotal: 20,
      });
      diagBuilder.setQueryExpansion(queryExpansionResult);
      console.log(`[${companyName}] Query expansion: ${queryExpansionResult.diagnostics.totalGenerated} queries generated (evKw=${queryExpansionResult.diagnostics.evidenceKeywordQueries}, reportType=${queryExpansionResult.diagnostics.reportTypeQueries})`);
    } catch (qeErr: any) {
      console.warn(`[${companyName}] Query expansion failed (non-fatal): ${qeErr?.message}`);
    }
  }

  // Instruction 11a: Auto-upgrade http:// to https:// for first-party URLs
  function normaliseUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" && companyDomain &&
          (u.hostname === companyDomain || u.hostname.endsWith("." + companyDomain))) {
        u.protocol = "https:";
      }
      return u.toString();
    } catch { return url; }
  }

  function addCandidate(result: SearchResult, lane: string) {
    const normUrl = normaliseUrl(result.link);
    if (seenUrls.has(normUrl)) return;
    // Hard deny-list filter: block noise URLs before they enter the candidate pool
    if (isUrlDenied(normUrl.toLowerCase())) {
      laneCounts["denied"] = (laneCounts["denied"] || 0) + 1;
      return;
    }
    seenUrls.add(normUrl);
    result.link = normUrl;
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
  if (pinnedUrls && pinnedUrls.length > 0) {
    console.log(`[${companyName}] pinned=${pinnedUrls.length}: ${pinnedUrls.join(" | ")}`);
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

  // Authoritative registry lane — domains and search terms come from framework data.
  // Instruction 46: Enhanced with issuer-profile-driven search terms and entity verification.
  const frameworkRegistries = ((framework as any).authoritativeRegistries as string[] | null) || [];
  if (frameworkRegistries.length > 0) {
    // Use issuer profile search terms when available (more comprehensive than just name+aliases)
    const registrySearchTerms = issuerProfile
      ? buildRegistrySearchTerms(issuerProfile)
      : [companyName, ...(opts.isin ? [opts.isin] : [])];

    const registryHits = await discoverRegistryLane(
      companyName,
      registrySearchTerms,
      opts.isin || null,
      frameworkRegistries
    );

    // Instruction 46: Score registry results against issuer profile for entity verification
    const allRegistryResults = [];
    let registryTotalQueries = frameworkRegistries.length * registrySearchTerms.length;
    for (const hit of registryHits) {
      const normUrl = normaliseUrl(hit.url);
      if (seenUrls.has(normUrl)) continue;

      // Entity verification: score how well this result matches our issuer
      if (issuerProfile) {
        const entityScore = scoreEntityMatch(
          { url: normUrl, title: hit.title },
          issuerProfile,
          [],
        );
        allRegistryResults.push({
          registryDomain: hit.source,
          queryVariant: companyName,
          resultUrl: normUrl,
          resultTitle: hit.title,
          entityMatchScore: entityScore.score,
          entityMatchSignals: entityScore.signals,
          status: entityScore.score >= 50 ? "matched" as const
            : entityScore.score >= 25 ? "ambiguous" as const
            : "no-match" as const,
        });

        // Only add high-confidence matches; downgrade ambiguous acronym-only matches
        if (entityScore.isAmbiguous && entityScore.score < 40) {
          laneCounts["registry-ambiguous"] = (laneCounts["registry-ambiguous"] || 0) + 1;
          continue; // Skip ambiguous acronym-only matches
        }
      }

      seenUrls.add(normUrl);
      allCandidates.push({
        url: normUrl,
        title: hit.title,
        snippet: "",
        lane: "registry-search",
        priority: -100,
      });
      laneCounts["registry-search"] = (laneCounts["registry-search"] || 0) + 1;
    }

    registrySummary = aggregateRegistryResults(
      frameworkRegistries,
      registryTotalQueries,
      allRegistryResults,
    );
    diagBuilder.setRegistrySearch(registrySummary);

    if (registryHits.length > 0) {
      console.log(`[${companyName}] Registry lane: ${registryHits.length} raw hits, ${laneCounts["registry-search"] || 0} accepted, ${laneCounts["registry-ambiguous"] || 0} ambiguous-rejected`);
    }
  }

  // Lane 1: General search (with recency filter)
  // The cap ONLY trims metadata (Layer 3) queries. Templates (Layer 1) and
  // legacy topic-tuned queries (Layer 2) are ALWAYS run in full — they are the
  // proven breadth that drives the baseline averages. The cap prevents the
  // additive metadata layer from exploding search-API volume under concurrency.
  const MAX_TOTAL_GENERAL_QUERIES = 18;
  const queryResult = buildGeneralQueries(companyName, framework, companyDomain || undefined);
  // Use the layer counts returned by buildGeneralQueries (single source of truth).
  const coreLayers = queryResult.templateCount + queryResult.legacyCount;
  const effectiveCap = Math.max(coreLayers, MAX_TOTAL_GENERAL_QUERIES);
  const generalQueries = queryResult.queries.slice(0, effectiveCap);
  console.log(`[${companyName}] Running general search lane (${generalQueries.length}/${queryResult.queries.length} queries, templates=${queryResult.templateCount}, legacy=${queryResult.legacyCount}, metadata=${queryResult.metadataCount}, cap=${effectiveCap})`);
  let queryIndex = 0;
  for (const query of generalQueries) {
    const results = await webSearch(query, { num: searchDepth, tbs: "qdr:y2" });
    for (const r of results) addCandidate(r, "general");

    // Position-based retry: run the unfiltered fallback on the first 6 queries
    // regardless of total count. This ensures older-but-valid documents (e.g.
    // modern slavery statements >2 years old) are still discoverable, while
    // limiting the API volume increase to a bounded 6 extra calls.
    if (results.length < 3 && queryIndex < 6) {
      const unfiltered = await webSearch(query, { num: searchDepth });
      // Limit unfiltered contribution per query — the fallback is for recall,
      // not for corpus dominance. This prevents older documents from crowding
      // out recent ones in the LLM's scoring context.
      const UNFILTERED_QUERY_CAP = 3;
      for (const r of unfiltered.slice(0, UNFILTERED_QUERY_CAP)) {
        addCandidate(r, "general-unfiltered");
      }
    }
    queryIndex++;
  }

  // Lane 1b (I73 Fix 2B): Generic corporate-artefact discovery lane.
  // Fires a fixed set of framework-agnostic queries targeting well-known
  // corporate document classes (annual/integrated reports, universal registration
  // documents, investor fact books, 20-F/10-K filings, proxy materials, investor
  // relations hubs). These queries do NOT reference the framework's topic and
  // therefore surface authoritative corporate artefacts even when the topic-scoped
  // queries (Lane 1 templates) miss them. Truth-baseline analysis on fw9
  // (2026-08-24) showed material disclosures on subdomains like library.e.abb.com,
  // investorfactbook.spglobal.com, aflac.co.jp and www-axa-com.cdn.prismic.io
  // that Lane 1 topic queries never surfaced but that generic-artefact queries
  // return on page 1. This lane is capped at 10 queries per company and its
  // output feeds subsequent lanes (domain-family resolution, pack composition).
  const _laneB_currentYear = new Date().getFullYear();
  const _laneB_lastYear = _laneB_currentYear - 1;
  const GENERIC_ARTEFACT_QUERIES = [
    `"${companyName}" annual report ${_laneB_currentYear} OR ${_laneB_lastYear}`,
    `"${companyName}" integrated report ${_laneB_currentYear} OR ${_laneB_lastYear}`,
    `"${companyName}" sustainability report ${_laneB_currentYear} OR ${_laneB_lastYear}`,
    `"${companyName}" universal registration document`,
    `"${companyName}" investor fact book`,
    `"${companyName}" annual information form`,
    `"${companyName}" 20-F OR 10-K filing`,
    `"${companyName}" proxy statement OR management circular`,
    `"${companyName}" investor relations documents`,
    `"${companyName}" corporate governance charter`,
  ];
  console.log(`[${companyName}] Running generic-artefact discovery lane (${GENERIC_ARTEFACT_QUERIES.length} queries)`);
  for (const query of GENERIC_ARTEFACT_QUERIES) {
    const results = await webSearch(query, { num: searchDepth });
    for (const r of results) addCandidate(r, "generic-artefact");
  }

  // Lane 2: Domain-anchored search (with auto-detection if no domain set)
  // 40-G: Short-circuit if company already has cached domain family (< 30 days old)
  // P3: Static import moved to top of file (see import block)
  const companyRow = opts.companyRow || {};
  let effectiveDomain: string | null = null;
  let relatedDomains: string[] = [];
  let domainAutoDetected = false;

  // 42-A + 41-B: Use cached family if available, fresh, AND same pipeline version.
  // Distinguish null (never resolved) from [] (resolved, legitimately empty).
  // NOTE: Drizzle returns camelCase properties (figiName, relatedDomains, etc.)
  // I53: cachedDomain is `let` (not `const`) so a boundary-verification failure
  // can clear it and force re-resolution downstream.
  let cachedDomain = companyDomain ? normaliseToRegistrableDomain(companyDomain) : null;
  const cachedRelated = companyRow.relatedDomains as string[] | null; // null = not yet resolved
  const cachedRdVersion = companyRow.relatedDomainsPipelineVersion as string | null;
  const figiResolvedAt = companyRow.figiResolvedAt ? new Date(companyRow.figiResolvedAt) : null;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // I53 / I54: Verify cachedDomain against the discriminative token-boundary
  // rule. When it fails, clear the stale value and force re-resolution.
  if (cachedDomain) {
    const nameForVerify = (companyRow.figiName as string | null) || companyName;
    const aliasesForVerify = deriveAliases(nameForVerify, (companyRow.figiTicker as string | null | undefined) ?? null);
    const nameTokens = nameForVerify.toLowerCase().split(/[\s&,.']+/).filter((w) => w.length >= 3);
    const check = domainMatchesIssuerDistinctively(cachedDomain, aliasesForVerify, nameTokens);
    if (!check.ok) {
      console.warn(`[${companyName}] I53/I54: cached domain '${cachedDomain}' fails discriminative check (aliases=[${aliasesForVerify.join(",")}], name='${nameForVerify}') — clearing`);
      if (companyRow.id) {
        try {
          await db.execute(sql`UPDATE companies SET domain = NULL, related_domains = NULL, related_domains_pipeline_version = NULL WHERE id = ${companyRow.id}`);
        } catch (clrErr: any) {
          console.warn(`[${companyName}] I53: failed to clear stale domain cache: ${clrErr?.message}`);
        }
      }
      cachedDomain = null;
    }
  }

  // 42-A: Cache HIT requires: domain set AND relatedDomains not null AND version match AND wall-clock fresh.
  if (
    cachedDomain &&
    cachedRelated !== null &&
    cachedRdVersion === PIPELINE_VERSION &&
    figiResolvedAt &&
    figiResolvedAt > thirtyDaysAgo
  ) {
    // Short-circuit: use cached family
    effectiveDomain = cachedDomain;
    relatedDomains = cachedRelated;
    console.log(`[${companyName}] 41-B: using cached domain family: ${effectiveDomain} + [${relatedDomains.join(", ")}]`);
  } else {
    // Full resolution ladder: 40-0 → 40-A → 40-B → 40-C → 40-D

    // 40-0: Resolve canonical name via OpenFIGI (if ISIN available)
    // P3: resolveCompanyFIGI now returns cached values when fresh, so we always call it.
    let figiName = companyRow.figiName || null;
    let figiTicker = companyRow.figiTicker || null;
    if (companyRow.isin) {
      const figiResult = await resolveCompanyFIGI({
        id: companyRow.id || 0,
        isin: companyRow.isin,
        figiResolvedAt: companyRow.figiResolvedAt,
        figiName: companyRow.figiName,
        figiTicker: companyRow.figiTicker,
        figiPipelineVersion: companyRow.figiPipelineVersion, // 42-A
        domain: companyRow.domain,
      });
      if (figiResult.name) figiName = figiResult.name;
      if (figiResult.ticker) figiTicker = figiResult.ticker;
    }

    // 40-A: Derive aliases from canonical name (or company.name fallback)
    const nameForAliases = figiName || companyName;
    const aliases = deriveAliases(nameForAliases, figiTicker);

    // I56 / 40-Y: Annual-report Serper lane. Runs a single query
    // `"<companyName>" annual report` and picks the top-frequency root
    // domain across the top 10 organic hits. This is our HIGHEST-priority
    // domain signal because Serper indexes the real corporate web,
    // catching cases where FMP's website field is wrong or where the
    // brand-name domain isn't derivable from the legal name.
    // Framework-agnostic and topic-agnostic.
    let annualReportDomain: string | null = null;
    try {
      annualReportDomain = await discoverPrimaryDomainViaAnnualReportSearch(
        figiName || companyName,
        companyName,
        aliases,
      );
    } catch (arErr: any) {
      console.warn(`[${companyName}] 40-Y annual-report lane failed (non-fatal): ${arErr?.message}`);
    }

    // I55 / 40-Z: Authoritative FMP lookup by ISIN. When FMP returns a
    // corporate website, treat it as the primary domain and skip 40-A/B/C.
    // FMP publishes the canonical corporate website per regulatory ISIN
    // mapping (SMFG->smfg.co.jp, MUFG->mufg.jp, CCB->ccb.com,
    // CBA->commbank.com.au, BNS->scotiabank.com, HDFC->hdfc.bank.in).
    // Framework-agnostic and topic-agnostic: same call flow for every issuer.
    //
    // I55c: Relaxed sanity gate for FMP-sourced domains. The strict
    // discriminative-token rule (I52-I54) works when the corporate site
    // uses the LEGAL-name tokens (e.g. barclays.com contains 'barclays'
    // matching 'BARCLAYS PLC'), but corporates often brand under a distinct
    // short name (commbank vs Commonwealth Bank, scotiabank vs Bank of Nova
    // Scotia, hdfcbank vs HDFC Bank Limited, mufg vs Mitsubishi UFJ FG).
    // For FMP-sourced domains we ALSO consider tokens derived from FMP's
    // canonical companyName which more often matches the brand.
    let fmpResolvedDomain: string | null = null;
    if (companyRow.isin && (companyRow.fmpPipelineVersion !== PIPELINE_VERSION || !companyRow.fmpResolvedAt)) {
      try {
        const fmpProfile = await resolveViaFmp(companyRow.isin);
        if (fmpProfile) {
          const fmpDomainCandidate = fmpWebsiteToDomain(fmpProfile.website);
          const normalisedFmpDomain = fmpDomainCandidate ? normaliseToRegistrableDomain(fmpDomainCandidate) : null;
          // Sanity check strategy: FMP is authoritative-per-ISIN, but we
          // still guard against obviously wrong `website` fields. A domain
          // is REJECTED only when its apex root appears in a closed deny-
          // list of shared/aggregator/exchange hosts. Otherwise ACCEPT —
          // corporate websites often use a brand name (commbank, scotiabank,
          // mufg) that is not derivable from the legal name, so requiring
          // token equality is too strict for FMP data.
          const FMP_NEVER_ISSUER_DOMAINS = new Set([
            "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com",
            "wikipedia.org", "reuters.com", "bloomberg.com", "ft.com", "cnbc.com",
            "google.com", "amazon.com", "reddit.com", "medium.com",
            "nasdaq.com", "marketwatch.com", "finance.yahoo.com", "yahoo.com",
            "moomoo.com", "seekingalpha.com", "stockanalysis.com", "tipranks.com",
            "ssga.com", "ishares.com", "blackrock.com", "vanguard.com",
            "morningstar.com", "fool.com", "investing.com", "stocktwits.com",
            "finbox.com", "simplywall.st", "gurufocus.com", "zacks.com",
            "canada.ca", "gov.uk", "gov.au", "europa.eu",
          ]);
          const denied = normalisedFmpDomain && FMP_NEVER_ISSUER_DOMAINS.has(normalisedFmpDomain);
          if (normalisedFmpDomain && !denied) {
            fmpResolvedDomain = normalisedFmpDomain;
            console.log(`[${companyName}] 40-Z: FMP resolved website=${fmpProfile.website} → domain=${normalisedFmpDomain} (symbol=${fmpProfile.symbol}, fmpName=${fmpProfile.companyName})`);
          } else if (denied) {
            console.warn(`[${companyName}] 40-Z: FMP website ${normalisedFmpDomain} is on the never-issuer deny-list — ignoring`);
          }
          // Persist ALL FMP fields regardless of website-gate outcome so
          // downstream registry / disambiguation code can use them.
          if (companyRow.id) {
            try {
              await db.execute(sql`
                UPDATE companies SET
                  fmp_symbol = ${fmpProfile.symbol},
                  fmp_company_name = ${fmpProfile.companyName},
                  fmp_website = ${fmpProfile.website},
                  fmp_description = ${fmpProfile.description},
                  fmp_country = ${fmpProfile.country},
                  fmp_industry = ${fmpProfile.industry},
                  fmp_sector = ${fmpProfile.sector},
                  fmp_resolved_at = NOW(),
                  fmp_pipeline_version = ${PIPELINE_VERSION}
                WHERE id = ${companyRow.id}
              `);
            } catch (persistErr: any) {
              console.warn(`[${companyName}] 40-Z: failed to persist FMP fields: ${persistErr?.message}`);
            }
          }
        } else {
          console.log(`[${companyName}] 40-Z: FMP returned no match for ISIN ${companyRow.isin}`);
        }
      } catch (fmpErr: any) {
        // Never fatal: fall through to existing 40-A/B/C ladder.
        console.warn(`[${companyName}] 40-Z: FMP lookup failed (non-fatal): ${fmpErr?.message}`);
      }
    } else if (companyRow.isin) {
      // Cache-hit path: reuse persisted FMP website if it still passes today's
      // boundary check.
      const cachedFmpWebsite = (companyRow as any).fmpWebsite as string | null | undefined;
      const cachedFmpDomain = cachedFmpWebsite ? fmpWebsiteToDomain(cachedFmpWebsite) : null;
      if (cachedFmpDomain) {
        const normalisedFmpDomain = normaliseToRegistrableDomain(cachedFmpDomain);
        const nameTokens = nameForAliases.toLowerCase().split(/[\s&,.']+/).filter((w: string) => w.length >= 3);
        const gate = domainMatchesIssuerDistinctively(normalisedFmpDomain, aliases, nameTokens);
        if (gate.ok) {
          fmpResolvedDomain = normalisedFmpDomain;
          console.log(`[${companyName}] 40-Z (cache-hit): reusing FMP domain ${normalisedFmpDomain}`);
        }
      }
    }

    // 39-A + 40-A: normalise stored domain, then try inference with aliases.
    // I56 / I55 domain-priority order:
    //   1) 40-Y annualReportDomain (Serper search real-index evidence)
    //   2) 40-Z fmpResolvedDomain (FMP authoritative ISIN→website)
    //   3) cachedDomain (already verified via I53 boundary check)
    //   4) 40-A/B inferDomainFromResults (Lane 1 candidate scan)
    //   5) 40-C discoverPrimaryDomainViaExplicitQuery (secondary Serper query)
    // Real-index Serper evidence trumps FMP because Serper catches FMP's
    // occasional wrong-website mappings (e.g. HDFC->hdfc.bank.in when the
    // corporate site is actually hdfcbank.com).
    effectiveDomain = annualReportDomain || fmpResolvedDomain || cachedDomain || null;
    if (!effectiveDomain) {
      effectiveDomain = inferDomainFromResults(allCandidates, companyName, aliases);
      if (effectiveDomain) {
        domainAutoDetected = true;
        console.log(`[${companyName}] 40-A/B: resolved domain: ${effectiveDomain}`);
      }
    }

    // 40-C: If still unresolved, try explicit corporate-domain query
    if (!effectiveDomain) {
      const issuerName = figiName || companyName;
      effectiveDomain = await discoverPrimaryDomainViaExplicitQuery(issuerName, companyName, aliases);
    }

    // 40-D: Discover related domains (evidence-gated)
    if (effectiveDomain) {
      // Core tokens = distinctive words from the primary domain
      const domainParts = effectiveDomain.split(".")[0].toLowerCase();
      // I54: exclude generic tokens from coreTokens so a related-domain match
      // like banktrack.org (contains 'bank') is not accepted as a family member.
      const coreTokens = aliases.filter(a => a.length >= 3 && domainParts.includes(a) && !GENERIC_DOMAIN_TOKENS.has(a.toLowerCase()));
      // Also add the domain root itself as a core token (never generic)
      if (domainParts.length >= 3 && !GENERIC_DOMAIN_TOKENS.has(domainParts)) coreTokens.push(domainParts);
      relatedDomains = discoverRelatedDomains(effectiveDomain, allCandidates, [...new Set(coreTokens)]);

      // 41-F: Cross-brand sibling discovery (e.g. chase.com for JPMorgan Chase)
      const issuerNameForSiblings = figiName || companyName;
      const crossBrandSiblings = await discoverCrossBrandSiblings(
        issuerNameForSiblings, effectiveDomain, relatedDomains, allCandidates
      );
      if (crossBrandSiblings.length > 0) {
        relatedDomains = [...new Set([...relatedDomains, ...crossBrandSiblings])];
        console.log(`[${companyName}] 41-F: cross-brand siblings: [${crossBrandSiblings.join(", ")}]`);
      }

      // Union with manual overrides
      const manualDomains = (companyRow.relatedDomainsManual as string[] | null) || [];
      if (manualDomains.length > 0) {
        relatedDomains = [...new Set([...relatedDomains, ...manualDomains])];
      }

      // Persist resolved family to DB (42-A: include pipeline version)
      if (companyRow.id) {
        try {
          const domainsJson = JSON.stringify(relatedDomains);
          await db.execute(sql`
            UPDATE companies SET
              domain = ${effectiveDomain},
              related_domains = ${domainsJson}::jsonb,
              related_domains_pipeline_version = ${PIPELINE_VERSION}
            WHERE id = ${companyRow.id}
          `);
        } catch (e: any) {
          console.warn(`[${companyName}] Failed to persist domain family: ${e.message}`);
        }
      }

      console.log(`[${companyName}] 40-D: domain family: ${effectiveDomain} + [${relatedDomains.join(", ")}]`);
    } else {
      // 41-B: Even when no domain found, persist empty [] to mark as "resolved, empty"
      // so the next battery doesn't re-run the full ladder.
      // 42-A: Also persist pipeline version.
      if (companyRow.id) {
        try {
          await db.execute(sql`
            UPDATE companies SET
              related_domains = '[]'::jsonb,
              related_domains_pipeline_version = ${PIPELINE_VERSION},
              figi_resolved_at = NOW()
            WHERE id = ${companyRow.id}
          `);
        } catch (e: any) {
          console.warn(`[${companyName}] Failed to persist empty domain family: ${e.message}`);
        }
      }
      console.log(`[${companyName}] domain-unresolved: no domain found after full 40 ladder`);
    }
  }

  // 40-F: Lane 2 query-budget cap
  const MAX_LANE2_QUERIES = parseInt(process.env.MAX_LANE2_QUERIES_PER_COMPANY || "60", 10);
  const allDomains = effectiveDomain ? [effectiveDomain, ...relatedDomains] : [];
  let lane2QueryCount = 0;

  if (allDomains.length > 0) {
    // 41-I: Weight Lane 2 allocation by Lane 1 evidence (sqrt-dampened).
    // Single-pass domain-hit count from allCandidates.
    const domainHitCounts = new Map<string, number>();
    for (const c of allCandidates) {
      try {
        const root = normaliseToRegistrableDomain(new URL(c.url).hostname);
        domainHitCounts.set(root, (domainHitCounts.get(root) || 0) + 1);
      } catch {}
    }
    const domainsWithHits = allDomains.map(d => ({
      domain: d,
      laneOneHits: domainHitCounts.get(d) || 0,
    }));
    const totalWeight = domainsWithHits.reduce(
      (s, d) => s + Math.sqrt(Math.max(1, d.laneOneHits)), 0
    );
    const MIN_PER_DOMAIN = 3;
    const budgetPerDomain = new Map<string, number>();
    for (const d of domainsWithHits) {
      const weight = Math.sqrt(Math.max(1, d.laneOneHits));
      const share = Math.floor(MAX_LANE2_QUERIES * weight / totalWeight);
      budgetPerDomain.set(d.domain, Math.max(MIN_PER_DOMAIN, share));
    }
    console.log(`[${companyName}] Lane 2: ${allDomains.length} domains, budget ${MAX_LANE2_QUERIES}, allocation: ${allDomains.map(d => `${d}=${budgetPerDomain.get(d)}`).join(", ")}`);

    for (const domain of allDomains) {
      const domainQueries = buildDomainQueries(companyName, domain, framework, topicPhrases);
      const domainBudget = budgetPerDomain.get(domain) || MIN_PER_DOMAIN;
      const budgetSlice = Math.min(domainQueries.length, domainBudget);

      for (let qi = 0; qi < budgetSlice && lane2QueryCount < MAX_LANE2_QUERIES; qi++) {
        const results = await webSearch(domainQueries[qi], { num: searchDepth });
        for (const r of results) addCandidate(r, "domain");
        lane2QueryCount++;
      }
    }
    console.log(`[${companyName}] Lane 2 total queries: ${lane2QueryCount}/${MAX_LANE2_QUERIES}`);
  } else {
    console.log(`[${companyName}] No domain available, skipping domain-anchored search`);
  }

  // Lane 2b: Topic-lexicon own-site probe (topic-agnostic)
  // Uses the framework's derived topic lexicon to search the company's own domain
  // for dedicated topic pages that may not rank for generic queries.
  // This catches pages like aboutamazon.com/ai, company.com/sustainability, etc.
  // P1 fix: Lane 2b/2c now count against the same MAX_LANE2_QUERIES budget.
  if (effectiveDomain && topicPhrases.length > 0 && lane2QueryCount < MAX_LANE2_QUERIES) {
    console.log(`[${companyName}] Running topic-lexicon own-site probe (budget remaining: ${MAX_LANE2_QUERIES - lane2QueryCount})`);
    // Use the top 6 topic phrases as individual site-scoped queries
    const probeTerms = topicPhrases.slice(0, 6);
    for (const term of probeTerms) {
      if (lane2QueryCount >= MAX_LANE2_QUERIES) break;
      const query = `site:${effectiveDomain} ${term}`;
      const results = await webSearch(query, { num: 5 });
      for (const r of results) addCandidate(r, "topic-probe");
      lane2QueryCount++;
    }
    // Also try common corporate URL patterns with slugified topic terms
    // (these are synthetic candidates, not search queries — no budget cost)
    const slugTerms = topicPhrases.slice(0, 3).map(t => t.toLowerCase().replace(/\s+/g, "-"));
    for (const slug of slugTerms) {
      const probeUrls = [
        `https://${effectiveDomain}/${slug}`,
        `https://www.${effectiveDomain}/${slug}`,
        `https://${effectiveDomain}/about/${slug}`,
      ];
      for (const url of probeUrls) {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          allCandidates.push({
            url,
            title: `Topic probe: ${slug}`,
            snippet: "",
            lane: "topic-probe-url",
            priority: -30, // High priority — deterministic own-site topic page
          });
          laneCounts["topic-probe-url"] = (laneCounts["topic-probe-url"] || 0) + 1;
        }
      }
    }
  }

  // Lane 2c (39-B): subdomain-variant site: queries for requiredDocTypes.
  // Some companies host disclosures on subdomains (about.bankofamerica.com, investor.citigroup.com).
  // After Lane 1 populates candidates, identify the top subdomains of the root domain
  // and generate site: queries against each for each requiredDocType.
  // P1 fix: Also counts against MAX_LANE2_QUERIES budget.
  const reqDocTypes39B = ((framework as any).requiredDocTypes as string[] | null) || [];
  const rootDomain = effectiveDomain;
  if (rootDomain && reqDocTypes39B.length > 0 && lane2QueryCount < MAX_LANE2_QUERIES) {
    const subdomainCounts = new Map<string, number>();
    for (const c of allCandidates) {
      try {
        const url = new URL(c.url);
        const host = url.hostname.replace(/^www\./, "");
        if (host !== rootDomain && host.endsWith("." + rootDomain)) {
          subdomainCounts.set(host, (subdomainCounts.get(host) || 0) + 1);
        }
      } catch {}
    }
    const topSubdomains = Array.from(subdomainCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([host]) => host);

    if (topSubdomains.length > 0) {
      console.log(`[${companyName}] 39-B: subdomain-variant queries for ${topSubdomains.join(", ")} (budget remaining: ${MAX_LANE2_QUERIES - lane2QueryCount})`);
      for (const subdomain of topSubdomains) {
        for (const docType of reqDocTypes39B.slice(0, 5)) {
          if (lane2QueryCount >= MAX_LANE2_QUERIES) break;
          const q = `site:${subdomain} ${docType}`;
          const results = await webSearch(q, { num: 15 });
          for (const r of results) addCandidate(r, "domain-variant");
          lane2QueryCount++;
        }
        // I73 (Fix 2A): also probe topic phrases per subdomain. Truth-baseline
        // analysis (fw9, 2026-08-24) showed material AI-governance content on
        // subdomains like library.e.abb.com and investorfactbook.spglobal.com
        // that are missed by doctype queries alone. Bounded by MAX_LANE2_QUERIES.
        for (const phrase of topicPhrases.slice(0, 3)) {
          if (lane2QueryCount >= MAX_LANE2_QUERIES) break;
          const q = `site:${subdomain} ${phrase}`;
          const results = await webSearch(q, { num: 10 });
          for (const r of results) addCandidate(r, "domain-variant-topic");
          lane2QueryCount++;
        }
        if (lane2QueryCount >= MAX_LANE2_QUERIES) break;
      }
    }
  }
  console.log(`[${companyName}] Lane 2 final query count (all sub-lanes): ${lane2QueryCount}/${MAX_LANE2_QUERIES}`);

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
    const localizedQueries = buildLocalizedTopicQueries(companyName, framework, localeProfile, topicPhrases);
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
    // R7c: enable extendedForms so we also pin recent proxies, 6-K, 10-Q, 8-K filings.
    // Foreign private issuers (Ambev, BHP) publish sustainability updates via 6-K,
    // not annual reports, and were previously missed.
    const annual = await resolveAuthoritativeAnnualFilings({
      companyName,
      ticker: opts.ticker,
      maxFilings: 3,
      extendedForms: true,
    });
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
  const irQueries = buildInvestorRelationsQueries(companyName, effectiveDomain, framework, topicPhrases);
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
    const sectorQueries = buildSectorSpecificQueries(companyName, opts.sector, framework, topicPhrases);
    for (const query of sectorQueries) {
      const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
      for (const r of results) addCandidate(r, "sector-specific");
    }
  }


  // Lane 11: Subsidiary / CDN discovery (P2c)
  // Search on known subsidiary/brand names and allow PDF discovery on common
  // corporate-doc CDNs. This catches the Coinbase modern-slavery-statement miss
  // (CB Payments is the subsidiary that publishes the MSA statement).
  // Also searches common IR/doc CDNs that host company PDFs.
  {
    const CORPORATE_DOC_CDNS = ["ctfassets.net", "q4cdn.com", "s3.amazonaws.com"];
    const topicKeywords = topicPhrases.slice(0, 3).join(" OR ");

    // Search for company + topic on common corporate CDNs
    if (topicKeywords) {
      for (const cdn of CORPORATE_DOC_CDNS) {
        const query = `site:${cdn} "${companyName}" ${topicKeywords} filetype:pdf`;
        try {
          const results = await webSearch(query, { num: 5 });
          for (const r of results) addCandidate(r, "cdn-pdf");
        } catch { /* best-effort */ }
      }
    }

    // Search for subsidiary/brand names if the company name suggests a parent
    // Common patterns: "Group" → search without "Group"; multi-word → search abbreviation
    const parentName = companyName.replace(/\s+(Group|Holdings|Inc\.?|Corp\.?|Ltd\.?|PLC|SE|AG|SA|NV)\s*$/i, "").trim();
    if (parentName !== companyName && parentName.length >= 3) {
      const subQuery = `"${parentName}" ${topicPhrases.slice(0, 2).join(" ")} filetype:pdf`;
      try {
        const results = await webSearch(subQuery, { num: 5 });
        for (const r of results) addCandidate(r, "subsidiary");
      } catch { /* best-effort */ }
    }

    laneCounts["subsidiary-cdn"] = (laneCounts["subsidiary-cdn"] || 0);
  }

  // Lane 12 (Instruction 46): Evidence-keyword expanded queries from issuer profile
  if (queryExpansionResult && queryExpansionResult.queries.length > 0) {
    console.log(`[${companyName}] Running evidence-keyword expansion lane (${queryExpansionResult.queries.length} queries)`);
    for (const eq of queryExpansionResult.queries) {
      try {
        const results = await webSearch(eq.query, { num: Math.min(searchDepth, 10) });
        for (const r of results) addCandidate(r, "evidence-expansion");
      } catch { /* best-effort */ }
    }
  }

  // ── R6 Discovery Rules ─────────────────────────────────────────────────────
  // Six generalised rules to close known false-negative discovery gaps.
  // See docs/R6-Discovery-Rules-Design-2026-09-05.md for full rationale.
  // Each rule is framework-agnostic and only ADDS candidates; the existing
  // pre-gate, provenance filter, and ranking code paths are unchanged.

  // R6a — IR-platform tenant enumeration (Q4Inc s24.q4cdn.com, Investis, ...)
  // On first run: bootstrap query per known platform to seed tenant discovery.
  // On subsequent runs: read persisted tenants from discoveryDiagnostics.irPlatformTenants
  // and issue direct site:cdn/<tenant>/ queries.
  try {
    const priorDiag = (opts.companyRow?.discoveryDiagnostics ?? {}) as any;
    const persistedTenants = Array.isArray(priorDiag.irPlatformTenants)
      ? priorDiag.irPlatformTenants as { platform: string; tenant: string }[]
      : [];
    const irQueries = buildIRPlatformSeedQueries(companyName, persistedTenants, topicPhrases);
    if (irQueries.length > 0) {
      console.log(`[${companyName}] R6a Running IR-platform tenant lane (${irQueries.length} queries, ${persistedTenants.length} persisted tenants)`);
      for (const q of irQueries.slice(0, 12)) {
        try {
          const results = await webSearch(q, { num: Math.min(searchDepth, 10) });
          for (const r of results) addCandidate(r, "r6a-ir-platform");
        } catch { /* best-effort */ }
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6a IR-platform lane failed: ${e?.message}`);
  }

  // R7a — Directory-index enumeration for known IR-platform tenants.
  // For any persisted tenant on a platform that publishes an Apache-style
  // directory index (currently Q4Inc s24.q4cdn.com), fetch each configured
  // directoryIndexBase URL and emit any PDF/xhtml files it lists as
  // candidates. Complementary to R6a (which uses Serper site: queries) —
  // directory enumeration finds files Google hasn't indexed yet.
  try {
    const priorDiag = (opts.companyRow?.discoveryDiagnostics ?? {}) as any;
    const persistedTenants = Array.isArray(priorDiag.irPlatformTenants)
      ? priorDiag.irPlatformTenants as { platform: string; tenant: string }[]
      : [];
    for (const t of persistedTenants.slice(0, 3)) {
      try {
        const urls = await enumerateTenantDirectory({
          platform: t.platform,
          tenant: t.tenant,
          fetchTimeoutMs: 5000,
          maxUrlsPerBase: 30,
        });
        if (urls.length > 0) {
          console.log(`[${companyName}] R7a directory-enumeration found ${urls.length} files for ${t.platform}:${t.tenant}`);
          for (const url of urls) {
            addCandidate({
              link: url,
              title: `[${t.platform}-directory-index] ${new URL(url).pathname.split("/").pop() || url}`,
              snippet: `Enumerated from ${t.platform} directory index for tenant ${t.tenant}`,
            } as any, "r7a-cdn-directory");
          }
        }
      } catch { /* best-effort per tenant */ }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R7a CDN directory lane failed: ${e?.message}`);
  }

  // R7d — Corporate landing-page seeding.
  // Before running the search-heavy lanes, HEAD-probe conventional ESG landing
  // URL patterns (/sustainability, /esg, /purpose, /global/sustainability, etc)
  // on the effective domain. Any URL returning 200 with substantive HTML is
  // emitted as a candidate so R6e link-farming can walk its links.
  // Bounded: max 5 hits per issuer, 3-second per-fetch timeout.
  if (effectiveDomain) {
    try {
      const hits = await probeLandingPages({
        effectiveDomain,
        fetchTimeoutMs: 3000,
        maxHits: 5,
      });
      if (hits.length > 0) {
        console.log(`[${companyName}] R7d landing-page seeding found ${hits.length} landing pages on ${effectiveDomain}`);
        for (const h of hits) {
          addCandidate({
            link: h.url,
            title: `[corporate-landing] ${new URL(h.url).pathname}`,
            snippet: `Landing page probed directly on ${effectiveDomain}`,
          } as any, "r7d-landing-seed");
        }
      }
    } catch (e: any) {
      console.warn(`[${companyName}] R7d landing-seed lane failed: ${e?.message}`);
    }
  }

  // R6b — Locale-aware topic-term variants (Spanish sostenibilidad, French durabilité, etc)
  // Extends the existing localized-topic lane with topic-native ESG vocabulary.
  try {
    const localeQueries = buildLocaleTopicQueries(companyName, opts.country, effectiveDomain);
    if (localeQueries.length > 0) {
      console.log(`[${companyName}] R6b Running locale-topic lane (${localeQueries.length} queries)`);
      for (const q of localeQueries.slice(0, 10)) {
        try {
          const gl = localeProfile?.gl;
          const hl = localeProfile?.hl;
          const results = await webSearch(q, { num: Math.min(searchDepth, 10), ...(gl ? { gl } : {}), ...(hl ? { hl } : {}) });
          for (const r of results) addCandidate(r, "r6b-locale-topic");
        } catch { /* best-effort */ }
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6b locale-topic lane failed: ${e?.message}`);
  }

  // R6c v2 — Regulator-repository API enumeration
  // v1 emitted directory URLs which the gate rejected as unfetchable. v2 calls
  // regulator APIs (filings.xbrl.org, HKEX titleSearchServlet) to return
  // concrete filing URLs. Best-effort, time-bounded, error-swallowed.
  try {
    console.log(`[${companyName}] R6c v2 invoking enumerator (lei=${issuerProfile?.lei ?? 'null'}, country=${opts.country ?? 'null'}, isin=${opts.isin ?? 'null'})`);
    const regFilings = await enumerateRegulatorFilings({
      companyName,
      lei: issuerProfile?.lei ?? (opts.companyRow?.lei as string | null) ?? null,
      country: opts.country ?? null,
      isin: opts.isin ?? null,
      fetchTimeoutMs: 8000,
    });
    console.log(`[${companyName}] R6c v2 enumerator returned ${regFilings.length} filings`);
    if (regFilings.length > 0) {
      console.log(`[${companyName}] R6c v2 Enumerated ${regFilings.length} regulator filings (${regFilings.map(r => r.source).join(", ")})`);
      for (const r of regFilings) {
        addCandidate({ link: r.url, title: r.title, snippet: r.snippet } as any, r.source);
      }
    }
    // Fallback: also emit v1 directory URLs (very low volume, harmless) so we
    // can still see the directory-URL patterns in diagnostics for regulators
    // whose APIs we haven't wrapped yet (TSX, ASX).
    const regUrls = buildRegulatorRepositoryUrls({
      companyName,
      lei: issuerProfile?.lei ?? (opts.companyRow?.lei as string | null) ?? null,
      country: opts.country ?? null,
      isin: opts.isin ?? null,
    });
    // Only emit the v1 URLs the v2 didn't cover (TSX/ASX today)
    for (const r of regUrls) {
      if (r.url.includes("sedarplus.ca") || r.url.includes("asx.com.au")) {
        addCandidate({ link: r.url, title: r.title, snippet: r.snippet } as any, "r6c-regulator-repo");
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6c regulator-repo lane failed: ${e?.message}`);
  }

  // R6d — Jurisdiction-aware framework document types
  // Adds queries with jurisdiction-specific doc types (CSRD sustainability statement,
  // UK section 172 statement, US 10-K, JP 有価証券報告書, etc).
  try {
    const jurQueries = buildJurisdictionDocTypeQueries({
      companyName,
      effectiveDomain,
      country: opts.country ?? null,
      isin: opts.isin ?? null,
    });
    if (jurQueries.length > 0) {
      console.log(`[${companyName}] R6d Running jurisdiction doc-type lane (${jurQueries.length} queries)`);
      for (const q of jurQueries.slice(0, 10)) {
        try {
          const results = await webSearch(q, { num: Math.min(searchDepth, 10) });
          for (const r of results) addCandidate(r, "r6d-jurisdiction-doctype");
        } catch { /* best-effort */ }
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6d jurisdiction-doctype lane failed: ${e?.message}`);
  }

  // R6e — Link-farming from ESG landing pages
  // For any candidate that looks like an ESG landing page, fetch it and extract
  // same-origin PDF and DAM links. Bounded to 3 landing pages per company.
  try {
    const landingCandidates = allCandidates
      .filter(c => isEsgLandingPage(c.url))
      .slice(0, 3);
    if (landingCandidates.length > 0) {
      console.log(`[${companyName}] R6e Link-farming ${landingCandidates.length} ESG landing pages`);
      const R6E_TIMEOUT_MS = 5000;
      for (const lc of landingCandidates) {
        try {
          const controller = new AbortController();
          const to = setTimeout(() => controller.abort(), R6E_TIMEOUT_MS);
          const resp = await fetch(lc.url, {
            signal: controller.signal,
            headers: { Accept: "text/html,*/*", "User-Agent": "CompanyIQ Discovery/1.0" },
            redirect: "follow",
          });
          clearTimeout(to);
          if (!resp.ok) continue;
          const html = await resp.text();
          if (!html || html.length < 100) continue;
          const extracted = extractLandingPageLinks({
            landingUrl: lc.url,
            html,
            maxLinks: 40,
            topicPhrases,
          });
          for (const ex of extracted) {
            addCandidate({ link: ex.url, title: `[link-farm from ${lc.url}] ${ex.hint}`, snippet: `Extracted from ESG landing page ${lc.url}` } as any, "r6e-link-farm");
          }
        } catch { /* best-effort */ }
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6e link-farm lane failed: ${e?.message}`);
  }

  // R6f — Sub-page enumeration on ESG report URL trees
  // For any landing page URL, issue `site:<host> inurl:<parent-path> <topic>`
  // Serper queries so we surface sub-pages that the landing page does NOT link
  // to explicitly.
  try {
    const landingCandidates = allCandidates
      .filter(c => isEsgLandingPage(c.url))
      .slice(0, 2);
    for (const lc of landingCandidates) {
      const enumQueries = buildSubpageEnumerationQueries(lc.url, topicPhrases);
      if (enumQueries.length > 0) {
        console.log(`[${companyName}] R6f Sub-page enumeration for ${lc.url} (${enumQueries.length} queries)`);
        for (const q of enumQueries.slice(0, 4)) {
          try {
            const results = await webSearch(q, { num: Math.min(searchDepth, 10) });
            for (const r of results) addCandidate(r, "r6f-subpage-enum");
          } catch { /* best-effort */ }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6f sub-page enum lane failed: ${e?.message}`);
  }

  // R7e — Sitemap.xml traversal on discovered landing pages.
  // Complements R6f (Serper site: inurl: queries) with deterministic sitemap-
  // based enumeration. Many corporate ESG sites publish a full sitemap.xml
  // that lists every subpage; parsing it lets us find sub-pages that Serper's
  // index doesn't return. Best-effort — many issuers block sitemap access.
  try {
    const landingCandidates = allCandidates
      .filter(c => isEsgLandingPage(c.url))
      .slice(0, 3);
    for (const lc of landingCandidates) {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 5000);
      try {
        const u = new URL(lc.url);
        // Try common sitemap locations in order
        const sitemapUrls = [
          `${u.origin}/sitemap.xml`,
          `${u.origin}/sitemap_index.xml`,
          `${u.origin}/sitemap-index.xml`,
        ];
        // Landing parent path (e.g. /purpose/esgreport for /purpose/esgreport/)
        const parentPath = u.pathname.replace(/\/$/, "") || u.pathname;
        let extracted: string[] = [];
        for (const sm of sitemapUrls) {
          try {
            const resp = await fetch(sm, {
              signal: controller.signal,
              headers: { Accept: "application/xml,*/*", "User-Agent": "CompanyIQ-Discovery/1.0" },
            });
            if (!resp.ok) continue;
            const xml = await resp.text();
            if (!xml || xml.length < 50) continue;
            const subs = parseSitemapForSubpaths(xml, parentPath);
            if (subs.length > 0) {
              extracted = subs.slice(0, 60);  // cap per issuer
              break;  // first successful sitemap wins
            }
          } catch { /* try next sitemap URL */ }
        }
        clearTimeout(to);
        for (const sub of extracted) {
          addCandidate({
            link: sub,
            title: `[sitemap sub-page from ${lc.url}]`,
            snippet: `Extracted from sitemap.xml under ${parentPath}`,
          } as any, "r7e-sitemap");
        }
        if (extracted.length > 0) {
          console.log(`[${companyName}] R7e sitemap enumerated ${extracted.length} sub-pages of ${lc.url}`);
        }
      } catch {
        clearTimeout(to);
      }
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R7e sitemap lane failed: ${e?.message}`);
  }

  // Persist newly-discovered IR-platform tenants for next-run bootstrap (R6a)
  try {
    const tenants = extractIRPlatformTenants(allCandidates.map(c => c.url));
    if (tenants.length > 0) {
      // Merge into diagBuilder for later persistence into discoveryDiagnostics
      diagBuilder.setIrPlatformTenants(tenants);
      console.log(`[${companyName}] R6a persisted IR-platform tenants: ${tenants.map(t => `${t.platform}:${t.tenant}`).join(", ")}`);
    }
  } catch (e: any) {
    console.warn(`[${companyName}] R6a tenant extraction failed: ${e?.message}`);
  }

  console.log(`[${companyName}] Discovery found ${allCandidates.length} total candidates`);

  // PRE-GATE HEURISTIC: Remove candidates whose title prominently mentions
  // a DIFFERENT company name. This catches obvious cross-company contamination
  // cheaply before the LLM gate runs.
  const companyNameLower = companyName.toLowerCase();
  const companyNameWords = companyNameLower.split(/[\s,\.\-&]+/).filter(w => w.length >= 3 && !['inc', 'ltd', 'plc', 'corp', 'group', 'the', 'and', 'company', 'limited', 'corporation', 'holdings', 'international'].includes(w));
  // Fix C: Use workspace-derived peer company names for anti-contamination filtering.
  // No hardcoded company names — the list is self-maintaining from the workspace universe.
  const KNOWN_OTHER_COMPANIES = (opts.peerCompanyNames || []);

  // Entity-specific exclusions: distinct issuers that share an ambiguous token
  // with the target (e.g. "360" → Qifu / 360 DigiTech / 360 Finance). These must
  // be rejected even when the title also contains the shared token, because the
  // generic name-match below would otherwise rescue them.
  const excludeEntities = disambiguationExclusions(companyName);
  const url2 = (s: string) => s.toLowerCase();

  // Fix 3 (Dead-fetch diagnosis): Filter out low-quality SEC EDGAR URLs that are
  // guaranteed to fail fetch — index pages, bare accession-folder URLs, XBRL viewers,
  // and non-primary exhibits (schedule 13G, form 4, etc.).
  const preEdgarFilterCount = allCandidates.length;
  const edgarFiltered = allCandidates.filter(c => {
    const u = c.url.toLowerCase();
    if (!/sec\.gov/.test(u)) return true; // Only filter SEC URLs
    // Reject EDGAR index pages
    if (/-index\.htm/.test(u) || /\/index\.htm/.test(u)) return false;
    // Reject bare accession-folder URLs (no file extension)
    if (/\/archives\/edgar\/data\/\d+\/\d+\/?$/.test(u)) return false;
    // Reject XBRL viewer URLs
    if (/viewer\.htm|ix\?doc=/.test(u)) return false;
    // Reject non-primary exhibits unless title indicates a primary filing
    const titleLower = (c.title || "").toLowerCase();
    const isExhibit = /ex\d|exhibit|schedule.?13|sc.?13[dg]|form.?[345]\b|\b6-?k\b/.test(u + " " + titleLower);
    const isPrimaryFiling = /10-?k|20-?f|40-?f|def.?14a|annual.?report/.test(titleLower);
    if (isExhibit && !isPrimaryFiling) return false;
    // Reject "Untitled" SEC pages (directory listings)
    if (titleLower === "untitled" || titleLower === "") return false;
    return true;
  });
  if (edgarFiltered.length < preEdgarFilterCount) {
    console.log(`[${companyName}] EDGAR quality filter removed ${preEdgarFilterCount - edgarFiltered.length} low-quality SEC URLs`);
  }

  // Fix 4 (Dead-fetch diagnosis): Drop URLs from known-blocked third-party
  // aggregators that consistently return 403/paywall and waste fetch retries.
  // Under first-party-only these are excluded anyway; removing them pre-gate
  // also saves LLM gate cost.
  const BLOCKED_AGGREGATOR_DOMAINS = new Set([
    "sustainabilityreports.com", "business-humanrights.org", "spglobal.com",
    "finance.yahoo.com", "yahoo.com", "relayto.com", "responsibilityreports.com",
    "seekingalpha.com", "morningstar.com", "ft.com", "wsj.com", "bloomberg.com",
    "reuters.com", "marketscreener.com", "simplywall.st", "tipranks.com",
  ]);
  const preAggregatorCount = edgarFiltered.length;
  const aggregatorFiltered = edgarFiltered.filter(c => {
    try {
      const host = new URL(c.url).hostname.replace(/^www\./, "").toLowerCase();
      return !BLOCKED_AGGREGATOR_DOMAINS.has(host) &&
        ![...BLOCKED_AGGREGATOR_DOMAINS].some(d => host.endsWith("." + d));
    } catch { return true; }
  });
  if (aggregatorFiltered.length < preAggregatorCount) {
    console.log(`[${companyName}] Aggregator filter removed ${preAggregatorCount - aggregatorFiltered.length} blocked third-party URLs`);
  }

  const filteredCandidates = aggregatorFiltered.filter(c => {
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

  // Fix 2 (Financed Emissions robustness): For non-US companies, cap SEC EDGAR
  // URLs to prevent the dense EDGAR filing set from crowding out the company's own
  // climate/sustainability reports. The 20-F and 1-2 key filings are kept (they have
  // the best priority scores), but the dozens of 6-Ks, FWPs, and prospectus supplements
  // that Google discovers are trimmed. US companies keep all their EDGAR filings.
  const isNonUS = opts.country && !/united states|usa|u\.s\./i.test(opts.country);
  let preCapCandidates = filteredCandidates;
  if (isNonUS) {
    const MAX_EDGAR_FOR_FOREIGN = 5;
    const edgarCandidates = filteredCandidates.filter(c => /sec\.gov/i.test(c.url));
    if (edgarCandidates.length > MAX_EDGAR_FOR_FOREIGN) {
      // Keep only the top-priority EDGAR URLs (by priority score, lower = better)
      const sortedEdgar = edgarCandidates.sort((a, b) => a.priority - b.priority);
      const keptEdgar = new Set(sortedEdgar.slice(0, MAX_EDGAR_FOR_FOREIGN).map(c => c.url));
      const removed = edgarCandidates.length - MAX_EDGAR_FOR_FOREIGN;
      preCapCandidates = filteredCandidates.filter(c => !/sec\.gov/i.test(c.url) || keptEdgar.has(c.url));
      console.log(`[${companyName}] EDGAR cap for non-US issuer: kept ${MAX_EDGAR_FOR_FOREIGN} of ${edgarCandidates.length} SEC URLs (removed ${removed})`);
    }
  }

  // Cap before gate to bound LLM cost.
  // Protected lanes (authoritative registry search, pinned, and filing submissions) bypass
  // the cap — these are structured-source high-confidence documents that should
  // never be pre-gate-rejected on a candidate-count budget.
  //
  // R5d (2026-09-04): reserve up to POLICY_RESERVED_SLOTS pre-gate slots for
  // policy-family documents (any URL/title whose text matches
  // POLICY_VEHICLE_TEST). Motivation: the Kering iter-14 FN diagnosis showed
  // that legitimate policy-vehicle URLs (e.g. `Environmental_Policy_2024_2025.pdf`)
  // were among the 180 pre-gate-filtered candidates because the higher-
  // priority lanes (sustainability report, annual report, ...) exhausted the
  // pre-gate slot budget before the policy queries' results could enter it.
  //
  // Reserved slots come off the top of the same 180 budget: the first N slots
  // are given to the top-priority policy-family docs, and the remaining
  // (180 - N) slots are filled from the general unprotected sort. Reserved
  // slots don't grow the total budget, so the LLM-cost bound is unchanged.
  // Regulator-API-derived candidates from R6c v2 (ESEF, HKEX) are authoritative
  // and should never be trimmed by the pre-gate cap. Same for pinned URLs, EDGAR
  // submissions (already deterministic API-sourced), and registry-search.
  const PROTECTED_LANES = [
    "registry-search", "pinned", "edgar-submissions",
    "r6c-esef-api", "r6c-hkex-api",
    "a-share-cninfo-api",  // parallel to r6c-*: China regulator API
  ];
  const POLICY_RESERVED_SLOTS = 10;
  // R5d policy-family detector — keep aligned with disclosure-document-types.ts
  // RANK_BOOSTS policy-family pattern. Matches on URL or title text so the
  // rule catches both explicit filename hints (`environmental-policy.pdf`)
  // and title-only cues (`Kering Environmental Policy 2024-2025`).
  const POLICY_VEHICLE_TEST = /\b(policy|framework|standards|principles|commitment|charter|guideline)s?\b/i;
  const isPolicyVehicle = (c: DiscoveryCandidate): boolean => {
    const url = (c.url || "").toLowerCase();
    const title = (c.title || "").toLowerCase();
    return POLICY_VEHICLE_TEST.test(url) || POLICY_VEHICLE_TEST.test(title);
  };

  const protectedDocs = preCapCandidates.filter(c => PROTECTED_LANES.includes((c as any).lane || ""));
  const unprotectedDocs = preCapCandidates.filter(c => !PROTECTED_LANES.includes((c as any).lane || ""));
  const sortedUnprotected = unprotectedDocs.sort((a, b) => a.priority - b.priority);
  // R5d reserved carve-out. Take up to POLICY_RESERVED_SLOTS policy-family
  // docs by priority order; the rest go into a fill-list from which we
  // consume the remaining pre-gate budget.
  const policyDocs: DiscoveryCandidate[] = [];
  const nonPolicyDocs: DiscoveryCandidate[] = [];
  for (const c of sortedUnprotected) {
    if (isPolicyVehicle(c) && policyDocs.length < POLICY_RESERVED_SLOTS) {
      policyDocs.push(c);
    } else {
      nonPolicyDocs.push(c);
    }
  }
  const remainingSlots = Math.max(0, PRE_GATE_CAP - policyDocs.length);
  const cappedUnprotected = [...policyDocs, ...nonPolicyDocs.slice(0, remainingSlots)];
  if (policyDocs.length > 0) {
    console.log(`[${companyName}] R5d: reserved ${policyDocs.length}/${POLICY_RESERVED_SLOTS} policy-family slot(s) before pre-gate cap (${remainingSlots} slots left for non-policy docs)`);
  }
  const preGateCandidates = [...protectedDocs, ...cappedUnprotected];

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

  // ── v3l RANKING (CORPUS_DRIFT_REDESIGN_V3) ──────────────────────────────────
  // Replaces the old integer tier-boost + `.sort((a,b)=>a.priority-b.priority)`
  // (which collapsed onto a coarse integer lattice and produced large tie
  // clusters → non-deterministic .slice()). The new ranker uses a deterministic
  // floating-point layered key: authorityClass ASC → fineScore DESC → urlHash ASC.
  const nativeNonLatinMarket = !!(localeProfile && /Japanese|Chinese|Korean/.test(localeProfile.lang));
  const rankOptsFor = (d: DiscoveryCandidate): ComputeOpts => ({
    companyDomain: effectiveDomain || companyDomain || null,
    topicPhrases,
    nativeNonLatinMarket,
    frameworkRegistries: (framework as any).authoritativeRegistries || undefined,
    frameworkFilingTypes: (framework as any).authoritativeFilingTypes || undefined,
    // ─── PR 1 · Change 1b: pass through issuerProfile + retrievalV2 so the
    // ranker can apply subsidiary/vintage/press-page penalties when enabled.
    issuerProfile,
    retrievalV2: opts.retrievalV2,
  });

  // §4: candidate-pool fingerprint over the FULL gated set BEFORE the cap, so
  // "different pool" (world drift) is distinguishable from "same pool, different
  // cut" (pipeline effect) in the manifest.
  const candidatePoolFingerprint = createHash("sha1")
    .update(recencyFiltered.map((d) => d.url).sort().join("\n"))
    .digest("hex");

  // §2.1: collapse near-duplicates BEFORE ranking (authority-class winner).
  const collapse = collapseNearDuplicates(recencyFiltered, rankOptsFor);
  if (collapse.collapsedGroups > 0) {
    console.log(`[${companyName}] Near-dup collapse: removed ${collapse.removed.length} docs across ${collapse.collapsedGroups} groups`);
  }

  // Caution C: best-effort, bounded HEAD size probe — ONLY on the post-collapse
  // set (never the pre-gate 180), tight timeout, 0-byte fallback. Off by default
  // via env to avoid added latency at portfolio scale unless explicitly enabled.
  const sizeByUrl = new Map<string, number | null>();
  if (process.env.DISCOVERY_SIZE_PROBE === "true") {
    await Promise.all(collapse.kept.slice(0, MAX_DOCS_RETURNED * 2).map(async (d) => {
      try {
        const r = await axios.head(d.url, { timeout: 500, maxRedirects: 2, validateStatus: () => true });
        const len = parseInt(String(r.headers["content-length"] || ""), 10);
        sizeByUrl.set(d.url, Number.isFinite(len) ? len : null);
      } catch { sizeByUrl.set(d.url, null); }
    }));
  }

  // Compute layered signals and sort with the deterministic comparator.
  const rankedKept = collapse.kept.map((doc) => {
    const signals = computeRankSignals(doc, { ...rankOptsFor(doc), sizeBytes: sizeByUrl.get(doc.url) ?? null });
    doc.rank = signals;
    return { doc, signals };
  });
  rankedKept.sort((a, b) => compareSignals(a.signals, b.signals));

  // §4: ranker diagnostics on the full ranked list (pre-cap) — the production
  // health signal for whether ranking specificity is actually working.
  const rankerDiagnostics = computeRankerDiagnostics(rankedKept);

  const finalDocs = rankedKept.slice(0, MAX_DOCS_RETURNED).map((r) => r.doc);

  // Compute coverage metric
  const coverageSignals = {
    topicSlugs: topicPhrases.map((p: string) => p.toLowerCase().replace(/\s+/g, "-")),
    requiredDocSlugs: ((framework.requiredDocTypes as string[] | null) || []).map((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
    requiredDocTypes: (framework.requiredDocTypes as string[] | null) || [],
  };
  const coverage = computeCoverageMetric(finalDocs, coverageSignals);
  console.log(`[${companyName}] Coverage: ${coverage.coverageLevel} (Tier1: ${coverage.tier1Count}, Tier2: ${coverage.tier2Count}, Tier3: ${coverage.tier3Count})`);
  console.log(`[${companyName}] Ranker: distinctTop20=${rankerDiagnostics.distinctPrioritiesInTop20} largestTie=${rankerDiagnostics.largestTieCountPreUrlHash} urlHashFrac=${rankerDiagnostics.urlhashDecisionFraction.toFixed(3)}`);
  if (coverage.missingTier1Types.length > 0) {
    console.warn(`[${companyName}] Missing mandatory sources: ${coverage.missingTier1Types.join(", ")}`);
  }

  // ── GENERALISED REQUIRED DOCUMENT RECENCY CHECK (Instructions 15+16+20) ──────
  // For each requiredDocType, verify current-period coverage. If stale-only,
  // trigger a targeted re-search. The backfill AUGMENTS (never replaces) existing
  // docs, uses deterministic candidate selection, and marks status as
  // "backfill_pending" until post-fetch validation confirms the content landed.
  const requiredDocTypes = ((framework as any).requiredDocTypes as string[] | null) || [];
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  const recencyStatus: Record<string, { status: string; bestYear: number | null; researchAttempted: boolean; backfilledUrl?: string }> = {};

  if (requiredDocTypes.length > 0) {
    for (const docType of requiredDocTypes) {
      const docTypeLower = docType.toLowerCase();
      const docTypeWords = docTypeLower.split(/\s+/).filter(w => w.length >= 3);
      // Find documents in the final corpus that match this doc type
      const matchingDocs = finalDocs.filter(d => {
        const haystack = (d.title + " " + d.url).toLowerCase();
        return docTypeWords.filter(w => haystack.includes(w)).length >= Math.min(2, docTypeWords.length);
      });
      // Detect the best (most recent) year among matching docs
      let bestYear: number | null = null;
      for (const d of matchingDocs) {
        const year = detectFilingYear(d.url, d.title);
        if (year && (bestYear === null || year > bestYear)) bestYear = year;
      }
      // User preference (2026-09-05): trigger a fresher-version search whenever the
      // best year is NOT the current year, i.e. even when the newest doc is only 1 year old.
      // Rationale: for scoring-vs-analyst-cited-evidence evaluation we want to be sure we
      // haven't missed the year's latest disclosure. The backfill AUGMENTS the corpus —
      // it never displaces older filings, so this is safe to run aggressively.
      const isCurrent = bestYear !== null && bestYear >= currentYear;
      if (isCurrent) {
        recencyStatus[docType] = { status: "current", bestYear, researchAttempted: false };
        continue;
      }
      // Not current (missing OR older than currentYear): trigger targeted re-search.
      console.log(`[${companyName}] RECENCY-CHECK: "${docType}" bestYear=${bestYear ?? "none"} < ${currentYear}, searching for fresher version`);
      recencyStatus[docType] = { status: "stale", bestYear, researchAttempted: true };
      try {
        const reSearchQueries = [
          `"${companyName}" "${docType}" ${currentYear}`,
          `"${companyName}" "${docType}" ${lastYear}`,
          `"${companyName}" ${docType} ${currentYear} filetype:pdf`,
        ];
        // Instruction 20: Collect ALL candidates from ALL queries, then sort deterministically
        const allCandidates: Array<{ normUrl: string; title: string; snippet: string; year: number }> = [];
        for (const q of reSearchQueries) {
          const results = await webSearch(q, { num: 5 });
          for (const r of results) {
            const normUrl = normaliseUrl(r.link);
            if (seenUrls.has(normUrl)) continue;
            const year = detectFilingYear(normUrl, r.title);
            if (year && year >= lastYear) {
              allCandidates.push({ normUrl, title: r.title, snippet: r.snippet, year });
            }
          }
        }
        // Instruction 20: Sort deterministically (newest year first, then URL lexicographic)
        allCandidates.sort((a, b) => (b.year - a.year) || a.normUrl.localeCompare(b.normUrl));
        if (allCandidates.length > 0) {
          const pick = allCandidates[0];
          seenUrls.add(pick.normUrl);
          const priority = calculatePriority(pick.normUrl, pick.title, companyDomain || null, framework, topicPhrases);
          // Instruction 16: AUGMENT — push alongside existing docs, never evict
          finalDocs.push({
            url: pick.normUrl,
            title: pick.title,
            snippet: pick.snippet,
            lane: "recency-backfill",
            priority,
          });
          // Instruction 15: Mark as backfill_pending (not backfilled) until post-fetch validates
          recencyStatus[docType] = { status: "backfill_pending", bestYear: pick.year, researchAttempted: true, backfilledUrl: pick.normUrl };
          console.log(`[${companyName}] RECENCY-CHECK: added backfill_pending for "${docType}" year=${pick.year} (keeping existing year=${bestYear ?? "none"} in corpus): ${pick.normUrl}`);
        }
      } catch (err: any) {
        console.warn(`[${companyName}] RECENCY-CHECK: re-search for "${docType}" failed: ${err?.message}`);
      }
    }
    const staleTypes = Object.entries(recencyStatus).filter(([, v]) => v.status === "stale").map(([k]) => k);
    if (staleTypes.length > 0) {
      console.warn(`[${companyName}] RECENCY-CHECK: still stale after re-search: ${staleTypes.join(", ")}`);
    }
  }

  // §4: final-corpus fingerprint (sorted KEPT URL set). Identical => scoring
  // should be identical. Retained as `candidateFingerprint` for back-compat.
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
      priority: d.rank ? d.rank.fineScore : d.priority,
    })),
    coverage,
    candidateFingerprint,
    candidatePoolFingerprint,
    finalCorpusFingerprint: candidateFingerprint,
    rankerDiagnostics,
    nearDupCollapsedGroups: collapse.collapsedGroups,
    capUsed: MAX_DOCS_RETURNED,
    recencyStatus: Object.keys(recencyStatus).length > 0 ? recencyStatus : undefined,
    // Instruction 46: Enhanced diagnostics
    issuerProfile: issuerProfile || undefined,
    retrievalDiagnostics: diagBuilder
      .setFilteringPipeline({
        totalCandidates: allCandidates.length,
        preGateFiltered: preGateCandidates.length,
        gateAccepted: accepted.length,
        recencyDropped: recencyDropped.length,
        finalCorpusSize: finalDocs.length,
      })
      .setDomainSearch({
        domainsSearched: allDomains,
        domainQueryCount: lane2QueryCount,
        domainResultCount: laneCounts["domain"] || 0,
        rejectedDomains: issuerProfile?.domainCandidates
          .filter(d => d.status === "rejected")
          .map(d => ({ domain: d.domain, reason: d.reason })) || [],
      })
      .build(),
    registrySearchSummary: registrySummary.registriesSearched.length > 0 ? registrySummary : undefined,
    queryExpansionResult: queryExpansionResult || undefined,
  };

  return { documents: finalDocs, diagnostics, effectiveDomain, domainAutoDetected, issuerProfile };
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
  /** PR 1 · Change 1b: forwarded to searchCompanyDocuments on each pass. */
  retrievalV2?: boolean;
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

  // v3l: each doc already carries its layered `.rank` signals from the per-pass
  // selection in searchCompanyDocuments(). Re-sort the merged union with the SAME
  // deterministic comparator (authorityClass ASC → fineScore DESC → urlHash ASC),
  // recomputing signals defensively for any doc missing them.
  const ensembleRankOpts: ComputeOpts = {
    companyDomain: effectiveDomain || opts.companyDomain || null,
  };
  const rankedAll = allDocs.map((doc) => ({
    doc,
    signals: doc.rank ?? computeRankSignals(doc, ensembleRankOpts),
  }));
  rankedAll.sort((a, b) => compareSignals(a.signals, b.signals));
  const finalDocs = rankedAll.slice(0, MAX_DOCS_RETURNED).map((r) => r.doc);

  const ensembleRankerDiagnostics = computeRankerDiagnostics(rankedAll);
  const ensembleFinalFingerprint = createHash("sha1")
    .update(finalDocs.map((d) => d.url).sort().join("\n"))
    .digest("hex");

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
        priority: d.rank ? d.rank.fineScore : d.priority,
      })),
      candidateFingerprint: ensembleFinalFingerprint,
      finalCorpusFingerprint: ensembleFinalFingerprint,
      rankerDiagnostics: ensembleRankerDiagnostics,
      capUsed: MAX_DOCS_RETURNED,
    },
    effectiveDomain,
    domainAutoDetected,
  };
}
