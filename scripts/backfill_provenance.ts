/**
 * U17 — Backfill `documents.source_type` using the new provenance classifier.
 *
 * The pre-U17 classifier compared the document hostname against
 * `companies.domain` only. That produced two systematic errors:
 *   (a) regulator-hosted issuer filings (SEC EDGAR, Modern Slavery Register,
 *       SEDAR+, ...) tagged `third_party`;
 *   (b) documents on the issuer's *related* domains tagged `third_party`,
 *       because related_domains was never consulted.
 *
 * Existing rows still carry the old labels. With U17 Fix A active, the
 * corpus-build filter drops every `third_party` document from the evidence
 * pack, so stale labels directly suppress legitimate issuer evidence. This
 * script re-runs `classifyProvenance` over every document row using the
 * stored full content and rewrites `source_type`.
 *
 * Runs read-only by default. Pass --apply to write.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill_provenance.ts            # dry run, all companies
 *   DATABASE_URL=... npx tsx scripts/backfill_provenance.ts --company 18
 *   DATABASE_URL=... npx tsx scripts/backfill_provenance.ts --apply
 *   DATABASE_URL=... npx tsx scripts/backfill_provenance.ts --apply --company 18 --json out.json
 */

import pg from "pg";
import { writeFileSync } from "node:fs";
import { classifyProvenance, provenanceToSourceType } from "../server/lib/provenance.js";
import { deriveAliases } from "../server/lib/issuer-resolver.js";

const { Pool } = pg;

// ─── CLI ────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const APPLY = process.argv.includes("--apply");
const COMPANY_FILTER = argValue("--company");
const JSON_OUT = argValue("--json");
const SAMPLE_LIMIT = parseInt(argValue("--samples") || "15", 10);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Row {
  doc_id: number;
  company_id: number;
  url: string;
  title: string | null;
  source_type: string | null;
  content: string | null;
  company_name: string;
  company_domain: string | null;
  company_ticker: string | null;
  related_domains: string[] | null;
}

interface Change {
  docId: number;
  companyId: number;
  companyName: string;
  url: string;
  title: string | null;
  from: string | null;
  to: string;
  reason: string;
  hasContent: boolean;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  const where = COMPANY_FILTER ? `WHERE d.company_id = ${parseInt(COMPANY_FILTER, 10)}` : "";
  const { rows } = await pool.query<Row>(`
    SELECT
      d.id            AS doc_id,
      d.company_id    AS company_id,
      d.url           AS url,
      d.title         AS title,
      d.source_type   AS source_type,
      COALESCE(dc.content, d.content) AS content,
      c.name          AS company_name,
      c.domain        AS company_domain,
      c.ticker        AS company_ticker,
      c.related_domains AS related_domains
    FROM documents d
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN document_content dc ON dc.id = d.content_id
    ${where}
    ORDER BY d.company_id, d.id
  `);

  console.log(`Loaded ${rows.length} document rows${COMPANY_FILTER ? ` for company ${COMPANY_FILTER}` : ""}.`);
  console.log(APPLY ? "MODE: APPLY (writes source_type)" : "MODE: DRY RUN (no writes)");
  console.log("");

  // Cache per-company derived values so deriveAliases runs once per company.
  const companyCache = new Map<number, {
    domain: string;
    related: string[];
    aliases: string[];
    name: string;
    ticker: string | null;
  }>();

  const changes: Change[] = [];
  const perCompany = new Map<number, {
    name: string;
    beforeFirst: number; beforeThird: number; beforeNull: number;
    afterFirst: number; afterThird: number;
    upgraded: number; downgraded: number; withContent: number; total: number;
  }>();

  for (const r of rows) {
    if (!companyCache.has(r.company_id)) {
      companyCache.set(r.company_id, {
        domain: (r.company_domain || "").replace(/^www\./, "").toLowerCase(),
        related: (r.related_domains || []).map(d => (d || "").replace(/^www\./, "").toLowerCase()).filter(Boolean),
        aliases: deriveAliases(r.company_name || "", r.company_ticker || null),
        name: r.company_name,
        ticker: r.company_ticker,
      });
    }
    const c = companyCache.get(r.company_id)!;

    if (!perCompany.has(r.company_id)) {
      perCompany.set(r.company_id, {
        name: r.company_name,
        beforeFirst: 0, beforeThird: 0, beforeNull: 0,
        afterFirst: 0, afterThird: 0,
        upgraded: 0, downgraded: 0, withContent: 0, total: 0,
      });
    }
    const agg = perCompany.get(r.company_id)!;
    agg.total++;
    if (r.source_type === "first_party") agg.beforeFirst++;
    else if (r.source_type === "third_party") agg.beforeThird++;
    else agg.beforeNull++;
    const hasContent = !!(r.content && r.content.length > 0);
    if (hasContent) agg.withContent++;

    // Mirrors the corpus-build call site in pipeline.ts (full content available).
    const prov = classifyProvenance({
      url: r.url,
      title: r.title,
      content: r.content,
      companyDomain: c.domain,
      relatedDomains: c.related,
      companyName: c.name,
      companyTicker: c.ticker,
      companyAliases: c.aliases,
    });
    const next = provenanceToSourceType(prov.provenance);

    if (next === "first_party") agg.afterFirst++; else agg.afterThird++;

    if (next !== r.source_type) {
      if (next === "first_party") agg.upgraded++; else agg.downgraded++;
      changes.push({
        docId: r.doc_id,
        companyId: r.company_id,
        companyName: r.company_name,
        url: r.url,
        title: r.title,
        from: r.source_type,
        to: next,
        reason: prov.reason,
        hasContent,
      });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log("Per-company source_type before → after");
  console.log(
    pad("company", 26) + pad("total", 7) + pad("content", 9) +
    pad("1st→", 7) + pad("3rd→", 7) + pad("→1st", 7) + pad("→3rd", 7) +
    pad("up", 6) + pad("down", 6) + "  %3rd after"
  );
  const sortedCompanies = [...perCompany.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, a] of sortedCompanies) {
    const pct = a.total ? Math.round((100 * a.afterThird) / a.total) : 0;
    console.log(
      pad(a.name, 26) + pad(String(a.total), 7) + pad(String(a.withContent), 9) +
      pad(String(a.beforeFirst), 7) + pad(String(a.beforeThird + a.beforeNull), 7) +
      pad(String(a.afterFirst), 7) + pad(String(a.afterThird), 7) +
      pad(String(a.upgraded), 6) + pad(String(a.downgraded), 6) + `  ${pct}%`
    );
  }

  const upgraded = changes.filter(c => c.to === "first_party");
  const downgraded = changes.filter(c => c.to === "third_party");
  console.log("");
  console.log(`TOTAL: ${rows.length} rows, ${changes.length} changes (${upgraded.length} → first_party, ${downgraded.length} → third_party)`);

  console.log("");
  console.log(`Sample upgrades (third_party → first_party), up to ${SAMPLE_LIMIT}:`);
  for (const c of upgraded.slice(0, SAMPLE_LIMIT)) {
    console.log(`  [${c.companyName}] ${c.url.slice(0, 110)}`);
    console.log(`      ${c.reason}`);
  }

  console.log("");
  console.log(`Sample downgrades (first_party → third_party), up to ${SAMPLE_LIMIT}:`);
  for (const c of downgraded.slice(0, SAMPLE_LIMIT)) {
    console.log(`  [${c.companyName}] ${c.url.slice(0, 110)}`);
    console.log(`      ${c.reason}`);
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      generatedAt: new Date().toISOString(),
      totalRows: rows.length,
      changes,
      perCompany: sortedCompanies.map(([id, a]) => ({ companyId: id, ...a })),
    }, null, 2));
    console.log(`\nWrote detail to ${JSON_OUT}`);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  if (APPLY && changes.length > 0) {
    console.log("");
    console.log(`Applying ${changes.length} updates…`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const BATCH = 500;
      for (let i = 0; i < changes.length; i += BATCH) {
        const slice = changes.slice(i, i + BATCH);
        const firstIds = slice.filter(c => c.to === "first_party").map(c => c.docId);
        const thirdIds = slice.filter(c => c.to === "third_party").map(c => c.docId);
        if (firstIds.length) {
          await client.query(`UPDATE documents SET source_type = 'first_party' WHERE id = ANY($1::int[])`, [firstIds]);
        }
        if (thirdIds.length) {
          await client.query(`UPDATE documents SET source_type = 'third_party' WHERE id = ANY($1::int[])`, [thirdIds]);
        }
      }
      await client.query("COMMIT");
      console.log("Applied.");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("Rolled back:", e);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } else if (APPLY) {
    console.log("\nNothing to apply.");
  }

  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
