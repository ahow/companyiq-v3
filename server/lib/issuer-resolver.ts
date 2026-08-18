/**
 * 40-0: OpenFIGI-first canonical-name resolution.
 * Resolves the canonical issuer name and ticker via ISIN lookup.
 * Results are cached on the company row (figiName, figiTicker, figiResolvedAt).
 *
 * P2: Includes exponential-backoff retry (up to 3 attempts) and a simple
 * token-bucket rate limiter (20 req/min) to stay within the free tier.
 */
import axios from "axios";
import { db } from "../db.js";
import { sql } from "drizzle-orm";

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

      const entry = result.data[0];
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
 * Resolve and persist FIGI data for a company.
 * Skips if already resolved within the last 30 days.
 *
 * P3 improvement: When the cache is fresh, returns the CACHED name/ticker
 * from the company row (passed in) rather than returning nulls. This makes
 * the function self-contained — callers don't need to separately read from
 * the row.
 */
export async function resolveCompanyFIGI(company: {
  id: number;
  isin?: string | null;
  figiResolvedAt?: Date | string | null;
  figiName?: string | null;
  figiTicker?: string | null;
}): Promise<FigiResult> {
  // Short-circuit if already resolved within 30 days — return cached values
  if (company.figiResolvedAt) {
    const resolvedAt = new Date(company.figiResolvedAt);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (resolvedAt > thirtyDaysAgo) {
      return {
        name: company.figiName || null,
        ticker: company.figiTicker || null,
      };
    }
  }

  if (!company.isin) {
    return { name: null, ticker: null };
  }

  const result = await resolveViaOpenFIGI(company.isin);

  // Persist to DB regardless of success (marks as resolved to prevent re-calls)
  try {
    await db.execute(sql`
      UPDATE companies SET
        figi_name = ${result.name},
        figi_ticker = ${result.ticker},
        figi_resolved_at = NOW()
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

  // 4. Ticker as alias
  if (ticker && ticker.length >= 2) {
    aliases.push(ticker.toLowerCase());
  }

  // Deduplicate and filter
  return [...new Set(aliases)].filter(a => a.length >= 2);
}
