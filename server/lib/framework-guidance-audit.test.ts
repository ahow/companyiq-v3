/**
 * Tests for the generic framework scoring_guidance audit (Change B) and the
 * rubric-tightening structured-guidance extractor + audit (A1/A3/A4).
 * node:test — run with:  npx tsx --test server/lib/framework-guidance-audit.test.ts
 *
 * Nothing here references a specific measure, company, or framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGuidance,
  auditFrameworkGuidance,
  extractGuidanceObject,
  stripStructuredGuidanceBlock,
} from "./framework-guidance-audit.js";

// ─── classifyGuidance (Change B — unchanged behaviour) ───────────────────────

test("plain prose scoring_guidance is flagged as non_json_prose", () => {
  const c = classifyGuidance("Award Yes when the company clearly discloses a policy.");
  assert.equal(c.ok, false);
  assert.equal(c.issue, "non_json_prose");
});

test("valid JSON object with expected buckets is OK", () => {
  const c = classifyGuidance(JSON.stringify({ yes: "...", no: "...", partial: "..." }));
  assert.equal(c.ok, true);
  assert.equal(c.issue, undefined);
});

test("JSON array is flagged as not_object", () => {
  const c = classifyGuidance(JSON.stringify(["yes", "no"]));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "not_object");
});

test("bare JSON string is flagged as not_object", () => {
  const c = classifyGuidance(JSON.stringify("just a string"));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "not_object");
});

test("JSON object without yes/no/partial keys is flagged as missing_expected_keys", () => {
  const c = classifyGuidance(JSON.stringify({ high: "...", low: "..." }));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "missing_expected_keys");
});

test("null / empty guidance is not a defect", () => {
  assert.equal(classifyGuidance(null).ok, true);
  assert.equal(classifyGuidance(undefined).ok, true);
  assert.equal(classifyGuidance("").ok, true);
  assert.equal(classifyGuidance("   ").ok, true);
});

// ─── extractGuidanceObject (tolerant, three shapes) ──────────────────────────

test("extractGuidanceObject parses a pure JSON object", () => {
  const o = extractGuidanceObject(JSON.stringify({ yes: "a", qualifyingInstance: "x" }));
  assert.equal(o?.qualifyingInstance, "x");
});

test("extractGuidanceObject parses a ```json fenced block appended to prose", () => {
  const raw = "Score Yes if disclosed.\n\n```json\n{ \"qualifyingInstance\": \"named policy\" }\n```";
  const o = extractGuidanceObject(raw);
  assert.equal(o?.qualifyingInstance, "named policy");
});

test("extractGuidanceObject parses a trailing balanced {...} blob", () => {
  const raw = "Some prose guidance here. { \"anchors\": { \"yes\": \"y\", \"no\": \"n\" } }";
  const o = extractGuidanceObject(raw);
  assert.equal(o?.anchors?.yes, "y");
});

test("extractGuidanceObject returns null for plain prose / empty / null", () => {
  assert.equal(extractGuidanceObject("just prose, no json"), null);
  assert.equal(extractGuidanceObject(""), null);
  assert.equal(extractGuidanceObject(null), null);
  assert.equal(extractGuidanceObject(JSON.stringify([1, 2, 3])), null); // array is not an object
});

// ─── stripStructuredGuidanceBlock ────────────────────────────────────────────

test("stripStructuredGuidanceBlock removes a fenced json block, keeps prose", () => {
  const raw = "Human readable guidance.\n\n```json\n{ \"qualifyingInstance\": \"x\" }\n```";
  assert.equal(stripStructuredGuidanceBlock(raw), "Human readable guidance.");
});

test("stripStructuredGuidanceBlock removes a trailing bare object, keeps prose", () => {
  const raw = "Human readable guidance. { \"qualifyingInstance\": \"x\" }";
  assert.equal(stripStructuredGuidanceBlock(raw), "Human readable guidance.");
});

test("stripStructuredGuidanceBlock leaves prose-only strings unchanged", () => {
  assert.equal(stripStructuredGuidanceBlock("Just prose."), "Just prose.");
  assert.equal(stripStructuredGuidanceBlock(null), "");
});

// ─── auditFrameworkGuidance (Change B + A4 structured checks) ─────────────────

// A helper for a fully rubric-tightened structured guidance object.
function fullStructured() {
  return JSON.stringify({
    yes: "a",
    no: "b",
    partial: "c",
    qualifyingInstance: "A specifically named policy/programme with a dated commitment.",
    disqualifiers: ["Generic aspiration", "Forward-looking intent without a named instance"],
    anchors: { yes: "Company X published policy Y in 2024 (verbatim quote present).", no: "Company only states it 'aims to' act." },
    yesRequiresQuote: "Yes only when a verbatim quote contains the named qualifying instance.",
  });
}

test("a fully rubric-tightened measure produces NO findings", () => {
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Complete", scoringGuidance: fullStructured() },
  ]);
  assert.deepEqual(findings, []);
});

test("empty / null guidance is not flagged by the structured audit", () => {
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Empty", scoringGuidance: null },
    { measureId: "m2", title: "Blank", scoringGuidance: "   " },
  ]);
  assert.deepEqual(findings, []);
});

test("prose-only guidance is flagged non_json_prose AND missing_structured_guidance", () => {
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Prose", scoringGuidance: "Score Yes if disclosed." },
  ]);
  const issues = findings.map((f) => f.issue).sort();
  assert.deepEqual(issues, ["missing_structured_guidance", "non_json_prose"]);
});

test("a JSON array is flagged not_object AND missing_structured_guidance", () => {
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Array", scoringGuidance: "[1,2,3]" },
  ]);
  const issues = findings.map((f) => f.issue).sort();
  assert.deepEqual(issues, ["missing_structured_guidance", "not_object"]);
});

test("a structured object missing each rubric field is flagged per missing field", () => {
  // Has yes/no/partial (so classifyGuidance is happy) but none of the new fields.
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Legacy", scoringGuidance: JSON.stringify({ yes: "a", no: "b", partial: "c" }) },
  ]);
  const issues = findings.map((f) => f.issue).sort();
  assert.deepEqual(issues, [
    "missing_anchors",
    "missing_disqualifiers",
    "missing_qualifying_instance",
    "missing_yes_requires_quote",
  ]);
});

test("a structured object missing ONLY anchors is flagged only for anchors", () => {
  const obj: any = JSON.parse(fullStructured());
  delete obj.anchors;
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "NoAnchors", scoringGuidance: JSON.stringify(obj) },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, "missing_anchors");
});

test("anchors missing one side (no) is flagged as missing_anchors", () => {
  const obj: any = JSON.parse(fullStructured());
  obj.anchors = { yes: "only a yes anchor" };
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "HalfAnchors", scoringGuidance: JSON.stringify(obj) },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, "missing_anchors");
});

test("structured guidance delivered as a ```json fence appended to prose passes the audit", () => {
  const obj = JSON.parse(fullStructured());
  const raw = "Human-readable prose guidance.\n\n```json\n" + JSON.stringify(obj) + "\n```";
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "V2Fence", scoringGuidance: raw },
  ]);
  assert.deepEqual(findings, []);
});
