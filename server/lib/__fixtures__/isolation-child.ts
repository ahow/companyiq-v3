// Test fixture loaded INSIDE an isolated job child via CIQ_CHILD_TEST_MODULE.
// Behaviour selected by FIXTURE_MODE (inherited env). No network.
import { spawn } from "node:child_process";
import fs from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (extra: any = {}) => ({ success: true, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0, ...extra });

export async function run(opts: any, h: { isCancelled: () => boolean; lifecycle: any }): Promise<any> {
  const mode = process.env.FIXTURE_MODE;
  if (mode === "busy") {
    const end = Date.now() + 3000;
    while (Date.now() < end) { /* synchronous CPU, 3 s */ }
    return ok({ pid: process.pid });
  }
  if (mode === "cancel") {
    for (let i = 0; i < 200; i++) { if (h.isCancelled()) return { success: false, error: "Cancelled", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 }; await sleep(50); }
    return ok();
  }
  if (mode === "ignore-revoke") {
    const g = spawn("sleep", ["300"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FIXTURE_PIDFILE!, JSON.stringify({ child: process.pid, grandchild: g.pid }));
    process.on("SIGTERM", () => { /* ignore: force SIGKILL escalation */ });
    await new Promise(() => {});
  }
  if (mode === "crash") {
    const { __llmSlotForTests } = await import("../ai-providers.js");
    await __llmSlotForTests.acquire(); // hold a brokered permit, never release
    await sleep(100);
    process.exit(1);
  }
  if (mode === "permits") {
    const { __llmSlotForTests } = await import("../ai-providers.js");
    const { processorSlotBroker } = await import("../processor.js");
    await Promise.all([
      ...Array.from({ length: 5 }, async () => { await __llmSlotForTests.acquire(); await sleep(150); __llmSlotForTests.release(); }),
      (async () => { await processorSlotBroker.browser.acquire(); await sleep(150); processorSlotBroker.browser.release(); })(),
    ]);
    return ok();
  }
  if (mode === "usage") {
    const { recordLlmUsage, __usageBufferLengthForTests } = await import("../llm-usage.js");
    recordLlmUsage({ raw: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: "stub-1", provider: "stub" });
    return ok({ childBuffer: __usageBufferLengthForTests(), pgMax: process.env.PG_POOL_MAX });
  }
  if (mode === "provider-error") {
    const { ProviderScoringError } = await import("../credit-breaker.js");
    throw new ProviderScoringError("deepseek", "quota_exhausted", "stub quota");
  }
  if (mode === "pipeline36") return (await import("./isolation-pipeline36.js")).runPipeline36(opts);

  // ── Gap B/C: a pipeline that never yields (sync loop) or never settles (async hang),
  // with a same-group grandchild (pdftotext-like) and a DETACHED registered
  // descendant (Chromium-like, own process group).
  if (mode === "block-forever" || mode === "hang") {
    const g = spawn("sleep", ["300"], { stdio: "ignore" });
    const d = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
    const { registerDescendantGroup } = await import("../isolation-ipc.js");
    registerDescendantGroup(d.pid);
    await sleep(200); // let the pgroup IPC message flush before the loop starves us
    writePids({ child: process.pid, grandchild: g.pid, detached: d.pid });
    if (mode === "hang") await new Promise(() => {});
    for (;;) { /* synchronous CPU forever */ }
  }
  // ── Gap B: keeps "dispatching" (stamping a file) and ignores cancel/revoke/SIGTERM.
  if (mode === "dispatch-loop") {
    process.on("SIGTERM", () => {});
    writePids({ child: process.pid });
    const f = process.env.FIXTURE_STAMPFILE!;
    for (;;) { fs.writeFileSync(f, String(Date.now())); await sleep(10); }
  }
  // ── Gap E: reports success while background work (a grandchild holding a
  // brokered proc permit + a live interval) is still running, and never exits.
  if (mode === "background-alive") {
    const { processorSlotBroker } = await import("../processor.js");
    await processorSlotBroker.proc.acquire();
    const g = spawn("sleep", ["300"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
    (process as any).exit = () => {}; // job-child's post-result exit is suppressed
    writePids({ child: process.pid, grandchild: g.pid });
    await sleep(100);
    return ok({ pid: process.pid });
  }
  // ── Gap E: queued (blocked) LLM acquisition withdrawn by abort.
  if (mode === "queued-cancel" || mode === "queued-crash") {
    const { __llmSlotForTests } = await import("../ai-providers.js");
    const { remotePermitState } = await import("../isolation-ipc.js");
    for (let i = 0; i < 8; i++) await __llmSlotForTests.acquire();
    const ac = new AbortController();
    const queued = __llmSlotForTests.acquire(ac.signal).then(() => "granted", (e: any) => "rejected:" + (e?.name || e?.message));
    await sleep(300); // parent broker now has 8 active + 1 waiting
    if (mode === "queued-crash") process.exit(3);
    ac.abort();
    const outcome = await queued;
    const afterAbort = remotePermitState();
    await sleep(300); // parent must show waiting=0 while the 8 are still held
    for (let i = 0; i < 8; i++) __llmSlotForTests.release();
    await sleep(50);
    return ok({ outcome, afterAbort, final: remotePermitState() });
  }
  // ── Gap E: subprocess permits are per-replica (baseline 6), not per child.
  if (mode === "procs") {
    const { processorSlotBroker } = await import("../processor.js");
    await Promise.all(Array.from({ length: 4 }, async () => { await processorSlotBroker.proc.acquire(); await sleep(200); processorSlotBroker.proc.release(); }));
    return ok();
  }
  // ── Gap F: what does the child actually create? Resources at entry (after
  // job-child startup) and after importing the real pipeline module graph.
  if (mode === "boot-audit") {
    const atEntry = process.getActiveResourcesInfo();
    const loaded: string[] = [];
    const mod: any = await import("node:module");
    mod.registerHooks?.({ resolve: (spec: string, ctx: any, next: any) => { const r = next(spec, ctx); loaded.push(r.url); return r; } });
    await import("../pipeline.js");
    await sleep(300);
    const { pool } = await import("../../db.js");
    // net.Socket wraps both stdio pipes and TCP connections: report the native handle + fd/peer.
    const handles = (process as any)._getActiveHandles().map((h: any) =>
      `${h?.constructor?.name}/${h?._handle?.constructor?.name ?? "-"}${h?.fd !== undefined ? "/fd" + h.fd : ""}${h?.remoteAddress ? "/peer=" + h.remoteAddress + ":" + h.remotePort : ""}`);
    const llm: any = await import("../llm-usage.js");
    return ok({
      atEntry, afterPipelineImport: process.getActiveResourcesInfo(), handles, hooks: typeof mod.registerHooks,
      loaded: loaded.filter((u) => u.startsWith("file:") && !u.includes("/node_modules/")).map((u) => u.replace(/^.*\/companyiq-v3\//, "")),
      loadedPkgs: [...new Set(loaded.filter((u) => u.includes("/node_modules/")).map((u) => u.split("/node_modules/").pop()!.split("/")[0]))],
      pgTotal: pool.totalCount, usagePool: llm.__usagePoolCreatedForTests(), redisUrl: process.env.REDIS_URL ?? null,
    });
  }
  // ── FIX 2 ordering barrier: report only when the test creates FIXTURE_GO.
  // FIXTURE_SAWCANCEL is written once the child observes cancel/revoke;
  // FIXTURE_LINGER keeps the child alive after reporting (exit suppressed).
  if (mode === "report-on-go") {
    writePids({ child: process.pid });
    const go = process.env.FIXTURE_GO!, saw = process.env.FIXTURE_SAWCANCEL;
    for (;;) {
      if (saw && h.isCancelled() && !fs.existsSync(saw)) fs.writeFileSync(saw, String(Date.now()));
      if (fs.existsSync(go)) break;
      await sleep(10);
    }
    if (process.env.FIXTURE_LINGER === "1") { (process as any).exit = () => {}; setInterval(() => {}, 1000); }
    return ok({ pid: process.pid, cancelledAtReport: h.isCancelled() });
  }
  // ── FIX 1: hold a browser permit (never released) and report success.
  if (mode === "hold-browser") {
    const { processorSlotBroker } = await import("../processor.js");
    await processorSlotBroker.browser.acquire();
    writePids({ child: process.pid });
    return ok({ pid: process.pid });
  }
  // ── FIX 1: register a process group that holds only an unreaped zombie.
  if (mode === "zombie-group") {
    const { registerDescendantGroup } = await import("../isolation-ipc.js");
    registerDescendantGroup(Number(process.env.FIXTURE_ZOMBIE_PGID));
    await sleep(100);
    return ok({ pid: process.pid });
  }
  throw new Error("unknown FIXTURE_MODE " + mode);
}

function writePids(o: any): void {
  fs.writeFileSync(process.env.FIXTURE_PIDFILE!, JSON.stringify(o));
}
