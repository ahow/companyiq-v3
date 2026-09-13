/**
 * Framework Creation v2 — design-time candidate mining for FRAMEWORK-LEVEL
 * improvement proposals.
 *
 * Three framework-scoped proposal types (see edit-proposer.ts builders) need a
 * pool of mined candidates before they can be surfaced:
 *   • terminology-gap   → topic_synonyms      (detectTerminologyGaps over corpus)
 *   • adjacent-topics   → adjacent_topics      (LLM over a bounded corpus sample)
 *   • anchor-frameworks → anchor_frameworks    (LLM over a bounded corpus sample)
 *
 * `mineFrameworkCandidates` produces the RAW candidate pools for a
 * framework+list's most recent batch. The pools are NOT filtered against the
 * currently-registered lists here — the caller (deriveProposalBundle) re-filters
 * them on every call so the proposal set stays correct after an apply mutates a
 * list. That separation is what makes caching safe: mining is expensive (a
 * corpus scan + up to two LLM calls) and deriveProposalBundle runs on every
 * results load AND every apply, so the mined pools are memoised per
 * (framework_id, list_id, batch_id) in `framework_v2_mined_candidates` and only
 * the cheap re-filter re-runs.
 *
 * GENERIC: nothing here is specific to any framework, company, topic or numeric
 * id — the topic, its synonyms and the registered lists all arrive via fwMeta,
 * and every id is a parameter. Every LLM step is non-fatal (contributes zero
 * candidates on failure); the whole function is additionally wrapped in a
 * try/catch by its caller.
 */

import { sql } from "drizzle-orm";
import { detectTerminologyGaps } from "./test-drive.js";
import {
  generateAdjacentTopicCandidates,
  generateAnchorFrameworkCandidates,
  type FrameworkContext,
} from "./edit-applier.js";

/** Minimal shape of the drizzle db handle we depend on (execute only). */
export interface DbLike {
  execute: (query: any) => Promise<any>;
}

/** Framework metadata needed for mining (all topic-agnostic, read from the row). */
export interface FrameworkMetaForMining {
  topicTerm: string;
  topicSynonyms: string[];
  adjacentTopics: string[];
  anchorFrameworks: string[];
  frameworkName?: string;
}

/** Raw (unfiltered) mined candidate pools. */
export interface MinedFrameworkCandidates {
  /** Terminology-gap terms with per-corpus company coverage. */
  terminology: Array<{ term: string; companyCount: number }>;
  /** Candidate adjacent-topic phrases (LLM). */
  adjacentPhrases: string[];
  /** Candidate anchor-framework names (LLM). */
  anchorNames: string[];
}

// ── Bounded corpus sampling for the LLM candidate generators ────────────────
// The terminology miner has its own internal caps (detectTerminologyGaps). For
// the two LLM generators we build ONE bounded sample string shared by both so we
// never send an unbounded corpus to the model. Caps mirror the existing chat
// path's conventions.
const CORPUS_TEXT_CAP_PER_COMPANY = 200_000; // matches chat path per-company cap
const DOC_SAMPLE_CHARS = 50_000;             // matches chat path per-doc LEFT() cap
const LLM_SAMPLE_TOTAL_CHARS = 16_000;       // total chars sent to the LLM generators
const LLM_SAMPLE_PER_COMPANY_CHARS = 2_500;  // per-company contribution to the sample

const EMPTY: MinedFrameworkCandidates = { terminology: [], adjacentPhrases: [], anchorNames: [] };

/**
 * Mine the framework+list's most recent batch corpus for framework-level
 * candidate pools. Memoised per (framework_id, list_id, batch_id). Always mines
 * all three pools so a single cache entry serves every caller regardless of
 * which proposal types end up being surfaced (the surfacing decision — e.g. the
 * adjacent-contamination recurrence threshold — lives in deriveProposalBundle).
 */
export async function mineFrameworkCandidates(
  db: DbLike,
  frameworkId: number,
  listId: number,
  workspaceId: number,
  fwMeta: FrameworkMetaForMining,
): Promise<MinedFrameworkCandidates> {
  // 1. Resolve the most recent batch for this framework+list+workspace.
  let batchId: number | undefined;
  try {
    const batchRow = await db.execute(sql`
      SELECT id FROM batch_runs
      WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND workspace_id = ${workspaceId}
      ORDER BY started_at DESC LIMIT 1
    `);
    batchId = (batchRow as any).rows?.[0]?.id;
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] batch lookup failed (non-fatal):", e?.message);
  }
  if (!batchId) return EMPTY;

  // 2. Cache read (non-fatal — table may be absent during a deploy race).
  try {
    const cached = await db.execute(sql`
      SELECT mined FROM framework_v2_mined_candidates
      WHERE framework_id = ${frameworkId} AND list_id = ${listId} AND batch_id = ${batchId}
    `);
    const mined = (cached as any).rows?.[0]?.mined;
    if (mined && typeof mined === "object") {
      return {
        terminology: Array.isArray(mined.terminology) ? mined.terminology : [],
        adjacentPhrases: Array.isArray(mined.adjacentPhrases) ? mined.adjacentPhrases : [],
        anchorNames: Array.isArray(mined.anchorNames) ? mined.anchorNames : [],
      };
    }
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] cache read failed (non-fatal):", e?.message);
  }

  // 3. Assemble bounded per-company corpus text (same query shape as the chat
  //    path; sampled with LEFT() to avoid TOAST decompression on large corpora).
  const corpusTexts = new Map<string, string>();
  try {
    const corpusRows = await db.execute(sql`
      SELECT bc.company_id, c.name AS company_name, d.type, d.title,
             LEFT(COALESCE(d.content, dc.content, ''), ${DOC_SAMPLE_CHARS}) AS text
      FROM batch_corpus bc JOIN companies c ON c.id = bc.company_id
      JOIN documents d ON d.id = bc.document_id
      LEFT JOIN document_content dc ON dc.id = d.content_id
      WHERE bc.batch_id = ${batchId}
    `);
    for (const r of ((corpusRows as any).rows || [])) {
      const name = String(r.company_name || "");
      if (!name) continue;
      const textLc = String(r.text || "").toLowerCase();
      const existing = corpusTexts.get(name) ?? "";
      if (existing.length < CORPUS_TEXT_CAP_PER_COMPANY) {
        corpusTexts.set(name, existing + " " + textLc.slice(0, DOC_SAMPLE_CHARS));
      }
    }
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] corpus load failed (non-fatal):", e?.message);
    return EMPTY;
  }
  if (corpusTexts.size === 0) return EMPTY;

  // 4. Terminology-gap mining (pure, internally bounded).
  let terminology: Array<{ term: string; companyCount: number }> = [];
  try {
    const gaps = detectTerminologyGaps(corpusTexts, fwMeta.topicSynonyms || [], fwMeta.topicTerm || "");
    terminology = (gaps.missingTerms || []).map((t) => ({ term: t.term, companyCount: t.companyCount }));
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] terminology mining failed (non-fatal):", e?.message);
  }

  // 5. Build ONE bounded corpus sample string for the two LLM generators.
  const sample = buildBoundedSample(corpusTexts);
  const ctx: FrameworkContext = {
    topicTerm: fwMeta.topicTerm || "",
    topicSynonyms: fwMeta.topicSynonyms || [],
    adjacentTopics: fwMeta.adjacentTopics || [],
    frameworkName: fwMeta.frameworkName,
  };

  // 6. LLM candidate generation (each non-fatal internally; run in parallel).
  let adjacentPhrases: string[] = [];
  let anchorNames: string[] = [];
  try {
    const [adj, anch] = await Promise.all([
      generateAdjacentTopicCandidates(sample, ctx).catch(() => []),
      generateAnchorFrameworkCandidates(sample, ctx).catch(() => []),
    ]);
    adjacentPhrases = adj;
    anchorNames = anch;
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] LLM candidate generation failed (non-fatal):", e?.message);
  }

  const result: MinedFrameworkCandidates = { terminology, adjacentPhrases, anchorNames };

  // 7. Cache write (non-fatal, idempotent upsert on the unique key).
  try {
    await db.execute(sql`
      INSERT INTO framework_v2_mined_candidates (framework_id, list_id, batch_id, mined)
      VALUES (${frameworkId}, ${listId}, ${batchId}, ${JSON.stringify(result)}::jsonb)
      ON CONFLICT (framework_id, list_id, batch_id)
      DO UPDATE SET mined = EXCLUDED.mined, created_at = NOW()
    `);
  } catch (e: any) {
    console.warn("[mineFrameworkCandidates] cache write failed (non-fatal):", e?.message);
  }

  return result;
}

/** Concatenate a bounded, per-company-capped sample string for the LLM. */
function buildBoundedSample(corpusTexts: Map<string, string>): string {
  let total = 0;
  const parts: string[] = [];
  for (const [name, text] of corpusTexts) {
    if (total >= LLM_SAMPLE_TOTAL_CHARS) break;
    const remaining = LLM_SAMPLE_TOTAL_CHARS - total;
    const chunk = text.slice(0, Math.min(LLM_SAMPLE_PER_COMPANY_CHARS, remaining)).trim();
    if (!chunk) continue;
    const block = `--- ${name} ---\n${chunk}`;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}
