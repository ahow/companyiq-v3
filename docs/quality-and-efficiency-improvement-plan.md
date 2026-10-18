# CompanyIQ v3 — Quality & Efficiency Improvement Plan

**Date:** 14 October 2026
**Author:** Agent, for Andy Howard
**Status:** PLAN ONLY. No code, production, budget, scoring, migration or run changes have been made. Everything below is proposed work for the feature branch; anything touching production, paid runs, migrations, historical results or scoring semantics needs separate approval.
**Supersedes scope of:** `docs/speed-cost-improvement-plan.md` — that document remains the detailed efficiency lane and is referenced here, not deleted. This document is the master plan that adds the completeness/accuracy lane the earlier plan deliberately flagged as "out of scope."

---

## Why this document exists

The earlier plan answered a narrower question — *make it faster and cheaper, change nothing about the answers*. Under that brief, every completeness/accuracy work package in the reviewer's brief (WP02–WP07, WP15) was correctly marked **OUT OF SCOPE (quality work)**: they *improve* answers, so they fell outside a pure efficiency ask.

You have now widened the ask:

> *"I am interested in incorporating measures which improve the accuracy and/or completeness of the analysis as well as those which improve speed or reduce cost. Any measures which improve speed or cost must not degrade (or be likely to degrade) accuracy and/or completeness."*

So the governing rules for this plan are now **two**, and they are asymmetric on purpose:

1. **Quality may go up.** Measures whose purpose is better completeness or accuracy are now **in scope** and welcome, even when they cost a little more time or money — provided the extra cost is proportionate and declared.
2. **Efficiency may never buy itself with quality.** Any speed or cost measure must be **exactly equivalent** to today's answers, or **validated as unchanged-or-better** on adjudicated + held-out cases, before it ships. Speed/cost is never allowed to *degrade or be likely to degrade* completeness or accuracy.

This is exactly the reviewer's own "quality rule" (*do not reduce completeness or accuracy to improve apparent speed or cost*) and it matches how you work: diagnose root cause from live evidence, prefer provable equivalence, validate behavioural changes against held-out adjudicated cases, and never tune toward a target distribution.

---

## The shape of the plan: two lanes, one set of gates

The reviewer's executive diagnosis is the right frame: run **two parallel lanes that share one set of quality gates.**

- **Lane A — Trustworthiness (completeness & accuracy).** *Did we find everything in scope, read it correctly, quote it honestly, attribute it to the right entity/date, retrieve the decisive passage, and apply the measure as written?* This lane can raise cost; it must raise quality.
- **Lane B — Efficient execution (speed & cost).** *Stop obsolete work, reuse valid work, remove redundant computation, allocate capacity by accepted throughput.* This lane must hold quality exactly flat (or prove it improved).

The two lanes meet at a **shared acceptance protocol** (the reviewer's GATE0–GATE6, adopted below). That shared protocol is what lets Lane B prove "no degradation" and lets Lane A prove "genuine improvement" using the *same* adjudicated fixtures and the *same* measurement definitions. Neither lane is trustworthy without it, which is why WP01 (the independent baseline) is the first thing built for both.

**Plain-language version.** The fast/cheap wins come from *not repeating work we have already done*. The quality wins come from *not silently doing less than the scope demands* — not missing a filing, not losing a table, not quoting the wrong company, not showing an incomplete run as if it were comprehensive. The same measuring stick proves both.

---

## The evidence this plan is built on

From the code, the prior investigations, and the reviewer's evidence register (E1–E7):

**Quality signals (Lane A):**
- **Batch 1277 produced a complete-looking score set while six first-party BCE disclosures were still unresolved** (E3). A failed/cancelled fetch can be mistaken for "the issuer disclosed nothing." This is the single clearest completeness risk: a *false substantive No*.
- **`checkProvenance` at the review baseline accepts ≥90% normalised contiguous overlap OR an absolute 120-character run**, and unresolved source titles fall back to pack-wide provenance (E6). The absolute-length branch can accept a genuine fragment followed by an invented suffix; the fallback can attach a citation that names no eligible document. These are *accuracy* risks (fabricated/misattributed support).
- **Normalisation at the baseline was ASCII-only** (E6) — a correctness/auditability risk for CJK, Arabic and mixed-script evidence.
- **Wrong-entity reinsertion and distribution-driven rubric advice** are carried forward as *revalidation* tasks, not confirmed current bugs (E7) — verify in the current tree before acting.

**Efficiency signals (Lane B), unchanged from the efficiency plan:**
- AXA preparation **446s in production vs ~10.8s on saved data** (E4) — we recompute/re-fetch reusable work.
- **~210–234 serial searches** for some companies (E4), many near-duplicate.
- **~\$0.405/company model cost, \$3.67 of \$4.05 was input tokens** (E2) — we pay mostly to *re-send context*.
- The **`tini` PID-1 reliability fix is live** in prod (`c1166ef6`) and dev (`6987d716`); idle PID usage fell from ~963/1000 to ~37/1000. The pipeline is now *reliable but slow*; speed is Lane B's job, durability of the fix is A5/B-durability.

---

# Every change at a glance — issue, fix, difficulty, cost, time

This section exists to answer one question directly: *for each measure, what is wrong, how am I fixing it, how likely is it to work, what does it do to cost, and what does it do to the time to process one company?*

**How to read the ratings (they are estimates, not measurements).** The entire plan is built so the *real* numbers come from the WP01 baseline and WP10 profiler before anything ships. Until then:
- **Difficulty / likelihood** — *Low / Medium / High* effort, paired with my confidence it works as intended. "Exact-equivalence" items are high-confidence because success is defined as byte-identical output; "semantic" items are lower-confidence because success depends on held-out validation.
- **Cost effect** — direction of effect on **all-in cost per accepted company** (model + search/proxy + compute + repair/retry). "↓" cheaper, "→" neutral, "↑ slight" a small deliberate increase bought for quality.
- **Time effect** — direction of effect on **wall-clock time to process one company**. Same arrows.

The asymmetry you set is visible in the columns: Lane A items are allowed a small "↑ slight" on cost/time because they buy completeness or accuracy; every Lane B item is "↓" or "→" on quality by construction, or it does not ship.

### Lane A — Completeness & Accuracy

| # (WP) | Issue in plain terms | How I fix it | Difficulty / likelihood | Cost effect | Time per company |
|---|---|---|---|---|---|
| **A0 (WP01)** | We can't *prove* answers are right or complete — "ten companies, 360 results" shows the run finished, not that it was correct. | Build a small versioned set of hand-adjudicated company×measure cases (known positives, negatives, wrong-entity, date-mismatch, missing-source, translated, table/OCR, contradictory), with held-out cases kept separate. | Medium effort, high likelihood. It's test data + harness, not pipeline surgery; the hard part is honest adjudication, not code. | → (offline; no per-run cost) | → (offline; doesn't touch live runs) |
| **A1 (WP02)** | A failed or cancelled fetch can be shown as "the company disclosed nothing" — a *false No* that looks complete (the Batch 1277 risk). | Add a research-scope manifest + per-document attempt ledger; separate "we looked and found nothing" from "we never got the document"; attach `researchStatus` to results; never display incomplete as comprehensive. | Medium effort, high likelihood. Additive fields/views, no scoring change — but it touches many readers (API/UI/CSV/report), so the work is breadth not depth. | → to ↑ slight (a few retries previously hidden now happen honestly) | ↑ slight (surfacing/retrying genuine gaps adds a little; can be bounded) |
| **A2 (WP03)** | The quote check can accept a real 120-character fragment with an *invented* ending, or attach a citation that names no eligible document; non-Latin text is mishandled. | Require full support under a strict, Unicode-aware, versioned normalisation; scorer uses application-supplied passage IDs (can't invent titles); honest ellipses; bounded citation repair before giving up. | Medium–High effort, medium likelihood. The logic is contained, but it *changes acceptance behaviour*, so it needs positive fixtures to avoid over-rejecting genuine quotes. | → (validation logic, negligible per-run) | → (negligible compute at scoring time) |
| **A3 (WP04)** | A passage from the wrong entity/year/author (a subsidiary, a supplier mention, a superseded report) can slip through into a positive result. | Carry an immutable eligibility decision through every stage (retrieval → arbiter → export); apply the framework's own parent/subsidiary rules; recompute eligibility per target even when source bytes are reused. | Medium–High effort, medium likelihood. It's a *composition* check across existing controls; cross-path tracing (EP01–EP06) is the effort. | → (checks are cheap) | → (negligible) |
| **A4 (WP05)** | Fetching a PDF isn't the same as reading it — a scanned page, a table, or a final-page disclosure can be silently lost; the subprocess move must not drop content. | Record extraction quality/pages/engine; OCR adaptively on pages that need it; preserve table headers/units/footnotes; treat translation as an aligned derivative; label uncertain completeness as partial, never invent a %. | High effort, medium likelihood. Extraction/OCR fidelity is genuinely fiddly across layouts and languages; the OCR-only-where-needed part is also a *speed* lever. | ↑ slight (adaptive OCR adds some; offset by not OCR-ing everything) | mixed: → to ↓ on text-heavy docs (skip needless OCR); ↑ slight on scanned/table docs that truly need it |
| **A5 (WP06)** | The right document can be found but its decisive passage never makes it into the model's prompt — so a smarter model still can't answer. | Benchmark the exact pack shown to each scoring role; add lexical/semantic/structured retrieval only where misses are measured; bounded expansion on demonstrated insufficiency. **Never shrink top-k just to save tokens.** | Medium–High effort, medium likelihood. Retrieval tuning is iterative; the guardrail (recall at real prompt budget) keeps it honest. | → to ↑ slight (bounded expansion adds a few calls only when evidence is insufficient) | ↑ slight (only on cases that trigger expansion) |
| **A6 (WP07)** | Rubrics can drift toward a target Yes/No rate, and a missed document can get "fixed" by loosening the measure instead of improving research. | Make each measure a strict contract (construct, scope, anti-inference, applicability); classify every test-drive defect by stage; version rubric edits with an impact preview; **prevalence can never move a definition**. | Medium effort, medium likelihood. Mostly process + contract structure; the discipline (no distribution tuning) is the point, matching your Goodhart guard. | → (offline framework work) | → (offline) |
| **A7 (WP08)** | We can't reliably reproduce or compare runs, so "it changed" gets blamed vaguely on "model randomness." | Run manifest linking framework/source/extraction/retrieval/prompt/model/code hashes; separate fixed-corpus replay from fresh research; record where a provider alias can drift. | Medium effort, high likelihood. It's plumbing/metadata, reusing existing provenance fields; low behavioural risk. | ↓ (it's what makes safe caching and cost attribution *possible*) | ↓ (enables replay/reuse — the 446s→10.8s lever) |
| **A8 (WP09)** | The acute resource leak is already fixed (`tini`); the risk now is *assuming* the rest of cancellation is sound without checking. | Verify the remaining invariants only (deadline flooring, IPC withdrawal, bounded browser stop, obsolete-work settlement, `unattempted_cancelled` stays retryable) — do not rebuild merged work. | Low–Medium effort, high likelihood. Verification against existing tests; no new architecture. Honour your no-override / stop-on-unresolved constraints. | → | → to ↓ (stopping obsolete work frees capacity) |
| **A9 (WP15)** | A reader can't always tell an unchanged score from one whose research quietly became incomplete; release records mix "approved" with "feature-branch-only." | Link every exported result to framework version/scope/coverage/evidence IDs; keep immutable snapshots + explicit revisions; keep candidate/approval/merge/deploy records separate; raw (non-deduped) test evidence. | Low–Medium effort, high likelihood. Reporting/governance, no pipeline risk. | → | → |

### Lane B — Speed & Cost (quality held flat by construction)

| # (WP) | Issue in plain terms | How I fix it | Difficulty / likelihood | Cost effect | Time per company |
|---|---|---|---|---|---|
| **B0 (WP10+WP13-A)** | We're guessing where time and money go (the 446s gap, the \$3.67 input-token bill) instead of measuring it. | Read-only per-stage profiler + per-call cost attribution (request/measure/role/provider/model, token counts, retries). No behaviour change. | Low–Medium effort, high likelihood. Instrumentation only. | → (makes later cuts honest) | → (read-only) |
| **B1 (WP10)** | The prep stage recomputes identical work — rebuilding regex patterns across 2,675 peers, redoing BM25 term counts every time. | Precompile patterns once; precompute BM25 term maps/doc-lengths under content keys; batch/skip no-op DB writes; bound caches. **Full peer universe preserved — no cutting 2,675→100.** | Medium effort, high likelihood. Classic exact-equivalence optimisation; success = byte-identical output, so low quality risk. | ↓ (less compute) | ↓↓ (this is where the biggest wall-clock win lives) |
| **B2 (WP13-B)** | The same model call (same prompt, context, measure) is sometimes issued more than once. | Detect provably-identical calls under full dependency keys and make them once. | Low–Medium effort, high likelihood. Equivalence by construction. | ↓ (fewer paid calls) | ↓ (fewer round-trips) |
| **B3 (WP11)** | ~210–234 searches run one-after-another, many near-duplicates finding nothing new. | Dedupe effectively-identical queries; run independent searches in *bounded* parallel within provider quotas; try canonical issuer copies before launching a browser. **Fewer redundant calls, not fewer queries.** | Medium effort, medium–high likelihood. The attribution trace (which query found a *new* source) de-risks it; essential-source recall must stay unchanged. | ↓ (fewer proxy/search/browser calls) | ↓↓ (stops serial waiting — large wall-clock win) |
| **B4 (WP12)** | Real runs redo valid work from scratch (why 446s in prod vs ~10.8s on saved data). | 7-layer cache keyed by true dependencies (bytes→extraction→OCR→index→eligibility→packs→scores); freshness by content hash; reason-aware negative caching; strict tenant isolation. Gated on A1 (gap manifest) + A3 (eligibility recompute). | High effort, medium likelihood. Powerful but the freshness/isolation correctness is where caching bugs hide — hence the guardrails and gating. | ↓↓ (biggest cost lever on warm runs) | ↓↓ (biggest time lever on warm runs) |
| **B5 (WP13-C/D/E)** | We pay mostly to *re-send* context; some context is repeated/irrelevant, and the strong model is used everywhere. | Trim *repeated* context (never decisive passages); provider prompt-cache-friendly stable prefixes; selective cheaper-first-pass with escalation on uncertainty/contradiction. | Medium–High effort, medium–lower likelihood. These are *semantic*; they only ship after held-out proof per measure/topic/language, verification stays on. | ↓ to ↓↓ (largest *model*-cost lever) — but unproven until validated | → to ↓ slight |
| **B6 (WP14)** | Capacity is tuned by guesswork; raising a pool naively can break things (the 88-vs-97-connection example). | Classify the bottleneck first; inventory every DB connection; one-variable capacity matrix; prefer more replicas at lower per-replica concurrency. Prod changes need approval. | Medium effort, medium likelihood. Scientific method applied to capacity; the risk is environmental, not algorithmic. | → to ↓ (throughput per unit cost) | ↓ at *batch* level (more accepted companies/hour); ~→ for a single company |
| **B-dur** | The live `tini` fix lives in the Railway start command — if that's ever cleared, the slow/crashing behaviour silently returns. | Restructure the Dockerfile so `tini` is the permanent `ENTRYPOINT`. **Gated on your confirmation the current dashboard re-run is clean.** | Low effort, high likelihood. Small, well-understood Docker change. | → | → (protects every other gain rather than adding one) |

**Reading the two tables together:** the safe, high-confidence wins are top-left and top-right — A0/A7 (foundations), A1/A2 (the two biggest trust fixes), and B1/B2/B3 (exact-equivalence speed). The biggest *numbers* (B4 caching, B5 model-cost) carry the most risk and therefore the most validation before they ship. Lane A's cost/time "↑ slight" entries are the price of not publishing a false negative — small, bounded, and the thing you explicitly said you're willing to pay for.

---

# Lane A — Completeness & Accuracy (now in scope)

Ordered by dependency, following the reviewer's priority map. Everything here is behind the shared acceptance protocol, uses small versioned fixtures first, prefers additive fields over disruptive migrations, and preserves the existing numeric/binary scoring contract until a versioned change is separately approved.

### A0. Independent, staged quality baseline — the measuring stick (WP01)

**Why first:** expected score counts and model consensus do *not* reveal omitted disclosures or systematic wrong answers. Every claim in both lanes — "more complete," "more accurate," "no regression" — is unprovable without a neutral ground truth. This is the foundation of the whole plan.

**What we build:** a versioned evaluation bundle at **company × measure** level. Each case carries the exact measure definition, as-of/entity scope, independently identified eligible sources, decisive passages, an adjudicated verdict with rationale, coverage status, and known ambiguity. Crucially, use **separate stage labels** — source availability, extraction, retrieval, quote validity, final scoring — so a wrong answer is attributed to the stage that caused it, not blamed on the framework.

**Design discipline (your anti-Goodhart constraint, explicit):**
- Start with a **small stratified pilot**: known-positive, known-negative, wrong-entity, date-mismatch, missing-essential-source, translated-evidence, table/OCR, and contradictory-evidence cases.
- Keep **development and holdout cases separate at company/source-family level** to prevent leakage. Candidate-generated examples can never be the sole ground truth.
- **Preserve analyst disagreement** rather than forcing a false consensus — a disputed case stays flagged, not averaged away.
- A real-world **No** is harder to establish than a positive quote: require an adequate declared search/coverage protocol and distinguish an *exhaustive fixture-negative* from an *uncertain real-world absence*.

**Acceptance:** versioned adjudicated fixtures + holdout protocol exist; every material score change is explainable against measure and sources; known critical positives/negatives pass; disputed cases stay flagged; the product never claims full-universe accuracy from a small sample.

### A1. Make completeness explicit — stop false substantive negatives (WP02) — **highest-value completeness item**

**The risk, concretely:** Batch 1277. A complete score set was published while essential first-party documents were unresolved. If downstream code treats a `dead` / `not_attempted_cancelled` source as "conclusively unavailable," a network failure becomes a fabricated finding of non-disclosure. That is the worst kind of error because it *looks* complete.

**What we build (additive, not a migration):**
- A **research-scope manifest** per assessment (entity boundary, as-of/lookback, eligible source families, languages, evidence requirements) and a **per-document attempt ledger**.
- **Separate** discovery eligibility, fetch lifecycle, extraction quality, policy exclusion and assessment relevance — conceptual states like `candidate / eligible / excluded_with_reason / queued / attempting / retrieved / extracted_complete / extracted_partial / transient_unavailable / permanent_unavailable_with_evidence / not_attempted_cancelled / superseded`. (Proposed distinctions, not mandated enum names — inspect the actual schema and all readers first.)
- Track **essential sources / document families** and unresolved material gaps. A verified equivalent issuer/regulatory copy (entity + version/content + date confirmed) may satisfy a requirement; a policy-excluded aggregator does **not** substitute for a missed annual report. Record gap→measure dependency *conservatively* — a document gap may affect some measures, not automatically all.
- Keep the existing score contract, but **attach `researchStatus` and reasons**. An incomplete assessment may stay draft or be explicitly published as incomplete per approved policy — **it must never be displayed as comprehensive**, and history is never silently relabelled.

**Tests:** CV01 (first-party timeout → incomplete, not unqualified No), CV02 (excluded third-party doesn't inflate gap count), CV03 (pre-fetch cancellation stays retryable), CV04 (cached corpus missing a newer doc → freshness finds the gap), CV05 (equivalent copy satisfies version; wrong-year does not), CV06 (truncated extraction → dependent measure unresolved), CV07 (API/UI/CSV/report show consistent status).

**Acceptance:** every required source has a traceable outcome; no essential gap is published as comprehensive; coverage metrics use an explicit denominator; discovery recall is labelled *lower-bound benchmark recall*, never "all sources found."

### A2. Harden quotations and stable source attribution (WP03) — **highest-value accuracy item**

**The risk, concretely (confirmed source finding E6):** the absolute-120-character acceptance branch can pass a real fragment + invented suffix; pack-wide provenance fallback can attach a citation naming no eligible document; ASCII-only normalisation mishandles non-Latin scripts.

**What we build:**
- The scorer **selects stable document/passage IDs supplied by the application**, never invents titles/URLs; IDs resolve against the immutable evidence pack and source version.
- A quotation requires **full support** under a **narrowly defined, Unicode-aware, versioned normalisation policy** that preserves numbers, minus signs, decimals, negation, units and material punctuation, with a mapping back to original characters so displayed quotes are auditable.
- Replace the **fuzzy absolute-length rule** that admits arbitrary unsupported extensions.
- Honest **ellipses**: store multiple validated spans in the same eligible context; never merge noncontiguous fragments into a falsely contiguous quote. Paraphrases are labelled as paraphrases with supporting passages, not passed off as verbatim.
- Keep **anti-echo** protection but don't reject genuine source text merely because the same wording appears in a rubric example (exact provenance + authoritative source identity beats lexical similarity).
- **Bounded citation repair** against already-present evidence before concluding; record the original failure; escalate/flag when valid support is unavailable. Invalid evidence does **not** auto-establish a substantive No.

**Note:** this changes acceptance behaviour, so it is versioned and compared against independent labels before rollout (GATE3), and paired with positive fixtures to prevent over-rejection.

**Tests:** QI01–QI09 (invented suffix fails; changed magnitude/sign/date/negation fails; invented source ID fails; wrong document/year fails; approved whitespace/hyphenation passes; CJK/Arabic/mixed-script auditable; rubric-identical genuine text not rejected; one valid quote supports only if it meets the exact measure; source-ID ambiguity is explicit failure/repair, not pack-wide fallback).

### A3. Preserve entity, provenance and temporal eligibility end to end (WP04)

**Status:** wrong-entity reinsertion is a *carried-forward* concern — verify the current trace before treating it as a live bug; the app already has identity/provenance controls, so this tests their *composition*, it does not replace them.

**What we build:** attach eligible entity, issuer/author, source class, as-of/publication/version and scope to every document/passage; carry an **immutable eligibility decision/version** through retrieval, prompt building, secondary votes, arbiter, expansion, persistence and export. A fallback may repair missing data but can never silently override an exclusion. Apply the **framework's own parent/subsidiary rules** (a group policy may apply to a subsidiary in one framework and not another). Shared source bytes may be reused while eligibility is **recomputed per target** — never infer an issuer's practice from a supplier/customer reference or a similarly named company.

**Why this also unlocks Lane B:** safe cross-entity cache reuse (Lane B / WP12) is only legitimate *because* eligibility is recomputed per target here. A3 is the guardrail that makes a cost win safe.

**Tests:** EP01–EP06 (rejected third-party stays rejected through all paths; subsidiary can't support parent-wide claim unless scope permits; current-year question doesn't inherit a superseded report; issuer-filed vs analyst-commentary distinguished; cache reuse can't carry stale eligibility; incomplete provenance → repair/review, not authority assumption).

### A4. Preserve extraction, table, OCR and translation fidelity (WP05)

**The risk:** fetching bytes ≠ obtaining complete usable evidence. A marker PDF proving extraction "works" says nothing about a scanned, multipage, table-heavy or multilingual report. Moving `pdf-parse` into a subprocess must preserve its useful output and fallback.

**What we build:** record bytes/pages available, extraction engine/version, processed pages, language, text quality, table structure and truncation reason — and where completeness is genuinely uncertain, **label it unknown/partial rather than inventing a percentage**. Use **OCR adaptively** (on pages that need it, not indiscriminately and not never). Preserve table headers, units, row/column relationships and footnotes. Dedupe boilerplate without removing a repeated *policy* or a decisive table note. Treat translation as an **aligned derivative with original-span links**, not replacement source truth.

**The one place Lane A and Lane B touch here:** "OCR only the pages that need it" is simultaneously a fidelity measure *and* a speed measure — but it is accepted **only** if it provably loses no content (EX02/EX07). It is a Lane-B speed win *gated on* Lane-A fidelity tests, never the reverse.

**Tests:** EX01–EX07 (final-page decisive evidence survives; scanned/rotated → OCR while text pages intact; multi-column order + table units preserved; benign-large and pathological-small PDFs bounded without source loss; original+translation retain numbers/negation/entities/scope; subprocess timeout → incomplete, partial stdout not accepted as complete; old/new extractor compared on ordinary/multipage/table/OCR/non-Latin fixtures by downstream passage recall).

> **Open constraint you set earlier, carried here:** resolve the small-PDF runtime gap and keep the behavioural recovery-boundary guard before the subprocess-extraction work is called complete. EX04/EX06 are the fixtures that prove it.

### A5. Improve retrieval and evidence-pack recall (WP06)

**The risk:** a valid document can be present while its decisive passage never reaches the model prompt. Smarter models cannot fix missing input. Distinguish discovery / extraction / retrieval / scoring errors *before* changing prompts.

**What we build:** a fixed source/passage benchmark that records the **exact evidence pack shown to each scoring role**; combine lexical/semantic/structured retrieval **only as measured misses demand**; protect entity/date/source eligibility before any expansion; include table context, qualifiers and contradictory evidence when needed. Use **bounded evidence expansion on demonstrated insufficiency** (retrieve more eligible passages for the same measure, record why, avoid unlimited model calls).

**Hard constraint (this is also the rule that bounds Lane B's context trimming):** **do not shrink top-k or evidence-pack length merely for token savings.** Content dedup is allowed only when every unique decisive fact and source link remains recoverable. Recall is measured **at the actual prompt budget**.

**Tests:** RT01–RT06 (synonym/sector-language retrieves decisive passage; low-frequency/late-report/table evidence reaches model input; negative/contradictory passages not suppressed by positive-query bias; expansion recovers missing evidence without reintroducing excluded material; deterministic stable passage identity/order; trimming preserves qualifiers and negation). A better overall ranking score can never compensate for a single critical lost passage.

### A6. Strengthen framework contracts and test-drive diagnosis (WP07)

**Status:** distribution-driven rubric advice is a carried-forward concern — inspect current rules/test-drive/proposal generation before declaring it present; reuse existing framework-v2 validation/generalisation modules where correct.

**What we build:** each measure specifies construct, definition, qualifying/non-qualifying evidence, source/entity/time scope, applicability, implementation-vs-aspiration, anti-inference rules, scoring, rationale requirements and uncertainty handling. **Examples illustrate the rule; they never silently change it. Search hints are not eligibility criteria.** Test drives must **classify defects** (framework ambiguity / discovery / acquisition-extraction / entity-provenance / retrieval / scoring / technical) — a missed document triggers a *research* fix, not a looser rubric.

**Your Goodhart guardrail, made a hard rule:** a high/low Yes rate may trigger investigation but **cannot justify moving the definition toward a target distribution** (FW02). Accepted edits create a **new framework version with an impact preview** — never a silent rewrite of published scores. Reject company-specific fixes unless they are an explicit data correction rather than universal logic (Q7).

**Tests:** FW01–FW07 (missed source = discovery not definition defect; prevalence alone can't alter criteria/scores; aspirational ESG text can't satisfy an implementation-specific measure; no silent construct change; revisions help adjudicated failures without harming holdout subgroups; export/import preserves hardening fields; test-drive stays within settings/deadline envelope).

### A7. Immutable replay & dependency-aware artifacts (WP08) — shared enabler

**Why it serves both lanes:** a run manifest linking framework/measure hashes, entity/as-of scope, source content/version hashes, extraction/translation versions, retrieval/tokenizer settings, exact packs, prompts, provider/model params and code/runtime tree is what makes Lane A comparisons *reproducible* and Lane B caching/attribution *provably valid*. Reuse existing provenance fields; fill real gaps before building a parallel metadata system. Separate **fixed-corpus replay** from **fresh-research** runs; pin provider/model version where available and **record the reproducibility limit** where an alias can drift (a seed does not make a remote model deterministic).

**Tests:** RP01–RP06 (deterministic replay; framework edit invalidates score/prompt caches but not unchanged bytes; extraction update invalidates dependent passages; entity/date/policy change invalidates eligibility without cross-tenant contamination; fresh-source update distinguished from scorer change; output ties to one owning attempt + immutable snapshot).

### A8. Verify operation lifetime & resource settlement — don't rebuild (WP09)

The acute leak is **already fixed** (the `tini` PID-1 work; idle PIDs ~963→~37). The reviewer is explicit: **verify the remaining invariants, do not duplicate merged work.** Confirm effective-deadline flooring (a recovery floor must not extend an exhausted enclosing deadline), real parent/child IPC withdrawal on expiry, bounded stop+cleanup of active browser/PDF/HTML work, obsolete-work settlement before replacement for the same operation key, and that an `unattempted_cancelled` document stays incomplete/retryable (**never** conclusive absence — this is where Lane A completeness and the cancellation system intersect).

> **Your standing constraints, carried here:** do **not** invoke the quarantine-recovery override; stop on unresolved cleanup, production enablement, automatic repeats, or a Trial 2 without approval. Tests use disposable worktrees, outer watchdogs, scoped cleanup — no broad `pkill`, no prod DB URLs, no live provider keys.

**Tests:** LC01–LC06 as specified in the brief.

### A9. Publish truthful results & maintain release evidence (WP15)

Every exported/displayed assessment links to framework version, source scope/as-of, coverage state, evidence IDs and run provenance, so a reviewer can tell an *unchanged* score from one whose research became *incomplete*. Preserve immutable published snapshots; create explicit revisions; never silently recompute history. Keep candidate-review / approval / merge / deploy / validation / acceptance as **separate** records (the review found a merged release carrying embedded "feature-branch-only" text — preserve that as dated history, not current status; a commit message claiming approval is not approval). Release gates record **actual** mandatory test counts/skips, normalised TS diagnostic multiplicity, mutation sensitivity and packaging — deduped signatures can hide occurrences, so keep raw evidence too.

**Tests:** PU01–PU06 (consistent verdict/evidence/status across UI/API/CSV/Word/PDF; historical snapshot survives updates; runtime reconciles with tested tree; missing Chromium *fails* the gate rather than exit-0 skip; faulty parent-cancellation mutation fails before child exit masks it; subprocess worker assets present under actual service layout).

---

# Lane B — Speed & Cost, without degrading quality

Full detail lives in **`docs/speed-cost-improvement-plan.md`**. Summary here, with the unchanged hard rule: **exact-equivalence or validated-unchanged-or-better, always.**

- **B0 — Measure first (WP10 profiling + WP01 baseline + WP08 keys + WP13-A cost attribution).** Read-only. No behaviour change. Makes every later claim a before/after fact.
- **B1 — Exact-equivalence compute wins (WP10).** Precompile peer-scan regex once (preserving boundaries/overlaps/Unicode and the *full* 2,675-peer universe — cutting to 100 is forbidden), precompute BM25 term maps/doc-lengths under content/tokenizer keys (preserving rank/tie semantics), batch/skip no-op DB writes, bound caches. Accept only on byte-identical outputs + p50/p95 improvement.
- **B2 — Remove duplicate model/compute calls (WP13-B).** Provably identical under full dependency keys → run once. Same answer, fewer calls.
- **B3 — Discovery dedupe + bounded parallelism (WP11).** Behind a query→new-eligible-source attribution trace; honour provider quotas/backoff (no parallel storm); canonical-source-first. Fewer redundant calls, not fewer queries; essential-source recall unchanged (DQ01).
- **B4 — Layered 7-level caching (WP12).** Keyed by true dependencies, gated on A3 (eligibility recompute) + A1 (gap manifest); freshness by content hash not TTL; reason-aware negative caching; absolute tenant isolation.
- **B5 — Model cost reductions that need validation (WP13-C/D/E).** Trim *repeated* context never *decisive* context (LM04); provider prompt-cache prefixes measured on *real billing*; selective escalation only with per-measure/topic/language held-out proof and verification stages left on. No promised percentage before measurement.
- **B6 — Capacity experiments (WP14).** Classify the bottleneck, inventory every DB connection, one-variable matrix, more-replicas-at-lower-concurrency. Prod changes need approval; metric is *accepted* throughput.
- **B-durability — `tini` as permanent `ENTRYPOINT` (A5 in the efficiency plan).** Restructure the Dockerfile so the fix can't vanish if the Railway start command is cleared — gated on your confirmation the current dashboard re-run is clean.

---

# How the two lanes interlock (the shared gates)

The reviewer's **integrated acceptance protocol (GATE0–GATE6)** is adopted as the single ladder both lanes climb:

- **GATE0** confirm baseline/runtime/fixtures (no production mutation during reconnaissance).
- **GATE1** deterministic unit/boundary tests with mutation-sensitive critical guards.
- **GATE2** fixed-corpus integration across difficult entity/language/table/cancellation cases.
- **GATE3** adjudicated holdout — acceptance criteria frozen *before* seeing results; report positive/negative/subgroup outcomes, not just total accuracy.
- **GATE4** cost/speed — cold vs warm separately; include all failure/repair cost.
- **GATE5** controlled live research — separately approved roster/scope/budget/stop policy.
- **GATE6** scale ladder — 50–100, then sustained 250, then 1000, each only after the prior stage is quality-valid.

**Decision rule that encodes your two asymmetric rules:**
- A **deterministic-equivalence** change (all of Lane B's B1/B2, most of B3/B4) must produce **equivalent outputs** — any difference blocks release.
- A **semantic** change (all of Lane A, plus Lane B's B5 context/routing) requires **truth-based evaluation**: a new critical fabricated/wrong-entity/unsupported positive, or a critical lost known passage, **blocks release**. Finite-sample uncertainty is reported; zero risk is never claimed.

**Measurement definitions (WP23), adopted so a "win" can't be faked:** essential-source recall, critical-passage recall, positive precision/recall (with incomplete-research tracked separately), quote validity, **accepted** throughput, **all-in accepted** unit cost, wasted-work ratio, and latency p50/p95/max — kept in a permanent baseline table **by framework/topic/language/sector** so a global average can't hide undercoverage of small issuers or non-English reports.

---

# Suggested combined sequence

Mirrors the reviewer's recommended start order and your "measure before you tune" style. Everything is feature-branch; prod/paid/scoring steps are called out.

1. **Foundation (serves both lanes).** WP01 adjudicated pilot + holdout; WP08 replay/dependency keys; WP10 read-only profiler; WP13-A cost attribution. *No behaviour change.*
2. **Completeness & integrity first (Lane A core).** WP02 coverage/research-state accounting (additive); WP03 quote/source integrity with positive fixtures to prevent over-rejection; trace WP04 eligibility persistence through every scoring branch. *Semantic → GATE3 before rollout.*
3. **In parallel, exact-equivalence speed (Lane B).** WP10 regex/BM25/DB/cache wins behind the replay gate; WP13-B duplicate-call removal. *Equivalence → byte-identical or it doesn't ship.*
4. **Evidence reaching the scorer (Lane A).** WP05 extraction/OCR/table/translation fidelity (resolve the small-PDF gap + keep the recovery-boundary guard); WP06 retrieval recall from measured misses. *Held-out validated.*
5. **Safe reuse & discovery efficiency (Lane B, now that its guardrails exist).** WP11 discovery dedupe + bounded parallelism; WP12 layered caching (needs WP02 manifest + WP04 eligibility recompute). *Essential-source recall and warm/cold savings measured separately.*
6. **Framework robustness (Lane A).** WP07 contracts + test-drive defect classification; impact-previewed versioning, never distribution tuning.
7. **Validated model-cost reductions (Lane B).** WP13-C/D/E context trimming, prompt-cache prefixes, selective escalation. *Held-out per subgroup; verification stays on.*
8. **Capacity (Lane B).** WP14 one-variable matrix in an approved environment; accepted-throughput metric.
9. **Governance + durability.** WP15 truthful publication/release evidence; Dockerfile `tini` ENTRYPOINT restructure (gated on clean re-run).

**Expected payoff shape (not quoted as a number before measurement):** Lane A's largest trust gains come from steps 2 and 4 (no false negatives, honest quotes, decisive passages actually reaching the scorer); Lane B's largest wall-clock gains from steps 3 and 5 (stop recomputing, stop re-fetching serially, reuse valid work) and largest cost gains from steps 3 and 7 (stop re-sending duplicate/irrelevant context, route cheaply only where proven safe). Every figure is reported against the step-1 baseline before it is believed.

---

## What this plan refuses to do

**On the efficiency side — never buy speed/cost with quality:**
- Cut the peer universe (2,675 → 100) to speed the scan.
- Delete query or source families to run fewer searches.
- Shrink top-k or evidence-pack length to save tokens.
- Globally disable self-consistency, arbiter or verification to cut model calls.
- Swap to a cheaper model globally without per-subgroup held-out proof.
- Longer timeouts or bigger pools as a first move, or OCR skipping that loses content.

**On the quality side — never fake completeness/accuracy:**
- Show an incomplete run as comprehensive, or read a failed fetch as issuer non-disclosure.
- Accept a fabricated quote extension, an invented citation, or pack-wide provenance fallback.
- Let a subsidiary/supplier/similarly-named-company reference stand in for the target issuer.
- Tune a rubric toward a target Yes/No distribution, or apply company-specific score overrides disguised as universal logic.
- Silently relabel or recompute historical published scores.

Faster and cheaper where we can prove the answers are identical; more complete and more accurate where the evidence shows we were missing or misattributing something — and the same adjudicated, held-out measuring stick proves both.
