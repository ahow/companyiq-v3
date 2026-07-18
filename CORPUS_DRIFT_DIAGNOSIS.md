# Corpus Drift: Diagnosis and Narrowing Design

**Date:** 23 Jun 2026
**Context:** Follow-up to reviewer Finding 2 (run-to-run cohort drift of ±10pt). This document explains *why* the corpus drifts, tests the user's "keep 50+ documents" hypothesis against the evidence, and proposes a concrete, low-risk redesign that **narrows** the corpus toward the most relevant documents while making selection **deterministic**.

---

## 1. Executive summary

The drift is **not** caused by the scorer. The model layer is already about as deterministic as the APIs allow (temperature 0, fixed seed 42, 3-pass self-consistency majority vote). The drift originates in **document selection** — specifically in how the final corpus is cut from the candidate pool.

The single biggest cause is a **tie-break problem**: the relevance score (`calculatePriority`) is a coarse integer, so a large block of documents end up sharing the *same* priority value. The final selection sorts by that integer and keeps the top 60 (`MAX_DOCS_RETURNED`). When 80–112 documents tie at the same score and only ~50 tail slots are available, *which* documents survive the cut is decided by **web-search arrival order**, which changes every run. That tail still feeds the scorer, so borderline measures flip and the total score drifts ±10pt.

**Key conclusion for the user's hypothesis:** keeping *more* documents does **not** mitigate drift — it **amplifies** it, because it enlarges the undifferentiated tie plateau competing for the cut. The right move is **fewer, better, deterministically-ranked** documents.

---

## 2. Evidence

### 2.1 The scorer is already deterministic
- All providers run at `temperature: 0`.
- A fixed `seed: 42` is set where the provider supports it.
- Each measure is scored with **3-pass self-consistency + majority vote**.

So two runs over an *identical* corpus will produce near-identical scores. The drift must therefore come from the corpus differing run-to-run.

### 2.2 The priority score collapses into large ties
Sampling stored `discovery_diagnostics.topUrls` for completed companies (workspace 3), the priority distribution of the top-20 kept documents shows massive tie clusters:

| Company | Priority pattern of top-20 kept docs | Gate accepted | Kept |
|---|---|---|---|
| Dominion Energy | one −75, then **15 docs at −25**, then −23/−21/−20 | 108 | 60 |
| Darden Restaurants | two −30/−29, then **~16 docs at −25** | 90 | 60 |
| The Southern Company | one −30, then **10+ docs at −25** | 112 | 60 |
| Magna International | two −75, a few −31/−26, then a **−25 plateau** | 91 | 60 |

The pattern is universal: a handful of genuinely high-value documents with distinct strong scores (−75, −60, −31, −30 — these are pinned/known/EDGAR/on-domain/tier-1), followed by a **flat plateau at −25** that fills most of the kept slots.

### 2.3 The cut among ties is non-deterministic
The two selection steps are:
```
preGateCandidates = filtered.sort((a,b) => a.priority - b.priority).slice(0, 180)
finalDocs         = recencyFiltered.sort((a,b) => a.priority - b.priority).slice(0, 60)
```
`a.priority - b.priority` has **no secondary tie-break key**. JavaScript's `Array.sort` is stable, so ties retain *insertion order* — and insertion order is the order documents arrived from the various web-search lanes, which varies per run (search APIs return different counts and orderings each time). Result: the −25 plateau reshuffles, and a different ~50 tail documents survive the `slice(0,60)` each run.

### 2.4 Why this produces ±10pt
The strongly-scored "best ~10" documents are stable and always retained — the user's intuition is **correct for the head of the list**. But measures whose evidence lives only in a *tail* document (e.g. a specific board-committee charter, a particular policy PDF) get a different verdict depending on whether that tail document made the cut this run. A handful of flipped Yes↔Partial↔No verdicts across 26–34 measures is exactly a ±10pt swing.

---

## 3. The four drift sources, ranked

| # | Source | Impact | Fixable? |
|---|---|---|---|
| 1 | **Tie-break non-determinism** in the `slice(0,60)` cut over the −25 plateau | **High** | Yes — easy, low-risk |
| 2 | **Volatile candidate pool** from live web search (different results each run) | Medium-High | Partially — freeze/cache per run |
| 3 | **LLM relevance-gate batch composition** (borderline docs judged with different neighbours) | Low-Medium | Yes — sort before batching |
| 4 | **EDGAR/cninfo API availability** per run (authoritative filing present or not) | Low | Yes — retry/cache |

---

## 4. Proposed redesign — "fewer, better, deterministic"

The goal: **narrow** the corpus to the documents that actually carry evidence, and make the selection reproducible so the same inputs always yield the same corpus fingerprint.

### 4.1 Make the ranking fine-grained (break the −25 plateau)
Replace the coarse additive integer with a **continuous relevance score** that differentiates documents currently tied at −25. Add deterministic, content-derived signals:
- **Filing-type weight** (10-K/20-F/annual report/proxy > sustainability report > IR page > news), already partially present via tier — extend it to a graded scale.
- **Recency score** as a continuous function of filing year (not a coarse bucket).
- **Topic-phrase density**: count of distinct framework lexicon phrases matched in the URL **and title** (not just first-match −3). More on-topic → higher rank.
- **Document-type specificity**: exact-form slugs (`def-14a`, `10-k`, `cdp-response`) outrank generic ones (`report`, `policy`).

This alone collapses most ties, so the `slice` cut becomes well-defined.

### 4.2 Add an explicit deterministic tie-break key
Even with finer scoring, residual ties must break **deterministically, not by arrival order**. Append a stable secondary sort key:
```
.sort((a,b) => (a.priority - b.priority) || a.urlHash.localeCompare(b.urlHash))
```
where `urlHash` is a hash of the canonical URL. Two runs that discover the same URL set now always produce the **same** ordering and the **same** fingerprint, regardless of web-search arrival order.

### 4.3 Narrow the cap from 60 → a relevance-thresholded set
Instead of always keeping exactly 60, keep documents that **clear a relevance threshold**, capped at a maximum (e.g. 40). Rationale:
- For most companies the genuinely-relevant set is 15–35 docs; padding to 60 only adds tail noise that drives drift.
- A threshold + cap keeps the "best" docs and discards marginal ones, which both **reduces drift** and **sharpens scoring** (less irrelevant context diluting the evidence).
- This directly implements the user's underlying goal ("keep the most relevant documents") but achieves stability by being *selective*, not *expansive*.

### 4.4 Freeze the corpus per run (audit + reproducibility)
Persist the selected document set (URLs + content hashes + fingerprint) as the run's **frozen corpus**. On a re-run/re-examination, reuse the frozen corpus unless explicitly told to re-discover. This:
- Eliminates source #2 (web-search volatility) for re-runs.
- Provides the **audit-trail manifest** the reviewer asked for (Finding 2): timestamp, retrieved-doc list, fingerprint, model/prompt versions.

### 4.5 Sort before gate-batching (source #3)
Sort candidates by the fine-grained priority **before** slicing into LLM relevance-gate batches, so a given document is always judged alongside the same neighbours → stable accept/reject.

---

## 5. Expected effect

| Metric | Before | After (expected) |
|---|---|---|
| Corpus fingerprint stability (same company, re-run) | Low (tail reshuffles) | High (identical when URL set identical) |
| Typical kept-doc count | 60 (padded) | 15–40 (thresholded) |
| Score drift on re-run | ±10pt | ≤ ±2–3pt (residual = genuine new disclosures only) |
| Scoring sharpness | diluted by tail noise | improved (evidence-dense corpus) |

The remaining drift after this change should be **only** from genuinely new disclosures appearing on the web between runs — which is legitimate, and is now *visible* via the frozen-corpus manifest rather than hidden.

---

## 6. Risk and rollout

- **All changes are in document *selection*, not scoring** — the scoring prompts/weights are untouched, so this does not move the goalposts on rigor (it sharpens evidence, it does not inflate scores).
- **Recommend NOT changing this mid-run.** The active climate run (batch 546) should finish on the current logic so its results are internally consistent. Apply the redesign as the next version and validate with a **repeatability test**: run the same 11-company cohort twice and confirm fingerprints match and scores are within ±2–3pt.
- Suggested sequence: (1) tie-break key + fingerprint freeze (smallest, highest-impact, near-zero risk); (2) fine-grained ranking; (3) threshold+cap narrowing; (4) manifest attached to CSV export.
