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
import { analyzeCompanyMeasures, getPromptHash, getPipelineVersion, type AnalysisResult } from "./analyzer.js";
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

// Usable-corpus threshold (chars) below which a (near-)zero result may be a
// fetch-coverage artifact. Declared at module top because it is referenced both
// by the fetch-coverage lowEvidence computation (Phase 1) and the auto-reexam
// gate (post-analysis) — keeping a single source of truth and avoiding a TDZ
// reference from the earlier fetch-coverage block.
const AUTO_REEXAM_MAX_CHARS = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);

export interface PipelineOptions {
  company: Company;
  framework: Framework;
  measures: FrameworkMeasure[];
  workspaceId: number;
  batchId?: number; // For corpus snapshot (batch_corpus table)
  cancelCheck?: () => boolean;
  skipFetch?: boolean; // If true, skip fetch phase (reuse existing documents)
  batchFetchState?: BatchFetchState; // 42-F: batch-scoped circuit-breaker
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

// 42-F: Batch-scoped circuit-breaker state.
export interface BatchFetchState {
  hostSlowFetches: Map<string, number>;
  hostCircuitBroken: Set<string>;
}

export function newBatchFetchState(): BatchFetchState {
  return {
    hostSlowFetches: new Map(),
    hostCircuitBroken: new Set(),
  };
}

async function runFetchPhase(opts: {
  company: Company;
  framework: Framework;
  workspaceId: number;
  batchId?: number;
  cancelCheck?: () => boolean;
  batchFetchState?: BatchFetchState; // 42-F
}): Promise<{ fetchedCount: number; totalAccepted: number }> {
  const { company, framework, workspaceId, batchId, cancelCheck } = opts;
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

  // Fix C: Derive peer company names from the workspace for anti-contamination filtering
  const workspaceCompanies = await storage.getCompanies(workspaceId);
  const peerCompanyNames = workspaceCompanies
    .filter((c: any) => c.id !== companyId)
    .map((c: any) => (c.name || "").toLowerCase())
    .filter((n: string) => n && n.length >= 4);

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
    peerCompanyNames,
    companyRow: company, // 40-G: pass full row for cached domain family + FIGI fields
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
  // Determine first-party vs third-party based on domain matching
  const companyDomainLower = (company.domain || "").replace(/^www\./, "").toLowerCase();
  for (const doc of discoveryResult.documents) {
    const type = inferDocumentType(doc.url);
    // Tag source type: first_party if URL matches company domain, third_party otherwise
    let sourceType: string = "third_party";
    if (companyDomainLower) {
      try {
        const docHost = new URL(doc.url).hostname.replace(/^www\./, "").toLowerCase();
        if (docHost === companyDomainLower || docHost.endsWith("." + companyDomainLower)) {
          sourceType = "first_party";
        }
      } catch {}
    }
    await storage.upsertDocument({
      companyId,
      url: doc.url,
      title: doc.title,
      type,
      gateVerdict: "accept",
      gateReason: `Priority: ${doc.priority}, Lane: ${doc.lane}`,
      sourceType,
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
        await storage.recordFetchFailure(companyId, d.url, "empty_cached_content");
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

  // ─── Corpus Validity Check (framework-aware) ─────────────────────────────
  // Detect when the corpus is composed entirely of the WRONG document types for
  // the framework's topic. E.g., for a Financed Emissions framework, a corpus of
  // 69 EDGAR filings with zero climate/TCFD/sustainability reports is invalid even
  // though the fetch ratio is 99%. This catches the SMFG-type failure.
  let corpusValidityWarning: string | null = null;
  {
    // TOPIC-AGNOSTIC CORPUS VALIDITY CHECK
    // The expected document types and data patterns are defined at framework-definition
    // time (by the builder) and stored on the framework record. The code here simply
    // REFERENCES those fields. No topic knowledge lives in this code path.
    const frameworkDocTypes = (framework as any).requiredDocTypes as string[] | null;
    const frameworkDataPatterns = (framework as any).dataPatterns as string[] | null;

    // Build the expected-type label from the framework's declared doc types
    const expectedLabel = frameworkDocTypes && frameworkDocTypes.length > 0
      ? frameworkDocTypes.join(" / ")
      : (framework.topicDescription || framework.name || "topic-relevant document");

    // Build the content-test regex from the framework's declared data patterns
    // Precision fix: require ≥2 distinct dataPatterns to hit the corpus text before
    // declaring hasRequiredDataDoc = True. A single stray keyword no longer passes.
    let contentPattern: RegExp | null = null;
    let useDistinctHitsPath = false;
    if (frameworkDataPatterns && frameworkDataPatterns.length > 0) {
      useDistinctHitsPath = true;
      // contentPattern kept as fallback for the per-doc check below
      contentPattern = new RegExp(`(?:${frameworkDataPatterns.join("|")})`, "i");
    } else {
      // Instruction 21c: No legacy fallback. If a framework has no dataPatterns,
      // derive a generic content check from its topic description words.
      // This is topic-agnostic — no hardcoded climate/AI/slavery branches.
      const topic = (framework.topicDescription || framework.name || "").toLowerCase();
      const topicWords = topic.split(/\s+/).filter(w => w.length > 4).slice(0, 8);
      if (topicWords.length > 0) {
        contentPattern = new RegExp(topicWords.join("|"), "i");
      }
    }

    // Load real content from DB (the same JOIN the analyze phase uses)
    const docsWithContent = await storage.getFetchedDocuments(companyId);

    // Fail-safe: if we genuinely couldn't load any readable content, do NOT flag suspect.
    const anyContentReadable = docsWithContent.some(d => (d.content || "").length >= 200);

    // A document "counts" only if its actual fetched content contains framework data.
    // A matching title alone is NOT sufficient.
    if (contentPattern && anyContentReadable && docsWithContent.length >= 5) {
      let hasDataDoc = false;

      if (useDistinctHitsPath && frameworkDataPatterns) {
        // Precision: require ≥2 distinct dataPatterns to match across the corpus.
        // This prevents a single stray keyword from passing the check.
        hasDataDoc = docsWithContent.some(d => {
          const content = d.content || "";
          if (content.length < 200) return false;
          const distinctHits = frameworkDataPatterns.filter(p => {
            try { return new RegExp(p, "i").test(content); } catch { return false; }
          }).length;
          return distinctHits >= 2;
        });
      } else {
        // Legacy path: single alternation regex
        hasDataDoc = docsWithContent.some(d => {
          const content = d.content || "";
          if (content.length < 200) return false;
          return contentPattern!.test(content);
        });
      }

      if (!hasDataDoc) {
        corpusValidityWarning =
          `Corpus lacks framework-relevant DATA for "${expectedLabel}": ${docsWithContent.length} documents fetched, ` +
          `none contain the expected figures/targets in their text (titles may match, content does not). ` +
          `Likely discovery-composition failure — score should be treated as low-coverage.`;
        console.warn(`[${companyName}] CORPUS VALIDITY WARNING: ${corpusValidityWarning}`);
      }
    }

    // Persist the validity warning in diagnostics (or clear stale warning if check passed)
    const priorDiag2 = (await storage.getCompanyById(companyId, workspaceId))?.discoveryDiagnostics as any || {};
    if (corpusValidityWarning) {
      // P4a: Write coverageLevel directly into the coverage sub-object that the API reads
      // (api.ts reads discoveryDiagnostics.coverage.coverageLevel). The old coverageLevelOverride
      // field was never consumed. Now we set both for backward compat.
      const existingCoverage = priorDiag2.coverage || {};
      await storage.updateCompany(companyId, workspaceId, {
        discoveryDiagnostics: {
          ...priorDiag2,
          corpusValidityWarning,
          coverageLevelOverride: "suspect",
          coverage: { ...existingCoverage, coverageLevel: "suspect" },
        } as any,
      });
    } else if (priorDiag2.corpusValidityWarning) {
      // Clear stale warning from a previous run (company now has valid content)
      const { corpusValidityWarning: _removed, coverageLevelOverride: _cov, ...rest } = priorDiag2;
      await storage.updateCompany(companyId, workspaceId, {
        discoveryDiagnostics: rest as any,
      });
    }
  }

  if (cancelCheck?.()) {
    await storage.updateCompany(companyId, workspaceId, { analysisStatus: "idle" });
    return { fetchedCount: 0, totalAccepted: discoveryResult.documents.length };
  }

  // Step 4: Fetch ALL accepted documents — loop until EVERY doc is resolved (ok or dead)
  // Analysis will NOT start until zero documents remain in "pending" status.
  const companyDomain = company.domain?.replace(/^www\./, "").toLowerCase() || "";

  // Fix 4 (Fetch Stability) + Fix 3 (Content-Drift Closure):
  // Before re-fetching, check if any pending docs already have content in the
  // deduplicated document_content table from a prior successful fetch.
  // This makes the accepted set converge AND eliminates content-level drift:
  // a doc that ever fetched successfully is reused with its STORED content
  // (not re-fetched, which could yield slightly different text due to page updates).
  // This is the "discover-once → re-score" principle applied at the document level.
  const contentCache = new Map<string, string>(); // URL → cached content for this run
  try {
    const pendingBefore = (await storage.getAcceptedDocuments(companyId)).filter(d => d.fetchStatus === "pending");
    let cacheHits = 0;
    for (const doc of pendingBefore) {
      const cached = await storage.getContentByUrl(doc.url);
      if (cached && cached.length > 50) {
        await storage.recordFetchSuccess(companyId, doc.url, cached);
        contentCache.set(doc.url, cached);
        cacheHits++;
      }
    }
    if (cacheHits > 0) {
      console.log(`[${companyName}] FETCH-CACHE: reused ${cacheHits} previously-fetched documents (stability + content-drift fix)`);
    }
  } catch (cacheErr: any) {
    console.warn(`[${companyName}] Fetch-cache reuse failed (non-fatal): ${cacheErr.message}`);
  }

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
        await storage.recordFetchDead(companyId, doc.url, "budget_exceeded");
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
        await storage.recordFetchDead(companyId, doc.url, "max_retries_exceeded");
      }
      break;
    }

    console.log(`[${companyName}] Fetch pass ${pass}: ${pendingDocs.length} pending, ${okDocs.length} ok, ${deadDocs.length} dead (elapsed: ${Math.round(elapsed / 1000)}s)`);

    // Priority-sort so the fetch budget is always spent on the most
    // decision-relevant disclosures first (important for doc-heavy issuers whose
    // WAF PDFs are slow and may exceed the budget):
    //   1. High-value content: primary filings + universal disclosure containers
    //      + framework-specific document types (from requiredDocTypes/evidenceKeywords).
    //   2. Company-domain documents.
    //   3. PDFs over HTML.
    // Low-value periodic filings (old 10-Qs) and generic product/marketing pages
    // therefore sink to the bottom and are the first to be dropped on budget.
    // 41-A: Framework-agnostic fetch prioritisation.
    // Universal filings — apply to any framework, always.
    const FILINGS_BASE = "10-?k|20-?f|40-?f|annual.?report|integrated.?report|def.?14a|proxy";
    // Cross-topic disclosure containers — these host any framework's disclosure.
    // Contains NO topic-specific terms — only document container types.
    const UNIVERSAL_DISCLOSURE = "esg\\b|sustainability.?report|integrated.?report|csr.?report|responsibility.?report";
    // Framework-specific patterns come EXCLUSIVELY from framework.requiredDocTypes
    // and framework.evidenceKeywords — no hardcoded topic literals.
    const frameworkDocTypesForRank = (framework as any).requiredDocTypes as string[] | null;
    const evidenceKeywords = (framework as any).evidenceKeywords as string[] | null;
    const metaTopic = [
      ...(frameworkDocTypesForRank ?? []),
      ...(evidenceKeywords ?? []).slice(0, 20),  // cap to prevent regex overflow
    ]
      .flatMap(dt => dt.toLowerCase().split(/[\/,\s]+/))
      .map(f => f.trim().replace(/\s+/g, ".?"))
      .filter(f => f.length >= 3)
      .join("|");
    const HIGH_VALUE_RE = new RegExp(
      `${FILINGS_BASE}|${UNIVERSAL_DISCLOSURE}${metaTopic ? "|" + metaTopic : ""}`,
      "i"
    );
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

    // 42-F: Batch-scoped circuit breaker for slow hosts.
    // State is shared across companies within a batch. If 3 consecutive fetches
    // from the same host exceed SLOW_FETCH_THRESHOLD_MS, circuit-break that host
    // for the remainder of the batch.
    const SLOW_FETCH_THRESHOLD_MS = 15_000;
    const CIRCUIT_BREAK_THRESHOLD = 3;
    const batchState = opts.batchFetchState ?? newBatchFetchState();
    const { hostSlowFetches, hostCircuitBroken } = batchState;

    const processOne = async (doc: typeof sortedPending[number]): Promise<void> => {
      if (cancelCheck?.()) return;

      // Check budget before starting this document
      if (Date.now() - fetchPhaseStart > FETCH_PHASE_BUDGET_MS) {
        fetchBudgetExceeded = true;
        return;
      }

      // 41-K: Skip if host is circuit-broken
      let docHost = "";
      try { docHost = new URL(doc.url).hostname; } catch {}
      if (docHost && hostCircuitBroken.has(docHost)) {
        console.log(`[${companyName}] 41-K: skipping ${doc.url.slice(0, 60)} (host circuit-broken)`);
        await storage.recordFetchFailure(companyId, doc.url, "circuit_broken");
        return;
      }

      try {
        const type = inferDocumentType(doc.url);
        // P5: Force headless for pinned/known URLs (they are high-priority and
        // often on defended/JS-rendered sites like smfg.co.jp).
        const gateReason = ((doc as any).gateReason || "").toLowerCase();
        const isPinnedOrKnown = gateReason.includes("lane: pinned") || gateReason.includes("lane: known");
        // Wrap processDocument with a per-document timeout
        const fetchStart = Date.now();
        const content = await withTimeout(
          processDocument(doc.url, type, { forceHeadless: isPinnedOrKnown }),
          PER_DOCUMENT_TIMEOUT_MS,
          `[${companyName}] fetch ${doc.url.slice(0, 80)}`
        );
        // 41-K: Track fetch latency for circuit-breaker
        const fetchElapsed = Date.now() - fetchStart;
        if (docHost && fetchElapsed >= SLOW_FETCH_THRESHOLD_MS) {
          const n = (hostSlowFetches.get(docHost) || 0) + 1;
          hostSlowFetches.set(docHost, n);
          if (n >= CIRCUIT_BREAK_THRESHOLD) {
            hostCircuitBroken.add(docHost);
            console.warn(`[${companyName}] 41-K: circuit break: ${docHost} (${n} consecutive slow fetches)`);
          }
        } else if (docHost) {
          hostSlowFetches.set(docHost, 0); // reset streak on fast fetch
        }

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
                await storage.recordFetchFailure(companyId, doc.url, "verification_failed");
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
              await storage.recordFetchFailure(companyId, doc.url, "empty_after_render");
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
          await storage.recordFetchFailure(companyId, doc.url, "fetch_returned_empty");
        }
      } catch (error: any) {
        if (error instanceof TimeoutError) {
          console.warn(`[${companyName}] Document fetch TIMEOUT (${PER_DOCUMENT_TIMEOUT_MS / 1000}s) — marking dead: ${doc.url.slice(0, 100)}`);
          await storage.recordFetchDead(companyId, doc.url, "timeout");
        } else if (error instanceof TransientFetchError) {
          console.warn(`[${companyName}] Transient fetch failure — keeping retryable: ${doc.url.slice(0, 100)} (${error.message})`);
          await storage.recordFetchFailure(companyId, doc.url, "transient");
        } else if (error instanceof PermanentFetchError) {
          // Classify the permanent failure by HTTP status
          const status = (error as any).statusCode;
          const reason = status === 401 ? "paywall_401" : status === 403 ? "blocked_403" : status === 404 ? "not_found_404" : "blocked_403";
          console.warn(`[${companyName}] Permanent fetch failure (${reason}) — marking dead: ${doc.url.slice(0, 100)} (${error.message})`);
          await storage.recordFetchDead(companyId, doc.url, reason);
        } else {
          // Unknown error — classify from message heuristics
          const msg = (error.message || "").toLowerCase();
          const reason = msg.includes("403") ? "blocked_403" : msg.includes("404") ? "not_found_404" : msg.includes("timeout") ? "timeout" : "transient";
          console.warn(`[${companyName}] Fetch failed (${reason}) for ${doc.url}: ${error.message}`);
          await storage.recordFetchFailure(companyId, doc.url, reason);
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
        await storage.recordFetchDead(companyId, doc.url, "budget_exceeded");
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

  // ─── One-Hop PDF Harvest (P2a + Fix 3: headless DOM + latest-year bias) ────────
  // When a fetched company-domain page is index-like (many links, little substantive text),
  // extract same-domain/CDN PDF links whose anchor text matches the framework topic.
  // Fix 3: Also try headless-rendered DOM for JS-rendered IR pages (SMFG class).
  // Fix 3: Prefer latest-year reports (2024/2023) over older ones.
  try {
    const fetchedOkDocs = await storage.getFetchedDocuments(companyId);
    const topicPattern = new RegExp(
      (framework.topicDescription || framework.name || "sustainability")
        .toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5).join("|"),
      "i"
    );
    let harvestedCount = 0;
    const MAX_HARVEST = 5;
    const currentYear = new Date().getFullYear();
    const recentYearPattern = new RegExp(`(${currentYear}|${currentYear - 1}|${currentYear - 2})`);

    for (const doc of fetchedOkDocs) {
      if (harvestedCount >= MAX_HARVEST) break;
      if (!companyDomain || !doc.url.toLowerCase().includes(companyDomain)) continue;
      if (/\.pdf(\?|$)/i.test(doc.url)) continue; // Already a PDF
      let content = doc.content || "";

      // Fix 3: If the fetched content is too short (likely a JS-rendered page where
      // the real links are in the DOM), try fetching the page with the headless browser
      // to get the rendered HTML with actual PDF links. This is the SMFG case.
      const linkMatches = content.match(/href=["'][^"']*\.pdf[^"']*/gi) || [];
      if (linkMatches.length < 2 && content.length < 2000) {
        // Likely a JS-rendered IR page — try headless render for link extraction
        try {
          const rendered = await processDocument(doc.url, "html");
          if (rendered && rendered.length > content.length) {
            // processDocument returns text, not HTML. We need the raw HTML for link extraction.
            // Instead, do a targeted headless fetch just for links.
            content = rendered; // Use whatever we got
          }
        } catch { /* non-fatal */ }
      }

      // Re-check for PDF links in the (possibly headless-rendered) content
      const allLinkMatches = content.match(/href=["'][^"']*\.pdf[^"']*/gi) || [];
      if (allLinkMatches.length < 1) continue;

      // Collect all candidate PDFs with year info for sorting
      const pdfCandidates: Array<{ url: string; year: number; anchor: string }> = [];
      for (const link of allLinkMatches.slice(0, 20)) {
        const hrefMatch = link.match(/href=["']([^"']+)/i);
        if (!hrefMatch) continue;
        let pdfUrl = hrefMatch[1];
        // Resolve relative URLs
        if (pdfUrl.startsWith("/")) {
          try { pdfUrl = new URL(pdfUrl, doc.url).href; } catch { continue; }
        }
        if (!/\.pdf(\?|$)/i.test(pdfUrl)) continue;
        // Must be same domain or common CDN
        const pdfHost = (() => { try { return new URL(pdfUrl).hostname; } catch { return ""; } })();
        const isSameDomain = pdfHost.includes(companyDomain) ||
          /ctfassets\.net|q4cdn\.com|s3\.amazonaws\.com/i.test(pdfHost);
        if (!isSameDomain) continue;
        // Check if anchor text or URL matches framework topic
        const anchorText = link.toLowerCase();
        if (!topicPattern.test(anchorText) && !topicPattern.test(pdfUrl.toLowerCase())) continue;
        // Extract year from URL or anchor for recency sorting
        const yearMatch = (pdfUrl + " " + anchorText).match(/(20[12]\d)/g);
        const year = yearMatch ? Math.max(...yearMatch.map(Number)) : 0;
        pdfCandidates.push({ url: pdfUrl, year, anchor: anchorText });
      }

      // Fix 3: Sort by year descending (prefer latest reports)
      pdfCandidates.sort((a, b) => b.year - a.year);

      for (const candidate of pdfCandidates) {
        if (harvestedCount >= MAX_HARVEST) break;
        const existing = await storage.getDocumentByUrl(companyId, candidate.url);
        if (!existing) {
          const yearLabel = candidate.year > 0 ? ` (${candidate.year})` : "";
          await storage.addDiscoveredDocument(companyId, candidate.url, `PDF harvest${yearLabel}: ${candidate.url.split("/").pop()}`, "first_party");
          harvestedCount++;
        }
      }
    }
    if (harvestedCount > 0) {
      console.log(`[${companyName}] ONE-HOP PDF HARVEST: discovered ${harvestedCount} new PDFs from landing pages (latest-year preferred)`);
    }
  } catch (harvestErr: any) {
    console.warn(`[${companyName}] PDF harvest failed (non-fatal): ${harvestErr.message}`);
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
    // Raw fetch-coverage weakness (discovery links that failed). Retained for
    // transparency, but NOT sufficient on its own to declare low evidence.
    const fetchWeakness = totalFetched < 3 || fetchRatio < 0.5 || (deadTier1 && fetchRatio < 0.7);
    // Corpus-aware low-evidence: a result is only genuinely low-evidence if the
    // USABLE corpus we actually retrieved is thin. A large corpus (e.g. a
    // multi-million-char filer) is never low-evidence even when many ancillary
    // discovery links went dead — those dead links don't reduce the evidence we
    // have. This keeps `lowEvidence` consistent with the auto-reexam thin-corpus
    // gate (AUTO_REEXAM_MAX_CHARS) so a company can never be lowEvidence=true yet
    // simultaneously skipped as a "thick corpus" legitimate zero.
    let corpusChars = 0;
    try { corpusChars = await storage.getCorpusCharCount(companyId); } catch { /* non-fatal */ }
    const corpusThin = corpusChars < AUTO_REEXAM_MAX_CHARS;
    const lowEvidence = fetchWeakness && corpusThin;
    // P3b: Surface "found but unretrievable" — identify first-party docs that were
    // discovered (relevant to the topic) but died on fetch. This converts a false "No"
    // into an actionable "exists, unread" diagnostic.
    // P4 fix: (a) use actual failureReason from the document record,
    //         (b) exclude speculatively constructed probe-lane URLs (only include
    //             documents from actual search results or pinned sources).
    const unretrievableFirstParty = deadDocs
      .filter(d => {
        const urlLower = (d.url || "").toLowerCase();
        // First-party: on the company's own domain
        if (!companyDomain || !urlLower.includes(companyDomain)) return false;
        // P4b: Provenance-based probe exclusion. The lane is stored in gateReason
        // as "Priority: X, Lane: <lane_name>". Exclude speculative probe-lane URLs
        // (constructed from topic lexicon, never found by a search engine).
        const gateReason = ((d as any).gateReason || "").toLowerCase();
        if (gateReason.includes("lane: topic-probe-url") || gateReason.includes("lane: probe")) return false;
        return true;
      })
      .map(d => ({
        url: d.url,
        title: d.title || null,
        reason: d.failureReason || "unknown",
        lane: ((d as any).gateReason || "").match(/Lane:\s*([\w-]+)/)?.[1] || "unknown",
      }))
      .slice(0, 10); // Cap at 10 for diagnostics readability

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
          corpusChars,
          corpusThin,
          fetchWeakness,
          lowEvidence,
          budgetExceeded: fetchBudgetExceeded,
          // P3b: "found but unretrievable" — first-party docs that died on fetch
          unretrievableFirstParty: unretrievableFirstParty.length > 0 ? unretrievableFirstParty : undefined,
        },
      } as any,
    });
    if (unretrievableFirstParty.length > 0) {
      console.warn(`[${companyName}] FOUND-BUT-UNRETRIEVABLE: ${unretrievableFirstParty.length} first-party docs discovered but failed to fetch: ${unretrievableFirstParty.map(d => d.url).join(", ")}`);
    }
    if (lowEvidence) {
      console.warn(`[${companyName}] LOW EVIDENCE: only ${totalFetched}/${totalDiscovered} docs fetched (ratio ${Math.round(fetchRatio * 100)}%${deadTier1 ? ', a primary filing failed to fetch' : ''}), thin corpus (${corpusChars} chars) — score may understate true disclosure`);
    } else if (fetchWeakness && !corpusThin) {
      console.log(`[${companyName}] Fetch-coverage weak (ratio ${Math.round(fetchRatio * 100)}%) but corpus is substantial (${corpusChars} chars) — NOT flagged low-evidence`);
    }
  } catch (covErr: any) {
    console.warn(`[${companyName}] Failed to persist fetch-coverage diagnostics (non-fatal): ${covErr.message}`);
  }

  // ─── Instruction 15: Post-fetch validation for recency backfill ────────────
  // Confirm that any backfill_pending URLs actually fetched to ≥200 chars of body.
  // If not, downgrade status to backfill_failed.
  const recencyStatus = discoveryResult.diagnostics?.recencyStatus as Record<string, any> | undefined;
  if (recencyStatus) {
    for (const [docType, status] of Object.entries(recencyStatus)) {
      if (status.status !== "backfill_pending" || !status.backfilledUrl) continue;
      const doc = finalDocs.find(d => d.url === status.backfilledUrl);
      if (doc && doc.fetchStatus === "ok") {
        // Check if content is substantial (will be validated via content length later)
        recencyStatus[docType] = { ...status, status: "backfilled" };
        console.log(`[${companyName}] RECENCY-CHECK: backfill confirmed for "${docType}": ${status.backfilledUrl}`);
      } else {
        recencyStatus[docType] = { ...status, status: "backfill_failed" };
        console.warn(`[${companyName}] RECENCY-CHECK: backfill for "${docType}" failed to fetch (${doc ? doc.fetchStatus : "not found"})`);
      }
    }
    // Persist the updated recencyStatus
    try {
      const priorDiag = (await storage.getCompanyById(companyId, workspaceId))?.discoveryDiagnostics as any || {};
      priorDiag.recencyStatus = recencyStatus;
      await storage.updateCompany(companyId, workspaceId, { discoveryDiagnostics: priorDiag } as any);
    } catch (e: any) {
      console.warn(`[${companyName}] Failed to persist recencyStatus: ${e.message}`);
    }
  }

  // ─── Corpus Snapshot: freeze the evidence set for this batch ──────────────
  // This makes re-scoring byte-identical: the analyze phase reads from batch_corpus
  // instead of the live documents table, so corpus composition is frozen at fetch time.
  if (batchId) {
    try {
      const { db } = await import("../db.js");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        INSERT INTO batch_corpus (batch_id, company_id, document_id)
        SELECT ${batchId}, ${companyId}, id FROM documents
        WHERE company_id = ${companyId}
          AND (fetch_status = 'ok' OR content_id IS NOT NULL)
        ON CONFLICT DO NOTHING
      `);
      console.log(`[${companyName}] CORPUS SNAPSHOT: frozen for batch ${batchId}`);
    } catch (snapErr: any) {
      console.warn(`[${companyName}] Corpus snapshot failed (non-fatal): ${snapErr.message}`);
    }
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
  batchId?: number;
  cancelCheck?: () => boolean;
}): Promise<AnalysisResult | null> {
  const { company, framework, measures, workspaceId, batchId, cancelCheck } = opts;
  const companyId = company.id;
  const companyName = company.name;
  console.log(`[${companyName}] === PHASE 2: ANALYZE ===`);

  // Read corpus validity warning from diagnostics (set during fetch phase)
  const companyDiag = (company.discoveryDiagnostics as any) || {};
  const corpusValidityWarning: string | null = companyDiag.corpusValidityWarning || null;

  // Load settings for scoring mode (needed for prompt hash stamping)
  const settings = await storage.getSettings(workspaceId);
  // Update status to analyzing
  await storage.updateCompany(companyId, workspaceId, { analysisStatus: "analyzing" });

  // Load documents: prefer batch_corpus snapshot (deterministic) over live documents table.
  // DOCUMENT POOL (P3a): At analyze time, retrieve from the UNION of:
  //   (i) all fetch_status='ok' documents ever collected for the company, AND
  //   (ii) this run's targeted discovery.
  // This is safe because the tool is recall-limited, precision-robust: per-measure
  // BM25 + topic-term signal self-filter off-topic documents, and no false positives
  // were observed even at 70-80 docs. The batch_corpus snapshot still freezes the
  // exact set used so re-score stays byte-identical.
  //
  // When a batch_corpus snapshot exists for this batch+company, use it with stable ORDER BY d.id
  // so the evidence pack is identical every time. Falls back to the full pool if no snapshot.
  let fetchedDocs: Awaited<ReturnType<typeof storage.getFetchedDocuments>>;
  if (batchId) {
    try {
      const { db: dbImport } = await import("../db.js");
      const { sql: sqlImport } = await import("drizzle-orm");
      const snapshotRows = await dbImport.execute(sqlImport`
        SELECT d.id, d.company_id, d.url, d.title, d.type, d.gate_verdict,
               d.gate_reason, d.fetch_status, d.fetch_failures, d.fetched_at, d.created_at,
               COALESCE(dc.content, d.content) AS content
        FROM batch_corpus bc
        JOIN documents d ON d.id = bc.document_id
        LEFT JOIN document_content dc ON dc.id = d.content_id
        WHERE bc.batch_id = ${batchId} AND bc.company_id = ${companyId}
        ORDER BY d.id
      `);
      if (snapshotRows.rows.length > 0) {
        fetchedDocs = snapshotRows.rows as any;
        console.log(`[${companyName}] Using batch_corpus snapshot (${fetchedDocs.length} docs, batch ${batchId})`);
      } else {
        // No snapshot — use the full document pool (all ever-fetched docs for this company)
        fetchedDocs = await storage.getAllFetchedDocumentsForCompany(companyId);
        console.log(`[${companyName}] Using full document pool (${fetchedDocs.length} docs, no snapshot)`);
      }
    } catch (snapErr: any) {
      console.warn(`[${companyName}] batch_corpus read failed, falling back to pool: ${snapErr.message}`);
      fetchedDocs = await storage.getAllFetchedDocumentsForCompany(companyId);
    }
  } else {
    // No batch context — use the full document pool
    fetchedDocs = await storage.getAllFetchedDocumentsForCompany(companyId);
  }

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

  // ─── FETCH-OUTCOME CONFIDENCE ADJUSTMENT ────────────────────────────────
  // If gate-accepted, on-topic documents failed to fetch (dead), any "No" verdict
  // with High/Medium confidence is unreliable — the evidence may have been in
  // those unfetched documents. Downgrade to Low confidence and annotate.
  // This is the reviewer's "single most valuable fix": fetch failures must not
  // produce confident negatives.
  try {
    const allAcceptedDocs = await storage.getAcceptedDocuments(companyId);
    const deadAccepted = allAcceptedDocs.filter(d => d.fetchStatus === "dead");
    if (deadAccepted.length > 0) {
      const deadTitles = deadAccepted.map(d => d.title || d.url).slice(0, 5);
      const deadCount = deadAccepted.length;
      const deadFirstParty = deadAccepted.filter(d => d.sourceType === "first_party");
      // Determine if the dead docs are material (first-party or Tier-1 filings)
      const hasMaterialDead = deadFirstParty.length > 0 || deadAccepted.some(d =>
        /10-?k|20-?f|annual.?report|integrated.?report|def.?14a|proxy|sustainability/i.test((d.url + " " + (d.title || "")).toLowerCase())
      );
      // P3b: blocked_403/empty_after_render on a RELEVANT document (company-domain or
      // topic-titled) is a stronger signal than not_found_404. These are documents
      // that exist but couldn't be retrieved — the evidence is likely there.
      const companyDomainLower = (company.domain || "").replace(/^www\./, "").toLowerCase();
      const hasBlockedRelevant = deadAccepted.some(d => {
        const reason = (d as any).failureReason || "";
        const isBlocked = reason === "blocked_403" || reason === "empty_after_render";
        const isOnCompanyDomain = companyDomainLower && d.url.toLowerCase().includes(companyDomainLower);
        return isBlocked && isOnCompanyDomain;
      });
      if (hasMaterialDead || hasBlockedRelevant) {
        let downgraded = 0;
        for (const cat of analysis.categories) {
          for (const m of cat.measures) {
            // Only downgrade "No" verdicts with High/Medium confidence
            if (m.verdict === "No" && (m.confidence === "High" || m.confidence === "Medium")) {
              m.confidence = "Low";
              m.verdictNuance = (m.verdictNuance || "") +
                ` [Confidence downgraded: ${deadCount} gate-accepted document(s) failed to fetch (${deadFirstParty.length} first-party). Missing: ${deadTitles.join("; ")}]`;
              downgraded++;
            }
          }
        }
        if (downgraded > 0) {
          console.log(`[${companyName}] FETCH-CONFIDENCE: downgraded ${downgraded} measures from High/Medium to Low (${deadCount} dead accepted docs, ${deadFirstParty.length} first-party)`);
        }
      }
    }
  } catch (fcErr: any) {
    console.warn(`[${companyName}] Fetch-confidence adjustment failed (non-fatal): ${fcErr.message}`);
  }
  // ─── Coverage-Based Confidence Cap (P4c) ─────────────────────────────────────
  // A "No" verdict built on a thin, suspect, or minimal corpus should never be
  // reported as High confidence. This folds corpus validity + coverage signals into
  // a hard cap on negative confidence, making the tool honest about what it could not retrieve.
  {
    const freshCompany = await storage.getCompanyById(companyId, workspaceId);
    const diag = (freshCompany?.discoveryDiagnostics as any) || {};
    const coverageLevel = diag.coverage?.coverageLevel || "unknown";
    const isSuspectOrMinimal = coverageLevel === "suspect" || coverageLevel === "minimal";
    const shouldClamp = corpusValidityWarning || isSuspectOrMinimal;

    if (shouldClamp) {
      let cvClamped = 0;
      const reason = corpusValidityWarning
        ? "corpus validity warning — documents lack framework-relevant data"
        : `coverage level is "${coverageLevel}" — insufficient evidence for confident negatives`;
      for (const cat of analysis.categories) {
        for (const m of cat.measures) {
          if (m.verdict === "No" && (m.confidence === "High" || m.confidence === "Medium")) {
            m.confidence = "Low";
            m.verdictNuance = (m.verdictNuance || "") +
              ` [Confidence clamped: ${reason}]`;
            cvClamped++;
          }
        }
      }
      if (cvClamped > 0) {
        console.log(`[${companyName}] COVERAGE-CONFIDENCE-CLAMP: downgraded ${cvClamped} "No" measures to Low (${reason})`);
      }
    }
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
        // Review fix: methodology stamping — enables cross-batch comparability
        modelId: (m as any)._gradedBy || null,
        promptHash: getPromptHash(settings.scoring_mode || "binary"),
        pipelineVersion: getPipelineVersion(),
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
const AUTO_REEXAM_MAX = parseInt(process.env.AUTO_REEXAM_MAX || "3", 10);
// AUTO_REEXAM_MAX_CHARS declared at module top (shared with fetch-coverage block).

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
      // Instruction 17: Even if corpus is thick, check if first-party docs are
      // overwhelmingly dead. If >=50% of first-party docs are dead AND there are
      // >=3 first-party docs, this is NOT a legitimate zero — it's a fetch-layer
      // failure that should be escalated.
      const allDocs = await storage.getAcceptedDocuments(companyId);
      const firstPartyDocs = allDocs.filter((d: any) => d.sourceType === "first_party");
      const firstPartyDead = firstPartyDocs.filter((d: any) => d.fetchStatus === "dead").length;
      const firstPartyDeadRatio = firstPartyDocs.length > 0 ? firstPartyDead / firstPartyDocs.length : 0;

      if (firstPartyDeadRatio >= 0.5 && firstPartyDocs.length >= 3) {
        console.log(
          `[${companyName}] Auto-reexam ESCALATED: firstPartyDead=${firstPartyDead}/${firstPartyDocs.length} ` +
          `(ratio=${Math.round(firstPartyDeadRatio * 100)}%), retrying with fresh browser instance`
        );
        // Don't skip — fall through to the retry logic below
      } else {
        console.log(
          `[${companyName}] Auto-reexam SKIPPED: legitimate zero ` +
            `(corpusChars=${corpusChars}, lowEvidence=${coverage?.lowEvidence ?? "n/a"}, ` +
            `fetchRatio=${coverage?.fetchRatio ?? "n/a"}, dead=${coverage?.documentsDead ?? "n/a"}, ` +
            `firstPartyDead=${firstPartyDead}/${firstPartyDocs.length})`
        );
        return false;
      }
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
  const { company, framework, measures, workspaceId, batchId, cancelCheck, skipFetch } = opts;
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
        fetchResult = await runFetchPhase({ company, framework, workspaceId, batchId, cancelCheck, batchFetchState: opts.batchFetchState });
        
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
      const analysis = await runAnalyzePhase({ company, framework, measures, workspaceId, batchId, cancelCheck });

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
