// ─── DIAGNOSTIC-ONLY Postgres pool instrumentation (batch-1255 plan §6.1/§6.4) ──
// Behaviour-neutral: instrumentedQuery() reproduces pg-pool's own Pool.query()
// lifecycle exactly (connect → client.query → client.release(err), with the same
// client 'error' listener) so success/error semantics and release guarantees are
// identical; it only records timings around the two phases. It never retries,
// never holds a client longer than the query, and never changes pool config.
//
// Logged per op: pool name + configured max, totalCount/idleCount/waitingCount,
// op name, and THREE distinct timings — checkout wait, SQL exec, total — which
// are never collapsed. Errors are always logged (message/code/cause/stack);
// successes are sampled (DIAG_DB_SAMPLE_RATE, default 0.01). Ops whose total
// exceeds DIAG_SLOW_OP_MS (default 500ms — a DIAGNOSTIC threshold, NOT an SLA)
// are always logged.
//
// This module must not import server/db.ts (keeps llm-usage.ts test-importable).
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { beginStage, diagFields, diagTags, truncate } from "./diag-context.js";

const DIAG_DB_ENABLED = process.env.DIAG_DB_INSTRUMENTATION !== "false";
const DIAG_DB_SAMPLE_RATE = Math.min(1, Math.max(0, parseFloat(process.env.DIAG_DB_SAMPLE_RATE || "0.01")));
/** DIAGNOSTIC threshold only — not an SLA. */
const DIAG_SLOW_OP_MS = parseInt(process.env.DIAG_SLOW_OP_MS || "500", 10);
const DIAG_POOL_SAMPLER_MS = parseInt(process.env.DIAG_POOL_SAMPLER_MS || "5000", 10);
const DIAG_POOL_IDLE_LOG_EVERY_MS = 60000;
const DIAG_PG_ACTIVITY_ENABLED = process.env.DIAG_PG_ACTIVITY_SAMPLER !== "false";
const DIAG_PG_ACTIVITY_INTERVAL_MS = Math.max(
  5000,
  parseInt(process.env.DIAG_PG_ACTIVITY_INTERVAL_MS || "15000", 10),
);
const DIAG_PG_ACTIVITY_MIN_GAP_MS = 5000;

interface RegisteredPool {
  name: string;
  pool: Pool;
  max: number;
  lastLoggedAt: number;
}
const pools = new Map<string, RegisteredPool>();

function poolState(p: Pool) {
  return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
}

/** Best-effort op name from SQL text: verb + first table, e.g. "insert measure_scores". */
export function sqlOpName(args: any[]): string {
  const a0 = args[0];
  const text: string = typeof a0 === "string" ? a0 : typeof a0?.text === "string" ? a0.text : "";
  if (!text) return a0?.name ? `named:${a0.name}` : "unknown";
  const t = text.trim().replace(/\s+/g, " ");
  const verb = (t.match(/^\w+/)?.[0] || "?").toLowerCase();
  const table = t.match(/\b(?:from|into|update|join)\s+"?([\w.]+)"?/i)?.[1];
  return table ? `${verb} ${table}` : truncate(t, 60);
}

function errInfo(err: any): Record<string, unknown> {
  const cause = err?.cause;
  return {
    message: truncate(String(err?.message || err), 500),
    code: err?.code ?? null,
    cause: cause ? truncate(String(cause?.message || cause), 300) : null,
    cause_code: cause?.code ?? null,
    stack: err?.stack ? truncate(String(err.stack), 1500) : null,
  };
}

function logOp(
  reg: RegisteredPool,
  op: string,
  waitMs: number,
  execMs: number | null,
  totalMs: number,
  phase: "ok" | "acquire_error" | "query_error",
  err?: any,
): void {
  const slow = totalMs >= DIAG_SLOW_OP_MS;
  const isErr = phase !== "ok";
  if (!isErr && !slow && !(DIAG_DB_SAMPLE_RATE > 0 && Math.random() < DIAG_DB_SAMPLE_RATE)) return;
  const payload: Record<string, unknown> = {
    pool: reg.name,
    pool_max: reg.max,
    ...poolState(reg.pool),
    op,
    outcome: phase,
    checkout_wait_ms: Math.round(waitMs),
    exec_ms: execMs === null ? null : Math.round(execMs),
    total_ms: Math.round(totalMs),
    slow_threshold_ms_diagnostic: DIAG_SLOW_OP_MS,
    // The usage pool flushes from a shared background interval, so any inherited
    // job context would be misleading; only the main pool carries job tags.
    ...(reg.name === "main" ? diagFields() : {}),
    ...(isErr ? { error: errInfo(err) } : {}),
  };
  const tag = isErr ? "[DIAG][db-error]" : slow ? "[DIAG][db-slow-op]" : "[DIAG][db-op-sample]";
  const line = `${tag} ${JSON.stringify(payload)}`;
  if (isErr) {
    console.warn(line);
    requestActivitySnapshot(`db-error pool=${reg.name} op=${op}${reg.name === "main" ? " " + diagTags() : ""}`);
  } else console.log(line);
}

/**
 * Drop-in replacement for pg-pool's Pool.query(text|config, values?) promise
 * form. Mirrors pg-pool 3.x query() exactly, plus timing. Callers must route
 * callback/submittable forms to the original pool.query (as db.ts already does).
 */
export function instrumentedQuery(poolName: string, args: any[]): Promise<any> {
  const reg = pools.get(poolName);
  if (!reg) return Promise.reject(new Error(`[pg-diag] pool not registered: ${poolName}`));
  const pool = reg.pool;
  const op = sqlOpName(args);
  // Only main-pool ops count toward a job's stage timers (see logOp note).
  const endStage = poolName === "main" ? beginStage("db_ops", op) : () => {};
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    pool.connect((connErr: Error | undefined, client: PoolClient | undefined) => {
      const t1 = performance.now();
      if (connErr || !client) {
        safeDiag(() => {
          logOp(reg, op, t1 - t0, null, t1 - t0, "acquire_error", connErr);
          endStage(false);
        });
        return reject(connErr);
      }
      let clientReleased = false;
      const finish = (err: any, res?: any) => {
        const t2 = performance.now();
        safeDiag(() => {
          logOp(reg, op, t1 - t0, t2 - t1, t2 - t0, err ? "query_error" : "ok", err);
          endStage(!err);
        });
        if (err) reject(err);
        else resolve(res);
      };
      const onError = (err: Error) => {
        if (clientReleased) return;
        clientReleased = true;
        client.release(err);
        finish(err);
      };
      client.once("error", onError);
      try {
        (client as any).query(args[0], args[1], (err: Error | undefined, res: any) => {
          client.removeListener("error", onError);
          if (clientReleased) return;
          clientReleased = true;
          client.release(err);
          finish(err, res);
        });
      } catch (err: any) {
        client.release(err);
        finish(err);
      }
    });
  });
}

/** Diagnostics must never throw into (or stall) the query's settle path. */
function safeDiag(fn: () => void): void {
  try {
    fn();
  } catch {
    /* ignore */
  }
}

export function isPoolInstrumented(poolName: string): boolean {
  return DIAG_DB_ENABLED && pools.has(poolName);
}

// ─── 5s pool-state sampler ───────────────────────────────────────────────────
let poolSamplerTimer: NodeJS.Timeout | null = null;

export function registerPoolForDiagnostics(name: string, pool: Pool, max: number): void {
  if (!DIAG_DB_ENABLED) return;
  pools.set(name, { name, pool, max, lastLoggedAt: 0 });
  // NOTE: deliberately NO pool.on("error") listener — adding one would change
  // the process's crash behaviour on idle-client errors (not behaviour-neutral).
  if (!poolSamplerTimer && DIAG_POOL_SAMPLER_MS > 0) {
    poolSamplerTimer = setInterval(samplePools, DIAG_POOL_SAMPLER_MS);
    poolSamplerTimer.unref?.();
  }
  startActivitySampler();
}

function samplePools(): void {
  const now = Date.now();
  for (const reg of pools.values()) {
    const s = poolState(reg.pool);
    const busy = s.total - s.idle;
    // Log every tick while anything is checked out/waiting; otherwise once a minute.
    if (busy > 0 || s.waiting > 0 || now - reg.lastLoggedAt >= DIAG_POOL_IDLE_LOG_EVERY_MS) {
      reg.lastLoggedAt = now;
      console.log(
        `[DIAG][pool-state] pool=${reg.name} max=${reg.max} total=${s.total} idle=${s.idle} busy=${busy} waiting=${s.waiting}`,
      );
    }
  }
}

// ─── Bounded pg_stat_activity sampler ────────────────────────────────────────
// Uses its OWN short-lived pg.Client per sample (never a pool slot), with a 3s
// statement_timeout and connect timeout; the client is always ended in finally.
// Adds at most one transient backend per process while a sample runs. Also
// triggered (rate-limited) on DB errors to capture state at error time.
let activityTimer: NodeJS.Timeout | null = null;
let activityRunning = false;
let lastActivityAt = 0;

function startActivitySampler(): void {
  if (activityTimer || !DIAG_PG_ACTIVITY_ENABLED || !process.env.DATABASE_URL) return;
  activityTimer = setInterval(() => void sampleActivity("interval"), DIAG_PG_ACTIVITY_INTERVAL_MS);
  activityTimer.unref?.();
}

function requestActivitySnapshot(reason: string): void {
  if (!DIAG_PG_ACTIVITY_ENABLED || !process.env.DATABASE_URL) return;
  if (Date.now() - lastActivityAt < DIAG_PG_ACTIVITY_MIN_GAP_MS) return;
  void sampleActivity(reason);
}

const ACTIVITY_GROUP_SQL = `
SELECT coalesce(application_name,'') AS app, coalesce(host(client_addr),'local') AS client,
       coalesce(state,'') AS state, coalesce(wait_event_type,'') AS wait_type, coalesce(wait_event,'') AS wait_event,
       count(*)::int AS n,
       round(max(extract(epoch FROM now() - xact_start)) * 1000)::bigint AS max_xact_age_ms,
       round(max(extract(epoch FROM now() - state_change)) * 1000)::bigint AS max_state_age_ms
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
GROUP BY 1,2,3,4,5 ORDER BY n DESC LIMIT 40`;

const ACTIVITY_BLOCKED_SQL = `
SELECT pid, coalesce(application_name,'') AS app, coalesce(state,'') AS state,
       coalesce(wait_event_type,'') AS wait_type, coalesce(wait_event,'') AS wait_event,
       pg_blocking_pids(pid) AS blocked_by,
       round(extract(epoch FROM now() - xact_start) * 1000)::bigint AS xact_age_ms,
       left(query, 160) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
LIMIT 20`;

async function sampleActivity(reason: string): Promise<void> {
  if (activityRunning) return;
  activityRunning = true;
  lastActivityAt = Date.now();
  let client: import("pg").Client | null = null;
  try {
    const pg = (await import("pg")).default;
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
      application_name: "ciq-diag-sampler",
    } as any);
    client.on("error", () => {}); // never crash the process from the sampler
    await client.connect();
    const groups = await client.query(ACTIVITY_GROUP_SQL);
    const blocked = await client.query(ACTIVITY_BLOCKED_SQL);
    const total = groups.rows.reduce((a: number, r: any) => a + Number(r.n), 0);
    console.log(
      `[DIAG][pg-activity] ${JSON.stringify({
        reason: truncate(reason, 300),
        backends_total: total,
        groups: groups.rows,
        blocked: blocked.rows,
        local_pools: [...pools.values()].map((r) => ({ pool: r.name, max: r.max, ...poolState(r.pool) })),
      })}`,
    );
  } catch (e: any) {
    console.warn(`[DIAG][pg-activity] sample failed (ignored): ${truncate(String(e?.message || e), 300)}`);
  } finally {
    activityRunning = false;
    if (client) {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
}
