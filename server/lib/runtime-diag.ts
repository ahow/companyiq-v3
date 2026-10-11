/**
 * DIAGNOSTIC-ONLY runtime probes (batch-1271 investigation).
 *
 * Observability only: every probe is read-only, wrapped in try/catch, runs on
 * unref'd timers, and never awaits on (or throws into) any production code
 * path. No concurrency, pool, timeout, retry, lock or replica setting is read
 * or modified here.
 *
 * Kill switch: DIAG_RUNTIME_ENABLED=false (read once at module load, i.e. at
 * process boot; on Railway a variable change redeploys, so it takes effect on
 * the next boot). With it set, every export below is a no-op: no timers, no
 * listeners, no PINGs, no log lines. In-process, disableRuntimeDiag() /
 * stopRuntimeDiag() tear down everything already running (timers, histogram,
 * BullMQ listeners, registered clients); stopRuntimeDiag() is called from
 * graceful shutdown.
 * Period via DIAG_RUNTIME_INTERVAL_MS (default 15s, clamped 5s..300s).
 *
 * Redis PING bound: at most ONE diagnostic PING is outstanding per client at
 * any time. A client whose previous PING has not settled (even after the 10s
 * diag timeout) is skipped with outcome=skipped_prev_pending until that PING
 * actually resolves or rejects; clients not in status "ready" are skipped
 * (outcome=skipped_not_ready) so nothing is ever added to ioredis's offline
 * queue. A late reply/rejection only clears the per-client flag.
 *
 * Log tags:
 *   [DIAG][event-loop]   p50/p99/max loop delay + timer drift (monitorEventLoopDelay)
 *   [DIAG][redis-ping]   PING round-trip per registered ioredis client + its
 *                        sent-awaiting-reply / offline queue depth (ioredis has no
 *                        pool; queue depth is its "acquire wait" analogue)
 *   [DIAG][llm-permits]  LLM semaphore: held / waiting / max
 *   [DIAG][bull-lock]    BullMQ lock renewals, renewal failures, stalled/active
 *   [DIAG][cancel-path]  batch-cancel steps a..f (see cancelTrace)
 */
import { monitorEventLoopDelay } from "perf_hooks";

let enabled = process.env.DIAG_RUNTIME_ENABLED !== "false";
const INTERVAL_MS = Math.min(300_000, Math.max(5_000, parseInt(process.env.DIAG_RUNTIME_INTERVAL_MS || "15000", 10) || 15_000));
const PING_TIMEOUT_MS = 10_000;
const LOOP_RESOLUTION_MS = 20; // histogram baseline: an idle loop reads ≈ this value

/** First 8 chars only — never log a full attempt token. */
export function maskToken(t: string | null | undefined): string {
  return t ? `${String(t).slice(0, 8)}...` : "null";
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* diagnostics never throw */ }
}

// ─── Cancellation-path tracing ───────────────────────────────────────────────
// step: a=pg-cancel  b=redis-flag-write/ack  c=queue-cleanup  d=flag-observed
//       e=attempt-revoke/provider-abort  f=settlement
export function cancelTrace(step: "a" | "b" | "c" | "d" | "e" | "f", fields: Record<string, unknown>): void {
  if (!enabled) return;
  safe(() => {
    const kv = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    console.log(`[DIAG][cancel-path] step=${step} ${kv} at=${new Date().toISOString()}`);
  });
}

// ─── Redis clients to ping ───────────────────────────────────────────────────
const redisClients = new Map<string, any>();
/** Clients whose diagnostic PING has been sent and has not yet settled. */
const pingOutstanding = new Set<any>();

export function registerRedisForDiag(name: string, client: any): void {
  if (!enabled || !client) return;
  safe(() => { redisClients.set(name, client); });
}

/**
 * One PING per client, bounded: returns the outcome string. Never throws.
 * The real ping promise gets its own settle handlers (so a late reply or late
 * rejection after the diag timeout is consumed and only clears the flag).
 */
async function pingOnce(c: any, timeoutMs: number): Promise<string> {
  if (pingOutstanding.has(c)) return "skipped_prev_pending";
  if (c?.status !== "ready") return "skipped_not_ready";
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(c.ping());
  } catch (e: any) {
    return `error:${String(e?.message || e).slice(0, 80)}`;
  }
  pingOutstanding.add(c);
  const settle = () => { pingOutstanding.delete(c); };
  p.then(settle, settle); // late resolve/reject: handled, flag cleared, nothing else touched
  let to: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p,
      new Promise((_, rej) => { to = setTimeout(() => rej(new Error("diag-timeout")), timeoutMs); to.unref?.(); }),
    ]);
    return "ok";
  } catch (e: any) {
    return e?.message === "diag-timeout" ? `timeout>${timeoutMs}` : `error:${String(e?.message || e).slice(0, 80)}`;
  } finally {
    if (to) clearTimeout(to);
  }
}

// ─── BullMQ lock-renewal observation (listeners only) ────────────────────────
const lastRenewAt = new Map<string, number>();
const activeSince = new Map<string, number>();
const bullListeners: Array<{ worker: any; event: string; fn: (...a: any[]) => void }> = [];

/** Remove every listener added by attachBullLockDiag (optionally only for one worker). */
export function detachBullLockDiag(worker?: any): void {
  for (let i = bullListeners.length - 1; i >= 0; i--) {
    const l = bullListeners[i];
    if (worker && l.worker !== worker) continue;
    safe(() => { (l.worker.off ?? l.worker.removeListener)?.call(l.worker, l.event, l.fn); });
    bullListeners.splice(i, 1);
  }
  if (!worker || bullListeners.length === 0) { lastRenewAt.clear(); activeSince.clear(); }
}

export function attachBullLockDiag(worker: any): void {
  if (!enabled || !worker?.on) return;
  if (bullListeners.some((l) => l.worker === worker)) return; // idempotent per worker
  safe(() => {
    // A previous (torn-down) Worker's listeners and stale job ids are dropped.
    detachBullLockDiag();
    const since = (m: Map<string, number>, id: string) => {
      const t = m.get(id);
      return t ? Date.now() - t : null;
    };
    const on = (event: string, fn: (...a: any[]) => void) => { worker.on(event, fn); bullListeners.push({ worker, event, fn }); };
    on("active", (job: any) => safe(() => {
      const id = String(job?.id);
      activeSince.set(id, Date.now());
      lastRenewAt.set(id, Date.now());
      console.log(`[DIAG][bull-lock] active job=${id} attemptsStarted=${job?.attemptsStarted ?? "-"} stalledCounter=${job?.stalledCounter ?? "-"}`);
    }));
    on("locksRenewed", (data: { count: number; jobIds: string[] }) => safe(() => {
      const per = (data?.jobIds || []).map((id) => `${id}:${since(lastRenewAt, id) ?? "?"}ms`).join(",");
      for (const id of data?.jobIds || []) lastRenewAt.set(id, Date.now());
      console.log(`[DIAG][bull-lock] locksRenewed count=${data?.count ?? 0} since_last_renew=${per || "-"}`);
    }));
    on("lockRenewalFailed", (jobIds: string[]) => safe(() => {
      const per = (jobIds || []).map((id) => `${id}:since_renew=${since(lastRenewAt, id) ?? "?"}ms,active_for=${since(activeSince, id) ?? "?"}ms`).join(" ");
      console.warn(`[DIAG][bull-lock] lockRenewalFailed ${per}`);
    }));
    on("stalled", (jobId: string, prev: string) => safe(() => {
      console.warn(`[DIAG][bull-lock] stalled job=${jobId} prev=${prev ?? "-"} since_renew_here=${since(lastRenewAt, String(jobId)) ?? "n/a"}ms`);
    }));
    const done = (job: any, kind: string) => safe(() => {
      const id = String(job?.id);
      console.log(`[DIAG][bull-lock] ${kind} job=${id} active_for=${since(activeSince, id) ?? "?"}ms`);
      activeSince.delete(id);
      lastRenewAt.delete(id);
    });
    on("completed", (job: any) => done(job, "completed"));
    on("failed", (job: any) => done(job, "failed"));
  });
}

// ─── Periodic sampler ────────────────────────────────────────────────────────
let started = false;
let generation = 0; // bumped by stop: an in-flight ping loop from an old generation exits
let samplerTimer: NodeJS.Timeout | undefined;
let driftTimer: NodeJS.Timeout | undefined;
let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

export function startRuntimeDiag(role: string, opts: { intervalMs?: number; pingTimeoutMs?: number } = {}): void {
  if (!enabled || started) return;
  started = true;
  const gen = ++generation;
  const intervalMs = opts.intervalMs ?? INTERVAL_MS;
  const pingTimeoutMs = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
  safe(() => {
    const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    h.enable();
    histogram = h;
    let lastTick = Date.now();
    let maxDrift = 0;
    driftTimer = setInterval(() => {
      const now = Date.now();
      maxDrift = Math.max(maxDrift, now - lastTick - 1000);
      lastTick = now;
    }, 1000);
    driftTimer.unref?.();

    let pinging = false; // one sweep at a time; per-client bound is pingOutstanding
    samplerTimer = setInterval(() => {
      if (!enabled || gen !== generation) return;
      safe(() => {
        // *_lag_ms = observed delay minus the sampling resolution (≈0 when healthy).
        const ms = (ns: number) => Math.max(0, Math.round(ns / 1e6) - LOOP_RESOLUTION_MS);
        console.log(
          `[DIAG][event-loop] role=${role} p50_lag_ms=${ms(h.percentile(50))} p99_lag_ms=${ms(h.percentile(99))} max_lag_ms=${ms(h.max)} ` +
          `mean_lag_ms=${ms(h.mean)} timer_drift_max_ms=${maxDrift} rss_mb=${Math.round(process.memoryUsage().rss / 1048576)}`,
        );
        h.reset();
        maxDrift = 0;
      });
      // LLM permit gauge (worker only; lazy so the app never loads the providers module for this).
      if (role === "worker") {
        import("./ai-providers.js")
          .then((m) => safe(() => {
            if (!enabled || gen !== generation) return;
            const s = m.__llmSlotForTests.state();
            console.log(`[DIAG][llm-permits] held=${s.active} waiting=${s.waiting} max=${s.max}`);
          }))
          .catch(() => {});
      }
      if (pinging) return;
      pinging = true;
      void (async () => {
        try {
          for (const [name, c] of Array.from(redisClients)) {
            if (!enabled || gen !== generation) break;
            try {
              const sent = c?.commandQueue?.length ?? "?";
              const offline = c?.offlineQueue?.length ?? "?";
              const t0 = Date.now();
              const outcome = await pingOnce(c, pingTimeoutMs);
              if (!enabled || gen !== generation) break;
              console.log(`[DIAG][redis-ping] role=${role} client=${name} status=${c?.status} rtt_ms=${Date.now() - t0} outcome=${outcome} awaiting_reply=${sent} offline_queue=${offline}`);
            } catch { /* skip this client only */ }
          }
        } catch { /* ignore */ } finally {
          pinging = false;
        }
      })();
    }, intervalMs);
    samplerTimer.unref?.();
    console.log(`[DIAG][runtime] started role=${role} interval_ms=${intervalMs}`);
  });
}

/** Tear down everything started/attached by this module. Idempotent; never throws. */
export function stopRuntimeDiag(): void {
  safe(() => {
    generation++;
    if (samplerTimer) clearInterval(samplerTimer);
    if (driftTimer) clearInterval(driftTimer);
    samplerTimer = driftTimer = undefined;
    histogram?.disable();
    histogram = undefined;
    detachBullLockDiag();
    redisClients.clear();
    // pingOutstanding entries clear themselves when their PING settles.
    if (started) console.log(`[DIAG][runtime] stopped`);
    started = false;
  });
}

/** In-process kill switch: stop everything and make every export a no-op. */
export function disableRuntimeDiag(): void {
  enabled = false;
  stopRuntimeDiag();
}

/** Test-only introspection (no production caller). */
export const __runtimeDiagForTests = {
  state: () => ({
    enabled,
    started,
    timers: (samplerTimer ? 1 : 0) + (driftTimer ? 1 : 0),
    histogram: !!histogram,
    bullListeners: bullListeners.length,
    redisClients: redisClients.size,
    pingOutstanding: pingOutstanding.size,
    trackedJobs: lastRenewAt.size + activeSince.size,
  }),
  enable: () => { enabled = true; },
};
