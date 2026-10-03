import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsTenseGate,
  neutralizeTenseGate,
  validateC2,
  type FrameworkDraft,
} from "./rules.js";

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

// ---------------------------------------------------------------------------
// neutralizeTenseGate — the deterministic, idempotent, topic-agnostic
// LAST-RESORT applied by the auto-repair loop (C2b) when the LLM fails to strip
// tense-gating phrasing. Mirrors the C7b ensureCountableCoverageTitle pattern.
// HARD GUARANTEE: containsTenseGate(neutralizeTenseGate(x)) === undefined, and
// a second application is a no-op (idempotent).
// ---------------------------------------------------------------------------

test("neutralizeTenseGate: strips an explicit present-tense requirement and converges", () => {
  const input =
    "Yes only if the quote uses a present-tense description of the policy.";
  assert.ok(containsTenseGate(input), "fixture must actually trip the gate");
  const out = neutralizeTenseGate(input);
  assert.equal(
    containsTenseGate(out),
    undefined,
    "neutralized text must no longer trip the tense gate",
  );
  assert.match(out, /in force or adopted and still in effect/i,
    "canonical in-effect clause must be present");
});

test("neutralizeTenseGate: strips a completed/past-action exclusion and converges", () => {
  const input =
    "Yes if the policy is in effect. Past adoption does not count; only a current statement qualifies.";
  assert.ok(containsTenseGate(input), "fixture must actually trip the gate");
  const out = neutralizeTenseGate(input);
  assert.equal(
    containsTenseGate(out),
    undefined,
    "neutralized text must no longer trip the tense gate",
  );
  // The clean leading sentence survives; the offending clause is dropped.
  assert.match(out, /Yes if the policy is in effect/i);
});

test("neutralizeTenseGate: is a no-op on tense-neutral wording", () => {
  const clean =
    "Yes if the entity has adopted or approved the policy in any tense; " +
    "'the Board approved X in March 2024' satisfies the gate.";
  assert.equal(containsTenseGate(clean), undefined, "fixture must be clean");
  assert.equal(
    neutralizeTenseGate(clean),
    clean,
    "a clean field must be returned byte-for-byte unchanged",
  );
});

test("neutralizeTenseGate: is a no-op on empty/falsey input", () => {
  assert.equal(neutralizeTenseGate(""), "");
});

test("neutralizeTenseGate: is idempotent (double application === single)", () => {
  const input = "Must be written in the present tense to count.";
  const once = neutralizeTenseGate(input);
  const twice = neutralizeTenseGate(once);
  assert.equal(twice, once, "re-applying the neutraliser must change nothing");
  assert.equal(containsTenseGate(twice), undefined);
});
