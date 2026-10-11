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

const { runPipelineIsolated, isolationEnabled, childPgBudget, __testing } = await import("./job-isolation.js");
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

test("3. child ignoring revoke + SIGTERM is SIGKILLed with its process group; watchdog error", async () => {
  process.env.FIXTURE_MODE = "ignore-revoke";
  const pidfile = path.join(os.tmpdir(), `iso-pid-${process.pid}.json`);
  process.env.FIXTURE_PIDFILE = pidfile;
  try { fs.unlinkSync(pidfile); } catch {}
  const t0 = Date.now();
  const err: any = await inCtx(async (lc) => {
    const p = runPipelineIsolated(mkOpts());
    for (let i = 0; i < 100 && !fs.existsSync(pidfile); i++) await sleep(50);
    revokeAttempt(lc, "job_watchdog_timeout");
    return p.then(() => null, (e) => e);
  });
  const pids = JSON.parse(fs.readFileSync(pidfile, "utf8"));
  console.log(`# deadline: rejected after ${Date.now() - t0}ms: ${err?.message}`);
  assert.ok(err instanceof Error);
  assert.match(err.message, /^Job watchdog timeout: Isolated job child exited unexpectedly \(code=null signal=SIGKILL/);
  await sleep(200);
  assert.equal(alive(pids.child), false, "child gone");
  assert.equal(alive(pids.grandchild), false, "grandchild (process group) gone");
  await assertNoLeaks();
});

test("4. crash: process.exit(1) holding an LLM permit → explicit retriable error, permit released", async () => {
  process.env.FIXTURE_MODE = "crash";
  const err: any = await inCtx(() => runPipelineIsolated(mkOpts()).then(() => null, (e) => e));
  console.log(`# crash: ${err?.message}`);
  assert.match(err.message, /^Isolated job child exited unexpectedly \(code=1 signal=null stage=/);
  // same predicate list as worker.ts isRetriableError
  const nonRetriable = ["Company not found", "Framework not found", "No measures in framework", "Could not claim job", "Job watchdog timeout", "Insufficient corpus"];
  assert.equal(nonRetriable.some((m) => err.message.includes(m)), false, "retriable");
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
