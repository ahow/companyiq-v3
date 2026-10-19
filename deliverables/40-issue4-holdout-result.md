# Issue 4 — B5 context trim: validation result and on-flip gate status

**Date:** 19 October 2026
**Author:** Implementation (CompanyIQ v3)
**Scope:** Close out Readiness Review Issue 4 ("The B5 context trim can remove non-duplicate evidence"). Reports the deployed state, the corrected-predicate offline validation against the frozen 1293 corpus, the yes→no / no→yes flip accounting, and why the literal on-flip gate (Issue 2 holdout) cannot be armed today.
**Commit under test == production:** `1d3aa94` (HEAD == origin/main; all four Railway targets SUCCESS at this SHA — see §5).

---

## 1. Bottom line

The dangerous behaviour the Review flagged is **already eliminated in production**: B5 runs in `shadow` on all four Railway targets, so it logs what it *would* trim but **applies no trim** — by construction it changes **zero** verdicts (yes→no = 0, no→yes = 0).

Separately, the trim predicate itself has been **corrected** so that, if ever switched on, it removes only genuine ≥90% near-duplicates rather than any non-keyword passage from an already-cited document. The corrected predicate has been validated offline against the real frozen 1293 corpus and **passes the recall invariant on 360/360 cells**, while keeping **870 more passages** than the old predicate.

What **cannot** be done right now is arm the literal gate the Review specifies for turning B5 back `on` — "test against the Issue 2 holdout before turning it back on." That holdout is a **human-analyst-labelled** ground-truth set that **does not yet exist** (Review Issue 2; recommended sequence Step 3 = "Build and label the holdout (analyst time), 3–5 analyst-days"). No paid model run substitutes for human labels, and a shadow-vs-on scoring comparison would in any case be confounded by Issue 1's documented noise floor (11–19 frozen-corpus flips with *no* code change). The on-flip is therefore **a bounded decision for you** (§6), not something that can be auto-passed from available data.

---

## 2. What the Review asked for (Issue 4)

> **Proposed solution.** Set `CONTEXT_COST_POLICY=shadow` now (no redeploy needed). If the saving is wanted later, redefine "redundant" as a genuine near-duplicate (for example, ≥ 90% shingle containment within an already-kept passage). Then test against the Issue 2 holdout before turning it back on.

Three distinct asks, tracked separately below:

| # | Ask | Status |
|---|---|---|
| 4a | Set B5 to `shadow` now | **Done** — live in `shadow` on all 4 targets @ `1d3aa94` |
| 4b | Redefine "redundant" as a genuine near-duplicate (≥90% shingle containment within an already-kept passage) | **Done** — implemented + offline-validated (§3, §4) |
| 4c | Test against the Issue 2 holdout before turning `on` | **Blocked** — holdout (human labels) does not exist; gate unarmed (§6) |

---

## 3. The corrected predicate (4b)

The old `planContextTrim` rule removed a passage if it was (i) not in the keyword-defined "decisive" set, (ii) added no new keyword token, and (iii) came from a document already represented in the pack. As the Review noted, a passage with a unique qualifier, date, scope limitation or negation but **no keyword hit** was therefore removable even though it carried information found nowhere else in the pack.

The corrected rule (`server/lib/model-cost.ts`) trims a passage **only** when it is a true near-duplicate of a passage already kept:

- near-duplicate = **≥90% k=4 word-shingle containment** (`NEAR_DUP_SHINGLE_K=4`, `NEAR_DUP_CONTAINMENT=0.9`) of the candidate's shingles inside a single already-kept passage;
- a passage that is not ≥90% contained in some kept passage is **never** trimmed, regardless of keyword content.

This is a structural guarantee, not a keyword heuristic: a passage cannot be ≥90% shingle-contained in another and still carry a unique qualifier/date/negation that the kept passage lacks. Default remains `DEFAULT_CONTEXT_COST_POLICY="shadow"`; the `off`/`shadow`/`on` seam is in `applyContextTrimPolicy` (wired at the B5 seam in `server/lib/analyzer.ts`). 13 unit tests pass (`server/lib/model-cost.test.ts`).

---

## 4. Offline validation against the frozen 1293 corpus

The proof (`server/scripts/gate_b5_offline_proof.ts 1293`, free — no LLM) reconstructs the **real** production evidence packs over frozen batch 1293 (framework 18 "AI Management"; 10 companies × 36 measures = **360 cells**) using the real `summarizeDocuments` + `buildEvidencePacksForCategory` + A5 `planBoundedExpansion` + B5 `planContextTrim`, in the same seam/order as `analyzer.ts`. For every cell it checks the hard invariant `verifyTrimPreservesRecall`: the decisive passages must remain a subset of the kept set and recall / misses must be identical before and after trim.

**Corrected predicate — invariant holds 360/360 (0 violations).**

### 4.1 Old vs corrected predicate footprint (frozen 1293, 360 cells)

| Metric | Old predicate | Corrected predicate | Change |
|---|---:|---:|---:|
| Recall invariant holds | 360 / 360 | 360 / 360 | — |
| Cells where trim fired | 326 | 242 | −84 |
| Passages trimmed (sum) | 2,021 | 1,151 | **−870 (kept)** |
| Passages kept (sum) | 5,525 | 9,569 | +4,044 |
| Token reduction | 25.39% | 7.65% | −17.74 pp |
| Projected $ saved / 10-co batch (first-pass) | $0.27 | $0.11 | −$0.16 |

The corrected predicate keeps **870 passages the old rule would have dropped** — exactly the non-duplicate context the Review warned about — while still passing the recall invariant on every cell. The remaining 7.65% reduction is pure ≥90% near-duplicate removal.

### 4.2 Per-company (corrected predicate)

| Company | Invariant OK | Trim fired | Token reduction |
|---|---|---|---:|
| CSX Corporation | 36/36 | 28 | 4.30% |
| MAGNA INTERNATIONAL INC. | 36/36 | 36 | 9.15% |
| THE SOUTHERN COMPANY | 36/36 | 36 | 17.16% |
| S&P GLOBAL INC. | 36/36 | 33 | 7.28% |
| MARTIN MARIETTA MATERIALS, INC. | 36/36 | 36 | 11.78% |
| DARDEN RESTAURANTS, INC. | 36/36 | 36 | 20.54% |
| BCE INC. | 36/36 | 36 | 5.16% |
| STRYKER CORPORATION | 36/36 | 0 | 0.00% |
| AMPHENOL CORPORATION | 36/36 | 1 | 0.12% |
| AFLAC INCORPORATED | 36/36 | 0 | 0.00% |
| **All (360 cells)** | **360/360** | **242** | **7.65%** |

**Honesty note (carried from the Review, Issue 2).** This invariant uses the measure's own keyword/title oracle to define "decisive". It is a valid *diagnostic* that the corrected predicate drops no decisive passage and no additional misses — and it is a strong *structural* result (≥90% shingle containment). It is **not** an independent accuracy proof; the Review explicitly calls the keyword oracle "circular as a proof of accuracy". True accuracy sign-off needs the Issue 2 human-labelled holdout (§6).

---

## 5. Deployed state and verdict-flip accounting (constraint: yes→no / no→yes)

**Production (deployed) B5 mode = `shadow` on all four targets at the tested commit:**

| Target | Deploy status | Commit |
|---|---|---|
| Production — app | SUCCESS | `1d3aa94` |
| Production — worker | SUCCESS | `1d3aa94` |
| Preview — app | SUCCESS | `1d3aa94` |
| Preview — worker | SUCCESS | `1d3aa94` |

Prod worker `CONTEXT_COST_POLICY = shadow`; health OK on `companyiq.online` and `app-production-9929.up.railway.app` (`{"status":"ok","version":"3.0.0"}`).

### Cells changing yes→no / no→yes

| Comparison | Mode | Y→N | N→Y | Total flips | Notes |
|---|---|---:|---:|---:|---|
| **Deployed production vs pre-fix** | `shadow` | **0** | **0** | **0** | Shadow applies no trim → zero verdict change by construction |
| Measured on-mode (batch 1293 B5-off vs 1294 B5-**on**, **old** predicate) | `on` | 4 | 7 | 11 | Within Issue 1 noise floor (11–19 frozen-corpus flips with no change); not distinguishable from scoring noise |
| On-mode, **corrected** predicate | `on` | — | — | — | **Not measured** — requires a paid scoring run, which would be confounded by the Issue 1 noise floor and is not authorised |

The only verdict change reaching production is **zero** (shadow). The only measured on-mode flip count (11) is from the *old* predicate and sits inside the documented noise floor, so it cannot be read as a real accuracy signal either way. The corrected predicate's on-mode flip count is deliberately **not** fabricated from a confounded run.

---

## 6. The on-flip gate — why it is unarmed, and the decision for you

The Review's gate for turning B5 `on` is: *"test against the Issue 2 holdout before turning it back on."* That gate cannot be armed today:

- The Issue 2 holdout is **250–300 human-analyst-labelled cells**, labelled blind to model output, including at least two non-English filers (Review Issue 2 §solution; sequence Step 3). **It has not been built** (no human-label file exists for this roster; the ledger's own GATE3 caveat confirms "no adjudicated human-labelled set for this roster").
- The offline gate CLI (`phase2_gate_cli.ts gate`) reports **"not armed"** without human labels and never fabricates a pass.
- A paid shadow-vs-on scoring comparison is **not** a substitute: it measures nothing against ground truth, and Issue 1's noise floor (11–19 flips on a frozen corpus with no code change) would swamp a 7.65%-near-duplicate effect.

**Recommendation: keep production on `shadow`.** Issue 4's actual danger — dropping non-duplicate context — is already removed (shadow drops nothing; the corrected predicate is validated and ready). The ~5 cents/company saving is not worth flipping `on` against an unarmed gate and on absent-data inference.

**Your decision (bounded yes/no):**

- **(A) Keep `shadow` (recommended).** No verdict risk; revisit the flip when the Issue 2 holdout is built and armed (Review sequence Steps 3 + 5).
- **(B) Build the Issue 2 holdout, then decide.** Larger, mostly-analyst effort (3–5 analyst-days); out of scope for this turn unless you ask. This is the only path that *properly* arms the gate.
- **(C) Explicitly override** and flip `on` now, accepting the offline + structural evidence (360/360 recall invariant, ≥90% near-dup containment, 870 more passages kept) as sufficient in place of human labels. This is a one-line env change (`CONTEXT_COST_POLICY=on`, auto-redeploys) that I will make **only on your explicit instruction** — I will not infer this pass from absent data.

---

## 7. Evidence index

- Corrected-predicate proof: `gate_b5_out/gate_b5_offline_proof.{json,md}` (360/360, 7.65%).
- Old-predicate proof (backup): `gate_b5_out/gate_b5_offline_proof.OLDPREDICATE.{json,md}` (326 cells, 25.39%).
- Measured on-mode flips (old predicate): `gate_b5_out/b5_flips_1293_vs_1294.{json,md}` (Y→N 4, N→Y 7, total 11).
- Code: `server/lib/model-cost.ts`, `server/lib/analyzer.ts` (B5 seam), `server/lib/model-cost.test.ts` (13 tests).
- Commit under test = production: `1d3aa94`.
