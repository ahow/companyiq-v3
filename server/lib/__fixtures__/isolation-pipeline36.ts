// 36-measure REAL runAnalysisPipeline(skipFetch) inside an isolated child, with
// in-memory pg stub + stub providers (same harness as scripts/profile-worker-blocking.ts).
import fs from "node:fs";

export async function runPipeline36(opts: any): Promise<any> {
  const corpus = JSON.parse(fs.readFileSync(process.env.FIXTURE_CORPUS || "/home/ubuntu/var_corpus/12.json", "utf8"))
    .filter((d: any) => d && typeof d.text === "string" && d.text.length > 50).slice(0, 40);
  const { pool } = await import("../../db.js");
  let fencedWrites = 0;
  (pool as any).query = async (q: any, vals?: any[]) => {
    const text = String(typeof q === "string" ? q : q?.text);
    const values = (typeof q === "object" && q?.values) || vals || [];
    if (/FROM documents d\s+LEFT JOIN document_content/i.test(text)) {
      const cid = Number(values[0]);
      const rows = corpus.map((d: any, i: number) => ({ id: cid * 100_000 + i, company_id: cid, url: d.url, title: d.title, type: /\.pdf/i.test(d.url) ? "pdf" : "html",
        gate_verdict: "accept", gate_reason: null, fetch_status: "ok", fetch_failures: 0, fetched_at: new Date(), created_at: new Date(), source_type: "first_party", content: d.text }));
      return { rows, rowCount: rows.length, fields: [], command: "SELECT" };
    }
    // Canonical fence lock (lockJobAndBatch): this attempt owns the job, batch running.
    if (/FOR UPDATE OF j FOR SHARE OF b/i.test(text)) { fencedWrites++; return { rows: [{ id: 77, batch_id: 1274, attempts: 1, job_status: "claimed", batch_status: "running" }], rowCount: 1, fields: [], command: "SELECT" }; }
    return { rows: [], rowCount: 0, fields: [], command: "SELECT" };
  };
  (pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });
  const { __setProvidersForTests } = await import("../ai-providers.js");
  let n = 0;
  const mk = (name: string, family: string) => ({ name, model: `${name}-stub`, family, isAvailable: () => true,
    complete: async (o: any) => { n++; await new Promise((r) => setTimeout(r, 50)); const m = String(o.prompt || "").slice(Math.floor(String(o.prompt || "").length * 0.55)).match(/[A-Z][^.\n]{140,320}\./);
      return JSON.stringify(m && n % 2 === 0 ? { score: 1, verdict: "Yes", confidence: "Medium", evidenceSummary: "Stub verbatim.", quotes: [{ text: m[0], source: "Doc" }] }
        : { score: 0, verdict: "No", confidence: "High", evidenceSummary: "No relevant disclosure.", quotes: [] }); } });
  __setProvidersForTests([["deepseek", "deepseek"], ["claude", "anthropic"], ["openrouter", "openrouter"], ["gemini", "google"], ["openai", "openai"], ["mistral", "mistral"],
    ["claude-arbiter", "anthropic"], ["gpt5-arbiter", "openai"], ["mistral-arbiter", "mistral"], ["gpt-4o-mini", "openai"], ["kimi", "moonshot"], ["glm-4.6", "zhipu"]].map(([a, b]) => mk(a, b)) as any);
  const { runAnalysisPipeline } = await import("../pipeline.js");
  const res: any = await runAnalysisPipeline(opts);
  const all = (res?.analysis?.categories ?? []).flatMap((c: any) => c.measures);
  return { success: res.success, error: res.error, documentsProcessed: res.documentsProcessed, documentsFresh: 0, documentsCached: 0, measures: all.length, providerCalls: n, fencedWrites };
}
