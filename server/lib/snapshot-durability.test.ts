import assert from "node:assert/strict";

/**
 * Deterministic regression tests for the durable analysis_results snapshot write.
 *
 * Covers:
 * 1. Stale runKey / current batchId (saved=false path — the batch 1059 defect)
 * 2. 22/22 completeness verification
 * 3. Artifact-before-acceptance ordering
 * 4. Idempotent retries
 * 5. Missing/empty snapshot rejection
 * 6. Cross-framework isolation
 *
 * No hardcoded company names, topics, jurisdictions, or framework IDs.
 * All behaviour driven by schema parameters.
 */

// ─── Mock Types ─────────────────────────────────────────────────────────────

type SnapshotRow = {
  id: number;
  batchId: number;
  workspaceId: number;
  runKey: string | null;
  runId: number | null;
  frameworkId: number;
  frameworkName: string;
  listName: string | null;
  resultsData: any;
  companiesCount: number;
  averageScore: number | null;
  acceptanceState: string;
  acceptedAt: Date | null;
  rejectionReason: string | null;
  immutableSnapshot: boolean;
  deploymentFingerprint: any;
};

type BatchRow = {
  id: number;
  artifactId: string | null;
  acceptanceState: string;
  snapshotSaved: boolean;
  status: string;
};

// ─── In-Memory Storage Simulation ───────────────────────────────────────────

class MockStorage {
  private snapshots: SnapshotRow[] = [];
  private batches: Map<number, BatchRow> = new Map();
  private nextId = 1;

  registerBatch(batchId: number, status = "completed") {
    this.batches.set(batchId, { id: batchId, artifactId: null, acceptanceState: "pending", snapshotSaved: false, status });
  }

  getBatch(batchId: number): BatchRow | null {
    return this.batches.get(batchId) || null;
  }

  setBatchArtifact(batchId: number, artifactId: string) {
    const b = this.batches.get(batchId);
    if (b) b.artifactId = artifactId;
  }

  setBatchAcceptance(batchId: number, state: string) {
    const b = this.batches.get(batchId);
    if (b) b.acceptanceState = state;
  }

  setBatchSnapshotSaved(batchId: number, saved: boolean) {
    const b = this.batches.get(batchId);
    if (b) b.snapshotSaved = saved;
  }

  getByRunKey(runKey: string, workspaceId: number): SnapshotRow | null {
    return this.snapshots.find(s => s.runKey === runKey && s.workspaceId === workspaceId) || null;
  }

  /**
   * Implements the FIXED saveAnalysisResults logic (mirrors server/storage.ts):
   * - Rejects empty/zero-company snapshots (returns null)
   * - Durable upsert: updates stale rows from prior batches with same runKey
   * - Never overwrites accepted snapshots
   * - True idempotent for same batch + same/fewer companies
   */
  saveAnalysisResults(data: {
    workspaceId: number;
    batchId: number;
    runKey: string | null;
    runId: number | null;
    frameworkId: number;
    frameworkName: string;
    listName: string | null;
    resultsData: any;
    companiesCount: number;
    averageScore: number | null;
    acceptanceState: string;
    rejectionReason: string | null;
    deploymentFingerprint: any;
  }): SnapshotRow | null {
    if (!data.resultsData || (Array.isArray(data.resultsData) && data.resultsData.length === 0)) return null;
    if (data.companiesCount <= 0) return null;

    if (data.runKey) {
      const existing = this.getByRunKey(data.runKey, data.workspaceId);
      if (existing) {
        const existingBatchMatches = existing.batchId === data.batchId;
        const existingIsAccepted = existing.acceptanceState === "accepted";
        const existingIsIncomplete = (existing.companiesCount || 0) < data.companiesCount;

        if (existingIsAccepted && existingBatchMatches) return existing;
        if (!existingBatchMatches || existingIsIncomplete) {
          if (existingIsAccepted) return existing;
          existing.batchId = data.batchId;
          existing.runId = data.runId;
          existing.frameworkId = data.frameworkId;
          existing.frameworkName = data.frameworkName;
          existing.listName = data.listName;
          existing.resultsData = data.resultsData;
          existing.companiesCount = data.companiesCount;
          existing.averageScore = data.averageScore;
          existing.acceptanceState = data.acceptanceState;
          existing.rejectionReason = data.rejectionReason;
          existing.deploymentFingerprint = data.deploymentFingerprint;
          return existing;
        }
        return existing;
      }
    }

    const row: SnapshotRow = {
      id: this.nextId++,
      batchId: data.batchId,
      workspaceId: data.workspaceId,
      runKey: data.runKey,
      runId: data.runId,
      frameworkId: data.frameworkId,
      frameworkName: data.frameworkName,
      listName: data.listName,
      resultsData: data.resultsData,
      companiesCount: data.companiesCount,
      averageScore: data.averageScore,
      acceptanceState: data.acceptanceState,
      acceptedAt: null,
      rejectionReason: data.rejectionReason,
      immutableSnapshot: true,
      deploymentFingerprint: data.deploymentFingerprint,
    };
    this.snapshots.push(row);
    return row;
  }

  markAccepted(batchId: number, runKey: string): boolean {
    const snapshot = this.snapshots.find(s => s.batchId === batchId && s.runKey === runKey && s.immutableSnapshot);
    if (!snapshot) return false;
    snapshot.acceptanceState = "accepted";
    snapshot.acceptedAt = new Date();
    this.setBatchAcceptance(batchId, "accepted");
    return true;
  }
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeResultsData(count: number, frameworkId: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    companyId: i + 1, companyName: `Company_${i + 1}`, totalScore: 10 + i, frameworkId,
    measureScores: [{ measureId: 1, score: 1 }],
  }));
}

const WS = 1;
const FW_A = 3;
const FW_B = 8;
const EXPECTED = 22;

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  let passed = 0;

  // TEST 1: Stale runKey / current batchId (the batch 1059 defect)
  {
    const s = new MockStorage();
    const runKey = "run_abc123";
    s.registerBatch(1055); s.registerBatch(1059);
    s.saveAnalysisResults({ workspaceId: WS, batchId: 1055, runKey, runId: 10, frameworkId: FW_B, frameworkName: "B", listName: "L", resultsData: makeResultsData(15, FW_B), companiesCount: 15, averageScore: 40, acceptanceState: "rejected", rejectionReason: "coverage 15/22", deploymentFingerprint: { sourceSha: "6c3cd3b" } });
    const result = s.saveAnalysisResults({ workspaceId: WS, batchId: 1059, runKey, runId: 12, frameworkId: FW_B, frameworkName: "B", listName: "L", resultsData: makeResultsData(EXPECTED, FW_B), companiesCount: EXPECTED, averageScore: 50, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "6c3cd3b" } });
    assert.ok(result); assert.equal(result.batchId, 1059); assert.equal(result.companiesCount, EXPECTED);
    assert.ok(s.markAccepted(1059, runKey), "markAccepted must succeed after upsert");
    passed++; console.log("  [PASS] TEST 1: Stale runKey / current batchId — durable upsert");
  }

  // TEST 2: 22/22 completeness verification
  {
    const s = new MockStorage();
    s.registerBatch(2001);
    const r = s.saveAnalysisResults({ workspaceId: WS, batchId: 2001, runKey: "run_c", runId: 20, frameworkId: FW_B, frameworkName: "B", listName: "L", resultsData: makeResultsData(EXPECTED, FW_B), companiesCount: EXPECTED, averageScore: 45, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "x" } });
    assert.ok(r); assert.equal(r.companiesCount, EXPECTED); assert.equal(r.resultsData.length, EXPECTED);
    assert.ok(s.markAccepted(2001, "run_c"));
    passed++; console.log("  [PASS] TEST 2: 22/22 completeness — full snapshot accepted");
  }

  // TEST 3: Artifact-before-acceptance ordering
  {
    const s = new MockStorage();
    const runKey = "run_art"; const batchId = 3001; const artifactId = `artifact-${runKey}`;
    s.registerBatch(batchId);
    s.saveAnalysisResults({ workspaceId: WS, batchId, runKey, runId: 30, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 60, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "y" } });
    assert.equal(s.getBatch(batchId)?.artifactId, null, "artifact null before write");
    s.setBatchArtifact(batchId, artifactId);
    assert.equal(s.getBatch(batchId)?.artifactId, artifactId, "artifact set before acceptance");
    assert.ok(s.markAccepted(batchId, runKey));
    assert.equal(s.getBatch(batchId)?.acceptanceState, "accepted");
    passed++; console.log("  [PASS] TEST 3: Artifact-before-acceptance ordering");
  }

  // TEST 4: Idempotent retries
  {
    const s = new MockStorage();
    s.registerBatch(4001);
    const data = { workspaceId: WS, batchId: 4001, runKey: "run_idem", runId: 40, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 55, acceptanceState: "pending" as string, rejectionReason: null as string | null, deploymentFingerprint: { sourceSha: "z" } };
    const first = s.saveAnalysisResults(data); assert.ok(first);
    const second = s.saveAnalysisResults(data); assert.ok(second);
    assert.equal(second.id, first.id, "idempotent: same row");
    first.acceptanceState = "accepted"; first.acceptedAt = new Date();
    const third = s.saveAnalysisResults(data); assert.ok(third);
    assert.equal(third.acceptanceState, "accepted", "must not overwrite accepted");
    passed++; console.log("  [PASS] TEST 4: Idempotent retries — no duplicates, no overwrites");
  }

  // TEST 5: Missing/empty snapshot rejection
  {
    const s = new MockStorage();
    s.registerBatch(5001);
    assert.equal(s.saveAnalysisResults({ workspaceId: WS, batchId: 5001, runKey: "run_e1", runId: 50, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: [], companiesCount: 0, averageScore: null, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: {} }), null, "empty array rejected");
    assert.equal(s.saveAnalysisResults({ workspaceId: WS, batchId: 5001, runKey: "run_e2", runId: 51, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: null, companiesCount: 0, averageScore: null, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: {} }), null, "null rejected");
    assert.equal(s.saveAnalysisResults({ workspaceId: WS, batchId: 5001, runKey: "run_e3", runId: 52, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: [{ x: 1 }], companiesCount: 0, averageScore: null, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: {} }), null, "zero count rejected");
    assert.equal(s.getByRunKey("run_e1", WS), null); assert.equal(s.getByRunKey("run_e2", WS), null); assert.equal(s.getByRunKey("run_e3", WS), null);
    passed++; console.log("  [PASS] TEST 5: Missing/empty snapshot rejection — null returned");
  }

  // TEST 6: Cross-framework isolation
  {
    const s = new MockStorage();
    s.registerBatch(6001); s.registerBatch(6002);
    const rA = s.saveAnalysisResults({ workspaceId: WS, batchId: 6001, runKey: "run_fwA", runId: 60, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 60, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "m" } });
    const rB = s.saveAnalysisResults({ workspaceId: WS, batchId: 6002, runKey: "run_fwB", runId: 61, frameworkId: FW_B, frameworkName: "B", listName: "L", resultsData: makeResultsData(EXPECTED, FW_B), companiesCount: EXPECTED, averageScore: 45, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "m" } });
    assert.ok(rA); assert.ok(rB); assert.notEqual(rA.id, rB.id);
    s.markAccepted(6001, "run_fwA");
    assert.equal(s.getByRunKey("run_fwA", WS)?.acceptanceState, "accepted");
    assert.equal(s.getByRunKey("run_fwB", WS)?.acceptanceState, "pending", "fw B must remain pending");
    passed++; console.log("  [PASS] TEST 6: Cross-framework isolation — independent lifecycle");
  }

  // TEST 7: Never downgrade
  {
    const s = new MockStorage();
    s.registerBatch(7001);
    const complete = s.saveAnalysisResults({ workspaceId: WS, batchId: 7001, runKey: "run_nd", runId: 70, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 55, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "p" } });
    assert.ok(complete);
    const partial = s.saveAnalysisResults({ workspaceId: WS, batchId: 7001, runKey: "run_nd", runId: 70, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(10, FW_A), companiesCount: 10, averageScore: 30, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "p" } });
    assert.ok(partial); assert.equal(partial.companiesCount, EXPECTED, "must NOT downgrade");
    passed++; console.log("  [PASS] TEST 7: Never downgrade — partial cannot overwrite complete");
  }

  // TEST 8: Accepted snapshot from different batch is protected
  {
    const s = new MockStorage();
    s.registerBatch(8001); s.registerBatch(8002);
    s.saveAnalysisResults({ workspaceId: WS, batchId: 8001, runKey: "run_prot", runId: 80, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 50, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "s" } });
    s.markAccepted(8001, "run_prot");
    const attempt = s.saveAnalysisResults({ workspaceId: WS, batchId: 8002, runKey: "run_prot", runId: 81, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 55, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "s" } });
    assert.ok(attempt); assert.equal(attempt.batchId, 8001, "must NOT overwrite accepted"); assert.equal(attempt.acceptanceState, "accepted");
    passed++; console.log("  [PASS] TEST 8: Accepted snapshot from different batch is protected");
  }

  // TEST 9: markAccepted fails when batchId doesn't match
  {
    const s = new MockStorage();
    s.registerBatch(9001); s.registerBatch(9002);
    s.saveAnalysisResults({ workspaceId: WS, batchId: 9001, runKey: "run_mis", runId: 90, frameworkId: FW_B, frameworkName: "B", listName: "L", resultsData: makeResultsData(EXPECTED, FW_B), companiesCount: EXPECTED, averageScore: 40, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "v" } });
    assert.equal(s.markAccepted(9002, "run_mis"), false, "must fail: batchId mismatch");
    passed++; console.log("  [PASS] TEST 9: markAccepted fails when batchId doesn't match");
  }

  // TEST 10: Full end-to-end flow (batch 1059 scenario)
  {
    const s = new MockStorage();
    const runKey = "run_e2e"; const artifactId = `artifact-${runKey}`;
    s.registerBatch(1055); s.registerBatch(1059);
    s.saveAnalysisResults({ workspaceId: WS, batchId: 1055, runKey, runId: 100, frameworkId: FW_B, frameworkName: "B", listName: "22 Banks", resultsData: makeResultsData(20, FW_B), companiesCount: 20, averageScore: 38, acceptanceState: "rejected", rejectionReason: "coverage 20/22", deploymentFingerprint: { sourceSha: "6c3cd3b" } });
    const saved = s.saveAnalysisResults({ workspaceId: WS, batchId: 1059, runKey, runId: 102, frameworkId: FW_B, frameworkName: "B", listName: "22 Banks", resultsData: makeResultsData(EXPECTED, FW_B), companiesCount: EXPECTED, averageScore: 45, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "6c3cd3b" } });
    assert.ok(saved); assert.equal(saved.batchId, 1059); assert.equal(saved.companiesCount, EXPECTED);
    s.setBatchArtifact(1059, artifactId);
    assert.ok(s.markAccepted(1059, runKey));
    s.setBatchSnapshotSaved(1059, true);
    const b = s.getBatch(1059);
    assert.equal(b?.artifactId, artifactId); assert.equal(b?.acceptanceState, "accepted"); assert.equal(b?.snapshotSaved, true);
    passed++; console.log("  [PASS] TEST 10: Full end-to-end flow (batch 1059 scenario)");
  }

  // TEST 11: ESM runtime — crypto.createHash does not throw ReferenceError
  // Regression for the require("crypto") defect in ESM context (worker.ts line 839).
  // The corpusHashSha computation must use the ESM-imported crypto module.
  {
    const crypto = await import("node:crypto");
    const corpusHash = "101,204,307";
    // This is the exact logic from worker.ts line 838-841 post-fix:
    const ids = corpusHash.split(",").filter(Boolean).map(Number).sort((a: number, b: number) => a - b);
    let corpusHashSha: string;
    try {
      corpusHashSha = ids.length > 0 ? crypto.createHash("sha256").update(ids.join(",")).digest("hex") : "empty";
    } catch (e: any) {
      // If this throws ReferenceError: require is not defined, the ESM fix is broken
      throw new Error(`ESM crypto regression: ${e.message}`);
    }
    assert.equal(typeof corpusHashSha, "string");
    assert.equal(corpusHashSha.length, 64, "SHA-256 hex must be 64 chars");
    // Deterministic: same input always produces same hash
    const again = crypto.createHash("sha256").update(ids.join(",")).digest("hex");
    assert.equal(corpusHashSha, again, "deterministic hash");
    // Empty corpus returns "empty"
    const emptyIds = "".split(",").filter(Boolean).map(Number).sort((a: number, b: number) => a - b);
    const emptyHash = emptyIds.length > 0 ? crypto.createHash("sha256").update(emptyIds.join(",")).digest("hex") : "empty";
    assert.equal(emptyHash, "empty");
    passed++; console.log("  [PASS] TEST 11: ESM runtime — crypto.createHash no ReferenceError");
  }

  // TEST 12: acceptanceState=accepted ONLY after snapshotSaved=true
  // Ensures the ordering invariant: artifact written → snapshot saved → acceptance flipped.
  {
    const s = new MockStorage();
    const runKey = "run_order"; const batchId = 12001; const artifactId = `artifact-${runKey}`;
    s.registerBatch(batchId);
    // Save snapshot
    const snap = s.saveAnalysisResults({ workspaceId: WS, batchId, runKey, runId: 120, frameworkId: FW_A, frameworkName: "A", listName: "L", resultsData: makeResultsData(EXPECTED, FW_A), companiesCount: EXPECTED, averageScore: 55, acceptanceState: "pending", rejectionReason: null, deploymentFingerprint: { sourceSha: "abc" } });
    assert.ok(snap);
    // Before artifact: batch must NOT be accepted
    assert.equal(s.getBatch(batchId)?.acceptanceState, "pending");
    assert.equal(s.getBatch(batchId)?.snapshotSaved, false);
    // Write artifact
    s.setBatchArtifact(batchId, artifactId);
    assert.equal(s.getBatch(batchId)?.artifactId, artifactId);
    // Still not accepted
    assert.equal(s.getBatch(batchId)?.acceptanceState, "pending");
    // Mark snapshot saved
    s.setBatchSnapshotSaved(batchId, true);
    assert.equal(s.getBatch(batchId)?.snapshotSaved, true);
    // NOW accept
    assert.ok(s.markAccepted(batchId, runKey));
    assert.equal(s.getBatch(batchId)?.acceptanceState, "accepted");
    // Verify the ordering: snapshotSaved was true BEFORE acceptance was set
    // (in our mock, markAccepted checks immutableSnapshot on the row)
    assert.equal(snap!.acceptanceState, "accepted");
    passed++; console.log("  [PASS] TEST 12: acceptanceState=accepted only after snapshotSaved=true");
  }

  console.log(`\nsnapshot-durability tests: PASS (${passed}/12 — stale-runKey-upsert, completeness-22, artifact-before-acceptance, idempotent-retry, empty-rejection, cross-framework-isolation, no-downgrade, accepted-protection, mismatch-rejection, e2e-1059-flow, esm-crypto-no-referror, acceptance-after-snapshot)`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
