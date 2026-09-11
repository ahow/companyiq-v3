/**
 * THIRD-VOTE / MODEL-CALIBRATION experiment — measurement only, NOT production.
 *
 *   tsx server/scripts/thirdvote_run.ts <companyId>
 *
 * PURPOSE
 * -------
 * Pure sampling (k=25) on the ORIGINAL wording removed intra-session flips but
 * exposed a residual problem it cannot fix: on companies 16 (Santander) and 20
 * (Sumitomo) the two DECIDING v2 graders sit at OPPOSITE confident poles
 * (deepseek Yes ~0.9, mistral-or No ~0.0), so the cascade collapses entirely onto
 * the single GPT-5 arbiter. This harness samples a CONFIGURABLE SET of models on
 * the SAME fixed pack, so we can (a) profile each model's calibration and (b)
 * compute a majority-of-3 verdict {deepseek, mistral-or, C} for each candidate
 * third model C, to see whether any single third vote resolves the split
 * decisively without merely duplicating one side or over-detecting on the BHP
 * control.
 *
 * DESIGN — identical to selfconsistency_run.ts except the sampled model set is a
 * configurable list rather than the hardcoded deciding pair:
 *  - Wording: PRODUCTION/baseline var_measures.json, restricted to measure 3.5.
 *  - FIXED EVIDENCE PACK built ONCE per company (real summarizeDocuments ->
 *    buildEvidencePacksForCategory -> rescorePacksForCategory) and REUSED for
 *    every sample of every model — a pure grader-variance test. combinedTextHash
 *    is verified against the value established in prior sessions.
 *  - Each model sampled K*M = 25 times (K=5 per repeat, M=5 repeats), temperature
 *    0, production seed, same gateEvidence downgrade (Partial/don't-know -> No).
 *    Binary: score 1 = Yes; majority = Yes iff #Yes > #No, ties -> No.
 *  - Provider attribution is STRICT: a sample whose returned provider differs
 *    from the requested model (i.e. a silent fallback) is discarded, never
 *    counted as that model's vote. A model with no API key / all-auth-fail is
 *    recorded as UNAVAILABLE and the run continues with the others.
 *
 * OUTPUT: /home/ubuntu/var_out_35_thirdvote/<companyId>.json  (+ per-model logs)
 *
 * Calls the REAL production building blocks; modifies no production code path and
 * writes only under /home/ubuntu. No commits.
 */
import { loadSecrets } from "./variability_secrets.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { createHash } from "crypto";

const secretsStatus = loadSecrets();
for (const req of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "DATABASE_URL"] as const) {
  if (!secretsStatus.present[req]) {
    console.error(`FATAL: missing secret ${req}`, secretsStatus.present);
    process.exit(1);
  }
}

// --- extra provider keys for the CANDIDATE third models (claude / gemini / kimi).
// variability_secrets.ts only loads the deciding-pair keys; the third-vote
// candidates need ANTHROPIC/GEMINI/KIMI keys injected into process.env BEFORE
// ai-providers.js is imported (providers are constructed at module load). Parsed
// from the same SENSITIVE.md table variability_secrets.ts already reads; nothing
// hardcoded, values never printed. Absent keys simply leave that model
// UNAVAILABLE (handled gracefully below).
function parseEnvFromMarkdown(md: string, envVar: string): string | undefined {
  const re = new RegExp(
    `\\|[^|\\n]*\\|\\s*\`?${envVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?\\s*\\|\\s*\`?([^|\`\\n]+?)\`?\\s*\\|`,
  );
  const m = md.match(re);
  if (!m) return undefined;
  const val = m[1].trim();
  if (!val || /^\*+$/.test(val) || val.toLowerCase().includes("masked")) return undefined;
  return val;
}
try {
  const md = readFileSync("/home/ubuntu/Uploads/CompanyIQ v3 — System Documentation (SENSITIVE).md", "utf8");
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY2", "ANTHROPIC_API_KEY3", "GEMINI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]) {
    const parsed = parseEnvFromMarkdown(md, v);
    if (parsed && !process.env[v]) process.env[v] = parsed;
  }
} catch { /* optional */ }
// glm-4.6 with reasoning ON hangs ~120s/call and rate-limits hard under batch
// load; OFF is ~3s/call with clean JSON and still returns glm-4.6's own verdict.
// Default OFF here so glm yields a usable calibration profile (documented caveat
// in meta.glmThinking). Override with GLM_THINKING=enabled.
if (!process.env.GLM_THINKING) process.env.GLM_THINKING = "disabled";

const HOME = "/home/ubuntu";
const OUTDIR = process.env.TV_OUT_DIR || `${HOME}/var_out_35_thirdvote`;
mkdirSync(OUTDIR, { recursive: true });
const LOG = `${OUTDIR}/driver.log`;
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  appendFileSync(LOG, line + "\n");
}

// ---- experiment constants ----
const MEASURE_ID = "3.5-erm-integration";
const K = parseInt(process.env.TV_K || "5", 10);   // samples per model per repeat
const M = parseInt(process.env.TV_M || "5", 10);   // repeats per company (K*M = 25 total/model)
// Deciding pair re-sampled here so the majority-of-3 is computed within ONE
// internally-consistent session on the SAME pack; the other four are candidates.
const DEFAULT_MODELS = ["deepseek", "mistral-or", "glm-4.6-zai", "kimi", "claude", "gemini"];
const MODELS = (process.env.TV_MODELS ? process.env.TV_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS);
// Per-model concurrency. Models are sampled SEQUENTIALLY (one provider active at
// a time) so their independent rate limits never contend; within a model we fire
// this many samples at once. Low by default because the candidate providers
// (gemini/glm/claude) rate-limit under batch load.
const CONCURRENCY = parseInt(process.env.TV_CONCURRENCY || "3", 10);
const MAX_ATTEMPTS = parseInt(process.env.TV_MAX_ATTEMPTS || "6", 10);
const EXPECTED_COMBINED_HASH: Record<number, string> = { 12: "da0ad51866f48297", 16: "043e0a695fc3a754", 20: "7b70cace018e5500" };

// ---- args ----
const companyId = parseInt(process.argv[2] || "", 10);
if (!companyId) { console.error("usage: thirdvote_run.ts <companyId>"); process.exit(1); }

// ---- static inputs (frozen) — identical to selfconsistency_run.ts ----
const framework = JSON.parse(readFileSync(`${HOME}/var_framework.json`, "utf8"));
let measures = JSON.parse(readFileSync(process.env.MEASURES_FILE || `${HOME}/var_measures.json`, "utf8"));
measures = measures.filter((m: any) => m.measureId === MEASURE_ID);
if (measures.length !== 1) { console.error(`expected exactly 1 measure ${MEASURE_ID}, got ${measures.length}`); process.exit(1); }
const lexTerms: string[] = JSON.parse(readFileSync(`${HOME}/var_topicterms.json`, "utf8"));
const companies = JSON.parse(readFileSync(`${HOME}/var_companies.json`, "utf8"));
const company = companies.find((c: any) => c.id === companyId);
if (!company) { console.error(`company ${companyId} not in var_companies.json`); process.exit(1); }
const companyName: string = company.name;

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

type Sample = { score: number; verdict: string; downgraded: boolean; provider?: string; error?: string; fallback?: boolean };

async function main() {
  const t0 = Date.now();
  const OUT = `${OUTDIR}/${companyId}.json`;
  if (existsSync(OUT) && process.env.TV_FORCE !== "1") { log(`SKIP (exists): ${OUT}`); process.exit(0); }
  log(`START company ${companyId} (${companyName}) K=${K} M=${M} models=[${MODELS.join(",")}] measure=${MEASURE_ID}`);

  const analyzer = await import("../lib/analyzer.js");
  const { buildBinaryScoringPrompt, summarizeDocuments, extractAndParseJSON } = analyzer as any;
  const { buildEvidencePacksForCategory, deriveTopicTerms } = await import("../lib/passage-retrieval.js");
  const { getProvider } = await import("../lib/ai-providers.js");
  const { rescorePacksForCategory, isRescoreEnabled } = await import("../lib/passage-rescore.js");
  const { gateEvidence } = await import("../lib/evidence-gate.js");

  // ---- availability probe (per model) ----
  const availability: Record<string, boolean> = {};
  for (const name of MODELS) {
    const p = getProvider(name);
    availability[name] = !!(p && p.isAvailable());
  }
  log(`availability: ${MODELS.map((m) => `${m}=${availability[m] ? "OK" : "UNAVAILABLE"}`).join(" ")}`);

  // ---- frozen corpus ----
  const corpusPath = `${HOME}/var_corpus/${companyId}.json`;
  let corpus: Array<{ url: string; title: string; text: string }>;
  try {
    corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  } catch (e: any) {
    if (e && e.code === "ERR_STRING_TOO_LONG") {
      log(`[corpus] ${corpusPath} exceeds V8 max string length — streaming-parsing array`);
      corpus = await loadCorpusStreaming(corpusPath);
      log(`[corpus] streamed ${corpus.length} documents`);
    } else throw e;
  }
  const documentTexts = corpus.map((d) => d.text || "");
  const documentUrls = corpus.map((d) => d.url || "");
  const documentTitles = corpus.map((d) => d.title || "");
  const topicDescription: string = framework.topicDescription || framework.name;

  // ---- Stage 1: combinedText (deterministic, no LLM) ----
  const summ = await summarizeDocuments({
    companyName, companyId, documentTexts, documentUrls, documentTitles,
    topicDescription, framework, retrievalV2: true,
  });
  const combinedText: string = summ.text;
  const combinedHash = createHash("sha256").update(combinedText).digest("hex").slice(0, 16);
  const expected = EXPECTED_COMBINED_HASH[companyId];
  const combinedHashMatch = expected ? combinedHash === expected : null;
  if (expected && !combinedHashMatch) {
    log(`WARNING: combinedTextHash MISMATCH for company ${companyId}: got ${combinedHash}, expected ${expected} — pack differs from prior sessions; continuing anyway.`);
  } else if (expected) {
    log(`combinedTextHash OK (${combinedHash}) matches prior sessions`);
  }

  const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  const topicTerms = [...new Set([...lexTerms, ...deterministicTerms])];

  const RESCORE_BUDGET_CHARS = parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "20000", 10);
  const RESCORE_BUDGET_CHUNKS = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "20", 10);

  const measure = measures[0];
  const catMeasures = [measure];

  // ---- build the FIXED evidence pack ONCE (real production building blocks) ----
  const bm25Packs = buildEvidencePacksForCategory({
    measures: catMeasures, combinedText, topicTerms,
    companyId, frameworkId: framework.id,
    reservedAnnualUrl: summ.reservedAnnualUrl,
    topicPrimaryDocUrls: summ.topicPrimaryDocUrls,
  });
  let prodPacks = bm25Packs;
  if (isRescoreEnabled()) {
    prodPacks = await rescorePacksForCategory(
      bm25Packs as any, catMeasures, combinedText,
      RESCORE_BUDGET_CHARS, RESCORE_BUDGET_CHUNKS, summ.topicPrimaryDocUrls,
    );
  }
  const prod = prodPacks.find((p: any) => p.measureId === MEASURE_ID)!;
  const evidenceText: string = prod.text;
  const evidenceFingerprintScored: string = prod.fingerprint;
  const evidenceTextHash: string = createHash("sha256").update(evidenceText).digest("hex").slice(0, 16);
  const evidenceTextLen: number = evidenceText.length;
  log(`fixed pack built: fingerprint=${evidenceFingerprintScored} textLen=${evidenceTextLen} textHash=${evidenceTextHash} combinedHash=${combinedHash}`);

  const { system, prompt } = buildBinaryScoringPrompt({
    companyName, measure, evidenceText, topicDescription, framework,
  });

  // ---- score one sample with a given provider (production seed, temp 0, gated) ----
  // Attribution is GUARANTEED pure: we call the provider's own complete() directly
  // (NOT completeScoring, which silently falls back to deepseek when a candidate
  // rate-limits — that contaminated every candidate vote in a first attempt). We
  // add our own retry/backoff on transient errors; scoring parsing + gateEvidence
  // are byte-identical to selfconsistency_run.ts.
  const seed = deterministicSeed(MEASURE_ID, companyId, 0) & 0x7fffffff;
  const scoreOne = async (provider: string): Promise<Sample> => {
    const p = getProvider(provider);
    if (!p) return { score: -1, verdict: "ERROR", downgraded: false, error: "provider not registered" };
    let lastErr = "";
    // gemini's free-tier quota is exhausted (429 even on isolated calls), so its
    // 6-retry backoff (~62s) is pure waste across 25 samples. Fail it fast (2
    // attempts); any clean samples it does return are still recorded honestly.
    const attempts = provider === "gemini" ? 2 : MAX_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // Per-provider maxTokens: claude's Anthropic SDK rejects non-streaming
        // requests whose max_tokens implies >10min ("Streaming is required ...");
        // cap claude at 8000. glm-4.6-zai returns null content at <=2000, so
        // everyone else keeps the full 32000 envelope used by selfconsistency.
        const maxTokens = provider === "claude" ? 8000 : 32000;
        const text = await p.complete({ system, prompt, json: true, maxTokens, seed, temperature: 0 } as any);
        const parsed = extractAndParseJSON(text);
        const rawScore = parsed.score === 1 ? 1 : 0; // binary
        const validVerdict = ["Yes", "No", "Partial"];
        let verdict = parsed.verdict && validVerdict.includes(parsed.verdict) ? parsed.verdict : (rawScore === 1 ? "Yes" : "No");
        const quotes = Array.isArray(parsed.quotes)
          ? parsed.quotes.filter((q: any) => q && typeof q.text === "string" && q.text.length > 0).map((q: any) => ({ text: q.text, source: q.source || "" }))
          : [];
        const { score, gate } = gateEvidence({
          originalScore: rawScore, quotes, packText: evidenceText,
          positiveExamples: measure.positiveExamples || [],
          negativeExamples: measure.negativeExamples || [],
        });
        if (gate.downgraded) verdict = "No";
        return { score, verdict, downgraded: !!gate.downgraded, provider };
      } catch (e: any) {
        lastErr = String(e?.message || e);
        // transient (429 / timeout / 5xx): exponential backoff then retry the SAME provider
        const backoff = Math.min(30000, 1000 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    return { score: -1, verdict: "ERROR", downgraded: false, error: lastErr.slice(0, 200) };
  };

  // small concurrency pool for a batch of identical sample calls to ONE provider
  async function runPool(provider: string, n: number): Promise<Sample[]> {
    const results: Sample[] = new Array(n);
    let next = 0;
    async function worker() {
      while (true) {
        const idx = next++;
        if (idx >= n) return;
        results[idx] = await scoreOne(provider);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, () => worker()));
    return results;
  }

  // binary majority over CLEAN samples: Yes iff #Yes > #No; ties -> No.
  const majorityOf = (samples: Sample[]) => {
    const yes = samples.filter((s) => s.score === 1).length;
    const no = samples.filter((s) => s.score === 0).length;
    const majority = yes > no ? 1 : 0;
    return { yes, no, majority };
  };

  // ---- sample models SEQUENTIALLY (independent rate limits never contend); each
  //      model's K*M samples run through a small per-provider concurrency pool. ----
  const byModel: Record<string, Sample[][]> = {};
  for (const model of MODELS) byModel[model] = Array.from({ length: M }, () => []);
  for (const model of MODELS) {
    if (!availability[model]) { log(`  ${model}: UNAVAILABLE — skipping`); continue; }
    const tm = Date.now();
    const flat = await runPool(model, K * M); // 25 samples in order
    for (let idx = 0; idx < flat.length; idx++) {
      const r = Math.floor(idx / K);
      byModel[model][r].push(flat[idx]);
    }
    const ok = flat.filter((s) => s.score === 0 || s.score === 1).length;
    const err = flat.filter((s) => s.score === -1).length;
    log(`  sampled ${model}: ${ok} clean, ${err} error (${Math.round((Date.now() - tm) / 1000)}s)`);
  }

  const modelSummary: Record<string, any> = {};
  for (const model of MODELS) {
    if (!availability[model]) {
      modelSummary[model] = { available: false, reason: "no API key / provider not configured", yes: 0, no: 0, error: 0, fallback: 0, cleanTotal: 0, yesFraction: null, majority: null, majorityLabel: "UNAVAILABLE", perRepeatMajorities: [], majorityStable: null };
      log(`  ${model}: UNAVAILABLE`);
      continue;
    }
    const flat = byModel[model].flat();
    const clean = flat.filter((s) => s.score === 0 || s.score === 1);
    const yes = clean.filter((s) => s.score === 1).length;
    const no = clean.filter((s) => s.score === 0).length;
    const errCount = flat.filter((s) => s.error && !s.fallback).length;
    const fbCount = flat.filter((s) => s.fallback).length;
    const perRepeatMaj: string[] = byModel[model].map((rs) => {
      const m = majorityOf(rs);
      return verdictLabel(m.majority);
    });
    // overall majority over all clean samples of the model
    const overall = clean.length ? (yes > no ? 1 : 0) : null;
    modelSummary[model] = {
      available: true,
      yes, no, error: errCount, fallback: fbCount, cleanTotal: clean.length,
      yesFraction: clean.length ? +(yes / clean.length).toFixed(4) : null,
      yesFractionOf25: +(yes / (K * M)).toFixed(4),
      majority: overall,
      majorityLabel: overall === null ? "NO-DATA" : verdictLabel(overall),
      perRepeatMajorities: perRepeatMaj,
      majorityStable: new Set(perRepeatMaj).size === 1,
    };
    log(`  ${model}: yes=${yes} no=${no} err=${errCount} fb=${fbCount} clean=${clean.length}/${K * M} frac=${modelSummary[model].yesFraction} => ${modelSummary[model].majorityLabel} (perRepeat=[${perRepeatMaj.join(",")}])`);
  }

  // ---- per-repeat records (all models side by side) ----
  const repeats: any[] = [];
  for (let r = 1; r <= M; r++) {
    const rec: any = { repeat: r, models: {} };
    for (const model of MODELS) {
      if (!availability[model]) { rec.models[model] = { available: false }; continue; }
      const rs = byModel[model][r - 1];
      const m = majorityOf(rs);
      rec.models[model] = {
        samples: rs.map((s) => ({ score: s.score, verdict: s.verdict, downgraded: s.downgraded, ...(s.fallback ? { fallback: true, provider: s.provider } : {}), ...(s.error && !s.fallback ? { error: s.error } : {}) })),
        yes: m.yes, no: m.no, majority: m.majority, majorityLabel: verdictLabel(m.majority),
      };
    }
    repeats.push(rec);
  }

  const out = {
    meta: {
      experiment: "third-vote / model-calibration on measure 3.5 (configurable model set)",
      companyId, companyName, measureId: MEASURE_ID, K, M, models: MODELS,
      wording: "production/baseline var_measures.json (measure 3.5 only)",
      fixedPack: true, temperature: 0, seed: "production deterministic (providerIndex 0)",
      evidenceGate: true, directProvider: true, concurrency: CONCURRENCY, maxAttempts: MAX_ATTEMPTS,
      glmThinking: process.env.GLM_THINKING,
      combinedTextHash: combinedHash, expectedCombinedHash: expected || null, combinedHashMatch,
      elapsedSec: null as any, ts: new Date().toISOString(),
    },
    evidenceFingerprintScored,
    evidenceTextHash,
    evidenceTextLen,
    availability,
    models: modelSummary,
    repeats,
  };
  out.meta.elapsedSec = Math.round((Date.now() - t0) / 1000);
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const fragLine = MODELS.map((m) => `${m}=${modelSummary[m].majorityLabel}${modelSummary[m].available ? `(${modelSummary[m].yes}/${modelSummary[m].cleanTotal})` : ""}`).join(" ");
  log(`SAVED ${OUT}  ${fragLine} (${out.meta.elapsedSec}s)`);
}
main().catch((e) => { log(`FATAL ${e?.stack || e}`); process.exit(1); });
