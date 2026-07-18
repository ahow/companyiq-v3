/**
 * Build ONE consolidated Results snapshot for the full ACWI May 26 list (2,443
 * companies) from the current live company-level data, using the SAME field
 * shape and the SAME buildFullMeasureScores back-fill logic the server uses in
 * saveAnalysisResultsForBatch. This reflects all recovery work (incl. batch 771)
 * because it reads each company's current scores under the active framework (7).
 *
 * Reconciliation: saved(completed) + failed must equal total list membership.
 * Companies that are not `completed` are EXCLUDED from the snapshot and reported.
 *
 * Usage:  DRY=1 tsx consolidateACWI.ts   (no write, prints summary)
 *         tsx consolidateACWI.ts         (writes the consolidated record)
 */
import crypto from "crypto";
import * as storage from "./server/storage.js";
import { db } from "./server/db.js";
import { sql } from "drizzle-orm";

const WORKSPACE_ID = 3;
const LIST_ID = 4;            // ACWI May 26
const FRAMEWORK_ID = 7;       // active "AI Governance and Strategy Assessment Framework" (34 measures)
const LIST_LABEL = "ACWI May 26 (Consolidated)";
const DRY = process.env.DRY === "1";

// Mirror of server/worker.ts buildFullMeasureScores (kept identical).
function buildFullMeasureScores(allMeasures: any[], scores: any[]): any[] {
  const byId = new Map<string, any>();
  for (const s of scores) byId.set(String(s.measureId), s);
  return allMeasures.map((m: any) => {
    const s = byId.get(String(m.measureId));
    if (s) {
      return {
        measureId: s.measureId,
        title: s.title || m.title || "",
        category: s.category || m.category || "",
        score: s.score,
        verdict: s.verdict || undefined,
        confidence: s.confidence || "Low",
        evidenceSummary: s.evidenceSummary || undefined,
        quotes: s.quotes || [],
      };
    }
    return {
      measureId: m.measureId,
      title: m.title || "",
      category: m.category || "",
      score: 0,
      verdict: "No",
      confidence: "Low",
      evidenceSummary: undefined,
      quotes: [],
      backfilled: true,
    };
  });
}

async function main() {
  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error("Framework not found");
  const allMeasures = await storage.getFrameworkMeasures(FRAMEWORK_ID);
  const measureCount = allMeasures.length;
  console.log(`[Consolidate] framework="${framework.name}" measures=${measureCount}`);

  // Full ACWI membership (ordered for stable output).
  const members = await db.execute(sql`
    SELECT c.id, c.name, c.analysis_status
    FROM company_list_members m
    JOIN companies c ON c.id = m.company_id
    WHERE m.list_id = ${LIST_ID}
    ORDER BY c.name ASC
  `);
  const total = members.rows.length;
  console.log(`[Consolidate] ACWI total members=${total}`);

  const resultsData: any[] = [];
  const excluded: Array<{ id: number; name: string; status: string }> = [];

  for (const row of members.rows as any[]) {
    const company = await storage.getCompanyById(row.id, WORKSPACE_ID);
    if (!company) { excluded.push({ id: row.id, name: row.name, status: "missing" }); continue; }
    if (company.analysisStatus !== "completed") {
      excluded.push({ id: company.id, name: company.name, status: company.analysisStatus });
      continue;
    }

    const scores = await storage.getMeasureScores(company.id, FRAMEWORK_ID);
    const docs = await storage.getFetchedDocuments(company.id);
    const sourceDocuments = docs.map((d: any) => ({ url: d.url, title: d.title || d.url }));
    const diagnostics = company.discoveryDiagnostics as any;
    const coverageLevel = diagnostics?.coverage?.coverageLevel || "unknown";
    const missingTier1 = diagnostics?.coverage?.missingTier1Types || [];
    const fetchCoverage = diagnostics?.fetchCoverage || null;
    const manifest = {
      pipelineVersion: "v3l-r1",
      gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || undefined,
      candidatePoolFingerprint: diagnostics?.candidatePoolFingerprint ?? undefined,
      finalCorpusFingerprint: diagnostics?.finalCorpusFingerprint ?? diagnostics?.candidateFingerprint ?? undefined,
      rankerDiagnostics: diagnostics?.rankerDiagnostics ?? undefined,
      nearDupCollapsedGroups: diagnostics?.nearDupCollapsedGroups ?? undefined,
      capUsed: diagnostics?.capUsed ?? undefined,
    };

    resultsData.push({
      companyId: company.id,
      companyName: company.name,
      isin: company.isin || undefined,
      sector: company.sector || undefined,
      country: company.country || undefined,
      totalScore: company.totalScore || 0,
      measuresMetCount: company.measuresMetCount || 0,
      measuresTotalCount: company.measuresTotalCount || 0,
      summary: company.summary || undefined,
      coverageLevel,
      missingTier1,
      documentsFetched: fetchCoverage?.documentsFetched ?? undefined,
      documentsDiscovered: fetchCoverage?.documentsDiscovered ?? undefined,
      fetchRatio: fetchCoverage?.fetchRatio ?? undefined,
      lowEvidence: fetchCoverage?.lowEvidence ?? undefined,
      manifest,
      sourceDocuments,
      measureScores: buildFullMeasureScores(allMeasures, scores),
    });
  }

  const saved = resultsData.length;
  const failed = excluded.length;
  const avgScore = saved > 0 ? Math.round(resultsData.reduce((s, r) => s + r.totalScore, 0) / saved) : 0;

  // Measure-completeness assertion.
  const incomplete = resultsData.filter(c => !Array.isArray(c.measureScores) || c.measureScores.length !== measureCount);

  console.log(`[Consolidate] saved=${saved} excluded(failed/other)=${failed} avg=${avgScore}`);
  console.log(`[Consolidate] reconciliation: saved+excluded=${saved + failed} vs total=${total} -> ${saved + failed === total ? "OK" : "MISMATCH"}`);
  console.log(`[Consolidate] measure-completeness: incomplete=${incomplete.length} -> ${incomplete.length === 0 ? "OK" : "MISMATCH"}`);
  console.log(`[Consolidate] excluded companies:`);
  excluded.forEach(e => console.log(`   ${e.id} ${e.name} [${e.status}]`));

  if (saved + failed !== total) throw new Error("Reconciliation mismatch — aborting write.");
  if (incomplete.length !== 0) throw new Error("Measure-completeness failed — aborting write.");

  if (DRY) { console.log("[Consolidate] DRY run — not writing."); await db.execute(sql`SELECT 1`); process.exit(0); }

  const shareToken = crypto.randomUUID();
  const rec = await storage.saveAnalysisResults({
    workspaceId: WORKSPACE_ID,
    batchId: 771,                       // associate with the final recovery batch
    frameworkId: FRAMEWORK_ID,
    frameworkName: framework.name,
    listName: LIST_LABEL,
    resultsData,
    companiesCount: saved,
    averageScore: avgScore,
    shareToken,
  });
  console.log(`[Consolidate] WROTE analysis_results #${(rec as any).id} (${saved} companies, avg ${avgScore}%, share ${shareToken})`);
  process.exit(0);
}

main().catch(e => { console.error("[Consolidate] FAILED", e.message); process.exit(1); });
