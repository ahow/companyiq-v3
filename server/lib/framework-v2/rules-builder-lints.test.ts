import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateScoringPersonaSectorNeutral,
  validateExpectedYesRateUncalibrated,
  validateUndefinedTerms,
  validateAll,
  type FrameworkDraft,
} from "./rules.js";

// Deliverable B lints (c) sector-relative materiality persona, (d) uncalibrated
// expectedYesRate, (e) undefined bar-setting terms. All are advisory: none may
// emit `error` or set a framework invalid.

function fw(partial: Partial<FrameworkDraft>): FrameworkDraft {
  return { name: "Test FW", topicTerm: "test-topic", measures: [], ...partial } as FrameworkDraft;
}

// ─── (c) BLINT-SECTOR ────────────────────────────────────────────────────────

const SECTOR_PERSONA =
  "You are an expert climate-risk analyst. Judge the substance of actions, decisions and outcomes " +
  "against the physical-risk materiality the company plausibly faces for its sector, qualitatively.";

test("(c) flags sector-relative materiality phrasing in a cross-sector persona", () => {
  const res = validateScoringPersonaSectorNeutral(
    fw({ scoringPersona: SECTOR_PERSONA, sectorScope: "All sectors (cross-sector)" }),
  );
  const v = res.violations.find((x) => x.rule === "BLINT-SECTOR");
  assert.ok(v, "expected a BLINT-SECTOR finding");
  assert.equal(v!.severity, "warning");
  assert.match(v!.suggestion || "", /remove/i);
  assert.equal(res.passed, true, "advisory lint must never set passed=false");
});

test("(c) treats ABSENT sectorScope as cross-sector and still flags", () => {
  const res = validateScoringPersonaSectorNeutral(fw({ scoringPersona: SECTOR_PERSONA }));
  assert.ok(res.violations.some((x) => x.rule === "BLINT-SECTOR"));
});

test("(c) clean persona (no sector-relative phrasing) is not flagged", () => {
  const res = validateScoringPersonaSectorNeutral(
    fw({
      scoringPersona: "You are an expert climate-risk analyst scoring corporate disclosures against a structured framework.",
      sectorScope: "All sectors (cross-sector)",
    }),
  );
  assert.equal(res.violations.length, 0);
});

test("(c) a genuinely sector-SPECIFIC framework is not flagged", () => {
  const res = validateScoringPersonaSectorNeutral(
    fw({ scoringPersona: SECTOR_PERSONA, sectorScope: "Banking sector only" }),
  );
  assert.equal(res.violations.length, 0);
});

// ─── (d) BLINT-EYR ───────────────────────────────────────────────────────────

test("(d) flags each measure carrying an expected_yes_rate as uncalibrated (info)", () => {
  const res = validateExpectedYesRateUncalibrated(
    fw({
      measures: [
        { measureId: "m1", title: "t", expected_yes_rate: 0.4 } as any,
        { measureId: "m2", title: "t", expected_yes_rate: 0.65 } as any,
        { measureId: "m3", title: "t" } as any, // no rate → no finding
      ],
    }),
  );
  const eyr = res.violations.filter((v) => v.rule === "BLINT-EYR");
  assert.equal(eyr.length, 2);
  assert.ok(eyr.every((v) => v.severity === "info"));
  assert.deepEqual(eyr.map((v) => v.measureId).sort(), ["m1", "m2"]);
  assert.match(eyr[0].message, /uncalibrated/i);
  assert.equal(res.passed, true);
});

// ─── (e) BLINT-TERM ──────────────────────────────────────────────────────────

test("(e) flags an undefined bar-setting term used in measure text", () => {
  const res = validateUndefinedTerms(
    fw({
      measures: [
        {
          measureId: "m1",
          title: "t",
          whatConstitutesEvidence: "Evidence that the company manages its critical suppliers.",
        } as any,
      ],
    }),
  );
  const v = res.violations.find((x) => x.rule === "BLINT-TERM" && x.measureId === "m1");
  assert.ok(v, "expected a BLINT-TERM finding for m1");
  assert.equal(v!.severity, "info");
  assert.match(v!.message, /critical/i);
  assert.equal(res.passed, true);
});

test("(e) a DEFINED term is not flagged", () => {
  const res = validateUndefinedTerms(
    fw({
      measures: [
        {
          measureId: "m1",
          title: "t",
          whatConstitutesEvidence:
            "Evidence addressing critical suppliers. DEFINITION OF \"CRITICAL\": a dependency the company itself " +
            "designates as critical, or a single-source input to a named product.",
        } as any,
      ],
    }),
  );
  assert.equal(res.violations.filter((v) => v.rule === "BLINT-TERM").length, 0);
});

test("(e) term defined via 'means' connective is not flagged", () => {
  const res = validateUndefinedTerms(
    fw({
      measures: [
        {
          measureId: "m1",
          title: "t",
          substantive_definition: "A material site means one contributing over 5% of group revenue.",
        } as any,
      ],
    }),
  );
  assert.equal(res.violations.filter((v) => v.rule === "BLINT-TERM").length, 0);
});

// ─── wiring: validateAll never fails on advisory-only findings ───────────────

test("validateAll stays passed=true when only advisory builder lints fire", () => {
  const res = validateAll(
    fw({
      scoringPersona: SECTOR_PERSONA,
      sectorScope: "All sectors (cross-sector)",
      measures: [
        {
          measureId: "m1",
          title: "Critical supplier management",
          substantive_definition: "The company manages its critical suppliers.",
          definition: "Manage critical suppliers",
          expected_yes_rate: 0.4,
          fallback_yes_criterion: "A named critical supplier programme exists.",
        } as any,
      ],
    }),
  );
  assert.ok(res.violations.some((v) => v.rule === "BLINT-SECTOR"));
  assert.ok(res.violations.some((v) => v.rule === "BLINT-EYR"));
  assert.ok(res.violations.some((v) => v.rule === "BLINT-TERM"));
  // None of the three may be error severity.
  assert.equal(
    res.violations.filter((v) => ["BLINT-SECTOR", "BLINT-EYR", "BLINT-TERM"].includes(v.rule) && v.severity === "error").length,
    0,
  );
});
