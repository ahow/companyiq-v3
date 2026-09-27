// decision-trace tests (pure, DB-free) — WS-B (P1) per-decision traceability.
// Run: DATABASE_URL=dummy npx tsx --test server/lib/framework-v2/reliability/decision-trace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDecisionTrace,
  computeFrameworkContentHash,
} from "./decision-trace.js";
import type { CanonicalRuleTrace } from "./canonical-rule.js";

// A representative, fully-bound canonical rule trace (substantive provenance).
function substantiveTrace(overrides: Partial<CanonicalRuleTrace> = {}): CanonicalRuleTrace {
  return {
    ruleId: "rule:1.1",
    ruleVersion: 1,
    sourceField: "substantiveDefinition",
    provenance: "substantive",
    flaggedForReview: false,
    clausesUsed: ["A named strategy is disclosed", "with substantive content"],
    finalDecisionBasis: "Yes-bar governed by substantiveDefinition (provenance: substantive).",
    frameworkHash: "abc123measurehash",
    ...overrides,
  };
}

// ── computeFrameworkContentHash ────────────────────────────────────────────────

test("computeFrameworkContentHash is deterministic for identical inputs", () => {
  const fw = { id: 13, version: 2, topicTerm: "AI governance", topicSynonyms: ["artificial intelligence"] };
  const measures = [
    { measureId: "1.1", substantiveDefinition: "x", scoringGuidance: "y" },
    { measureId: "1.2", substantiveDefinition: "z" },
  ];
  const a = computeFrameworkContentHash(fw, measures);
  const b = computeFrameworkContentHash(fw, measures);
  assert.equal(a, b, "same framework + measures ⇒ same hash");
  assert.equal(a.length, 32, "hash is 32 hex chars");
});

test("computeFrameworkContentHash is order-sensitive (a reordered set is a different executed framework)", () => {
  const fw = { id: 13, version: 2, topicTerm: "AI governance", topicSynonyms: [] };
  const m1 = { measureId: "1.1", substantiveDefinition: "x" };
  const m2 = { measureId: "1.2", substantiveDefinition: "z" };
  const forward = computeFrameworkContentHash(fw, [m1, m2]);
  const reversed = computeFrameworkContentHash(fw, [m2, m1]);
  assert.notEqual(forward, reversed, "measure order changes the framework hash");
});

test("computeFrameworkContentHash changes when a measure's decision-relevant content changes", () => {
  const fw = { id: 13, version: 1, topicTerm: "t", topicSynonyms: [] };
  const before = computeFrameworkContentHash(fw, [{ measureId: "1.1", substantiveDefinition: "old" }]);
  const after = computeFrameworkContentHash(fw, [{ measureId: "1.1", substantiveDefinition: "new" }]);
  assert.notEqual(before, after, "editing substantiveDefinition moves the hash");
});

// ── buildDecisionTrace: happy path ─────────────────────────────────────────────

test("a fully-bound positive decision produces a pass record with bound evidence + clauses", () => {
  const trace = buildDecisionTrace({
    companyId: 42,
    measureId: "1.1",
    verdict: "Yes",
    quotes: [
      { text: "The Board approved the AI strategy in 2024.", source: "Annual Report", sourceUrl: "https://x/ar.pdf", page: 12 },
    ],
    canonicalRuleTrace: substantiveTrace(),
    runId: 777,
    frameworkId: 13,
    frameworkVersion: 2,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.schemaVersion, 1);
  assert.equal(trace.runId, 777);
  assert.equal(trace.validation.status, "pass");
  assert.equal(trace.validation.flaggedForReview, false);
  assert.equal(trace.diagnostics.length, 0, "fully-bound decision has no diagnostics");
  assert.equal(trace.evidencePassages.length, 1);
  assert.equal(trace.evidencePassages[0].page, 12);
  assert.deepEqual(trace.evidenceBoundToClauses, substantiveTrace().clausesUsed);
  assert.equal(trace.canonicalRule?.ruleId, "rule:1.1");
  assert.equal(trace.fallbackActivated, false);
});

// ── buildDecisionTrace: fail-loud paths ────────────────────────────────────────

test("FAIL-LOUD: a decision with no canonical rule is surfaced (status fail), never silently blank", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "9.9",
    verdict: "Yes",
    quotes: [{ text: "some evidence", source: "Doc" }],
    canonicalRuleTrace: null,
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.canonicalRule, null);
  assert.equal(trace.validation.status, "fail");
  assert.ok(trace.diagnostics.length >= 1, "diagnostics record the missing rule");
  assert.ok(/no canonical rule/i.test(trace.diagnostics.join(" ")));
});

test("FAIL-LOUD: a positive verdict with no bound evidence is surfaced (status fail)", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "1.1",
    verdict: "Yes",
    quotes: [], // no evidence
    canonicalRuleTrace: substantiveTrace(),
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.validation.status, "fail");
  assert.ok(/no bound evidence/i.test(trace.diagnostics.join(" ")));
});

test("diagnostic sidecar quotes (diag://) are NOT counted as bound evidence", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "1.1",
    verdict: "Yes",
    quotes: [
      { text: "retrieval diagnostic payload", source: "retrieval", sourceUrl: "diag://retrieval-v1" },
      { text: "evidence gate payload", source: "evidence-gate", sourceUrl: "diag://evidence-gate-v1" },
    ],
    canonicalRuleTrace: substantiveTrace(),
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.evidencePassages.length, 0, "diag:// quotes are excluded");
  // Positive verdict + only diagnostic quotes ⇒ still fail-loud (no real evidence).
  assert.equal(trace.validation.status, "fail");
});

// ── buildDecisionTrace: three-valued status ────────────────────────────────────

test("a flagged-for-review rule yields status 'unknown' (not pass, not fail)", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "1.1",
    verdict: "Yes",
    quotes: [{ text: "evidence", source: "Doc" }],
    canonicalRuleTrace: substantiveTrace({ flaggedForReview: true, provenance: "fallback-derived", sourceField: "fallbackYesCriterion" }),
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.validation.status, "unknown");
  assert.equal(trace.validation.flaggedForReview, true);
  assert.equal(trace.fallbackActivated, true, "fallback-derived provenance activates the fallback flag");
  assert.ok(trace.fallbackReason && trace.fallbackReason.length > 0, "fallback reason is populated");
});

test("an indeterminate verdict with a bound rule yields status 'unknown'", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "1.1",
    verdict: "Insufficient evidence",
    quotes: [], // negative/indeterminate verdicts do not require bound evidence
    canonicalRuleTrace: substantiveTrace(),
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.validation.status, "unknown");
  assert.equal(trace.diagnostics.length, 0, "an indeterminate verdict without evidence is not a fail");
});

test("a negative (No) verdict without evidence is a clean pass (no positive-evidence requirement)", () => {
  const trace = buildDecisionTrace({
    companyId: 1,
    measureId: "1.1",
    verdict: "No",
    quotes: [],
    canonicalRuleTrace: substantiveTrace(),
    frameworkId: 13,
    frameworkHash: "fwhash",
  });
  assert.equal(trace.validation.status, "pass");
  assert.equal(trace.diagnostics.length, 0);
});
