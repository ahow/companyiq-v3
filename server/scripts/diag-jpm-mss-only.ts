/**
 * Controlled test: run JPM's fw8 (modern slavery) analysis with ONLY the MSS PDFs
 * as input — no SEC filings, no proxy statements, no other docs.
 *
 * Purpose: disambiguate retrieval vs scoring as the ceiling. If the LLM verdicts
 * "Yes" on modern-slavery measures when given only MSS content, the retrieval
 * pipeline is the last-mile problem and further retrieval fixes will move the
 * needle. If it STILL says "No", the scoring rubric / prompt is the ceiling
 * and further retrieval work is wasted.
 *
 * Usage: tsx server/scripts/diag-jpm-mss-only.ts
 */
import * as storage from "../storage.js";
import { analyzeCompanyMeasures } from "../lib/analyzer.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";

const JPM_COMPANY_ID = 521;
const FW8_FRAMEWORK_ID = 8;
const WORKSPACE_ID = 3;

async function main() {
  const company = await storage.getCompanyById(JPM_COMPANY_ID, WORKSPACE_ID);
  if (!company) throw new Error("JPM not found");
  const framework = await storage.getFrameworkById(FW8_FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error("fw8 not found");
  const measures = await storage.getFrameworkMeasures(FW8_FRAMEWORK_ID);
  console.log(`Company: ${company.name}`);
  console.log(`Framework: ${framework.name} (${measures.length} measures)`);

  // Load ONLY MSS docs for JPM. Filter: title OR url contains 'slavery' (any case).
  // Read directly via SQL to bypass any content-strip on API paths.
  const rows = await db.execute(sql`
    SELECT d.id, d.url, d.title, d.fetch_status,
           COALESCE(dc.content, d.content) AS content
    FROM documents d
    LEFT JOIN document_content dc ON dc.id = d.content_id
    WHERE d.company_id = ${JPM_COMPANY_ID}
      AND (lower(d.url) LIKE '%slavery%' OR lower(d.title) LIKE '%slavery%')
      AND d.fetch_status = 'ok'
      AND COALESCE(dc.content_length, length(d.content)) > 50
    ORDER BY d.id
  `);
  const docs: any[] = (rows.rows as any[]).filter((r) => r.content && r.content.length > 50);

  console.log(`\nMSS docs with content: ${docs.length}`);
  for (const d of docs) {
    console.log(`  id=${d.id} status=${d.fetch_status} len=${d.content.length} title=${(d.title || "").slice(0, 70)}`);
    console.log(`     url=${d.url}`);
  }

  if (docs.length === 0) {
    console.log("\nNo MSS docs with content found — cannot run controlled test.");
    process.exit(1);
  }

  // Assemble analyzer inputs from ONLY the MSS docs.
  const documentTexts = docs.map((d) => d.content as string);
  const documentUrls = docs.map((d) => d.url as string);
  const documentTitles = docs.map((d) => d.title as string);
  const totalChars = documentTexts.reduce((s, t) => s + t.length, 0);
  console.log(`\nTotal MSS corpus chars: ${totalChars}`);

  const t0 = Date.now();
  const analysis = await analyzeCompanyMeasures({
    workspaceId: WORKSPACE_ID,
    companyName: company.name,
    companyId: JPM_COMPANY_ID,
    documentTexts,
    documentUrls,
    documentTitles,
    framework: framework as any,
    measures: measures as any,
    freshScoring: true, // never reuse a cached verdict — this is a probe
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log(`\n=== MSS-ONLY RESULT (${secs}s) ===`);
  console.log(`Total score: ${analysis.scorePercentage}%`);
  console.log(`\nAll 31 measure verdicts:`);
  const allM = analysis.categories.flatMap((c: any) => c.measures);
  for (const m of allM) {
    const v = m.verdict || "?";
    const s = m.score ?? "?";
    const c = m.confidence || "?";
    const abst = (m as any).abstained ? " [ABSTAINED]" : "";
    console.log(`  ${m.measureId.padEnd(45)} verdict=${v.padEnd(10)} score=${s} conf=${c}${abst}`);
  }

  // Focus report on the 5 slavery measures 1.1..1.5 (the ones directly answerable
  // from MSS content).
  const slaveryMeasures = allM.filter((m: any) =>
    /^1\.[1-5]-/.test(m.measureId || "") ||
    /slavery|human.rights|trafficking|due.diligence/.test((m.title || "").toLowerCase())
  );
  console.log(`\nFocus (5 slavery measures) — detailed:`);
  for (const m of slaveryMeasures.slice(0, 6)) {
    console.log(`\n=== ${m.measureId} (${m.title}) ===`);
    console.log(`  verdict=${m.verdict} score=${m.score} conf=${m.confidence}`);
    console.log(`  evidenceSummary: ${(m.evidenceSummary || "").slice(0, 500)}`);
    const qs = (m.quotes || []).filter((q: any) => q.sourceUrl !== "diag://retrieval-v1");
    console.log(`  Quotes (${qs.length}):`);
    for (const q of qs.slice(0, 3)) {
      console.log(`    "${(q.text || "").slice(0, 220)}"`);
      console.log(`      source: ${q.source || q.sourceUrl}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
