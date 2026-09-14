import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUsage,
  computeCost,
  lookupPrice,
  loadPriceTable,
  resetPriceTableCache,
  type PriceTable,
} from "./llm-usage.js";

// A fixed, self-contained price table so tests don't depend on env or defaults.
const TABLE: PriceTable = {
  "deepseek": { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  "glm-4.6": { inputPerMillion: 0.6, outputPerMillion: 2.2 },
  "claude-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
};

// ─── parseUsage: both provider shapes ────────────────────────────────────────

test("parseUsage parses OpenAI-compatible shape (prompt/completion/total)", () => {
  const u = parseUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
  assert.equal(u.promptTokens, 1000);
  assert.equal(u.completionTokens, 200);
  assert.equal(u.totalTokens, 1200);
});

test("parseUsage parses Anthropic shape (input/output tokens, derives total)", () => {
  const u = parseUsage({ input_tokens: 500, output_tokens: 50 });
  assert.equal(u.promptTokens, 500);
  assert.equal(u.completionTokens, 50);
  assert.equal(u.totalTokens, 550); // derived when total absent
});

test("parseUsage parses Gemini shape (usageMetadata counts)", () => {
  const u = parseUsage({ promptTokenCount: 300, candidatesTokenCount: 40, totalTokenCount: 340 });
  assert.equal(u.promptTokens, 300);
  assert.equal(u.completionTokens, 40);
  assert.equal(u.totalTokens, 340);
});

test("parseUsage returns nulls for missing/invalid usage (never throws)", () => {
  for (const bad of [null, undefined, {}, 42, "x", { prompt_tokens: "nope" }]) {
    const u = parseUsage(bad as any);
    assert.equal(u.promptTokens, null);
    assert.equal(u.completionTokens, null);
    assert.equal(u.totalTokens, null);
  }
});

// ─── lookupPrice: substring / longest-match ──────────────────────────────────

test("lookupPrice matches dated/versioned model names via longest substring key", () => {
  // "claude-sonnet-4-5-20250929" should match "claude-sonnet", not a shorter key
  const p = lookupPrice("claude-sonnet-4-5-20250929", TABLE);
  assert.ok(p);
  assert.equal(p!.inputPerMillion, 3.0);
});

test("lookupPrice is case-insensitive and exact-first", () => {
  const p = lookupPrice("DeepSeek", TABLE);
  assert.ok(p);
  assert.equal(p!.inputPerMillion, 0.28);
});

test("lookupPrice returns null for an unknown model", () => {
  assert.equal(lookupPrice("mystery-model-x", TABLE), null);
});

// ─── computeCost: USD math + unknown model ───────────────────────────────────

test("computeCost computes USD from tokens + price table", () => {
  const usage = parseUsage({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  const cost = computeCost(usage, "deepseek", TABLE);
  assert.ok(Math.abs((cost.inputCostUsd ?? -1) - 0.28) < 1e-9);
  assert.ok(Math.abs((cost.outputCostUsd ?? -1) - 0.42) < 1e-9);
  assert.ok(Math.abs((cost.totalCostUsd ?? -1) - 0.7) < 1e-9);
});

test("computeCost scales linearly with partial-million token counts", () => {
  const usage = parseUsage({ prompt_tokens: 500_000, completion_tokens: 250_000 });
  const cost = computeCost(usage, "glm-4.6", TABLE);
  // 0.5M * 0.6 = 0.30 ; 0.25M * 2.2 = 0.55 ; total 0.85
  assert.ok(Math.abs((cost.inputCostUsd ?? -1) - 0.3) < 1e-9);
  assert.ok(Math.abs((cost.outputCostUsd ?? -1) - 0.55) < 1e-9);
  assert.ok(Math.abs((cost.totalCostUsd ?? -1) - 0.85) < 1e-9);
});

test("computeCost returns null cost for unknown model (tokens still parsed)", () => {
  const usage = parseUsage({ prompt_tokens: 1000, completion_tokens: 100 });
  const cost = computeCost(usage, "unknown-model", TABLE);
  assert.equal(cost.inputCostUsd, null);
  assert.equal(cost.outputCostUsd, null);
  assert.equal(cost.totalCostUsd, null);
});

test("computeCost treats missing token counts as 0 when price is known", () => {
  const usage = parseUsage(null);
  const cost = computeCost(usage, "deepseek", TABLE);
  assert.equal(cost.inputCostUsd, 0);
  assert.equal(cost.outputCostUsd, 0);
  assert.equal(cost.totalCostUsd, 0);
});

// ─── loadPriceTable: env override merges over defaults ────────────────────────

test("loadPriceTable merges LLM_PRICE_TABLE_JSON over built-in defaults", () => {
  const prev = process.env.LLM_PRICE_TABLE_JSON;
  try {
    resetPriceTableCache();
    process.env.LLM_PRICE_TABLE_JSON = JSON.stringify({
      "deepseek": { inputPerMillion: 9.99, outputPerMillion: 8.88 },
      "brand-new-model": { inputPerMillion: 1.11, outputPerMillion: 2.22 },
    });
    const table = loadPriceTable();
    // Overridden default
    assert.equal(table["deepseek"].inputPerMillion, 9.99);
    // New model added
    assert.equal(table["brand-new-model"].outputPerMillion, 2.22);
    // A built-in that wasn't overridden still present
    assert.ok(table["claude"]);
  } finally {
    if (prev === undefined) delete process.env.LLM_PRICE_TABLE_JSON;
    else process.env.LLM_PRICE_TABLE_JSON = prev;
    resetPriceTableCache();
  }
});

test("loadPriceTable ignores malformed env JSON (falls back to defaults)", () => {
  const prev = process.env.LLM_PRICE_TABLE_JSON;
  try {
    resetPriceTableCache();
    process.env.LLM_PRICE_TABLE_JSON = "{not valid json";
    const table = loadPriceTable();
    assert.ok(table["deepseek"]); // defaults intact
  } finally {
    if (prev === undefined) delete process.env.LLM_PRICE_TABLE_JSON;
    else process.env.LLM_PRICE_TABLE_JSON = prev;
    resetPriceTableCache();
  }
});
