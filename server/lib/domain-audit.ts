/**
 * Domain-and-ISIN audit library.
 *
 * Given a company row (name, ticker, country, current isin/domain/related),
 * this module produces proposals for corrections by triangulating four
 * signals in the following order of trust:
 *
 *   1. FMP profile-by-ticker (with the country + ADR guards from the
 *      test-drive ingest path). Yields canonical ISIN, corporate website,
 *      canonical company name, ISO 3166 country code.
 *   2. OpenFIGI mapping of the FMP-suggested ISIN. Cross-checks that the
 *      canonical name FIGI publishes for that ISIN is broadly consistent
 *      with what FMP returned. Catches the Prudential-style collision
 *      where an FMP ticker happens to point at the wrong issuer.
 *   3. Web search plurality: `"<canonical name>" annual report` on the
 *      Serper API, top-N organic results with an aggregator deny-list.
 *      Corroborates (or contradicts) the FMP-derived domain.
 *   4. Regional-variant searches for related domains. Guarded by
 *      name-token match and competitor-legal-name block.
 *
 * The module NEVER writes to companies. It emits typed proposal records
 * that a caller (the CLI script) persists to `company_domain_proposals`.
 *
 * Every proposal carries structured `sources` and a `conflictNotes` string
 * so a reviewer can see, per company, which signals agreed and which did
 * not. Confidence tiers are:
 *   - high   \u2014 FMP + search-plurality + (OpenFIGI or no ISIN in FMP)
 *              all agree, no ADR downgrade required
 *   - medium \u2014 FMP resolved cleanly but search-plurality did not
 *              corroborate, OR FMP required a country-suffix retry, OR
 *              OpenFIGI could not verify
 *   - low    \u2014 signals disagreed materially; caller should not auto-apply
 *
 * The audit is deterministic given the same inputs (Serper cache is not
 * used here \u2014 we accept per-run variance). All external calls are wrapped
 * in try/catch and produce a proposal-with-conflict rather than aborting.
 */

import axios from "axios";
import { resolveViaFmpByTicker, fmpWebsiteToDomain, type FmpProfile } from "./fmp-resolver.js";
import { resolveViaOpenFIGI, type FigiResult } from "./issuer-resolver.js";
import { validateIsin } from "./isin-validator.js";
import { classifyProvenance } from "./provenance.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface CompanyAuditInput {
  id: number;
  name: string;
  ticker: string | null;
  country: string | null;
  isin: string | null;
  domain: string | null;
  relatedDomains: string[] | null;
  isUnlisted: boolean;
}

export interface AuditSource {
  signal: "fmp" | "openfigi" | "search-plurality" | "regional-search" | "adr-guard" | "country-guard";
  evidence: Record<string, unknown>;
}

export type ProposalType = "isin" | "domain" | "related_domains";
export type Confidence = "high" | "medium" | "low";

export interface AuditProposal {
  companyId: number;
  proposalType: ProposalType;
  currentValue: unknown;
  proposedValue: unknown;
  sources: AuditSource[];
  confidence: Confidence;
  conflictNotes: string | null;
}

export interface AuditResult {
  companyId: number;
  companyName: string;
  skipped: false;
  proposals: AuditProposal[];
  trace: string[];
}

export interface AuditSkip {
  companyId: number;
  companyName: string;
  skipped: true;
  reason: string;
}

export type AuditOutcome = AuditResult | AuditSkip;

// ─── Country normalisation (mirrors framework-builder-v2 route) ─────────

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  "UNITED STATES": "US", "USA": "US", "U.S.": "US", "U.S.A.": "US",
  "UNITED KINGDOM": "GB", "UK": "GB", "GREAT BRITAIN": "GB", "ENGLAND": "GB",
  "FRANCE": "FR", "GERMANY": "DE", "SWITZERLAND": "CH", "NETHERLANDS": "NL",
  "ITALY": "IT", "SPAIN": "ES", "SWEDEN": "SE", "NORWAY": "NO", "DENMARK": "DK",
  "FINLAND": "FI", "BELGIUM": "BE", "AUSTRIA": "AT", "IRELAND": "IE",
  "PORTUGAL": "PT", "GREECE": "GR", "POLAND": "PL", "CZECH REPUBLIC": "CZ",
  "JAPAN": "JP", "CHINA": "CN", "HONG KONG": "HK", "TAIWAN": "TW",
  "SOUTH KOREA": "KR", "KOREA": "KR", "SINGAPORE": "SG", "INDIA": "IN",
  "AUSTRALIA": "AU", "NEW ZEALAND": "NZ",
  "CANADA": "CA", "MEXICO": "MX", "BRAZIL": "BR", "ARGENTINA": "AR",
  "CHILE": "CL", "COLOMBIA": "CO", "PERU": "PE",
  "SOUTH AFRICA": "ZA", "ISRAEL": "IL", "TURKEY": "TR",
  "UNITED ARAB EMIRATES": "AE", "SAUDI ARABIA": "SA",
};
export function normaliseCountry(x: string | null | undefined): string | null {
  if (!x) return null;
  const t = x.trim().toUpperCase();
  return COUNTRY_NAME_TO_ISO2[t] ?? t;
}
export function countriesLooselyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normaliseCountry(a);
  const nb = normaliseCountry(b);
  if (!na || !nb) return false;
  return na === nb;
}

// Country \u2192 preferred exchange suffixes, mirrored from framework-builder-v2.
// Kept in sync with the ingest path so audit and ingest agree on which
// listing to prefer for a given (unqualified ticker, country) pair.
const COUNTRY_TO_SUFFIXES: Record<string, string[]> = {
  "United Kingdom": [".L"], "UK": [".L"], "GB": [".L"],
  "France": [".PA"], "FR": [".PA"],
  "Germany": [".DE"], "DE": [".DE"],
  "Switzerland": [".SW"], "CH": [".SW"],
  "Japan": [".T"], "JP": [".T"],
  "Hong Kong": [".HK"], "HK": [".HK"],
  "Australia": [".AX"], "AU": [".AX"],
  "Canada": [".TO"], "CA": [".TO"],
  "South Korea": [".KS"], "KR": [".KS"],
  "Brazil": [".SA"], "BR": [".SA"],
  "Netherlands": [".AS"], "NL": [".AS"],
  "Italy": [".MI"], "IT": [".MI"],
  "Spain": [".MC"], "ES": [".MC"],
  "Sweden": [".ST"], "SE": [".ST"],
  "India": [".NS", ".BO"], "IN": [".NS", ".BO"],
};

// ─── Domain helpers ─────────────────────────────────────────────────────

const AGGREGATOR_DENY_LIST = new Set([
  // News / market data / social
  "bloomberg.com", "reuters.com", "ft.com", "cnbc.com", "wsj.com", "marketwatch.com",
  "finance.yahoo.com", "yahoo.com", "google.com", "linkedin.com", "twitter.com", "x.com",
  "facebook.com", "youtube.com", "wikipedia.org", "reddit.com", "medium.com",
  // Investment aggregators
  "stockanalysis.com", "seekingalpha.com", "morningstar.com", "fool.com",
  "investing.com", "stocktwits.com", "finbox.com", "simplywall.st", "gurufocus.com",
  "zacks.com", "tipranks.com", "moomoo.com", "stocktitan.net", "alphaspread.com",
  "wallstreetzen.com", "stockstory.org", "trefis.com", "quiverquant.com",
  // Aggregator report hosts
  "annualreports.com", "publicnow.com", "scribd.com",
  // Regulators (identity-checked separately by provenance classifier)
  "sec.gov", "sedarplus.ca", "sedar.com", "modernslaveryregister.gov.au",
  "gov.uk", "gov.au", "canada.ca", "europa.eu",
]);

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function registrableRoot(host: string): string {
  // Cheap public-suffix approximation: strip subdomain(s) but preserve
  // multi-part TLDs like .co.uk, .com.br, .co.jp, .com.au, .com.hk, .com.sg.
  const parts = host.split(".");
  const MULTI = new Set(["co.uk", "com.br", "co.jp", "com.au", "com.hk", "com.sg", "co.in", "com.cn", "co.kr", "com.mx", "co.za"]);
  const tail2 = parts.slice(-2).join(".");
  const tail3 = parts.slice(-3).join(".");
  if (parts.length >= 3 && MULTI.has(tail2)) return tail3;
  if (parts.length >= 2) return tail2;
  return host;
}

/**
 * Extract distinctive lowercase tokens from a company name, dropping legal
 * suffixes. NFD-normalises and strips combining diacritic marks so that
 * "Nestl\u00e9" and "NESTLE" produce the same tokens — without this, the
 * OpenFIGI cross-check would report a false disagreement for every accented
 * European issuer.
 */
export function nameTokens(name: string): string[] {
  const STOP = new Set([
    "inc", "inc.", "corp", "corp.", "corporation", "company", "co", "co.", "ltd", "ltd.",
    "limited", "plc", "sa", "s.a.", "n.v.", "nv", "ag", "ab", "asa", "spa", "s.p.a.", "sarl",
    "holdings", "holding", "group", "the", "and", "&", "of", "de", "la", "el", "gmbh", "kg",
    "s\u00e0.r.l", "s.\u00e0.r.l.", "kgaa", "srl", "s.r.l.", "co.,", "ltd.,", "corp.,",
    // Cross-lingual issuer-form terms so we don't split identity on suffixes
    // like "Nestle SA-REG" vs "Nestle S.A.", or "...aktiengesellschaft".
    "reg", "regd", "regd.", "registered", "aktiengesellschaft",
  ]);
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOP.has(t));
}

// ─── FMP resolution stage (ticker collision + ADR guards) ───────────────

export interface FmpResolutionOutcome {
  fmp: FmpProfile | null;
  symbolUsed: string | null;
  derivedDomain: string | null;
  trace: string[];
  guardHit: null | "country-mismatch" | "adr-skip" | "no-ticker" | "no-hit";
}

/**
 * Run the same FMP-by-ticker resolution the test-drive ingest path uses,
 * so the audit and ingest agree on what FMP would produce. Returns the
 * accepted profile (if any) plus a trace of every candidate attempted.
 */
export async function resolveFmpForAudit(
  ticker: string | null,
  country: string | null,
): Promise<FmpResolutionOutcome> {
  const trace: string[] = [];
  if (!ticker || !ticker.trim()) {
    return { fmp: null, symbolUsed: null, derivedDomain: null, trace: ["no ticker"], guardHit: "no-ticker" };
  }

  const first = ticker.trim().toUpperCase();
  const attempts: string[] = [first];
  const seen = new Set(attempts);
  const isUnqualified = !first.includes(".");
  if (isUnqualified && country) {
    const suffixes = COUNTRY_TO_SUFFIXES[country] ?? [];
    for (const suf of suffixes) {
      const q = `${first}${suf}`;
      if (!seen.has(q)) { attempts.unshift(q); seen.add(q); }
    }
  }

  let lastGuard: FmpResolutionOutcome["guardHit"] = null;
  for (let i = 0; i < attempts.length; i++) {
    const s = attempts[i];
    try {
      const fmp = await resolveViaFmpByTicker(s);
      if (!fmp) { trace.push(`${s} => null`); lastGuard = "no-hit"; continue; }
      if (country && fmp.country && !countriesLooselyMatch(country, fmp.country)) {
        trace.push(`${s} => country-mismatch (fmp=${fmp.country}, expected=${country})`);
        lastGuard = "country-mismatch";
        continue;
      }
      const isAdr = !!fmp.isin
        && /^US/i.test(fmp.isin)
        && !!country
        && normaliseCountry(country) !== "US";
      const hasMore = i < attempts.length - 1;
      if (isAdr && hasMore) {
        trace.push(`${s} => ADR-skip (isin=${fmp.isin}, country hint=${country})`);
        lastGuard = "adr-skip";
        continue;
      }
      trace.push(`${s} => OK (${fmp.companyName}, ${fmp.country}, isin=${fmp.isin})`);
      const derivedHost = fmpWebsiteToDomain(fmp.website);
      const derivedDomain = derivedHost ? registrableRoot(derivedHost) : null;
      return { fmp, symbolUsed: s, derivedDomain, trace, guardHit: null };
    } catch (e: any) {
      trace.push(`${s} => ERROR ${e?.message ?? e}`);
    }
  }
  return { fmp: null, symbolUsed: null, derivedDomain: null, trace, guardHit: lastGuard ?? "no-hit" };
}

// ─── OpenFIGI verification ──────────────────────────────────────────────

export interface FigiVerification {
  figi: FigiResult | null;
  agrees: boolean;   // FIGI name is broadly consistent with FMP companyName
  notes: string | null;
}

/**
 * Given an ISIN suggested by FMP and the company name FMP returned, ask
 * OpenFIGI what canonical name it publishes for that ISIN and check
 * whether the two names share at least one distinctive token.
 */
export async function verifyIsinViaFigi(
  isin: string | null,
  fmpCompanyName: string | null,
): Promise<FigiVerification> {
  if (!isin) return { figi: null, agrees: false, notes: "no ISIN to verify" };
  const v = validateIsin(isin);
  if (!v.valid) return { figi: null, agrees: false, notes: `FMP ISIN failed validation: ${v.reason}` };
  try {
    const figi = await resolveViaOpenFIGI(v.canonical!);
    if (!figi.name) return { figi, agrees: false, notes: "OpenFIGI returned no name for this ISIN" };
    if (!fmpCompanyName) return { figi, agrees: true, notes: "OpenFIGI name available; FMP name absent \u2014 not compared" };
    const fmpTok = new Set(nameTokens(fmpCompanyName));
    const figiTok = new Set(nameTokens(figi.name));
    const overlap = [...fmpTok].filter(t => figiTok.has(t));
    if (overlap.length === 0) {
      return {
        figi,
        agrees: false,
        notes: `OpenFIGI name "${figi.name}" shares no distinctive token with FMP name "${fmpCompanyName}"`,
      };
    }
    return { figi, agrees: true, notes: `OpenFIGI: "${figi.name}" (overlap: ${overlap.join(", ")})` };
  } catch (e: any) {
    return { figi: null, agrees: false, notes: `OpenFIGI error: ${e?.message ?? e}` };
  }
}

// ─── Web-search plurality ───────────────────────────────────────────────

export interface SearchPluralityResult {
  topHost: string | null;
  topHostCount: number;
  totalNonAggregatorHits: number;
  hostCounts: Array<[string, number]>;
  rawHits: Array<{ host: string; url: string; title: string }>;
  error: string | null;
}

interface SerperOrganic { title?: string; link?: string; snippet?: string }

/**
 * Query `"<name>" annual report OR investor relations` on Serper. Take top
 * 10 organic hits, strip aggregators via AGGREGATOR_DENY_LIST, count by
 * registrable-root host, return the top host with a tie-break by first
 * appearance. Returns null topHost when no non-aggregator hits remained.
 */
export async function searchPlurality(canonicalName: string): Promise<SearchPluralityResult> {
  const apiKey = process.env.SERPER_API_KEY || "";
  if (!apiKey) {
    return {
      topHost: null, topHostCount: 0, totalNonAggregatorHits: 0, hostCounts: [], rawHits: [],
      error: "SERPER_API_KEY not configured \u2014 search-plurality signal unavailable",
    };
  }
  try {
    const q = `"${canonicalName}" annual report OR investor relations`;
    const resp = await axios.post(
      "https://google.serper.dev/search",
      { q, num: 10 },
      { headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" }, timeout: 15000 },
    );
    const organic: SerperOrganic[] = resp.data?.organic || [];
    const rawHits: SearchPluralityResult["rawHits"] = [];
    const counts = new Map<string, number>();
    for (const r of organic) {
      const host = hostOf(r.link || "");
      if (!host) continue;
      const root = registrableRoot(host);
      if (AGGREGATOR_DENY_LIST.has(root)) continue;
      rawHits.push({ host: root, url: r.link || "", title: r.title || "" });
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    const hostCounts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      topHost: hostCounts[0]?.[0] ?? null,
      topHostCount: hostCounts[0]?.[1] ?? 0,
      totalNonAggregatorHits: rawHits.length,
      hostCounts,
      rawHits,
      error: null,
    };
  } catch (e: any) {
    return {
      topHost: null, topHostCount: 0, totalNonAggregatorHits: 0, hostCounts: [], rawHits: [],
      error: `Serper error: ${e?.message ?? e}`,
    };
  }
}

// ─── Regional related-domain search (guarded) ───────────────────────────

/**
 * For a confirmed listed company with an accepted primary domain, look for
 * regional issuer sites via `"<name> <region>"` queries. The guard is
 * strict: candidate hosts MUST share at least one distinctive name token
 * (blocks aggregators like publicnow.com) AND MUST NOT be the primary
 * domain of a competitor (deferred to a separate competitor-name check
 * caller can bolt on \u2014 the audit script does the token guard here).
 */
export async function proposeRelatedDomains(
  canonicalName: string,
  primaryDomain: string,
  regionsToProbe: string[],
): Promise<{ candidates: string[]; error: string | null; hitsByRegion: Record<string, string[]> }> {
  const apiKey = process.env.SERPER_API_KEY || "";
  if (!apiKey) return { candidates: [], hitsByRegion: {}, error: "SERPER_API_KEY missing" };
  const tokens = new Set(nameTokens(canonicalName));
  if (tokens.size === 0) return { candidates: [], hitsByRegion: {}, error: "no distinctive tokens in name" };
  const primaryRoot = registrableRoot(primaryDomain.replace(/^www\./, ""));
  const candidatesByRegion: Record<string, string[]> = {};
  const acceptedSet = new Set<string>();
  for (const region of regionsToProbe) {
    const q = `"${canonicalName}" ${region} annual report OR investor relations`;
    try {
      const resp = await axios.post(
        "https://google.serper.dev/search",
        { q, num: 10 },
        { headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" }, timeout: 15000 },
      );
      const organic: SerperOrganic[] = resp.data?.organic || [];
      const perRegion: string[] = [];
      for (const r of organic) {
        const host = hostOf(r.link || "");
        if (!host) continue;
        const root = registrableRoot(host);
        if (root === primaryRoot) continue;                  // already covered
        if (AGGREGATOR_DENY_LIST.has(root)) continue;
        const rootTokens = new Set(root.replace(/[.\-]/g, " ").split(" ").filter(Boolean));
        const overlap = [...tokens].some(t => rootTokens.has(t) || root.includes(t));
        if (!overlap) continue;
        perRegion.push(root);
        acceptedSet.add(root);
      }
      candidatesByRegion[region] = [...new Set(perRegion)];
    } catch {
      candidatesByRegion[region] = [];
    }
  }
  return { candidates: [...acceptedSet].sort(), hitsByRegion: candidatesByRegion, error: null };
}

// ─── U17 impact simulator ───────────────────────────────────────────────

export interface DocumentRow {
  id: number;
  url: string;
  title: string | null;
  sourceType: "first_party" | "third_party" | null;
}

/**
 * Given a company's documents and a proposed (domain, relatedDomains) pair,
 * return the count of currently-third_party docs that would flip to
 * first_party under classifyProvenance() with the proposed values. Used
 * as the `u17_impact_docs_flipped` field on domain proposals so a reviewer
 * can prioritise proposals with the largest recall lift.
 *
 * We only count flips in the third_party \u2192 first_party direction; a
 * proposal that would DEMOTE first_party documents to third_party is
 * flagged separately by the caller and requires manual review.
 */
export function computeU17Impact(
  docs: DocumentRow[],
  proposed: { domain: string | null; relatedDomains: string[]; ticker: string | null; isin: string | null; name: string; aliases: string[] },
): { flippedToFirst: number; demotedToThird: number } {
  let flippedToFirst = 0;
  let demotedToThird = 0;
  for (const d of docs) {
    const result = classifyProvenance({
      url: d.url,
      title: d.title,
      content: null,
      companyDomain: proposed.domain,
      relatedDomains: proposed.relatedDomains,
      companyName: proposed.name,
      companyTicker: proposed.ticker,
      companyAliases: proposed.aliases,
    });
    const proposedType = result.provenance === "issuer" ? "first_party" : "third_party";
    if (d.sourceType === "third_party" && proposedType === "first_party") flippedToFirst += 1;
    else if (d.sourceType === "first_party" && proposedType === "third_party") demotedToThird += 1;
  }
  return { flippedToFirst, demotedToThird };
}
