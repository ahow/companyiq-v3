// PR 1 · Change 4: Auto re-retrieval for Low-confidence measures.
//
// When a measure scores Low-confidence, this module fires ONE targeted
// discovery query for that measure, merges any NEW documents into the
// corpus (subject to 1c's chunk sanity gate and 1b's ranking penalties),
// and returns a fresh EvidencePack the analyzer can rescore against.
//
// Costs are strictly bounded by `RetrievalReviewQueue`, which is
// instantiated ONCE per portfolio job and dedupes on the composite
// key `${companyId}:${measureId}`. Every fire is capped at 1 per
// (company, measure) per batch.
//
// The whole module is inert unless both `retrievalV2` AND `autoReretrieval`
// are on AND a reviewQueue is passed through. When either is off the
// caller never invokes it, so pre-change behaviour is byte-identical.

import type { Framework, FrameworkMeasure, TrustedSource } from "../../shared/schema.js";
import type { IssuerProfile } from "./issuer-profile.js";
import { searchCompanyDocuments, type DiscoveryCandidate } from "./discovery.js";
import {
  chunkDocuments,
  buildBM25Index,
  buildEvidencePackForMeasure,
  applyChunkSanityGate,
  type EvidencePack,
} from "./passage-retrieval.js";
import { processDocument, inferDocumentType } from "./processor.js";

/**
 * PR 1 · Change 4: Input for a single measure's targeted re-retrieval.
 * Assembled by the analyzer at scoring time (see analyzer.ts).
 */
export interface ReretrievalRequest {
  company: {
    id: number;
    name: string;
    domain?: string | null;
    isin?: string | null;
    ticker?: string | null;
    sector?: string | null;
    country?: string | null;
  };
  measure: FrameworkMeasure;
  framework: Framework;
  trustedSources: TrustedSource[];
  issuerProfile?: IssuerProfile;
  /** Current corpus text (with `--- DOCUMENT: <title> [<url>] ---` headers). */
  existingCorpusText: string;
  /** URLs of docs already in the corpus (dedupe target for new discovery hits). */
  existingDocUrls: Set<string>;
  /** Composite key `${companyId}:${measureId}` — used for the per-batch dedupe Set. */
  fingerprintKey: string;
}

/**
 * PR 1 · Change 4: Result envelope. `fired=false` means we short-circuited
 * (already-fired dedupe). `fired=true` covers every outcome that spent a
 * discovery call, whether it added docs, added none, or errored.
 */
export interface ReretrievalResult {
  fired: boolean;
  newEvidencePack?: EvidencePack;
  augmentedCorpusText?: string;
  /** Count of NEW docs successfully fetched and merged into the corpus. */
  newDocsAdded: number;
  targetedQuery: string;
  reason: "skipped-already-fired" | "no-new-docs" | "success" | "search-failed";
  detail?: string;
}

/** Truncation ceiling for the query fragment carved from the measure definition. */
const QUERY_FRAGMENT_MAX_CHARS = 120;

/** Per-measure discovery budget: single targeted query, moderate depth. */
const RERETRIEVAL_SEARCH_DEPTH = 10;
const RERETRIEVAL_QUERY_VARIANTS = 0;

/** Per-doc fetch timeout so a single hostile URL cannot block scoring. */
const RERETRIEVAL_PER_DOC_TIMEOUT_MS = 30_000;

/** Hard cap on how many new docs we merge in a single re-retrieval. */
const RERETRIEVAL_MAX_NEW_DOCS = 5;

/**
 * PR 1 · Change 4: Compose the targeted query string for a Low-confidence
 * measure. Exported for tests (query composition rules are the primary
 * behavioural surface of this module).
 *
 * Rules:
 *   - Field precedence: substantiveDefinition > definition > title
 *   - Truncate at first sentence boundary AND at QUERY_FRAGMENT_MAX_CHARS
 *   - Company name is quoted; embedded double quotes are stripped so the
 *     final query stays valid for Serper/SerpAPI.
 */
export function composeTargetedQuery(companyName: string, measure: FrameworkMeasure, currentYear: number): string {
  const m: { substantiveDefinition?: string | null; definition?: string | null; title: string } = measure;
  const rawText = m.substantiveDefinition || m.definition || m.title || "";
  // Truncate to keep the query focused — long definitions dilute Serper results.
  const firstSentence = rawText.split(/[.!?]/)[0] || "";
  const queryFragment = firstSentence.slice(0, QUERY_FRAGMENT_MAX_CHARS).trim();
  // Strip embedded double quotes so the outer `"…"` wrapping stays balanced.
  const safeName = companyName.replace(/"/g, "");
  return `"${safeName}" ${queryFragment} ${currentYear} OR ${currentYear - 1} annual report OR sustainability report`;
}

/**
 * PR 1 · Change 4: Fetch a discovery candidate's text via the existing
 * processor pipeline (fetchWithRetry → pdf-parse / cheerio-strip, with
 * headless-browser fallback). Returns null on any failure so the caller
 * can dedupe/log and move on.
 *
 * Reused rather than reimplemented: `processDocument` already handles
 * PDFs, HTML, WAF challenges, cookie warm-up, and browser fallback —
 * exactly the same path the fetch phase uses.
 */
async function fetchCandidateText(candidate: DiscoveryCandidate): Promise<string | null> {
  try {
    const type = inferDocumentType(candidate.url);
    const contentPromise = processDocument(candidate.url, type);
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), RERETRIEVAL_PER_DOC_TIMEOUT_MS),
    );
    const content = await Promise.race([contentPromise, timeoutPromise]);
    if (!content || content.length < 200) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * PR 1 · Change 4: Fire a single targeted `searchCompanyDocuments` query for
 * the given Low-confidence measure, merge any NEW documents into the corpus,
 * and return a fresh EvidencePack.
 *
 * Guaranteed side effects:
 *   - `firedSet.add(fingerprintKey)` on every non-skip path (bounds cost)
 *   - No network activity when `fingerprintKey` is already in `firedSet`
 *
 * Behaviour on failure paths:
 *   - Discovery throws → `{ fired: true, reason: "search-failed" }`
 *   - Discovery returns only known URLs → `{ fired: true, reason: "no-new-docs" }`
 *   - All fetch attempts fail → `{ fired: true, reason: "no-new-docs" }`
 *
 * @param req request bundle (see ReretrievalRequest)
 * @param firedSet per-batch dedupe Set (see RetrievalReviewQueue.getFiredSet)
 */
export async function runTargetedReretrieval(
  req: ReretrievalRequest,
  firedSet: Set<string>,
): Promise<ReretrievalResult> {
  const currentYear = new Date().getUTCFullYear();
  const targetedQuery = composeTargetedQuery(req.company.name, req.measure, currentYear);

  // Dedupe — the cost gate. One fire per (company, measure) per batch, period.
  if (firedSet.has(req.fingerprintKey)) {
    return {
      fired: false,
      newDocsAdded: 0,
      targetedQuery,
      reason: "skipped-already-fired",
    };
  }
  firedSet.add(req.fingerprintKey);

  // Discovery call. Retains 1b's ranking penalties via retrievalV2=true; issuer
  // context flows to 1c-style entity checks on the merged chunk pool below.
  let candidates: DiscoveryCandidate[];
  try {
    const discoveryResult = await searchCompanyDocuments({
      companyName: req.company.name,
      companyId: req.company.id,
      companyDomain: req.company.domain ?? null,
      isin: req.company.isin ?? null,
      ticker: req.company.ticker ?? null,
      sector: req.company.sector ?? null,
      country: req.company.country ?? null,
      pinnedUrls: [],
      framework: req.framework,
      trustedSources: req.trustedSources,
      searchDepth: RERETRIEVAL_SEARCH_DEPTH,
      queryVariants: RERETRIEVAL_QUERY_VARIANTS,
      evidenceKeywords: req.measure.evidenceKeywords || undefined,
      retrievalV2: true,
    });
    candidates = discoveryResult.documents || [];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      fired: true,
      newDocsAdded: 0,
      targetedQuery,
      reason: "search-failed",
      detail: msg,
    };
  }

  // Filter to NEW URLs only (dedupe against the caller-provided set).
  const newCandidates: DiscoveryCandidate[] = [];
  for (const c of candidates) {
    if (!c.url || req.existingDocUrls.has(c.url)) continue;
    newCandidates.push(c);
    if (newCandidates.length >= RERETRIEVAL_MAX_NEW_DOCS) break;
  }

  if (newCandidates.length === 0) {
    return {
      fired: true,
      newDocsAdded: 0,
      targetedQuery,
      reason: "no-new-docs",
    };
  }

  // Fetch text for each new candidate via the SAME pipeline the fetch phase
  // uses. Failures are skipped, not fatal — a re-retrieval that surfaces
  // 3 of 5 candidates is still a valid partial win.
  const fetched: Array<{ url: string; title: string; text: string }> = [];
  for (const c of newCandidates) {
    const text = await fetchCandidateText(c);
    if (!text) continue;
    fetched.push({ url: c.url, title: c.title || c.url, text });
  }

  if (fetched.length === 0) {
    return {
      fired: true,
      newDocsAdded: 0,
      targetedQuery,
      reason: "no-new-docs",
      detail: `${newCandidates.length} new candidates found but all fetches failed`,
    };
  }

  // Concatenate using the analyzer's canonical doc header format so
  // chunkDocuments can parse per-chunk provenance (docUrl / docTitle).
  const newDocsBlock = fetched
    .map((d) => `\n\n--- DOCUMENT: ${d.title} [${d.url}] ---\n\n${d.text}`)
    .join("");
  const augmentedCorpusText = req.existingCorpusText + newDocsBlock;

  // Rebuild chunks + BM25 index on the augmented corpus and apply 1c's sanity
  // gate WITH `preserveIfOnlySource: true` — this is where that 1c parameter
  // (accepted-but-not-yet-used) finally gets exercised. issuerProfile flows in
  // so entity mismatches on the newly merged docs are still caught.
  let evidencePack: EvidencePack;
  try {
    const rawChunks = chunkDocuments(augmentedCorpusText);
    const gate = applyChunkSanityGate(rawChunks, {
      issuerProfile: req.issuerProfile,
      currentYear,
      preserveIfOnlySource: true,
    });
    const keptChunks = gate.keep.length > 0 ? gate.keep : rawChunks;
    const bm25Index = buildBM25Index(keptChunks.map((c) => c.text));
    evidencePack = buildEvidencePackForMeasure({
      measure: req.measure,
      chunks: keptChunks,
      bm25Index,
      companyId: req.company.id,
      frameworkId: req.framework.id,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      fired: true,
      newDocsAdded: fetched.length,
      targetedQuery,
      reason: "search-failed",
      detail: `evidence rebuild failed: ${msg}`,
    };
  }

  return {
    fired: true,
    newEvidencePack: evidencePack,
    augmentedCorpusText,
    newDocsAdded: fetched.length,
    targetedQuery,
    reason: "success",
  };
}

/**
 * PR 1 · Change 4: Per-batch dedupe registry. One instance per analysis run
 * (per portfolio scoring job). Ensures each (companyId, measureId) fires at
 * most one re-retrieval per batch — the cost gate for this change.
 *
 * Threading: instantiated at `runAnalysisPipeline` scope in pipeline.ts and
 * passed through `runAnalyzePhase` → `analyzeCompanyMeasures`. When the
 * caller omits it, the analyzer treats re-retrieval as disabled.
 */
export class RetrievalReviewQueue {
  private fired = new Set<string>();

  /** True iff a re-retrieval has already been fired for this (company, measure). */
  hasFired(companyId: number, measureId: string): boolean {
    return this.fired.has(`${companyId}:${measureId}`);
  }

  /** Record a fire without invoking discovery — used by tests and manual paths. */
  markFired(companyId: number, measureId: string): void {
    this.fired.add(`${companyId}:${measureId}`);
  }

  /** The underlying Set — passed by reference into `runTargetedReretrieval`. */
  getFiredSet(): Set<string> {
    return this.fired;
  }

  /** Diagnostic-only: how many measures have fired so far in this batch. */
  get size(): number {
    return this.fired.size;
  }
}
