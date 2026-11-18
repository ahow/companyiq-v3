// Proposal A — aboutness scorer unit tests (synthetic, company-agnostic).
// Run: npx tsx --test server/lib/aboutness.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreAboutness, setAboutnessDocWeights, getAboutnessDocWeight, isCompetitorDominated, type AboutnessResult } from "./aboutness.js";

// Factory for a synthetic AboutnessResult (only the fields isCompetitorDominated reads matter).
function ar(partial: Partial<AboutnessResult>): AboutnessResult {
  return {
    density: 0,
    dominanceRatio: 0,
    anchored: partial.anchored ?? false,
    targetHits: partial.targetHits ?? 0,
    topOther: partial.topOther,
    topOtherHits: partial.topOtherHits ?? 0,
    decision: partial.decision ?? "deprioritize",
  };
}

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

// ─── P2.3 — isCompetitorDominated (competitor-dominance admission hard reject) ──
const PEERS = ["vodafone group", "zentrix group", "iberdrola sa"];

test("P2.3: a listed peer dominating the body (ratio ≥ min, not anchored) → competitor-dominated", () => {
  const r = ar({ anchored: false, targetHits: 1, topOther: "vodafone group", topOtherHits: 8 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), true);
});

test("P2.3: a non-peer dominator is NOT a competitor-dominance reject (conservative)", () => {
  // Some org-shaped string that is NOT in the workspace peer list → do not reject.
  const r = ar({ anchored: false, targetHits: 1, topOther: "northwind partners ag", topOtherHits: 20 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), false);
});

test("P2.3: an anchored document is never competitor-dominated (target owns the cover)", () => {
  const r = ar({ anchored: true, targetHits: 1, topOther: "vodafone group", topOtherHits: 20 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), false);
});

test("P2.3: a peer below the minimum ratio does not trigger the hard reject", () => {
  // 3 peer hits vs 1 target hit → ratio 3 < 4 → not rejected.
  const r = ar({ anchored: false, targetHits: 1, topOther: "vodafone group", topOtherHits: 3 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), false);
});

test("P2.3: substring match counts (peer name contains / is contained by topOther)", () => {
  // topOther 'vodafone' is a substring of the listed peer 'vodafone group'.
  const r = ar({ anchored: false, targetHits: 1, topOther: "vodafone", topOtherHits: 10 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), true);
});

test("P2.3: empty peer list → never competitor-dominated", () => {
  const r = ar({ anchored: false, targetHits: 1, topOther: "vodafone group", topOtherHits: 50 });
  assert.equal(isCompetitorDominated(r, [], 4), false);
});

test("P2.3: zero target hits uses a safe denominator (max(1,targetHits))", () => {
  const r = ar({ anchored: false, targetHits: 0, topOther: "zentrix group", topOtherHits: 4 });
  assert.equal(isCompetitorDominated(r, PEERS, 4), true); // 4 / max(1,0) = 4 ≥ 4
});

test("weight registry is per company and defaults to 1", () => {
  setAboutnessDocWeights(1, new Map([["https://x.com/a.pdf", 0.5]]));
  assert.equal(getAboutnessDocWeight(1, "https://X.com/a.pdf/"), 0.5);
  assert.equal(getAboutnessDocWeight(2, "https://x.com/a.pdf"), 1);
  assert.equal(getAboutnessDocWeight(undefined, "https://x.com/a.pdf"), 1);
  setAboutnessDocWeights(1, new Map());
  assert.equal(getAboutnessDocWeight(1, "https://x.com/a.pdf"), 1);
});
