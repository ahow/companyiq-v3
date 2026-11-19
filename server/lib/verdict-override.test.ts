/**
 * 1.5 — GATE_RATIONALE_SYNC: verdict-override reconciliation.
 * node:test — run with:  npx tsx --test server/lib/verdict-override.test.ts
 * No company/framework/measure names referenced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeOverrideReason,
  buildOverrideMarker,
  extractVerdictOverrideReason,
  recordVerdictOverride,
} from "./verdict-override.js";

const LONG_AFFIRMATIVE =
  "The company clearly discloses a dedicated board-level committee with documented oversight of the relevant risks, "
  + "and provides a detailed account of its processes and metrics spanning many paragraphs. ".repeat(12);

test("sanitizeOverrideReason strips brackets and collapses whitespace", () => {
  assert.equal(sanitizeOverrideReason("  [Entity-attribution]   gate:  x\n\ty "), "Entity-attribution gate: x y");
});

test("buildOverrideMarker + extract round-trips the reason", () => {
  const marker = buildOverrideMarker("Provenance gate: all supporting quotes third-party");
  const text = `${marker}${LONG_AFFIRMATIVE}`;
  assert.equal(extractVerdictOverrideReason(text), "Provenance gate: all supporting quotes third-party");
});

test("extractVerdictOverrideReason returns null when no marker present", () => {
  assert.equal(extractVerdictOverrideReason(LONG_AFFIRMATIVE), null);
  assert.equal(extractVerdictOverrideReason(""), null);
  assert.equal(extractVerdictOverrideReason(null), null);
});

test("flag OFF → recordVerdictOverride is a no-op (legacy behaviour preserved)", () => {
  delete process.env.GATE_RATIONALE_SYNC;
  const r: any = { verdict: "No", evidenceSummary: LONG_AFFIRMATIVE, verdictNuance: "nuance" };
  const out = recordVerdictOverride(r, "Entity-attribution gate: subsidiary");
  assert.equal(out.verdictOverrideReason, undefined);
  assert.equal(out.evidenceSummary, LONG_AFFIRMATIVE);
  assert.equal(out.verdictNuance, "nuance");
});

test("flag ON → reason written to dedicated field, survives the 600-char screen slice", () => {
  process.env.GATE_RATIONALE_SYNC = "1";
  const r: any = { verdict: "No", evidenceSummary: LONG_AFFIRMATIVE, verdictNuance: "originally affirmative nuance" };
  const out = recordVerdictOverride(r, "Entity-attribution gate: quote names a distinct subsidiary");
  assert.equal(out.verdictOverrideReason, "Entity-attribution gate: quote names a distinct subsidiary");
  // The controlling reason is at the START, so a 600-char slice still shows it.
  const sliced = (out.evidenceSummary || "").slice(0, 600);
  assert.ok(sliced.startsWith("[OVERRIDE: Entity-attribution gate: quote names a distinct subsidiary]"));
  assert.equal(extractVerdictOverrideReason(out.evidenceSummary), "Entity-attribution gate: quote names a distinct subsidiary");
  assert.ok(String(out.verdictNuance).startsWith("[OVERRIDE:"));
  delete process.env.GATE_RATIONALE_SYNC;
});

test("flag ON → idempotent (second record does not double-prefix)", () => {
  process.env.GATE_RATIONALE_SYNC = "1";
  const r: any = { verdict: "No", evidenceSummary: "x", verdictNuance: "y" };
  recordVerdictOverride(r, "Reason A");
  const firstSummary = r.evidenceSummary;
  recordVerdictOverride(r, "Reason B");
  // The marker is only ever prefixed once; the first controlling reason remains.
  assert.equal(r.evidenceSummary, firstSummary);
  assert.equal(extractVerdictOverrideReason(r.evidenceSummary), "Reason A");
  delete process.env.GATE_RATIONALE_SYNC;
});

test("flag ON → never moves the verdict", () => {
  process.env.GATE_RATIONALE_SYNC = "1";
  const r: any = { verdict: "No", score: 0, evidenceSummary: "x", verdictNuance: "y" };
  recordVerdictOverride(r, "Some gate reason");
  assert.equal(r.verdict, "No");
  assert.equal(r.score, 0);
  delete process.env.GATE_RATIONALE_SYNC;
});
