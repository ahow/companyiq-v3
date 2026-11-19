/**
 * 1.1 — EVIDENCE_REPAIR_REGRADE: a rescue replacement passage must satisfy the
 * measure's FULL positive-criteria predicate, not just share one keyword.
 * node:test — run with:  npx tsx --test server/lib/evidence-repair-regrade.test.ts
 * No company/framework/measure names referenced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rescuePassageSatisfiesCriteria,
  researchBestPassage,
  parsePackSegments,
  resolveGatePolicy,
} from "./evidence-gate.js";
import { evidenceRepairRegradeEnabled } from "./scoring-fix-flags.js";

const policy = resolveGatePolicy();
const CRITERIA = [
  "board committee oversight of climate related risk",
  "documented process reviewed annually",
];

test("flag defaults OFF (behaviour-preserving)", () => {
  delete process.env.EVIDENCE_REPAIR_REGRADE;
  assert.equal(evidenceRepairRegradeEnabled(), false);
  process.env.EVIDENCE_REPAIR_REGRADE = "1";
  assert.equal(evidenceRepairRegradeEnabled(), true);
  delete process.env.EVIDENCE_REPAIR_REGRADE;
});

test("passage satisfying ALL criteria conditions → satisfied", () => {
  const passage =
    "The board committee provides oversight of climate related risk, and a documented process is reviewed annually.";
  const r = rescuePassageSatisfiesCriteria(policy, CRITERIA, passage);
  assert.equal(r.conditionsRequired, 2);
  assert.equal(r.conditionsMet, 2);
  assert.equal(r.satisfied, true);
});

test("passage sharing only ONE keyword → NOT satisfied (the integrity fix)", () => {
  const passage = "The annual gala celebrated our loyal customers with seasonal gift cards.";
  const r = rescuePassageSatisfiesCriteria(policy, CRITERIA, passage);
  assert.equal(r.satisfied, false);
  assert.ok(r.conditionsMet < r.conditionsRequired);
});

test("passage matching only one of two conditions → NOT satisfied", () => {
  const passage = "The board committee provides oversight of climate related risk.";
  const r = rescuePassageSatisfiesCriteria(policy, CRITERIA, passage);
  assert.equal(r.conditionsRequired, 2);
  assert.ok(r.conditionsMet >= 1);
  assert.equal(r.satisfied, false);
});

test("no gradable criteria → cannot affirm (not satisfied)", () => {
  const r = rescuePassageSatisfiesCriteria(policy, ["", "   "], "anything");
  assert.equal(r.conditionsRequired, 0);
  assert.equal(r.satisfied, false);
});

test("researchBestPassage finds a supporting passage present in the corpus", () => {
  const pack =
    "--- DOCUMENT: AR [https://x.com] ---\n"
    + "The board committee provides oversight of climate related risk, and a documented process is reviewed annually by it.";
  const segs = parsePackSegments(pack);
  const found = researchBestPassage(policy, CRITERIA, segs, pack);
  assert.ok(found, "a supporting passage is found");
  assert.ok(rescuePassageSatisfiesCriteria(policy, CRITERIA, found!.text).satisfied);
});

test("researchBestPassage returns null when corpus shares too little vocabulary", () => {
  const pack = "--- DOCUMENT: X [https://x.com] ---\nSeasonal gift cards for loyal shoppers are available in stores.";
  const segs = parsePackSegments(pack);
  const found = researchBestPassage(policy, CRITERIA, segs, pack);
  assert.equal(found, null);
});
