/**
 * backfill-provenance-upgrade.ts — non-destructive provenance backfill (3m note §4.2).
 *
 * WHY
 * ---
 * Companies analysed before the Rule 1a short-token rescue (2026-11-02) and the
 * FMP anchor-wiring fix (§4.1) have their OWN filings sitting in the third_party
 * bucket, so they were withheld from the scorer (the 3M signature: issuer-domain
 * documents classified third_party; see 3m_corpus_investigation note §1). This
 * one-off pass re-runs classifyProvenance() over EXISTING `documents` rows with
 * the SAME anchor derivation as fix (A) — i.e. FMP's resolved identity
 * (fmp_website / fmp_symbol) is wired into the domain / ticker / related_domains
 * anchors that the deterministic host match reads — and UPGRADES rows that now
 * resolve to the issuer.
 *
 * STRICTLY NON-DESTRUCTIVE
 * ------------------------
 *   - Only ever changes source_type 'third_party' -> 'first_party'.
 *   - NEVER downgrades (first_party is never touched), never deletes, never edits
 *     content / scores / titles / any other column. The UPDATE itself is guarded
 *     with `WHERE source_type = 'third_party'` as a second belt-and-braces check.
 *   - --dry-run is the DEFAULT: it only SELECTs and reports counts. Writes happen
 *     ONLY with an explicit --apply flag.
 *
 * SCOPE / SAFETY
 * --------------
 *   - Reads the DB URL from DATABASE_URL (env). The prod URL is NOT hardcoded.
 *   - Optional --company <id> or --workspace <id> to scope the pass.
 *   - CIK-dependent regulator-host upgrades (SEC EDGAR etc.) are out of scope here
 *     — this pass targets the issuer-domain / FMP-anchor upgrades that fix (A)
 *     enables. Those cases are recovered by a normal re-analysis. (We never
 *     downgrade, so skipping them can only mean fewer upgrades, never harm.)
 *
 * USAGE
 * -----
 *   # Dry-run (default), whole DB — reports what WOULD be upgraded, writes nothing:
 *   DATABASE_URL=... node --import tsx server/scripts/backfill-provenance-upgrade.ts
 *
 *   # Dry-run, single company:
 *   DATABASE_URL=... node --import tsx server/scripts/backfill-provenance-upgrade.ts --company 815
 *
 *   # Dry-run, one workspace:
 *   DATABASE_URL=... node --import tsx server/scripts/backfill-provenance-upgrade.ts --workspace 3
 *
 *   # APPLY the upgrades (writes third_party -> first_party only):
 *   DATABASE_URL=... node --import tsx server/scripts/backfill-provenance-upgrade.ts --apply
 *   DATABASE_URL=... node --import tsx server/scripts/backfill-provenance-upgrade.ts --company 815 --apply
 */

import pg from "pg";
import { classifyProvenance, provenanceToSourceType } from "../lib/provenance.js";
import { deriveFmpAnchors } from "../lib/fmp-resolver.js";
import { deriveAliases } from "../lib/issuer-resolver.js";

const { Pool } = pg;

// ─── CLI parsing ──────────────────────────────────────────────────────────────

interface Args {
  apply: boolean;
  companyId?: number;
  workspaceId?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false; // default anyway; explicit is fine
    else if (a === "--company") {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) throw new Error("--company requires a numeric id");
      args.companyId = v;
    } else if (a.startsWith("--company=")) {
      args.companyId = parseInt(a.split("=")[1], 10);
    } else if (a === "--workspace") {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v)) throw new Error("--workspace requires a numeric id");
      args.workspaceId = v;
    } else if (a.startsWith("--workspace=")) {
      args.workspaceId = parseInt(a.split("=")[1], 10);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CompanyRow {
  id: number;
  workspace_id: number;
  name: string | null;
  isin: string | null;
  domain: string | null;
  ticker: string | null;
  related_domains: string[] | null;
  fmp_symbol: string | null;
  fmp_website: string | null;
}

interface DocRow {
  id: number;
  url: string;
  title: string | null;
  source_type: string | null;
  content: string | null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required (the prod URL is never hardcoded).");
    process.exit(1);
  }

  const mode = args.apply ? "APPLY (writes third_party -> first_party)" : "DRY-RUN (no writes)";
  console.log("─".repeat(78));
  console.log(`Provenance backfill-upgrade — ${mode}`);
  if (args.companyId) console.log(`Scope: company id = ${args.companyId}`);
  else if (args.workspaceId) console.log(`Scope: workspace id = ${args.workspaceId}`);
  else console.log("Scope: ALL companies");
  console.log("─".repeat(78));

  const pool = new Pool({ connectionString: dbUrl });

  let totalCompanies = 0;
  let totalScanned = 0;
  let totalUpgradeCandidates = 0;
  let totalApplied = 0;
  const perCompany: Array<{ id: number; name: string; scanned: number; upgrades: number }> = [];

  try {
    // Load companies in scope.
    let companyQuery = `
      SELECT id, workspace_id, name, isin, domain, ticker, related_domains, fmp_symbol, fmp_website
      FROM companies
    `;
    const params: any[] = [];
    if (args.companyId) {
      companyQuery += ` WHERE id = $1`;
      params.push(args.companyId);
    } else if (args.workspaceId) {
      companyQuery += ` WHERE workspace_id = $1`;
      params.push(args.workspaceId);
    }
    companyQuery += ` ORDER BY id`;

    const companies = (await pool.query(companyQuery, params)).rows as CompanyRow[];
    console.log(`Loaded ${companies.length} company row(s).\n`);

    for (const c of companies) {
      // Derive the SAME anchors as fix (A): fill blank native domain/ticker and
      // union the FMP host into related_domains.
      const nativeDomain = (c.domain || "").replace(/^www\./i, "").toLowerCase().trim() || null;
      const nativeRelated = Array.isArray(c.related_domains)
        ? c.related_domains.map((d) => (d || "").replace(/^www\./i, "").toLowerCase()).filter(Boolean)
        : [];
      const anchors = deriveFmpAnchors({
        nativeDomain,
        nativeTicker: c.ticker,
        relatedDomains: nativeRelated,
        fmpWebsite: c.fmp_website,
        fmpSymbol: c.fmp_symbol,
      });
      const effectiveDomain = nativeDomain || anchors.domain || "";
      const effectiveTicker = (c.ticker || anchors.ticker || null) as string | null;
      const effectiveRelated = anchors.relatedDomains
        ? anchors.relatedDomains.map((d) => (d || "").replace(/^www\./i, "").toLowerCase()).filter(Boolean)
        : nativeRelated;
      const companyAliases = deriveAliases(c.name || "", effectiveTicker);

      // Load this company's third_party documents (only these can upgrade) WITH content.
      const docs = (await pool.query(
        `
        SELECT d.id, d.url, d.title, d.source_type,
               COALESCE(dc.content, d.content) AS content
        FROM documents d
        LEFT JOIN document_content dc ON dc.id = d.content_id
        WHERE d.company_id = $1
          AND d.source_type = 'third_party'
        ORDER BY d.id
        `,
        [c.id],
      )).rows as DocRow[];

      if (docs.length === 0) continue;
      totalCompanies++;

      const upgradeIds: number[] = [];
      for (const doc of docs) {
        totalScanned++;
        const prov = classifyProvenance({
          url: doc.url,
          title: doc.title,
          content: doc.content,
          companyDomain: effectiveDomain,
          relatedDomains: effectiveRelated,
          companyName: c.name,
          companyTicker: effectiveTicker,
          companyAliases,
          companyIsin: c.isin,
          // companySecCik intentionally omitted — see SCOPE note in the header.
        });
        if (provenanceToSourceType(prov.provenance) === "first_party") {
          upgradeIds.push(doc.id);
          totalUpgradeCandidates++;
        }
      }

      if (upgradeIds.length > 0) {
        perCompany.push({ id: c.id, name: c.name || "(unnamed)", scanned: docs.length, upgrades: upgradeIds.length });
        const anchorNote =
          (anchors.domain ? ` domain<-${anchors.domain}` : "") +
          (anchors.ticker ? ` ticker<-${anchors.ticker}` : "") +
          (anchors.relatedDomains ? ` +fmp-host` : "");
        console.log(
          `[company ${c.id}] ${c.name || "(unnamed)"}: ${upgradeIds.length}/${docs.length} third_party docs now resolve to issuer` +
          (anchorNote ? ` (FMP anchors:${anchorNote})` : "") +
          (args.apply ? "" : " [dry-run]"),
        );

        if (args.apply) {
          // Belt-and-braces: the WHERE also re-checks source_type so we can only
          // ever perform the third_party -> first_party upgrade, never a downgrade.
          const res = await pool.query(
            `UPDATE documents SET source_type = 'first_party'
             WHERE id = ANY($1::int[]) AND source_type = 'third_party'`,
            [upgradeIds],
          );
          totalApplied += res.rowCount ?? 0;
        }
      }
    }

    console.log("\n" + "─".repeat(78));
    console.log("SUMMARY");
    console.log(`  Companies with upgradeable docs : ${totalCompanies}`);
    console.log(`  Third-party docs scanned        : ${totalScanned}`);
    console.log(`  Upgrade candidates (→first_party): ${totalUpgradeCandidates}`);
    if (args.apply) {
      console.log(`  Rows actually upgraded           : ${totalApplied}`);
    } else {
      console.log(`  Rows upgraded                    : 0 (dry-run — re-run with --apply to write)`);
    }
    console.log("─".repeat(78));
    if (!args.apply && totalUpgradeCandidates > 0) {
      console.log("Dry-run only. To apply, re-run the SAME command with --apply appended.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("backfill-provenance-upgrade failed:", err);
  process.exit(1);
});
