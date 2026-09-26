/**
 * Instruction 46 Follow-Up — Strict Replay Corpus Pinning
 * ────────────────────────────────────────────────────────
 * When scoreOnly=true and sourceBatchId is supplied, scoring uses EXCLUSIVELY
 * the immutable document IDs stored in the source batch_corpus. No re-fetching,
 * re-resolution, cache refresh, or document mutation is permitted.
 *
 * This module provides:
 *  - Per-company corpus hash computation from batch_corpus snapshot
 *  - Source/replay hash comparison with divergence detection
 *  - Quarantine logic: reject/flag any replay with hash divergence BEFORE
 *    KPI aggregation
 *  - Deterministic hash: SHA-256 over sorted document_id list
 *
 * Design:
 *  - No company/topic/framework-specific logic
 *  - Deterministic: identical batch_corpus → identical hash
 *  - Fail-closed: divergence → quarantine, never silent acceptance
 */

import { createHash } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CorpusHashEntry {
  companyId: number;
  hash: string;
  documentIds: number[];
}

export interface ReplayCorpusComparison {
  companyId: number;
  sourceHash: string;
  replayHash: string;
  match: boolean;
}

export interface ReplayCorpusVerification {
  totalCompanies: number;
  matchCount: number;
  mismatchCount: number;
  mismatches: ReplayCorpusComparison[];
  allMatch: boolean;
  /** SHA-256 over all per-company hashes (batch-level fingerprint) */
  batchFingerprint: string;
}

// ─── Hash Computation ───────────────────────────────────────────────────────

/**
 * Compute a deterministic corpus hash for a single company from document IDs.
 * The hash is SHA-256 of the sorted, comma-joined document_id list.
 * This is the canonical hash used for replay comparison.
 */
export function computeCorpusHash(documentIds: number[]): string {
  const sorted = [...documentIds].sort((a, b) => a - b);
  return createHash("sha256")
    .update(sorted.join(","))
    .digest("hex");
}

/**
 * Compute per-company corpus hashes for an entire batch.
 * Input: array of { companyId, documentIds } from batch_corpus.
 * Output: per-company hash entries, deterministically ordered by companyId.
 */
export function computeBatchCorpusHashes(
  entries: Array<{ companyId: number; documentIds: number[] }>
): CorpusHashEntry[] {
  return entries
    .map(e => ({
      companyId: e.companyId,
      hash: computeCorpusHash(e.documentIds),
      documentIds: [...e.documentIds].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.companyId - b.companyId);
}

/**
 * Compute a batch-level fingerprint from per-company hashes.
 * Deterministic: same per-company hashes → same batch fingerprint.
 */
export function computeBatchFingerprint(hashes: CorpusHashEntry[]): string {
  const sorted = [...hashes].sort((a, b) => a.companyId - b.companyId);
  const payload = sorted.map(h => `${h.companyId}:${h.hash}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Replay Comparison ──────────────────────────────────────────────────────

/**
 * Compare source and replay corpus hashes per company.
 * Returns detailed comparison with mismatch identification.
 *
 * STRICT CONTRACT: For a valid pinned replay, ALL companies must have
 * identical corpus hashes (22/22 equality). Any divergence indicates
 * document mutation, re-fetching, or cache refresh occurred.
 */
export function verifyReplayCorpusEquality(
  sourceHashes: CorpusHashEntry[],
  replayHashes: CorpusHashEntry[],
): ReplayCorpusVerification {
  const sourceMap = new Map(sourceHashes.map(h => [h.companyId, h]));
  const replayMap = new Map(replayHashes.map(h => [h.companyId, h]));

  const allCompanyIds = new Set([
    ...sourceHashes.map(h => h.companyId),
    ...replayHashes.map(h => h.companyId),
  ]);

  const comparisons: ReplayCorpusComparison[] = [];
  let matchCount = 0;
  let mismatchCount = 0;

  for (const companyId of [...allCompanyIds].sort((a, b) => a - b)) {
    const sourceEntry = sourceMap.get(companyId);
    const replayEntry = replayMap.get(companyId);

    const sourceHash = sourceEntry?.hash ?? "MISSING";
    const replayHash = replayEntry?.hash ?? "MISSING";
    const match = sourceHash === replayHash && sourceHash !== "MISSING";

    if (match) {
      matchCount++;
    } else {
      mismatchCount++;
      comparisons.push({ companyId, sourceHash, replayHash, match: false });
    }
  }

  const batchFingerprint = computeBatchFingerprint(replayHashes);

  return {
    totalCompanies: allCompanyIds.size,
    matchCount,
    mismatchCount,
    mismatches: comparisons,
    allMatch: mismatchCount === 0,
    batchFingerprint,
  };
}

/**
 * Determine whether a replay batch should be quarantined based on
 * corpus hash verification results.
 *
 * Quarantine criteria:
 *  - Any corpus hash mismatch → quarantine
 *  - Missing companies in either source or replay → quarantine
 *
 * Returns { quarantine: boolean, reason: string | null }
 */
export function shouldQuarantineReplay(
  verification: ReplayCorpusVerification,
): { quarantine: boolean; reason: string | null } {
  if (verification.allMatch) {
    return { quarantine: false, reason: null };
  }

  const reason = `Corpus hash divergence: ${verification.mismatchCount}/${verification.totalCompanies} companies have mismatched corpus hashes. ` +
    `Mismatched company IDs: [${verification.mismatches.map(m => m.companyId).join(", ")}]. ` +
    `This indicates document mutation, re-fetching, or cache refresh occurred during replay.`;

  return { quarantine: true, reason };
}

// ═══════════════════════════════════════════════════════════════════════════
// Change #2 — Replayable Evidence Ledger
// ═══════════════════════════════════════════════════════════════════════════
//
// The corpus-hash primitives above pin WHICH documents entered a run. The
// ledger below goes one level deeper: per run, it freezes — for each
// (company, measure) cell — the retrieved document ids AND a content hash of
// every passage that was actually selected/scored. This lets a scoring run be
// REPLAYED against a byte-identical evidence bundle (deterministic re-scoring,
// regression testing, audit) without re-fetching or re-retrieving.
//
// Design contract (identical spirit to the corpus pinning above):
//   - Deterministic: identical passage content → identical hashes → identical
//     bundle hash, regardless of passage ORDER (hashes are sorted before
//     folding, exactly like computeCorpusHash sorts document ids).
//   - Topic/company/framework-agnostic: keyed purely on numeric
//     company/measure/document ids and content hashes. No hardcoded topic.
//   - Fail-LOUD on replay: replayLedgerCell() throws LedgerIntegrityError when
//     the supplied content does not reproduce the frozen bundle hash. This is a
//     replay/AUDIT tool — it is NEVER called on the normal scoring path, so it
//     can never block a live run. The freeze/serialize path is cheap and pure.

// ─── Ledger Types ─────────────────────────────────────────────────────────

/** One selected/scored passage, frozen by content hash (not by raw text). */
export interface LedgerPassage {
  /** Stable passage id within the run (e.g. chunk id / ordinal). */
  passageId: string;
  /** Source document id the passage came from. */
  documentId: number;
  /** SHA-256 of the passage's exact scored content. */
  contentHash: string;
  /** Character length of the scored content (cheap integrity cross-check). */
  charLen: number;
}

/** Frozen evidence bundle for a single (company, measure) cell. */
export interface LedgerCell {
  companyId: number;
  measureId: string;
  /** All document ids retrieved for this cell (sorted, deduped). */
  retrievedDocumentIds: number[];
  /** The passages actually selected/scored for this cell. */
  passages: LedgerPassage[];
  /** SHA-256 over the sorted passage content hashes — the cell bundle hash. */
  bundleHash: string;
}

/** A complete per-run ledger, keyed by run id / batch id. */
export interface RunLedger {
  runId: string;
  batchId: number | null;
  createdAt: string;
  cells: LedgerCell[];
  /** SHA-256 over all cell bundle hashes — the run-level fingerprint. */
  ledgerFingerprint: string;
}

/** Raw passage input at freeze time (content is hashed, never stored raw). */
export interface RawPassageInput {
  passageId: string;
  documentId: number;
  content: string;
}

/** Thrown when a replay bundle fails to reproduce a frozen hash. Fail-loud. */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

// ─── Freeze (write) path — cheap, pure, non-blocking ────────────────────────

/** Deterministic SHA-256 of a single passage's exact scored content. */
export function hashPassageContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute a cell's bundle hash: SHA-256 over the SORTED passage content
 * hashes. Order-insensitive by construction, mirroring computeCorpusHash.
 */
export function computeBundleHash(passages: LedgerPassage[]): string {
  const sorted = passages.map(p => p.contentHash).sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

/**
 * Freeze one (company, measure) cell from raw retrieved docs + selected
 * passages. Hashes each passage's content; never stores the raw text.
 */
export function freezeLedgerCell(
  companyId: number,
  measureId: string,
  retrievedDocumentIds: number[],
  rawPassages: RawPassageInput[],
): LedgerCell {
  const retrieved = [...new Set(retrievedDocumentIds)].sort((a, b) => a - b);
  const passages: LedgerPassage[] = rawPassages.map(p => ({
    passageId: p.passageId,
    documentId: p.documentId,
    contentHash: hashPassageContent(p.content),
    charLen: p.content.length,
  }));
  return {
    companyId,
    measureId,
    retrievedDocumentIds: retrieved,
    passages,
    bundleHash: computeBundleHash(passages),
  };
}

/** Fold cells into a run ledger with a deterministic run-level fingerprint. */
export function freezeRunLedger(
  runId: string,
  batchId: number | null,
  cells: LedgerCell[],
): RunLedger {
  const sortedCells = [...cells].sort((a, b) =>
    a.companyId - b.companyId || a.measureId.localeCompare(b.measureId));
  const payload = sortedCells
    .map(c => `${c.companyId}:${c.measureId}:${c.bundleHash}`)
    .join("\n");
  const ledgerFingerprint = createHash("sha256").update(payload).digest("hex");
  return {
    runId,
    batchId,
    createdAt: new Date().toISOString(),
    cells: sortedCells,
    ledgerFingerprint,
  };
}

// ─── Serialization (persist as JSON / JSONB, no schema change required) ──────

export function serializeRunLedger(ledger: RunLedger): string {
  return JSON.stringify(ledger);
}

export function deserializeRunLedger(json: string): RunLedger {
  const obj = JSON.parse(json);
  if (!obj || typeof obj.runId !== "string" || !Array.isArray(obj.cells)) {
    throw new LedgerIntegrityError("Malformed run ledger JSON");
  }
  return obj as RunLedger;
}

// ─── Replay (read) path — fail-loud on hash mismatch ────────────────────────

/**
 * Re-materialise a cell's exact passage bundle from freshly supplied content
 * (e.g. re-read from the pinned documents) and verify it reproduces the frozen
 * bundle hash. On ANY divergence — missing passage, changed content, extra
 * passage — throws LedgerIntegrityError (fail-loud). On success returns the
 * ordered raw passages, ready to feed straight into the scorer WITHOUT
 * re-fetching or re-retrieving.
 *
 * This is an audit/replay tool: it is never invoked on the live scoring path,
 * so it cannot block a normal run.
 */
export function replayLedgerCell(
  cell: LedgerCell,
  suppliedPassages: RawPassageInput[],
): RawPassageInput[] {
  const byId = new Map(suppliedPassages.map(p => [p.passageId, p]));
  if (byId.size !== cell.passages.length) {
    throw new LedgerIntegrityError(
      `Replay passage count mismatch for company ${cell.companyId} measure ${cell.measureId}: ` +
      `frozen ${cell.passages.length}, supplied ${byId.size}`,
    );
  }
  const rebuilt: LedgerPassage[] = [];
  const ordered: RawPassageInput[] = [];
  for (const frozen of cell.passages) {
    const supplied = byId.get(frozen.passageId);
    if (!supplied) {
      throw new LedgerIntegrityError(
        `Replay missing passage ${frozen.passageId} for company ${cell.companyId} measure ${cell.measureId}`,
      );
    }
    const contentHash = hashPassageContent(supplied.content);
    if (contentHash !== frozen.contentHash) {
      throw new LedgerIntegrityError(
        `Replay content-hash divergence for passage ${frozen.passageId} ` +
        `(company ${cell.companyId} measure ${cell.measureId}): ` +
        `frozen ${frozen.contentHash.slice(0, 12)}…, replay ${contentHash.slice(0, 12)}…`,
      );
    }
    rebuilt.push({ ...frozen, contentHash });
    ordered.push(supplied);
  }
  const replayBundleHash = computeBundleHash(rebuilt);
  if (replayBundleHash !== cell.bundleHash) {
    throw new LedgerIntegrityError(
      `Replay bundle-hash divergence for company ${cell.companyId} measure ${cell.measureId}: ` +
      `frozen ${cell.bundleHash.slice(0, 12)}…, replay ${replayBundleHash.slice(0, 12)}…`,
    );
  }
  return ordered;
}
