/**
 * Browser-lifetime reproduction harness (worker isolation ON, zero paid calls).
 *
 * Drives REPRO_JOBS isolated job children through the production supervisor
 * (runPipelineIsolated → job-child.ts) at REPRO_CONCURRENCY (default 4 =
 * production WORKER_CONCURRENCY) with MAX_CONCURRENT_BROWSER=1 (production).
 * Each child runs the production fetchPdfViaBrowser path against its OWN
 * synthetic marker PDFs served on 127.0.0.1, then a synthetic scoring hold (no
 * providers). Child turnover is continuous: a new child is forked as soon as
 * one settles. The summary asserts per-document extraction (every expected
 * document requested, no BrowserUnavailableError skip, its marker extracted)
 * and reports wall time, browser admission wait and permit hold time.
 *
 * Every REPRO_SAMPLE_MS it samples /proc and logs (one JSON line, tag SAMPLE):
 *   - limits: RLIMIT_NPROC, cgroup pids.max / pids.current (the TasksMax the
 *     harness was started under, if any)
 *   - live counters: harness-tree tasks (threads), processes, job children
 *   - live browser instances (distinct puppeteer profile main processes)
 *   - total RSS of the harness tree
 *   - broker permit state (active / waiting / max)
 * and logs acquire/grant/release events for the parent-side browser permit
 * (FETCH-BROKER), launch/exit events for each Chromium instance observed in
 * /proc (BROWSER-OBSERVED), and child stdout/stderr inline (child startup
 * stderr appears verbatim, e.g. pthread_create / uv_thread_create aborts).
 *
 * Writes a JSON summary to REPRO_OUT. Exit code 0 always (it is evidence, not
 * an assertion); the summary carries `bound_held` and `spawn_failures`.
 *
 *   REPRO_LABEL=before REPRO_OUT=/tmp/x.json npx tsx server/scripts/browser-lifetime-repro.ts
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const JOBS = parseInt(process.env.REPRO_JOBS || "16", 10);
const CONC = parseInt(process.env.REPRO_CONCURRENCY || "4", 10);
const SAMPLE_MS = parseInt(process.env.REPRO_SAMPLE_MS || "250", 10);
const LABEL = process.env.REPRO_LABEL || "run";
const OUT = process.env.REPRO_OUT || `/tmp/browser-lifetime-${LABEL}.json`;
const DOCS_PER_CHILD = parseInt(process.env.REPRO_DOCS_PER_CHILD || "2", 10);

// Test-only environment. Production values are kept for every capacity knob:
// MAX_CONCURRENT_BROWSER=1, WORKER_CONCURRENCY=4, PG_POOL_MAX=20.
Object.assign(process.env, {
  WORKER_ISOLATION_ENABLED: "true",
  CIQ_CHILD_TEST_MODULE: path.join(ROOT, "server/lib/__fixtures__/browser-lifetime-child.ts"),
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium",
  MAX_CONCURRENT_BROWSER: "1",
  WORKER_CONCURRENCY: String(CONC),
  PG_POOL_MAX: "20",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
  REPRO_HOLD_MS: process.env.REPRO_HOLD_MS || "15000",
  REPRO_DOCS_PER_CHILD: String(DOCS_PER_CHILD),
});

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const log = (tag: string, msg: string) => console.log(`${ts()} [${tag}] ${msg}`);

// ─── /proc sampling ──────────────────────────────────────────────────────────
interface P { pid: number; ppid: number; state: string; rssKb: number; threads: number }
function procTable(): Map<number, P> {
  const t = new Map<number, P>();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      t.set(+d, { pid: +d, ppid: +f[1], state: f[0], threads: +f[17], rssKb: (+f[21] * 4096) / 1024 });
    } catch { /* exited */ }
  }
  return t;
}
function tree(t: Map<number, P>): P[] {
  const out: P[] = []; const q = [process.pid];
  while (q.length) { const p = q.pop()!; for (const v of t.values()) if (v.ppid === p) { out.push(v); q.push(v.pid); } }
  return out;
}
const readNum = (f: string) => { try { const v = fs.readFileSync(f, "utf8").trim(); return v === "max" ? "max" : Number(v); } catch { return null; } };
function cgroupDir(): string | null {
  try { const rel = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]; return `/sys/fs/cgroup${rel}`; } catch { return null; }
}
const CG = cgroupDir();
function nprocLimit(): string {
  try { const l = fs.readFileSync("/proc/self/limits", "utf8").split("\n").find((x) => x.startsWith("Max processes")); return l ? l.replace(/\s+/g, " ").trim() : "?"; } catch { return "?"; }
}
const comm = (p?: number) => { try { return p ? fs.readFileSync(`/proc/${p}/comm`, "utf8").trim() : "?"; } catch { return "?"; } };
const cmdHead = (p: number) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter((a) => !a.startsWith("--") || /headless|type|user-data|proxy/.test(a)).join(" ").slice(0, 300); } catch { return "?"; } };
/** Puppeteer profile dir from a cmdline, or null if the process holds no puppeteer profile. */
function profileOf(p: number): string | null {
  try {
    const args = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
    const a = args.find((x) => x.startsWith("--user-data-dir=") && x.includes("puppeteer_dev_chrome_profile"));
    return a ? a.slice("--user-data-dir=".length) : null;
  } catch { return null; }
}
/**
 * Browser instances = one main process per distinct puppeteer profile.
 * Main = holds a puppeteer profile, carries no --type= (helpers do), AND its
 * parent does not hold the same profile. Chromium itself forks children with
 * the same profile and no --type= (zygote-less forks/crashpad-like helpers);
 * those were previously counted as a second browser.
 */
function browserMains(pids: number[], t: Map<number, P>): number[] {
  const byProfile = new Map<string, number>();
  for (const p of pids) {
    const prof = profileOf(p);
    if (!prof) continue;
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("--type=")) continue; } catch { continue; }
    const pp = t.get(p)?.ppid;
    if (pp && profileOf(pp) === prof) continue; // forked by the browser itself
    if (!byProfile.has(prof)) byProfile.set(prof, p);
  }
  return [...byProfile.values()];
}

async function main() {
  const { runPipelineIsolated, __testing } = await import("../lib/job-isolation.js");
  const { processorSlotBroker } = await import("../lib/processor.js");

  // Parent-side permit events (the fetch-broker permit every child must hold
  // while it drives Chromium).
  const b = processorSlotBroker.browser;
  const rawAcquire = b.acquire, rawRelease = b.release;
  const events: Array<{ at: number; ev: string; detail?: any }> = [];
  const ev = (e: string, detail?: any) => { events.push({ at: Date.now() - t0, ev: e, detail }); log("EVENT", `${e} ${detail ? JSON.stringify(detail) : ""}`); };
  (b as any).acquire = async () => { ev("permit.acquire.request", b.state()); await rawAcquire(); ev("permit.acquire.granted", b.state()); };
  (b as any).release = (...a: any[]) => { const r = (rawRelease as any)(...a); ev("permit.release", b.state()); return r; };

  // Every job/document gets its own synthetic PDF carrying a unique marker; the
  // server records which documents were actually requested (no silent skip).
  const { markerPdf, markerFor } = await import("../lib/__fixtures__/marker-pdf.js");
  const served = new Map<string, number>();
  const srv = http.createServer((q, r) => {
    const m = /^\/(job-\d+-doc-\d+)\.pdf/.exec(q.url || "");
    if (!m) { r.writeHead(200, { "content-type": "text/html" }); r.end("<html><body>issuer home</body></html>"); return; } // origin page (WAF prime)
    served.set(m[1], (served.get(m[1]) ?? 0) + 1);
    const pdf = markerPdf([markerFor(m[1]), `Synthetic annual report for ${m[1]}.`]);
    r.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length }); r.end(pdf);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  process.env.REPRO_DOC_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  log("SETUP", `label=${LABEL} jobs=${JOBS} concurrency=${CONC} MAX_CONCURRENT_BROWSER=1 synthetic marker PDFs docsPerChild=${DOCS_PER_CHILD} hold=${process.env.REPRO_HOLD_MS}ms`);
  log("LIMITS", `${nprocLimit()} | cgroup=${CG} pids.max=${readNum(`${CG}/pids.max`)} pids.current=${readNum(`${CG}/pids.current`)}`);

  const baseline = new Set(tree(procTable()).map((p) => p.pid)); // tsx/esbuild helpers already present
  const samples: any[] = [];
  const seenBrowsers = new Map<number, { launchedAt: number; exitedAt?: number }>();
  let peakBrowsers = 0, peakTasks = 0, peakRssMb = 0, peakProcs = 0;
  const sampler = setInterval(() => {
    const t = procTable();
    const all = tree(t).filter((p) => p.state !== "Z");
    const ours = all.filter((p) => !baseline.has(p.pid));
    const mains = browserMains(ours.map((p) => p.pid), t);
    for (const m of mains) if (!seenBrowsers.has(m)) { seenBrowsers.set(m, { launchedAt: Date.now() - t0 }); ev("browser.observed.launch", { pid: m, ppid: t.get(m)?.ppid, parentComm: comm(t.get(m)?.ppid), cmd: cmdHead(m) }); }
    for (const [m, v] of seenBrowsers) if (!v.exitedAt && !mains.includes(m) && !(t.get(m) && t.get(m)!.state !== "Z")) { v.exitedAt = Date.now() - t0; ev("browser.observed.exit", { pid: m, livedMs: v.exitedAt - v.launchedAt }); }
    const tasks = all.reduce((a, p) => a + p.threads, 0) + (t.get(process.pid)?.threads ?? 0);
    const rssMb = Math.round((all.reduce((a, p) => a + p.rssKb, 0) + (t.get(process.pid)?.rssKb ?? 0)) / 1024);
    const s = {
      at: Date.now() - t0, liveBrowsers: mains.length, tasks, procs: all.length + 1, jobChildren: __testing.liveChildren(),
      rssMb, pidsCurrent: readNum(`${CG}/pids.current`), pidsMax: readNum(`${CG}/pids.max`), permit: b.state(),
    };
    peakBrowsers = Math.max(peakBrowsers, s.liveBrowsers); peakTasks = Math.max(peakTasks, tasks); peakRssMb = Math.max(peakRssMb, rssMb); peakProcs = Math.max(peakProcs, s.procs);
    samples.push(s);
    if (samples.length % Math.max(1, Math.round(1000 / SAMPLE_MS)) === 0) log("SAMPLE", JSON.stringify(s));
  }, SAMPLE_MS);

  const results: Array<{ job: number; ok: boolean; startedAt: number; ms: number; error?: string; docs?: any[] }> = [];
  let next = 0;
  const runOne = async (job: number) => {
    const st = Date.now();
    log("JOB", `start job=${job}`);
    try {
      const r: any = await runPipelineIsolated({ company: { id: 1000 + job } as any, framework: { id: 1 } as any, measures: [], workspaceId: 1 } as any);
      results.push({ job, ok: !!r?.success, startedAt: st - t0, ms: Date.now() - st, error: r?.error, docs: r?.docs });
      log("JOB", `done job=${job} success=${r?.success} error=${r?.error ?? "-"} ms=${Date.now() - st}`);
    } catch (e: any) {
      results.push({ job, ok: false, startedAt: st - t0, ms: Date.now() - st, error: String(e?.message || e).slice(0, 300) });
      log("JOB", `FAILED job=${job} err=${String(e?.message || e).slice(0, 300)}`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, async () => { while (next < JOBS) await runOne(next++); }));
  await new Promise((r) => setTimeout(r, 1500));
  clearInterval(sampler);
  srv.close();

  const wallMs = Date.now() - t0 - 1500;
  // Per-document extraction: every expected document must have been requested
  // from the server, fetched without BrowserUnavailableError, and yield its marker.
  const expected = results.flatMap((r) => Array.from({ length: DOCS_PER_CHILD }, (_, i) => `job-${1000 + r.job}-doc-${i}`));
  const docRows = results.flatMap((r) => r.docs ?? []);
  const perDoc = expected.map((k) => { const d = docRows.find((x) => x.key === k); return { key: k, served: served.get(k) ?? 0, chars: d?.chars ?? 0, markerFound: !!d?.markerFound, skipped: d ? !!d.skipped : true, error: d?.error, fetchMs: d?.ms ?? null }; });
  const extraction = {
    expected: expected.length, markerFound: perDoc.filter((d) => d.markerFound).length,
    neverRequested: perDoc.filter((d) => d.served === 0).map((d) => d.key),
    skippedBrowserUnavailable: perDoc.filter((d) => d.skipped).map((d) => d.key),
    missingMarker: perDoc.filter((d) => !d.markerFound).map((d) => d.key),
  };
  // Browser admission wait (permit request → grant, parent broker) and permit
  // hold (grant → release: launch + fetch + close/reap inside the child).
  const stats = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); const pick = (f: number) => a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null; return { n: a.length, mean: a.length ? Math.round(a.reduce((p, q) => p + q, 0) / a.length) : null, p50: pick(0.5), p95: pick(0.95), max: a.length ? a[a.length - 1] : null, total: a.reduce((p, q) => p + q, 0) }; };
  const waits: number[] = [], holds: number[] = []; const pend: number[] = []; let grantAt: number[] = [];
  for (const e of events) {
    if (e.ev === "permit.acquire.request") pend.push(e.at);
    else if (e.ev === "permit.acquire.granted") { const r = pend.shift(); if (r != null) waits.push(e.at - r); grantAt.push(e.at); }
    else if (e.ev === "permit.release") { const g = grantAt.shift(); if (g != null) holds.push(e.at - g); }
  }
  const timing = { wallMs, admissionWaitMs: stats(waits), permitHoldMs: stats(holds), perDocFetchMs: stats(perDoc.map((d) => d.fetchMs ?? 0).filter((x) => x > 0)) };
  const spawnFailures = results.filter((r) => !r.ok && /exited unexpectedly|spawn|EAGAIN|pthread|uv_thread/i.test(r.error || "")).length;
  const summary = {
    label: LABEL, jobs: JOBS, concurrency: CONC, maxConcurrentBrowser: 1, holdMs: +process.env.REPRO_HOLD_MS!, docsPerChild: DOCS_PER_CHILD,
    limits: { nproc: nprocLimit(), cgroup: CG, pidsMax: readNum(`${CG}/pids.max`) },
    peak: { liveBrowsers: peakBrowsers, tasks: peakTasks, procs: peakProcs, rssMb: peakRssMb },
    bound_held: peakBrowsers <= 1,
    jobsOk: results.filter((r) => r.ok).length, jobsFailed: results.filter((r) => !r.ok).length, spawn_failures: spawnFailures,
    firstFailureJob: results.filter((r) => !r.ok).sort((a, b) => a.job - b.job)[0]?.job ?? null,
    browsersLaunched: seenBrowsers.size, extraction, timing, perDoc,
    all_documents_extracted: extraction.markerFound === extraction.expected && extraction.skippedBrowserUnavailable.length === 0,
    browserLifetimesMs: [...seenBrowsers.values()].map((v) => (v.exitedAt ?? Date.now() - t0) - v.launchedAt),
    finalBroker: __testing.brokerState(), quarantined: __testing.stats().quarantined,
    results: results.sort((a, b) => a.job - b.job), events, samples,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));
  log("SUMMARY", JSON.stringify({ ...summary, results: undefined, events: events.length, samples: samples.length, browserLifetimesMs: undefined }));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
