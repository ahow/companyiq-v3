# CompanyIQ v3 — Reviewer Findings: Diagnosis & Fix Plan

This responds to the four reviewer comments on the AI-template output. For each I have reproduced the issue against the **live production database and codebase**, identified the **root cause**, and proposed a **specific fix** with a priority rating.

**Headline:** The single blocking finding (#1, the duplicate ISINs / "6 vs 47" spread) is **not a scoring-determinism failure**. It is a **deduplication bug at company ingest** — the same security exists as **two separate database rows** that were analysed at different times against different corpora, and both rows landed in the CSV. This is fixable and does not undermine the per-company scoring engine.

---

## Finding 1 — Duplicate ISINs with divergent scores  **[BLOCKER — fix before external use]**

### What the reviewer saw
12 ISINs appear twice (24 rows), case-variant names, scores diverging (e.g. Mitsubishi UFJ **6 vs 47**, JP3902900004).

### What is actually happening
The duplicates are **two distinct company rows for the same issuer**, not one company scored twice:

| ISIN | Row A (original) | Row B (re-added in the 2,443 run) |
|---|---|---|
| JP3902900004 (Mitsubishi UFJ) | id 1294, "Mitsubishi UFJ Financial Group, Inc." | id 2456, "MITSUBISHI UFJ FINANCIAL GROUP INC" |
| US1729674242 (Citigroup) | id 992, "CITIGROUP INC." | id 2455, "CITIGROUP INC" |
| ES0113900J37 (Santander) | id 899, "Banco Santander, S.A." | id 2457, "BANCO SANTANDER SA" |

The live DB confirms it exactly: workspace 3 holds **2,556 rows but only 2,444 distinct normalised ISINs → 12 redundant rows / 24 colliding rows**, matching the reviewer's count precisely.

### Root cause
The CSV-import handler (`server/routes/api.ts`, `/companies/upload`) de-duplicates **only on an exact, case-sensitive company-name match** (`storage.getCompanyByName`). When the portfolio was re-uploaded for the new run, every issuer whose name casing/punctuation differed ("Inc." vs "INC") was treated as new and **re-inserted**. There is **no unique index on ISIN** in the `companies` table (only PK on `id` and indexes on workspace/status), so nothing at the database level prevents the duplicate.

The "6 vs 47" spread then arises because the two rows were analysed in **different runs against a different (dynamic) corpus** — exactly the divergence the reviewer is right to refuse to ship.

### Fix
1. **Ingest dedup on normalised ISIN (primary key for identity).** Before insert, match on `UPPER(TRIM(isin))` within the workspace; if found, **update** the existing row (name/sector/country/domain) instead of inserting. Fall back to normalised-name match only when ISIN is absent.
2. **Add a partial unique index**: `CREATE UNIQUE INDEX companies_ws_isin_uniq ON companies (workspace_id, UPPER(TRIM(isin))) WHERE isin IS NOT NULL AND TRIM(isin) <> '';` — makes the duplicate structurally impossible going forward.
3. **One-time cleanup of the existing 12 pairs**: keep the fully-analysed row, merge the idle/duplicate into it (or delete the redundant idle row), so the CSV carries exactly one row per ISIN.
4. **CSV export guard**: de-duplicate by normalised ISIN at export time as a belt-and-suspenders, keeping the most recently completed analysis.

---

## Finding 2 — Run-to-run cohort drift vs r14, and missing audit manifest  **[HIGH]**

### What the reviewer saw
Apple −11, NVIDIA +7, Amazon +8 etc. between the r14 cohort and the portfolio CSV; ±10pt = a different verdict on 3–4 questions. Wants a manifest (timestamp, retrieved-doc list, prompt+model versions) attached to the CSV.

### What is actually happening / root cause
Two compounding causes:

1. **The scoring engine is already near-deterministic at the model layer.** All providers run at `temperature: 0` with a fixed `seed: 42`, and each measure uses **3-pass self-consistency with majority vote**. So the residual model noise is small.
2. **The drift is dominated by corpus drift, not the scorer.** Discovery queries the live web + EDGAR on each run, so the *retrieved document set* changes between runs (new filings appear, mirrors rotate, fetch successes/failures differ). A different corpus → a different evidence pack → a legitimately different verdict on the marginal 3–4 questions. **Additionally**, part of the Apple/NVIDIA comparison is **row-identity confusion**: the demo rows live in workspace 1 and the portfolio rows in workspace 3 — partly different entities, which inflates the apparent delta.

Today the system persists per-company `created_at` and the source-document list inside `results_data`, but **does not stamp model version, prompt version, or seed per run** — so the manifest the reviewer wants cannot be fully reconstructed.

### Fix
1. **Freeze the corpus per portfolio run.** Persist the exact fetched document set (URL + retrieved timestamp + content hash) — most of this already exists in `documents`/`results_data`; add a content hash. Offer a "re-score from frozen corpus" mode so a re-run is reproducible to the document.
2. **Add a run manifest** attached to every CSV: run id, batch id, timestamp, framework name+version, model name+version per provider, seed, self-consistency N, and the per-company retrieved-doc list with hashes.
3. **Stamp provenance in `analysis_results`** (new columns: `model_versions jsonb`, `prompt_version text`, `seed int`, `corpus_hash text`).
4. **Always compare like-for-like rows** (same workspace/ISIN) when measuring drift, to remove the demo-vs-portfolio artefact.

---

## Finding 3 — Stale corpus / EDGAR-primary preference not exclusive  **[MEDIUM]**

### What the reviewer saw
10% of US filers have no source-link year ≥ 2025; some `Coverage=full` 0-scores look like retrieval misses (Affirm, AutoZone, Air Products, etc.); for NVIDIA the Fortune mirror PDF is still cited alongside the EDGAR primary, so the preference rule "is not exclusive." Recommends "EDGAR primary, mirror only if EDGAR fetch fails." Notes Caterpillar 0% is legitimate.

### What is actually happening / root cause
The EDGAR-vs-mirror logic already exists but only as a **tie-break**: EDGAR HTML is boosted, EDGAR PDF demoted, a dateless mirror can never outrank a dated filing, and within the same ~150-day period EDGAR beats a mirror. **However**, the mirror remains in the candidate set and **can still be cited** when both are present — exactly NVIDIA's case. So the reviewer is correct that the preference is non-exclusive. The "stale" and "Coverage=full but 0" cases are a mix of genuine retrieval misses and legitimate zeros (the reviewer themselves confirms Caterpillar's 0 is real).

### Fix
1. **Make EDGAR-primary exclusive.** When an EDGAR primary document for the issuer's current period is present **and fetched successfully**, drop same-period third-party mirrors from the citable set (keep them only as fetch-failure fallback). Implements the reviewer's exact recommendation.
2. **Stale-source QC pass.** Flag US filers whose newest source-link year < current−1 and auto-queue an EDGAR-submissions re-seed (the authoritative CIK→latest-10-K lane already exists; trigger it on staleness).
3. **"Full-coverage zero" review lane.** Route `Coverage=full` + score 0 companies (Affirm, AutoZone, Air Products, American Water Works, Echostar, CF Industries) into the existing QA worklist for human spot-check — do **not** auto-flip them (preserves scoring rigour; avoids inflating).
4. **Do not sweep all 0s into "errors."** Keep legitimate zeros (e.g. Caterpillar) as zeros; only the coverage-full subset gets reviewed.

---

## Finding 4 — Scoring-formula inconsistency  **[LOW — document & enforce]**

### What the reviewer saw
`Total Score (%)` matches **(Yes + 0.5·Partial)/Total** in 47/50 rows but **Yes/Total** in 37/50; 3 outliers use a different rule.

### What is actually happening / root cause
There is **one** formula in code (`server/lib/analyzer.ts`):

> `scorePercentage = round( (Σ measure scores) / answeredCount × 100 )`, where each measure scores **1 (Yes), 0.5 (Partial), 0 (No)**.

That is precisely **(Yes + 0.5·Partial)/answered**. The apparent inconsistency is two documented behaviours, not three rules:

- **Denominator = answered, not total.** Measures returning "Insufficient evidence" are *abstained* and excluded from both numerator and denominator (the v3e answered-measures rule). So a manual `Yes/Total` check mismatches whenever a row has abstentions.
- **Rows with zero Partials** make `(Yes + 0.5·0)/answered` identical to `Yes/answered`, which is why ~37 rows also satisfy the simpler expression.
- A handful of rows run in **binary mode** (Partial forced to 0), which also collapses to `Yes/answered`.

The reviewer's substantive ask is valid: **state the formula explicitly and apply it uniformly.**

### Fix
1. **Document the canonical formula** in the export and methodology: `Total Score (%) = round( (Yes + 0.5·Partial) / Answered × 100 )`, with "Answered = Total − Insufficient-evidence (abstained)."
2. **Emit the components in the CSV** per company: `Yes`, `Partial`, `No`, `Abstained`, `Answered`, `Total` — so any reviewer can re-derive the percentage exactly.
3. **Lock the scoring mode per portfolio run** (partial vs binary) so all rows use the same rule; record it in the manifest (Finding 2).

---

## Priority summary

| # | Finding | Severity | Core fix | Blocks external use? |
|---|---|---|---|---|
| 1 | Duplicate ISINs / divergent scores | **Blocker** | ISIN-normalised dedup + unique index + cleanup | **Yes** |
| 2 | Cohort drift / no manifest | High | Freeze corpus + run manifest + provenance columns | Recommended before sign-off |
| 3 | Stale corpus / EDGAR not exclusive | Medium | Exclusive EDGAR-primary + staleness re-seed + full-zero review lane | No (QC improvement) |
| 4 | Score-formula clarity | Low | Document formula + emit Yes/Partial/No/Answered columns | No |

## Recommended sequence
1. **Fix #1 now** (dedup + unique index + clean the 12 pairs + regenerate a de-duplicated CSV). This alone resolves the blocker.
2. **Add the manifest + component columns (#2, #4)** — small, high-trust, and makes every number re-derivable.
3. **Tighten EDGAR-primary exclusivity and add the staleness/full-zero QC lanes (#3)** as the next QC iteration.
