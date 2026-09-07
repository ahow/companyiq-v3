/* Repro of /v2/improvement/chat pre-LLM stages against prod DB. Diagnostic only. */
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { analyseTestDrive } from "../lib/framework-v2/test-drive.js";
import { proposeEditsForFlags } from "../lib/framework-v2/edit-proposer.js";
import { diagnoseRootCauses } from "../lib/framework-v2/root-cause-diagnostic.js";
import { detectTerminologyGaps } from "../lib/framework-v2/test-drive.js";
import { buildImprovementChatSystemPrompt } from "../lib/framework-v2/improvement-chat.js";

const frameworkId = Number(process.argv[2] || 3);
const listId = Number(process.argv[3] || 2);
const workspaceId = 1;

function stage(n: string) { console.log(`\n=== STAGE: ${n} ===`); }

async function main() {
  stage("fw meta");
  const fwRow = await db.execute(sql`SELECT name, topic_term FROM frameworks WHERE id = ${frameworkId} AND workspace_id = ${workspaceId}`);
  const fwMeta = ((fwRow as any).rows || [])[0] || {};
  console.log("fwMeta:", JSON.stringify(fwMeta));

  stage("scores");
  const scoresQuery = await db.execute(sql`
    SELECT ms.company_id, c.name AS company_name, ms.measure_id, ms.verdict
    FROM measure_scores ms
    JOIN companies c ON c.id = ms.company_id
    JOIN company_list_members clm ON clm.company_id = c.id AND clm.list_id = ${listId}
    WHERE ms.framework_id = ${frameworkId}`);
  const scoreRows = ((scoresQuery as any).rows || []) as any[];
  console.log("scoreRows:", scoreRows.length);
  const byCompany: Record<string, any> = {};
  for (const r of scoreRows) {
    const k = String(r.company_id);
    if (!byCompany[k]) byCompany[k] = { companyId: r.company_id, companyName: r.company_name, measures: [] };
    byCompany[k].measures.push({ measureId: r.measure_id, verdict: r.verdict || "No" });
  }
  const results = Object.values(byCompany) as any[];
  const perCompanySummary = results.map((r) => {
    const yes = r.measures.filter((m: any) => m.verdict === "Yes").length;
    return { companyName: r.companyName, yesCount: yes, yesRate: r.measures.length ? yes / r.measures.length : 0 };
  });
  console.log("results companies:", results.length);

  stage("measure meta");
  const measureMetaQuery = await db.execute(sql`
    SELECT measure_id, expected_yes_rate, title, substantive_definition, fallback_yes_criterion,
           positive_examples, negative_examples, min_quote_context_chars, disclosure_vehicles
    FROM framework_measures WHERE framework_id = ${frameworkId}`);
  const measureRows = ((measureMetaQuery as any).rows || []) as any[];
  console.log("measureRows:", measureRows.length);
  const measureMetadata = measureRows.map((m: any) => ({
    measureId: m.measure_id,
    expected_yes_rate: typeof m.expected_yes_rate === "number" ? m.expected_yes_rate : 0.35,
  }));
  const measuresById: Record<string, any> = {};
  for (const m of measureRows) measuresById[m.measure_id] = m;

  stage("analyseTestDrive");
  const report = analyseTestDrive(results as any, measureMetadata);
  console.log("flags:", (report.flags || []).length);

  stage("proposeEditsForFlags");
  const editsBundle = proposeEditsForFlags(report.flags || [], measuresById);
  console.log("proposals:", editsBundle.proposals.length);

  stage("batch lookup");
  const batchRow = await db.execute(sql`
    SELECT id FROM batch_runs WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${workspaceId}
    ORDER BY started_at DESC LIMIT 1`);
  const batchId = (batchRow as any).rows?.[0]?.id;
  console.log("batchId:", batchId);

  let rootCauses: any = null;
  const corpusTexts = new Map<string, string>();
  let topicSynonymsForGap: string[] = [];
  if (batchId) {
    stage("topic synonyms");
    const topicRow = await db.execute(sql`SELECT topic_synonyms FROM frameworks WHERE id = ${frameworkId}`);
    const topicSynonyms = ((topicRow as any).rows?.[0]?.topic_synonyms) || [];
    console.log("topicSynonyms type:", Array.isArray(topicSynonyms) ? "array" : typeof topicSynonyms, JSON.stringify(topicSynonyms).slice(0, 200));
    topicSynonymsForGap = Array.isArray(topicSynonyms) ? topicSynonyms : [];
    const termsLc = [String(fwMeta.topic_term || "").toLowerCase(), ...topicSynonyms.map((s: string) => s.toLowerCase())].filter(Boolean);

    stage("corpus rows");
    const corpusRows = await db.execute(sql`
      SELECT bc.company_id, c.name AS company_name, d.type, d.title,
             LENGTH(COALESCE(d.content, dc.content, '')) AS len,
             COALESCE(d.content, dc.content, '') AS text
      FROM batch_corpus bc JOIN companies c ON c.id = bc.company_id
      JOIN documents d ON d.id = bc.document_id
      LEFT JOIN document_content dc ON dc.id = d.content_id
      WHERE bc.batch_id = ${batchId}`);
    const cr = ((corpusRows as any).rows || []);
    console.log("corpusRows:", cr.length);
    const perCompStats: Record<string, any> = {};
    for (const r of cr) {
      const cid = Number(r.company_id); const k = String(cid);
      if (!perCompStats[k]) perCompStats[k] = { companyId: cid, companyName: r.company_name, docCount: 0, totalChars: 0, pdfCount: 0, thematicReportCount: 0, topicTermMentions: 0, topicMentioningDocs: 0, yesCount: 0, totalMeasures: 0 };
      const s = perCompStats[k]; s.docCount++; s.totalChars += Number(r.len || 0);
      if (String(r.type || "").toLowerCase() === "pdf") s.pdfCount++;
      const titleLc = String(r.title || "").toLowerCase();
      if (titleLc.includes("sustainability") || titleLc.includes("tnfd")) s.thematicReportCount++;
      const textLc = String(r.text || "").toLowerCase(); let docMentions = 0;
      for (const t of termsLc) { let i = textLc.indexOf(t); while (i !== -1) { docMentions++; i = textLc.indexOf(t, i + t.length); } }
      s.topicTermMentions += docMentions; if (docMentions > 0) s.topicMentioningDocs++;
      const existing = corpusTexts.get(r.company_name) ?? "";
      if (existing.length < 200_000) corpusTexts.set(r.company_name, existing + " " + textLc.slice(0, 50000));
    }
    for (const r of results) {
      const k = String(r.companyId);
      if (perCompStats[k]) { perCompStats[k].yesCount = r.measures.filter((m: any) => m.verdict === "Yes").length; perCompStats[k].totalMeasures = r.measures.length; }
    }
    const scoresByCM: Record<string, Record<string, string>> = {};
    for (const r of results) { const k = String(r.companyId); scoresByCM[k] = {}; for (const m of r.measures) scoresByCM[k][m.measureId] = m.verdict; }
    stage("diagnoseRootCauses");
    rootCauses = diagnoseRootCauses(Object.values(perCompStats), measureMetadata.map((m: any) => m.measureId), scoresByCM);
    console.log("rootCauses headline:", rootCauses?.headline);
  }
  if (!rootCauses) {
    rootCauses = { companies: [], measures: [], summary: { docCollectionFailures: 0, frameworkIssues: 0, healthy: 0, ambiguous: 0, deadMeasuresLikelyFrameworkFault: 0, deadMeasuresLikelyCorpusFault: 0 }, headline: "stub" };
  }

  stage("detectTerminologyGaps");
  let terminologyGapResult: any = null;
  if (corpusTexts.size > 0) terminologyGapResult = detectTerminologyGaps(corpusTexts, topicSynonymsForGap, String(fwMeta.topic_term || ""));
  console.log("terminologyGaps:", terminologyGapResult?.missingTerms?.length ?? "n/a");

  stage("vehicle mismatch");
  const vehicleMismatches: any[] = [];
  const measuresWithVehicles = measureRows.filter((m: any) => Array.isArray(m.disclosure_vehicles) && m.disclosure_vehicles.length > 0);
  console.log("measuresWithVehicles:", measuresWithVehicles.length);

  stage("buildImprovementChatSystemPrompt");
  const chatCtx: any = {
    frameworkName: fwMeta.name,
    topicTerm: fwMeta.topic_term,
    perCompanySummary,
    rootCauses,
    flags: report.flags || [],
    proposals: editsBundle.proposals,
    passedRobustnessCriteria: 0,
    totalRobustnessCriteria: 6,
    terminologyGaps: terminologyGapResult?.missingTerms,
    vehicleMismatches: vehicleMismatches.length > 0 ? vehicleMismatches : undefined,
  };
  const system = buildImprovementChatSystemPrompt(chatCtx);
  console.log("system prompt length:", system.length);

  stage("LLM call (real system prompt)");
  const { completeWithFallback } = await import("../lib/ai-providers.js");
  const { extractActionsFromReply } = await import("../lib/framework-v2/improvement-chat.js");
  const messages = [{ role: "user", content: "Why did Ambev score 0? What should I change?" }];
  const history = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  const t0 = Date.now();
  const { text: reply, provider } = await completeWithFallback("claude", {
    system, prompt: history + "\n\nAssistant:", maxTokens: 4000, temperature: 0.2,
  });
  console.log(`LLM OK in ${Date.now()-t0}ms via ${provider}, reply len=${reply.length}`);
  const { displayText, actions } = extractActionsFromReply(reply);
  console.log("displayText len:", displayText.length, "actions:", actions.length);
  console.log("reply preview:", displayText.slice(0, 300));
  console.log("\n=== FULL END-TO-END PASSED ===");
  process.exit(0);
}
main().catch((e) => { console.error("\n!!! THREW:", e); process.exit(1); });
