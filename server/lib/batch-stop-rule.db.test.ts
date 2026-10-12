/**
 * Batch stop rule S4 against a REAL, DISPOSABLE local Postgres (+ local Redis).
 * Never run against production or the org-shared hosted DB: the target must be
 * a loopback host, and the test runs inside a throwaway database cloned from it
 * (CREATE DATABASE stoprule_<ts> TEMPLATE <base>) that is DROPPED at the end.
 *
 * Run (docker ciq-int-pg / ciq-int-redis, schema already pushed into `ciq`):
 *   STOP_RULE_TEST_PG=postgres://ciq:ciq@127.0.0.1:55432/ciq REDIS_URL=redis://127.0.0.1:56379 \
 *     npx tsx server/lib/batch-stop-rule.db.test.ts
 *
 * Exercises, with the real worker wiring (worker.stopRuleTripped):
 *   1. COUNT_BATCH_FAILURES_SQL on real analysis_jobs rows written by the real storage.failJob
 *   2. the real cancel path: cancelBatch flag (Redis) → storage.cancelBatchRun (PG) →
 *      queue.removeBatchJobs (BullMQ) → saveStopRuleSnapshot
 *   3. two failure paths racing: batch durably cancelled once, exactly one snapshot,
 *      marked rejected "cancelled/partial", never accepted; no retry enqueued; the
 *      PG claim fence refuses the failed jobs afterwards
 */
import pg from "pg";

process.exitCode = 1; // premature exit must not look like success
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

const BASE = process.env.STOP_RULE_TEST_PG;
if (!BASE) { console.log("SKIP: STOP_RULE_TEST_PG not set"); process.exit(0); }
const baseUrl = new URL(BASE);
if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname) || /companyiq/i.test(baseUrl.pathname)) {
  console.error(`REFUSING: ${baseUrl.hostname}${baseUrl.pathname} is not a disposable loopback test database`);
  process.exit(2);
}
const throwaway = `stoprule_${Date.now()}`;
const testUrl = new URL(BASE); testUrl.pathname = `/${throwaway}`;
const admin = () => { const u = new URL(BASE); u.pathname = "/postgres"; return new pg.Client({ connectionString: u.toString() }); };

async function main() {
  const a = admin(); await a.connect();
  await a.query(`CREATE DATABASE ${throwaway} TEMPLATE ${baseUrl.pathname.slice(1)}`);
  await a.end();
  console.log(`[STOP-RULE-DB] throwaway database ${throwaway} created (template ${baseUrl.pathname.slice(1)} on ${baseUrl.host})`);
  Object.assign(process.env, { DATABASE_URL: testUrl.toString(), BATCH_STOP_RULE_FAILED_JOBS: "2" });

  const logs: string[] = [];
  const origWarn = console.warn; const origLog = console.log;
  const tap = (orig: (...x: any[]) => void) => (...x: any[]) => { logs.push(x.map(String).join(" ")); orig(...x); };
  console.warn = tap(origWarn); console.log = tap(origLog);

  const c = new pg.Client({ connectionString: testUrl.toString() }); await c.connect();
  let teardown = async () => {};
  try {
    const storage = await import("../storage.js");
    const { addBatchJobs, getQueue } = await import("../queue.js");
    const { stopRuleTripped } = await import("../worker.js");
    const { pool } = await import("../db.js");
    const { redis } = await import("../redis.js");
    const { COUNT_BATCH_FAILURES_SQL } = await import("./batch-stop-rule.js");
    let batchIdForCleanup = 0;
    teardown = async () => {
      // The throwaway DB reuses the template's id sequences, so leaving the Redis
      // cancel flag behind would cancel an unrelated later batch with the same id
      // on this local Redis (observed once: it cancelled the next integration run).
      if (batchIdForCleanup) await redis.del(`cancelled:batch:${batchIdForCleanup}`).catch(() => {});
      await getQueue().close().catch(() => {}); await pool.end().catch(() => {}); redis.disconnect();
    };

    // ─── Seed: 1 completed company (scored) + 3 jobs that fail ──────────────
    const tag = `stoprule-${Date.now()}`;
    const u = (await c.query("insert into users(email,password_hash,name) values($1,'x','t') returning id", [`${tag}@test.local`])).rows[0].id;
    const ws = (await c.query("insert into workspaces(name,slug,owner_id) values($1,$1,$2) returning id", [tag, u])).rows[0].id;
    const fw = (await c.query("insert into frameworks(workspace_id,name,is_active) values($1,$2,true) returning id", [ws, `${tag}-fw`])).rows[0].id;
    await c.query(`insert into framework_measures(framework_id,measure_id,category,category_number,title,definition,scoring_guidance,evidence_keywords,display_order)
      values($1,'M1','Environment',1,'Climate targets','Discloses climate targets.','Yes if disclosed.','["climate"]',0)`, [fw]);
    const cos: number[] = [];
    for (const n of ["Done", "FailA", "FailB", "FailC"]) cos.push((await c.query("insert into companies(workspace_id,name) values($1,$2) returning id", [ws, `${tag} ${n}`])).rows[0].id);
    await c.query(`insert into measure_scores(company_id,framework_id,measure_id,category,category_number,title,score,confidence,verdict)
      values($1,$2,'M1','Environment',1,'Climate targets',1,'High','Yes')`, [cos[0], fw]);
    const batch: any = await storage.createBatchRun(ws, fw, cos.length);
    const jobs: any[] = await storage.createAnalysisJobs(cos.map((co, i) => ({ workspaceId: ws, batchId: batch.id, companyId: co, companyName: `${tag} ${i}`, frameworkId: fw })));
    const [done, jA, jB, jC] = jobs;
    batchIdForCleanup = batch.id;
    await c.query("update analysis_jobs set status='completed', attempts=1, completed_at=now() where id=$1", [done.id]);
    await c.query("update analysis_jobs set attempts=1 where id = any($1)", [[jA.id, jB.id, jC.id]]);
    await c.query("update companies set analysis_status='completed' where id=$1", [cos[0]]).catch(() => {});
    // jC stays queued in BullMQ (never started) so the real purge has work.
    await addBatchJobs([{ jobId: jC.id, companyId: cos[3], frameworkId: fw, batchId: batch.id, workspaceId: ws, skipFetch: true, skipDiscovery: true }] as any, ws, batch.id);
    const queuedBefore = (await getQueue().getJobs(["waiting", "prioritized", "delayed"])).filter((j) => j?.data?.batchId === batch.id).length;
    console.log(`[STOP-RULE-DB] seeded ws=${ws} fw=${fw} batch=${batch.id} jobs=${jobs.map((j) => j.id).join(",")} queued=${queuedBefore}`);

    // ─── 1. COUNT_BATCH_FAILURES_SQL on rows written by the real failJob ────
    const ERR = "Isolated job child exited unexpectedly (code=null signal=SIGABRT stage=spawn)";
    await storage.failJob(jA.id, ERR);
    const c1 = (await c.query(COUNT_BATCH_FAILURES_SQL, [batch.id])).rows[0];
    check("SQL: one failed attempt counted, none exhausted", c1.failed_attempt_jobs === 1 && c1.retry_exhausted_jobs === 0, c1);
    const belowStopped = await stopRuleTripped(batch.id, jA.id, ERR, fw, ws);
    check("below threshold (1/2): not stopped, legacy retry path stays in charge", belowStopped === false);
    check("below threshold: batch still running", (await c.query("select status from batch_runs where id=$1", [batch.id])).rows[0].status === "running");

    // ─── 2+3. Two failure paths race to the threshold ───────────────────────
    await Promise.all([storage.failJob(jB.id, ERR), storage.failJob(jC.id, ERR)]);
    const c2 = (await c.query(COUNT_BATCH_FAILURES_SQL, [batch.id])).rows[0];
    check("SQL: three failed-attempt jobs counted (cancel/provider_paused excluded by construction)", c2.failed_attempt_jobs === 3 && c2.retry_exhausted_jobs === 0, c2);
    let retriesEnqueued = 0;
    const onFailure = async (jobId: number) => { const stopped = await stopRuleTripped(batch.id, jobId, ERR, fw, ws); if (!stopped) retriesEnqueued++; return stopped; };
    const t0 = Date.now();
    const [sB, sC] = await Promise.all([onFailure(jB.id), onFailure(jC.id)]);
    const raceMs = Date.now() - t0;
    check("race: both failure paths report stopped (each suppresses its retry)", sB === true && sC === true, { sB, sC });
    check("race: zero retries enqueued", retriesEnqueued === 0, retriesEnqueued);

    const br = (await c.query("select status, acceptance_state, rejection_reason, terminal_at from batch_runs where id=$1", [batch.id])).rows[0];
    check("durable: batch_runs.status = cancelled, acceptance rejected", br.status === "cancelled" && br.acceptance_state === "rejected" && br.terminal_at != null, br);
    const transitions = logs.filter((l) => l.includes(`cancelBatchRun batch=${batch.id} transitioned=true`)).length;
    const noops = logs.filter((l) => l.includes(`cancelBatchRun batch=${batch.id} transitioned=false`)).length;
    check("durable: exactly one PG transition, the racing cancel was the idempotent no-op", transitions === 1 && noops === 1, { transitions, noops });
    check("race: losing path logged 'snapshot left to that path'", logs.some((l) => l.includes(`batch=${batch.id} already cancelled by another path`)));

    const snaps = (await c.query("select id, acceptance_state, rejection_reason, companies_count from analysis_results where batch_id=$1", [batch.id])).rows;
    check("snapshot: exactly one row for the batch (no duplicate)", snaps.length === 1, snaps);
    check("snapshot: holds only the completed company", snaps[0]?.companies_count === 1, snaps[0]);
    check("snapshot: marked rejected 'cancelled/partial … not comprehensive', never accepted",
      snaps.length === 1 && snaps[0].acceptance_state === "rejected" && /cancelled\/partial snapshot .*not comprehensive/.test(snaps[0].rejection_reason ?? ""), snaps[0]);

    const queuedAfter = (await getQueue().getJobs(["waiting", "prioritized", "delayed"])).filter((j) => j?.data?.batchId === batch.id).length;
    check("purge: queued BullMQ job for the batch removed", queuedBefore === 1 && queuedAfter === 0, { queuedBefore, queuedAfter });
    const flag = await redis.get(`cancelled:batch:${batch.id}`).catch(() => null); // cancellation.ts KEY_PREFIX
    check("flag: Redis cross-replica cancel notification set", flag === "1", flag);

    const jobRows = (await c.query("select id, status, attempts from analysis_jobs where batch_id=$1 order by id", [batch.id])).rows;
    const claims = await Promise.all([jA.id, jB.id, jC.id].map((id) => storage.claimJob(id)));
    check("fence: no failed job can be re-claimed (no uncontrolled retry)", claims.every((r) => r == null), claims.map((r) => r?.id ?? null));
    const jobRows2 = (await c.query("select id, status, attempts from analysis_jobs where batch_id=$1 order by id", [batch.id])).rows;
    check("fence: attempts unchanged by refused claims", JSON.stringify(jobRows) === JSON.stringify(jobRows2), { jobRows, jobRows2 });

    // A third, late failure path after the cancel: still suppressed, still one snapshot.
    const late = await onFailure(jA.id);
    const snaps2 = (await c.query("select count(*)::int n from analysis_results where batch_id=$1", [batch.id])).rows[0].n;
    check("late failure after cancel: stopped, still exactly one snapshot, still zero retries", late === true && snaps2 === 1 && retriesEnqueued === 0, { late, snaps2, retriesEnqueued });
    console.log(`[STOP-RULE-DB] race completed in ${raceMs}ms; final jobs=${JSON.stringify(jobRows2)}`);
  } finally {
    console.warn = origWarn; console.log = origLog;
    await c.end().catch(() => {});
    await teardown();
    const d = admin(); await d.connect();
    await d.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [throwaway]);
    await d.query(`DROP DATABASE IF EXISTS ${throwaway}`);
    const left = (await d.query("select count(*)::int n from pg_database where datname=$1", [throwaway])).rows[0].n;
    await d.end();
    console.log(`[STOP-RULE-DB] teardown: DROP DATABASE ${throwaway} → remaining=${left}; Redis cancel flag removed`);
  }
}

main().then(() => {
  console.log(`\nbatch-stop-rule.db: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode as number), 200).unref();
}, (e) => { console.error("FATAL", e); process.exit(1); });
