/**
 * Unit tests for the STEP-2 builder_improve Goodhart / anti-homogenisation guard.
 *
 * The guard is a pure function (`applyGoodhartGuard`) tested without any network
 * call. `builderImprove` is exercised with an injected `complete` so the whole
 * pass (parse -> guard -> result) runs deterministically offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyGoodhartGuard,
  hasStructuralRootCause,
  isHomogenising,
  extractJsonObject,
  builderImprove,
  type SemanticProposal,
  type StructuralFinding,
} from "./builder-improve.js";

const findings: StructuralFinding[] = [
  { id: "bd-C4", source: "D1", rule: "C4", summary: "C4 drift" },
  { id: "ledger-c5-scoringguidance", source: "D2", rule: "C5", summary: "recurrence" },
  { id: "ga-224-TNFD", source: "D3", rule: "construction-rule", summary: "topic leak" },
];

function proposal(overrides: Partial<SemanticProposal> = {}): SemanticProposal {
  return {
    id: "sp-1",
    targetRule: "C4",
    field: "fallback",
    rationale: "Builder C4 contradicts validateC4.",
    proposedBuilderEdit: "Rewrite C4 to be conjunctive.",
    rootCauseRef: "bd-C4",
    basis: "structural-drift",
    ...overrides,
  };
}

test("guard ACCEPTS a proposal anchored to a known finding id", () => {
  const { accepted, rejected } = applyGoodhartGuard([proposal()], findings);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 0);
});

test("guard ACCEPTS a proposal anchored to a bare validator rule code", () => {
  const { accepted } = applyGoodhartGuard([proposal({ rootCauseRef: "C5" })], findings);
  assert.equal(accepted.length, 1);
});

test("guard REJECTS a proposal with no structural anchor", () => {
  const { accepted, rejected } = applyGoodhartGuard(
    [proposal({ rootCauseRef: "", basis: undefined })],
    findings,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /No structural root cause/);
});

test("guard REJECTS a self-declared reviewer-preference proposal", () => {
  const { accepted, rejected } = applyGoodhartGuard(
    [proposal({ basis: "reviewer-preference" })],
    findings,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("guard REJECTS a reviewer-preference rationale even with a valid anchor", () => {
  const { accepted, rejected } = applyGoodhartGuard(
    [proposal({ rationale: "I prefer this wording, it reads better." })],
    findings,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("guard REJECTS a homogenising edit (anti-homogenisation)", () => {
  const { accepted, rejected } = applyGoodhartGuard(
    [
      proposal({
        proposedBuilderEdit:
          "Force all frameworks to use the same measurable proxy for every topic.",
      }),
    ],
    findings,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /homogenisation/i);
});

test("hasStructuralRootCause / isHomogenising behave as documented", () => {
  const ids = new Set(findings.map((f) => f.id));
  const rules = new Set(findings.map((f) => f.rule));
  assert.equal(hasStructuralRootCause(proposal(), ids, rules), true);
  assert.equal(hasStructuralRootCause(proposal({ rootCauseRef: "nope", targetRule: "nope" }), ids, rules), false);
  assert.equal(isHomogenising(proposal({ proposedBuilderEdit: "make all frameworks identical" })), true);
  assert.equal(isHomogenising(proposal()), false);
});

test("extractJsonObject pulls the JSON object out of chatty model output", () => {
  const obj = extractJsonObject('Sure! Here it is:\n{"proposals":[]}\nHope that helps.');
  assert.deepEqual(obj, { proposals: [] });
});

test("builderImprove runs end-to-end with an injected LLM and filters via the guard", async () => {
  const fakeComplete = async () => ({
    text: JSON.stringify({
      proposals: [
        proposal({ id: "keep", rootCauseRef: "bd-C4" }),
        proposal({ id: "drop", rootCauseRef: "", basis: undefined }),
      ],
    }),
    provider: "test",
  });
  const result = await builderImprove(findings, { complete: fakeComplete });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].id, "keep");
  assert.equal(result.rejected.length, 1);
  assert.equal(result.guard.structuralRootCauseRequired, true);
  assert.equal(result.guard.antiHomogenisationApplied, true);
});

test("builderImprove is fail-safe on malformed model output (zero proposals, no throw)", async () => {
  const fakeComplete = async () => ({ text: "not json at all", provider: "test" });
  const result = await builderImprove(findings, { complete: fakeComplete });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 0);
});
