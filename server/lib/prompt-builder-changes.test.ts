/**
 * Tests that the binary scoring prompt carries the generic Changes A, B and C.
 * node:test — run with:  npx tsx --test server/lib/prompt-builder-changes.test.ts
 *
 * These assert on GENERIC prompt structure only — no measure/company/framework
 * name is referenced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBinaryScoringPrompt } from "./analyzer.js";

function build(measureOverrides: any) {
  return buildBinaryScoringPrompt({
    companyName: "Acme",
    measure: { title: "Some measure", definition: "Some definition", ...measureOverrides } as any,
    evidenceText: "Some evidence.",
    topicDescription: "Some topic",
  });
}

test("Change A: generic exclusion-precedence rule is present for every measure", () => {
  const { prompt } = build({});
  assert.match(prompt, /PRECEDENCE \(how to reconcile the guidance above\)/);
  assert.match(prompt, /Assess whether a qualifying instance exists FIRST/);
});

test("Change B: plain-prose scoring_guidance is rendered under a neutral heading, NOT bucketed under '- Yes:'", () => {
  const prose = "Award a positive score when the disclosure names a concrete instance.";
  const { prompt } = build({ scoringGuidance: prose });
  assert.ok(prompt.includes(prose), "prose text should be present");
  // The prose must be under the neutral "Scoring guidance:" heading and must NOT
  // be shoehorned into the "- Yes: <prose>" JSON-bucket layout.
  assert.equal(prompt.includes(`- Yes: ${prose}`), false);
  assert.match(prompt, /Scoring guidance:\n/);
});

test("Change B: structured JSON scoring_guidance IS bucketed under '- Yes:'", () => {
  const { prompt } = build({ scoringGuidance: JSON.stringify({ yes: "clear ev", no: "none", partial: "some" }) });
  assert.match(prompt, /- Yes: clear ev/);
  assert.match(prompt, /- No: none/);
});

test("Change C: prompt schema requests rationaleConsistencyCheck + consistencyNote and includes the self-check instruction", () => {
  const { prompt } = build({});
  assert.match(prompt, /"rationaleConsistencyCheck": "Yes" \| "No"/);
  assert.match(prompt, /"consistencyNote":/);
  // The single-shot self-check instruction block must be embedded (no extra call).
  assert.match(prompt, /rationaleConsistencyCheck/);
});
