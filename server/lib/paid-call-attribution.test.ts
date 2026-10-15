// WP13-A — per-call cost-attribution unit tests.
// Run: node --import tsx --test server/lib/paid-call-attribution.test.ts
//
// These tests exercise the PURE builder (buildPaidCallRow), which needs no DB.
// The central contract under test: every paid call produces a self-describing
// row that is joinable by its OWN identifiers + emit timestamp, NEVER by
// log-arrival order.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPaidCallRow,
  PAID_CALL_COLS,
  type PaidCallRow,
} from "./paid-call-attribution.js";

// Column indices (must match the fixed row order + the DDL in server/db.ts).
const C = {
  request_id: 0, call_kind: 1, workspace_id: 2, batch_id: 3, job_id: 4,
  company_id: 5, framework_id: 6, measure_id: 7, role: 8, stage: 9,
  provider: 10, model: 11, endpoint: 12, input_tokens: 13, output_tokens: 14,
  total_tokens: 15, retry_count: 16, input_cost_usd: 17, output_cost_usd: 18,
  total_cost_usd: 19, emit_ts: 20,
} as const;

test("row has exactly PAID_CALL_COLS columns in the documented order", () => {
  const row = buildPaidCallRow({
    callKind: "llm",
    provider: "deepseek",
    model: "deepseek-chat",
    context: { workspaceId: 1, batchId: 2, jobId: 3, companyId: 4, frameworkId: 5 },
  });
  assert.equal(PAID_CALL_COLS, 21);
  assert.equal(row.length, PAID_CALL_COLS);
});

test("explicit attribution context is captured at the correct positions", () => {
  const row = buildPaidCallRow({
    callKind: "llm",
    provider: "deepseek",
    model: "deepseek-chat",
    role: "primary",
    stage: "scoring",
    measureId: "m-42",
    retryCount: 2,
    context: { workspaceId: 10, batchId: 20, jobId: 30, companyId: 40, frameworkId: 50 },
  });
  assert.equal(row[C.call_kind], "llm");
  assert.equal(row[C.workspace_id], 10);
  assert.equal(row[C.batch_id], 20);
  assert.equal(row[C.job_id], 30);
  assert.equal(row[C.company_id], 40);
  assert.equal(row[C.framework_id], 50);
  assert.equal(row[C.measure_id], "m-42");
  assert.equal(row[C.role], "primary");
  assert.equal(row[C.stage], "scoring");
  assert.equal(row[C.provider], "deepseek");
  assert.equal(row[C.model], "deepseek-chat");
  assert.equal(row[C.retry_count], 2);
});

test("each call mints a distinct stable request_id (join key, not log order)", () => {
  const base = { callKind: "search" as const, provider: "serper", endpoint: "https://serper.dev" };
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const row = buildPaidCallRow(base);
    const id = row[C.request_id] as string;
    assert.ok(typeof id === "string" && id.length >= 16, "request_id must be a stable non-trivial id");
    ids.add(id);
  }
  assert.equal(ids.size, 50, "request_ids must be unique per call");
});

test("a supplied request_id is preserved verbatim (log correlation)", () => {
  const row = buildPaidCallRow({ callKind: "browser", provider: "evomi" }, "req-abc-123");
  assert.equal(row[C.request_id], "req-abc-123");
});

test("rows are joinable by OWN timestamp, independent of emission/arrival order", () => {
  // Build rows whose emit timestamps are DELIBERATELY out of insertion order:
  // the row inserted SECOND carries the EARLIER timestamp. A correct consumer
  // that sorts by emit_ts must recover true chronological order regardless of
  // the order the rows were produced/appended.
  const late = buildPaidCallRow({
    callKind: "llm", provider: "deepseek", model: "deepseek-chat",
    measureId: "m-late", emittedAt: "2026-01-01T00:00:10.000Z",
    context: { jobId: 7 },
  });
  const early = buildPaidCallRow({
    callKind: "llm", provider: "deepseek", model: "deepseek-chat",
    measureId: "m-early", emittedAt: "2026-01-01T00:00:01.000Z",
    context: { jobId: 7 },
  });
  const arrivalOrder: PaidCallRow[] = [late, early]; // arrival order != time order
  const byTime = [...arrivalOrder].sort((a, b) =>
    String(a[C.emit_ts]).localeCompare(String(b[C.emit_ts])));
  assert.equal(byTime[0][C.measure_id], "m-early");
  assert.equal(byTime[1][C.measure_id], "m-late");
  // Both rows still belong to the same job via their OWN job_id, not position.
  assert.equal(byTime[0][C.job_id], 7);
  assert.equal(byTime[1][C.job_id], 7);
});

test("LLM usage + cost are parsed for llm kind; null for non-llm kinds", () => {
  const llm = buildPaidCallRow({
    callKind: "llm", provider: "deepseek", model: "deepseek-chat",
    rawUsage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
  assert.equal(llm[C.input_tokens], 100);
  assert.equal(llm[C.output_tokens], 40);
  assert.equal(llm[C.total_tokens], 140);
  // Cost is model-priced; for a priced model it is a number, else null — but
  // never a token value. Assert it is numeric-or-null and total ≥ 0 when set.
  const total = llm[C.total_cost_usd];
  assert.ok(total === null || (typeof total === "number" && total >= 0));

  const search = buildPaidCallRow({ callKind: "search", provider: "serper", endpoint: "u" });
  assert.equal(search[C.input_tokens], null);
  assert.equal(search[C.output_tokens], null);
  assert.equal(search[C.total_tokens], null);
  assert.equal(search[C.total_cost_usd], null);
});

test("retry_count is clamped to a non-negative integer", () => {
  assert.equal(buildPaidCallRow({ callKind: "search", provider: "serper", retryCount: -5 })[C.retry_count], 0);
  assert.equal(buildPaidCallRow({ callKind: "search", provider: "serper", retryCount: 3.9 })[C.retry_count], 3);
  assert.equal(buildPaidCallRow({ callKind: "search", provider: "serper" })[C.retry_count], 0);
});

test("emit_ts is a valid ISO-8601 instant reflecting when the call settled", () => {
  const row = buildPaidCallRow({ callKind: "browser", provider: "evomi", emittedAt: "2026-03-04T05:06:07.000Z" });
  assert.equal(row[C.emit_ts], "2026-03-04T05:06:07.000Z");
  const now = buildPaidCallRow({ callKind: "browser", provider: "evomi" });
  assert.ok(!Number.isNaN(Date.parse(String(now[C.emit_ts]))), "emit_ts must be parseable");
});
