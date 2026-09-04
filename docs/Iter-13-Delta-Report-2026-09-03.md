# CompanyIQ v3 — Iter-13 Delta Report

**Date:** 3 September 2026 (~18:00 BST)
**Framework:** Nature and Biodiversity Disclosure Framework (id=3), 20 measures
**Universe:** 10 companies (list id=2) — Nestlé, Unilever, BHP, Kering, Walmart, Samsung, Santander, Ambev, Newmont, Prudential
**Batches:** iter-11 = batch 14 (pre-U2 baseline), iter-12 = batch 15 (post-U2 score-only), iter-13 = batch 16 (post-ISIN + fresh discovery + provenance backfill on affected rows)
**Run time:** 11:10 (batch 16 started 17:48:07Z, terminal 17:59:17Z)

---

## What iter-13 measures

Iter-13 is the full re-analysis triggered after applying tonight's SQL / audit corrections:

1. All 19 rows populated with correct primary-listing ISINs (16 from audit, 3 manual: Prudential plc, Unilever plc, Ambev SA)
2. `related_domains` cleaned on Apple/NextEra/Suncor/Ambev (aggregator removal: `yahoo.com`, `publicnow.com`)
3. `related_domains` augmented on Santander (3 legitimate corporate subsites), Unilever (2 regional sites), L'Oréal (2 corporate sites — L'Oréal not in list 2, marginal)
4. L'Oréal's null domain set to `loreal.com` (not in list 2, marginal)
5. FMP/FIGI/related_domains pipeline-version caches invalidated so discovery re-runs from scratch
6. U17 provenance backfill re-run for the 7 affected companies (23 upgrades on L'Oréal, 3 on Unilever, 1 each on Santander/Ambev)

**Runtime flag state (unchanged from iter-12):** `SCORING_BASE_RATE_PRIOR=true`, `U17_PROVENANCE_FILTER` on (code default), `RETRIEVAL_LLM_RESCORE=1`, `FRAMEWORK_V2_TWO_STEP=1`, `FRAMEWORK_V2_CONTEXT_EXPAND=1`, `FRAMEWORK_V2_EVIDENCE_ABSENT=1`. **`SCORING_CASCADE` is NOT set** — PR#2 cascade is not active. **`retrievalV2` / `autoReretrieval` are NOT set** — PR#1 retrieval hardening is not active.

So iter-13 measures the **incremental effect of the tonight-applied data corrections against a stable code baseline**, not the effect of PR#1/PR#2. Those are a separate future measurement.

---

## Headline result

**Total Yes count across 200 (company × measure) cells:**

| Iteration | Yes | Partial | No | Insufficient | Avg score |
|---|---|---|---|---|---|
| iter-11 (batch 14, pre-U2) | 81 | 15 | 104 | 0 | 41 |
| iter-12 (batch 15, post-U2 score-only) | 90 | 7 | 103 | 0 | 45 |
| iter-13 (batch 16, post-ISIN + fresh discovery) | 87 | 5 | 108 | 0 | 44 |

**iter-12 → iter-13:** −3 Yes, +5 No, −2 Partial. Modest tightening.
**iter-11 → iter-13 cumulative:** +6 Yes, +4 No, −10 Partial, average score 41 → 44. Net positive with lower Partial reliance — the "narrow Partial" direction the user has consistently favoured.

**Interpretation direction:** iter-13 shows the cleaner corpus (aggregator removal + provenance filter + fresh discovery against correct ISINs) produces slightly more No verdicts than the base-rate-prior alone did. This is exactly the interaction risk that U2's documentation flagged: the prior nudges Yes upward, so a cleaner corpus that removes previously-supporting third-party quotes will pull back. **Net effect vs pre-U2 baseline remains positive.**

---

## Per-company Yes counts

| ID | Company | iter-11 | iter-12 | iter-13 | iter-11 → iter-13 | Notes |
|---|---|---|---|---|---|---|
| 1 | Nestlé | 8 | 8 | 7 | −1 | Slight tightening; 3 Partials in iter-13 vs 0 in iter-12 suggests more cautious scoring |
| 11 | Unilever | 12 | 15 | 16 | **+4** | Largest positive movement across the three iterations |
| 12 | BHP Group | 13 | 13 | 13 | 0 | Stable — reasonable given BHP's TNFD-aligned disclosure |
| 13 | Kering | 14 | 15 | 14 | 0 | iter-13 dropped 1 from iter-12; net neutral vs iter-11 |
| 14 | Walmart | 10 | 12 | 11 | **+1** | Modest positive |
| 15 | Samsung Electronics | 11 | 11 | 12 | **+1** | Modest positive |
| 16 | Banco Santander | 1 | 6 | 2 | **+1** | Base-rate prior inflated 1 → 6; cleaner corpus brought it to 2. Net +1 |
| 17 | Ambev | 0 | 0 | 0 | 0 | **Still fetch-blocked** — U7 (browser hardening) is the missing lever |
| 18 | Newmont Corporation | 10 | 8 | 10 | 0 | Recovered iter-11 level; U17 provenance filter removed some third-party quotes, discovery found equivalent first-party support |
| 19 | Prudential plc | 2 | 2 | 2 | 0 | Ticker collision resolved (ISIN now `GB0007099541`), but Yes count unchanged. Two Partials in iter-12 converted to No |

**Named observations from the change roadmap:**

- **Newmont measure 2.4 (nature-opportunities)** — iter-11 audit flagged Yes supported by 3-of-5 third-party Proteus PDF quotes. iter-13 per-measure yesCount for 2.4: 6 → 5 (i.e. one Yes was downgraded). Direction consistent with U17 Fix A blocking the Proteus content
- **Prudential 1.1 (board-oversight)** — iter-11 audit flagged iter-11 Yes was scored against Prudential Financial US content. iter-13: still No. The ISIN correction populated identity but the corpus was rebuilt with correct discovery — no Yes rebound because the actual Prudential plc content presumably doesn't cleanly discuss nature-related board oversight. Expected given nature disclosure is weak across financials
- **Ambev**: unchanged. The domain family cleanup (removing `publicnow.com`) reduced noise but the underlying documents themselves are third-party-heavy (72% still third-party after the backfill). Browser hardening (U7) unlocks the actual issuer content

---

## Per-measure Yes counts (across all 10 companies)

| Measure | iter-11 | iter-12 | iter-13 | iter-11 → iter-13 |
|---|---|---|---|---|
| 1.1-board-oversight | 3 | 4 | 4 | +1 |
| 1.2-management-responsibility | 4 | 3 | 3 | −1 |
| 1.3-governance-processes | 3 | 5 | 4 | +1 |
| 1.4-integration-strategy | 4 | 6 | 5 | +1 |
| 1.5-stakeholder-engagement | 0 | 1 | 0 | 0 |
| 1.6-remuneration-linkage | 1 | 1 | 2 | +1 |
| 2.1-nature-dependencies | 7 | 8 | 7 | 0 |
| 2.2-nature-impacts | 8 | 8 | 8 | 0 |
| 2.3-nature-risks | 5 | 5 | 5 | 0 |
| 2.4-nature-opportunities | 6 | 6 | 5 | −1 |
| 2.5-priority-locations | 3 | 3 | 3 | 0 |
| 2.6-business-model-resilience | 1 | 2 | 2 | +1 |
| 2.7-strategic-response | 6 | 9 | 8 | +2 |
| 2.8-value-chain-assessment | 5 | 4 | 5 | 0 |
| 3.1-identification-process | 7 | 8 | 8 | +1 |
| 3.2-prioritization-approach | 6 | 6 | 6 | 0 |
| 3.3-tnfd-leap-application | 3 | 2 | 2 | −1 |
| 3.4-integration-erm | 4 | 4 | 5 | +1 |
| 3.5-mitigation-hierarchy | 4 | 4 | 4 | 0 |
| 3.6-scenario-analysis | 1 | 1 | 1 | 0 |
| **TOTAL** | **81** | **90** | **87** | **+6** |

Most measures are stable across the three iterations (±0 or ±1 Yes). Two measures with iter-11 → iter-13 movement worth noting:

- **2.7-strategic-response +2**: strongest positive. The base-rate prior helped this measure (6 → 9) and cleaner corpus didn't reverse it (8). This is a broadly-applicable measure; the prior calibration probably matched it well
- **2.4-nature-opportunities −1**: the Newmont-audit-motivated measure. As expected — the provenance filter removed at least one Yes that had been resting on third-party quotes

---

## Corpus state at iter-13 discovery

Per-company document counts post-fresh-discovery (i.e. iter-13 corpus) with source-type breakdown after the provenance backfill:

| ID | Company | Total docs | First-party | Third-party | % third-party |
|---|---|---|---|---|---|
| 1 | Nestlé | 62 | 40 | 22 | 35.5% |
| 11 | Unilever | 132 | 24 | 108 | 81.8% |
| 12 | BHP Group | 92 | 67 | 25 | 27.2% |
| 13 | Kering | 137 | 115 | 22 | 16.1% |
| 14 | Walmart | 79 | 64 | 15 | 19.0% |
| 15 | Samsung Electronics | 99 | 81 | 18 | 18.2% |
| 16 | Banco Santander | 79 | 58 | 21 | 26.6% |
| 17 | Ambev | 97 | 27 | 70 | 72.2% |
| 18 | Newmont Corporation | 123 | 95 | 28 | 22.8% |
| 19 | Prudential plc | 52 | 42 | 10 | 19.2% |

**8 of 10 companies are within the 5-35% third-party band the handover cited as healthy.** Two outliers:

- **Unilever 82% third-party** — largest gap. The ISIN correction to `GB00B10RZP78` (LSE primary) will help future runs; iter-13 already used it. The residual gap is that Unilever's disclosure ecosystem is genuinely fragmented across regional sites (`unileverconsumercarebd.com`, `unilevernepal.com`, `hul.co.in`, `unileverusa.com`) — most of which are missing from `related_domains`. The regional-variant search in the audit picked up 2 of these; more work needed
- **Ambev 72% third-party** — U7 fetch-block. Ambev's IR site `ri.ambev.com.br` runs on MZiQ, one of the IR-portal vendors T3.2 (CDN admission) and T3.1 (browser hardening) are designed to handle

---

## What this iteration confirms

1. **The ISIN and domain corrections are not causing regressions.** Cumulative iter-11 → iter-13 is net-positive (+6 Yes, average score +3 points), and no company went net-negative more than 1 point vs iter-11
2. **The base-rate prior (U2) and provenance filter (U17 Fix A) interact as designed** — U2 pushes Yes up, U17 Fix A tightens against low-quality supporting evidence. The combination lands roughly where iter-11 was, but with better corpus provenance underlying the verdicts
3. **Ambev cannot be improved without U7 (browser fallback hardening)** — quantitatively, and by direct observation of the 72% third-party corpus. T3.1 is the critical next lever for that specific company
4. **Prudential's identity fix worked at the data layer** but produced no verdict lift, which is defensible given the framework subject (nature/biodiversity disclosure by a life insurer)
5. **Newmont's provenance concerns from iter-11 audit have been mechanically addressed** — measure 2.4 dropped one Yes, consistent with the Proteus PDF being filtered out

---

## What this iteration does NOT resolve

1. **No independent truth baseline against this framework.** The primary-source truth baseline in memory (`CompanyIQ-v3--Primary-Source-Truth-Baseline-22-Banks--fw3fw8.md`) is for the 22-bank fw3 climate + fw8 modern slavery run, not for this 10-company nature framework. Without truth labels, "correctness" of the iter-13 verdicts cannot be measured — only movement direction
2. **PR#1 (retrieval hardening) and PR#2 (cascade) effects unmeasured** — neither `retrievalV2` nor `SCORING_CASCADE` flags are on. Turning them on and re-running is the next natural measurement, but that's a separate iteration (iter-14 candidate)
3. **Compound-question and cross-measure quote-reuse effects unmeasured** — the framework has some measures that may be compound (1.4 integration-strategy, 3.4 integration-erm) which U15 (T3.6 atomicity rule) would flag. Not addressed by iter-13

---

## What this tells us about roadmap sequencing

Reading the roadmap Section 7 sequence against iter-13's results:

- **T1.2 (U17 Fix B — scoring-time provenance gate)** — moderate priority. Iter-13 shows the corpus-build filter (Fix A) is already doing most of the work; the scoring-time safety net will catch cases Fix A misses but the marginal contribution appears smaller than expected. Still worth shipping — the mechanism is small and correct — but no longer a top-3 lever
- **T1.3 (U9 Layer 1 — verbatim re-fetch + tier gating)** — priority *unchanged*. Nothing in iter-13 addresses fabricated or drifted citations; this remains the cheapest audit-defensibility win
- **T1.4 (U3 — force translation for non-English)** — iter-13 corpus counts suggest this may unlock recall on Nestlé (35% third-party could be lower with Swiss/French/German native content) and remains the right next lever for that
- **T3.1 (U7 — browser hardening)** — **promoted urgency**. Ambev is proof that no amount of upstream fix helps a company whose fetches are being blocked. If Ambev matters to you as a specific data point, U7 moves up in priority

**Roadmap update:** the recommended sequence still holds, but T3.1 (U7 browser hardening) is a stronger candidate for early Tier-2 promotion than I had it. Everything else stays.

---

## Artefacts

- **Batch 16** in `batch_runs` table, `terminal_at = 2026-09-03T17:59:17Z`, all 10 jobs completed cleanly, zero failures
- **framework_v2_iterations row 14** contains the full per-measure and per-company snapshot; `analysis_results` id=16 is the acceptance-pending snapshot
- **Per-measure verdict data**: cached at `/tmp/iter13_full.json` in the sandbox — includes iter-11, iter-12, iter-13 side-by-side with per-company verdicts. Copied to `docs/iter13_full.json` for durability

## Next step

Per the roadmap, the next item is **T1.2 — U17 Fix B**. Its expected marginal contribution has been slightly reduced by iter-13 evidence (Fix A appears to catch most of the third-party content already), but the mechanism is still worth shipping. Estimated ~1 day of work.

Alternative if Ambev matters: pull **T3.1 (U7 browser hardening)** forward. Iter-13 makes clear it's the specific unblock for that company.

Your call on which to do next.
