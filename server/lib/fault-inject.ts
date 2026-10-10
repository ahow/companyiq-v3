// ─── TEST-ONLY fault-injection harness ───────────────────────────────────────
// Strictly gated: fully inert unless DIAG_FAULT_INJECT is set to a non-empty
// JSON object mapping companyId -> { mode, ms? }. It never adds new stop /
// fencing logic — it only (a) shortens the EXISTING discovery/pipeline timeout
// for a flagged company, or (b) calls the REAL markBatchCancelled() once at a
// chosen moment, so the existing cooperative cancellation path can be observed.
//
// Example:
//   DIAG_FAULT_INJECT={"147":{"mode":"discovery_timeout","ms":8000},
//                      "257":{"mode":"pipeline_timeout","ms":8000},
//                      "2682":{"mode":"cancel_waiting_db"},
//                      "2004":{"mode":"cancel_external_inflight"}}
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
}

const VALID_MODES = new Set<FaultMode>([
  "discovery_timeout",
  "pipeline_timeout",
  "cancel_waiting_db",
  "cancel_external_inflight",
]);
const DEFAULT_MS = 8000;

function parseConfig(): Map<string, FaultSpec> {
  const out = new Map<string, FaultSpec>();
  const raw = process.env.DIAG_FAULT_INJECT;
  if (!raw || !raw.trim()) {
    console.log("[FAULT-INJECT] harness INACTIVE (DIAG_FAULT_INJECT unset)");
    return out;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[FAULT-INJECT] harness INACTIVE (DIAG_FAULT_INJECT is not a JSON object)");
      return out;
    }
    for (const [cid, v] of Object.entries(parsed as Record<string, any>)) {
      const mode = v?.mode as FaultMode;
      if (!/^\d+$/.test(cid) || !VALID_MODES.has(mode)) {
        console.warn(`[FAULT-INJECT] ignoring invalid entry company=${cid} spec=${JSON.stringify(v)}`);
        continue;
      }
      const msNum = Number(v?.ms);
      const ms = Number.isInteger(msNum) && msNum > 0 ? msNum : DEFAULT_MS;
      out.set(cid, { mode, ms });
    }
  } catch (e: any) {
    console.warn(`[FAULT-INJECT] harness INACTIVE (invalid JSON: ${e?.message || e})`);
    return new Map();
  }
  if (out.size === 0) {
    console.log("[FAULT-INJECT] harness INACTIVE (no valid entries)");
  } else {
    const desc = Array.from(out.entries()).map(([c, s]) => `${c}:${s.mode}${s.mode.endsWith("_timeout") ? `@${s.ms}ms` : ""}`).join(", ");
    console.warn(`[FAULT-INJECT] harness ACTIVE (TEST-ONLY) for companies: ${desc}`);
  }
  return out;
}

let CONFIG: Map<string, FaultSpec>;
try {
  CONFIG = parseConfig();
} catch {
  CONFIG = new Map();
}

export function isFaultInjectActive(): boolean {
  return CONFIG.size > 0;
}

/** Returns the fault spec for a company, or null (always null when inert). */
export function getFaultSpec(companyId: number | string | null | undefined): FaultSpec | null {
  try {
    if (CONFIG.size === 0 || companyId == null) return null;
    return CONFIG.get(String(companyId)) ?? null;
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
 * Returns the deadline to use for a timeout. For a company flagged with the
 * matching timeout mode, returns spec.ms; otherwise returns `normalMs` unchanged.
 */
export function faultTimeoutMs(
  companyId: number | null | undefined,
  mode: "discovery_timeout" | "pipeline_timeout",
  normalMs: number,
): number {
  try {
    const spec = getFaultSpec(companyId);
    if (!spec || spec.mode !== mode) return normalMs;
    const attempt = getDiagContext()?.attemptId ?? "-";
    faultLog(`${mode} armed at ${spec.ms}ms (normal ${normalMs}ms) for company ${companyId} attempt ${attempt}`);
    return spec.ms;
  } catch (e: any) {
    try { console.error(`[FAULT-INJECT] faultTimeoutMs error (ignored): ${e?.message || e}`); } catch { /* */ }
    return normalMs;
  }
}

const firedCancels = new Set<string>();

/**
 * If `companyId` is flagged with `mode`, calls the REAL markBatchCancelled(batchId)
 * at most once per (batchId, companyId). Returns a promise that ALWAYS resolves
 * (callers may await it for determinism, or ignore it to keep an in-flight
 * request running). Never throws. Adds no stop logic of its own.
 */
export function maybeFireCancel(
  mode: "cancel_waiting_db" | "cancel_external_inflight",
  batchId: number | null | undefined,
  companyId: number | null | undefined,
  where: string,
): Promise<void> {
  try {
    const spec = getFaultSpec(companyId);
    if (!spec || spec.mode !== mode) return Promise.resolve();
    if (batchId == null) {
      faultLog(`${mode} SKIPPED at ${where}: no batchId for company ${companyId}`);
      return Promise.resolve();
    }
    const key = `${batchId}:${companyId}`;
    if (firedCancels.has(key)) return Promise.resolve();
    firedCancels.add(key);
    const attempt = getDiagContext()?.attemptId ?? "-";
    const stage = getDiagContext()?.stage ?? "-";
    faultLog(`${mode} FIRING real-cancel(${batchId}) at ${where} company ${companyId} attempt ${attempt} stage ${stage}`);
    // Faithfully simulate a real admin cancellation: set BOTH the durable Redis
    // cooperative-cancel flag (what actually fences in-flight work) AND the PG
    // terminal lifecycle (status=cancelled/terminal/rejected), exactly like the
    // production POST /api/batch/cancel path (cancelBatch + cancelBatchRun).
    // This is a TEST-INJECTION faithfulness change only; it does NOT alter any
    // production fencing/cancellation behaviour.
    return Promise.allSettled([
      import("../cancellation.js").then(({ markBatchCancelled }) => markBatchCancelled(batchId)),
      import("../storage.js").then((s) => s.cancelBatchRun(batchId, "fault-injection controlled cancel test")),
    ]).then(
      () => faultLog(`${mode} real-cancel(${batchId}) resolved (company ${companyId} attempt ${attempt})`),
      (e: any) => faultLog(`${mode} real-cancel(${batchId}) error (ignored): ${e?.message || e}`),
    );
  } catch (e: any) {
    try { console.error(`[FAULT-INJECT] maybeFireCancel error (ignored): ${e?.message || e}`); } catch { /* */ }
    return Promise.resolve();
  }
}
