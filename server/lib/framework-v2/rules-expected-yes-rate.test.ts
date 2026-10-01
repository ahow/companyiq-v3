import { test } from "node:test";
import assert from "node:assert/strict";
import { validateC9, type FrameworkDraft } from "./rules.js";

// Issue 4 — an EXTREME expected_yes_rate (<0.10 or >0.80) must carry a
// base-rate justification (expected_yes_rate_justification, >= 40 chars trimmed).
// Mid-range rates (0.10-0.80 inclusive) need none. Topic-agnostic: this asserts
// presence/length only, never subject-matter content.

function fw(measures: FrameworkDraft["measures"]): FrameworkDraft {
  return { name: "Test FW", topicTerm: "test-topic", measures } as FrameworkDraft;
}

// Helper: C9 ERROR violations attributable to a specific measure (ignores the
// framework-level aggregate too-narrow/too-broad WARNINGS, which are advisory
// and fire on single-measure fixtures by construction).
function c9Errors(fwDraft: FrameworkDraft, measureId: string) {
  return validateC9(fwDraft).violations.filter(
    (v) => v.rule === "C9" && v.severity === "error" && v.measureId === measureId,
  );
}

const LONG_JUST =
  "Few entities disclose an externally audited absolute figure, so a low base rate is expected here.";

test("C9: extreme low rate (0.05) with NO justification is an error", () => {
  const errs = c9Errors(
    fw([{ measureId: "m1", title: "t", expected_yes_rate: 0.05 } as any]),
    "m1",
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /extreme/);
});

test("C9: extreme high rate (0.85) with NO justification is an error", () => {
  const errs = c9Errors(
    fw([{ measureId: "m1", title: "t", expected_yes_rate: 0.85 } as any]),
    "m1",
  );
  assert.equal(errs.length, 1);
});

test("C9: extreme rate WITH a >=40-char justification is clean", () => {
  const errs = c9Errors(
    fw([
      {
        measureId: "m1",
        title: "t",
        expected_yes_rate: 0.05,
        expected_yes_rate_justification: LONG_JUST,
      } as any,
    ]),
    "m1",
  );
  assert.equal(errs.length, 0);
});

test("C9: extreme rate with a TOO-SHORT (<40 char) justification is an error", () => {
  const errs = c9Errors(
    fw([
      {
        measureId: "m1",
        title: "t",
        expected_yes_rate: 0.05,
        expected_yes_rate_justification: "rare disclosure",
      } as any,
    ]),
    "m1",
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /too short/);
});

test("C9: mid-range rate (0.35) needs NO justification", () => {
  const errs = c9Errors(
    fw([{ measureId: "m1", title: "t", expected_yes_rate: 0.35 } as any]),
    "m1",
  );
  assert.equal(errs.length, 0);
});

test("C9: boundary rates 0.10 and 0.80 are NOT extreme (no justification required)", () => {
  assert.equal(
    c9Errors(fw([{ measureId: "m1", title: "t", expected_yes_rate: 0.10 } as any]), "m1").length,
    0,
  );
  assert.equal(
    c9Errors(fw([{ measureId: "m2", title: "t", expected_yes_rate: 0.80 } as any]), "m2").length,
    0,
  );
});
