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

// ---- cascade mode (flag/env, old behaviour preserved by default) ----
//   legacy (default): deepseek + glm-4.6-zai decide, claude-arbiter tiebreaks
//                     (the original documented cascade — byte-for-byte unchanged).
//   v2 (CASCADE_MODE=v2): deepseek + mistral-or decide, GPT-5 arbiter tiebreaks,
//                     and GLM is demoted to a scored-only extra vote that NEVER
//                     affects the verdict.
const CASCADE_MODE = (process.env.CASCADE_MODE || "legacy").toLowerCase();
const NEW_CASCADE = CASCADE_MODE === "v2";

// v2 runs are written to a distinct filename so they never clobber (or SKIP on)
// the existing legacy 13_run*.json files, keeping the A-B comparison intact.
const OUT = `${OUTDIR}/${companyId}_run${runIndex}${NEW_CASCADE ? "_v2" : ""}${measureLimit ? `_lim${measureLimit}` : ""}.json`;
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
// v2 cascade: deepseek + mistral-or are the deciding primaries, gpt5-arbiter is
// the stage-3 tiebreaker (fires ONLY on primary disagreement), and glm-4.6-zai is
// kept as a scored-only EXTRA vote that does NOT affect the verdict.
const CASCADE = NEW_CASCADE
  ? { primary: "deepseek", secondary: "mistral-or", arbiter: "gpt5-arbiter" }
  : { primary: "deepseek", secondary: "glm-4.6-zai", arbiter: "claude-arbiter" };
const EXTRA_LLMS = NEW_CASCADE ? ["glm-4.6-zai"] : ["mistral-or"];
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
// extractAndParseJSON is imported (not duplicated) from ../lib/analyzer.js inside
// main() — see the dynamic import block below — so the harness uses the IDENTICAL
// parse+repair+raw-on-failure-logging logic as production.
function verdictLabel(s: number): string { return s === 1 ? "Yes" : s === 0.5 ? "Partial" : "No"; }

async function main() {
  const t0 = Date.now();
  // Import lib modules AFTER secrets are set.
  const analyzer = await import("../lib/analyzer.js");
  const { buildBinaryScoringPrompt, summarizeDocuments, extractAndParseJSON } = analyzer as any;
  const { buildEvidencePacksForCategory, deriveTopicTerms } = await import("../lib/passage-retrieval.js");
  const { completeScoring } = await import("../lib/ai-providers.js");
  const { rescorePacksForCategory, isRescoreEnabled } = await import("../lib/passage-rescore.js");
  const { gateEvidence } = await import("../lib/evidence-gate.js");

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

      // ---- score ONE provider (real seed/prompt) + apply the evidence gate ----
      const scoreOne = async (provider: string) => {
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
          const rawScore = parsed.score === 1 ? 1 : 0; // binary mode
          const validVerdict = ["Yes", "No", "Partial"];
          let verdict = parsed.verdict && validVerdict.includes(parsed.verdict)
            ? parsed.verdict : (rawScore === 1 ? "Yes" : "No");
          const quotes = Array.isArray(parsed.quotes)
            ? parsed.quotes.filter((q: any) => q && typeof q.text === "string" && q.text.length > 0)
            : [];
          const cleanQuotes = quotes.map((q: any) => ({ text: q.text, source: q.source || "" }));
          // ---- deterministic evidence-integrity gate: applied to EVERY model
          //      (primaries, extra votes, AND the arbiter) right after JSON parse
          //      and BEFORE any cascade decision uses this score. Binary preserved. ----
          const { score, gate } = gateEvidence({
            originalScore: rawScore, quotes: cleanQuotes, packText: evidenceText,
            positiveExamples: measure.positiveExamples || [],
            negativeExamples: measure.negativeExamples || [],
          });
          if (gate.downgraded) verdict = "No"; // gate-downgraded YES → No (0/1 kept)
          rec = { ...rec, gradedBy, model, score, verdict,
            evidenceSummary: String(parsed.evidenceSummary || parsed.reasoning || ""),
            quotes: cleanQuotes, gate };
        } catch (e: any) {
          rec = { ...rec, error: String(e?.message || e) };
        }
        return rec;
      };

      // ---- score the deciding primaries + extra votes (arbiter deferred in v2) ----
      const llmResults: any[] = [];
      // v2: score only the primaries + extra (glm) up front; the GPT-5 arbiter is
      //     fired conditionally below (ONLY on primary disagreement).
      // legacy: score all four as before so the 3-vote reconstruction has s3.
      const preArbiter = NEW_CASCADE
        ? [CASCADE.primary, CASCADE.secondary, ...EXTRA_LLMS]
        : ALL_LLMS;
      for (const provider of preArbiter) llmResults.push(await scoreOne(provider));

      const byLlm: Record<string, any> = {};
      for (const r of llmResults) byLlm[r.llm] = r;
      const s1 = byLlm[CASCADE.primary]?.score;   // GATED
      const s2 = byLlm[CASCADE.secondary]?.score; // GATED
      let cascade: any;

      if (NEW_CASCADE) {
        // ---- v2: primaries decide; GPT-5 arbiter fires ONLY on disagreement ----
        if (s1 == null || s2 == null) {
          cascade = { stage: "error", note: "primary/secondary missing", arbiterFired: false };
        } else if (s1 === s2) {
          cascade = { stage: "agreed", score: s1, verdict: verdictLabel(s1),
            confidence: "High", arbiterFired: false };
        } else {
          const arbRec = await scoreOne(CASCADE.arbiter); // gated inside scoreOne
          llmResults.push(arbRec);
          byLlm[arbRec.llm] = arbRec;
          const s3 = arbRec.score;
          if (s3 == null) {
            cascade = { stage: "error", note: "arbiter missing on disagreement", arbiterFired: true };
          } else {
            const arbiterSidedWith = s3 === s1 ? CASCADE.primary
              : (s3 === s2 ? CASCADE.secondary : "neither");
            cascade = { stage: "arbiter", score: s3, verdict: verdictLabel(s3),
              confidence: "Medium", arbiterFired: true, arbiterSidedWith };
          }
        }
      } else {
        // ---- legacy (unchanged): deepseek+glm decide, claude tiebreaks on disagree ----
        const s3 = byLlm[CASCADE.arbiter]?.score;
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

      const lab = (s: any) => (s == null ? "-" : verdictLabel(s));
      const gv = (llm: string) => { // gated verdict + ↓ if the gate downgraded it
        const r = byLlm[llm];
        if (!r) return "-";
        return `${lab(r.score)}${r.gate && r.gate.downgraded ? "↓" : ""}`;
      };
      const packMark = records[records.length - 1].chunks.packChangedByRescore ? "  [pack↻]" : "";
      if (NEW_CASCADE) {
        console.error(`  ${measure.measureId.padEnd(26)} ds=${gv(CASCADE.primary)} mistral=${gv(CASCADE.secondary)} gpt5=${gv(CASCADE.arbiter)} glm=${gv("glm-4.6-zai")} => ${cascade.verdict}/${cascade.stage}${cascade.arbiterFired ? " [arb]" : ""}${packMark}`);
      } else {
        console.error(`  ${measure.measureId.padEnd(26)} ds=${gv(CASCADE.primary)} glm=${gv(CASCADE.secondary)} claude=${gv(CASCADE.arbiter)} mistral=${gv("mistral-or")} => ${cascade.verdict}/${cascade.stage}${packMark}`);
      }
    }
  }

  const out = {
    meta: {
      companyId, companyName, runIndex, framework: framework.name, frameworkId: framework.id,
      measureCount: measures.length, totalCorpusChars: totalChars,
      combinedTextChars: combinedText.length, combinedTextHash: combinedHash,
      summarizerModel: summ.model, topicTermCount: topicTerms.length,
      cascade: CASCADE, extraLlms: EXTRA_LLMS, allLlms: ALL_LLMS,
      cascadeMode: CASCADE_MODE, evidenceGate: true,
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
