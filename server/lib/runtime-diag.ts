/**
 * DIAGNOSTIC-ONLY runtime probes (batch-1271 investigation).
 *
 * Observability only: every probe is read-only, wrapped in try/catch, runs on
 * unref'd timers with an in-flight guard, and never awaits on (or throws into)
 * any production code path. No concurrency, pool, timeout, retry, lock or
 * replica setting is read-modified here. Disable entirely with
 * DIAG_RUNTIME_ENABLED=false; period via DIAG_RUNTIME_INTERVAL_MS (default 15s).
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

const ENABLED = process.env.DIAG_RUNTIME_ENABLED !== "false";
const INTERVAL_MS = Math.min(300_000, Math.max(5_000, parseInt(process.env.DIAG_RUNTIME_INTERVAL_MS || "15000", 10) || 15_000));
const PING_TIMEOUT_MS = 10_000;
const LOOP_RESOLUTION_MS = 20; // histogram baseline: an idle loop reads ≈ this value

/** First 8 chars only — never log a full attempt token. */
export function maskToken(t: string | null | undefined): string {
  return t ? `${String(t).slice(0, 8)}…` : "null";
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* diagnostics never throw */ }
}

// ─── Cancellation-path tracing ───────────────────────────────────────────────
// step: a=pg-cancel  b=redis-flag-write/ack  c=queue-cleanup  d=flag-observed
//       e=attempt-revoke/provider-abort  f=settlement
export function cancelTrace(step: "a" | "b" | "c" | "d" | "e" | "f", fields: Record<string, unknown>): void {
  if (!ENABLED) return;
  safe(() => {
    const kv = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    console.log(`[DIAG][cancel-path] step=${step} ${kv} at=${new Date().toISOString()}`);
  });
}

// ─── Redis clients to ping ───────────────────────────────────────────────────
const redisClients = new Map<string, any>();
export function registerRedisForDiag(name: string, client: any): void {
  if (!ENABLED || !client) return;
  safe(() => { redisClients.set(name, client); });
}

// ─── BullMQ lock-renewal observation (listeners only) ────────────────────────
const lastRenewAt = new Map<string, number>();
const activeSince = new Map<string, number>();

export function attachBullLockDiag(worker: any): void {
  if (!ENABLED || !worker?.on) return;
  safe(() => {
    const since = (m: Map<string, number>, id: string) => {
      const t = m.get(id);
      return t ? Date.now() - t : null;
    };
    worker.on("active", (job: any) => safe(() => {
      const id = String(job?.id);
      activeSince.set(id, Date.now());
      lastRenewAt.set(id, Date.now());
      console.log(`[DIAG][bull-lock] active job=${id} attemptsStarted=${job?.attemptsStarted ?? "-"} stalledCounter=${job?.stalledCounter ?? "-"}`);
    }));
    worker.on("locksRenewed", (data: { count: number; jobIds: string[] }) => safe(() => {
      const per = (data?.jobIds || []).map((id) => `${id}:${since(lastRenewAt, id) ?? "?"}ms`).join(",");
      for (const id of data?.jobIds || []) lastRenewAt.set(id, Date.now());
      console.log(`[DIAG][bull-lock] locksRenewed count=${data?.count ?? 0} since_last_renew=${per || "-"}`);
    }));
    worker.on("lockRenewalFailed", (jobIds: string[]) => safe(() => {
      const per = (jobIds || []).map((id) => `${id}:since_renew=${since(lastRenewAt, id) ?? "?"}ms,active_for=${since(activeSince, id) ?? "?"}ms`).join(" ");
      console.warn(`[DIAG][bull-lock] lockRenewalFailed ${per}`);
    }));
    worker.on("stalled", (jobId: string, prev: string) => safe(() => {
      console.warn(`[DIAG][bull-lock] stalled job=${jobId} prev=${prev ?? "-"} since_renew_here=${since(lastRenewAt, String(jobId)) ?? "n/a"}ms`);
    }));
    const done = (job: any, kind: string) => safe(() => {
      const id = String(job?.id);
      console.log(`[DIAG][bull-lock] ${kind} job=${id} active_for=${since(activeSince, id) ?? "?"}ms`);
      activeSince.delete(id);
      lastRenewAt.delete(id);
    });
    worker.on("completed", (job: any) => done(job, "completed"));
    worker.on("failed", (job: any) => done(job, "failed"));
  });
}

// ─── Periodic sampler ────────────────────────────────────────────────────────
let started = false;

export function startRuntimeDiag(role: string): void {
  if (!ENABLED || started) return;
  started = true;
  safe(() => {
    const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    h.enable();
    let lastTick = Date.now();
    let maxDrift = 0;
    const drift = setInterval(() => {
      const now = Date.now();
      maxDrift = Math.max(maxDrift, now - lastTick - 1000);
      lastTick = now;
    }, 1000);
    drift.unref?.();

    let pinging = false;
    const timer = setInterval(() => {
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
            const s = m.__llmSlotForTests.state();
            console.log(`[DIAG][llm-permits] held=${s.active} waiting=${s.waiting} max=${s.max}`);
          }))
          .catch(() => {});
      }
      if (pinging) return;
      pinging = true;
      void (async () => {
        try {
          for (const [name, c] of redisClients) try {
            const sent = c?.commandQueue?.length ?? "?";
            const offline = c?.offlineQueue?.length ?? "?";
            const t0 = Date.now();
            let outcome = "ok";
            let to: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                c.ping(),
                new Promise((_, rej) => { to = setTimeout(() => rej(new Error("diag-timeout")), PING_TIMEOUT_MS); to.unref?.(); }),
              ]);
            } catch (e: any) {
              outcome = e?.message === "diag-timeout" ? `timeout>${PING_TIMEOUT_MS}` : `error:${String(e?.message || e).slice(0, 80)}`;
            } finally {
              if (to) clearTimeout(to);
            }
            console.log(`[DIAG][redis-ping] role=${role} client=${name} status=${c?.status} rtt_ms=${Date.now() - t0} outcome=${outcome} awaiting_reply=${sent} offline_queue=${offline}`);
          } catch { /* skip this client only */ }
        } catch { /* ignore */ } finally {
          pinging = false;
        }
      })();
    }, INTERVAL_MS);
    timer.unref?.();
    console.log(`[DIAG][runtime] started role=${role} interval_ms=${INTERVAL_MS}`);
  });
}
