/**
 * WP05/Phase0 — behavioural tests proving:
 *   (1) the extraction classifier produces 'partial' for a non-empty-but-truncated
 *       / timed-out read (NOT 'complete');
 *   (2) the classified label flows through the persist derivation
 *       (`deriveExtractionState`, used verbatim by `recordFetchSuccess`): a supplied
 *       'partial' label persists 'partial' even though content_length > 0, while an
 *       absent label falls back to the legacy binary derivation (unrelated callers
 *       unaffected);
 *   (3) the EX04 recovery-boundary guard HOLDS: no matter how many times the
 *       document-completeness re-retrieval decision is invoked for the same company
 *       in the same batch, recovery fires at most ONCE (recovery cannot loop).
 *
 * The persist derivation is tested as a pure function, which is the ONLY logic in
 * recordFetchSuccess's extraction-state branch (the UPDATE is a trivial passthrough
 * of the derived value) — so this proves the thread end-to-end without live DB I/O.
 * The real `RetrievalReviewQueue` registry is used; the discovery/network call is
 * dependency-injected with a counting fake, so NO live DB, discovery, or network.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/phase0-partial-threading.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// Keep the loop alive and pin a DB URL that is never actually connected (nothing
// under test performs DB I/O).
const keepAlive = setInterval(() => {}, 1000);
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
});

const { classifyExtractionCompleteness } = await import("./processor.js");
const { deriveExtractionState } = await import("../storage.js");
const { maybeFireDocumentCompletenessReretrieval, DOC_COMPLETENESS_RERETRIEVAL_KEY } = await import("./analyzer.js");
const { RetrievalReviewQueue } = await import("./retrieval-review-queue.js");
import type { ReretrievalResult } from "./retrieval-review-queue.js";

// ── (1) classifier produces 'partial' for a non-empty truncated/timed-out read ──
test("(1a) a non-empty but TIMED-OUT extraction classifies 'partial', not 'complete'", () => {
  const c = classifyExtractionCompleteness({
    textLen: 5000, minChars: 1000, timedOut: true, failed: false,
  });
  assert.equal(c, "partial", "a SIGKILLed engine's partial stdout must never be 'complete'");
});

test("(1b) a non-empty extraction with pages left unprocessed classifies 'partial'", () => {
  const c = classifyExtractionCompleteness({
    textLen: 5000, minChars: 1000, timedOut: false, failed: false,
    pagesAvailable: 40, pagesProcessed: 6,
  });
  assert.equal(c, "partial", "pages-incomplete with some text => partial");
});

test("(1c) a short clean read (some text, below minChars) classifies 'partial'", () => {
  const c = classifyExtractionCompleteness({
    textLen: 120, minChars: 1000, timedOut: false, failed: false,
  });
  assert.equal(c, "partial");
});

test("(1d) a full clean read classifies 'complete'", () => {
  const c = classifyExtractionCompleteness({
    textLen: 50000, minChars: 1000, timedOut: false, failed: false,
    pagesAvailable: 40, pagesProcessed: 40,
  });
  assert.equal(c, "complete");
});

// ── (2) the classified label flows through the persist derivation ───────────────
test("(2a) a supplied 'partial' label persists 'partial' EVEN THOUGH content_length > 0", () => {
  // This is the exact small-PDF gap: binary derivation would say 'complete'.
  assert.equal(deriveExtractionState(5000, "partial"), "partial");
});

test("(2b) a supplied 'unknown' label flows through unchanged", () => {
  assert.equal(deriveExtractionState(5000, "unknown"), "unknown");
});

test("(2c) NO supplied label + content>0 falls back to legacy binary 'complete'", () => {
  assert.equal(deriveExtractionState(5000, undefined), "complete");
  assert.equal(deriveExtractionState(5000, null), "complete");
});

test("(2d) NO supplied label + empty content falls back to legacy binary 'empty'", () => {
  assert.equal(deriveExtractionState(0, undefined), "empty");
});

test("(2e) a supplied 'complete' label is honoured (no spurious downgrade)", () => {
  assert.equal(deriveExtractionState(50000, "complete"), "complete");
});

// ── (3) recovery-boundary guard holds under repeated invocation ─────────────────
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

const company = { id: 202, name: "Beta PLC", domain: "beta.example", isin: null, ticker: null, sector: null, country: null } as any;
const framework = { id: 18, name: "AI Management" } as any;
const measures = [
  { measureId: "m1", title: "Board AI oversight", definition: "Whether the board oversees AI risk management." },
] as any;

test("(3) recovery stops after the bound: 5 sequential 'partial' invocations => EXACTLY ONE fire", async () => {
  const spy = makeCountingReretrieval();
  const reviewQueue = new RetrievalReviewQueue();
  const base = {
    documentCompleteness: ["partial", "unknown"],
    reviewQueue,
    company,
    framework,
    measures,
    trustedSources: [],
    issuerProfile: undefined,
    existingCorpusText: "EXISTING",
    existingDocUrls: new Set<string>(),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: false,
  } as any;

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await maybeFireDocumentCompletenessReretrieval(base, spy.fn as any));
  }

  assert.equal(spy.calls, 1, "the per-company/per-batch bound caps recovery at ONE across repeated invocations");
  assert.equal(results[0].fired, true, "first invocation fires");
  assert.equal(results[0].reason, "fired");
  for (let i = 1; i < 5; i++) {
    assert.equal(results[i].fired, false, `invocation ${i + 1} is blocked by the bound`);
    assert.equal(results[i].reason, "already-fired");
  }
  assert.ok(
    reviewQueue.hasFired(company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY),
    "the reserved dedupe key is marked fired — recovery cannot loop",
  );
});

test.after(() => clearInterval(keepAlive));
