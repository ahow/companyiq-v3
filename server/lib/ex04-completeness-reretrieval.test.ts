/**
 * EX04 — behavioural tests for the document-level completeness re-retrieval
 * decision helper `maybeFireDocumentCompletenessReretrieval` (server/lib/analyzer.ts)
 * against the REAL `RetrievalReviewQueue` per-batch dedupe registry. The actual
 * discovery/network call (`runTargetedReretrieval`) is dependency-injected with a
 * counting fake, so NO live DB, discovery, or network is touched.
 *
 * COVERAGE (gates EX04 completion):
 *   (a) a doc classified 'unknown'  → EXACTLY ONE targeted re-retrieval
 *   (b) a genuinely 'empty' doc     → ZERO
 *   (c) a 'complete' doc            → ZERO (verdict-invariant)
 *   (d) skipFetch / replay          → ZERO (suppressed; replay determinism held)
 *   (e) two 'unknown' docs, SAME company same batch → at most ONE (bound holds)
 * Plus a 'partial' parity case and a flag-off gating case.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/ex04-completeness-reretrieval.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// Match the sibling harness: keep the loop alive and pin a DB URL that is never
// actually connected (the helper under test performs no DB I/O).
const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
});

const { maybeFireDocumentCompletenessReretrieval, DOC_COMPLETENESS_RERETRIEVAL_KEY } = await import("./analyzer.js");
const { RetrievalReviewQueue } = await import("./retrieval-review-queue.js");
import type { ReretrievalResult } from "./retrieval-review-queue.js";
import type { ExtractionCompleteness } from "./processor.js";

// A counting fake for the injected discovery call. Mirrors the real contract:
// it records the fingerprintKey into the shared firedSet (as runTargetedReretrieval
// does) so the dedupe path is exercised exactly as in production.
function makeCountingReretrieval() {
  let calls = 0;
  const fn = async (
    req: { fingerprintKey: string },
    firedSet: Set<string>,
  ): Promise<ReretrievalResult> => {
    calls += 1;
    firedSet.add(req.fingerprintKey);
    return { fired: true, newDocsAdded: 0, targetedQuery: "fake", reason: "no-new-docs" };
  };
  return { fn, get calls() { return calls; } };
}

// Minimal framework-level fixtures. Shapes are cast because the helper only reads
// company.{id,name,domain,isin,ticker,sector,country} and the measure definition
// fields — never any other column — which is exactly the framework-level contract.
const company = { id: 101, name: "Acme PLC", domain: "acme.example", isin: null, ticker: null, sector: null, country: null } as any;
const framework = { id: 18, name: "AI Management" } as any;
const measures = [
  { measureId: "m1", title: "Board AI oversight", definition: "Whether the board oversees AI risk management." },
] as any;

function baseArgs(documentCompleteness: ExtractionCompleteness[], over: Record<string, unknown> = {}) {
  return {
    documentCompleteness,
    reviewQueue: new RetrievalReviewQueue(),
    company,
    framework,
    measures,
    trustedSources: [],
    issuerProfile: undefined,
    existingCorpusText: "EXISTING CORPUS TEXT",
    existingDocUrls: new Set<string>(),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: false,
    ...over,
  } as any;
}

// ── (a) 'unknown' fires EXACTLY ONE ──────────────────────────────────────────
test("(a) a document classified 'unknown' triggers EXACTLY ONE targeted re-retrieval", async () => {
  const spy = makeCountingReretrieval();
  const res = await maybeFireDocumentCompletenessReretrieval(baseArgs(["unknown"]), spy.fn as any);
  assert.equal(spy.calls, 1, "exactly one re-retrieval fired");
  assert.equal(res.fired, true);
  assert.equal(res.reason, "fired");
});

// ── (b) 'empty' fires ZERO (verdict-invariant) ───────────────────────────────
test("(b) a genuinely 'empty' document triggers ZERO re-retrievals", async () => {
  const spy = makeCountingReretrieval();
  const res = await maybeFireDocumentCompletenessReretrieval(baseArgs(["empty"]), spy.fn as any);
  assert.equal(spy.calls, 0, "no re-retrieval for a genuinely empty document");
  assert.equal(res.fired, false);
  assert.equal(res.reason, "no-failed-extraction");
});

// ── (c) 'complete' fires ZERO (verdict-invariant) ────────────────────────────
test("(c) a 'complete' document triggers ZERO re-retrievals", async () => {
  const spy = makeCountingReretrieval();
  const res = await maybeFireDocumentCompletenessReretrieval(baseArgs(["complete"]), spy.fn as any);
  assert.equal(spy.calls, 0, "no re-retrieval for a complete document");
  assert.equal(res.fired, false);
  assert.equal(res.reason, "no-failed-extraction");
});

// ── (d) skipFetch/replay fires ZERO (suppressed) ─────────────────────────────
test("(d) under skipFetch/replay an 'unknown' document triggers ZERO (suppressed)", async () => {
  const spy = makeCountingReretrieval();
  const res = await maybeFireDocumentCompletenessReretrieval(baseArgs(["unknown"], { skipFetch: true }), spy.fn as any);
  assert.equal(spy.calls, 0, "re-retrieval fully suppressed under replay for determinism");
  assert.equal(res.fired, false);
  assert.equal(res.reason, "skipFetch");
});

// ── (e) two 'unknown' docs, SAME company same batch → at most ONE ─────────────
test("(e) two 'unknown' documents for the same company in the same batch still trigger at most ONE", async () => {
  const spy = makeCountingReretrieval();
  const reviewQueue = new RetrievalReviewQueue();

  // First: two 'unknown' docs in one call — per-company, not per-doc, so ONE fire.
  const res1 = await maybeFireDocumentCompletenessReretrieval(
    baseArgs(["unknown", "unknown"], { reviewQueue }), spy.fn as any);
  // Second call, SAME reviewQueue (same batch) — the dedupe bound must block it.
  const res2 = await maybeFireDocumentCompletenessReretrieval(
    baseArgs(["unknown"], { reviewQueue }), spy.fn as any);

  assert.equal(spy.calls, 1, "the per-company/per-batch bound caps re-retrieval at ONE");
  assert.equal(res1.fired, true);
  assert.equal(res2.fired, false);
  assert.equal(res2.reason, "already-fired");
  assert.ok(reviewQueue.hasFired(company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY), "the reserved dedupe key is marked fired");
});

// ── parity: 'partial' is a confirmed failed-read → fires ONE ─────────────────
test("(parity) a 'partial' document triggers EXACTLY ONE re-retrieval", async () => {
  const spy = makeCountingReretrieval();
  const res = await maybeFireDocumentCompletenessReretrieval(baseArgs(["partial"]), spy.fn as any);
  assert.equal(spy.calls, 1);
  assert.equal(res.fired, true);
});

// ── gating: flags off → ZERO even with an 'unknown' doc ──────────────────────
test("(gating) with retrievalV2/autoReretrieval off an 'unknown' document triggers ZERO", async () => {
  const spyOff1 = makeCountingReretrieval();
  const r1 = await maybeFireDocumentCompletenessReretrieval(baseArgs(["unknown"], { retrievalV2: false }), spyOff1.fn as any);
  assert.equal(spyOff1.calls, 0);
  assert.equal(r1.reason, "flag-off");

  const spyOff2 = makeCountingReretrieval();
  const r2 = await maybeFireDocumentCompletenessReretrieval(baseArgs(["unknown"], { autoReretrieval: false }), spyOff2.fn as any);
  assert.equal(spyOff2.calls, 0);
  assert.equal(r2.reason, "flag-off");
});

test.after(() => clearInterval(keepAlive));
