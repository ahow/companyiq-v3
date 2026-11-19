/**
 * 1.6 — READJUDICATION_PASS: gated, bounded, idempotent re-adjudication pass.
 * node:test — run with:  npx tsx --test server/lib/readjudication.test.ts
 * No company/framework/measure names referenced — criteria/corpus are free text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReadjudicate, readjudicateMeasure } from "./readjudication.js";

// Criteria vocabulary and a corpus passage that genuinely satisfies ALL of it.
const CRITERIA = [
  "board committee oversight of climate risk",
  "documented governance process reviewed annually",
];
const SUPPORTING_PACK =
  "--- DOCUMENT: Annual Report [https://example-issuer.com/ar] ---\n"
  + "The board committee has oversight of climate risk across the group. "
  + "A documented governance process is reviewed annually by the committee and covers climate risk oversight.";
const UNSUPPORTING_PACK =
  "--- DOCUMENT: Marketing [https://example-issuer.com/x] ---\n"
  + "Our stores offer a wide range of seasonal products and gift cards for loyal shoppers.";

test("unflagged row is never touched (returns unchanged, no trace)", () => {
  const r: any = { verdict: "No", score: 0, needsReadjudication: false, rationaleScoreInconsistent: false };
  const out = readjudicateMeasure({ result: r, criteria: CRITERIA, packText: SUPPORTING_PACK });
  assert.equal(out.readjudicationTrace, undefined);
  assert.equal(out.verdict, "No");
  assert.equal(shouldReadjudicate(r), false);
});

test("flagged + genuinely-supported corpus → verdict moves to Yes with trace", () => {
  const r: any = { verdict: "No", score: 0, needsReadjudication: true, inconsistencyReason: "affirmative_on_no" };
  const out = readjudicateMeasure({ result: r, criteria: CRITERIA, packText: SUPPORTING_PACK });
  assert.equal(out.verdict, "Yes");
  assert.equal(out.score, 1);
  assert.ok(out.readjudicationTrace, "trace recorded");
  assert.equal(out.readjudicationTrace!.resolution, "moved-to-yes");
  assert.equal(out.readjudicationTrace!.originalVerdict, "No");
  assert.ok(out.readjudicationTrace!.passagesSearched > 0, "searched passages recorded");
  assert.ok(out.readjudicationTrace!.foundPassage, "found passage recorded");
  assert.equal(out.needsReadjudication, false, "flag cleared");
  assert.ok((out.quotes || []).length > 0, "supporting quote attached");
});

test("flagged + genuinely-unsupported corpus → stays No, flag cleared, reason recorded", () => {
  const r: any = { verdict: "No", score: 0, rationaleScoreInconsistent: true, inconsistencyReason: "affirmative_on_no" };
  const out = readjudicateMeasure({ result: r, criteria: CRITERIA, packText: UNSUPPORTING_PACK });
  assert.equal(out.verdict, "No");
  assert.equal(out.readjudicationTrace!.resolution, "confirmed-no");
  assert.equal(out.readjudicationTrace!.cleared, true);
  assert.equal(out.needsReadjudication, false, "flag cleared even when No confirmed");
  assert.ok(String(out.verdictNuance).includes("Re-adjudication"), "audit note appended");
});

test("idempotent / bounded: a row that already has a trace is skipped", () => {
  const r: any = { verdict: "No", score: 0, needsReadjudication: true, inconsistencyReason: "x" };
  readjudicateMeasure({ result: r, criteria: CRITERIA, packText: SUPPORTING_PACK });
  const verdictAfterFirst = r.verdict;
  const traceAfterFirst = r.readjudicationTrace;
  // shouldReadjudicate now false because a trace exists.
  assert.equal(shouldReadjudicate(r), false);
  const out = readjudicateMeasure({ result: r, criteria: CRITERIA, packText: UNSUPPORTING_PACK });
  assert.equal(out.verdict, verdictAfterFirst, "second pass does not change the verdict");
  assert.equal(out.readjudicationTrace, traceAfterFirst, "trace unchanged on second pass");
});

test("deterministic: two fresh rows over the same corpus reach the same verdict", () => {
  const mk = () => ({ verdict: "No", score: 0, needsReadjudication: true, inconsistencyReason: "x" }) as any;
  const a = readjudicateMeasure({ result: mk(), criteria: CRITERIA, packText: SUPPORTING_PACK });
  const b = readjudicateMeasure({ result: mk(), criteria: CRITERIA, packText: SUPPORTING_PACK });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.readjudicationTrace!.foundPassage, b.readjudicationTrace!.foundPassage);
});
