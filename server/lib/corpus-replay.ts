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
