# CompanyIQ v3 — Comprehensive Robustness Plan

**Date:** 2026-11-16
**Author:** diagnostic/engineering pass for Andy Howard
**Status:** DESIGN FOR REVIEW — nothing in here is implemented or deployed. This is the structural design to sign off before any code changes.
**Companion doc:** `DISCOVERY_MISS_DIAGNOSIS_20261115.md` (the evidence; this doc is the fix).

---

## 0. What this plan is answering

Two asks:

1. **Fix this specific analysis** — the physical-climate run where English-reporting majors (L'Oréal, GE, ExxonMobil, TotalEnergies) swung wildly or sat stuck at zero.
2. **Make the *application* rigorous so any future framework you build is robust** — i.e. stop treating each framework as a one-off and instead fix the machinery so a new framework is reliable by construction.

The diagnosis established three distinct "miss" phenomena: **(A)** non-English extraction misses (grader can't read CJK corpora), **(B)** run-to-run discovery non-determinism (score tracks corpus size/composition, not language — this is what hit the English majors), and **(C)** stalled/aborted batches scoring zero. This plan addresses all three and then generalises each fix into a framework-grade guarantee.

I traced the actual execution paths before proposing anything (per your standing preference). Every proposal below cites the code it changes. The plan is organised as **eight workstreams**, each marked with what it fixes (A/B/C) and whether it is *this-analysis* or *every-framework*.

---

## 1. The root causes, grounded in code

Before the fixes, the precise mechanisms. These are the levers everything else hangs off.

### 1.1 Corpus is a growing *union*, not a fixed set (the main driver of B)

`server/lib/pipeline.ts` (~L2510, "DOCUMENT POOL (P3a)"): at analyze time, when there is no pinned snapshot, scoring reads **the union of (i) every `fetch_status='ok'` document ever collected for the company and (ii) this run's fresh discovery.** Each run writes its newly-discovered docs to the `documents` table, so the *next* run's union is strictly larger.

This is exactly what the test runs showed: ExxonMobil's corpus grew 76 → 110 → 116 → 125 docs across the four re-runs, and its score climbed 0 → 11 → 19 → 16 as qualifying English evidence finally entered the pool. The score wasn't noisy for mysterious reasons — **the input literally changed under it every run.** That is the core of phenomenon B, and it is structural, not a bug.

### 1.2 The reproducibility primitive already exists but isn't used for development

Same file (~L2521): when `sourceBatchId` is set, the pipeline enters **CORPUS REPLAY MODE** — it reads *exactly* the `batch_corpus` snapshot of the source batch, in stable `ORDER BY d.id`, and **refuses to fall back to live documents** (deterministic failure on a missing snapshot). Scoring itself is already deterministic (temperature 0 + `deterministicSeed`, analyzer L4016).

So "score the identical corpus twice and get the identical answer" is *already possible*. It just isn't surfaced as a framework-development workflow. This is the single biggest lever and most of the work is wiring, not new machinery.

### 1.3 The relevance gate is reject-biased, snippet-only, and fails closed (a second driver of B, and a silent recall tax on every framework)

`server/lib/discovery.ts`, `runRelevanceGate` (L3453). Every non-protected candidate is classified accept/reject by an LLM **on URL + title + snippet only — before the document is fetched.** Four problems:

- **Reject-biased by instruction:** the system prompt says *"When in doubt, REJECT rather than accept — false positives are more harmful than false negatives."* For diffuse-evidence topics (physical climate), the qualifying content lives *inside* generically-titled docs (a 10-K whose Item 1A has the climate-risk passage; an annual report with one resilience paragraph). The snippet looks generic → the gate rejects it. This is the same failure mode the code comments already acknowledge for `evidence_keywords` vs disclosure-vehicle titles.
- **Fails closed:** on two consecutive LLM errors the **entire batch of 20 candidates is dropped** (L3530-ish). Under Serper/deepseek load this silently removes real documents, and it does so *differently every run* → variance.
- **Judged pre-fetch on snippet:** topic relevance is decided without the document body, so it penalises exactly the diffuse disclosures physical-climate scoring depends on.
- **Non-deterministic in practice:** temperature is 0 (good) but no `seed` is passed, and — more importantly — the candidate set feeding it varies run-to-run (live Serper), so even a deterministic gate yields different accept sets.

Note what's *protected*: `PROTECTED_LANES` (L216) — registry-search, EDGAR submissions, ESEF/HKEX/cninfo APIs, pinned — **bypass the gate**. So a US 10-K via EDGAR survives, but a project microsite page (Exxon's Hebron platform), a press release, or a CDP PDF coming through a general lane is gate-judged on its snippet and can be dropped.

### 1.4 Under-configured frameworks silently fall back to thin generic queries (the fw24 problem; a latent trap for every new framework)

`server/lib/discovery.ts`, `buildGeneralQueries` (L1611). Query construction is layered: **Layer 1** `searchTemplates`, **Layer 2** `legacyQueryTemplates`, **Layer 3** `requiredDocTypes` → `buildDisclosureVehicleQueries`. When Layer 2 is empty the code drops to a **six-query generic fallback** (L1640): `"{company}" {topicWords}`, `… annual report`, `… governance`, `… policy framework`, `… corporate responsibility report`. That's it.

Production field counts confirm the draft physical-climate framework (fw24) is in exactly this state: `searchTemplates=0, legacyQueryTemplates=0, multiDoc=0, urlPatterns=0` — it runs almost entirely on the generic fallback, so its discovery is both thin *and* maximally exposed to the non-determinism in 1.3. The v2 builder never populated these fields, and **nothing prevents activating a framework in this state.** Every future framework you build inherits this trap unless the machinery changes.

### 1.5 No multilingual extraction (phenomenon A — separate cohort)

For mature fw21, the dominant zero-cohort (387 of 2,339 scored) is CJK reporters with thick corpora (median 53 docs) and blank rationales — docs found, grader can't read them. Ganfeng Lithium: 82 docs, all "No", blank rationales; Aier Eye scored 70 off an English HKEX filing. This doesn't touch the English majors but is part of a *comprehensive* fix.

### 1.6 Variance was never measured (why fw21 "looked fine")

AI Management ran as one-shot large batches; the physical-climate test deliberately re-ran ~50 companies four times — the only design that exposes 1.1/1.3. fw21 is structurally more robust (AI evidence is binary-clean and concentrated) but we have no number for its variance because we never ran the repeat design against it.

---

## 2. The plan — eight workstreams

Priority order is top-down: the earlier ones are higher-leverage and several later ones depend on them. Each lists **Fixes** (A/B/C), **Scope** (this-analysis vs every-framework), **Change**, **Where**, **Effort**, **Risk**.

### Workstream 1 — Frozen-corpus framework development (discover-once → score-many)
- **Fixes:** B (eliminates it during development) · **Scope:** every-framework · **Effort:** M · **Risk:** Low

**Change.** Make corpus replay a first-class development workflow. A framework author does one *discovery* batch over the test list, which snapshots the corpus (`batch_corpus`). Every subsequent scoring run while iterating the rubric sets `sourceBatchId` to that batch, so it replays the **identical** corpus. Because scoring is already deterministic, rubric edits now show *rubric* effects with zero corpus noise. Add a "re-discover corpus" action for when the author deliberately wants a fresh pull.

**Where.** The pipeline path exists (`pipeline.ts` replay branch L2521). Work is: (a) a UI/control in the framework builder to "lock corpus from batch N / re-score", (b) persist the chosen `sourceBatchId` on the framework draft, (c) surface corpus hash + doc count so the author sees it's frozen.

**Why it's the keystone.** Until the corpus is held constant, *no* rubric change can be evaluated honestly, and every robustness metric (Workstream 8) is contaminated. This is the prerequisite for rigorous framework work.

### Workstream 2 — Relevance-gate hardening
- **Fixes:** B (big), A (minor) · **Scope:** every-framework · **Effort:** M · **Risk:** Medium (precision/recall trade — must be measured)

Four sub-changes to `runRelevanceGate` / its call site (`discovery.ts` L3453, L5478):

1. **Fail *open*, not closed.** On persistent LLM error, **keep** the batch and defer the decision to the post-fetch aboutness scorer (which reads real content) instead of dropping 20 candidates blind. Removes a large, invisible, run-varying recall loss.
2. **Split entity-disambiguation from topic-relevance.** Keep the strict "is this the right company?" check (this is what stops wrong-company pollution and must stay aggressive). *Loosen* the "is this on-topic?" check at the snippet stage — for candidates matching a declared `requiredDocType` (annual report, 10-K, sustainability/TCFD/CDP report), **accept on identity alone and let content-stage retrieval decide topicality.** This directly stops the gate throwing away diffuse-evidence disclosures.
3. **Add `seed`** to the gate call for within-input determinism (cheap, strictly positive).
4. **Protect declared disclosure vehicles.** Treat a strong `requiredDocType` title match like a semi-protected lane: it bypasses topic-reject (still subject to entity-reject). Generalises: any framework that declares its vehicles gets reliable delivery of them.

**Risk control.** This trades precision for recall. Validate on a frozen corpus (Workstream 1): measure corpus size, duplicate/off-topic rate, and score deltas on a labelled sample before/after. Ship behind an env flag (`GATE_FAILOPEN`, `GATE_SPLIT_IDENTITY_TOPIC`) so it's reversible.

### Workstream 3 — Framework readiness gate (preflight) + v2-builder field population
- **Fixes:** B (removes the fw24 generic-fallback trap) · **Scope:** every-framework · **Effort:** M · **Risk:** Low

**Change.** Two parts:
1. **Preflight / readiness score.** Before a framework can be *activated* (or before a full-universe run), compute a completeness score over its query-driving fields (`searchTemplates`, `legacyQueryTemplates`, `requiredDocTypes`, `multiDoc`, `urlPatterns`, `authoritativeRegistries/FilingTypes`). Block activation (or require explicit override) when it would fall to the six-query generic fallback. This is the structural guarantee that *no future framework ships under-configured.*
2. **Fix the v2 builder to populate the fields.** The builder should derive `requiredDocTypes` and `legacyQueryTemplates` from the per-measure `disclosureVehicles` the author already enters — the exact inputs `buildDisclosureVehicleQueries` (L1721) is designed to consume. Right now that linkage is missing, which is why fw24 is empty.

**Where.** Builder/save path + a `frameworkReadiness()` helper; surfaced in the Frameworks list and on Activate.

### Workstream 4 — Backfill the current physical-climate framework
- **Fixes:** B, this run specifically · **Scope:** this-analysis · **Effort:** S · **Risk:** Low
- **Depends on:** Workstream 3 part 2 (or do it manually from the uploaded spec)

**Change.** Populate fw24's `legacyQueryTemplates`, `requiredDocTypes` (CDP climate response, TCFD/ISSB report, 10-K/20-F Item 1A risk factors, annual report risk section, business-continuity/resilience disclosures), `searchTemplates`, and `authoritativeFilingTypes` from the physical-climate spec you uploaded. This immediately thickens and stabilises discovery for this framework. Use the existing `build_fw22_v31.py` import pattern (`companyiq_fw22_v3.1_import.json`) as the template.

### Workstream 5 — Doc-type-aware discovery for diffuse-evidence topics
- **Fixes:** B (composition misses like GE/L'Oréal stuck at 0) · **Scope:** every-framework · **Effort:** M · **Risk:** Low-Medium

**Change.** For topics whose evidence is diffuse, raw recall isn't enough — the *right* vehicle has to surface. Add per-framework **doc-type priorities**: declared vehicles get dedicated query templates *and* a ranking boost so they survive the pre-gate cap (`PRE_GATE_CAP=180`, L65) and near-dup collapse. For physical climate: guarantee at least one query each for CDP, TCFD/ISSB, and the latest 10-K/20-F risk section per company. This is what moves GE (93 docs, stuck at 0) and L'Oréal (59 docs, stuck at 0) — their qualifying disclosure exists but never wins a slot. Generalises via the same `requiredDocTypes` + authority-boost mechanism.

### Workstream 6 — Multilingual extraction / grading
- **Fixes:** A (the dominant fw21 zero-cohort) · **Scope:** every-framework · **Effort:** L · **Risk:** Medium

**Change.** Add a language-aware path so CJK (and other non-English) corpora actually score: detect document language at extraction, and either (a) translate retrieved evidence passages to English before grading, or (b) grade in-language with a multilingual model. Lowest-risk first cut: translate only the *retrieved evidence passages* (not whole corpora) at scoring time — bounded cost, surgical. This is independent of the English-majors issue and can proceed in parallel. Validate on the known cases (Ganfeng, the 162 CN zeros).

### Workstream 7 — Operational guardrails: stalled-batch detection & auto-requeue
- **Fixes:** C · **Scope:** every-framework · **Effort:** S · **Risk:** Low

**Change.** A batch where companies complete with zero documents retrieved (result 864: 573 companies, avg 0, zero docs each) should be *detected and requeued*, not saved as zeros. Add a post-company check: `researchStatus=unresolved_gaps` + `coverage.denominator=0` across a run → flag + auto-retry rather than persist a false zero. Prevents stalls from polluting saved results and skewing averages.

### Workstream 8 — Variance harness (make robustness measurable)
- **Fixes:** the meta-problem (we couldn't see B until we re-ran) · **Scope:** every-framework · **Effort:** M · **Risk:** Low
- **Depends on:** Workstream 1 (to separate corpus variance from rubric variance)

**Change.** A built-in "framework variance report": run the same N companies K times and report, per measure and per company, **flip rate** (No↔Yes across runs), **score stddev**, and **corpus-size variance**. Run it in two modes — *frozen corpus* (isolates rubric/grader determinism) and *live discovery* (measures real-world end-to-end variance). Make a variance threshold part of the readiness gate (Workstream 3) so a framework can't be activated until its variance is known and acceptable. This is the concrete answer to "I want future frameworks to be robust and rigorous" — it turns robustness into a number you gate on, and it's the test we never ran against fw21.

---

## 3. Which workstreams fix what

| Phenomenon | Primary fix | Supporting |
|---|---|---|
| **A** — non-English extraction misses | W6 multilingual grading | — |
| **B** — run-to-run non-determinism (the English majors) | W1 frozen corpus (dev) · W2 gate hardening (prod) | W3, W4, W5 |
| **C** — stalled batches scoring zero | W7 stalled-batch requeue | — |
| **Meta** — robustness unmeasured | W8 variance harness | W1 |

**Important honesty check on the English majors specifically:** W1 makes them *reproducible during framework development* (same corpus → same score). It does **not** by itself make a live full-universe production run deterministic — that's W2 + W5 (stop the gate dropping qualifying docs; reliably surface the right vehicles) plus W4 (don't run on the generic fallback). In production you will never get bit-identical runs while discovery uses live Serper, but W2/W4/W5 narrow the band from "0 → 30" down to small, and W1/W8 let you *prove* how small before you trust a framework.

---

## 4. Recommended sequencing

1. **W1 (frozen corpus)** + **W8 (variance harness)** first — together they give you the instrument to evaluate everything else. Without them, every later change is judged on shifting sand.
2. **W3 (readiness gate + builder fix)** then **W4 (backfill fw24)** — stops new frameworks shipping thin; fixes the one in front of you.
3. **W2 (gate hardening)** and **W5 (doc-type-aware discovery)** — the two production-recall fixes for the English majors; validate each on the frozen corpus from W1.
4. **W6 (multilingual)** and **W7 (stalled-batch)** — parallelisable, independent of the above.

Everything ships behind env flags where it touches production scoring, so each step is reversible and measurable in isolation.

---

## 5. What I did NOT change

No code was modified and nothing was deployed for this plan. The only outstanding local diff in the repo remains the earlier registry-coercion commit (held, unpushed, unapproved) — unrelated to this work. Awaiting your sign-off on scope/sequencing before implementing any workstream. When you approve, I'll branch per workstream, keep production deploys gated on your explicit go-ahead, and validate on a frozen corpus before touching the live scoring path.
