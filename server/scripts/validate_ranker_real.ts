// Validate the v3l ranker against REAL stored discovered documents.
// Pulls the `documents` table per company, runs the layered ranker, and reports
// the §4 ranker diagnostics so we can confirm tie-collapse is resolved on
// production data (not just the synthetic fixture).
//
// Run: DATABASE_URL=$(cat /tmp/dburl.txt) npx tsx server/scripts/validate_ranker_real.ts

import pg from "pg";
import { rankDocuments, collapseNearDuplicates, computeRankerDiagnostics } from "../lib/ranking.js";

const { Client } = pg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();

  // Pick a spread of companies that have a decent number of stored docs.
  const companies = await client.query(`
    SELECT c.id, c.name, c.domain
    FROM companies c
    JOIN documents d ON d.company_id = c.id
    GROUP BY c.id, c.name, c.domain
    HAVING COUNT(d.id) >= 8
    ORDER BY COUNT(d.id) DESC
    LIMIT 8
  `);

  console.log(`Validating ranker on ${companies.rows.length} real companies\n`);
  let worstTie = 0;
  let worstUrlHashFrac = 0;

  for (const c of companies.rows) {
    const docsRes = await client.query(
      `SELECT url, COALESCE(title, '') AS title FROM documents WHERE company_id = $1`,
      [c.id]
    );
    const docs = docsRes.rows.map((r: any) => ({ url: r.url, title: r.title }));
    if (docs.length === 0) continue;

    const opts = { companyDomain: c.domain || null, topicPhrases: ["ai", "artificial intelligence", "governance", "risk", "responsible"] };
    const collapse = collapseNearDuplicates(docs, opts);
    const ranked = rankDocuments(collapse.kept, opts);
    const diag = computeRankerDiagnostics(ranked);
    worstTie = Math.max(worstTie, diag.largestTieCountPreUrlHash);
    worstUrlHashFrac = Math.max(worstUrlHashFrac, diag.urlhashDecisionFraction);

    console.log(`── ${c.name} (id=${c.id}) ──`);
    console.log(`   docs=${docs.length} kept=${collapse.kept.length} collapsedGroups=${collapse.collapsedGroups}`);
    console.log(`   distinctTop20=${diag.distinctPrioritiesInTop20} largestTie=${diag.largestTieCountPreUrlHash} urlHashFrac=${(diag.urlhashDecisionFraction * 100).toFixed(1)}%`);
    console.log(`   top5:`);
    for (const r of ranked.slice(0, 5)) {
      console.log(`     [c${r.signals.authorityClass} f${r.signals.fineScore.toFixed(2)}] ${r.doc.title.slice(0, 70)}`);
    }
    console.log("");
  }

  console.log("════════════════════════════════════");
  console.log(`WORST largestTiePreUrlHash across cohort: ${worstTie}  (target ≤ 3)`);
  console.log(`WORST urlHash decision fraction:          ${(worstUrlHashFrac * 100).toFixed(1)}%  (target < 10%)`);
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
