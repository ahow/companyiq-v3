/**
 * Unit tests for Option A + C ("search-and-repair") in evidence-gate.ts:
 * `gateEvidenceWithRepair` vs the legacy `gateEvidence` ("strip-and-flip").
 *
 * Fixtures are the REAL stripped quotes + pack doc identities from the canonical
 * production case recorded in /home/ubuntu/batch_1304_results.json:
 *   Gerdau (companyId 123) · measure 2.1-deployed-systems.
 *   - 3 genuine AI quotes the model labelled source "ANNUAL REPORT"
 *     (quotesTotal 3, quotesValid 0, downgraded true, all source-attribution).
 *   - the pack's chunk-assembled DOCUMENT segments were titled
 *     "20-F 2001 Ing" and "Gerdau Annual Report - 2021".
 * The generic label "ANNUAL REPORT" resolves to the WRONG segment
 * ("Gerdau Annual Report - 2021") whose slice does NOT contain the verbatim text,
 * while the text is verbatim-present in another present segment — so the legacy
 * gate strips all three and flips Yes→No, and the repair path must RELABEL and
 * keep Yes.
 *
 * Offline: no LLM, no network, no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateEvidence, gateEvidenceWithRepair, parsePackSegments } from "./evidence-gate.js";

// ── Real stripped quotes (verbatim, from the 1304 evidence-gate audit blob) ────
const Q1 =
  "Also in the special steels segment, we began using generative AI to process customer calibration sheets. By analyzing technical specifications, the AI determine";
const Q2 =
  "Another strong example is the development of Integrated Business Planning using AI, providing our supply chain operations with a smarter, more predictive model ";
const Q3 =
  "Safety analytics: a platform designed to reduce injuries in our industrial operations using machine learning and data available from enterprise management syste";

const GERDAU_QUOTES = [
  { text: Q1, source: "ANNUAL REPORT" },
  { text: Q2, source: "ANNUAL REPORT" },
  { text: Q3, source: "ANNUAL REPORT" },
];

// ── Build a pack whose DOCUMENT segments reproduce the real doc identities ─────
// The verbatim AI text is scattered into the "20-F 2001 Ing" chunk (retrieval-named,
// as the design describes), while the "Gerdau Annual Report - 2021" segment — the
// one the label "ANNUAL REPORT" resolves to — holds only 2021 boilerplate.
function buildGerdauPack(): string {
  const seg2001 =
    "--- DOCUMENT: 20-F 2001 Ing [https://www.gerdau.com.br/updatetool/DownloadCenter/_fls/_dwn/164_2.pdf] ---\n" +
    "Gerdau is a leading long-steel producer in the Americas. " +
    Q1 +
    "s the optimal process parameters. " +
    Q2 +
    "for demand. " +
    Q3 +
    "ms to flag hazards before they occur.\n\n";
  const seg2021 =
    "--- DOCUMENT: Gerdau Annual Report - 2021 [https://www2.gerdau.com/sites/gln_gerdau/files/downloadable_files/Gerdau%20Annual%20Report%20-%202021.pdf] ---\n" +
    "In 2021 Gerdau reported record shipments and strengthened its governance practices. " +
    "The company advanced its decarbonisation roadmap and expanded recycling capacity across its mills.\n\n";
  return seg2001 + seg2021;
}

const PACK = buildGerdauPack();
const RESEARCH_CRITERIA = [
  "2.1 Deployed systems",
  "AI or ML operationally deployed in at least one named business function",
];

// ── Sanity: fixtures reproduce the production ground truth ─────────────────────
test("fixtures: the 3 genuine quotes are verbatim-present pack-wide (provenance ok)", () => {
  for (const q of GERDAU_QUOTES) {
    assert.ok(PACK.includes(q.text), `quote should be present in the pack: ${q.text.slice(0, 40)}…`);
  }
});

// ── Regression guard: flag-OFF (legacy) path still strips + flips ─────────────
test("flag OFF (gateEvidence): source-attribution strips all 3 quotes and flips Yes→No", () => {
  const real = gateEvidence({
    originalScore: 1,
    quotes: GERDAU_QUOTES,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsePackSegments(PACK), // as the analyzer would parse them
  });
  assert.equal(real.score, 0, "legacy path downgrades to 0");
  assert.equal(real.gate.downgraded, true, "legacy path reports downgraded");
  assert.equal(real.gate.quotesValid, 0, "legacy path validates 0 quotes");
  assert.equal(real.keptQuotes.length, 0, "legacy strict-strip drops all flagged quotes");
  for (const f of real.gate.failures) {
    assert.ok(f.reasons.includes("source-attribution"), "each failure is source-attribution");
  }
});

// ── New behaviour: flag-ON (repair) path relabels and KEEPS Yes ───────────────
test("flag ON (gateEvidenceWithRepair): relabels the 3 quotes and keeps Yes", () => {
  const parsed = parsePackSegments(PACK);
  const { score, gate, keptQuotes } = gateEvidenceWithRepair({
    originalScore: 1,
    quotes: GERDAU_QUOTES,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsed,
    researchCriteria: RESEARCH_CRITERIA,
  });
  assert.equal(score, 1, "repair path keeps Yes");
  assert.equal(gate.downgraded, false, "repair path does NOT downgrade");
  assert.equal(gate.quotesValid, 3, "all 3 quotes are valid after relabel");
  assert.equal(keptQuotes.length, 3, "all 3 quotes are kept");
  // Relabel recorded in repairs[], original generic label preserved for audit.
  assert.ok(gate.repairs && gate.repairs.length === 3, "3 relabels recorded in repairs[]");
  for (const r of gate.repairs!) {
    assert.equal(r.originalSource, "ANNUAL REPORT");
    assert.equal(r.repairedTo, "20-F 2001 Ing", "relabelled to the segment that contains the text");
  }
  // The kept quotes carry the corrected source, not the stale "ANNUAL REPORT".
  for (const q of keptQuotes) {
    assert.equal((q as any).source, "20-F 2001 Ing");
  }
  // No re-search needed — relabel alone sustained the Yes.
  assert.ok(!gate.researched, "no re-search when relabel already sustains Yes");
});

// ── Re-search: every quote fails provenance, corpus has support → keep Yes ─────
test("flag ON: all quotes fail provenance but corpus supports the measure → re-search keeps Yes", () => {
  const parsed = parsePackSegments(PACK);
  const hallucinated = [
    { text: "Gerdau deployed a fully autonomous AGI foundry that runs with zero human oversight.", source: "ANNUAL REPORT" },
  ];
  const { score, gate, keptQuotes } = gateEvidenceWithRepair({
    originalScore: 1,
    quotes: hallucinated,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsed,
    // criteria that DO occur in the pack ("generative AI", "machine learning")
    researchCriteria: ["generative using machine learning predictive model business"],
  });
  assert.equal(score, 1, "re-search rescues the Yes from verbatim corpus evidence");
  assert.equal(gate.downgraded, false, "not downgraded when corpus supports the measure");
  assert.ok(gate.researched && gate.researched.length === 1, "re-search recorded in researched[]");
  // The rescued quote is verbatim-present in the pack (anti-hallucination preserved).
  assert.ok(PACK.includes(gate.researched![0].repairedQuote), "rescued passage is verbatim in the pack");
  assert.ok(keptQuotes.length >= 1, "the rescued passage is kept as the supporting quote");
});

// ── Last resort: hallucinated quote + corpus has nothing → downgrade (step 4) ──
test("flag ON: hallucinated quote with no corpus support anywhere → last-resort downgrade", () => {
  const parsed = parsePackSegments(PACK);
  const hallucinated = [
    { text: "Gerdau operates a chain of luxury seaside hotels across the Mediterranean.", source: "ANNUAL REPORT" },
  ];
  const { score, gate } = gateEvidenceWithRepair({
    originalScore: 1,
    quotes: hallucinated,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsed,
    // criteria about tourism/hotels — absent from this steel-maker corpus
    researchCriteria: ["luxury seaside hotels mediterranean tourism resort hospitality"],
  });
  assert.equal(score, 0, "no verbatim-present support anywhere → downgrade");
  assert.equal(gate.downgraded, true, "last-resort downgrade fires (Option C step 4)");
  assert.ok(!gate.researched, "no researched record when re-search finds nothing");
});

// ── No-regression: the repair path never passes a pack-wide-failing quote ──────
test("flag ON: a quote absent pack-wide is never validated as-is (no hallucination regression)", () => {
  const parsed = parsePackSegments(PACK);
  const mixed = [
    { text: "This sentence is categorically not anywhere in the Gerdau evidence pack at all.", source: "ANNUAL REPORT" },
  ];
  const { gate } = gateEvidenceWithRepair({
    originalScore: 1,
    quotes: mixed,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsed,
    researchCriteria: [], // no criteria → re-search cannot run
  });
  // The hallucinated quote must be a provenance failure, never counted valid.
  assert.ok(gate.failures.some((f) => f.reasons.includes("provenance")), "pack-wide-absent quote fails provenance");
  assert.equal(gate.quotesValid, 0, "no pack-wide-absent quote is ever validated");
});

// ── NO verdict stays NO: the gate never promotes a cascade No ──────────────────
test("flag ON: an original No stays No (gate never promotes)", () => {
  const parsed = parsePackSegments(PACK);
  const { score, gate } = gateEvidenceWithRepair({
    originalScore: 0,
    quotes: GERDAU_QUOTES,
    packText: PACK,
    policyVersion: "v2",
    sourceAttribution: true,
    documentSegments: parsed,
    researchCriteria: RESEARCH_CRITERIA,
  });
  assert.equal(score, 0, "No stays No");
  assert.equal(gate.downgraded, false, "a No is never 'downgraded'");
});
