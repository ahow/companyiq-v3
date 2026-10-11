/**
 * Worker isolation supervisor tests (DESIGN.md §10 items 1–7). Deterministic, no network.
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/job-isolation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

Object.assign(process.env, {
  WORKER_ISOLATION_ENABLED: "true", WORKER_CONCURRENCY: "4", PG_POOL_MAX: "20", LLM_MAX_CONCURRENCY: "8", MAX_CONCURRENT_BROWSER: "1",
  WORKER_ISOLATION_KILL_GRACE_MS: "1000", LLM_USAGE_LOGGING_ENABLED: "true", SCORING_STRICT_PROVIDER: "true", SCORING_REQ_LOG: "off",
  PROVIDER_FALLBACK_ORDER: "deepseek", RETRIEVAL_SEMANTIC_HYBRID: "false", DIAG_DB_INSTRUMENTATION: "false",
  CIQ_CHILD_TEST_MODULE: path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "isolation-child.ts"),
});

// Child must not depend on Redis: redis.ts throws at import without REDIS_URL.
delete process.env.REDIS_URL;
delete process.env.MAX_CONCURRENT_SUBPROC; // baseline default (6) under test

const { runPipelineIsolated, isolationEnabled, childPgBudget, classifyIsolatedOutcome, pipelineTimeoutMs, __testing } = await import("./job-isolation.js");
const { isRetriableError, fenceCancelledResult } = await import("./retry-policy.js");
const { PG_PARENT_RESERVE } = await import("../db.js");
const { spawn } = await import("node:child_process");
const { runWithDiagContext } = await import("./diag-context.js");
const { createAttemptLifecycle, revokeAttempt } = await import("./lifecycle-fence.js");
const { __usageBufferLengthForTests } = await import("./llm-usage.js");
const { ProviderScoringError } = await import("./credit-breaker.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const company = { id: 5001, workspaceId: 1, name: "Stub PLC", createdAt: new Date("2026-01-01") };
const framework = { id: 9001, workspaceId: 1, name: "F" };
function mkOpts(extra: any = {}) {
  return { company, framework, measures: [], workspaceId: 1, batchId: 1274, attemptId: "t-attempt", batchFetchState: { hostSlowFetches: new Map(), hostCircuitBroken: new Set<string>() }, ...extra } as any;
}
function inCtx<T>(fn: (lc: any) => Promise<T>, deadlineMs: number | null = null): Promise<T> {
  const lc = createAttemptLifecycle({ jobId: 77, batchId: 1274, attemptNumber: 1, deadlineAt: deadlineMs ? new Date(Date.now() + deadlineMs) : null, attemptToken: "00000000-0000-4000-8000-000000000001" });
  return runWithDiagContext({ batchId: 1274, jobId: 77, attemptId: "t-attempt", attemptNumber: 1, companyId: 5001, frameworkId: 9001, stage: "pipeline", lifecycle: lc }, () => fn(lc));
}
function lagProbe() {
  let last = performance.now(), max = 0;
  const t = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last - 20); last = now; }, 20);
  return { stop: () => { clearInterval(t); return max; } };
}
async function assertNoLeaks() {
  for (let i = 0; i < 40 && __testing.liveChildren() > 0; i++) await sleep(25); // child exits ~50ms after its result
  const s = __testing.brokerState();
  assert.deepEqual([s.llm.active, s.llm.waiting, s.browser.active, s.browser.waiting, s.proc.active, s.proc.waiting], [0, 0, 0, 0, 0, 0], JSON.stringify(s));
  assert.equal(__testing.liveChildren(), 0);
}
/** Alive = exists and is not a zombie (an exited-but-unreaped process holds no resources). */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return false; }
};
let pidSeq = 0;
function freshPidfile(): string {
  const f = path.join(os.tmpdir(), `iso-pid-${process.pid}-${++pidSeq}.json`);
  try { fs.unlinkSync(f); } catch {}
  process.env.FIXTURE_PIDFILE = f;
  return f;
}
async function waitFile(f: string, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fs.existsSync(f) && fs.statSync(f).size > 0) return;
  throw new Error("timeout waiting for " + f);
}
async function waitDead(pids: number[], ms: number): Promise<number> {
  const t0 = Date.now();
  while (pids.some(alive)) { if (Date.now() - t0 > ms) return -1; await sleep(10); }
  return Date.now() - t0;
}
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("flag + PG budget partition (C = floor((20-4)/4) = 4)", () => {
  assert.equal(isolationEnabled(), true);
  assert.equal(childPgBudget(), 4);
  assert.equal(childPgBudget({ PG_POOL_MAX: "6", WORKER_CONCURRENCY: "4" } as any), 0);
});

test("1. child busy-loops 3s: parent event loop stays responsive (<100ms lag)", async () => {
  process.env.FIXTURE_MODE = "busy";
  const p = lagProbe();
  const t0 = Date.now();
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts()));
  const maxLag = p.stop();
  console.log(`# busy child: wall=${Date.now() - t0}ms parent max lag=${maxLag.toFixed(1)}ms childPid=${r.pid} parentPid=${process.pid}`);
  assert.equal(r.success, true);
  assert.notEqual(r.pid, process.pid);
  assert.ok(maxLag < 100, `parent lag ${maxLag}ms`);
  await assertNoLeaks();
});

test("2. cancel: parent cancelCheck → child returns Cancelled", async () => {
  process.env.FIXTURE_MODE = "cancel";
  let flag = false;
  setTimeout(() => { flag = true; }, 2500);
  const t0 = Date.now();
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts({ cancelCheck: () => flag })));
  console.log(`# cancel: returned after ${Date.now() - t0}ms error=${r.error}`);
  assert.equal(r.success, false);
  assert.equal(r.error, "Cancelled");
  await sleep(100);
  await assertNoLeaks();
});

test("3. child ignoring revoke + SIGTERM is SIGKILLed with its process group; classified as revoked → fenced non-retriable", async () => {
  process.env.FIXTURE_MODE = "ignore-revoke";
  const pidfile = freshPidfile();
  const t0 = Date.now();
  const r: any = await inCtx(async (lc) => {
    const p = runPipelineIsolated(mkOpts());
    await waitFile(pidfile);
    revokeAttempt(lc, "ownership_lost");
    return p;
  });
  const pids = JSON.parse(fs.readFileSync(pidfile, "utf8"));
  console.log(`# revoke: resolved after ${Date.now() - t0}ms: ${r?.error}`);
  assert.equal(r.error, "Cancelled");
  // worker.ts lifecycle fence: batch not cancelled → watchdog timeout → no retry
  const fenced = fenceCancelledResult(r, false, "ownership_lost", 600000);
  assert.match(fenced.error!, /^Job watchdog timeout after 600000ms \(attempt revoked: ownership_lost\)$/);
  assert.equal(isRetriableError(fenced.error!), false);
  assert.equal(alive(pids.child), false, "child gone");
  assert.equal(alive(pids.grandchild), false, "grandchild (process group) gone");
  await assertNoLeaks();
});

test("4. crash: process.exit(1) holding an LLM permit → explicit retriable error, permit released", async () => {
  process.env.FIXTURE_MODE = "crash";
  const err: any = await inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
  console.log(`# crash: ${err?.message}`);
  assert.match(err.message, /^Isolated job child exited unexpectedly \(code=1 signal=null stage=/);
  assert.equal(isRetriableError(err.message), true, "retriable (worker.ts isRetriableError)");
  await assertNoLeaks();
});

test("5. permit brokerage: 4 children × 5 LLM permits → max 8 concurrent; browser max 1; all released", async () => {
  process.env.FIXTURE_MODE = "permits";
  let maxLlm = 0, maxBrowser = 0;
  const t = setInterval(() => { const s = __testing.brokerState(); maxLlm = Math.max(maxLlm, s.llm.active); maxBrowser = Math.max(maxBrowser, s.browser.active); }, 5);
  const rs = await Promise.all([0, 1, 2, 3].map(() => inCtx(() => runPipelineIsolated(mkOpts()))));
  clearInterval(t);
  console.log(`# permits: maxLlm=${maxLlm} maxBrowser=${maxBrowser}`);
  assert.ok(rs.every((r: any) => r.success));
  assert.equal(maxLlm, 8);
  assert.equal(maxBrowser, 1);
  await sleep(50);
  await assertNoLeaks();
});

test("6. usage row forwarded to parent buffer; child buffer stays empty; child PG_POOL_MAX=4", async () => {
  process.env.FIXTURE_MODE = "usage";
  const before = __usageBufferLengthForTests();
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts()));
  assert.equal(r.childBuffer, 0);
  assert.equal(r.pgMax, "4");
  assert.equal(__usageBufferLengthForTests(), before + 1);
});

test("ProviderScoringError rebuilt as the real class (isProviderQuotaError path)", async () => {
  process.env.FIXTURE_MODE = "provider-error";
  const err: any = await inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
  assert.ok(err instanceof ProviderScoringError);
  assert.equal(err.failureClass, "quota_exhausted");
  assert.equal(err.provider, "deepseek");
  await assertNoLeaks();
});

const CORPUS = "/home/ubuntu/var_corpus/12.json";
test("7. full 36-measure real pipeline in child (stubbed pg/providers); parent responsive", { skip: !fs.existsSync(CORPUS) && "corpus missing" }, async () => {
  process.env.FIXTURE_MODE = "pipeline36";
  const savedMeasures: any[] = JSON.parse(fs.readFileSync("/home/ubuntu/var_measures.json", "utf8"));
  const sf: any = JSON.parse(fs.readFileSync("/home/ubuntu/var_framework.json", "utf8"));
  const camel = (m: any, i: number) => ({ id: m.id ?? i + 1, frameworkId: 9001, measureId: m.measure_id ?? m.measureId, category: m.category, categoryNumber: m.category_number ?? m.categoryNumber ?? 1,
    title: m.title, definition: m.definition ?? "", scoringGuidance: m.scoring_guidance ?? m.scoringGuidance ?? null, evidenceKeywords: m.evidence_keywords ?? m.evidenceKeywords ?? null,
    requiredSourceTypes: m.required_source_types ?? null, displayOrder: i + 1, scoringMode: m.scoring_mode ?? m.scoringMode ?? undefined });
  const measures = Array.from({ length: 36 }, (_, i) => { const b = camel(savedMeasures[i % savedMeasures.length], i); return i < savedMeasures.length ? b : { ...b, id: 10_000 + i, measureId: `${b.measureId}-dup${i}` }; });
  const fw = { id: 9001, workspaceId: 1, name: sf.name, topicDescription: sf.topic_description ?? sf.topicDescription, version: 1, isActive: true };
  const p = lagProbe();
  const t0 = Date.now();
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts({ company: { ...company, analysisStatus: "fetched", ticker: null, website: null }, framework: fw, measures, skipFetch: true })));
  const maxLag = p.stop();
  console.log(`# pipeline36: wall=${Date.now() - t0}ms success=${r.success} measures=${r.measures} providerCalls=${r.providerCalls} fencedWriteLocks=${r.fencedWrites} err=${r.error ?? "-"} parentMaxLag=${maxLag.toFixed(1)}ms`);
  assert.equal(r.success, true, r.error);
  assert.equal(r.measures, 36);
  assert.ok(maxLag < 100, `parent lag ${maxLag}ms`);
  await assertNoLeaks();
});


// ─── Gap A: replica DB connection inventory ─────────────────────────────────
test("A1. pool inventory: parent main 4 + 4 children × 4 + parent usage 2 = 22 = baseline 20 + 2", () => {
  const PG_POOL_MAX = 20, CONC = 4, USAGE = parseInt(process.env.PG_USAGE_POOL_MAX || "2", 10);
  const parentMain = Math.min(PG_PARENT_RESERVE, PG_POOL_MAX); // db.ts: role worker-parent + isolation on
  const children = CONC * childPgBudget();                      // each child's db.ts pool max
  const childUsage = 0;                                         // child forwards usage rows (asserted live in F1)
  const isolated = parentMain + children + USAGE + childUsage;
  const baseline = PG_POOL_MAX + USAGE;                          // 35884ee: one main pool + one usage pool
  console.log(`# pool inventory: parentMain=${parentMain} children=${CONC}x${childPgBudget()}=${children} parentUsage=${USAGE} childUsage=0 total=${isolated} baseline=${baseline}`);
  assert.equal(isolated, 22);
  assert.ok(isolated <= baseline);
  // Default production concurrency (10): floor(16/10)=1 per child → 4 + 10 + 2 = 16 ≤ 22
  assert.equal(Math.min(PG_PARENT_RESERVE, 20) + 10 * childPgBudget({ PG_POOL_MAX: "20", WORKER_CONCURRENCY: "10" } as any) + USAGE, 16);
});

// ─── Gap B: parent-enforced deadlines; no grace past a deadline ─────────────
test("B1. pipeline deadline: child blocked forever → parent SIGKILLs at PIPELINE_TIMEOUT_MS (grace 30s NOT applied); same result as in-process timeout", async () => {
  const r: any = await withEnv({ FIXTURE_MODE: "block-forever", PIPELINE_TIMEOUT_MS: "2500", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
    assert.equal(pipelineTimeoutMs(), 2500);
    const pidfile = freshPidfile();
    return inCtx(async (lc) => {
      const t0 = Date.now();
      const p = runPipelineIsolated(mkOpts());
      await waitFile(pidfile);
      const res: any = await p;
      const pids = JSON.parse(fs.readFileSync(pidfile, "utf8"));
      return { ...res, elapsed: Date.now() - t0, pids, revoked: lc.revoked, reason: lc.revokedReason };
    });
  });
  console.log(`# B1 pipeline deadline: resolved after ${r.elapsed}ms error="${r.error}" revoked=${r.reason}`);
  assert.equal(r.success, false);
  assert.match(r.error, /^Pipeline timed out after \d+s$/);
  assert.equal(r.failureType, "timeout");
  assert.equal(r.revoked, true);
  assert.equal(r.reason, "pipeline_timeout");
  assert.ok(r.elapsed >= 2500 && r.elapsed < 4000, `killed at ${r.elapsed}ms`);
  assert.equal(isRetriableError(r.error), true, "existing policy: pipeline timeout is retriable");
  assert.equal(await waitDead([r.pids.child, r.pids.grandchild, r.pids.detached], 500), 0, "child + same-group grandchild + detached descendant already gone at settle");
  await assertNoLeaks();
});

test("B2. job deadline: child keeps dispatching and ignores revoke/SIGTERM → nothing written after deadlineAt; non-retriable watchdog", async () => {
  const stamp = path.join(os.tmpdir(), `iso-stamp-${process.pid}`);
  try { fs.unlinkSync(stamp); } catch {}
  const r: any = await withEnv({ FIXTURE_MODE: "dispatch-loop", FIXTURE_STAMPFILE: stamp, PIPELINE_TIMEOUT_MS: "60000", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
    const pidfile = freshPidfile();
    return inCtx(async (lc) => {
      const err: any = await runPipelineIsolated(mkOpts()).then(() => null, (e) => e);
      return { err, deadline: lc.deadlineAt.getTime(), revoked: lc.revoked, reason: lc.revokedReason, pids: JSON.parse(fs.readFileSync(pidfile, "utf8")) };
    }, 3000);
  });
  const lastWrite = parseInt(fs.readFileSync(stamp, "utf8"), 10);
  await sleep(200);
  const lastWriteLater = parseInt(fs.readFileSync(stamp, "utf8"), 10);
  console.log(`# B2 job deadline: ${r.err?.message} lastWrite-deadline=${lastWrite - r.deadline}ms`);
  assert.match(r.err.message, /^Job watchdog timeout: isolated child killed at job deadline \(code=null signal=SIGKILL/);
  assert.equal(isRetriableError(r.err.message), false);
  assert.equal(r.reason, "job_watchdog_timeout");
  assert.ok(lastWrite - r.deadline <= 50, `child wrote ${lastWrite - r.deadline}ms after the deadline`);
  assert.equal(lastWriteLater, lastWrite, "no writes after settle");
  assert.equal(alive(r.pids.child), false);
  await assertNoLeaks();
});

// ─── Gap C: abrupt coordinator death (SIGKILL: process.on('exit') never runs) ──
for (const mode of ["block-forever", "hang"] as const) {
  test(`C. supervisor SIGKILLed while child is ${mode === "hang" ? "idle-waiting (event loop free)" : "synchronously blocked"} → child, grandchild and detached descendant die`, async () => {
    const pidfile = freshPidfile();
    const parent = spawn(process.execPath, ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "isolation-parent.ts")],
      { env: { ...process.env, FIXTURE_MODE: mode, PIPELINE_TIMEOUT_MS: "600000" }, stdio: "inherit" });
    await waitFile(pidfile);
    const pids = JSON.parse(fs.readFileSync(pidfile, "utf8"));
    assert.ok([pids.child, pids.grandchild, pids.detached].every(alive), "all running before the kill");
    parent.kill("SIGKILL");
    await new Promise((r) => parent.once("exit", r));
    const ms = await waitDead([pids.child, pids.grandchild, pids.detached], 3000);
    console.log(`# C ${mode}: supervisor SIGKILLed → all descendants gone after ${ms}ms`);
    assert.ok(ms >= 0, `orphans survived: ${JSON.stringify({ child: alive(pids.child), grandchild: alive(pids.grandchild), detached: alive(pids.detached) })}`);
    for (const p of [pids.child, pids.grandchild, pids.detached]) { try { process.kill(p, "SIGKILL"); } catch {} }
  });
}

// ─── Gap D: retry classification table (same outcome as the in-process path) ─
test("D. retry classification table", () => {
  const base = { reported: null, code: null, signal: "SIGKILL" as const, lastStage: "scoring", pipelineElapsedMs: 540_000 };
  const worker = (o: any, batchCancelled: boolean) => {          // worker.ts decision, reduced
    if ("reject" in o) return isRetriableError(o.reject.message) ? "retry" : "final";
    const r = fenceCancelledResult(o.resolve, batchCancelled, "x", 600000);
    if (r.success) return "success";
    if (r.error === "Cancelled") return "cancelled";               // failJob("Cancelled (batch cancelled)")
    return isRetriableError(r.error!) ? "retry" : "final";
  };
  const rows: Array<[string, any, boolean, string]> = [
    ["admin cancel (batch cancelled), child killed", { ...base, killReason: "cancel" }, true, "cancelled"],
    ["admin cancel, then job deadline hastens kill", { ...base, killReason: "cancel" }, true, "cancelled"],
    ["ownership lost (revoke), child killed", { ...base, killReason: "revoke:ownership_lost" }, false, "final"],
    ["job watchdog deadline", { ...base, killReason: "job_deadline" }, false, "final"],
    ["pipeline deadline (existing policy: retriable)", { ...base, killReason: "pipeline_deadline" }, false, "retry"],
    ["unexpected crash (no kill requested)", { ...base, killReason: null, code: 1, signal: null }, false, "retry"],
    ["OOM / external SIGKILL (no kill requested)", { ...base, killReason: null }, false, "retry"],
    ["child reported result before any kill wins", { ...base, killReason: "job_deadline", reported: { resolve: { success: true } } }, false, "success"],
  ];
  for (const [name, input, bc, want] of rows) assert.equal(worker(classifyIsolatedOutcome(input), bc), want, name);
  // the in-process pipeline timeout string is reproduced exactly
  assert.equal((classifyIsolatedOutcome({ ...base, killReason: "pipeline_deadline" }) as any).resolve.error, "Pipeline timed out after 540s");
});

test("D6. cancel in progress, child ignores it, job deadline arrives → still a cancellation, killed at the deadline (not after the 30s grace)", async () => {
  const stamp = path.join(os.tmpdir(), `iso-stamp2-${process.pid}`);
  let flag = false;
  const t0 = Date.now();
  const r: any = await withEnv({ FIXTURE_MODE: "dispatch-loop", FIXTURE_STAMPFILE: stamp, PIPELINE_TIMEOUT_MS: "60000", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
    freshPidfile();
    setTimeout(() => { flag = true; }, 300);
    return inCtx(async (lc) => ({ ...(await runPipelineIsolated(mkOpts({ cancelCheck: () => flag }))), reason: lc.revokedReason }), 2500);
  });
  const elapsed = Date.now() - t0;
  console.log(`# D6 cancel+deadline: ${r.error} after ${elapsed}ms`);
  assert.equal(r.error, "Cancelled");
  assert.ok(elapsed < 4000, `${elapsed}ms`);
  assert.equal(fenceCancelledResult(r, true, "job_watchdog_timeout", 600000).error, "Cancelled", "batch cancelled → stays cancellation");
  await assertNoLeaks();
});

// ─── Gap E: permits / background work ────────────────────────────────────────
test("E1. queued IPC LLM acquisition aborted → withdrawn from the parent broker while 8 are still held", async () => {
  process.env.FIXTURE_MODE = "queued-cancel";
  let sawQueued = false, sawWithdrawn = false;
  const t = setInterval(() => { const s = __testing.brokerState().llm; if (s.active === 8 && s.waiting === 1) sawQueued = true; if (sawQueued && s.active === 8 && s.waiting === 0) sawWithdrawn = true; }, 5);
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts()));
  clearInterval(t);
  console.log(`# E1 queued-cancel: outcome=${r.outcome} afterAbort=${JSON.stringify(r.afterAbort)} sawQueued=${sawQueued} sawWithdrawn=${sawWithdrawn}`);
  assert.match(r.outcome, /^rejected/);
  assert.equal(r.afterAbort.pending, 0);
  assert.deepEqual(r.final, { pending: 0, outstanding: { llm: 0, browser: 0, proc: 0 } });
  assert.ok(sawQueued && sawWithdrawn);
  await assertNoLeaks();
});

test("E1b. child dies with 8 LLM permits held + 1 queued → parent drops the queued wait and returns all 8", async () => {
  process.env.FIXTURE_MODE = "queued-crash";
  const err: any = await inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
  assert.match(err.message, /exited unexpectedly \(code=3/);
  await assertNoLeaks();
});

test("E2/E3. child reports success with a grandchild + permit still alive and never exits → outcome delivered only after it is killed; permit never free while the process lives", async () => {
  process.env.FIXTURE_MODE = "background-alive";
  const pidfile = freshPidfile();
  let held = false, releasedWhileAlive = false, pids: any = null;
  const t = setInterval(() => {
    if (!pids && fs.existsSync(pidfile) && fs.statSync(pidfile).size) pids = JSON.parse(fs.readFileSync(pidfile, "utf8"));
    const a = __testing.brokerState().proc.active;
    if (a === 1) held = true;
    if (held && a === 0 && pids && (alive(pids.grandchild) || alive(pids.child))) releasedWhileAlive = true;
  }, 2);
  const t0 = Date.now();
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts()));
  const elapsed = Date.now() - t0;
  clearInterval(t);
  pids ??= JSON.parse(fs.readFileSync(pidfile, "utf8"));
  // checked synchronously at delivery, no polling
  const atDelivery = { child: alive(pids.child), grandchild: alive(pids.grandchild), proc: __testing.brokerState().proc.active, live: __testing.liveChildren() };
  console.log(`# E2 background-alive: delivered after ${elapsed}ms atDelivery=${JSON.stringify(atDelivery)} releasedWhileAlive=${releasedWhileAlive}`);
  assert.equal(r.success, true);
  assert.ok(elapsed >= 2000, "held back for the exit grace");
  assert.deepEqual(atDelivery, { child: false, grandchild: false, proc: 0, live: 0 });
  assert.ok(held);
  assert.equal(releasedWhileAlive, false);
  await assertNoLeaks();
});

test("E4. subprocess limit is per replica with the 35884ee baseline 6: 3 children × 4 → max 6 concurrent", async () => {
  process.env.FIXTURE_MODE = "procs";
  assert.equal(__testing.brokerState().proc.max, 6);
  let maxProc = 0;
  const t = setInterval(() => { maxProc = Math.max(maxProc, __testing.brokerState().proc.active); }, 2);
  const rs = await Promise.all([0, 1, 2].map(() => inCtx(() => runPipelineIsolated(mkOpts()))));
  clearInterval(t);
  console.log(`# E4 procs: maxProc=${maxProc}`);
  assert.ok(rs.every((r: any) => r.success));
  assert.equal(maxProc, 6);
  await assertNoLeaks();
});

// ─── Gap F: what the child creates at startup ────────────────────────────────
test("F1. child startup audit: no Redis/Bull, no DB init / startup-cleanup / reconciler, 0 PG connections, no usage pool", async () => {
  process.env.FIXTURE_MODE = "boot-audit";
  const r: any = await inCtx(() => runPipelineIsolated(mkOpts()));
  console.log(`# F1 atEntry=${JSON.stringify(r.atEntry)} afterPipelineImport=${JSON.stringify(r.afterPipelineImport)} handles=${JSON.stringify(r.handles)} modules=${r.loaded.length} pkgs=${r.loadedPkgs.length} pgTotal=${r.pgTotal} usagePool=${r.usagePool}`);
  console.log(`# F1 server modules loaded by child pipeline import: ${[...new Set(r.loaded.filter((u: string) => u.startsWith("server/") && !u.startsWith("server/lib/")))].join(",")}`);
  console.log(`# F1 packages: ${r.loadedPkgs.sort().join(",")}`);
  assert.equal(r.hooks, "function");
  assert.ok(r.loaded.includes("server/lib/pipeline.ts") && r.loaded.length > 20, "module tracking is effective");
  for (const m of ["server/redis.ts", "server/queue.ts", "server/startup-cleanup.ts", "server/reconciler.ts", "server/worker.ts", "server/worker-main.ts", "server/index.ts", "server/lib/reconcile-resurrect.ts"])
    assert.equal(r.loaded.includes(m), false, `${m} loaded in child`);
  for (const p of ["ioredis", "bullmq", "bull"]) assert.equal(r.loadedPkgs.includes(p), false, `${p} loaded in child`);
  assert.equal(r.redisUrl, null);
  assert.equal(r.pgTotal, 0, "no PG connection opened by startup");
  assert.equal(r.usagePool, false);
  // only the IPC channel and stdio pipes; no TCP (PG/Redis) connection
  assert.ok(!r.handles.some((h: string) => /TCP|peer=/.test(h)), `network handles: ${r.handles}`);
  const allowed = new Set(["PipeWrap", "Timeout", "MessagePort", "Worker", "TTYWrap", "FSReqCallback", "SignalWrap", "ProcessWrap"]);
  for (const k of r.atEntry) assert.ok(allowed.has(k), `unexpected resource at child entry: ${k}`);
  await assertNoLeaks();
});

// ─── Gap G: what still runs on the parent loop ───────────────────────────────
test("G1. 4 concurrent CPU-bound children on this 2-CPU host: parent lag, fork and IPC-handler cost", async () => {
  process.env.FIXTURE_MODE = "busy";
  __testing.resetStats();
  const p = lagProbe();
  const rs = await Promise.all([0, 1, 2, 3].map(() => inCtx(() => runPipelineIsolated(mkOpts()))));
  const maxLag = p.stop();
  const s = __testing.stats();
  console.log(`# G1 4x busy on ${os.cpus().length} CPUs: parentMaxLag=${maxLag.toFixed(1)}ms forks=${s.forks} maxForkMs=${s.maxForkMs.toFixed(1)} messages=${s.messages} maxHandlerMs=${s.maxHandlerMs.toFixed(2)}`);
  assert.ok(rs.every((r: any) => r.success));
  assert.ok(maxLag < 100, `parent lag ${maxLag}ms`);
  assert.ok(s.maxHandlerMs < 20);
  await assertNoLeaks();
});

// ─── FIX 1: unconfirmed descendant cleanup → quarantine, never a clean success ─
const { processorSlotBroker } = await import("./processor.js");
const { quarantinedChildren, recoverQuarantinedChildren, probeGroups } = await import("./job-isolation.js");
const forcedAlive = async () => ({ live: [999_999], zombies: [], reliable: true });
async function acquiredWithin(p: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
}

test("Q1. forced-alive probe: child reported success but cleanup unconfirmed → rejected (non-retriable), quarantined, browser permit NOT reassigned; released once termination is confirmed", async () => {
  __testing.resetStats();
  __testing.setLivenessProbe(forcedAlive);
  try {
    const t0 = Date.now();
    const err: any = await withEnv({ FIXTURE_MODE: "hold-browser", WORKER_ISOLATION_REAP_WINDOW_MS: "300", WORKER_ISOLATION_QUARANTINE_POLL_MS: "100" }, async () => {
      freshPidfile();
      return inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
    });
    const q = quarantinedChildren();
    console.log(`# Q1 quarantine: settled after ${Date.now() - t0}ms err="${err?.message}" quarantine=${JSON.stringify(q)}`);
    assert.ok(err, "not a success");
    assert.match(err.message, /^Isolated job child cleanup unconfirmed: child pid=\d+ quarantined, cleanup unconfirmed after 300ms: live=\[999999\]/);
    assert.equal(isRetriableError(err.message), false);
    assert.equal(q.length, 1);
    assert.deepEqual(q[0].withheld, { llm: 0, browser: 1, proc: 0 });
    assert.equal(q[0].jobId, 77);
    assert.equal(__testing.stats().quarantined, 1);
    assert.equal(__testing.liveChildren(), 0);
    assert.equal(__testing.brokerState().browser.active, 1, "permit still held by the quarantined child");
    // capacity is not reassigned: a new browser acquire (max 1) does not resolve while quarantined
    const next = processorSlotBroker.browser.acquire();
    assert.equal(await acquiredWithin(next, 500), false, "browser permit re-granted while descendants may still run");
    // termination established → monitor releases the withheld permit → waiter gets it
    __testing.setLivenessProbe(null);
    assert.equal(await acquiredWithin(next, 2000), true, "permit returned after termination confirmed");
    processorSlotBroker.browser.release();
    assert.equal(quarantinedChildren().length, 0);
    await assertNoLeaks();
  } finally { __testing.setLivenessProbe(null); recoverQuarantinedChildren(); }
});

test("Q2. quarantine persists while the probe says live; deliberate recovery returns the permits", async () => {
  __testing.setLivenessProbe(forcedAlive);
  try {
    await withEnv({ FIXTURE_MODE: "hold-browser", WORKER_ISOLATION_REAP_WINDOW_MS: "200", WORKER_ISOLATION_QUARANTINE_POLL_MS: "100" }, async () => {
      freshPidfile();
      await inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
    });
    await sleep(500); // several monitor ticks
    const q = quarantinedChildren();
    assert.equal(q.length, 1, "still quarantined while live");
    assert.equal(__testing.brokerState().browser.active, 1);
    assert.equal(recoverQuarantinedChildren(q[0].childPid), 1);
    assert.equal(quarantinedChildren().length, 0);
    await assertNoLeaks();
  } finally { __testing.setLivenessProbe(null); recoverQuarantinedChildren(); }
});

test("Q3. zombie vs live: a group holding only an unreaped zombie counts as terminated (kill(-g,0) alone would not tell) → clean success, no quarantine, no 2s wait", async () => {
  // helper P (own group) forks C; C moves to its own group and exits; P never reaps → C is a zombie alone in group C
  const helper = spawn("python3", ["-c", "import os,sys,time\npid=os.fork()\nif pid==0:\n  os.setpgid(0,0); os._exit(0)\nprint(pid,flush=True); time.sleep(60)"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  try {
    const zpid = await new Promise<number>((res) => helper.stdout!.once("data", (d) => res(parseInt(String(d), 10))));
    for (let i = 0; i < 100 && fs.readFileSync(`/proc/${zpid}/stat`, "utf8").split(") ")[1][0] !== "Z"; i++) await sleep(10);
    let killSeesGroup = true; try { process.kill(-zpid, 0); } catch { killSeesGroup = false; }
    const pr = await probeGroups([zpid]);
    console.log(`# Q3 zombie pgid=${zpid}: kill(-g,0) succeeds=${killSeesGroup} probe=${JSON.stringify(pr)}`);
    assert.deepEqual(pr, { live: [], zombies: [zpid], reliable: true });
    // a live member (helper P leads its own group) is reported as live
    const pl = await probeGroups([helper.pid!]);
    assert.ok(pl.live.includes(helper.pid!));
    __testing.resetStats();
    const t0 = Date.now();
    const r: any = await withEnv({ FIXTURE_MODE: "zombie-group", FIXTURE_ZOMBIE_PGID: String(zpid), WORKER_ISOLATION_REAP_WINDOW_MS: "3000" }, () => inCtx(() => runPipelineIsolated(mkOpts())));
    const elapsed = Date.now() - t0;
    console.log(`# Q3 settled after ${elapsed}ms success=${r.success} quarantined=${__testing.stats().quarantined}`);
    assert.equal(r.success, true);
    assert.equal(__testing.stats().quarantined, 0);
    assert.ok(elapsed < 2500, `waited ${elapsed}ms on a zombie`);
    await assertNoLeaks();
  } finally { try { process.kill(-helper.pid!, "SIGKILL"); } catch {} }
});

// ─── FIX 2: monotonic terminal decision (explicit ordering barriers) ────────
function goFiles() {
  const b = path.join(os.tmpdir(), `iso-go-${process.pid}-${++pidSeq}`);
  for (const s of [".go", ".saw"]) { try { fs.unlinkSync(b + s); } catch {} }
  return { go: b + ".go", saw: b + ".saw" };
}
async function until(cond: () => boolean, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return;
  throw new Error("barrier timeout");
}

test("M1. report accepted BEFORE the job deadline keeps precedence even though the deadline fires before the child exits → success", async () => {
  const f = goFiles();
  __testing.resetStats();
  const r: any = await withEnv({ FIXTURE_MODE: "report-on-go", FIXTURE_GO: f.go, FIXTURE_LINGER: "1", WORKER_ISOLATION_EXIT_GRACE_MS: "30000", PIPELINE_TIMEOUT_MS: "60000" }, async () => {
    const pidfile = freshPidfile();
    return inCtx(async (lc) => {
      const t0 = Date.now();
      const p = runPipelineIsolated(mkOpts());
      await waitFile(pidfile);
      fs.writeFileSync(f.go, "1");            // barrier: report goes out now, deadline is ~2.5s away
      const res: any = await p;
      return { ...res, elapsed: Date.now() - t0, revoked: lc.revoked, deadline: lc.deadlineAt.getTime() - t0 };
    }, 2500);
  });
  console.log(`# M1 report-before-deadline: success=${r.success} elapsed=${r.elapsed}ms deadlineAt=+${r.deadline}ms revoked=${r.revoked} late=${__testing.stats().lateReportsDiscarded}`);
  assert.equal(r.success, true);
  assert.equal(r.revoked, false, "accepted report: deadline did not take a terminal decision");
  assert.ok(r.elapsed >= 2400 && r.elapsed < 6000, `lingering child killed at the deadline, not after the 30s exit grace (${r.elapsed}ms)`);
  assert.equal(__testing.stats().lateReportsDiscarded, 0);
  await assertNoLeaks();
});

test("M2. job deadline BEFORE the report → stays job watchdog timeout (non-retriable); late success discarded", async () => {
  const f = goFiles();
  __testing.resetStats();
  __testing.setSuppressDeadlineKill(true);   // deadline decides + revokes, but the child is left alive to report late
  try {
    const r: any = await withEnv({ FIXTURE_MODE: "report-on-go", FIXTURE_GO: f.go, PIPELINE_TIMEOUT_MS: "60000", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
      const pidfile = freshPidfile();
      return inCtx(async (lc) => {
        const p = runPipelineIsolated(mkOpts()).then(() => null, (e) => e);
        await waitFile(pidfile);
        await until(() => lc.revoked);          // barrier: terminal decision taken
        fs.writeFileSync(f.go, "1");            // only now may the child report success
        return { err: await p, reason: lc.revokedReason };
      }, 1500);
    });
    const late = __testing.lateReports();
    console.log(`# M2 deadline-before-report: err="${r.err?.message}" late=${JSON.stringify(late)}`);
    assert.match(r.err.message, /^Job watchdog timeout: isolated child killed at job deadline \(code=0 /);
    assert.equal(isRetriableError(r.err.message), false);
    assert.equal(r.reason, "job_watchdog_timeout");
    assert.equal(late.length, 1);
    assert.equal(late[0].killReason, "job_deadline");
    assert.match(late[0].summary, /^success=true/);
    await assertNoLeaks();
  } finally { __testing.setSuppressDeadlineKill(false); }
});

test("M2b. pipeline deadline BEFORE the report → stays pipeline timeout (retriable, existing policy); late success discarded", async () => {
  const f = goFiles();
  __testing.resetStats();
  __testing.setSuppressDeadlineKill(true);
  try {
    const r: any = await withEnv({ FIXTURE_MODE: "report-on-go", FIXTURE_GO: f.go, PIPELINE_TIMEOUT_MS: "1500", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
      const pidfile = freshPidfile();
      return inCtx(async (lc) => {
        const p = runPipelineIsolated(mkOpts());
        await waitFile(pidfile);
        await until(() => lc.revoked);
        fs.writeFileSync(f.go, "1");
        return { ...(await p), reason: lc.revokedReason };
      });
    });
    console.log(`# M2b pipeline-deadline-before-report: error="${r.error}" failureType=${r.failureType} late=${__testing.stats().lateReportsDiscarded}`);
    assert.equal(r.success, false);
    assert.match(r.error, /^Pipeline timed out after \d+s$/);
    assert.equal(r.failureType, "timeout");
    assert.equal(isRetriableError(r.error), true);
    assert.equal(r.reason, "pipeline_timeout");
    assert.equal(__testing.stats().lateReportsDiscarded, 1);
    await assertNoLeaks();
  } finally { __testing.setSuppressDeadlineKill(false); }
});

test("M3. cancel BEFORE the report → stays a cancellation; late success discarded", async () => {
  const f = goFiles();
  __testing.resetStats();
  let flag = false;
  const r: any = await withEnv({ FIXTURE_MODE: "report-on-go", FIXTURE_GO: f.go, FIXTURE_SAWCANCEL: f.saw, PIPELINE_TIMEOUT_MS: "60000", WORKER_ISOLATION_KILL_GRACE_MS: "30000" }, async () => {
    const pidfile = freshPidfile();
    return inCtx(async () => {
      const p = runPipelineIsolated(mkOpts({ cancelCheck: () => flag }));
      await waitFile(pidfile);
      flag = true;
      await waitFile(f.saw);                    // barrier: child observed the cancel (parent decided first)
      fs.writeFileSync(f.go, "1");
      return p;
    });
  });
  const late = __testing.lateReports();
  console.log(`# M3 cancel-before-report: error="${r.error}" late=${JSON.stringify(late)}`);
  assert.equal(r.success, false);
  assert.equal(r.error, "Cancelled");
  assert.equal(fenceCancelledResult(r, true, "cancel", 600000).error, "Cancelled");
  assert.equal(late.length, 1);
  assert.equal(late[0].killReason, "cancel");
  assert.match(late[0].summary, /^success=true/);
  await assertNoLeaks();
});
