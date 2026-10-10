// ─── TEST-ONLY fault-injection harness ───────────────────────────────────────
// Strictly gated: fully inert unless DIAG_FAULT_INJECT is set. It never adds
// new stop / fencing logic — it only (a) shortens the EXISTING discovery /
// pipeline timeout for the targeted attempt, or (b) calls the REAL
// markBatchCancelled() + cancelBatchRun() once at a chosen moment, so the
// production cancellation / lifecycle-fence path can be observed.
//
// Targeting (re-keyed): the PRIMARY key is the batch and/or job, never the
// company. A fault can only fire for an attempt whose diag context matches
//   DIAG_FAULT_BATCH=<batch_runs.id>   and/or   DIAG_FAULT_JOB=<analysis_jobs.id>
// (at least one must be set; when both are set both must match). companyId in
// the spec is an OPTIONAL extra check. This prevents a stale company-keyed
// config from firing inside an unrelated later batch.
//
// DIAG_FAULT_INJECT is a JSON spec or array of specs:
//   DIAG_FAULT_BATCH=1301
//   DIAG_FAULT_INJECT=[{"mode":"discovery_timeout","ms":8000,"companyId":147},
//                      {"mode":"cancel_external_inflight"}]
//
// Every entry point is try/catch-wrapped: a harness error is logged and
// swallowed, never propagated into a job.
import { getDiagContext, diagTags } from "./diag-context.js";
// cancellation.js is imported lazily (it opens Redis at module load) so this
// module stays side-effect-free for scripts that import discovery/pipeline.

export type FaultMode =
  | "discovery_timeout"
  | "pipeline_timeout"
  | "cancel_waiting_db"
  | "cancel_external_inflight";

export interface FaultSpec {
  mode: FaultMode;
  ms: number;
  /** Optional extra check; never the primary key. */
  companyId: number | null;
}

export interface FaultTarget {
  batchId: number | null;
  jobId: number | null;
}

export interface FaultIds {
  batchId?: number | null;
  jobId?: number | null;
  companyId?: number | null;
}

const VALID_MODES = new Set<FaultMode>([
  "discovery_timeout",
  "pipeline_timeout",
  "cancel_waiting_db",
  "cancel_external_inflight",
]);
const DEFAULT_MS = 8000;

function parseIntEnv(v: string | undefined): number | null {
  if (!v || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

interface FaultConfig { target: FaultTarget; specs: FaultSpec[] }
const INERT: FaultConfig = { target: { batchId: null, jobId: null }, specs: [] };

/** Parse the harness config from an env object (exported for tests). */
export function parseFaultConfig(env: Record<string, string | undefined> = process.env): FaultConfig {
  const raw = env.DIAG_FAULT_INJECT;
  if (!raw || !raw.trim()) {
    console.log("[FAULT-INJECT] harness INACTIVE (DIAG_FAULT_INJECT unset)");
    return INERT;
  }
  const target: FaultTarget = { batchId: parseIntEnv(env.DIAG_FAULT_BATCH), jobId: parseIntEnv(env.DIAG_FAULT_JOB) };
  if (target.batchId == null && target.jobId == null) {
    console.warn("[FAULT-INJECT] harness INACTIVE (DIAG_FAULT_INJECT set but neither DIAG_FAULT_BATCH nor DIAG_FAULT_JOB is a valid id)");
    return INERT;
  }
  const specs: FaultSpec[] = [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const v of list) {
      const mode = v?.mode as FaultMode;
      if (!v || typeof v !== "object" || !VALID_MODES.has(mode)) {
        console.warn(`[FAULT-INJECT] ignoring invalid spec ${JSON.stringify(v)}`);
        continue;
      }
      const msNum = Number(v.ms);
      const ms = Number.isInteger(msNum) && msNum > 0 ? msNum : DEFAULT_MS;
      const cidNum = Number(v.companyId);
      const companyId = v.companyId != null && Number.isInteger(cidNum) ? cidNum : null;
      specs.push({ mode, ms, companyId });
    }
  } catch (e: any) {
    console.warn(`[FAULT-INJECT] harness INACTIVE (invalid JSON: ${e?.message || e})`);
    return INERT;
  }
  if (specs.length === 0) {
    console.log("[FAULT-INJECT] harness INACTIVE (no valid specs)");
    return INERT;
  }
  const desc = specs.map((s) => `${s.mode}${s.mode.endsWith("_timeout") ? `@${s.ms}ms` : ""}${s.companyId != null ? `[company=${s.companyId}]` : ""}`).join(", ");
  console.warn(`[FAULT-INJECT] harness ACTIVE (TEST-ONLY) batch=${target.batchId ?? "*"} job=${target.jobId ?? "*"}: ${desc}`);
  return { target, specs };
}

let CONFIG: FaultConfig;
try {
  CONFIG = parseFaultConfig();
} catch {
  CONFIG = INERT;
}

/** Test hook: re-read config from an env object. */
export function __reloadFaultConfigForTests(env: Record<string, string | undefined>): void {
  CONFIG = parseFaultConfig(env);
  firedCancels.clear();
}

export function isFaultInjectActive(): boolean {
  return CONFIG.specs.length > 0;
}

/**
 * Returns the matching spec for `mode`, or null (always null when inert).
 * ids default to the current diag context (batch/job/company of the attempt).
 */
export function getFaultSpec(mode: FaultMode, ids: FaultIds = {}): FaultSpec | null {
  try {
    if (CONFIG.specs.length === 0) return null;
    const ctx = getDiagContext();
    const batchId = ids.batchId ?? ctx?.batchId ?? null;
    const jobId = ids.jobId ?? ctx?.jobId ?? null;
    const companyId = ids.companyId ?? ctx?.companyId ?? null;
    const { target } = CONFIG;
    if (target.batchId != null && Number(batchId) !== target.batchId) return null;
    if (target.jobId != null && Number(jobId) !== target.jobId) return null;
    return CONFIG.specs.find((s) => s.mode === mode && (s.companyId == null || Number(companyId) === s.companyId)) ?? null;
  } catch {
    return null;
  }
}

/** Log a harness event with full diag correlation + precise timestamp. */
export function faultLog(msg: string): void {
  try {
    console.warn(`[FAULT-INJECT] ${new Date().toISOString()} ${msg} ${diagTags()}`);
  } catch { /* never propagate */ }
}

/**
 * Returns the deadline to use for a timeout. For the targeted batch/job (and
 * optional company) with the matching timeout mode, returns spec.ms;
 * otherwise returns `normalMs` unchanged.
 */
export function faultTimeoutMs(
  mode: "discovery_timeout" | "pipeline_timeout",
  normalMs: number,
  ids: FaultIds = {},
): number {
  try {
    const spec = getFaultSpec(mode, ids);
    if (!spec) return normalMs;
    const attempt = getDiagContext()?.attemptId ?? "-";
    faultLog(`${mode} armed at ${spec.ms}ms (normal ${normalMs}ms) attempt ${attempt}`);
    return spec.ms;
  } catch (e: any) {
    try { console.error(`[FAULT-INJECT] faultTimeoutMs error (ignored): ${e?.message || e}`); } catch { /* */ }
    return normalMs;
  }
}

// Fires-once dedupe keyed by mode:batch:job. In-memory only — it RESETS ON
// REDEPLOY / process restart, so after a redeploy with the harness still
// configured the cancel can fire once more for the same target. Unset
// DIAG_FAULT_INJECT after a test run.
const firedCancels = new Set<string>();

/**
 * If the current attempt is the targeted batch/job (optional company) for
 * `mode`, calls the REAL markBatchCancelled(batchId) + cancelBatchRun(batchId)
 * at most once per (mode, batch, job). Returns a promise that ALWAYS resolves
 * (callers may await it for determinism, or ignore it to keep an in-flight
 * request running). Never throws. Adds no stop logic of its own.
 */
export function maybeFireCancel(
  mode: "cancel_waiting_db" | "cancel_external_inflight",
  where: string,
  ids: FaultIds = {},
): Promise<void> {
  try {
    const spec = getFaultSpec(mode, ids);
    if (!spec) return Promise.resolve();
    const ctx = getDiagContext();
    const batchId = ids.batchId ?? ctx?.batchId ?? null;
    const jobId = ids.jobId ?? ctx?.jobId ?? null;
    if (batchId == null) {
      faultLog(`${mode} SKIPPED at ${where}: no batchId`);
      return Promise.resolve();
    }
    const key = `${mode}:${batchId}:${jobId ?? "-"}`;
    if (firedCancels.has(key)) return Promise.resolve();
    firedCancels.add(key);
    const attempt = ctx?.attemptId ?? "-";
    const stage = ctx?.stage ?? "-";
    faultLog(`${mode} FIRING real-cancel(${batchId}) at ${where} job ${jobId ?? "-"} attempt ${attempt} stage ${stage}`);
    // Faithfully simulate a real admin cancellation: the non-authoritative
    // Redis notification AND the authoritative PG terminal state, exactly like
    // POST /api/batch/cancel (cancelBatch + cancelBatchRun).
    return Promise.allSettled([
      import("../cancellation.js").then(({ markBatchCancelled }) => markBatchCancelled(batchId)),
      import("../storage.js").then((s) => s.cancelBatchRun(batchId, "fault-injection controlled cancel test")),
    ]).then(
      () => faultLog(`${mode} real-cancel(${batchId}) resolved (job ${jobId ?? "-"} attempt ${attempt})`),
      (e: any) => faultLog(`${mode} real-cancel(${batchId}) error (ignored): ${e?.message || e}`),
    );
  } catch (e: any) {
    try { console.error(`[FAULT-INJECT] maybeFireCancel error (ignored): ${e?.message || e}`); } catch { /* */ }
    return Promise.resolve();
  }
}
