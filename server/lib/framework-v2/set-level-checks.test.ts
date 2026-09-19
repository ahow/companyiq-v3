/**
 * Focused unit tests for the reviewer-criteria builder upgrade (steps 1–4).
 *
 * Covers the three behaviours the implementation spec calls out for verification:
 *   1. The deterministic synonym-pollution filter rejects function-word n-grams
 *      ("the board", "operations and", "and other") and keeps genuine multi-word
 *      terms ("algorithmic accountability").
 *   2. The new set-level checks (overlap, numbering continuity, empty retrieval
 *      guards) emit ONLY `info`-severity violations — never error/warning — so
 *      they are excluded from the repair trigger and the repairMeasuresTargeted
 *      grouping and can never grow the repair payload.
 *   3. The deterministic query-template sanitiser parameterises hardcoded years
 *      and drops junk-verb-only templates, again with no violation emitted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateSetLevel,
  validateAll,
  type FrameworkDraft,
  type MeasureDraft,
} from "./rules.js";
import {
  isPollutedSynonymPhrase,
  isPollutedSynonymTokens,
} from "./test-drive.js";
import { sanitizeSearchTemplates } from "./query-template-hygiene.js";

// ─── Step 2a: synonym-pollution filter ──────────────────────────────────────

test("isPollutedSynonymPhrase rejects leading-stopword phrases", () => {
  assert.equal(isPollutedSynonymPhrase("the board"), true);
});

test("isPollutedSynonymPhrase rejects trailing-stopword phrases", () => {
  assert.equal(isPollutedSynonymPhrase("operations and"), true);
});

test("isPollutedSynonymPhrase rejects all-stopword phrases", () => {
  assert.equal(isPollutedSynonymPhrase("and other"), true); // "other" is not a stopword, but leading "and" is
  assert.equal(isPollutedSynonymPhrase("the and of"), true);
});

test("isPollutedSynonymPhrase rejects empty / whitespace phrases", () => {
  assert.equal(isPollutedSynonymPhrase(""), true);
  assert.equal(isPollutedSynonymPhrase("   "), true);
});

test("isPollutedSynonymPhrase keeps genuine multi-word terms", () => {
  assert.equal(isPollutedSynonymPhrase("algorithmic accountability"), false);
  assert.equal(isPollutedSynonymPhrase("modern slavery"), false);
  assert.equal(isPollutedSynonymPhrase("biodiversity"), false);
});

test("isPollutedSynonymTokens matches the phrase wrapper over pre-tokenised input", () => {
  assert.equal(isPollutedSynonymTokens(["the", "board"]), true);
  assert.equal(isPollutedSynonymTokens(["algorithmic", "accountability"]), false);
  assert.equal(isPollutedSynonymTokens([]), true);
});

// ─── Step 2c/2d/2e: set-level checks emit info only ──────────────────────────

function measure(overrides: Partial<MeasureDraft> & { measureId: string }): MeasureDraft {
  return { title: `Discloses ${overrides.measureId}`, ...overrides };
}

/**
 * Framework engineered to trip every set-level check at once:
 *   - overlap: measures 1.1 and 1.3 both cite the anchor standard "TCFD" and
 *     share an identical positive-example anchor quote.
 *   - numbering: category 1 has 1.1 and 1.3 but no 1.2 (gap).
 *   - empty-guards: negativeKeywords / antiInferenceRules absent.
 */
function trippingFramework(): FrameworkDraft {
  const sharedQuote =
    "Our board reviews the TCFD-aligned climate transition plan every year in detail.";
  return {
    name: "Climate transition",
    topicTerm: "climate transition",
    anchorFrameworks: [{ name: "TCFD" }],
    measures: [
      measure({
        measureId: "1.1-oversight",
        substantive_definition: "Tests board oversight, aligned to the TCFD framework.",
        positive_examples: [sharedQuote],
      }),
      measure({
        measureId: "1.3-strategy",
        substantive_definition: "Tests strategy disclosure, aligned to the TCFD framework.",
        positive_examples: [sharedQuote],
      }),
    ],
  };
}

test("validateSetLevel emits ONLY info-severity violations", () => {
  const result = validateSetLevel(trippingFramework());
  assert.ok(result.violations.length > 0, "expected some advisory diagnostics");
  for (const v of result.violations) {
    assert.equal(v.severity, "info", `violation ${v.rule} should be info, got ${v.severity}`);
  }
});

test("validateSetLevel flags overlap, numbering and empty-guards", () => {
  const rules = new Set(validateSetLevel(trippingFramework()).violations.map((v) => v.rule));
  assert.ok(rules.has("overlap"), "expected an overlap diagnostic");
  assert.ok(rules.has("numbering"), "expected a numbering-continuity diagnostic");
  assert.ok(rules.has("empty-guards"), "expected an empty-guards diagnostic");
});

test("validateSetLevel never fails (info does not block); passed stays true", () => {
  assert.equal(validateSetLevel(trippingFramework()).passed, true);
});

test("set-level info is excluded from the repair trigger and grouping predicates", () => {
  const violations = validateSetLevel(trippingFramework()).violations;
  // Repair TRIGGER (framework-builder-v2.ts): .some(v => v.severity === "error")
  assert.equal(violations.some((v) => v.severity === "error"), false);
  // repairMeasuresTargeted GROUPING: skips anything not error/warning
  const groupedForRepair = violations.filter(
    (v) => v.severity === "error" || v.severity === "warning",
  );
  assert.equal(groupedForRepair.length, 0, "no set-level diagnostic may enter repair");
});

test("populated retrieval guards suppress the empty-guards diagnostic", () => {
  const fw = trippingFramework();
  fw.negativeKeywords = ["general environmental policy"];
  fw.antiInferenceRules = ["an environmental policy is not a climate transition plan"];
  const rules = new Set(validateSetLevel(fw).violations.map((v) => v.rule));
  assert.equal(rules.has("empty-guards"), false);
});

test("validateAll surfaces set-level info without failing on it", () => {
  const result = validateAll(trippingFramework());
  // Any set-level info present must not be error/warning; validateAll.passed is
  // governed by error count only, so info can never flip it.
  const setLevelRules = new Set(["overlap", "numbering", "empty-guards"]);
  const setLevel = result.violations.filter((v) => setLevelRules.has(v.rule));
  assert.ok(setLevel.length > 0, "set-level checks should run inside validateAll");
  for (const v of setLevel) assert.equal(v.severity, "info");
});

// ─── Step 2b: query-template sanitiser (deterministic auto-fix) ──────────────

test("sanitizeSearchTemplates parameterises hardcoded years", () => {
  const r = sanitizeSearchTemplates(['"{company}" climate transition plan 2024']);
  assert.deepEqual(r.cleaned, ['"{company}" climate transition plan {currentYear}']);
  assert.equal(r.rewritten.length, 1);
});

test("sanitizeSearchTemplates drops junk-verb-only templates", () => {
  const r = sanitizeSearchTemplates(['"{company}" approve', '"{company}" review']);
  assert.deepEqual(r.cleaned, []);
  assert.equal(r.dropped.length, 2);
});

test("sanitizeSearchTemplates keeps genuine templates and dedups", () => {
  const r = sanitizeSearchTemplates([
    '"{company}" modern slavery due diligence',
    '"{company}" modern slavery due diligence',
    '"{company}" board oversight',
  ]);
  assert.deepEqual(r.cleaned, [
    '"{company}" modern slavery due diligence',
    '"{company}" board oversight',
  ]);
});

test("sanitizeSearchTemplates tolerates non-array / non-string input", () => {
  assert.deepEqual(sanitizeSearchTemplates(undefined).cleaned, []);
  assert.deepEqual(sanitizeSearchTemplates([42, null, "modern slavery policy"]).cleaned, [
    "modern slavery policy",
  ]);
});
