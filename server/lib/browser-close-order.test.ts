/**
 * Close-before-release ordering (opt-in; needs a local Chromium, no DB writes,
 * no Redis, zero paid calls).
 *
 * Runs REAL isolated job children (runPipelineIsolated → job-child.ts →
 * __fixtures__/browser-close-order-child.ts) that drive the production browser
 * call sites (fetchPdfViaBrowser, fetchIssuerPdfsWithPrimedSession) against a
 * local HTTP server. The parent wraps the replica browser-permit broker and, at
 * the exact instant each permit returns, scans /proc for any live (non-zombie)
 * Chromium process holding a puppeteer profile. Invariant on every exit path:
 *
 *     work stopped → Chromium closed → termination confirmed → permit returned
 *
 * Paths: success, fetch failure (connection reset; direct + pdfRecovery),
 * cancellation (in-flight, post-acquire refusal, pre-acquire refusal), and child
 * death (pipeline deadline → SIGKILL → parent group reap → releaseAll).
 *
 *   npx tsx server/lib/browser-close-order.test.ts
 * Skips (exit 0) when Chromium is missing unless CLOSE_ORDER_REQUIRED=1.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { markerPdf, markerFor } from "./__fixtures__/marker-pdf.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium";
Object.assign(process.env, {
  WORKER_ISOLATION_ENABLED: "true",
  CIQ_CHILD_TEST_MODULE: path.join(HERE, "__fixtures__/browser-close-order-child.ts"),
  PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
  PIPELINE_TIMEOUT_MS: "60000",
});

/** Live (non-zombie) processes holding a puppeteer profile, anywhere on the box. */
function liveChromium(): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      if (st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3) === "Z") continue;
      if (fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("puppeteer_dev_chrome_profile")) out.push(+d);
    } catch { /* exited */ }
  }
  return out;
}

if (!fs.existsSync(CHROMIUM)) {
  if (process.env.CLOSE_ORDER_REQUIRED === "1") throw new Error(`chromium missing at ${CHROMIUM}`);
  console.log(`SKIP browser-close-order: chromium missing at ${CHROMIUM}`);
} else {
  const pre = liveChromium();
  const { runPipelineIsolated, __testing } = await import("./job-isolation.js");
  const { processorSlotBroker } = await import("./processor.js");

  // ── permit instrumentation: record live Chromium at every grant / return ──
  const b = processorSlotBroker.browser;
  const rawAcquire = b.acquire.bind(b), rawRelease = (b.release as any).bind(b);
  const log: Array<{ ev: "grant" | "release"; at: number; liveChromium: number[] }> = [];
  (b as any).acquire = async () => { await rawAcquire(); log.push({ ev: "grant", at: Date.now(), liveChromium: liveChromium().filter((p) => !pre.includes(p)) }); };
  (b as any).release = (...a: any[]) => { log.push({ ev: "release", at: Date.now(), liveChromium: liveChromium().filter((p) => !pre.includes(p)) }); return rawRelease(...a); };

  // ── local server ──
  const okPdf = (k: string) => markerPdf([markerFor(k), "close-order synthetic document"]);
  const sockets = new Set<any>();
  const srv = http.createServer((q, r) => {
    const u = q.url || "/";
    const send = (buf: Buffer) => { r.writeHead(200, { "content-type": "application/pdf", "content-length": buf.length }); r.end(buf); };
    if (/^\/ok-\d+\.pdf/.test(u)) return send(okPdf(u.slice(1, -4)));
    if (u.startsWith("/slow.pdf")) return void setTimeout(() => send(okPdf("slow")), 2500);
    if (u.startsWith("/reset.pdf")) return void q.socket.destroy();
    if (u.startsWith("/hang.pdf")) return; // never answers
    r.writeHead(200, { "content-type": "text/html" }); r.end("<html><body>issuer home</body></html>");
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  process.env.CLOSE_ORDER_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;

  const runMode = async (mode: string, extra: Record<string, any> = {}) => {
    process.env.CLOSE_ORDER_MODE = mode;
    const from = log.length;
    let res: any, err: any;
    try { res = await runPipelineIsolated({ company: { id: 7000 } as any, framework: { id: 1 } as any, measures: [], workspaceId: 1, ...extra } as any); }
    catch (e) { err = e; }
    // permits may return asynchronously after the child settles (parent reap)
    for (let i = 0; i < 100 && __testing.brokerState().browser?.active; i++) await new Promise((r) => setTimeout(r, 100));
    return { res, err, events: log.slice(from) };
  };
  const assertCloseBeforeRelease = (events: typeof log, minReleases: number) => {
    const rel = events.filter((e) => e.ev === "release");
    assert.ok(rel.length >= minReleases, `expected ≥${minReleases} permit returns, got ${rel.length}`);
    for (const e of rel) assert.deepEqual(e.liveChromium, [], `permit returned while Chromium still alive: ${e.liveChromium}`);
    assert.equal(events.filter((e) => e.ev === "grant").length, rel.length, "every grant returned exactly once");
    const bs = __testing.brokerState();
    assert.equal(bs.browser?.active ?? 0, 0, `broker not drained: ${JSON.stringify(bs)}`);
    assert.equal(__testing.stats().quarantined, 0, "no quarantine expected");
  };

  test("success path: extracted marker; Chromium gone before the permit returns", async () => {
    const { res, err, events } = await runMode("success");
    assert.equal(err, undefined);
    const r = res.closeOrder.fetchPdfViaBrowser;
    assert.equal(r.ok, true); assert.match(r.text, new RegExp(markerFor("ok-0")));
    assertCloseBeforeRelease(events, 1);
  });

  test("fetch-failure path (connection reset; direct + pdfRecovery): close before release", async () => {
    const { res, err, events } = await runMode("failure");
    assert.equal(err, undefined);
    assert.equal(res.closeOrder.fetchPdfViaBrowser.chars ?? 0, 0, "reset must not yield text");
    assertCloseBeforeRelease(events, 2);
  });

  test("cancellation path (in-flight / post-acquire refusal / pre-acquire refusal): close before release", async () => {
    // Cancel only once A demonstrably holds the permit (first grant + 600 ms,
    // i.e. Chromium launched and A is waiting on the 2.5 s slow document).
    const outFile = `/tmp/close-order-cancel-${process.pid}.json`;
    fs.rmSync(outFile, { force: true });
    process.env.CLOSE_ORDER_OUT = outFile;
    const from = log.length;
    const cancelCheck = () => { const g = log.slice(from).find((e) => e.ev === "grant"); return !!g && Date.now() - g.at > 600; };
    const { res, err, events } = await runMode("cancel", { batchId: 990001, cancelCheck });
    delete process.env.CLOSE_ORDER_OUT;
    assert.ok(res || err, "settled");
    const c = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(c.A_inflight.ok, true, `A (in flight at cancel) completed its fetch: ${JSON.stringify(c.A_inflight)}`);
    assert.match(String(c.B_postAcquire.error), /BrowserUnavailableError: lifecycle cancelled/, "B refused after acquiring");
    assert.match(String(c.C_preAcquire.error), /BrowserUnavailableError: lifecycle cancelled/, "C refused before acquiring");
    assertCloseBeforeRelease(events, 2); // A's permit + B's post-acquire permit
  });

  test("child-death path (pipeline deadline → SIGKILL while holding the permit): parent reap before release", async () => {
    process.env.PIPELINE_TIMEOUT_MS = "6000";
    try {
      const { res, err, events } = await runMode("kill");
      assert.ok(err || res?.success === false, "deadline must fail the job");
      assertCloseBeforeRelease(events, 1);
    } finally { process.env.PIPELINE_TIMEOUT_MS = "60000"; }
  });

  test.after(() => { for (const s of sockets) s.destroy(); srv.close(); });
}
