/**
 * SELF-CONSISTENCY (majority-vote) experiment — measurement only, NOT production.
 *
 *   tsx server/scripts/selfconsistency_run.ts <companyId>
 *
 * PURPOSE
 * -------
 * Test whether k-of-k majority voting on the two DECIDING v2 grader models
 * (deepseek + mistral-or) removes the run-to-run cascade "flip" on measure
 * 3.5-erm-integration for company 12 (BHP), while keeping companies 16/20 stable.
 *
 * DESIGN (implemented exactly)
 * ----------------------------
 *  - Wording: PRODUCTION/baseline var_measures.json, restricted to measure 3.5.
 *  - CASCADE_MODE = v2 semantics: deepseek + mistral-or are the two deciding
 *    votes; the GPT-5 arbiter fires ONLY when the two majorities disagree.
 *  - FIXED EVIDENCE PACK: the evidence pack is built ONCE per company (real
 *    summarizeDocuments -> buildEvidencePacksForCategory -> rescorePacksForCategory)
 *    and REUSED for every sample, so this is a pure grader-variance test. The
 *    scored fingerprint is recorded so the fixed pack is auditable.
 *  - Within one EVALUATION (repeat): call deepseek k=5 times and mistral-or k=5
 *    times (temperature 0, independent completeScoring calls, production seed).
 *    Each sample is gated by the SAME production evidence gate. Binary convention:
 *    Partial / don't-know -> No. Majority = Yes iff #Yes > #No; ties -> No.
 *  - Repeat the whole evaluation M=5 times per company (independent).
 *
 * OUTPUT: /home/ubuntu/var_out_35_selfconsistency/<companyId>.json
 *   { meta, evidenceFingerprintScored, repeats:[ { repeat, deepseek:{samples,
 *     yes,no,majority}, mistralOr:{...}, arbiterFired, arbiterVerdict,
 *     cascadeVerdict } ] }
 *
 * This script calls the REAL production building blocks; it does not reimplement
 * scoring. It does NOT modify any production code path and writes only under
 * /home/ubuntu.
 */
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
const OUTDIR = process.env.SC_OUT_DIR || `${HOME}/var_out_35_selfconsistency`;
mkdirSync(OUTDIR, { recursive: true });
const LOG = `${OUTDIR}/driver.log`;
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  appendFileSync(LOG, line + "\n");
}

// ---- experiment constants ----
const MEASURE_ID = "3.5-erm-integration";
const K = parseInt(process.env.SC_K || "5", 10);   // samples per model per repeat
const M = parseInt(process.env.SC_M || "5", 10);   // repeats per company
const PRIMARIES = ["deepseek", "mistral-or"] as const;
const ARBITER = "gpt5-arbiter";

// ---- args ----
const companyId = parseInt(process.argv[2] || "", 10);
if (!companyId) { console.error("usage: selfconsistency_run.ts <companyId>"); process.exit(1); }

// ---- static inputs (frozen) — identical to variability_run.ts ----
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

async function main() {
  const t0 = Date.now();
  const OUT = `${OUTDIR}/${companyId}.json`;
  if (existsSync(OUT) && process.env.SC_FORCE !== "1") { log(`SKIP (exists): ${OUT}`); process.exit(0); }
  log(`START company ${companyId} (${companyName}) K=${K} M=${M} measure=${MEASURE_ID}`);

  const analyzer = await import("../lib/analyzer.js");
  const { buildBinaryScoringPrompt, summarizeDocuments, extractAndParseJSON } = analyzer as any;
  const { buildEvidencePacksForCategory, deriveTopicTerms } = await import("../lib/passage-retrieval.js");
  const { completeScoring } = await import("../lib/ai-providers.js");
  const { rescorePacksForCategory, isRescoreEnabled } = await import("../lib/passage-rescore.js");
  const { gateEvidence } = await import("../lib/evidence-gate.js");

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
  // Composed-text hash of the ACTUAL pack fed to the models (varies run-to-run in
  // production; fixed within a session here). Recorded so a cross-session verdict
  // change can be attributed to pack recomposition vs model drift. Semantics of
  // scoring are unchanged — this only records an extra hash of the same pack.
  const evidenceTextHash: string = createHash("sha256").update(evidenceText).digest("hex").slice(0, 16);
  const evidenceTextLen: number = evidenceText.length;
  log(`fixed pack built: fingerprint=${evidenceFingerprintScored} textLen=${evidenceTextLen} textHash=${evidenceTextHash} combinedHash=${combinedHash}`);

  const { system, prompt } = buildBinaryScoringPrompt({
    companyName, measure, evidenceText, topicDescription, framework,
  });

  // ---- score one sample with a given provider (production seed, temp 0, gated) ----
  const scoreOne = async (provider: string): Promise<{ score: number; verdict: string; downgraded: boolean; error?: string }> => {
    const seed = deterministicSeed(MEASURE_ID, companyId, 0) & 0x7fffffff;
    try {
      const { text } = await completeScoring(provider, {
        system, prompt, json: true, maxTokens: 32000, seed, temperature: 0,
      });
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
      return { score, verdict, downgraded: !!gate.downgraded };
    } catch (e: any) {
      return { score: -1, verdict: "ERROR", downgraded: false, error: String(e?.message || e) };
    }
  };

  // binary majority: Yes iff #Yes(score==1) > #No; ties -> No (conservative).
  const majorityOf = (samples: Array<{ score: number }>) => {
    const yes = samples.filter((s) => s.score === 1).length;
    const no = samples.filter((s) => s.score === 0).length;
    const majority = yes > no ? 1 : 0; // tie -> 0 (No)
    return { yes, no, majority };
  };

  const repeats: any[] = [];
  for (let r = 1; r <= M; r++) {
    const modelResults: Record<string, any> = {};
    for (const provider of PRIMARIES) {
      const samples: Array<{ score: number; verdict: string; downgraded: boolean; error?: string }> = [];
      for (let i = 0; i < K; i++) samples.push(await scoreOne(provider));
      const errs = samples.filter((s) => s.score === -1);
      if (errs.length) log(`  repeat ${r} ${provider}: ${errs.length}/${K} ERROR (${errs[0].error})`);
      const maj = majorityOf(samples);
      modelResults[provider] = {
        samples: samples.map((s) => ({ score: s.score, verdict: s.verdict, downgraded: s.downgraded, ...(s.error ? { error: s.error } : {}) })),
        yes: maj.yes, no: maj.no, majority: maj.majority, majorityLabel: verdictLabel(maj.majority),
      };
    }
    const dsMaj = modelResults["deepseek"].majority;
    const miMaj = modelResults["mistral-or"].majority;
    let arbiterFired = false, arbiterVerdict: string | null = null, cascadeScore: number;
    if (dsMaj === miMaj) {
      cascadeScore = dsMaj;
    } else {
      arbiterFired = true;
      const arb = await scoreOne(ARBITER);
      arbiterVerdict = arb.verdict;
      cascadeScore = arb.score === 1 ? 1 : 0;
    }
    const rec = {
      repeat: r,
      deepseek: modelResults["deepseek"],
      mistralOr: modelResults["mistral-or"],
      arbiterFired,
      arbiterVerdict,
      cascadeVerdict: verdictLabel(cascadeScore),
    };
    repeats.push(rec);
    log(`  repeat ${r}: ds(maj=${verdictLabel(dsMaj)} ${modelResults["deepseek"].yes}Y/${modelResults["deepseek"].no}N) ` +
        `mistral(maj=${verdictLabel(miMaj)} ${modelResults["mistral-or"].yes}Y/${modelResults["mistral-or"].no}N) ` +
        `arb=${arbiterFired}${arbiterVerdict ? "("+arbiterVerdict+")" : ""} => ${rec.cascadeVerdict}`);
  }

  const cascadeYes = repeats.filter((r) => r.cascadeVerdict === "Yes").length;
  const dsMajorities = repeats.map((r) => r.deepseek.majorityLabel);
  const miMajorities = repeats.map((r) => r.mistralOr.majorityLabel);
  const out = {
    meta: {
      experiment: "self-consistency majority vote on deciding v2 graders",
      companyId, companyName, measureId: MEASURE_ID, K, M,
      wording: "production/baseline var_measures.json (measure 3.5 only)",
      cascadeMode: "v2 (deepseek + mistral-or decide; gpt5-arbiter on disagreement)",
      fixedPack: true, temperature: 0, seed: "production deterministic (providerIndex 0)",
      evidenceGate: true, combinedTextHash: combinedHash,
      elapsedSec: null as any, ts: new Date().toISOString(),
    },
    evidenceFingerprintScored,
    evidenceTextHash,
    evidenceTextLen,
    summary: {
      deepseekMajorities: dsMajorities,
      mistralOrMajorities: miMajorities,
      deepseekMajorityStable: new Set(dsMajorities).size === 1,
      mistralOrMajorityStable: new Set(miMajorities).size === 1,
      cascadeYesCount: cascadeYes, cascadeTotal: M,
      cascadeVerdicts: repeats.map((r) => r.cascadeVerdict),
    },
    repeats,
  };
  out.meta.elapsedSec = Math.round((Date.now() - t0) / 1000);
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  log(`SAVED ${OUT}  cascadeYes=${cascadeYes}/${M} dsMaj=[${dsMajorities.join(",")}] miMaj=[${miMajorities.join(",")}] (${out.meta.elapsedSec}s)`);
}
main().catch((e) => { log(`FATAL ${e?.stack || e}`); process.exit(1); });
