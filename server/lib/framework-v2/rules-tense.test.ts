import { test } from "node:test";
import assert from "node:assert/strict";
import { containsTenseGate, validateC2, type FrameworkDraft } from "./rules.js";

// Issue 2 — Gate on in-effect-vs-aspiration, NEVER on grammatical tense.
//
// A Yes-gate that REQUIRES present tense (or EXCLUDES a completed/past adoption)
// wrongly drops a legitimate DATED disclosure ("The Board approved our Strategy
// in March 2024"). containsTenseGate detects that family; validateC2 now scans
// the Yes-gate (fallback_yes_criterion + scoringGuidance) — historically it only
// scanned the exclusion field. Topic-agnostic: grammatical/temporal words only.

function fw(measures: FrameworkDraft["measures"]): FrameworkDraft {
  return { name: "Test FW", topicTerm: "test-topic", measures } as FrameworkDraft;
}

// A substantively-valid exclusion so the ONLY variable under test is the Yes-gate.
const CLEAN_EXCLUSION =
  "Generic environmental statements without specific programmes or targets; " +
  "third-party industry initiatives attributed to others.";

test("containsTenseGate: flags an explicit present-tense requirement", () => {
  assert.ok(containsTenseGate("The Yes-gate requires a present-tense deployment verb."));
  assert.ok(containsTenseGate("Must be written in the present tense to count."));
});

test("containsTenseGate: flags a completed/past-action exclusion", () => {
  assert.ok(
    containsTenseGate(
      "Past adoption does not count; only a current statement qualifies.",
    ),
  );
});

test("containsTenseGate: tense-neutral in-effect wording is clean", () => {
  assert.equal(
    containsTenseGate(
      "Yes if the entity has adopted or approved the policy in any tense; " +
        "a dated completed adoption such as 'approved in March 2024' qualifies.",
    ),
    undefined,
  );
});

test("validateC2: a tense-gating fallback_yes_criterion is a C2 error", () => {
  const r = validateC2(
    fw([
      {
        measureId: "1.1",
        title: "Does the entity disclose a policy on X?",
        whatDoesNotConstituteEvidence: CLEAN_EXCLUSION,
        fallback_yes_criterion:
          "Yes only if the quote uses a present-tense description of the policy.",
      } as any,
    ]),
  );
  const tenseErr = r.violations.find(
    (v) => v.rule === "C2" && /gates on tense/i.test(v.message),
  );
  assert.ok(tenseErr, "expected a C2 tense-gate error");
  assert.equal(tenseErr!.severity, "error");
});

test("validateC2: a dated/any-tense adoption gate produces NO tense error", () => {
  const r = validateC2(
    fw([
      {
        measureId: "1.1",
        title: "Does the entity disclose a policy on X?",
        whatDoesNotConstituteEvidence: CLEAN_EXCLUSION,
        fallback_yes_criterion:
          "Yes if the entity has adopted or approved the policy (any tense); " +
          "'the Board approved X in March 2024' satisfies the gate.",
      } as any,
    ]),
  );
  const tenseErr = r.violations.find(
    (v) => v.rule === "C2" && /gates on tense/i.test(v.message),
  );
  assert.equal(tenseErr, undefined, "clean any-tense gate must not raise a tense error");
});

test("validateC2: the exclusion field still catches forward-looking disqualifiers", () => {
  const r = validateC2(
    fw([
      {
        measureId: "1.1",
        title: "T",
        whatDoesNotConstituteEvidence:
          "Forward-looking commitments do not qualify; " + CLEAN_EXCLUSION,
        fallback_yes_criterion: "Yes if the policy is in effect.",
      } as any,
    ]),
  );
  assert.ok(
    r.violations.some((v) => v.rule === "C2" && v.severity === "error"),
    "exclusion-field tense/aspiration guard must remain active",
  );
});
