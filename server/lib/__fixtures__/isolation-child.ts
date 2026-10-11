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
  throw new Error("unknown FIXTURE_MODE " + mode);
}
