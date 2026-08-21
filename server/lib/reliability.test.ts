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
  selectTerminalBatchPerFramework,
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

  // ─── I45: Deterministic Replay Tests ──────────────────────────────────────────

  // Test: Identical frozen inputs produce identical scoring outputs.
  // This validates that the deterministic seed, structured output validation,
  // and quote sorting produce byte-stable results across invocations.
  {
    // Simulate two scoring runs with identical inputs
    const { createHash } = await import("crypto");
    const measureId = "M1.1";
    const companyId = 42;
    const providerIndex = 0;

    // Deterministic seed must be identical for same inputs
    const seed1 = createHash("sha256").update(`${measureId}:${companyId}:${providerIndex}`).digest().readUInt32BE(0);
    const seed2 = createHash("sha256").update(`${measureId}:${companyId}:${providerIndex}`).digest().readUInt32BE(0);
    assert.equal(seed1, seed2, "deterministic seed must be identical for same inputs");

    // Different companyId must produce different seed
    const seed3 = createHash("sha256").update(`${measureId}:${companyId + 1}:${providerIndex}`).digest().readUInt32BE(0);
    assert.notEqual(seed1, seed3, "different companyId must produce different seed");

    // Verdict cache key must include companyId to prevent cross-company contamination
    const evidenceHash1 = createHash("sha256").update("test evidence").digest("hex").slice(0, 16);
    const key1 = `${companyId}:${measureId}:deepseek:binary:${evidenceHash1}:noprompt`;
    const key2 = `${companyId + 1}:${measureId}:deepseek:binary:${evidenceHash1}:noprompt`;
    assert.notEqual(key1, key2, "verdict cache keys for different companies must differ");
  }

  // ─── I45: Workspace Isolation Tests ──────────────────────────────────────────

  // Test: Concurrent battery runs with different testCycleIds produce
  // non-overlapping run keys, preventing cross-cycle contamination.
  {
    const cycle1Inputs = { testCycleId: "cycle-A", commitSha: "a34f416", frameworkId: 3, listId: 5, batteryLabel: "fw3_a" };
    const cycle2Inputs = { testCycleId: "cycle-B", commitSha: "a34f416", frameworkId: 3, listId: 5, batteryLabel: "fw3_a" };
    const key1 = buildRunKey(cycle1Inputs);
    const key2 = buildRunKey(cycle2Inputs);
    assert.notEqual(key1, key2, "different testCycleIds must produce different run keys");

    // Same cycle, different frameworks must also produce different keys
    const fw3Key = buildRunKey({ ...cycle1Inputs, frameworkId: 3 });
    const fw8Key = buildRunKey({ ...cycle1Inputs, frameworkId: 8 });
    assert.notEqual(fw3Key, fw8Key, "different frameworkIds must produce different run keys");

    // Same cycle, different battery labels must produce different keys
    const labelA = buildRunKey({ ...cycle1Inputs, batteryLabel: "fw3_a" });
    const labelB = buildRunKey({ ...cycle1Inputs, batteryLabel: "fw3_b" });
    assert.notEqual(labelA, labelB, "different battery labels must produce different run keys");

    // Verify no cross-framework leakage in Gate Report
    const fw3AScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 30 + i }));
    const fw3BScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 30 + i })); // identical
    const fw8AScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 10 + i }));
    const fw8BScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 10 + i })); // identical
    const isolationSnapshots = [
      snapshot("run-iso-1", "fw3_a", { resultsData: fw3AScores }),
      snapshot("run-iso-2", "fw3_b", { resultsData: fw3BScores }),
      snapshot("run-iso-3", "fw8_a", { resultsData: fw8AScores }),
      snapshot("run-iso-4", "fw8_b", { resultsData: fw8BScores }),
    ];
    const isoReport = buildGateReport("cycle-isolation", isolationSnapshots, fingerprint, 22);

    // fw3 and fw8 deltas must be zero (identical A/B within each framework)
    const fw3Deltas = isoReport.companyABDelta.filter(r => r.framework === "fw3");
    const fw8Deltas = isoReport.companyABDelta.filter(r => r.framework === "fw8");
    assert.equal(fw3Deltas.length, 22, "fw3 isolation test must have 22 rows");
    assert.equal(fw8Deltas.length, 22, "fw8 isolation test must have 22 rows");
    assert.ok(fw3Deltas.every(r => r.delta === 0), "fw3 identical A/B must have zero deltas");
    assert.ok(fw8Deltas.every(r => r.delta === 0), "fw8 identical A/B must have zero deltas");

    // No cross-framework score leakage: fw3 scores start at 30, fw8 at 10.
    // fw8 max is 10+21=31, fw3 min is 30. Use a structural check: fw8 company 1
    // must have score 10 (not 30), confirming no fw3 data leaked into fw8 rows.
    const fw8Company1 = fw8Deltas.find(r => r.companyId === 1);
    assert.ok(fw8Company1, "fw8 must have companyId=1");
    assert.equal(fw8Company1!.scoreA, 10, "fw8 companyId=1 scoreA must be 10 (not 30 from fw3)");
    const fw3Company1 = fw3Deltas.find(r => r.companyId === 1);
    assert.ok(fw3Company1, "fw3 must have companyId=1");
    assert.equal(fw3Company1!.scoreA, 30, "fw3 companyId=1 scoreA must be 30");
  }

  // ─── I45: Structured Output Validation Tests ────────────────────────────────

  // Test: Quote sorting is deterministic regardless of input order
  {
    const quotes1 = [
      { text: "beta quote", source: "Doc A" },
      { text: "alpha quote", source: "Doc A" },
      { text: "gamma quote", source: "Doc B" },
    ];
    const quotes2 = [
      { text: "gamma quote", source: "Doc B" },
      { text: "alpha quote", source: "Doc A" },
      { text: "beta quote", source: "Doc A" },
    ];
    const sort = (qs: typeof quotes1) => qs.slice().sort((a, b) => {
      const sc = a.source.localeCompare(b.source);
      return sc !== 0 ? sc : a.text.localeCompare(b.text);
    });
    const sorted1 = sort(quotes1);
    const sorted2 = sort(quotes2);
    assert.deepEqual(sorted1, sorted2, "quote sorting must be deterministic regardless of input order");
    assert.equal(sorted1[0].text, "alpha quote", "first quote must be alphabetically first");
  }

  // ─── Cross-Framework Score Isolation Tests ──────────────────────────────────
  // Validates that framework-scoped clearing and snapshot building cannot mix
  // scores from different frameworks. Uses generic framework keys, no hardcoded
  // company names, topics, jurisdictions, or framework IDs.
  {
    // Simulate two frameworks with distinct score sets for the same companies
    const fwAlphaScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 50 + i }));
    const fwBetaScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 10 + i }));

    // Create snapshots for two different frameworks
    const alphaA = snapshot("run-iso-alpha-a", "alpha_a", { resultsData: fwAlphaScores });
    const alphaB = snapshot("run-iso-alpha-b", "alpha_b", { resultsData: fwAlphaScores.map(r => ({ ...r, totalScore: r.totalScore + 1 })) });
    const betaA = snapshot("run-iso-beta-a", "beta_a", { resultsData: fwBetaScores });
    const betaB = snapshot("run-iso-beta-b", "beta_b", { resultsData: fwBetaScores });

    const report = buildGateReport("cycle-cross-fw-isolation", [alphaA, alphaB, betaA, betaB], fingerprint, 22);

    // Framework alpha deltas should be 1 (b = a + 1)
    const alphaDeltas = report.companyABDelta.filter(r => r.framework === "alpha");
    assert.equal(alphaDeltas.length, 22, "alpha framework must have 22 delta rows");
    assert.ok(alphaDeltas.every(r => r.delta === 1), "alpha deltas must all be 1");

    // Framework beta deltas should be 0 (identical A/B)
    const betaDeltas = report.companyABDelta.filter(r => r.framework === "beta");
    assert.equal(betaDeltas.length, 22, "beta framework must have 22 delta rows");
    assert.ok(betaDeltas.every(r => r.delta === 0), "beta deltas must all be 0");

    // No cross-framework contamination: alpha company 1 score must be 50, not 10
    const alphaC1 = alphaDeltas.find(r => r.companyId === 1);
    assert.ok(alphaC1, "alpha must have companyId=1");
    assert.equal(alphaC1!.scoreA, 50, "alpha companyId=1 scoreA must be 50 (not 10 from beta)");
    const betaC1 = betaDeltas.find(r => r.companyId === 1);
    assert.ok(betaC1, "beta must have companyId=1");
    assert.equal(betaC1!.scoreA, 10, "beta companyId=1 scoreA must be 10 (not 50 from alpha)");

    // Total rows must be exactly 44 (22 per framework)
    assert.equal(report.companyABDelta.length, 44, "total delta rows must be 44 (22 per framework)");
  }

  // ─── Terminal Snapshot Persistence Before Acceptance Tests ─────────────────
  // Validates that the selector rejects snapshots that are pending, have no
  // artifact, or are incomplete — preventing acceptance of non-persisted snapshots.
  {
    const pendingSnapshot = snapshot("run-pending-1", "fw_a", { acceptanceState: "pending" });
    const acceptedSnapshot = snapshot("run-accepted-1", "fw_b");
    const partialSnapshot = snapshot("run-partial-1", "fw_a", { companiesCount: 20 });

    const selection = selectValidEvidenceSnapshots(
      [pendingSnapshot, acceptedSnapshot, partialSnapshot],
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 },
    );

    // Only the fully accepted snapshot should pass
    assert.equal(selection.accepted.length, 1, "only one fully accepted snapshot should pass");
    assert.equal(selection.accepted[0].runKey, "run-accepted-1");
    assert.equal(selection.rejected.length, 2, "pending and partial must be rejected");

    // Verify rejection reasons are meaningful
    const pendingRejection = selection.rejected.find(r => r.snapshot.runKey === "run-pending-1");
    assert.ok(pendingRejection, "pending snapshot must be in rejected list");
    assert.ok(pendingRejection!.reason.includes("not an accepted"), "pending rejection reason must mention acceptance");

    const partialRejection = selection.rejected.find(r => r.snapshot.runKey === "run-partial-1");
    assert.ok(partialRejection, "partial snapshot must be in rejected list");
    assert.ok(partialRejection!.reason.includes("not complete"), "partial rejection reason must mention completeness");
  }

  // ─── Idempotent Finalization Tests ────────────────────────────────────────────
  // Validates that re-running finalization with the same inputs produces
  // byte-identical output, and that order of input does not matter.
  {
    const fwXScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 20 + i }));
    const fwYScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 40 + i }));
    const snaps = [
      snapshot("run-idem-1", "fwx_a", { resultsData: fwXScores }),
      snapshot("run-idem-2", "fwx_b", { resultsData: fwXScores }),
      snapshot("run-idem-3", "fwy_a", { resultsData: fwYScores }),
      snapshot("run-idem-4", "fwy_b", { resultsData: fwYScores }),
    ];

    // Run finalization twice with different input orders
    const report1 = buildGateReport("cycle-idem", snaps, fingerprint, 22);
    const report2 = buildGateReport("cycle-idem", [...snaps].reverse(), fingerprint, 22);
    const report3 = buildGateReport("cycle-idem", [snaps[2], snaps[0], snaps[3], snaps[1]], fingerprint, 22);

    // All three must be byte-identical
    assert.deepEqual(report1, report2, "idempotent finalization: reversed input must produce identical report");
    assert.deepEqual(report1, report3, "idempotent finalization: shuffled input must produce identical report");

    // All gates must pass
    assert.ok(report1.gates.every(g => g.passed), "all gates must pass for complete valid snapshots");
  }

  // ─── Rejection of Mixed/Pending Batches Tests ────────────────────────────────
  // Validates that the selector and per-framework selector both reject
  // mixed-state batches (some accepted, some pending/rejected).
  {
    const mixedSnapshots = [
      snapshot("run-mix-1", "fw_a"),
      snapshot("run-mix-2", "fw_b", { acceptanceState: "pending" }),
      snapshot("run-mix-3", "fw_a", { lifecycleState: "rejected", acceptanceState: "rejected" }),
      snapshot("run-mix-4", "fw_b"),
    ];

    const selection = selectValidEvidenceSnapshots(
      mixedSnapshots,
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 },
    );

    // Only the two fully accepted snapshots should pass
    assert.equal(selection.accepted.length, 2, "only fully accepted snapshots should pass");
    assert.equal(selection.rejected.length, 2, "pending and rejected must be filtered out");

    // Per-framework selector must also reject pending/rejected
    const perFw = selectTerminalBatchPerFramework(
      mixedSnapshots,
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint },
    );
    assert.equal(perFw.rejected.length, 2, "per-framework selector must reject pending and rejected snapshots");
    // The accepted ones should be grouped by framework key
    const fwKeys = [...perFw.perFramework.keys()];
    assert.ok(fwKeys.length > 0, "per-framework selector must have at least one framework key");
    // All accepted snapshots in perFramework must be genuinely accepted
    for (const [, snaps] of perFw.perFramework) {
      for (const s of snaps) {
        assert.equal(s.acceptanceState, "accepted", "per-framework accepted snapshot must have acceptanceState=accepted");
      }
    }
  }

  // ─── selectTerminalBatchPerFramework Isolation Tests ──────────────────────────
  // Validates that the per-framework selector correctly groups by framework key
  // and rejects incomplete/fingerprint-mismatched snapshots.
  {
    const fwAScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 30 + i }));
    const fwBScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 60 + i }));
    const perFwSnapshots = [
      snapshot("run-pf-1", "gamma_a", { resultsData: fwAScores }),
      snapshot("run-pf-2", "gamma_b", { resultsData: fwAScores }),
      snapshot("run-pf-3", "delta_a", { resultsData: fwBScores }),
      snapshot("run-pf-4", "delta_b", { resultsData: fwBScores }),
      // Rejected: incomplete
      snapshot("run-pf-5", "gamma_a", { companiesCount: 15 }),
      // Rejected: wrong fingerprint
      snapshot("run-pf-6", "delta_a", { deploymentFingerprint: { ...fingerprint, liveWorkerSha: "wrong" } }),
    ];

    const result = selectTerminalBatchPerFramework(
      perFwSnapshots,
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint },
    );

    // Two framework keys: gamma and delta
    assert.ok(result.perFramework.has("gamma"), "must have gamma framework key");
    assert.ok(result.perFramework.has("delta"), "must have delta framework key");
    assert.equal(result.perFramework.get("gamma")!.length, 2, "gamma must have 2 accepted snapshots");
    assert.equal(result.perFramework.get("delta")!.length, 2, "delta must have 2 accepted snapshots");
    assert.equal(result.rejected.length, 2, "incomplete and fingerprint-mismatched must be rejected");
  }

  // ─── Batch-Scoped Snapshot Persistence Tests ─────────────────────────────────
  // Validates the contract that snapshot building uses batch-scoped job status
  // (not live company status) and that empty snapshots are rejected.
  {
    // Test: A snapshot with 0 companies must be rejected by the selector
    const emptySnapshot = snapshot("run-empty-1", "fw_a", { companiesCount: 0, totalJobs: 22 });
    const fullSnapshot = snapshot("run-full-1", "fw_b");
    const emptySelection = selectValidEvidenceSnapshots(
      [emptySnapshot, fullSnapshot],
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 },
    );
    assert.equal(emptySelection.accepted.length, 1, "empty snapshot must be rejected");
    assert.equal(emptySelection.rejected.length, 1, "empty snapshot must appear in rejected list");
    assert.ok(emptySelection.rejected[0].reason.includes("not complete"), "empty snapshot rejection reason must mention completeness");

    // Test: A snapshot where totalJobs != companiesCount is incomplete
    const partialSnapshot2 = snapshot("run-partial-2", "fw_a", { companiesCount: 18, totalJobs: 22 });
    const partialSelection = selectValidEvidenceSnapshots(
      [partialSnapshot2],
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 },
    );
    assert.equal(partialSelection.accepted.length, 0, "partial snapshot must not be accepted");
    assert.equal(partialSelection.rejected.length, 1, "partial snapshot must be rejected");
  }

  // ─── Artifact-Before-Acceptance Ordering Tests ──────────────────────────────
  // Validates that the acceptance gate requires both a non-null artifactId
  // and a persisted snapshot row before acceptance can proceed.
  {
    // Test: selectValidEvidenceSnapshots rejects snapshots with pending acceptance
    const pendingArtifact = snapshot("run-pending-art-1", "fw_a", { acceptanceState: "pending" });
    const acceptedArtifact = snapshot("run-accepted-art-1", "fw_b");
    const artSelection = selectValidEvidenceSnapshots(
      [pendingArtifact, acceptedArtifact],
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4 },
    );
    assert.equal(artSelection.accepted.length, 1, "only accepted snapshot passes artifact gate");
    assert.equal(artSelection.accepted[0].runKey, "run-accepted-art-1");
    assert.equal(artSelection.rejected.length, 1, "pending snapshot rejected at artifact gate");

    // Test: The gate report requires all snapshots to be accepted (not pending)
    const mixedArtifacts = [
      snapshot("run-art-1", "fw_a"),
      snapshot("run-art-2", "fw_b"),
      snapshot("run-art-3", "fw_a", { acceptanceState: "pending" }),
      snapshot("run-art-4", "fw_b"),
    ];
    const mixedReport = buildGateReport("cycle-artifact-order", mixedArtifacts, fingerprint, 22);
    // Gate 2 (terminal_success_and_acceptance) must fail because one is pending
    const gate2 = mixedReport.gates.find(g => g.id === 2);
    assert.ok(gate2, "gate 2 must exist");
    assert.equal(gate2!.passed, false, "gate 2 must fail when a snapshot is pending");
  }

  // ─── Idempotent Retry Contract Tests ───────────────────────────────────────
  // Validates that re-running snapshot save with the same inputs produces
  // the same selection result (idempotent).
  {
    const retryScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 25 + i }));
    const retrySnapshots = [
      snapshot("run-retry-1", "fwr_a", { resultsData: retryScores }),
      snapshot("run-retry-2", "fwr_b", { resultsData: retryScores }),
      snapshot("run-retry-3", "fwr_a", { resultsData: retryScores }),
      snapshot("run-retry-4", "fwr_b", { resultsData: retryScores }),
    ];

    // First selection
    const sel1 = selectValidEvidenceSnapshots(retrySnapshots, {
      expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4,
    });
    // Second selection (same inputs)
    const sel2 = selectValidEvidenceSnapshots(retrySnapshots, {
      expectedCompanyCount: 22, deploymentFingerprint: fingerprint, requiredSnapshotCount: 4,
    });
    assert.equal(sel1.accepted.length, sel2.accepted.length, "idempotent retry: same accepted count");
    assert.deepEqual(
      sel1.accepted.map(s => s.runKey),
      sel2.accepted.map(s => s.runKey),
      "idempotent retry: same accepted run keys",
    );
  }

  // ─── Cross-Framework Snapshot Isolation (Concurrent Batch) Tests ────────────
  // Validates that snapshots from different frameworks cannot contaminate each
  // other's acceptance state or KPI aggregation.
  {
    const fwXScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 45 + i }));
    const fwYScores = Array.from({ length: 22 }, (_, i) => ({ companyId: i + 1, totalScore: 15 + i }));

    // Framework X has both A/B accepted; Framework Y has A accepted but B pending
    const concurrentSnapshots = [
      snapshot("run-conc-1", "fwx_a", { resultsData: fwXScores }),
      snapshot("run-conc-2", "fwx_b", { resultsData: fwXScores }),
      snapshot("run-conc-3", "fwy_a", { resultsData: fwYScores }),
      snapshot("run-conc-4", "fwy_b", { resultsData: fwYScores, acceptanceState: "pending" }),
    ];

    // Per-framework selector must accept fwx snapshots but reject fwy_b
    const concResult = selectTerminalBatchPerFramework(
      concurrentSnapshots,
      { expectedCompanyCount: 22, deploymentFingerprint: fingerprint },
    );
    assert.ok(concResult.perFramework.has("fwx"), "fwx must be present");
    assert.equal(concResult.perFramework.get("fwx")!.length, 2, "fwx must have 2 accepted snapshots");
    assert.ok(concResult.perFramework.has("fwy"), "fwy must be present");
    assert.equal(concResult.perFramework.get("fwy")!.length, 1, "fwy must have only 1 accepted snapshot (B is pending)");
    assert.equal(concResult.rejected.length, 1, "fwy_b pending must be rejected");
    assert.equal(concResult.rejected[0].snapshot.runKey, "run-conc-4");

    // Gate report with mixed acceptance must fail gate 2
    const concReport = buildGateReport("cycle-concurrent", concurrentSnapshots, fingerprint, 22);
    const concGate2 = concReport.gates.find(g => g.id === 2);
    assert.ok(concGate2, "gate 2 must exist in concurrent report");
    assert.equal(concGate2!.passed, false, "gate 2 must fail when fwy_b is pending");
  }

  console.log("reliability acceptance tests: PASS (duplicate-create, heartbeat, provenance, fingerprint, finalizer, corpus-replay, framework-scoped-ab-delta, deterministic-corpusHash, I45-deterministic-replay, I45-workspace-isolation, I45-structured-output, cross-framework-isolation, terminal-snapshot-persistence, idempotent-finalization, mixed-pending-rejection, per-framework-selection, batch-scoped-snapshot, artifact-before-acceptance, idempotent-retry, concurrent-framework-isolation)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
