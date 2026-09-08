/**
 * Variability experiment harness — ONE (company, run) per process invocation.
 *
 *   tsx server/scripts/variability_run.ts <companyId> <runIndex> [measureLimit]
 *
 * WHY one process per (company, run): the LLM passage-rescorer (passage-rescore.ts)
 * keeps an in-process `rescoreCache` (Map). Running all 5 runs in a single process
 * would serve runs 2-5 from that cache and hide real rescore variance. A fresh
 * process per run reproduces exactly what a real re-run of the framework does:
 * cold in-process caches, identical frozen corpus (summary cache is DB-backed and
 * shared, so combinedText stays deterministic).
 *
 * WHAT it records, per measure, faithfully reproducing the production path
 * (settings: binary + cascade + cascade_v2 + ensemble + bm25 + retrieval_v2,
 *  RETRIEVAL_LLM_RESCORE default ON):
 *   (i)  chunks extracted:
 *        - BM25 pack (pre-rescore, deterministic)  : fingerprint + chunk list
 *        - production pack (post-LLM-rescore)       : fingerprint + chunk list
 *   (ii) each cascade LLM's independent verdict on the production pack:
 *        deepseek, glm-4.6, mistral-arbiter — single pass each, real seeds,
 *        real buildBinaryScoringPrompt + completeScoring — plus the reconstructed
 *        cascade decision (what production would have returned from those 3 votes).
 *
 * SCOPE / faithful-reproduction notes (documented, not hidden):
 *   - We call the REAL production building blocks (summarizeDocuments,
 *     buildEvidencePacksForCategory, rescorePacksForCategory, buildBinaryScoringPrompt,
 *     completeScoring, deterministicSeed) — no reimplementation.
 *   - We run all THREE cascade models on EVERY measure (production only fires the
 *     arbiter on deepseek/glm disagreement). This is intentional: it exposes each
 *     model's independent per-run verdict, which the conditional cascade cannot.
 *   - The scoring-time deep-read re-retrieval fallback (runTargetedReretrieval) is
 *     NOT invoked here. It is a conditional second pass; excluding it keeps each
 *     measure's evidence identity clean and interpretable. Recorded as a limitation.
 *   - issuerProfile is not supplied to summarizeDocuments (the chunk-sanity gate is
 *     therefore inert — same as any run without a cached issuer profile).
 */
import { loadSecrets } from "./variability_secrets.js";
const secretsStatus = loadSecrets();
// Required for the reliable model set: deepseek (DEEPSEEK_API_KEY), glm-4.6-zai
// (ZAI_API_KEY), claude-arbiter + mistral-or (OPENROUTER_API_KEY), DB (DATABASE_URL).
for (const req of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "DATABASE_URL"] as const) {
  if (!secretsStatus.present[req]) {
    console.error(`FATAL: missing secret ${req}`, secretsStatus.present);
    process.exit(1);
  }
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";

const HOME = "/home/ubuntu";
const OUTDIR = `${HOME}/var_out`;
mkdirSync(OUTDIR, { recursive: true });

// ---- args ----
const companyId = parseInt(process.argv[2] || "", 10);
const runIndex = parseInt(process.argv[3] || "", 10);
const measureLimit = process.argv[4] ? parseInt(process.argv[4], 10) : undefined; // for validation
if (!companyId || !runIndex) {
  console.error("usage: variability_run.ts <companyId> <runIndex> [measureLimit]");
  process.exit(1);
}

// ---- static inputs (frozen) ----
const framework = JSON.parse(readFileSync(`${HOME}/var_framework.json`, "utf8"));
let measures = JSON.parse(readFileSync(`${HOME}/var_measures.json`, "utf8"));
const lexTerms: string[] = JSON.parse(readFileSync(`${HOME}/var_topicterms.json`, "utf8"));
const companies = JSON.parse(readFileSync(`${HOME}/var_companies.json`, "utf8"));
const company = companies.find((c: any) => c.id === companyId);
if (!company) { console.error(`company ${companyId} not in var_companies.json`); process.exit(1); }
const companyName: string = company.name;
if (measureLimit) measures = measures.slice(0, measureLimit);

const OUT = `${OUTDIR}/${companyId}_run${runIndex}${measureLimit ? `_lim${measureLimit}` : ""}.json`;
if (existsSync(OUT)) { console.error(`SKIP (exists): ${OUT}`); process.exit(0); }

// Reliable model set (all confirmed working live this session):
//   primary   deepseek            (DeepSeek direct)
//   secondary glm-4.6-zai         (z.ai native — content always populated, seed+json)
//   arbiter   claude-arbiter      (anthropic/claude-sonnet-4.5 via OpenRouter — the
//                                   ORIGINAL documented cascade arbiter; prod's
//                                   cascade_v2 mistral-arbiter is currently 403 →
//                                   silent deepseek fallback, so it is unusable)
// extra:      mistral-or          (mistralai/mistral-large via OpenRouter) — recorded
//                                   as a 4th independent verdict so the intended-but-
//                                   prod-broken European arbiter's behaviour + its own
//                                   run-to-run variance are visible. NOT part of the
//                                   reconstructed 3-model cascade decision.
const CASCADE = { primary: "deepseek", secondary: "glm-4.6-zai", arbiter: "claude-arbiter" };
const EXTRA_LLMS = ["mistral-or"];
const ALL_LLMS = [CASCADE.primary, CASCADE.secondary, CASCADE.arbiter, ...EXTRA_LLMS];
// glm-4.6 / claude are reasoning-capable and need output headroom so the reasoning
// trace does not starve the JSON answer (prod's 2000 caused glm content=null). z.ai
// keeps reasoning in a separate field, but claude via OpenRouter shares the budget.
// Sized so glm-4.6's reasoning_content (a reasoning model: observed up to ~8.4k
// tokens) plus the JSON answer always fit — below this, glm intermittently hits
// finish_reason=length with empty content, a harness artifact that would masquerade
// as run-to-run variance. Non-reasoning providers stop early, so the higher cap
// costs them nothing. The provider layer clamps to each provider's maxOutputTokens.
const SCORING_MAX_TOKENS = 32000;

function deterministicSeed(measureId: string, cid: number, providerIndex: number): number {
  return createHash("sha256").update(`${measureId}:${cid}:${providerIndex}`).digest().readUInt32BE(0);
}
function extractAndParseJSON(text: string): any {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const fb = text.indexOf("{"), lb = text.lastIndexOf("}");
  if (fb !== -1 && lb > fb) { try { return JSON.parse(text.slice(fb, lb + 1)); } catch {} }
  throw new Error("Failed to parse JSON from LLM response");
}
function verdictLabel(s: number): string { return s === 1 ? "Yes" : s === 0.5 ? "Partial" : "No"; }

async function main() {
  const t0 = Date.now();
  // Import lib modules AFTER secrets are set.
  const analyzer = await import("../lib/analyzer.js");
  const { buildBinaryScoringPrompt, summarizeDocuments } = analyzer as any;
  const { buildEvidencePacksForCategory, deriveTopicTerms } = await import("../lib/passage-retrieval.js");
  const { completeScoring } = await import("../lib/ai-providers.js");
  const { rescorePacksForCategory, isRescoreEnabled } = await import("../lib/passage-rescore.js");

  // ---- frozen corpus ----
  const corpus: Array<{ url: string; title: string; text: string }> =
    JSON.parse(readFileSync(`${HOME}/var_corpus/${companyId}.json`, "utf8"));
  const documentTexts = corpus.map((d) => d.text || "");
  const documentUrls = corpus.map((d) => d.url || "");
  const documentTitles = corpus.map((d) => d.title || "");
  const totalChars = documentTexts.reduce((s, t) => s + t.length, 0);
  const topicDescription: string = framework.topicDescription || framework.name;

  // ---- Stage 1: combinedText via REAL summarizeDocuments (deterministic, no LLM) ----
  const summ = await summarizeDocuments({
    companyName, companyId, documentTexts, documentUrls, documentTitles,
    topicDescription, framework, retrievalV2: true,
  });
  const combinedText: string = summ.text;
  const combinedHash = createHash("sha256").update(combinedText).digest("hex").slice(0, 16);

  // ---- topicTerms = union(cached lexicon, deterministic terms) — as production ----
  const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  const topicTerms = [...new Set([...lexTerms, ...deterministicTerms])];

  // ---- group measures by category (as production) ----
  const catMap = new Map<string, any[]>();
  for (const m of measures) { if (!catMap.has(m.category)) catMap.set(m.category, []); catMap.get(m.category)!.push(m); }

  const RESCORE_BUDGET_CHARS = parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "20000", 10);
  const RESCORE_BUDGET_CHUNKS = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "20", 10);

  const records: any[] = [];

  for (const [category, catMeasures] of catMap) {
    // BM25 pack (pre-rescore, deterministic)
    const bm25Packs = buildEvidencePacksForCategory({
      measures: catMeasures, combinedText, topicTerms,
      companyId, frameworkId: framework.id,
      reservedAnnualUrl: summ.reservedAnnualUrl,
      topicPrimaryDocUrls: summ.topicPrimaryDocUrls,
    });
    const bm25ById = new Map(bm25Packs.map((p: any) => [p.measureId, p]));

    // Production pack (post-LLM-rescore) — deep-copy the BM25 packs first so the
    // recorded BM25 fingerprint/chunks are the untouched pre-rescore state.
    const bm25Snapshot = new Map(bm25Packs.map((p: any) => [p.measureId, JSON.parse(JSON.stringify(p))]));
    let prodPacks = bm25Packs;
    const rescoreOn = isRescoreEnabled();
    if (rescoreOn) {
      prodPacks = await rescorePacksForCategory(
        bm25Packs as any, catMeasures, combinedText,
        RESCORE_BUDGET_CHARS, RESCORE_BUDGET_CHUNKS, summ.topicPrimaryDocUrls,
      );
    }
    const prodById = new Map(prodPacks.map((p: any) => [p.measureId, p]));

    for (const measure of catMeasures) {
      const bm25 = bm25Snapshot.get(measure.measureId)!;
      const prod = prodById.get(measure.measureId)!;
      const evidenceText: string = prod.text;

      const chunkView = (p: any) => ({
        fingerprint: p.fingerprint,
        // Definitive signal: sha256 of the actual composed evidence text that is
        // fed to the LLMs. The `fingerprint`/`topChunks` diagnostics are BM25-ranked
        // and do NOT reflect the rescore's reordering/reselection, so we hash the
        // real text: a run-to-run change here isolates rescore-driven pack variance.
        textHash: createHash("sha256").update(String(p.text || "")).digest("hex"),
        textLen: String(p.text || "").length,
        chunkCount: p.chunkCount,
        totalChars: p.totalChars,
        topicHits: p.topicHits,
        forceIncludedCount: p.forceIncludedCount,
        requiredDocPresent: p.requiredDocPresent,
        topChunks: (p.passageDiagnostics?.topChunks || []).map((c: any) => ({
          docUrl: c.docUrl, docTitle: c.docTitle, seqInDoc: c.seqInDoc,
          score: c.score, forced: c.forced, textPreview: c.textPreview,
        })),
      });

      // ---- score with each LLM (single pass; real seed/prompt) ----
      const llmResults: any[] = [];
      for (const provider of ALL_LLMS) {
        const { system, prompt } = buildBinaryScoringPrompt({
          companyName, measure, evidenceText, topicDescription, framework,
        });
        // Production cascade uses providerIndex 0 (single pass per stage).
        // Mask to signed 31-bit: z.ai (glm-4.6 native) validates `seed` as a
        // signed int32 and 400s on values > 2147483647 (deterministicSeed returns
        // a full uint32). Masking is deterministic and identical every run, so it
        // adds ZERO run-to-run variance while staying within every provider's range.
        const seed = deterministicSeed(measure.measureId, companyId, 0) & 0x7fffffff;
        let rec: any = { llm: provider, seed };
        if (process.env.DUMP_GLM_PROMPT && provider === "glm-4.6-zai") {
          writeFileSync(`/home/ubuntu/glm_prompt_${measure.measureId}.json`,
            JSON.stringify({ system, prompt, seed }, null, 2));
        }
        try {
          const { text, provider: gradedBy, model } = await completeScoring(provider, {
            system, prompt, json: true, maxTokens: SCORING_MAX_TOKENS, seed,
          });
          const parsed = extractAndParseJSON(text);
          const score = parsed.score === 1 ? 1 : 0; // binary mode
          const validVerdict = ["Yes", "No", "Partial"];
          const verdict = parsed.verdict && validVerdict.includes(parsed.verdict)
            ? parsed.verdict : (score === 1 ? "Yes" : "No");
          const quotes = Array.isArray(parsed.quotes)
            ? parsed.quotes.filter((q: any) => q && typeof q.text === "string" && q.text.length > 0)
            : [];
          rec = { ...rec, gradedBy, model, score, verdict,
            evidenceSummary: String(parsed.evidenceSummary || parsed.reasoning || ""),
            quotes: quotes.map((q: any) => ({ text: q.text, source: q.source || "" })) };
        } catch (e: any) {
          rec = { ...rec, error: String(e?.message || e) };
        }
        llmResults.push(rec);
      }

      // ---- reconstruct the cascade decision from the 3 votes (scoreWithCascade) ----
      const byLlm: Record<string, any> = {};
      for (const r of llmResults) byLlm[r.llm] = r;
      const s1 = byLlm[CASCADE.primary]?.score;
      const s2 = byLlm[CASCADE.secondary]?.score;
      const s3 = byLlm[CASCADE.arbiter]?.score;
      let cascade: any;
      if (s1 == null || s2 == null) {
        cascade = { stage: "error", note: "primary/secondary missing" };
      } else if (s1 === s2) {
        cascade = { stage: "agreed", score: s1, verdict: verdictLabel(s1),
          confidence: "High", arbiterFired: false };
      } else if (s3 == null) {
        cascade = { stage: "error", note: "arbiter missing on disagreement" };
      } else {
        const votes = [s1, s2, s3];
        const uniq = Array.from(new Set(votes));
        if (uniq.length === 3) {
          cascade = { stage: "3-way", score: s3, verdict: verdictLabel(s3),
            confidence: "Review-required", arbiterFired: true };
        } else {
          const majorityScore = votes.find((v) => votes.filter((x) => x === v).length >= 2)!;
          const arbiterSidedWith = s3 === s1 ? CASCADE.primary : (s3 === s2 ? CASCADE.secondary : "neither");
          cascade = { stage: "arbiter", score: majorityScore, verdict: verdictLabel(majorityScore),
            confidence: "Medium", arbiterFired: true, arbiterSidedWith };
        }
      }

      records.push({
        measureId: measure.measureId, title: measure.title, category,
        chunks: { bm25: chunkView(bm25), production: chunkView(prod),
          rescoreOn,
          // Compare the composed evidence text (not the BM25-only fingerprint,
          // which the rescore does not update) so this flag truly reflects whether
          // the LLM rescore altered the evidence the scorers saw.
          packChangedByRescore:
            createHash("sha256").update(String(bm25.text || "")).digest("hex") !==
            createHash("sha256").update(String(prod.text || "")).digest("hex") },
        evidenceFingerprintScored: prod.fingerprint,
        llmResults, cascade,
      });
      const sM = byLlm["mistral-or"]?.score;
      const lab = (s: any) => (s == null ? "-" : verdictLabel(s));
      console.error(`  ${measure.measureId.padEnd(26)} ds=${lab(s1)} glm=${lab(s2)} claude=${lab(s3)} mistral=${lab(sM)} => ${cascade.verdict}/${cascade.stage}${records[records.length-1].chunks.packChangedByRescore ? "  [pack↻]" : ""}`);
    }
  }

  const out = {
    meta: {
      companyId, companyName, runIndex, framework: framework.name, frameworkId: framework.id,
      measureCount: measures.length, totalCorpusChars: totalChars,
      combinedTextChars: combinedText.length, combinedTextHash: combinedHash,
      summarizerModel: summ.model, topicTermCount: topicTerms.length,
      cascade: CASCADE, extraLlms: EXTRA_LLMS, allLlms: ALL_LLMS,
      scoringMaxTokens: SCORING_MAX_TOKENS,
      scoringMode: "binary", passes: 1,
      rescoreOn: isRescoreEnabled(), retrievalV2: true,
      deepReadInHarness: false, issuerProfileSupplied: false,
      elapsedSec: null as any, ts: new Date().toISOString(),
    },
    records,
  };
  out.meta.elapsedSec = Math.round((Date.now() - t0) / 1000);
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`\nSAVED ${OUT}  (${records.length} measures, ${out.meta.elapsedSec}s, combinedHash=${combinedHash})`);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
