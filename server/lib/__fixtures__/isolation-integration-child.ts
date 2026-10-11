// Integration child module (loaded by job-child.ts via CIQ_CHILD_TEST_MODULE).
// Runs inside a REAL isolated job child against REAL Postgres:
//   1. fetchPdfViaBrowser(INT_PDF_URL): real shared Chromium (permit brokered by
//      the parent, process group registered for reaping) + real pdftotext.
//   2. holds INT_HOLD_MS so concurrent children overlap (peak sampling, lock renewal).
//   3. real runAnalysisPipeline(skipFetch/skipDiscovery) on the seeded corpus.
// Only the LLM providers are stubbed (no paid calls); everything else is production code.
export async function run(opts: any): Promise<any> {
  const { __setProvidersForTests } = await import("../ai-providers.js");
  let n = 0;
  const mk = (name: string, family: string) => ({ name, model: `${name}-stub`, family, isAvailable: () => true,
    complete: async (o: any) => { n++; await new Promise((r) => setTimeout(r, 20)); const p = String(o.prompt || ""); const m = p.slice(Math.floor(p.length * 0.55)).match(/[A-Z][^.\n]{140,320}\./);
      return JSON.stringify(m && n % 2 === 0 ? { score: 1, verdict: "Yes", confidence: "Medium", evidenceSummary: "Stub verbatim.", quotes: [{ text: m[0], source: "Doc" }] }
        : { score: 0, verdict: "No", confidence: "High", evidenceSummary: "No relevant disclosure.", quotes: [] }); } });
  __setProvidersForTests([["deepseek", "deepseek"], ["claude", "anthropic"], ["openrouter", "openrouter"], ["gemini", "google"], ["openai", "openai"], ["mistral", "mistral"],
    ["claude-arbiter", "anthropic"], ["gpt5-arbiter", "openai"], ["mistral-arbiter", "mistral"], ["gpt-4o-mini", "openai"], ["kimi", "moonshot"], ["glm-4.6", "zhipu"]].map(([a, b]) => mk(a, b)) as any);

  const { fetchPdfViaBrowser } = await import("../processor.js");
  const t0 = Date.now();
  const pdfText = await fetchPdfViaBrowser(String(process.env.INT_PDF_URL));
  console.log(`[INT-CHILD pid=${process.pid}] browser-pdf chars=${pdfText.length} ms=${Date.now() - t0} marker=${pdfText.includes("CIQ-INTEGRATION-MARKER")}`);
  await new Promise((r) => setTimeout(r, parseInt(process.env.INT_HOLD_MS || "20000", 10)));

  const { runAnalysisPipeline } = await import("../pipeline.js");
  const res = await runAnalysisPipeline(opts);
  console.log(`[INT-CHILD pid=${process.pid}] pipeline success=${res.success} docs=${res.documentsProcessed} providerCalls=${n} error=${res.error ?? ""}`);
  return res;
}
