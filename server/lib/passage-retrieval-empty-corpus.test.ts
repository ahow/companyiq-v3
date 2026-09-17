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

// ---------------------------------------------------------------------------
// CHANGE 2 — applyChunkSanityGate fail-open safety net + preserveIfOnlySource.
// When the gate would empty the pool although there WERE input chunks, keep the
// least-bad source's chunks and emit a loud [CHUNK_GATE_FAIL_OPEN] warning.
// Behind CHUNK_GATE_FAIL_OPEN (default-on); flag-off restores prior behaviour
// (the gate may empty the pool).
// ---------------------------------------------------------------------------
import { applyChunkSanityGate } from "./passage-retrieval.js";
import type { Chunk } from "./passage-retrieval.js";
import type { IssuerProfile } from "./issuer-profile.js";

// Minimal issuer profile: distinctive legal name token "zzqcorp" that appears in
// NO test document, empty verifiedDomains, so scoreEntityMatch returns 0 for the
// docs below -> the gate hard-rejects all of them (entityScore < 20).
const ISSUER: IssuerProfile = {
  companyId: 999,
  legalName: "Zzqcorp Holdings",
  tradingNames: [],
  formerNames: [],
  localLanguageNames: [],
  aliases: [],
  queryAliases: [],
  isin: null,
  ticker: null,
  figiName: null,
  figiTicker: null,
  lei: null,
  verifiedDomains: [],
  domainCandidates: [],
  country: null,
  supportedLanguages: [],
  resolvedAt: new Date().toISOString(),
  pipelineVersion: "test",
};

// Two unrelated documents (neither matches the issuer) -> both rejected.
const REJECTABLE_CHUNKS: Chunk[] = [
  { text: "some unrelated content about widgets", docIndex: 0, docUrl: "https://example.com/a", docTitle: "Alpha Widgets 2025" },
  { text: "more unrelated content about gadgets", docIndex: 1, docUrl: "https://other.com/b", docTitle: "Beta Gadgets 2024" },
];

function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.map(String).join(" ")); };
  try { return { result: fn(), warnings }; }
  finally { console.warn = orig; }
}

test("CHANGE 2: all-rejected corpus fails open (non-empty keep + loud diagnostic)", () => {
  const prev = process.env.CHUNK_GATE_FAIL_OPEN;
  delete process.env.CHUNK_GATE_FAIL_OPEN; // default-on
  try {
    const { result, warnings } = captureWarn(() =>
      applyChunkSanityGate(REJECTABLE_CHUNKS, { issuerProfile: ISSUER }),
    );
    // Every input group was rejected...
    assert.ok(result.rejected.length >= 1, "some docs rejected");
    // ...but fail-open kept at least one chunk (never hands retrieval an empty pool).
    assert.ok(result.keep.length >= 1, "fail-open kept least-bad chunk(s)");
    // ...and it was loud and greppable.
    assert.ok(
      warnings.some((w) => w.includes("[CHUNK_GATE_FAIL_OPEN]") && w.includes("fail-open")),
      "loud [CHUNK_GATE_FAIL_OPEN] diagnostic emitted",
    );
  } finally {
    if (prev === undefined) delete process.env.CHUNK_GATE_FAIL_OPEN;
    else process.env.CHUNK_GATE_FAIL_OPEN = prev;
  }
});

test("CHANGE 2: flag off (CHUNK_GATE_FAIL_OPEN=false) still empties the pool", () => {
  const prev = process.env.CHUNK_GATE_FAIL_OPEN;
  process.env.CHUNK_GATE_FAIL_OPEN = "false";
  try {
    const { result, warnings } = captureWarn(() =>
      applyChunkSanityGate(REJECTABLE_CHUNKS, { issuerProfile: ISSUER, preserveIfOnlySource: true }),
    );
    assert.equal(result.keep.length, 0, "prior behaviour: pool emptied");
    assert.ok(result.rejected.length >= 1, "docs still rejected");
    assert.equal(
      warnings.filter((w) => w.includes("[CHUNK_GATE_FAIL_OPEN]")).length,
      0,
      "no fail-open diagnostic when flag off",
    );
  } finally {
    if (prev === undefined) delete process.env.CHUNK_GATE_FAIL_OPEN;
    else process.env.CHUNK_GATE_FAIL_OPEN = prev;
  }
});

test("CHANGE 2: preserveIfOnlySource keeps the sole rejected source (loud)", () => {
  const prev = process.env.CHUNK_GATE_FAIL_OPEN;
  delete process.env.CHUNK_GATE_FAIL_OPEN;
  const single: Chunk[] = [
    { text: "unrelated content one", docIndex: 0, docUrl: "https://only.com/x", docTitle: "Only Source 2025" },
    { text: "unrelated content two", docIndex: 0, docUrl: "https://only.com/x", docTitle: "Only Source 2025" },
  ];
  try {
    const { result, warnings } = captureWarn(() =>
      applyChunkSanityGate(single, { issuerProfile: ISSUER, preserveIfOnlySource: true }),
    );
    assert.ok(result.keep.length >= 1, "only-source chunks preserved");
    assert.ok(
      warnings.some((w) => w.includes("[CHUNK_GATE_FAIL_OPEN]")),
      "loud diagnostic emitted for preserveIfOnlySource",
    );
  } finally {
    if (prev === undefined) delete process.env.CHUNK_GATE_FAIL_OPEN;
    else process.env.CHUNK_GATE_FAIL_OPEN = prev;
  }
});

test("CHANGE 2: a passing corpus is unaffected by the flag (no fail-open needed)", () => {
  const prev = process.env.CHUNK_GATE_FAIL_OPEN;
  delete process.env.CHUNK_GATE_FAIL_OPEN;
  try {
    // No issuerProfile -> entity checks skipped; recent year -> nothing rejected.
    const good: Chunk[] = [
      { text: "clean chunk", docIndex: 0, docUrl: "https://x.com/doc", docTitle: "Report 2025" },
    ];
    const { result, warnings } = captureWarn(() =>
      applyChunkSanityGate(good, { currentYear: 2025 }),
    );
    assert.equal(result.keep.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(warnings.filter((w) => w.includes("[CHUNK_GATE_FAIL_OPEN]")).length, 0);
  } finally {
    if (prev === undefined) delete process.env.CHUNK_GATE_FAIL_OPEN;
    else process.env.CHUNK_GATE_FAIL_OPEN = prev;
  }
});
