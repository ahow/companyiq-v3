/**
 * Unit tests for the append-only recurring-defect ledger (STEP 3, Detector D2).
 *
 * Covers: append+read round-trip, the >= PROMOTE_THRESHOLD promotion of a defect
 * class across DISTINCT sites, the no-promotion case below threshold, distinct-
 * site de-duplication (same site repeated does not inflate the count), and the
 * fail-loud behaviour on a corrupt ledger line.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDefectRecords,
  readLedger,
  computeRecurrencePromotions,
  defectClassOf,
  normaliseRecord,
} from "./defect-ledger.js";

function tmpLedger(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defect-ledger-"));
  return path.join(dir, "ledger.jsonl");
}

test("append + read round-trips records and derives defectClass/count", () => {
  const file = tmpLedger();
  const { appended } = appendDefectRecords(
    [{ frameworkId: "fw1", rule: "C5", field: "scoringGuidance", measureId: "m1" }],
    file,
  );
  assert.equal(appended, 1);
  const rows = readLedger(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].defectClass, defectClassOf("C5", "scoringGuidance"));
  assert.equal(rows[0].count, 1);
});

test("a defect class across >= 3 DISTINCT sites is promoted to a builder proposal", () => {
  const file = tmpLedger();
  appendDefectRecords(
    [
      { frameworkId: "fwA", rule: "C5", field: "scoringGuidance", measureId: "m1" },
      { frameworkId: "fwA", rule: "C5", field: "scoringGuidance", measureId: "m2" },
      { frameworkId: "fwB", rule: "C5", field: "scoringGuidance", measureId: "m1" },
    ],
    file,
  );
  const promotions = computeRecurrencePromotions(readLedger(file), 3);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].rule, "C5");
  assert.equal(promotions[0].distinctSites, 3);
  assert.deepEqual(promotions[0].frameworks, ["fwA", "fwB"]);
});

test("below-threshold recurrence does NOT promote (anti-overfit gate)", () => {
  const file = tmpLedger();
  appendDefectRecords(
    [
      { frameworkId: "fwA", rule: "C7", field: "title", measureId: "m1" },
      { frameworkId: "fwA", rule: "C7", field: "title", measureId: "m2" },
    ],
    file,
  );
  const promotions = computeRecurrencePromotions(readLedger(file), 3);
  assert.equal(promotions.length, 0);
});

test("the same site repeated counts once (distinct-site de-duplication)", () => {
  const file = tmpLedger();
  appendDefectRecords(
    [
      { frameworkId: "fwA", rule: "C8", field: "evidence", measureId: "m1" },
      { frameworkId: "fwA", rule: "C8", field: "evidence", measureId: "m1" },
      { frameworkId: "fwA", rule: "C8", field: "evidence", measureId: "m1" },
    ],
    file,
  );
  const promotions = computeRecurrencePromotions(readLedger(file), 3);
  assert.equal(promotions.length, 0, "one site repeated 3x must NOT promote");
});

test("readLedger is fail-loud on a corrupt JSONL line", () => {
  const file = tmpLedger();
  appendDefectRecords([{ frameworkId: "fwA", rule: "C1", field: "title", measureId: "m1" }], file);
  fs.appendFileSync(file, "{ this is not valid json\n", "utf-8");
  assert.throws(() => readLedger(file), /corrupt JSONL/);
});

test("appendDefectRecords is fail-loud when the path is unwritable", () => {
  // A path whose parent is a file (not a directory) cannot be created → throws.
  const file = tmpLedger();
  fs.writeFileSync(file, "", "utf-8");
  const bad = path.join(file, "nested", "ledger.jsonl");
  assert.throws(() => appendDefectRecords([{ frameworkId: "x", rule: "C1", field: "t", measureId: "m" }], bad), /FAILED to append/);
});

test("normaliseRecord fills defaults deterministically", () => {
  const r = normaliseRecord({ frameworkId: "fw", rule: "C2", field: "x", measureId: "m" });
  assert.equal(r.defectClass, "C2:x");
  assert.equal(r.count, 1);
  assert.equal(typeof r.timestamp, "string");
});
