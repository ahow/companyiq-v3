/**
 * 1.2 — SCORING_BASE_RATE_PRIOR_ALLOW: the legacy base-rate prior cannot influence
 *        the verdict-cache salt unless BOTH the allow-flag AND SCORING_BASE_RATE_PRIOR
 *        are on; with the allow-flag off (compiled default) the salt stays "br0".
 * 1.4 — computeCompanyScore is the SINGLE aggregator; measuresMet equals the former
 *        reduce(binaryScore) sum and abstained/backfilled rows are excluded.
 * node:test — run with:  npx tsx --test server/lib/scoring-base-rate-and-aggregator.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoringBaseRatePriorAllowEnabled } from "./scoring-fix-flags.js";
import { computeCompanyScore, isMet } from "../../shared/verdict.js";

// Replicates the analyzer's salt predicate (1.2): baseRateOn is true ONLY when the
// allow-flag AND the legacy variable are both on. The salt term is "br1" vs "br0".
function saltBaseRateTerm(): string {
  const baseRateOn = scoringBaseRatePriorAllowEnabled() && process.env.SCORING_BASE_RATE_PRIOR === "true";
  return baseRateOn ? "br1" : "br0";
}

test("1.2 default (allow-flag off) → salt stays br0 even if SCORING_BASE_RATE_PRIOR=true", () => {
  delete process.env.SCORING_BASE_RATE_PRIOR_ALLOW;
  process.env.SCORING_BASE_RATE_PRIOR = "true";
  assert.equal(scoringBaseRatePriorAllowEnabled(), false);
  assert.equal(saltBaseRateTerm(), "br0");
  delete process.env.SCORING_BASE_RATE_PRIOR;
});

test("1.2 allow-flag on but legacy var off → salt still br0", () => {
  process.env.SCORING_BASE_RATE_PRIOR_ALLOW = "1";
  delete process.env.SCORING_BASE_RATE_PRIOR;
  assert.equal(saltBaseRateTerm(), "br0");
  delete process.env.SCORING_BASE_RATE_PRIOR_ALLOW;
});

test("1.2 both on → salt becomes br1 (prior honoured only when explicitly allowed)", () => {
  process.env.SCORING_BASE_RATE_PRIOR_ALLOW = "1";
  process.env.SCORING_BASE_RATE_PRIOR = "true";
  assert.equal(saltBaseRateTerm(), "br1");
  delete process.env.SCORING_BASE_RATE_PRIOR_ALLOW;
  delete process.env.SCORING_BASE_RATE_PRIOR;
});

test("1.4 measuresMet equals the binary reduce(score) sum over the same rows", () => {
  const rows = [
    { verdict: "Yes", score: 1 },
    { verdict: "No", score: 0 },
    { verdict: "Partial", score: 0 }, // collapses to No
    { verdict: "Yes", score: 1 },
  ];
  const legacyReduce = rows.reduce((acc, r) => acc + (isMet(r.verdict, r.score) ? 1 : 0), 0);
  const cs = computeCompanyScore(rows);
  assert.equal(cs.measuresMet, legacyReduce);
  assert.equal(cs.measuresMet, 2);
});

test("1.4 abstained and backfilled rows are excluded from answered denominator", () => {
  const rows = [
    { verdict: "Yes", score: 1 },
    { verdict: "No", score: 0 },
    { verdict: "Insufficient evidence", score: 0, abstained: true },
    { verdict: "No", score: 0, backfilled: true },
  ];
  const cs = computeCompanyScore(rows, 4);
  assert.equal(cs.measuresMet, 1);
  assert.equal(cs.answeredCount, 2, "abstained + backfilled excluded");
  assert.equal(cs.assessedCount, 3, "only backfilled excluded from assessed");
  assert.equal(cs.totalScorePct, 50, "1 met / 2 answered");
  assert.equal(cs.strictScorePct, 25, "1 met / 4 all measures");
});
