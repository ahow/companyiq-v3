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
import { processDocument, inferDocumentType, PermanentFetchError, TransientFetchError } from "./processor.js";
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
    ticker: company.ticker,
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

  // Save discovery diagnostics (includes coverage metric).
  // IMPORTANT: preserve the bounded-retry counter (autoReexam) that lives in the
  // SAME jsonb column. A re-examination run re-enters the fetch phase, and if we
  // blindly overwrote discoveryDiagnostics here we would wipe autoReexam.count
  // back to 0 every pass — defeating the bound and risking an infinite retry
  // loop. Read-merge so the counter survives across re-fetches.
  {
    const priorDiag = (await storage.getCompanyById(companyId, workspaceId))?.discoveryDiagnostics as any || {};
    const merged: any = { ...discoveryResult.diagnostics };
    if (priorDiag.autoReexam) merged.autoReexam = priorDiag.autoReexam;
    await storage.updateCompany(companyId, workspaceId, {
      discoveryDiagnostics: merged,
    });
  }

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

    // Priority-sort so the fetch budget is always spent on the most
    // decision-relevant disclosures first (important for doc-heavy issuers whose
    // WAF PDFs are slow and may exceed the budget):
    //   1. High-value content: primary filings (10-K/20-F/annual/proxy) AND
    //      AI-governance material (ai ethics / responsible ai / ai policy / csr).
    //   2. Company-domain documents.
    //   3. PDFs over HTML.
    // Low-value periodic filings (old 10-Qs) and generic product/marketing pages
    // therefore sink to the bottom and are the first to be dropped on budget.
    const HIGH_VALUE_RE = /10-?k|20-?f|annual.?report|integrated.?report|def.?14a|proxy|ai.?ethic|responsible.?ai|ai.?governance|ai.?policy|ai.?principle|ethics.?and.?integrity|csr.?report|sustainability.?report|esg/i;
    const LOW_VALUE_RE = /10-?q|transcript|glossary|generative-ai-vs|gen-ai-glossary|express\/web/i;
    const rank = (u: string): number => {
      const s = u.toLowerCase();
      if (LOW_VALUE_RE.test(s)) return -1;
      if (HIGH_VALUE_RE.test(s)) return 2;
      return 0;
    };
    const sortedPending = [...pendingDocs].sort((a, b) => {
      const aRank = rank(a.url), bRank = rank(b.url);
      if (aRank !== bRank) return bRank - aRank;
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
            } else if (
              vr.verdict === "generic" &&
              (content.trim().length < 400 || /enable javascript|requires javascript|请启用javascript|开启javascript/i.test(content))
            ) {
              // "generic-because-empty": the verifier could not determine the issuer
              // because the fetched content was a near-empty / JS-required shell
              // (common for Chinese portals & SPA IR sites whose real content is
              // hydrated client-side). This is NOT proof the document is irrelevant
              // — it is a FETCH problem. Mark it a retryable failure so a later pass
              // (with the browser-render escalation) can recover the real text,
              // instead of permanently discarding the issuer's own disclosure. This
              // is a primary driver of the systematic zero-scoring of Chinese-listed
              // issuers.
              console.warn(`[${companyName}] POST-FETCH generic/empty (likely JS shell) — keeping retryable: ${doc.url.slice(0, 80)} — ${vr.reason}`);
              await storage.recordFetchFailure(companyId, doc.url);
            } else {
              // different_company, or genuine generic (real multi-company index /
              // industry page with substantive text) -> TERMINAL reject. Mark the
              // row 'rejected' so it is excluded from scoring AND never retried
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
          // A per-document timeout is the most budget-expensive failure mode and
          // almost never resolves on a retry within the same run. Mark it dead in
          // one step so the fetch loop does not re-attempt it (and re-burn the
          // full timeout) on every subsequent pass.
          console.warn(`[${companyName}] Document fetch TIMEOUT (${PER_DOCUMENT_TIMEOUT_MS / 1000}s) — marking dead: ${doc.url.slice(0, 100)}`);
          await storage.recordFetchDead(companyId, doc.url);
        } else if (error instanceof TransientFetchError) {
          // REVIEWER FIX v3d (issue #3): browser-PDF returned empty THIS pass for a
          // possibly-transient WAF/edge reason (e.g. ir.tesla.com Akamai). Record a
          // retryable failure so a later pass can recover the high-value IR PDF,
          // instead of discarding it as dead on the first miss.
          console.warn(`[${companyName}] Transient fetch failure — keeping retryable: ${doc.url.slice(0, 100)} (${error.message})`);
          await storage.recordFetchFailure(companyId, doc.url);
        } else if (error instanceof PermanentFetchError) {
          // 401 paywall / 403 CDN block — will not succeed on retry. Mark dead now.
          console.warn(`[${companyName}] Permanent fetch failure — marking dead: ${doc.url.slice(0, 100)} (${error.message})`);
          await storage.recordFetchDead(companyId, doc.url);
        } else {
          console.warn(`[${companyName}] Fetch failed for ${doc.url}: ${error.message}`);
          await storage.recordFetchFailure(companyId, doc.url);
        }
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
  const totalDead = finalDocs.filter(d => d.fetchStatus === "dead").length;
  const totalDiscovered = finalDocs.length;

  console.log(`[${companyName}] Fetch phase complete: ${totalFetched} fetched, ${newFetchCount} new this run (${Math.round((Date.now() - fetchPhaseStart) / 1000)}s elapsed${fetchBudgetExceeded ? ', BUDGET EXCEEDED' : ''})`);

  // ─── Persist a fetch-coverage signal ───────────────────────────────────────
  // A low score backed by thin retrieval (most key docs `dead`) should be
  // visibly distinguishable from a genuine low score. We merge a `fetchCoverage`
  // block into the existing discoveryDiagnostics jsonb (no schema migration) so
  // the UI/export can show "X of Y fetched" and flag low-evidence results.
  try {
    const fetchRatio = totalDiscovered > 0 ? totalFetched / totalDiscovered : 0;
    // Did any Tier-1 (primary filing) document fail to fetch?
    const deadDocs = finalDocs.filter(d => d.fetchStatus === "dead");
    const deadTier1 = deadDocs.some(d => /10-?k|20-?f|annual.?report|integrated.?report|def.?14a|proxy.?statement/i.test((d.url + " " + (d.title || "")).toLowerCase()));
    const lowEvidence = totalFetched < 3 || fetchRatio < 0.5 || (deadTier1 && fetchRatio < 0.7);
    const existingDiag = (await storage.getCompanyById(companyId, workspaceId))?.discoveryDiagnostics as any || {};
    await storage.updateCompany(companyId, workspaceId, {
      discoveryDiagnostics: {
        ...existingDiag,
        fetchCoverage: {
          documentsFetched: totalFetched,
          documentsDead: totalDead,
          documentsDiscovered: totalDiscovered,
          fetchRatio: Math.round(fetchRatio * 100) / 100,
          deadPrimaryFiling: deadTier1,
          lowEvidence,
          budgetExceeded: fetchBudgetExceeded,
        },
      } as any,
    });
    if (lowEvidence) {
      console.warn(`[${companyName}] LOW EVIDENCE: only ${totalFetched}/${totalDiscovered} docs fetched (ratio ${Math.round(fetchRatio * 100)}%${deadTier1 ? ', a primary filing failed to fetch' : ''}) — score may understate true disclosure`);
    }
  } catch (covErr: any) {
    console.warn(`[${companyName}] Failed to persist fetch-coverage diagnostics (non-fatal): ${covErr.message}`);
  }

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

  // v3j (Obs 3.2): the deterministic force-include path is otherwise invisible to
  // downstream validators. We surface it WITHOUT a schema migration by tagging the
  // already-persisted quotes JSONB: any quote whose sourceUrl matches the measure's
  // forceIncludedDocUrl is annotated forceInclude=true. The /api/companies/:id
  // payload returns quotes verbatim, so validators can confirm the path fired.
  const normUrl = (u?: string) => (u || "").trim().toLowerCase().replace(/[#?].*$/, "").replace(/\/$/, "");
  const scoreRows = analysis.categories.flatMap((cat) =>
    cat.measures.map((m) => {
      const fiUrl = normUrl((m as any).forceIncludedDocUrl);
      const fiCount = (m as any).forceIncludedCount ?? 0;
      const quotes = (m.quotes || []).map((q) => {
        const fromForced = fiCount > 0 && !!fiUrl && normUrl((q as any).sourceUrl) === fiUrl;
        return fromForced ? { ...q, forceInclude: true } : q;
      });
      return {
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
        quotes,
        verdict: m.verdict,
        verdictNuance: m.verdictNuance,
        displayOrder: m.displayOrder,
        // v3e: persist abstain flag + evidence fingerprint for the answered-measures
        // denominator and cross-run drift detection / verdict caching.
        abstained: (m as any).abstained === true,
        evidenceFingerprint: (m as any).evidenceFingerprint ?? null,
      };
    })
  );

  await storage.createMeasureScores(scoreRows);

  // Update company with results.
  // Populate measuresMetCount/measuresTotalCount (previously left null, which
  // surfaced as blank columns in the CSV/API export). "Met" counts measures with
  // a Yes verdict; partial verdicts contribute fractionally to the score but are
  // not counted as fully met here.
  const allMeasureResults = analysis.categories.flatMap((c) => c.measures);
  const measuresMet = allMeasureResults.filter((m) => m.verdict === "Yes").length;
  // v3e (Section 3): measuresTotalCount now reflects ANSWERED measures (the
  // denominator behind scorePercentage), so "X met of Y" is internally consistent
  // with the displayed percentage. The full framework size and abstained count are
  // also recorded for transparency.
  const answeredCount = (analysis as any).answeredCount ?? measures.length;
  const abstainedCount = (analysis as any).abstainedCount ?? 0;
  await storage.updateCompany(companyId, workspaceId, {
    totalScore: analysis.scorePercentage,
    measuresMetCount: measuresMet,
    measuresTotalCount: answeredCount,
    summary: analysis.summary,
    analysisStatus: "completed",
  });

  console.log(`[${companyName}] Analysis complete: ${analysis.scorePercentage}% (${measuresMet} met / ${answeredCount} answered; ${abstainedCount} abstained of ${measures.length} total)`);

  // ─── v3j (Bug 2): RECORD FORCE-INCLUDE INVARIANT VIOLATIONS ─────────────────
  // The analyzer asserts that every filing-bound measure whose required document
  // was present in the corpus received at least one genuine forced body chunk.
  // A violation is the exact Bug-2 regression (e.g. Salesforce Risk Q1 saw no
  // real Item 1A body). We persist violations to processing_errors so a portfolio
  // run is auditable and can be gated, without aborting this company's other
  // (valid) scores.
  const fiInvariant = (analysis as any).forceIncludeInvariant as
    | { ok: boolean; checked: number; violations: Array<{ measureId: string; reason: string }> }
    | undefined;
  if (fiInvariant && !fiInvariant.ok) {
    console.error(`[${companyName}][invariant][FAIL] ${fiInvariant.violations.length} force-include violation(s): ${fiInvariant.violations.map((v) => `${v.measureId} (${v.reason})`).join("; ")}`);
    try {
      await storage.logProcessingError({
        companyId,
        companyName,
        stage: "score",
        error: `Force-include invariant violated for ${fiInvariant.violations.length} measure(s): ${fiInvariant.violations.map((v) => `${v.measureId} [${v.reason}]`).join("; ")}`,
      });
    } catch (e: any) {
      console.warn(`[${companyName}] Failed to record force-include invariant violation: ${e?.message}`);
    }
  } else if (fiInvariant) {
    console.log(`[${companyName}][invariant][OK] force-include satisfied for ${fiInvariant.checked} filing-bound measure(s)`);
  }

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

// ─── Auto-Reexamination Gate (v3k-r15) ──────────────────────────────────────
// A company can "complete" with an EMPTY or thin corpus for two very different
// reasons:
//   (1) FETCH-COVERAGE ARTIFACT — its primary filings were discovered but the
//       fetches failed (timeouts, Chromium fork exhaustion during a degraded
//       window, transient CDN blocks). The score understates true disclosure.
//   (2) LEGITIMATE NO-DISCLOSURE — a substantial corpus was fetched and read,
//       but it genuinely contains no qualifying AI-governance content.
// Only (1) warrants a re-examination. The gate below fires ONLY when the
// persisted fetch-coverage diagnostics flag thin/degraded retrieval AND the
// usable corpus is small, and it is strictly bounded so it can never loop.
const AUTO_REEXAM_MAX = parseInt(process.env.AUTO_REEXAM_MAX || "2", 10);
const AUTO_REEXAM_MAX_CHARS = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);

/**
 * Decide whether a just-finalized company should be automatically re-examined
 * because its corpus was degraded by fetch failures (NOT a legitimate zero).
 * Returns true if a re-examination was enqueued (caller should treat the run as
 * superseded), false if the result should stand as-is.
 */
async function maybeAutoReexamine(opts: {
  company: Company;
  framework: Framework;
  workspaceId: number;
  totalScore: number;
}): Promise<boolean> {
  const { company, framework, workspaceId } = opts;
  const companyId = company.id;
  const companyName = company.name;
  try {
    // Re-read the company to get the freshly-persisted diagnostics + score.
    const fresh = await storage.getCompanyById(companyId, workspaceId);
    const diag = (fresh?.discoveryDiagnostics as any) || {};
    const coverage = diag.fetchCoverage || null;
    const reexam = diag.autoReexam || { count: 0 };
    const score = typeof fresh?.totalScore === "number" ? fresh.totalScore : opts.totalScore;

    // GUARD 1 — only ever consider a (near-)zero result. A scored company has
    // demonstrably usable evidence and must never be churned.
    if (score > 0) return false;

    // GUARD 2 — bounded retries: never loop.
    if ((reexam.count || 0) >= AUTO_REEXAM_MAX) {
      console.log(`[${companyName}] Auto-reexam SKIPPED: retry budget exhausted (${reexam.count}/${AUTO_REEXAM_MAX})`);
      return false;
    }

    // GUARD 3 — the result must look like a FETCH-COVERAGE ARTIFACT, not a
    // legitimate no-disclosure zero. Two independent conditions must hold:
    //   (a) the fetch-coverage diagnostics already flagged thin/degraded
    //       retrieval (most docs dead, low fetch ratio, or a dead primary
    //       filing) — this is the same `lowEvidence` signal surfaced in the UI;
    //   (b) the USABLE corpus is small (< AUTO_REEXAM_MAX_CHARS). A large corpus
    //       (e.g. a 3.6M-char filer) is never a fetch failure even if many
    //       ancillary URLs went dead, so it is treated as a legitimate zero.
    const corpusChars = await storage.getCorpusCharCount(companyId);
    const degradedRetrieval = !!coverage && coverage.lowEvidence === true;
    const thinCorpus = corpusChars < AUTO_REEXAM_MAX_CHARS;

    if (!degradedRetrieval || !thinCorpus) {
      console.log(
        `[${companyName}] Auto-reexam SKIPPED: legitimate zero ` +
          `(corpusChars=${corpusChars}, lowEvidence=${coverage?.lowEvidence ?? "n/a"}, ` +
          `fetchRatio=${coverage?.fetchRatio ?? "n/a"}, dead=${coverage?.documentsDead ?? "n/a"})`
      );
      return false;
    }

    // All guards passed — this is a fetch-coverage artifact. Record the bounded
    // retry in discoveryDiagnostics (no migration) and enqueue a fresh run that
    // forces re-discovery + re-fetch of the previously-dead documents.
    const nextCount = (reexam.count || 0) + 1;
    await storage.updateCompany(companyId, workspaceId, {
      discoveryDiagnostics: {
        ...diag,
        autoReexam: {
          count: nextCount,
          lastTriggeredAt: new Date().toISOString(),
          reason: `degraded fetch coverage: ${coverage.documentsFetched}/${coverage.documentsDiscovered} fetched, ` +
            `${coverage.documentsDead} dead, ratio ${coverage.fetchRatio}, corpusChars ${corpusChars}`,
        },
      } as any,
    });

    const enq = await storage.enqueueReexamination({
      companyId,
      companyName,
      frameworkId: framework.id,
      workspaceId,
    });
    if (enq) {
      console.warn(
        `[${companyName}] AUTO-REEXAM TRIGGERED (${nextCount}/${AUTO_REEXAM_MAX}): ` +
          `corpusChars=${corpusChars}, fetchRatio=${coverage.fetchRatio}, ` +
          `dead=${coverage.documentsDead}/${coverage.documentsDiscovered} ` +
          `-> re-enqueued as batch ${enq.batchId}, job ${enq.jobId} (skipFetch=false)`
      );
      return true;
    }
    return false;
  } catch (err: any) {
    console.warn(`[${companyName}] Auto-reexam check failed (non-fatal): ${err.message}`);
    return false;
  }
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
          // Auto-reexamination gate: if this empty corpus is a fetch-coverage
          // artifact (degraded retrieval, thin corpus) and the bounded retry
          // budget remains, enqueue a fresh re-discovery+re-fetch run. We then
          // return success:true so the worker does NOT also fire its generic
          // retry (which would reuse the same empty corpus) and the originating
          // batch counter advances cleanly. The re-exam runs as its own batch.
          const reexamined = await maybeAutoReexamine({ company, framework, workspaceId, totalScore: 0 });
          if (reexamined) {
            return {
              success: true,
              documentsProcessed: 0,
              documentsFresh: fetchResult.totalAccepted,
              documentsCached: 0,
            };
          }
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

      // Auto-reexamination gate on the NORMAL completion path: a company can
      // finish with >0 fetched docs yet a 0% score because the few docs that
      // fetched were ancillary while the primary filings died. If the corpus is
      // thin AND fetch coverage was flagged degraded, re-examine (bounded). A
      // large, genuinely-zero corpus is left untouched.
      if ((analysis.scorePercentage ?? 0) <= 0) {
        await maybeAutoReexamine({ company, framework, workspaceId, totalScore: 0 });
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
