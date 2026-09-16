// ─── Approach 4: Semantic candidate generation at corpus assembly ────────────
//
// GENERIC, framework-independent, deterministic, single-pass augmentation of the
// existing BM25 (Approach 2/3) corpus selection in analyzer.summarizeDocuments.
//
// What this module provides:
//   • embedTextsCached()  — batched embeddings via the app's EXISTING OpenAI-
//     compatible provider config (OPENAI_API_KEY + OPENAI_API_BASE — the same
//     endpoint the app already uses for its OpenAI-family chat models). No new
//     vendor is hardcoded. Per-text on-disk cache keyed by a hash of the chunk
//     text + model, so a repeated run reuses the cache (deterministic + cheap).
//   • cosineSim()         — cosine similarity between two vectors.
//   • hybridRankScores()  — PURE function combining normalized BM25 rank and
//     cosine rank via reciprocal-rank fusion (RRF) with a framework-independent
//     constant weight, plus a Goodhart-aware FLOOR that keeps any chunk carrying
//     a hard lexical signal (curated discriminator or quantified figure) ranked
//     above chunks that have none — so cosine drift can never evict them.
//
// ROBUSTNESS: every network path degrades gracefully. If embeddings are
// unavailable (no key) or error, embedTextsCached returns nulls and the caller
// falls back to the pure BM25 (Approach 2/3) ranking, so scoring never breaks.

import axios from "axios";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Config (all framework-independent; env-tunable, sane defaults) ──────────

// The embedding model. Uses the SAME OpenAI-compatible provider the app already
// configures (OPENAI_API_KEY + OPENAI_API_BASE). Env-tunable but defaults to a
// small, cheap, widely-available embedding model.
const EMBED_MODEL = process.env.RETRIEVAL_EMBED_MODEL || "text-embedding-3-small";
const EMBED_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
// Number of texts per embeddings request.
const EMBED_BATCH = Math.max(1, parseInt(process.env.RETRIEVAL_EMBED_BATCH || "128", 10));
// Per-text character cap before embedding (embedding models have token limits;
// candidate chunks are ~1500 chars so this is only a defensive guard).
const EMBED_MAX_CHARS = Math.max(200, parseInt(process.env.RETRIEVAL_EMBED_MAX_CHARS || "8000", 10));
// Per-request timeout (ms).
const EMBED_TIMEOUT_MS = Math.max(1000, parseInt(process.env.RETRIEVAL_EMBED_TIMEOUT_MS || "30000", 10));
// Persistent on-disk cache directory for chunk embeddings.
const CACHE_DIR = process.env.RETRIEVAL_EMBED_CACHE_DIR || join(tmpdir(), "companyiq-embed-cache");

/**
 * Whether the semantic-hybrid path is enabled. OPT-IN, off by default, so the
 * corpus selection is byte-for-byte the existing BM25 behavior until explicitly
 * enabled — matching the codebase's env-gated feature convention.
 */
export function isSemanticHybridEnabled(): boolean {
  return process.env.RETRIEVAL_HYBRID_SEMANTIC === "1";
}

/** True when an embeddings API key is configured (else we degrade to BM25). */
export function isEmbeddingConfigured(): boolean {
  return !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

// ─── On-disk embedding cache (deterministic, keyed by model + chunk text) ────

function cacheKeyFor(text: string): string {
  return createHash("sha256").update(EMBED_MODEL + "\u0000" + text).digest("hex");
}

function cachePathFor(key: string): string {
  // Shard by first 2 hex chars to avoid one directory with tens of thousands of files.
  return join(CACHE_DIR, key.slice(0, 2), key + ".json");
}

function readCachedVector(key: string): number[] | null {
  try {
    const p = cachePathFor(key);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) return parsed as number[];
    return null;
  } catch {
    return null;
  }
}

function writeCachedVector(key: string, vec: number[]): void {
  try {
    const p = cachePathFor(key);
    mkdirSync(join(CACHE_DIR, key.slice(0, 2)), { recursive: true });
    writeFileSync(p, JSON.stringify(vec));
  } catch {
    /* cache write is best-effort; never fatal */
  }
}

// ─── Embeddings API (OpenAI-compatible; reuses the app's provider config) ────

let embedWarned = false;
function warnOnce(msg: string): void {
  if (!embedWarned) {
    embedWarned = true;
    console.warn(`[corpus-semantic] ${msg}`);
  }
}

async function embedBatch(inputs: string[]): Promise<(number[] | null)[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return inputs.map(() => null);
  try {
    const resp = await axios.post(
      `${EMBED_BASE}/embeddings`,
      { model: EMBED_MODEL, input: inputs },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: EMBED_TIMEOUT_MS },
    );
    const data = resp.data?.data;
    if (!Array.isArray(data)) return inputs.map(() => null);
    // Order the returned embeddings by their `index` field (OpenAI-compatible
    // responses may not be in request order).
    const out: (number[] | null)[] = inputs.map(() => null);
    for (const row of data) {
      const idx = typeof row?.index === "number" ? row.index : -1;
      const emb = row?.embedding;
      if (idx >= 0 && idx < out.length && Array.isArray(emb)) out[idx] = emb as number[];
    }
    return out;
  } catch (e) {
    warnOnce(`embeddings request failed (${(e as Error).message}); degrading to BM25-only ranking`);
    return inputs.map(() => null);
  }
}

/**
 * Embed an array of texts, using the persistent on-disk cache first and issuing
 * batched API requests only for the cache misses. Returns one vector (or null,
 * on any failure) per input, in input order. Never throws.
 *
 * Deterministic: identical input text → identical cache key → identical vector
 * on a repeated run. Single embedding pass — the caller passes every unique text
 * it needs (all candidate chunks + the query) in ONE call.
 */
export async function embedTextsCached(texts: string[]): Promise<(number[] | null)[]> {
  const result: (number[] | null)[] = new Array(texts.length).fill(null);
  const keys = texts.map((t) => cacheKeyFor((t || "").slice(0, EMBED_MAX_CHARS)));

  // 1) Serve from cache.
  const missIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = readCachedVector(keys[i]);
    if (cached) result[i] = cached;
    else missIdx.push(i);
  }
  if (missIdx.length === 0) return result;
  if (!isEmbeddingConfigured()) {
    warnOnce("OPENAI_API_KEY not set; degrading to BM25-only ranking");
    return result; // misses stay null → caller degrades
  }

  // 2) Batch the misses. De-duplicate identical texts within this run so a
  //    repeated chunk is embedded once.
  const uniqueByKey = new Map<string, { text: string; idxs: number[] }>();
  for (const i of missIdx) {
    const k = keys[i];
    const entry = uniqueByKey.get(k);
    if (entry) entry.idxs.push(i);
    else uniqueByKey.set(k, { text: (texts[i] || "").slice(0, EMBED_MAX_CHARS), idxs: [i] });
  }
  const uniqueKeys = [...uniqueByKey.keys()];
  const uniqueTexts = uniqueKeys.map((k) => uniqueByKey.get(k)!.text);

  for (let start = 0; start < uniqueTexts.length; start += EMBED_BATCH) {
    const slice = uniqueTexts.slice(start, start + EMBED_BATCH);
    const vecs = await embedBatch(slice);
    for (let j = 0; j < slice.length; j++) {
      const vec = vecs[j];
      if (!vec) continue;
      const k = uniqueKeys[start + j];
      writeCachedVector(k, vec);
      for (const targetIdx of uniqueByKey.get(k)!.idxs) result[targetIdx] = vec;
    }
  }
  return result;
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

export function cosineSim(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Hybrid rank via reciprocal-rank fusion (PURE, deterministic) ────────────

export interface HybridRankOptions {
  /** BM25 (after Approach 2/3 adjustments) score per chunk. */
  bm25: number[];
  /** Cosine similarity to the query vector per chunk (null when unavailable). */
  cosine: (number | null)[];
  /**
   * FLOOR flag per chunk: true iff the chunk carries a hard lexical signal (a
   * curated discriminator token or a quantified figure). Floor chunks are kept
   * ranked above non-floor chunks so cosine drift can never evict them.
   */
  floor: boolean[];
  /** RRF constant (framework-independent). Default 60 (the standard value). */
  k?: number;
  /** Weight on the cosine RRF term (framework-independent constant). Default 1. */
  cosineWeight?: number;
}

/**
 * Reciprocal-rank fusion of the BM25 ordering and the cosine ordering, with a
 * Goodhart-aware floor. Returns a hybrid score per chunk (higher = better).
 *
 * hybrid[i] = 1/(k + bm25Rank[i]) + cosineWeight * 1/(k + cosRank[i]) + floorBonus[i]
 *
 * where ranks are 0-based positions in the respective descending sort (stable by
 * original index on ties), a chunk with no cosine is placed at the worst cosine
 * rank, and floorBonus is a constant strictly greater than the maximum possible
 * fused RRF value so that EVERY floor chunk outranks EVERY non-floor chunk while
 * still being ordered among themselves by the fused score.
 *
 * PURE and deterministic — no I/O, no randomness. Framework-independent.
 */
export function hybridRankScores(opts: HybridRankOptions): number[] {
  const { bm25, cosine, floor } = opts;
  const n = bm25.length;
  const k = opts.k ?? 60;
  const cosineWeight = opts.cosineWeight ?? 1;

  const rankOf = (values: (number | null)[]): number[] => {
    // Descending sort by value (nulls last), stable by index. Returns rank[idx].
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const va = values[a];
      const vb = values[b];
      const aNull = va === null || va === undefined;
      const bNull = vb === null || vb === undefined;
      if (aNull && bNull) return a - b;
      if (aNull) return 1;
      if (bNull) return -1;
      if (vb !== va) return (vb as number) - (va as number);
      return a - b;
    });
    const rank = new Array<number>(n);
    for (let r = 0; r < order.length; r++) rank[order[r]] = r;
    return rank;
  };

  const bm25Rank = rankOf(bm25);
  const cosRank = rankOf(cosine);

  // Floor bonus strictly dominates the max fused RRF (which is <= (1+cosineWeight)/k).
  const floorBonus = (1 + Math.max(0, cosineWeight)) + 1; // safely above any fused value

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const fused = 1 / (k + bm25Rank[i]) + cosineWeight * (1 / (k + cosRank[i]));
    out[i] = fused + (floor[i] ? floorBonus : 0);
  }
  return out;
}
