/**
 * batch-1277 (B6) — equivalence test: the NEW killable pdf-parse subprocess boundary
 * (extractViaPdfParseSubprocess, which runs pdf-parse-worker.cjs via runProcessCollect)
 * must yield byte-identical extracted text to the OLD in-process pdf-parse call, once
 * the SAME normaliser (normaliseTableHorizonMarkers) is applied to both — proving the
 * move off the main thread did not change WHAT text is produced, only WHERE the parse
 * runs (so it can be SIGKILLed to honour the operation deadline).
 *
 * The in-process reference calls the EXACT same pdf-parse the worker calls (resolved
 * through createRequire), so this compares the two execution loci of one library, not
 * two libraries. No DB, no Redis, no Chromium, no paid calls.
 *
 * Fixture: server/lib/__fixtures__/sample-filing.pdf — a small, well-formed PDF
 * committed with the test. It is NOT hand-rolled: pdf-parse bundles an old pdf.js
 * (v1.10.100) whose cross-reference reader rejects the minimal hand-built xref tables
 * our other fixtures (marker-pdf.ts) use for the real-browser → pdftotext path, so
 * those are unusable here. This fixture is produced deterministically by weasyprint
 * (see the regeneration recipe in __fixtures__/README-sample-filing.md) and parses
 * cleanly on the first pdf.js call, with both prose and table-ish rows so the
 * horizon normaliser is actually exercised.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/pdf-parse-subprocess-equivalence.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const { extractViaPdfParseSubprocess, processorSlotBroker } = await import("./processor.js");
const { normaliseTableHorizonMarkers } = await import("./table-horizon-normaliser.js");

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "__fixtures__", "sample-filing.pdf");

const b = processorSlotBroker.proc;

// In-process reference = the OLD path: pdf-parse in the main process, then the SAME
// normaliser the new caller (extractTextFromPdf) applies to the subprocess output.
async function inProcessReference(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf);
  // normaliseTableHorizonMarkers returns { text, detected, annotationsAdded };
  // the production caller (extractTextFromPdf) uses .text — mirror that exactly.
  return normaliseTableHorizonMarkers(data.text || "").text;
}

// New path = subprocess worker (RAW text) + the SAME normaliser applied by the caller.
async function subprocessPath(buf: Buffer): Promise<string> {
  const raw = await extractViaPdfParseSubprocess(buf);
  return normaliseTableHorizonMarkers(raw).text;
}

test("B6 equivalence — subprocess extraction is byte-identical to in-process after the same normaliser", async () => {
  const buf = readFileSync(FIXTURE);
  const [ref, sub] = await Promise.all([inProcessReference(buf), subprocessPath(buf)]);

  assert.ok(ref.length > 0, "in-process reference produced text");
  assert.ok(sub.length > 0, "subprocess produced text");
  assert.equal(sub, ref, "subprocess extraction is byte-identical to in-process after the same normaliser");
  // sanity: the marker content actually came through (not an empty-equals-empty pass)
  assert.ok(sub.includes("CIQMARKER-ALPHA"), "extracted text contains the fixture marker");
  // the table-ish rows that exercise the horizon normaliser survived the round trip
  assert.ok(sub.includes("Row A") && sub.includes("Row B"), "table-ish rows present after normalisation");

  // the proc slot is released after the subprocess settles (no capacity leak)
  assert.equal(b.state().active, 0, "proc slot released after extraction");
  assert.equal(b.state().waiting, 0);
});

// A second, independent invocation on the same bytes: equivalence must hold run-to-run,
// and the proc slot must be re-acquirable (no cumulative leak across extractions).
test("B6 equivalence — holds on a repeat extraction and leaves capacity restored", async () => {
  const buf = readFileSync(FIXTURE);
  const ref = await inProcessReference(buf);
  const sub = await subprocessPath(buf);
  assert.equal(sub, ref, "second extraction is also byte-identical");
  assert.equal(b.state().active, 0, "proc slot released after repeat extraction");
  assert.equal(b.state().waiting, 0);
});

test.after(() => clearInterval(keepAlive));
