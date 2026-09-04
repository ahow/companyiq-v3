/**
 * R2 impact retro-simulation.
 *
 * For every list-2 iter-13 corpus document, re-classifies with the R2
 * classifier and reports how many docs would flip source_type.
 *
 * Reports:
 *  - Total docs classified
 *  - Docs that would flip third_party -> issuer under R2
 *  - Docs that would flip issuer -> third_party (would be a regression)
 *  - Per-company summary
 *  - Full flip list for audit
 *
 * Does NOT write to DB. Purely observational.
 */

import { Client } from "pg";
import { classifyProvenance } from "../server/lib/provenance.js";
import { resolveCikForCompany } from "../server/lib/discovery.js";
import { deriveAliases } from "../server/lib/issuer-resolver.js";

const DB = process.env.DATABASE_URL ||
  "postgresql://postgres:ciq3securepass2024@hayabusa.proxy.rlwy.net:57064/companyiq_v3";

interface DocRow {
  id: number;
  url: string;
  title: string | null;
  currentSourceType: string | null;
  content: string | null;
}

interface Company {
  id: number;
  name: string;
  domain: string | null;
  relatedDomains: string[] | null;
  ticker: string | null;
  isin: string | null;
  country: string | null;
}

async function main() {
  const c = new Client({ connectionString: DB, connect_timeout: 10 });
  await c.connect();

  const cos = await c.query(`
    select co.id, co.name, co.domain, co.related_domains, co.ticker, co.isin, co.country
      from companies co
      join company_list_members m on m.company_id = co.id
     where m.list_id = 2
     order by co.name
  `);
  const companies: Company[] = cos.rows.map((r: any) => ({
    id: r.id, name: r.name, domain: r.domain,
    relatedDomains: r.related_domains, ticker: r.ticker,
    isin: r.isin, country: r.country,
  }));
  console.log(`Loaded ${companies.length} companies`);

  const flipsUpgrade: Array<any> = [];
  const flipsDowngrade: Array<any> = [];
  const perCompany: Record<string, { total: number; up: number; down: number; sameFP: number; sameTP: number }> = {};

  for (const co of companies) {
    perCompany[co.name] = { total: 0, up: 0, down: 0, sameFP: 0, sameTP: 0 };
    // Fetch corpus for this company
    const docs = await c.query(`
      select d.id, d.url, d.title, d.source_type as current_source_type,
             coalesce(dc.content, '') as content
        from batch_corpus bc
        join documents d on d.id = bc.document_id
        left join document_content dc on dc.id = d.content_id
       where bc.batch_id = 16 and bc.company_id = $1
    `, [co.id]);
    const aliases = deriveAliases(co.name, co.ticker);
    const cik = await resolveCikForCompany({
      companyName: co.name, ticker: co.ticker, country: co.country, isin: co.isin,
    });
    for (const d of docs.rows) {
      const prov = classifyProvenance({
        url: d.url,
        title: d.title,
        content: (d.content || "").slice(0, 8192),
        companyDomain: co.domain,
        relatedDomains: co.relatedDomains,
        companyName: co.name,
        companyTicker: co.ticker,
        companyAliases: aliases,
        companyIsin: co.isin,
        companySecCik: cik,
      });
      const newLabel = prov.provenance === "issuer" ? "first_party" : "third_party";
      const oldLabel = d.current_source_type;
      const bucket = perCompany[co.name];
      bucket.total++;
      if (oldLabel === "third_party" && newLabel === "first_party") {
        bucket.up++;
        flipsUpgrade.push({
          company: co.name, url: d.url, title: d.title,
          reason: prov.reason, tier: prov.identitySignal,
        });
      } else if (oldLabel === "first_party" && newLabel === "third_party") {
        bucket.down++;
        flipsDowngrade.push({
          company: co.name, url: d.url, title: d.title,
          reason: prov.reason, tier: prov.identitySignal,
        });
      } else if (newLabel === "first_party") {
        bucket.sameFP++;
      } else {
        bucket.sameTP++;
      }
    }
  }

  // Report
  console.log(`\nPer-company R2 classification impact:`);
  console.log(`  ${"Company".padEnd(30)} ${"n".padStart(4)} ${"\u2191fp".padStart(4)} ${"\u2193tp".padStart(4)} ${"=fp".padStart(4)} ${"=tp".padStart(4)}`);
  for (const [name, s] of Object.entries(perCompany).sort()) {
    console.log(`  ${name.padEnd(30)} ${String(s.total).padStart(4)} ${String(s.up).padStart(4)} ${String(s.down).padStart(4)} ${String(s.sameFP).padStart(4)} ${String(s.sameTP).padStart(4)}`);
  }
  const totalUp = Object.values(perCompany).reduce((s, v) => s + v.up, 0);
  const totalDown = Object.values(perCompany).reduce((s, v) => s + v.down, 0);
  const totalN = Object.values(perCompany).reduce((s, v) => s + v.total, 0);
  console.log(`\nTotals: n=${totalN}, upgraded ${totalUp}, downgraded ${totalDown}`);

  console.log(`\n=== UPGRADES (third_party -> first_party, ${flipsUpgrade.length}) ===`);
  for (const f of flipsUpgrade) {
    console.log(`  ${f.company} | tier=${f.tier}`);
    console.log(`    ${(f.title || "").slice(0, 80)}`);
    console.log(`    ${f.url.slice(0, 100)}`);
    console.log(`    reason: ${f.reason}`);
  }

  if (flipsDowngrade.length > 0) {
    console.log(`\n=== DOWNGRADES (first_party -> third_party, ${flipsDowngrade.length}) ===`);
    for (const f of flipsDowngrade) {
      console.log(`  ${f.company} | tier=${f.tier}`);
      console.log(`    ${(f.title || "").slice(0, 80)}`);
      console.log(`    ${f.url.slice(0, 100)}`);
      console.log(`    reason: ${f.reason}`);
    }
  } else {
    console.log(`\nNo downgrades \u2014 R2 is strictly recall-additive on this cohort.`);
  }

  await c.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
