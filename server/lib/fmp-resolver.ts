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

function getFmpKey(): string | null {
  const k = process.env.FMP_API_KEY || process.env.FMP_TOKEN || "";
  return k ? k : null;
}

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;

async function fmpGet(url: string, params: Record<string, unknown>): Promise<any> {
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
 * Shape the /stable/profile response into our internal FmpProfile.
 * Extracted so both ISIN-first and ticker-first resolvers share one mapper.
 */
function profileFromApiRow(p: any, fallbackSymbol: string | null): FmpProfile {
  return {
    symbol: p?.symbol ?? fallbackSymbol,
    companyName: p?.companyName ?? null,
    website: p?.website ?? null,
    description: p?.description ?? null,
    ceo: p?.ceo ?? null,
    industry: p?.industry ?? null,
    sector: p?.sector ?? null,
    country: p?.country ?? null,
    exchange: p?.exchange ?? null,
    exchangeFullName: p?.exchangeFullName ?? null,
    cik: p?.cik ? String(p.cik) : null,
    isin: p?.isin ?? null,
    cusip: p?.cusip ?? null,
  };
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

  return profileFromApiRow(arr[0], primarySymbol);
}

/**
 * Resolve an issuer via FMP starting from a ticker/symbol.
 *
 * Used by the framework-builder test-drive ingest path, which historically
 * had no ISIN to feed `resolveViaFmp` — companies arrive with a ticker only,
 * so the ISIN → website chain never ran and downstream pipelines lost the
 * FMP + OpenFIGI benefit. This variant skips the ISIN-search step and calls
 * /stable/profile?symbol= directly. FMP returns the ISIN in the profile
 * response, so the caller can then persist it and every subsequent pipeline
 * call goes through the standard ISIN path unchanged.
 *
 * Ticker collision note: NYSE "PRU" is Prudential Financial; LSE "PRU" is
 * Prudential plc. FMP's `symbol` field is exchange-suffixed for non-US
 * listings (e.g. `HSBA.L`, `NESN.SW`), so callers should pass the
 * exchange-qualified ticker where available. When the caller only has an
 * unqualified US-style ticker, the FMP result will be the NYSE listing —
 * this is by design and matches FMP's own primary-listing convention.
 *
 * Returns null when the ticker is empty, no FMP key is configured, or the
 * profile endpoint returns no rows. Network / auth errors bubble up.
 */
export async function resolveViaFmpByTicker(ticker: string): Promise<FmpProfile | null> {
  const key = getFmpKey();
  if (!key) return null;
  if (!ticker || !ticker.trim()) return null;

  const symbol = ticker.trim().toUpperCase();
  const profileResp = await fmpGet(`${FMP_BASE}/profile`, { symbol });
  const arr = Array.isArray(profileResp) ? profileResp : [];
  if (arr.length === 0) return null;

  return profileFromApiRow(arr[0], symbol);
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
