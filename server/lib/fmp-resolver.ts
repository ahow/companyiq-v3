/**
 * I55: FMP-based issuer resolution (authoritative website + rich metadata).
 *
 * Chains ISIN → symbol via FMP search-ISIN → profile-symbol → website.
 * Solves the acronym-collision failure mode that I52/I53/I54 could not
 * distinguish, because FMP publishes the canonical corporate website
 * directly (SMFG -> smfg.co.jp, MUFG -> mufg.jp, CCB -> ccb.com).
 *
 * NOT company/topic/jurisdiction specific — the same call flow applies
 * uniformly to every issuer with an ISIN.
 *
 * Rate limits: FMP paid plans allow >=250 req/min. This module is called
 * once per company per pipeline-version bump, so rate limits are not a
 * practical concern for the 22-bank fleet.
 */

import axios from "axios";

// /stable/ is the current-tier endpoint set. /api/v3 is legacy and returns
// 'Legacy Endpoint' errors for accounts subscribed after August 31, 2025.
const FMP_BASE = "https://financialmodelingprep.com/stable";

/** Retrieved corporate profile fields. Any field may be null when FMP has no data. */
export interface FmpProfile {
  symbol: string | null;
  companyName: string | null;
  website: string | null;
  description: string | null;
  ceo: string | null;
  industry: string | null;
  sector: string | null;
  country: string | null; // 2-letter ISO code
  exchange: string | null;
  exchangeFullName: string | null;
  cik: string | null;
  isin: string | null;
  cusip: string | null;
}

export function getFmpKey(): string | null {
  const k = process.env.FMP_API_KEY || process.env.FMP_TOKEN || "";
  return k ? k : null;
}

/** Base URL for the FMP /stable endpoint set — exported for sibling modules. */
export const FMP_STABLE_BASE = FMP_BASE;

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;

export async function fmpGet(url: string, params: Record<string, unknown>): Promise<any> {
  const key = getFmpKey();
  if (!key) throw new Error("FMP_API_KEY not configured");
  const p: Record<string, unknown> = { ...params, apikey: key };
  let lastErr: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.get(url, { params: p, timeout: REQUEST_TIMEOUT_MS });
      return r.data;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_RETRIES) break;
      const backoff = 1500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Rank a set of ISIN-search matches to pick the primary listing.
 * Preference order (higher = better):
 *   1) Home-exchange listing (native currency, native country) — highest
 *      market cap is a good proxy since ADR / OTC / grey-market listings
 *      typically have far smaller reported cap.
 *   2) Non-ADR fallback if only ADR entries exist.
 *
 * Deterministic: ties broken by symbol string sort so the same call
 * returns the same primary every time.
 */
function pickPrimaryFmpMatch(matches: Array<{ symbol?: string; name?: string; marketCap?: number; exchange?: string }>): string | null {
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => {
    const mcA = typeof a.marketCap === "number" ? a.marketCap : 0;
    const mcB = typeof b.marketCap === "number" ? b.marketCap : 0;
    if (mcB !== mcA) return mcB - mcA;
    return (a.symbol || "").localeCompare(b.symbol || "");
  });
  return sorted[0]?.symbol ?? null;
}

/**
 * Resolve an issuer via FMP starting from ISIN.
 * Returns the picked-primary profile, or null when FMP has no match.
 * Network / auth errors bubble up as thrown exceptions so the caller can
 * decide to fall back.
 */
export async function resolveViaFmp(isin: string): Promise<FmpProfile | null> {
  const key = getFmpKey();
  if (!key) return null;
  if (!isin || !isin.trim()) return null;

  // Step 1: search-ISIN — map ISIN to one or more listing symbols
  const searchResp = await fmpGet(`${FMP_BASE}/search-isin`, { isin: isin.trim().toUpperCase() });
  const matches = Array.isArray(searchResp) ? searchResp : [];
  const primarySymbol = pickPrimaryFmpMatch(matches);
  if (!primarySymbol) return null;

  // Step 2: profile — full company profile including website (accepts ?symbol=)
  const profileResp = await fmpGet(`${FMP_BASE}/profile`, { symbol: primarySymbol });
  const arr = Array.isArray(profileResp) ? profileResp : [];
  if (arr.length === 0) return null;
  const p = arr[0] || {};

  return {
    symbol: p.symbol ?? primarySymbol,
    companyName: p.companyName ?? null,
    website: p.website ?? null,
    description: p.description ?? null,
    ceo: p.ceo ?? null,
    industry: p.industry ?? null,
    sector: p.sector ?? null,
    country: p.country ?? null,
    exchange: p.exchange ?? null,
    exchangeFullName: p.exchangeFullName ?? null,
    cik: p.cik ? String(p.cik) : null,
    isin: p.isin ?? null,
    cusip: p.cusip ?? null,
  };
}

/** Normalise an FMP website URL into a registrable root domain. */
export function fmpWebsiteToDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const withScheme = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    const u = new URL(withScheme);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    // Rely on caller's normaliseToRegistrableDomain if further trimming is needed.
    return host || null;
  } catch {
    return null;
  }
}

// ─── FMP anchor derivation (durable provenance fix, §4.1) ────────────────────
//
// 3M (and the whole cohort) can carry a resolved fmp_symbol / fmp_website while
// the native domain / ticker / related_domains columns that classifyProvenance()
// Rule 1 reads are blank. This leaves the deterministic host-match unable to fire,
// so the issuer's own filings fall through to third_party and are dropped from the
// eligible-evidence pack. deriveFmpAnchors() computes the anchor values to write
// (or fall back on at classify time) from the already-resolved FMP identity.
//
// Guarantees (never overwrite a native non-blank value, never touch *_manual):
//   • domain:          set from the registrable domain of fmp_website ONLY when
//                      the native domain is blank.
//   • ticker:          set from fmp_symbol ONLY when the native ticker is blank.
//   • relatedDomains:  add the fmp registrable domain if it is not already
//                      present (additive union; manual overrides are untouched).

// Two-part country-code TLD suffixes where the registrable domain is the last
// THREE labels (e.g. 3m.co.uk -> 3m.co.uk). Small closed list; mirrors the one
// used by the provenance classifier.
const FMP_TWO_PART_CC_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "co.kr",
  "com.au", "net.au", "org.au", "com.br", "com.cn", "com.hk", "com.sg",
  "com.mx", "co.in", "co.za", "co.nz", "com.tr", "com.tw", "com.my",
]);

/** Reduce a hostname to its registrable domain (eTLD+1, cc-TLD aware). */
export function registrableDomain(host: string | null | undefined): string | null {
  const clean = (host || "").replace(/^www\./i, "").toLowerCase().trim();
  if (!clean) return null;
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".") || null;
  const lastTwo = parts.slice(-2).join(".");
  if (FMP_TWO_PART_CC_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export interface FmpAnchorInput {
  nativeDomain?: string | null;
  nativeTicker?: string | null;
  relatedDomains?: string[] | null;
  fmpWebsite?: string | null;
  fmpSymbol?: string | null;
}

export interface FmpAnchorResult {
  /** Present only when the native domain was blank and FMP yielded one. */
  domain?: string;
  /** Present only when the native ticker was blank and FMP yielded one. */
  ticker?: string;
  /** Present only when the fmp registrable domain was not already in related_domains. */
  relatedDomains?: string[];
  /** True when any of domain/ticker/relatedDomains would change. */
  changed: boolean;
}

function isBlank(v: string | null | undefined): boolean {
  return !v || !String(v).trim();
}

/**
 * Compute the provenance anchors to write (or fall back on) from an issuer's
 * already-resolved FMP identity. Pure: no I/O, no mutation of inputs.
 */
export function deriveFmpAnchors(input: FmpAnchorInput): FmpAnchorResult {
  const result: FmpAnchorResult = { changed: false };

  const fmpHost = fmpWebsiteToDomain(input.fmpWebsite ?? null); // strips scheme/www
  const fmpRegistrable = registrableDomain(fmpHost);

  // domain: only when native is blank.
  if (isBlank(input.nativeDomain) && fmpRegistrable) {
    result.domain = fmpRegistrable;
    result.changed = true;
  }

  // ticker: only when native is blank.
  if (isBlank(input.nativeTicker) && !isBlank(input.fmpSymbol)) {
    result.ticker = String(input.fmpSymbol).trim();
    result.changed = true;
  }

  // related_domains: additive union of the fmp registrable domain.
  if (fmpRegistrable) {
    const existing = (input.relatedDomains || [])
      .map((d) => registrableDomain(d) || (d || "").replace(/^www\./i, "").toLowerCase().trim())
      .filter(Boolean);
    const already = existing.includes(fmpRegistrable);
    if (!already) {
      const merged = [...(input.relatedDomains || []).filter(Boolean), fmpRegistrable];
      result.relatedDomains = merged;
      result.changed = true;
    }
  }

  return result;
}
