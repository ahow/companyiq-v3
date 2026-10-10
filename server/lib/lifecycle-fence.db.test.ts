/**
 * DB-backed lifecycle / ownership fencing tests against a REAL local Postgres
 * (+ Redis for the supersession notification path). Never run against prod.
 *
 * Run:
 *   DATABASE_URL=postgresql://ciqtest:ciqtest@localhost:5432/ciqtest \
 *   REDIS_URL=redis://127.0.0.1:6390 PG_POOL_MAX=1 PG_CONNECTION_TIMEOUT_MS=30000 \
 *   npx tsx server/lib/lifecycle-fence.db.test.ts
 *
 * PG_POOL_MAX=1 is REQUIRED (the DB-wait scenario holds the only connection).
 *
 * Scenarios:
 *   S1 supersession == cancellation (O2): notify + stop + never completed
 *   S2 cancel while queued for a DB connection (pool max=1)
 *   S3 late write after attempt deadline, before a retry claims the job
 *   S4 stale attempt #1 resumes after attempt #2 owns the job
 *   S5 admin cancel: claim/complete/status/finalize refused
 */
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import * as storage from "../storage.js";
import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import { createAttemptLifecycle, ownershipFromContext, revokeAttempt, dispatchRevokedReason, type AttemptOwnership } from "./lifecycle-fence.js";
import { isBatchCancelledCached } from "../cancellation.js";
import { redis } from "../redis.js";
import { finalizeBatchAndSave } from "../worker.js";

process.exitCode = 1; // premature exit must not look like success

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let wsId = 0, fwId = 0;
const companyIds: number[] = [];

async function fixtures() {
  const tag = `lf${Date.now()}`;
  const [u] = await q(`INSERT INTO users (email, password_hash, name) VALUES ('${tag}@t.local','x','t') RETURNING id`);
  const [w] = await q(`INSERT INTO workspaces (name, slug, owner_id) VALUES ('${tag}','${tag}',${u.id}) RETURNING id`);
  wsId = w.id;
  const [f] = await q(`INSERT INTO frameworks (workspace_id, name) VALUES (${wsId},'fw-${tag}') RETURNING id`);
  fwId = f.id;
  for (let i = 0; i < 6; i++) {
    const [c] = await q(`INSERT INTO companies (workspace_id, name) VALUES (${wsId},'co${i}-${tag}') RETURNING id`);
    companyIds.push(c.id);
  }
}

async function newJob(batchId: number, companyId: number): Promise<number> {
  const [j] = await q(`INSERT INTO analysis_jobs (workspace_id, batch_id, company_id, company_name, framework_id) VALUES (${wsId},${batchId},${companyId},'c',${fwId}) RETURNING id`);
  return j.id;
}

/** Claim exactly like the worker and build the attempt's lifecycle context. */
async function claimAttempt(jobId: number, batchId: number, companyId: number, deadlineMs = 60_000): Promise<{ ctx: DiagContext; own: AttemptOwnership } | null> {
  const claimed: any = await storage.claimJob(jobId);
  if (!claimed) return null;
  const lifecycle = createAttemptLifecycle({ jobId, batchId, attemptNumber: claimed.attempts, deadlineAt: new Date(Date.now() + deadlineMs) });
  const ctx: DiagContext = { batchId, jobId, attemptId: `t-${jobId}-${claimed.attempts}`, attemptNumber: claimed.attempts, companyId, frameworkId: fwId, stage: "test", lifecycle };
  return { ctx, own: ownershipFromContext(ctx)! };
}

function scoreRows(companyId: number, n: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({ companyId, frameworkId: fwId, measureId: `${tag}-${i}`, category: "c", categoryNumber: 1, title: tag }));
}
const scoresFor = (companyId: number) => q(`SELECT measure_id FROM measure_scores WHERE company_id=${companyId} AND framework_id=${fwId} ORDER BY measure_id`);
const batchStatus = async (id: number) => (await q(`SELECT status FROM batch_runs WHERE id=${id}`))[0]?.status;
const jobRow = async (id: number) => (await q(`SELECT status, attempts FROM analysis_jobs WHERE id=${id}`))[0];

async function s1Supersession() {
  console.log("── S1 supersession == cancellation (O2) ──");
  // Spy: notify is invoked per superseded id, and failures are non-fatal.
  const marked: number[] = [], removed: number[] = [];
  await storage.notifySupersededBatches([11, 12], { markBatchCancelled: async (id) => { marked.push(id); }, removeBatchJobs: async (id) => { removed.push(id); } });
  check("notifySupersededBatches calls mark + remove for every id", JSON.stringify(marked) === "[11,12]" && JSON.stringify(removed) === "[11,12]");
  let threw = false;
  try { await storage.notifySupersededBatches([13], { markBatchCancelled: async () => { throw new Error("redis down"); }, removeBatchJobs: async () => { throw new Error("bull down"); } }); } catch { threw = true; }
  check("notify failures are non-fatal (PG guard remains authoritative)", !threw);

  const A = (await storage.createBatchRun(wsId, fwId, 2)) as any;
  const jA = await newJob(A.id, companyIds[0]);
  const jA2 = await newJob(A.id, companyIds[1]);
  const att = await claimAttempt(jA, A.id, companyIds[0]);
  check("old batch A: attempt claimed while running", !!att);

  const B = (await storage.createBatchRun(wsId, fwId, 1)) as any; // supersedes A (real notify path: Redis + BullMQ)
  check("A is cancelled in PG after supersession", (await batchStatus(A.id)) === "cancelled");
  check("B is running", (await batchStatus(B.id)) === "running");
  check("A Redis cancel flag set (durable notification)", (await redis.exists(`cancelled:batch:${A.id}`)) === 1);
  check("A in-process cancel cache set", isBatchCancelledCached(A.id));
  check("A attempt: dispatch gate now refuses (work stops)", dispatchRevokedReason(att!.ctx) === "batch_cancelled");

  const wrote = await runWithDiagContext(att!.ctx, () => storage.replaceMeasureScoresFenced(att!.own, companyIds[0], fwId, scoreRows(companyIds[0], 3, "A")));
  check("A attempt: score write fenced", wrote === false);
  check("A attempt: zero score rows", (await scoresFor(companyIds[0])).length === 0);
  const cj = await storage.completeJob(jA, att!.own);
  check("A attempt: completeJob refused (0 rows)", cj.transitioned === false);
  check("A: pending job cannot be claimed (no retry)", (await storage.claimJob(jA2)) === null);
  check("A: completeBatchRun refused", (await storage.completeBatchRun(A.id)) === false);
  check("A: setBatchRunStatus(pending_review) refused", (await storage.setBatchRunStatus(A.id, "pending_review")) === false);
  await finalizeBatchAndSave(A.id, fwId, wsId);
  check("A: finalizeBatchAndSave cannot flip cancelled -> completed", (await batchStatus(A.id)) === "cancelled");
  await finalizeBatchAndSave(A.id, fwId, wsId, undefined, { adminRecoverTerminal: true }).catch(() => {});
  check("A: admin recover path still never flips cancelled -> completed", (await batchStatus(A.id)) === "cancelled");
  // Reconciler fallback statement (verbatim condition) is a no-op on a cancelled batch.
  const rec = await q(`UPDATE batch_runs SET status='completed', completed_at=NOW() WHERE id=${A.id} AND status='running' RETURNING id`);
  check("A: reconciler fallback UPDATE matches 0 rows", rec.length === 0);

  // New batch unaffected.
  const jB = await newJob(B.id, companyIds[0]);
  const attB = await claimAttempt(jB, B.id, companyIds[0]);
  check("B: claim succeeds", !!attB);
  check("B: dispatch allowed", dispatchRevokedReason(attB!.ctx) === null);
  const okB = await runWithDiagContext(attB!.ctx, () => storage.replaceMeasureScoresFenced(attB!.own, companyIds[0], fwId, scoreRows(companyIds[0], 2, "B")));
  check("B: score write persists", okB === true && (await scoresFor(companyIds[0])).length === 2);
  check("B: completeJob transitions", (await storage.completeJob(jB, attB!.own)).transitioned === true);
  check("B: completeBatchRun transitions running -> completed", (await storage.completeBatchRun(B.id)) === true && (await batchStatus(B.id)) === "completed");
}

async function s2DbWaitCancel() {
  console.log("── S2 cancel while queued for a DB connection (pool max=1) ──");
  check("precondition: pool max is 1", (pool as any).options.max === 1, (pool as any).options.max);
  const C = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jC = await newJob(C.id, companyIds[2]);
  const att = (await claimAttempt(jC, C.id, companyIds[2]))!;
  const ext = new pg.Client({ connectionString: process.env.DATABASE_URL }); // external admin connection
  await ext.connect();

  const hold = await pool.connect(); // occupy the only pool connection
  const p = runWithDiagContext(att.ctx, () => storage.replaceMeasureScoresFenced(att.own, companyIds[2], fwId, scoreRows(companyIds[2], 4, "C")));
  await sleep(150);
  check("score write is queued waiting for a connection", pool.waitingCount >= 1, pool.waitingCount);
  await ext.query(`UPDATE batch_runs SET status='cancelled' WHERE id=$1`, [C.id]); // admin cancel lands while queued
  hold.release();
  const res = await p;
  check("queued write refused after cancel (atomic PG guard)", res === false);
  check("zero score rows persisted", (await scoresFor(companyIds[2])).length === 0);
  await sleep(50);
  check("no pool leak: waitingCount=0", pool.waitingCount === 0, pool.waitingCount);
  check("no pool leak: all clients idle", pool.totalCount === pool.idleCount, { total: pool.totalCount, idle: pool.idleCount });
  const r = await ext.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'`);
  check("no connection left idle-in-transaction", r.rows[0].n === 0, r.rows[0].n);

  // Variant: pipeline-timeout revoke while queued (batch still running, SQL deadline not elapsed).
  const D = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jD = await newJob(D.id, companyIds[3]);
  const attD = (await claimAttempt(jD, D.id, companyIds[3]))!;
  const hold2 = await pool.connect();
  const p2 = runWithDiagContext(attD.ctx, () => storage.replaceMeasureScoresFenced(attD.own, companyIds[3], fwId, scoreRows(companyIds[3], 2, "D")));
  await sleep(100);
  revokeAttempt(attD.ctx.lifecycle, "pipeline_timeout");
  hold2.release();
  check("revoked-while-queued write refused post-acquire", (await p2) === false && (await scoresFor(companyIds[3])).length === 0);
  // Owner may still release its own claim after a timeout (not deadline/batch gated).
  check("revoked owner can still release its claim (failJob)", (await storage.failJob(jD, "Job watchdog timeout", attD.own)).transitioned === true);
  await ext.end();
}

async function s3LateWrite() {
  console.log("── S3 late write after deadline, before retry claims ──");
  const E = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jE = await newJob(E.id, companyIds[4]);
  const att = (await claimAttempt(jE, E.id, companyIds[4], 300))!; // 300ms attempt deadline
  await sleep(450); // LLM response arrives after the deadline; no watchdog callback, no retry claim yet
  const before = await jobRow(jE);
  check("job still claimed by attempt 1 (retry has not claimed)", before.status === "claimed" && before.attempts === 1, before);
  // Bypass the in-process deadline pre-check to prove the SQL deadline guard itself refuses.
  const lcNoDeadline = { ...att.ctx.lifecycle!, deadlineAt: null };
  const wrote = await runWithDiagContext({ ...att.ctx, lifecycle: lcNoDeadline }, () => storage.replaceMeasureScoresFenced(att.own, companyIds[4], fwId, scoreRows(companyIds[4], 3, "E")));
  check("late score write refused by SQL deadline guard", wrote === false);
  check("zero score rows", (await scoresFor(companyIds[4])).length === 0);
  check("late completeJob refused", (await storage.completeJob(jE, att.own)).transitioned === false);
  check("job not completed", (await jobRow(jE)).status === "claimed");
}

async function s4StaleAttempt() {
  console.log("── S4 stale attempt #1 resumes after attempt #2 owns ──");
  const F = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const cid = companyIds[5];
  const jF = await newJob(F.id, cid);
  const a1 = (await claimAttempt(jF, F.id, cid))!;
  await storage.failJob(jF, "simulated timeout release", a1.own); // attempt 1 released (e.g. watchdog)
  const a2 = (await claimAttempt(jF, F.id, cid))!;
  check("attempt 2 owns job (attempts=2)", a2.own.attemptNumber === 2 && (await jobRow(jF)).attempts === 2);
  const ok2 = await runWithDiagContext(a2.ctx, () => storage.replaceMeasureScoresFenced(a2.own, cid, fwId, scoreRows(cid, 3, "new")));
  check("attempt 2 score write persists", ok2 === true);

  const ok1 = await runWithDiagContext(a1.ctx, () => storage.replaceMeasureScoresFenced(a1.own, cid, fwId, scoreRows(cid, 5, "old")));
  check("stale attempt 1 score write fenced", ok1 === false);
  const rows = await scoresFor(cid);
  check("attempt 2 scores intact (not deleted / not mixed)", rows.length === 3 && rows.every((r) => String(r.measure_id).startsWith("new")), rows);
  check("stale attempt 1 completeJob ignored", (await storage.completeJob(jF, a1.own)).transitioned === false);
  check("stale attempt 1 failJob ignored", (await storage.failJob(jF, "late error", a1.own)).transitioned === false);
  const jr = await jobRow(jF);
  check("job still claimed by attempt 2", jr.status === "claimed" && jr.attempts === 2, jr);
  check("attempt 2 completeJob transitions", (await storage.completeJob(jF, a2.own)).transitioned === true);
  // Back-compat: unguarded callers (no ownership) keep previous semantics.
  check("completeJob without ownership: idempotent guard unchanged", (await storage.completeJob(jF)).transitioned === false);
}

async function s5AdminCancel() {
  console.log("── S5 admin cancel ──");
  const G = (await storage.createBatchRun(wsId, fwId, 2)) as any;
  const jG1 = await newJob(G.id, companyIds[0]);
  const jG2 = await newJob(G.id, companyIds[1]);
  const att = (await claimAttempt(jG1, G.id, companyIds[0]))!;
  await storage.cancelBatchRun(G.id, "admin cancel (test)");
  check("claim refused on cancelled batch", (await storage.claimJob(jG2)) === null);
  check("in-flight attempt score write fenced", (await runWithDiagContext(att.ctx, () => storage.replaceMeasureScoresFenced(att.own, companyIds[0], fwId, scoreRows(companyIds[0], 1, "G")))) === false);
  check("completeJob refused", (await storage.completeJob(jG1, att.own)).transitioned === false);
  check("owner can release claim (failJob)", (await storage.failJob(jG1, "Cancelled", att.own)).transitioned === true);
  check("completeBatchRun refused", (await storage.completeBatchRun(G.id)) === false);
  check("status remains cancelled", (await batchStatus(G.id)) === "cancelled");
  // pending_review -> completed (operator discard & finalise) is still allowed.
  const H = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  await storage.setBatchRunStatus(H.id, "pending_review");
  check("pending_review -> completed still allowed", (await storage.completeBatchRun(H.id)) === true);
}

async function main() {
  await fixtures();
  await s1Supersession();
  await s2DbWaitCancel();
  await s3LateWrite();
  await s4StaleAttempt();
  await s5AdminCancel();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
