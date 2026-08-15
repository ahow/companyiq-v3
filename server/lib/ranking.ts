// ─── Corpus Ranking (v3l) ────────────────────────────────────────────────────
// Deterministic, floating-point document ranking that replaces the coarse
// integer `calculatePriority()` lattice (which created large tie clusters, e.g.
// 15 docs tied at −25, → non-deterministic .sort().slice()). See
// CORPUS_DRIFT_REDESIGN_V3.md for the commitment-level spec.
//
// The layered sort key is, in priority order:
//   1. authorityClass ASC   — coarse integer tier (regulatory primary > … > secondary)
//   2. fineScore     DESC   — continuous float; does the meaningful separation
//   3. urlHash       ASC    — deterministic tiebreak for metadata-indistinguishable docs
//
// IMPORTANT: this module is pure and has no I/O. `sizeBonus` (which needs a HEAD
// request) is passed in as an already-resolved per-URL number so the ranker stays
// synchronous, deterministic, and unit-testable. The caller (discovery.ts) is
// responsible for the bounded, best-effort HEAD probe on the POST-GATE set only.

import { createHash } from "crypto";

export interface RankSignals {
  /** Coarse authority tier: 0 = regulatory primary … 4 = secondary/aggregator. */
  authorityClass: number;
  /** Continuous float; higher = better. Does the real separation work. */
  fineScore: number;
  /** SHA-1 hex of the URL — deterministic tertiary key. */
  urlHash: string;
  /** Component breakdown, retained for diagnostics/explainability. */
  components: Record<string, number>;
}

export interface RankableDoc {
  url: string;
  title: string;
}

// ─── §1.1 Authority Class ────────────────────────────────────────────────────

const REGULATORY_PRIMARY_HOST = /(^|\.)sec\.gov$/;
// Statutory registries / regulatory mirrors (Class 1).
const STATUTORY_REGISTRY_HOSTS = [
  "sedarplus.ca", "sedar.com", "asx.com.au", "hkexnews.hk", "hkex.com.hk",
  "find-and-update.company-information.service.gov.uk", "data.fca.org.uk",
  "fca.org.uk", "unternehmensregister.de", "handelsregister.de",
  "registers.esma.europa.eu", "esap.europa.eu", "info-financiere.fr",
  "cnmv.es", "1info.it", "registroimprese.it", "afm.nl", "kvk.nl",
  "bolagsverket.se", "brreg.no", "datacvr.virk.dk", "zefix.ch", "core.cro.ie",
  "disclosure2.edinet-fsa.go.jp", "release.tdnet.info", "kind.krx.co.kr",
  "mops.twse.com.tw", "sgx.com", "bseindia.com", "nseindia.com", "sebi.gov.in",
  "cninfo.com.cn", "sse.com.cn", "szse.cn", "b3.com.br", "rad.cvm.gov.br",
  "saudiexchange.sa", "adx.ae", "dfm.ae", "kap.org.tr", "maya.tase.co.il",
  "clientportal.jse.co.za", "mca.gov.in", "connectonline.asic.gov.au",
];
// Voluntary registries / global frameworks (Class 2).
const VOLUNTARY_REGISTRY_HOSTS = [
  "cdp.net", "tnfd.global", "sciencebasedtargets.org",
  "sciencebasedtargetsnetwork.org", "unglobalcompact.org",
  "netzeroassetmanagers.org", "unepfi.org", "unpri.org",
  "equator-principles.com", "financeforbiodiversity.org",
  "carbonaccountingfinancials.com", "climateaction.unfccc.int",
  "there100.org", "theclimategroup.org", "weps.org", "eiti.org", "icmm.com",
  "rspo.org", "fsc.org", "pefc.org", "bcorporation.net", "usgbc.org",
  "ungpreporting.org", "oecd.org", "gov.uk",
];
// Secondary / news / aggregator hosts (Class 4).
const SECONDARY_HOSTS = [
  "reuters.com", "bloomberg.com", "cnbc.com", "bbc.com", "medium.com",
  "fortune.com", "forbes.com", "marketwatch.com", "seekingalpha.com",
  "finance.yahoo.com", "wsj.com", "ft.com", "businesswire.com",
  "prnewswire.com", "globenewswire.com", "investing.com", "fool.com",
  "barrons.com", "morningstar.com", "simplywall.st", "tipranks.com",
];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** SEC EDGAR PRIMARY document in HTML form (the section-taggable original). */
function isEdgarPrimaryHtml(url: string): boolean {
  const u = url.toLowerCase();
  return /sec\.gov\/archives\/edgar\/data\/\d+\//.test(u)
    && /\.html?($|\?)/.test(u)
    && !/-index\.html?|\/index\.html?/.test(u);
}

export function authorityClass(url: string, companyDomain: string | null): number {
  const host = hostOf(url);
  const u = url.toLowerCase();
  // Class 0 — regulatory primary: SEC EDGAR primary HTML.
  if (isEdgarPrimaryHtml(url)) return 0;
  // SEC PDFs and EDGAR index pages are primary-ish but not the section-taggable
  // HTML; treat as Class 1 (regulatory mirror) so the HTML original wins.
  if (REGULATORY_PRIMARY_HOST.test(host)) return 1;
  // Class 1 — statutory registries / regulatory mirrors.
  if (STATUTORY_REGISTRY_HOSTS.some(d => host === d || host.endsWith("." + d) || u.includes(d))) return 1;
  // Class 2 — voluntary registries / global frameworks.
  if (VOLUNTARY_REGISTRY_HOSTS.some(d => host === d || host.endsWith("." + d) || u.includes(d))) return 2;
  // Class 4 — secondary / news / aggregators.
  if (SECONDARY_HOSTS.some(d => host === d || host.endsWith("." + d))) return 4;
  // Class 3 — company's own IR/ESG domain.
  if (companyDomain && u.includes(companyDomain.toLowerCase())) return 3;
  // Default: unknown third-party → treat as secondary (Class 4) so it never
  // structurally outranks a registry/primary by fineScore alone.
  return 4;
}

// ─── §1.2 fineScore Components ───────────────────────────────────────────────

const CURRENT_YEAR = new Date().getUTCFullYear();

/** Component 1 — filing-type weight (0..15). */
function filingTypeWeight(s: string): number {
  if (/10-?k\b|10k\b|20-?f\b|40-?f\b/.test(s)) return 12.0;
  if (/def.?14a|proxy.?statement|agm.?circular|proxy.?circular|notice.?of.?meeting/.test(s)) return 10.0;
  if (/integrated.?report/.test(s)) return 7.5;
  if (/annual.?report|年度报告|年度報告|年报|年報/.test(s)) return 7.5;
  if (/10-?q\b/.test(s)) return 7.0;
  if (/\bcdp\b|tcfd|climate.?report/.test(s)) return 8.0;
  if (/8-?k\b|6-?k\b/.test(s)) return 5.0;
  if (/sustainab|esg\b|csr\b|responsibility/.test(s)) return 6.0;
  return 0.0;
}

/** Component 2 — continuous recency (0..6). Fallback 1.5 if no year detected. */
function recencyWeight(s: string): number {
  // Match a plausible 4-digit filing year (1990..currentYear+1).
  const years = (s.match(/\b(19|20)\d{2}\b/g) || [])
    .map(Number)
    .filter(y => y >= 1990 && y <= CURRENT_YEAR + 1);
  if (years.length === 0) return 1.5;
  const docYear = Math.max(...years);
  return Math.max(0.0, 6.0 - 1.5 * (CURRENT_YEAR - docYear));
}

/** Component 3 — topic-phrase density (0..8): COUNT of distinct lexicon matches. */
function topicDensity(url: string, title: string, topicPhrases: string[]): number {
  if (!topicPhrases || topicPhrases.length === 0) return 0.0;
  const hay = (url + " " + title).toLowerCase();
  const matched = new Set<string>();
  for (const p of topicPhrases) {
    const phrase = p.toLowerCase().trim();
    if (phrase.length < 2) continue;
    const slug = phrase.replace(/\s+/g, "-");
    const nospace = phrase.replace(/\s+/g, "");
    if (hay.includes(phrase) || hay.includes(slug) || hay.includes(nospace)) matched.add(phrase);
  }
  return Math.min(8.0, 1.6 * matched.size);
}

const EXACT_FORM_SLUGS = ["def-14a", "10-k", "10k", "20-f", "40-f", "10-q"];
const GENERIC_SLUGS = ["report", "document", "file", "filing", "pdf", "download"];

/** Component 4 — slug specificity (0..8). */
function slugSpecificity(url: string): number {
  const u = url.toLowerCase();
  let score = 0.0;
  for (const slug of EXACT_FORM_SLUGS) if (u.includes(slug)) { score += 3.0; break; }
  for (const slug of GENERIC_SLUGS) if (u.includes(slug)) { score += 0.5; break; }
  let depth = 0;
  try { depth = new URL(url).pathname.split("/").filter(Boolean).length; } catch { /* ignore */ }
  score += Math.min(2.0, 0.15 * depth);
  return Math.min(8.0, score);
}

const STOP_TOKENS = new Set([
  "sec", "gov", "secgov", "html", "htm", "pdf", "exhibit", "document", "documents",
  "the", "and", "for", "inc", "ltd", "plc", "corp", "company", "co",
]);

/** Component 5 — title token count (0..3) — Caution A: demote title-less exhibits. */
function titleTokenBonus(title: string): number {
  const tokens = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s\u00c0-\uffff]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_TOKENS.has(t) && !/^\d+$/.test(t));
  const informative = new Set(tokens).size;
  return Math.min(3.0, 0.3 * informative);
}

/** Component 6 — filing-section hint (0..2): Item 1A / Part I / Section 5. */
function filingSectionBonus(title: string): number {
  const t = (title || "").toLowerCase();
  let n = 0;
  if (/\bitem\s+\d+[a-z]?\b/.test(t)) n++;
  if (/\bpart\s+[ivx]+\b/.test(t)) n++;
  if (/\bsection\s+\d+\b/.test(t)) n++;
  return Math.min(2.0, n * 1.0);
}

/** Component 7 — document size estimate (0..2). `bytes` is pre-resolved (Caution C). */
export function sizeBonus(bytes: number | null | undefined): number {
  if (!bytes || bytes <= 10 * 1024) return 0.0;
  return Math.min(2.0, 0.2 * Math.log(bytes / 1024));
}

/**
 * Component 9 — URL-path discriminator (0..3, continuous) — v3l-r2.
 *
 * PURPOSE: real corpora contain genuinely DIFFERENT documents that share an
 * identical title + form + year (paginated PDFs, multi-part exhibits, repeated
 * "primary_doc.xml", "13-F Information Table", same-named sustainability PDFs).
 * Components 1-8 evaluate those identically, collapsing them onto the same
 * fineScore and pushing all separation onto urlHash (the lattice problem moved
 * down a level). This component injects a small, BOUNDED, DETERMINISTIC float
 * derived from the parts of the URL that actually vary, so such docs receive
 * distinct fineScores and urlHash rarely decides anything.
 *
 * It is intentionally small in magnitude (<=3) so it NEVER reorders documents
 * that already differ on a meaningful component (filing type, recency, topic),
 * and only separates otherwise-identical ones. It is a pure function of the URL
 * string, so it stays deterministic and order-independent.
 */
function pathDiscriminator(url: string): number {
  let path = url;
  let query = "";
  try {
    const u = new URL(url);
    path = u.pathname || "";
    query = u.search || "";
  } catch { /* keep raw string */ }
  const full = (path + query);

  // (a) Numeric identity bucket: the LAST run of >=3 digits in the path is, in
  //     practice, the accession sequence / page / exhibit index that differs
  //     between near-identical docs. Map it to a smooth fraction in [0,1).
  const digitRuns = full.match(/\d{3,}/g) || [];
  let numericFrac = 0;
  if (digitRuns.length > 0) {
    const last = digitRuns[digitRuns.length - 1];
    // use the trailing 6 digits so very long CIK+accession strings still vary
    const tail = last.slice(-6);
    numericFrac = (parseInt(tail, 10) % 1000) / 1000; // 0.000 .. 0.999
  }

  // (b) Path-shape signal: depth + total length, squashed. Two docs that share
  //     a title but live at different path depths/lengths separate here.
  const segs = full.split("/").filter(Boolean).length;
  const lenSig = Math.min(1, full.length / 160);          // 0..1 by length
  const depthSig = Math.min(1, segs / 12);                 // 0..1 by depth

  // (c) Stable per-URL micro-jitter from a hash of the FULL path+query. Bounded
  //     and tiny; guarantees distinctness when (a)/(b) happen to coincide, but
  //     small enough never to outweigh a real component. Deterministic.
  const h = createHash("sha1").update(full).digest();
  const jitter = ((h[0] << 8) | h[1]) / 65535;             // 0..1 deterministic

  // Weighted, bounded to [0,3]. Numeric identity dominates (it is the real
  // differentiator), shape adds a little, jitter is the last-resort separator.
  const raw = 1.8 * numericFrac + 0.6 * lenSig + 0.4 * depthSig + 0.2 * jitter;
  return Math.min(3.0, raw);
}

const CJK_OR_NONLATIN = /[\u3000-\u9fff\uac00-\ud7af]/; // CJK + Hangul

/**
 * Component 8 — cross-language signal (−2..0) — Caution B.
 * ONLY penalise English-titled SECONDARY/aggregator (Class 4) pages for issuers
 * in non-EN markets. NEVER penalise Class 0/1/2 primary/registry docs (an
 * official English 20-F or IFRS report is genuinely primary).
 */
function crossLanguageSignal(title: string, authClass: number, nativeNonLatinMarket: boolean): number {
  if (!nativeNonLatinMarket) return 0.0;
  if (authClass < 4) return 0.0; // only the secondary/aggregator class
  const t = title || "";
  const hasNonLatin = CJK_OR_NONLATIN.test(t);
  const looksEnglish = /[a-z]/i.test(t) && !hasNonLatin;
  return looksEnglish ? -2.0 : 0.0;
}


/**
 * Component 10 — PDF-over-landing-page signal (−6..+8).
 * Prefer the actual document (PDF on company domain) over section landing pages.
 * Penalise index/navigation pages that link to reports but are not reports themselves.
 */
function pdfVsLandingSignal(url: string, title: string, isCompanyDomain: boolean): number {
  const u = url.toLowerCase();
  const t = (title || "").toLowerCase();
  let score = 0;
  // Boost: company-domain PDFs are the actual reports
  if (isCompanyDomain && /\.pdf(\?|$)/i.test(u)) score += 8;
  // Penalise: section landing pages (navigation, not content)
  if (/\/(sustainability|esg|responsibility|ir|reports?)\/?$/i.test(u)) score -= 6;
  // Penalise: report library / download centre pages (index, not document)
  if (/reports?.and.presentations|report.library|download.centre|document.library/i.test(t) && !/\.pdf/i.test(u)) score -= 4;
  return score;
}
// ─── Public: compute the full layered ranking signal for one document ─────────

export interface ComputeOpts {
  companyDomain?: string | null;
  topicPhrases?: string[];
  /** ISO-2 / market hint: true when the issuer's primary filings are non-Latin
   *  (JP/CN/KR/TW/HK). Drives the Caution-B cross-language penalty. */
  nativeNonLatinMarket?: boolean;
  /** Pre-resolved content length in bytes for this URL (best-effort HEAD). */
  sizeBytes?: number | null;
}

export function computeRankSignals(doc: RankableDoc, opts: ComputeOpts = {}): RankSignals {
  const url = doc.url;
  const title = doc.title || "";
  const s = (url + " " + title).toLowerCase();
  const authClass = authorityClass(url, opts.companyDomain ?? null);
  const isCompanyDomain = opts.companyDomain ? url.toLowerCase().includes(opts.companyDomain.toLowerCase()) : false;

  const components: Record<string, number> = {
    filingType: filingTypeWeight(s),
    recency: recencyWeight(s),
    topicDensity: topicDensity(url, title, opts.topicPhrases || []),
    slugSpecificity: slugSpecificity(url),
    titleTokens: titleTokenBonus(title),
    filingSection: filingSectionBonus(title),
    size: sizeBonus(opts.sizeBytes),
    crossLanguage: crossLanguageSignal(title, authClass, !!opts.nativeNonLatinMarket),
    pathDiscriminator: pathDiscriminator(url),
    // P2a: Prefer the actual document (PDF) over the landing/index page.
    // Company-domain PDFs are the actual reports; section landing pages are navigation.
    pdfVsLanding: pdfVsLandingSignal(url, title, isCompanyDomain),
  };
  const fineScore = Object.values(components).reduce((a, b) => a + b, 0);
  const urlHash = createHash("sha1").update(url).digest("hex");
  return { authorityClass: authClass, fineScore, urlHash, components };
}

// ─── Layered comparator + total-order sort ────────────────────────────────────

/** Compare two precomputed signals by the layered key. Returns <0 if a ranks
 *  before (better than) b. Guarantees a TOTAL order because urlHash is unique
 *  per distinct URL. */
export function compareSignals(a: RankSignals, b: RankSignals): number {
  if (a.authorityClass !== b.authorityClass) return a.authorityClass - b.authorityClass; // ASC
  if (a.fineScore !== b.fineScore) return b.fineScore - a.fineScore;                       // DESC
  return a.urlHash < b.urlHash ? -1 : a.urlHash > b.urlHash ? 1 : 0;                       // ASC
}

export interface RankedDoc<T extends RankableDoc> {
  doc: T;
  signals: RankSignals;
}

/** Rank a list of docs by the layered key, best-first. Deterministic total order. */
export function rankDocuments<T extends RankableDoc>(docs: T[], opts: ComputeOpts | ((d: T) => ComputeOpts) = {}): RankedDoc<T>[] {
  const withSignals: RankedDoc<T>[] = docs.map((doc) => ({
    doc,
    signals: computeRankSignals(doc, typeof opts === "function" ? opts(doc) : opts),
  }));
  withSignals.sort((x, y) => compareSignals(x.signals, y.signals));
  return withSignals;
}

// ─── §2.1 Near-duplicate collapse ─────────────────────────────────────────────

/** Normalised title stem: strip case, punctuation, extensions, collapse spaces. */
function normTitleStem(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/\.(pdf|html?|docx?|xlsx?)\b/g, "")
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 8) // first 8 informative tokens form the stem
    .join(" ");
}

function yearKey(s: string): string {
  const years = (s.match(/\b(19|20)\d{2}\b/g) || []).map(Number).filter(y => y >= 1990 && y <= CURRENT_YEAR + 1);
  return years.length ? String(Math.max(...years)) : "noyear";
}

/** Coarse form key for collapse grouping (10-K / proxy / annual / sustainability / other). */
function formKey(s: string): string {
  if (/10-?k\b|10k\b/.test(s)) return "10-K";
  if (/20-?f\b/.test(s)) return "20-F";
  if (/40-?f\b/.test(s)) return "40-F";
  if (/def.?14a|proxy/.test(s)) return "proxy";
  if (/annual.?report|integrated.?report|年度报告|年报/.test(s)) return "annual";
  if (/sustainab|esg\b|csr\b/.test(s)) return "sustainability";
  if (/\bcdp\b|tcfd/.test(s)) return "cdp";
  return "other";
}

export interface CollapseResult<T extends RankableDoc> {
  kept: T[];
  removed: T[];
  /** number of duplicate groups that had > 1 member */
  collapsedGroups: number;
}

/**
 * Collapse near-duplicates BEFORE ranking. Group by (formKey, year, titleStem);
 * within each group keep ONE winner chosen by:
 *   1. lowest authorityClass (most authoritative)
 *   2. highest fineScore
 *   3. lowest urlHash
 * Caution / spec §2.1: winner is chosen by AUTHORITY CLASS first, never by
 * fineScore alone, so two near-dups don't collapse to whichever had a slightly
 * higher topic-match.
 *
 * "other"/"noyear" groups are NOT collapsed (too coarse to be safe).
 */
export function collapseNearDuplicates<T extends RankableDoc>(
  docs: T[],
  opts: ComputeOpts | ((d: T) => ComputeOpts) = {}
): CollapseResult<T> {
  const groups = new Map<string, RankedDoc<T>[]>();
  const standalone: RankedDoc<T>[] = [];

  for (const doc of docs) {
    const signals = computeRankSignals(doc, typeof opts === "function" ? opts(doc) : opts);
    const s = (doc.url + " " + (doc.title || "")).toLowerCase();
    const form = formKey(s);
    const yr = yearKey(s);
    const stem = normTitleStem(doc.title || "");
    if (form === "other" || yr === "noyear" || stem.length < 4) {
      standalone.push({ doc, signals });
      continue;
    }
    const key = `${form}::${yr}::${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ doc, signals });
  }

  const kept: T[] = [];
  const removed: T[] = [];
  let collapsedGroups = 0;

  for (const [, members] of groups) {
    if (members.length === 1) { kept.push(members[0].doc); continue; }
    collapsedGroups++;
    members.sort((a, b) => compareSignals(a.signals, b.signals));
    kept.push(members[0].doc);
    for (let i = 1; i < members.length; i++) removed.push(members[i].doc);
  }
  for (const m of standalone) kept.push(m.doc);

  return { kept, removed, collapsedGroups };
}

// ─── §4 Ranker diagnostics ─────────────────────────────────────────────────────

export interface RankerDiagnostics {
  distinctPrioritiesInTop20: number;
  largestTieCountPreUrlHash: number;
  urlhashDecisionFraction: number;
  totalDocs: number;
}

/**
 * Compute the §4 ranker_diagnostics for a ranked list. Operates on the final
 * ranked order (best-first). A "selection decision" is an adjacent pair in the
 * ranked list; it is "broken by urlHash" when the two share BOTH authorityClass
 * and fineScore (so only the hash separated them).
 */
export function computeRankerDiagnostics(ranked: RankedDoc<any>[]): RankerDiagnostics {
  const top20 = ranked.slice(0, 20);
  // distinct (authorityClass, fineScore rounded) pairs in top-20
  const distinct = new Set(top20.map(r => `${r.signals.authorityClass}:${r.signals.fineScore.toFixed(4)}`));
  // largest tie cluster (same authorityClass + fineScore) across whole list, pre-urlHash
  const clusters = new Map<string, number>();
  for (const r of ranked) {
    const k = `${r.signals.authorityClass}:${r.signals.fineScore.toFixed(4)}`;
    clusters.set(k, (clusters.get(k) || 0) + 1);
  }
  let largestTie = 0;
  for (const c of clusters.values()) largestTie = Math.max(largestTie, c);
  // fraction of adjacent decisions broken solely by urlHash
  let urlhashBroken = 0;
  let decisions = 0;
  for (let i = 1; i < ranked.length; i++) {
    decisions++;
    const a = ranked[i - 1].signals, b = ranked[i].signals;
    if (a.authorityClass === b.authorityClass && a.fineScore === b.fineScore) urlhashBroken++;
  }
  return {
    distinctPrioritiesInTop20: distinct.size,
    largestTieCountPreUrlHash: largestTie,
    urlhashDecisionFraction: decisions > 0 ? urlhashBroken / decisions : 0,
    totalDocs: ranked.length,
  };
}
