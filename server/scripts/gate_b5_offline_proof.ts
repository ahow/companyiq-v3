/**
 * gate_b5_offline_proof.ts — B5 / WP13-C GATE5 STEP 1 (offline, LLM-free).
 *
 * Over the frozen corpus of a baseline batch (default 1293: A5-on, B1-on, B5-off),
 * reconstruct — for EVERY company × measure cell — the evidence pack the way
 * current production produces it, then apply the B5 context-trim (planContextTrim,
 * policy=on) and assert the HARD INVARIANT verifyTrimPreservesRecall for every
 * cell: decisive pack passages ⊆ kept set, recall preserved with identical misses.
 *
 * FAITHFUL RECONSTRUCTION (mirrors the sanctioned variability_run.ts harness):
 *   1. Frozen corpus loaded with the EXACT production replay query
 *      (COALESCE(dc.content, d.content), ORDER BY d.id) — the real document text
 *      lives in document_content, joined via documents.content_id.
 *   2. combinedText built by the REAL production retrieval-corpus builder
 *      summarizeDocuments(...) (deterministic BM25, no LLM), retrievalV2=false to
 *      match workspace 3's production setting (retrieval_v2 unset ⇒ false).
 *   3. Evidence packs built by the REAL buildEvidencePacksForCategory, grouped by
 *      category, with reservedAnnualUrl + topicPrimaryDocUrls from the summarizer —
 *      exactly as analyzer.ts does.
 *   4. A5 bounded expansion (planBoundedExpansion) then B5 context-trim
 *      (planContextTrim) at the same analyzer seam, in the same order.
 *
 * The proof PASSES only if the invariant holds for 100% of cells. It also
 * quantifies token savings (A5-settled pack vs B5-trimmed pack).
 *
 * DOCUMENTED SIMPLIFICATIONS (neither can weaken the invariant):
 *   - The optional LLM passage-rescore REORDER (passage-rescore.ts) is omitted.
 *     It only reorders/reselects within budget and cannot affect the trim
 *     invariant, which keeps every decisive passage regardless of order. Savings
 *     are therefore computed on the BM25+A5 pack; the REAL token/cost delta is
 *     measured end-to-end by STEP 3's live batch.
 *   - A5 eligibility is applied as the fail-open superset (isEligible=true),
 *     exactly as the analyzer's A3 fail-open catch branch — a conservative choice
 *     that puts MORE passages in the pack (more trim candidates), so it cannot
 *     hide an invariant violation.
 *
 * Usage:
 *   DATABASE_URL=... node --import tsx server/scripts/gate_b5_offline_proof.ts [baselineBatchId]
 */
import { mkdirSync, writeFileSync } from "fs";
import { Pool } from "pg";

const BASELINE_BATCH = parseInt(process.argv[2] || "1293", 10);
const WORKSPACE_ID = 3;
const OUTDIR = "/home/ubuntu/github_repos/companyiq-v3/gate_b5_out";
// DeepSeek-chat (primary first-pass scorer) published input price, USD per 1M
// input tokens. The evidence pack is part of the input prompt on every cascade
// stage; this is the conservative single-stage projection.
const DEEPSEEK_INPUT_USD_PER_M = 0.27;
// Token estimate: ~4 chars/token (standard GPT-family approximation).
const CHARS_PER_TOKEN = 4;
const tok = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}

// Generic snake_case → camelCase row mapper, so framework/measure objects carry
// EVERY column under the camelCase names the production code reads (Drizzle shape),
// without hand-listing dozens of fields. jsonb columns are already parsed by pg.
function camel<T = any>(row: Record<string, any>): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    out[ck] = v;
    out[k] = v; // keep snake_case too (belt-and-braces for any snake reader)
  }
  return out as T;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

async function main() {
  mkdirSync(OUTDIR, { recursive: true });

  // Import the REAL production building blocks (after env is set).
  const analyzer = await import("../lib/analyzer.js");
  const { summarizeDocuments } = analyzer as any;
  const {
    buildEvidencePacksForCategory,
    chunkDocuments,
    deriveTopicTerms,
  } = await import("../lib/passage-retrieval.js");
  const {
    computeDecisivePassages,
    measurePackRecall,
    planBoundedExpansion,
    formatExpansionAppend,
    stablePassageId,
  } = await import("../lib/evidence-recall.js");
  const { planContextTrim, verifyTrimPreservesRecall } = await import("../lib/model-cost.js");

  // ── Load framework + measures (full rows → camelCase Drizzle shape) ─────────
  const fwRes = await pool.query(
    `SELECT * FROM frameworks WHERE id=(SELECT framework_id FROM batch_runs WHERE id=$1)`,
    [BASELINE_BATCH],
  );
  if (fwRes.rows.length === 0) throw new Error("framework not found for batch " + BASELINE_BATCH);
  const framework: any = camel(fwRes.rows[0]);
  const frameworkId: number = framework.id;

  const mRes = await pool.query(
    `SELECT * FROM framework_measures WHERE framework_id=$1 ORDER BY display_order`,
    [frameworkId],
  );
  const measures: any[] = mRes.rows.map((r) => camel(r));
  console.error(`framework ${frameworkId} "${framework.name}" — ${measures.length} measures`);

  // ── topicTerms: cached lexicon ∪ deterministicTerms (mirrors analyzer) ─────
  const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  let lexTerms: string[] = [];
  try {
    const lxRes = await pool.query(
      `SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key=$2`,
      [WORKSPACE_ID, `topic_lexicon:v1:${frameworkId}`],
    );
    if (lxRes.rows[0]?.value) {
      const parsed = JSON.parse(lxRes.rows[0].value);
      if (Array.isArray(parsed.terms)) lexTerms = parsed.terms.filter((t: any) => typeof t === "string");
    }
  } catch { /* fall back to deterministic only */ }
  const topicTerms = [...new Set([...lexTerms, ...deterministicTerms])];
  console.error(`topicTerms=${topicTerms.length} (lexicon=${lexTerms.length} + deterministic=${deterministicTerms.length})`);

  // ── Company order (job order) ──────────────────────────────────────────────
  const coRes = await pool.query(
    `SELECT aj.company_id AS id, c.name FROM analysis_jobs aj JOIN companies c ON c.id=aj.company_id
     WHERE aj.batch_id=$1 ORDER BY aj.id`,
    [BASELINE_BATCH],
  );
  const companies = coRes.rows as Array<{ id: number; name: string }>;
  console.error(`companies in batch ${BASELINE_BATCH}: ${companies.length}`);

  // ── group measures by category (as production) ─────────────────────────────
  const catMap = new Map<string, any[]>();
  for (const m of measures) {
    const cat = m.category;
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat)!.push(m);
  }

  const cells: any[] = [];
  let anyViolation = false;

  for (const co of companies) {
    // Frozen corpus for (batch, company) — EXACT production replay query.
    const docRes = await pool.query(
      `SELECT d.id, d.url, d.title, COALESCE(dc.content, d.content) AS content
       FROM batch_corpus bc
       JOIN documents d ON d.id = bc.document_id
       LEFT JOIN document_content dc ON dc.id = d.content_id
       WHERE bc.batch_id=$1 AND bc.company_id=$2
       ORDER BY d.id`,
      [BASELINE_BATCH, co.id],
    );
    const docs = docRes.rows as Array<{ url: string; title: string; content: string }>;
    const documentTexts = docs.map((d) => d.content || "");
    const documentUrls = docs.map((d) => d.url || "");
    const documentTitles = docs.map((d) => d.title || "");
    const totalChars = documentTexts.reduce((a, t) => a + t.length, 0);

    // combinedText via the REAL production retrieval-corpus builder (no LLM).
    // retrievalV2=false matches workspace 3's production setting.
    const summ = await summarizeDocuments({
      companyName: co.name,
      companyId: co.id,
      documentTexts,
      documentUrls,
      documentTitles,
      topicDescription: framework.topicDescription || framework.name,
      framework,
      retrievalV2: false,
    });
    const combinedText: string = summ.text || "";
    const corpusChunks = chunkDocuments(combinedText);
    console.error(
      `  ${co.name} (#${co.id}): ${docs.length} docs, ${totalChars.toLocaleString()} raw chars ` +
      `→ combinedText ${combinedText.length.toLocaleString()} chars (${summ.model}), ${corpusChunks.length} chunks`,
    );

    // Build packs per category, exactly as the analyzer does.
    const packById = new Map<string, any>();
    for (const [, catMeasures] of catMap) {
      const packs = buildEvidencePacksForCategory({
        measures: catMeasures,
        combinedText,
        topicTerms,
        companyId: co.id,
        frameworkId,
        reservedAnnualUrl: summ.reservedAnnualUrl,
        topicPrimaryDocUrls: summ.topicPrimaryDocUrls,
      });
      for (const p of packs) packById.set(p.measureId, p);
    }

    for (const measure of measures) {
      const pack = packById.get(measure.measureId);
      const evidenceText: string = pack?.text || "";

      // ── A5 bounded expansion (policy=on), deterministic, append-only ────────
      let finalEvidence = evidenceText;
      if (evidenceText) {
        const a5PackChunks = corpusChunks.filter((c: any) => c.text && evidenceText.includes(c.text));
        const a5PackIds = new Set(a5PackChunks.map((c: any) => stablePassageId(c)));
        const decisive = computeDecisivePassages({ measure, chunks: corpusChunks });
        const recall = measurePackRecall({ decisive, packPassageIds: a5PackIds });
        const plan = planBoundedExpansion({
          misses: recall.misses,
          chunks: corpusChunks,
          packPassageIds: a5PackIds,
          packChunks: a5PackChunks,
          measure,
          isEligible: () => true, // fail-open superset (matches analyzer catch branch)
        });
        if (plan.fired) finalEvidence = evidenceText + formatExpansionAppend(plan);
      }

      // ── B5 context-trim (policy=on), mirrors the analyzer seam exactly ──────
      const trimPackChunks = corpusChunks.filter((c: any) => c.text && finalEvidence.includes(c.text));
      const trimPlan = planContextTrim({
        measure,
        packChunks: trimPackChunks,
        corpusChunks,
        apply: true,
      });
      const verify = verifyTrimPreservesRecall({
        measure,
        packChunks: trimPackChunks,
        corpusChunks,
        plan: trimPlan,
      });

      // Apply the trim to the text the same way the analyzer does.
      const keptSet = new Set(trimPlan.keptIds);
      let trimmedText = finalEvidence;
      for (const c of trimPackChunks) {
        if (!c.text) continue;
        if (keptSet.has(stablePassageId(c))) continue;
        trimmedText = trimmedText.split(c.text).join("");
      }

      const origTokens = tok(finalEvidence);
      const trimTokens = tok(trimmedText);
      const ok = verify.ok && verify.missesEqual && verify.trimmedRecall === verify.originalRecall;
      if (!ok) anyViolation = true;

      cells.push({
        companyId: co.id,
        companyName: co.name,
        measureId: measure.measureId,
        decisivePackCount: trimPlan.decisivePackCount,
        trimmedPassages: trimPlan.trimmedIds.length,
        keptPassages: trimPlan.keptIds.length,
        bytesSaved: trimPlan.bytesSaved,
        originalRecall: verify.originalRecall,
        trimmedRecall: verify.trimmedRecall,
        missesEqual: verify.missesEqual,
        invariantOk: ok,
        origChars: finalEvidence.length,
        trimChars: trimmedText.length,
        origTokens,
        trimTokens,
        tokensSaved: origTokens - trimTokens,
      });
    }
    console.error(`  ${co.name} (#${co.id}) done — ${measures.length} cells`);
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const total = cells.length;
  const okCells = cells.filter((c) => c.invariantOk).length;
  const violating = cells.filter((c) => !c.invariantOk);
  const firedCells = cells.filter((c) => c.trimmedPassages > 0).length;
  const sumOrigTok = cells.reduce((a, c) => a + c.origTokens, 0);
  const sumTrimTok = cells.reduce((a, c) => a + c.trimTokens, 0);
  const sumTokSaved = sumOrigTok - sumTrimTok;
  const sumOrigChars = cells.reduce((a, c) => a + c.origChars, 0);
  const sumTrimChars = cells.reduce((a, c) => a + c.trimChars, 0);
  const pctTokReduction = sumOrigTok > 0 ? (sumTokSaved / sumOrigTok) * 100 : 0;
  const usdSavedPerBatch = (sumTokSaved / 1_000_000) * DEEPSEEK_INPUT_USD_PER_M;

  const agg = {
    baselineBatch: BASELINE_BATCH,
    frameworkId,
    frameworkName: framework.name,
    companies: companies.length,
    measures: measures.length,
    totalCells: total,
    invariantOkCells: okCells,
    invariantViolatingCells: violating.length,
    invariantHolds100pct: violating.length === 0,
    cellsWhereTrimFired: firedCells,
    sumOrigChars,
    sumTrimChars,
    sumOrigTokens: sumOrigTok,
    sumTrimTokens: sumTrimTok,
    tokensSaved: sumTokSaved,
    pctTokenReduction: Number(pctTokReduction.toFixed(2)),
    deepseekInputUsdPerM: DEEPSEEK_INPUT_USD_PER_M,
    projectedUsdSavedPerBatchFirstPass: Number(usdSavedPerBatch.toFixed(4)),
    charsPerTokenAssumption: CHARS_PER_TOKEN,
    note: "combinedText via REAL summarizeDocuments(retrievalV2=false); packs via REAL buildEvidencePacksForCategory per category. LLM passage-rescore REORDER omitted (reorder-only, cannot affect trim invariant); A5 eligibility applied as fail-open superset.",
  };

  writeFileSync(`${OUTDIR}/gate_b5_offline_proof.json`, JSON.stringify({ agg, cells }, null, 2));

  // ── Markdown report ─────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# B5 / WP13-C GATE5 — STEP 1 Offline Held-Out Proof`);
  lines.push("");
  lines.push(`**Baseline corpus:** batch ${BASELINE_BATCH} (A5-on, B1-on, B5-off) · framework ${frameworkId} "${framework.name}"`);
  lines.push(`**Cells:** ${total} (${companies.length} companies × ${measures.length} measures)`);
  lines.push(`**Reconstruction:** REAL summarizeDocuments (retrievalV2=false) + REAL buildEvidencePacksForCategory (per category) + A5 planBoundedExpansion + B5 planContextTrim — same seam/order as analyzer.ts.`);
  lines.push("");
  lines.push(`## Hard invariant (verifyTrimPreservesRecall)`);
  lines.push("");
  lines.push(`- Cells where invariant holds: **${okCells} / ${total}**`);
  lines.push(`- Violating cells: **${violating.length}**`);
  lines.push(`- **Proof ${violating.length === 0 ? "PASSES ✅ (100% of cells)" : "FAILS ❌"}**`);
  lines.push("");
  lines.push(`## Token savings (B5 trim, policy=on)`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Cells where trim fired (≥1 redundant repeat removed) | ${firedCells} / ${total} |`);
  lines.push(`| Original (A5-settled) pack tokens (sum) | ${sumOrigTok.toLocaleString()} |`);
  lines.push(`| Trimmed pack tokens (sum) | ${sumTrimTok.toLocaleString()} |`);
  lines.push(`| Tokens saved (sum) | ${sumTokSaved.toLocaleString()} |`);
  lines.push(`| **Aggregate token reduction** | **${pctTokReduction.toFixed(2)}%** |`);
  lines.push(`| Chars saved (sum) | ${(sumOrigChars - sumTrimChars).toLocaleString()} |`);
  lines.push(`| Projected $ saved / 10-co batch (first-pass, DeepSeek @ $${DEEPSEEK_INPUT_USD_PER_M}/M in) | $${usdSavedPerBatch.toFixed(4)} |`);
  lines.push("");
  lines.push(`> Projection is the conservative single-stage (DeepSeek first-pass) input-token saving on the BM25+A5 pack (LLM rescore omitted offline); the pack appears in every cascade stage's prompt, so realized saving compounds across stages. STEP 3's live batch measures the true end-to-end delta.`);
  lines.push("");
  lines.push(`## Per-company summary`);
  lines.push("");
  lines.push(`| Company | Cells | Invariant OK | Trim fired | Orig tok | Trim tok | Reduction |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const co of companies) {
    const cc = cells.filter((c) => c.companyId === co.id);
    const okc = cc.filter((c) => c.invariantOk).length;
    const fc = cc.filter((c) => c.trimmedPassages > 0).length;
    const ot = cc.reduce((a, c) => a + c.origTokens, 0);
    const tt = cc.reduce((a, c) => a + c.trimTokens, 0);
    const pr = ot > 0 ? ((ot - tt) / ot) * 100 : 0;
    lines.push(`| ${co.name} | ${cc.length} | ${okc}/${cc.length} | ${fc} | ${ot.toLocaleString()} | ${tt.toLocaleString()} | ${pr.toFixed(2)}% |`);
  }
  lines.push("");
  if (violating.length > 0) {
    lines.push(`## ❌ VIOLATING CELLS (STOP — do not flip)`);
    lines.push("");
    lines.push(`| Company | Measure | origRecall | trimRecall | missesEqual |`);
    lines.push(`|---|---|---|---|---|`);
    for (const v of violating) {
      lines.push(`| ${v.companyName} | ${v.measureId} | ${v.originalRecall} | ${v.trimmedRecall} | ${v.missesEqual} |`);
    }
  }
  writeFileSync(`${OUTDIR}/gate_b5_offline_proof.md`, lines.join("\n"));

  console.log(JSON.stringify(agg, null, 2));
  console.log(`\nArtifacts: ${OUTDIR}/gate_b5_offline_proof.{json,md}`);

  await pool.end();
  if (anyViolation) {
    console.error("\n❌ INVARIANT VIOLATED — STOP, do not flip.");
    process.exit(2);
  }
  console.error("\n✅ Invariant holds for 100% of cells.");
}

main().catch((e) => {
  console.error("PROOF ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
