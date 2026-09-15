import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StructuredGuidance,
  STRUCTURED_GUIDANCE_FIELDS_SPEC,
  STRUCTURED_GUIDANCE_AUTHORING_BLOCK,
  STRUCTURED_GUIDANCE_REGEN_INSTRUCTION,
  STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT,
  normaliseStructuredGuidance,
  mergeStructuredIntoScoringGuidance,
} from "./structured-guidance.js";
import { extractGuidanceObject } from "../framework-guidance-audit.js";
import { auditFrameworkGuidance } from "../framework-guidance-audit.js";
import { DRAFTING_SYSTEM_PROMPT_HEAD, CHUNKED_MEASURES_SYSTEM_PROMPT } from "./intake-prompt.js";

const FIELD_NAMES = ["qualifyingInstance", "disqualifiers", "anchors", "yesRequiresQuote"];

// A full, well-shaped structured-guidance object (generic, topic-agnostic).
const full4: Partial<StructuredGuidance> = {
  qualifyingInstance: "A named, in-place programme with a dated milestone specific to this measure.",
  disqualifiers: ["Generic mention with no named instance", "Aspirational intent without an in-place programme"],
  anchors: { yes: "Names the programme and cites its launch date — qualifies.", no: "Only states an intention to act someday — fails." },
  yesRequiresQuote: "A Yes is permissible only when a verbatim quote contains the qualifyingInstance.",
};

// ─── normaliseStructuredGuidance ────────────────────────────────────────────

test("normalise: strips a Partial anchor while keeping yes/no", () => {
  const out = normaliseStructuredGuidance({
    ...full4,
    anchors: { yes: "y", no: "n", partial: "SHOULD NOT SURVIVE" },
  });
  assert.ok(out);
  assert.ok(out!.anchors);
  assert.equal((out!.anchors as any).partial, undefined);
  assert.equal(out!.anchors!.yes, "y");
  assert.equal(out!.anchors!.no, "n");
});

test("normalise: returns null when nothing usable is supplied", () => {
  assert.equal(normaliseStructuredGuidance(null), null);
  assert.equal(normaliseStructuredGuidance({}), null);
  assert.equal(normaliseStructuredGuidance({ qualifyingInstance: "   " }), null);
  assert.equal(normaliseStructuredGuidance({ disqualifiers: ["", "  "] }), null);
  assert.equal(normaliseStructuredGuidance("a string"), null);
  assert.equal(normaliseStructuredGuidance([1, 2]), null);
});

test("normalise: trims strings and drops empty array members", () => {
  const out = normaliseStructuredGuidance({
    qualifyingInstance: "  spaced  ",
    disqualifiers: ["  keep me  ", "", "   "],
    yesRequiresQuote: "  quote rule  ",
  });
  assert.ok(out);
  assert.equal(out!.qualifyingInstance, "spaced");
  assert.deepEqual(out!.disqualifiers, ["keep me"]);
  assert.equal(out!.yesRequiresQuote, "quote rule");
});

test("normalise: partial-only structured object still returns present fields", () => {
  const out = normaliseStructuredGuidance({ qualifyingInstance: "only this" });
  assert.deepEqual(out, { qualifyingInstance: "only this" });
});

// ─── mergeStructuredIntoScoringGuidance ─────────────────────────────────────

test("merge: existing pure-JSON object overlays the four fields and keeps other keys", () => {
  const existing = JSON.stringify({
    yes: "prior yes bucket",
    no: "prior no bucket",
    partial: "prior partial bucket",
    explicit_exclusions: ["keep me"],
  });
  const merged = mergeStructuredIntoScoringGuidance(existing, full4);
  const obj = JSON.parse(merged);
  // Prior non-structured keys preserved.
  assert.equal(obj.yes, "prior yes bucket");
  assert.equal(obj.no, "prior no bucket");
  assert.deepEqual(obj.explicit_exclusions, ["keep me"]);
  // Structured fields overlaid.
  assert.equal(obj.qualifyingInstance, full4.qualifyingInstance);
  assert.deepEqual(obj.disqualifiers, full4.disqualifiers);
  assert.equal(obj.yesRequiresQuote, full4.yesRequiresQuote);
  // anchors merged; NEVER a partial anchor.
  assert.equal(obj.anchors.yes, full4.anchors!.yes);
  assert.equal(obj.anchors.no, full4.anchors!.no);
  assert.equal(obj.anchors.partial, undefined);
});

test("merge: prose existing keeps prose and appends a parseable json fence", () => {
  const existing = "This is the human-readable prose scoring guidance. A Yes requires a verbatim quote.";
  const merged = mergeStructuredIntoScoringGuidance(existing, full4);
  assert.ok(merged.includes(existing));
  assert.ok(merged.includes("```json"));
  const obj = extractGuidanceObject(merged);
  assert.ok(obj);
  assert.equal(obj.qualifyingInstance, full4.qualifyingInstance);
  assert.deepEqual(obj.disqualifiers, full4.disqualifiers);
  assert.equal(obj.anchors.partial, undefined);
});

test("merge: incoming null/empty returns existing UNCHANGED (never blanks prior)", () => {
  const existing = "prior prose guidance";
  assert.equal(mergeStructuredIntoScoringGuidance(existing, null), existing);
  assert.equal(mergeStructuredIntoScoringGuidance(existing, {}), existing);
  assert.equal(mergeStructuredIntoScoringGuidance(existing, { qualifyingInstance: "  " }), existing);
  const jsonExisting = JSON.stringify({ yes: "y" });
  assert.equal(mergeStructuredIntoScoringGuidance(jsonExisting, null), jsonExisting);
});

test("merge: only the fields the LLM returned overwrite; omitted fields keep prior", () => {
  const existing = JSON.stringify({
    qualifyingInstance: "OLD qi",
    disqualifiers: ["OLD d"],
    anchors: { yes: "OLD y", no: "OLD n" },
    yesRequiresQuote: "OLD q",
  });
  const merged = mergeStructuredIntoScoringGuidance(existing, { qualifyingInstance: "NEW qi" });
  const obj = JSON.parse(merged);
  assert.equal(obj.qualifyingInstance, "NEW qi");
  assert.deepEqual(obj.disqualifiers, ["OLD d"]);
  assert.equal(obj.anchors.yes, "OLD y");
  assert.equal(obj.yesRequiresQuote, "OLD q");
});

test("merge: a prior prose Partial anchor never survives the merge", () => {
  const existing = 'prose here\n\n```json\n{ "anchors": { "yes": "oy", "no": "on", "partial": "op" } }\n```';
  const merged = mergeStructuredIntoScoringGuidance(existing, { qualifyingInstance: "qi" });
  const obj = extractGuidanceObject(merged);
  assert.ok(obj);
  assert.equal(obj.anchors.partial, undefined);
});

// ─── audit-pass: a refine-authored measure passes the guidance audit ─────────

test("audit: merge output (from any prior) passes framework-guidance-audit with zero findings and no Partial", () => {
  for (const prior of ["prior prose scoring guidance", JSON.stringify({ yes: "y", no: "n", partial: "p" }), "", null]) {
    const scoringGuidance = mergeStructuredIntoScoringGuidance(prior as any, full4);
    const findings = auditFrameworkGuidance([{ measureId: "m1", title: "T", scoringGuidance }]);
    assert.deepEqual(findings, [], `expected zero findings for prior=${JSON.stringify(prior)}`);
    const obj = extractGuidanceObject(scoringGuidance);
    assert.ok(obj);
    assert.equal(obj.anchors.partial, undefined);
  }
});

// ─── shared-helper usage: ONE definition feeds create + intake + refine ──────

test("shared spec/blocks each mention all four structured field names", () => {
  for (const name of FIELD_NAMES) {
    assert.ok(STRUCTURED_GUIDANCE_FIELDS_SPEC.includes(name), `FIELDS_SPEC missing ${name}`);
    assert.ok(STRUCTURED_GUIDANCE_AUTHORING_BLOCK.includes(name), `AUTHORING_BLOCK missing ${name}`);
    assert.ok(STRUCTURED_GUIDANCE_REGEN_INSTRUCTION.includes(name), `REGEN_INSTRUCTION missing ${name}`);
    assert.ok(STRUCTURED_GUIDANCE_SCHEMA_FRAGMENT.includes(name), `SCHEMA_FRAGMENT missing ${name}`);
  }
});

test("REGEN_INSTRUCTION reuses the shared FIELDS_SPEC (single source of truth)", () => {
  assert.ok(STRUCTURED_GUIDANCE_REGEN_INSTRUCTION.includes(STRUCTURED_GUIDANCE_FIELDS_SPEC));
});

test("intake prompts embed the shared AUTHORING_BLOCK (create+intake share one definition)", () => {
  assert.ok(DRAFTING_SYSTEM_PROMPT_HEAD.includes(STRUCTURED_GUIDANCE_AUTHORING_BLOCK));
  assert.ok(CHUNKED_MEASURES_SYSTEM_PROMPT.includes(STRUCTURED_GUIDANCE_AUTHORING_BLOCK));
});
