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

  console.log("reliability acceptance tests: PASS (duplicate-create, heartbeat, provenance, fingerprint, finalizer)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
