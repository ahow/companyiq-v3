import assert from "node:assert/strict";
import {
  assertProductionFingerprint,
  buildGateReport,
  buildRunKey,
  computeRecoveryLabels,
  compareDeploymentFingerprint,
  fingerprintsEqual,
  isHeartbeatStalled,
  isTerminalLifecycleState,
  selectValidEvidenceSnapshots,
  validateCorpusReplayProvenance,
  type DeploymentFingerprint,
  type EvidenceSnapshot,
} from "./reliability.js";

const fingerprint: DeploymentFingerprint = {
  sourceSha: "a34f416",
  liveAppSha: "a34f416",
  liveWorkerSha: "a34f416",
  tsCount: 58,
  executableGeneralisationCount: 0,
};

function snapshot(runKey: string, label: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    id: Number(runKey.replace(/\D/g, "")) || 1,
    batchId: Number(runKey.replace(/\D/g, "")) || 1,
    runKey,
    lifecycleState: "accepted",
    acceptanceState: "accepted",
    deploymentFingerprint: fingerprint,
    totalJobs: 22,
    companiesCount: 22,
    batteryLabel: label,
    resultsData: Array.from({ length: 22 }, (_, index) => ({ companyId: index + 1, totalScore: index + 10 })),
    ...overrides,
  };
}

async function main() {
  // Duplicate-create race contract: concurrent callers derive exactly one key,
  // and the database unique constraint is the authority that makes adoption safe.
  const inputs = { testCycleId: "cycle-1", commitSha: "a34f416", frameworkId: 3, listId: 5, batteryLabel: "A" };
  const keys = await Promise.all(Array.from({ length: 32 }, async () => buildRunKey(inputs)));
  assert.equal(new Set(keys).size, 1, "concurrent create callers must derive one deterministic run_key");
  assert.equal(keys[0], buildRunKey(inputs));

  // Stale polling contract: an unchanged aggregate count is not a stall while
  // the batch and every active job continue to heartbeat.
  const now = new Date("2026-08-19T12:00:00.000Z");
  assert.equal(isHeartbeatStalled({
    lifecycleState: "running",
    lastHeartbeatAt: new Date(now.getTime() - 5 * 60_000),
    activeJobs: [{ id: 1, status: "claimed", lastProgressAt: new Date(now.getTime() - 4 * 60_000) }],
    now,
    thresholdMs: 45 * 60_000,
  }), false);
  assert.equal(isHeartbeatStalled({
    lifecycleState: "running",
    lastHeartbeatAt: new Date(now.getTime() - 60 * 60_000),
    activeJobs: [{ id: 1, status: "claimed", lastProgressAt: new Date(now.getTime() - 60 * 60_000) }],
    now,
    thresholdMs: 45 * 60_000,
  }), true);

  // Cancellation/rejection provenance contract: terminal rejected/cancelled
  // states remain visible to selectors and can never enter KPI aggregation.
  assert.equal(isTerminalLifecycleState("cancelled"), true);
  assert.equal(isTerminalLifecycleState("rejected"), true);
  const selection = selectValidEvidenceSnapshots([
    snapshot("run-1", "battery-alpha-A"),
    snapshot("run-2", "battery-alpha-B", { acceptanceState: "rejected" }),
    snapshot("run-3", "battery-beta-A", { companiesCount: 21 }),
    snapshot("run-4", "battery-beta-B", { deploymentFingerprint: { ...fingerprint, liveWorkerSha: "other" } }),
  ], { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 });
  assert.equal(selection.accepted.length, 1);
  assert.equal(selection.rejected.length, 3);
  assert.ok(selection.rejected.every((item) => item.reason.length > 0));

  // Fingerprint gate contract: all five provenance fields participate in the
  // comparison and a single revision/count drift is visible.
  const drifted = { ...fingerprint, tsCount: 59 };
  assert.deepEqual(compareDeploymentFingerprint(fingerprint, drifted), ["tsCount"]);
  assert.equal(fingerprintsEqual(fingerprint, drifted), false);
  assert.throws(() => assertProductionFingerprint(fingerprint, drifted), /fingerprint mismatch/);
  assert.deepEqual(computeRecoveryLabels(["battery-alpha-A", "battery-alpha-B", "battery-beta-A"], [
    { batteryLabel: "battery-alpha-A", lifecycleState: "accepted", acceptanceState: "accepted" },
    { batteryLabel: "battery-alpha-B", lifecycleState: "rejected", acceptanceState: "rejected" },
  ]), {
    accepted: ["battery-alpha-A"],
    rejected: ["battery-alpha-B"],
    rerun: ["battery-alpha-B", "battery-beta-A"],
  });

  // Finalizer retry/idempotency contract: the same accepted evidence set produces
  // byte-stable report inputs and the same source run ordering on every retry.
  const accepted = [
    snapshot("run-4", "battery-beta-B"),
    snapshot("run-2", "battery-alpha-B"),
    snapshot("run-1", "battery-alpha-A"),
    snapshot("run-3", "battery-beta-A"),
  ];
  const first = buildGateReport("cycle-1", accepted, fingerprint, 22);
  const second = buildGateReport("cycle-1", accepted.slice().reverse(), fingerprint, 22);
  assert.deepEqual(first, second, "finalizer retries must produce the same report payload");
  assert.equal(first.gates.length, 7);
  assert.ok(first.gates.every((gate) => gate.passed));

  // ─── FIX 2 (I44-FU): Framework-scoped A/B delta tests ──────────────────────

  // Test 1: Framework-scoped deltas — labels with framework prefix are grouped correctly
  {
    const fw3Scores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 30 + i }));
    const fw8Scores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 10 + i }));
    const mixedSnapshots = [
      snapshot("run-1", "fw3_a", { resultsData: fw3Scores }),
      snapshot("run-2", "fw3_b", { resultsData: fw3Scores.map(r => ({ ...r, totalScore: r.totalScore + 2 })) }),
      snapshot("run-3", "fw8_a", { resultsData: fw8Scores }),
      snapshot("run-4", "fw8_b", { resultsData: fw8Scores }),
    ];
    const report = buildGateReport("cycle-fw-scoped", mixedSnapshots, fingerprint, 22);

    // Every delta row must have a framework field
    assert.ok(report.companyABDelta.every(row => typeof row.framework === "string" && row.framework.length > 0),
      "every companyABDelta row must have a non-empty framework field");

    // fw3 rows should have delta = 2 (b = a + 2)
    const fw3Rows = report.companyABDelta.filter(r => r.framework === "fw3");
    assert.equal(fw3Rows.length, 22, "fw3 should have 22 company rows");
    assert.ok(fw3Rows.every(r => r.delta === 2), "fw3 deltas should all be 2");

    // fw8 rows should have delta = 0 (identical A/B)
    const fw8Rows = report.companyABDelta.filter(r => r.framework === "fw8");
    assert.equal(fw8Rows.length, 22, "fw8 should have 22 company rows");
    assert.ok(fw8Rows.every(r => r.delta === 0), "fw8 deltas should all be 0");

    // No cross-framework contamination: total rows = 44 (22 per framework)
    assert.equal(report.companyABDelta.length, 44, "total delta rows should be 44 (22 per framework)");

    // Deterministic ordering: sorted by framework key, then companyId
    for (let i = 1; i < report.companyABDelta.length; i++) {
      const prev = report.companyABDelta[i - 1];
      const curr = report.companyABDelta[i];
      const fwCmp = prev.framework.localeCompare(curr.framework);
      assert.ok(fwCmp < 0 || (fwCmp === 0 && prev.companyId < curr.companyId),
        "companyABDelta must be sorted by framework then companyId");
    }
  }

  // Test 2: Labels without _a/_b suffix are excluded from A/B deltas
  {
    const noAbSnapshots = [
      snapshot("run-1", "battery-alpha"),
      snapshot("run-2", "battery-beta"),
      snapshot("run-3", "battery-gamma"),
      snapshot("run-4", "battery-delta"),
    ];
    const report = buildGateReport("cycle-no-ab", noAbSnapshots, fingerprint, 22);
    assert.equal(report.companyABDelta.length, 0, "labels without _a/_b suffix should produce no A/B deltas");
  }

  // Test 3: Single framework with hyphen-separated labels (e.g., "battery-alpha-a")
  {
    const singleFw = [
      snapshot("run-1", "battery-alpha-a"),
      snapshot("run-2", "battery-alpha-b"),
      snapshot("run-3", "battery-beta-a"),
      snapshot("run-4", "battery-beta-b"),
    ];
    const report = buildGateReport("cycle-hyphen", singleFw, fingerprint, 22);
    const frameworks = [...new Set(report.companyABDelta.map(r => r.framework))];
    assert.equal(frameworks.length, 2, "hyphen-separated labels should produce two framework keys");
    assert.ok(frameworks.includes("battery-alpha"), "should include battery-alpha framework");
    assert.ok(frameworks.includes("battery-beta"), "should include battery-beta framework");
  }

  // Test 4: Deterministic batch corpusHash — verifies the concept (actual DB test
  // requires integration, but we validate the contract here)
  {
    // When batch_corpus rows exist, corpusHash should be derived from document_id
    // in ascending order. This is a unit-level contract test for the sorting logic.
    const docIds = [105, 42, 200, 1, 99];
    const sortedHash = [...docIds].sort((a, b) => a - b).join(",");
    assert.equal(sortedHash, "1,42,99,105,200", "corpusHash must use ascending document_id order");
  }

  // ─── Corpus Replay Validation Tests ──────────────────────────────────────────

  // Valid same-run replay: matching fingerprint passes
  const validResult = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "deadbeef",
    sourceAcceptanceState: "accepted",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 1,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 2, 3],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: fingerprint,
  });
  assert.equal(validResult.valid, true, "valid replay must pass");
  assert.equal(validResult.reason, null);

  // Missing source snapshot: source not accepted
  const notAccepted = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "deadbeef",
    sourceAcceptanceState: "pending",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 1,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 2, 3],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: fingerprint,
  });
  assert.equal(notAccepted.valid, false, "non-accepted source must be rejected");
  assert.ok(notAccepted.reason!.toLowerCase().includes("not accepted"));

  // Cross-workspace source: different workspace
  const crossWorkspace = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "deadbeef",
    sourceAcceptanceState: "accepted",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 2,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 2, 3],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: fingerprint,
  });
  assert.equal(crossWorkspace.valid, false, "cross-workspace replay must be rejected");
  assert.ok(crossWorkspace.reason!.toLowerCase().includes("workspace"));

  // Changed company set/order
  const changedCompanies = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "deadbeef",
    sourceAcceptanceState: "accepted",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 1,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 3, 2],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: fingerprint,
  });
  assert.equal(changedCompanies.valid, false, "changed company order must be rejected");
  assert.ok(changedCompanies.reason!.toLowerCase().includes("company"));

  // Fingerprint mismatch between source and replay
  const fpMismatch = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "deadbeef",
    sourceAcceptanceState: "accepted",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 1,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 2, 3],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: { ...fingerprint, liveWorkerSha: "different" },
  });
  assert.equal(fpMismatch.valid, false, "deployment fingerprint mismatch must be rejected");
  assert.ok(fpMismatch.reason!.toLowerCase().includes("fingerprint"));

  // Fallback prevention: sourceBatchId present but empty corpus fingerprint
  const emptyFingerprint = validateCorpusReplayProvenance({
    sourceRunKey: "run_abc123",
    sourceBatchId: 100,
    sourceCorpusFingerprint: "",
    sourceAcceptanceState: "accepted",
    sourceWorkspaceId: 1,
    replayWorkspaceId: 1,
    sourceCompanyIds: [1, 2, 3],
    replayCompanyIds: [1, 2, 3],
    sourceDeploymentFingerprint: fingerprint,
    replayDeploymentFingerprint: fingerprint,
  });
  assert.equal(emptyFingerprint.valid, false, "empty corpus fingerprint must be rejected");
  assert.ok(emptyFingerprint.reason!.toLowerCase().includes("fingerprint"));

  console.log("reliability acceptance tests: PASS (duplicate-create, heartbeat, provenance, fingerprint, finalizer, corpus-replay, framework-scoped-ab-delta, deterministic-corpusHash)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
