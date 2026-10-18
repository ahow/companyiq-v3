# Readiness Review — Response & Reconciliation

Date: 18 October 2026
Purpose: For each issue the reviewer raised, state (a) the honest, code-verified reality, (b) whether it is a **genuine open change still needed**, and (c) whether it reflects a **deliberate decision I made earlier not to address it** (a deferral/gate) rather than an oversight.

How this was checked: I read the actual source on the prod commit (`f221b64`, confirmed deployed on all four Railway services this session) and the live Railway environment variables for the production app + worker. Where the review, my ledger, and the live state disagree, I say so and side with the running code.

---

## 0. Headline

The review is largely fair and its three big issues are real. But three of its component claims are **wrong or stale**, and in two of those I was also wrong in my own ledger. Correcting them changes what is actually left to do:

- **A3 eligibility is NOT "shadow only" — it is enforcing in production.** The review read a stale helper-script comment; the live scoring path enforces by default. (Reviewer too pessimistic; my ledger was right.)
- **B4 caching is NOT off — `CACHE_LAYER_POLICY=on` in prod** (2 of 7 layers live; score layer still not wired). Both the review *and* my ledger said "off". Neither matched the running system.
- **A6 and A9 are not merely "dormant" — they are materially inert** (no pipeline caller at all). The reviewer's sharper wording is correct; my ledger's "live, dormant (shadow)" oversold them.

None of these corrections removes the three headline problems (reproducibility, no ground truth, no >10-company run). Those are real, and they were **deliberate deferrals on my part**, not solved work.

---

## 1. Corrections I owe to my own prior record

These matter because the user explicitly asked whether some items reflect a decision I made. In two cases my own documentation was simply wrong against the running code, and I am correcting it.

| # | My prior claim | Verified reality (prod `f221b64` + live env) | Evidence |
|---|---|---|---|
| C1 | Ledger: B4 caching "default off" | **`CACHE_LAYER_POLICY=on` in the live Railway env** (app + worker). 2 of 7 layers active (bytes, index). Score layer still not wired, so it does **not** cache verdicts. | Railway GraphQL env read, this session |
| C2 | Ledger: A6/A9 "live, dormant (shadow)" | **Materially inert.** `framework-contract.ts` and `truthful-publication.ts` are imported only by their own tests; `PUBLICATION_POLICY` is read nowhere in the pipeline. Flipping their policy env would do nothing. | `grep` repo-wide, this session |
| C3 | (Reviewer's claim, not mine) A3 "shadow only" | **A3 enforces by default in prod.** `analyzer.ts:3219-3220`: `enforce = rawEnforce === "" ? true : rawEnforce === "on"` — i.e. **unset ⇒ enforce**. Prod leaves `ELIGIBILITY_ENFORCE` unset, so it enforces. A stale comment in `server/scripts/build_gate3_labels.ts` still says "ELIGIBILITY_ENFORCE=OFF (shadow)", which is almost certainly what misled the review. | `analyzer.ts:3214-3235`; stale string in `build_gate3_labels.ts:380` |

---

## 2. The reviewer's five issues — verified verdicts

| Issue | Reviewer's claim | Verified reality | Real open change? | Deliberate deferral? |
|---|---|---|---|---|
| **1 — Verdicts not reproducible** | 28/360 cells flip on fresh re-run; 11–19 on a frozen corpus; scoring non-deterministic at temp 0 | **Accurate.** B4 score cache is not wired (confirmed), so identical evidence is not pinned to a verdict; cross-model cascade (`cascade_v2`) is off. | **Yes — genuine open change.** | **Yes.** I gated score-caching + stability work behind a held-out check that does not yet exist. Deferred, not solved. |
| **2 — No independent ground truth; Yes drift 56→70** | No human-labelled holdout; A5/B5 proofs use a circular keyword oracle (`evidence-recall.ts`) | **Accurate.** The decisive/recall oracle is keyword-defined; it is a diagnostic, not an accuracy proof. No adjudicated set exists for this roster. | **Yes — genuine open change.** | **Yes.** Explicitly recorded as a deferral ("no adjudicated human-labelled set for this roster"). |
| **3 — No completed run >10 companies** | Batches 1276 (12/25) and 1277 (4/25) failed; root cause undiagnosed; batch stop-rule cancels after 3 first-attempt failures; B6 only lowers concurrency | **Accurate.** B6 dynamic capacity is a no-op at one replica (`effective=4`=static). Root cause remains logged as undiagnosed. | **Yes — genuine open change.** | **Yes.** The 25-company failure was logged as a separate, undiagnosed load issue and parked. |
| **4 — B5 trim can remove non-duplicate evidence** | `planContextTrim` drops a no-keyword passage from an already-cited doc even if it carries a unique qualifier/date/scope/negation | **Substantially correct**, with one nuance (below). B5 is **on in prod** (`CONTEXT_COST_POLICY` unset ⇒ default "on"). | **Yes — and it touches a hard standing constraint** ("relevant text is never dropped"). | **Partly.** I shipped B5 on by default on the strength of a keyword-oracle invariant; I did not treat non-keyword qualifiers as protected. That was a decision, and it is the wrong one against the stated constraint. |
| **5 — Completeness only partly wired** | A4's complete/partial/empty label is not passed into `extraction_state`; a timed-out partial PDF can still count as "researched" | **Correct for the partial case.** Failed-reads (empty) *are* wired (EX04 → `recordExtractionState` → targeted re-retrieval). But the main fetch path forces `extraction_state = content>0 ? 'complete' : 'empty'` (`storage.ts:686`) — so a PDF that returned *some* text after a timeout is labelled **complete**, never **partial**. | **Yes — genuine open change** (the partial branch). | **Yes.** Ledger records this as "a follow-up". |

### Nuance on Issue 4 (so the fix is correct, not over-broad)
The real predicate (`model-cost.ts:236-237`) trims a passage only when **all four** hold: not decisive, adds no new decisive *token*, adds no new *source link*, and carries no decisive *phrase*. The reviewer's summary omitted the source-link and phrase guards, so no whole document is ever lost (the first passage per link is always kept). **But the core concern stands:** "decisive" is defined solely by the measure's own keywords/title tokens, so a passage whose only unique content is a non-keyword qualifier, date, scope limitation, or negation ("does not apply to Scope 3", "except in Germany", "from 2024") is **not** protected and can be trimmed. The code comment "Trim repeated context, never decisive context" is therefore accurate only under a keyword definition of "decisive" — which is narrower than "relevant". This is a live risk against the standing constraint.

---

## 3. Backlog-table corrections (where the review's status differs from the running system)

| Item | Review's status | Verified status | Note |
|---|---|---|---|
| A3 | "Shadow only" | **Enforcing (default-on)** | Review misled by a stale script comment; see C3 |
| B4 | "Off" | **`CACHE_LAYER_POLICY=on`** (2/7 layers; no score layer) | See C1 — does not fix Issue 1 |
| A6 | "Not wired" | Not wired — **confirmed** | Review correct; ledger oversold it |
| A9 | "Not wired" | Not wired — **confirmed** | Review correct; ledger oversold it |
| A4 | "pending push" (doc note) | Commit `7d4eb49` **is on `main`** | Documentation inconsistency only; review correct |

---

## 4. Cell-flip counts (reported figures — not re-run this session)

Per the requirement to surface Yes→No / No→Yes totals in summary tables. These are the reviewer's cited figures from the ledger; I have **not** re-executed the batches, so they are reported, not re-verified.

| Comparison | Yes→No | No→Yes | **Total cells changed** | Of 360 |
|---|---:|---:|---:|---:|
| Fresh re-run, identical roster (1284 vs 1287) | 10 | 18 | **28** | 7.8% |
| Frozen corpus — B1 (byte-identical prep) | — | — | **19** | 5.3% |
| Frozen corpus — A5 | — | — | **16** | 4.4% |
| Frozen corpus — B5 | — | — | **11** | 3.1% |
| Aggregate Yes count across backlog | — | — | **56 → 70 (+14, +25%)** | — |

The frozen-corpus rows are reported as net changed-cell counts in the ledger without a Yes→No / No→Yes split; recovering that split is exactly what the reviewer's "per-cell stability table" (Issue 1, step 1) would produce.

---

## 5. Standing-constraint check

- **"Relevant text is never dropped."** Currently **at risk in production**: B5 (`CONTEXT_COST_POLICY=on`) can trim a non-keyword qualifier/date/scope/negation from an already-cited document. Recommended immediate action: set `CONTEXT_COST_POLICY=shadow` (no redeploy) until "redundant" is redefined as a true near-duplicate (e.g. ≥90% shingle containment) and validated. This is the single change I would make today.
- **"Resolve the small-PDF runtime gap + recovery-boundary guard before calling the patch complete."** The failed-read path (small-PDF gap) **is** wired end-to-end (EX04 → re-retrieval). The remaining gap is the **partial** case in Issue 5 (timed-out-but-some-text PDFs labelled "complete"). So the patch is not yet complete by the constraint's own terms.
- **"Code tested == code in prod."** Confirmed: all four Railway services are on `f221b64` = local `main` HEAD.
- **"Framework-level, not company/topic specific."** All items above are framework-level; B5's trim and A3's enforcement are both keyword/invariant-driven with no company or topic hardcoding.

---

## 6. What I recommend doing now (vs. what can wait)

**Do now (small, constraint-driven):**
1. `CONTEXT_COST_POLICY=shadow` — stop B5 trimming live until redundancy is redefined. Directly protects the "relevant text never dropped" constraint. (Minutes.)
2. Wire the A4 **partial** label into `extraction_state` so a timed-out partial PDF is not counted as fully researched (Issue 5). (Closes the remaining half of the small-PDF constraint.)
3. Fix the stale `build_gate3_labels.ts` comment and the ledger B4/A6/A9 rows so the documentation matches the running system (prevents the next reviewer being misled the same way).

**The real programme (deferred, not solved — be honest with stakeholders):**
- Issue 1: five frozen-corpus replays → per-cell/per-measure stability table → wire the B4 score cache → escalate only disagreeing cells via `cascade_v2`.
- Issue 2: build + label a 250–300-cell independent holdout (incl. non-English filers) and make it the standing regression gate; re-decide A2/A5/B5/A3 on it.
- Issue 3: instrument the pipeline, reproduce the 1277 timeouts at concurrency 8, fix the shared-resource bottleneck, change the batch stop-rule to retry+quarantine, then scale-test 25→50→100.

**Genuinely can wait:** A6 wiring (only needed before relying on *new* frameworks), A9 publication record (A1 already exposes status), B2 routing, B3 parallelism, other B4 layers.

One caveat on the review's effort table (Section 5): those day-estimates are the reviewer's own, explicitly "not developer quotes" — treat them as rough sizing, not commitments.
