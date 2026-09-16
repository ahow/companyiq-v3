import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containsQuantifiedFigure,
  stripRepeatedStructuralBlocks,
  computeAssemblyPenaltyFactors,
  type ChunkLike,
} from "./corpus-boilerplate.js";

// ─── containsQuantifiedFigure ───────────────────────────────────────────────

test("figure detector: catches numbers, percent, currency, magnitude words", () => {
  assert.equal(containsQuantifiedFigure("we reduced emissions by 42%"), true);
  assert.equal(containsQuantifiedFigure("invested $3 across programmes"), true);
  assert.equal(containsQuantifiedFigure("three million tonnes"), true);
  assert.equal(containsQuantifiedFigure("a general statement of intent"), false);
});

// ─── (3c) stripRepeatedStructuralBlocks ─────────────────────────────────────

function corpus(docs: Array<{ title: string; body: string }>): string {
  return docs.map((d) => `\n\n--- DOCUMENT: ${d.title} [http://x/${d.title}] ---\n\n${d.body}`).join("");
}

test("3c: strips a footer line that recurs across >= 3 distinct documents", () => {
  const footer = "Copyright Acme Holdings all rights reserved";
  const c = corpus([
    { title: "a", body: `Unique alpha content here.\n${footer}` },
    { title: "b", body: `Unique beta content here.\n${footer}` },
    { title: "c", body: `Unique gamma content here.\n${footer}` },
  ]);
  const res = stripRepeatedStructuralBlocks(c);
  assert.ok(res.strippedLines >= 3, `expected >=3 stripped, got ${res.strippedLines}`);
  assert.ok(res.patterns >= 1);
  assert.ok(!res.text.includes(footer), "footer should be gone");
  // Unique content and provenance headers survive.
  assert.ok(res.text.includes("Unique alpha content here."));
  assert.ok(res.text.includes("--- DOCUMENT: a"));
});

test("3c: does NOT strip a line that recurs in only 2 documents (below threshold)", () => {
  const footer = "shared tagline text only twice";
  const c = corpus([
    { title: "a", body: `alpha\n${footer}` },
    { title: "b", body: `beta\n${footer}` },
    { title: "c", body: `gamma without it` },
  ]);
  const res = stripRepeatedStructuralBlocks(c);
  assert.equal(res.strippedLines, 0);
  assert.ok(res.text.includes(footer));
});

test("3c: never strips a repeated line carrying a quantified figure", () => {
  const figLine = "revenue grew by 12 across the year";
  const c = corpus([
    { title: "a", body: `alpha\n${figLine}` },
    { title: "b", body: `beta\n${figLine}` },
    { title: "c", body: `gamma\n${figLine}` },
    { title: "d", body: `delta\n${figLine}` },
  ]);
  const res = stripRepeatedStructuralBlocks(c);
  assert.equal(res.strippedLines, 0);
  assert.ok(res.text.includes(figLine));
});

test("3c: never strips a repeated line containing a curated discriminator", () => {
  const line = "our nightingale programme statement";
  const c = corpus([
    { title: "a", body: `alpha\n${line}` },
    { title: "b", body: `beta\n${line}` },
    { title: "c", body: `gamma\n${line}` },
  ]);
  const res = stripRepeatedStructuralBlocks(c, { protectTerms: ["nightingale"] });
  assert.equal(res.strippedLines, 0);
  assert.ok(res.text.includes(line));
});

test("3c: returns input unchanged when corpus has a single/zero document segment", () => {
  const single = "just some text with no document headers";
  const res = stripRepeatedStructuralBlocks(single);
  assert.equal(res.text, single);
  assert.equal(res.strippedLines, 0);
});

// ─── (3a)+(3b) computeAssemblyPenaltyFactors ────────────────────────────────

// Build a boilerplate paragraph long enough to yield k=8 shingles.
const BOILER = "this standard safe harbour disclaimer paragraph is repeated verbatim in every annual filing without any change whatsoever across documents";

function repeatedAcrossDocs(nDocs: number): ChunkLike[] {
  const chunks: ChunkLike[] = [];
  for (let d = 0; d < nDocs; d++) {
    chunks.push({ text: BOILER, docIndex: d }); // identical boilerplate
    chunks.push({ text: `unique discriminating passage about widget number ${d} alpha beta gamma delta epsilon`, docIndex: d });
  }
  return chunks;
}

test("3a/3b: penalises cross-document near-duplicate boilerplate, factor < 1", () => {
  const chunks = repeatedAcrossDocs(5);
  const factors = computeAssemblyPenaltyFactors(chunks);
  // Even indices are the repeated boilerplate → penalised.
  assert.ok(factors[0] < 1, `boilerplate should be penalised, got ${factors[0]}`);
  // Gentle: never drops the score to zero or below ~0.5.
  assert.ok(factors[0] > 0.5, `penalty must be gentle, got ${factors[0]}`);
});

test("3a/3b: a chunk with a quantified figure is protected (factor 1) even if repeated", () => {
  const chunks: ChunkLike[] = [];
  const figBoiler = BOILER + " and it reported exactly 100 units";
  for (let d = 0; d < 5; d++) chunks.push({ text: figBoiler, docIndex: d });
  const factors = computeAssemblyPenaltyFactors(chunks);
  for (const f of factors) assert.equal(f, 1);
});

test("3a/3b: a chunk containing a curated discriminator is protected (factor 1)", () => {
  const chunks: ChunkLike[] = [];
  const discBoiler = BOILER + " nightingale";
  for (let d = 0; d < 5; d++) chunks.push({ text: discBoiler, docIndex: d });
  const factors = computeAssemblyPenaltyFactors(chunks, { protectTerms: ["nightingale"] });
  for (const f of factors) assert.equal(f, 1);
});

test("3a/3b: a chunk matching a framework dataPattern is protected (factor 1)", () => {
  const chunks: ChunkLike[] = [];
  const discBoiler = BOILER + " modern slavery statement";
  for (let d = 0; d < 5; d++) chunks.push({ text: discBoiler, docIndex: d });
  const factors = computeAssemblyPenaltyFactors(chunks, { protectRegexes: [/modern slavery/gi] });
  for (const f of factors) assert.equal(f, 1);
});

test("3a/3b: near-unique discriminative chunk is unpenalised (factor 1)", () => {
  const chunks = repeatedAcrossDocs(5);
  const factors = computeAssemblyPenaltyFactors(chunks);
  // Odd indices are the unique passages → not near-duplicate → factor 1.
  assert.equal(factors[1], 1);
  assert.equal(factors[3], 1);
});

test("3a/3b: tiny corpus (too few docs) yields all-1 factors (no penalty)", () => {
  const chunks: ChunkLike[] = [
    { text: BOILER, docIndex: 0 },
    { text: BOILER, docIndex: 1 },
  ];
  const factors = computeAssemblyPenaltyFactors(chunks);
  for (const f of factors) assert.equal(f, 1);
});

test("3a/3b: empty input returns empty factor array", () => {
  assert.deepEqual(computeAssemblyPenaltyFactors([]), []);
});
