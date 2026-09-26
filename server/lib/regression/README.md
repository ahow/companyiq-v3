# Regression harness (Change #5) + Evidence ledger (Change #2)

Generic, topic/company-agnostic regression testing for scoring. It re-scores
adjudicated **gold cells** and reports pass/fail against the reviewer's verdict.
Non-blocking: this is an offline audit/CI tool — it is never on the live
scoring path and can never gate a run.

## How it works

1. **Evidence ledger** (`server/lib/corpus-replay.ts`, Change #2) freezes, per
   `(company, measure)` cell, the retrieved document ids plus the SHA-256
   content hash of every scored passage, and a run-level fingerprint. It has a
   fail-loud replay path (`replayLedgerCell`) that re-materialises the exact
   passage bundle and throws `LedgerIntegrityError` on any hash divergence.
2. **Harness** (`harness.ts`) takes a `GoldSet` and a `ReplayScorer`. For each
   gold cell it replays the frozen bundle through the scorer and compares the
   produced verdict (case-insensitive) to the adjudicated `expectedVerdict`.
   A scorer that throws (e.g. `LedgerIntegrityError`) is recorded as an
   errored, failing row — the run never aborts.

Wire the scorer to the real replay-ledger + analyzer path in a CLI/CI step:

```ts
import { loadGoldSet, runRegressionHarness, formatRegressionReport } from "./harness.js";
const gold = loadGoldSet(new URL("./gold-set.json", import.meta.url).pathname);
const report = await runRegressionHarness(gold, async (cell) => {
  // 1. load the frozen RunLedger for this (company, measure)
  // 2. replayLedgerCell(cell, freshlyReadPassages)  // fail-loud integrity check
  // 3. feed the ordered passages to the analyzer and return its verdict
  return await scoreViaLedger(cell);
});
console.log(formatRegressionReport(report));
process.exit(report.allPass ? 0 : 1);
```

## Gold-set format (`gold-set.json`)

```jsonc
{
  "description": "...",
  "cells": [
    {
      "companyId": 158,              // required, numeric
      "companyName": "3i Group plc", // optional, human label
      "measureId": "board-oversight",// required
      "measureTitle": "...",         // optional
      "expectedVerdict": "Yes",      // required: Yes | No | Partial | Insufficient evidence
      "note": "...",                 // optional adjudication note
      "signedOffBy": "...",          // optional reviewer id
      "signedOffAt": "2026-09-26"    // optional ISO date
    }
  ]
}
```

## CSV import

`importGoldSetFromCsv(csv)` parses a reviewer workbook exported as CSV. Headers
are case-insensitive and order-free; required columns: `company_id`,
`measure_id`, `expected_verdict`. Optional: `company_name`, `measure_title`,
`note`, `signed_off_by`, `signed_off_at`.

## Seeded data

Only ONE row is seeded — the documented false-negative control:

- **3i Group plc** (`company_id` 158), measure `board-oversight`, expected
  **Yes** (Audit & Compliance Committee evidence is present in the corpus but
  the run scored No).

## TODO — import the full adjudication workbook

The reviewer's full **80-cell** adjudication workbook was **not** uploaded to
this environment, so it has intentionally **not** been fabricated. When it is
available, export it to CSV and import it:

```ts
import { importGoldSetFromCsv } from "./harness.js";
import { readFileSync } from "node:fs";
const gold = importGoldSetFromCsv(readFileSync("adjudications.csv", "utf8"));
```

Candidate sources present in this repo's uploads (verify they are the signed-off
gold set before importing — do not import unadjudicated data):
`AI Governance and Strategy (imported)-26 Sept 2026*.csv`.
