/**
 * Tests for the rubric-tightening authoring + rendering contract (A1/A2/A3).
 * node:test — run with:
 *   DATABASE_URL="postgres://u:p@localhost:5432/x" npx tsx --test server/lib/rubric-tightening.test.ts
 *
 * GENERIC: no test references a specific measure, company, or framework. Every
 * measure/framework object below is a synthetic fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBinaryScoringPrompt, buildPartialScoringPrompt } from "./analyzer.js";
import {
  DRAFTING_SYSTEM_PROMPT_HEAD,
  CHUNKED_MEASURES_SYSTEM_PROMPT,
} from "./framework-v2/intake-prompt.js";

// ─── A helper to build the full scoring text (system + prompt) ────────────────
function builtText(measure: any): string {
  const { system, prompt } = buildBinaryScoringPrompt({
    companyName: "Acme Co",
    measure,
    evidenceText: "Some evidence text here.",
    topicDescription: "the framework topic",
    framework: undefined,
  });
  return system + "\n" + prompt;
}

// A fully rubric-tightened structured guidance object (the shape the builder
// instructs the LLM to author). Stored as a ```json fence appended to prose to
// exercise the tolerant extractor + backward-compatible prose portion.
function structuredGuidance() {
  return (
    "Score Yes when the disclosure meets the qualifying instance below.\n\n" +
    "```json\n" +
    JSON.stringify({
      qualifyingInstance:
        "A specifically named policy/programme with a dated, quantified commitment.",
      disqualifiers: [
        "Generic aspiration with no named instance",
        "Forward-looking intent without a dated commitment",
      ],
      anchors: {
        yes: "Company published its Board-approved X Policy in 2024 with a 30% target by 2027.",
        no: "Company states it 'aims to strengthen governance over time'.",
      },
      yesRequiresQuote:
        "A Yes is permissible ONLY when a verbatim quote names the qualifying instance.",
    }) +
    "\n```"
  );
}

// ─── A1: authoring instructions instruct the LLM to author the 4 fields ───────

test("A1: single-shot drafter boilerplate instructs authoring of all 4 structured fields", () => {
  for (const field of ["qualifyingInstance", "disqualifiers", "anchors", "yesRequiresQuote"]) {
    assert.ok(
      DRAFTING_SYSTEM_PROMPT_HEAD.includes(field),
      `DRAFTING_SYSTEM_PROMPT_HEAD should instruct authoring of "${field}"`,
    );
  }
});

test("A1: chunked-measures boilerplate instructs authoring of all 4 structured fields", () => {
  for (const field of ["qualifyingInstance", "disqualifiers", "anchors", "yesRequiresQuote"]) {
    assert.ok(
      CHUNKED_MEASURES_SYSTEM_PROMPT.includes(field),
      `CHUNKED_MEASURES_SYSTEM_PROMPT should instruct authoring of "${field}"`,
    );
  }
});

// ─── A1/A3: structured guidance is RENDERED into the scoring prompt ───────────

test("A1: qualifyingInstance and disqualifiers are rendered into the built prompt", () => {
  const text = builtText({
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: structuredGuidance(),
  });
  assert.ok(text.includes("QUALIFYING INSTANCE"), "should render QUALIFYING INSTANCE heading");
  assert.ok(
    text.includes("A specifically named policy/programme with a dated, quantified commitment."),
    "should render the authored qualifyingInstance text",
  );
  assert.ok(text.includes("DISQUALIFIERS"), "should render DISQUALIFIERS heading");
  assert.ok(text.includes("Generic aspiration with no named instance"), "should render a disqualifier");
});

test("A3: exactly one canonical Yes + one canonical No anchor render, and NO Partial anchor", () => {
  const text = builtText({
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: structuredGuidance(),
  });
  assert.ok(text.includes("WORKED EXAMPLES"), "should render WORKED EXAMPLES heading");
  assert.ok(text.includes("Canonical YES:"), "should render the canonical YES anchor");
  assert.ok(text.includes("Canonical NO:"), "should render the canonical NO anchor");
  // NEVER a Partial anchor (operator treats Partial as No).
  assert.ok(!/Canonical\s+PARTIAL/i.test(text), "must NOT render any Partial anchor");
  // Exactly one YES anchor line and one NO anchor line.
  assert.equal((text.match(/Canonical YES:/g) || []).length, 1, "exactly one YES anchor");
  assert.equal((text.match(/Canonical NO:/g) || []).length, 1, "exactly one NO anchor");
});

// ─── A2: Yes-requires-a-verbatim-quote precondition is ALWAYS in the prompt ────

test("A2: structured measure carries the Yes-requires-verbatim-quote precondition", () => {
  const text = builtText({
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: structuredGuidance(),
  });
  assert.ok(
    text.includes("YES REQUIRES A VERBATIM QUOTE"),
    "should render the Yes-requires-verbatim-quote precondition",
  );
  // Uses the authored rule line when present.
  assert.ok(
    text.includes("A Yes is permissible ONLY when a verbatim quote names the qualifying instance."),
    "should use the authored yesRequiresQuote line",
  );
});

test("A2: prose-only / legacy measure STILL carries the Yes-requires-verbatim-quote precondition (backward compatible)", () => {
  const text = builtText({
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: "Award Yes when the company clearly discloses a policy.", // prose only, no JSON
  });
  assert.ok(
    text.includes("YES REQUIRES A VERBATIM QUOTE"),
    "precondition must be emitted even without structured guidance",
  );
  // No structured sections should appear for a prose-only measure.
  assert.ok(!text.includes("QUALIFYING INSTANCE"), "no QUALIFYING INSTANCE for prose-only measure");
  assert.ok(!text.includes("WORKED EXAMPLES"), "no WORKED EXAMPLES for prose-only measure");
});

test("A2/A3: the PARTIAL prompt builder also renders the precondition + Yes/No anchors (no Partial anchor)", () => {
  const measure = {
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: structuredGuidance(),
  };
  const { system, prompt } = buildPartialScoringPrompt({
    companyName: "Acme Co",
    measure: measure as any,
    evidenceText: "Some evidence text here.",
    topicDescription: "the framework topic",
    framework: undefined,
  });
  const text = system + "\n" + prompt;
  assert.ok(text.includes("YES REQUIRES A VERBATIM QUOTE"), "partial builder must carry the precondition");
  assert.ok(text.includes("Canonical YES:"), "partial builder renders the canonical YES anchor");
  assert.ok(text.includes("Canonical NO:"), "partial builder renders the canonical NO anchor");
  assert.ok(!/Canonical\s+PARTIAL/i.test(text), "partial builder must NOT render a Partial anchor");
});

test("A2/A3: null scoringGuidance renders precondition and no structured sections (no throw)", () => {
  const text = builtText({
    measureId: "m1",
    title: "T",
    definition: "D",
    category: "C",
    categoryNumber: 1,
    displayOrder: 1,
    scoringGuidance: null,
  });
  assert.ok(text.includes("YES REQUIRES A VERBATIM QUOTE"));
  assert.ok(!text.includes("WORKED EXAMPLES"));
});
