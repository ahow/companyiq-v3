/**
 * Domain & ISIN audit CLI.
 *
 * For every LISTED company (is_unlisted = false) in the workspace, produce
 * proposals for corrections to `isin`, `domain`, and `related_domains` and
 * write them to `company_domain_proposals`. Never touches `companies`.
 *
 * Runs read-only by default (dry-run: prints the proposal table and exits).
 * Pass --persist to write proposals to the DB. Pass --company N to audit a
 * single row for spot-checking.
 *
 * Usage:
 *   DATABASE_URL=... FMP_API_KEY=... SERPER_API_KEY=... \
 *     npx tsx scripts/propose_domain_and_isin.ts                 # dry run, all listed
 *   ... npx tsx scripts/propose_domain_and_isin.ts --company 19
 *   ... npx tsx scripts/propose_domain_and_isin.ts --persist
 *   ... npx tsx scripts/propose_domain_and_isin.ts --persist --json out.json
 *
 * Merge dependency: this script uses `resolveViaFmpByTicker` from
 * server/lib/fmp-resolver.ts. That symbol is introduced in the PR that
 * fixes the test-drive ingest path. Both PRs must be present on the
 * branch for the audit to run.
 */

import pg from "pg";
import { writeFileSync } from "node:fs";
import {
  resolveFmpForAudit,
  verifyIsinViaFigi,
  searchPlurality,
  proposeRelatedDomains,
  computeU17Impact,
  nameTokens,
  type CompanyAuditInput,
  type AuditProposal,
  type AuditSource,
  type Confidence,
  type DocumentRow,
} from "../server/lib/domain-audit.js";

// ─── CLI arg parse ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const persist = args.includes("--persist");
const jsonIdx = args.indexOf("--json");
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const companyIdx = args.indexOf("--company");
const companyFilter = companyIdx >= 0 ? Number(args[companyIdx + 1]) : null;
const includeRelated = !args.includes("--no-related");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Countries to probe for regional-variant related-domain search. */
const RELATED_REGIONS: Record<string, string[]> = {
  "United Kingdom": ["USA", "India"],
  "US": ["UK", "Europe"], "United States": ["UK", "Europe"],
  "Netherlands": ["USA", "Brasil"], "Brazil": ["USA"], "BR": ["USA"],
  "Switzerland": ["USA", "Latin America"],
  "France": ["USA", "China"],
  "Japan": ["USA", "Europe"],
  "Australia": ["USA"], "AU": ["USA"],
  "Canada": ["USA"], "CA": ["USA"],
  "Spain": ["Latin America", "UK"], "ES": ["Latin America", "UK"],
  "South Korea": ["USA", "China"], "KR": ["USA", "China"],
};

function pickConfidence(input: {
  fmpAccepted: boolean;
  usedCountrySuffix: boolean;
  wasAdrFallback: boolean;
  figiAgrees: boolean | null;   // null = FIGI didn't run
  /**
   * Search-plurality outcome, tri-state:
   *   "matches"    — search winner is FMP-derived domain (strong corroboration)
   *   "disagrees"  — search winner is a different credible non-aggregator domain
   *   "inconclusive" — no clear winner, too few hits, or search failed
   */
  searchOutcome: "matches" | "disagrees" | "inconclusive";
}): Confidence {
  if (!input.fmpAccepted) return "low";
  if (input.wasAdrFallback) return "low";       // Wrong-listing risk
  if (input.figiAgrees === false) return "low"; // Identity conflict
  if (input.searchOutcome === "disagrees") return "medium"; // FMP+FIGI OK but search disagrees
  // Search matches OR inconclusive both defer to FMP+FIGI. Distinguish:
  //   — If FMP was clean AND (FIGI agreed OR wasn't run for other reasons), "high".
  //   — If FIGI was actually run and agreed, "high" regardless of search.
  //   — If FIGI wasn't run (figiAgrees === null) AND search inconclusive, "medium"
  //     because we lack independent corroboration.
  if (input.figiAgrees === true) return "high";
  if (input.searchOutcome === "matches") return "high";
  return "medium";
}

/**
 * Classify the search-plurality result into a tri-state outcome the
 * confidence picker can use. Requires either a clear plurality (top host
 * has >=2 hits and >=40% of non-aggregator hits) OR a plurality-of-one on
 * an already-known corporate domain.
 */
function classifySearchOutcome(
  fmpDomain: string | null,
  search: { topHost: string | null; topHostCount: number; totalNonAggregatorHits: number },
): "matches" | "disagrees" | "inconclusive" {
  if (!fmpDomain) return "inconclusive";
  if (!search.topHost) return "inconclusive";
  const fmpNorm = normDomain(fmpDomain);
  const searchNorm = normDomain(search.topHost);
  // If the top host and FMP-derived match, corroboration is unambiguous
  // even at count 1 out of 1.
  if (fmpNorm === searchNorm) return "matches";
  // Otherwise: the search winner disagrees only if it has some real support.
  // "Real support" = at least 2 hits AND at least 40% share of non-aggregator
  // hits. Below that, the top host is likely noise (e.g. one stray aggregator
  // that snuck past the deny-list).
  if (search.topHostCount >= 2 && search.totalNonAggregatorHits >= 2
      && search.topHostCount / search.totalNonAggregatorHits >= 0.4) {
    return "disagrees";
  }
  return "inconclusive";
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function normDomain(d: string | null): string | null {
  if (!d) return null;
  return d.replace(/^www\./i, "").toLowerCase();
}

// ─── Audit one company ──────────────────────────────────────────────────

async function auditCompany(
  c: CompanyAuditInput,
  docs: DocumentRow[],
): Promise<{ proposals: AuditProposal[]; trace: string[]; skip?: string }> {
  if (c.isUnlisted) {
    return { proposals: [], trace: [`skipped: is_unlisted=true`], skip: "is_unlisted" };
  }

  // Stage 1: FMP
  const fmpOut = await resolveFmpForAudit(c.ticker, c.country);
  const trace = [...fmpOut.trace];
  const fmp = fmpOut.fmp;

  // Stage 2: OpenFIGI cross-check on the FMP-suggested ISIN.
  let figi: Awaited<ReturnType<typeof verifyIsinViaFigi>> | null = null;
  if (fmp?.isin) {
    figi = await verifyIsinViaFigi(fmp.isin, fmp.companyName);
    trace.push(`figi: ${figi.notes ?? "no notes"} (agrees=${figi.agrees})`);
  }

  // Stage 3: Search plurality on the canonical name.
  const searchName = fmp?.companyName || c.name;
  const search = await searchPlurality(searchName);
  if (search.error) trace.push(`search: ${search.error}`);
  else trace.push(`search: top=${search.topHost} (${search.topHostCount}/${search.totalNonAggregatorHits})`);

  const fmpDomain = fmpOut.derivedDomain;
  const searchOutcome = search.error
    ? "inconclusive"
    : classifySearchOutcome(fmpDomain, search);

  const proposals: AuditProposal[] = [];

  // ── ISIN proposal ──────────────────────────────────────────────────
  const proposedIsin = fmp?.isin || null;
  const wasAdrFallback = !!proposedIsin && /^US/i.test(proposedIsin) && !!c.country && (c.country.toUpperCase() !== "US" && c.country !== "United States");
  const isinConfidence = pickConfidence({
    fmpAccepted: !!fmp,
    usedCountrySuffix: fmpOut.symbolUsed !== null && fmpOut.symbolUsed !== c.ticker?.toUpperCase(),
    wasAdrFallback,
    figiAgrees: figi ? figi.agrees : null,
    searchOutcome,
  });
  const isinSources: AuditSource[] = [];
  if (fmp) {
    isinSources.push({
      signal: "fmp",
      evidence: {
        symbol: fmpOut.symbolUsed,
        companyName: fmp.companyName,
        country: fmp.country,
        exchange: fmp.exchange,
      },
    });
  }
  if (figi) {
    isinSources.push({ signal: "openfigi", evidence: { name: figi.figi?.name ?? null, agrees: figi.agrees, notes: figi.notes } });
  }
  const isinConflict = fmp
    ? (figi?.agrees === false
        ? `FMP suggested ISIN ${proposedIsin}, but OpenFIGI name disagrees: ${figi.notes}`
        : (wasAdrFallback ? `FMP-only source was a US ADR fallback (isin=${proposedIsin}); primary local ISIN not resolved` : null))
    : `FMP could not resolve ticker=${c.ticker ?? "\u2205"}, country=${c.country ?? "\u2205"} (guard=${fmpOut.guardHit}, trace: ${fmpOut.trace.join("; ")})`;
  const currentIsin = c.isin;
  if (proposedIsin !== null && !jsonEq(currentIsin, proposedIsin)) {
    proposals.push({
      companyId: c.id,
      proposalType: "isin",
      currentValue: currentIsin,
      proposedValue: proposedIsin,
      sources: isinSources,
      confidence: isinConfidence,
      conflictNotes: isinConflict,
    });
  } else if (proposedIsin === null && currentIsin === null && fmpOut.guardHit) {
    // FMP couldn't produce anything AND the DB has nothing. Emit a
    // proposal-with-null-value + conflict note so the reviewer sees the row.
    proposals.push({
      companyId: c.id,
      proposalType: "isin",
      currentValue: currentIsin,
      proposedValue: null,
      sources: isinSources,
      confidence: "low",
      conflictNotes: isinConflict,
    });
  }

  // ── Domain proposal ────────────────────────────────────────────────
  const currentDomain = normDomain(c.domain);
  const proposedDomain = normDomain(fmpDomain);
  const domainConfidence = pickConfidence({
    fmpAccepted: !!fmp,
    usedCountrySuffix: false,
    wasAdrFallback: false, // domain isn't ADR-affected
    figiAgrees: figi ? figi.agrees : null,
    searchOutcome,
  });
  const domainSources: AuditSource[] = [];
  if (fmp) {
    domainSources.push({
      signal: "fmp",
      evidence: { website: fmp.website, derivedDomain: proposedDomain },
    });
  }
  if (search.topHost !== null || search.error) {
    domainSources.push({
      signal: "search-plurality",
      evidence: {
        topHost: search.topHost,
        topHostCount: search.topHostCount,
        totalNonAggregatorHits: search.totalNonAggregatorHits,
        hostCounts: search.hostCounts,
        error: search.error,
      },
    });
  }
  const domainConflict = (() => {
    if (!fmp) return `FMP did not resolve; cannot propose domain from FMP`;
    if (search.error) return null;
    if (searchOutcome === "disagrees") {
      return `FMP-derived domain "${fmpDomain}" disagrees with search-plurality top "${search.topHost}" (${search.topHostCount}/${search.totalNonAggregatorHits})`;
    }
    return null;
  })();

  // Compute U17 impact for the domain proposal (independent of related_domains).
  const aliases = nameTokens(fmp?.companyName || c.name);
  let u17Flip: number | null = null;
  if (proposedDomain !== null && !jsonEq(currentDomain, proposedDomain)) {
    const impact = computeU17Impact(docs, {
      domain: proposedDomain,
      relatedDomains: c.relatedDomains ?? [],
      ticker: c.ticker,
      isin: proposedIsin,
      name: fmp?.companyName || c.name,
      aliases,
    });
    u17Flip = impact.flippedToFirst - impact.demotedToThird;
    proposals.push({
      companyId: c.id,
      proposalType: "domain",
      currentValue: currentDomain,
      proposedValue: proposedDomain,
      sources: domainSources,
      confidence: domainConflict ? "low" : domainConfidence,
      conflictNotes: domainConflict,
    });
    trace.push(`domain proposal: ${currentDomain} \u2192 ${proposedDomain} (u17 net flip: ${u17Flip})`);
  }

  // ── Related domains proposal (guarded, optional) ───────────────────
  if (includeRelated && proposedDomain) {
    const regions = c.country ? (RELATED_REGIONS[c.country] || RELATED_REGIONS[c.country.toUpperCase()] || []) : [];
    const currentRelated = (c.relatedDomains ?? []).map(d => normDomain(d)!).filter(Boolean);
    if (regions.length > 0) {
      const regional = await proposeRelatedDomains(fmp?.companyName || c.name, proposedDomain, regions);
      trace.push(`related-search: candidates=${regional.candidates.join(", ") || "(none)"}${regional.error ? ` err=${regional.error}` : ""}`);

      // Clean the CURRENT set of any aggregator/deny-listed hosts (e.g. Ambev's publicnow.com).
      const currentCleaned = currentRelated.filter(d => !isAggregatorHost(d));
      // Merge: keep current-cleaned plus new candidates that share tokens.
      const merged = Array.from(new Set([...currentCleaned, ...regional.candidates])).sort();
      const currentSorted = [...currentRelated].sort();
      if (!jsonEq(currentSorted, merged)) {
        const impact = computeU17Impact(docs, {
          domain: proposedDomain,
          relatedDomains: merged,
          ticker: c.ticker,
          isin: proposedIsin,
          name: fmp?.companyName || c.name,
          aliases,
        });
        const netFlip = impact.flippedToFirst - impact.demotedToThird;
        proposals.push({
          companyId: c.id,
          proposalType: "related_domains",
          currentValue: currentSorted,
          proposedValue: merged,
          sources: [
            { signal: "regional-search", evidence: { regions, hitsByRegion: regional.hitsByRegion, error: regional.error } },
          ],
          confidence: regional.error ? "low" : "medium",
          conflictNotes: regional.error,
        });
        trace.push(`related_domains proposal: net flip=${netFlip}, demoted=${impact.demotedToThird}, added=${regional.candidates.length}`);
      }
    }
  }

  return { proposals, trace };
}

/** Cheap deny-list check; mirrors the audit lib's AGGREGATOR_DENY_LIST for the current-cleanup step. */
function isAggregatorHost(host: string): boolean {
  const KNOWN = new Set([
    "publicnow.com", "annualreports.com", "yahoo.com", "linkedin.com", "reuters.com",
    "bloomberg.com", "ft.com", "wsj.com", "cnbc.com", "marketwatch.com",
    "stockanalysis.com", "seekingalpha.com", "morningstar.com", "fool.com",
    "investing.com", "stocktwits.com", "finbox.com", "simplywall.st", "gurufocus.com",
    "zacks.com", "tipranks.com", "moomoo.com", "stocktitan.net", "scribd.com",
  ]);
  return KNOWN.has(host);
}

// ─── Persistence ────────────────────────────────────────────────────────

async function persistProposal(client: pg.Client, p: AuditProposal): Promise<void> {
  // Supersede any existing pending proposal for the same (company, type).
  await client.query(
    `UPDATE company_domain_proposals SET status='superseded', updated_at=NOW()
       WHERE company_id=$1 AND proposal_type=$2 AND status='pending'`,
    [p.companyId, p.proposalType],
  );
  await client.query(
    `INSERT INTO company_domain_proposals
       (company_id, proposal_type, current_value, proposed_value, sources,
        confidence, conflict_notes, status)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, 'pending')`,
    [
      p.companyId,
      p.proposalType,
      JSON.stringify(p.currentValue ?? null),
      JSON.stringify(p.proposedValue ?? null),
      JSON.stringify(p.sources),
      p.confidence,
      p.conflictNotes,
    ],
  );
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const whereFilter = companyFilter !== null ? `AND id = ${companyFilter}` : "";
  const { rows } = await client.query<{
    id: number; name: string; ticker: string | null; country: string | null;
    isin: string | null; domain: string | null; related_domains: string[] | null;
    is_unlisted: boolean;
  }>(
    `SELECT id, name, ticker, country, isin, domain, related_domains, is_unlisted
       FROM companies
      WHERE is_unlisted = false ${whereFilter}
      ORDER BY id`,
  );

  console.log(`Auditing ${rows.length} listed companies${persist ? " (writes enabled)" : " (dry-run)"}\n`);

  const allOutcomes: Array<{
    id: number; name: string; proposals: AuditProposal[]; trace: string[]; skip?: string;
  }> = [];

  for (const r of rows) {
    // Fetch docs for U17-impact simulation.
    const docsRes = await client.query<{ id: number; url: string; title: string | null; source_type: string | null }>(
      `SELECT id, url, title, source_type FROM documents WHERE company_id = $1`,
      [r.id],
    );
    const docs: DocumentRow[] = docsRes.rows.map(d => ({
      id: d.id,
      url: d.url,
      title: d.title,
      sourceType: (d.source_type === "first_party" || d.source_type === "third_party") ? d.source_type : null,
    }));

    const input: CompanyAuditInput = {
      id: r.id,
      name: r.name,
      ticker: r.ticker,
      country: r.country,
      isin: r.isin,
      domain: r.domain,
      relatedDomains: r.related_domains,
      isUnlisted: r.is_unlisted,
    };
    const out = await auditCompany(input, docs);
    allOutcomes.push({ id: r.id, name: r.name, ...out });

    // Persist immediately (per company) so a mid-run failure still lands some proposals.
    if (persist) {
      for (const p of out.proposals) {
        try {
          await persistProposal(client, p);
        } catch (e: any) {
          console.warn(`  persist failed for company ${r.id} type=${p.proposalType}: ${e.message}`);
        }
      }
    }
  }

  await client.end();

  // ── Render inline table ────────────────────────────────────────────
  const header = ["id", "name", "type", "current \u2192 proposed", "conf", "conflict"];
  console.log(header.join("\t"));
  console.log(header.map(_ => "---").join("\t"));
  for (const o of allOutcomes) {
    if (o.skip) {
      console.log(`${o.id}\t${o.name}\tSKIP\t\u2014\t\u2014\t${o.skip}`);
      continue;
    }
    if (o.proposals.length === 0) {
      console.log(`${o.id}\t${o.name}\t\u2014\tno changes proposed\t\u2014\t\u2014`);
      continue;
    }
    for (const p of o.proposals) {
      const cur = JSON.stringify(p.currentValue ?? null);
      const pro = JSON.stringify(p.proposedValue ?? null);
      const short = cur.length + pro.length > 100 ? `${cur.slice(0, 40)}\u2026 \u2192 ${pro.slice(0, 40)}\u2026` : `${cur} \u2192 ${pro}`;
      console.log(`${o.id}\t${o.name}\t${p.proposalType}\t${short}\t${p.confidence}\t${p.conflictNotes ?? ""}`);
    }
  }

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(allOutcomes, null, 2), "utf8");
    console.log(`\nJSON written to ${jsonPath}`);
  }
  console.log(persist ? "\nProposals persisted." : "\nDry-run \u2014 no writes. Pass --persist to write.");
}

main().catch((e) => { console.error(e); process.exit(1); });
