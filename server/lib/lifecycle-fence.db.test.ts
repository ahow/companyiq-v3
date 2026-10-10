/**
 * DB-backed lifecycle / ownership fencing tests against a REAL local Postgres
 * (+ Redis for the supersession notification path). Never run against prod.
 *
 * Run (self-configuring — no PG_POOL_MAX or other knobs needed):
 *   DATABASE_URL=postgresql://ciqtest:ciqtest@localhost:5432/ciqtest \
 *   REDIS_URL=redis://localhost:6390 \
 *   npx tsx server/lib/lifecycle-fence.db.test.ts
 *
 * Scenarios that need a specific pool shape create their OWN pg.Pool (e.g.
 * max=1) and pass it to the real storage.replaceMeasureScoresFenced via its
 * `fenceDb` seam; the app's module pool keeps whatever PG_POOL_MAX the env
 * gives it (default 20) and is never assumed to be 1.
 *
 * EVERY scenario asserts the FINAL analysis_jobs.status/attempts AND
 * batch_runs.status (plus counters where relevant).
 *
 * Scenarios:
 *   S1 supersession == cancellation, via the REAL supersession entry point
 *      storage.createBatchRun -> notifySupersededBatches (real Redis + BullMQ)
 *   S2 cancel while queued for a DB connection (self-configured pool max=1)
 *   S3 late write after attempt deadline, before a retry claims the job
 *   S4 stale attempt #1 resumes after attempt #2 owns the job
 *   S5 admin cancel: claim/complete/status/finalize refused
 *   S6 REAL pipeline timeout (runAnalysisPipeline + withTimeout) revokes the
 *      attempt; a late synthetic LLM/pipeline response is refused; job/batch
 *      end failed/timeout, never completed
 *   S7 shared lock order, both orderings, deterministic (two connections,
 *      explicit statement ordering, pg_stat_activity lock-wait observation):
 *      (A) cancel commits before the fenced SELECT -> write refused
 *      (A') cancel UPDATE holds b; fenced SELECT blocks, re-evaluates -> refused
 *      (B) fenced write holds FOR SHARE OF b; cancel UPDATE blocks until the
 *          write commits -> write lands, then cancel applies; later stale write refused
 */
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../shared/schema.js";
import { db } from "../db.js";
import * as storage from "../storage.js";
import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import {
  createAttemptLifecycle, ownershipFromContext, revokeAttempt, dispatchRevokedReason, runFencedWrite,
  type AttemptOwnership,
} from "./lifecycle-fence.js";
import { isBatchCancelledCached } from "../cancellation.js";
import { redis } from "../redis.js";
import { finalizeBatchAndSave } from "../worker.js";
import { runAnalysisPipeline } from "./pipeline.js";
import { __reloadFaultConfigForTests } from "./fault-inject.js";

process.exitCode = 1; // premature exit must not look like success

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Bounded state poll (NOT a sleep-and-hope): resolves true as soon as cond() holds. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 5): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return true; await sleep(stepMs); }
  return !!(await cond());
}
/** True once a backend matching `where` is blocked on a heavyweight lock. */
function lockWaitObserved(obs: pg.Client, where: string) {
  return waitFor(async () => (await obs.query(
    `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${where}`,
  )).rows[0].n > 0);
}
const newClient = async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; };

let wsId = 0, fwId = 0;
const companyIds: number[] = [];

async function fixtures() {
  const tag = `lf${Date.now()}`;
  const [u] = await q(`INSERT INTO users (email, password_hash, name) VALUES ('${tag}@t.local','x','t') RETURNING id`);
  const [w] = await q(`INSERT INTO workspaces (name, slug, owner_id) VALUES ('${tag}','${tag}',${u.id}) RETURNING id`);
  wsId = w.id;
  const [f] = await q(`INSERT INTO frameworks (workspace_id, name) VALUES (${wsId},'fw-${tag}') RETURNING id`);
  fwId = f.id;
  for (let i = 0; i < 12; i++) {
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
const batchRow = async (id: number) => (await q(`SELECT status, completed_jobs, failed_jobs FROM batch_runs WHERE id=${id}`))[0];
const jobRow = async (id: number) => (await q(`SELECT status, attempts, last_error FROM analysis_jobs WHERE id=${id}`))[0];

/** POINT 3: every scenario ends by asserting the final job AND batch state. */
async function assertFinal(label: string, jobs: Array<[number, string, number]>, batches: Array<[number, string, { completed?: number; failed?: number }?]>) {
  for (const [id, status, attempts] of jobs) {
    const r = await jobRow(id);
    check(`${label} FINAL job ${id}: status=${status} attempts=${attempts}`, r?.status === status && Number(r?.attempts) === attempts, r);
  }
  for (const [id, status, counters] of batches) {
    const r = await batchRow(id);
    const okCounters = !counters
      || ((counters.completed === undefined || Number(r?.completed_jobs) === counters.completed)
        && (counters.failed === undefined || Number(r?.failed_jobs) === counters.failed));
    check(`${label} FINAL batch ${id}: status=${status}${counters ? ` ${JSON.stringify(counters)}` : ""}`, r?.status === status && okCounters, r);
  }
}

async function s1Supersession() {
  console.log("── S1 supersession == cancellation — REAL entry point storage.createBatchRun -> notifySupersededBatches (real Redis/BullMQ) ──");
  // Unit-level spy on notifySupersededBatches' contract (per-id, non-fatal).
  const marked: number[] = [], removed: number[] = [];
  await storage.notifySupersededBatches([11, 12], { markBatchCancelled: async (id) => { marked.push(id); }, removeBatchJobs: async (id) => { removed.push(id); } });
  check("[spy] notifySupersededBatches calls mark + remove for every id", JSON.stringify(marked) === "[11,12]" && JSON.stringify(removed) === "[11,12]");
  let threw = false;
  try { await storage.notifySupersededBatches([13], { markBatchCancelled: async () => { throw new Error("redis down"); }, removeBatchJobs: async () => { throw new Error("bull down"); } }); } catch { threw = true; }
  check("[spy] notify failures are non-fatal (PG guard remains authoritative)", !threw);

  const A = (await storage.createBatchRun(wsId, fwId, 2)) as any;
  const jA = await newJob(A.id, companyIds[0]);
  const jA2 = await newJob(A.id, companyIds[1]);
  const att = await claimAttempt(jA, A.id, companyIds[0]);
  check("old batch A: attempt claimed while running", !!att);

  // REAL supersession entry point (no mocks): createBatchRun's supersede UPDATE
  // followed by notifySupersededBatches with the real Redis flag + BullMQ purge.
  const B = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  check("[real createBatchRun] A is cancelled in PG after supersession", (await batchStatus(A.id)) === "cancelled");
  check("[real createBatchRun] B is running", (await batchStatus(B.id)) === "running");
  check("[real notifySupersededBatches] A Redis cancel flag set (durable notification)", (await redis.exists(`cancelled:batch:${A.id}`)) === 1);
  check("[real notifySupersededBatches] A in-process cancel cache set", isBatchCancelledCached(A.id));
  check("A attempt: dispatch gate now refuses (work stops)", dispatchRevokedReason(att!.ctx) === "batch_cancelled");

  const wrote = await runWithDiagContext(att!.ctx, () => storage.replaceMeasureScoresFenced(att!.own, companyIds[0], fwId, scoreRows(companyIds[0], 3, "A")));
  check("A attempt: score write fenced", wrote === false);
  check("A attempt: zero score rows", (await scoresFor(companyIds[0])).length === 0);
  const cj = await storage.completeJob(jA, att!.own);
  check("A attempt: completeJob refused (0 rows)", cj.transitioned === false);
  // Worker "Cancelled" branch: owner records failure; batch not running -> 'failed', batchTerminal, no requeue.
  const fA = await storage.failJob(jA, "Cancelled (batch cancelled)", att!.own);
  check("A attempt: failJob records failure as batchTerminal (no requeue)", fA.transitioned && fA.batchTerminal && fA.finalFailed, fA);
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
  check("B: completeBatchRun transitions running -> completed", (await storage.completeBatchRun(B.id)) === true);
  await assertFinal("S1", [[jA, "failed", 1], [jA2, "pending", 0], [jB, "completed", 1]],
    [[A.id, "cancelled", { completed: 0, failed: 0 }], [B.id, "completed"]]);
}

async function s2DbWaitCancel() {
  console.log("── S2 cancel while queued for a DB connection (SELF-CONFIGURED pool max=1) ──");
  // Self-configuring: own pool + drizzle instance, passed to the REAL
  // replaceMeasureScoresFenced via its fenceDb seam. Independent of PG_POOL_MAX.
  const ownPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const ownDb = drizzle(ownPool);
  check("self-configured fence pool: max=1 (independent of PG_POOL_MAX)", (ownPool as any).options.max === 1);
  const C = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jC = await newJob(C.id, companyIds[2]);
  const att = (await claimAttempt(jC, C.id, companyIds[2]))!;
  const ext = await newClient();

  const hold = await ownPool.connect(); // occupy the only connection of the fence pool
  const p = runWithDiagContext(att.ctx, () => storage.replaceMeasureScoresFenced(att.own, companyIds[2], fwId, scoreRows(companyIds[2], 4, "C"), ownDb));
  check("score write is queued waiting for a connection (ownPool.waitingCount>=1)", await waitFor(() => ownPool.waitingCount >= 1), ownPool.waitingCount);
  await storage.cancelBatchRun(C.id, "S2 admin cancel while queued"); // real cancel lands (PG only) while queued
  hold.release();
  const res = await p;
  check("queued write refused after cancel (atomic PG guard)", res === false);
  check("zero score rows persisted", (await scoresFor(companyIds[2])).length === 0);
  check("no pool leak: waitingCount=0", await waitFor(() => ownPool.waitingCount === 0), ownPool.waitingCount);
  check("no pool leak: all clients idle", await waitFor(() => ownPool.totalCount === ownPool.idleCount), { total: ownPool.totalCount, idle: ownPool.idleCount });
  const r = await ext.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'`);
  check("no connection left idle-in-transaction", r.rows[0].n === 0, r.rows[0].n);
  const fC = await storage.failJob(jC, "Cancelled (batch cancelled)", att.own);
  check("C: owner releases claim; batchTerminal, no requeue", fC.transitioned && fC.batchTerminal, fC);

  // Variant: pipeline-timeout revoke while queued (batch still running, SQL deadline not elapsed).
  const D = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jD = await newJob(D.id, companyIds[3]);
  const attD = (await claimAttempt(jD, D.id, companyIds[3]))!;
  const hold2 = await ownPool.connect();
  const p2 = runWithDiagContext(attD.ctx, () => storage.replaceMeasureScoresFenced(attD.own, companyIds[3], fwId, scoreRows(companyIds[3], 2, "D"), ownDb));
  check("D: write queued on fence pool", await waitFor(() => ownPool.waitingCount >= 1), ownPool.waitingCount);
  revokeAttempt(attD.ctx.lifecycle, "pipeline_timeout");
  hold2.release();
  check("revoked-while-queued write refused post-acquire", (await p2) === false && (await scoresFor(companyIds[3])).length === 0);
  // Owner may still release its own claim after a timeout (rule iii, not deadline/batch gated).
  const fD = await storage.failJob(jD, "Job watchdog timeout", attD.own);
  check("revoked owner can still release its claim (failJob -> pending, retry allowed)", fD.transitioned === true && !fD.batchTerminal && !fD.finalFailed, fD);
  await ext.end();
  await ownPool.end();
  await assertFinal("S2", [[jC, "failed", 1], [jD, "pending", 1]],
    [[C.id, "cancelled", { completed: 0, failed: 0 }], [D.id, "running", { completed: 0, failed: 0 }]]);
}

async function s3LateWrite() {
  console.log("── S3 late write after deadline, before retry claims ──");
  const E = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  const jE = await newJob(E.id, companyIds[4]);
  const att = (await claimAttempt(jE, E.id, companyIds[4], 300))!; // 300ms attempt deadline
  await waitFor(() => Date.now() > att.own.deadlineAt!.getTime() + 100, 2000); // response arrives after the deadline
  const before = await jobRow(jE);
  check("job still claimed by attempt 1 (retry has not claimed)", before.status === "claimed" && before.attempts === 1, before);
  // Bypass the in-process deadline pre-check to prove the SQL deadline guard itself refuses.
  const lcNoDeadline = { ...att.ctx.lifecycle!, deadlineAt: null };
  const wrote = await runWithDiagContext({ ...att.ctx, lifecycle: lcNoDeadline }, () => storage.replaceMeasureScoresFenced(att.own, companyIds[4], fwId, scoreRows(companyIds[4], 3, "E")));
  check("late score write refused by SQL deadline guard", wrote === false);
  check("zero score rows", (await scoresFor(companyIds[4])).length === 0);
  check("late completeJob refused", (await storage.completeJob(jE, att.own)).transitioned === false);
  // Watchdog/timeout path then records the failure (owner-only rule) -> retry allowed.
  const fE = await storage.failJob(jE, "Job watchdog timeout", att.own);
  check("timeout failure recorded by owner after deadline (-> pending for retry)", fE.transitioned && !fE.finalFailed && !fE.batchTerminal, fE);
  await assertFinal("S3", [[jE, "pending", 1]], [[E.id, "running", { completed: 0, failed: 0 }]]);
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
  await assertFinal("S4", [[jF, "completed", 2]], [[F.id, "running", { failed: 0 }]]);
}

async function s5AdminCancel() {
  console.log("── S5 admin cancel ──");
  const G = (await storage.createBatchRun(wsId, fwId, 2)) as any;
  const jG1 = await newJob(G.id, companyIds[0]);
  const jG2 = await newJob(G.id, companyIds[1]);
  const att = (await claimAttempt(jG1, G.id, companyIds[0]))!;
  await storage.cancelBatchRun(G.id, "admin cancel (test)");
  await storage.cancelBatchRun(G.id, "admin cancel (repeat)"); // idempotent: 0 rows, no rewrite
  check("claim refused on cancelled batch", (await storage.claimJob(jG2)) === null);
  check("in-flight attempt score write fenced", (await runWithDiagContext(att.ctx, () => storage.replaceMeasureScoresFenced(att.own, companyIds[0], fwId, scoreRows(companyIds[0], 1, "G")))) === false);
  check("completeJob refused", (await storage.completeJob(jG1, att.own)).transitioned === false);
  const fG = await storage.failJob(jG1, "Cancelled", att.own);
  check("owner can release claim (failJob) -> failed, batchTerminal, not requeued", fG.transitioned && fG.batchTerminal && fG.finalFailed, fG);
  check("completeBatchRun refused", (await storage.completeBatchRun(G.id)) === false);
  check("repeat cancel kept original reason (idempotent)", (await q(`SELECT rejection_reason FROM batch_runs WHERE id=${G.id}`))[0]?.rejection_reason === "admin cancel (test)");
  // pending_review -> completed (operator discard & finalise) is still allowed.
  const H = (await storage.createBatchRun(wsId, fwId, 1)) as any;
  await storage.setBatchRunStatus(H.id, "pending_review");
  check("pending_review -> completed still allowed", (await storage.completeBatchRun(H.id)) === true);
  await assertFinal("S5", [[jG1, "failed", 1], [jG2, "pending", 0]],
    [[G.id, "cancelled", { completed: 0, failed: 0 }], [H.id, "completed"]]);
}

async function s6PipelineTimeoutLateResponse() {
  console.log("── S6 REAL pipeline timeout revokes attempt; late synthetic LLM/pipeline response refused ──");
  const B6 = (await storage.createBatchRun(wsId, fwId, 2)) as any;
  const cid = companyIds[6];
  const j = await newJob(B6.id, cid);
  const jOther = await newJob(B6.id, companyIds[7]); // keeps the batch open (not finalised)
  await q(`UPDATE analysis_jobs SET attempts=2 WHERE id=${j}`); // attempts 1-2 used; this claim is the final attempt
  const att = (await claimAttempt(j, B6.id, cid))!;
  check("S6: final attempt (3) claimed", att.own.attemptNumber === 3);

  // TEST-ONLY fault: shorten the REAL PIPELINE_TIMEOUT_MS for this batch+job only.
  __reloadFaultConfigForTests({ DIAG_FAULT_INJECT: JSON.stringify({ mode: "pipeline_timeout", ms: 300 }), DIAG_FAULT_BATCH: String(B6.id), DIAG_FAULT_JOB: String(j) });
  // Hold the company row so the pipeline body's first DB write blocks: the body
  // deterministically cannot finish before the 300ms pipeline timeout.
  const blocker = await newClient();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [cid]);
  const company = await storage.getCompanyById(cid, wsId);
  const framework = await storage.getFrameworkById(fwId, wsId);
  const run = runWithDiagContext(att.ctx, () => runAnalysisPipeline({
    company: company as any, framework: framework as any, measures: [], workspaceId: wsId, batchId: B6.id, skipFetch: true, attemptId: att.ctx.attemptId,
  }));
  const revoked = await waitFor(() => att.ctx.lifecycle!.revoked, 10_000);
  check("S6: real pipeline timeout revoked the attempt (withTimeout timer callback)", revoked && att.ctx.lifecycle!.revokedReason === "pipeline_timeout", att.ctx.lifecycle!.revokedReason);
  const atRevoke = await jobRow(j);
  check("S6: revoke happened BEFORE failJob/any retry (job still claimed by attempt 3)", atRevoke.status === "claimed" && atRevoke.attempts === 3, atRevoke);

  // Late synthetic LLM/pipeline response arrives after the timeout: the
  // orphaned body would persist its ~36 measure rows via the real fenced write.
  const late1 = await runWithDiagContext(att.ctx, () => storage.replaceMeasureScoresFenced(att.own, cid, fwId, scoreRows(cid, 36, "late")));
  check("S6: late score write REFUSED after pipeline-timeout revoke", late1 === false);
  check("S6: zero score rows", (await scoresFor(cid)).length === 0);

  await blocker.query("COMMIT");
  await blocker.end();
  const result: any = await run;
  check("S6: pipeline returned timeout failure", result?.success === false && result?.failureType === "timeout" && /timed out/.test(String(result?.error)), result);

  // Worker result-failure path: failJob(ownership); final failure -> incrementBatchFailed.
  const f = await storage.failJob(j, result.error, att.own);
  check("S6: failJob records final timeout failure (not batchTerminal)", f.transitioned && f.finalFailed && !f.batchTerminal, f);
  if (f.transitioned && f.finalFailed && !f.batchTerminal) await storage.incrementBatchFailed(B6.id);

  // A second late response even WITHOUT the in-process revoke flag (fresh
  // lifecycle, no deadline): the SQL ownership guard alone refuses it.
  const freshLc = createAttemptLifecycle({ jobId: j, batchId: B6.id, attemptNumber: 3, deadlineAt: null });
  const late2 = await runWithDiagContext({ ...att.ctx, lifecycle: freshLc }, () => storage.replaceMeasureScoresFenced(att.own, cid, fwId, scoreRows(cid, 36, "late2")));
  check("S6: late write refused by SQL ownership guard alone (job no longer claimed)", late2 === false && (await scoresFor(cid)).length === 0);
  check("S6: late completeJob refused", (await storage.completeJob(j, att.own)).transitioned === false);
  __reloadFaultConfigForTests({});
  const jr = await jobRow(j);
  check("S6: job last_error records the pipeline timeout", /timed out/.test(String(jr?.last_error)), jr?.last_error);
  await assertFinal("S6", [[j, "failed", 3], [jOther, "pending", 0]], [[B6.id, "running", { completed: 0, failed: 1 }]]);
  check("S6: batch NOT completed", (await batchStatus(B6.id)) !== "completed");
}

async function s7LockOrder() {
  console.log("── S7 shared lock order: both orderings, deterministic (two connections + pg_stat_activity) ──");
  const fencePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const fenceDb = drizzle(fencePool);
  const fencePid = Number((await fencePool.query("SELECT pg_backend_pid() AS p")).rows[0].p);
  const obs = await newClient(); // observer only (reads pg_stat_activity / committed state)
  // Fenced writes below run OUTSIDE any diag context, so the in-process revoke
  // fast path is not consulted: only the SQL lock + predicate decide.

  // (A) cancel COMMITS before the fenced write's SELECT.
  {
    const A7 = (await storage.createBatchRun(wsId, fwId, 1)) as any; const cid = companyIds[8];
    const jA = await newJob(A7.id, cid); const att = (await claimAttempt(jA, A7.id, cid))!;
    await storage.cancelBatchRun(A7.id, "S7A cancel commits first"); // connection 1 (module pool), committed
    check("(A) cancel committed (observer sees cancelled)", (await obs.query("SELECT status FROM batch_runs WHERE id=$1", [A7.id])).rows[0].status === "cancelled");
    const w = await storage.replaceMeasureScoresFenced(att.own, cid, fwId, scoreRows(cid, 36, "S7A"), fenceDb); // connection 2
    check("(A) fenced write refused", w === false);
    check("(A) no scores", (await scoresFor(cid)).length === 0);
    check("(A) completeJob refused", (await storage.completeJob(jA, att.own)).transitioned === false);
    const f = await storage.failJob(jA, "Cancelled (batch cancelled)", att.own);
    check("(A) failJob -> failed, batchTerminal", f.transitioned && f.batchTerminal, f);
    await assertFinal("S7(A)", [[jA, "failed", 1]], [[A7.id, "cancelled", { completed: 0, failed: 0 }]]);
  }

  // (A') cancel UPDATE holds the batch row lock (uncommitted); the fenced
  // SELECT … FOR SHARE OF b blocks on it, then re-evaluates after COMMIT.
  {
    const A8 = (await storage.createBatchRun(wsId, fwId, 1)) as any; const cid = companyIds[9];
    const jA = await newJob(A8.id, cid); const att = (await claimAttempt(jA, A8.id, cid))!;
    const canceller = await newClient();
    await canceller.query("BEGIN");
    await canceller.query("UPDATE batch_runs SET status='cancelled', completed_at=NOW() WHERE id=$1 AND status <> 'cancelled'", [A8.id]);
    const pw = storage.replaceMeasureScoresFenced(att.own, cid, fwId, scoreRows(cid, 36, "S7A2"), fenceDb);
    check("(A') fenced SELECT observed blocked on the batch row lock", await lockWaitObserved(obs, `pid = ${fencePid}`));
    await canceller.query("COMMIT");
    await canceller.end();
    check("(A') fenced write refused after re-evaluation (EvalPlanQual)", (await pw) === false);
    check("(A') no scores", (await scoresFor(cid)).length === 0);
    check("(A') completeJob refused", (await storage.completeJob(jA, att.own)).transitioned === false);
    const f = await storage.failJob(jA, "Cancelled (batch cancelled)", att.own);
    check("(A') failJob -> failed, batchTerminal", f.transitioned && f.batchTerminal, f);
    await assertFinal("S7(A')", [[jA, "failed", 1]], [[A8.id, "cancelled", { completed: 0, failed: 0 }]]);
  }

  // (B) fenced write holds FOR UPDATE OF j FOR SHARE OF b; the real
  // cancelBatchRun UPDATE blocks until the write commits, then applies.
  {
    const B7 = (await storage.createBatchRun(wsId, fwId, 1)) as any; const cid = companyIds[10];
    const jB = await newJob(B7.id, cid); const att = (await claimAttempt(jB, B7.id, cid))!;
    let cancelP: Promise<void> | null = null;
    let cancelBlocked = false, runningWhileHeld = false;
    const wrote = await runFencedWrite(fenceDb, att.own, async (tx) => {
      // Canonical lock is held here (connection 2). Issue the real cancel (connection 1).
      cancelP = storage.cancelBatchRun(B7.id, "S7B concurrent cancel");
      cancelBlocked = await lockWaitObserved(obs, `pid <> ${fencePid} AND query ILIKE 'update "batch_runs"%'`);
      runningWhileHeld = (await obs.query("SELECT status FROM batch_runs WHERE id=$1", [B7.id])).rows[0].status === "running";
      // Same framework-scoped replacement as replaceMeasureScoresFenced (delete + ~36-row insert).
      await tx.execute(sql`DELETE FROM measure_scores WHERE company_id = ${cid} AND framework_id = ${fwId}`);
      await tx.insert(schema.measureScores).values(scoreRows(cid, 36, "S7B"));
    });
    check("(B) cancel UPDATE observed BLOCKED while the fenced write held FOR SHARE OF b", cancelBlocked);
    check("(B) batch still running while the write held its lock", runningWhileHeld);
    check("(B) fenced write succeeded (linearised before the cancel)", wrote === true);
    await cancelP;
    check("(B) cancel applied after the write committed", (await batchStatus(B7.id)) === "cancelled");
    check("(B) the pre-cancel write's 36 rows are intact", (await scoresFor(cid)).length === 36);
    // No later stale write lands.
    const stale = await storage.replaceMeasureScoresFenced(att.own, cid, fwId, scoreRows(cid, 5, "S7B-stale"), fenceDb);
    const rows = await scoresFor(cid);
    check("(B) later stale write refused; scores unchanged", stale === false && rows.length === 36 && rows.every((r) => String(r.measure_id).startsWith("S7B-") && !String(r.measure_id).startsWith("S7B-stale")), rows.length);
    check("(B) completeJob after cancel refused", (await storage.completeJob(jB, att.own)).transitioned === false);
    const f = await storage.failJob(jB, "Cancelled (batch cancelled)", att.own);
    check("(B) failJob -> failed, batchTerminal (no requeue)", f.transitioned && f.batchTerminal, f);
    await assertFinal("S7(B)", [[jB, "failed", 1]], [[B7.id, "cancelled", { completed: 0, failed: 0 }]]);
  }
  await obs.end();
  await fencePool.end();
}

async function main() {
  await fixtures();
  await s1Supersession();
  await s2DbWaitCancel();
  await s3LateWrite();
  await s4StaleAttempt();
  await s5AdminCancel();
  await s6PipelineTimeoutLateResponse();
  await s7LockOrder();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
