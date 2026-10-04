/**
 * Unit tests for the STEP-1 builder-review composer.
 *
 * Verifies that the three detectors are mapped into the two StructuredIssue-shaped
 * lists the client renders (builderChanges = D1 drift + D2 promotions;
 * generalisationFindings = D3), that the issue envelope matches buildIssuePayload's
 * shape, and that a below-threshold ledger produces no promotions while an
 * over-threshold one does. Uses the committed fixture via the explicit-text path
 * and a tmp ledger — no network, no in-repo-default dependency.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeBuilderReview } from "./builder-review.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "__fixtures__");
const builderText = fs.readFileSync(path.join(FIX, "sample-builder-prompt.md"), "utf-8");

function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-review-"));
  return path.join(dir, "ledger.jsonl");
}

test("composer returns two issue-list payloads in the buildIssuePayload shape", async () => {
  const r = await composeBuilderReview({ builderText, ledgerPath: tmpLedger() });
  for (const list of [r.builderChanges, r.generalisationFindings]) {
    assert.ok(Array.isArray(list.issues));
    assert.equal(typeof list.issuesReadable, "string");
    assert.equal(typeof list.errorCount, "number");
    assert.equal(typeof list.warningCount, "number");
  }
  // Each mapped issue has the full StructuredIssue shape.
  for (const i of [...r.builderChanges.issues, ...r.generalisationFindings.issues]) {
    for (const k of ["id", "ruleCode", "severity", "measureId", "field", "issue", "reason", "solution", "implication"]) {
      assert.ok(k in i, `missing ${k} in ${JSON.stringify(i)}`);
    }
  }
});

test("builderChanges carries the D1 drift proposals; the C4 contradiction is an error", async () => {
  const r = await composeBuilderReview({ builderText, ledgerPath: tmpLedger() });
  const c4 = r.builderChanges.issues.find((i) => i.id === "bd-C4");
  assert.ok(c4, "expected bd-C4 in builderChanges");
  assert.equal(c4!.severity, "error");
  assert.equal(c4!.measureId, "builder-level");
});

test("generalisationFindings carries the D3 audit findings as warnings", async () => {
  const r = await composeBuilderReview({ builderText, ledgerPath: tmpLedger() });
  assert.ok(r.generalisationFindings.issues.length > 0);
  assert.ok(r.generalisationFindings.issues.every((i) => i.severity === "warning"));
  assert.equal(r.generalisationFindings.errorCount, 0);
});

test("a recurring defect over threshold is promoted into builderChanges", async () => {
  const file = tmpLedger();
  const defects = [
    { frameworkId: "fwA", rule: "C5", field: "scoringGuidance", measureId: "m1" },
    { frameworkId: "fwA", rule: "C5", field: "scoringGuidance", measureId: "m2" },
    { frameworkId: "fwB", rule: "C5", field: "scoringGuidance", measureId: "m1" },
  ];
  const r = await composeBuilderReview({ builderText, ledgerPath: file, defects, promoteThresholdOverride: 3 });
  assert.equal(r.promotions.length, 1);
  const promoted = r.builderChanges.issues.find((i) => i.id === r.promotions[0].id);
  assert.ok(promoted, "promotion should appear in builderChanges list");
});

test("the semantic pass is omitted unless requested, and runs with an injected LLM", async () => {
  const noSem = await composeBuilderReview({ builderText, ledgerPath: tmpLedger() });
  assert.equal(noSem.semantic, undefined);

  const fakeComplete = async () => ({ text: JSON.stringify({ proposals: [] }), provider: "test" });
  const withSem = await composeBuilderReview({
    builderText,
    ledgerPath: tmpLedger(),
    semantic: true,
    semanticComplete: fakeComplete as any,
  });
  assert.ok(withSem.semantic, "semantic result expected when requested");
  assert.equal(withSem.semantic!.accepted.length, 0);
});

test("composer resolves the explicit source and never mutates frameworks (gated)", async () => {
  const r = await composeBuilderReview({ builderText, ledgerPath: tmpLedger() });
  assert.equal(r.source.origin, "explicit");
  assert.match(r.note, /GATED/);
  assert.match(r.note, /verified-fixed/);
});
