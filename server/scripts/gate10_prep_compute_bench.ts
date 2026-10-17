/**
 * GATE10 — B1 / WP10 prep-stage compute benchmark (offline, bounded, free).
 *
 * WHAT THIS MEASURES
 *   B1 removes recomputed prep-stage work WITHOUT changing output:
 *     (1) PEER-SCAN REGEX — scoreAboutness() runs one Unicode word-boundary regex
 *         per peer per document, across the full ~2,675-peer universe. B1 compiles
 *         each pattern once and reuses it.
 *     (2) BM25 PER-DOC TERM MAPS — bm25Score() re-tokenises the document and
 *         rebuilds its term-frequency Map on every (chunk × measure) call. B1
 *         precomputes those maps once in buildBM25Index().
 *   This script drives BOTH on a real on-disk fixture corpus, with the optimisation
 *   OFF (PREP_COMPUTE_CACHE_POLICY=off, exact pre-B1 path) vs ON, and reports
 *   p50/p95 wall-clock for each.
 *
 * BYTE-IDENTICAL GUARD (acceptance gate, enforced in-script)
 *   Before timing, the script asserts the OUTPUT is identical OFF vs ON:
 *     • scoreAboutness() result object for every document, and
 *     • bm25Score() for every (measure-query × chunk) pair, incl. the full ranking
 *       with its tie-break order.
 *   If any differ, the script exits non-zero and reports FAIL — a timing win is
 *   only accepted on top of byte-identical output.
 *
 * PEER UNIVERSE: a deterministic 2,675-name universe is synthesised (real seed
 *   names from var_companies.json + deterministic distinct fillers). The FULL
 *   universe is used — nothing is cut to a subset (that is corpus-pinning and is
 *   forbidden).
 *
 * COST: free. Pure string/regex/BM25 over a local fixture. No DB, no network, no
 *   model call. (A dummy DATABASE_URL is only needed so transitively-imported
 *   modules construct their lazy pool; no query is ever issued.)
 *
 * USAGE
 *   DATABASE_URL=postgres://u:p@localhost:5432/x \
 *     npx tsx server/scripts/gate10_prep_compute_bench.ts [companyId] [repeats]
 *   companyId default: 1 (Nestlé fixture, 104 docs ~8 MB). repeats default: 3.
 *
 * OUTPUT: ~/gate10_out/gate10_prep_compute_bench.{json,md}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { scoreAboutness, type AboutnessResult } from "../lib/aboutness.js";
import {
  buildBM25Index,
  bm25Score,
  chunkDocuments,
  tokenize,
  type BM25Index,
} from "../lib/passage-retrieval.js";
import {
  clearPeerRegexCache,
  peerRegexCacheSize,
  isPrepComputeCacheEnabled,
} from "../lib/prep-compute-cache.js";

const HOME = process.env.HOME || "/home/ubuntu";
const OUT_DIR = process.env.GATE10_OUT_DIR || `${HOME}/gate10_out`;
const CORPUS_DIR = process.env.VAR_CORPUS_DIR || `${HOME}/var_corpus`;
const COMPANIES_PATH = process.env.VAR_COMPANIES_PATH || `${HOME}/var_companies.json`;

const companyId = Number(process.argv[2] || "1");
const REPEATS = Math.max(1, Number(process.argv[3] || "3"));
const PEER_UNIVERSE_SIZE = 2675; // full universe — do NOT cut.

// ─── helpers ──────────────────────────────────────────────────────────────────

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6; // ms
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function summarise(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
    mean: s.length ? sum / s.length : 0,
    total: sum,
  };
}
function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(3)}ms`;
}
function pctDelta(off: number, on: number): string {
  if (off === 0) return "n/a";
  return `${(((off - on) / off) * 100).toFixed(1)}%`;
}

// ─── fixture loading ────────────────────────────────────────────────────────────

interface CorpusDoc { url: string; title: string; text: string; }

function loadCorpus(id: number): CorpusDoc[] {
  const path = `${CORPUS_DIR}/${id}.json`;
  if (!existsSync(path)) throw new Error(`corpus fixture not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as CorpusDoc[];
}

function targetName(id: number): string {
  try {
    const list = JSON.parse(readFileSync(COMPANIES_PATH, "utf8")) as Array<{ id: number; name: string }>;
    const hit = list.find((c) => c.id === id);
    if (hit) return hit.name;
  } catch { /* fall through */ }
  return "Nestlé";
}

/**
 * Deterministic 2,675-name peer universe. Seeds with the real company names from
 * var_companies.json (so the workload includes genuine multi-word / Unicode /
 * punctuation names), then appends deterministic distinct fillers to reach the
 * full universe size. Fully reproducible; no company/topic pinning.
 */
function buildPeerUniverse(size: number, excludeName: string): string[] {
  const seeds: string[] = [];
  try {
    const list = JSON.parse(readFileSync(COMPANIES_PATH, "utf8")) as Array<{ id: number; name: string }>;
    for (const c of list) if (c.name && c.name.toLowerCase() !== excludeName.toLowerCase()) seeds.push(c.name);
  } catch { /* seeds optional */ }
  const SUFFIXES = ["Group", "Holdings", "Industries", "Partners", "Capital", "Global", "Technologies", "Systems"];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (n: string) => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } };
  for (const s of seeds) push(s);
  let i = 0;
  while (out.length < size) {
    const suf = SUFFIXES[i % SUFFIXES.length];
    // Deterministic, pronounceable-ish distinct names (e.g. "Veltar Capital 0137").
    const stem = `Peer${((i * 2654435761) % 100000).toString(36)}`;
    push(`${stem} ${suf} ${String(i).padStart(4, "0")}`);
    i++;
  }
  return out.slice(0, size);
}

// Synthetic, framework-level measure query sets (ESG-style terms, not topic-pinned
// to any one framework) — deterministic. ~36 sets mirrors a typical framework.
function buildMeasureQueries(): string[][] {
  const BASES = [
    "carbon emissions scope greenhouse gas", "water usage supply chain stewardship",
    "board governance independence diversity", "human rights labour supply chain",
    "executive compensation pay ratio", "climate risk transition scenario",
    "renewable energy procurement targets", "waste circular economy recycling",
    "data privacy cybersecurity breach", "health safety workforce incident",
    "biodiversity deforestation land use", "tax transparency jurisdiction reporting",
    "anti corruption bribery ethics", "community investment philanthropy impact",
    "product quality recall safety", "supplier audit code conduct",
    "diversity inclusion gender pay", "net zero target commitment pathway",
  ];
  const out: string[][] = [];
  for (const b of BASES) {
    out.push(tokenize(b));
    out.push(tokenize(`${b} disclosure report policy`)); // a variant → ~36 sets
  }
  return out;
}

// ─── byte-identical verification (OFF vs ON) ────────────────────────────────────

function aboutnessAll(docs: CorpusDoc[], name: string, peers: string[]): AboutnessResult[] {
  return docs.map((d) => scoreAboutness(d.text, name, [], peers));
}

function bm25All(index: BM25Index, queries: string[][]): number[] {
  const out: number[] = [];
  for (const q of queries) for (let i = 0; i < index.documents.length; i++) out.push(bm25Score(q, i, index));
  return out;
}

function rankAll(index: BM25Index, queries: string[][]): string {
  // Full ranking per query with the representative (score desc, index asc)
  // tie-break — identical arrays ⇒ identical downstream ordering.
  const parts: string[] = [];
  for (const q of queries) {
    const scored = index.documents.map((_, i) => ({ i, s: bm25Score(q, i, index) }));
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    parts.push(scored.map((x) => `${x.i}:${x.s.toFixed(10)}`).join(","));
  }
  return parts.join("|");
}

// ─── main ────────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const docs = loadCorpus(companyId);
  const name = targetName(companyId);
  const peers = buildPeerUniverse(PEER_UNIVERSE_SIZE, name);
  const combined = docs.map((d) => `\n\n--- DOCUMENT: ${d.title} [${d.url}] ---\n\n${d.text}`).join("");
  const chunks = chunkDocuments(combined).map((c) => c.text);
  const queries = buildMeasureQueries();

  console.log(`[gate10] company=${companyId} name="${name}" docs=${docs.length} chunks=${chunks.length} peers=${peers.length} queries=${queries.length} repeats=${REPEATS}`);
  if (peers.length !== PEER_UNIVERSE_SIZE) throw new Error(`peer universe must be ${PEER_UNIVERSE_SIZE}, got ${peers.length}`);

  // ── 1) BYTE-IDENTICAL GUARD ──────────────────────────────────────────────────
  process.env.PREP_COMPUTE_CACHE_POLICY = "off";
  clearPeerRegexCache();
  const aboutOff = aboutnessAll(docs, name, peers);
  const idxOff = buildBM25Index(chunks);
  const bm25Off = bm25All(idxOff, queries);
  const rankOff = rankAll(idxOff, queries);

  process.env.PREP_COMPUTE_CACHE_POLICY = "on";
  clearPeerRegexCache();
  const aboutOn = aboutnessAll(docs, name, peers);
  const idxOn = buildBM25Index(chunks);
  const bm25On = bm25All(idxOn, queries);
  const rankOn = rankAll(idxOn, queries);

  const aboutIdentical = JSON.stringify(aboutOff) === JSON.stringify(aboutOn);
  const bm25Identical = JSON.stringify(bm25Off) === JSON.stringify(bm25On);
  const rankIdentical = rankOff === rankOn;
  const byteIdentical = aboutIdentical && bm25Identical && rankIdentical;

  console.log(`[gate10] byte-identical: aboutness=${aboutIdentical} bm25=${bm25Identical} rank/tie-break=${rankIdentical} → ${byteIdentical ? "PASS" : "FAIL"}`);

  // ── 2) TIMING — aboutness (per-document samples) ─────────────────────────────
  const aboutSamplesOff: number[] = [];
  const aboutSamplesOn: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    process.env.PREP_COMPUTE_CACHE_POLICY = "off";
    clearPeerRegexCache();
    for (const d of docs) { const t = now(); scoreAboutness(d.text, name, [], peers); aboutSamplesOff.push(now() - t); }

    process.env.PREP_COMPUTE_CACHE_POLICY = "on";
    if (r === 0) clearPeerRegexCache(); // warm the regex cache on first ON repeat (prod is long-lived)
    for (const d of docs) { const t = now(); scoreAboutness(d.text, name, [], peers); aboutSamplesOn.push(now() - t); }
  }

  // ── 3) TIMING — BM25 (per measure-query full-corpus scan samples) ─────────────
  const bm25SamplesOff: number[] = [];
  const bm25SamplesOn: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    // OFF: index has no precomputed maps; every bm25Score re-tokenises.
    process.env.PREP_COMPUTE_CACHE_POLICY = "off";
    const io = buildBM25Index(chunks);
    for (const q of queries) { const t = now(); for (let i = 0; i < io.documents.length; i++) bm25Score(q, i, io); bm25SamplesOff.push(now() - t); }

    // ON: index precomputes per-doc term maps once; bm25Score reuses them.
    process.env.PREP_COMPUTE_CACHE_POLICY = "on";
    const in_ = buildBM25Index(chunks);
    for (const q of queries) { const t = now(); for (let i = 0; i < in_.documents.length; i++) bm25Score(q, i, in_); bm25SamplesOn.push(now() - t); }
  }

  // ── 4) TIMING — buildBM25Index itself (ON does more work at build) ────────────
  const buildOff: number[] = [];
  const buildOn: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    process.env.PREP_COMPUTE_CACHE_POLICY = "off";
    { const t = now(); buildBM25Index(chunks); buildOff.push(now() - t); }
    process.env.PREP_COMPUTE_CACHE_POLICY = "on";
    { const t = now(); buildBM25Index(chunks); buildOn.push(now() - t); }
  }

  const result = {
    gate: "GATE10",
    workPackage: "B1 / WP10",
    killSwitch: { env: "PREP_COMPUTE_CACHE_POLICY", default: "on" },
    timestamp: new Date().toISOString(),
    fixture: { companyId, name, docs: docs.length, chunks: chunks.length, peerUniverse: peers.length, measureQueries: queries.length, repeats: REPEATS },
    byteIdentical: { aboutness: aboutIdentical, bm25: bm25Identical, rankTieBreak: rankIdentical, overall: byteIdentical },
    regexCacheSizeAfterWarm: peerRegexCacheSize(),
    aboutness: { off: summarise(aboutSamplesOff), on: summarise(aboutSamplesOn) },
    bm25Scoring: { off: summarise(bm25SamplesOff), on: summarise(bm25SamplesOn) },
    bm25IndexBuild: { off: summarise(buildOff), on: summarise(buildOn) },
  };

  const jsonPath = `${OUT_DIR}/gate10_prep_compute_bench.json`;
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const a = result.aboutness, b = result.bm25Scoring, bi = result.bm25IndexBuild;
  const md = `# GATE10 — B1 / WP10 prep-stage compute benchmark

- **Kill-switch**: \`PREP_COMPUTE_CACHE_POLICY\` (default \`on\`)
- **Fixture**: company ${companyId} ("${name}") — ${docs.length} docs, ${chunks.length} chunks, **${peers.length}-peer universe (full, uncut)**, ${queries.length} measure queries, ${REPEATS} repeats
- **Generated**: ${result.timestamp}

## Byte-identical guard (acceptance gate)

| Output | OFF == ON |
|---|---|
| scoreAboutness (per doc) | ${aboutIdentical ? "✅ identical" : "❌ DIFFERS"} |
| bm25Score (per query×chunk) | ${bm25Identical ? "✅ identical" : "❌ DIFFERS"} |
| BM25 ranking + tie-breaks | ${rankIdentical ? "✅ identical" : "❌ DIFFERS"} |
| **Overall** | ${byteIdentical ? "✅ **PASS**" : "❌ **FAIL**"} |

## Timing — peer-scan aboutness (per-document latency, ${a.off.n} samples)

| metric | OFF (pre-B1) | ON (B1) | improvement |
|---|---|---|---|
| p50 | ${fmt(a.off.p50)} | ${fmt(a.on.p50)} | ${pctDelta(a.off.p50, a.on.p50)} |
| p95 | ${fmt(a.off.p95)} | ${fmt(a.on.p95)} | ${pctDelta(a.off.p95, a.on.p95)} |
| mean | ${fmt(a.off.mean)} | ${fmt(a.on.mean)} | ${pctDelta(a.off.mean, a.on.mean)} |
| total | ${fmt(a.off.total)} | ${fmt(a.on.total)} | ${pctDelta(a.off.total, a.on.total)} |

## Timing — BM25 scoring (per measure-query full-corpus scan, ${b.off.n} samples)

| metric | OFF (pre-B1) | ON (B1) | improvement |
|---|---|---|---|
| p50 | ${fmt(b.off.p50)} | ${fmt(b.on.p50)} | ${pctDelta(b.off.p50, b.on.p50)} |
| p95 | ${fmt(b.off.p95)} | ${fmt(b.on.p95)} | ${pctDelta(b.off.p95, b.on.p95)} |
| mean | ${fmt(b.off.mean)} | ${fmt(b.on.mean)} | ${pctDelta(b.off.mean, b.on.mean)} |
| total | ${fmt(b.off.total)} | ${fmt(b.on.total)} | ${pctDelta(b.off.total, b.on.total)} |

## Timing — buildBM25Index (index build; ON precomputes term maps here)

| metric | OFF (pre-B1) | ON (B1) | delta |
|---|---|---|---|
| p50 | ${fmt(bi.off.p50)} | ${fmt(bi.on.p50)} | ${pctDelta(bi.off.p50, bi.on.p50)} |
| p95 | ${fmt(bi.off.p95)} | ${fmt(bi.on.p95)} | ${pctDelta(bi.off.p95, bi.on.p95)} |

> Note: B1 shifts per-doc term-map construction INTO buildBM25Index (one-time) so
> it is paid once instead of on every (chunk × measure) bm25Score call. The net
> prep-stage win is the BM25-scoring table above (many calls) minus the small
> one-time build cost here. Numbers are measured on this VM; no value is fabricated.
`;
  const mdPath = `${OUT_DIR}/gate10_prep_compute_bench.md`;
  writeFileSync(mdPath, md);

  console.log(`[gate10] wrote ${jsonPath}`);
  console.log(`[gate10] wrote ${mdPath}`);
  console.log(`[gate10] aboutness p50 OFF=${fmt(a.off.p50)} ON=${fmt(a.on.p50)} (${pctDelta(a.off.p50, a.on.p50)}) | p95 OFF=${fmt(a.off.p95)} ON=${fmt(a.on.p95)} (${pctDelta(a.off.p95, a.on.p95)})`);
  console.log(`[gate10] bm25     p50 OFF=${fmt(b.off.p50)} ON=${fmt(b.on.p50)} (${pctDelta(b.off.p50, b.on.p50)}) | p95 OFF=${fmt(b.off.p95)} ON=${fmt(b.on.p95)} (${pctDelta(b.off.p95, b.on.p95)})`);

  if (!byteIdentical) {
    console.error("[gate10] FAIL: output is not byte-identical OFF vs ON — rejecting.");
    process.exit(1);
  }
}

main();
