import assert from "node:assert/strict";
import {
  hasCSRDHorizonTable,
  normaliseCSRDHorizonMarkers,
} from "./csrd-table-normaliser";

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

console.log("CSRD table normaliser tests");

test("no-op on plain text without CSRD header", () => {
  const t = "Some paragraph.\n\nAnother paragraph.\n\nNo tables here.";
  const r = normaliseCSRDHorizonMarkers(t);
  assert.equal(r.detected, false);
  assert.equal(r.annotationsAdded, 0);
  assert.equal(r.text, t);
});

test("no-op on text with bullets but no CSRD header", () => {
  const t = "Bullet list:\n\u2022 apples\n\u2022 pears\n\u2022 oranges";
  const r = normaliseCSRDHorizonMarkers(t);
  assert.equal(r.detected, false);
  assert.equal(r.text, t);
});

test("detects header even with lots of intervening text", () => {
  const header =
    "Value chain Time horizon\nSubtopic IRO name\nRationale\nShort term Medium term Long term";
  assert.equal(hasCSRDHorizonTable(header), true);
});

test("annotates '\u2022\u2022\u2022' as short/medium/long", () => {
  const doc = [
    "Value chain Time horizon",
    "Subtopic IRO name",
    "Rationale: description",
    "Short term Medium term Long term",
    "",
    "Biodiversity and ecosystems",
    "Deforestation",
    "\u2022\u2022\u2022",
    "Risk: This risk in our upstream value chain...",
    "\u2022\u2022\u2022",
  ].join("\n");
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, true);
  assert.equal(r.annotationsAdded, 2);
  assert.match(r.text, /\u2022\u2022\u2022 \[horizon: short, medium and long term\]/);
});

test("annotates '\u2022' and '\u2022\u2022' variants", () => {
  const doc = [
    "IRO name Subtopic Rationale Short term Medium term Long term",
    "Risk A",
    "\u2022",
    "Risk B",
    "\u2022\u2022",
    "Risk C",
    "\u2022\u2022\u2022",
  ].join("\n");
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, true);
  assert.equal(r.annotationsAdded, 3);
  assert.match(r.text, /\u2022 \[horizon: short term\]/);
  assert.match(r.text, /\u2022\u2022 \[horizon: short and medium term\]/);
  assert.match(r.text, /\u2022\u2022\u2022 \[horizon: short, medium and long term\]/);
});

test("annotates filled/empty circle notation \u25cf\u25cf\u25cb", () => {
  const doc = [
    "Rationale Short term Medium term Long term",
    "\u25cf\u25cf\u25cb",
    "\u25cf\u25cb\u25cb",
    "\u25cf\u25cf\u25cf",
  ].join("\n");
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, true);
  assert.equal(r.annotationsAdded, 3);
  assert.match(r.text, /\u25cf\u25cf\u25cb \[horizon: short and medium term\]/);
  assert.match(r.text, /\u25cf\u25cb\u25cb \[horizon: short term\]/);
  assert.match(r.text, /\u25cf\u25cf\u25cf \[horizon: short, medium and long term\]/);
});

test("does NOT annotate bullet within a normal sentence", () => {
  const doc = [
    "IRO Subtopic Short term Medium term Long term",
    "This is a real sentence \u2022 with a bullet character in it.",
  ].join("\n");
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, true);
  assert.equal(r.annotationsAdded, 0);
  assert.equal(r.text.includes("[horizon:"), false);
});

test("idempotent: running twice produces the same output", () => {
  const doc = [
    "Rationale Short term Medium term Long term",
    "Risk A",
    "\u2022\u2022\u2022",
  ].join("\n");
  const first = normaliseCSRDHorizonMarkers(doc).text;
  const second = normaliseCSRDHorizonMarkers(first).text;
  assert.equal(first, second);
});

test("byte-identical output when no header detected (backward-compat guard)", () => {
  const doc = "Random\n\ntext with \u2022 bullets but no ESRS header\n\u2022\u2022\u2022";
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, false);
  assert.equal(r.annotationsAdded, 0);
  assert.equal(r.text, doc);
});

test("real Nestlé-style block: two horizon markers get annotated", () => {
  const doc = `Value chainTime horizon
Subtopic IRO name
Upstream Own operations Downstream
Rationale: description of impact and/or risk
Short term Medium term Long term
Table of Contents
About this
Non-Financial Statement 2025

Biodiversity and ecosystems
Impacts on the state of species
Pollinator decline
\u2022
Negative impact: This negative impact in our upstream value chain relates to how the excessive or improper use of pesticides can harm pollinator populations, crucial for the state of species and ecosystems.
\u2022\u2022\u2022
Land-use change
Deforestation
\u2022
Risk: This risk in our upstream value chain relates to how agricultural activities can be a key driver of land-use change and can contribute to deforestation.
\u2022\u2022\u2022`;
  const r = normaliseCSRDHorizonMarkers(doc);
  assert.equal(r.detected, true);
  assert.equal(r.annotationsAdded, 4);
  // Both "•••" occurrences should now carry the horizon annotation
  const tripleAnnotations = (r.text.match(/\u2022\u2022\u2022 \[horizon: short, medium and long term\]/g) || []).length;
  assert.equal(tripleAnnotations, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
