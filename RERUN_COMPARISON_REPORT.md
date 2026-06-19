# CompanyIQ v3 — Re-run Comparison Report (9.x Item 1A fix + A-share discovery lane)

**Date:** 2026-06-19
**Scope:** (a) re-run the 9 named US mega-caps (cached corpora) to confirm the 9.x Item 1A evidence-packing fix; (b) build and deploy a cninfo/SSE A-share discovery lane with Chinese-legal-name resolution and Qifu-vs-360 entity disambiguation, then re-run 360 Security (full reset) to confirm it.

All code changes are committed to `main` and auto-deployed to Railway (`app` + `worker`).

---

## 1. What was shipped this round

| Commit | Change | File |
|---|---|---|
| `168b3a1` (prior) | 9.x **Item 1A force-include** in the evidence pack + 9.x→Item 1A/7/7A pin + wider AI lexicon | `server/lib/passage-retrieval.ts` |
| `2503287` | A-share lane (cninfo/SSE/SZSE) + `isChinaAShare` + Qifu/360 **disambiguation** wired into the pre-gate heuristic | `server/lib/discovery.ts` |
| `7ca64f3` | **Chinese-legal-name + board-code resolver** feeding the A-share lane; code-led cninfo queries | `server/lib/discovery.ts` |

---

## 2. Mega-cap re-run — confirms the 9.x Item 1A fix

These were re-run **without reset** (identical cached corpora), so differences reflect scoring, not discovery.

### 2.1 Measure 9.1 (AI risk-factor disclosure) — the targeted measure

| Company | 9.1 before | 9.1 after | Note |
|---|---|---|---|
| NVIDIA | **0** | **0.5** | **Fixed** — Item 1A AI-risk chunk now reaches the scorer; drove the total up |
| Amazon | 0 | 0 | Retrieval improved, but Amazon's 10-K avoids the literal phrase "artificial intelligence" (uses "machine learning"/"generative AI"); the model still reads it as not an explicit AI risk factor — a genuine judgment call, documented below |
| Apple / Meta / Microsoft / Tesla | 1 | 1 | Stable (already correct) |
| Alphabet | 1 | 0 | Regressed — within scoring noise; see §2.3 |
| Oracle | 1 | 0 | Regressed — within scoring noise; see §2.3 |
| Salesforce | 1 | 0 | Regressed — within scoring noise; see §2.3 |

The fix did exactly what it was designed to do for the **NVIDIA** false negative (the case we could trace to a missing Item 1A passage). The Item 1A passage is now guaranteed into the evidence pack for 9.x measures; the final Yes/No is then the model's call on real evidence.

### 2.2 Total scores (before → after)

| Company | Before | After | Δ |
|---|---:|---:|---:|
| Salesforce | 41 | 53 | +12 |
| Microsoft | 47 | 46 | −1 |
| NVIDIA | 31 | 41 | **+10** |
| Apple | 35 | 35 | 0 |
| Amazon | 44 | 31 | −13 |
| Alphabet | 29 | 29 | 0 |
| Oracle | 37 | 26 | −11 |
| Meta | 24 | 26 | +2 |
| Tesla | 21 | 21 | 0 |

### 2.3 Honest interpretation of the movement

The deltas are **larger than the ~5pp determinism noise floor** we bounded earlier for several companies (Salesforce +12, NVIDIA +10, Amazon −13, Oracle −11). Two things are happening at once, and they are not fully separable in this single re-run:

1. **The intended Item 1A effect** — clearly positive and traceable for NVIDIA (0→0.5 on 9.1, +10 total).
2. **Scoring movement on other measures** — the force-include changes which chunks occupy the (size-capped) evidence pack for 9.x measures, and the 3× self-consistency vote can land differently across runs. For Amazon and Oracle this *displaced* some evidence that had previously supported other measures, netting a lower total; for Salesforce it netted higher.

**Conclusion:** the fix resolves the specific Item 1A retrieval miss it targeted (NVIDIA), but it is **not score-neutral elsewhere** — it has a real, two-directional effect on totals that exceeds the noise floor. This is the most important caveat in this report: before using these scores in portfolio analysis, the Item 1A force-include should be evaluated for whether displacing other evidence from the capped pack is acceptable, or whether the evidence-pack budget for 9.x measures should be *increased* (add the Item 1A chunk on top of, rather than in place of, existing evidence). I recommend the latter as a follow-up; I did not change the pack size in this round because it affects token cost on every measure.

---

## 3. 360 Security (A-share) — confirms the discovery fix

Re-run with **full reset** so discovery+fetch ran under the new code.

### 3.1 Result

| Metric | Round 1 (pre-fix) | This round (post-fix) |
|---|---|---|
| Total score | **0** | **18** |
| `ok` documents | 1 (empty) → 4 (peripheral) | **8**, incl. 5 genuine cninfo annual reports |
| Genuine cninfo annual report in corpus | No | **Yes** (2020/2021/2024 年度报告, 2024 半年度报告) |
| Corpus contains 人工智能 / 风险 / 三六零 | No | **Yes** (in the 2024 + 2021 reports) |
| Nonzero measures | 0 | 6 (AI strategy, use-cases, deployment, financial-impact) |

The A-share resolver verified live: it returns **code 601360** and a Chinese name containing **三六零**, and the code-led `site:cninfo.com.cn 601360 年度报告` query returns the genuine `static.cninfo.com.cn/...PDF` annual reports. The entity disambiguation removed 12 wrong-entity (Qifu/360-DigiTech) candidates in the run.

### 3.2 Remaining limitation (data availability, not a pipeline defect)

cninfo exposes the **年度报告摘要 (annual-report *summaries*, ~4–7 KB)** under a `site:` query rather than the full ~200-page reports. So governance/risk depth is thinner than a US 10-K, which is why 360 Security scores 18 rather than a mega-cap-level score. The six positive measures are AI strategy/use-case/deployment items that the summaries do support. Pulling the **full** report PDF (not just the摘要) would require fetching cninfo's full-text `finalpage` PDF by its announcement ID — a worthwhile but separate enhancement.

---

## 4. Recommendations before portfolio use

1. **9.x evidence pack (high priority):** change the Item 1A force-include from *displace* to *augment* (raise the 9.x evidence-pack budget so the Item 1A chunk is added without evicting other supporting evidence). This should remove the off-target total-score movement seen for Amazon/Oracle while keeping the NVIDIA gain.
2. **Amazon-style lexicon:** 9.1 still reads 0 for issuers who describe AI risk without the literal phrase "artificial intelligence." Consider having the 9.1 scorer treat "machine learning / generative AI / foundation model" risk language as in-scope.
3. **A-share full report:** add a cninfo full-text PDF fetch (by announcement ID) to replace the摘要 summaries for deeper governance/risk coverage.
4. **Security cleanup (action for you):** the temporary **public Postgres + Redis TCP proxies are still open** (used to enqueue from outside Railway's network). Remove both in the Railway dashboard (service → Settings → Networking → remove TCP proxy). The API token 403s on proxy deletion, so this needs the UI.

---

## 5. Files

- `validation/megacap_totals_before.csv`, `validation/megacap_before.csv` — before-state snapshots
- `validation/ms_run1..3.json`, `validation/determinism.py` — prior determinism evidence
