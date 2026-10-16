/**
 * evidence_recall_benchmark.ts — A5 / WP06: deterministic passage-level recall
 * benchmark of the evidence pack shown to the scoring role.
 *
 * WHAT IT MEASURES (plan §"A5. Improve retrieval and evidence-pack recall"):
 *   For a FIXED, frozen corpus and the real framework/measures, it records the
 *   EXACT evidence pack built for each (company, measure) at the ACTUAL PROMPT
 *   BUDGET — the same pack the scoring role sees — and reports passage-level
 *   RECALL of the measure's DECISIVE passages: of all passages in the corpus that
 *   carry a sufficient density of the measure's framework-authored decisive
 *   signal, how many actually reached the budgeted pack. It also reports, in
 *   SHADOW (read-only, pack unchanged), how many of the MISSES the A5 bounded
 *   expansion could recover (eligible decisive passages present in the corpus but
 *   crowded out of the pack).
 *
 * FREE / OFFLINE / DETERMINISTIC:
 *   - NO paid LLM calls. The combinedText is built by the REAL, deterministic
 *     summarizeDocuments (retrievalV2 BM25 corpus selection — no model), and packs
 *     by the REAL buildEvidencePacksForCategory. Identical to the variability_run
 *     offline harness, so "the pack shown to the scorer" is production's own pack.
 *   - READ-ONLY w.r.t. the production DB: it needs NO prod database. summarizeDocuments
 *     only touches a `summary_cache` table (lookup + write); point DATABASE_URL at
 *     ANY empty/throwaway Postgres (a cache miss is the normal path). The frozen
 *     corpus + framework + measures are read from local JSON fixtures.
 *   - DETERMINISTIC: every step (chunking, BM25, oracle, recall, expansion plan) is
 *     pure and stable, so re-runs are byte-identical.
 *
 * FIXTURES (same as variability_run.ts):
 *   $HOME/var_framework.json      the framework (snake_case; normalised below)
 *   $HOME/var_measures.json       the measures   (snake_case; normalised below)
 *   $HOME/var_topicterms.json     cached lexicon terms (string[])
 *   $HOME/var_companies.json      [{ id, name }]
 *   $HOME/var_corpus/<id>.json    per-company frozen corpus [{ url, title, text }]
 *   $HOME/var_corpus/<id>.ndjson  streaming sibling for corpora over the V8 string limit
 *
 * USAGE:
 *   DATABASE_URL=postgresql://user@host/anydb \
 *     npx tsx server/scripts/evidence_recall_benchmark.ts [companyIds] [measureLimit]
 *   - companyIds: comma list (default: every company in var_companies.json that has
 *     a corpus file). e.g. "1,11,14"
 *   - measureLimit: cap measures per company (for a fast smoke run).
 *   Env: RECALL_BENCH_OUT_DIR (default $HOME/var_out), RETRIEVAL_CORPUS_MAX_CHARS,
 *        RETRIEVAL_EVIDENCE_TOP_K, RETRIEVAL_EVIDENCE_MAX_CHARS (all pass through to
 *        the real pipeline so the benchmark tracks the live budget).
 *
 * OUTPUT (written to the out dir):
 *   evidence_recall_benchmark.json  machine-readable per-(company,measure) + aggregate
 *   evidence_recall_benchmark.md    human-readable summary
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import {
  computeDecisivePassages,
  measurePackRecall,
  planBoundedExpansion,
  stablePassageId,
  resolveRecallExpansionPolicy,
  RECALL_EXPANSION_ENV,
} from "../lib/evidence-recall.js";
import type { Chunk } from "../lib/passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

const HOME = process.env.HOME || "/home/ubuntu";
const OUT_DIR = process.env.RECALL_BENCH_OUT_DIR || `${HOME}/var_out`;

// ─── Fixture loading + snake→camel normalisation (framework-level, no company logic) ─

function loadJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Normalise a measure fixture (snake_case) to the camelCase fields the pipeline reads. */
function normaliseMeasure(m: any): FrameworkMeasure & { evidenceKeywords: string[] } {
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
  } as any;
}

/** Normalise a framework fixture (snake_case) to the camelCase fields the pipeline reads. */
function normaliseFramework(f: any): any {
  return {
    id: f.id,
    name: f.name,
    topicDescription: f.topic_description ?? f.topicDescription,
    requiredDocTypes: f.required_doc_types ?? f.requiredDocTypes,
    dataPatterns: f.data_patterns ?? f.dataPatterns,
    negativeKeywords: f.negative_keywords ?? f.negativeKeywords,
    negativeDomains: f.negative_domains ?? f.negativeDomains,
    knownDisclosureUrls: f.known_disclosure_urls ?? f.knownDisclosureUrls,
    trustedSourceIds: f.trusted_source_ids ?? f.trustedSourceIds,
  };
}

/** Streaming corpus loader for corpora that exceed the V8 single-string limit. */
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
      console.log(`[corpus] ${corpusPath} exceeds V8 string limit — streaming NDJSON sibling`);
      return loadCorpusStreaming(corpusPath);
    }
    throw e;
  }
}

// ─── Membership: which full-corpus chunks actually reached the budgeted pack ────
// The pack text is assembled verbatim from the selected chunk texts (with "---
// DOCUMENT: ..." headers), so a chunk is "in the pack" iff its exact text is a
// substring of the pack text. This recovers the EXACT pack passage set by stable
// identity — the ground truth for recall "at the actual prompt budget".
function packPassageIdsFor(packText: string, chunks: Chunk[]): { ids: Set<string>; matched: Chunk[] } {
  const ids = new Set<string>();
  const matched: Chunk[] = [];
  for (const c of chunks) {
    if (c.text && packText.includes(c.text)) {
      ids.add(stablePassageId(c));
      matched.push(c);
    }
  }
  return { ids, matched };
}

// ─── Per-company evaluation ────────────────────────────────────────────────────

interface MeasureRecallRow {
  companyId: number;
  companyName: string;
  category: string;
  measureId: string;
  title: string;
  packChunks: number;
  packChars: number;
  decisiveCount: number;
  recalledCount: number;
  recall: number;
  missCount: number;
  // SHADOW (read-only): how many misses the A5 bounded expansion could recover
  // (eligible decisive passages in the corpus, absent from the pack).
  expansionRecoverable: number;
  expansionAddedChars: number;
  expansionCapHit: boolean;
}

async function evaluateCompany(
  company: { id: number; name: string },
  measures: Array<FrameworkMeasure & { evidenceKeywords: string[] }>,
  framework: any,
  topicTerms: string[],
  pipeline: any,
): Promise<MeasureRecallRow[]> {
  const { summarizeDocuments, buildEvidencePacksForCategory, chunkDocuments } = pipeline;
  const corpus = await loadCorpus(company.id);
  const documentTexts = corpus.map((d) => d.text || "");
  const documentUrls = corpus.map((d) => d.url || "");
  const documentTitles = corpus.map((d) => d.title || "");
  const topicDescription: string = framework.topicDescription || framework.name;

  // Stage 1 — REAL deterministic combinedText (retrievalV2 BM25 corpus selection, no LLM).
  const summ = await summarizeDocuments({
    companyName: company.name,
    companyId: company.id,
    documentTexts,
    documentUrls,
    documentTitles,
    topicDescription,
    framework,
    retrievalV2: true,
  });
  const combinedText: string = summ.text;

  // The full chunk universe of the budgeted corpus = the oracle universe AND the
  // membership source. (Same chunker the pack builder uses internally.)
  const chunks: Chunk[] = chunkDocuments(combinedText);

  // Group measures by category exactly as production does.
  const catMap = new Map<string, Array<FrameworkMeasure & { evidenceKeywords: string[] }>>();
  for (const m of measures) {
    if (!catMap.has(m.category)) catMap.set(m.category, []);
    catMap.get(m.category)!.push(m);
  }

  const rows: MeasureRecallRow[] = [];
  for (const [category, catMeasures] of catMap) {
    const packs = buildEvidencePacksForCategory({
      measures: catMeasures,
      combinedText,
      topicTerms,
      companyId: company.id,
      frameworkId: framework.id,
      reservedAnnualUrl: summ.reservedAnnualUrl,
      topicPrimaryDocUrls: summ.topicPrimaryDocUrls,
    });
    const packById = new Map(packs.map((p: any) => [p.measureId, p]));

    for (const measure of catMeasures) {
      const pack: any = packById.get(measure.measureId);
      const packText: string = pack?.text || "";
      const { ids: packIds, matched: packChunks } = packPassageIdsFor(packText, chunks);

      const decisive = computeDecisivePassages({ measure, chunks });
      const recall = measurePackRecall({ decisive, packPassageIds: packIds });

      // SHADOW expansion — read-only; measures recoverability of the misses.
      const plan = planBoundedExpansion({
        misses: recall.misses,
        chunks,
        packPassageIds: packIds,
        packChunks,
        measure,
      });

      rows.push({
        companyId: company.id,
        companyName: company.name,
        category,
        measureId: measure.measureId,
        title: measure.title,
        packChunks: packChunks.length,
        packChars: packText.length,
        decisiveCount: recall.decisiveCount,
        recalledCount: recall.recalledCount,
        recall: recall.recall,
        missCount: recall.misses.length,
        expansionRecoverable: plan.added.length,
        expansionAddedChars: plan.addedChars,
        expansionCapHit: plan.capHit,
      });
    }
  }
  return rows;
}

// ─── Aggregation + reporting ────────────────────────────────────────────────────

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function microRecall(rows: MeasureRecallRow[]): number {
  const dec = rows.reduce((s, r) => s + r.decisiveCount, 0);
  const rec = rows.reduce((s, r) => s + r.recalledCount, 0);
  return dec === 0 ? 1 : rec / dec;
}

function buildMarkdown(
  rows: MeasureRecallRow[],
  perCompany: Map<number, MeasureRecallRow[]>,
  meta: any,
): string {
  const lines: string[] = [];
  lines.push("# A5 / WP06 — Evidence-Pack Recall Benchmark");
  lines.push("");
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "- Deterministic, free, offline. The combinedText is built by the REAL " +
      "`summarizeDocuments` (retrievalV2 BM25 corpus selection — no LLM) and the pack " +
      "by the REAL `buildEvidencePacksForCategory`, so the measured pack is the exact " +
      "pack the scoring role sees at the actual prompt budget.",
  );
  lines.push(
    "- **Decisive passage** (framework-level oracle): a corpus passage carrying a " +
      "sufficient density of the measure's OWN framework-authored decisive signal " +
      "(`title` + `evidenceKeywords`): ≥ 2 distinct decisive tokens, or a verbatim " +
      "multi-word evidenceKeyword phrase. ZERO per-company / per-topic logic.",
  );
  lines.push(
    "- **Recall** = (decisive passages present in the budgeted pack) / (decisive passages in the corpus).",
  );
  lines.push(
    "- **Expansion-recoverable (shadow)** = decisive MISSES that the A5 bounded, " +
      "A3-eligibility-composing, append-only expansion could add back WITHOUT shrinking " +
      "the pack. Shadow only — the pack is NOT modified by the benchmark.",
  );
  lines.push("");
  lines.push("## Budget / configuration");
  lines.push("");
  lines.push(`- Corpus selection budget (RETRIEVAL_CORPUS_MAX_CHARS): ${meta.budgets.corpusMaxChars}`);
  lines.push(`- Pack top-k (RETRIEVAL_EVIDENCE_TOP_K): ${meta.budgets.topK}`);
  lines.push(`- Pack max chars (RETRIEVAL_EVIDENCE_MAX_CHARS): ${meta.budgets.evidenceMaxChars}`);
  lines.push(`- Kill-switch (${RECALL_EXPANSION_ENV}) resolved: \`${meta.policy}\` (benchmark runs the expansion in SHADOW regardless; default prod = \`off\`)`);
  lines.push("");

  // Aggregate
  const totalDecisive = rows.reduce((s, r) => s + r.decisiveCount, 0);
  const totalRecalled = rows.reduce((s, r) => s + r.recalledCount, 0);
  const totalMiss = rows.reduce((s, r) => s + r.missCount, 0);
  const totalRecoverable = rows.reduce((s, r) => s + r.expansionRecoverable, 0);
  const macro =
    rows.length === 0 ? 1 : rows.reduce((s, r) => s + r.recall, 0) / rows.length;
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`- Companies evaluated: ${perCompany.size}`);
  lines.push(`- (company × measure) cells: ${rows.length}`);
  lines.push(`- Decisive passages (corpus total): ${totalDecisive}`);
  lines.push(`- Recalled into the budgeted pack: ${totalRecalled}`);
  lines.push(`- **Micro-averaged recall: ${fmtPct(microRecall(rows))}**`);
  lines.push(`- Macro-averaged recall (mean over cells): ${fmtPct(macro)}`);
  lines.push(`- Decisive misses: ${totalMiss}`);
  lines.push(
    `- Of which recoverable by A5 bounded expansion (shadow): ${totalRecoverable}` +
      ` (${totalMiss === 0 ? "n/a" : fmtPct(totalRecoverable / totalMiss)} of misses)`,
  );
  lines.push("");

  // Per-company table
  lines.push("## Per-company recall");
  lines.push("");
  lines.push("| Company | Cells | Decisive | Recalled | Recall (micro) | Misses | Recoverable (shadow) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [cid, crows] of perCompany) {
    const name = crows[0]?.companyName ?? String(cid);
    const dec = crows.reduce((s, r) => s + r.decisiveCount, 0);
    const rec = crows.reduce((s, r) => s + r.recalledCount, 0);
    const miss = crows.reduce((s, r) => s + r.missCount, 0);
    const recov = crows.reduce((s, r) => s + r.expansionRecoverable, 0);
    lines.push(
      `| ${name} (${cid}) | ${crows.length} | ${dec} | ${rec} | ${fmtPct(microRecall(crows))} | ${miss} | ${recov} |`,
    );
  }
  lines.push("");

  // Lowest-recall cells (where retrieval loses decisive material)
  const worst = [...rows]
    .filter((r) => r.decisiveCount > 0)
    .sort((a, b) => a.recall - b.recall || b.missCount - a.missCount)
    .slice(0, 25);
  lines.push("## Lowest-recall cells (top 25 — where decisive material is crowded out)");
  lines.push("");
  lines.push("| Company | Measure | Decisive | Recalled | Recall | Misses | Recoverable |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of worst) {
    lines.push(
      `| ${r.companyName} (${r.companyId}) | ${r.measureId} | ${r.decisiveCount} | ${r.recalledCount} | ${fmtPct(r.recall)} | ${r.missCount} | ${r.expansionRecoverable} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict-invariance note");
  lines.push("");
  lines.push(
    "The default kill-switch value is `off` (current production behaviour), so the " +
      "shipped default appends nothing and the production verdict surface is byte-identical. " +
      "This benchmark measures recall and the shadow recoverability of the bounded expansion; " +
      "it does NOT change any pack or verdict.",
  );
  lines.push("");
  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const framework = normaliseFramework(loadJSON<any>(`${HOME}/var_framework.json`));
  const measuresRaw = loadJSON<any[]>(`${HOME}/var_measures.json`);
  const lexTerms = loadJSON<string[]>(`${HOME}/var_topicterms.json`);
  const companies = loadJSON<Array<{ id: number; name: string }>>(`${HOME}/var_companies.json`);

  let measures = measuresRaw.map(normaliseMeasure);
  const measureLimit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
  if (measureLimit) measures = measures.slice(0, measureLimit);

  // Company selection: explicit arg, else every company with a corpus file.
  let companyIds: number[];
  if (process.argv[2]) {
    companyIds = process.argv[2].split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  } else {
    companyIds = companies
      .map((c) => c.id)
      .filter((id) => existsSync(`${HOME}/var_corpus/${id}.json`) || existsSync(`${HOME}/var_corpus/${id}.ndjson`));
  }

  // Import the REAL production building blocks (after env is set).
  const analyzer = await import("../lib/analyzer.js");
  const pr = await import("../lib/passage-retrieval.js");
  const pipeline = {
    summarizeDocuments: (analyzer as any).summarizeDocuments,
    buildEvidencePacksForCategory: (pr as any).buildEvidencePacksForCategory,
    deriveTopicTerms: (pr as any).deriveTopicTerms,
    chunkDocuments: (pr as any).chunkDocuments,
  };
  const deterministicTerms = pipeline.deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  const topicTerms = [...new Set([...lexTerms, ...deterministicTerms])];

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const allRows: MeasureRecallRow[] = [];
  const perCompany = new Map<number, MeasureRecallRow[]>();
  const errors: Array<{ companyId: number; error: string }> = [];

  for (const cid of companyIds) {
    const company = companies.find((c) => c.id === cid);
    if (!company) {
      console.error(`[skip] company ${cid} not in var_companies.json`);
      continue;
    }
    console.log(`[company ${cid}] ${company.name} — evaluating...`);
    try {
      const rows = await evaluateCompany(company, measures, framework, topicTerms, pipeline);
      allRows.push(...rows);
      perCompany.set(cid, rows);
      console.log(
        `[company ${cid}] done: ${rows.length} cells, micro-recall ${fmtPct(microRecall(rows))}`,
      );
    } catch (e: any) {
      const msg = (e && e.message) || String(e);
      console.error(`[company ${cid}] ERROR: ${msg}`);
      errors.push({ companyId: cid, error: msg });
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    frameworkId: framework.id,
    frameworkName: framework.name,
    companiesEvaluated: [...perCompany.keys()],
    companiesErrored: errors,
    measureCount: measures.length,
    policy: resolveRecallExpansionPolicy(),
    budgets: {
      corpusMaxChars: parseInt(process.env.RETRIEVAL_CORPUS_MAX_CHARS || "560000", 10),
      topK: parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "45", 10),
      evidenceMaxChars: parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "45000", 10),
    },
  };

  const jsonOut = {
    meta,
    aggregate: {
      cells: allRows.length,
      decisive: allRows.reduce((s, r) => s + r.decisiveCount, 0),
      recalled: allRows.reduce((s, r) => s + r.recalledCount, 0),
      microRecall: microRecall(allRows),
      macroRecall: allRows.length === 0 ? 1 : allRows.reduce((s, r) => s + r.recall, 0) / allRows.length,
      misses: allRows.reduce((s, r) => s + r.missCount, 0),
      expansionRecoverable: allRows.reduce((s, r) => s + r.expansionRecoverable, 0),
    },
    rows: allRows,
  };

  const jsonPath = `${OUT_DIR}/evidence_recall_benchmark.json`;
  const mdPath = `${OUT_DIR}/evidence_recall_benchmark.md`;
  writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));
  writeFileSync(mdPath, buildMarkdown(allRows, perCompany, meta));

  console.log("");
  console.log(`[done] ${allRows.length} cells across ${perCompany.size} companies in ${meta.elapsedSec}s`);
  console.log(`[done] micro-recall ${fmtPct(jsonOut.aggregate.microRecall)}, misses ${jsonOut.aggregate.misses}, recoverable ${jsonOut.aggregate.expansionRecoverable}`);
  if (errors.length) console.log(`[done] ${errors.length} company error(s): ${errors.map((e) => e.companyId).join(", ")}`);
  console.log(`[done] wrote ${jsonPath}`);
  console.log(`[done] wrote ${mdPath}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
