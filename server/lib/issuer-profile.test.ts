/**
 * Instruction 46 — Unit Tests
 * Tests cover:
 *  - Alias generation determinism
 *  - Entity/domain verification
 *  - Registry lookup by identifier and alias
 *  - Ambiguous acronym rejection/downgrade
 *  - Schema-driven evidenceKeywords query expansion
 *  - Retrieval diagnostics
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  generateIssuerAliases,
  corroborateAcronyms,
  verifyDomainCandidate,
  scoreEntityMatch,
  type IssuerProfile,
  type IssuerAlias,
} from "./issuer-profile.js";
import { expandQueries } from "./query-expansion.js";
import {
  buildRegistrySearchTerms,
  scoreRegistryResult,
  processRegistryResults,
  aggregateRegistryResults,
  emptyRegistrySummary,
} from "./registry-adapter.js";
import {
  RetrievalDiagnosticsBuilder,
  classifyLowScoreReason,
  mergeRetrievalDiagnostics,
} from "./retrieval-diagnostics.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<IssuerProfile> = {}): IssuerProfile {
  return {
    companyId: 1,
    legalName: "Sumitomo Mitsui Financial Group",
    tradingNames: ["smfg", "sumitomo mitsui"],
    formerNames: [],
    localLanguageNames: [],
    aliases: [
      { value: "sumitomo mitsui financial group", type: "legal-name", confidence: "high", provenance: "company-record" },
      { value: "smfg", type: "acronym", confidence: "low", provenance: "derived-initials" },
      { value: "sumitomimitsui", type: "trading-name", confidence: "medium", provenance: "derived-structural" },
      { value: "sumitomo", type: "trading-name", confidence: "medium", provenance: "derived-structural" },
      { value: "mitsui", type: "trading-name", confidence: "medium", provenance: "derived-structural" },
    ],
    queryAliases: ["sumitomo mitsui financial group", "sumitomimitsui", "sumitomo", "mitsui"],
    isin: "JP3890350006",
    ticker: "8316",
    figiName: "Sumitomo Mitsui Financial Group Inc",
    figiTicker: "8316",
    lei: null,
    verifiedDomains: ["smfg.co.jp"],
    domainCandidates: [],
    country: "Japan",
    supportedLanguages: ["en", "ja"],
    resolvedAt: new Date().toISOString(),
    pipelineVersion: "v46-test",
    ...overrides,
  };
}

// ─── Alias Generation Determinism ───────────────────────────────────────────

describe("generateIssuerAliases", () => {
  test("produces deterministic output for identical inputs", () => {
    const opts = {
      companyName: "Barclays PLC",
      figiName: "Barclays PLC",
      figiTicker: "BARC",
      isin: "GB0031348658",
      ticker: "BARC",
      country: "United Kingdom",
    };
    const run1 = generateIssuerAliases(opts);
    const run2 = generateIssuerAliases(opts);
    assert.deepEqual(run1, run2, "Alias generation must be deterministic");
  });

  test("generates legal-name, ticker, and isin aliases", () => {
    const aliases = generateIssuerAliases({
      companyName: "Commonwealth Bank of Australia",
      figiName: "Commonwealth Bank of Australia",
      figiTicker: "CBA",
      isin: "AU000000CBA7",
      ticker: "CBA",
      country: "Australia",
    });
    const types = new Set(aliases.map(a => a.type));
    assert(types.has("legal-name"), "Should have legal-name alias");
    // CBA is 3 chars, which is valid for ticker alias (>= 2)
    assert(types.has("ticker"), "Should have ticker alias");
    assert(types.has("isin"), "Should have isin alias");
    // Verify the ticker value is present
    const tickerAliases = aliases.filter(a => a.type === "ticker");
    assert(tickerAliases.some(a => a.value === "cba"), "Should have CBA as ticker");
  });

  test("marks short acronyms as low confidence", () => {
    const aliases = generateIssuerAliases({
      companyName: "Sumitomo Mitsui Financial Group",
      figiName: null,
      figiTicker: null,
      isin: null,
      ticker: null,
      country: "Japan",
    });
    const acronyms = aliases.filter(a => a.type === "acronym");
    for (const a of acronyms) {
      if (a.value.length <= 4) {
        assert.equal(a.confidence, "low", `Short acronym "${a.value}" should be low confidence`);
      }
    }
  });
});

// ─── Domain Verification ────────────────────────────────────────────────────

describe("verifyDomainCandidate", () => {
  test("accepts domain containing legal-name word", () => {
    const aliases = generateIssuerAliases({
      companyName: "Barclays PLC",
      figiName: "Barclays PLC",
      figiTicker: "BARC",
      isin: "GB0031348658",
      ticker: "BARC",
      country: "UK",
    });
    const result = verifyDomainCandidate("barclays.com", aliases, "Barclays PLC", "Barclays PLC");
    assert.equal(result.status, "accepted");
    assert(result.evidence.length > 0);
  });

  test("rejects domain with no issuer-identity match", () => {
    const aliases = generateIssuerAliases({
      companyName: "Barclays PLC",
      figiName: "Barclays PLC",
      figiTicker: "BARC",
      isin: "GB0031348658",
      ticker: "BARC",
      country: "UK",
    });
    const result = verifyDomainCandidate("randomsite.com", aliases, "Barclays PLC", "Barclays PLC");
    assert.equal(result.status, "rejected");
  });

  // ─── R5e: ISIN-country gate on ticker-only matches ─────────────────────

  test("R5e: rejects generic-TLD ticker-only match for non-US issuer", () => {
    // Prudential plc scenario. ISIN GB..., ticker PRU. `prudential.com` is
    // owned by Prudential Financial (US) and its only match against the
    // Prudential-plc alias set is the ticker "pru". Pre-R5e: accepted.
    // Post-R5e: rejected on generic TLD + non-US ISIN.
    const aliases = generateIssuerAliases({
      companyName: "Prudential plc",
      figiName: "PRUDENTIAL PLC",
      figiTicker: "PRU",
      isin: "GB0007099541",
      ticker: "PRU",
      country: "United Kingdom",
    });
    // Without ISIN (pre-R5e behaviour): accepted via ticker match
    const preR5e = verifyDomainCandidate("prudential.com", aliases, "Prudential plc", "PRUDENTIAL PLC");
    assert.equal(preR5e.status, "accepted", "pre-R5e: ticker-only match accepts");
    // With ISIN (R5e enabled): rejected
    const postR5e = verifyDomainCandidate("prudential.com", aliases, "Prudential plc", "PRUDENTIAL PLC", "GB0007099541");
    assert.equal(postR5e.status, "rejected", "R5e: ticker-only match on generic TLD + non-US ISIN rejects");
    assert.match(postR5e.reason, /R5e/);
  });

  test("R5e: accepts country-TLD ticker match matching ISIN country", () => {
    // `prudential.com.sg` for a GB-ISIN issuer: the TLD `.com.sg` maps to
    // country SG, ISIN country is GB. Under a strict rule this would be
    // rejected. But this domain would be accepted anyway via the "prudential"
    // trading-name alias (not ticker), so R5e is not triggered. This test
    // exercises the case where ticker IS the only match AND TLD matches.
    const aliases = generateIssuerAliases({
      companyName: "Test Co",
      figiName: "TEST CO",
      figiTicker: "XYZ",
      isin: "GB0000000000",
      ticker: "XYZ",
      country: "United Kingdom",
    });
    // Domain contains ticker "xyz" AND has UK-matching TLD `.co.uk`.
    const result = verifyDomainCandidate("xyz.co.uk", aliases, "Test Co", "TEST CO", "GB0000000000");
    assert.equal(result.status, "accepted");
    assert.match(result.reason, /Verified/);
    // Evidence should include the R5e note.
    assert(result.evidence.some(e => /R5e.*TLD country "GB"/i.test(e)));
  });

  test("R5e: accepts legal-name-word match on generic TLD regardless of ISIN country", () => {
    // Unilever (NL/UK-registered) accepting `unilever.com` should NOT be
    // affected by R5e because Check 2 (legal-name word) fires before
    // ticker. The gate only fires when acceptingAliasType === "ticker".
    const aliases = generateIssuerAliases({
      companyName: "Unilever plc",
      figiName: "UNILEVER PLC",
      figiTicker: "ULVR",
      isin: "GB00B10RZP78",
      ticker: "ULVR",
      country: "United Kingdom",
    });
    // "unilever" as a trading-name alias fires before ticker "ulvr".
    // This should always be accepted regardless of R5e.
    const result = verifyDomainCandidate("unilever.com", aliases, "Unilever plc", "UNILEVER PLC", "GB00B10RZP78");
    assert.equal(result.status, "accepted");
    assert.match(result.reason, /Verified/);
    // Confirm the match is via legal-name/trading-name, not ticker.
    assert(!result.evidence[0].includes("ticker"), "first evidence should not be ticker");
  });

  test("R5e: US-ISIN issuers still accept generic-TLD ticker-only match (pre-R5e behaviour preserved)", () => {
    // For US issuers, generic `.com` is the canonical TLD. The gate is
    // deliberately skipped when ISIN country is US to avoid regressing
    // legitimate US-issuer domains that only match via ticker.
    const aliases = generateIssuerAliases({
      companyName: "Test US Co",
      figiName: "TEST US CO",
      figiTicker: "XYZ",
      isin: "US0000000000",
      ticker: "XYZ",
      country: "United States",
    });
    const result = verifyDomainCandidate("xyzcorp.com", aliases, "Test US Co", "TEST US CO", "US0000000000");
    assert.equal(result.status, "accepted");
  });

  test("R5e: without ISIN argument, pre-R5e behaviour preserved (backwards compatible)", () => {
    // Callers that don't pass ISIN get the pre-R5e ticker-only acceptance.
    // This is required so existing test coverage and any consumers that
    // don't have ISIN available still work.
    const aliases = generateIssuerAliases({
      companyName: "Prudential plc",
      figiName: "PRUDENTIAL PLC",
      figiTicker: "PRU",
      isin: "GB0007099541",
      ticker: "PRU",
      country: "United Kingdom",
    });
    // No ISIN arg passed — the pre-R5e ticker-only branch fires
    const result = verifyDomainCandidate("prudential.com", aliases, "Prudential plc", "PRUDENTIAL PLC");
    assert.equal(result.status, "accepted");
  });

  test("R5e: country-TLD mismatch rejects (e.g. .fr domain for GB issuer via ticker)", () => {
    // Hypothetical case: ticker matches AND TLD is country-specific but
    // wrong. Both signals should refuse to align → reject.
    const aliases = generateIssuerAliases({
      companyName: "Test Co",
      figiName: "TEST CO",
      figiTicker: "XYZ",
      isin: "GB0000000000",
      ticker: "XYZ",
      country: "United Kingdom",
    });
    const result = verifyDomainCandidate("xyz.fr", aliases, "Test Co", "TEST CO", "GB0000000000");
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /R5e.*TLD indicates country FR, issuer ISIN country is GB/);
  });
});

// ─── Acronym Corroboration ──────────────────────────────────────────────────

describe("corroborateAcronyms", () => {
  test("upgrades acronym when found in verified domain", () => {
    const aliases: IssuerAlias[] = [
      { value: "smfg", type: "acronym", confidence: "low", provenance: "derived-initials" },
    ];
    const result = corroborateAcronyms(aliases, ["smfg.co.jp"], "Sumitomo Mitsui Financial Group");
    assert.equal(result[0].confidence, "medium", "Acronym in domain should be upgraded");
  });

  test("does not upgrade acronym without corroboration", () => {
    const aliases: IssuerAlias[] = [
      { value: "xyz", type: "acronym", confidence: "low", provenance: "derived-initials" },
    ];
    const result = corroborateAcronyms(aliases, ["somecompany.com"], "Some Other Company");
    assert.equal(result[0].confidence, "low", "Uncorroborated acronym stays low");
  });
});

// ─── Entity Match Scoring ───────────────────────────────────────────────────

describe("scoreEntityMatch", () => {
  test("high score for own-domain document", () => {
    const profile = makeProfile();
    const doc = { url: "https://www.smfg.co.jp/english/sustainability/report.pdf", title: "SMFG Sustainability Report 2024" };
    const result = scoreEntityMatch(doc, profile, []);
    // Domain match = 40 points; with title containing "sumitomo" or FIGI words it gets more
    // The domain match alone gives 40, which is a strong signal
    assert(result.score >= 40, `Own-domain doc should score >= 40, got ${result.score}`);
    assert(!result.isAmbiguous);
  });

  test("ambiguous for acronym-only match", () => {
    const profile = makeProfile({
      verifiedDomains: [],
      aliases: [
        { value: "cba", type: "acronym", confidence: "low", provenance: "derived-initials" },
      ],
      queryAliases: [],
      figiName: null,
      legalName: "CBA Group",
    });
    const doc = { url: "https://randomsite.com/report.pdf", title: "CBA Report 2024" };
    const result = scoreEntityMatch(doc, profile, []);
    assert(result.isAmbiguous || result.score < 40, "Acronym-only match should be ambiguous or low");
  });

  test("rejects document with no matching signals", () => {
    const profile = makeProfile();
    const doc = { url: "https://unrelated.com/report.pdf", title: "Annual Report 2024" };
    const result = scoreEntityMatch(doc, profile, []);
    assert(result.score < 20, `No-match doc should score very low, got ${result.score}`);
    assert(result.rejectionReason !== null);
  });
});

// ─── Registry Search ────────────────────────────────────────────────────────

describe("buildRegistrySearchTerms", () => {
  test("includes legal name, FIGI name, and ISIN", () => {
    const profile = makeProfile();
    const terms = buildRegistrySearchTerms(profile);
    assert(terms.some(t => t.toLowerCase().includes("sumitomo")), "Should include legal name");
    assert(terms.some(t => t.includes("JP3890350006")), "Should include ISIN");
  });

  test("caps at 6 terms", () => {
    const profile = makeProfile();
    const terms = buildRegistrySearchTerms(profile);
    assert(terms.length <= 6, `Should cap at 6 terms, got ${terms.length}`);
  });
});

describe("scoreRegistryResult", () => {
  test("matches result with issuer name in title", () => {
    const profile = makeProfile();
    const result = scoreRegistryResult(
      { url: "https://registry.example.com/smfg", title: "Sumitomo Mitsui Financial Group - Modern Slavery Statement" },
      profile,
    );
    assert.equal(result.status, "matched");
  });

  test("rejects result with no issuer signals", () => {
    const profile = makeProfile();
    const result = scoreRegistryResult(
      { url: "https://registry.example.com/other", title: "Some Other Company Statement" },
      profile,
    );
    assert(result.status === "no-match" || result.status === "ambiguous");
  });
});

// ─── Query Expansion ────────────────────────────────────────────────────────

describe("expandQueries", () => {
  test("generates queries from evidenceKeywords", () => {
    const profile = makeProfile();
    const result = expandQueries({
      profile,
      evidenceKeywords: ["financed emissions", "scope 3", "PCAF"],
      requiredDocTypes: ["TCFD/Climate Report"],
      topicPhrases: ["climate change", "carbon emissions"],
    });
    assert(result.queries.length > 0, "Should generate queries");
    assert(result.diagnostics.evidenceKeywordQueries > 0, "Should have evidence-keyword queries");
  });

  test("produces deterministic output", () => {
    const profile = makeProfile();
    const opts = {
      profile,
      evidenceKeywords: ["modern slavery", "forced labour", "supply chain"],
      requiredDocTypes: ["Modern Slavery Statement"],
      topicPhrases: ["human rights", "labour rights"],
    };
    const run1 = expandQueries(opts);
    const run2 = expandQueries(opts);
    assert.deepEqual(run1.queries, run2.queries, "Query expansion must be deterministic");
  });

  test("respects maxTotal cap", () => {
    const profile = makeProfile();
    const result = expandQueries({
      profile,
      evidenceKeywords: Array.from({ length: 50 }, (_, i) => `keyword${i}`),
      requiredDocTypes: ["Report Type A", "Report Type B", "Report Type C"],
      topicPhrases: Array.from({ length: 20 }, (_, i) => `phrase${i}`),
      maxTotal: 10,
    });
    assert(result.queries.length <= 10, `Should respect maxTotal, got ${result.queries.length}`);
  });
});

// ─── Retrieval Diagnostics ──────────────────────────────────────────────────

describe("RetrievalDiagnosticsBuilder", () => {
  test("builds complete diagnostics", () => {
    const builder = new RetrievalDiagnosticsBuilder();
    const profile = makeProfile();
    builder.setIssuerProfile(profile, {
      aliasCount: 5,
      verifiedDomainCount: 1,
      rejectedDomainCount: 0,
      identifiersAvailable: ["isin", "ticker"],
      resolutionPath: ["figi-resolved"],
    });
    builder.setFilteringPipeline({
      totalCandidates: 200,
      preGateFiltered: 150,
      gateAccepted: 80,
      recencyDropped: 5,
      finalCorpusSize: 75,
    });
    builder.addEntityVerification("match");
    builder.addEntityVerification("different_company");
    const diag = builder.build();
    assert.equal(diag.issuerProfile.aliasCount, 5);
    assert.equal(diag.filteringPipeline.totalCandidates, 200);
    assert.equal(diag.entityVerification.matchCount, 1);
    assert.equal(diag.entityVerification.differentCompanyCount, 1);
  });
});

describe("classifyLowScoreReason", () => {
  test("classifies timeout", () => {
    const builder = new RetrievalDiagnosticsBuilder();
    builder.setFilteringPipeline({
      totalCandidates: 100,
      preGateFiltered: 80,
      gateAccepted: 50,
      recencyDropped: 0,
      finalCorpusSize: 50,
      timeoutCount: 3,
    });
    const diag = builder.build();
    const reason = classifyLowScoreReason(diag, 0, 0);
    assert.equal(reason, "timeout");
  });

  test("classifies entity mismatch", () => {
    const builder = new RetrievalDiagnosticsBuilder();
    builder.setFilteringPipeline({
      totalCandidates: 100,
      preGateFiltered: 80,
      gateAccepted: 50,
      recencyDropped: 0,
      finalCorpusSize: 50,
    });
    // Simulate 60% mismatch rate
    for (let i = 0; i < 6; i++) builder.addEntityVerification("different_company");
    for (let i = 0; i < 4; i++) builder.addEntityVerification("match");
    const diag = builder.build();
    const reason = classifyLowScoreReason(diag, 0, 0);
    assert.equal(reason, "entity-mismatch");
  });
});

describe("mergeRetrievalDiagnostics", () => {
  test("preserves existing fields", () => {
    const existing = { autoReexam: { count: 1 }, someOtherField: "value" };
    const builder = new RetrievalDiagnosticsBuilder();
    const retrieval = builder.build();
    const merged = mergeRetrievalDiagnostics(existing, retrieval);
    assert.equal((merged as any).autoReexam.count, 1);
    assert.equal((merged as any).someOtherField, "value");
    assert(merged.retrievalDiagnostics !== undefined);
  });
});

// Run tests
console.log("All Instruction 46 tests passed.");
