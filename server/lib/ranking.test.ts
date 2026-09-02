// Standalone test runner for ranking.ts (no Vitest/Jest dependency).
// Run with:  npx tsx server/lib/ranking.test.ts
//
// Exits non-zero if any assertion fails. Covers:
//   - Total order (no ties survive the layered key) on a realistic fixture
//   - Authority-class ordering (regulatory primary > registry > voluntary > IR > secondary)
//   - fineScore continuity (no integer-lattice collapse)
//   - Caution A (title-less exhibit demotion)
//   - Caution B (cross-language penalty gated to secondary class only)
//   - Near-duplicate collapse keeps the authority-class winner
//   - Ranker diagnostics thresholds (distinct top-20, tie size, urlHash fraction)

import {
  computeRankSignals,
  compareSignals,
  rankDocuments,
  collapseNearDuplicates,
  computeRankerDiagnostics,
  authorityClass,
} from "./ranking.js";
import type { IssuerProfile } from "./issuer-profile.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(name: string) { console.log(`\n── ${name} ──`); }

const CY = new Date().getUTCFullYear();

// ─── Realistic mixed fixture (the kind of pool that produced −25 ties) ───────
const COMPANY_DOMAIN = "abc.xyz";
const fixture = [
  { url: `https://www.sec.gov/Archives/edgar/data/1652044/000165204425000014/goog-${CY}1231.htm`, title: `Alphabet Inc. Annual Report on Form 10-K ${CY} Item 1A Risk Factors` },
  { url: `https://www.sec.gov/Archives/edgar/data/1652044/000165204425000020/goog-def14a-${CY}.htm`, title: `Alphabet Inc. Proxy Statement DEF 14A ${CY}` },
  { url: `https://www.sec.gov/Archives/edgar/data/1652044/000165204425000014/ex-99.1.htm`, title: `99.1` },
  { url: `https://abc.xyz/assets/investor/${CY}-annual-report.pdf`, title: `Alphabet ${CY} Annual Report` },
  { url: `https://www.cdp.net/en/responses/alphabet-${CY}`, title: `Alphabet CDP Climate Change Response ${CY}` },
  { url: `https://www.reuters.com/technology/alphabet-results-${CY}`, title: `Alphabet beats earnings estimates ${CY}` },
  { url: `https://abc.xyz/esg/${CY}-sustainability-report`, title: `Alphabet ${CY} Sustainability Report` },
  { url: `https://seekingalpha.com/article/alphabet-${CY}`, title: `Alphabet: A Buy For ${CY}` },
  { url: `https://www.sec.gov/Archives/edgar/data/1652044/000165204425000099/goog-10q-${CY}.htm`, title: `Alphabet Inc. Quarterly Report Form 10-Q ${CY}` },
  { url: `https://abc.xyz/investor/press/alphabet-announces-${CY}`, title: `Alphabet Announces ${CY} Results` },
];

section("authorityClass mapping");
ok(authorityClass(fixture[0].url, COMPANY_DOMAIN) === 0, "EDGAR primary HTML → class 0");
// B3: CDP is framework-scoped after Instruction 31: class 2 only when the
// active framework declares it in authoritativeRegistries.
ok(
  authorityClass(fixture[4].url, COMPANY_DOMAIN, ["cdp.net"]) === 2,
  "CDP → class 2 (voluntary registry) when framework declares cdp.net"
);
ok(
  authorityClass(fixture[4].url, COMPANY_DOMAIN) === 4,
  "CDP → class 4 (secondary) when framework does not declare cdp.net"
);
ok(authorityClass(fixture[3].url, COMPANY_DOMAIN) === 3, "company IR domain → class 3");
ok(authorityClass(fixture[5].url, COMPANY_DOMAIN) === 4, "reuters → class 4 (secondary)");
ok(authorityClass(fixture[7].url, COMPANY_DOMAIN) === 4, "seekingalpha → class 4 (secondary)");

section("Total order — no surviving ties");
const ranked = rankDocuments(fixture, { companyDomain: COMPANY_DOMAIN, topicPhrases: ["climate", "sustainability", "risk"] });
let strictlyOrdered = true;
for (let i = 1; i < ranked.length; i++) {
  // every adjacent pair must compare strictly < 0 (a before b); equal (0) means a tie survived
  if (compareSignals(ranked[i - 1].signals, ranked[i].signals) >= 0) {
    // 0 would only be possible for identical URL; allow >0 never (sorted), so check != 0
    if (compareSignals(ranked[i - 1].signals, ranked[i].signals) === 0) strictlyOrdered = false;
  }
}
ok(strictlyOrdered, "layered key yields a strict total order (no zero-compare adjacent pairs)");

section("Authority precedence beats fineScore");
// The 10-K (class 0) must rank above the IR annual report (class 3) even though
// both are strong topic/recency docs.
const idx10k = ranked.findIndex(r => r.doc.url === fixture[0].url);
const idxIR = ranked.findIndex(r => r.doc.url === fixture[3].url);
ok(idx10k < idxIR, "EDGAR 10-K (class 0) ranks above IR annual report (class 3)");
// Secondary (reuters / seekingalpha) must be at the bottom band.
const idxReuters = ranked.findIndex(r => r.doc.url === fixture[5].url);
ok(idxReuters > idx10k && idxReuters > idxIR, "secondary news ranks below primary & IR");

section("fineScore continuity (no integer lattice)");
const fineScores = ranked.map(r => r.signals.fineScore);
const hasFraction = fineScores.some(s => Math.abs(s - Math.round(s)) > 1e-9);
ok(hasFraction, "fineScores are continuous floats, not collapsed to integers");

section("Caution A — title-less exhibit demoted within class 0");
// ex-99.1 (title "99.1") is also EDGAR class 0 but should rank BELOW the 10-K
// because titleTokenBonus + filingType + section bonus are far lower.
const sig10k = computeRankSignals(fixture[0], { companyDomain: COMPANY_DOMAIN });
const sigEx = computeRankSignals(fixture[2], { companyDomain: COMPANY_DOMAIN });
ok(sig10k.authorityClass === 0 && sigEx.authorityClass === 0, "both 10-K and exhibit are class 0");
ok(sig10k.fineScore > sigEx.fineScore, "titled 10-K outranks title-less exhibit on fineScore");
ok(sigEx.components.titleTokens < 1.0, "exhibit '99.1' gets near-zero titleTokenBonus");

section("Caution B — cross-language penalty gated to secondary class only");
const jpPrimary = { url: "https://www.sec.gov/Archives/edgar/data/123/abc-20251231.htm", title: "Annual Report 20-F English" };
const jpSecondaryEN = { url: "https://www.reuters.com/markets/japan-co", title: "Japan Co Reports Strong Year" };
const sigJpPrimary = computeRankSignals(jpPrimary, { companyDomain: "x.jp", nativeNonLatinMarket: true });
const sigJpSecondary = computeRankSignals(jpSecondaryEN, { companyDomain: "x.jp", nativeNonLatinMarket: true });
ok(sigJpPrimary.components.crossLanguage === 0, "English-titled PRIMARY (class<4) NOT penalised");
ok(sigJpSecondary.components.crossLanguage === -2.0, "English-titled SECONDARY (class 4) penalised −2.0");
const sigEnMarket = computeRankSignals(jpSecondaryEN, { companyDomain: "x.com", nativeNonLatinMarket: false });
ok(sigEnMarket.components.crossLanguage === 0, "no penalty for EN-market issuer");

section("Near-duplicate collapse keeps authority-class winner");
const dupPool = [
  // Same 10-K, year, title-stem — one on EDGAR (class 0), one mirrored on a news site (class 4)
  { url: `https://www.sec.gov/Archives/edgar/data/1/000/acme-10k-${CY}.htm`, title: `ACME Corp Annual Report on Form 10-K ${CY}` },
  { url: `https://www.bloomberg.com/acme/acme-10k-${CY}.htm`, title: `ACME Corp Annual Report on Form 10-K ${CY}` },
  // A standalone proxy (no dup)
  { url: `https://www.sec.gov/Archives/edgar/data/1/000/acme-def14a-${CY}.htm`, title: `ACME Corp Proxy Statement DEF 14A ${CY}` },
];
const collapse = collapseNearDuplicates(dupPool, { companyDomain: "acme.com" });
ok(collapse.collapsedGroups === 1, "exactly one near-dup group collapsed");
ok(collapse.removed.length === 1, "one duplicate removed");
ok(collapse.kept.some(d => d.url.includes("sec.gov") && d.url.includes("10k")), "EDGAR (class 0) 10-K kept as winner");
ok(!collapse.kept.some(d => d.url.includes("bloomberg")), "bloomberg mirror removed");
ok(collapse.kept.some(d => d.url.includes("def14a")), "standalone proxy retained");

section("Ranker diagnostics thresholds");
const diag = computeRankerDiagnostics(ranked);
ok(diag.distinctPrioritiesInTop20 === Math.min(20, fixture.length), "distinct priorities in top-20 == number of candidate docs (all distinct)");
ok(diag.largestTieCountPreUrlHash <= 3, `largest pre-urlHash tie ≤ 3 (got ${diag.largestTieCountPreUrlHash})`);
ok(diag.urlhashDecisionFraction < 0.10, `urlHash decision fraction < 10% (got ${(diag.urlhashDecisionFraction * 100).toFixed(1)}%)`);

section("Determinism — repeated ranking identical");
const r1 = rankDocuments(fixture, { companyDomain: COMPANY_DOMAIN }).map(r => r.doc.url).join("|");
const r2 = rankDocuments([...fixture].reverse(), { companyDomain: COMPANY_DOMAIN }).map(r => r.doc.url).join("|");
ok(r1 === r2, "ranking is input-order-independent (deterministic)");

// ─── PR 1 · Change 1b: retrievalV2 penalty components ────────────────────────
// Tests for the three new penalty helpers (subsidiary / vintage / press-page)
// and the backward-compatibility invariant that fineScore is byte-identical
// when retrievalV2 is absent/false.

// Minimal profile mirroring the brief §6 spec (legalName + domains only).
// A richer profile (FIGI name + high-conf aliases containing "unilever")
// would push HUL from the "weak" (-8) into the "moderate" (-3) band because
// scoreEntityMatch adds +10..+15 per matching alias/FIGI word. The brief's
// expected "≤ -8" assumes the minimal profile shape.
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

section("PR 1 · 1b · entityMatchPenalty (subsidiary detection)");
{
  const profile = makeUnileverProfile();
  // Strong parent match: unilever.com domain + "Unilever plc" legal name in title
  const parent = {
    url: "https://unilever.com/2025-annual-report.pdf",
    title: "Unilever plc Annual Report 2025",
  };
  const sigParent = computeRankSignals(parent, { retrievalV2: true, issuerProfile: profile });
  ok(sigParent.components.entityMatch === 0, `parent Unilever plc doc → 0 (got ${sigParent.components.entityMatch})`);

  // Subsidiary (Hindustan Unilever) — different domain, subsidiary name; should
  // score weakly and get penalty ≤ -8.
  const sub = {
    url: "https://hul.co.in/annual-report-2025.pdf",
    title: "Hindustan Unilever Limited Integrated Report 2025",
  };
  const sigSub = computeRankSignals(sub, { retrievalV2: true, issuerProfile: profile });
  ok(sigSub.components.entityMatch <= -8, `HUL doc penalised ≤ -8 (got ${sigSub.components.entityMatch})`);

  // No profile → 0 regardless of flag
  const sigNoProfile = computeRankSignals(sub, { retrievalV2: true });
  ok(sigNoProfile.components.entityMatch === 0, "no profile → 0 (backward compat)");
}

section("PR 1 · 1b · vintagePenalty (deep-vintage docs)");
{
  // Use titles only (no URL year noise). CURRENT_YEAR is derived at runtime
  // from the ranking.ts module; use CY (this test's copy) to build titles that
  // hit each age band deterministically regardless of when the test runs.
  const current = {
    url: `https://example.com/doc-${CY}.pdf`,
    title: `Annual Report ${CY}`,
  };
  const sigCurrent = computeRankSignals(current, { retrievalV2: true });
  ok(sigCurrent.components.vintage === 0, `current-year doc → 0 (got ${sigCurrent.components.vintage})`);

  const age4 = {
    url: `https://example.com/doc-${CY - 4}.pdf`,
    title: `Annual Report ${CY - 4}`,
  };
  const sigAge4 = computeRankSignals(age4, { retrievalV2: true });
  ok(sigAge4.components.vintage === -5, `age-4 doc → -5 (got ${sigAge4.components.vintage})`);

  const age7 = {
    url: `https://example.com/doc-${CY - 7}.pdf`,
    title: `Annual Report ${CY - 7}`,
  };
  const sigAge7 = computeRankSignals(age7, { retrievalV2: true });
  ok(sigAge7.components.vintage === -8, `age-7 doc → -8 (got ${sigAge7.components.vintage})`);

  const noYear = { url: "https://example.com/document.pdf", title: "Annual Report" };
  const sigNoYear = computeRankSignals(noYear, { retrievalV2: true });
  ok(sigNoYear.components.vintage === 0, `no-year doc → 0 (got ${sigNoYear.components.vintage})`);
}

section("PR 1 · 1b · pressPagePenalty");
{
  const pressGeneric = {
    url: "https://kering.com/press/announcement",
    title: "Kering announces new leadership",
  };
  const sigPress = computeRankSignals(pressGeneric, { retrievalV2: true });
  ok(sigPress.components.pressPage === -4, `plain press page → -4 (got ${sigPress.components.pressPage})`);

  const pressFiling = {
    url: "https://kering.com/press/annual-report-2025",
    title: "Kering 2025 Annual Report",
  };
  const sigPressFiling = computeRankSignals(pressFiling, { retrievalV2: true });
  ok(sigPressFiling.components.pressPage === 0, `press URL with filing keyword → 0 (got ${sigPressFiling.components.pressPage})`);

  const investors = {
    url: "https://kering.com/investors/2025-annual-report.pdf",
    title: "Kering 2025 Annual Report",
  };
  const sigInvestors = computeRankSignals(investors, { retrievalV2: true });
  ok(sigInvestors.components.pressPage === 0, `non-press URL → 0 (got ${sigInvestors.components.pressPage})`);
}

section("PR 1 · 1b · retrievalV2 backward-compat invariant (fineScore byte-identical)");
{
  // A doc that would trigger ALL three penalties under retrievalV2=true:
  //   - HUL-style URL/title (weak entity match under Unilever profile)
  //   - Vintage 2018 (age >= 5 → -8)
  //   - Press-page URL without filing keyword
  const profile = makeUnileverProfile();
  const doc = {
    url: "https://hul.co.in/press/announcement-2018",
    title: "Hindustan Unilever Ltd Statement 2018",
  };
  const sigOff = computeRankSignals(doc, { issuerProfile: profile });
  const sigOffFalse = computeRankSignals(doc, { issuerProfile: profile, retrievalV2: false });
  const sigDefault = computeRankSignals(doc, {});
  ok(sigOff.fineScore === sigOffFalse.fineScore, `fineScore identical: flag absent vs false (${sigOff.fineScore} vs ${sigOffFalse.fineScore})`);
  ok(sigOff.fineScore === sigDefault.fineScore, `fineScore identical: flag absent vs empty opts (${sigOff.fineScore} vs ${sigDefault.fineScore})`);
  ok(sigOff.components.entityMatch === 0, "entityMatch is 0 when retrievalV2 absent");
  ok(sigOff.components.vintage === 0, "vintage is 0 when retrievalV2 absent");
  ok(sigOff.components.pressPage === 0, "pressPage is 0 when retrievalV2 absent");

  // And with retrievalV2 ON, all three should fire and fineScore must be lower.
  const sigOn = computeRankSignals(doc, { issuerProfile: profile, retrievalV2: true });
  ok(sigOn.components.entityMatch < 0, `entityMatch < 0 when flag on (got ${sigOn.components.entityMatch})`);
  ok(sigOn.components.vintage < 0, `vintage < 0 when flag on (got ${sigOn.components.vintage})`);
  ok(sigOn.components.pressPage < 0, `pressPage < 0 when flag on (got ${sigOn.components.pressPage})`);
  ok(sigOn.fineScore < sigOff.fineScore, `fineScore drops with all penalties on (${sigOn.fineScore} < ${sigOff.fineScore})`);
}

section("PR 1 · 1b · realistic ranking end-to-end (Unilever plc corpus)");
{
  const profile = makeUnileverProfile();
  const corpus = [
    { url: `https://unilever.com/sustainability/${CY}-sustainability-statement.pdf`,
      title: `Unilever plc ${CY} Sustainability Statement` },
    { url: `https://hul.co.in/${CY}-integrated-report.pdf`,
      title: `Hindustan Unilever Limited Integrated Report ${CY}` },
    { url: `https://unilever.com/sustainability/${CY - 6}-sustainability-report.pdf`,
      title: `Unilever plc ${CY - 6} Sustainability Report` },
  ];

  // Pre-1b baseline: capture whatever order the ranker produces so we assert
  // it is preserved when the flag is off (this is the byte-identical guardrail
  // extended to the end-to-end sort).
  const baseline = rankDocuments(corpus, { companyDomain: "unilever.com" });
  const baselineOrder = baseline.map((r) => r.doc.url).join("|");

  // With flag off but issuerProfile supplied, order must be unchanged.
  const offWithProfile = rankDocuments(corpus, { companyDomain: "unilever.com", issuerProfile: profile });
  ok(offWithProfile.map((r) => r.doc.url).join("|") === baselineOrder,
    "flag off + profile supplied preserves baseline order");

  // With flag on: the current-year Unilever plc doc should be first, and both
  // the HUL doc and the deep-vintage doc should rank later than it.
  const onRanked = rankDocuments(corpus, {
    companyDomain: "unilever.com",
    issuerProfile: profile,
    retrievalV2: true,
  });
  const firstUrl = onRanked[0].doc.url;
  ok(firstUrl.includes("unilever.com") && firstUrl.includes(`${CY}-sustainability-statement`),
    `current Unilever plc doc ranks first with retrievalV2 (got ${firstUrl})`);
}

section("PR 1 · 1b · diagnostics count penalty hits");
{
  const profile = makeUnileverProfile();
  const docs = [
    { url: "https://unilever.com/2025-annual-report.pdf", title: "Unilever plc Annual Report 2025" }, // clean
    { url: "https://hul.co.in/2025-report.pdf", title: "Hindustan Unilever Report 2025" },              // entity penalty
    { url: `https://unilever.com/${CY - 6}-old.pdf`, title: `Unilever plc Report ${CY - 6}` },        // vintage penalty
    { url: "https://unilever.com/press/announcement", title: "Unilever plc statement" },              // press penalty
  ];
  const rankedOn = rankDocuments(docs, {
    companyDomain: "unilever.com",
    issuerProfile: profile,
    retrievalV2: true,
  });
  const diagOn = computeRankerDiagnostics(rankedOn);
  ok(diagOn.entityMatchPenaltyHits >= 1, `entityMatch hits >=1 (got ${diagOn.entityMatchPenaltyHits})`);
  ok(diagOn.vintagePenaltyHits >= 1, `vintage hits >=1 (got ${diagOn.vintagePenaltyHits})`);
  ok(diagOn.pressPagePenaltyHits >= 1, `pressPage hits >=1 (got ${diagOn.pressPagePenaltyHits})`);

  // With flag off — none of the counters may fire.
  const rankedOff = rankDocuments(docs, { companyDomain: "unilever.com", issuerProfile: profile });
  const diagOff = computeRankerDiagnostics(rankedOff);
  ok(diagOff.entityMatchPenaltyHits === 0, `flag off → entityMatch hits 0 (got ${diagOff.entityMatchPenaltyHits})`);
  ok(diagOff.vintagePenaltyHits === 0, `flag off → vintage hits 0 (got ${diagOff.vintagePenaltyHits})`);
  ok(diagOff.pressPagePenaltyHits === 0, `flag off → pressPage hits 0 (got ${diagOff.pressPagePenaltyHits})`);
}

console.log(`\n────────────────────────────\nPASSED: ${passed}   FAILED: ${failed}`);
if (failed > 0) process.exit(1);
