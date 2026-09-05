# Noise-floor diagnosis — the real reason iter-15 looked like a regression

**Date**: 2026-09-04
**Context**: After iter-15 (with R5c+R5d+R5e) showed a large recall drop vs iter-14, we rolled the R5 PRs back (PR #14) and reran the pipeline against the same code as iter-14 to measure the intrinsic noise floor. That rerun is iter-16 (batch 19).

## Headline finding: **the noise floor is enormous — and it's not in scoring**

Iter-14 vs iter-16, **identical code, identical inputs**:

| Metric | Iter-14 | Iter-16 | Δ |
|---|---|---|---|
| High-conf recall | 0.810 | **0.655** | **-0.155** |
| High-conf F1 | 0.889 | 0.786 | -0.103 |
| Medium-conf recall | 0.571 | 0.286 | -0.285 |
| Cell-level agreement | — | **83.5%** | 33 of 200 cells flipped |
| High-conf cell flips | — | **13% (16 cells)** | — |

**33 cells (16.5% of the truth baseline) produce different verdicts run-to-run on the same code.**

This is much larger than what stochastic scoring alone would produce (~3-5% from mistral-arbiter, the only remaining seed-unaware model in the cascade).

## Actual root cause: discovery / fetch instability

Comparing iter-14 vs iter-16 corpus sizes on identical code:

| Company | Iter-14 disc/fetched | Iter-16 disc/fetched | Change | iter-16 dead-fetch reasons |
|---|---|---|---|---|
| Ambev | 52 / 42 | **None / None** | *diagnostics missing* | transient=5, empty_after_render=2, fetch_returned_empty=1 |
| BHP Group | 108 / 103 | 49 / 49 | -55% | none |
| Banco Santander | 94 / 92 | 46 / 44 | -51% | transient=1 |
| Kering | 152 / 149 | 73 / 71 | -52% | transient=2 |
| Nestlé | 82 / 71 | 54 / 35 | **-51% fetched** | transient=6, **circuit_broken=13** |
| Newmont | 149 / 131 | 69 / 61 | -53% | transient=7, fetch_returned_empty=1 |
| Prudential plc | 59 / 57 | **None / None** | *diagnostics missing* | transient=1 |
| Samsung Electronics | 121 / 115 | 52 / 50 | -57% | transient=2 |
| Unilever | 137 / 122 | 42 / 37 | -70% | transient=2, empty_after_render=2, fetch_returned_empty=1 |
| Walmart | 90 / 86 | **None / None** | *diagnostics missing* | transient=3, fetch_returned_empty=1 |

**Observations:**

1. **Corpus size dropped by 50-70% across every company** — this is not a couple of stochastic fetches, this is a systematic contraction.
2. **`documentsDiscovered=None` for 3 of 10 companies** (Ambev, Prudential, Walmart) — the discovery pipeline partially failed to write diagnostics, meaning it exited via a non-standard code path.
3. **Every company had `transient` fetch failures** — the Cloudflare/CDN fetcher (or the underlying HTTP client) is unstable at scale.
4. **Nestlé had 13 `circuit_broken` events** — a provider hit its credit-exhaustion breaker and downstream fetches were skipped rather than retried.
5. **Walmart shrank most dramatically** and its recall collapsed 6/8 (75%) → 0/8 (0%) — one of the biggest "regressions" in iter-15 turned out to be intrinsic pipeline volatility.

## Why the pipeline is so sensitive to corpus size

Pipeline: web-search → fetch → chunk → BM25 index → per-measure retrieval (top-20 chunks) → LLM scoring.

When the corpus is 50 docs instead of 100:
- Same top-20 retrieval budget → BM25 picks different chunks because the IDF landscape is different (rarer terms get boosted).
- Different chunks reach the scoring prompt → different evidence text → different verdicts.
- The cascade's stage-1 (deepseek) and stage-2 (glm-4.6) may agree or disagree based on the specific chunks — mistral-arbiter only fires ~15-20% but even the stage-1/2 verdicts change because their input text is different.

So a stochastic corpus is amplified through the scoring path even when scoring itself is deterministic.

## What iter-15's "regression" actually was

Iter-15 was a mix of:
- **Real R5e over-rejection** (santander.com, bhp.com rejected on ticker-only match — provable, deterministic)
- **Real R5c/R5d corpus expansion** (Newmont/Kering got docs they didn't have before — provable)
- **~10-15% noise-floor cell flips** from discovery instability — INDISTINGUISHABLE from real regressions in a single run

Post-iter-16 evidence: iter-14 → iter-16 showed a 15.5-point recall drop with NO code change, which is larger than the iter-14 → iter-15 15.5-point drop with R5 changes. **The iter-15 R5 changes are not statistically distinguishable from noise on a single-run basis.**

## Implications

1. **Single-run diffs cannot detect effect sizes below ~15% recall.** R5c/R5d/R5e's predicted per-measure impact was 2-3 cells each (~2% recall each). We cannot reliably measure that against a 15%-noise baseline in one run.

2. **The pipeline is not producing reproducible research artifacts.** For a research-grade platform where clients would want to trust results, this is a serious quality gap independent of the R5 investigation.

3. **The user's original diagnostic path was correct.** The recall gap between the pipeline and the reconciled truth (which had inter-analyst agreement) exists — but attributing individual FN cells to specific code causes requires either (a) many runs averaged, or (b) fixing the discovery instability so single-run diffs are meaningful.

## Recommended path forward (design choices, not action items yet)

**A. Fix discovery stability before evaluating any further R5 changes.**

Concrete levers:
- **Retry transient search failures** with exponential backoff. The `transient=5,6,7` counts suggest the search / fetch stage is failing on temporary network conditions.
- **Do not skip fetches on provider circuit-break** — Nestlé's 13 `circuit_broken` events are dropping 13 candidate documents from the corpus. Circuit-breaker should be scoped to LLM providers, not to document fetching.
- **Empty-page handling**: `empty_after_render` and `fetch_returned_empty` suggest the fetcher is returning empty content on some URLs. Either retry with a different fetch strategy or use the search snippet as fallback content.
- **Diagnostic completeness**: three companies had `documentsDiscovered=None`, meaning the pipeline exited on a code path that didn't write diagnostics. Either fix that, or add a required post-condition that every completed batch has non-null diagnostics.

**B. If discovery stability is intractable, switch to a multi-run evaluation methodology.**

- Run each iteration 3-5 times, take median verdict per cell.
- Compare median-of-N against median-of-N to smooth over noise.
- Cost: 3-5x per experiment. Time: 3-5x per experiment.

**C. Accept the noise floor and design R5 v2 fixes with big-enough effect sizes.**

- R5c: closes 2 cells → too small to detect against 15% noise floor.
- R5d: closes 1 cell → too small.
- R5e: fixes 2 cells → too small.

Individual R5 sub-parts won't survive noise-floor scrutiny even with correct implementations.

## Next-step candidates (need user decision)

- **Path 1**: Fix discovery instability first (retries, no circuit-break on fetches, empty-page fallbacks). Rerun iter-14-equivalent as many times as needed to establish a reliable baseline. Then re-attempt R5 fixes.
- **Path 2**: Switch to a median-of-N evaluation methodology. Rerun iter-14-equivalent 5 times, aggregate. Then evaluate R5 fixes as median-of-5 vs median-of-5.
- **Path 3**: Accept the noise floor. Design R5 fixes that target BIG effect sizes (e.g. rebuild the retrieval ranker to eliminate corpus-size sensitivity, ~15+ cell impact expected). Ship, measure, iterate.

## Historical batch reference

- Iter-13 (batch 16): 62 TP / 22 FN High-conf. R1 pre-shipped.
- Iter-14 (batch 17): 68 TP / 16 FN High-conf. Post R1+R2+U17-B merge but before R5.
- Iter-15 (batch 18): 60 TP / 24 FN High-conf. Post R5c+R5d+R5e merge; investigated as regression.
- Iter-16 (batch 19): 55 TP / 29 FN High-conf. **SAME CODE as iter-14. This is the noise floor.**

Iter-14/16 cell-level disagreement rate: 16.5% overall, 13% High-conf.
