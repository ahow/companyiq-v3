// B1 / WP10 — prep-compute cache: byte-identical-equivalence unit tests.
// Run: npx tsx --test server/lib/prep-compute-cache.test.ts
//
// These tests prove the exact-equivalence contract for every piece of B1:
//   (a) the cached peer-scan regex matches byte-for-byte identically to a freshly
//       rebuilt pattern, incl. Unicode / word-boundary / overlap cases, and a
//       cached GLOBAL regex is safe to reuse across .match() calls (no lastIndex
//       carry-over);
//   (b) the precomputed BM25 per-doc term-frequency maps yield identical scores,
//       rank order and tie-breaks vs the uncached recompute path;
//   (c) the kill-switch default (on) / off / on behaviour;
//   (d) cache invalidation on content change serves no stale value;
//   (e) the no-op document-upsert skip never drops a real change (it skips only a
//       byte-identical repeat, and re-writes after any invalidation), and the OFF
//       path always writes.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolvePrepComputeCachePolicy,
  isPrepComputeCacheEnabled,
  DEFAULT_PREP_COMPUTE_CACHE_POLICY,
  PREP_COMPUTE_CACHE_ENV,
  BoundedCache,
  getCachedRegex,
  peerRegexCacheSize,
  clearPeerRegexCache,
  documentUpsertFingerprint,
  shouldSkipDocumentUpsert,
  recordDocumentUpsert,
  invalidateDocumentUpsertForCompany,
  invalidateDocumentUpsertByDocId,
  clearDocumentUpsertDedupe,
  documentUpsertDedupeSize,
} from "./prep-compute-cache.js";
import { buildBM25Index, bm25Score, tokenize, type BM25Index } from "./passage-retrieval.js";
import { scoreAboutness } from "./aboutness.js";

// Restore env around each policy mutation so tests don't leak state.
function withPolicy(value: string | undefined, fn: () => void): void {
  const prev = process.env[PREP_COMPUTE_CACHE_ENV];
  if (value === undefined) delete process.env[PREP_COMPUTE_CACHE_ENV];
  else process.env[PREP_COMPUTE_CACHE_ENV] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[PREP_COMPUTE_CACHE_ENV];
    else process.env[PREP_COMPUTE_CACHE_ENV] = prev;
  }
}

// ─── (c) Kill-switch ──────────────────────────────────────────────────────────

test("(c) default policy is ON (byte-identical by construction)", () => {
  assert.equal(DEFAULT_PREP_COMPUTE_CACHE_POLICY, "on");
  withPolicy(undefined, () => {
    assert.equal(resolvePrepComputeCachePolicy(), "on");
    assert.equal(isPrepComputeCacheEnabled(), true);
  });
});

test("(c) env=off disables; env=on enables; junk falls back to default on", () => {
  withPolicy("off", () => {
    assert.equal(resolvePrepComputeCachePolicy(), "off");
    assert.equal(isPrepComputeCacheEnabled(), false);
  });
  withPolicy("on", () => {
    assert.equal(resolvePrepComputeCachePolicy(), "on");
    assert.equal(isPrepComputeCacheEnabled(), true);
  });
  withPolicy("OFF", () => assert.equal(resolvePrepComputeCachePolicy(), "off")); // case-insensitive
  withPolicy("  on  ", () => assert.equal(resolvePrepComputeCachePolicy(), "on")); // trimmed
  withPolicy("banana", () => assert.equal(resolvePrepComputeCachePolicy(), "on")); // junk → default
  withPolicy("", () => assert.equal(resolvePrepComputeCachePolicy(), "on")); // empty → default
});

test("(c) explicit arg overrides env", () => {
  withPolicy("off", () => {
    assert.equal(resolvePrepComputeCachePolicy("on"), "on");
    assert.equal(isPrepComputeCacheEnabled("on"), true);
  });
});

// ─── BoundedCache ─────────────────────────────────────────────────────────────

test("BoundedCache evicts oldest beyond cap (FIFO), bounding memory", () => {
  const c = new BoundedCache<string, number>(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.size, 3);
  c.set("d", 4); // evicts "a"
  assert.equal(c.size, 3);
  assert.equal(c.has("a"), false);
  assert.equal(c.get("d"), 4);
  // Updating an existing key keeps the slot, does not grow.
  c.set("b", 20);
  assert.equal(c.size, 3);
  assert.equal(c.get("b"), 20);
});

// ─── (a) Peer-scan regex equivalence ──────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildAboutnessRegex = (term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, "giu");

// A representative, framework-level set of tricky terms/inputs (no company-pinning).
const REGEX_CASES: Array<{ term: string; hay: string }> = [
  { term: "acme", hay: "acme ACME Acme acmetastic macme .acme, (acme)" }, // case + boundary
  { term: "coca-cola", hay: "coca-cola Coca-Cola coca-colas xcoca-cola" }, // hyphen (regex meta via esc)
  { term: "s&p", hay: "s&p S&P the s&p 500 and s&ps" }, // ampersand
  { term: "at&t", hay: "AT&T at&t at&ts (at&t)" },
  { term: "e*trade", hay: "e*trade E*TRADE e*trades" }, // asterisk meta
  { term: "yahoo!", hay: "yahoo! Yahoo! yahoo!! xyahoo!" }, // bang
  { term: "nestlé", hay: "Nestlé nestlé NESTLÉ nestléa anestlé" }, // accented Unicode letter
  { term: "zürich", hay: "Zürich zürich zürichs" }, // umlaut
  { term: "ab", hay: "ab ab ab abab ba ab" }, // repeats + adjacency
  { term: "3m", hay: "3M 3m 3ms x3m 3m." }, // digit-leading (\p{N} boundary)
  { term: "l'oréal", hay: "L'Oréal l'oréal l'oréals" }, // apostrophe + accent
];

test("(a) cached regex has identical source+flags and match counts vs rebuilt", () => {
  clearPeerRegexCache();
  for (const { term, hay } of REGEX_CASES) {
    const fresh = buildAboutnessRegex(term);
    const cached = getCachedRegex(`t\u0000${term}`, () => buildAboutnessRegex(term), "on");
    assert.equal(cached.source, fresh.source, `source mismatch for "${term}"`);
    assert.equal(cached.flags, fresh.flags, `flags mismatch for "${term}"`);
    const freshCount = hay.match(fresh)?.length ?? 0;
    const cachedCount = hay.match(cached)?.length ?? 0;
    assert.equal(cachedCount, freshCount, `count mismatch for "${term}" in "${hay}"`);
  }
});

test("(a) second call returns the SAME cached instance (memoised, not rebuilt)", () => {
  clearPeerRegexCache();
  const first = getCachedRegex("k\u00acme", () => buildAboutnessRegex("acme"), "on");
  const second = getCachedRegex("k\u00acme", () => buildAboutnessRegex("acme"), "on");
  assert.equal(first, second);
  assert.equal(peerRegexCacheSize(), 1);
});

test("(a) policy OFF never caches — always rebuilds a fresh instance", () => {
  clearPeerRegexCache();
  const a = getCachedRegex("k\u00acme", () => buildAboutnessRegex("acme"), "off");
  const b = getCachedRegex("k\u00acme", () => buildAboutnessRegex("acme"), "off");
  assert.notEqual(a, b); // fresh each time
  assert.equal(peerRegexCacheSize(), 0); // nothing cached
});

test("(a) cached GLOBAL regex is reuse-safe across .match() (no lastIndex carry-over)", () => {
  clearPeerRegexCache();
  const re = getCachedRegex("g\u00ab", () => buildAboutnessRegex("ab"), "on");
  // Reusing the same global regex many times via String#match must give a stable
  // count every time (String#match resets lastIndex before and after).
  for (let i = 0; i < 5; i++) {
    assert.equal("ab ab ab".match(re)?.length ?? 0, 3, `iteration ${i}`);
    assert.equal("ab".match(re)?.length ?? 0, 1, `iteration ${i}`);
    assert.equal("xyz".match(re)?.length ?? 0, 0, `iteration ${i}`);
  }
  // lastIndex is never left non-zero by .match() with a global regex.
  assert.equal(re.lastIndex, 0);
});

// ─── (a+) scoreAboutness end-to-end equivalence (ON vs OFF) ────────────────────

test("(a+) scoreAboutness is byte-identical ON vs OFF across varied docs", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");
  const docs: Array<{ text: string; name: string; aliases: string[]; peers: string[] }> = [
    { text: `Acmeco Analyst Report 2025. Acmeco grew. ${filler(300)} Our strategy at Acmeco.`, name: "Acmeco Holdings", aliases: [], peers: ["zentrix group", "nestlé"] },
    { text: `${filler(400)} Zentrix Group revenue rose. ${filler(40)} Hosted by acmeco.`, name: "Acmeco", aliases: ["acme co"], peers: ["zentrix group"] },
    { text: `Nestlé factbook ${filler(200)} Nestlé Zürich L'Oréal Coca-Cola S&P`, name: "Nestlé", aliases: [], peers: ["l'oréal", "coca-cola", "s&p", "zürich"] },
    { text: `${filler(1000)}`, name: "Acmeco", aliases: [], peers: ["zentrix group"] },
  ];
  for (const d of docs) {
    let off!: ReturnType<typeof scoreAboutness>;
    let on!: ReturnType<typeof scoreAboutness>;
    withPolicy("off", () => { clearPeerRegexCache(); off = scoreAboutness(d.text, d.name, d.aliases, d.peers); });
    withPolicy("on", () => { clearPeerRegexCache(); on = scoreAboutness(d.text, d.name, d.aliases, d.peers); });
    assert.deepEqual(on, off, `scoreAboutness differs ON vs OFF for "${d.name}"`);
  }
});

// ─── (b) BM25 term-map equivalence: scores + rank + tie-breaks ─────────────────

// A deterministic, framework-level synthetic corpus (no company/topic pinning).
function makeCorpus(): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) {
    const reps = (i % 5) + 1;
    chunks.push(
      (`carbon emissions scope governance board ` .repeat(reps) +
        `water supply chain ${"policy ".repeat(i % 3)} ` +
        `report ${i} ${"disclosure ".repeat((i % 4) + 1)}`).trim(),
    );
  }
  // Include two byte-identical chunks to force a genuine score tie.
  chunks.push("alpha beta gamma delta alpha beta");
  chunks.push("alpha beta gamma delta alpha beta");
  return chunks;
}

const QUERIES = [
  "carbon emissions scope",
  "water supply chain policy",
  "governance board disclosure",
  "alpha beta",
  "nonexistent token here",
].map((q) => tokenize(q));

// Rank with a representative, stable tie-break (score desc, then original index asc)
// — the same shape downstream ranking uses — so identical scores ⇒ identical order.
function rank(index: BM25Index, query: string[]): Array<{ i: number; s: number }> {
  const scored = index.documents.map((_, i) => ({ i, s: bm25Score(query, i, index) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored;
}

test("(b) ON index (cached term-maps) scores identically to recompute path", () => {
  let onIndex!: BM25Index;
  withPolicy("on", () => { onIndex = buildBM25Index(makeCorpus()); });
  assert.ok(onIndex.termFreqsByDoc, "ON index must carry precomputed term-freq maps");
  assert.equal(onIndex.termFreqsByDoc!.length, onIndex.documents.length);

  // Clone the index but strip the cached maps → forces bm25Score's recompute path.
  const recomputeIndex: BM25Index = { ...onIndex, termFreqsByDoc: undefined };

  for (const q of QUERIES) {
    for (let i = 0; i < onIndex.documents.length; i++) {
      const cached = bm25Score(q, i, onIndex);
      const recomputed = bm25Score(q, i, recomputeIndex);
      assert.equal(cached, recomputed, `score mismatch doc ${i} query "${q.join(" ")}"`);
    }
  }
});

test("(b) buildBM25Index ON vs OFF: identical docFreqs/docLengths/avg + scores", () => {
  const corpus = makeCorpus();
  let onIndex!: BM25Index;
  let offIndex!: BM25Index;
  withPolicy("on", () => { onIndex = buildBM25Index(corpus); });
  withPolicy("off", () => { offIndex = buildBM25Index(corpus); });

  assert.equal(offIndex.termFreqsByDoc, undefined, "OFF index must NOT precompute maps");
  assert.deepEqual(onIndex.docLengths, offIndex.docLengths);
  assert.equal(onIndex.avgDocLength, offIndex.avgDocLength);
  assert.equal(onIndex.totalDocs, offIndex.totalDocs);
  assert.deepEqual([...onIndex.docFreqs.entries()].sort(), [...offIndex.docFreqs.entries()].sort());

  for (const q of QUERIES) {
    for (let i = 0; i < corpus.length; i++) {
      assert.equal(bm25Score(q, i, onIndex), bm25Score(q, i, offIndex), `score mismatch doc ${i}`);
    }
  }
});

test("(b) rank order AND tie-breaks are identical ON vs OFF", () => {
  const corpus = makeCorpus();
  let onIndex!: BM25Index;
  let offIndex!: BM25Index;
  withPolicy("on", () => { onIndex = buildBM25Index(corpus); });
  withPolicy("off", () => { offIndex = buildBM25Index(corpus); });
  for (const q of QUERIES) {
    const onRank = rank(onIndex, q);
    const offRank = rank(offIndex, q);
    assert.deepEqual(onRank, offRank, `rank/tie-break mismatch for query "${q.join(" ")}"`);
  }
  // Sanity: the two byte-identical chunks really do tie, exercising the tie-break.
  const tieQ = tokenize("alpha beta");
  const n = onIndex.documents.length;
  assert.equal(bm25Score(tieQ, n - 1, onIndex), bm25Score(tieQ, n - 2, onIndex));
});

// ─── (d) Invalidation on content change (no stale serve) ───────────────────────

test("(d) different corpus content → different index, never a stale cached map", () => {
  let idxA!: BM25Index;
  let idxB!: BM25Index;
  withPolicy("on", () => {
    idxA = buildBM25Index(["carbon emissions report", "water policy disclosure"]);
    idxB = buildBM25Index(["alpha beta gamma", "delta epsilon zeta"]);
  });
  // Each build has its OWN term-freq maps keyed to its own content (content-keyed
  // by construction — the maps live on the index object, not a shared store).
  assert.notEqual(idxA.termFreqsByDoc, idxB.termFreqsByDoc);
  const q = tokenize("carbon emissions");
  assert.ok(bm25Score(q, 0, idxA) > 0, "idxA doc0 should match 'carbon emissions'");
  assert.equal(bm25Score(q, 0, idxB), 0, "idxB doc0 must NOT serve idxA's stale score");
});

// ─── (e) No-op document-upsert skip — never drops a real write ─────────────────

test("(e) fingerprint distinguishes null vs empty string and field changes", () => {
  const base = documentUpsertFingerprint({ title: "t", gateVerdict: "accept", gateReason: "r", sourceType: "issuer" });
  assert.equal(base, documentUpsertFingerprint({ title: "t", gateVerdict: "accept", gateReason: "r", sourceType: "issuer" }));
  assert.notEqual(base, documentUpsertFingerprint({ title: "t", gateVerdict: "accept", gateReason: "r", sourceType: "third_party" }));
  // null and "" must be distinguishable, and null vs undefined share the sentinel.
  assert.notEqual(
    documentUpsertFingerprint({ title: null }),
    documentUpsertFingerprint({ title: "" }),
  );
  assert.equal(
    documentUpsertFingerprint({ title: null }),
    documentUpsertFingerprint({ title: undefined }),
  );
});

test("(e) skip only an identical repeat; re-write after content change", () => {
  clearDocumentUpsertDedupe();
  withPolicy("on", () => {
    const fp1 = documentUpsertFingerprint({ title: "A", gateVerdict: "accept", gateReason: "r1", sourceType: "issuer" });
    // First write: never skipped (nothing recorded yet).
    assert.equal(shouldSkipDocumentUpsert(1, "u", fp1), false);
    recordDocumentUpsert(1, "u", fp1, 100);
    // Identical repeat → skip (true no-op).
    assert.equal(shouldSkipDocumentUpsert(1, "u", fp1), true);
    // A real change (different bytes) → must NOT skip.
    const fp2 = documentUpsertFingerprint({ title: "B", gateVerdict: "accept", gateReason: "r1", sourceType: "issuer" });
    assert.equal(shouldSkipDocumentUpsert(1, "u", fp2), false);
  });
});

test("(e) OFF policy always writes (never skips)", () => {
  clearDocumentUpsertDedupe();
  const fp = documentUpsertFingerprint({ title: "A" });
  recordDocumentUpsert(1, "u", fp, 100);
  withPolicy("off", () => {
    assert.equal(shouldSkipDocumentUpsert(1, "u", fp), false);
  });
  withPolicy("on", () => {
    assert.equal(shouldSkipDocumentUpsert(1, "u", fp), true); // same registry, ON skips
  });
});

test("(e) company invalidation forces re-write (row deletion safety)", () => {
  clearDocumentUpsertDedupe();
  withPolicy("on", () => {
    const fp = documentUpsertFingerprint({ title: "A", sourceType: "issuer" });
    recordDocumentUpsert(7, "u1", fp, 11);
    recordDocumentUpsert(7, "u2", fp, 12);
    recordDocumentUpsert(8, "u3", fp, 13);
    assert.equal(shouldSkipDocumentUpsert(7, "u1", fp), true);
    invalidateDocumentUpsertForCompany(7);
    // Company 7 entries gone → must re-write; company 8 untouched.
    assert.equal(shouldSkipDocumentUpsert(7, "u1", fp), false);
    assert.equal(shouldSkipDocumentUpsert(7, "u2", fp), false);
    assert.equal(shouldSkipDocumentUpsert(8, "u3", fp), true);
  });
});

test("(e) docId invalidation forces re-write (source_type mutation safety)", () => {
  clearDocumentUpsertDedupe();
  withPolicy("on", () => {
    const fp = documentUpsertFingerprint({ title: "A", sourceType: "issuer" });
    recordDocumentUpsert(9, "u", fp, 500);
    assert.equal(shouldSkipDocumentUpsert(9, "u", fp), true);
    invalidateDocumentUpsertByDocId(500); // e.g. updateDocumentSourceType(500, ...)
    assert.equal(shouldSkipDocumentUpsert(9, "u", fp), false);
  });
});

test("(e) full clear empties the registry", () => {
  clearDocumentUpsertDedupe();
  withPolicy("on", () => {
    recordDocumentUpsert(1, "a", documentUpsertFingerprint({ title: "x" }), 1);
    recordDocumentUpsert(2, "b", documentUpsertFingerprint({ title: "y" }), 2);
    assert.ok(documentUpsertDedupeSize() >= 2);
    clearDocumentUpsertDedupe();
    assert.equal(documentUpsertDedupeSize(), 0);
  });
});
