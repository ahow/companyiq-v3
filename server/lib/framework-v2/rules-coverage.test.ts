import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCoverageMeasure,
  validateC7,
  validateC11,
  type FrameworkDraft,
} from "./rules.js";

// Issue 3 — coverage measures are detected STRUCTURALLY (not by a self-declared
// flag), and must carry an EXPLICIT, countable coverage threshold (a %, an
// "N of" count, or a definite-proportion quantifier). A coverage extent decided
// by a vague degree/extent word ("broad", "comprehensive") with no such
// threshold fails C11. Topic-agnostic: scope/quantifier/extent vocabulary only.

function fw(measures: FrameworkDraft["measures"]): FrameworkDraft {
  return { name: "Test FW", topicTerm: "test-topic", measures } as FrameworkDraft;
}

test("isCoverageMeasure: a scope phrase in the title flags it as coverage-type", () => {
  assert.equal(
    isCoverageMeasure({
      measureId: "1.1",
      title: "Does the policy apply across the organisation?",
    } as any),
    true,
  );
  assert.equal(
    isCoverageMeasure({
      measureId: "1.2",
      title: "Portfolio-level emissions target",
    } as any),
    true,
  );
});

test("isCoverageMeasure: a plain single-artefact measure is NOT coverage-type", () => {
  assert.equal(
    isCoverageMeasure({
      measureId: "1.3",
      title: "Does the entity disclose a board-approved climate policy?",
    } as any),
    false,
  );
});

test("validateC7: a structurally-detected coverage measure with a vague scope phrase fails", () => {
  const r = validateC7(
    fw([
      {
        measureId: "1.1",
        // Detected as coverage via "across the"; but no countable threshold and
        // no whitelist — must fail loudly even without r3_1_exception_coverage.
        title: "Policy applies across the organisation",
      } as any,
    ]),
  );
  const errs = r.violations.filter((v) => v.rule === "C7" && v.severity === "error");
  assert.ok(errs.length >= 1, "expected C7 errors for a vague-scope coverage measure");
  assert.equal(r.passed, false);
});

test("validateC7: a coverage measure with an explicit threshold + whitelist passes", () => {
  const r = validateC7(
    fw([
      {
        measureId: "1.1",
        title: "Policy applies enterprise-wide across all operations",
        coverage_whitelist: ["across the group", "enterprise-wide", "all our operations"],
      } as any,
    ]),
  );
  const errs = r.violations.filter((v) => v.rule === "C7" && v.severity === "error");
  assert.equal(errs.length, 0);
});

test("validateC11: coverage extent decided by an extent word with no threshold fails", () => {
  const r = validateC11(
    fw([
      {
        measureId: "1.1",
        title: "Does the policy achieve broad coverage across the group?",
        fallback_yes_criterion: "Yes if a policy document is named in a verbatim quote.",
      } as any,
    ]),
  );
  const covErr = r.violations.find(
    (v) => v.rule === "C11" && /coverage measure whose coverage extent/i.test(v.message),
  );
  assert.ok(covErr, "expected a coverage-specific C11 error");
  assert.equal(covErr!.severity, "error");
});

test("validateC11: an explicit coverage threshold rescues an extent word", () => {
  const r = validateC11(
    fw([
      {
        measureId: "1.1",
        title: "Does the policy achieve broad coverage of at least 80% of all operations?",
        fallback_yes_criterion: "Yes if a policy document is named in a verbatim quote.",
      } as any,
    ]),
  );
  const covErr = r.violations.find(
    (v) => v.rule === "C11" && /coverage measure whose coverage extent/i.test(v.message),
  );
  assert.equal(covErr, undefined, "an explicit % threshold must clear the coverage C11 gate");
});
