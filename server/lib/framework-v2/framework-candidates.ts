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
const DOC_SAMPLE_CHARS = 150_000;            // per-doc region scanned for topic relevance (bounded LEFT())
const LLM_SAMPLE_TOTAL_CHARS = 16_000;       // total chars sent to the LLM generators
const LLM_SAMPLE_PER_COMPANY_CHARS = 2_500;  // per-company contribution to the sample

// ── Topic-scoped passage extraction (precision fix) ─────────────────────────
// The LLM candidate generators (anchor-frameworks, adjacent-topics) must see
// text where the framework TOPIC is actually discussed — not document
// front-matter. The head of an ESG / annual / integrated report is dominated by
// generic reporting-standard boilerplate ("prepared in accordance with GRI /
// SASB / TCFD …"), so a position-based (document-head) sample makes the anchor
// miner propose those generic standards for ANY topic. Instead we extract text
// WINDOWS around occurrences of the topic term / its synonyms (all read from
// framework metadata — fully topic-agnostic), so only standards cited IN
// CONNECTION WITH the actual topic reach the model. Falls back to the document
// head when a corpus never names the topic, so mining never silently goes empty.
const TOPIC_WINDOW_BEFORE = 240;             // chars kept before a topic match
const TOPIC_WINDOW_AFTER = 560;              // chars kept after a topic match
const TOPIC_MAX_MATCHES_PER_TERM = 40;       // bound the scan per query term per company
// Generic connective words that must not be used as standalone topic tokens
// (they would match almost any passage and defeat the scoping). The multi-word
// topic PHRASES are always matched in full regardless of this list.
const GENERIC_TOPIC_TOKENS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "their", "they",
  "management", "disclosure", "disclosures", "report", "reports", "reporting",
  "policy", "policies", "risk", "risks", "framework", "frameworks", "standard",
  "standards", "company", "companies", "group", "related", "other", "data",
]);

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

  // 5. Build ONE bounded corpus sample string for the two LLM generators,
  //    scoped to passages that actually discuss the framework topic (so the
  //    anchor/adjacent miners see topic-relevant text, not report front-matter).
  const topicQuery = buildTopicQueryTokens(fwMeta);
  const sample = buildBoundedSample(corpusTexts, topicQuery);
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

/** Topic query derived from framework metadata — fully topic-agnostic. */
export interface TopicQuery {
  /** Full topic phrases (topic term + synonyms), lowercased. Matched verbatim. */
  phrases: string[];
  /** Distinctive single tokens drawn from those phrases, for recall. */
  tokens: string[];
}

/**
 * Derive the set of phrases/tokens that mark a passage as "about this topic".
 * Everything comes from the framework row (topic term + synonyms) — no company,
 * topic or standard literals are hardcoded, so this is generic across frameworks.
 */
export function buildTopicQueryTokens(fwMeta: FrameworkMetaForMining): TopicQuery {
  const rawPhrases = [fwMeta.topicTerm || "", ...(fwMeta.topicSynonyms || [])];
  const phrases: string[] = [];
  const seenPhrase = new Set<string>();
  for (const p of rawPhrases) {
    const s = String(p || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (s.length < 3 || seenPhrase.has(s)) continue;
    seenPhrase.add(s);
    phrases.push(s);
  }
  const tokens: string[] = [];
  const seenTok = new Set<string>();
  for (const p of phrases) {
    for (const raw of p.split(/[^a-z0-9\u00c0-\uffff]+/)) {
      const t = raw.trim();
      if (t.length < 4 || GENERIC_TOPIC_TOKENS.has(t) || seenTok.has(t)) continue;
      seenTok.add(t);
      tokens.push(t);
    }
  }
  return { phrases, tokens };
}

/** True if the char at the given boundary index is not part of a word. */
function isBoundary(text: string, idx: number): boolean {
  if (idx < 0 || idx >= text.length) return true;
  return !/[a-z0-9\u00c0-\uffff]/.test(text[idx]);
}

/**
 * Extract up to `maxChars` of text drawn from windows around occurrences of any
 * topic phrase/token in `text` (which must already be lowercased). Overlapping
 * windows are merged; returns "" when the topic is never named so the caller can
 * fall back to the document head. Pure and bounded.
 */
export function extractTopicWindows(text: string, query: TopicQuery, maxChars: number): string {
  if (!text || maxChars <= 0) return "";
  const needles = [...query.phrases, ...query.tokens];
  if (needles.length === 0) return "";

  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    if (!needle) continue;
    const tokenLike = !needle.includes(" ");
    let from = 0;
    let hits = 0;
    while (hits < TOPIC_MAX_MATCHES_PER_TERM) {
      const pos = text.indexOf(needle, from);
      if (pos === -1) break;
      from = pos + needle.length;
      // For single tokens, require word boundaries so "ai" doesn't match "said".
      if (tokenLike && (!isBoundary(text, pos - 1) || !isBoundary(text, pos + needle.length))) {
        continue;
      }
      hits++;
      ranges.push([Math.max(0, pos - TOPIC_WINDOW_BEFORE), Math.min(text.length, pos + needle.length + TOPIC_WINDOW_AFTER)]);
    }
  }
  if (ranges.length === 0) return "";

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  const out: string[] = [];
  let total = 0;
  for (const [s, e] of merged) {
    if (total >= maxChars) break;
    const slice = text.slice(s, Math.min(e, s + (maxChars - total))).trim();
    if (!slice) continue;
    out.push(slice);
    total += slice.length;
  }
  return out.join(" … ");
}

/**
 * Concatenate a bounded, per-company-capped sample string for the LLM. Each
 * company contributes TOPIC-RELEVANT passages where the framework topic is
 * named; companies whose corpus never names the topic fall back to the document
 * head so mining is never starved. Topic-scoped companies are preferred when the
 * global budget is tight, so the model's limited context is spent on on-topic
 * text — the precision fix for anchor-framework/adjacent-topic mining.
 */
function buildBoundedSample(corpusTexts: Map<string, string>, query: TopicQuery): string {
  const scoped: Array<{ name: string; chunk: string }> = [];
  const fallback: Array<{ name: string; chunk: string }> = [];
  for (const [name, text] of corpusTexts) {
    const windows = extractTopicWindows(text, query, LLM_SAMPLE_PER_COMPANY_CHARS);
    if (windows) {
      scoped.push({ name, chunk: windows });
    } else {
      const head = text.slice(0, LLM_SAMPLE_PER_COMPANY_CHARS).trim();
      if (head) fallback.push({ name, chunk: head });
    }
  }

  let total = 0;
  const parts: string[] = [];
  for (const { name, chunk } of [...scoped, ...fallback]) {
    if (total >= LLM_SAMPLE_TOTAL_CHARS) break;
    const remaining = LLM_SAMPLE_TOTAL_CHARS - total;
    const trimmed = chunk.slice(0, remaining).trim();
    if (!trimmed) continue;
    const block = `--- ${name} ---\n${trimmed}`;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}
