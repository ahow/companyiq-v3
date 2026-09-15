/**
 * Tests for retrieval-stability changes (B2 deterministic tie-break, B4 query
 * expansion union).
 * node:test — run with:
 *   DATABASE_URL="postgres://u:p@localhost:5432/x" npx tsx --test server/lib/retrieval-stability.test.ts
 *
 * GENERIC: fixtures are synthetic; nothing references a specific measure/company.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableChunkKey, compareStableByChunk } from "./passage-rescore.js";
import { expandQueries } from "./query-expansion.js";

// ─── B2: deterministic stable tie-break for equal-score chunks ────────────────

function chunk(docUrl: string, docIndex: number, seqInDoc: number, text = "t"): any {
  return { text, docIndex, docUrl, seqInDoc };
}

test("B2: compareStableByChunk yields a total order independent of input array order", () => {
  // Three chunks that would tie on a primary score. Their stable order is fixed
  // by (docUrl, docIndex, seqInDoc, idx).
  const a = { chunk: chunk("https://a.example/doc", 0, 2), idx: 0 };
  const b = { chunk: chunk("https://a.example/doc", 0, 1), idx: 1 };
  const c = { chunk: chunk("https://b.example/doc", 1, 0), idx: 2 };

  const perm1 = [a, b, c].slice().sort(compareStableByChunk);
  const perm2 = [c, a, b].slice().sort(compareStableByChunk);
  const perm3 = [b, c, a].slice().sort(compareStableByChunk);

  const keys1 = perm1.map((x) => stableChunkKey(x.chunk, x.idx));
  const keys2 = perm2.map((x) => stableChunkKey(x.chunk, x.idx));
  const keys3 = perm3.map((x) => stableChunkKey(x.chunk, x.idx));

  assert.deepEqual(keys1, keys2, "permutation 2 must resolve to the same order");
  assert.deepEqual(keys1, keys3, "permutation 3 must resolve to the same order");
  // Same-doc chunks ordered by seqInDoc; b (seq 1) before a (seq 2); different-doc last.
  assert.deepEqual(perm1.map((x) => x.idx), [1, 0, 2]);
});

test("B2: a blended-score sort with the tie-break is stable under input permutation", () => {
  // Simulate the analyzer/rescorer pattern: primary score desc, then stable key.
  const items = [
    { c: { chunk: chunk("https://a/doc", 0, 5), idx: 0 }, final: 5 },
    { c: { chunk: chunk("https://a/doc", 0, 1), idx: 1 }, final: 5 }, // ties with above
    { c: { chunk: chunk("https://a/doc", 0, 9), idx: 2 }, final: 8 }, // highest
  ];
  const sortFn = (x: any, y: any) => (y.final - x.final) || compareStableByChunk(x.c, y.c);

  const order1 = items.slice().sort(sortFn).map((x) => x.c.idx);
  const order2 = [items[2], items[0], items[1]].slice().sort(sortFn).map((x) => x.c.idx);
  const order3 = [items[1], items[2], items[0]].slice().sort(sortFn).map((x) => x.c.idx);

  // Highest score first; tie broken by seqInDoc (1 before 5).
  assert.deepEqual(order1, [2, 1, 0]);
  assert.deepEqual(order1, order2);
  assert.deepEqual(order1, order3);
});

// ─── B4: query-expansion UNION of qualifyingInstance + generic queries ────────

function profile(): any {
  return {
    figiName: "Acme Corporation",
    legalName: "Acme Corporation",
    queryAliases: ["acme corporation", "acme"],
    supportedLanguages: ["en"],
    localLanguageNames: [],
  };
}

test("B4: qualifyingInstances produce dedicated queries UNIONed with the generic set", () => {
  const withQI = expandQueries({
    profile: profile(),
    evidenceKeywords: ["board oversight", "risk committee"],
    requiredDocTypes: [],
    topicPhrases: ["governance"],
    qualifyingInstances: [
      "A Board-approved AI governance policy with a dated commitment",
      "A named risk-management system for model risk",
    ],
    maxTotal: 40,
  });

  assert.ok(
    withQI.diagnostics.qualifyingInstanceQueries >= 2,
    "should generate a query per qualifying instance",
  );
  // The generic evidence-keyword queries are STILL present (union, not replacement).
  assert.ok(
    withQI.diagnostics.evidenceKeywordQueries >= 2,
    "generic evidence-keyword queries must still be generated",
  );
  // A qualifying-instance query actually appears in the final set and carries the phrase.
  const qiQueries = withQI.queries.filter((q) => q.source === "qualifying-instance");
  assert.ok(qiQueries.length >= 1, "final query set includes qualifying-instance queries");
  assert.ok(
    qiQueries.some((q) => q.query.includes("Board-approved AI governance policy")),
    "a qualifying-instance query carries the authored phrase",
  );
});

test("B4: absent qualifyingInstances → generic-only query set (backward compatible)", () => {
  const generic = expandQueries({
    profile: profile(),
    evidenceKeywords: ["board oversight", "risk committee"],
    requiredDocTypes: [],
    topicPhrases: ["governance"],
    // qualifyingInstances omitted entirely
    maxTotal: 40,
  });
  assert.equal(generic.diagnostics.qualifyingInstanceQueries, 0, "no qualifying-instance queries");
  assert.ok(generic.queries.every((q) => q.source !== "qualifying-instance"));
  // Generic queries are unaffected.
  assert.ok(generic.diagnostics.evidenceKeywordQueries >= 2);
});

test("B4: query expansion is deterministic — same inputs produce identical output", () => {
  const opts = {
    profile: profile(),
    evidenceKeywords: ["board oversight", "risk committee"],
    requiredDocTypes: [],
    topicPhrases: ["governance"],
    qualifyingInstances: ["A named risk-management system for model risk"],
    maxTotal: 40,
  };
  const a = expandQueries(opts).queries.map((q) => q.query);
  const b = expandQueries(opts).queries.map((q) => q.query);
  assert.deepEqual(a, b);
});
