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
| Cells where trim fired (≥1 redundant repeat removed) | 326 / 360 |
| Original (A5-settled) pack tokens (sum) | 3,920,993 |
| Trimmed pack tokens (sum) | 2,925,442 |
| Tokens saved (sum) | 995,551 |
| **Aggregate token reduction** | **25.39%** |
| Chars saved (sum) | 3,982,208 |
| Projected $ saved / 10-co batch (first-pass, DeepSeek @ $0.27/M in) | $0.2688 |

> Projection is the conservative single-stage (DeepSeek first-pass) input-token saving on the BM25+A5 pack (LLM rescore omitted offline); the pack appears in every cascade stage's prompt, so realized saving compounds across stages. STEP 3's live batch measures the true end-to-end delta.

## Per-company summary

| Company | Cells | Invariant OK | Trim fired | Orig tok | Trim tok | Reduction |
|---|---|---|---|---|---|---|
| CSX Corporation | 36 | 36/36 | 36 | 448,363 | 314,028 | 29.96% |
| MAGNA INTERNATIONAL INC. | 36 | 36/36 | 36 | 438,905 | 298,375 | 32.02% |
| THE SOUTHERN COMPANY | 36 | 36/36 | 36 | 445,912 | 311,856 | 30.06% |
| S&P GLOBAL INC. | 36 | 36/36 | 36 | 493,524 | 346,551 | 29.78% |
| MARTIN MARIETTA MATERIALS, INC. | 36 | 36/36 | 33 | 291,200 | 239,106 | 17.89% |
| DARDEN RESTAURANTS, INC. | 36 | 36/36 | 35 | 348,762 | 246,678 | 29.27% |
| BCE INC. | 36 | 36/36 | 36 | 482,428 | 370,744 | 23.15% |
| STRYKER CORPORATION | 36 | 36/36 | 36 | 452,091 | 339,311 | 24.95% |
| AMPHENOL CORPORATION | 36 | 36/36 | 27 | 332,822 | 283,593 | 14.79% |
| AFLAC INCORPORATED | 36 | 36/36 | 15 | 186,986 | 175,200 | 6.30% |
