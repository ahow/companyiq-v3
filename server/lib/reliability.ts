import crypto from "node:crypto";

export const RUN_LIFECYCLE_STATES = [
  "created",
  "running",
  "terminal_success",
  "terminal_failed",
  "cancelled",
  "accepted",
  "rejected",
] as const;

export type RunLifecycleState = (typeof RUN_LIFECYCLE_STATES)[number];

export type DeploymentFingerprint = {
  sourceSha: string;
  liveAppSha: string;
  liveWorkerSha: string;
  tsCount: number;
  executableGeneralisationCount: number;
};

export type RunKeyInput = {
  testCycleId: string;
  commitSha: string;
  frameworkId: number;
  listId?: number | null;
  batteryLabel: string;
};

export type ProgressJob = {
  id: number;
  status: string;
  lastProgressAt?: Date | string | number | null;
};

export type ProgressSnapshot = {
  total: number;
  completed: number;
  active: number;
  pending: number;
  failed: number;
  lastProgressAt: string | null;
  oldestActiveJobAgeMs: number | null;
  jobs: Array<{ id: number; status: string; lastProgressAt: string | null }>;
};

export type EvidenceSnapshot = {
  id: number;
  batchId: number;
  runKey: string;
  lifecycleState: string;
  acceptanceState: string;
  deploymentFingerprint: DeploymentFingerprint | null;
  totalJobs: number;
  companiesCount: number;
  batteryLabel?: string | null;
  resultsData: unknown;
};

export type EvidenceSelectionOptions = {
  expectedCompanyCount: number;
  deploymentFingerprint: DeploymentFingerprint;
  requiredSnapshotCount?: number;
};

export type EvidenceSelection = {
  accepted: EvidenceSnapshot[];
  rejected: Array<{ snapshot: EvidenceSnapshot; reason: string }>;
};

function normalisePart(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function normaliseFingerprint(value: DeploymentFingerprint): DeploymentFingerprint {
  return {
    sourceSha: normalisePart(value.sourceSha),
    liveAppSha: normalisePart(value.liveAppSha),
    liveWorkerSha: normalisePart(value.liveWorkerSha),
    tsCount: Number(value.tsCount),
    executableGeneralisationCount: Number(value.executableGeneralisationCount),
  };
}

export function buildRunKey(input: RunKeyInput): string {
  const canonical = [
    normalisePart(input.testCycleId),
    normalisePart(input.commitSha),
    normalisePart(input.frameworkId),
    normalisePart(input.listId),
    normalisePart(input.batteryLabel),
  ].join("|");
  return `run_${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function deploymentFingerprintFromEnvironment(env: NodeJS.ProcessEnv = process.env): DeploymentFingerprint {
  return {
    sourceSha: normalisePart(env.SOURCE_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_SHA),
    liveAppSha: normalisePart(env.LIVE_APP_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_SHA),
    liveWorkerSha: normalisePart(env.LIVE_WORKER_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_SHA),
    tsCount: Number(env.TS_COUNT || 0),
    executableGeneralisationCount: Number(env.EXECUTABLE_GENERALISATION_COUNT || 0),
  };
}

export function fingerprintsEqual(a: DeploymentFingerprint | null | undefined, b: DeploymentFingerprint | null | undefined): boolean {
  if (!a || !b) return false;
  const left = normaliseFingerprint(a);
  const right = normaliseFingerprint(b);
  return left.sourceSha === right.sourceSha
    && left.liveAppSha === right.liveAppSha
    && left.liveWorkerSha === right.liveWorkerSha
    && left.tsCount === right.tsCount
    && left.executableGeneralisationCount === right.executableGeneralisationCount;
}

export function compareDeploymentFingerprint(
  expected: DeploymentFingerprint,
  actual: DeploymentFingerprint,
): string[] {
  const left = normaliseFingerprint(expected);
  const right = normaliseFingerprint(actual);
  const mismatches: string[] = [];
  for (const field of [
    "sourceSha",
    "liveAppSha",
    "liveWorkerSha",
    "tsCount",
    "executableGeneralisationCount",
  ] as const) {
    if (left[field] !== right[field]) mismatches.push(field);
  }
  return mismatches;
}

export function assertProductionFingerprint(
  expected: DeploymentFingerprint,
  actual: DeploymentFingerprint,
  diagnosticRun = false,
): void {
  const mismatches = compareDeploymentFingerprint(expected, actual);
  if (mismatches.length > 0 && !diagnosticRun) {
    throw new Error(`Production battery refused: deployment fingerprint mismatch (${mismatches.join(", ")})`);
  }
}

export function isTerminalLifecycleState(state: string | null | undefined): boolean {
  return state === "terminal_success"
    || state === "terminal_failed"
    || state === "cancelled"
    || state === "accepted"
    || state === "rejected";
}

export function computeProgressSnapshot(
  jobs: ProgressJob[],
  now = new Date(),
): ProgressSnapshot {
  const counts = jobs.reduce((acc, job) => {
    acc.total += 1;
    if (job.status === "completed") acc.completed += 1;
    else if (job.status === "failed") acc.failed += 1;
    else if (job.status === "claimed" || job.status === "active") acc.active += 1;
    else acc.pending += 1;
    return acc;
  }, { total: 0, completed: 0, active: 0, pending: 0, failed: 0 });

  const normalisedJobs = jobs.map((job) => ({
    id: job.id,
    status: job.status,
    lastProgressAt: job.lastProgressAt == null ? null : new Date(job.lastProgressAt).toISOString(),
  }));
  const progressTimes = jobs
    .map((job) => job.lastProgressAt == null ? null : new Date(job.lastProgressAt).getTime())
    .filter((value): value is number => Number.isFinite(value));
  const activeTimes = jobs
    .filter((job) => job.status === "claimed" || job.status === "active")
    .map((job) => job.lastProgressAt == null ? null : new Date(job.lastProgressAt).getTime())
    .filter((value): value is number => Number.isFinite(value));

  return {
    ...counts,
    lastProgressAt: progressTimes.length > 0 ? new Date(Math.max(...progressTimes)).toISOString() : null,
    oldestActiveJobAgeMs: activeTimes.length > 0 ? Math.max(0, now.getTime() - Math.min(...activeTimes)) : null,
    jobs: normalisedJobs,
  };
}

export function isHeartbeatStalled(args: {
  lifecycleState: string;
  lastHeartbeatAt: Date | string | number | null | undefined;
  activeJobs: ProgressJob[];
  now?: Date;
  thresholdMs: number;
}): boolean {
  if (args.lifecycleState !== "running") return false;
  const now = args.now ?? new Date();
  const batchHeartbeat = args.lastHeartbeatAt == null ? NaN : new Date(args.lastHeartbeatAt).getTime();
  if (!Number.isFinite(batchHeartbeat) || now.getTime() - batchHeartbeat <= args.thresholdMs) return false;
  if (args.activeJobs.length === 0) return false;
  return args.activeJobs.every((job) => {
    const progress = job.lastProgressAt == null ? NaN : new Date(job.lastProgressAt).getTime();
    return Number.isFinite(progress) && now.getTime() - progress > args.thresholdMs;
  });
}

export function selectValidEvidenceSnapshots(
  snapshots: EvidenceSnapshot[],
  options: EvidenceSelectionOptions,
): EvidenceSelection {
  const requiredCount = options.requiredSnapshotCount ?? 4;
  const accepted: EvidenceSnapshot[] = [];
  const rejected: Array<{ snapshot: EvidenceSnapshot; reason: string }> = [];
  const seenRunKeys = new Set<string>();

  for (const snapshot of [...snapshots].sort((a, b) => a.runKey.localeCompare(b.runKey) || a.id - b.id)) {
    let reason: string | null = null;
    if (!(snapshot.lifecycleState === "accepted" || snapshot.lifecycleState === "terminal_success") || snapshot.acceptanceState !== "accepted") {
      reason = "snapshot is not an accepted terminal-success run";
    } else if (snapshot.totalJobs !== options.expectedCompanyCount || snapshot.companiesCount !== options.expectedCompanyCount) {
      reason = "snapshot is not complete for the expected company count";
    } else if (!fingerprintsEqual(snapshot.deploymentFingerprint, options.deploymentFingerprint)) {
      reason = "deployment fingerprint does not match the battery fingerprint";
    } else if (seenRunKeys.has(snapshot.runKey)) {
      reason = "duplicate run_key";
    }
    if (reason) rejected.push({ snapshot, reason });
    else {
      accepted.push(snapshot);
      seenRunKeys.add(snapshot.runKey);
    }
  }

  if (accepted.length > requiredCount) {
    const overflow = accepted.splice(requiredCount);
    for (const snapshot of overflow) rejected.push({ snapshot, reason: "snapshot exceeds the required evidence set" });
  }
  return { accepted, rejected };
}

function snapshotResults(snapshot: EvidenceSnapshot): Array<{ companyId: number; totalScore: number }> {
  if (!Array.isArray(snapshot.resultsData)) return [];
  return snapshot.resultsData
    .filter((value): value is { companyId: number; totalScore: number } => {
      const row = value as any;
      return Number.isFinite(Number(row?.companyId)) && Number.isFinite(Number(row?.totalScore));
    })
    .map((row) => ({ companyId: Number(row.companyId), totalScore: Number(row.totalScore) }));
}

export function computeRecoveryLabels(expectedLabels: string[], runs: Array<{ batteryLabel: string; lifecycleState: string; acceptanceState: string }>): { accepted: string[]; rejected: string[]; rerun: string[] } {
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  for (const run of runs) {
    if (run.lifecycleState === "accepted" && run.acceptanceState === "accepted") accepted.add(run.batteryLabel);
    else if (run.lifecycleState === "rejected" || run.acceptanceState === "rejected" || run.lifecycleState === "cancelled") rejected.add(run.batteryLabel);
  }
  const expected = [...new Set(expectedLabels)].sort();
  const rerun = expected.filter((label) => !accepted.has(label));
  return {
    accepted: expected.filter((label) => accepted.has(label)),
    rejected: expected.filter((label) => rejected.has(label)),
    rerun,
  };
}

export type GateReportData = {
  testCycleId: string;
  deploymentFingerprint: DeploymentFingerprint;
  sourceRunKeys: string[];
  fleetAverages: Array<{ runKey: string; batteryLabel: string | null; averageScore: number }>;
  companyABDelta: Array<{ companyId: number; scoreA: number | null; scoreB: number | null; delta: number | null }>;
  gates: Array<{ id: number; name: string; passed: boolean; reason: string }>;
  developerInstructionSpec: Record<string, unknown>;
};

export function buildGateReport(
  testCycleId: string,
  snapshots: EvidenceSnapshot[],
  fingerprint: DeploymentFingerprint,
  expectedCompanyCount: number,
): GateReportData {
  const ordered = [...snapshots].sort((a, b) => a.runKey.localeCompare(b.runKey));
  const fleetAverages = ordered.map((snapshot) => {
    const rows = snapshotResults(snapshot);
    const averageScore = rows.length > 0 ? rows.reduce((sum, row) => sum + row.totalScore, 0) / rows.length : 0;
    return {
      runKey: snapshot.runKey,
      batteryLabel: snapshot.batteryLabel ?? null,
      averageScore: Number(averageScore.toFixed(6)),
    };
  });

  const byCompany = new Map<number, { a?: number; b?: number }>();
  for (const snapshot of ordered) {
    const label = (snapshot.batteryLabel ?? "").toLowerCase();
    const variant = label.endsWith("a") ? "a" : label.endsWith("b") ? "b" : null;
    if (!variant) continue;
    for (const row of snapshotResults(snapshot)) {
      const current = byCompany.get(row.companyId) ?? {};
      current[variant] = row.totalScore;
      byCompany.set(row.companyId, current);
    }
  }
  const companyABDelta = [...byCompany.entries()].sort(([a], [b]) => a - b).map(([companyId, values]) => ({
    companyId,
    scoreA: values.a ?? null,
    scoreB: values.b ?? null,
    delta: values.a != null && values.b != null ? Number((values.b - values.a).toFixed(6)) : null,
  }));

  const sameFingerprint = ordered.every((snapshot) => fingerprintsEqual(snapshot.deploymentFingerprint, fingerprint));
  const complete = ordered.every((snapshot) => snapshot.companiesCount === expectedCompanyCount && snapshot.totalJobs === expectedCompanyCount);
  const uniqueRuns = new Set(ordered.map((snapshot) => snapshot.runKey)).size === ordered.length;
  const terminalSuccess = ordered.every((snapshot) => snapshot.lifecycleState === "accepted" || snapshot.lifecycleState === "terminal_success");
  const acceptedState = ordered.every((snapshot) => snapshot.acceptanceState === "accepted");
  const evidencePresent = ordered.every((snapshot) => snapshotResults(snapshot).length === expectedCompanyCount);
  const reportInputsDeterministic = ordered.every((snapshot) => snapshot.runKey.length > 0);
  const gates = [
    { id: 1, name: "required_snapshot_count", passed: ordered.length === 4, reason: ordered.length === 4 ? "four accepted snapshots are present" : `expected four accepted snapshots, found ${ordered.length}` },
    { id: 2, name: "terminal_success_and_acceptance", passed: terminalSuccess && acceptedState, reason: terminalSuccess && acceptedState ? "all snapshots are accepted terminal runs" : "one or more snapshots are not terminal-success and accepted" },
    { id: 3, name: "complete_company_coverage", passed: complete, reason: complete ? "all snapshots cover the expected company count" : "one or more snapshots are partial" },
    { id: 4, name: "deployment_fingerprint_match", passed: sameFingerprint, reason: sameFingerprint ? "all snapshots match one deployment fingerprint" : "mixed deployment fingerprints were detected" },
    { id: 5, name: "unique_run_provenance", passed: uniqueRuns, reason: uniqueRuns ? "run keys are unique" : "duplicate run keys were detected" },
    { id: 6, name: "evidence_rows_present", passed: evidencePresent, reason: evidencePresent ? "each snapshot contains one result row per company" : "one or more snapshots lack complete result rows" },
    { id: 7, name: "deterministic_inputs", passed: reportInputsDeterministic, reason: reportInputsDeterministic ? "all report inputs have immutable run keys" : "one or more report inputs lack a run key" },
  ];

  return {
    testCycleId,
    deploymentFingerprint: normaliseFingerprint(fingerprint),
    sourceRunKeys: ordered.map((snapshot) => snapshot.runKey),
    fleetAverages,
    companyABDelta,
    gates,
    developerInstructionSpec: {
      lifecycle: RUN_LIFECYCLE_STATES,
      evidenceRule: "Only accepted terminal-success snapshots with complete company coverage and matching deployment fingerprints may enter KPI aggregation.",
      recoveryRule: "Recovery creates a new run key and preserves accepted snapshots and rejected artifacts with audit provenance.",
      finalizationRule: "The gate report is keyed by test cycle and is immutable after successful persistence.",
    },
  };
}
