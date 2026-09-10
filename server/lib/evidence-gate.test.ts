import assert from "node:assert/strict";
import { gateEvidence } from "./evidence-gate";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    pass++;
  } catch (e: any) {
    console.error(`  \u2717 ${name}: ${e.message}`);
    fail++;
  }
}

console.log("Evidence-integrity gate tests");

// A realistic injected positive example (the kind that gets echoed) and a pack
// that genuinely contains a different, real disclosure sentence.
const POSITIVE_EXAMPLE =
  "The Board's Sustainability Committee has oversight responsibility for nature and biodiversity risks and opportunities, reviewing our TNFD-aligned disclosures annually.";
const IN_PACK_SENTENCE =
  "In 2023 the group completed a double-materiality assessment covering water, deforestation and land-use change across its owned and franchised operations.";
const PACK_TEXT = `... preamble text ... ${IN_PACK_SENTENCE} ... more evidence-pack content follows here about governance and metrics ...`;

test("(a) catches a verbatim positive-example echo (anti-echo FAIL, downgrades YES→0)", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: POSITIVE_EXAMPLE, source: "Fabricated 2023 Report" }],
    packText: PACK_TEXT, // echo is NOT in the pack
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
  });
  assert.equal(r.gate.quotesTotal, 1);
  assert.equal(r.gate.quotesValid, 0);
  assert.equal(r.gate.failures.length, 1);
  assert.ok(r.gate.failures[0].reasons.includes("anti-echo"), "anti-echo reason present");
  assert.equal(r.gate.downgraded, true);
  assert.equal(r.score, 0, "YES with only an echoed quote downgrades to 0");
});

test("(b) passes a genuine in-pack quote (VALID, YES sustained)", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: IN_PACK_SENTENCE, source: "Kering Universal Registration Document 2023" }],
    packText: PACK_TEXT,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
  });
  assert.equal(r.gate.quotesValid, 1);
  assert.equal(r.gate.failures.length, 0);
  assert.equal(r.gate.downgraded, false);
  assert.equal(r.score, 1, "YES with a valid in-pack quote is sustained");
});

test("(c) fails an out-of-pack quote (provenance FAIL, downgrades YES→0)", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: "The company operates a fleet of zero-emission cargo submarines since 2019.", source: "Some Real-Looking Report 2022" }],
    packText: PACK_TEXT, // fabricated sentence not in pack, not an example either
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
  });
  assert.equal(r.gate.quotesValid, 0);
  assert.equal(r.gate.failures.length, 1);
  assert.ok(r.gate.failures[0].reasons.includes("provenance"), "provenance reason present");
  assert.equal(r.gate.downgraded, true);
  assert.equal(r.score, 0, "YES with only an out-of-pack quote downgrades to 0");
});

test("(d) thin/absent source fails the source check", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: IN_PACK_SENTENCE, source: "n/a" }],
    packText: PACK_TEXT,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
  });
  assert.equal(r.gate.quotesValid, 0);
  assert.ok(r.gate.failures[0].reasons.includes("source"));
  assert.equal(r.score, 0);
});

test("(e) NO stays 0 and is never marked downgraded", () => {
  const r = gateEvidence({
    originalScore: 0,
    quotes: [{ text: IN_PACK_SENTENCE, source: "Kering URD 2023" }],
    packText: PACK_TEXT,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
  });
  assert.equal(r.score, 0);
  assert.equal(r.gate.downgraded, false, "NO is not a downgrade");
});

// ---- Task B: strict-strip ----
const SECOND_IN_PACK_SENTENCE =
  "The group's Scope 1 and Scope 2 greenhouse-gas emissions fell 14% year on year, verified by an external assurance provider.";
const PACK_TEXT_TWO = `${PACK_TEXT} ${SECOND_IN_PACK_SENTENCE} ... closing content ...`;

test("(f) strict-strip: YES with 3 invalid + 1 valid keeps score 1 and returns only the valid quote", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [
      { text: POSITIVE_EXAMPLE, source: "Fabricated 2023 Report" }, // anti-echo
      { text: "The company operates zero-emission cargo submarines since 2019.", source: "Made-up 2022" }, // provenance
      { text: SECOND_IN_PACK_SENTENCE, source: "n/a" }, // source (thin) — in pack but bad source
      { text: SECOND_IN_PACK_SENTENCE, source: "Kering Universal Registration Document 2023" }, // valid
    ],
    packText: PACK_TEXT_TWO,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    // strictStrip defaults to true
  });
  assert.equal(r.gate.quotesTotal, 4);
  assert.equal(r.gate.quotesValid, 1);
  assert.equal(r.gate.failures.length, 3);
  assert.equal(r.score, 1, "YES survives on the one valid quote");
  assert.equal(r.keptQuotes.length, 1, "only the valid quote is kept");
  assert.equal(r.keptQuotes[0].source, "Kering Universal Registration Document 2023");
});

test("(g) strict-strip disabled: same input keeps all 4 quotes but score still 1", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [
      { text: POSITIVE_EXAMPLE, source: "Fabricated 2023 Report" },
      { text: SECOND_IN_PACK_SENTENCE, source: "Kering Universal Registration Document 2023" },
    ],
    packText: PACK_TEXT_TWO,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    strictStrip: false,
  });
  assert.equal(r.keptQuotes.length, 2, "legacy mode keeps flagged quotes too");
  assert.equal(r.score, 1);
});

// ---- Task C: source-attribution ----
const DOC_A_TEXT = `Kering Universal Registration Document 2023. ${IN_PACK_SENTENCE}`;
const DOC_B_TEXT = `Kering Climate Report 2023. ${SECOND_IN_PACK_SENTENCE}`;
const SEGMENTS = [
  { id: "Kering Universal Registration Document 2023", text: DOC_A_TEXT },
  { id: "Kering Climate Report 2023", text: DOC_B_TEXT },
];

test("(h) source-attribution: quote in pack but attributed to the WRONG document fails", () => {
  const r = gateEvidence({
    originalScore: 1,
    // IN_PACK_SENTENCE lives in DOC A, but the quote claims it came from DOC B.
    quotes: [{ text: IN_PACK_SENTENCE, source: "Kering Climate Report 2023" }],
    packText: `${DOC_A_TEXT} ${DOC_B_TEXT}`,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    documentSegments: SEGMENTS,
  });
  assert.equal(r.gate.quotesValid, 0);
  assert.ok(
    r.gate.failures[0].reasons.includes("source-attribution"),
    "source-attribution reason present",
  );
  assert.equal(r.score, 0, "misattributed quote downgrades YES→0");
});

test("(i) source-attribution: quote attributed to the CORRECT document passes", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: IN_PACK_SENTENCE, source: "Kering Universal Registration Document 2023" }],
    packText: `${DOC_A_TEXT} ${DOC_B_TEXT}`,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    documentSegments: SEGMENTS,
  });
  assert.equal(r.gate.quotesValid, 1);
  assert.equal(r.gate.failures.length, 0);
  assert.equal(r.score, 1);
});

test("(j) source-attribution: unresolvable source falls back to pack-wide (no attribution fail)", () => {
  const r = gateEvidence({
    originalScore: 1,
    // Source names no known segment → fall back to pack-wide provenance, which passes.
    quotes: [{ text: IN_PACK_SENTENCE, source: "Third-Party Analyst Note" }],
    packText: `${DOC_A_TEXT} ${DOC_B_TEXT}`,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    documentSegments: SEGMENTS,
  });
  assert.equal(r.gate.quotesValid, 1, "unresolved source is not hard-failed on attribution");
  assert.equal(r.score, 1);
});

test("(k) backward compatible: no segments supplied behaves exactly as before", () => {
  const r = gateEvidence({
    originalScore: 1,
    quotes: [{ text: IN_PACK_SENTENCE, source: "Kering Climate Report 2023" }],
    packText: PACK_TEXT,
    positiveExamples: [POSITIVE_EXAMPLE],
    negativeExamples: [],
    // no documentSegments
  });
  assert.equal(r.gate.quotesValid, 1);
  assert.equal(r.score, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
