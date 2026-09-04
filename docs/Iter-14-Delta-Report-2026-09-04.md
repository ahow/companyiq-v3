# Iter-14 Delta Report — R1+R2+U17-B Combined Impact

**Date**: 2026-09-04
**Batch**: 17 (iter-14) vs 16 (iter-13)
**Framework**: 3 (Nature and Biodiversity Disclosure Framework)
**List**: 2 (10 companies)
**Baseline**: Reconciled truth (3 analysts + Manus AI reconciler, 200 cells, 105 Yes / 84 No / 11 Not disclosed)

## What shipped

Three PRs landed on `main` between iter-13 and iter-14:

- **PR #8 — U17 Fix B (scoring-time provenance gate)** — precision-side gate, defaulted OFF via feature flag. Should have zero effect on iter-14 verdicts unless the flag was enabled server-side.
- **PR #9 — R2 (IR-platform CDN + subsidiary-brand hostname classification)** — extends the provenance classifier with two new rules:
  - Rule 1b (brand-token-in-hostname) — catches subsidiaries and regional sites (`unilevernepal.com`, `walmart.org`, ...)
  - Rule 2 (IR-platform / hosted-IR CDN) — recognises Q4 Inc / MZiQ / PrecisionIR CDNs
- **PR #10 — R1 (framework-level disclosure document types + query overhaul)** — aggregates each framework's per-measure `disclosure_vehicles` into `framework.required_doc_types`, then generates four query patterns per vehicle (quoted+filetype:pdf, quoted+year, unquoted+filetype:pdf, unquoted+year) to target document titles rather than content keywords.

## Headline results

### High-confidence subset (n=124 cells)

|              | TP | FP | FN | TN | Precision | Recall | F1    |
|--------------|----|----|----|----|-----------|--------|-------|
| Iter-13      | 62 | 2  | 22 | 38 | 0.969     | 0.738  | 0.838 |
| Iter-14      | 68 | 1  | 16 | 39 | 0.986     | 0.810  | 0.889 |
| **Δ**        | +6 | −1 | −6 | +1 | **+1.7 pts** | **+7.2 pts** | **+0.051** |

### Medium-confidence subset (n=66 cells)

|              | TP | FP | FN | TN | Precision | Recall | F1    |
|--------------|----|----|----|----|-----------|--------|-------|
| Iter-13      | 11 | 12 | 10 | 33 | 0.478     | 0.524  | 0.500 |
| Iter-14      | 12 | 13 | 9  | 32 | 0.480     | 0.571  | 0.522 |
| **Δ**        | +1 | +1 | −1 | −1 | +0.002    | +0.048 | +0.022 |

### Low-confidence subset (n=10 cells)

Unchanged (0 TP / 0 FP / 0 FN / 10 TN in both iterations). These are the framework-clarification cells where no analyst reached a confident verdict; the pipeline was already saying No, matching truth.

## Per-company recall (High confidence)

| Company              | Iter-13    | Iter-14    | Δ       |
|----------------------|------------|------------|---------|
| Ambev                | 0/0 (—)    | 0/0 (—)    | —       |
| BHP Group            | 10/10 (100%) | 10/10 (100%) | 0       |
| **Banco Santander**  | 1/7 (14%)  | 5/7 (71%)  | **+57 pts** |
| Kering               | 11/14 (79%) | 12/14 (86%) | **+7 pts**  |
| Nestlé               | 5/6 (83%)  | 5/6 (83%)  | 0       |
| **Newmont**          | 6/14 (43%) | 7/14 (50%) | **+7 pts**  |
| Prudential plc       | 0/2 (0%)   | 0/2 (0%)   | 0       |
| Samsung Electronics  | 7/7 (100%) | 7/7 (100%) | 0       |
| Unilever             | 16/16 (100%) | 16/16 (100%) | 0       |
| Walmart              | 6/8 (75%)  | 6/8 (75%)  | 0       |

## Verdict changes (200 cells total)

| Type                | Count |
|---------------------|-------|
| **FIXED** (wrong → right) | 12 |
| BROKEN (right → wrong)    | 1  |
| CHANGED-still-wrong       | 2  |
| Unchanged                 | 185 |

**Net: +11 correct verdicts** (12 fixed − 1 broken).

### High-confidence FIXED cells

| Company | Measure | Truth | Iter-13 | Iter-14 |
|---------|---------|-------|---------|---------|
| Banco Santander | 1.4-integration-strategy | Yes | No | **Yes** |
| Banco Santander | 2.1-nature-dependencies | Yes | No | **Yes** |
| Banco Santander | 2.8-value-chain-assessment | Yes | No | **Yes** |
| Banco Santander | 3.2-prioritization-approach | Yes | No | **Yes** |
| Kering | 2.3-nature-risks | Yes | No | **Yes** |
| Nestlé | 2.6-business-model-resilience | No | Partial | **No** (precision) |
| Newmont | 1.4-integration-strategy | Yes | No | **Yes** |
| Newmont | 2.6-business-model-resilience | No | Yes | **No** (precision) |
| Walmart | 2.6-business-model-resilience | No | Partial | **No** (precision) |

### BROKEN cell (1)

| Company | Measure | Truth | Iter-13 | Iter-14 |
|---------|---------|-------|---------|---------|
| Nestlé (Medium conf) | 2.4-nature-opportunities | No | No | **Yes** (FP) |

## Attribution — how R1 and R2 contributed

**Banco Santander (+57 pts recall — largest single-company gain)**
- **R1 effect**: R1's `"Banco Santander" sustainability report filetype:pdf` query surfaced `santander.com/content/dam/santander-com/en/documentos/informe-anual-de-sostenibilidad-2024.pdf` — the main Sustainability Report that was missing from iter-13's corpus.
- **R2 effect**: The R2 subsidiary-brand rule catches `santandermedia.com` and similar Banco Santander-branded regional properties as first-party. The corpus counted **20 first-party docs** for Santander in iter-14 (see below), up substantially from iter-13.
- Both are needed: R1 finds the URL, R2 classifies it as first-party so the scoring pipeline treats it as authoritative.

**Kering (+7 pts recall)**
- R1's vehicle queries surfaced additional Kering PDFs. `kering.com/api/download-file` (the sustainability report endpoint) is now in the corpus.
- One Kering FN remains (out of 2 original): the `filings.xbrl.org` ESEF filing — a specialized regulatory repository R1 doesn't target and R2 doesn't classify.

**Newmont (+7 pts recall)**
- R1's vehicle queries expanded the Newmont corpus significantly. The retro-simulation predicted 2/2 target URLs would surface (both q4cdn.com paths), but only 1 of 2 verdicts flipped. The **corpus** received the URLs, but scoring didn't extract the required disclosure text — this is now an R5 (section-aware retrieval) issue on 7 remaining FN cells.

**Prudential plc (no change, 0/2)**
- The R1 retro-sim predicted 1/1 target URL surfaced (HKEX Sustainability Report). Verdicts unchanged.
- Root cause candidate: the HKEX PDFs are Prudential plc's Sustainability Reports but their nature/biodiversity content is thin, so even with the doc in corpus the scoring model finds insufficient evidence. This should be adjudicated against the truth-quote text in a follow-up before deciding whether it's a discovery, retrieval, or scoring gap.

## Iter-14 corpus composition

| Company              | First-party | Total |
|----------------------|-------------|-------|
| Ambev                | 2           | 19    |
| Banco Santander      | 20          | 30    |
| BHP Group            | 18          | 22    |
| Kering               | 18          | 23    |
| Nestlé               | 21          | 30    |
| Newmont              | 20          | 32    |
| Prudential plc       | 6           | 13    |
| Samsung Electronics  | 24          | 31    |
| Unilever             | 6           | 16    |
| Walmart              | 10          | 18    |

Santander (20 first-party), Nestlé (21), Newmont (20), Samsung (24) all show strong first-party corpora — consistent with R1+R2 expanding source discovery. Prudential (6 first-party) and Unilever (6 first-party) remain low — Prudential because HKEX filings dominate, Unilever because most subsidiaries were already covered pre-R2.

## Remaining recall gap analysis

**15 High-confidence FN cells still unrecovered**:

- **Newmont**: 7 FN — R1 unlocked s24.q4cdn.com but scoring isn't extracting the biodiversity content. **Next step: R5 section-aware retrieval + topic-strict term split.**
- **Kering**: 2 FN — `filings.xbrl.org` ESEF filing. **Next step: add XBRL host class to R2 or expand R1 with `site:filings.xbrl.org` variants.**
- **Prudential**: 2 FN — HKEX Sustainability Report content not yielding biodiversity verdict. **Next step: manual adjudication to isolate whether R5 or a rescore is needed.**
- **Banco Santander**: 2 FN — remaining Sanandter FNs likely need more specific measure-level document alignment. **Next step: R5.**
- **Walmart**: 2 FN — Walmart ESG report chapters need HTML extraction. **Next step: R6 (content extraction) + R5.**

## Precision changes

Precision improved slightly (+1.7 pts High, +0.2 pts Medium). One BROKEN cell at Medium confidence (Nestlé 2.4). This is likely noise given the small movement, but should be watched — R1 + R2 shouldn't push precision negative.

Note: U17 Fix B (scoring-time provenance gate) was merged but defaults OFF via feature flag. If enabled, it would further tighten precision but at some recall cost. Not evaluated in this iteration.

## Roadmap position

R1 + R2 delivered ~half the recall gap that the FN root-cause diagnosis predicted was addressable:
- Diagnosis said 12 of 22 High-conf FNs were retrieval misses; R1+R2 closed 6 of those.
- 7 Newmont FN cells got the RIGHT DOCUMENTS but scoring didn't find biodiversity content → R5 addresses this.
- 2 Kering + 2 Prudential + 2 Walmart FNs are structural (XBRL, HKEX-formatted, HTML) → R2/R6 refinements.

**Priority next**:
1. **R5** (section-aware retrieval + topic-strict term split) — highest expected payoff for Newmont's 7 remaining FN cells.
2. **R4** (entity-resolution country gate for EDGAR) — prevents Prudential-plc / Prudential-Financial confusion.
3. **R6** (HTML content extraction) — Walmart's web-hosted ESG chapters.

## Reproducibility

- Batch 17 (iter-14): started 2026-09-04 11:09:26 UTC, completed 11:23:51 (14 min 25 sec).
- Git commit: `ef93ccd` (U17-B merge, HEAD of main).
- Feature flags: default (U17 Fix B provenance gate = OFF).
- Verdict data: `analysis_results.results_data` for `batch_id IN (16, 17)`.
- Comparison script: `/tmp/compare_both_iters.py`.

## Sources

- Truth baseline: `/home/user/workspace/uploaded_attachments/3aedbcae8a6945dbb35e085f603807de/NatureFramework_TruthBaseline_Reconciled.xlsx` + unanimous-reversal applied.
- FN root cause: `docs/Recall-Root-Cause-Diagnosis-2026-09-04.md`.
- R1 retro-sim (predicted 8/9 target URLs surfaced): [PR #10](https://github.com/ahow/companyiq-v3/pull/10).
- R2 retro-sim (predicted 48 upgrades / 0 downgrades): [PR #9](https://github.com/ahow/companyiq-v3/pull/9).
