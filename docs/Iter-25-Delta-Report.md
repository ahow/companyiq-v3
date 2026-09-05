# Iter-25 Delta Report — R7 Rollout Attribution

**Date**: 2026-09-05
**Baseline**: Iter-24 (batch 27) — Pre-R7, R=0.714 F1=0.769
**New**: Iter-25 (batch 28) — Post-R7 (all 7 rules), R=0.733 F1=0.751
**Framework**: Nature and Biodiversity Disclosure Framework (F3), 10 companies × 20 measures = 200 cells

## Headline

| Metric | Iter-24 | Iter-25 | Δ |
|---|---|---|---|
| **Precision** | 0.833 | 0.770 | −0.063 |
| **Recall** | 0.714 | 0.733 | **+0.019** |
| **F1** | 0.769 | 0.751 | −0.018 |
| **TP** | 75 | 77 | +2 |
| **FP** | 15 | 23 | **+8** |
| **FN** | 30 | 28 | −2 |
| **Avg score** | 43 | 46 | +3 |

**Verdict**: R7 lifted recall as designed (2 more truth-Yes now captured) but introduced 8 new false positives, netting a small F1 regression. This is a **scoring-interpretation issue**, not a discovery gap — R7 discovery worked; the LLM is now finding more documents and calling some of them "Yes" more liberally.

## Cell-level flip breakdown

Of 200 cells: 176 unchanged (81 Yes-stable, 95 No-stable), 24 flipped.

| Flip type | Count |
|---|---|
| No → Yes | 8 |
| Yes → No | 5 |
| No → Partial | 7 |
| Partial → Yes | 2 |
| **Beneficial** (wrong → right) | 5 |
| **Regression** (right → wrong) | 13 |
| **Neutral** (still wrong, just differently) | 4 |

## Beneficial flips (R7 payoff)

| Company | Measure | Truth | 24 → 25 |
|---|---|---|---|
| Banco Santander | 2.7-strategic-response | Yes | Partial → Yes |
| Banco Santander | 3.4-integration-erm | Yes | No → Yes |
| Kering | 1.2-management-responsibility | Yes | No → Yes |
| Prudential plc | 1.5-stakeholder-engagement | No | Yes → No |
| Unilever | 1.4-integration-strategy | Yes | No → Yes |

## Regression flips (R7 collateral)

The 13 regression flips split into two patterns:

**Pattern A — LLM now says "Yes" on 4 clear-No truth cells** (new precision loss from broader corpus):
- BHP Group 1.5-stakeholder-engagement
- Prudential plc 2.3-nature-risks
- Samsung Electronics 1.3-governance-processes
- Samsung Electronics 2.4-nature-opportunities
- Unilever 2.4-nature-opportunities

**Pattern B — LLM now says "Partial" on clear-No truth cells** (Partial-count creep — 0 to 9):
- BHP Group 2.5-priority-locations
- Banco Santander 2.5-priority-locations
- Kering 1.5-stakeholder-engagement
- Nestlé 2.5-priority-locations
- (all "Partial" verdicts new in iter-25)

**Pattern C — Yes → No losses on truth-Yes** (evidence displaced by new higher-ranked but weaker chunks):
- BHP Group 1.1-board-oversight
- Kering 3.3-tnfd-leap-application
- Newmont 1.2-management-responsibility
- Prudential plc 2.1-nature-dependencies

## Per-company F1 delta (lenient)

| Company | 24 F1 | 25 F1 | Δ |
|---|---|---|---|
| Unilever | 0.93 | 0.97 | ↑ +0.04 |
| Banco Santander | 0.80 | 0.82 | = +0.02 |
| Newmont | 0.56 | 0.56 | = 0.00 |
| Prudential | 0.88 | 0.88 | = 0.00 |
| Kering | 0.94 | 0.91 | ↓ −0.03 |
| Nestlé | 0.53 | 0.50 | ↓ −0.03 |
| Samsung | 0.89 | 0.80 | ↓ −0.09 |
| BHP Group | 0.92 | 0.81 | ↓ −0.11 |
| Ambev | 0.00 | 0.00 | flat |
| Walmart | 0.00 | 0.00 | flat |

**Ambev**: F1=0 because truth is nearly all "No" — no positive class in truth, so R undefined. Not a real failure; TN=20/20. Adjust attribution to exclude companies with zero positive truth.

**Walmart**: F1=0 because pipeline scored ALL 20 measures "No" despite 69 successfully-fetched docs (including the FY2026 ESG report and Proxy Statement, both truth-cited). Scoring engine applies a strict "nature-only" filter; analysts interpret Walmart's "sustainability incl. climate" language as covering nature. **This is a scoring interpretation gap, not a discovery gap** — R7 cannot fix it.

## What each R7 rule delivered

R7 rules split into "discovery expansion" (fetched more/different docs) vs "provenance/quality" (accepted evidence more liberally).

| Rule | Truth-doc gap targeted | Iter-25 status |
|---|---|---|
| **R7a** — Q4Inc directory enum | Newmont Q4 CDN files | Pinned tenant `382246808` present; directory enumeration ran but Newmont F1 unchanged (0.56). Latent capacity for other Q4 issuers. |
| **R7b** — IR-platform registry (6 new) | Ambev api.mziq.com | Cannot verify without Ambev positive-class truth; latent capacity. |
| **R7c** — EDGAR multi-form | Ambev 6-K | Ran; adds 6-K/proxy/10-Q to US-listed issuers. Latent capacity for FPI disclosures. |
| **R7d** — Landing page seeding | Airbus/Nestlé landings | Ran on all 10 issuers. Nestlé F1 dropped slightly (−0.03) — new landing pages introduced adjacent-climate evidence that the LLM confused for nature. |
| **R7e** — Sitemap traversal | Walmart /purpose/esgreport subpages | Ran; Walmart already had `/purpose/esgreport` in corpus but scoring engine rejects all. |
| **R7f** — Compound doc-type splitting | Nestlé committee-charter.pdf | Ran on all 10 issuers. Governance-adjacent queries broadened. |
| **R7g** — Gzip fetch fallback + ESEF provenance | Kering ESEF XHTML | Provenance whitelist active; Kering F1 dropped −0.03 (already high — regression from other rules). |

## Root cause of the F1 regression

The precision loss (−0.063) comes from **the LLM scorer, not the discovery layer**:

1. **Partial-verdict creep** (7 cells): the LLM now emits Partial on cells where iter-24 said No. New evidence in the corpus (from R7d landings, R7c EDGAR multi-form) matches the framework's "adjacent evidence" language but not the strict measure. Truth analysts said No.

2. **Adjacent-topic evidence contamination**: R7d landing pages surface general sustainability text that the LLM treats as partial evidence for nature/biodiversity measures.

3. **Evidence-chunk displacement** (4 Yes→No flips): new higher-scoring chunks pushed the actual supporting quotes out of the top-K passed to the LLM. This is a chunking/ranking issue, not a discovery issue.

## Recommended next steps (in order)

1. **Tighten Partial-verdict threshold**: currently 9 Partials in iter-25 (0 in iter-24). Investigate the R6/R7 configs that changed the LLM prompt's willingness to say Partial. Baseline behaviour was to force Yes/No.

2. **Nature-topic ranking boost**: for the Nature framework specifically, boost the ranking of chunks containing "nature", "biodiversity", "natural capital", "ecosystem service" over generic-sustainability chunks. This addresses adjacent-topic contamination in R7d landings.

3. **Chunking/ranking investigation for the 4 Yes→No losses**: verify that the truth-cited evidence chunks are still in the top-K passed to LLM. If displaced, tune scoring or add pin-through logic.

4. **Walmart-specific**: the scoring model's strict "nature-only" interpretation vs analyst "sustainability = nature" is a framework-definition tension. Either (a) relax the framework, (b) tighten analyst adjudication, or (c) accept the strict interpretation and adjust the truth baseline for Walmart.

5. **Ambev-specific**: 20/20 truth "No" cells — this issuer is unsuitable for F1 attribution. Consider replacing with another issuer for the benchmark or excluding from headline F1.

Sources: iter-24 batch 27 immutable_snapshot in analysis_results table; iter-25 batch 28 (2026-09-05T13:14 UTC) after PRs #22, #23, #24 merged. Confusion metrics computed against `Truth verdict` column in `/tmp/truth_final.json` (Sheet 3 of NatureFramework_TruthBaseline_Reconciled.xlsx).
