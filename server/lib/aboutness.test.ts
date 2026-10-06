// Proposal A — aboutness scorer unit tests (synthetic, company-agnostic).
// Run: npx tsx --test server/lib/aboutness.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreAboutness, setAboutnessDocWeights, getAboutnessDocWeight } from "./aboutness.js";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");

test("issuer's own report (anchored, frequent mentions) => keep", () => {
  const text = `Acmeco Analyst Report 2025\nAcmeco delivered growth. ${filler(300)} Our strategy at Acmeco ... we invested. ${filler(300)} Acmeco results.`;
  const r = scoreAboutness(text, "Acmeco Holdings", [], ["zentrix group"]);
  assert.equal(r.decision, "keep");
  assert.ok(r.anchored);
});

test("table-heavy doc with one cover mention is NOT rejected (lenient floor)", () => {
  const text = `Acmeco factbook\n${filler(5000)} Zentrix Group ${filler(100)} Zentrix Group`;
  const r = scoreAboutness(text, "Acmeco", [], ["zentrix group"]);
  assert.notEqual(r.decision, "reject");
});

test("issuer-hosted research clearly about another entity => reject", () => {
  const body = Array.from({ length: 12 }, () => `Zentrix Group revenue rose. ${filler(40)}`).join(" ");
  const text = `${filler(400)} Sector note. ${body} Hosted by acmeco.`;
  const r = scoreAboutness(text, "Acmeco", [], ["zentrix group"]);
  assert.equal(r.decision, "reject");
  assert.equal(r.topOther, "zentrix group");
});

test("borderline (peer-heavy but target mentioned several times) => deprioritize, not reject", () => {
  const body = Array.from({ length: 12 }, () => `Zentrix Group revenue rose. ${filler(40)}`).join(" ");
  const text = `${filler(400)} ${body} Acmeco Acmeco Acmeco`;
  const r = scoreAboutness(text, "Acmeco", [], ["zentrix group"]);
  assert.equal(r.decision, "deprioritize");
});

test("generic legal-form org detection counts as competing entity", () => {
  const body = Array.from({ length: 10 }, () => `Northwind Partners AG reported. ${filler(30)}`).join(" ");
  const r = scoreAboutness(`${filler(400)} ${body}`, "Acmeco", [], []);
  assert.equal(r.decision, "reject");
});

test("weight registry is per company and defaults to 1", () => {
  setAboutnessDocWeights(1, new Map([["https://x.com/a.pdf", 0.5]]));
  assert.equal(getAboutnessDocWeight(1, "https://X.com/a.pdf/"), 0.5);
  assert.equal(getAboutnessDocWeight(2, "https://x.com/a.pdf"), 1);
  assert.equal(getAboutnessDocWeight(undefined, "https://x.com/a.pdf"), 1);
  setAboutnessDocWeights(1, new Map());
  assert.equal(getAboutnessDocWeight(1, "https://x.com/a.pdf"), 1);
});
