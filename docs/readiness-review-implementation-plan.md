# CompanyIQ v3 — Readiness Review Implementation Plan

**Basis:** This plan implements only the changes verified as *real and necessary* in
[`readiness-review-response.md`](./readiness-review-response.md), checked against production
commit `f221b64` (= local `main` HEAD, deployed SUCCESS on all 4 Railway services). It does
**not** act on the review's or the ledger's unverified claims; where those disagreed with the
running code, the running code wins (see "Verified premises" below).

**Scope guarantees honoured throughout:**
- Every change is **framework-level** — no company-specific or topic-specific logic.
- **No relevant text is ever dropped** — the trim change (Phase 0.1 / Phase 1) only ever
  *widens* what is kept.
- Any change touching scoring reports **total cells flipping Yes→No and No→Yes** (split, not net).
- "Tested == production": every phase is validated on the **same commit** that is (or will be)
  deployed; no fix is called complete on a branch that prod isn't running.

> **A note on each "In plain terms" line:** these are deliberately non-technical one-liners so a
> non-engineer can follow what the change does and why. They do not replace the engineering detail
> underneath them.

---

## Verified premises (do not revert to the old ledger wording)

| Item | Old claim | Verified reality at `f221b64` |
|---|---|---|
| A3 eligibility enforcement | "shadow / OFF" | **ENFORCES in prod.** `analyzer.ts:3219-3220` — unset `ELIGIBILITY_ENFORCE` means *enforce*. Two script comments still say "shadow" and are stale. |
| B4 cache | "off" | **ON** (`CACHE_LAYER_POLICY=on`), but only 2 of 7 layers (bytes, index). **Score/verdict layer not wired** — so Issue 1 still stands. |
| B5 context-cost trim | (ledger quiet) | **ON in prod** (`CONTEXT_COST_POLICY` unset → code default "on"). This is the live trimmer behind Issue 4. |
| A6 framework-contract / A9 truthful-publication | "live, dormant" | **Materially inert** — imported only by their own tests; `PUBLICATION_POLICY` read nowhere in the pipeline. |

---

## Phase 0 — Immediate, low-risk, constraint-driven (do first)

These three are the only items that directly discharge the two blocking constraints
(recovery-boundary guard already lives in code; **small-PDF runtime gap** + **never drop relevant
text**). They are small, reversible, and verdict-safe.

### 0.1 — Stop the live evidence trimmer (`CONTEXT_COST_POLICY=shadow`) — *Issue 4*

- **In plain terms:** Right now the system quietly deletes bits of evidence it *thinks* are
  repeats before the AI reads them. We're turning that deletion **off** (it still logs what it
  *would* have cut, so we lose no insight), because its "is this a repeat?" rule is too crude and
  can throw away a sentence whose only new content is a date, a caveat, or a "not" — exactly the
  text that changes an answer. No code changes; it's a single setting flip (the service restarts to
  pick it up) that we can undo instantly.
- **What/why:** `model-cost.ts:235-236` trims a passage when
  `!isDecisive && newTokens.length===0 && !linkNew && !hits.phraseHit`. "Decisive" is defined by
  keyword/title-tokens only, so a passage whose unique content is a non-keyword qualifier, date,
  scope limit, or negation can be trimmed. Setting the policy to `shadow` makes the planner compute
  and log trim candidates **without applying them** — protecting constraint 6 immediately.
- **Seam:** env var only — Railway `variableUpsert` on prod **app** + **worker** services. No code
  edit (Railway restarts the services to apply the variable). Reversible by flipping back to `on`.
- **Framework-level:** it's a global policy switch; no company/topic logic.
- **Verdict-invariance:** evidence set can only grow (fewer passages removed) → answers can only
  become *more* complete, never less.
- **Acceptance test:** re-run one frozen-corpus batch with policy `shadow`; confirm (a) trim-candidate
  log still emitted, (b) 0 passages removed, (c) **cells flipped Yes→No / No→Yes vs the `on` run**
  reported as a split count.
- **Note:** this is the one Phase-0 action that changes a *production* setting. **Go-ahead granted**
  (user, this execution turn) to run Phase 0 including this flip. Reversible and spends nothing.

### 0.2 — Thread the "partial" extraction label through the fetch-success path — *Issue 5 (small-PDF gap)*

- **In plain terms:** When we download a document (e.g. a big PDF) and the reader times out but
  still pulls *some* text, the system currently files it as "complete" — as if we'd read the whole
  thing. That's the "small-PDF gap": we can silently miss the half we never read. This change lets
  the system honestly mark such a document "partial", so the research step knows to go back and
  finish reading it instead of assuming it's done. It never changes any score directly.
- **What/why:** `storage.ts:686` hard-codes `extraction_state = contentLength>0 ? 'complete' : 'empty'`
  on every successful fetch — so a truncated/timed-out-but-non-empty extraction is mislabelled
  "complete". The classifier that already *produces* "partial"
  (`processor.ts` `classifyExtractionCompleteness`, ~1051/1205/1236) isn't threaded into this persist.
- **Seam:** pass the classifier's completeness result into `recordFetchSuccess` and replace the
  binary derivation at `storage.ts:686` with the real label (`complete|partial|empty`). Then make
  A1 research-status (`storage.ts:868-884` reuse-path derivation) treat a **partial/failed essential
  doc as a gap**, routing it to the existing targeted re-retrieval (`pipeline.ts:2808-2845` →
  analyzer re-retrieval) that today only fires for `unknown/partial` on the empty branch.
- **Framework-level:** completeness classification is generic (truncation/length/structure signals),
  not per-company.
- **Verdict-invariance:** `extraction_state` is **never read by scoring** (confirmed in the column's
  own doc comment and by grep) — it only feeds research-state accounting and re-retrieval. Scores
  are unaffected; coverage improves.
- **Acceptance test:** craft/replay a known truncated PDF; confirm its row persists `partial`
  (not `complete`), that A1 status flags it as a gap, and that re-retrieval is triggered. Confirm
  **0 cell flips** attributable to the label itself (re-retrieval may add evidence — report any
  Yes→No / No→Yes from that separately).

### 0.3 — Documentation hygiene (no behaviour change)

- **In plain terms:** Fix stale code comments and ledger rows that describe the system as it *used
  to be*, not as it runs now — they're what misled the reviewer into thinking eligibility was "off"
  and caching was "off". Pure clean-up; nothing executes differently.
- **Changes:**
  - `server/scripts/build_gate3_labels.ts:380` and `gate3_build_labels_recovered.ts:542` — remove
    the "ELIGIBILITY_ENFORCE=OFF shadow" comment; replace with the verified default-on behaviour.
  - `implementation-run-ledger.md` — correct the A4 "pending push" row (commit `7d4eb49` **is** on
    main), and correct the B4 (**on**, 2/7 layers), A6/A9 (**inert**) status rows to match the
    running system.
- **Framework-level / verdict-invariance:** comments and docs only — zero runtime effect.
- **Acceptance test:** grep shows no remaining "shadow" eligibility comment; ledger rows match the
  Verified-premises table above.

---

## Phase 1 — Reproducibility (Issue 1)

**In plain terms:** Ask the system the same questions twice on the *same* evidence and it sometimes
gives different answers (28 of 360 cells flip on a fresh re-run). This phase removes the biggest
sources of that wobble **inside the builder** so that a **single** run is reproducible — and flags
any cell that's genuinely borderline rather than hiding it.

**Cost & scope model (reading of your Q1 — confirmed):**
- **The fixes live in the builder, and target a single run.** The score/verdict cache (1.2), the
  deterministic seams (1.5), the tie-break arbiter (1.3) and the borderline flag (1.4) all change the
  *analysis engine* so that **one** pass over a company is stable. Production still analyses each
  company **exactly once** — this phase does **not** make production re-run analysis N times.
  (This matches the standing preference for single-run robustness over iterative refinement.)
- **The "five replays" (1.1) is a one-time diagnostic, not a production cost.** It runs on a
  **small fixed sample** — the frozen corpus (a handful of companies), **not** all companies — purely
  to *measure* the wobble before the fix and *prove* it is gone after. It is a build-time harness that
  is retired/kept in CI as a spot-check; it is never part of a production scoring run.
- **Net effect on cost at scale:** flat or lower. A reproducible single run + a cache means fewer
  re-rolls, not more.

| Step | What / why | In plain terms | Seam | Acceptance |
|---|---|---|---|---|
| 1.1 | Five frozen-corpus replays → per-cell/per-measure stability table | "Run it 5× on identical evidence and chart which answers move." | batch runner on `f221b64`, corpus pinned | table with **Yes→No / No→Yes totals per measure** (constraint 4) |
| 1.2 | Wire the **score/verdict cache** (the missing 1 of B4's layers) | "Remember the answer for an identical evidence pack so we don't re-roll the dice." | key = `hash(evidence pack + measure version + prompt version + model id)`; add score layer alongside bytes/index in the cache module | identical pack → identical verdict; cache hit logged |
| 1.3 | Escalate only *disagreeing* cells via existing `cascade_v2` arbiter | "When two passes disagree, break the tie with the cross-model check that's already built but switched off." | enable `cascade_v2` for flip cells only | disagreeing cells converge; others untouched |
| 1.4 | Expose a per-cell **stable / borderline** flag | "Label each answer as solid or genuinely on-the-fence, instead of pretending all are equally firm." | additive output field; no scoring change | flag present; borderline set matches 1.1 |
| 1.5 | Reduce discovery variance (reuse prior source manifest) | "Start from the same list of sources each run so we're not comparing different evidence." | reuse manifest on replay | discovery delta shrinks run-to-run |

- **Framework-level:** cache key and arbiter are generic; no company/topic terms.
- **Verdict-invariance caveat:** 1.2/1.3 *intend* to change unstable verdicts toward stability — so
  each carries a **Yes→No / No→Yes split** vs the pre-change baseline (not net).
- **Dependency:** 1.2 depends on 0.1 being settled (so trimming doesn't vary the pack under the cache key).

---

## Phase 2 — Ground truth (Issue 2)

**In plain terms:** Today the system grades its own homework — the "recall" and "decisive" proofs
use the same keyword rule the scorer uses, so they can't catch its blind spots. This phase builds a
small, human-labelled answer key (including non-English filers) and makes every future change prove
itself against it, so we can tell real improvement from the AI just agreeing with itself.

**Cost & scope model (reading of your Q2 — confirmed):**
- **This is a build-time asset, not production human review.** The holdout is a **small, fixed set**
  (~250–300 cells across a handful of companies) that is **labelled once** and then checked into the
  repo as a static yardstick.
- **It is fully decoupled from production volume.** The gate runs in the **builder/CI** against that
  fixed set whenever code changes. Scoring 1 company or 10,000 in production triggers **zero** human
  input — nobody reviews production results by hand. The only human effort is the **one-time**
  construction of the fixed set (and occasional top-ups if the framework definitions change).
- **Why a human set at all:** it is the one thing the keyword oracle (`evidence-recall.ts`) cannot be —
  independent. Without it, A5/B5 "recall"/"decisive" improvements can't be distinguished from the
  scorer agreeing with its own keyword rule (the circularity behind the 56→70 "Yes" drift).

- **Build a 250–300-cell independent holdout**, human-labelled, incl. **≥2 non-English filers**.
- Make it the **standing regression gate** for all later changes.
- Re-decide A2/A5/B5/A3 and the 0/36 companies on it (the current A5/B5 "recall"/"decisive" proofs
  use a keyword oracle — `evidence-recall.ts` — and are circular; the "Yes" drift 56→70 (+25%) must
  be checked against truth, not the oracle).
- **Framework-level:** holdout spans companies/topics; gate is generic.
- **Acceptance:** gate runs in CI-style batch; A5/B5 recall measured against **human labels**, with
  **Yes→No / No→Yes vs oracle-era baseline** reported.

---

## Phase 3 — Scale (Issue 3)

**In plain terms:** We've never completed a clean run of more than ~10 companies — two big batches
failed and we don't yet know why. This phase adds timers to see where runs stall, reproduces the
failure deliberately, fixes the real bottleneck, and changes the "give up" rule so one flaky company
doesn't cancel the whole batch — then proves it at 25 → 50 → 100.

- **Instrument per-stage timers** with a DB heartbeat (find *where* 1277 stalled).
- **Reproduce** the batch-1277 timeouts at concurrency 8 with the stop-rule temporarily raised.
- **Fix the shared-resource bottleneck** (root cause, not an env knob).
- **Change the batch stop-rule** from "cancel after 3 first-attempt failures (pre-retry)" to
  **retry + quarantine**, stopping only on a *systemic* signal — so a trimmed-but-finished run beats
  an incomplete timeout.
- **Scale-test** 25 → 50 → 100.
- **Note:** B6 "dynamic" capacity only *lowers* concurrency (effective = 4 = static at 1 replica), so
  it does not help throughput; prefer **horizontal scaling** (more individually-stable replicas).
- **Framework-level:** timers/stop-rule are generic; no per-company tuning.
- **Acceptance:** a **≥25-company run completes** with per-stage timings; stop-rule quarantines
  rather than cancels; INCONCLUSIVE (genuine stop) distinguished from FAILURE in the report.

---

## Can wait — explicitly out of scope now (state, don't do)

- **A6 framework-contract wiring** — only needed before relying on *new* frameworks.
- **A9 publication record** — A1 already exposes research status; no user-facing gap today.
- **B2 routing / B3 parallelism / remaining B4 layers** — optimisations, not correctness.

---

## Dependency-ordered summary

| Order | Item | Issue | Risk | Redeploy? | Reports cell flips? |
|---|---|---|---|---|---|
| 1 | 0.1 Trim → shadow | 4 | low (reversible env) | no | yes (split) |
| 2 | 0.2 Partial label threaded | 5 | low | yes (code) | yes (re-retrieval only) |
| 3 | 0.3 Doc hygiene | — | none | no | n/a |
| 4 | 1.1 Stability table | 1 | none (measurement) | no | yes (split) |
| 5 | 1.2 Score cache | 1 | medium | yes | yes (split) |
| 6 | 1.3 cascade_v2 on flips | 1 | medium | yes | yes (split) |
| 7 | 1.4–1.5 flags + discovery | 1 | low | yes | yes (split) |
| 8 | 2.x Ground-truth holdout | 2 | medium | no (gate) | yes (vs oracle) |
| 9 | 3.x Scale | 3 | medium | yes | n/a (throughput) |

**Sizing disclaimer:** any effort figures carried over from the review are *rough sizing, not
developer quotes or commitments.*

**Definition of "complete" for the blocking constraints:** the patch is **not** complete until
(a) the behavioral recovery-boundary guard is confirmed in the running code **and** (b) the
small-PDF runtime gap (0.2) is closed and verified on the **same commit prod runs**.
