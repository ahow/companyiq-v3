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
ok(authorityClass(fixture[4].url, COMPANY_DOMAIN) === 2, "CDP → class 2 (voluntary registry)");
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

console.log(`\n────────────────────────────\nPASSED: ${passed}   FAILED: ${failed}`);
if (failed > 0) process.exit(1);
