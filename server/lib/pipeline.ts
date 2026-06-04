/**
 * Pipeline Architecture (v3):
 * 
 * The pipeline is split into TWO DISTINCT PHASES:
 * 
 * Phase 1: FETCH (company-level, framework-agnostic for document storage)
 *   - Clear stale discovery cache
 *   - Discover documents via web search
 *   - Run relevance gate
 *   - Fetch ALL accepted documents (download content)
 *   - Store fetched content at the company level
 *   - Status: idle -> fetching -> fetched
 * 
 * Phase 2: ANALYZE (framework-specific)
 *   - Load all fetched documents for the company
 *   - Run LLM scoring against the active framework measures
 *   - Store scores
 *   - Status: fetched -> analyzing -> completed
 * 
 * Key benefit: Once documents are fetched for a company, they can be
 * reused across multiple framework evaluations without re-fetching.
 */

import * as storage from "../storage.js";
import { searchCompanyDocuments, type DiscoveryResult } from "./discovery.js";
import { processDocument, inferDocumentType } from "./processor.js";
import { analyzeCompanyMeasures, type AnalysisResult } from "./analyzer.js";
import type { Company, Framework, FrameworkMeasure } from "../../shared/schema.js";

export interface PipelineOptions {
  company: Company;
  framework: Framework;
  measures: FrameworkMeasure[];
  workspaceId: number;
  cancelCheck?: () => boolean;
  skipFetch?: boolean; // If true, skip fetch phase (reuse existing documents)
}

export interface PipelineResult {
  success: boolean;
  analysis?: AnalysisResult;
  error?: string;
  documentsProcessed: number;
  documentsFresh: number;
  documentsCached: number;
}

// ─── Phase 1: Fetch Documents (Company-Level) ───────────────────────────────

async function runFetchPhase(opts: {
  company: Company;
  framework: Framework;
  workspaceId: number;
  cancelCheck?: () => boolean;
}): Promise<{ fetchedCount: number; totalAccepted: number }> {
  const { company, framework, workspaceId, cancelCheck } = opts;
  const companyId = company.id;
  const companyName = company.name;

  console.log(`[${companyName}] === PHASE 1: FETCH ===`);

  // Update status to fetching
  await storage.updateCompany(companyId, workspaceId, { analysisStatus: "fetching" });

  // Step 1: Clear only PENDING (never-fetched) documents from previous runs.
  // Previously fetched documents (fetchStatus: "ok") are KEPT for reuse.
  await storage.clearDiscoveredDocuments(companyId);
  console.log(`[${companyName}] Cleared stale pending documents (cached docs preserved)`);

  // Count cached documents that already have content
  const cachedDocs = await storage.getFetchedDocuments(companyId);
  console.log(`[${companyName}] ${cachedDocs.length} cached documents available from previous runs`);

  if (cancelCheck?.()) {
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "idle" });
    return { fetchedCount: 0, totalAccepted: 0 };
  }

  // Step 2: Run discovery (web search + relevance gate)
  const trustedSources = await storage.getTrustedSources(workspaceId);
  const settings = await storage.getSettings(workspaceId);
  const searchDepth = parseInt(settings.search_depth || "10");
  const queryVariants = parseInt(settings.discovery_query_variants || "3");
  console.log(`[${companyName}] Using search depth: ${searchDepth}, query variants: ${queryVariants}`);

  const discoveryResult: DiscoveryResult = await searchCompanyDocuments({
    companyName,
    companyId,
    companyDomain: company.domain,
    isin: company.isin,
    sector: company.sector,
    country: company.country,
    pinnedUrls: (company.pinnedDocuments as string[]) || undefined,
    framework,
    trustedSources,
    searchDepth,
    queryVariants,
  });

  console.log(`[${companyName}] Discovery found ${discoveryResult.documents.length} accepted documents`);

  // Step 3: Store discovered documents in DB (company-level, no frameworkId in uniqueness)
  for (const doc of discoveryResult.documents) {
    const type = inferDocumentType(doc.url);
    await storage.upsertDocument({
      companyId,
      url: doc.url,
      title: doc.title,
      type,
      gateVerdict: "accept",
      gateReason: `Priority: ${doc.priority}, Lane: ${doc.lane}`,
    });
  }

  // Save discovery diagnostics
  await storage.updateCompany(companyId, workspaceId, {
    discoveryDiagnostics: discoveryResult.diagnostics as any,
  });

  if (cancelCheck?.()) {
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "idle" });
    return { fetchedCount: 0, totalAccepted: discoveryResult.documents.length };
  }

  // Step 4: Fetch ALL accepted documents — loop until EVERY doc is resolved (ok or dead)
  // Analysis will NOT start until zero documents remain in "pending" status.
  const companyDomain = company.domain?.replace(/^www\./, "").toLowerCase() || "";

  let newFetchCount = 0;
  let totalFetched = 0;
  let pass = 0;
  const MAX_PASSES = 4; // Each pass gives pending docs another attempt (3 failures = dead)

  while (true) {
    pass++;
    if (cancelCheck?.()) break;

    // Re-read from DB each pass to get current state
    const allDocs = await storage.getAcceptedDocuments(companyId);
    const pendingDocs = allDocs.filter((d) => d.fetchStatus === "pending");
    const okDocs = allDocs.filter((d) => d.fetchStatus === "ok");
    const deadDocs = allDocs.filter((d) => d.fetchStatus === "dead");

    totalFetched = okDocs.length;

    // EXIT CONDITION: No more pending documents — all are resolved
    if (pendingDocs.length === 0) {
      console.log(`[${companyName}] All documents resolved: ${okDocs.length} ok, ${deadDocs.length} dead`);
      break;
    }

    // Safety: don't loop forever if something is wrong
    if (pass > MAX_PASSES) {
      console.warn(`[${companyName}] Max fetch passes (${MAX_PASSES}) reached. ${pendingDocs.length} docs still pending — marking as dead.`);
      // Force-mark remaining pending docs as dead
      for (const doc of pendingDocs) {
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
      }
      break;
    }

    console.log(`[${companyName}] Fetch pass ${pass}: ${pendingDocs.length} pending, ${okDocs.length} ok, ${deadDocs.length} dead`);

    // Priority-sort: company domain first, then PDFs
    const sortedPending = [...pendingDocs].sort((a, b) => {
      const aIsCompanyDomain = companyDomain && a.url.toLowerCase().includes(companyDomain) ? 1 : 0;
      const bIsCompanyDomain = companyDomain && b.url.toLowerCase().includes(companyDomain) ? 1 : 0;
      if (aIsCompanyDomain !== bIsCompanyDomain) return bIsCompanyDomain - aIsCompanyDomain;
      const aIsPdf = a.url.toLowerCase().endsWith(".pdf") ? 1 : 0;
      const bIsPdf = b.url.toLowerCase().endsWith(".pdf") ? 1 : 0;
      if (aIsPdf !== bIsPdf) return bIsPdf - aIsPdf;
      return 0;
    });

    // Fetch each pending document
    for (const doc of sortedPending) {
      if (cancelCheck?.()) break;

      try {
        const type = inferDocumentType(doc.url);
        const content = await processDocument(doc.url, type);

        if (content && content.length > 50) {
          await storage.recordFetchSuccess(companyId, doc.url, content);
          newFetchCount++;
        } else {
          await storage.recordFetchFailure(companyId, doc.url);
        }
      } catch (error: any) {
        console.warn(`[${companyName}] Fetch failed for ${doc.url}: ${error.message}`);
        await storage.recordFetchFailure(companyId, doc.url);
      }
    }

    // Brief pause between passes to avoid hammering servers
    if (pass < MAX_PASSES) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log(`[${companyName}] Fetch phase complete: ${totalFetched} fetched, ${newFetchCount} new this run`);

  // Update status to fetched
  await storage.updateCompany(companyId, workspaceId, { analysisStatus: "fetched" });

  return { fetchedCount: totalFetched, totalAccepted: totalFetched };
}

// ─── Phase 2: Analyze Documents (Framework-Specific) ────────────────────────

async function runAnalyzePhase(opts: {
  company: Company;
  framework: Framework;
  measures: FrameworkMeasure[];
  workspaceId: number;
  cancelCheck?: () => boolean;
}): Promise<AnalysisResult | null> {
  const { company, framework, measures, workspaceId, cancelCheck } = opts;
  const companyId = company.id;
  const companyName = company.name;

  console.log(`[${companyName}] === PHASE 2: ANALYZE ===`);

  // Update status to analyzing
  await storage.updateCompany(companyId, workspaceId, { analysisStatus: "analyzing" });

  // Load all fetched documents for this company (company-level, reusable)
  const fetchedDocs = await storage.getFetchedDocuments(companyId);

  if (fetchedDocs.length === 0) {
    console.warn(`[${companyName}] No fetched documents available for analysis`);
    await storage.updateCompany(companyId, workspaceId, {
      analysisStatus: "completed",
      totalScore: 0,
      summary: "No documents could be fetched for analysis.",
    });
    await storage.clearMeasureScores(companyId);
    return null;
  }

  console.log(`[${companyName}] Analyzing with ${fetchedDocs.length} fetched documents`);

  if (cancelCheck?.()) {
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "fetched" });
    return null;
  }

  // Build document texts (from stored content)
  const documentTexts: string[] = [];
  const documentUrls: string[] = [];
  for (const doc of fetchedDocs) {
    if (doc.content) {
      documentTexts.push(doc.content);
      documentUrls.push(doc.url);
    }
  }

  // Run the LLM analysis (framework-specific scoring)
  const analysis = await analyzeCompanyMeasures({
    workspaceId,
    companyName,
    companyId,
    documentTexts,
    documentUrls,
    framework,
    measures,
  });

  // ─── 0%-GUARD: Only persist if analysis produced meaningful results ──────

  if (analysis.totalScore === 0 && analysis.categories.every(c => c.measures.every(m => m.confidence === "Low"))) {
    console.warn(`[${companyName}] 0%-guard triggered: all measures are Low-confidence zeros`);
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "failed" });
    await storage.logProcessingError({
      companyId,
      companyName,
      stage: "score",
      error: "Analysis returned 0% with all Low-confidence verdicts — likely a retrieval failure",
    });
    return null;
  }

  // ─── Persist Results ──────────────────────────────────────────────────────

  await storage.clearMeasureScores(companyId);

  const scoreRows = analysis.categories.flatMap((cat) =>
    cat.measures.map((m) => ({
      companyId,
      frameworkId: framework.id,
      measureId: m.measureId,
      category: m.category,
      categoryNumber: m.categoryNumber,
      title: m.title,
      definition: m.definition,
      score: m.score,
      coverage: m.coverage,
      confidence: m.confidence,
      evidenceSummary: m.evidenceSummary,
      quotes: m.quotes,
      verdict: m.verdict,
      verdictNuance: m.verdictNuance,
      displayOrder: m.displayOrder,
    }))
  );

  await storage.createMeasureScores(scoreRows);

  // Update company with results
  await storage.updateCompany(companyId, workspaceId, {
    totalScore: analysis.scorePercentage,
    summary: analysis.summary,
    analysisStatus: "completed",
  });

  console.log(`[${companyName}] Analysis complete: ${analysis.scorePercentage}% (${analysis.totalScore}/${measures.length} measures met)`);

  // ─── Auto-Pin Sources ──────────────────────────────────────────────────────
  // When analysis finds evidence, auto-pin those source URLs so they're always
  // re-checked in future runs (ensures consistency across iterations).
  try {
    const autoPinSettings = await storage.getSettings(workspaceId);
    if (autoPinSettings.auto_pin_sources === "true") {
      const existingPins = new Set<string>((company.pinnedDocuments as string[]) || []);
      const newPins: string[] = [];

      for (const cat of analysis.categories) {
        for (const m of cat.measures) {
          if (m.verdict === "Yes" || m.verdict === "Partial") {
            for (const quote of m.quotes) {
              if (quote.source && quote.source.startsWith("http") && !existingPins.has(quote.source)) {
                existingPins.add(quote.source);
                newPins.push(quote.source);
              }
            }
          }
        }
      }

      if (newPins.length > 0) {
        const allPins = [...((company.pinnedDocuments as string[]) || []), ...newPins];
        await storage.updateCompany(companyId, workspaceId, { pinnedDocuments: allPins });
        console.log(`[${companyName}] Auto-pinned ${newPins.length} evidence sources (total: ${allPins.length})`);
      }
    }
  } catch (pinError: any) {
    console.warn(`[${companyName}] Auto-pin failed (non-fatal): ${pinError.message}`);
  }

  return analysis;
}

// ─── Combined Pipeline (both phases in sequence) ────────────────────────────

export async function runAnalysisPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { company, framework, measures, workspaceId, cancelCheck, skipFetch } = opts;
  const companyName = company.name;
  const companyId = company.id;

  try {
    // Phase 1: Fetch (unless skipping to reuse cached docs)
    let fetchResult = { fetchedCount: 0, totalAccepted: 0 };
    if (!skipFetch) {
      fetchResult = await runFetchPhase({ company, framework, workspaceId, cancelCheck });
      
      if (cancelCheck?.()) {
        return { success: false, error: "Cancelled", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
      }

      if (fetchResult.fetchedCount === 0) {
        await storage.updateCompany(companyId, workspaceId, {
          analysisStatus: "completed",
          totalScore: 0,
          summary: "No documents could be fetched for analysis.",
        });
        return {
          success: false,
          error: "No documents could be fetched",
          documentsProcessed: 0,
          documentsFresh: fetchResult.totalAccepted,
          documentsCached: 0,
        };
      }
    } else {
      console.log(`[${companyName}] Skipping fetch phase (reusing cached documents)`);
      // Ensure status reflects we're past fetching
      await storage.updateCompany(companyId, workspaceId, { analysisStatus: "fetched" });
    }

    // Phase 2: Analyze
    const analysis = await runAnalyzePhase({ company, framework, measures, workspaceId, cancelCheck });

    if (!analysis) {
      return {
        success: false,
        error: "Analysis produced no results",
        documentsProcessed: fetchResult.fetchedCount,
        documentsFresh: fetchResult.totalAccepted,
        documentsCached: 0,
      };
    }

    return {
      success: true,
      analysis,
      documentsProcessed: fetchResult.fetchedCount,
      documentsFresh: fetchResult.totalAccepted,
      documentsCached: skipFetch ? fetchResult.fetchedCount : 0,
    };
  } catch (error: any) {
    console.error(`[${companyName}] Pipeline error: ${error.message}`);
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "failed" });
    await storage.logProcessingError({
      companyId,
      companyName,
      stage: "pipeline",
      error: `${error.message} | ${error.stack?.slice(0, 500) || ""}`,
    });
    return {
      success: false,
      error: error.message,
      documentsProcessed: 0,
      documentsFresh: 0,
      documentsCached: 0,
    };
  }
}
