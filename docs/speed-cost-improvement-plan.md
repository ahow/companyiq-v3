# CompanyIQ v3 — Speed & Cost Improvement Plan

**Date:** 14 October 2026
**Author:** Agent, for Andy Howard
**Status:** PLAN ONLY. No code, production, budget or run changes have been made. Everything below is proposed work for the feature branch; anything touching production, paid runs, migrations or scoring needs separate approval.

---

## The one rule this plan obeys

You asked for two things, under one hard condition:

1. Make the analysis run **faster**.
2. Make it **cheaper**.
3. With **zero** reduction or change to completeness or accuracy.

So the governing principle for every item here is simple to state:

> **We only ship a change once we can prove it produces the same answers (or provably better ones), on the same evidence, for the same companies.** We never buy speed or savings by quietly doing less research, looking at fewer sources, skipping verification, or shrinking what the model sees.

That principle is not mine alone — it is also the reviewer's own "quality rule" and matches how you work: measure the real bottleneck first, prefer changes that are *exactly equivalent* to what we do today, and only accept a change that alters behaviour after it has been validated against held-out, adjudicated cases. Nothing here is a guess at a config knob.

**The simple explanation:** today the pipeline is slow and costs money mostly because it **repeats work it has already done** — the same searches, the same text-crunching, the same big chunks of context sent to the model over and over. The fastest, safest wins come from *not repeating identical work*, not from doing less work. That is the spine of this whole plan.

---

## Where the time and money actually go (the evidence)

Before proposing anything, here is what we already know from the code and from the prior investigations the reviewer cites. These are the facts the plan is built on:

- **One company's "preparation" step took 446 seconds in production but only ~10.8 seconds when replayed on already-saved data** (the AXA case, from `TIMEOUT_INVESTIGATION`). That ~40x gap is the single loudest signal that we are recomputing or re-fetching things we could reuse. (Reviewer WP10.)
- **Some companies fire ~210–234 searches, run one after another.** That is a lot of serial waiting, and many of those queries are near-duplicates that find nothing new. (Reviewer WP11.)
- **Model cost was ~\$0.405 per company, and \$3.67 of the \$4.05 was *input* tokens.** In plain terms: we are paying mostly to *send context into* the model, not to get answers out. That points straight at repeated/duplicated context as the thing to measure and cut. (Reviewer WP13.)
- **The recent reliability fix already landed.** The worker was hitting the Linux process/thread ceiling (PID exhaustion) and dying; putting `tini` back as PID 1 dropped it from 963/1000 processes to ~37/1000, and your current re-run shows "none [failed] so far." That is why the pipeline is now *reliable but slow* — we fixed the crashing; we have not yet made it fast. Speed is this plan's job.

So the three big levers are: **stop re-fetching** (discovery), **stop re-computing** (preparation/caching), and **stop re-sending** (model context). All three can be done without changing a single answer.

---

# Part A — Speed plan

Ordered so that the safest, provably-equivalent wins come first, and nothing is tuned before it is measured.

### A0. Measure before touching anything (prerequisite, ~fast)

We cannot claim "faster with no quality loss" unless we can *see* both. Two cheap, additive things first:

- **Per-stage profiling on a saved corpus** — time `updateCompany`, CIK resolution, peer loading, aboutness scan, provenance, BM25, and DB writes *separately*, at one worker and at the real parallelism. Run against saved data so we separate "slow compute" from "waiting on the network/DB." This is reviewer **WP10's** measurement step and it is a read-only profiling harness — no behaviour change.
- **A small adjudicated baseline set** (reviewer **WP01**) — a handful of companies/measures with known-correct answers, so that after any optimisation we can confirm the answers are byte-identical (for equivalence changes) or unchanged-or-better (for semantic ones). This is the guardrail that makes the whole "no accuracy loss" promise checkable rather than assertable.

*Why first:* without these, every later item is an unprovable claim. With them, each item becomes a before/after fact.

### A1. Stop re-computing in the preparation stage — exact-equivalence optimisations (biggest, safest win)

This is reviewer **WP10**, and it is the top of the plan because it is where the 446s-vs-10.8s gap lives and because every change here is *deterministically equivalent* — same inputs, same outputs, just less wasted CPU.

- **Precompile the peer-scan patterns once.** The "aboutness" peer scan appears to rebuild/escape regex patterns and re-normalise text repeatedly across ~2,675 peers. Compile the escaped patterns once, reuse the normalised text, and (if profiling confirms peer scans dominate) use a single equivalence-tested multi-pattern matcher instead of N separate passes. **Constraint, stated explicitly:** this must preserve word boundaries, overlaps, Unicode/case behaviour, and the *full* peer universe. Cutting 2,675 peers to 100 is **not** allowed — that is a coverage cut, not a speed optimisation.
- **Precompute BM25 term maps and document lengths once, under content/tokenizer keys.** Today BM25 appears to redo term-frequency work; compute per-document term maps and lengths once and cache them keyed by `(content hash, tokenizer/config)`, so they are reused until the document or tokenizer actually changes. Preserve ranking and tie-break semantics exactly (or validate any difference against critical-passage recall before accepting).
- **Batch DB writes and skip no-op writes.** If profiling shows DB round-trips dominate, batch equivalent updates and omit writes that change nothing, under ownership guards. Same data ends up in the DB; fewer round-trips.
- **Bound caches / drop duplicate in-memory corpus copies.** If memory pressure (and the GC pauses it causes) dominates, remove duplicate corpus copies and bound caches. Lower memory → less GC stalling → faster, with identical outputs.

*Acceptance for every A1 item:* deterministic before/after outputs on the saved corpus (or an explicitly-intended, validated improvement), with p50/p95 CPU/wall/memory shown. We return the measured dominant path and the smallest fix for it — not a speculative rewrite.

### A2. Stop re-fetching in discovery — dedupe and bounded parallelism (speed + cost)

This is reviewer **WP11**. The ~210–234 serial searches are the target, but the rule is strict: **fewer redundant calls, not fewer queries.**

- **First, build a query→new-eligible-source attribution trace.** Before we call anything "redundant," we measure which queries actually produced a new eligible source and which produced nothing new. This makes dedupe *measurable* rather than a guess, and it is the safety gate the reviewer insists on.
- **Deduplicate semantically/effectively identical queries** using query/config/time-aware keys, so the same search is not issued twice within a run.
- **Run independent searches in bounded parallel instead of strictly serial** — but honouring real provider rate/token/request quotas and backoff. This is the single biggest *wall-clock* win in discovery: the work is the same, it just stops waiting in single file. (This respects your known preference for staying under learned provider ceilings — no parallel storm.)
- **Try canonical/official issuer & regulatory copies before expensive browser fallback,** when version-equivalence is verified. Launching a full browser is the expensive path; if a direct canonical copy of the *same* document exists, use it.

*Constraint, stated explicitly:* this is not permission to delete query families, skip measures because early evidence looked positive, or let a prior "no result" cache permanently suppress a later-available source. Known-essential-source recall must be unchanged across countries/languages (test DQ01).

### A3. Reuse valid work safely across retries and frameworks — layered caching (speed + cost)

This is reviewer **WP12**, and it is what turns the 446s back into something near the 10.8s replay for real runs, not just replays. The key idea is a **7-layer cache where each layer is keyed by its true dependencies**, so we reuse exactly what is still valid and recompute exactly what changed:

1. raw source bytes (by content/version hash)
2. extraction (by bytes + engine/config)
3. OCR/translation (by span + language + engine/version)
4. chunks/index/term maps (by extraction + tokenizer/config)
5. eligibility (by entity/date/source policy)
6. evidence packs (by corpus + measure + retrieval config)
7. scores (by exact pack + framework/prompt/model)

Lower layers (bytes, extraction) are the easiest to reuse safely and give most of the benefit. A changed framework, for example, reuses unchanged *documents* but correctly recomputes eligibility/retrieval/scoring.

*Constraints, stated explicitly (these are what make caching safe, not reckless):*
- Never reuse a "complete-looking but actually incomplete" corpus without its gap manifest.
- Freshness is decided by **content hash**, not a TTL timer alone (a report can change at the same URL).
- Error/"no result" caching gets a short, explicit, reason-aware policy — it must not permanently hide a source that later appears.
- Tenant/access isolation is absolute — private material must never leak through a public cache path.

*Dependency:* A3 is safest once replay keys (WP08) and eligibility recomputation (WP04) exist, because those are what let us *prove* a cached layer is still valid for the new target. So A3 lands after those enablers, not before.

### A4. Capacity and scheduling — only after the bottleneck is named (throughput)

This is reviewer **WP14**. Crucially, it comes *after* A1–A3, because raising capacity before removing wasted work just scales the waste.

- **Classify the bottleneck first:** is a stage waiting on acquisition, on slow SQL/locks, on CPU starvation, on a provider quota, or on a browser lane being held? Each has a different fix; we measure per-stage wait vs service time before changing anything.
- **Inventory every DB connection** (parent/child/app/diagnostic) before touching pool sizes — the reviewer's `3×(20+2)+22 = 88 vs 97 usable` example is exactly why naively raising a pool can *break* things. Measure the real topology; don't assume.
- **Prefer more replicas at lower per-replica concurrency** over cranking one big worker — this matches how you already think about horizontal scaling, and keeps each replica individually stable (and inside the PID ceiling we just rescued).
- **Run a one-variable-at-a-time capacity matrix in an approved environment** (baseline → lower per-replica competition → more replicas at lower concurrency → CPU/mem ceiling only if actually constrained), recomputing DB and account-wide search/LLM quotas each time.

*Constraint, stated explicitly:* production capacity changes need your approval; "resource maxima" on Railway are not dedicated reservations; and we measure **accepted throughput** (completed *and* quality-passing), never "claimed jobs."

### A5. Make the reliability fix permanent (durability, not speed — small, recommended)

Not a speed win, but it protects every speed win above: the `tini` PID-1 fix currently lives in the Railway **service start command**, which overrides the Docker `ENTRYPOINT`. If that start command is ever cleared or a service is recreated, the fix silently vanishes and the slow/crashing behaviour returns. The durable fix is to restructure the `Dockerfile` so `tini` is the permanent `ENTRYPOINT` and `node` is the `CMD`, then drop the custom start command. **This is gated on your confirmation that the current re-run is clean** — you mentioned restructuring the Dockerfile once it's proven, so I've left it here as the natural follow-up rather than doing it now.

---

# Part B — Cost plan

The reviewer's **WP13** gives the correct order, and I'm keeping it, because the first two steps are *exactly-equivalent* (zero risk to answers) and the measurement from step A makes the rest honest. Note that **A2/A3 above already cut cost too** (fewer search/proxy calls, fewer browser launches, fewer recomputations) — so Part B is specifically about *model* cost.

### B1. Attribute cost first (safe, do before any routing change)

Tag every model call with request/run/attempt/measure/role/provider/model IDs and prompt/output/cache token counts, latency, retries, and known/unknown price — and reconcile against the invoice. **Dropped events and unknown prices stay visible** (we don't invent zeros). Until we can see *which role on which measure* spends the \$3.67 of input tokens, every saving is a guess. This changes no behaviour; it just makes cost legible.

### B2. Remove duplicate identical model calls (safe, exactly-equivalent)

With full dependency keys from B1, find calls that are provably identical — same prompt, same model, same context, same measure — and make them once. Same answer, fewer calls. This is the model-cost twin of A3's caching.

### B3. Reduce *repeated* context, never *decisive* context (needs validation)

The \$3.67 input-token signal says we are re-sending the same context repeatedly. Trim the **irrelevant repeated** material while **preserving every decisive passage, qualifier, contradiction and citation** — and prefer sending traceable excerpts over lossy summaries. This one changes what the model sees, so it must pass the adjudicated + held-out check (test LM04: a summary must never drop a negative or turn into a fabricated quote) before it ships. **Hard constraint from reviewer WP06:** we do **not** shrink top-k or evidence-pack length merely to save tokens — recall at the actual prompt budget must be unchanged.

### B4. Provider prompt-cache-compatible stable prefixes (needs real billing measurement)

Many providers bill cached prompt prefixes cheaper. Structuring prompts with stable prefixes (while preserving tenant boundaries and the actual scoring context) can cut input cost materially. But cache discounts are provider/account/version dependent, so this is accepted only after measuring **real billing**, not theoretical token counts.

### B5. Selective escalation / cheaper first pass (needs held-out validation — last, most carefully)

A cheaper first-pass model with escalation to the strong model on uncertainty/contradiction/rare constructs/failed integrity checks *can* save money — but only if validated on a held-out analyst corpus, per measure/topic/language. **Non-negotiable guardrails (reviewer WP13):**
- Do **not** globally switch off self-consistency, arbiter, or verification to cut event counts.
- Measure the marginal error each stage *catches* and the misses any routing *creates*.
- If any hard-quality subgroup (a language, a sector, rare constructs) degrades, keep the strong processing for that group or reject the change.
- A new topic/framework/language starts **unproven** — it does not inherit a cheap route proven elsewhere.
- **No promised percentage saving is quoted before it is measured.**

---

# Part C — The reviewer's brief, reviewed part by part

You asked me to go through each of the reviewer's proposals and either incorporate it or explain why it isn't helpful *for your specific ask* (faster + cheaper, no quality change). Here is every work package.

Three verdicts are used:
- **INCORPORATED** — it is a genuine speed and/or cost lever that preserves completeness & accuracy; it is in Part A or B above.
- **GUARDRAIL / ENABLER** — it is not itself a speed/cost win, but a speed/cost change above *depends on it* or would be *unsafe without it*. Kept for that reason.
- **OUT OF SCOPE (quality work)** — it is a completeness/accuracy *improvement*. Valuable, and the reviewer is right to propose it, but it is **not** a speed/cost item, so it is outside what you asked for here. (Flagged, not dismissed.)

| WP | Title | Verdict | Why |
|----|-------|---------|-----|
| **WP01** | Independent quality baseline | **ENABLER** | Not a speed win, but it is the measuring stick that lets us *prove* a speed/cost change didn't move the answers. It's step A0. Without it, "no accuracy loss" is an assertion, not a fact. |
| **WP02** | Coverage manifest / research state | **GUARDRAIL** | A completeness-integrity feature (stops a failed fetch being read as "company disclosed nothing"). Not speed/cost itself, but it's the gap-manifest that makes cache reuse (A3) and discovery dedupe (A2) safe. |
| **WP03** | Quote integrity / stable citations | **OUT OF SCOPE (quality work)** | Accuracy improvement (stops fabricated/misattributed quotes). Doesn't make the run faster or cheaper; it changes acceptance behaviour. Worth doing — just not under this ask. |
| **WP04** | Entity/provenance/time enforcement | **GUARDRAIL / ENABLER** | Primarily accuracy. But it's a *prerequisite* for safe cross-entity cache reuse (A3): we can only reuse shared source bytes across companies if eligibility is recomputed per target. So it enables a cost/speed win. |
| **WP05** | Extraction/table/OCR/translation fidelity | **MOSTLY OUT OF SCOPE; one conditional speed item** | Mostly accuracy/completeness. **Exception:** "use OCR adaptively on pages that need it, not indiscriminately" *is* a legitimate speed win — if and only if it provably loses no content (test EX02). I've noted it as a conditional A1-adjacent candidate, gated on the fidelity tests. |
| **WP06** | Retrieval / evidence-pack recall | **GUARDRAIL (constrains B3)** | An accuracy improvement, so out of scope as a win — but it carries the hard constraint that bounds Part B: *"Do not shrink top-k or pack length merely for token savings."* It is the rule that keeps B3 honest. |
| **WP07** | Framework contracts / test-drive | **OUT OF SCOPE (quality work)** | Accuracy/generalisation of the measures themselves. No speed/cost effect. |
| **WP08** | Immutable replay & dependency keys | **ENABLER** | Reproducibility infrastructure. Not a win by itself, but it is what makes both safe caching (A3) and trustworthy cost attribution (B1) *possible and provable*. Lands early as plumbing. |
| **WP09** | Cancellation / resource settlement | **PARTIALLY INCORPORATED (verify, don't rebuild)** | The acute resource leak is already fixed (the tini PID-1 work). The reviewer rightly says *verify the remaining invariants, don't duplicate merged work.* Speed relevance: promptly stopping obsolete work frees capacity for useful work. So: verify, don't rebuild. |
| **WP10** | Profile preparation & optimise equivalent computation | **INCORPORATED — core speed (A1)** | This is the heart of Part A. Deterministic-equivalence optimisations (regex precompile, BM25 term-map precompute, DB write batching, cache bounding). Same answers, far less wasted CPU. Directly targets the 446s gap. |
| **WP11** | Discovery / acquisition efficiency | **INCORPORATED — core speed + cost (A2)** | Dedupe identical queries, bounded parallel search, canonical-source-first. Fewer redundant calls and less serial waiting, with unchanged source recall. |
| **WP12** | Caching / checkpoint reuse | **INCORPORATED — core speed + cost (A3)** | The 7-layer dependency-keyed cache. The single biggest lever for turning real runs toward replay speed, with strict freshness/isolation guardrails. |
| **WP13** | LLM cost without regression | **INCORPORATED — core cost (B1–B5)** | Adopted wholesale as Part B, in the reviewer's own A→E order. A/B/D are safe-equivalent; C/E need held-out validation. |
| **WP14** | Scheduling / DB / Railway capacity | **INCORPORATED — throughput (A4)** | Bottleneck-classify first, inventory connections, one-variable matrix, more-replicas-at-lower-concurrency. Prod changes need approval. |
| **WP15** | Publish truthful results / release evidence | **OUT OF SCOPE (governance/audit)** | Audit-trail and publication integrity. Important for trust; no effect on run speed or cost. |
| **§21** | Shared design sketches | **REFERENCE** | Illustrative field lists, explicitly "not a mandated schema rewrite." We add only the fields a chosen WP needs (e.g. content hash for A3), not a new data architecture. |
| **§22** | Integrated acceptance protocol (GATE0–6) | **ADOPTED AS THE TEST LADDER** | This is how we *prove* each change is non-regressive: deterministic-equivalence outputs for A1-type changes; truth-based holdout evaluation for B3/B5-type changes. Mirrored in the sequencing below. |
| **§23** | Measurement definitions | **ADOPTED** | We report **accepted throughput**, **all-in accepted unit cost**, **wasted-work ratio**, and latency p50/p95/max — so a "win" can't be faked by completing junk cheaply. |
| **§24** | Autonomous execution rules | **ADOPTED (process)** | Feature-branch envelope, smallest-remedy-per-WP, no prod URLs/keys in tests, preserve evidence on failure. Matches your standing constraints. |
| **§25** | Recommended starting sequence | **ADOPTED** | Its explicit warning — *do not* start with a global provider downgrade, longer timeouts, bigger pools, smaller packs, fewer source families, or disabled verification — is exactly your filter. Our sequencing follows it. |

---

# Suggested sequence (safe order of execution)

This mirrors the reviewer's GATE0–GATE6 and your "measure before tune" style. Each step is on the feature branch; prod/paid steps are called out.

1. **Measure & enable (A0 + WP08 + B1).** Stand up the per-stage profiler, the small adjudicated baseline, replay/dependency keys, and model-cost attribution. *No behaviour change. This is what makes every later claim provable.*
2. **Exact-equivalence speed wins (A1 / WP10).** Precompile peer-scan patterns, precompute BM25 term maps, batch/skip DB writes, bound caches. *Accept only on byte-identical outputs + p50/p95 improvement.*
3. **Remove duplicate model calls (B2).** Exactly-equivalent, keyed by B1's attribution.
4. **Discovery dedupe + bounded parallelism (A2 / WP11)** behind the query→new-source attribution trace. *Accept only on unchanged essential-source recall.*
5. **Layered caching (A3 / WP12)** once WP04 eligibility recompute and WP02 gap manifest are in place. *Warm-run savings measured separately from cold; every hit carries freshness/isolation evidence.*
6. **Context trimming + prompt-cache (B3 / B4).** *Validate on held-out + adversarial cases; real billing for B4. WP06 recall constraint enforced.*
7. **Selective escalation (B5).** *Held-out validation per measure/topic/language; verification stages stay on; no subgroup regression.*
8. **Capacity experiments (A4 / WP14).** *Approved environment, one variable at a time, accepted-throughput metric.*
9. **Durability follow-up (A5).** *Dockerfile `tini` ENTRYPOINT restructure — gated on your confirmation the current re-run is clean.*

**Expected shape of the payoff** (deliberately not quoted as a single percentage, because the reviewer and you both reject promised numbers before measurement): the largest *wall-clock* gains come from steps 2, 4 and 5 (stop recomputing, stop re-fetching serially, stop redoing valid work); the largest *cost* gains come from steps 3, 6 and 7 (stop sending duplicate/irrelevant context, then route cheaply only where proven safe). Every number gets reported against the step 1 baseline before it's believed.

---

## What this plan deliberately does **not** do

To be explicit about your filter — these are the "faster/cheaper" shortcuts the plan **refuses**, because each one trades away completeness or accuracy:

- Cutting the peer universe (2,675 → 100) to speed up the scan.
- Deleting query families or source families to run fewer searches.
- Shrinking top-k or evidence-pack length to save tokens.
- Globally disabling self-consistency, arbiter, or verification to cut model calls.
- Swapping to a cheaper model globally without per-subgroup held-out proof.
- Longer timeouts or bigger connection pools as a first move.

Faster and cheaper, yes — but only by doing the *same* work *once* and *well*, never by doing *less*.
