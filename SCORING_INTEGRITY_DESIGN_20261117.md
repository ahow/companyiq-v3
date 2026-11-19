# CompanyIQ v3 — Scoring-Integrity Design (the three unaddressed problem classes)

**Date:** 2026-11-17 (rev 2 — removes "abstain"; re-search-first, forced binary Y/N)
**Author:** engineering/design pass for Andy Howard
**Status:** **DESIGN FOR REVIEW — nothing here is implemented or deployed.** Sign off scope/sequencing before any code change.
**Companion docs:**
- `FRAMEWORK_STRENGTHENING_MATRIX.md` — the six mechanical gate/attribution/labelling bugs (fixed + live on prod `40a353e`).
- `DISCOVERY_MISS_DIAGNOSIS_20261115.md` — production evidence behind the "miss" phenomena.
- `FRAMEWORK_ROBUSTNESS_PLAN_20261116.md` — the **machinery** plan (W1–W8), **now implemented** (commit `0de167c`, live on prod, most workstreams default-ON — see `DEPLOYED_FLAGS.md`).

---

## 0. What changed in this revision, and what this document is

**Your instruction (1):** *no "abstain".* Every measure must resolve to **Yes or No**. When evidence is in doubt, **re-search is the priority** — not dropping the measure. This revision removes abstention entirely from the design. The score denominator is **never** reduced to hide a measure we found hard to judge; instead we **make retrieval adequate by re-searching**, then force a binary verdict.

This document is the **scoring-side complement** to the robustness plan (which handles the discovery/determinism *machinery*). It designs the scoring-layer guards that plan does not: the **retrieval-adequacy → re-search loop** (the real cure for score-tracks-retrieval), the **hard recency rule**, and grader **calibration**. For discovery it points at the already-deployed W2/W5 and the one still-open hardcoded suppressor (see §2).

| Problem class | Machinery (robustness plan, deployed) | Scoring-layer guard (THIS doc) |
|---|---|---|
| 1 — wrong zeros / discovery | W2 gate hardening, W3 readiness, W5 doc-type discovery (all live) | **Part A** — deterministic primary-document acquisition, as the re-search target |
| 2 — score ∝ retrieval volume | — | **Part B** — per-measure retrieval-adequacy → **re-search loop**, forced binary |
| 3 — run-to-run inconsistency | W1 frozen corpus, W8 variance harness (live) | **Part C** — borderline calibration & grader determinism |
| 4 — outdated sources | BUG5 date advisory (display-only) | **Part D** — hard recency rule, re-search-first |

---

## 1. The design principle (revised) — re-search first, always resolve to Y/N

Your standing rule, now the sole conflict-resolution path (abstain deleted):

> **When evidence is in doubt, re-search the corpus for a better quote. Never drop the measure, never hand-adjust the score. Every measure ends Yes or No.**

So whenever a guard detects doubt, it takes exactly one of two mechanical actions, in order:

1. **RE-SEARCH** — trigger a targeted re-discovery/re-fetch for the specific missing artefact (the declared disclosure vehicle for that measure, Part A) or a fresher source (Part D). Re-grade with the enlarged evidence.
2. **RESOLVE BINARY** — after re-search is genuinely exhausted, force the verdict:
   - evidence found → **Yes**;
   - vehicle acquired (or provably unavailable after exhaustive re-search) and no supporting evidence in it → **confident No**.

A "No" is therefore only ever recorded **after** we have done everything to find evidence. That is what makes it a *true* No rather than a retrieval artefact. The number is only ever moved by **evidence entering the grader** — never by a post-hoc adjustment and never by removing a measure from the denominator.

**Consequence for the score formula.** It stays exactly `met / answered` with **every** measure answered (`answered` = all measures; nothing excluded). We break the score↔retrieval coupling not by changing the denominator but by **guaranteeing adequate retrieval per measure before a No is allowed** — i.e. we fix the *input*, not the *arithmetic*.

---

## 2. Why "obvious" documents get missed, and the hardcoded text involved (answer to your Q2)

Grounded in the deployed code. **There is no per-company block** — nothing excludes "Michelin" or any issuer by name. But there **are three hardcoded mechanisms** that can suppress an obviously-relevant document, and one framework-configuration effect:

1. **Query-variant generator is muzzled against sustainability queries** — `server/lib/discovery.ts` L1567 & L1576, verbatim:
   > *"Generate queries that target the specific topic — do NOT default to generic sustainability/ESG queries unless the topic is explicitly about sustainability."*
   > *"IMPORTANT: … Do NOT generate generic sustainability/ESG queries unless that IS the topic."*
   For a framework whose topic is **"Physical Climate Resilience and Business Continuity"** (not literally "sustainability"), this instruction tells the variant generator **not** to search for "<company> sustainability report". So that lane never requests it. It is only reached through a *different* lane (declared `requiredDocTypes` → `buildDisclosureVehicleQueries`), which is why **declaring the doc-type on the framework matters so much.**

2. **A hardcoded aggregator denylist drops third-party-hosted copies** — `discovery.ts` L5443, `BLOCKED_AGGREGATOR_DOMAINS`: `sustainabilityreports.com`, `responsibilityreports.com`, `spglobal.com`, `morningstar.com`, `ft.com`, `bloomberg.com`, `reuters.com`, `seekingalpha.com`, etc. If the **only** surfaced copy of a sustainability report is on one of those aggregators, it is **hard-removed before the gate**. The issuer's *own-domain* copy is **not** blocked — so this bites only when discovery failed to find the issuer-hosted original and found only an aggregator mirror.

3. **The relevance gate was reject-biased on snippet alone** — `discovery.ts` L3586, *"When in doubt, REJECT rather than accept."* Judged on URL+title+snippet **before fetch**, so a generically-titled URD / annual report whose snippet didn't shout the topic got dropped. **This one is now mitigated in production:** `GATE_SPLIT_IDENTITY_TOPIC` (default-ON, confirmed live) splits strict entity-check from loosened topic-check, so a candidate matching a declared disclosure vehicle now passes on **identity alone** and defers topicality to the content stage.

**The framework-configuration effect (the real amplifier).** The Michelin/MAA/Hyundai-Glovis/Grupo misses came from **test drives on an under-configured framework (fw24: `search_templates=0, legacy=0, multi_doc=0, url_patterns=0`)**. With empty templates, discovery fell to a **thin 6-query generic fallback** *and* the variant generator was muzzled (mechanism 1) *and* reject-bias was in force (mechanism 3, pre-mitigation). The active framework (**fw25**) by contrast **declares 27 `requiredDocTypes`** including "Sustainability/ESG Report", "CDP response", "TCFD/IFRS S2 report", "20-F filing" — so with doc-type-aware discovery (W5, live) those vehicles now get **dedicated queries + a ranking boost** and are far more likely to surface.

**Net answer:** it is *partly* hardcoded text (the anti-sustainability query instruction and the aggregator denylist are the two still-active suppressors) and *mostly* the interaction of that text with an under-configured framework. The fixes: (a) **relax mechanism 1** so declared disclosure vehicles are always query-able regardless of topic wording; (b) **make mechanism 2 issuer-aware** — never drop an aggregator copy when it is the *only* copy of a declared vehicle and no issuer-hosted original was found; (c) ensure every active framework declares its vehicles (W3 readiness gate, live). These are exactly the re-search targets Part A relies on.

---

## 3. Where the score is produced (verified insertion points)

- **Company score = `Math.round((met.length / answered.length) * 100)`** — `server/routes/api.ts` L171-174 and read/export path L2142-2143. Share of answered measures graded "Yes".
- **Grading** runs at temperature 0 with `deterministicSeed` (`analyzer.ts` ~L4016); a **verdict cache** keyed on evidence fingerprint reuses prior verdicts for identical evidence (~L2341); **corpus-replay** can pin an exact corpus (`pipeline.ts`). Part C builds on these.
- **Recency today is document-selection only** — newest 10-K/annual selection (`analyzer.ts` ~L1819-1928) and stale-version hygiene (~L2291). Nothing stops an old quote in a legitimately-kept document from *satisfying* a current-practice measure. Part D closes that.
- **W5 doc-type machinery is live** — `matchesRequiredDocType` + `DOCTYPE_RESERVED_SLOTS=20` + `−30` priority boost (`discovery.ts` ~L3454, L3478). Part A extends this into a *guaranteed-acquisition* lane.

---

## Part A — Deterministic primary-document acquisition (the re-search engine)

**Fixes:** class 1, and is the RE-SEARCH mechanism for Parts B & D. **Scope:** every-framework. **Builds on:** deployed W5. **Effort:** M. **Risk:** Low-Med.

A **primary-document resolution lane**, keyed on **(issuer identity, jurisdiction, framework-declared primary doc-types)** — a *procedure*, no hardcoded per-company URLs. Resolution order per declared doc-type:

1. **Authoritative registry/filing API** (protected lanes, `PROTECTED_LANES` L216): EDGAR (10-K/20-F), ESEF/national stores (EU URD/annual), HKEX/cninfo (HK/CN), EDINET (JP), DART (KR) — query the registry for that type directly.
2. **Issuer IR/corporate domain, type-scoped** (via the existing domain-identity policy): `site:<issuer-domain> "universal registration document" | "TCFD" | "sustainability report" filetype:pdf`. First-party, strengthens the eligibility denominator.
3. **General search fallback** only if 1–2 return nothing — and here, **exempt declared vehicles from suppressors (2)** so an aggregator-only copy of a required vehicle is kept rather than denylisted.

Every step logs provenance, so a No is explainable: *"doc-type URD declared; registry lane empty; issuer-domain lane empty; general lane empty"* = an honest, diagnosable gap — and the trigger for one more re-search pass before the binary No is locked.

**This lane is what Parts B and D call when they hit doubt.** It is the concrete "re-search the corpus" action your standing rule mandates.

---

## Part B — Per-measure retrieval-adequacy → re-search loop (the core new design)

**Fixes:** class 2 (score ∝ retrieval volume). **Scope:** every-framework. **Effort:** M. **Risk:** Medium (adds re-search work; validate throughput). **Depends on:** Part A (the re-search engine), W1 frozen corpus (to validate).

### B.1 The problem
Score = `met/answered`. A "No" drags the percentage down **whether or not we had the evidence that could have produced a Yes.** Thin corpora produce more retrieval-gap Nos, so score mechanically tracks retrieval volume (≈0.4 rank corr; ExxonMobil 0→11→19→16 as corpus grew 76→125; GE stuck at 0 with 93 docs).

### B.2 The design — fix the input, not the arithmetic (no abstain)
Before a measure's grade is finalised, compute a **per-measure retrieval-adequacy** signal:
- Did we retrieve **and extract** at least one document of the **doc-type(s) this measure declares** as its evidence vehicle (and, post Part D, within the recency horizon)?

Then:

| Grader verdict | Vehicle retrieved & readable for this measure? | Action |
|---|---|---|
| Yes | (any) | **Yes** (final) |
| No | **Yes** | **Confident No** (final) — we had the vehicle, evidence genuinely absent |
| No | **No** | **RE-SEARCH** (Part A) for that measure's vehicle, then re-grade. Bounded retries. |

After the bounded re-search retries, the measure is **forced to a binary verdict**: Yes if evidence was found, **No** if the vehicle was acquired (or exhaustively proven unavailable) and still carries nothing. **No measure is ever dropped from the denominator.** The coupling breaks because a "No" can now only occur *after* adequate retrieval — so a thin corpus is **thickened by targeted re-search** until each measure's vehicle is present, rather than being scored down for a retrieval reason.

### B.3 What is surfaced (advisory only, never changes Y/N or the score)
- **Judgeable coverage** — fraction of measures whose declared vehicle was successfully retrieved (how much re-search succeeded). Display/QA only.
- **Re-search ledger** — per measure, how many re-search passes ran and what was acquired. For audit and for the variance harness.

These are **advisory** so a reviewer can *see* how hard the system had to work, but they do not alter the headline `met/answered` or any verdict. This respects "every question has an answer" — the answer is always Y/N; coverage is just metadata.

### B.4 Validation (mandatory)
On a **frozen corpus** (W1): recompute score-vs-retrieval-volume rank correlation **before/after**; success = materially lower, with the English majors' scores stabilising because their vehicles are now reliably retrieved. Confirm **confident zeros stay zero** (full vehicle retrieval + genuine absence must still yield No). Throughput guard: the re-search loop must respect the standing time/score gates — bound retries per measure and run re-search within the existing concurrency budget. Ship behind `SCORE_RETRIEVAL_RESEARCH=false` by default; enable per-framework.

---

## Part C — Borderline-measure calibration & grader determinism

**Fixes:** class 3 (run-to-run flips), the *grading* half. **Scope:** every-framework. **Effort:** M. **Risk:** Medium. **Depends on:** W1 (frozen corpus) & W8 (variance harness), both live.

Run-to-run inconsistency has two sources: **corpus changes under the grader** (handled by W1/W2/W5, deployed) and **the grader drawing the Yes/No boundary differently on identical evidence** (this part). Three mechanical additions, all at temperature 0 + `deterministicSeed`:

1. **Explicit per-measure decision criteria + anchor examples** — each measure carries a declared "what counts as Yes / No / borderline" with 1–2 anchor quotes. Removes the latitude behind the 68 flips and Iberdrola 50→36. Rubric data, authored once per framework (surfaced in the builder).
2. **Borderline tie-break via the arbiter** — when primary-grader confidence is in the declared borderline band, invoke the arbiter with the explicit criteria as a deterministic tie-break rather than letting a low-confidence verdict swing. Arbiter failures fall through **OpenRouter** (your standing fallback rule). The verdict is still binary.
3. **Evidence-fingerprint verdict reuse on by default for reruns** — identical evidence ⇒ identical verdict (cache at `analyzer.ts` ~L2341), so a flip can only come from *changed evidence* (explainable), never from grader noise.

**Measurement:** the W8 variance harness is the acceptance test — same N companies K times in frozen-corpus mode, require flip rate → ~0; then live-discovery mode for the irreducible band. `VARIANCE_MAX_FLIP_RATE` (0.05) already exists as the gate threshold.

---

## Part D — Hard recency rule (re-search-first, binary outcome)

**Fixes:** class 4 (outdated sources, SIA 2003/04). **Scope:** every-framework. **Effort:** S. **Risk:** Low. **Depends on:** Part A.

1. **Per-measure (or per-framework default) recency horizon** — declared field ("latest reporting period" / "within N years of run date"). Rubric data, no hardcoded dates.
2. **Hard gate at verdict time** — a quote whose source date is **outside the horizon cannot, on its own, satisfy** the measure. (Source date is already extracted for selection; reuse it.)
3. **Re-search before concluding** (standing rule) — when the only support is stale, **trigger Part A re-search for the latest primary** and re-grade.
4. **Forced binary outcome** — after re-search: in-horizon evidence found → **Yes**; no in-horizon evidence exists → **No** (current-practice evidence genuinely unavailable). **Never a Yes on stale evidence; never an abstain.**
5. **Date-unknown** → route to the Part C borderline arbiter (binary verdict), flagged.

This upgrades the BUG5 date *advisory* into an enforced satisfaction rule while keeping every outcome Y/N.

---

## 4. Which feedback item each part closes

| Feedback item | Closed by |
|---|---|
| Michelin URD / MAA / Hyundai Glovis TCFD / Grupo 20-F wrong zeros | **Part A** acquisition + relax suppressors (§2) + Part B re-search loop; framework must declare the vehicles (W3, live) |
| Score tracks retrieval volume (≈0.4) | **Part B** (per-measure adequacy → re-search; input fixed, arithmetic unchanged, no abstain) |
| Run-to-run flips (68 flips, Iberdrola 50→36) | **Part C** + W1 frozen corpus / W8 harness (live) |
| Outdated sources (SIA 2003/04) | **Part D** hard recency rule, re-search-first |

---

## 5. Recommended sequencing

1. **Prerequisite:** W1 frozen corpus + W8 harness — already deployed; use them to validate 2–5 below.
2. **§2 suppressor relaxations** (small, high-value): let declared disclosure vehicles be query-able regardless of topic wording (mechanism 1); make the aggregator denylist issuer-aware for declared vehicles (mechanism 2).
3. **Part D (hard recency)** — smallest self-contained guard.
4. **Part A (primary acquisition)** — the re-search engine Parts B & D call.
5. **Part B (retrieval-adequacy re-search loop)** — highest-leverage; validate correlation drop + confident-zeros preserved + throughput within gates.
6. **Part C (calibration/determinism)** — needs per-measure criteria authored; measured by W8.

Everything touching live scoring ships **behind an env flag, default off**, validated on a **frozen corpus** before production enablement — same discipline as the six strengthening fixes.

## 6. Open questions for you

- **Part B throughput:** the re-search loop does *more* work per thin company (consistent with your completeness-over-speed preference) but must stay inside the standing time gate (≤ baseline +10%) for full-universe runs. Acceptable to let per-company time rise for thin companies as long as the batch gate holds, or do you want a hard per-company re-search cap?
- **Part D horizon:** single framework-wide horizon, or per-measure horizons? (Per-measure is more correct — a governance-structure measure tolerates older evidence than a current-year-emissions measure — but needs authoring.)
- **First implementation scope:** land **§2 + D + B** first (the re-search-first core, no new determinism work), with **A** hardened alongside and **C** as a second phase?

**No code changed, nothing deployed for this design.** On sign-off I will branch per part, keep production deploys gated on your explicit go-ahead, and validate each on a frozen corpus before touching the live scoring path.
