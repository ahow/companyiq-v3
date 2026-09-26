// Regression harness tests (pure, DB-free; run: npx tsx server/lib/regression/harness.test.ts)
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseGoldSet, loadGoldSet, importGoldSetFromCsv, runRegressionHarness,
  formatRegressionReport, type GoldCell,
} from "./harness.js";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));

  // Seeded gold set loads and contains the single documented 3i control row.
  const gold = loadGoldSet(join(here, "gold-set.json"));
  assert.equal(gold.cells.length, 1, "only the 3i control row is seeded");
  const c = gold.cells[0];
  assert.equal(c.companyId, 158, "3i company_id");
  assert.equal(c.measureId, "board-oversight", "3i measure");
  assert.equal(c.expectedVerdict, "Yes", "3i expected verdict Yes");

  // Pass case: scorer reproduces the gold verdict.
  const passRep = await runRegressionHarness(gold, () => "Yes");
  assert.equal(passRep.allPass, true, "3i passes when scorer returns Yes");
  assert.equal(passRep.passed, 1);
  assert.equal(passRep.failed, 0);

  // Case-insensitive verdict comparison.
  const ciRep = await runRegressionHarness(gold, () => "yes");
  assert.equal(ciRep.allPass, true, "verdict comparison is case-insensitive");

  // Fail case: current production behaviour (false-negative "No") is caught.
  const failRep = await runRegressionHarness(gold, () => "No");
  assert.equal(failRep.allPass, false, "3i fails when scorer returns No");
  assert.equal(failRep.failed, 1);

  // Errored case: a thrown scorer error is a failing+errored row, never aborts.
  const errRep = await runRegressionHarness(gold, () => { throw new Error("hash mismatch"); });
  assert.equal(errRep.errored, 1, "thrown error recorded as errored row");
  assert.equal(errRep.failed, 1, "errored row counts as failing");
  assert.equal(errRep.allPass, false);
  assert.match(errRep.rows[0].error ?? "", /hash mismatch/, "error message captured");

  // CSV importer round-trip (header order/case-insensitive).
  const csv = [
    "Company_ID,Measure_ID,Expected_Verdict,Company_Name,Signed_Off_By",
    '158,board-oversight,Yes,"3i Group plc",reviewer',
  ].join("\n");
  const imported = importGoldSetFromCsv(csv);
  assert.equal(imported.cells.length, 1, "one row imported");
  assert.equal(imported.cells[0].companyId, 158, "csv company id parsed");
  assert.equal(imported.cells[0].expectedVerdict, "Yes", "csv verdict parsed");

  // parseGoldSet rejects malformed input.
  assert.throws(() => parseGoldSet("{}"), "missing cells rejected");

  // formatRegressionReport produces a non-empty summary.
  assert.ok(formatRegressionReport(failRep).length > 0, "report renders");

  console.log("regression-harness tests: PASS (seed-3i, pass, case-insensitive, fail, errored, csv-import, malformed, format)");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
