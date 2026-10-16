### GATE3 label set — batch 1287 (A3 full-supporting-quote-set eligibility)

Source: `analysis_results` snapshot id 803. Companies: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18. ELIGIBILITY_POLICY=(default v2).
Composer: `composeCellEligibility` (full supporting-quote set). Generated 2026-10-16T01:04:36.549Z.

**Path used:** FREE corpus-URL recovery (replay of composeCellEligibility over recovered URLs).
**Measured sourceUrl recovery rate:** 99.34% (150/151 supporting quotes; 1 unresolved). Recovery tiers: T1-full=127, T3-anchor32=2, T2-anchor48=21.

Labels for each POSITIVE cell: **STAY** (cited quote already eligible), **QUOTE_CORRECT** (an eligible quote exists but is not cited first — promote it; verdict unchanged), **VERDICT_CHANGE** (all quotes hard-excluded — downgrade to No; last resort), **REVIEW** (none eligible but some unknown-provenance). URL-drop artifacts (a REVIEW cell still carrying an unresolved quote) are EXCLUDED from the counts and reported separately.

| Bucket | Cells | Share of classified cells |
|---|---|---|
| STAY | 63 | 98.4% |
| QUOTE_CORRECT | 1 | 1.6% |
| VERDICT_CHANGE | 0 | 0.0% |
| REVIEW (genuine) | 0 | 0.0% |
| **Classified positive cells** | **64** | **100%** |
| _excluded: URL-drop artifact_ | _0_ | _n/a_ |
| **Total positive cells** | **64** | — |

**Verdict flips implied by these labels:** Yes→No = 0 (VERDICT_CHANGE); No→Yes = 0 (A3 only acts on positive cells). Total cells changing verdict = 0.
Of those 0 Yes→No flips: **0 genuine** (all quotes are genuinely third-party) and **0 provenance-attribution artifact** (every excluded quote is an issuer disclosure the classifier cannot map to the issuer — see root-cause below). **Genuine verdict-change = 0.**

#### Per-company breakdown

| Company ID | Company | Positive cells | STAY | QUOTE_CORRECT | VERDICT_CHANGE | REVIEW | Excluded(artifact) |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 5 | 5 | 0 | 0 | 0 | 0 |
| 10 | MAGNA INTERNATIONAL INC. | 12 | 11 | 1 | 0 | 0 | 0 |
| 11 | THE SOUTHERN COMPANY | 3 | 3 | 0 | 0 | 0 | 0 |
| 12 | S&P GLOBAL INC. | 13 | 13 | 0 | 0 | 0 | 0 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | 0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 5 | 5 | 0 | 0 | 0 | 0 |
| 15 | BCE INC. | 16 | 16 | 0 | 0 | 0 | 0 |
| 16 | STRYKER CORPORATION | 7 | 7 | 0 | 0 | 0 | 0 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | 0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 3 | 3 | 0 | 0 | 0 | 0 |
| **ALL** | **Aggregate** | **64** | **63** | **1** | **0** | **0** | **0** |

#### Verdict on the user's governing expectation

User's expectation: making A3 evaluate the full supporting-quote set *"should almost always result in the quote being changed to ensure it is accurate rather than the verdict being changed"* — i.e. QUOTE_CORRECT should dominate; VERDICT_CHANGE should be rare.

**CONFIRMED.** Among the 1 actionable cells, quote-correction (1) is the ONLY actionable remedy. VERDICT_CHANGE is 0.0% of classified positive cells (rare). The data confirms the user's expectation that quote-correction dominates and verdict-change is rare.

Note: under the current shadow configuration (ELIGIBILITY_ENFORCE=OFF) NONE of these actions are applied — this set is a pre-enforcement forecast of what A3 would do.
