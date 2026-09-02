// Standalone test runner for passage-retrieval.ts's PR 1 · Change 1c
// `applyChunkSanityGate`. No Vitest/Jest dep.
// Run with:  npx tsx server/lib/passage-retrieval.test.ts
//
// Exits non-zero if any assertion fails. Covers:
//   - Empty input       → { keep: [], rejected: [], softFlagged: [] }
//   - No issuerProfile, all recent   → all kept, no rejections
//   - No issuerProfile, one 2019 doc → 2019 chunks rejected (age ≥ 5)
//   - Weak-entity: HUL doc chunks (no "unilever" in title) → rejected as no-entity
//   - Soft flag: 2023 doc (age 3, currentYear 2026) → kept, softFlagged=vintage-warning
//   - Multiple chunks from same doc share one rejection entry (chunkCount = N)
//   - preserveIfOnlySource: true accepted but no-op (identical to default)
//   - Backward-compat invariant: retrievalV2 off path never invokes the gate
//     (verified indirectly here by proving the gate is a pure function that,
//     when NOT called, cannot modify chunks — matched by analyzer.ts's
//     `if (retrievalV2 && issuerProfile)` guard).

import { applyChunkSanityGate, type Chunk } from "./passage-retrieval.js";
import type { IssuerProfile } from "./issuer-profile.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(name: string) { console.log(`\n── ${name} ──`); }

// Deterministic "current year" for stable assertions across wall-clock drift.
const CY = 2026;

function mkChunk(text: string, docUrl: string | undefined, docTitle: string | undefined, docIndex: number, seqInDoc: number): Chunk {
  return { text, docIndex, docUrl, docTitle, seqInDoc };
}

// Minimal Unilever plc profile — mirrors ranking.test.ts's fixture for
// consistency with PR 1 · Change 1b. legalName's only distinctive word after
// the generic-word filter is "unilever"; verifiedDomains is unilever.com.
function makeUnileverProfile(): IssuerProfile {
  return {
    companyId: 1,
    legalName: "Unilever PLC",
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
    verifiedDomains: ["unilever.com"],
    domainCandidates: [],
    country: "GB",
    supportedLanguages: ["en"],
    resolvedAt: new Date("2026-01-01").toISOString(),
    pipelineVersion: "test",
  };
}

section("Empty input");
{
  const r = applyChunkSanityGate([], { currentYear: CY });
  ok(r.keep.length === 0, `empty: keep is empty (got ${r.keep.length})`);
  ok(r.rejected.length === 0, `empty: rejected is empty (got ${r.rejected.length})`);
  ok(r.softFlagged.length === 0, `empty: softFlagged is empty (got ${r.softFlagged.length})`);
}

section("No issuerProfile, all recent docs → all kept, no rejections");
{
  const chunks: Chunk[] = [
    mkChunk("body A1", "https://example.com/a-2026.pdf", "Example A 2026 Report", 0, 0),
    mkChunk("body A2", "https://example.com/a-2026.pdf", "Example A 2026 Report", 0, 1),
    mkChunk("body B1", "https://example.com/b-2025.pdf", "Example B 2025 Report", 1, 0),
  ];
  const r = applyChunkSanityGate(chunks, { currentYear: CY });
  ok(r.keep.length === 3, `all recent: keep=3 (got ${r.keep.length})`);
  ok(r.rejected.length === 0, `all recent: rejected=0 (got ${r.rejected.length})`);
  ok(r.softFlagged.length === 0, `all recent: softFlagged=0 (got ${r.softFlagged.length})`);
}

section("No issuerProfile, one 2019 doc + one 2025 doc → 2019 rejected (vintage)");
{
  const chunks: Chunk[] = [
    mkChunk("old1", "https://example.com/report-2019.pdf", "Report 2019", 0, 0),
    mkChunk("old2", "https://example.com/report-2019.pdf", "Report 2019", 0, 1),
    mkChunk("new1", "https://example.com/report-2025.pdf", "Report 2025", 1, 0),
  ];
  const r = applyChunkSanityGate(chunks, { currentYear: CY });
  ok(r.keep.length === 1, `vintage: keep=1 (got ${r.keep.length})`);
  ok(r.keep[0].text === "new1", `vintage: kept chunk is the 2025 one (got "${r.keep[0]?.text}")`);
  ok(r.rejected.length === 1, `vintage: rejected group count=1 (got ${r.rejected.length})`);
  ok(r.rejected[0].reason === "vintage", `vintage: reason="vintage" (got "${r.rejected[0]?.reason}")`);
  ok(r.rejected[0].chunkCount === 2, `vintage: chunkCount=2 (both 2019 chunks) (got ${r.rejected[0]?.chunkCount})`);
  ok(r.rejected[0].detail.includes("2019"), `vintage: detail mentions 2019 (got "${r.rejected[0]?.detail}")`);
}

section("Weak-entity: Unilever plc profile, HUL doc → rejected (no-entity)");
{
  const profile = makeUnileverProfile();
  const chunks: Chunk[] = [
    // HUL doc, title does NOT contain "unilever" → scoreEntityMatch = 0 → no-entity
    mkChunk("hul body 1", "https://hul.co.in/report-2026.pdf", "HUL Annual Report 2026", 0, 0),
    mkChunk("hul body 2", "https://hul.co.in/report-2026.pdf", "HUL Annual Report 2026", 0, 1),
    mkChunk("hul body 3", "https://hul.co.in/report-2026.pdf", "HUL Annual Report 2026", 0, 2),
    // Parent Unilever doc → clean keep
    mkChunk("parent 1", "https://unilever.com/2026-annual-report.pdf", "Unilever plc Annual Report 2026", 1, 0),
  ];
  const r = applyChunkSanityGate(chunks, { issuerProfile: profile, currentYear: CY });
  ok(r.keep.length === 1, `weak-entity: keep=1 (parent only) (got ${r.keep.length})`);
  ok(r.keep[0].text === "parent 1", `weak-entity: kept chunk is the Unilever plc one (got "${r.keep[0]?.text}")`);
  ok(r.rejected.length === 1, `weak-entity: one rejected group (got ${r.rejected.length})`);
  ok(r.rejected[0].reason === "no-entity",
    `weak-entity: reason="no-entity" (score 0, brief distinguishes 0-score) (got "${r.rejected[0]?.reason}")`);
  ok(r.rejected[0].chunkCount === 3, `weak-entity: chunkCount=3 (all HUL chunks) (got ${r.rejected[0]?.chunkCount})`);
  ok((r.rejected[0].docUrl || "").includes("hul.co.in"), `weak-entity: docUrl points at HUL (got "${r.rejected[0]?.docUrl}")`);
}

section("Soft flag: 2023 doc (age 3, currentYear 2026) → kept, vintage-warning");
{
  const chunks: Chunk[] = [
    mkChunk("body 1", "https://example.com/report-2023.pdf", "Report 2023", 0, 0),
    mkChunk("body 2", "https://example.com/report-2023.pdf", "Report 2023", 0, 1),
  ];
  const r = applyChunkSanityGate(chunks, { currentYear: CY });
  ok(r.keep.length === 2, `soft-vintage: keep=2 (both kept) (got ${r.keep.length})`);
  ok(r.rejected.length === 0, `soft-vintage: rejected=0 (got ${r.rejected.length})`);
  ok(r.softFlagged.length === 1, `soft-vintage: softFlagged=1 (got ${r.softFlagged.length})`);
  ok(r.softFlagged[0].reason === "vintage-warning", `soft-vintage: reason="vintage-warning" (got "${r.softFlagged[0]?.reason}")`);
  ok(r.softFlagged[0].chunkCount === 2, `soft-vintage: chunkCount=2 (got ${r.softFlagged[0]?.chunkCount})`);
}

section("Multiple chunks from same doc → one rejection entry with correct chunkCount");
{
  // Same URL, five chunks, all deep-vintage: single rejected entry with chunkCount=5.
  const chunks: Chunk[] = [];
  for (let i = 0; i < 5; i++) chunks.push(mkChunk(`c${i}`, "https://example.com/old-2018.pdf", "Old 2018 Report", 0, i));
  const r = applyChunkSanityGate(chunks, { currentYear: CY });
  ok(r.rejected.length === 1, `group-collapse: one rejected entry for 5 chunks (got ${r.rejected.length})`);
  ok(r.rejected[0].chunkCount === 5, `group-collapse: chunkCount aggregates to 5 (got ${r.rejected[0]?.chunkCount})`);
  ok(r.keep.length === 0, `group-collapse: keep=0 (got ${r.keep.length})`);
}

section("preserveIfOnlySource: true accepted but no-op (identical to default)");
{
  const chunks: Chunk[] = [
    mkChunk("old", "https://example.com/report-2019.pdf", "Report 2019", 0, 0),
    mkChunk("new", "https://example.com/report-2025.pdf", "Report 2025", 1, 0),
  ];
  const rDefault = applyChunkSanityGate(chunks, { currentYear: CY });
  const rPreserve = applyChunkSanityGate(chunks, { currentYear: CY, preserveIfOnlySource: true });
  ok(rDefault.keep.length === rPreserve.keep.length,
    `preserveIfOnlySource: same keep length (default=${rDefault.keep.length}, preserve=${rPreserve.keep.length})`);
  ok(rDefault.rejected.length === rPreserve.rejected.length,
    `preserveIfOnlySource: same rejected length (default=${rDefault.rejected.length}, preserve=${rPreserve.rejected.length})`);
  ok(rDefault.softFlagged.length === rPreserve.softFlagged.length,
    `preserveIfOnlySource: same softFlagged length (default=${rDefault.softFlagged.length}, preserve=${rPreserve.softFlagged.length})`);
}

section("Backward-compat invariant: gate is a pure function; input unchanged");
{
  // The gate must NOT mutate its input array. This is the analytic guarantee
  // behind the analyzer.ts backward-compat rule (retrievalV2 off → docChunks
  // untouched): if the gate is never invoked, chunks are pristine; and even if
  // invoked, the SAME chunk objects appear in keep[] (identity-preserving), so
  // downstream code paths that compare by reference are safe.
  const chunks: Chunk[] = [
    mkChunk("a", "https://example.com/report-2025.pdf", "Report 2025", 0, 0),
    mkChunk("b", "https://example.com/report-2019.pdf", "Old 2019", 1, 0),
  ];
  const snapshotLen = chunks.length;
  const snapshotFirst = chunks[0];
  const r = applyChunkSanityGate(chunks, { currentYear: CY });
  ok(chunks.length === snapshotLen, `input array length unchanged (got ${chunks.length})`);
  ok(chunks[0] === snapshotFirst, `input array element identity unchanged`);
  ok(r.keep[0] === snapshotFirst, `keep[] preserves chunk identity (same reference as input)`);
}

section("Interaction: entity failure dominates vintage");
{
  // HUL doc from 2018 (both deep-vintage AND wrong-entity). Brief's decision
  // priority: entity mismatch dominates → reason must be "no-entity" (not "vintage").
  const profile = makeUnileverProfile();
  const chunks: Chunk[] = [
    mkChunk("hul-old", "https://hul.co.in/report-2018.pdf", "HUL Report 2018", 0, 0),
  ];
  const r = applyChunkSanityGate(chunks, { issuerProfile: profile, currentYear: CY });
  ok(r.rejected.length === 1, `priority: 1 rejection (got ${r.rejected.length})`);
  ok(r.rejected[0].reason === "no-entity" || r.rejected[0].reason === "weak-entity",
    `priority: entity reason wins over vintage (got "${r.rejected[0]?.reason}")`);
}

console.log(`\n────────────────────────────\nPASSED: ${passed}   FAILED: ${failed}`);
if (failed > 0) process.exit(1);
