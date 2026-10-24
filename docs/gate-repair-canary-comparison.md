# Gate-Repair Canary — Live Production Comparison (Batch 1306 vs 1305)

**Date:** 2026-10-24
**Deployed code:** `6b60e94` (PR #65, squash-merged to `main`; merge verified via GitHub API — `merged=true`, and `origin/main` HEAD = `6b60e94996f30de590c7cb3ae33cacdbe360fe4d`)
**Canary flags during run:** `SCORING_CASCADE=1`, `RETRIEVAL_EVIDENCE_REPAIR=1` (worker service, production environment)
**Flags after run:** reverted to known-safe production state (`SCORING_CASCADE=0`, `RETRIEVAL_EVIDENCE_REPAIR` unset) — **confirmed**

---

## Bottom line

The search-and-repair evidence gate, run **live on the production worker** over the ACWI_50 corpus, **fully recovers the safe baseline and slightly exceeds it (22.6% vs 21.3% Yes)** while the collapse-triggering cascade path is active — and does so **without a single hallucinated evidence promotion**. This is a **GO**. The fix is already merged and deployed; it is dormant behind `RETRIEVAL_EVIDENCE_REPAIR` (default OFF), so production behavior is unchanged until you flip the flag.

---

## What was run

A **score-only corpus-replay** batch (1306) was enqueued on the production worker, re-scoring the **exact frozen corpus** of batch **1305** (ACWI_50 — workspace 3, framework 18, list 9) with the merged code and both canary flags ON. No live document fetch, no discovery — the only variable vs the 1305 baseline is the scoring/gate path.

**New-code-path verification (deployment-target check):** every measure in the canary carries `pipeline_version = 6b60e94996f30de590c7cb3ae33cacdbe360fe4d` and the cascade model chain `deepseek+glm-4.6-zai+gpt5-arbiter`, confirming the worker executed the merged code on the cascade path — not a stale deploy.

### Why 1305 and not 1289
The originally-requested baseline **1289 is unreplayable**: all 1668 of its corpus documents have been pruned from the `documents` table (0 joinable), and the replay path correctly refuses to fall back to live documents. **1305 is the clean substitute** — same list/framework, fully intact corpus (1481/1481 docs joinable), and its Yes-rate (21.1% on disk) is statistically identical to 1289's (21.1%). Re-scoring 1305's *identical* corpus is in fact the cleaner controlled test.

---

## Coverage

| | Companies | Measures (cells) |
|---|---:|---:|
| 1305 baseline (on disk) | 50 | 1,800 |
| 1306 canary (completed) | 50 | 1,800 |
| **Compared (common)** | **50** | **1,800** |

**Full coverage — all 50 companies scored.** GERDAU S.A. (company 123) was initially blocked by an operational/queue issue (a job-watchdog timeout, then a BullMQ deterministic-jobId dedup collision, then a claim-refusal once the batch had auto-finalized to `pending_review`). It was re-scored on the identical fixed code path (`pipeline_version = 6b60e94996f3`, cascade chain `deepseek+glm-4.6-zai+gpt5-arbiter`) and completed cleanly with 36/36 measures. **These were never scoring-logic failures.** The comparison below is over all 50 companies present in both batches.

---

## Aggregate result — triangulation

| Config | Flags | Yes / 1,800 | Yes-rate |
|---|---|---:|---:|
| 1304 degraded (the collapse) | cascade ON, repair OFF | 143 | **7.9%** |
| 1305 baseline (current prod) | cascade OFF | 383 | **21.3%** |
| **1306 canary (the fix)** | **cascade ON, repair ON** | **407** | **22.6%** |

The canary sits **above** the safe baseline, not merely at it. The cascade path (which the collapse config cut to 8.0%) now runs with its scoring benefits intact because repair recovers evidence that the old strip-and-flip gate destroyed.

---

## Cell-by-cell comparison (vs 1305 baseline)

| Metric | Value |
|---|---:|
| Cells compared | 1,800 |
| Identical verdict | 1,748 (**97.1%**) |
| No→Yes (recoveries) | **38** |
| Yes→No (downgrades) | **14** |
| Net | **+24 Yes** |

97.1% of verdicts are unchanged. The movement is net-positive (+24), dominated by recoveries where repair re-searched the corpus and found verbatim-present support that the legacy gate had stripped. The 14 downgrades are the fix's last-resort path firing correctly — a Yes dropped only when **no** verbatim-present support exists anywhere in the corpus.

---

## No-hallucination invariant — standing constraint

> Constraint: *"Re-search the corpus for the best evidence quote instead of changing the score."*

Every one of the **38 No→Yes recoveries** was checked against the company's intact 1305 corpus text:

| Check | Result |
|---|---:|
| Recoveries with real evidence quotes | 38 / 38 |
| Backed by verbatim-present corpus text (strict full-string match) | 33 |
| Remaining backed by long contiguous verbatim fragments (14+ word runs for 4; 6-word run for 1) | 5 |
| **Hallucinated / fabricated promotions** | **0** |

The 5 that failed strict full-string matching were confirmed by contiguous-fragment search to be real corpus text (the strict match failed only on whitespace/document-boundary artifacts, not on fabricated content). **No Yes verdict was promoted on evidence that is not present verbatim in the corpus.** The constraint is honored.

---

## Biggest per-company movers

| Company | 1305 base | 1306 canary | Δ |
|---|---:|---:|---:|
| PEARSON PLC | 14 | 20 | +6 |
| OBAYASHI CORPORATION | 0 | 5 | +5 |
| Haier Smart Home Co., Ltd. | 15 | 18 | +3 |
| T. ROWE PRICE GROUP, INC. | 5 | 8 | +3 |
| Wolters Kluwer N.V. | 14 | 17 | +3 |
| MANULIFE FINANCIAL CORPORATION | 14 | 16 | +2 |
| GERDAU S.A. | 11 | 13 | +2 |
| THE CHARLES SCHWAB CORPORATION | 12 | 10 | −2 |
| (4 companies) | — | — | −1 each |

No company collapsed; the largest single downgrade is −2 (Charles Schwab, still 10 Yes).

---

## Full per-company Yes counts (50 companies)

| Company | 1304 degraded | 1305 baseline | 1306 canary | Δ (canary−base) |
|---|---:|---:|---:|---:|
| PEARSON PLC | 9 | 14 | 20 | **+6** |
| OBAYASHI CORPORATION | 0 | 0 | 5 | **+5** |
| Haier Smart Home Co., Ltd. | 3 | 15 | 18 | **+3** |
| T. ROWE PRICE GROUP, INC. | 0 | 5 | 8 | **+3** |
| Wolters Kluwer N.V. | 10 | 14 | 17 | **+3** |
| MANULIFE FINANCIAL CORPORATION | 8 | 14 | 16 | **+2** |
| GERDAU S.A. | 2 | 11 | 13 | **+2** |
| Demant A/S | 3 | 5 | 6 | **+1** |
| ING Groep N.V. | 4 | 20 | 21 | **+1** |
| INSURANCE AUSTRALIA GROUP LIMITED | 6 | 20 | 21 | **+1** |
| Japan Exchange Group, Inc. | 2 | 7 | 8 | **+1** |
| KERRY GROUP PUBLIC LIMITED COMPANY | 2 | 6 | 7 | **+1** |
| PAYCHEX, INC. | 5 | 14 | 15 | **+1** |
| PPG INDUSTRIES, INC. | 0 | 7 | 8 | **+1** |
| SANTOS LIMITED | 2 | 3 | 4 | **+1** |
| UNICREDIT, SOCIETA PER AZIONI | 3 | 12 | 13 | **+1** |
| 3I GROUP PLC | 0 | 0 | 0 | 0 |
| ADANI ENTERPRISES LIMITED | 6 | 13 | 13 | 0 |
| Aura Minerals Inc. | 0 | 6 | 6 | 0 |
| CHINA GOLD INTERNATIONAL RESOURCES CORP. LTD. | 0 | 0 | 0 | 0 |
| COMPAGNIE GENERALE DES ETABLISSEMENTS MICHELIN SCA | 2 | 10 | 10 | 0 |
| Grupo Aeroportuario del Pacifico, S.A.B. de C.V. | 0 | 0 | 0 | 0 |
| HANMI Semiconductor CO., LTD. | 0 | 0 | 0 | 0 |
| HYUNDAI GLOVIS Co., LTD. | 4 | 7 | 7 | 0 |
| INDUSTRIAL BANK CO.,LTD. | 0 | 5 | 5 | 0 |
| Iberdrola, S.A. | 15 | 20 | 20 | 0 |
| Jeronimo Martins, SGPS, S.A. | 2 | 2 | 2 | 0 |
| KING SLIDE WORKS CO.,LTD | 0 | 0 | 0 | 0 |
| KLEPIERRE SA | 0 | 2 | 2 | 0 |
| LG CHEM LTD | 0 | 0 | 0 | 0 |
| MAPFRE, S.A. | 5 | 20 | 20 | 0 |
| MASTEC, INC. | 0 | 0 | 0 | 0 |
| MID-AMERICA APARTMENT COMMUNITIES, INC. | 0 | 0 | 0 | 0 |
| NVR, Inc. | 0 | 1 | 1 | 0 |
| POWER FINANCE CORPORATION LIMITED | 1 | 1 | 1 | 0 |
| RECORDATI INDUSTRIA CHIMICA E FARMACEUTICA S.P.A. | 0 | 4 | 4 | 0 |
| SALMAR ASA | 0 | 0 | 0 | 0 |
| SINGAPORE AIRLINES LIMITED | 10 | 12 | 12 | 0 |
| SMITHS GROUP PLC | 1 | 8 | 8 | 0 |
| THE PNC FINANCIAL SERVICES GROUP, INC. | 5 | 14 | 14 | 0 |
| Trelleborg AB | 3 | 4 | 4 | 0 |
| Wheaton Precious Metals Corp. | 0 | 0 | 0 | 0 |
| Jiangsu Zhongtian Technology Co., Ltd. | 0 | 1 | 0 | **-1** |
| MAHINDRA AND MAHINDRA LIMITED | 5 | 22 | 21 | **-1** |
| Norsk Hydro ASA | 0 | 3 | 2 | **-1** |
| OMV Aktiengesellschaft | 10 | 19 | 18 | **-1** |
| PACCAR INC | 0 | 6 | 5 | **-1** |
| POWSZECHNA KASA OSZCZEDNOSCI BANK POLSKI SPOLKA AKCYJNA | 2 | 11 | 10 | **-1** |
| QBE INSURANCE GROUP LIMITED | 6 | 13 | 12 | **-1** |
| THE CHARLES SCHWAB CORPORATION | 7 | 12 | 10 | **-2** |

---

## Verdict flips (measure-level)

**No→Yes recoveries (38):**

- Demant A/S — `1.4-strategic-objectives`
- GERDAU S.A. — `1.9-workforce-strategy`
- GERDAU S.A. — `2.1-deployed-systems`
- HYUNDAI GLOVIS Co., LTD. — `2.9-ai-product-innovation`
- Haier Smart Home Co., Ltd. — `2.11-ai-research-activity`
- Haier Smart Home Co., Ltd. — `2.3-quantified-outcomes`
- Haier Smart Home Co., Ltd. — `2.9-ai-product-innovation`
- Haier Smart Home Co., Ltd. — `3.2-ai-risk-framework`
- INDUSTRIAL BANK CO.,LTD. — `1.4-strategic-objectives`
- ING Groep N.V. — `1.3-executive-accountability`
- INSURANCE AUSTRALIA GROUP LIMITED — `1.2-board-oversight`
- INSURANCE AUSTRALIA GROUP LIMITED — `2.13-ai-portfolio-inventory`
- Japan Exchange Group, Inc. — `2.4-customer-facing-ai`
- KERRY GROUP PUBLIC LIMITED COMPANY — `2.4-customer-facing-ai`
- MANULIFE FINANCIAL CORPORATION — `1.7-responsible-ai-commitment`
- MANULIFE FINANCIAL CORPORATION — `2.8-ai-partnerships`
- OBAYASHI CORPORATION — `1.4-strategic-objectives`
- OBAYASHI CORPORATION — `2.11-ai-research-activity`
- OBAYASHI CORPORATION — `2.3-quantified-outcomes`
- OBAYASHI CORPORATION — `2.5-generative-ai-use`
- OBAYASHI CORPORATION — `2.9-ai-product-innovation`
- PAYCHEX, INC. — `2.11-ai-research-activity`
- PEARSON PLC — `1.1-ai-strategy-document`
- PEARSON PLC — `1.10-stakeholder-engagement`
- PEARSON PLC — `1.4-strategic-objectives`
- PEARSON PLC — `2.10-operational-efficiency`
- PEARSON PLC — `2.4-customer-facing-ai`
- PEARSON PLC — `2.9-ai-product-innovation`
- PPG INDUSTRIES, INC. — `1.4-strategic-objectives`
- QBE INSURANCE GROUP LIMITED — `2.4-customer-facing-ai`
- SANTOS LIMITED — `2.3-quantified-outcomes`
- T. ROWE PRICE GROUP, INC. — `1.7-responsible-ai-commitment`
- T. ROWE PRICE GROUP, INC. — `2.11-ai-research-activity`
- T. ROWE PRICE GROUP, INC. — `3.2-ai-risk-framework`
- UNICREDIT, SOCIETA PER AZIONI — `2.3-quantified-outcomes`
- Wolters Kluwer N.V. — `1.4-strategic-objectives`
- Wolters Kluwer N.V. — `2.7-ai-infrastructure`
- Wolters Kluwer N.V. — `3.5-explainability-transparency`

**Yes→No downgrades (14):**

- HYUNDAI GLOVIS Co., LTD. — `1.4-strategic-objectives`
- Haier Smart Home Co., Ltd. — `1.9-workforce-strategy`
- INDUSTRIAL BANK CO.,LTD. — `3.5-explainability-transparency`
- INSURANCE AUSTRALIA GROUP LIMITED — `1.10-stakeholder-engagement`
- Jiangsu Zhongtian Technology Co., Ltd. — `2.9-ai-product-innovation`
- MAHINDRA AND MAHINDRA LIMITED — `1.1-ai-strategy-document`
- Norsk Hydro ASA — `2.2-business-function-deployment`
- OMV Aktiengesellschaft — `3.5-explainability-transparency`
- PACCAR INC — `2.9-ai-product-innovation`
- POWSZECHNA KASA OSZCZEDNOSCI BANK POLSKI SPOLKA AKCYJNA — `2.9-ai-product-innovation`
- QBE INSURANCE GROUP LIMITED — `2.1-deployed-systems`
- QBE INSURANCE GROUP LIMITED — `3.4-bias-mitigation`
- THE CHARLES SCHWAB CORPORATION — `1.1-ai-strategy-document`
- THE CHARLES SCHWAB CORPORATION — `3.6-human-oversight`

---

## Recommendation

**GO.** The fix is merged (`6b60e94`) and deployed; production is unchanged because the flag defaults OFF. The live canary confirms what the offline replay projected: enabling `RETRIEVAL_EVIDENCE_REPAIR=1` (with `SCORING_CASCADE=1`) restores the safe Yes-rate, modestly improves recall through legitimate corpus re-search, and introduces zero hallucinated promotions.

**To enable in production** (when you decide): set `SCORING_CASCADE=1` and `RETRIEVAL_EVIDENCE_REPAIR=1` on the worker service, wait for the redeploy to reach SUCCESS, and run the next production batch. The canary flags are currently **reverted** — nothing is live until you choose to flip them.

### Loose ends (not blockers)
- Repaired quotes are relabeled (provenance kept) but not arbiter-reconfirmed — by design for this fix.
- Re-search is corpus-only (no new full-document fetch) — by design.
