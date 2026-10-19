# B5 / WP13-C GATE5 — STEP 1 Offline Held-Out Proof

**Baseline corpus:** batch 1293 (A5-on, B1-on, B5-off) · framework 18 "AI Management"
**Cells:** 360 (10 companies × 36 measures)
**Reconstruction:** REAL summarizeDocuments (retrievalV2=false) + REAL buildEvidencePacksForCategory (per category) + A5 planBoundedExpansion + B5 planContextTrim — same seam/order as analyzer.ts.

## Hard invariant (verifyTrimPreservesRecall)

- Cells where invariant holds: **360 / 360**
- Violating cells: **0**
- **Proof PASSES ✅ (100% of cells)**

## Token savings (B5 trim, policy=on)

| Metric | Value |
|---|---|
| Cells where trim fired (≥1 redundant repeat removed) | 242 / 360 |
| Original (A5-settled) pack tokens (sum) | 5,221,547 |
| Trimmed pack tokens (sum) | 4,822,021 |
| Tokens saved (sum) | 399,526 |
| **Aggregate token reduction** | **7.65%** |
| Chars saved (sum) | 1,598,104 |
| Projected $ saved / 10-co batch (first-pass, DeepSeek @ $0.27/M in) | $0.1079 |

> Projection is the conservative single-stage (DeepSeek first-pass) input-token saving on the BM25+A5 pack (LLM rescore omitted offline); the pack appears in every cascade stage's prompt, so realized saving compounds across stages. STEP 3's live batch measures the true end-to-end delta.

## Per-company summary

| Company | Cells | Invariant OK | Trim fired | Orig tok | Trim tok | Reduction |
|---|---|---|---|---|---|---|
| CSX Corporation | 36 | 36/36 | 28 | 585,447 | 560,280 | 4.30% |
| MAGNA INTERNATIONAL INC. | 36 | 36/36 | 36 | 613,043 | 556,927 | 9.15% |
| THE SOUTHERN COMPANY | 36 | 36/36 | 36 | 612,478 | 507,368 | 17.16% |
| S&P GLOBAL INC. | 36 | 36/36 | 33 | 634,220 | 588,053 | 7.28% |
| MARTIN MARIETTA MATERIALS, INC. | 36 | 36/36 | 36 | 408,795 | 360,624 | 11.78% |
| DARDEN RESTAURANTS, INC. | 36 | 36/36 | 36 | 413,633 | 328,682 | 20.54% |
| BCE INC. | 36 | 36/36 | 36 | 645,526 | 612,221 | 5.16% |
| STRYKER CORPORATION | 36 | 36/36 | 0 | 607,959 | 607,959 | 0.00% |
| AMPHENOL CORPORATION | 36 | 36/36 | 1 | 447,849 | 447,310 | 0.12% |
| AFLAC INCORPORATED | 36 | 36/36 | 0 | 252,597 | 252,597 | 0.00% |
