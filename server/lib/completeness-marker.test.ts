/**
 * Unit tests for the PURE completeness assessment logic (no DB).
 *
 * Focus: the materiality gate on `budgetExceeded` and the Tier 1 / Tier 2 split
 * that keeps the re-run core defensible. Fixtures mirror the three reference
 * companies validated against the live prod DB (fw21, workspace 3):
 *   - 3M  (#815): budgetExceeded, fetchRatio 0.96, deadPrimary, 0 first-party docs
 *   - AAC (#816): budgetExceeded, fetchRatio 0.94, 23 first-party docs, no unretrieved FP
 *   - ACS (#820): fetchRatio 0.60, deadPrimary, 17 first-party docs (genuinely truncated)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCompleteness,
  resolveThresholds,
  type CompanyCompletenessRow,
} from "./completeness-marker.js";

const T = resolveThresholds(); // fetchRatioThreshold 0.7, budgetMaterialFetchRatio 0.9

function row(over: Partial<CompanyCompletenessRow>): CompanyCompletenessRow {
  return {
    companyId: 1,
    companyName: "Test",
    diagnostics: {},
    firstPartyDocCount: 5,
    unretrievedFirstPartyCount: 0,
    jobFailed: false,
    ...over,
  };
}

test("complete company: no deficit, tier 0, no re-run", () => {
  const a = assessCompleteness(
    row({ diagnostics: { fetchCoverage: { fetchRatio: 0.98 }, coverage: { coverageLevel: "full" } } }),
    T,
  );
  assert.equal(a.needsRerun, false);
  assert.equal(a.tier, 0);
  assert.deepEqual(a.reasons, []);
});

test("3M: zero first-party + dead primary + budget material => Tier 1", () => {
  const a = assessCompleteness(
    row({
      companyId: 815,
      firstPartyDocCount: 0,
      unretrievedFirstPartyCount: 0,
      diagnostics: {
        fetchCoverage: { budgetExceeded: true, fetchRatio: 0.96, deadPrimaryFiling: true },
        coverage: { coverageLevel: "full" },
      },
    }),
    T,
  );
  assert.equal(a.needsRerun, true);
  assert.equal(a.tier, 1);
  assert.ok(a.reasons.includes("zero_first_party_docs"));
  assert.ok(a.reasons.includes("dead_primary_filing"));
  // budget is material here only because fetchRatio>=0.9 but other Tier 1 signals carry it;
  // the budget signal itself is marginal (0.96, no unretrieved FP) — proving the gate works.
  assert.ok(a.reasons.includes("budget_exceeded_marginal"));
});

test("AAC: budget overrun but 94% fetched, no unretrieved first-party => Tier 2 (marginal)", () => {
  const a = assessCompleteness(
    row({
      companyId: 816,
      firstPartyDocCount: 23,
      unretrievedFirstPartyCount: 0,
      diagnostics: {
        fetchCoverage: { budgetExceeded: true, fetchRatio: 0.94, deadPrimaryFiling: false },
        coverage: { coverageLevel: "adequate" },
      },
    }),
    T,
  );
  assert.equal(a.needsRerun, true);
  assert.equal(a.tier, 2, "marginal budget overrun must not inflate the Tier 1 core");
  assert.deepEqual(a.reasons, ["budget_exceeded_marginal"]);
});

test("ACS: fetchRatio 0.60 + dead primary => Tier 1 (genuinely truncated)", () => {
  const a = assessCompleteness(
    row({
      companyId: 820,
      firstPartyDocCount: 17,
      unretrievedFirstPartyCount: 10,
      diagnostics: {
        fetchCoverage: { budgetExceeded: false, fetchRatio: 0.6, deadPrimaryFiling: true },
        coverage: { coverageLevel: "adequate" },
      },
    }),
    T,
  );
  assert.equal(a.needsRerun, true);
  assert.equal(a.tier, 1);
  assert.ok(a.reasons.includes("low_fetch_ratio"));
  assert.ok(a.reasons.includes("dead_primary_filing"));
});

test("budgetExceeded with unretrieved first-party docs => material (Tier 1)", () => {
  const a = assessCompleteness(
    row({
      unretrievedFirstPartyCount: 2,
      diagnostics: { fetchCoverage: { budgetExceeded: true, fetchRatio: 0.97 } },
    }),
    T,
  );
  assert.equal(a.tier, 1);
  assert.ok(a.reasons.includes("budget_exceeded_material"));
});

test("budgetExceeded with low fetchRatio (<0.9) and no unretrieved FP => material (Tier 1)", () => {
  const a = assessCompleteness(
    row({
      unretrievedFirstPartyCount: 0,
      firstPartyDocCount: 8,
      diagnostics: { fetchCoverage: { budgetExceeded: true, fetchRatio: 0.85 } },
    }),
    T,
  );
  assert.equal(a.tier, 1);
  assert.ok(a.reasons.includes("budget_exceeded_material"));
});

test("sole marginal budget overrun => Tier 2, never Tier 1", () => {
  const a = assessCompleteness(
    row({
      unretrievedFirstPartyCount: 0,
      firstPartyDocCount: 12,
      diagnostics: { fetchCoverage: { budgetExceeded: true, fetchRatio: 0.95 }, coverage: { coverageLevel: "full" } },
    }),
    T,
  );
  assert.equal(a.tier, 2);
  assert.deepEqual(a.reasons, ["budget_exceeded_marginal"]);
});

test("failed job alone => Tier 1, category failed", () => {
  const a = assessCompleteness(row({ jobFailed: true, diagnostics: { fetchCoverage: { fetchRatio: 0.99 } } }), T);
  assert.equal(a.tier, 1);
  assert.equal(a.category, "failed");
  assert.deepEqual(a.reasons, ["failed_job"]);
});

test("fetchRatio stored as string is parsed", () => {
  const a = assessCompleteness(
    row({ diagnostics: { fetchCoverage: { fetchRatio: "0.5" } } }),
    T,
  );
  assert.ok(a.reasons.includes("low_fetch_ratio"));
  assert.equal(a.tier, 1);
});

test("custom budgetMaterialFetchRatio threshold is honored", () => {
  // Lower the material bar to 0.8: a 0.85 budget overrun is now marginal.
  const a = assessCompleteness(
    row({ unretrievedFirstPartyCount: 0, diagnostics: { fetchCoverage: { budgetExceeded: true, fetchRatio: 0.85 } } }),
    resolveThresholds({ budgetMaterialFetchRatio: 0.8 }),
  );
  assert.ok(a.reasons.includes("budget_exceeded_marginal"));
});
