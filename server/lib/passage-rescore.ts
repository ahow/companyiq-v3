// I69 — LLM Passage Rescoring
//
// Motivation: BM25 keyword density does not reliably surface the definitive
// evidentiary passage for a measure inside a large corporate document. Truth-
// baseline validation on fw9 (batch 1109 vs primary sources for 6 companies)
// showed 100% precision but only 26% recall — the app was systematically
// missing evidence that exists in the corpus but does not win BM25 selection.
//
// This module re-ranks the top BM25 candidates using a cheap LLM (DeepSeek),
// which evaluates each candidate for evidentiary relevance to the measure's
// scoring guidance rather than keyword density.
//
// The rescoring is:
//   - Framework-agnostic: uses only measure.title, measure.definition, and
//     measure.scoringGuidance from the framework schema. No topic literals.
//   - Optional: gated by RETRIEVAL_LLM_RESCORE env flag. Off by default.
//   - Cached: results keyed on (measureId, chunkTextHash) so replays are free.
//   - Deterministic (temperature=0).
//   - Bounded: at most one LLM call per measure per company (batched candidates).
//
// The blended final score is 0.3 * BM25_normalized + 0.7 * LLM_score, tunable
// via env. The 0.7 weight on the LLM reflects that BM25 has already been shown
// to under-rank definitive-evidence passages; letting the LLM dominate is the
// point of the change.

import { createHash } from "crypto";
import { buildBM25Index, bm25Score, chunkDocuments, tokenize, type Chunk, type EvidencePack, type BM25Index } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

const RESCORE_ENABLED = process.env.RETRIEVAL_LLM_RESCORE === "1" || process.env.RETRIEVAL_LLM_RESCORE === "true";
const RESCORE_MODEL = process.env.RETRIEVAL_LLM_RESCORE_MODEL || "deepseek";
const RESCORE_CANDIDATES = parseInt(process.env.RETRIEVAL_LLM_RESCORE_CANDIDATES || "30", 10);
const RESCORE_BM25_WEIGHT = parseFloat(process.env.RETRIEVAL_LLM_RESCORE_BM25_WEIGHT || "0.3");
const RESCORE_MAX_CHARS_PER_CANDIDATE = parseInt(process.env.RETRIEVAL_LLM_RESCORE_MAX_CHARS || "600", 10);

export function isRescoreEnabled(): boolean { return RESCORE_ENABLED; }

// In-process cache keyed by (measureId + chunkText hash). Postgres cache is a
// future extension. This alone is sufficient because the same chunk is often
// scored across companies (SEC boilerplate) and the same measure runs 25x
// per batch on different companies with mostly-disjoint chunks; a shared
// per-process map still cuts duplicated calls.
const rescoreCache = new Map<string, number>();
function cacheKey(measureId: string, chunkText: string): string {
  const h = createHash("sha256").update(chunkText).digest("hex").slice(0, 24);
  return `${measureId}::${h}`;
}

interface Candidate {
  idx: number;         // index into the source chunks array
  chunk: Chunk;
  bm25: number;        // raw BM25 score for the measure
  llm?: number;        // LLM-assigned evidence score 0..10 (assigned after rescoring)
}

// Score all chunks with BM25 for the given measure and return top-N candidates.
function selectTopBM25Candidates(chunks: Chunk[], bm25Index: BM25Index, measure: FrameworkMeasure, topN: number): Candidate[] {
  const queryText = [measure.title || "", measure.definition || "", ...((measure as any).evidenceKeywords || [])].join(" ");
  const q = tokenize(queryText);
  const scored: Candidate[] = chunks.map((chunk, idx) => ({ idx, chunk, bm25: bm25Score(q, idx, bm25Index) }));
  scored.sort((a, b) => b.bm25 - a.bm25);
  return scored.slice(0, topN).filter(c => c.bm25 > 0 || c.chunk.text.length > 0);
}

// Build the rescoring prompt. Frames the measure with its Yes rule so the LLM
// judges evidentiary relevance to the SPECIFIC criterion, not just topical
// relevance.
function buildRescorePrompt(measure: FrameworkMeasure, candidates: Candidate[]): { system: string; user: string } {
  const sg: any = measure.scoringGuidance || {};
  const yesRule = (typeof sg === "string" ? "" : (sg.yes || "")) || "Specific evidence directly answering the question.";
  const exclusions = (typeof sg === "string" ? [] : (sg.explicit_exclusions || [])) as string[];

  const system = "You are a strict evidence-relevance judge for corporate disclosure assessment. Given a scoring question, its YES rule, and a list of candidate text passages retrieved from the company's public documents, score each passage 0-10 for how directly it would support a YES verdict. High scores go only to passages containing specific, verbatim evidence of what the YES rule requires. Low scores go to passages that mention the topic without providing the specific evidence the rule requires. Return valid JSON only.";

  const rulesBlock = [
    `Question: ${measure.title || ""}`,
    `Definition: ${(measure.definition || "").slice(0, 400)}`,
    `YES rule: ${yesRule.slice(0, 400)}`,
    exclusions.length > 0 ? `Exclusions (score 0-2 if the passage matches an exclusion): ${exclusions.slice(0, 3).map(e => e.slice(0, 100)).join(" | ")}` : "",
  ].filter(Boolean).join("\n");

  const passages = candidates.map((c, i) => {
    const t = c.chunk.text.replace(/\s+/g, " ").trim().slice(0, RESCORE_MAX_CHARS_PER_CANDIDATE);
    return `[${i}] ${t}`;
  }).join("\n\n");

  const user = `${rulesBlock}

Score each of the following candidate passages 0-10 on evidentiary relevance to the YES rule. Return JSON array only:
[{"id":0,"s":<0-10>},{"id":1,"s":<0-10>},...]

Passages:
${passages}`;

  return { system, user };
}

// Parse the LLM response into a scores map. Robust to markdown code blocks and
// stray text.
function parseLLMScores(raw: string, n: number): Map<number, number> {
  const out = new Map<number, number>();
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return out;
  try {
    const arr = JSON.parse(arrayMatch[0]);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const id = typeof item?.id === "number" ? item.id : (typeof item?.i === "number" ? item.i : null);
        const s = typeof item?.s === "number" ? item.s : (typeof item?.score === "number" ? item.score : null);
        if (id !== null && s !== null && id >= 0 && id < n) {
          out.set(id, Math.max(0, Math.min(10, s)));
        }
      }
    }
  } catch { /* fall through */ }
  return out;
}

// Async: call the LLM to score the candidates. Returns Map<candidateIdx, llmScore>
// where candidateIdx is the position in the input array (0..n-1).
async function scoreCandidatesWithLLM(measure: FrameworkMeasure, candidates: Candidate[]): Promise<Map<number, number>> {
  const { completeWithFallback } = await import("./ai-providers.js");

  // Check per-chunk cache first; batch only uncached items.
  const uncachedIndexes: number[] = [];
  const scores = new Map<number, number>();
  for (let i = 0; i < candidates.length; i++) {
    const key = cacheKey(measure.measureId, candidates[i].chunk.text);
    if (rescoreCache.has(key)) scores.set(i, rescoreCache.get(key)!);
    else uncachedIndexes.push(i);
  }
  if (uncachedIndexes.length === 0) return scores;

  const toScore = uncachedIndexes.map((globalIdx, localIdx) => ({ globalIdx, localIdx, cand: candidates[globalIdx] }));

  const localBatch: Candidate[] = toScore.map(t => t.cand);
  const { system, user } = buildRescorePrompt(measure, localBatch);

  let raw = "";
  try {
    const resp = await completeWithFallback(RESCORE_MODEL, {
      system,
      prompt: user,
      maxTokens: 2048,
      temperature: 0,
      json: true,
    });
    raw = resp.text || "";
  } catch (err: any) {
    console.warn(`[llm-rescore] ${measure.measureId}: LLM call failed (${err?.message || err}); falling back to BM25 order`);
    return scores; // fall back: uncached candidates get no LLM score, blended score will fall back to BM25
  }

  const parsed = parseLLMScores(raw, toScore.length);
  if (parsed.size === 0) {
    console.warn(`[llm-rescore] ${measure.measureId}: LLM returned no parseable scores (raw ${raw.length} chars); falling back to BM25`);
    return scores;
  }
  // Map local ids back to global candidate indexes and cache
  for (const [localId, score] of parsed) {
    const t = toScore[localId];
    if (!t) continue;
    scores.set(t.globalIdx, score);
    rescoreCache.set(cacheKey(measure.measureId, t.cand.chunk.text), score);
  }
  return scores;
}

// Public: re-rank the candidates of an evidence pack using LLM rescoring. Returns
// a new EvidencePack whose text and chunkCount reflect the new ranking. If the
// LLM call fails, returns the original pack unchanged.
export async function rescorePackWithLLM(
  pack: EvidencePack,
  measure: FrameworkMeasure,
  combinedText: string,
  budgetChars: number = 20000,
  budgetChunks: number = 20,
): Promise<EvidencePack> {
  if (!RESCORE_ENABLED) return pack;
  if (!pack.text || pack.text.length === 0) return pack;

  // Recompute chunks and BM25 index over the same corpus the original pack was
  // built from. This is idempotent; the sync builder already did this work but
  // did not expose the full candidate pool.
  const chunks = chunkDocuments(combinedText);
  if (chunks.length === 0) return pack;

  const bm25 = buildBM25Index(chunks.map(c => c.text));
  const candidates = selectTopBM25Candidates(chunks, bm25, measure, RESCORE_CANDIDATES);
  if (candidates.length === 0) return pack;

  // Score candidates with LLM
  const llmScores = await scoreCandidatesWithLLM(measure, candidates);
  if (llmScores.size === 0) {
    // Fell back — keep original pack
    return pack;
  }

  // Normalize BM25 to 0..10 range for blending
  const maxBM25 = Math.max(...candidates.map(c => c.bm25), 1e-6);
  candidates.forEach(c => {
    (c as any).bm25Norm = (c.bm25 / maxBM25) * 10;
  });

  // Blend scores. Candidates without an LLM score fall back to BM25 (weight 1.0
  // implicitly, since they can't win any LLM signal).
  const blended = candidates.map((c, i) => {
    const bm = (c as any).bm25Norm as number;
    const llm = llmScores.get(i);
    const final = llm !== undefined
      ? RESCORE_BM25_WEIGHT * bm + (1 - RESCORE_BM25_WEIGHT) * llm
      : bm; // no LLM score → keep BM25 order
    return { c, final, llm };
  });

  blended.sort((a, b) => b.final - a.final);

  // Build the new pack text respecting budgets. Deterministic tiebreak = original
  // BM25 rank (already reflected in candidate order).
  let text = "";
  let chunkCount = 0;
  const perDocCount = new Map<number, number>();
  const MAX_PER_DOC = 5; // matches the sync builder's default cap

  for (const b of blended) {
    if (chunkCount >= budgetChunks) break;
    if (text.length + b.c.chunk.text.length > budgetChars) continue;
    const doc = b.c.chunk.docIndex;
    const used = perDocCount.get(doc) || 0;
    if (used >= MAX_PER_DOC) continue;
    text += (text.length > 0 ? "\n\n" : "") + b.c.chunk.text;
    chunkCount++;
    perDocCount.set(doc, used + 1);
  }

  // Log what changed at the top of the list (diagnostic only)
  const top5Before = candidates.slice(0, 5).map(c => `bm=${c.bm25.toFixed(1)}`).join(",");
  const top5After = blended.slice(0, 5).map(b => `bm=${b.c.bm25.toFixed(1)},llm=${b.llm ?? "-"}`).join(",");
  console.log(`[llm-rescore] ${measure.measureId}: before=[${top5Before}] after=[${top5After}]`);

  return {
    ...pack,
    text,
    chunkCount,
    totalChars: text.length,
    // Preserve fingerprint eligibility semantics of the original pack
  };
}

// Public: bulk rescoring for a category. Fires all measures in parallel but
// respects the shared LLM semaphore in ai-providers.ts, so total in-flight
// stays bounded.
export async function rescorePacksForCategory(
  packs: EvidencePack[],
  measures: FrameworkMeasure[],
  combinedText: string,
  budgetChars: number = 20000,
  budgetChunks: number = 20,
): Promise<EvidencePack[]> {
  if (!RESCORE_ENABLED) return packs;
  if (packs.length === 0 || measures.length === 0) return packs;

  // Match packs to measures by measureId
  const measureById = new Map(measures.map(m => [m.measureId, m]));
  const results = await Promise.all(packs.map(async (pack) => {
    const m = measureById.get(pack.measureId);
    if (!m) return pack;
    try {
      return await rescorePackWithLLM(pack, m, combinedText, budgetChars, budgetChunks);
    } catch (err: any) {
      console.warn(`[llm-rescore] measure ${pack.measureId} rescoring failed (${err?.message || err}); keeping original pack`);
      return pack;
    }
  }));
  return results;
}
