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
 * 
 * TIMEOUT ARCHITECTURE:
 * - Per-document fetch: 45 seconds (prevents a single URL from blocking)
 * - Fetch phase budget: 5 minutes (stops fetching and proceeds with what we have)
 * - Per-company pipeline: 8 minutes (hard cap — ensures batch always completes)
 */

import * as storage from "../storage.js";
import { searchCompanyDocuments, type DiscoveryResult } from "./discovery.js";
import { processDocument, inferDocumentType } from "./processor.js";
import { analyzeCompanyMeasures, type AnalysisResult } from "./analyzer.js";
import { runTemporalValidation, type TemporalContext } from "./temporal-validation.js";
import { shouldVerifyDocument, verifyDocumentCompany } from "./company-verification.js";
import type { Company, Framework, FrameworkMeasure } from "../../shared/schema.js";

// ─── Timeout Constants ──────────────────────────────────────────────────────
// NOTE: these must all stay below the BullMQ queue/worker lockDuration (10 min)
// so a single long-running company never exceeds its lock. Large annual-report
// PDFs can take 60–90s to download, so the per-document timeout must exceed the
// processor's binary fetch timeout (FETCH_TIMEOUT_BINARY, default 90s) to let a
// legitimately slow download finish instead of being cut off and marked dead.
const PIPELINE_TIMEOUT_MS = parseInt(process.env.PIPELINE_TIMEOUT_MS || "540000", 10); // 9 min
const FETCH_PHASE_BUDGET_MS = parseInt(process.env.FETCH_PHASE_BUDGET_MS || "360000", 10); // 6 min
const PER_DOCUMENT_TIMEOUT_MS = parseInt(process.env.PER_DOCUMENT_TIMEOUT_MS || "100000", 10); // 100 sec
// Max documents fetched concurrently WITHIN a single company. Kept small so it
// composes safely with worker concurrency and the shared browser-slot pool
// (MAX_CONCURRENT_BROWSER): worst-case browser demand ~= WORKER_CONCURRENCY but
// the per-process browser pool caps actual Chromium use regardless. Quality is
// unaffected — the same fetch+verify runs per doc, just overlapped.
const INCOMPANY_FETCH_CONCURRENCY = parseInt(process.env.INCOMPANY_FETCH_CONCURRENCY || "4", 10);

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

// ─── Timeout Helper ─────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
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
  const fetchPhaseStart = Date.now();

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
  // Global platform sources (shared multi-tenant hosts). Documents on these
  // hosts are ALWAYS issuer-verified, overriding the own-domain fast-path.
  const platformHosts = await storage.getActivePlatformHosts();
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

  // Persist an auto-detected domain back to the company record so future runs
  // (and the Domains dashboard) have it, and so contamination heuristics can
  // rely on a stored domain. Only write when the company had no domain set and
  // discovery confidently auto-detected one.
  if (
    discoveryResult.domainAutoDetected &&
    discoveryResult.effectiveDomain &&
    !company.domain
  ) {
    try {
      await storage.updateCompany(companyId, workspaceId, {
        domain: discoveryResult.effectiveDomain,
      });
      // Keep the in-memory company object in sync for the rest of this run
      (company as any).domain = discoveryResult.effectiveDomain;
      console.log(`[${companyName}] Persisted auto-detected domain: ${discoveryResult.effectiveDomain}`);
    } catch (e: any) {
      console.warn(`[${companyName}] Failed to persist auto-detected domain: ${e.message}`);
    }
  }

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

  // Step 3b: Cross-workspace document reuse — if content already exists in
  // document_content (from another workspace's fetch), link it immediately
  // so we don't re-fetch the same URL.
  const reusedCount = await storage.linkExistingContent(companyId);
  if (reusedCount > 0) {
    console.log(`[${companyName}] Reused ${reusedCount} documents from global content cache (cross-workspace)`);

    // CONTAMINATION FIX: cache-linked documents are marked 'needs_verify' (not
    // 'ok') because the global content cache is shared by URL across ALL
    // companies — a shared-CDN URL fetched for another issuer (e.g. a Pfizer
    // 10-K on s206.q4cdn.com) must NOT be silently trusted for this company.
    // Run the SAME issuer verification used in the fetch loop, but on the
    // already-cached content (no network re-fetch). Own-domain docs fast-path
    // to 'ok' with no LLM cost, exactly like the fetch loop.
    const toVerify = await storage.getDocumentsNeedingVerification(companyId);
    let reuseKept = 0, reuseRejected = 0;
    for (const d of toVerify) {
      const content = d.content || "";
      if (content.length <= 50) {
        // No usable cached content — drop back to normal fetch path.
        await storage.recordFetchFailure(companyId, d.url);
        continue;
      }
      if (!shouldVerifyDocument({ url: d.url, verifiedDomain: company.domain, platformHosts })) {
        await storage.markLinkedDocumentVerified(companyId, d.url);
        reuseKept++;
        continue;
      }
      try {
        const vr = await verifyDocumentCompany(
          {
            name: companyName,
            isin: company.isin,
            sector: company.sector,
            country: company.country,
            ticker: company.ticker,
            verifiedDomain: company.domain,
          },
          { url: d.url, title: d.title, content }
        );
        if (vr.verdict === "match") {
          await storage.markLinkedDocumentVerified(companyId, d.url);
          reuseKept++;
        } else if (vr.verdict === "error") {
          // Fail-safe: same cheap name-mention heuristic as the fetch loop.
          const contentLower = content.toLowerCase();
          const companyNameLower = companyName.toLowerCase();
          const nameWords = companyNameLower
            .split(/[\s,\.\-&]+/)
            .filter(w => w.length >= 4 && !['inc', 'ltd', 'plc', 'corp', 'group', 'the', 'and', 'company', 'limited', 'corporation', 'holdings', 'international'].includes(w));
          const fallbackMentions = (companyNameLower.length >= 4 && contentLower.includes(companyNameLower))
            || nameWords.some(w => contentLower.includes(w));
          if (fallbackMentions) {
            console.warn(`[${companyName}] REUSE VERIFY ERROR (${vr.reason}); kept via name-mention fallback: ${d.url.slice(0, 80)}`);
            await storage.markLinkedDocumentVerified(companyId, d.url);
            reuseKept++;
          } else {
            console.warn(`[${companyName}] REUSE VERIFY ERROR (${vr.reason}); no name mention — rejected: ${d.url.slice(0, 80)}`);
            await storage.recordVerificationReject(companyId, d.url, `error — ${vr.reason}`);
            reuseRejected++;
          }
        } else {
          const issuer = vr.detectedIssuer ? `: ${vr.detectedIssuer}` : '';
          console.warn(`[${companyName}] REUSE POST-FETCH REJECT (${vr.verdict}${issuer}): ${d.url.slice(0, 80)} — ${vr.reason}`);
          await storage.recordVerificationReject(companyId, d.url, `${vr.verdict}${issuer} — ${vr.reason}`);
          reuseRejected++;
        }
      } catch (e: any) {
        // On unexpected error, reject conservatively to avoid contamination.
        console.warn(`[${companyName}] REUSE VERIFY EXCEPTION; rejected: ${d.url.slice(0, 80)} — ${e?.message?.slice(0, 120)}`);
        await storage.recordVerificationReject(companyId, d.url, `error — verify exception`);
        reuseRejected++;
      }
    }
    if (toVerify.length > 0) {
      console.log(`[${companyName}] Reuse verification: ${reuseKept} kept, ${reuseRejected} rejected (of ${toVerify.length})`);
    }
  }

  // Save discovery diagnostics (includes coverage metric)
  await storage.updateCompany(companyId, workspaceId, {
    discoveryDiagnostics: discoveryResult.diagnostics as any,
  });

  // Log coverage level for monitoring
  const coverage = discoveryResult.diagnostics.coverage;
  if (coverage) {
    console.log(`[${companyName}] Document coverage: ${coverage.coverageLevel} | Tier1: ${coverage.tier1Count}, Tier2: ${coverage.tier2Count}, Tier3: ${coverage.tier3Count}`);
    if (coverage.coverageLevel === "minimal" || coverage.coverageLevel === "low") {
      console.warn(`[${companyName}] LOW COVERAGE WARNING: Missing ${coverage.missingTier1Types.join(", ") || "key filings"}. Results may be unreliable.`);
    }
  }

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
  let fetchBudgetExceeded = false;

  while (true) {
    pass++;
    if (cancelCheck?.()) break;

    // ─── FETCH PHASE TIME BUDGET CHECK ──────────────────────────────────
    const elapsed = Date.now() - fetchPhaseStart;
    if (elapsed > FETCH_PHASE_BUDGET_MS) {
      console.warn(`[${companyName}] Fetch phase budget exceeded (${Math.round(elapsed / 1000)}s > ${Math.round(FETCH_PHASE_BUDGET_MS / 1000)}s) — proceeding with available documents`);
      fetchBudgetExceeded = true;
      // Force-mark remaining pending docs as dead so we can proceed
      const remainingPending = (await storage.getAcceptedDocuments(companyId)).filter(d => d.fetchStatus === "pending");
      for (const doc of remainingPending) {
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
      }
      if (remainingPending.length > 0) {
        console.warn(`[${companyName}] Force-marked ${remainingPending.length} remaining pending docs as dead (budget exceeded)`);
      }
      break;
    }

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

    console.log(`[${companyName}] Fetch pass ${pass}: ${pendingDocs.length} pending, ${okDocs.length} ok, ${deadDocs.length} dead (elapsed: ${Math.round(elapsed / 1000)}s)`);

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

    // Fetch pending documents with BOUNDED PARALLELISM. The per-document logic
    // (fetch -> verify -> record) is identical to the previous sequential
    // version; only the orchestration is concurrent, capped at
    // INCOMPANY_FETCH_CONCURRENCY so we never overwhelm the shared browser-slot
    // pool or the LLM rate limit. Quality is unchanged: every doc is still
    // fetched and verified with the same checks.
    const processOne = async (doc: typeof sortedPending[number]): Promise<void> => {
      if (cancelCheck?.()) return;

      // Check budget before starting this document
      if (Date.now() - fetchPhaseStart > FETCH_PHASE_BUDGET_MS) {
        fetchBudgetExceeded = true;
        return;
      }

      try {
        const type = inferDocumentType(doc.url);
        // Wrap processDocument with a per-document timeout
        const content = await withTimeout(
          processDocument(doc.url, type),
          PER_DOCUMENT_TIMEOUT_MS,
          `[${companyName}] fetch ${doc.url.slice(0, 80)}`
        );

        if (content && content.length > 50) {
          // POST-FETCH VALIDATION: Verify the document content actually relates
          // to the target company. This catches cases where the gate accepted a
          // document based on title/URL, but the actual content is about a
          // different company entirely (e.g. a foreign filing pulled in via a
          // shared investor-relations CDN such as q4cdn.com).
          //
          // Layered policy:
          //  - If the doc is hosted on the company's OWN verified domain, trust
          //    it (fast path, no LLM call).
          //  - Otherwise (no verified domain set, OR host != verified domain),
          //    run an LLM check on the actual content to confirm the issuer.
          //    A document is KEPT only if the LLM confirms it is about THIS
          //    company — so relevant off-domain / shared-CDN documents are
          //    retained, while other companies' documents are rejected.
          const needsVerify = shouldVerifyDocument({ url: doc.url, verifiedDomain: company.domain, platformHosts });

          if (!needsVerify) {
            // On the company's own verified domain — accept without LLM cost.
            await storage.recordFetchSuccess(companyId, doc.url, content);
            newFetchCount++;
          } else {
            const vr = await verifyDocumentCompany(
              {
                name: companyName,
                isin: company.isin,
                sector: company.sector,
                country: company.country,
                ticker: company.ticker,
                verifiedDomain: company.domain,
              },
              { url: doc.url, title: doc.title, content }
            );

            if (vr.verdict === "match") {
              await storage.recordFetchSuccess(companyId, doc.url, content);
              newFetchCount++;
            } else if (vr.verdict === "error") {
              // Fail-safe: the verifier itself failed (LLM/parse error). Fall back
              // to the cheap substring heuristic so a transient verifier outage
              // does not silently discard a genuinely relevant document.
              const contentLower = content.toLowerCase();
              const companyNameLower = companyName.toLowerCase();
              const nameWords = companyNameLower
                .split(/[\s,\.\-&]+/)
                .filter(w => w.length >= 4 && !['inc', 'ltd', 'plc', 'corp', 'group', 'the', 'and', 'company', 'limited', 'corporation', 'holdings', 'international'].includes(w));
              const fallbackMentions = companyNameLower.length >= 4 && contentLower.includes(companyNameLower)
                || nameWords.some(w => contentLower.includes(w));
              if (fallbackMentions) {
                console.warn(`[${companyName}] VERIFY ERROR (${vr.reason}); kept via name-mention fallback: ${doc.url.slice(0, 80)}`);
                await storage.recordFetchSuccess(companyId, doc.url, content);
                newFetchCount++;
              } else {
                console.warn(`[${companyName}] VERIFY ERROR (${vr.reason}); no name mention — rejected: ${doc.url.slice(0, 80)}`);
                await storage.recordFetchFailure(companyId, doc.url);
              }
            } else {
              // different_company or generic -> TERMINAL reject. Mark the row
              // 'rejected' so it is excluded from scoring AND never retried
              // (avoids repeated re-fetch + repeated LLM verifier cost), and is
              // purged on the next re-discovery.
              const issuer = vr.detectedIssuer ? `: ${vr.detectedIssuer}` : '';
              console.warn(`[${companyName}] POST-FETCH REJECT (${vr.verdict}${issuer}): ${doc.url.slice(0, 80)} — ${vr.reason}`);
              await storage.recordVerificationReject(companyId, doc.url, `${vr.verdict}${issuer} — ${vr.reason}`);
            }
          }
        } else {
          await storage.recordFetchFailure(companyId, doc.url);
        }
      } catch (error: any) {
        if (error instanceof TimeoutError) {
          console.warn(`[${companyName}] Document fetch TIMEOUT (${PER_DOCUMENT_TIMEOUT_MS / 1000}s): ${doc.url.slice(0, 100)}`);
        } else {
          console.warn(`[${companyName}] Fetch failed for ${doc.url}: ${error.message}`);
        }
        await storage.recordFetchFailure(companyId, doc.url);
      }
    };

    // Run processOne over sortedPending with a fixed-size worker pool. Documents
    // are pulled from a shared cursor so faster docs don't wait on slower ones.
    let cursor = 0;
    const poolSize = Math.max(1, Math.min(INCOMPANY_FETCH_CONCURRENCY, sortedPending.length));
    const runWorker = async (): Promise<void> => {
      while (true) {
        if (cancelCheck?.()) return;
        if (Date.now() - fetchPhaseStart > FETCH_PHASE_BUDGET_MS) {
          fetchBudgetExceeded = true;
          return;
        }
        const idx = cursor++;
        if (idx >= sortedPending.length) return;
        await processOne(sortedPending[idx]);
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
    if (fetchBudgetExceeded) {
      console.warn(`[${companyName}] Fetch budget exceeded during parallel pass — stopping`);
    }

    // If budget exceeded mid-pass, force-kill remaining pending docs
    if (fetchBudgetExceeded) {
      const remainingPending = (await storage.getAcceptedDocuments(companyId)).filter(d => d.fetchStatus === "pending");
      for (const doc of remainingPending) {
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
        await storage.recordFetchFailure(companyId, doc.url);
      }
      if (remainingPending.length > 0) {
        console.warn(`[${companyName}] Force-marked ${remainingPending.length} remaining pending docs as dead (budget exceeded)`);
      }
      break;
    }

    // Brief pause between passes to avoid hammering servers
    if (pass < MAX_PASSES) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Final count
  const finalDocs = await storage.getAcceptedDocuments(companyId);
  totalFetched = finalDocs.filter(d => d.fetchStatus === "ok").length;

  console.log(`[${companyName}] Fetch phase complete: ${totalFetched} fetched, ${newFetchCount} new this run (${Math.round((Date.now() - fetchPhaseStart) / 1000)}s elapsed${fetchBudgetExceeded ? ', BUDGET EXCEEDED' : ''})`);

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
  const documentTitles: string[] = [];
  for (const doc of fetchedDocs) {
    if (doc.content) {
      documentTexts.push(doc.content);
      documentUrls.push(doc.url);
      documentTitles.push(doc.title || doc.url);
    }
  }

  // ─── Temporal Validation Step ──────────────────────────────────────────────
  // Check for policy withdrawals, target rollbacks, or material changes that
  // would affect the currency of the evidence.
  let temporalContext: TemporalContext | undefined;
  try {
    temporalContext = await runTemporalValidation({
      companyName,
      companyId,
      framework,
      documentTexts,
      documentUrls,
    });
    if (temporalContext && temporalContext.withdrawals.length > 0) {
      console.log(`[${companyName}] Temporal validation found ${temporalContext.withdrawals.length} policy withdrawals/changes`);
      for (const w of temporalContext.withdrawals) {
        console.log(`  - ${w.description} (detected: ${w.detectedDate || 'unknown'})`);
      }
    }
  } catch (tvError: any) {
    console.warn(`[${companyName}] Temporal validation failed (non-fatal): ${tvError.message}`);
  }

  // Run the LLM analysis (framework-specific scoring)
  const analysis = await analyzeCompanyMeasures({
    workspaceId,
    companyName,
    companyId,
    documentTexts,
    documentUrls,
    documentTitles,
    framework,
    measures,
    temporalContext,
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
  const pipelineStart = Date.now();

  // Wrap the entire pipeline in a hard timeout to prevent any single company
  // from blocking the worker indefinitely. This ensures batch counters always
  // increment and the batch eventually completes.
  const pipelinePromise = (async (): Promise<PipelineResult> => {
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

      const elapsed = Math.round((Date.now() - pipelineStart) / 1000);
      console.log(`[${companyName}] Pipeline completed in ${elapsed}s`);

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
  })();

  // Apply the hard pipeline timeout
  try {
    return await withTimeout(pipelinePromise, PIPELINE_TIMEOUT_MS, `[${companyName}] pipeline`);
  } catch (timeoutError: any) {
    if (timeoutError instanceof TimeoutError) {
      const elapsed = Math.round((Date.now() - pipelineStart) / 1000);
      console.error(`[${companyName}] PIPELINE TIMEOUT after ${elapsed}s — marking as failed`);
      await storage.updateCompany(companyId, workspaceId, { analysisStatus: "failed" });
      await storage.logProcessingError({
        companyId,
        companyName,
        stage: "pipeline",
        error: `Pipeline timed out after ${elapsed}s (limit: ${PIPELINE_TIMEOUT_MS / 1000}s)`,
      });
      return {
        success: false,
        error: `Pipeline timed out after ${elapsed}s`,
        documentsProcessed: 0,
        documentsFresh: 0,
        documentsCached: 0,
      };
    }
    throw timeoutError;
  }
}
