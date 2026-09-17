// R4 (2026-09) — loud empty-corpus sentinel unit tests.
// buildEvidencePacksForCategory must attach a machine-readable
// emptyCorpus diagnostic to the sentinel packs it emits when the corpus
// yields zero chunks, so the pipeline can distinguish "0 usable chunks across
// ALL measures" (an operational failure) from a topic genuinely absent in a
// real corpus. Behind LOUD_EMPTY_CORPUS (default-on); a clean no-op when off.
//
// Run (DATABASE_URL must be set — passage-retrieval.ts transitively imports
// the db client at module load, same as passage-retrieval.test.ts):
//   DATABASE_URL=postgres://x:x@localhost:5432/x \
//     npx tsx --test server/lib/passage-retrieval-empty-corpus.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidencePacksForCategory } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

// The sentinel path reads only `measureId` off each measure.
const MEASURES = [
  { measureId: "m1" },
  { measureId: "m2" },
] as unknown as FrameworkMeasure[];

test("R4: empty combinedText emits emptyCorpus diagnostic on every sentinel pack", () => {
  const prev = process.env.LOUD_EMPTY_CORPUS;
  delete process.env.LOUD_EMPTY_CORPUS; // default-on
  try {
    const packs = buildEvidencePacksForCategory({
      measures: MEASURES,
      combinedText: "",
      topK: 5,
      maxChars: 1000,
      companyId: 42,
      frameworkId: 7,
    });
    assert.equal(packs.length, 2);
    for (const p of packs) {
      assert.equal(p.chunkCount, 0);
      assert.ok(p.passageDiagnostics, "passageDiagnostics present");
      assert.equal(p.passageDiagnostics!.emptyCorpus, true);
      assert.equal(p.passageDiagnostics!.emptyCorpusReason, "no_corpus_text");
    }
  } finally {
    if (prev === undefined) delete process.env.LOUD_EMPTY_CORPUS;
    else process.env.LOUD_EMPTY_CORPUS = prev;
  }
});

test("R4: whitespace-only corpus is still flagged empty (no_corpus_text)", () => {
  const prev = process.env.LOUD_EMPTY_CORPUS;
  delete process.env.LOUD_EMPTY_CORPUS;
  try {
    const packs = buildEvidencePacksForCategory({
      measures: MEASURES,
      combinedText: "   \n\t   ",
      topK: 5,
      maxChars: 1000,
      companyId: 42,
      frameworkId: 7,
    });
    for (const p of packs) {
      assert.ok(p.passageDiagnostics);
      assert.equal(p.passageDiagnostics!.emptyCorpus, true);
      // trims to empty -> classified as no_corpus_text.
      assert.equal(p.passageDiagnostics!.emptyCorpusReason, "no_corpus_text");
    }
  } finally {
    if (prev === undefined) delete process.env.LOUD_EMPTY_CORPUS;
    else process.env.LOUD_EMPTY_CORPUS = prev;
  }
});

test("R4: clean no-op when LOUD_EMPTY_CORPUS=false (no passageDiagnostics)", () => {
  const prev = process.env.LOUD_EMPTY_CORPUS;
  process.env.LOUD_EMPTY_CORPUS = "false";
  try {
    const packs = buildEvidencePacksForCategory({
      measures: MEASURES,
      combinedText: "",
      topK: 5,
      maxChars: 1000,
      companyId: 42,
      frameworkId: 7,
    });
    assert.equal(packs.length, 2);
    for (const p of packs) {
      assert.equal(p.chunkCount, 0);
      assert.equal(p.passageDiagnostics, undefined);
    }
  } finally {
    if (prev === undefined) delete process.env.LOUD_EMPTY_CORPUS;
    else process.env.LOUD_EMPTY_CORPUS = prev;
  }
});
