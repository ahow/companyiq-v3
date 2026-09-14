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
    void insertUsageEvent({ usage, cost, model: args.model, provider: args.provider, callType, ctx }).catch(
      (e: any) => console.warn(`[llm-usage] insert failed (swallowed): ${e?.message || e}`)
    );
  } catch (e: any) {
    console.warn(`[llm-usage] recordLlmUsage failed (swallowed): ${e?.message || e}`);
  }
}

async function insertUsageEvent(p: {
  usage: ParsedUsage;
  cost: ComputedCost;
  model: string;
  provider: string;
  callType: string | null;
  ctx: LlmUsageContext;
}): Promise<void> {
  // Lazy import so the pure functions above stay importable (e.g. in unit tests)
  // without requiring DATABASE_URL / a live pool.
  const { pool } = await import("../db.js");
  await pool.query(
    `INSERT INTO llm_usage_events
       (workspace_id, batch_id, company_id, framework_id, model, provider, call_type,
        prompt_tokens, completion_tokens, total_tokens,
        input_cost_usd, output_cost_usd, total_cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      p.ctx.workspaceId ?? null,
      p.ctx.batchId ?? null,
      p.ctx.companyId ?? null,
      p.ctx.frameworkId ?? null,
      p.model || null,
      p.provider || null,
      p.callType ?? null,
      p.usage.promptTokens ?? 0,
      p.usage.completionTokens ?? 0,
      p.usage.totalTokens ?? 0,
      p.cost.inputCostUsd,
      p.cost.outputCostUsd,
      p.cost.totalCostUsd,
    ]
  );
}
