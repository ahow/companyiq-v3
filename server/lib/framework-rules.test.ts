import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateApplicability,
  evaluateCoverage,
  evidenceWithinReportingPeriod,
  documentInEntityScope,
} from "./framework-rules.ts";

// ── 2.1 applicability ────────────────────────────────────────────────────────
test("2.1 no rule / always → applicable (default preserved)", () => {
  assert.equal(evaluateApplicability(null, []).applicable, true);
  assert.equal(evaluateApplicability({ mode: "always" }, []).applicable, true);
});

test("2.1 if_material requiresAny gates on profile facts", () => {
  const rule = { mode: "if_material", requiresAny: ["long_lived_assets", "material_facility_footprint"] };
  assert.equal(evaluateApplicability(rule, ["long_lived_assets"]).applicable, true);
  const neg = evaluateApplicability(rule, ["something_else"]);
  assert.equal(neg.applicable, false);
  assert.match(neg.rationale, /not applicable/);
});

test("2.1 requiresAll must all be present", () => {
  const rule = { mode: "if_material", requiresAll: ["a", "b"] };
  assert.equal(evaluateApplicability(rule, ["a"]).applicable, false);
  assert.equal(evaluateApplicability(rule, ["a", "b"]).applicable, true);
});

// ── 2.2 coverage ─────────────────────────────────────────────────────────────
test("2.2 undisclosed / vague denominator cannot pass", () => {
  const rule = { defaultThreshold: 0.5, doesNotCount: ["across our operations", "company-wide"] };
  const r = evaluateCoverage(rule, [], "We manage climate risk across our operations.");
  assert.equal(r.covered, false);
  assert.equal(r.disclosedFraction, null);
});

test("2.2 explicit fraction above threshold passes; below fails", () => {
  const rule = { defaultThreshold: 0.5 };
  assert.equal(evaluateCoverage(rule, [], "310 of 356 facilities assessed").covered, true);
  assert.equal(evaluateCoverage(rule, [], "82% of asset value").covered, true);
  assert.equal(evaluateCoverage(rule, [], "40% of sites").covered, false);
});

test("2.2 whitelist phrase counts as disclosed denominator", () => {
  const r = evaluateCoverage({ defaultThreshold: 0.9 }, ["all 14 material plants"], "We assessed all 14 material plants.");
  assert.equal(r.covered, true);
  assert.equal(r.matchedPhrase, "all 14 material plants");
});

// ── 2.3 reporting period ─────────────────────────────────────────────────────
test("2.3 no window → every date qualifies (default preserved)", () => {
  assert.equal(evidenceWithinReportingPeriod(null, undefined), true);
  assert.equal(evidenceWithinReportingPeriod({}, "1990-01-01"), true);
});

test("2.3 start/end window enforced", () => {
  const p = { start: "2023-01-01", end: "2025-12-31" };
  assert.equal(evidenceWithinReportingPeriod(p, "2024-06-01"), true);
  assert.equal(evidenceWithinReportingPeriod(p, "2022-06-01"), false);
  assert.equal(evidenceWithinReportingPeriod(p, "2026-06-01"), false);
});

test("2.3 maxAgeMonths rolling window + unknown date fails closed", () => {
  const asOf = new Date("2026-01-01T00:00:00Z");
  const p = { maxAgeMonths: 24 };
  assert.equal(evidenceWithinReportingPeriod(p, "2025-01-01", asOf), true);
  assert.equal(evidenceWithinReportingPeriod(p, "2023-06-01", asOf), false);
  assert.equal(evidenceWithinReportingPeriod(p, null, asOf), false);
});

// ── 2.4 entity scope ─────────────────────────────────────────────────────────
test("2.4 no scope data / non-group → in scope (default preserved)", () => {
  assert.equal(documentInEntityScope(null, { url: "https://x.com/a" }).inScope, true);
  assert.equal(documentInEntityScope({ entityType: "subsidiary" }, { url: "https://x.com/a" }).inScope, true);
});

test("2.4 group: subsidiary solo doc excluded unless consolidated", () => {
  const ctx = { entityType: "group", trustedDomains: ["parent.com"], subsidiaryDomains: ["sub.com"] };
  assert.equal(documentInEntityScope(ctx, { url: "https://parent.com/ar" }).inScope, true);
  assert.equal(documentInEntityScope(ctx, { url: "https://sub.com/local" }).inScope, false);
  assert.equal(documentInEntityScope(ctx, { url: "https://sub.com/local", consolidated: true }).inScope, true);
});
