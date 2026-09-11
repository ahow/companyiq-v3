/**
 * COST-SPLIT measurement — per-stage wall-clock + token accounting for ONE company
 * across ALL production measures, single sample (k=1), CASCADE_MODE=v2.
 *
 *   tsx server/scripts/coststsplit_run.ts <companyId>
 *
 * PURPOSE
 * -------
 * Measure what fraction of a company's end-to-end scoring cost (wall-clock AND
 * LLM tokens) is spent in the GRADING step vs everything upstream, so we can put
 * an honest number on the true end-to-end multiplier of k=5 self-consistency
 * (which multiplies ONLY the deciding-grader calls).
 *
 * This is measurement only. It does NOT modify any production code path and writes
 * only under /home/ubuntu. It mirrors the faithful production reproduction in
 * server/scripts/variability_run.ts (same building blocks, same v2 cascade, single
 * pass per model via completeScoring — exactly the grading unit that the k=5
 * self-consistency experiment multiplies).
 *
 * STAGE BOUNDARIES (measured)
 *   - summarize   : summarizeDocuments (Stage-1 combinedText; DB-cached for most
 *                   companies -> ~0 LLM calls, still timed)
 *   - topicterms  : deriveTopicTerms (deterministic, no LLM)
 *   - packbuild   : buildEvidencePacksForCategory (BM25 pack, deterministic, no LLM)
 *   - rescore     : rescorePacksForCategory (LLM chunk rank/rescore)
 *   - grade_deciding : deepseek + mistral-or completeScoring calls  <-- k multiplies THIS
 *   - grade_extra    : glm-4.6-zai (non-deciding scored extra)
 *   - grade_arbiter  : gpt5-arbiter (fires only on deciding-model disagreement)
 *
 * NOTE ON "retrieval": discovery + fetch + PDF/HTML extraction + embeddings all
 * happen ONCE upstream to produce the frozen corpus on disk; they are not part of
 * this per-cell scoring path and are not re-run here (the corpus is read from
 * var_corpus/<id>.json). The in-scoring upstream stages are summarize + packbuild
 * + rescore. This is stated in the report.
 *
 * TOKEN ACCOUNTING: a global axios response interceptor records `usage`
 * (prompt_tokens / completion_tokens) from every /chat/completions response and
 * attributes it to the CURRENT_STAGE label. All v2 cascade providers + the rescore
 * model are OpenAICompatibleProvider (axios), so usage is captured for every LLM
 * call. Any provider that does NOT return usage is counted by call-count only and
 * flagged (noUsageCalls).
 */
import axios from "axios";
import { loadSecrets } from "./variability_secrets.js";
const secretsStatus = loadSecrets();
for (const req of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "DATABASE_URL"] as const) {
  if (!secretsStatus.present[req]) {
    console.error(`FATAL: missing secret ${req}`, secretsStatus.present);
    process.exit(1);
  }
}

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { createHash } from "crypto";

const HOME = "/home/ubuntu";
const OUTDIR = process.env.CS_OUT_DIR || `${HOME}/var_out_coststit`;
mkdirSync(OUTDIR, { recursive: true });
const LOG = `${OUTDIR}/driver.log`;
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  appendFileSync(LOG, line + "\n");
}

// ---------- stage token accounting via global axios interceptor ----------
type Bucket = { calls: number; promptTokens: number; completionTokens: number; noUsageCalls: number };
const STAGES = ["summarize", "topicterms", "packbuild", "rescore", "grade_deciding", "grade_extra", "grade_arbiter", "other"] as const;
type Stage = typeof STAGES[number];
const tokBuckets: Record<Stage, Bucket> = Object.fromEntries(
  STAGES.map((s) => [s, { calls: 0, promptTokens: 0, completionTokens: 0, noUsageCalls: 0 }]),
) as Record<Stage, Bucket>;
let CURRENT_STAGE: Stage = "other";
axios.interceptors.response.use((response) => {
  try {
    const url = String(response.config?.url || "");
    if (url.includes("/chat/completions") || url.includes(":generateContent")) {
      const b = tokBuckets[CURRENT_STAGE];
      b.calls += 1;
      const u = (response.data && response.data.usage) || null;
      if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
        b.promptTokens += u.prompt_tokens || 0;
        b.completionTokens += u.completion_tokens || 0;
      } else {
        b.noUsageCalls += 1;
      }
    }
  } catch { /* never let accounting break a call */ }
  return response;
}, (error) => Promise.reject(error));

// glm-4.6-zai (the NON-deciding extra) was suffering a provider-side outage during
// this measurement (persistent >120s timeouts on api.z.ai). k=5 self-consistency
// never multiplies glm, so its health is irrelevant to the headline multiplier, but
// its 4×120s retry storm would inflate grade_extra wall-clock and stretch the run to
// hours. We cap ONLY glm's request timeout here (production code untouched; deciding
// graders keep the faithful 120s) so the run completes and grade_extra is captured
// best-effort. CS_GLM_TIMEOUT_MS overrides.
const GLM_TIMEOUT_MS = parseInt(process.env.CS_GLM_TIMEOUT_MS || "60000", 10);
axios.interceptors.request.use((config) => {
  try {
    if (String(config.url || "").includes("api.z.ai")) config.timeout = GLM_TIMEOUT_MS;
  } catch { /* never break a call */ }
  return config;
});

// ---------- wall-clock accounting per stage ----------
const wallMs: Record<Stage, number> = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
async function timed<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
  const prev = CURRENT_STAGE; CURRENT_STAGE = stage;
  const t = Date.now();
  try { return await fn(); }
  finally { wallMs[stage] += Date.now() - t; CURRENT_STAGE = prev; }
}

// ---------- args + frozen inputs (identical to variability_run.ts) ----------
const companyId = parseInt(process.argv[2] || "", 10);
if (!companyId) { console.error("usage: coststsplit_run.ts <companyId>"); process.exit(1); }

const framework = JSON.parse(readFileSync(`${HOME}/var_framework.json`, "utf8"));
let measures = JSON.parse(readFileSync(process.env.MEASURES_FILE || `${HOME}/var_measures.json`, "utf8"));
// CS_LIMIT: smoke-test only — restrict to the first N measures to verify token
// capture before the full 25-measure run. Unset for the real measurement.
if (process.env.CS_LIMIT) measures = measures.slice(0, parseInt(process.env.CS_LIMIT, 10));
const lexTerms: string[] = JSON.parse(readFileSync(`${HOME}/var_topicterms.json`, "utf8"));
const companies = JSON.parse(readFileSync(`${HOME}/var_companies.json`, "utf8"));
const company = companies.find((c: any) => c.id === companyId);
if (!company) { console.error(`company ${companyId} not in var_companies.json`); process.exit(1); }
const companyName: string = company.name;

const CASCADE = { primary: "deepseek", secondary: "mistral-or", arbiter: "gpt5-arbiter" };
const EXTRA = "glm-4.6-zai";
const SCORING_MAX_TOKENS = 32000;

function deterministicSeed(measureId: string, cid: number, providerIndex: number): number {
  return createHash("sha256").update(`${measureId}:${cid}:${providerIndex}`).digest().readUInt32BE(0);
}
function verdictLabel(s: number): string { return s === 1 ? "Yes" : s === 0.5 ? "Partial" : "No"; }

async function loadCorpusStreaming(path: string): Promise<Array<{ url: string; title: string; text: string }>> {
  const { createReadStream, existsSync } = await import("fs");
  const readline = await import("readline");
  const ndjsonPath = path.replace(/\.json$/, ".ndjson");
  if (!existsSync(ndjsonPath)) throw new Error(`Corpus ${path} exceeds V8 string limit and no NDJSON sibling at ${ndjsonPath}.`);
  const out: Array<{ url: string; title: string; text: string }> = [];
  const rl = readline.createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) { const s = line.trim(); if (s) out.push(JSON.parse(s)); }
  return out;
}

async function main() {
  const t0 = Date.now();
  const OUT = `${OUTDIR}/${companyId}.json`;
  if (existsSync(OUT) && process.env.CS_FORCE !== "1") { log(`SKIP (exists): ${OUT}`); process.exit(0); }
  log(`START cost-split company ${companyId} (${companyName}) measures=${measures.length} CASCADE_MODE=v2 k=1`);

  const analyzer = await import("../lib/analyzer.js");
  const { buildBinaryScoringPrompt, summarizeDocuments, extractAndParseJSON } = analyzer as any;
  const { buildEvidencePacksForCategory, deriveTopicTerms } = await import("../lib/passage-retrieval.js");
  const { completeScoring } = await import("../lib/ai-providers.js");
  const { rescorePacksForCategory, isRescoreEnabled } = await import("../lib/passage-rescore.js");
  const { gateEvidence } = await import("../lib/evidence-gate.js");

  // ---- frozen corpus (read from disk; NOT counted as an LLM stage) ----
  const corpusPath = `${HOME}/var_corpus/${companyId}.json`;
  let corpus: Array<{ url: string; title: string; text: string }>;
  try { corpus = JSON.parse(readFileSync(corpusPath, "utf8")); }
  catch (e: any) {
    if (e && e.code === "ERR_STRING_TOO_LONG") { corpus = await loadCorpusStreaming(corpusPath); }
    else throw e;
  }
  const documentTexts = corpus.map((d) => d.text || "");
  const documentUrls = corpus.map((d) => d.url || "");
  const documentTitles = corpus.map((d) => d.title || "");
  const topicDescription: string = framework.topicDescription || framework.name;

  // ---- Stage: summarize ----
  const summ = await timed("summarize", () => summarizeDocuments({
    companyName, companyId, documentTexts, documentUrls, documentTitles,
    topicDescription, framework, retrievalV2: true,
  }));
  const combinedText: string = summ.text;
  const combinedHash = createHash("sha256").update(combinedText).digest("hex").slice(0, 16);

  // ---- Stage: topicterms ----
  const topicTerms = await timed("topicterms", async () => {
    const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
    return [...new Set([...lexTerms, ...deterministicTerms])];
  });

  const RESCORE_BUDGET_CHARS = parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "20000", 10);
  const RESCORE_BUDGET_CHUNKS = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "20", 10);

  // group by category exactly like production/variability_run
  const catMap = new Map<string, any[]>();
  for (const m of measures) { if (!catMap.has(m.category)) catMap.set(m.category, []); catMap.get(m.category)!.push(m); }

  const perMeasure: any[] = [];
  const rescoreOn = isRescoreEnabled();

  for (const [category, catMeasures] of catMap) {
    // ---- Stage: packbuild (deterministic BM25) ----
    const bm25Packs = await timed("packbuild", async () => buildEvidencePacksForCategory({
      measures: catMeasures, combinedText, topicTerms,
      companyId, frameworkId: framework.id,
      reservedAnnualUrl: summ.reservedAnnualUrl,
      topicPrimaryDocUrls: summ.topicPrimaryDocUrls,
    }));

    // ---- Stage: rescore (LLM chunk rank) ----
    let prodPacks = bm25Packs;
    if (rescoreOn) {
      prodPacks = await timed("rescore", async () => rescorePacksForCategory(
        bm25Packs as any, catMeasures, combinedText,
        RESCORE_BUDGET_CHARS, RESCORE_BUDGET_CHUNKS, summ.topicPrimaryDocUrls,
      ));
    }
    const prodById = new Map(prodPacks.map((p: any) => [p.measureId, p]));

    for (const measure of catMeasures) {
      const prod = prodById.get(measure.measureId)!;
      const evidenceText: string = prod.text;

      // score ONE provider (real seed/prompt) + gate. Stage label set by caller.
      const scoreOne = async (provider: string, stage: Stage) => {
        const { system, prompt } = buildBinaryScoringPrompt({ companyName, measure, evidenceText, topicDescription, framework });
        const seed = deterministicSeed(measure.measureId, companyId, 0) & 0x7fffffff;
        return timed(stage, async () => {
          try {
            const { text } = await completeScoring(provider, { system, prompt, json: true, maxTokens: SCORING_MAX_TOKENS, seed });
            const parsed = extractAndParseJSON(text);
            const rawScore = parsed.score === 1 ? 1 : 0;
            const quotes = Array.isArray(parsed.quotes)
              ? parsed.quotes.filter((q: any) => q && typeof q.text === "string" && q.text.length > 0).map((q: any) => ({ text: q.text, source: q.source || "" }))
              : [];
            const { score, gate } = gateEvidence({
              originalScore: rawScore, quotes, packText: evidenceText,
              positiveExamples: measure.positiveExamples || [], negativeExamples: measure.negativeExamples || [],
            });
            return { score: gate.downgraded ? 0 : score };
          } catch (e: any) {
            return { score: -1, error: String(e?.message || e) };
          }
        });
      };

      // deciding primaries
      const r1 = await scoreOne(CASCADE.primary, "grade_deciding");
      const r2 = await scoreOne(CASCADE.secondary, "grade_deciding");
      // non-deciding extra (glm) — production runs it on every measure in this harness
      const rExtra = await scoreOne(EXTRA, "grade_extra");
      // arbiter ONLY on deciding disagreement
      let arbiterFired = false; let rArb: any = null;
      const s1 = r1.score, s2 = r2.score;
      let cascadeScore: number | null = null;
      if (s1 != null && s2 != null && s1 >= 0 && s2 >= 0) {
        if (s1 === s2) { cascadeScore = s1; }
        else { arbiterFired = true; rArb = await scoreOne(CASCADE.arbiter, "grade_arbiter"); cascadeScore = rArb.score >= 0 ? rArb.score : null; }
      }
      perMeasure.push({
        measureId: measure.measureId, category,
        deciding: { deepseek: s1, mistralOr: s2 }, extra: rExtra.score,
        arbiterFired, cascade: cascadeScore == null ? null : verdictLabel(cascadeScore),
      });
      log(`  ${measure.measureId.padEnd(26)} ds=${s1} mi=${s2} glm=${rExtra.score} arb=${arbiterFired} => ${cascadeScore == null ? "-" : verdictLabel(cascadeScore)}`);
    }
  }

  const elapsedSec = Math.round((Date.now() - t0) / 1000);

  // ---- aggregate ----
  const tokTotal = (b: Bucket) => b.promptTokens + b.completionTokens;
  const sumWall = Object.values(wallMs).reduce((a, b) => a + b, 0);
  const sumTokAll = STAGES.reduce((a, s) => a + tokTotal(tokBuckets[s]), 0);
  const sumCalls = STAGES.reduce((a, s) => a + tokBuckets[s].calls, 0);
  const decidingTok = tokTotal(tokBuckets["grade_deciding"]);
  const decidingWall = wallMs["grade_deciding"];
  const arbiterFiredCount = perMeasure.filter((m) => m.arbiterFired).length;

  const stageRows = STAGES.map((s) => ({
    stage: s,
    wallMs: wallMs[s],
    wallPct: sumWall ? +(100 * wallMs[s] / sumWall).toFixed(2) : 0,
    calls: tokBuckets[s].calls,
    promptTokens: tokBuckets[s].promptTokens,
    completionTokens: tokBuckets[s].completionTokens,
    totalTokens: tokTotal(tokBuckets[s]),
    tokenPct: sumTokAll ? +(100 * tokTotal(tokBuckets[s]) / sumTokAll).toFixed(2) : 0,
    noUsageCalls: tokBuckets[s].noUsageCalls,
  }));

  const out = {
    meta: {
      experiment: "per-stage cost split (wall-clock + tokens), single sample k=1",
      companyId, companyName, measureCount: measures.length,
      cascadeMode: "v2 (deepseek+mistral-or decide; gpt5-arbiter on disagreement; glm-4.6-zai non-deciding extra)",
      gradingUnit: "single-pass completeScoring per model (same unit the k=5 self-consistency experiment multiplies)",
      rescoreOn, combinedTextHash: combinedHash, corpusDocs: corpus.length,
      // harness knobs (do NOT affect deciding graders, which succeed first-try):
      // glm (non-deciding extra) was in a provider timeout outage during this run,
      // so its per-call timeout was capped and it fell back to deepseek. See §8 note.
      glmTimeoutMs: GLM_TIMEOUT_MS,
      scoringProviderRetries: parseInt(process.env.SCORING_PROVIDER_RETRIES || "4", 10),
      elapsedSec, ts: new Date().toISOString(),
    },
    totals: {
      wallMsSum: sumWall, tokenSumAll: sumTokAll, llmCallSum: sumCalls,
      arbiterFiredCount, measuresWithArbiter: arbiterFiredCount, measuresTotal: measures.length,
    },
    decidingGraderShare: {
      wallMs: decidingWall, wallPctOfSum: sumWall ? +(100 * decidingWall / sumWall).toFixed(2) : 0,
      totalTokens: decidingTok, tokenPctOfSum: sumTokAll ? +(100 * decidingTok / sumTokAll).toFixed(2) : 0,
      calls: tokBuckets["grade_deciding"].calls,
    },
    stages: stageRows,
    perMeasure,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  log(`SAVED ${OUT}  wallSum=${sumWall}ms tokSum=${sumTokAll} calls=${sumCalls} decidingTok%=${out.decidingGraderShare.tokenPctOfSum} decidingWall%=${out.decidingGraderShare.wallPctOfSum} arbiterFired=${arbiterFiredCount}/${measures.length} (${elapsedSec}s)`);
}
main().catch((e) => { log(`FATAL ${e?.stack || e}`); process.exit(1); });
