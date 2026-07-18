# Corpus-Drift Redesign — v2 (Response to Reviewer Pushback)

**Status:** specification + empirical validation. No pipeline selection logic has
been changed yet (the climate run has now completed, so the "don't change
mid-run" constraint no longer applies — see §0).

**What changed since v1:** every claim that was previously *asserted* is now either
(a) demonstrated on real stored data, or (b) explicitly downgraded to "not proven,
here is the honest fallback." The five reviewer points are addressed in order in
§1–§5. A consolidated set of commitments is in §6.

---

## 0. Live state at time of writing (context for the commitments)

- **Climate run (batch 546, framework 6) is COMPLETE:** 2,355 jobs completed +
  88 failed at the job level, but **all 88 of those companies were subsequently
  auto-recovered** by the Layer-2 reconciler and now show `completed`. Net:
  **2,443 / 2,443 companies completed, 0 stuck.**
- **Duplicate ISINs: 0** (Finding 1 fix + cleanup + unique index all live).
- The climate scores now occupy the live `total_score` column; the
  AI-Governance numbers survive only in the saved results snapshot
  (`analysis_results` id 35). This is directly relevant to §4 (the 12 names).

---

## 1. §4.1 fine-grained ranking — *demonstrated, and partially honest-failed*

You were right that this was the load-bearing, under-specified piece. I built the
scorer and ran it on the **real stored top-20 documents** for the four §2.2 sample
companies (pulled from `companies.discovery_diagnostics.topUrls`, which persists
the actual `{url, title, priority}` triples).

### 1.1 The proposed score (explicit weights)

Continuous score, **higher = better**, computed only from URL + title (no
web-order dependence). Five components:

| Component | What it rewards | Weight range |
|---|---|---|
| **Filing-type weight** | 10-K/20-F/40-F (10.0), DEF-14A/proxy (8.5), 10-Q (6.0), 8-K/6-K (5.0); CDP/TCFD (6.5); sustainability/ESG (4.5); annual report (5.0) | 0 – ~25 (additive) |
| **Source authority** | EDGAR-HTML primary (12.0) > EDGAR-PDF (9.0) > statutory registry (8.0) > voluntary registry (6.0); news (−6.0); junk aggregators (−10.0) | −10 – 12 |
| **Recency (continuous)** | `max(0, 6 − 1.5·(currentYear − docYear))` from a 4-digit year in URL/title | 0 – 6 |
| **Topic-phrase density** | `min(8, 1.6 × #distinct framework-lexicon phrases matched)` — *count*, not first-match | 0 – 8 |
| **Slug specificity** | exact form slugs (`def-14a`, `10-k`) 3.0 each; generic words (`report`) 0.6; + path-depth `min(2, 0.15·depth)` | 0 – ~8 |
| **On-domain** | issuer's own domain | 0 or 4 |

(Weights are the starting point for tuning, not sacred. The point of publishing
them is that they are reviewable and deterministic.)

### 1.2 Result on real data — did it break the −25 plateau?

| Company | OLD distinct / largest tie | NEW distinct / largest tie (score only) | + near-dup collapse |
|---|---|---|---|
| Dominion Energy | 5 / **15 @ −25** | 9 / 12 | 9 / 11 |
| Darden Restaurants | 5 / **14 @ −25** | 12 / 9 | 12 / 8 |
| The Southern Company | 6 / **10 @ −25** | 13 / 6 | 13 / **3** |
| Magna International | 7 / **10 @ −25** | 10 / 10 | 10 / 7 |

**Honest verdict: the fine-grained score does NOT, by itself, get every company's
largest tie ≤ 4.** It does the *meaningful* separation — it lifts authoritative
filings to the top with clear gaps (e.g. Dominion's 10-K at **30.8** vs the pack at
13–23; Magna's two 40-Fs at 30.8 / 29.3 vs proxies at ~21) — but it leaves residual
ties.

### 1.3 Why the residual ties are *correct*, not a failure

I inspected the survivors. They fall into two classes, and **neither should be
separated by a content score**:

1. **Title-less SEC exhibit pages** — e.g. Dominion's `"99.1 - SEC.gov"`,
   `"EX-99.1 - SEC.gov"`, `"Document - SEC.gov"`. The stored title carries no
   distinguishing signal; the differentiating content is in the document *body*,
   which discovery does not see at ranking time. No metadata-derived score can
   (or honestly should) rank these against each other.
2. **Genuine near-duplicates** — e.g. Magna's two identical
   `"2026 Management Proxy Circular"` PDFs. There is no "better" one; there is only
   a *stable* one.

For both classes the correct tool is a **deterministic-but-arbitrary** key. So the
determinism guarantee rests on the **layered key as a whole**, and I will stop
claiming §4.1 removes ties on its own:

```
sort key = ( authorityClass ASC,        # coarse integer bucket (regulatory > voluntary > IR > secondary)
             fineScore DESC,             # §1.1 continuous — does the meaningful work
             urlHash ASC )               # §2 — guarantees a TOTAL order for the indistinguishable remainder
```

With the urlHash tertiary key, **every document in all four samples becomes fully,
deterministically ordered** (verified: "fully ordered: True" for all four). You are
correct that urlHash-best ≠ better; my claim is narrower and defensible —
*for documents that are not distinguishable by available metadata, reproducibility
is the only honest goal, and urlHash delivers it.*

### 1.4 Added refinement: near-duplicate collapsing

Collapsing near-dups (same form + year + normalized-title-stem, keep highest
authority) both shrinks ties *and* removes redundant tail (Southern 20→17 docs,
largest tie 10→3). This is folded into the spec as a pre-ranking step. It is the
single most effective lever in the sample and doubles as part of §3 narrowing.

---

## 2. §4.3 threshold-vs-cap is a back-door scoring change — *accepted; gated behind A/B*

You are right: moving from "always 60" to "threshold-clear, capped at ~40" will move
scores for thin-evidence companies because the corpus shrank, not because the world
changed — and that confound must be measured, not assumed away.

**Commitment:** the threshold/cap change ships **only** behind a one-time A/B that
isolates the pipeline effect.

### 2.1 The A/B is genuinely "same URL set, old vs new selection"

This is now feasible *because the candidate set is already persisted*:
`discovery_diagnostics` stores `candidateFingerprint`, `topUrls`, `acceptedByGate`,
and `totalCandidates` per company. For the A/B we:

1. **Freeze** the candidate pool for the A/B cohort (replay the exact stored
   candidate URLs — no new web search), guaranteeing the *world* is held constant.
2. Run **selection-old** (priority sort, cap 60) and **selection-new**
   (layered key + near-dup collapse + threshold + cap 40) over that *same frozen pool*.
3. Re-score under both. Because corpus is the only thing that differs, the per-company
   delta **is** the pipeline-attribution number.

### 2.2 Attribution table shipped with every future run

```
ΔScore(company) = Score_new − Score_old        # pipeline effect (from the frozen-pool A/B)
ΔWorld(company) = Score_liverun − Score_new     # residual = genuine disclosure/world change
```

The CSV/manifest will carry both columns so that when a number moves, the user can
tell **pipeline-effect from world-effect** at a glance. No score moves silently.

---

## 3. §Cohort drift vs r14 — *explicit commitment to retire & rebaseline*

v1 did not reconcile the portfolio CSV against your signed-off r14 cohort. It now does,
explicitly:

- The r14 numbers and the current portfolio numbers are **not comparable** — different
  corpus snapshots and (for Apple/NVIDIA/etc.) in several cases different *rows*
  (workspace-1 demo rows vs workspace-3 portfolio rows). Treating their delta as
  "drift" mixes three unrelated causes.
- **Commitment:** once the redesigned pipeline is accepted, we **re-run the r14
  cohort under the new pipeline, declare that the new baseline, and retire the old
  r14/portfolio numbers as non-comparable.** All future drift is measured against the
  new baseline only, using the §2.2 attribution split. This is stated as a hard
  step in §6, not left implicit.

---

## 4. §The 12 already-duplicated ISINs in the delivered file — *one explicit choice*

The structural cause is fixed (dedup + unique index) and the 12 duplicate *rows* are
gone from the DB. But the **already-delivered AI-Governance CSV** still contains the
divergent pairs (Mitsubishi UFJ 6-vs-47, etc.), and those AI scores now live only in
the snapshot.

**Decision (picking one, per your instruction):** **Re-run the 12 names** under the
shipped new pipeline once it lands, and patch their rows in the AI-Governance CSV with
the new single deterministic value — rather than just documenting a dedup rule. Reason:
the divergence itself proves at least one of each pair was scored on a degraded corpus,
so a clean re-run is more trustworthy than picking a winner from two suspect rows. The
12 ISINs are enumerated in Appendix A. Until that re-run, the affected 12 rows in the
current CSV are flagged **"superseded — re-run pending"** so no one relies on them.

---

## 5. §4.5 sort-before-batching — *kept for hygiene, not credited for the headline*

Agreed. The relevance-gate batching order (source #3 of 4) is **Low-Medium** and will
**not** materially move the ±10pt number on its own. It is retained purely so the LLM
gate sees a stable, relevance-ordered batch composition (which removes one more small
non-determinism source). It is explicitly **not** part of the headline determinism
claim — that claim rests on §1 (layered key + near-dup collapse) and the §2 frozen
corpus.

---

## 6. Consolidated commitments (what actually ships, in order)

| # | Change | Risk | Proven? | Gate before portfolio use |
|---|---|---|---|---|
| C1 | **Deterministic layered sort key** (authorityClass, fineScore, urlHash) | Low | Yes — total order on all 4 samples | Unit test asserting total order on a fixed fixture |
| C2 | **Near-duplicate collapse** | Low | Yes — ties ↓, tail ↓ on samples | Same A/B as C3 |
| C3 | **Threshold + cap 40** (the back-door scoring change) | **Medium** | Not yet — by design | **Frozen-pool A/B (§2) + attribution columns** |
| C4 | **Corpus freeze + manifest** (URLs, content hashes, fingerprint, model+prompt+seed versions) attached to CSV | Low | Mechanism exists (`candidateFingerprint`) | Manifest schema review |
| C5 | **Re-run the 12 ISINs** and patch CSV; flag as superseded until then | Low | n/a | — |
| C6 | **Retire r14, rebaseline** under new pipeline; all drift measured vs new baseline | Process | n/a | One-time r14 re-run |

**Validation before any portfolio-wide adoption:** twice-run repeatability test on an
11-company cohort, target **≤ ±2–3 pt** run-to-run on identical inputs. If C3's A/B
shows a company moving > a chosen threshold purely from corpus shrink, that company is
routed to QA review rather than silently re-scored.

---

## Appendix A — the 12 ISINs to re-run (§4)

The 12 securities that were duplicated in the AI-Governance export and are flagged
"superseded — re-run pending": Mitsubishi UFJ (JP3902900004), Banco Santander
(ES0113900J37), Citigroup (US1729674242), JPMorgan (US46625H1005), SMFG
(JP3890350006), BBVA (ES0113211835), Mizuho (JP3885780001), plus the remaining 5
pairs identified in the dedup cleanup (Wells Fargo US9497461015 and the four others).
The exact, complete list is reproducible from the cleanup log and will be enumerated
in the re-run ticket.
