# Investigation: Prudential plc and Kering remaining FN cells

**Date**: 2026-09-04
**Purpose**: Adjudicate the 4 High-confidence FN cells remaining after iter-14 for Prudential plc (2) and Kering (2) to classify each as discovery, retrieval, or scoring failure, and identify generalisable fixes.

## TL;DR

| Company | Measure | Truth quote source | Iter-14 corpus? | Root cause |
|---|---|---|---|---|
| Kering | 1.2-management-responsibility | `Environmental_Policy_2024_2025.pdf` | **No** | **Discovery miss** — policy vehicle not in R1 aggregator |
| Kering | 3.3-tnfd-leap-application | `Additional_information_to_ESG_reporting_2024_2025.pdf` | **No** | **Discovery miss** — supplementary ESG addendum not in vehicle list |
| Prudential plc | 2.1-nature-dependencies | HKEX-filed Sustainability Report | **No** | **Entity resolution miss** — pipeline fetched Prudential Financial (US) instead |
| Prudential plc | 2.2-nature-impacts | HKEX-filed Sustainability Report | **No** | **Entity resolution miss** (same) |

None of these 4 cells is a pure scoring failure. Two are pure discovery misses (Kering-specific vehicles not in the framework's aggregated `required_doc_types`), two are entity-resolution / ranking failures where the wrong company's filings dominated.

Note on Prudential ranking: I initially inspected iter-14 evidence quotes and thought at least one FN was a scoring failure (the pipeline found nature/biodiversity references but scored No). On deeper inspection those quotes came from Prudential Financial documents talking about "Financing the Transition" (climate, not nature), so the No verdict was correct — the failure is upstream at entity resolution.

## Detail — Kering

### 1.2-management-responsibility

**Truth quote** (from `Environmental_Policy_2024_2025.pdf`):
> The Chief Sustainability Officer leads the implementation of Kering's Biodiversity Strategy and Environmental Policy, coordinating with House sustainability teams and reporting to the Executive Committee…

**Iter-14 pipeline evidence summary**:
> The evidence provided focuses on climate-related responsibilities, with explicit mentions of the Chief Sustainability Officer and CEO having responsibility for climate-related risks and opportunities.

The pipeline had CSO material but only from climate-oriented sections in other docs. The Environmental Policy 2024-2025 — where the CSO's biodiversity oversight is explicit — was never fetched.

**Why R1 missed it**: The Environmental Policy is a "policy" vehicle, ranked at 50 in R1's aggregator vs. sustainability report at 100. Only the top-8 vehicles feed the vehicle-query lane by default, so policy queries never fired. Furthermore, "environmental statement" (a near-synonym of the doc title) is in R1's REJECT_PATTERNS.

**Generalised fix candidates**:
1. **Increase R1's `maxVehicles` cap** from 8 to 12, so lower-ranked policy vehicles get their queries.
2. **Remove "environmental statement" from REJECT_PATTERNS** — it filtered out a legitimate vehicle.
3. **Add company-specific vehicle discovery** — infer additional vehicles from the company's IR site's document listing (once discovered), not just from the framework.

### 3.3-tnfd-leap-application

**Truth quote** (from `Additional_information_to_ESG_reporting_2024_2025.pdf`):
> In 2023 and 2024, Kering has been one of the 17 corporate participants in the Initial Target Validation Group set up by the Science-Based Targets Network (SBTN), to pilot the validation process for the SBTs for Nature (land, freshwater and biodiversity).

**Iter-14 pipeline evidence summary**:
> Kering provides extensive disclosure about its nature and biodiversity assessment work, including its EP&L methodology, involvement with SBTN pilot projects, and use of tools like the WWF Biodiversity Risk Filter, and TNFD Early Adopter commitment. However, the specific LEAP (Locate, Evaluate, Assess, Prepare) approach is not explicitly named as such.

**This is a false negative caused by literal-string matching.** The pipeline correctly extracted evidence of Kering's SBTN pilot participation and TNFD Early Adopter status — both of which qualify as "TNFD LEAP or similar nature assessment methodology" per the measure's wording. But the scoring model over-narrowed on the literal "LEAP" acronym and returned No. **This is the topic-strict term split problem in reverse** — the scorer was too strict.

**Root-cause**: The measure title says "TNFD LEAP approach OR similar" but scoring collapsed the OR clause. The truth doc would probably not have flipped the verdict either; the fix is at scoring time.

**Generalised fix candidates**:
1. **R5 measure clause parser** — split each measure's title on "OR", score against each disjunct independently, take the max.
2. **Confidence-driven abstention** — when scoring returns No with Low confidence AND positive evidence is present in the summary, re-score with an explicit disjunction prompt.

## Detail — Prudential plc

### Entity resolution failure

**What the pipeline resolved for "Prudential plc"**:

| Field | Value |
|---|---|
| ISIN | GB0007099541 (correct, UK) |
| Country | United Kingdom (correct) |
| Ticker | PRU (correct — LSE / HKEX) |
| **Verified domain** | **`prudential.com`** (WRONG — this is Prudential Financial US) |
| Legal name | Prudential plc |

The domain-verification step accepted `prudential.com` because it matches the ticker "PRU". `prudential.com` belongs to Prudential Financial Inc. (NYSE:PRU), the unrelated US insurance company. Prudential plc's actual sites are `prudentialplc.com` and `prudential.com.sg`.

**Consequence**: The pipeline then discovered SEC 10-K, Q4-CDN-hosted Proxy Statement, and stocklight.com results — all Prudential Financial documents — and classified them as first-party. R2's IR-platform CDN rule *worked as designed* on `s203.q4cdn.com/245412310/…` — but classifier rules fire on the (wrongly-attributed) company context. R2 has no way of knowing this Q4 CDN belongs to a different Prudential.

**Iter-14 corpus contamination** (13 documents):
- ✗ SEC filings for CIK 1137774 (Prudential Financial, US)
- ✗ q4cdn.com Prudential-Proxy2026.pdf (US)
- ✗ stocklight.com/stocks/us/nyse-pru/ (US)
- ✗ MetLife-Proxy-Statement.pdf (unrelated US insurer)
- ✗ LD Fondes dialogliste (Danish pension fund's engagement list)
- ✓ prudential.com.sg (Prudential plc Asia — correct)
- ✓ prudentialplc.com (correct)
- ✗ 0 HKEX filings

**The R1 vehicle queries DID surface `hkexnews.hk/…2025040900053.pdf` in web search (I re-verified live).** But those results were deprioritised by ranker because the "verified domain" set didn't include `hkexnews.hk`, so trusted-source and IR-domain lanes favoured `prudential.com` (US) docs.

`entityVerification.totalDocumentsVerified = 0` — the verification lane never ran on any candidate, so nothing was blocked.

**Generalised fix candidates** (this is R4's remit — restated with sharper framing):

1. **R4 (country-gated EDGAR)** — the pre-existing R4 design closes half the loop by preventing US SEC filings from being accepted when the issuer's `country != US`.
2. **Domain acceptance must require country / jurisdictional match** — reject `prudential.com` as a candidate domain for Prudential plc unless it demonstrably serves UK/HK content. Rule: accept a domain only if it either (a) appears in the FIGI-registered legal-domain list, or (b) has a WHOIS/registrar country matching the issuer's country, or (c) has ≥2 corroborating first-party signals (ticker + ISIN + legal name mention on page).
3. **Ambiguous-ticker gate** — a plaintext ticker match ("pru") should not be sufficient to accept a candidate domain when multiple issuers share the ticker. Detection: query FIGI/Bloomberg for other issuers with the same ticker in different countries; if any exist, require a stronger signal.
4. **Entity verification lane must actually run** — `totalDocumentsVerified: 0` on Prudential is a bug regardless of root cause. Verification should run per-document to catch cross-issuer contamination even if domain resolution failed.

Fix (2) is a generalised superset of R4. Every ambiguous ticker case benefits, not just Prudential.

## What Kering FN 3.3 and Prudential FNs tell us about R5 design

**Original R5 hypothesis**: retrieval finds the right documents but scoring can't extract the right sections.

**Reality after this investigation**: for the 4 remaining FN cells, section-aware retrieval alone would fix 0 of 4:
- Kering 1.2 and 3.3 need discovery fixes (miss the whole document).
- Prudential 2.1 and 2.2 need entity-resolution fixes (miss the whole company's docs).

However, R5 remains valid for the **Newmont 7 FN cells** — the iter-14 delta report shows the s24.q4cdn.com Sustainability Report entered the corpus but scoring didn't find biodiversity content. That's the classic section-retrieval problem. And Kering 3.3 does need one component of R5 — the OR-clause disjunctive scoring.

## Recommended priority ordering (updated)

Revised from the iter-14 delta report:

1. **R4 with sharpened domain-jurisdiction rule** (higher priority than before). Fixes Prudential (2 High-conf FN) + any other cross-jurisdiction ticker collision. Also addresses the "entity verification never runs" bug.
2. **R5 (section-aware retrieval + disjunctive-clause scoring)**. Fixes Newmont (7 High-conf FN) + Kering 3.3.
3. **R1 refinement: expand policy vehicle coverage**. Fixes Kering 1.2. Small change: bump `maxVehicles` cap, revise REJECT_PATTERNS.
4. **R6 (HTML content extraction)** — Walmart 2 FN.

## Reproducibility

- Iter-14 evidence extraction: `select results_data from analysis_results where batch_id=17`.
- Kering iter-14 corpus: `SELECT url, source_type FROM documents WHERE company_id = (SELECT id FROM companies WHERE name='Kering') AND created_at > '2026-09-04 11:09'` (22 docs).
- Prudential iter-14 corpus: 13 docs (10 wrong-entity, 3 correct).
- Truth quotes for Kering FN cells: `/tmp/fn_cells.json`.
- Live-search re-verification: `pplx_sdk.search.web('"Kering" "Environmental Policy" filetype:pdf')`.
