// ─── LLM Token + Cost Usage Logging ──────────────────────────────────────────
// Generic, provider-agnostic capture of token usage and USD cost for EVERY LLM
// call, so a full run can self-report exactly how much it cost. Everything here
// is:
//   • GENERIC — no framework/company/topic knowledge; only model-name → price
//     mapping (which is config, overridable via env).
//   • TOLERANT — missing usage or missing attribution never throws; we log what
//     we have (nulls/zeros) and continue.
//   • LOW-OVERHEAD — the DB write is fire-and-forget and fully swallowed, so
//     usage logging can NEVER break or slow scoring. Kill-switch:
//     LLM_USAGE_LOGGING_ENABLED (default "true").
//
// Attribution (workspaceId/batchId/companyId/frameworkId/callType) is propagated
// implicitly via AsyncLocalStorage. The worker wraps each job in
// runWithLlmContext(...), so any LLM call made anywhere down the pipeline picks
// up the right attribution without threading params through every function.

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Attribution context (propagated via AsyncLocalStorage) ──────────────────

export interface LlmUsageContext {
  workspaceId?: number | null;
  batchId?: number | null;
  companyId?: number | null;
  frameworkId?: number | null;
  callType?: string | null; // e.g. 'scoring' | 'arbiter' | 'chat' | 'discovery'
}

const usageContextStore = new AsyncLocalStorage<LlmUsageContext>();

/** Run `fn` with the given attribution context available to all nested LLM calls. */
export function runWithLlmContext<T>(ctx: LlmUsageContext, fn: () => T): T {
  return usageContextStore.run(ctx, fn);
}

/** Read the current attribution context (empty object if none is set). */
export function getLlmContext(): LlmUsageContext {
  return usageContextStore.getStore() || {};
}

// ─── Usage parsing (provider-shape agnostic) ─────────────────────────────────

export interface ParsedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/**
 * Parse a raw provider usage object into a normalised shape. Handles BOTH:
 *   • OpenAI-compatible: { prompt_tokens, completion_tokens, total_tokens }
 *   • Anthropic-style:   { input_tokens, output_tokens }  (no total)
 *   • Gemini-style:      { promptTokenCount, candidatesTokenCount, totalTokenCount }
 * Anything missing → null. Never throws.
 */
export function parseUsage(raw: any): ParsedUsage {
  if (!raw || typeof raw !== "object") {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const num = (v: any): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const prompt =
    num(raw.prompt_tokens) ?? num(raw.input_tokens) ?? num(raw.promptTokenCount);
  const completion =
    num(raw.completion_tokens) ?? num(raw.output_tokens) ?? num(raw.candidatesTokenCount);
  let total = num(raw.total_tokens) ?? num(raw.totalTokenCount);
  if (total == null && (prompt != null || completion != null)) {
    total = (prompt ?? 0) + (completion ?? 0);
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

// ─── Price table (config-driven, env-overridable) ────────────────────────────

export interface ModelPrice {
  inputPerMillion: number; // USD per 1,000,000 input/prompt tokens
  outputPerMillion: number; // USD per 1,000,000 output/completion tokens
}
export type PriceTable = Record<string, ModelPrice>;

// Built-in default prices (USD per 1M tokens). These are ESTIMATES and are meant
// to be overridden per-deployment via the LLM_PRICE_TABLE_JSON env var. Keys are
// matched case-insensitively; the longest key that is a substring of the model
// name wins (so "claude-sonnet-4-5-20250929" matches "claude-sonnet"). This is
// config, not framework logic — the mapping is model-name → price only.
const DEFAULT_PRICE_TABLE: PriceTable = {
  // DeepSeek
  "deepseek-reasoner": { inputPerMillion: 0.56, outputPerMillion: 1.68 },
  "deepseek-chat": { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  "deepseek": { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  // Zhipu / GLM
  "glm-4.6": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  "glm-4": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  "zhipu": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  // Anthropic / Claude
  "claude-haiku": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  "claude-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-opus": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "claude": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "anthropic": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  // Mistral — public list price estimate (mistral-large ~ $2.00 in / $6.00 out
  // per 1M tokens). Override via LLM_PRICE_TABLE_JSON for negotiated rates.
  "mistral-large": { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  // mistral-medium (e.g. mistralai/mistral-medium-3.1) ~ $0.40 in / $2.00 out
  // per 1M tokens. Key is longer/more-specific than the generic "mistral" key,
  // so lookupPrice's longest-substring-wins rule resolves "mistral-medium-3.1"
  // to this entry rather than the generic "mistral" fallback.
  "mistral-medium": { inputPerMillion: 0.4, outputPerMillion: 2.0 },
  "mistral": { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  // OpenAI GPT-5 — public list price estimate ($1.25 in / $10.00 out per 1M
  // tokens). Override via LLM_PRICE_TABLE_JSON for negotiated rates.
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10.0 },
};

let cachedTable: PriceTable | null = null;

/**
 * Build the effective price table: built-in defaults, with any entries from the
 * LLM_PRICE_TABLE_JSON env var merged on top (env wins). Env value must be a JSON
 * object of { "<model-key>": { "inputPerMillion": <n>, "outputPerMillion": <n> } }.
 * Malformed env is ignored (warn + fall back to defaults). Cached after first call.
 */
export function loadPriceTable(): PriceTable {
  if (cachedTable) return cachedTable;
  const merged: PriceTable = {};
  for (const [k, v] of Object.entries(DEFAULT_PRICE_TABLE)) merged[k.toLowerCase()] = v;

  const rawEnv = process.env.LLM_PRICE_TABLE_JSON;
  if (rawEnv && rawEnv.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawEnv);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, any>)) {
          if (
            v &&
            typeof v === "object" &&
            typeof v.inputPerMillion === "number" &&
            typeof v.outputPerMillion === "number"
          ) {
            merged[k.toLowerCase()] = {
              inputPerMillion: v.inputPerMillion,
              outputPerMillion: v.outputPerMillion,
            };
          }
        }
      }
    } catch (e: any) {
      console.warn(`[llm-usage] Failed to parse LLM_PRICE_TABLE_JSON: ${e?.message || e}`);
    }
  }
  cachedTable = merged;
  return merged;
}

/** Reset the cached price table (test-only). */
export function resetPriceTableCache(): void {
  cachedTable = null;
}

/**
 * Normalise a model name for price lookup. Providers frequently prefix the model
 * id with a namespace segment (e.g. "mistralai/mistral-large", "openai/gpt-5",
 * "anthropic/claude-sonnet-4-5", "x-ai/grok-2"). The price table is keyed on the
 * bare model name, so we strip the provider namespace GENERICALLY: split on "/"
 * and keep the last segment. This is provider-agnostic — no hardcoded provider
 * list — so any "<provider>/<model>" form resolves to "<model>". Leading/trailing
 * whitespace is trimmed. Non-string input → "".
 */
export function normalizeModelName(model: string): string {
  if (!model || typeof model !== "string") return "";
  const trimmed = model.trim();
  const slash = trimmed.lastIndexOf("/");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim();
}

/**
 * Look up the price for a model name. The name is first normalised (provider
 * namespace stripped). Exact (lowercased) match first, otherwise the longest
 * table key that is a substring of the model name. Unknown → null.
 */
export function lookupPrice(model: string, table: PriceTable): ModelPrice | null {
  if (!model || typeof model !== "string") return null;
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  const m = normalized.toLowerCase();
  if (table[m]) return table[m];
  let best: { keyLen: number; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (k.length > 0 && m.includes(k)) {
      if (!best || k.length > best.keyLen) best = { keyLen: k.length, price };
    }
  }
  return best ? best.price : null;
}

// ─── Cost computation ────────────────────────────────────────────────────────

export interface ComputedCost {
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  totalCostUsd: number | null;
}

/**
 * Compute USD cost from parsed usage + a model name. Unknown model (no price
 * entry) → all-null cost (tokens are still logged separately). Missing token
 * counts are treated as 0 for the cost arithmetic when a price IS known.
 */
export function computeCost(usage: ParsedUsage, model: string, table?: PriceTable): ComputedCost {
  const priceTable = table ?? loadPriceTable();
  const price = lookupPrice(model, priceTable);
  if (!price) return { inputCostUsd: null, outputCostUsd: null, totalCostUsd: null };
  const inTok = usage.promptTokens ?? 0;
  const outTok = usage.completionTokens ?? 0;
  const inputCostUsd = (inTok / 1_000_000) * price.inputPerMillion;
  const outputCostUsd = (outTok / 1_000_000) * price.outputPerMillion;
  return { inputCostUsd, outputCostUsd, totalCostUsd: inputCostUsd + outputCostUsd };
}

// ─── Runtime recorder (fire-and-forget, fully swallowed) ─────────────────────

function loggingEnabled(): boolean {
  return (process.env.LLM_USAGE_LOGGING_ENABLED || "true").toLowerCase() !== "false";
}

export interface RecordUsageArgs {
  raw: any; // raw provider usage object (any shape); may be null/undefined
  model: string;
  provider: string;
  callType?: string | null;
  context?: LlmUsageContext; // explicit overrides; otherwise AsyncLocalStorage context is used
}

/**
 * Record a single LLM usage event. Fire-and-forget: never throws, never blocks
 * the caller, honours the LLM_USAGE_LOGGING_ENABLED kill-switch, and swallows
 * every failure (warn + continue) so scoring is never impacted.
 */
export function recordLlmUsage(args: RecordUsageArgs): void {
  if (!loggingEnabled()) return;
  try {
    const usage = parseUsage(args.raw);
    const cost = computeCost(usage, args.model);
    const ctx: LlmUsageContext = { ...(getLlmContext() || {}), ...(args.context || {}) };
    const callType = args.callType ?? ctx.callType ?? null;
    enqueueUsageEvent([
      ctx.workspaceId ?? null,
      ctx.batchId ?? null,
      ctx.companyId ?? null,
      ctx.frameworkId ?? null,
      args.model || null,
      args.provider || null,
      callType ?? null,
      usage.promptTokens ?? 0,
      usage.completionTokens ?? 0,
      usage.totalTokens ?? 0,
      cost.inputCostUsd,
      cost.outputCostUsd,
      cost.totalCostUsd,
    ]);
  } catch (e: any) {
    console.warn(`[llm-usage] recordLlmUsage failed (swallowed): ${e?.message || e}`);
  }
}

// ─── Batched, pool-isolated persistence ──────────────────────────────────────
// REGRESSION FIX (root cause of scoring-phase pool exhaustion): scoring makes
// ~100 LLM calls per company (36 measures × primary/fallback/arbiter). The old
// path did one fire-and-forget `pool.query` INSERT per call on the SHARED job
// pool (server/db.ts). Under concurrent scoring that flooded the pool and starved
// the ESSENTIAL connections — heartbeat, lock-renewal, status writes, the stale-
// claim reaper — so they timed out together ("Connection terminated due to
// connection timeout"). The pool (db.ts) was explicitly sized for ~1 connection
// per concurrent job; usage logging was never in that budget.
//
// This keeps full usage logging but removes the contention two ways:
//   (1) a DEDICATED small pool (max PG_USAGE_POOL_MAX, default 2), fully isolated
//       from the job pool, so usage inserts can never consume job-pool slots; and
//   (2) in-memory BUFFERING flushed as ONE multi-row INSERT on a timer / size
//       threshold, so N LLM calls cost O(1) round-trips instead of O(N)
//       concurrent checkouts.
// Telemetry stays best-effort: overflow drops oldest, flush failures are swallowed
// (never requeued → no hot-loop), and nothing here can throw into scoring.

type UsageRow = [
  number | null, number | null, number | null, number | null, // workspace, batch, company, framework
  string | null, string | null, string | null,                // model, provider, callType
  number, number, number,                                      // prompt, completion, total tokens
  number | null, number | null, number | null,                // input, output, total cost usd
];

const USAGE_COLS = 13;
const FLUSH_INTERVAL_MS = parseInt(process.env.LLM_USAGE_FLUSH_MS || "5000", 10);
const FLUSH_MAX_ROWS = parseInt(process.env.LLM_USAGE_FLUSH_ROWS || "200", 10);
const BUFFER_MAX_ROWS = parseInt(process.env.LLM_USAGE_BUFFER_MAX || "5000", 10);
const USAGE_POOL_MAX = parseInt(process.env.PG_USAGE_POOL_MAX || "2", 10);

const usageBuffer: UsageRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;
let usagePool: import("pg").Pool | null = null;
let shutdownHooked = false;

async function getUsagePool(): Promise<import("pg").Pool> {
  if (usagePool) return usagePool;
  // Lazy import so the pure functions above stay importable (e.g. in unit tests)
  // without requiring DATABASE_URL / a live pool.
  const pg = (await import("pg")).default;
  usagePool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: USAGE_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || "10000", 10),
  });
  // DIAGNOSTIC-ONLY (batch-1255 §6.1): tag this SEPARATE pool distinctly ("usage").
  const diag = await import("./pg-diag.js");
  diag.registerPoolForDiagnostics("usage", usagePool, USAGE_POOL_MAX);
  return usagePool;
}

function ensureFlusher(): void {
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flushUsage(); }, FLUSH_INTERVAL_MS);
    // Telemetry must never keep the process alive on its own.
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
  if (!shutdownHooked) {
    shutdownHooked = true;
    const onExit = () => { void flushUsage(); };
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);
    process.once("beforeExit", onExit);
  }
}

function enqueueUsageEvent(row: UsageRow): void {
  usageBuffer.push(row);
  if (usageBuffer.length > BUFFER_MAX_ROWS) {
    const dropped = usageBuffer.length - BUFFER_MAX_ROWS;
    usageBuffer.splice(0, dropped); // drop oldest; telemetry is best-effort
    console.warn(`[llm-usage] buffer overflow; dropped ${dropped} oldest usage event(s)`);
  }
  ensureFlusher();
  if (usageBuffer.length >= FLUSH_MAX_ROWS) void flushUsage();
}

async function flushUsage(): Promise<void> {
  if (flushing || usageBuffer.length === 0) return;
  flushing = true;
  const batch = usageBuffer.splice(0, FLUSH_MAX_ROWS); // bound one INSERT's size
  try {
    const values: any[] = [];
    const tuples: string[] = [];
    batch.forEach((r, i) => {
      const base = i * USAGE_COLS;
      tuples.push(`(${Array.from({ length: USAGE_COLS }, (_, k) => `$${base + k + 1}`).join(",")})`);
      values.push(...r);
    });
    const p = await getUsagePool();
    const diag = await import("./pg-diag.js");
    const runQuery = (...args: any[]): Promise<any> =>
      diag.isPoolInstrumented("usage") ? diag.instrumentedQuery("usage", args) : (p.query as any)(...args);
    await runQuery(
      `INSERT INTO llm_usage_events
         (workspace_id, batch_id, company_id, framework_id, model, provider, call_type,
          prompt_tokens, completion_tokens, total_tokens,
          input_cost_usd, output_cost_usd, total_cost_usd)
       VALUES ${tuples.join(",")}`,
      values
    );
  } catch (e: any) {
    // Swallow; do NOT requeue (avoids unbounded growth / hot-looping when the DB
    // is unhappy). Usage logging can never break or slow scoring.
    console.warn(`[llm-usage] flush failed (swallowed): ${e?.message || e}`);
  } finally {
    flushing = false;
  }
}
