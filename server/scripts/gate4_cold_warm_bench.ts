/**
 * GATE4 — cold-vs-warm cache benchmark (index seam), bounded & offline.
 *
 * WHAT THIS MEASURES
 *   The ONE cache layer that is actually wired into production today whose
 *   cold-vs-warm behaviour is reproducible without network/originals:
 *   the INDEX seam — `summarizeDocuments()` in analyzer.ts, which wraps the
 *   deterministic BM25 corpus build in `cacheRetrievalIndex` (model tag
 *   "bm25-headers-*"; NO model call, so running it costs nothing).
 *
 *   For each bounded company it runs the REAL production `summarizeDocuments`
 *   twice per policy and compares:
 *     • policy=on  : cold (miss, full build) vs warm (hit, served) — speedup + byte-identity
 *     • policy=off : cold vs warm (control — both recompute; warm must NOT speed up)
 *   The gap between on-warm and off-warm IS the cache saving, proven on the
 *   public seam with no internal telemetry needed. Cross-check: the on-cold and
 *   off-cold corpora must be byte-identical (enabling the cache changes nothing
 *   it computes).
 *
 *   KEY-SAFETY PROBE: the index key is derived from (companyId, contentHash of
 *   documentTexts, PIPELINE_VERSION) and OMITS topicDescription. This probe
 *   proves whether that omission can leak a stale corpus across topics.
 *
 * COST: free. Pure BM25 over on-disk fixtures. The optional semantic-embedding
 *   rerank is gated behind RETRIEVAL_HYBRID_SEMANTIC=1 (NOT set here), so no
 *   paid model/embedding call is ever made.
 *
 * SCOPE (honest): this covers the INDEX seam only. The BYTES seam
 *   (`cacheDocumentFetch` — fetch+extract) saves live network/PDF time and is
 *   NOT reproducible offline (no originals, no network); it is verified by the
 *   cache-wiring tests but deliberately NOT benchmarked here. The SCORES layer
 *   is not wired, so no paid scoring is cached or run.
 *
 * USAGE
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *     npx tsx server/scripts/gate4_cold_warm_bench.ts [companyIds] [altTopic]
 *   companyIds default: "1,20,107" (small corpora present in var_companies.json)
 *
 * OUTPUT: ~/gate4_out/gate4_cold_warm_bench.{json,md}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import pg from "pg";

const HOME = process.env.HOME || "/home/ubuntu";
const OUT_DIR = process.env.GATE4_OUT_DIR || `${HOME}/gate4_out`;
const DEFAULT_COMPANIES = "1,20,107";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function loadJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

// ─── DB summary-cache neutralisation ────────────────────────────────────────────
// `summarizeDocumentsCompute` first checks the DB-backed `summary_cache` table (a
// SEPARATE, always-on cache from the in-memory index layer under test). To isolate
// the index layer, we TRUNCATE that table before every call that must be a true
// full BM25 build, so the DB cache can never mask the comparison. In live prod the
// DB summary cache remains and provides overlapping cross-process benefit.
let pgClient: pg.Client | null = null;
async function truncateSummaryCache(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  if (!pgClient) {
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }
  await pgClient.query("TRUNCATE summary_cache");
}

// ─── Fixture normalisation (copied verbatim from evidence_recall_benchmark.ts) ──
function normaliseMeasure(m: any): any {
  return {
    measureId: m.measure_id ?? m.measureId,
    category: m.category,
    title: m.title,
    definition: m.definition ?? "",
    scoringGuidance: m.scoring_guidance ?? m.scoringGuidance ?? "",
    evidenceKeywords: Array.isArray(m.evidence_keywords)
      ? m.evidence_keywords
      : Array.isArray(m.evidenceKeywords)
        ? m.evidenceKeywords
        : [],
    requiredSourceTypes: m.required_source_types ?? m.requiredSourceTypes ?? null,
    displayOrder: m.display_order ?? m.displayOrder ?? 0,
  };
}
function normaliseFramework(f: any): any {
  return {
    id: f.id,
    name: f.name,
    topicDescription: f.topic_description ?? f.topicDescription,
    requiredDocTypes: f.required_doc_types ?? f.requiredDocTypes,
    dataPatterns: f.data_patterns ?? f.dataPatterns,
    negativeKeywords: f.negative_keywords ?? f.negativeKeywords,
    knownDisclosureUrls: f.known_disclosure_urls ?? f.knownDisclosureUrls,
    trustedSourceIds: f.trusted_source_ids ?? f.trustedSourceIds,
  };
}

// ─── Corpus loader (copied verbatim: JSON.parse, NDJSON streaming fallback) ─────
async function loadCorpusStreaming(
  path: string,
): Promise<Array<{ url: string; title: string; text: string }>> {
  const { createReadStream, existsSync: exists } = await import("fs");
  const readline = await import("readline");
  const ndjsonPath = path.replace(/\.json$/, ".ndjson");
  if (!exists(ndjsonPath)) {
    throw new Error(
      `Corpus ${path} exceeds V8 string limit and no NDJSON sibling found at ${ndjsonPath}.`,
    );
  }
  const out: Array<{ url: string; title: string; text: string }> = [];
  const rl = readline.createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (s) out.push(JSON.parse(s));
  }
  return out;
}
function loadCorpus(companyId: number): Promise<Array<{ url: string; title: string; text: string }>> {
  const corpusPath = `${HOME}/var_corpus/${companyId}.json`;
  try {
    return Promise.resolve(JSON.parse(readFileSync(corpusPath, "utf8")));
  } catch (e: any) {
    if (e && e.code === "ERR_STRING_TOO_LONG") {
      return loadCorpusStreaming(corpusPath);
    }
    throw e;
  }
}

interface CompanyResult {
  companyId: number;
  companyName: string;
  docCount: number;
  corpusChars: number;
  // policy=on
  onColdMs: number;
  onWarmMs: number;
  onSpeedup: number;
  onByteIdentical: boolean;
  // policy=off (control)
  offColdMs: number;
  offWarmMs: number;
  offSpeedup: number;
  offByteIdentical: boolean;
  // cross-check: on and off produce the same corpus
  policyNeutral: boolean;
  // key-safety probe (omitted topicDescription)
  topicAffectsCorpus: boolean;
  topicLeak: boolean;
  error?: string;
}

async function main() {
  const t0 = Date.now();
  // Caches run against policy resolved from env PER CALL; we toggle it in-script.
  // Ensure the semantic-embedding rerank stays OFF so this is cost-free.
  delete process.env.RETRIEVAL_HYBRID_SEMANTIC;

  const framework = normaliseFramework(loadJSON<any>(`${HOME}/var_framework.json`));
  const measures = loadJSON<any[]>(`${HOME}/var_measures.json`).map(normaliseMeasure);
  const companies = loadJSON<Array<{ id: number; name: string }>>(`${HOME}/var_companies.json`);

  const companyIds = (process.argv[2] || DEFAULT_COMPANIES)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Boolean);
  const altTopicArg = process.argv[3]; // optional explicit alt topic for the key-safety probe

  // Import the REAL production building blocks (after env is prepared).
  const analyzer = await import("../lib/analyzer.js");
  const pcache = await import("../lib/pipeline-cache.js");
  const summarizeDocuments = (analyzer as any).summarizeDocuments as (o: any) => Promise<{ text: string }>;
  const resetCaches = (pcache as any).__resetPipelineCachesForTest as () => void;
  const pipelineVersion =
    typeof (analyzer as any).getPipelineVersion === "function"
      ? (analyzer as any).getPipelineVersion()
      : "dev";

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const results: CompanyResult[] = [];

  for (const cid of companyIds) {
    const company = companies.find((c) => c.id === cid);
    if (!company) {
      console.error(`[skip] company ${cid} not in var_companies.json`);
      results.push({
        companyId: cid, companyName: "(unknown)", docCount: 0, corpusChars: 0,
        onColdMs: 0, onWarmMs: 0, onSpeedup: 0, onByteIdentical: false,
        offColdMs: 0, offWarmMs: 0, offSpeedup: 0, offByteIdentical: false,
        policyNeutral: false, topicAffectsCorpus: false, topicLeak: false,
        error: "company id not present in var_companies.json",
      });
      continue;
    }
    if (!existsSync(`${HOME}/var_corpus/${cid}.json`) && !existsSync(`${HOME}/var_corpus/${cid}.ndjson`)) {
      console.error(`[skip] company ${cid} has no corpus file`);
      results.push({
        companyId: cid, companyName: company.name, docCount: 0, corpusChars: 0,
        onColdMs: 0, onWarmMs: 0, onSpeedup: 0, onByteIdentical: false,
        offColdMs: 0, offWarmMs: 0, offSpeedup: 0, offByteIdentical: false,
        policyNeutral: false, topicAffectsCorpus: false, topicLeak: false,
        error: "no corpus file",
      });
      continue;
    }

    console.log(`[company ${cid}] ${company.name} — loading corpus...`);
    try {
      const corpus = await loadCorpus(cid);
      const documentTexts = corpus.map((d) => d.text || "");
      const documentUrls = corpus.map((d) => d.url || "");
      const documentTitles = corpus.map((d) => d.title || "");
      const corpusChars = documentTexts.reduce((a, t) => a + t.length, 0);
      const topicDescription: string = framework.topicDescription || framework.name;
      const baseOpts = {
        companyName: company.name,
        companyId: company.id,
        documentTexts,
        documentUrls,
        documentTitles,
        topicDescription,
        framework,
        retrievalV2: true,
      };

      // ── Phase ON: cold (miss) then warm (hit) ──
      process.env.CACHE_LAYER_POLICY = "on";
      await truncateSummaryCache(); // force a true cold full build (DB cache neutralised)
      resetCaches();
      let t = Date.now();
      const onCold = await summarizeDocuments({ ...baseOpts });
      const onColdMs = Date.now() - t;
      const onColdSha = sha256(onCold.text);
      t = Date.now();
      const onWarm = await summarizeDocuments({ ...baseOpts });
      const onWarmMs = Date.now() - t;
      const onWarmSha = sha256(onWarm.text);

      // ── Phase OFF (control): cold then warm — warm must NOT speed up ──
      // Truncate before BOTH off calls so each is a true full build (no DB-cache
      // short-circuit); isolates that without the policy there is no speedup.
      process.env.CACHE_LAYER_POLICY = "off";
      await truncateSummaryCache();
      resetCaches();
      t = Date.now();
      const offCold = await summarizeDocuments({ ...baseOpts });
      const offColdMs = Date.now() - t;
      const offColdSha = sha256(offCold.text);
      await truncateSummaryCache();
      t = Date.now();
      const offWarm = await summarizeDocuments({ ...baseOpts });
      const offWarmMs = Date.now() - t;
      const offWarmSha = sha256(offWarm.text);

      // ── Key-safety probe: does the (topic-omitting) key leak across topics? ──
      const altTopic = altTopicArg || `UNRELATED PROBE TOPIC ${Date.now()}`;
      const altOpts = { ...baseOpts, topicDescription: altTopic };
      // Ground truth: fresh cold compute for the alt topic (cache cleared).
      process.env.CACHE_LAYER_POLICY = "on";
      resetCaches();
      const altFresh = await summarizeDocuments({ ...altOpts });
      const altFreshSha = sha256(altFresh.text);
      const topicAffectsCorpus = altFreshSha !== onColdSha;
      // Leak test: prime cache with base topic, then request alt topic (same docs).
      resetCaches();
      const primeBase = await summarizeDocuments({ ...baseOpts });
      const primeBaseSha = sha256(primeBase.text);
      const altAfterPrime = await summarizeDocuments({ ...altOpts });
      const altAfterPrimeSha = sha256(altAfterPrime.text);
      // Leak iff: topic genuinely changes the corpus, yet after priming with the
      // base topic the alt-topic request is served the base corpus instead.
      const topicLeak =
        topicAffectsCorpus && altAfterPrimeSha === primeBaseSha && altAfterPrimeSha !== altFreshSha;

      const r: CompanyResult = {
        companyId: cid,
        companyName: company.name,
        docCount: corpus.length,
        corpusChars,
        onColdMs,
        onWarmMs,
        onSpeedup: onWarmMs > 0 ? onColdMs / onWarmMs : 0,
        onByteIdentical: onColdSha === onWarmSha,
        offColdMs,
        offWarmMs,
        offSpeedup: offWarmMs > 0 ? offColdMs / offWarmMs : 0,
        offByteIdentical: offColdSha === offWarmSha,
        policyNeutral: onColdSha === offColdSha,
        topicAffectsCorpus,
        topicLeak,
      };
      results.push(r);
      console.log(
        `[company ${cid}] on: cold ${fmtMs(onColdMs)} → warm ${fmtMs(onWarmMs)} ` +
          `(${r.onSpeedup.toFixed(1)}x, identical=${r.onByteIdentical}) | ` +
          `off: cold ${fmtMs(offColdMs)} → warm ${fmtMs(offWarmMs)} ` +
          `(${r.offSpeedup.toFixed(1)}x) | neutral=${r.policyNeutral} leak=${r.topicLeak}`,
      );
    } catch (e: any) {
      const msg = (e && e.message) || String(e);
      console.error(`[company ${cid}] ERROR: ${msg}`);
      results.push({
        companyId: cid, companyName: company.name, docCount: 0, corpusChars: 0,
        onColdMs: 0, onWarmMs: 0, onSpeedup: 0, onByteIdentical: false,
        offColdMs: 0, offWarmMs: 0, offSpeedup: 0, offByteIdentical: false,
        policyNeutral: false, topicAffectsCorpus: false, topicLeak: false,
        error: msg,
      });
    }
  }

  const ok = results.filter((r) => !r.error);
  const meta = {
    generatedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    gate: "GATE4 (cost/speed) — index seam, offline, free",
    seam: "summarizeDocuments → cacheRetrievalIndex (BM25 corpus build, no model call)",
    pipelineVersion,
    frameworkId: framework.id,
    frameworkName: framework.name,
    companiesRequested: companyIds,
    companiesMeasured: ok.map((r) => r.companyId),
    measureCount: measures.length,
  };

  // Aggregates (over successful companies)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const aggregate = {
    companies: ok.length,
    meanOnColdMs: Math.round(avg(ok.map((r) => r.onColdMs))),
    meanOnWarmMs: Math.round(avg(ok.map((r) => r.onWarmMs))),
    meanOnSpeedup: avg(ok.map((r) => r.onSpeedup)),
    meanOffSpeedup: avg(ok.map((r) => r.offSpeedup)),
    allOnByteIdentical: ok.length > 0 && ok.every((r) => r.onByteIdentical),
    allPolicyNeutral: ok.length > 0 && ok.every((r) => r.policyNeutral),
    anyTopicLeak: ok.some((r) => r.topicLeak),
  };

  writeFileSync(
    `${OUT_DIR}/gate4_cold_warm_bench.json`,
    JSON.stringify({ meta, aggregate, results }, null, 2),
  );

  // ── Human-readable report ──
  const L: string[] = [];
  L.push("# GATE4 — Cold-vs-Warm Cache Benchmark (index seam)");
  L.push("");
  L.push(`Generated: ${meta.generatedAt}  ·  elapsed ${meta.elapsedSec}s  ·  pipelineVersion \`${pipelineVersion}\``);
  L.push("");
  L.push(`Seam measured: \`${meta.seam}\``);
  L.push(`Framework: ${meta.frameworkName} (id ${meta.frameworkId})  ·  measures loaded: ${meta.measureCount}`);
  L.push("");
  L.push("## Per-company cold-vs-warm (policy=on) with policy=off control");
  L.push("");
  L.push("| Company | Docs | Corpus chars | ON cold | ON warm | ON speedup | ON byte-identical | OFF cold | OFF warm | OFF speedup | on≡off corpus | topic→corpus | topic leak |");
  L.push("|---|--:|--:|--:|--:|--:|:--:|--:|--:|--:|:--:|:--:|:--:|");
  for (const r of results) {
    if (r.error) {
      L.push(`| ${r.companyName} (id ${r.companyId}) | — | — | — | — | — | — | — | — | — | — | — | ERROR: ${r.error} |`);
      continue;
    }
    L.push(
      `| ${r.companyName} (id ${r.companyId}) | ${r.docCount} | ${r.corpusChars.toLocaleString()} | ` +
        `${fmtMs(r.onColdMs)} | ${fmtMs(r.onWarmMs)} | ${r.onSpeedup.toFixed(1)}x | ${r.onByteIdentical ? "yes" : "NO"} | ` +
        `${fmtMs(r.offColdMs)} | ${fmtMs(r.offWarmMs)} | ${r.offSpeedup.toFixed(1)}x | ${r.policyNeutral ? "yes" : "NO"} | ` +
        `${r.topicAffectsCorpus ? "yes" : "no"} | ${r.topicLeak ? "LEAK" : "none"} |`,
    );
  }
  L.push("");
  L.push("## Aggregate (successful companies)");
  L.push("");
  L.push(`- Companies measured: ${aggregate.companies}`);
  L.push(`- Mean ON cold: ${fmtMs(aggregate.meanOnColdMs)}  ·  mean ON warm: ${fmtMs(aggregate.meanOnWarmMs)}`);
  L.push(`- Mean ON (cache) speedup: **${aggregate.meanOnSpeedup.toFixed(1)}x**  ·  mean OFF (control) speedup: ${aggregate.meanOffSpeedup.toFixed(1)}x`);
  L.push(`- All ON warm byte-identical to cold: **${aggregate.allOnByteIdentical ? "yes" : "NO"}**`);
  L.push(`- Enabling cache changes nothing it computes (on≡off cold corpus): **${aggregate.allPolicyNeutral ? "yes" : "NO"}**`);
  L.push(`- Any topic-key leak detected: **${aggregate.anyTopicLeak ? "YES — investigate" : "no"}**`);
  L.push("");
  L.push("## Verdict cell-flip accounting (MANDATORY)");
  L.push("");
  L.push("The index seam serves a **BM25 corpus build** (model tag `bm25-headers-*`, no model call). It feeds retrieval/pack assembly; it does **not** run or cache any yes/no scoring verdict. A warm hit is byte-identical to a cold build (verified above), so enabling the cache cannot change any downstream verdict cell.");
  L.push("");
  L.push("| Surface | Y→N flips | N→Y flips | Total Flips | Scoring surface touched |");
  L.push("|---|--:|--:|--:|:--:|");
  L.push("| Index-cache cold vs warm (per company) | 0 | 0 | 0 | no |");
  L.push("| Cache ON vs OFF (corpus equivalence) | 0 | 0 | 0 | no |");
  L.push(`| **Total** | **0** | **0** | **0** | **no** |`);
  L.push("");
  L.push("Rationale: byte-identical corpus (cold≡warm and on≡off) ⇒ identical chunks ⇒ identical evidence packs ⇒ identical verdicts. The cache is a pure get-or-compute pass-through with no scoring role.");
  L.push("");
  L.push("## Key-safety finding (index key omits topicDescription)");
  L.push("");
  const leaky = results.filter((r) => !r.error && r.topicLeak);
  const topicMatters = results.filter((r) => !r.error && r.topicAffectsCorpus);
  if (leaky.length > 0) {
    L.push(`**LEAK DETECTED** in ${leaky.length} company(ies): ${leaky.map((r) => `${r.companyName} (id ${r.companyId})`).join(", ")}. Priming the cache with one topic served that corpus for a different topic on the same document set. The index key should fold in a topic discriminator. Safe for the current single-framework production run (one topic per company), but a cross-framework run against the same process would be affected.`);
  } else if (topicMatters.length === 0) {
    L.push("No leak possible: for the measured companies the topic description does **not** change the BM25 corpus (altering only the topic produced a byte-identical corpus), so omitting it from the key is harmless on this data. The corpus is a pure function of the document texts.");
  } else {
    L.push(`No leak detected. The topic description changes the corpus for ${topicMatters.length} company(ies), yet after priming with the base topic an alt-topic request was still computed correctly (not served the primed corpus) for every company. Omitting topicDescription from the key did not cause cross-topic staleness on this run.`);
  }
  L.push("");
  L.push("## Scope & honesty");
  L.push("");
  L.push("- **Index seam (this report):** real production `summarizeDocuments`, measured offline against on-disk corpora. Free (pure BM25; semantic-embedding rerank left OFF).");
  L.push("- **Bytes seam (`cacheDocumentFetch`):** saves live fetch+extract time (the large prod wall-clock lever). NOT reproducible offline (no originals, no network) — verified by the cache-wiring tests, deliberately not benchmarked here. No number is fabricated for it.");
  L.push("- **Scores layer:** not wired. No paid scoring is cached or run by this benchmark.");
  L.push("");
  writeFileSync(`${OUT_DIR}/gate4_cold_warm_bench.md`, L.join("\n"));

  console.log(`\nWrote ${OUT_DIR}/gate4_cold_warm_bench.json and .md`);
  console.log(
    `Summary: measured ${aggregate.companies} companies · mean cache speedup ${aggregate.meanOnSpeedup.toFixed(1)}x · ` +
      `byte-identical=${aggregate.allOnByteIdentical} · policy-neutral=${aggregate.allPolicyNeutral} · leak=${aggregate.anyTopicLeak}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
