/**
 * PROFILE HARNESS — worker event-loop blocking (fix/worker-isolation, Phase 1).
 *
 * Drives the REAL worker CPU paths on SAVED corpora with ZERO network and ZERO
 * paid calls, at production-like in-process concurrency (default 4 companies
 * concurrently = WORKER_CONCURRENCY=4), and measures how the main event loop
 * is blocked:
 *
 *   Phase A "fetch-extract": the processor's synchronous extraction libraries
 *     on real corpus text — pdf-parse on locally generated PDFs (reportlab, from
 *     the saved document text) + normaliseTableHorizonMarkers (the exact pdf-parse
 *     path in processor.extractTextFromPdf) and cheerio HTML extraction.
 *   Phase B "analyze": the REAL runAnalysisPipeline(skipFetch=true) →
 *     runAnalyzePhase → analyzeCompanyMeasures (hygiene, boilerplate, chunking,
 *     BM25, evidence packs, prompt build, scoring parse, quote provenance /
 *     evidence gate, score aggregation) for a real 29-measure framework
 *     (var_measures.json) padded to 36 measures, with saved document text
 *     served by an in-memory pg stub.
 *
 * Instrumentation: perf_hooks.monitorEventLoopDelay (per phase), a 50ms
 * lag probe that records each stall and the diag stage(s) active at the time,
 * and node --cpu-prof (parsed by analyze-cpuprofile.ts).
 *
 * Run (see docs/worker-isolation/PROFILE_EVIDENCE.md):
 *   DATABASE_URL=postgres://stub@127.0.0.1:1/stub node --cpu-prof --cpu-prof-dir=/tmp/ciq-prof \
 *     --import tsx server/scripts/profile-worker-blocking.ts
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";

// ── Zero-network guard (installed BEFORE app modules load) ──────────────────
const blockedNet: string[] = [];
const deny = (what: string) => (...args: any[]) => {
  const a = args[0];
  blockedNet.push(`${what}:${typeof a === "string" ? a : a?.hostname || a?.host || a?.href || "?"}`);
  throw new Error(`[profile-harness] network disabled (${what})`);
};
(http as any).request = deny("http.request"); (http as any).get = deny("http.get");
(https as any).request = deny("https.request"); (https as any).get = deny("https.get");
(net as any).connect = deny("net.connect"); (net as any).createConnection = deny("net.createConnection");
(globalThis as any).fetch = async (u: any) => { blockedNet.push(`fetch:${String(u)}`); throw new Error("[profile-harness] network disabled (fetch)"); };

Object.assign(process.env, {
  LLM_USAGE_LOGGING_ENABLED: "false", SCORING_STRICT_PROVIDER: "true", SCORING_REQ_LOG: "off",
  PROVIDER_FALLBACK_ORDER: "deepseek", RETRIEVAL_SEMANTIC_HYBRID: "false", DIAG_DB_INSTRUMENTATION: "false",
  LLM_MAX_CONCURRENCY: process.env.LLM_MAX_CONCURRENCY || "8",
});

const CONCURRENCY = parseInt(process.env.PROFILE_CONCURRENCY || "4", 10);
const CORPORA = (process.env.PROFILE_CORPORA || "12,11,18,14").split(",");
const PROVIDER_LATENCY_MS = parseInt(process.env.PROFILE_PROVIDER_LATENCY_MS || "400", 10);
const OUT = process.env.PROFILE_OUT || "/tmp/ciq-prof/harness-result.json";
const PHASES = (process.env.PROFILE_PHASES || "extract,analyze").split(",");

const { pool } = await import("../db.js");
const { runWithDiagContext, getDiagContext } = await import("../lib/diag-context.js");
const { createAttemptLifecycle, registerBatchCancelSource } = await import("../lib/lifecycle-fence.js");
const { __setProvidersForTests } = await import("../lib/ai-providers.js");
const { runAnalysisPipeline } = await import("../lib/pipeline.js");
const { normaliseTableHorizonMarkers } = await import("../lib/table-horizon-normaliser.js");
const cheerio = await import("cheerio");
const pdfParse = (await import("pdf-parse")).default as any;

registerBatchCancelSource(() => false);

// ── Saved inputs ────────────────────────────────────────────────────────────
interface Doc { url: string; title: string; text: string }
function loadCorpus(id: string): Doc[] {
  const p = `/home/ubuntu/var_corpus/${id}.json`;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return (raw as any[]).filter((d) => d && typeof d.text === "string" && d.text.length > 50);
}
const savedMeasures: any[] = JSON.parse(fs.readFileSync("/home/ubuntu/var_measures.json", "utf8"));
const savedFramework: any = JSON.parse(fs.readFileSync("/home/ubuntu/var_framework.json", "utf8"));
const camel = (m: any, i: number) => ({
  id: m.id ?? i + 1, frameworkId: 9001, measureId: m.measure_id ?? m.measureId, category: m.category,
  categoryNumber: m.category_number ?? m.categoryNumber ?? 1, title: m.title, definition: m.definition ?? "",
  scoringGuidance: m.scoring_guidance ?? m.scoringGuidance ?? null, evidenceKeywords: m.evidence_keywords ?? m.evidenceKeywords ?? null,
  requiredSourceTypes: m.required_source_types ?? null, displayOrder: i + 1, scoringMode: m.scoring_mode ?? m.scoringMode ?? undefined,
});
const measures36 = Array.from({ length: 36 }, (_, i) => {
  const base = camel(savedMeasures[i % savedMeasures.length], i);
  return i < savedMeasures.length ? base : { ...base, id: 10_000 + i, measureId: `${base.measureId}-dup${i}` };
});
const framework = {
  id: 9001, workspaceId: 1, name: savedFramework.name, topicDescription: savedFramework.topic_description ?? savedFramework.topicDescription,
  version: 1, isActive: true,
};

// ── In-memory pg stub: document reads return saved corpus, everything else 0 rows ──
const corpusByCompany = new Map<number, Doc[]>();
let sqlCount = 0;
(pool as any).query = async (q: any, vals?: any[]) => {
  sqlCount++;
  const text = String(typeof q === "string" ? q : q?.text);
  const values = (typeof q === "object" && q?.values) || vals || [];
  if (/FROM documents d\s+LEFT JOIN document_content/i.test(text)) {
    const cid = Number(values[0]);
    const docs = corpusByCompany.get(cid) ?? [];
    const rows = docs.map((d, i) => ({
      id: cid * 100_000 + i, company_id: cid, url: d.url, title: d.title, type: /\.pdf/i.test(d.url) ? "pdf" : "html",
      gate_verdict: "accept", gate_reason: null, fetch_status: "ok", fetch_failures: 0, fetched_at: new Date(), created_at: new Date(),
      source_type: "first_party", content: d.text,
    }));
    return { rows, rowCount: rows.length, fields: [], command: "SELECT" };
  }
  return { rows: [], rowCount: 0, fields: [], command: "SELECT" };
};
// db.transaction() (fenced score write) checks out a client: hand back the same stub.
(pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });

// ── Stub providers: async latency + a verbatim quote lifted from the prompt ──
let providerCalls = 0;
function mk(name: string, family: string) {
  return {
    name, model: `${name}-stub`, family, isAvailable: () => true,
    complete: async (opts: any) => {
      providerCalls++;
      await new Promise((r) => setTimeout(r, PROVIDER_LATENCY_MS));
      const p: string = opts.prompt || "";
      // Pick a sentence-ish span from the passages so quote provenance / evidence
      // gate run their real verification path.
      const m = p.slice(Math.floor(p.length * 0.55)).match(/[A-Z][^.\n]{140,320}\./);
      const yes = !!m && (providerCalls % 2 === 0);
      return JSON.stringify(yes
        ? { score: 1, verdict: "Yes", confidence: "Medium", evidenceSummary: "Stub verdict citing a verbatim passage.", quotes: [{ text: m![0], source: "Doc" }] }
        : { score: 0, verdict: "No", confidence: "High", evidenceSummary: "No relevant disclosure in the provided passages.", quotes: [] });
    },
  };
}
const names: Array<[string, string]> = [["deepseek", "deepseek"], ["claude", "anthropic"], ["openrouter", "openrouter"], ["gemini", "google"], ["openai", "openai"],
  ["mistral", "mistral"], ["claude-arbiter", "anthropic"], ["gpt5-arbiter", "openai"], ["mistral-arbiter", "mistral"], ["gpt-4o-mini", "openai"], ["kimi", "moonshot"], ["glm-4.6", "zhipu"]];
__setProvidersForTests(names.map(([n, f]) => mk(n, f)) as any);

// ── Lag probe: records every stall > 100ms with the stage(s) active ─────────
const activeStages = new Map<string, string>();
const stalls: Array<{ at: number; lagMs: number; phase: string; stages: string[] }> = [];
let currentPhase = "boot";
const PROBE_MS = 50;
let last = performance.now();
const probe = setInterval(() => {
  const now = performance.now();
  const lag = now - last - PROBE_MS;
  last = now;
  if (lag > 100) stalls.push({ at: Math.round(now), lagMs: Math.round(lag), phase: currentPhase, stages: [...new Set(activeStages.values())] });
}, PROBE_MS);

function eldSnapshot(h: ReturnType<typeof monitorEventLoopDelay>) {
  const ms = (n: number) => Math.round(n / 1e6);
  return { p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)), max: ms(h.max), mean: Math.round(h.mean / 1e6), count: h.count };
}
async function runPool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const result: any = { concurrency: CONCURRENCY, corpora: CORPORA, providerLatencyMs: PROVIDER_LATENCY_MS, phases: {} };
const corpora = CORPORA.map((id) => ({ id, docs: loadCorpus(id) }));
for (const c of corpora) console.log(`[harness] corpus ${c.id}: ${c.docs.length} docs, ${(c.docs.reduce((a, d) => a + d.text.length, 0) / 1e6).toFixed(1)}M chars`);

// ── Phase A: fetch-extract (pdf-parse + horizon normaliser, cheerio) ───────
if (PHASES.includes("extract")) {
  currentPhase = "extract";
  const pdfDir = "/tmp/ciq-prof/pdfs";
  fs.mkdirSync(pdfDir, { recursive: true });
  // Build up to 2 real PDFs per corpus from the largest saved document texts
  // (capped at 400k chars each — a ~150-page report). Generated OUTSIDE the
  // measured window (python/reportlab subprocess).
  const pdfJobs: Array<{ corpus: string; file: string; chars: number }> = [];
  for (const c of corpora) {
    const big = [...c.docs].sort((a, b) => b.text.length - a.text.length).slice(0, 2);
    big.forEach((d, k) => {
      const file = `${pdfDir}/${c.id}-${k}.pdf`;
      if (!fs.existsSync(file)) {
        const txt = `${pdfDir}/${c.id}-${k}.txt`;
        fs.writeFileSync(txt, d.text.slice(0, 400_000));
        execFileSync("python3", ["-c", `
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
src, out = sys.argv[1], sys.argv[2]
c = canvas.Canvas(out, pagesize=A4); y = 800
for line in open(src, encoding='utf8', errors='ignore').read().splitlines():
    for k in range(0, max(1, len(line)), 110):
        seg = line[k:k+110].encode('latin-1', 'ignore').decode('latin-1')
        c.drawString(40, y, seg); y -= 12
        if y < 40: c.showPage(); y = 800
c.save()`, txt, file]);
      }
      pdfJobs.push({ corpus: c.id, file, chars: Math.min(d.text.length, 400_000) });
    });
  }
  const htmlJobs = corpora.flatMap((c) => c.docs.filter((d) => !/\.pdf/i.test(d.url)).slice(0, 25).map((d) => ({ corpus: c.id, html:
    `<html><head><script>var x=1;</script><style>.a{}</style></head><body><nav>Menu</nav><main>${d.text.slice(0, 200_000).split(/\n+/).map((p) => `<p>${p.replace(/[<>&]/g, " ")}</p>`).join("")}</main><footer>f</footer></body></html>` })));
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const t0 = performance.now();
  const timings: any[] = [];
  await runPool(pdfJobs, CONCURRENCY, async (j) => {
    activeStages.set(j.file, "extract:pdf-parse");
    const buf = fs.readFileSync(j.file);
    const s = performance.now();
    const data = await pdfParse(buf);
    const n = normaliseTableHorizonMarkers(data.text || "");
    timings.push({ kind: "pdf", corpus: j.corpus, bytes: buf.length, pages: data.numpages, chars: n.text.length, ms: Math.round(performance.now() - s) });
    activeStages.delete(j.file);
  });
  await runPool(htmlJobs, CONCURRENCY, async (j, i) => {
    activeStages.set(`h${i}`, "extract:cheerio");
    const s = performance.now();
    const $ = cheerio.load(j.html);
    $("script, style, nav, footer, header, aside").remove();
    const text = $("main").first().text().replace(/\s+/g, " ").trim();
    timings.push({ kind: "html", corpus: j.corpus, bytes: j.html.length, chars: text.length, ms: Math.round(performance.now() - s) });
    activeStages.delete(`h${i}`);
    await new Promise((r) => setImmediate(r));
  });
  h.disable();
  result.phases.extract = { wallMs: Math.round(performance.now() - t0), eld: eldSnapshot(h), pdf: timings.filter((t) => t.kind === "pdf"),
    htmlCount: timings.filter((t) => t.kind === "html").length, htmlMaxMs: Math.max(0, ...timings.filter((t) => t.kind === "html").map((t) => t.ms)) };
  console.log(`[harness] extract phase: ${JSON.stringify(result.phases.extract.eld)} wall=${result.phases.extract.wallMs}ms`);
}

// ── Phase B: analyze (real runAnalysisPipeline, skipFetch) ─────────────────
if (PHASES.includes("analyze")) {
  currentPhase = "analyze";
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const t0 = performance.now();
  const perCompany: any[] = [];
  await runPool(corpora, CONCURRENCY, async (c, i) => {
    const companyId = 5000 + i;
    corpusByCompany.set(companyId, c.docs);
    const company: any = { id: companyId, workspaceId: 1, name: `Corpus${c.id} PLC`, ticker: null, website: null, analysisStatus: "fetched" };
    const lifecycle = createAttemptLifecycle({ jobId: 9000 + i, batchId: 1274, attemptNumber: 1, deadlineAt: null, attemptToken: `00000000-0000-4000-8000-00000000000${i}` });
    const s = performance.now();
    const ctx: any = { batchId: 1274, jobId: 9000 + i, attemptNumber: 1, companyId, lifecycle, attemptId: `profile-${i}` };
    const stageKey = `c${i}`;
    const stageTick = setInterval(() => { activeStages.set(stageKey, `analyze:${(ctx.stage as string) || "-"}`); }, 25);
    let res: any, err: any;
    try {
      res = await runWithDiagContext(ctx, () => runAnalysisPipeline({ company, framework: framework as any, measures: measures36 as any, workspaceId: 1, batchId: 1274, skipFetch: true, cancelCheck: () => false, attemptId: ctx.attemptId } as any));
    } catch (e) { err = e; }
    clearInterval(stageTick); activeStages.delete(stageKey);
    const ms = Math.round(performance.now() - s);
    const all = (res?.analysis?.categories ?? []).flatMap((x: any) => x.measures);
    perCompany.push({ corpus: c.id, docs: c.docs.length, ms, success: res?.success, error: res?.error ?? err?.message, measures: all.length,
      yes: all.filter((m: any) => m.verdict === "Yes").length, scoringErrors: all.filter((m: any) => m.verdict === "Scoring error").length });
    console.log(`[harness] company corpus=${c.id} done in ${ms}ms success=${res?.success} measures=${all.length} err=${res?.error ?? err?.message ?? "-"}`);
  });
  h.disable();
  result.phases.analyze = { wallMs: Math.round(performance.now() - t0), eld: eldSnapshot(h), perCompany };
  console.log(`[harness] analyze phase: ${JSON.stringify(result.phases.analyze.eld)} wall=${result.phases.analyze.wallMs}ms`);
}

clearInterval(probe);
result.stalls = stalls;
result.stallSummary = {
  count: stalls.length, totalMs: stalls.reduce((a, s) => a + s.lagMs, 0), maxMs: Math.max(0, ...stalls.map((s) => s.lagMs)),
  over1s: stalls.filter((s) => s.lagMs > 1000).length, over5s: stalls.filter((s) => s.lagMs > 5000).length,
};
result.providerCalls = providerCalls;
result.sqlCount = sqlCount;
result.blockedNetwork = { count: blockedNet.length, sample: [...new Set(blockedNet)].slice(0, 20) };
result.rssMB = Math.round(process.memoryUsage().rss / 1e6);
fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`[harness] stalls=${JSON.stringify(result.stallSummary)} providerCalls=${providerCalls} sql=${sqlCount} blockedNet=${blockedNet.length} rss=${result.rssMB}MB → ${OUT}`);
process.exit(0);
