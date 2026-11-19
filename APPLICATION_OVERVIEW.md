# CompanyIQ v3 — Application Overview (for independent review)

**Date:** 2026-11-17
**Repository:** https://github.com/ahow/companyiq-v3.git (branch `main`)
**Live deployment:** https://companyiq.online (Railway, auto-deploys from `main`)
**Audience:** an independent reviewer assessing the design, correctness, and scoring integrity of the system.

> This document describes the application as it exists in the deployed code (prod HEAD `40a353e`). It is grounded in the source tree; file/line references are given so a reviewer can verify each claim. Companion design/diagnosis documents are listed in §10.

---

## 1. What the application is

CompanyIQ v3 is an **evidence-based corporate-disclosure scoring engine**. Given a **company** and a **framework** (a structured questionnaire of binary measures — e.g. *"Physical Climate Resilience and Business Continuity v3.1"*), it:

1. **Discovers** the company's primary disclosure documents on the public web (annual reports, 10-K/20-F filings, sustainability/ESG reports, CDP responses, TCFD/IFRS S2 reports, etc.).
2. **Fetches** and parses those documents into a per-company evidence **corpus**.
3. **Retrieves** the passages relevant to each framework measure.
4. **Grades** each measure to a **binary verdict** (Yes / No) with a supporting evidence quote and source attribution.
5. **Scores** the company as the percentage of measures answered *Yes*.

The goal is a **defensible, reproducible** score: every Yes/No must be traceable to a quoted passage in an attributable source document, and the same company analysed twice against the same framework should produce the same result.

It is used in production to run **large batches** (e.g. a 50-company list, scaling toward 2,500 companies) autonomously against an active framework.

---

## 2. Scoring model (important — read before reviewing scores)

- Each measure is **binary**: the grader emits **0 or 1**. A "Partial" determination counts as **0**, not a fractional credit. There is **no 0–4 / Likert scale**.
- **Company score** = `round( met.length / answered.length * 100 )` — the share of answered measures that are *Yes*. Verified at `server/routes/api.ts` L171–174 and L2142–2143.
- **Design principle (current, rev 2 of the scoring-integrity design):** every measure must resolve to **Yes or No**. "Abstain" is **not** a design principle. When evidence is in doubt, the priority is to **re-search the corpus** for a better quote and enlarge retrieval — *not* to drop the measure or hand-adjust the score. The denominator is never reduced to hide a hard-to-judge measure. (See `SCORING_INTEGRITY_DESIGN_20261117.md`.)
- **Standing integrity rule:** when attribution/evidence is in doubt, fix the *evidence/retrieval/labelling mechanics* (re-search for the best quote); never zero or hand-edit a score.

---

## 3. Architecture

**Runtime:** Node.js + TypeScript, executed with `tsx` (no separate compile step for the server); the client is built with `vite`. Data in **PostgreSQL** (PG16, hosted on Railway); job queue / coordination via **Redis**.

**Processes (Railway services):**
- **App / API service** (`server/routes/api.ts` + `server/index`) — HTTP API and the client app; exposes `/analyze` (~L739) and results endpoints.
- **Worker service** (`server/worker.ts`) — pulls analysis jobs from Redis and runs the discovery→grading pipeline. Runs **8 replicas** in production. Concurrency bound `MAX_CONCURRENT` (~L70).
- **Postgres** and **Redis** — managed Railway plugins.

**Two Railway environments:** **Production** (`c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b`) and **Preview** (`6987d716-8c03-4a35-ae7c-270d6806cc50`). Production is the one serving companyiq.online.

**Key source directories:**
- `server/lib/discovery.ts` — document discovery: query generation, search-provider calls, the relevance gate, doc-type-aware boosting, aggregator filtering.
- `server/lib/analyzer.ts` — corpus assembly, recency/document selection, corpus hygiene (stale-version drop), grading orchestration, determinism (temperature-0 + deterministic seed).
- `server/lib/eligibility-flags.ts` — source-attribution logic (own-brand vs third-party host, pronoun/entity checks).
- `server/lib/robustness-flags.ts` — the W1–W8 robustness feature-flag registry (env-driven, most default-ON).
- `shared/research-state.ts` — per-company research state: evidence-completeness derivation, coverage accounting, quote-reuse detection, source-label mismatch flagging (display/advisory layer).
- `server/routes/api.ts` — API surface and the score formula.
- `server/scripts/programme_launch_run.ts` — batch launcher for autonomous programme runs.

---

## 4. The analysis pipeline (per company × framework)

1. **Query generation** (`discovery.ts`)
   - A layered set of queries is built: declared **disclosure-vehicle** queries from the framework's `required_doc_types`, plus framework-provided `search_templates` / `legacy_query_templates` / `multi_document_query_templates` / URL patterns, plus LLM-generated **query variants** (`generateQueryVariants`, prompt ~L1555–1582), plus a generic fallback (`buildGeneralQueries` ~L1611; thin 6-query fallback ~L1640 when a framework declares no templates).
   - Search providers: Serper.dev / SerpAPI.

2. **Relevance gate** (`runRelevanceGate` ~L3515)
   - Candidate URLs are screened on URL + title + snippet **before** fetch. `matchesRequiredDocType` (~L3478) and a doc-type priority boost (~L3454) favour declared vehicles. A hardcoded **aggregator denylist** (`BLOCKED_AGGREGATOR_DOMAINS` ~L5443) removes third-party-hosted mirrors.

3. **Fetch & corpus assembly** (`analyzer.ts`)
   - Documents are fetched and parsed. **Recency/document selection** picks the newest primary filing (~L1819–1928). **Corpus hygiene** drops superseded/stale versions (~L2291–2326).

4. **Retrieval + grading**
   - Relevant passages are retrieved per measure and graded to a binary verdict with an evidence quote and attributed source. Grading is deterministic: **temperature 0** + a deterministic seed (~L4016), with a verdict cache (~L2341).
   - **LLM providers:** a primary / secondary / arbiter arrangement, with **OpenRouter as the fallback** for any failed primary, secondary, or arbiter call.

5. **Scoring & attribution**
   - Measures aggregate to the company score (§2). Attribution checks (`eligibility-flags.ts`) confirm each evidence quote is sourced from an own-brand domain vs a third party, guarding against mis-attributed quotes.

---

## 5. Robustness machinery (W1–W8) — deployed

A set of robustness workstreams (plan: `FRAMEWORK_ROBUSTNESS_PLAN_20261116.md`) is **implemented and live** in production (commit `0de167c`, an ancestor of prod HEAD `40a353e`). Controlled by env flags in `server/lib/robustness-flags.ts`; authoritative flag/default table in `DEPLOYED_FLAGS.md`. Summary:

| WS | Purpose | Prod state |
|----|---------|-----------|
| W1 | Frozen corpus for deterministic re-grades | default-ON |
| W2 | Relevance-gate hardening — `GATE_FAILOPEN`, `GATE_SPLIT_IDENTITY_TOPIC` (identity vs topicality split) | default-ON |
| W3 | Framework-readiness gate (ensures a framework declares its disclosure vehicles) | default-ON |
| W5 | Doc-type-aware discovery (dedicated queries + ranking boost for declared vehicles) | default-ON |
| W7 | Stalled-batch requeue | default-ON |
| W8 | Variance harness (run-to-run consistency measurement); `VARIANCE_GATE_STRICT` | harness ON, strict gate OFF |
| — | `MULTILINGUAL_EVIDENCE_TRANSLATE` | explicitly set ON in prod worker |

---

## 6. Six mechanical bugs — fixed and live

Separately from W1–W8, six mechanical gate/attribution/labelling bugs were identified and fixed (live on prod `40a353e`). Documented in `FRAMEWORK_STRENGTHENING_MATRIX.md`: BUG1/BUG6 attribution (own-brand vs third-party host, pronoun/entity handling in `eligibility-flags.ts`), BUG2 evidence-completeness derivation, BUG3 embedding-report matching, BUG4 quote-reuse detection, BUG5 source-label/date mismatch advisory (`shared/research-state.ts`).

---

## 7. Known hard problems the reviewer should scrutinise

These are the open problem classes the current design work targets (full treatment in `SCORING_INTEGRITY_DESIGN_20261117.md`):

1. **Wrong zeros / discovery gaps** — obvious documents (e.g. a company's sustainability report) sometimes not surfaced. Root causes are code-grounded (§8 below), not random.
2. **Score tracks retrieval volume** — a company with a thinner retrieved corpus tends to score lower, because un-retrieved evidence reads as a *No*. The cure is per-measure **retrieval-adequacy → re-search** before any No is allowed, not arithmetic changes.
3. **Run-to-run inconsistency** — mitigated by frozen corpus (W1) + temperature-0/seed + variance harness (W8), but still worth independent measurement.
4. **Outdated sources** — a Yes should never rest on stale evidence; a hard recency rule with re-search-first is proposed.

---

## 8. Why "obvious" documents can be missed (code-grounded)

There is **no per-company block** — nothing excludes any issuer by name. Three hardcoded mechanisms plus one configuration effect explain the misses:

1. **Query-variant generator is muzzled against sustainability queries** — `discovery.ts` L1567 & L1576 instruct the variant generator *not* to produce generic sustainability/ESG queries unless the topic *is* sustainability. For a framework titled "Physical Climate Resilience…" that lane never requests "<company> sustainability report"; the report is only reached via the declared-`required_doc_types` lane.
2. **Hardcoded aggregator denylist** — `BLOCKED_AGGREGATOR_DOMAINS` (L5443) drops third-party-hosted copies (sustainabilityreports.com, spglobal.com, bloomberg.com, reuters.com, etc.) before the gate. The issuer's own-domain copy is not blocked; this only bites when the sole surfaced copy is an aggregator mirror.
3. **Reject-biased relevance gate** — L3586 *"When in doubt, REJECT rather than accept."* on snippet alone, pre-fetch. **Now mitigated** by `GATE_SPLIT_IDENTITY_TOPIC` (live), which lets a declared vehicle pass on identity and defers topicality to the content stage.

**Configuration amplifier:** the widely-cited misses (Michelin, etc.) came from test drives on an **under-configured** framework (fw24: zero templates), which fell back to the thin 6-query generic path *and* hit the muzzle *and* the pre-mitigation reject-bias. The **active** framework (fw25) declares 27 `required_doc_types` incl. sustainability/CDP/TCFD, so doc-type-aware discovery (W5) now targets and boosts those vehicles. **Proposed fixes:** relax mechanism 1 so declared vehicles are always query-able; make mechanism 2 issuer-aware (keep an aggregator copy when it is the only copy); enforce W3 readiness so every active framework declares its vehicles.

---

## 9. Deployment & operation

- **Hosting:** Railway. Production env `c1166ef6-…`; app + worker (8 replicas) + Postgres + Redis. Auto-deploy on push to `main`.
- **Data model (frameworks):** frameworks are rows in Postgres; disclosure configuration lives in **jsonb** columns `required_doc_types`, `legacy_query_templates`, `search_templates`, `multi_document_query_templates` (query with `jsonb_array_length`). Active frameworks at time of writing: id 1 (Test), id 25 (Physical Climate Resilience v3.1, 27 required doc types).
- **Batch runs:** `server/scripts/programme_launch_run.ts` launches a workspace/framework/list run against the worker fleet.
- **Determinism controls:** temperature 0, deterministic seed, frozen corpus (W1), verdict cache.

---

## 10. Companion documents in the repo

- `SCORING_INTEGRITY_DESIGN_20261117.md` — scoring-integrity design (rev 2): re-search-first, forced binary Y/N, no abstain; the four problem classes and their guards.
- `FRAMEWORK_ROBUSTNESS_PLAN_20261116.md` — W1–W8 machinery plan (now implemented).
- `FRAMEWORK_STRENGTHENING_MATRIX.md` — the six mechanical bugs (fixed, live).
- `DISCOVERY_MISS_DIAGNOSIS_20261115.md` — production evidence behind the discovery misses.
- `DEPLOYED_FLAGS.md` — authoritative env-flag/default table for W1–W8.

---

## 11. Suggested focus areas for the independent review

1. Is the **binary scoring model** (Partial → 0, score = % Yes) appropriate, and is the denominator handled correctly (`api.ts` L171–174)?
2. Does the **re-search-first, no-abstain** design actually break the score↔retrieval-volume coupling without inflating Yes rates?
3. Are the **three hardcoded suppressors** (§8) the right things to relax, and do the proposed fixes risk letting in low-quality third-party evidence?
4. Is **determinism** (temperature-0 + seed + frozen corpus) sufficient for reproducible scores at batch scale, and does the variance harness (W8) measure it credibly?
5. Is **attribution** (`eligibility-flags.ts`) robust against quotes that mention the company but originate from third parties?
