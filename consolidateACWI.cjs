/**
 * Bulk consolidation of the full ACWI May 26 list into ONE analysis_results
 * snapshot, built from current live company-level data under framework 7.
 * Uses a handful of bulk queries instead of per-company round-trips.
 *
 * Output JSON shape per company matches server/worker.ts saveAnalysisResultsForBatch,
 * including buildFullMeasureScores back-fill so EVERY saved company carries all
 * 34 framework measures.
 *
 *   DRY=1 node consolidateACWI.cjs   -> validate + print, no write
 *         node consolidateACWI.cjs   -> write the consolidated record
 */
const { Client } = require("pg");
const crypto = require("crypto");
const fs = require("fs");

const DB = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();
const WORKSPACE_ID = 3, LIST_ID = 4, FRAMEWORK_ID = 7;
const LIST_LABEL = "ACWI May 26 (Consolidated)";
const DRY = process.env.DRY === "1";

function buildFullMeasureScores(allMeasures, byMeasureId) {
  return allMeasures.map((m) => {
    const s = byMeasureId.get(String(m.measure_id));
    if (s) {
      return {
        measureId: s.measure_id,
        title: s.title || m.title || "",
        category: s.category || m.category || "",
        score: s.score,
        verdict: s.verdict || undefined,
        confidence: s.confidence || "Low",
        evidenceSummary: s.evidence_summary || undefined,
        quotes: s.quotes || [],
      };
    }
    return {
      measureId: m.measure_id,
      title: m.title || "",
      category: m.category || "",
      score: 0, verdict: "No", confidence: "Low",
      evidenceSummary: undefined, quotes: [], backfilled: true,
    };
  });
}

(async () => {
  const pg = new Client({ connectionString: DB, ssl: false });
  await pg.connect();

  const fwr = await pg.query("select id,name from frameworks where id=$1", [FRAMEWORK_ID]);
  const frameworkName = fwr.rows[0].name;
  const measRows = (await pg.query(
    "select measure_id,category,title from framework_measures where framework_id=$1 order by category_number,display_order",
    [FRAMEWORK_ID]
  )).rows;
  const measureCount = measRows.length;
  console.log(`[Consolidate] framework="${frameworkName}" measures=${measureCount}`);

  // Members + company fields (single query).
  const companies = (await pg.query(`
    SELECT c.id, c.name, c.isin, c.sector, c.country, c.analysis_status,
           c.total_score, c.measures_met_count, c.measures_total_count,
           c.summary, c.discovery_diagnostics
    FROM company_list_members m
    JOIN companies c ON c.id = m.company_id
    WHERE m.list_id = $1
    ORDER BY c.name ASC
  `, [LIST_ID])).rows;
  const total = companies.length;
  const completed = companies.filter(c => c.analysis_status === "completed");
  const completedIds = completed.map(c => c.id);
  console.log(`[Consolidate] total=${total} completed=${completed.length}`);

  // Bulk measure_scores for all completed companies under framework 7.
  const msByCompany = new Map();
  if (completedIds.length) {
    const ms = (await pg.query(`
      SELECT company_id, measure_id, category, title, score, verdict, confidence, evidence_summary, quotes
      FROM measure_scores
      WHERE framework_id = $1 AND company_id = ANY($2::int[])
    `, [FRAMEWORK_ID, completedIds])).rows;
    for (const r of ms) {
      if (!msByCompany.has(r.company_id)) msByCompany.set(r.company_id, new Map());
      msByCompany.get(r.company_id).set(String(r.measure_id), r);
    }
  }

  // Bulk source documents (fetch_status=ok) for all completed companies.
  const docsByCompany = new Map();
  if (completedIds.length) {
    const docs = (await pg.query(`
      SELECT company_id, url, title FROM documents
      WHERE fetch_status = 'ok' AND company_id = ANY($1::int[])
    `, [completedIds])).rows;
    for (const d of docs) {
      if (!docsByCompany.has(d.company_id)) docsByCompany.set(d.company_id, []);
      docsByCompany.get(d.company_id).push({ url: d.url, title: d.title || d.url });
    }
  }

  const resultsData = [];
  const excluded = [];
  for (const c of companies) {
    if (c.analysis_status !== "completed") { excluded.push(c); continue; }
    const byId = msByCompany.get(c.id) || new Map();
    const diag = c.discovery_diagnostics || {};
    const fc = diag.fetchCoverage || null;
    resultsData.push({
      companyId: c.id,
      companyName: c.name,
      isin: c.isin || undefined,
      sector: c.sector || undefined,
      country: c.country || undefined,
      totalScore: c.total_score || 0,
      measuresMetCount: c.measures_met_count || 0,
      measuresTotalCount: c.measures_total_count || 0,
      summary: c.summary || undefined,
      coverageLevel: diag?.coverage?.coverageLevel || "unknown",
      missingTier1: diag?.coverage?.missingTier1Types || [],
      documentsFetched: fc?.documentsFetched ?? undefined,
      documentsDiscovered: fc?.documentsDiscovered ?? undefined,
      fetchRatio: fc?.fetchRatio ?? undefined,
      lowEvidence: fc?.lowEvidence ?? undefined,
      manifest: {
        pipelineVersion: "v3l-r1",
        gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || undefined,
        candidatePoolFingerprint: diag?.candidatePoolFingerprint ?? undefined,
        finalCorpusFingerprint: diag?.finalCorpusFingerprint ?? diag?.candidateFingerprint ?? undefined,
        rankerDiagnostics: diag?.rankerDiagnostics ?? undefined,
        nearDupCollapsedGroups: diag?.nearDupCollapsedGroups ?? undefined,
        capUsed: diag?.capUsed ?? undefined,
      },
      sourceDocuments: docsByCompany.get(c.id) || [],
      measureScores: buildFullMeasureScores(measRows, byId),
    });
  }

  const saved = resultsData.length;
  const failed = excluded.length;
  const avg = saved ? Math.round(resultsData.reduce((s, r) => s + r.totalScore, 0) / saved) : 0;
  const incomplete = resultsData.filter(c => c.measureScores.length !== measureCount);

  console.log(`[Consolidate] saved=${saved} excluded=${failed} avg=${avg}`);
  console.log(`[Consolidate] reconciliation saved+excluded=${saved + failed} vs total=${total} -> ${saved + failed === total ? "OK" : "MISMATCH"}`);
  console.log(`[Consolidate] measure-completeness incomplete=${incomplete.length} -> ${incomplete.length === 0 ? "OK" : "MISMATCH"}`);
  console.log(`[Consolidate] excluded:`);
  excluded.forEach(e => console.log(`   ${e.id} ${e.name} [${e.analysis_status}]`));

  if (saved + failed !== total) { console.error("ABORT: reconciliation mismatch"); process.exit(1); }
  if (incomplete.length) { console.error("ABORT: measure-completeness failed"); process.exit(1); }

  if (DRY) { console.log("[Consolidate] DRY — no write."); await pg.end(); process.exit(0); }

  const shareToken = crypto.randomUUID();
  const ins = await pg.query(
    `INSERT INTO analysis_results
       (workspace_id, batch_id, framework_id, framework_name, list_name, results_data, companies_count, average_score, share_token, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9, now())
     RETURNING id`,
    [WORKSPACE_ID, 771, FRAMEWORK_ID, frameworkName, LIST_LABEL, JSON.stringify(resultsData), saved, avg, shareToken]
  );
  console.log(`[Consolidate] WROTE analysis_results #${ins.rows[0].id} (${saved} companies, avg ${avg}%, share ${shareToken})`);
  await pg.end();
  process.exit(0);
})().catch(e => { console.error("[Consolidate] FAILED", e.message); process.exit(1); });
