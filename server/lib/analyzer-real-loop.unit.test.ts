/**
 * Drives the REAL analyzeCompanyMeasures (server/lib/analyzer.ts) end to end —
 * settings load, corpus hygiene, chunking/retrieval, evidence packs, the real
 * MEASURE_CONCURRENCY=5 batch loop with its assertDispatchAllowed gate, the real
 * scoring functions and completeScoring — for a 36-measure framework inside a
 * live (never revoked) worker attempt context.
 * No DB / network / paid calls: the provider registry is replaced with in-process
 * mocks (__setProvidersForTests) and the pg pool's query() is replaced with an
 * in-memory stub returning zero rows (settings → defaults, no verdict cache,
 * no cached summary; cacheSummary insert is a no-op).
 * Run: DATABASE_URL=<any pg url; not connected> npx tsx server/lib/analyzer-real-loop.unit.test.ts
 */
process.exitCode = 1;
const keepAlive = setInterval(() => {}, 1000);

import { getEventListeners } from "node:events";
import { pool } from "../db.js";
import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import { createAttemptLifecycle, registerBatchCancelSource } from "./lifecycle-fence.js";
import { __setProvidersForTests, __llmSlotForTests, type AIProvider } from "./ai-providers.js";
import { analyzeCompanyMeasures } from "./analyzer.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}

// In-memory DB stub: every query returns zero rows (no connection is opened).
const sqlSeen: string[] = [];
(pool as any).query = async (q: any) => {
  sqlSeen.push(String(typeof q === "string" ? q : q?.text).slice(0, 60));
  return { rows: [], rowCount: 0, fields: [], command: "SELECT" };
};

const NO_JSON = JSON.stringify({ score: 0, verdict: "No", confidence: "High", evidenceSummary: "No relevant disclosure in the provided passages.", quotes: [] });
interface Mock extends AIProvider { calls: number; scoringCalls: number; signals: Array<AbortSignal | undefined>; aborted: number }
function mk(name: string, family: string): Mock {
  const m: Mock = {
    name, model: `${name}-model`, family, calls: 0, scoringCalls: 0, signals: [], aborted: 0,
    isAvailable: () => true,
    complete: async (opts: any) => {
      m.calls++;
      m.signals.push(opts.signal);
      if (opts.signal) { m.scoringCalls++; opts.signal.addEventListener("abort", () => { m.aborted++; }, { once: true }); }
      return NO_JSON;
    },
  };
  return m;
}

async function main() {
  process.env.LLM_USAGE_LOGGING_ENABLED = "false";
  process.env.SCORING_STRICT_PROVIDER = "true";
  process.env.SCORING_REQ_LOG = "off";
  process.env.PROVIDER_FALLBACK_ORDER = "deepseek";
  process.env.RETRIEVAL_SEMANTIC_HYBRID = "false";
  registerBatchCancelSource(() => false);

  const names: Array<[string, string]> = [["deepseek", "deepseek"], ["claude", "anthropic"], ["openrouter", "openrouter"], ["gemini", "google"], ["openai", "openai"],
    ["mistral", "mistral"], ["claude-arbiter", "anthropic"], ["gpt5-arbiter", "openai"], ["mistral-arbiter", "mistral"], ["gpt-4o-mini", "openai"], ["kimi", "moonshot"], ["glm-4.6", "zhipu"]];
  const mocks = names.map(([n, f]) => mk(n, f));
  const restore = __setProvidersForTests(mocks);

  const framework: any = { id: 9001, workspaceId: 1, name: "Test framework", topicDescription: "Corporate governance disclosure", version: 1, isActive: true };
  const measures: any[] = Array.from({ length: 36 }, (_, i) => ({
    id: i + 1, frameworkId: 9001, measureId: `M${String(i + 1).padStart(2, "0")}`,
    category: `Category ${Math.floor(i / 12) + 1}`, categoryNumber: Math.floor(i / 12) + 1,
    title: `Measure ${i + 1} board oversight disclosure`, definition: `The company discloses board oversight item ${i + 1}.`,
    scoringGuidance: null, evidenceKeywords: ["board", "oversight"], requiredSourceTypes: null, displayOrder: i + 1,
  }));
  const doc = Array.from({ length: 60 }, (_, i) => `Section ${i + 1}. The board of directors reviews oversight matters annually and reports to shareholders on governance item ${i + 1}.`).join("\n\n");

  const lifecycle = createAttemptLifecycle({ jobId: 701, batchId: 55, attemptNumber: 1, deadlineAt: null, attemptToken: "33333333-3333-4333-8333-333333333333" });
  const ctx: DiagContext = { batchId: 55, jobId: 701, attemptNumber: 1, companyId: 123, lifecycle };
  let result: any, err: any = null;
  const t0 = Date.now();
  try {
    result = await runWithDiagContext(ctx, () => analyzeCompanyMeasures({
      workspaceId: 1, companyName: "TestCo", companyId: 123,
      documentTexts: [doc], documentUrls: ["https://example.invalid/annual-report-2025.pdf"], documentTitles: ["Annual Report 2025"],
      framework, measures, freshScoring: true,
    }));
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  const all = (result?.categories ?? []).flatMap((c: any) => c.measures);
  const scoring = mocks.reduce((a, m) => a + m.scoringCalls, 0);
  const aborted = mocks.reduce((a, m) => a + m.aborted, 0);
  console.log(`  info: ${ms}ms, provider calls=${mocks.map((m) => `${m.name}:${m.calls}`).filter((s) => !s.endsWith(":0")).join(" ")}, sql stubbed=${sqlSeen.length}`);
  check("real analyzeCompanyMeasures completed without error", err == null, err?.stack?.split("\n").slice(0, 4));
  check("36 measures returned", all.length === 36 && result?.measuresTotal === 36, { n: all.length, total: result?.measuresTotal });
  check("all 36 genuinely scored (none abstained / 'Scoring error')", all.length === 36 && all.every((m: any) => !m.abstained && m.verdict !== "Scoring error"), all.filter((m: any) => m.abstained).map((m: any) => `${m.measureId}:${m.verdict}`));
  check("scoring went through completeScoring with an attempt signal (≥36 signalled provider calls)", scoring >= 36, scoring);
  check("gates inert: attempt not revoked, zero aborts", !lifecycle.revoked && !lifecycle.abort.signal.aborted && aborted === 0, { revoked: lifecycle.revoked, aborted });
  check("no abort listeners left on the shared controller", getEventListeners(lifecycle.abort.signal, "abort").length === 0, getEventListeners(lifecycle.abort.signal, "abort").length);
  check("LLM slot pool back to idle (no permit leak)", __llmSlotForTests.state().active === 0 && __llmSlotForTests.state().waiting === 0, __llmSlotForTests.state());

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
