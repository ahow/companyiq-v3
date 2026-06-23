# Corpus-Drift Redesign — v3 (Commitment-Level Build Spec)

**Date:** 23 Jun 2026  
**Author:** Manus AI  
**Re:** `companyiq_v3_developer_feedback_corpus_redesign.md` (Reviewer response to v2)  
**Status:** **Approved & Locked.** Incorporates the reviewer's structural framing, five core improvements, and four developer cautions (A–D).

---

## 0. The Core Architectural Principle

The primary engineering objective is to make document ranking specific and continuous so that documents carrying real evidence are placed unambiguously at the top, in a stable order, every run. 

All other mechanisms—the `urlHash` tertiary key, near-duplicate collapsing, the frozen corpus, and the run manifest—are safety nets and governance tools for cases the ranker cannot or should not resolve on its own. **Ranking specificity is the engine; the rest is governance.**

---

## 1. §1: The Primary Fix — Ranking Specificity

The integer return type of `calculatePriority()` collapses fine-grained scores onto a coarse integer lattice, creating massive tie clusters (e.g., 15 documents tied at −25). To resolve this, `calculatePriority()` must return a **floating-point score** (higher = better), and the sorting comparator must preserve these floats through the entire pipeline without rounding.

### 1.1 Coarse Authority Classes (Primary Sort Key)
Before applying the fineScore, every document is assigned an integer `authorityClass` (0 = highest, 4 = lowest) to keep secondary mirrors structurally below primary sources:

| Class | Source Category | Examples |
|---|---|---|
| **0** | Regulatory Primary | SEC EDGAR primary HTML filings (`sec.gov/archives/edgar/*.htm`) |
| **1** | Regulatory Mirror / Statutory Registry | SEDAR+, ASX, HKEX, UK Companies House, EU registries, SEC PDFs |
| **2** | Voluntary Registry | CDP, TNFD, SBTi, UN Global Compact, Net Zero Asset Managers |
| **3** | Company Investor Relations / ESG | Issuer's own domain (`ir.company.com`, `company.com/esg`) |
| **4** | Secondary / Aggregator / Media | News sites, blog posts, general web, junk aggregators |

### 1.2 Continuous fineScore Components (Secondary Sort Key)
The `fineScore` is a continuous floating-point value computed as the sum of five components:

```
fineScore = filingTypeWeight + recencyWeight + topicDensity + slugSpecificity + titleTokenBonus + filingSectionBonus + sizeBonus + langSignal
```

1. **Filing-Type Weight (0.0 to 15.0):**
   - 10-K, 20-F, 40-F: `+12.0`
   - DEF-14A / Proxy Statement: `+10.0`
   - 10-Q: `+7.0`
   - 8-K / 6-K: `+5.0`
   - CDP Response / TCFD Report: `+8.0`
   - Sustainability / ESG Report: `+6.0`
   - Integrated / Annual Report: `+7.5`

2. **Continuous Recency Weight (0.0 to 6.0):**
   - Extracts a 4-digit year from the URL or title.
   - Formula: `recencyWeight = max(0.0, 6.0 - 1.5 * (currentYear - docYear))`
   - Fallback if no year is found: `1.5` (neutral).

3. **Topic-Phrase Density (0.0 to 8.0):**
   - Counts distinct framework-lexicon phrases matched in the URL or title (using the active framework's multilingual lexicon).
   - Formula: `topicDensity = min(8.0, 1.6 * distinct_phrases_count)`

4. **Slug Specificity (0.0 to 8.0):**
   - Exact form slugs (`def-14a`, `10-k`, `20-f`): `+3.0` each.
   - Generic path slugs (`report`, `document`, `file`): `+0.5` each.
   - Path-depth bonus: `min(2.0, 0.15 * path_depth)` (where depth is the number of slashes in the URL path).

5. **Title Token Count (0.0 to 3.0) — *Caution A Applied*:**
   - Downweights generic, title-less SEC exhibit pages (e.g., "99.1", "EX-99.1", "Document").
   - Formula: `titleTokenBonus = min(3.0, 0.3 * informative_token_count)` (where tokens are words of length ≥ 3, excluding "SEC.gov", "HTML", "PDF", "Exhibit", or numbers).

6. **Filing-Section Hint (0.0 to 2.0):**
   - Looks for section tags in the title (e.g., "Item 1A", "Part I", "Section 5").
   - Formula: `+1.0` per match, capped at `2.0`. Promotes risk-factor-bearing sections.

7. **Document Size Estimate (0.0 to 2.0) — *Caution C Applied*:**
   - Large filings carry more measure-bearing content than 2-page press releases.
   - **Constraint:** To avoid latency, timeouts, and failures, this HEAD request is **only** performed on the post-gate accepted set (~40–60 documents), **never** on the pre-gate 180 candidate pool. It must use a tight 500ms timeout with a `0.0` fallback.
   - Formula: `sizeBonus = min(2.0, 0.2 * ln(content_length_bytes / 1024))` (for size > 10KB, else `0.0`).

8. **Cross-Language Signal (-2.0 to 0.0) — *Caution B Applied*:**
   - Gated on **secondary/aggregator pages** (Class 4) for non-EN-market issuers (e.g., JP/CN/KR companies).
   - Penalty of `-2.0` if the title of a Class 4 document is purely English when the company's primary filings are in its native language.
   - **Constraint:** Never penalize English-titled Class 0/1/2 documents (e.g., official English 20-F or IFRS reports).

---

## 2. §2: The Safety Nets

### 2.1 Near-Duplicate Collapsing (§2.2)
Near-duplicates (same form + year + normalized-title-stem) are collapsed *before* ranking.
- **Normalised-title-stem:** Strip punctuation, whitespace, case, and file extensions.
- **Selection rule:** Keep the document with the **highest authority class** (lowest integer value). If authority classes are tied, keep the one with the higher `fineScore`. If still tied, keep the one with the lower `urlHash`. This prevents choosing a winner based on arbitrary topic-match noise.

### 2.2 Deterministic Tertiary Key (`urlHash`) (§2.1)
If two documents share the same `authorityClass` and `fineScore`, the tie is broken deterministically by sorting on `urlHash` (SHA-1 of the URL string) in ascending order.
- **Acceptance Criterion:** In the 15-company test cohort, `urlHash` should break **fewer than 10%** of selection decisions. If it breaks more, the ranking specificity in §1 is insufficient.

---

## 3. §3: The Length Cap (Cap-Sweep Experiment)

The length cap is a scoring choice, not a determinism fix. It will be evaluated empirically after C1, C2, and C4 are deployed.

### 3.1 The Cap-Sweep Procedure
1. Freeze the candidate pool for the 15-company test cohort (11 r14 companies + Dominion, Darden, Southern, Magna).
2. Apply the new C1+C2 selection over the frozen pool at three caps: **N = 40, N = 60, N = 80**.
3. Re-score under each cap using identical model, prompt, and seed (with 3-pass self-consistency enabled).
4. Record `score_at_40`, `score_at_60`, `score_at_80`, and measure-level verdict changes.

### 3.2 Decision Rule

| Pattern across N = 40, 60, 80 | Interpretation | Action |
|---|---|---|
| Scores within ±2pt on ≥80% of companies | Cap is largely inert under granular ranking | Use **N = 60** (maximize safety margin) |
| Scores rise monotonically (mean Δ_80_minus_40 > +3pt) | Tail documents carry real evidence | Use **N = 80** (or higher) |
| Scores fall monotonically (mean Δ_80_minus_40 < −3pt) | Tail noise dilutes grader | Use **N = 40** (ship v2 threshold+cap) |
| Mixed (no monotonic pattern) | Cap interacts with company-specific corpus | Use **N = 60** (flag mixed-direction movers) |

---

## 4. §4: The Run Manifest & Provenance

Every CSV export and database `analysis_results` row must record a rich manifest to guarantee auditability:

```json
{
  "pipeline_version": "v3l-r1",
  "git_sha": "5420a81...",
  "model_versions": {
    "discovery_gate": "deepseek-chat",
    "grader": "deepseek-chat"
  },
  "prompt_versions": {
    "gate_prompt_hash": "sha1_hash",
    "grader_prompt_hash": "sha1_hash"
  },
  "seed": 42,
  "candidate_pool_fingerprint": "sha1_of_sorted_candidate_urls",
  "final_corpus_fingerprint": "sha1_of_sorted_final_urls",
  "ranker_diagnostics": {
    "distinct_priorities_in_top_20": 16,
    "largest_tie_count_pre_urlhash": 2,
    "urlhash_decision_fraction": 0.05
  },
  "kept_count": 60,
  "cap_used": 60,
  "coverage_level": "full",
  "missing_tier1_types": [],
  "cohort_baseline": "v3l-r1-baseline"
}
```

---

## 5. §5: Validation & Acceptance Tests

### Test A: Same-Pool Repeatability (Headline Determinism)
Run the 11-company cohort twice against the same frozen candidate pool.
- **Target:** **11/11 companies** have identical `final_corpus_fingerprint` and **score delta = 0** on all measures.

### Test B: Live-Run Drift (Realistic Field Claim) — *Caution D Applied*
Run the 11-company cohort twice on different days with live web search.
- **Target:** Mean absolute score delta ≤ ±3pt, max ≤ ±5pt.
- **Pass Condition:** A company exceeding ±5pt **passes** if its `candidate_pool_fingerprint` changed (legitimate world change). It only **fails** if its `candidate_pool_fingerprint` is identical but its score moved > ±5pt (determinism bug).

### Test C: Ranker-Quality Test — *Caution A Applied*
On the 15-company test cohort, report:
- Distinct priority values in top-20 (Target: **≥15** for companies with ≥15 distinct candidate documents; otherwise `distinct_priorities == total_candidate_docs`).
- Largest tie count pre-urlHash (Target: **≤3**).
- Fraction of decisions broken by `urlHash` (Target: **<10%**).

---

## 6. Build Sequence

1. **Implement §1 Ranker Improvements** in `discovery.ts` (floating-point priority, authority classes, new components, layered comparators).
2. **Implement §2.1 Near-Duplicate Collapsing** (pre-ranking, authority-class winner).
3. **Implement §4 Run Manifest** (fingerprints, diagnostics).
4. **Run Test C & Test A** to verify ranking quality and determinism.
5. **Run C5 (12-ISIN Re-run)** under C1+C2+C4 at cap 60 and patch CSV.
6. **Run Test D (Cap Sweep)** and apply §3.2 decision rule.
7. **Run C6 (r14 Rebaseline)** under the final chosen cap, setting `cohort_baseline = "v3l-r1-baseline"`.
