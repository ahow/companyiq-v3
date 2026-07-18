/**
 * Cost estimate for a FULL RESET re-examination of ~2,500 companies.
 *
 * Grounded in:
 *  - Code-enforced LLM limits (analyzer.ts, discovery.ts, passage-retrieval.ts,
 *    company-verification.ts, ai-providers.ts)
 *  - Measured per-company profile from the live DB:
 *      avg discovered docs/company = 49 (median 54, max 89)
 *      avg ok docs/company         = 34 (median 35)
 *      median corpus               = 3.66M chars  (avg 4.33M, p90 8.23M)
 *      framework measures          = 26
 *      self-consistency passes     = 3
 *
 * All scoring/discovery/verification runs on deepseek-chat (user preference:
 * Deepseek primary). DeepSeek pricing (deepseek-chat, standard tier, USD):
 *      input  (cache miss): $0.27 / 1M tokens
 *      input  (cache hit) : $0.07 / 1M tokens
 *      output             : $1.10 / 1M tokens
 * Token rule of thumb for English/markdown corpora: ~4 chars / token.
 *
 * NOTE: This estimates the EXTERNAL LLM API dollar cost (DeepSeek). It is the
 * objective, measurable quantity. Manus "credits" are a separate platform
 * billing unit that this script cannot price; see the report for guidance.
 */

const CHARS_PER_TOKEN = 4;
const N_COMPANIES = 2500;
const MEASURES = 26;
const PASSES = 3;

// DeepSeek deepseek-chat pricing (USD per 1M tokens)
const P_IN_MISS = 0.27 / 1e6;
const P_IN_HIT  = 0.07 / 1e6;
const P_OUT     = 1.10 / 1e6;

function tok(chars) { return chars / CHARS_PER_TOKEN; }

// ─── Per-company token model ────────────────────────────────────────────────
// 1) SCORING (dominant): 26 measures x 3 passes = 78 calls.
//    Each call input = system+prompt+evidence. Evidence is capped at
//    RETRIEVAL_EVIDENCE_MAX_CHARS = 20,000 chars (~5,000 tokens). Prompt
//    scaffolding (rubric, definition, instructions) ~1,500 tokens. Output
//    capped maxTokens=2000 but typical JSON verdict ~350 tokens.
const SCORING_CALLS = MEASURES * PASSES; // 78
const EVID_TOKENS = tok(20000);          // ~5000
const SCORING_PROMPT_SCAFFOLD = 1500;
const SCORING_IN_PER_CALL = EVID_TOKENS + SCORING_PROMPT_SCAFFOLD; // ~6500
const SCORING_OUT_TYP = 350;
const SCORING_OUT_HI = 2000;

// Caching: across 3 passes of the same measure, and across the 26 measures of a
// company, the bulky shared parts (rubric scaffold + overlapping evidence) are
// substantially cache-hittable on DeepSeek's automatic context cache. We model
// a cache-hit fraction on the INPUT tokens.
const CACHE_HIT_FRAC = { low: 0.6, exp: 0.45, high: 0.2 };

// 2) RELEVANCE GATE (discovery): classify discovered URLs in batches of 20.
//    avg 49 discovered -> 3 batches. Each call ~ (URLs metadata in) + (JSON out).
const DISC_BATCHES = Math.ceil(49 / 20); // 3
const GATE_IN_PER_BATCH = 1200;  // 20 url+title+snippet rows
const GATE_OUT_PER_BATCH = 700;  // accept/reject JSON

// 3) PER-COMPANY one-offs: query-variant gen, topic lexicon, terminology,
//    temporal validation, exec summary.
const ONEOFF = [
  { name: "query_variants", in: 800,  out: 500 },
  { name: "topic_lexicon",  in: 1000, out: 1200 }, // often cached per-framework, counted once/co conservatively
  { name: "terminology",    in: tok(15000), out: 1200 }, // 15k char prefix
  { name: "temporal_valid", in: 2000, out: 1500 },
  { name: "exec_summary",   in: 600,  out: 300 },
];

// 4) DOCUMENT VERIFICATION: off-domain candidate issuer checks. Own-domain docs
//    fast-path with NO llm call. Model a fraction of discovered docs needing a
//    verify call (~300 tokens out each, ~1500 in for the snippet).
const VERIFY_FRAC = { low: 0.25, exp: 0.45, high: 0.7 };
const VERIFY_IN = 1500, VERIFY_OUT = 300;
const DISCOVERED = 49;

function perCompany(scn) {
  const cacheHit = CACHE_HIT_FRAC[scn];
  const verifyFrac = VERIFY_FRAC[scn];
  const outTok = scn === "high" ? SCORING_OUT_HI : (scn === "low" ? 300 : SCORING_OUT_TYP);

  // scoring input split into cached/uncached
  const scoringInTotal = SCORING_CALLS * SCORING_IN_PER_CALL;
  const scoringInHit = scoringInTotal * cacheHit;
  const scoringInMiss = scoringInTotal * (1 - cacheHit);
  const scoringOut = SCORING_CALLS * outTok;

  // gate
  const gateInTotal = DISC_BATCHES * GATE_IN_PER_BATCH;
  const gateOut = DISC_BATCHES * GATE_OUT_PER_BATCH;

  // one-offs
  let oneoffIn = 0, oneoffOut = 0;
  for (const o of ONEOFF) { oneoffIn += o.in; oneoffOut += o.out; }

  // verification
  const vCount = Math.round(DISCOVERED * verifyFrac);
  const verifyIn = vCount * VERIFY_IN;
  const verifyOut = vCount * VERIFY_OUT;

  const inMiss = scoringInMiss + gateInTotal + oneoffIn + verifyIn;
  const inHit = scoringInHit;
  const out = scoringOut + gateOut + oneoffOut + verifyOut;

  const cost = inMiss * P_IN_MISS + inHit * P_IN_HIT + out * P_OUT;
  return {
    scn,
    scoringCalls: SCORING_CALLS,
    totalCalls: SCORING_CALLS + DISC_BATCHES + ONEOFF.length + vCount,
    inMissTok: Math.round(inMiss), inHitTok: Math.round(inHit), outTok: Math.round(out),
    costPerCompany: cost,
  };
}

console.log("=== Per-company estimate (DeepSeek deepseek-chat, USD) ===\n");
const rows = ["low","exp","high"].map(perCompany);
for (const r of rows) {
  console.log(`[${r.scn.toUpperCase()}] calls=${r.totalCalls} (scoring ${r.scoringCalls}) | ` +
    `in_miss=${r.inMissTok.toLocaleString()} in_hit=${r.inHitTok.toLocaleString()} out=${r.outTok.toLocaleString()} tok | ` +
    `$${r.costPerCompany.toFixed(4)}/company`);
}
console.log("\n=== Fleet estimate for " + N_COMPANIES.toLocaleString() + " companies (USD) ===\n");
for (const r of rows) {
  const fleet = r.costPerCompany * N_COMPANIES;
  console.log(`[${r.scn.toUpperCase()}]  $${fleet.toFixed(2)}  (~$${(fleet/N_COMPANIES).toFixed(3)}/co)  | total LLM calls ~${(r.totalCalls*N_COMPANIES).toLocaleString()}`);
}

// Sensitivity: scoring-only (the dominant term), no cache, typical out
const noCacheScoringIn = SCORING_CALLS * SCORING_IN_PER_CALL;
const scoringOnly = noCacheScoringIn * P_IN_MISS + SCORING_CALLS * SCORING_OUT_TYP * P_OUT;
console.log("\n=== Sensitivity ===");
console.log(`Scoring-only, NO cache, typical output: $${scoringOnly.toFixed(4)}/company -> fleet $${(scoringOnly*N_COMPANIES).toFixed(2)}`);
console.log(`If self-consistency disabled (1 pass instead of 3): scoring cost ~1/3.`);
