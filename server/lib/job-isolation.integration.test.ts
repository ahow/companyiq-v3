/**
 * Worker-isolation INTEGRATION suite (opt-in; NOT part of the unit run).
 *
 * Real BullMQ worker (startWorker) on real Redis + real Postgres, isolation ON
 * (test env only), 2 jobs at concurrency 2. Each job runs in a real isolated
 * child: real shared Chromium (fetchPdfViaBrowser on a locally served PDF, real
 * pdftotext), then the real runAnalysisPipeline(skipFetch) on a seeded corpus,
 * writing real measure_scores through the lifecycle fence. LLM providers are
 * stubbed in the child (no paid calls) — that boundary is NOT exercised.
 *
 * Run (needs docker containers ciq-int-pg / ciq-int-redis, schema pushed):
 *   DATABASE_URL=postgres://ciq:ciq@127.0.0.1:55432/ciq REDIS_URL=redis://127.0.0.1:56379 \
 *     npx tsx server/lib/job-isolation.integration.test.ts
 * Skips (exit 0) when PG/Redis are unreachable unless INT_REQUIRED=1.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import IORedis from "ioredis";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq";
const REDIS = process.env.REDIS_URL || "redis://127.0.0.1:56379";
const CHROMIUM = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium";
const HOLD_MS = parseInt(process.env.INT_HOLD_MS || "20000", 10);
const TIMEOUT_MS = parseInt(process.env.INT_TIMEOUT_MS || "240000", 10);
const EVIDENCE = path.resolve(HERE, "../../docs/worker-isolation/evidence/integration-run.json");

// ─── Test-only environment (never production defaults) ──────────────────────
Object.assign(process.env, {
  DATABASE_URL: DB, REDIS_URL: REDIS,
  WORKER_ISOLATION_ENABLED: "true",
  CIQ_CHILD_TEST_MODULE: path.join(HERE, "__fixtures__/isolation-integration-child.ts"),
  PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
  WORKER_CONCURRENCY: "2",
  WORKER_LOCK_DURATION_MS: process.env.WORKER_LOCK_DURATION_MS || "30000",
  WORKER_STALLED_INTERVAL_MS: process.env.WORKER_STALLED_INTERVAL_MS || "15000",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",   // parent has no provider keys; providers are stubbed in the child
  OFFPEAK_GATE_ENABLED: "false",
  INT_HOLD_MS: String(HOLD_MS),
});

async function reachable(): Promise<string | null> {
  const c = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 3000 });
  try { await c.connect(); await c.query("select 1 from analysis_jobs limit 1"); } catch (e: any) { return "postgres: " + e.message; } finally { await c.end().catch(() => {}); }
  const r = new IORedis(REDIS, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
  try { await r.connect(); await r.ping(); } catch (e: any) { return "redis: " + e.message; } finally { r.disconnect(); }
  if (!fs.existsSync(CHROMIUM)) return "chromium missing at " + CHROMIUM;
  return null;
}

// ─── /proc process sampling ──────────────────────────────────────────────────
const PAGE = 4096;
function procTable(): Map<number, { ppid: number; comm: string; rssKb: number; state: string }> {
  const t = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const close = s.lastIndexOf(")");
      const comm = s.slice(s.indexOf("(") + 1, close);
      const f = s.slice(close + 2).split(" ");
      t.set(Number(d), { ppid: Number(f[1]), comm, state: f[0], rssKb: (Number(f[21]) * PAGE) / 1024 });
    } catch { /* exited */ }
  }
  return t;
}
function descendants(root: number, t = procTable()) {
  const out: number[] = []; const q = [root];
  while (q.length) { const p = q.pop()!; for (const [pid, v] of t) if (v.ppid === p) { out.push(pid); q.push(pid); } }
  return { t, pids: out };
}
/** Full identity of a process, for evidence and failure messages. */
function identity(pid: number, t = procTable()) {
  let exe = "?", cmdline = "?", startTicks = -1;
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* gone / no perm */ }
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { /* gone */ }
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); startTicks = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]); } catch { /* gone */ }
  const v = t.get(pid);
  return { pid, ppid: v?.ppid ?? -1, comm: v?.comm ?? "?", state: v?.state ?? "?", rssKb: v?.rssKb ?? 0, exe, cmdline: cmdline.slice(0, 300), startTicks };
}
/**
 * Explicit toolchain allowlist — exactly ONE kind of process is excluded from
 * the descendant/child counts: tsx's esbuild transform service, i.e. a DIRECT
 * child of this test process whose executable is an `esbuild` binary run as
 * `esbuild --service=<ver> --ping`. tsx starts it lazily on the first TS
 * transform after startup (so it may appear after the pre-job snapshot), it is
 * test tooling, never application work (production runs compiled JS with no
 * tsx). Every other descendant — including any other esbuild invocation —
 * stays strictly counted. Evidence: TEST_RESULTS.md §"Extra integration process".
 */
function isToolchainHelper(pid: number, t: ReturnType<typeof procTable>): boolean {
  if (t.get(pid)?.ppid !== process.pid) return false;
  const id = identity(pid, t);
  return /(^|\/)esbuild$/.test(id.exe) && /(^|\/)esbuild --service=\S+ --ping$/.test(id.cmdline);
}
const toolchainHelpersSeen = new Map<number, ReturnType<typeof identity>>();
function sample() {
  const { t, pids } = descendants(process.pid);
  const nonZombie = pids.filter((p) => t.get(p)!.state !== "Z");
  const helpers = nonZombie.filter((p) => isToolchainHelper(p, t));
  for (const p of helpers) if (!toolchainHelpersSeen.has(p)) toolchainHelpersSeen.set(p, { ...identity(p, t), firstSeenAt: Date.now() } as any);
  const live = nonZombie.filter((p) => !helpers.includes(p));
  const chrome = live.filter((p) => /chrom/i.test(t.get(p)!.comm));
  const jobChildren = live.filter((p) => t.get(p)!.ppid === process.pid);
  return {
    at: Date.now(), descendants: live.length, chromium: chrome.length, jobChildren: jobChildren.length,
    descendantRssMb: Math.round(live.reduce((a, p) => a + t.get(p)!.rssKb, 0) / 1024),
    chromiumRssMb: Math.round(chrome.reduce((a, p) => a + t.get(p)!.rssKb, 0) / 1024),
    parentRssMb: Math.round(process.memoryUsage().rss / 1048576),
    toolchainHelperPids: helpers,
    // Identity of every COUNTED direct child (job children); full identity of all counted descendants when few.
    jobChildIds: jobChildren.map((p) => identity(p, t)),
    countedDescendantIds: live.length <= 4 ? live.map((p) => identity(p, t)) : undefined,
  };
}
function orphanPuppeteerChromium(): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { if (fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("puppeteer_dev_chrome_profile")) out.push(Number(d)); } catch { /* gone */ }
  }
  return out;
}

async function main() {
  const why = await reachable();
  if (why) {
    console.log(`SKIP integration: ${why}`);
    process.exit(process.env.INT_REQUIRED === "1" ? 1 : 0);
  }
  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };
  const baselineOrphans = new Set(orphanPuppeteerChromium());
  // Production schema bootstrap (raw-SQL tables/columns beyond drizzle push).
  const { initializeDatabase } = await import("../db.js");
  await initializeDatabase();
  // Pre-job snapshot: identity of every descendant that exists before any job starts (recorded, NOT excluded).
  const preJob = (() => { const { t, pids } = descendants(process.pid); return pids.map((p) => ({ ...identity(p, t), toolchainHelper: isToolchainHelper(p, t) })); })();
  console.log(`[INT] initializeDatabase OK; pre-job descendants: ${JSON.stringify(preJob)}`);

  // Local PDF (real Chromium print-to-pdf) served over HTTP for the browser path.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ciq-int-"));
  fs.writeFileSync(path.join(tmp, "doc.html"), "<html><body><h1>CIQ-INTEGRATION-MARKER</h1><p>" + "Sustainability disclosure paragraph. ".repeat(40) + "</p></body></html>");
  execFileSync(CHROMIUM, ["--headless", "--no-sandbox", "--disable-gpu", `--print-to-pdf=${path.join(tmp, "doc.pdf")}`, `file://${path.join(tmp, "doc.html")}`], { stdio: "ignore", timeout: 60000 });
  const pdf = fs.readFileSync(path.join(tmp, "doc.pdf"));
  const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length }); r.end(pdf); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  process.env.INT_PDF_URL = `http://127.0.0.1:${(srv.address() as any).port}/doc.pdf`;

  // ─── Seed (raw SQL for fixtures; batch/jobs via production storage) ────────
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  const tag = `int-${Date.now()}`;
  const u = (await c.query("insert into users(email,password_hash,name) values($1,'x','int') returning id", [`${tag}@test.local`])).rows[0].id;
  const ws = (await c.query("insert into workspaces(name,slug,owner_id) values($1,$1,$2) returning id", [tag, u])).rows[0].id;
  const fw = (await c.query("insert into frameworks(workspace_id,name,is_active) values($1,$2,true) returning id", [ws, `${tag}-fw`])).rows[0].id;
  const MEASURES = ["Climate targets", "Scope 1 emissions", "Board diversity", "Supply chain audits", "Water management", "Anti-corruption policy"];
  for (let i = 0; i < MEASURES.length; i++) {
    await c.query(`insert into framework_measures(framework_id,measure_id,category,category_number,title,definition,scoring_guidance,evidence_keywords,display_order)
      values($1,$2,$3,$4,$5,$6,'Yes if disclosed.',$7,$8)`, [fw, `M${i + 1}`, i < 3 ? "Environment" : "Governance", i < 3 ? 1 : 2, MEASURES[i], `Company discloses ${MEASURES[i].toLowerCase()}.`, JSON.stringify(MEASURES[i].toLowerCase().split(" ")), i]);
  }
  const corpus = JSON.parse(fs.readFileSync(process.env.FIXTURE_CORPUS || "/home/ubuntu/var_corpus/12.json", "utf8"))
    .filter((d: any) => d && typeof d.text === "string" && d.text.length > 50).slice(0, 25);
  const companies: number[] = [];
  for (const name of ["IntCo Alpha", "IntCo Beta"]) {
    const co = (await c.query("insert into companies(workspace_id,name) values($1,$2) returning id", [ws, `${tag} ${name}`])).rows[0].id;
    companies.push(co);
    for (const d of corpus) {
      await c.query(`insert into documents(company_id,url,title,type,fetch_status,gate_verdict,source_type,content,fetched_at) values($1,$2,$3,$4,'ok','accept','first_party',$5,now())`,
        [co, d.url, d.title, /\.pdf/i.test(d.url) ? "pdf" : "html", d.text]);
    }
  }
  console.log(`[INT] seeded workspace=${ws} framework=${fw} companies=${companies.join(",")} docs/company=${corpus.length} measures=${MEASURES.length}`);

  const storage = await import("../storage.js");
  const { addBatchJobs, getQueue } = await import("../queue.js");
  const { startWorker, stopWorker } = await import("../worker.js");
  const iso = await import("./job-isolation.js");

  const batch: any = await storage.createBatchRun(ws, fw, companies.length);
  const jobs: any[] = await storage.createAnalysisJobs(companies.map((co, i) => ({ workspaceId: ws, batchId: batch.id, companyId: co, companyName: `${tag} ${i}`, frameworkId: fw })));
  const q = getQueue();
  await q.obliterate({ force: true }).catch(() => {});

  const worker = await startWorker(`int-${process.pid}`);
  const stalled: string[] = []; const failedEv: string[] = []; const completedEv: string[] = [];
  worker.on("stalled", (id: string) => stalled.push(id));
  worker.on("failed", (j: any, e: any) => failedEv.push(`${j?.id}: ${e?.message}`));
  worker.on("completed", (j: any) => completedEv.push(String(j?.id)));

  const t0 = Date.now();
  await addBatchJobs(jobs.map((j) => ({ jobId: j.id, companyId: j.companyId, frameworkId: fw, batchId: batch.id, workspaceId: ws, skipFetch: true, skipDiscovery: true })) as any, ws, batch.id);
  const bullIds = jobs.map((j) => `batch-${batch.id}-company-${j.companyId}`);

  // Sampling: processes every 500ms; lock PTTL per job (an increase = renewal).
  const r = new IORedis(REDIS);
  const samples: any[] = []; const lastTtl = new Map<string, number>(); const renewals = new Map<string, number>(bullIds.map((b) => [b, 0]));
  const timer = setInterval(async () => {
    samples.push(sample());
    for (const b of bullIds) {
      const ttl = await r.pttl(`bull:analysis:${b}:lock`).catch(() => -2);
      const prev = lastTtl.get(b);
      if (ttl > 0 && prev !== undefined && prev > 0 && ttl > prev + 250) renewals.set(b, renewals.get(b)! + 1);
      lastTtl.set(b, ttl);
    }
  }, 500);

  let rows: any[] = [];
  while (Date.now() - t0 < TIMEOUT_MS) {
    rows = (await c.query("select id,status,last_error,attempts from analysis_jobs where batch_id=$1 order by id", [batch.id])).rows;
    if (rows.every((x) => x.status === "completed" || x.status === "failed")) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const elapsedMs = Date.now() - t0;
  await new Promise((res) => setTimeout(res, 3000)); // let child exit / reap / permits settle
  clearInterval(timer);
  const after = sample();
  await stopWorker();
  await new Promise((res) => setTimeout(res, 2000));
  const afterStop = sample();
  const newOrphans = orphanPuppeteerChromium().filter((p) => !baselineOrphans.has(p));

  const batchRow = (await c.query("select status,completed_jobs,failed_jobs,total_jobs from batch_runs where id=$1", [batch.id])).rows[0];
  const scores = (await c.query("select company_id, count(*)::int n, sum(case when verdict='Yes' then 1 else 0 end)::int yes, count(distinct attempt_id)::int attempts from measure_scores where framework_id=$1 group by company_id order by company_id", [fw])).rows;
  const peak = samples.reduce((m, s) => (s.chromium > m.chromium || (s.chromium === m.chromium && s.descendantRssMb > m.descendantRssMb) ? s : m), samples[0] ?? after);
  const maxRss = samples.reduce((m, s) => Math.max(m, s.descendantRssMb), 0);
  const maxParent = samples.reduce((m, s) => Math.max(m, s.parentRssMb), 0);
  const maxConcurrentChildren = samples.reduce((m, s) => Math.max(m, s.jobChildren), 0);
  const summary = {
    ranAt: new Date().toISOString(), node: process.version, chromium: CHROMIUM,
    config: { concurrency: 2, lockDurationMs: Number(process.env.WORKER_LOCK_DURATION_MS), stalledIntervalMs: Number(process.env.WORKER_STALLED_INTERVAL_MS), holdMs: HOLD_MS },
    elapsedMs, jobs: rows, batch: batchRow, scores,
    peak, maxDescendantRssMb: maxRss, maxParentRssMb: maxParent, maxConcurrentJobChildren: maxConcurrentChildren,
    lockRenewals: Object.fromEntries(renewals), stalledEvents: stalled, failedEvents: failedEv, completedEvents: completedEv,
    afterCompletion: after, afterStopWorker: afterStop, newOrphanPuppeteerChromium: newOrphans,
    preJobDescendants: preJob, toolchainHelpers: [...toolchainHelpersSeen.values()],
    quarantined: iso.quarantinedChildren().length, isolationStats: iso.__testing.stats(), brokerAfter: iso.__testing.brokerState(), samples: samples.length,
  };
  console.log("[INT] summary " + JSON.stringify({ ...summary, samples: samples.length }, null, 1));

  check(rows.length === 2 && rows.every((x) => x.status === "completed"), `both analysis_jobs completed (${rows.map((x) => x.status).join(",")})`);
  check(batchRow?.completed_jobs === 2 && batchRow?.failed_jobs === 0, `batch counters completed=2 failed=0 (got ${batchRow?.completed_jobs}/${batchRow?.failed_jobs}, status=${batchRow?.status})`);
  check(scores.length === 2 && scores.every((s: any) => s.n === MEASURES.length), `measure_scores persisted: ${MEASURES.length} per company (${JSON.stringify(scores)})`);
  const maxSample = samples.find((x) => x.jobChildren === maxConcurrentChildren);
  check(maxConcurrentChildren === 2, `2 isolated job children ran concurrently (max seen ${maxConcurrentChildren}; at max: ${JSON.stringify(maxSample?.jobChildIds?.map((i: any) => ({ pid: i.pid, exe: i.exe, cmd: i.cmdline.slice(0, 120) })))})`);
  check(peak.chromium > 0, `real Chromium observed under job children (peak ${peak.chromium} procs, ${peak.chromiumRssMb} MB)`);
  check(stalled.length === 0, `no BullMQ stalled events (${stalled.length})`);
  check([...renewals.values()].every((n) => n >= 1), `lock renewed at least once per job (${JSON.stringify(Object.fromEntries(renewals))})`);
  check(after.descendants === 0, `no descendants after completion (${after.descendants}, chromium ${after.chromium}; counted: ${JSON.stringify(after.countedDescendantIds)})`);
  check(afterStop.descendants === 0, `no descendants after stopWorker (${afterStop.descendants}; counted: ${JSON.stringify(afterStop.countedDescendantIds)})`);
  check(newOrphans.length === 0, `no orphaned puppeteer Chromium anywhere on host (${newOrphans.join(",") || "none"})`);
  check(iso.quarantinedChildren().length === 0, "no quarantined children");
  const b = summary.brokerAfter as any;
  check(JSON.stringify(b).match(/"(inUse|active|held)":[1-9]/) === null, `broker permits all returned after completion (${JSON.stringify(b)})`);

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({ ...summary, samplesData: samples, failures }, null, 1));
  await r.quit().catch(() => {}); await q.close().catch(() => {}); await c.end().catch(() => {}); srv.close();
  console.log(`[INT] toolchain helpers (excluded by exe+cmdline allowlist): ${JSON.stringify([...toolchainHelpersSeen.values()])}`);
  console.log(`[INT] harness pid=${process.pid} exiting; helper pids to verify gone after exit: ${[...toolchainHelpersSeen.keys()].join(",") || "none"}`);
  console.log(failures.length ? `INTEGRATION FAIL (${failures.length})` : "INTEGRATION PASS");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error("INTEGRATION ERROR", e); process.exit(1); });
