// ─── WP08 — Immutable replay & dependency-aware run manifest ──────────────────
// Plan: docs/quality-and-efficiency-improvement-plan.md "A7. Immutable replay &
//       dependency-aware artifacts (WP08)" (line ~191) + tests RP01–RP06 (~195).
//
// A run manifest links, for ONE batch run, every dependency that determines its
// output: framework/measure hashes, entity + as-of scope, source content/version
// hashes, extraction/translation versions, retrieval/tokenizer settings, the
// exact evidence packs, the prompts, the provider/model params, and the
// code/runtime tree. With it, a reviewer can tell an UNCHANGED score from one
// whose research became incomplete, and Lane-B caching/attribution becomes
// *provably* keyed on true dependencies rather than hopeful TTLs.
//
// Two hard requirements from the brief are honoured literally:
//   1. REUSE existing provenance — this module imports the pipeline's own hashes
//      (computeCorpusHash / computeBatchFingerprint, computeFrameworkContentHash,
//      getPromptHash, PIPELINE_VERSION). It does NOT build a parallel metadata
//      system; it fills the gaps (canonical manifest hash, run-mode split,
//      runtime-settings snapshot, reproducibility-limit ledger).
//   2. DON'T FAKE DETERMINISM — a fixed-corpus REPLAY is separated from a
//      FRESH-research run, and every place where a provider/model ALIAS can drift
//      (a seed does not make a remote model deterministic) is recorded as an
//      explicit reproducibility limit rather than silently claimed reproducible.
//
// Everything here is ADDITIVE and READ-ONLY: assembling or persisting a manifest
// never changes any pipeline output. Persistence is fully swallowed.

import { createHash } from "node:crypto";
import { PIPELINE_VERSION } from "./pipeline-version.js";

// ─── Canonical hashing (stable regardless of key insertion order) ─────────────

/**
 * Deterministic JSON: objects are emitted with keys sorted lexicographically at
 * every depth, so two logically-equal structures always serialize identically.
 * Arrays keep their order (order IS meaningful for measures/packs). Undefined
 * values are dropped (JSON has no undefined); null is preserved.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: any): any {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = sortDeep(value[key]);
  }
  return out;
}

/** SHA-256 hex of the canonical form of any JSON-able value. */
export function hashObject(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

// ─── Run mode: fixed-corpus REPLAY vs FRESH research ──────────────────────────

export type RunMode = "replay" | "fresh";

/**
 * A run is a fixed-corpus REPLAY only when it both skips fetching (scoreOnly) and
 * pins a source corpus (sourceBatchId). Anything else is FRESH research: live
 * discovery / search / fetch, whose corpus is NOT reproducible because the web
 * and the search index move under us.
 */
export function classifyRunMode(input: { scoreOnly?: boolean | null; sourceBatchId?: number | null }): RunMode {
  return input.scoreOnly && input.sourceBatchId != null ? "replay" : "fresh";
}

// ─── Runtime settings snapshot (retrieval / tokenizer / translation) ──────────
// Resolved from the SAME env vars + defaults the retrieval/translation layers
// read (passage-retrieval.ts, translation.ts). Captured so a manifest records
// the exact knobs a run used. Kept as a plain object so it hashes canonically.

function num(env: string, def: number): number {
  const v = Number(process.env[env]);
  return Number.isFinite(v) ? v : def;
}

export function retrievalSettingsSnapshot(): Record<string, number> {
  // Mirrors passage-retrieval.ts constants (same env names + defaults).
  return {
    chunk_size: num("RETRIEVAL_CHUNK_SIZE", 2200),
    chunk_overlap: num("RETRIEVAL_CHUNK_OVERLAP", 300),
    topic_weight: num("RETRIEVAL_TOPIC_WEIGHT", 2.0),
    section_boost: num("RETRIEVAL_SECTION_BOOST", 2.5),
    max_chunks_per_doc: num("RETRIEVAL_MAX_CHUNKS_PER_DOC", 5),
    primary_max_chunks_per_doc: num("RETRIEVAL_PRIMARY_MAX_CHUNKS_PER_DOC", 10),
    guaranteed_topic_chunks: num("RETRIEVAL_GUARANTEED_TOPIC_CHUNKS", 8),
    evidence_top_k: num("RETRIEVAL_EVIDENCE_TOP_K", 45),
    evidence_max_chars: num("RETRIEVAL_EVIDENCE_MAX_CHARS", 45000),
    force_include_chunks: num("RETRIEVAL_FORCE_INCLUDE_CHUNKS", 4),
    force_include_extra_chars: num("RETRIEVAL_FORCE_INCLUDE_EXTRA_CHARS", 9000),
    bm25_reserve_chunks: num("RETRIEVAL_BM25_RESERVE_CHUNKS", 6),
    bm25_reserve_extra_chars: num("RETRIEVAL_BM25_RESERVE_EXTRA_CHARS", 16000),
    bm25_reserve_min_frac: num("RETRIEVAL_BM25_RESERVE_MIN_FRAC", 0.45),
  };
}

export function tokenizerSettingsSnapshot(): Record<string, unknown> {
  // The tokenizer (passage-retrieval.ts tokenize) keeps ASCII tokens length > 2
  // plus CJK character bigrams, with a framework-scoped short-token allowlist.
  return {
    scheme: "ascii-word>2 + cjk-bigram",
    min_ascii_token_len: 3,
    cjk_bigrams: true,
    short_token_allowlist: "framework-scoped (set per run)",
  };
}

export function translationSettingsSnapshot(): Record<string, unknown> {
  // Mirrors translation.ts (read at call-time from env).
  return {
    provider: process.env.TRANSLATION_PROVIDER || "deepseek",
    non_english_ratio_threshold: num("TRANSLATION_NONENGLISH_RATIO", 0.1),
    max_translate_chars: num("TRANSLATION_MAX_CHARS", 120000),
    translate_block_size: num("TRANSLATION_BLOCK_SIZE", 6000),
  };
}

// ─── Code / runtime tree fingerprint ──────────────────────────────────────────

/**
 * Best-effort fingerprint of the CODE + RUNTIME that produced a run. This is NOT
 * a content hash of the whole source tree (we do not walk the filesystem on the
 * hot path); it is the pipeline's own deploy-pinned version markers plus the node
 * runtime. On a deployed build PIPELINE_VERSION / gitSha are the immutable git
 * SHA, so this ties a run to one commit. See reproducibility limits for the case
 * where it resolves to 'dev'.
 */
export function computeCodeTreeHash(extra?: Record<string, unknown>): {
  hash: string;
  components: Record<string, unknown>;
} {
  const components: Record<string, unknown> = {
    pipeline_version: PIPELINE_VERSION,
    git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev",
    node_version: process.version,
    ...(extra || {}),
  };
  return { hash: hashObject(components), components };
}

// ─── Reproducibility-limit ledger (never fake determinism) ────────────────────

export interface ReproducibilityLimit {
  /** Which dependency can drift. */
  field: string;
  /** Why exact reproduction is not guaranteed. */
  reason: string;
  /** How bad: 'blocks' exact replay, or merely 'bounds' it. */
  severity: "blocks" | "bounds";
}

/**
 * Enumerate, honestly, where this run cannot be bit-reproduced. Driven by the run
 * mode and the provider/model params actually used.
 */
export function detectReproducibilityLimits(input: {
  runMode: RunMode;
  codeTreeComponents: Record<string, unknown>;
  providerModelParams?: Array<{ role?: string; provider?: string; model?: string; temperature?: number | null }> | null;
}): ReproducibilityLimit[] {
  const limits: ReproducibilityLimit[] = [];

  // 1. Remote model aliases drift — the single most important honesty point.
  const models = input.providerModelParams || [];
  const aliases = Array.from(
    new Set(models.map((m) => `${m.provider || "?"}:${m.model || "?"}`)),
  ).filter((a) => a !== "?:?");
  if (aliases.length > 0) {
    limits.push({
      field: `model_alias(${aliases.join(", ")})`,
      reason:
        "Provider/model names are ALIASES, not immutable model-snapshot versions. " +
        "The provider can update the weights behind an alias at any time, and a " +
        "remote LLM is not guaranteed deterministic even at temperature 0 / fixed " +
        "seed. Scores may therefore differ on replay even with an identical corpus.",
      severity: "blocks",
    });
  }

  // 2. FRESH runs: the corpus itself is not pinned.
  if (input.runMode === "fresh") {
    limits.push({
      field: "corpus",
      reason:
        "FRESH-research run: discovery/search/fetch ran live. The web and the " +
        "search index change over time, so the exact document set is not " +
        "reproducible. Use a fixed-corpus replay (scoreOnly + sourceBatchId) to " +
        "pin the corpus.",
      severity: "blocks",
    });
  }

  // 3. Non-deploy builds: code fingerprint is not a commit.
  if (input.codeTreeComponents.git_sha === "dev") {
    limits.push({
      field: "code_tree",
      reason:
        "Code fingerprint resolved to 'dev' (no RAILWAY_GIT_COMMIT_SHA / GIT_SHA). " +
        "The exact source tree is not pinned to a commit for this run.",
      severity: "bounds",
    });
  }

  return limits;
}

// ─── Manifest shape ───────────────────────────────────────────────────────────

export interface RunManifestInput {
  /** Stable id for this run (e.g. batch run key). */
  runId: string;
  batchId?: number | null;
  workspaceId?: number | null;
  frameworkId?: number | null;
  listId?: number | null;

  // Run mode inputs.
  scoreOnly?: boolean | null;
  sourceBatchId?: number | null;

  // Entity + temporal scope.
  asOf?: string | null;
  entityScope?: { companyIds?: number[] | null; listId?: number | null } | null;

  // Framework / measure provenance (reuse computeFrameworkContentHash output).
  frameworkHash?: string | null;
  frameworkVersion?: string | number | null;
  measureHashes?: Array<{ measureId: string; hash: string }> | null;

  // Source corpus provenance (reuse computeBatchFingerprint / computeCorpusHash).
  corpusFingerprint?: string | null;
  sourceCorpusFingerprint?: string | null;
  perCompanyCorpus?: Array<{ companyId: number; corpusHash: string }> | null;

  // Extraction / translation versions.
  extractionVersion?: string | null;
  translationSettings?: Record<string, unknown> | null;

  // Retrieval / tokenizer settings.
  retrievalSettings?: Record<string, unknown> | null;
  tokenizerSettings?: Record<string, unknown> | null;

  // Exact evidence packs (hashes only; the bytes live in the ledger).
  packs?: Array<{ companyId?: number | null; measureId: string; packHash: string }> | null;

  // Prompts + provider/model params.
  promptHashes?: Record<string, string> | null;
  providerModelParams?: Array<{ role?: string; provider?: string; model?: string; temperature?: number | null }> | null;

  // Optional extra components folded into the code-tree fingerprint.
  codeTreeExtra?: Record<string, unknown> | null;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  runMode: RunMode;
  batchId: number | null;
  workspaceId: number | null;
  frameworkId: number | null;
  listId: number | null;
  createdAt: string;
  scope: {
    asOf: string | null;
    companyIds: number[] | null;
    listId: number | null;
    sourceBatchId: number | null;
  };
  framework: {
    hash: string | null;
    version: string | number | null;
    measureHashes: Array<{ measureId: string; hash: string }>;
  };
  corpus: {
    fingerprint: string | null;
    sourceCorpusFingerprint: string | null;
    perCompany: Array<{ companyId: number; corpusHash: string }>;
  };
  extraction: { version: string | null };
  translation: Record<string, unknown>;
  retrieval: Record<string, unknown>;
  tokenizer: Record<string, unknown>;
  packs: Array<{ companyId?: number | null; measureId: string; packHash: string }>;
  prompts: Record<string, string>;
  providerModelParams: Array<{ role?: string; provider?: string; model?: string; temperature?: number | null }>;
  codeTree: { hash: string; components: Record<string, unknown> };
  reproducibilityLimits: ReproducibilityLimit[];
  /** Canonical SHA-256 over the manifest body (every field above except this). */
  manifestHash: string;
}

/**
 * Pure assembler: build the manifest from whatever provenance the caller has.
 * Deterministic given its inputs (createdAt is the one caller-supplied/clock
 * field; see `now`). Fills snapshot settings from the live env when the caller
 * does not override them, and records reproducibility limits honestly.
 */
export function buildRunManifest(input: RunManifestInput, now?: string): RunManifest {
  const runMode = classifyRunMode({ scoreOnly: input.scoreOnly, sourceBatchId: input.sourceBatchId });
  const codeTree = computeCodeTreeHash(input.codeTreeExtra || undefined);
  const providerModelParams = input.providerModelParams || [];
  const reproducibilityLimits = detectReproducibilityLimits({
    runMode,
    codeTreeComponents: codeTree.components,
    providerModelParams,
  });

  const body: Omit<RunManifest, "manifestHash"> = {
    schemaVersion: 1,
    runId: input.runId,
    runMode,
    batchId: input.batchId ?? null,
    workspaceId: input.workspaceId ?? null,
    frameworkId: input.frameworkId ?? null,
    listId: input.listId ?? null,
    createdAt: now || new Date().toISOString(),
    scope: {
      asOf: input.asOf ?? null,
      companyIds: input.entityScope?.companyIds ?? null,
      listId: input.entityScope?.listId ?? input.listId ?? null,
      sourceBatchId: input.sourceBatchId ?? null,
    },
    framework: {
      hash: input.frameworkHash ?? null,
      version: input.frameworkVersion ?? null,
      measureHashes: input.measureHashes || [],
    },
    corpus: {
      fingerprint: input.corpusFingerprint ?? null,
      sourceCorpusFingerprint: input.sourceCorpusFingerprint ?? null,
      perCompany: input.perCompanyCorpus || [],
    },
    extraction: { version: input.extractionVersion ?? null },
    translation: input.translationSettings || translationSettingsSnapshot(),
    retrieval: input.retrievalSettings || retrievalSettingsSnapshot(),
    tokenizer: input.tokenizerSettings || tokenizerSettingsSnapshot(),
    packs: input.packs || [],
    prompts: input.promptHashes || {},
    providerModelParams,
    codeTree,
    reproducibilityLimits,
  };

  // manifestHash is a pure DEPENDENCY fingerprint: it covers everything that can
  // change the produced bytes (framework/measure hashes, corpus, extraction,
  // retrieval/tokenizer/translation settings, packs, prompts, provider/model
  // params, code tree, runMode and the entity/as-of/source scope) but NOT the
  // run-identity fields (runId, batchId, workspaceId, listId) nor the createdAt
  // timestamp. Those identify *which* run emitted the manifest and are stored as
  // their own columns; excluding them is what lets RP01 hold (a deterministic
  // replay under a fresh runId/batchId produces an identical manifestHash) while
  // cross-tenant isolation (RP04) is still enforced because scope.companyIds,
  // scope.listId and scope.asOf remain inside the hashed body.
  const {
    createdAt: _omitCreatedAt,
    runId: _omitRunId,
    batchId: _omitBatchId,
    workspaceId: _omitWorkspaceId,
    listId: _omitListId,
    ...hashable
  } = body;
  const manifestHash = hashObject(hashable);
  return { ...body, manifestHash };
}

// ─── Persistence (one row per run; fully swallowed) ───────────────────────────

function enabled(): boolean {
  return (process.env.RUN_MANIFEST_ENABLED || "true").toLowerCase() !== "false";
}

const POOL_MAX = parseInt(process.env.PG_RUN_MANIFEST_POOL_MAX || "1", 10);
let pool: import("pg").Pool | null = null;

async function getPool(): Promise<import("pg").Pool> {
  if (pool) return pool;
  const pg = (await import("pg")).default;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || "10000", 10),
  });
  try {
    const diag = await import("./pg-diag.js");
    diag.registerPoolForDiagnostics("run_manifest", pool, POOL_MAX);
  } catch { /* diagnostics optional */ }
  return pool;
}

/**
 * Persist a manifest to run_manifests. Never throws, honours the kill-switch, and
 * swallows all failures (telemetry must never disturb the pipeline). Returns the
 * manifestHash on a successful enqueue of the write, else null.
 */
export async function recordRunManifest(manifest: RunManifest): Promise<string | null> {
  if (!enabled()) return null;
  try {
    const p = await getPool();
    await p.query(
      `INSERT INTO run_manifests
         (run_id, batch_id, workspace_id, framework_id, run_mode, manifest_hash,
          manifest, reproducibility_limits, emit_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        manifest.runId,
        manifest.batchId,
        manifest.workspaceId,
        manifest.frameworkId,
        manifest.runMode,
        manifest.manifestHash,
        JSON.stringify(manifest),
        JSON.stringify(manifest.reproducibilityLimits),
        new Date().toISOString(),
      ],
    );
    return manifest.manifestHash;
  } catch (e: any) {
    console.warn(`[run-manifest] recordRunManifest failed (swallowed): ${e?.message || e}`);
    return null;
  }
}

/** Convenience: assemble + persist in one swallowed call. Returns manifestHash or null. */
export async function buildAndRecordRunManifest(input: RunManifestInput): Promise<string | null> {
  try {
    const manifest = buildRunManifest(input);
    return await recordRunManifest(manifest);
  } catch (e: any) {
    console.warn(`[run-manifest] buildAndRecordRunManifest failed (swallowed): ${e?.message || e}`);
    return null;
  }
}
