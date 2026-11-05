/**
 * FMP-only domain backfill for companies with a blank `companies.domain`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The full discovery ladder (discovery.ts) resolves and persists a company's
 * domain during analysis, but that path is Serper-backed (costs search calls)
 * and only runs when a company is actually analysed. Companies that have never
 * been analysed — including every company a user newly imports — therefore sit
 * with a NULL domain until their first full run. A blank domain weakens
 * provenance Rule 1 (own-domain first_party match), so the issuer's own filings
 * can be misread as third_party.
 *
 * This module resolves the domain using ONLY the FMP identity we already pay a
 * flat subscription for (ISIN -> primary listing -> company profile -> website),
 * with NO Serper and NO LLM calls, so it is free to run at scale and safe to run
 * on every new company. It writes the same anchors the pipeline writes
 * (deriveFmpAnchors): native `domain`/`ticker` only when blank, and an additive
 * union into `related_domains`. It NEVER overwrites a non-blank native value and
 * NEVER touches `related_domains_manual`.
 *
 * Two consumers:
 *   1) server/scripts/backfill-null-domains.ts — one-off sweep of the backlog.
 *   2) server/reconciler.ts — a small bounded sweep every reconcile pass, so new
 *      companies are auto-populated within minutes of being added, with no
 *      per-import latency and no manual step. THIS is the "automatic for all
 *      companies including new ones" guarantee.
 *
 * Companies with no ISIN cannot be FMP-resolved; they are left for the full
 * discovery ladder to resolve on their first analysis. The sweep reports them.
 */
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import {
  resolveViaFmp,
  deriveFmpAnchors,
  getFmpKey,
  type FmpProfile,
} from "./fmp-resolver.js";

export interface DomainBackfillStats {
  scanned: number;
  resolved: number;        // domain written this run
  fromCache: number;       // resolved from an already-cached fmp_website (no API call)
  fromFmpLookup: number;   // resolved via a fresh FMP ISIN lookup
  noIsin: number;          // skipped: no ISIN, cannot FMP-resolve (needs full discovery)
  fmpNoMatch: number;      // ISIN present but FMP returned no usable website
  errors: number;
  dryRun: boolean;
}

interface NullDomainRow {
  id: number;
  name: string;
  isin: string | null;
  domain: string | null;
  ticker: string | null;
  related_domains: unknown;
  fmp_website: string | null;
  fmp_symbol: string | null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; }
    catch { return []; }
  }
  return [];
}

/**
 * Resolve + persist the domain for a single company row using FMP only.
 * Returns the outcome bucket for stats. Pure w.r.t. Serper/LLM (no such calls).
 */
async function backfillOne(
  row: NullDomainRow,
  dryRun: boolean,
): Promise<"fromCache" | "fromFmpLookup" | "noIsin" | "fmpNoMatch" | "error"> {
  try {
    let fmpWebsite = row.fmp_website;
    let fmpSymbol = row.fmp_symbol;
    let usedLookup = false;

    // Tier 1: already-cached fmp_website -> no API call.
    // Tier 2: fresh FMP ISIN lookup (only when no cached website).
    if (!fmpWebsite || !fmpWebsite.trim()) {
      if (!row.isin || !row.isin.trim()) return "noIsin";
      const profile: FmpProfile | null = await resolveViaFmp(row.isin);
      usedLookup = true;
      if (!profile || !profile.website || !profile.website.trim()) return "fmpNoMatch";
      fmpWebsite = profile.website;
      fmpSymbol = fmpSymbol || profile.symbol;
    }

    const anchors = deriveFmpAnchors({
      nativeDomain: row.domain,
      nativeTicker: row.ticker,
      relatedDomains: asStringArray(row.related_domains),
      fmpWebsite,
      fmpSymbol,
    });

    if (!anchors.domain) {
      // FMP website did not reduce to a registrable domain.
      return usedLookup ? "fmpNoMatch" : "fmpNoMatch";
    }

    if (!dryRun) {
      // Build the UPDATE: always set domain; set ticker/related_domains/fmp cache
      // only where we have a value, never overwriting a non-blank native value
      // (deriveFmpAnchors already enforced that) and never touching *_manual.
      const relatedJson =
        anchors.relatedDomains != null ? JSON.stringify(anchors.relatedDomains) : null;
      await db.execute(sql`
        UPDATE companies SET
          domain = ${anchors.domain},
          ticker = COALESCE(NULLIF(${anchors.ticker ?? null}, ''), ticker),
          related_domains = COALESCE(${relatedJson}::jsonb, related_domains),
          fmp_website = COALESCE(NULLIF(${fmpWebsite ?? null}, ''), fmp_website),
          fmp_symbol = COALESCE(NULLIF(${fmpSymbol ?? null}, ''), fmp_symbol),
          fmp_resolved_at = COALESCE(fmp_resolved_at, NOW()),
          updated_at = NOW()
        WHERE id = ${row.id}
      `);
    }

    return usedLookup ? "fromFmpLookup" : "fromCache";
  } catch (e: any) {
    console.warn(`[DomainBackfill] company ${row.id} (${row.name}) failed: ${e?.message}`);
    return "error";
  }
}

/**
 * Resolve blank domains for up to `limit` companies (across all workspaces, or a
 * single workspace when `workspaceId` is given), FMP-only. Bounded concurrency.
 */
export async function backfillNullDomainsViaFmp(opts: {
  limit?: number;
  workspaceId?: number;
  dryRun?: boolean;
  concurrency?: number;
} = {}): Promise<DomainBackfillStats> {
  const limit = Math.max(1, opts.limit ?? 1000);
  const dryRun = opts.dryRun ?? false;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const stats: DomainBackfillStats = {
    scanned: 0, resolved: 0, fromCache: 0, fromFmpLookup: 0,
    noIsin: 0, fmpNoMatch: 0, errors: 0, dryRun,
  };

  if (!getFmpKey()) {
    console.warn("[DomainBackfill] FMP_API_KEY not configured — nothing to do");
    return stats;
  }

  const wsFilter = opts.workspaceId != null ? sql`AND workspace_id = ${opts.workspaceId}` : sql``;
  // Prioritise rows with a cached fmp_website (instant, no API call) first.
  const res: any = await db.execute(sql`
    SELECT id, name, isin, domain, ticker, related_domains, fmp_website, fmp_symbol
    FROM companies
    WHERE (domain IS NULL OR domain = '') ${wsFilter}
    ORDER BY (fmp_website IS NOT NULL AND fmp_website <> '') DESC, id ASC
    LIMIT ${limit}
  `);
  const rows = ((res.rows as NullDomainRow[]) || []);
  stats.scanned = rows.length;

  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const myIdx = idx++;
      const outcome = await backfillOne(rows[myIdx], dryRun);
      switch (outcome) {
        case "fromCache": stats.fromCache++; stats.resolved++; break;
        case "fromFmpLookup": stats.fromFmpLookup++; stats.resolved++; break;
        case "noIsin": stats.noIsin++; break;
        case "fmpNoMatch": stats.fmpNoMatch++; break;
        case "error": stats.errors++; break;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return stats;
}
