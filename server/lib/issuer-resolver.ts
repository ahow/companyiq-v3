/**
 * 40-0: OpenFIGI-first canonical-name resolution.
 * Resolves the canonical issuer name and ticker via ISIN lookup.
 * Results are cached on the company row (figiName, figiTicker, figiResolvedAt).
 *
 * P2: Includes exponential-backoff retry (up to 3 attempts) and a simple
 * token-bucket rate limiter (20 req/min) to stay within the free tier.
 *
 * 42-A: Cache freshness is tied to PIPELINE_VERSION, not just wall-clock.
 * 42-B: Stale-domain detection runs on every call (cache hit or miss).
 */
import axios from "axios";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { PIPELINE_VERSION } from "./pipeline-version.js";

const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";
const OPENFIGI_API_KEY = process.env.OPENFIGI_API_KEY || "";

// P2: Simple token-bucket rate limiter — 20 requests per 60-second window.
// The free tier allows 25/min; we leave headroom for safety.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_TOKENS = 20;
let rateBucketTokens = RATE_LIMIT_MAX_TOKENS;
let rateBucketLastRefill = Date.now();

function consumeRateToken(): boolean {
  const now = Date.now();
  const elapsed = now - rateBucketLastRefill;
  if (elapsed >= RATE_LIMIT_WINDOW_MS) {
    rateBucketTokens = RATE_LIMIT_MAX_TOKENS;
    rateBucketLastRefill = now;
  }
  if (rateBucketTokens > 0) {
    rateBucketTokens--;
    return true;
  }
  return false;
}

async function waitForRateToken(): Promise<void> {
  while (!consumeRateToken()) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (Date.now() - rateBucketLastRefill) + 100;
    console.log(`[issuer-resolver] Rate limit reached, waiting ${Math.round(waitMs / 1000)}s`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

export interface FigiResult {
  name: string | null;
  ticker: string | null;
}

/**
 * 41-E: Pick the primary listing entry from an OpenFIGI mapping response.
 * Preference order:
 *   1. Common Stock listed on the ISIN's home exchange.
 *   2. Any Common Stock listing.
 *   3. First entry (fallback).
 *
 * The ISO 3166 → exchange code map is data, not a topic/company branch.
 */
interface FigiEntry {
  name?: string;
  ticker?: string;
  exchCode?: string;
  securityType?: string;
}

function pickPrimary(data: FigiEntry[], isin: string): FigiEntry | null {
  if (!data || data.length === 0) return null;
  const isinCountry = isin.slice(0, 2).toUpperCase();

  // ISO 3166 country → Bloomberg exchange codes for common home listings.
  const HOME_EXCH: Record<string, string[]> = {
    GB: ["LN"], US: ["UN", "UW", "UA", "UF", "US"], CA: ["CT"],
    AU: ["AT"], FR: ["FP"], DE: ["GY"], IT: ["IM"], ES: ["SM"],
    NL: ["NA"], CH: ["SW", "SE"], JP: ["JT", "JP", "JN"],
    HK: ["HK"], CN: ["CH"], SG: ["SP"], IN: ["IB", "IN"],
    KR: ["KS"], TW: ["TT"], BR: ["BZ"], MX: ["MM"], ZA: ["SJ"],
    SE: ["SS"], NO: ["NO"], DK: ["DC"], FI: ["FH"], BE: ["BB"],
    AT: ["AV"], IE: ["ID"], IL: ["IT"], TR: ["TI"], AE: ["DH", "UH"],
  };
  const home = HOME_EXCH[isinCountry] ?? [];
  const cs = data.filter(d => d.securityType === "Common Stock");
  const homeCs = cs.filter(d => home.includes(d.exchCode ?? ""));
  if (homeCs.length > 0) return homeCs[0];
  if (cs.length > 0) return cs[0];
  return data[0];
}

/**
 * Resolve canonical issuer name and ticker from ISIN via OpenFIGI.
 * Returns null fields on failure (network error, no match, etc.).
 * Never throws — all errors are caught and logged.
 *
 * P2: Retries up to 3 times with exponential backoff on transient errors
 * (429, 5xx, network timeouts). Respects the token-bucket rate limiter.
 */
export async function resolveViaOpenFIGI(isin: string): Promise<FigiResult> {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Wait for a rate-limit token before making the request
      await waitForRateToken();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (OPENFIGI_API_KEY) {
        headers["X-OPENFIGI-APIKEY"] = OPENFIGI_API_KEY;
      }

      const response = await axios.post(
        OPENFIGI_URL,
        [{ idType: "ID_ISIN", idValue: isin }],
        { headers, timeout: 10000 }
      );

      const result = response.data?.[0];
      if (!result || result.warning || !result.data || result.data.length === 0) {
        return { name: null, ticker: null };
      }

      // 41-E: Use pickPrimary to select the home-exchange listing, not data[0]
      const entry = pickPrimary(result.data, isin);
      if (!entry) return { name: null, ticker: null };
      return {
        name: entry.name || null,
        ticker: entry.ticker || null,
      };
    } catch (err: any) {
      const status = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500;

      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[issuer-resolver] OpenFIGI attempt ${attempt + 1} failed for ${isin} (status=${status || "network"}), retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.warn(`[issuer-resolver] OpenFIGI call failed for ISIN ${isin} after ${attempt + 1} attempts: ${err.message}`);
      return { name: null, ticker: null };
    }
  }

  return { name: null, ticker: null };
}

/**
 * 42-B refactor: Extract the HTTP-call-and-persist block into a helper.
 */
async function callAndPersistFigi(company: { id: number; isin?: string | null }): Promise<FigiResult> {
  if (!company.isin) return { name: null, ticker: null };

  const result = await resolveViaOpenFIGI(company.isin);

  // Persist to DB regardless of success (marks as resolved to prevent re-calls)
  // 42-A: Also persist figi_pipeline_version
  try {
    await db.execute(sql`
      UPDATE companies SET
        figi_name = ${result.name},
        figi_ticker = ${result.ticker},
        figi_resolved_at = NOW(),
        figi_pipeline_version = ${PIPELINE_VERSION}
      WHERE id = ${company.id}
    `);
  } catch (e: any) {
    console.warn(`[issuer-resolver] Failed to persist FIGI for company ${company.id}: ${e.message}`);
  }

  if (result.name) {
    console.log(`[issuer-resolver] Resolved ${company.isin} → name="${result.name}", ticker="${result.ticker}"`);
  } else {
    console.log(`[issuer-resolver] No OpenFIGI match for ISIN ${company.isin} (company ${company.id})`);
  }

  return result;
}

/**
 * Resolve and persist FIGI data for a company.
 *
 * 42-A: Cache hit requires BOTH wall-clock freshness AND pipeline-version match.
 * 42-B: Stale-domain detection runs on EVERY call (cache hit or miss), using
 *       whatever FIGI name/ticker is available.
 */
export async function resolveCompanyFIGI(company: {
  id: number;
  isin?: string | null;
  figiResolvedAt?: Date | string | null;
  figiName?: string | null;
  figiTicker?: string | null;
  figiPipelineVersion?: string | null; // 42-A
  domain?: string | null;
}): Promise<FigiResult> {
  let result: FigiResult;

  // 42-A: Cache HIT only if fresh AND same pipeline version
  if (
    company.figiResolvedAt &&
    company.figiPipelineVersion === PIPELINE_VERSION
  ) {
    const resolvedAt = new Date(company.figiResolvedAt);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (resolvedAt > thirtyDaysAgo) {
      result = {
        name: company.figiName || null,
        ticker: company.figiTicker || null,
      };
    } else {
      // Expired wall-clock — re-fetch
      result = await callAndPersistFigi(company);
    }
  } else if (company.isin) {
    // Version mismatch or never resolved — re-fetch
    result = await callAndPersistFigi(company);
  } else {
    result = { name: null, ticker: null };
  }

  // 42-B: Stale-domain check runs on EVERY call, cache hit or miss.
  // FIGI result may be from cache; that's fine — the check compares
  // FIGI name tokens against the current domain, both stable across this call.
  if (result.name && company.domain) {
    if (isDomainStale(company.domain, result)) {
      console.warn(
        `[issuer-resolver] Clearing stale domain for company ${company.id}: ` +
        `"${company.domain}" (FIGI name: "${result.name}")`
      );
      try {
        await db.execute(sql`
          UPDATE companies SET
            domain = NULL,
            related_domains = NULL,
            related_domains_pipeline_version = NULL,
            updated_at = NOW()
          WHERE id = ${company.id}
        `);
        company.domain = null;
      } catch (e: any) {
        console.warn(`[issuer-resolver] Failed to clear stale domain: ${e.message}`);
      }
    }
  }

  return result;
}

/**
 * 41-D: A company.domain is considered stale if it shares zero distinctive tokens
 * with the FIGI-resolved canonical name. This catches DB imports pointing at
 * unrelated entities (e.g. Mitsubishi UFJ → mitsubishi-hc-capital.com).
 *
 * No topic logic, no company literals. Works on token overlap alone.
 */
function isDomainStale(domain: string, figiResult: FigiResult): boolean {
  if (!figiResult.name) return false;
  const figiTokens = deriveAliases(figiResult.name, figiResult.ticker)
    .filter(a => a.length >= 3);
  if (figiTokens.length === 0) return false;
  const dl = domain.toLowerCase();
  return !figiTokens.some(t => dl.includes(t));
}

/**
 * 40-A: Derive aliases from a canonical name (or company.name fallback).
 * Returns an array of lowercase alias strings (length >= 2).
 */
export function deriveAliases(
  canonicalName: string,
  ticker: string | null
): string[] {
  const GENERIC_WORDS = new Set([
    "the", "and", "for", "of", "group", "holding", "holdings", "company", "companies",
    "corp", "corporation", "incorporated", "inc", "ltd", "limited", "llc", "plc",
    "co", "sa", "se", "ag", "nv", "spa", "oyj", "asa", "ab", "as", "bv", "kg",
    "international", "global", "worldwide", "industries", "industrial", "enterprise",
    "enterprises", "technologies", "technology", "systems", "solutions", "services",
    "products", "bank", "banking", "capital", "partners", "resources", "materials",
    "energy", "power", "motors", "financial", "pharmaceutical", "pharmaceuticals",
    "chemical", "chemicals", "insurance", "asset", "management", "trust",
    "australia", "america", "american", "national", "japan", "china", "korea",
    "hong", "kong", "india", "indian", "canada", "canadian", "uk", "british",
  ]);

  const words = canonicalName
    .toLowerCase()
    .replace(/[/\\,.'()&]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !GENERIC_WORDS.has(w));

  const aliases: string[] = [];

  // 1. Initial-based alias (first letter of each distinctive word)
  if (words.length >= 2) {
    const initials = words.map(w => w[0]).join("");
    if (initials.length >= 2) {
      aliases.push(initials);
    }
  }

  // 2. Concatenated distinctive words
  if (words.length >= 2) {
    const concat = words.join("");
    if (concat.length >= 4) {
      aliases.push(concat);
    }
  }

  // 3. Individual distinctive words (already used by existing token match,
  //    but include here for completeness in the alias set)
  for (const w of words) {
    if (w.length >= 3) {
      aliases.push(w);
    }
  }

  // 4. Ticker as alias (41-E: reject ADR pink-sheet codes — 5 uppercase letters ending in F)
  if (ticker && ticker.length >= 2) {
    const isAdrPinkSheet = /^[A-Z]{5}F$/.test(ticker);
    if (!isAdrPinkSheet) {
      aliases.push(ticker.toLowerCase());
    }
  }

  // Deduplicate and filter
  return [...new Set(aliases)].filter(a => a.length >= 2);
}
