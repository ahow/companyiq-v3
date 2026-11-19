// Wiring tests for 3.4b EXTRACTION_RETRY_FALLBACK integrated into
// processor.processDocument via the injectable worker hook. Asserts:
//   • flag OFF → exactly one attempt (today's behaviour), no retry;
//   • flag ON  → a failed RECOVERABLE-vehicle extraction is retried, bounded by
//     EXTRACTION_RETRY_BUDGET (no loop, no cost inflation);
//   • non-recoverable vehicles and permanent failures are never retried.
// Also exercises the bounded-retry decision function directly.
//
// Run: DATABASE_URL=postgres://x node --import tsx --test server/lib/extraction-retry-wiring.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { processDocument, __setProcessDocumentWorkerForTest, PermanentFetchError } from "./processor.js";
import { mayRetryExtraction } from "./retrieval-funnel.js";

const GOOD = "x".repeat(200); // > 50 chars → "usable" extraction

function setFlag(name: string, v: string | null) {
  if (v == null) delete process.env[name];
  else process.env[name] = v;
}

afterEach(() => {
  __setProcessDocumentWorkerForTest(null);
  setFlag("EXTRACTION_RETRY_FALLBACK", null);
  setFlag("EXTRACTION_RETRY_BUDGET", null);
  setFlag("EXTRACTION_RECOVERABLE_VEHICLES", null);
});

// Unique URL per call so the in-memory doc cache / in-flight coalescing never
// bleeds across assertions.
let seq = 0;
const freshUrl = (ext: string) => `https://example.com/doc-${Date.now()}-${seq++}.${ext}`;

// ─── pure bounded-retry decision ───────────────────────────────────────────────

test("3.4b mayRetryExtraction is strictly bounded and vehicle-scoped", () => {
  const rec = ["pdf-behind-link"];
  assert.equal(mayRetryExtraction("pdf-behind-link", 0, 1, rec), true, "recoverable, under budget → retry");
  assert.equal(mayRetryExtraction("pdf-behind-link", 1, 1, rec), false, "attempts == budget → stop (no loop)");
  assert.equal(mayRetryExtraction("html-render", 0, 1, rec), false, "non-recoverable vehicle → never retry");
  assert.equal(mayRetryExtraction("pdf-behind-link", 0, 0, rec), false, "budget 0 → never retry");
});

// ─── OFF: single attempt ────────────────────────────────────────────────────────

test("3.4b OFF: a failing PDF extraction is attempted exactly once (no retry)", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", null); // default off
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    throw new Error("boom");
  });
  await assert.rejects(() => processDocument(freshUrl("pdf"), "pdf"), /boom/);
  assert.equal(calls, 1, "OFF → exactly one attempt");
});

// ─── ON: bounded retry that eventually succeeds ─────────────────────────────────

test("3.4b ON: a recoverable PDF extraction retries within budget and succeeds", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", "1");
  setFlag("EXTRACTION_RETRY_BUDGET", "1");
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return GOOD;
  });
  const out = await processDocument(freshUrl("pdf"), "pdf");
  assert.equal(out, GOOD, "second attempt returns usable text");
  assert.equal(calls, 2, "ON → one retry (two total attempts)");
});

test("3.4b ON: retry is bounded by budget — never loops", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", "1");
  setFlag("EXTRACTION_RETRY_BUDGET", "1");
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    throw new Error("always fails");
  });
  await assert.rejects(() => processDocument(freshUrl("pdf"), "pdf"), /always fails/);
  assert.equal(calls, 2, "budget=1 → at most one retry (two attempts), then give up");
});

test("3.4b ON: empty (unusable) extraction is retried then returned, bounded", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", "1");
  setFlag("EXTRACTION_RETRY_BUDGET", "1");
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    return "   "; // unusable (<= 50 chars after trim)
  });
  const out = await processDocument(freshUrl("pdf"), "pdf");
  assert.equal(out.trim().length <= 50, true, "returns the (still unusable) text after exhausting budget");
  assert.equal(calls, 2, "budget=1 → one retry on empty extraction");
});

// ─── ON: non-recoverable vehicle & permanent failure never retried ──────────────

test("3.4b ON: non-recoverable vehicle (html) is NOT retried", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", "1");
  setFlag("EXTRACTION_RETRY_BUDGET", "2");
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    throw new Error("html boom");
  });
  await assert.rejects(() => processDocument(freshUrl("html"), "html"), /html boom/);
  assert.equal(calls, 1, "html-render vehicle not in recoverable set → single attempt");
});

test("3.4b ON: PermanentFetchError is never retried", async () => {
  setFlag("EXTRACTION_RETRY_FALLBACK", "1");
  setFlag("EXTRACTION_RETRY_BUDGET", "2");
  let calls = 0;
  __setProcessDocumentWorkerForTest(async () => {
    calls++;
    throw new PermanentFetchError("gone");
  });
  await assert.rejects(() => processDocument(freshUrl("pdf"), "pdf"));
  assert.equal(calls, 1, "permanent failure → no retry even for a recoverable vehicle");
});
