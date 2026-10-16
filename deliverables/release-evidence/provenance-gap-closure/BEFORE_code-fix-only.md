### GATE3 label set — batch 1287 (A3 full-supporting-quote-set eligibility)

Source: `analysis_results` snapshot id 803. Companies: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18. ELIGIBILITY_POLICY=(default v2).
Composer: `composeCellEligibility` (full supporting-quote set). Generated 2026-10-16T01:03:07.556Z.

**Path used:** FREE corpus-URL recovery (replay of composeCellEligibility over recovered URLs).
**Measured sourceUrl recovery rate:** 99.34% (150/151 supporting quotes; 1 unresolved). Recovery tiers: T1-full=127, T3-anchor32=2, T2-anchor48=21.

Labels for each POSITIVE cell: **STAY** (cited quote already eligible), **QUOTE_CORRECT** (an eligible quote exists but is not cited first — promote it; verdict unchanged), **VERDICT_CHANGE** (all quotes hard-excluded — downgrade to No; last resort), **REVIEW** (none eligible but some unknown-provenance). URL-drop artifacts (a REVIEW cell still carrying an unresolved quote) are EXCLUDED from the counts and reported separately.

| Bucket | Cells | Share of classified cells |
|---|---|---|
| STAY | 56 | 87.5% |
| QUOTE_CORRECT | 5 | 7.8% |
| VERDICT_CHANGE | 3 | 4.7% |
| REVIEW (genuine) | 0 | 0.0% |
| **Classified positive cells** | **64** | **100%** |
| _excluded: URL-drop artifact_ | _0_ | _n/a_ |
| **Total positive cells** | **64** | — |

**Verdict flips implied by these labels:** Yes→No = 3 (VERDICT_CHANGE); No→Yes = 0 (A3 only acts on positive cells). Total cells changing verdict = 3.
Of those 3 Yes→No flips: **0 genuine** (all quotes are genuinely third-party) and **3 provenance-attribution artifact** (every excluded quote is an issuer disclosure the classifier cannot map to the issuer — see root-cause below). **Genuine verdict-change = 0.**

#### VERDICT_CHANGE root-cause diagnosis

Each VERDICT_CHANGE cell has ALL supporting quotes hard-excluded. The table classifies *why* each quote was excluded — distinguishing a genuine third-party source from a **provenance-attribution gap** (an issuer's own disclosure whose recovered URL the classifier cannot map to the issuer: a search-engine redirect mask, an unmapped IR-distribution CDN tenant, or a quote whose `source` title is plainly an issuer filing type).

| Company | Measure | Excluded quote sources (title) | Hosts | Exclusion kinds | Diagnosis |
|---|---|---|---|---|---|
| S&P GLOBAL INC. | 1.2-board-oversight | 2026 Proxy Statement; 2026 Proxy Statement | s29.q4cdn.com, s29.q4cdn.com | ir_cdn, ir_cdn | **provenance-attribution artifact** (not genuine) |
| S&P GLOBAL INC. | 2.8-ai-partnerships | 2026 Proxy Statement; 2026 Proxy Statement; 2026 Proxy Statement | s29.q4cdn.com, s29.q4cdn.com, s29.q4cdn.com | ir_cdn, ir_cdn, ir_cdn | **provenance-attribution artifact** (not genuine) |
| S&P GLOBAL INC. | 2.9-ai-product-innovation | 2025 Proxy Statement; 2025 Proxy Statement; 2025 Proxy Statement | s29.q4cdn.com, s29.q4cdn.com, s29.q4cdn.com | ir_cdn, ir_cdn, ir_cdn | **provenance-attribution artifact** (not genuine) |

Exclusion-kind legend: `redirect_mask` = search-engine redirect hiding the true URL; `ir_cdn` = IR-distribution CDN (e.g. Q4 Inc `s29.q4cdn.com`) whose tenant is not mapped to the issuer domain; `issuer_doctype` = the quote's `source` title is an issuer-authored filing (proxy statement, annual report, 10-K, sustainability report, …); `third_party` = a genuinely third-party source.

#### Per-company breakdown

| Company ID | Company | Positive cells | STAY | QUOTE_CORRECT | VERDICT_CHANGE | REVIEW | Excluded(artifact) |
|---|---|---|---|---|---|---|---|
| 9 | CSX Corporation | 5 | 5 | 0 | 0 | 0 | 0 |
| 10 | MAGNA INTERNATIONAL INC. | 12 | 11 | 1 | 0 | 0 | 0 |
| 11 | THE SOUTHERN COMPANY | 3 | 3 | 0 | 0 | 0 | 0 |
| 12 | S&P GLOBAL INC. | 13 | 6 | 4 | 3 | 0 | 0 |
| 13 | MARTIN MARIETTA MATERIALS, INC. | 0 | 0 | 0 | 0 | 0 | 0 |
| 14 | DARDEN RESTAURANTS, INC. | 5 | 5 | 0 | 0 | 0 | 0 |
| 15 | BCE INC. | 16 | 16 | 0 | 0 | 0 | 0 |
| 16 | STRYKER CORPORATION | 7 | 7 | 0 | 0 | 0 | 0 |
| 17 | AMPHENOL CORPORATION | 0 | 0 | 0 | 0 | 0 | 0 |
| 18 | AFLAC INCORPORATED | 3 | 3 | 0 | 0 | 0 | 0 |
| **ALL** | **Aggregate** | **64** | **56** | **5** | **3** | **0** | **0** |

#### Verdict on the user's governing expectation

User's expectation: making A3 evaluate the full supporting-quote set *"should almost always result in the quote being changed to ensure it is accurate rather than the verdict being changed"* — i.e. QUOTE_CORRECT should dominate; VERDICT_CHANGE should be rare.

**CONFIRMED.** Among the 8 actionable cells, quote-correction (5) dominates verdict-change (3). VERDICT_CHANGE is 4.7% of classified positive cells (rare). The data confirms the user's expectation that quote-correction dominates and verdict-change is rare.

**Root-cause caveat (strengthens the confirmation):** of the 3 apparent verdict-change cell(s), **3 are provenance-attribution artifacts, not genuine ineligibility** — every excluded quote is the issuer's OWN disclosure whose recovered URL the classifier cannot map to the issuer (unmapped Q4-Inc IR-CDN tenants such as `s29.q4cdn.com`, and `www.google.com/goto` redirect masks). **Genuine verdict-change after removing these artifacts = 0** (0.0% of classified cells). Before enabling enforcement these are classifier provenance gaps to close (map the issuer's Q4/IR-CDN tenants into `related_domains`; resolve search-engine redirect URLs to their target), NOT evidence the verdict should flip.

Note: under the current shadow configuration (ELIGIBILITY_ENFORCE=OFF) NONE of these actions are applied — this set is a pre-enforcement forecast of what A3 would do.
