# CompanyIQ v3 — Change Roadmap

**Date:** 3 September 2026 (early evening BST)
**Author basis:** consolidates the 17-item Unified Change Register (2 Sep 2026), the Interventions & Lessons Register (2 Sep 2026), the Session Handover (3 Sep 2026 00:50 BST), plus new items identified in the domain / ISIN / unlisted-flag session run on 3 Sep 2026 (PRs #5, #6, #7).
**Purpose:** one document that names every remaining candidate change, orders them by tier and dependency, states the acceptance test for each, and lets us work through them item-by-item without re-deriving priorities every time.

---

## Executive summary

**Total outstanding items: 22.** Of these:

- **4 Tier 1 items** are ready to ship immediately (biggest recall/precision levers with lowest risk)
- **5 Tier 2 items** land next (moderate effort, strong evidence)
- **9 Tier 3 items** are structural investments (larger effort, high ceiling)
- **4 operational / follow-up items** identified in this session (ISIN cross-check for CSV, apply-proposals script, iter-13 rerun, apply-proposals UI)

**Cross-cutting rule that governs sequencing (from earlier lessons E1, E3, and iter-11/12):**

- Framework-specification quality and rubric calibration move outcomes 5–15× more than any single retrieval-code change
- Ensembles hide component damage; every item ships behind a flag and is measured **standalone** on a truth baseline before combining
- U1 (framework-agnosticism fixes — landed) is a prerequisite for A/B interpreting any retrieval change; new retrieval items must not re-introduce cross-topic contamination

**The immediate next lever** is **iter-13 on fw3 × 10 companies** with the newly-populated ISINs and cleaned related_domains. That measurement is what everything shipped in the last two sessions was designed to enable, and its outcome directly informs whether U6 (competitor-collision), U8 (ML filter), or U11 (sector routing) is the highest-value Sprint-N+1 lever.

---

## Section 1 — What has already shipped

Recorded here so we don't waste review cycles on closed items.

| ID | Description | Landed | Notes |
|---|---|---|---|
| U1 | Framework-agnosticism fixes (`temporal-validation.ts` withdrawal patterns, `LEGACY_TOPIC` narrowing, `company.domain` OpenFIGI stale-clear) | Instructions 41-C / 41-D / 42-B, pre-session | Verified at HEAD `23709a0` |
| U2 | Base-rate prior injected into scoring prompt (behind `SCORING_BASE_RATE_PRIOR` flag) | commit `e1474f9`, 2 Sep 2026 | Iter-11 → iter-12 measured Nestlé/Kering/Santander gains |
| U17 Fix A | Source-provenance classifier + corpus-build third-party exclusion (behind `U17_PROVENANCE_FILTER` flag, defaults on) | commit `3a31ca7`, 2 Sep 2026 | Deployed Railway 23:41Z 2 Sep |
| U17 backfill | Re-classified all 1,280 document rows with the new classifier | commit `19221e0`, 3 Sep 2026 | 369 upgrades to first-party, no downgrades |
| PR#1 | Retrieval hardening — latest-primary-disclosure verification, subsidiary/vintage/press-page ranking penalties, chunk sanity gate, auto re-retrieval on low-confidence cells | merged `c7bb4d4` | Behind `retrievalV2` / `autoReretrieval` flags |
| PR#2 | Cross-architecture cascade scoring (DeepSeek → GLM → Mistral arbiter) + auto-downgrade suppression | merged `23709a0` | Behind `SCORING_CASCADE` flag |
| — | ISIN + related_domains manual apply for all 19 preview rows | Direct SQL, 3 Sep 2026 evening | 19/19 have ISINs; caches invalidated; L'Oréal domain set; aggregators removed from Apple/NextEra/Suncor/Ambev; Santander gained legitimate corporate subsites |

**Open PRs from this session (all pending merge; not yet counted as shipped):**

- **PR #5** — Test-drive ingest: resolve ISIN + FMP metadata by ticker, with country + ADR collision guards. Includes ISIN check-digit validation. 37/37 unit tests pass; dry-run verified against all 19 preview companies
- **PR #6** — `is_unlisted` flag on companies, plumbed through CSV upload, single-create endpoint, discovery.ts / issuer-profile.ts guards, DashboardPage checkbox, ListsPage help text. 40/40 unit tests pass
- **PR #7** — Domain-and-ISIN audit workstream: `company_domain_proposals` table + `scripts/propose_domain_and_isin.ts` CLI. Dry-run against all 19 companies committed as evidence

The manual SQL apply on 3 Sep evening obsoletes the "run PR #7 with `--persist`" step, but the audit library and proposals table remain useful for future audits of new company universes.

---

## Section 2 — Tier 1 (this sprint)

Ship in dependency order. Truth-baseline A/B each item independently. Every item is behind a flag by default.

### T1.1 — Iter-13 rerun on fw3 × 10 with corrected data

**Why first:** every item shipped in the last two sessions was aimed at making iter-13 interpretable. Running it now (a) confirms the U2 + U17 + PR#1 + PR#2 + ISIN corrections combined lift is real, (b) resets the baseline against which every subsequent item is measured, and (c) surfaces which residual FN/FP class dominates — which drives the choice between U8 (ML filter), U11 (sector routing), or U13 (CoT re-read) as the next Sprint-N+1 target.

**What to do:**
- Trigger a score-only rerun of fw3 × the 10-company list via `POST /api/analyze` with `{frameworkId: 3, listId: 2, scoreOnly: true}`
- Compare iter-13 against iter-11 (pre-U2, pre-U17) and iter-12 (post-U2, pre-U17). Not iter-11 vs iter-13 in isolation; the two-hop comparison isolates U17's marginal effect
- Score against the primary-source truth baseline (`CompanyIQ-v3--Primary-Source-Truth-Baseline-22-Banks--fw3fw8.md`)
- Attribute movement to: base-rate prior (U2), provenance filter (U17 Fix A), retrieval hardening (PR#1), domain corrections (this-session SQL)

**Acceptance test:** interpretable delta report — per-company Y/P/N, with attribution. Nestlé and Ambev fetch-blocked in iter-12 (U7 unfixed) — expect residual gap until U7 lands.

**Effort:** S. ~30 min run + ~1 hour analysis.

**Interaction constraints:** none — this is a measurement, not a change.

---

### T1.2 — U17 Fix B: scoring-time provenance gate on Yes verdicts

**Why:** U17 Fix A filters third-party docs from the *corpus-build* stage. Fix B is the safety net at the *scoring* stage — for every Yes verdict, look up the quote's `sourceUrl`, resolve its provenance class, and downgrade the verdict if third-party and no corroborating issuer-provenance quote is present.

**What to do:**
- Add `resolveQuoteProvenance(quote, sourceUrl, companyRow)` helper reusing `classifyProvenance` from `server/lib/provenance.ts`
- In `analyzer.ts` post-verdict pass, run the check on every Yes and Partial verdict
- Downgrade → No with `provenance_downgrade` in the verdict trace and record `verdict_original` for auditability
- Behind flag `U17_SCORING_TIME_GATE` (default off; enable after standalone measurement)

**Acceptance test:**
- Unit tests covering three cases: (a) first-party quote survives, (b) regulator-hosted issuer-filed quote survives, (c) third-party quote downgrades
- On the fw3 × 10 iter-13 batch: measure precision delta with the flag on vs off. Expected direction: precision + on Newmont measure 2.4, negligible movement elsewhere
- Zero downgrades where all quotes cite the issuer's own domain — sanity check that Fix A did its job upstream

**Effort:** S–M. Estimated ~1 day. Shares the "resolve quote → sourceUrl → provenance" mechanism with U9 Layer 1 — implement once, wire twice.

**Interaction constraints:**
- Must ship *after* U17 Fix A + backfill (both landed) so provenance labels are correct
- Ships **paired** with U9 Layer 1 as originally planned (shared mechanism); measure independently by toggling the flag

---

### T1.3 — U9 Layer 1: verbatim quote re-verification + tier gating

**Why:** the cheapest audit-defensibility win in the whole corpus. Catches fabricated citations (LLM paraphrase, stitched fragments, URL drifted) and Tier-3 outlets (case studies, aggregators, template sites). Two soak tests measured zero logic false negatives on 266 Yes verdicts.

**What to do (spec exists at `Sprint-1-Mode-A--ServerLib-Integration-Spec-U9-Layer-1-source.md`):**
- **Check A — verbatim/near-verbatim re-fetch** — after each Yes verdict, re-fetch the cited URL, whitespace + smart-quote tolerant fuzzy match, multi-fragment support. Reject paraphrase. Downgrade → No with `validation_failure_reason` recorded
- **Check B — tier gating** — Tier 1 (issuer domain / regulator / exchange filing endpoint) accept; Tier 2 (~35 outlets in `sprint1_validation/tier2_outlets.json`) with issuer attribution ±200 chars accept; Tier 3 reject
- 30-test regression suite exists in `companyiq-runs/tests/regression_suite.py` — port as `server/lib/quote-verifier.test.ts`
- Behind flag `U9_LAYER_1` (default off)

**Acceptance test:**
- 30/30 regression tests pass in TypeScript
- On the fw3 × 10 iter-13 batch: predicted precision 82.5% → 84.4% (from Sprint 1 soak). Expected downgrades cluster in Nestlé, Prudential (already fixed by ISIN update, so effect should be minimal), and any bank citing third-party aggregators
- Zero downgrades of first-party quotes verified in the batch — logic-false-negative check

**Effort:** S–M. Estimated 1–1.5 days.

**Interaction constraints:**
- Shares scoring-time gate mechanism with T1.2 (U17 Fix B) — build the gate once, wire it in twice
- **U12 (LLM-direct + union) MUST NOT ship without this** — U12 introduces hallucinated-citation risk; Layer 1 verbatim check is the exact control
- U9 Layer 2 (semantic cross-provider check) is Tier 2 — do not conflate

---

### T1.4 — U3: force translation for all URLs of non-English-tagged companies

**Why:** 13 recoverable FN cells across three frameworks (~7% of all FNs) at zero material cost. Every single FN4 case was a non-English company where the English URL was scored and the native-language URL was never translated because the per-URL `NON_ENGLISH_RATIO_THRESHOLD` heuristic didn't fire.

**What to do:**
- In `server/lib/translation.ts`, add condition: when `company.localeProfile` is non-English, bypass the per-URL ratio threshold. Every URL for that company gets translated
- Preserve the existing `MAX_TRANSLATE_CHARS=120000` guardrail
- Behind flag `TRANSLATION_FORCE_ON_LOCALE` (default off)

**Acceptance test:**
- On fw3 × 10 iter-13: Toyota, Samsung, and Nestlé (Swiss with multilingual reports) should show a translation-count increase. Any FN → TP flip on non-English disclosure is confirmatory
- Cost delta ≤ $0.05 per 22-bank run (from Sprint 9 measurement)

**Effort:** S. ~2–3 hours. One policy change on top of infrastructure that already exists.

**Interaction constraints:**
- Runs before U8 (ML filter) and U13 (CoT re-read) so recall lift is measurable standalone
- U4 (locale-table coverage audit) should run first to confirm the 24-community table is populated — otherwise the force-translate policy has nothing to force

---

## Section 3 — Tier 1.5 (small operational items, this sprint)

Items uncovered in this session that are too small for their own Tier but too important to defer. Order-independent within this group.

### T1.5.1 — Fix Prudential's ticker in the DB

**Why:** `companies.ticker = 'PRU'` on Prudential plc (id=19) still points at Prudential Financial US via any future FMP-by-ticker resolution. We manually set `isin = 'GB0007099541'` so the ISIN-first path works, but the ticker itself is wrong.

**What to do:**
- `UPDATE companies SET ticker = 'PRU.L' WHERE id = 19` (or leave it — the ISIN-first path in `discovery.ts` short-circuits on ISIN presence, so ticker collisions no longer bite)
- Same for Unilever (`UL` → `ULVR.L`) and Ambev (`ABEV` → `ABEV3.SA`) if we want the FMP-by-ticker path to remain consistent for future ingest paths

**Acceptance test:** trivial — SELECT after UPDATE.

**Effort:** S. ~15 min.

---

### T1.5.2 — Merge PRs #5, #6, #7 (or close #7)

**Why:** three PRs are open on the repository. #5 (ingest ISIN) and #6 (unlisted flag) fix real bugs and stay useful. #7 (audit) is code we bypassed via SQL — the library and proposals table remain useful for future audits of new company universes; the audit script is optional.

**What to do:**
- Review and merge #6 first (schema addition; simplest)
- Review and merge #5 (rebased on merged #6 if needed)
- Decide on #7: merge to keep the audit library available, or close if you'd rather not maintain unused code
- Prudential's `PRU.LN` question (whether FMP has an LSE-primary variant that would resolve correctly) is now moot — the ISIN is populated

**Effort:** S — review time only.

---

### T1.5.3 — Apply-proposals runbook (if #7 merges)

**Why:** the audit produces `company_domain_proposals` rows; there's currently no code to promote accepted proposals into `companies`. We bypassed this via direct SQL for the current 19-company set, but a repeatable workflow is nice for the next universe.

**What to do:**
- Extend `scripts/propose_domain_and_isin.ts` with `--apply` mode that reads `WHERE status = 'accepted'` and updates `companies`, sets `applied_at`, invalidates FMP/FIGI/related_domains pipeline versions
- Add a tiny UI page under `client/src/pages/AdminProposalsPage.tsx` for accept/reject workflow (optional — CLI is enough for now)
- Guard: never apply a proposal whose target row has `is_unlisted = true`

**Effort:** S for the CLI apply. M for the UI page.

**Interaction constraints:** ships only if #7 merges.

---

### T1.5.4 — CSV-upload ISIN cross-check (the deferred follow-up)

**Why:** you supply clean ISINs in your uploads, but a right-format-but-wrong-issuer paste (someone pastes `US7443201022` for Prudential plc) still passes ISIN validation and silently corrupts the row. This is the follow-up we deferred from the PR #5 discussion.

**What to do:**
- In `POST /api/companies/bulk`, after ISIN validation, call `resolveViaFmp(isin)` if FMP key is configured
- Check that FMP's returned `companyName` shares distinctive tokens with the supplied `name` (reuse `nameTokens` from `domain-audit.ts`); check FMP's `country` matches supplied `country`
- On mismatch: log, do NOT insert, add to `skipped[]` with reason `"isin_identity_mismatch"`, return in the response so the user sees which rows were rejected
- Respect `is_unlisted = true` — skip the cross-check for those rows

**Acceptance test:**
- Unit tests covering: valid ISIN + matching name = OK; valid ISIN + mismatched name = rejected; unlisted row = skipped; FMP key absent = graceful fall-through with a warning

**Effort:** S. Estimated ~half a day. Uses the library from PR #5 + PR #7.

**Interaction constraints:** ships after PR #5 merges.

---

## Section 4 — Tier 2 (next sprint)

Moderate effort, strong evidence. Ship in the order below.

### T2.1 — U9 Layer 2: cross-provider semantic quote check

**Why:** Layer 1 catches fabrication (is the quote real?); Layer 2 catches relevance (does it answer the measure?). Different LLM provider from the primary scorer (GLM verifies DeepSeek, DeepSeek verifies GLM, never same-model) receives only the measure text + the quote and answers "does this quote answer this measure?". Predicted +0.05 precision at $0.30 per 100-company batch.

**What to do:**
- Extend `server/lib/quote-verifier.ts` (from T1.3) with a Layer 2 pass that runs only on Yes verdicts surviving Layer 1
- Route through `ai-providers.ts` with a "must be different provider from primary scorer" constraint
- Downgrade → No on clear No; keep on ambiguous
- Behind flag `U9_LAYER_2` (default off)

**Acceptance test:**
- On the fw3 × 10 truth baseline: precision + expected on measures where evidence exists but is topically-adjacent (fw3 climate vs sustainability, fw8 modern slavery vs general human rights)
- Cost per run ≤ $0.40 for 25 companies

**Effort:** S. ~1 day.

**Interaction constraints:**
- Ships **after** U8 (ML filter) so effects are cleanly measurable — the two attack overlapping FP populations
- Layer 1 must be shipped and stable first

---

### T2.2 — U8: per-measure ML verdict filter at τ = 0.30

**Why:** the largest single measured precision lever in the entire corpus (F1 0.612 → 0.689 on 682 fw8 cells; ML-filter-only vs baseline +0.092 F1 on the 4-bank ablation). Removes 24 of 51 FPs while losing only 2 of 64 TPs. Improves automatically as truth data grows.

**What to do:**
- Feature extraction in TypeScript (pure string/regex over data the scorer already has): matched-quote count, mean/max quote length, forward-looking marker density, digit/percent/capital-word-run density, Jaccard overlap of matched quotes against `evidenceKeywords`, source-URL domain match against `disclosure_vehicles`, strong/weak/fallback path distribution
- Train offline in Python (`sklearn`), ship coefficient JSON per `(frameworkId, version, measureId)` in the `frameworks` table so the deploy has no `sklearn` runtime dependency
- Apply at scoring time: downgrade Yes → No when classifier probability < τ (default τ = 0.30, framework-specific override supported)
- Behind flag `ML_FILTER_ENABLED` (default off; enable per framework after truth-labelled data ≥ ~15 Yes verdicts per measure)

**Acceptance test:**
- Retrain against current ~4,400 labelled cells across fw3/fw8/fw11b; per-framework threshold sweep confirms τ = 0.30 is near-optimum
- On fw3 × 10 iter-14 (after Tier 1 lands): F1 + against iter-13, precision + more than recall −, MAE lower

**Effort:** M. ~2–3 days for extraction + offline training pipeline + deploy path.

**Interaction constraints:**
- Ship **before** U9 Layer 2 so effects are cleanly measurable
- Requires per-framework truth data; may need a data-entry sprint for newer frameworks

---

### T2.3 — U10: restructured arbiter as quote-quality judge

**Why:** current arbiter (Mistral in PR#2) receives the same evidence pack and system prompt as the primary scorers and converges to the primary's verdict in ~91% of disagreements. Restructure: arbiter receives *only the two differing verdicts + their cited quotes*, task is "judge quote quality between these two verdicts" (adversarially framed).

**What to do:**
- Change the arbiter prompt in `analyzer.ts` / cascade config
- Arbiter input: two verdicts + their quotes + measure text; NOT the raw evidence pack
- Frame adversarially: "strongest No argument, strongest Yes argument, then pick"
- Behind flag `SCORING_ARBITER_QUOTE_JUDGE` (default off, layered on `SCORING_CASCADE`)

**Acceptance test:**
- On the fw3 × 10 iter-13 disagreement subset: arbiter agreement-with-primary drops from ~91% to a target ~50–65%; F1 net-positive
- Kering 1.3 arbiter regression (iter-11 audit) should improve

**Effort:** S–M. ~1–1.5 days.

**Interaction constraints:** ships independently of U8 and U9 — different mechanism.

---

### T2.4 — U6: competitor-collision penalty in `scoreEntityMatch`

**Why:** even with ISINs populated, `scoreEntityMatch` can still accept documents that mention a *different* known issuer's legal name (Prudential Financial mentioned in a page about Prudential plc, etc.). The ISIN populates identity but doesn't itself prevent quote reuse from a competitor's document that made it into the corpus.

**What to do:**
- In `server/lib/ranking.ts` `scoreEntityMatch`, when the document contains the *official legal name* of a *different* known issuer (FIGI aliases + curated shortlist), apply a collision penalty large enough to push the score below the accept threshold
- Curated shortlist starting from known ambiguities: Prudential plc ↔ Prudential Financial Inc; Standard Chartered ↔ Standard Bank; State Bank of India ↔ SBI Holdings Japan; Munich Re ↔ Munich Airport
- Match requires the collision candidate's *full official name*, not a shared word ("Prudential")
- Behind flag `COMPETITOR_COLLISION_PENALTY` (default off)

**Acceptance test:**
- Unit tests: document about Prudential Financial rejected as evidence for Prudential plc; document mentioning both correctly attributed
- On fw3 × 10: Prudential 1.1 (iter-11 audit) improves; no regression on non-collision cases

**Effort:** M. ~1.5 days including curated shortlist authoring.

**Interaction constraints:** ships independently; the FIGI alias source has to be populated (`figiName` / `figiTicker` per company) — already invalidated on this-session SQL apply, so first run of the pipeline post-merge should refresh them.

---

### T2.5 — U5: firing-rate audit dashboard

**Why:** several deployed mechanisms have unclear firing rates. `FRAMEWORK_V2_TWO_STEP` only delivers value if measures declare `scoring_strategy`; `FRAMEWORK_V2_EVIDENCE_ABSENT` was previously blocked by shared-blob augmentation. A dashboard removes the ambiguity.

**What to do:**
- Instrument each flagged mechanism (`FRAMEWORK_V2_TWO_STEP`, `FRAMEWORK_V2_CONTEXT_EXPAND`, `FRAMEWORK_V2_EVIDENCE_ABSENT`, `MULTILINGUAL_DISCOVERY_ENABLED`, `RETRIEVAL_LLM_RESCORE`, `SCORING_CASCADE`, `U17_PROVENANCE_FILTER`, `SCORING_BASE_RATE_PRIOR`) to emit a firing event with `(batchId, companyId, measureId, mechanism)` tuple
- New table `mechanism_firing_events`
- Small admin page `AdminFiringRatesPage.tsx` showing per-mechanism firing-rate over last N batches

**Acceptance test:**
- After one fw3 × 10 batch: every listed mechanism reports a firing-rate ≥ 0
- Zero-firing mechanisms identified as issues (e.g. `FRAMEWORK_V2_TWO_STEP` firing 0 times → measures haven't declared `scoring_strategy`)

**Effort:** S. Estimated ~1 day for instrumentation + admin page.

**Interaction constraints:** independent of everything else; useful to run first because it may reveal U8/U11/U15 are partly-deployed but silently not firing.

---

## Section 5 — Tier 3 (structural investments)

Larger effort, high ceiling. Order below reflects both dependency and expected-lift-per-effort. Not all should be attempted in one sprint.

### T3.1 — U7: browser fallback hardening

**Why:** 13 Nestlé URLs marked `dead` in one batch (`circuit_broken`, `timeout`, `empty_after_render`) because `BROWSER_LAUNCH_COOLDOWN_MS=120000` opens a 2-minute global cooldown on any single launch failure. Ambev 1.4 fetch-blocked for the same reason. Directly unblocks two named iter-11/12 gaps.

**What to do (three separable fixes):**
1. **Circuit-broken URLs stay `pending`, not `dead`** — currently they're marked `dead` and never retried. Change: URLs skipped because of an open circuit are annotated `circuit_broken` and left `pending`, retried on the next batch pass
2. **JS-render detection for known IR-portal software** — pattern-match on the fetched HTML for MZiQ, Q4 Inc, Investis fingerprints and force the headless-browser path on first fetch, not on retry (architecture-driven, not company-driven — mirrors T3.2 CDN admission philosophy)
3. **Launch reliability** — memory limits, exponential-backoff on launch failure (rather than immediate cooldown), consider serialising launch to one-at-a-time under load

**Acceptance test:**
- Nestlé and Ambev complete iter-14 without fetch-blocks
- Firing rate of `circuit_broken` events ≥ 90% reduced

**Effort:** S–M. ~1.5–2 days.

**Interaction constraints:** independent; large recall lift on affected companies.

---

### T3.2 — CDN admission rule (Q4 / MZiQ / Contentful IR portals)

**Why:** identified in this session's audit. Newmont's `s24.q4cdn.com` (4 docs), `d18rn0p25nwr6d.cloudfront.net` (2), Ambev's `api.mziq.com` (4), `mz-filemanager.s3.amazonaws.com` (2), `assets.ctfassets.net` (4) — all issuer-authored PDFs served from Q4 Inc, MZiQ and Contentful IR-portal CDNs, currently classified `third_party` because the classifier only checks `company.domain` and `related_domains`.

**What to do:**
- In `server/lib/provenance.ts`, add a `CDN_HOST_PATTERNS` layer between the domain-match and regulator-match rules
- Each pattern: `(hostRegex, cdnLabel, identityCheck)` — the identity check confirms the document mentions the target issuer's name / ticker / ISIN. Same pattern as the regulator-host rule (rules 2 + 3)
- Seed patterns: `s24.q4cdn.com`, `d18rn0p25nwr6d.cloudfront.net` (Q4), `api.mziq.com`, `mz-filemanager.s3.amazonaws.com` (MZiQ), `assets.ctfassets.net` (Contentful) — plus Investis and any others surfaced by the audit
- Backfill `documents.source_type` on rows currently `third_party` where the host matches a CDN pattern and the document identity-checks

**Acceptance test:**
- Newmont, Ambev, and any other issuer using these CDNs see their CDN-served docs upgraded to `first_party`
- Ambev's post-U17-Fix-A third-party share falls from 69% into the 5–15% target band on fw3

**Effort:** S. ~1 day including backfill.

**Interaction constraints:**
- Ships **after** U17 Fix B (T1.2) so provenance labels are consistent
- Do NOT frame as a per-company hint list — it's an IR-portal-vendor rule

---

### T3.3 — U11: reopen sector-scope routing under evidence-absent semantics

**Why:** the largest single precision recovery in the entire corpus (+0.224 on fw8, F1 0.602 → 0.646, MAE 2.9 → 1.7). Was deprecated in favour of universal applicability — a design tension that was mistaken. Universal applicability is a *grammatical* property; sector scoping is a *runtime routing decision*. Now that `framework-v2/evidence-absent.ts` is deployed the two reconcile cleanly.

**What to do:**
- Add optional `applies_when_sector_in: string[]` metadata at the measure level in the framework schema
- Every measure remains grammatically universal — the field is metadata, not phrasing
- At runtime in `analyzer.ts` / `pipeline.ts`: when a measure carries the field and the company's `sector` doesn't overlap, short-circuit to `evidence_absent` (not fabricated No) *before* the LLM call
- Sector metadata already on `companies.sector`; framework field is new
- Behind flag `SECTOR_ROUTING_ENABLED` (default off; measure-level opt-in)

**Acceptance test:**
- On fw8 × 22 banks (once truth baseline available): precision + ~0.22, F1 + ~0.04, MAE + (lower), cost − (~30% because half the LLM calls disappear)
- Skips must be 100% correct — validate against truth baseline
- Fail-open when sector metadata missing

**Effort:** S for the mechanism; M for the design + data (which measures get which sectors)

**Interaction constraints:** stacks with U8 (they attack different FP populations); ship independently and measure additivity.

---

### T3.4 — U13: tiered chain-of-thought second pass on borderline No verdicts

**Why:** targets FN9 — "LLM says evidence doesn't quite satisfy the criteria" — which is **62%** of all FNs across three frameworks. Built and unit-tested offline; blocked historically by a sandbox proxy limitation that no longer applies.

**What to do:**
- On No verdicts with non-empty matched evidence, run a permissive-prompt second pass with a lighter model (Gemini 2.5 Flash-Lite via `ai-providers.ts`)
- If second-pass confidence for Yes ≥ 0.5, flip
- Healthy flip-rate band: 15–40% (outside this range, either the base pass is too strict or the second pass is too permissive)
- Behind flag `SCORING_COT_SECOND_PASS` (default off)

**Acceptance test:**
- Flip-rate lands in the 15–40% band
- On fw3 × 10: recall + on measures where the pipeline currently scores No with weak matched-evidence quotes
- Cost delta: ~$0.17 per 22-bank run — verify against budget

**Effort:** S. Built and tested offline; port to Node ~1 day.

**Interaction constraints:**
- Opposite direction from U9 Layer 2 (which downgrades Yes → No). No conflict, but measure separately.
- Order-independent with T3.3 (U11)

---

### T3.5 — U14: cross-measure aggregation via `paired_rf_measureId`

**Why:** one generic quote fires the same Yes on 3–4 unrelated measures. The Bank of America supplier-code sentence example: same generic quote accepted as evidence for 3 distinct fw8 measures. Same failure class as Walmart 2.3 in the iter-10 audit.

**What to do:**
- Schema field `paired_rf_measureId` already exists on measures
- In `pipeline.ts`, enforce declared dependencies at scoring time: measure 2.2 = Yes only if measure 2.1 = Yes for this company. Run in dependency order; parent verdict enters child prompt
- Reuses the framework-v2 rules engine substrate
- Behind flag `PAIRED_MEASURES_ENFORCED` (default off)

**Acceptance test:**
- Bank of America mitigation FPs on fw8 drop to zero (per Sprint report)
- Walmart 2.3 no longer fires from cross-measure quote reuse
- No regression on well-authored frameworks

**Effort:** S–M. ~1.5 days.

**Interaction constraints:** complementary with T3.3 (U11 sector routing) and T3.6 (U15 atomicity) — all three address cross-measure quote reuse from different angles.

---

### T3.6 — U15: compound-measure atomicity as construction rule C11

**Why:** the only lever that ever cracked the hardest measure class in the corpus. fw10 5.2 had 0 TP across 5 truth-Yes companies through three pattern rebuilds; splitting into 5.2a/5.2b/5.2c gave the pipeline surface area for 5 TP on 5.2c.

**What to do:**
- Add construction rule C11 to `server/lib/framework-v2/rules.ts`: detect measures whose definition contains coordinating conjunctions binding two independently-testable conditions, or that name two distinct evidence types
- Enforce decomposition into 2–4 atomic sub-measures with parent firing Yes if ≥2 children fire
- Rule fires at framework-*build*-time via the existing validator; doesn't need runtime plumbing
- Optional: script to re-split existing frameworks (fw3, fw8, fw11b) — separate work package

**Acceptance test:**
- Unit tests: compound-question detector flags coordinated conjunctions correctly, doesn't false-positive on well-authored measures
- New frameworks built after this ships automatically inherit the rule
- If we re-split fw3/fw8/fw11b: measured improvement on previously-0-TP compound measures

**Effort:** S for the rule; M for the re-split work.

**Interaction constraints:** independent; construction-time rule, not a runtime change.

---

### T3.7 — U12: LLM-direct adaptive-retrieval second track + union scoring

**Why:** the biggest F1 number in the entire corpus (+28pp F1 over the deployed app baseline; two-leg minimum at $1.24/run is 45% cheaper than the 3-leg). The only intervention that attacks the diagnosed root cause of the recall ceiling — the app currently runs a *fixed* retrieval procedure and cannot course-correct when the first search returns the wrong thing.

**What to do:**
- New `server/lib/llm-direct.ts`: per `(company × measure)`, LLM reads measure criteria, formulates its own search via `pplx_sdk`, reads results, re-searches if off-target, returns verdict with citations
- v2 refinements: vintage-aware source discovery, section-level PDF handling, two-pass reasoning
- New table `analysis_results_llm_direct` (or extend existing `analysis_results` with a `leg` column)
- Union layer: report Yes if any leg says Yes; emit `union_verdict`, `decided_by`, `leg_count_yes`, `primary_source_url`, `primary_source_quote`
- Cost controls: run LLM-direct only on cells where the source-grounded pipeline said No/Partial (~65% cost reduction, negligible quality loss); pre-launch mode as a cheap framework-quality gate
- Behind flag `LLM_DIRECT_LEG` (default off)

**Acceptance test:**
- Standalone LLM-direct-v2 leg on fw3 × 10: F1 within 5pt of the offline-measured 75.1%
- Union (App + LLM-direct): F1 + ≥ 15pt over App alone
- Cost per 25-company run ≤ $1.30 for two-leg minimum

**Effort:** L. 3–5 days per the I77 spec + ~1 day for the union layer.

**Interaction constraints:**
- **REQUIRES U9 Layer 1 (T1.3) shipped and stable** — LLM-direct has hallucinated-citation risk; verbatim verification is the exact control
- Not compatible with running unmeasured — must A/B against source-grounded pipeline
- Does NOT crowding-out the primary leg (independent pack)

---

### T3.8 — U16: deterministic verdict caching keyed on sorted URL list

**Why:** not a quality lever, but what makes weekly runs over a 100+ company universe economically routine. Verified: 833,830 DeepSeek tokens (~$0.23) → 36/36 cache hits, 0 tokens, $0.00 on second run. Weekly cost projection 100 companies: ~$18 → ~$0.50 once warm.

**What to do:**
- Re-key the verdict cache on `(company, measureId, sorted URL list, evidence_patterns_hash, weak_patterns_hash, framework_version, expected_yes_rate_hash, fallback_criterion_hash)` rather than extracted content
- Extracted content is non-deterministic across `content.fetch(prompt=...)` calls — verified 29K vs 34K chars on identical calls
- Preserve existing `CIQ_FORCE_FRESH_SCORING` bypass

**Acceptance test:**
- Two consecutive runs of the same batch: run 1 populates cache, run 2 hits ≥90% of cells
- No verdict staleness on framework changes: change `expected_yes_rate` and confirm cache re-evaluates
- Cache correctly invalidates on framework version bump

**Effort:** M. ~2 days including the cache-key hashing surface.

**Interaction constraints:**
- Ships **after** U2 (base-rate prior — landed) so cache key includes `expected_yes_rate_hash`
- Must invalidate on any framework field that affects the verdict — the offline implementation enumerates them; use it as the spec

---

### T3.9 — U4: locale-table coverage audit

**Why:** production has multilingual discovery (`MULTILINGUAL_DISCOVERY_ENABLED`) and a `localeProfile` table. The offline Sprint 9c work identified 24 language communities + a 400+-issuer name-token heuristic. **SMFG fw3: 1 → 17 cells vs truth 18.** Largest per-cell error reduction observed anywhere. Might already be closed in production — verify first.

**What to do:**
- Grep `discovery.ts:3523` for the current `localeProfile` table
- Compare against the 24-community list: JP, CN, ES, IT, FR, DE, IN, KR, BR, RU, AR, TR, TH, VI, ID, NL, PL, SV, DA, NO, FI, PT-PT, MX, ZA, SG, HK, TW
- If gaps: port the missing communities and the 400+-issuer name-token heuristic
- Confirm `MULTILINGUAL_DISCOVERY_ENABLED` is on in the deployed environment

**Acceptance test:**
- Coverage inventory: ≥ 24 communities in the deployed table
- On fw3 × 22 banks (once we have that universe): non-English companies show materially higher URL counts than the pre-U4 baseline

**Effort:** S. ~half a day for the audit; a few hours of data entry if gaps confirmed.

**Interaction constraints:** T1.4 (U3 force-translation) depends on this — no point forcing translation on a company whose native URLs never got discovered.

---

## Section 6 — Interaction constraints and measurement discipline

Consolidated so the sequence is not violated by mistake.

**Hard constraints (violating these produces silently wrong measurements):**

1. **U12 (T3.7) requires U9 Layer 1 (T1.3)** — LLM-direct without verbatim verification adds hallucinated citations to the corpus
2. **U16 (T3.8) requires U2 (shipped)** — cache key must hash `expected_yes_rate`; otherwise silent staleness on framework prior changes
3. **CSV cross-check (T1.5.4) requires PR #5** — depends on `resolveViaFmp` + `validateIsin` from that PR
4. **CDN admission (T3.2) after U17 Fix B (T1.2)** — provenance labels must be consistent before adding a new provenance layer

**Soft constraints (violation produces uninterpretable results but not broken code):**

- **U8 (T2.2) before U9 Layer 2 (T2.1)** — both attack FP populations; ship U8 first, measure, then A/B U9 stacking
- **U3 (T1.4) after U4 (T3.9)** — force-translation is only useful if the URLs got discovered
- **Never bundle items with overlapping FP/FN targets into the same measurement window**
- **Report per-leg standalone metrics alongside ensemble metrics** — ensembles hide component damage (lesson E3)

**Truth-baseline A/B protocol (unchanged from the earlier register):**

1. Set flag `off` on all under-test items
2. Run the target batch (fw3 × 10 for Tier 1 items; expand as universe grows)
3. Set the flag `on` (only one item at a time)
4. Re-run the target batch (via `scoreOnly: true` where the change is scoring-only, or a full re-analysis where retrieval is affected)
5. Compare against the primary-source truth baseline (never against a previous iteration's verdicts — always against truth)
6. Attribute movement to the flag; write a delta report following the iter-11 → iter-12 template
7. If the delta is directionally right and the cost is acceptable, default the flag `on` (this is the promotion step — separate from the initial ship)

---

## Section 7 — Recommended execution sequence

**Sprint N (7–8 days):** T1.1 (iter-13 measurement), T1.2 (U17 Fix B), T1.3 (U9 Layer 1 — paired with T1.2 for shared mechanism), T1.4 (U3 force-translation), then the Tier-1.5 housekeeping items (T1.5.1 Prudential ticker, T1.5.2 PR merges, T1.5.3 apply script if #7 merges, T1.5.4 CSV cross-check).

**Sprint N+1 (~1 week):** T2.2 (U8 ML filter — highest-evidence single lever), T2.1 (U9 Layer 2), T2.3 (U10 restructured arbiter), T2.4 (U6 competitor-collision), T2.5 (U5 firing-rate dashboard — order-flexible).

**Sprint N+2 (~1 week):** T3.1 (U7 browser hardening), T3.2 (CDN admission), T3.3 (U11 sector routing), T3.4 (U13 CoT second pass). Recovers the largest single-precision lever (U11) and attacks the 62% FN class (U13) simultaneously.

**Sprint N+3 (~2 weeks):** T3.7 (U12 LLM-direct + union), T3.5 (U14 paired-measure enforcement), T3.6 (U15 atomicity rule), T3.8 (U16 deterministic cache), T3.9 (U4 locale coverage audit). Structural investments with biggest ceiling and lowest run costs.

**Cross-sprint (continuous):**
- Truth-baseline A/B every item independently before default-on promotion
- Per-mechanism firing-rate telemetry (T2.5, once landed)
- Never bundle FP/FN-overlapping items into one measurement window
- Report per-leg standalone metrics alongside ensemble metrics

---

## Section 8 — Quick-reference execution table

| ID | Title | Tier | Effort | Depends on | Predicted lift | Acceptance test key metric |
|---|---|---|---|---|---|---|
| T1.1 | Iter-13 rerun on fw3 × 10 | 1 | S | ISIN apply (done), U2 (done), U17 Fix A (done) | Baseline measurement, not a change | Interpretable per-company Δ vs iter-11/12 |
| T1.2 | U17 Fix B: scoring-time provenance gate | 1 | S–M | U17 Fix A + backfill (done) | Precision + on Newmont 2.4 and similar | Third-party quote downgrade rate + zero first-party downgrades |
| T1.3 | U9 Layer 1: verbatim + tier gating | 1 | S–M | Ships paired with T1.2 | Precision 82.5% → 84.4% (from soak); catches fabricated citations | 30/30 regression tests pass; 0 logic-FNs |
| T1.4 | U3: force translation for non-English companies | 1 | S | Ideally after T3.9 | Recall + ~13 cells across three frameworks | Translation-count increase on Toyota/Samsung/Nestlé |
| T1.5.1 | Fix Prudential ticker | 1.5 | S | — | Cleanup only | Row updated |
| T1.5.2 | Merge PRs #5, #6, #7 (or close #7) | 1.5 | S | — | Cleanup only | PRs closed / merged |
| T1.5.3 | Apply-proposals CLI (if #7 merges) | 1.5 | S | PR #7 merged | Optional workflow | `--apply` mode works |
| T1.5.4 | CSV upload ISIN cross-check | 1.5 | S | PR #5 merged | Prevents right-format-wrong-issuer at ingest | Unit tests pass |
| T2.1 | U9 Layer 2: cross-provider semantic check | 2 | S | T1.3 stable, T2.2 measured | Precision + ~0.05 | Precision + on topically-adjacent measures |
| T2.2 | U8: per-measure ML filter τ=0.30 | 2 | M | Truth-labelled data ≥15 Yes/measure | F1 + ~0.08; 24/51 FPs removed | Per-framework threshold sweep at optimum |
| T2.3 | U10: restructured arbiter as quote judge | 2 | S–M | SCORING_CASCADE already on | Arbiter agreement-with-primary drops to 50–65% | Kering 1.3 regression resolves |
| T2.4 | U6: competitor-collision penalty | 2 | M | FIGI aliases populated (in progress) | Prudential 1.1 iter-11 audit case resolves | Unit tests + Prudential doc rejection |
| T2.5 | U5: firing-rate audit dashboard | 2 | S | — | Diagnostic — reveals zero-firing mechanisms | Every flagged mechanism reports firing-rate |
| T3.1 | U7: browser fallback hardening | 3 | S–M | — | Nestlé + Ambev complete iter-14 | `circuit_broken` reduced ≥90% |
| T3.2 | CDN admission rule | 3 | S | T1.2 (U17 Fix B) | Ambev third-party share 69% → 5-15% | CDN-hosted issuer PDFs classified first_party |
| T3.3 | U11: sector-scope routing | 3 | S–M | T3.5 for framework metadata | fw8 precision + 0.22, F1 + 0.04, cost − ~30% | Skips 100% correct against truth |
| T3.4 | U13: CoT second pass on borderline No | 3 | S | ai-providers.ts (done) | Recall + on 62% FN class | Flip-rate in 15–40% band |
| T3.5 | U14: paired-measure enforcement | 3 | S–M | — | BofA mitigation FPs → 0 | Walmart 2.3 cross-measure reuse resolves |
| T3.6 | U15: atomicity rule (C11) | 3 | S | — | Compound-question detector works | New frameworks inherit; fw10-5.2-style measures fixable |
| T3.7 | U12: LLM-direct + union scoring | 3 | L | T1.3 (U9 Layer 1) MUST be stable | Standalone 75.1% F1; union +28pp | Cost per run ≤ $1.30 for two-leg |
| T3.8 | U16: deterministic verdict cache | 3 | M | U2 done | Weekly cost $18 → $0.50 warm | ≥90% cache hits on second run |
| T3.9 | U4: locale-table coverage audit | 3 | S | — | SMFG-style: 1 → 17 cells / 18 truth | ≥24 language communities in production table |

---

## Section 9 — Items deliberately NOT in this plan

For completeness — these were considered and rejected or deferred, with reasons.

- **Offline C1–C17** (interventions that didn't work in Sprint 9d ablation) — not carried forward. Only revisit if the underlying mechanism assumption changes
- **D4 partial-credit end-to-end** — currently a footgun. Product-scope question, not engineering. Decide separately: commit to Partial as a real scored state, narrow it to specific measures, or eliminate it
- **D6 adversarial two-model verification** — subsumed by T2.3 (U10 arbiter) + T2.1 (U9 Layer 2)
- **D7 routine truth re-audit** — already productionised as `truth-check.ts` + bulk explore-truth button. Ship as an analyst SOP (monthly re-audit), not a code change
- **The `sector_scope: agnostic|specific` deprecation** — resolved by T3.3 (U11 sector routing under evidence-absent). The two goals reconcile; no re-deprecation needed
- **Framework transformer as final artefact** — remains a first-draft tool; author review is the correct architecture. Not a change, a workflow reminder

---

## Appendix A — Cross-reference to earlier registers

| This roadmap | Unified Change Register (2 Sep) | Interventions Register (2 Sep) | Live-audit source |
|---|---|---|---|
| T1.1 | — (new — measurement, not a change) | — | This-session ISIN work |
| T1.2 | U17 Fix B | — | iter-12 Newmont diagnosis |
| T1.3 | U9 Layer 1 | A2 | Sprint 1 |
| T1.4 | U3 | A10 | Sprint 9d rev3 |
| T1.5.1–4 | — (new — housekeeping identified this session) | — | This session |
| T2.1 | U9 Layer 2 | A2 | D3 |
| T2.2 | U8 | A1 | Sprint 9d |
| T2.3 | U10 | D6 (offline) | D1 iter-11 |
| T2.4 | U6 | — | D4 iter-11 |
| T2.5 | U5 | E5 | — |
| T3.1 | U7 | E2 residue | D2 iter-11 |
| T3.2 | — (new — surfaced by this-session audit) | — | Newmont / Ambev CDN observations |
| T3.3 | U11 | A7 | — |
| T3.4 | U13 | D3 (offline) | — |
| T3.5 | U14 | D5 (offline) | — |
| T3.6 | U15 | A8 | — |
| T3.7 | U12 | A4 + A5 | — |
| T3.8 | U16 | A11 | — |
| T3.9 | U4 | A6 (delta) | — |

---

## Appendix B — Session artefacts (all under `memory/sessions/2026-08-31_2026-09-06/`)

- `5f780dff/ai_outputs/CompanyIQ-v3--Unified-Change-Register.md` — the 17-item register with full evidence per item
- `5f780dff/ai_outputs/CompanyIQ-Interventions-Lessons-Register.md` — 58-item Sections A/B/C register with which items are in production
- `5f780dff/ai_outputs/CompanyIQ-v3--Session-Handover.md` — iter-11/12 baseline, deploy state, and Tier 1 status
- `5f780dff/ai_outputs/Sprint-1-Mode-A--ServerLib-Integration-Spec-U9-Layer-1-source.md` — T1.3 implementation spec (verbatim + tier gating)
- `5f780dff/ai_outputs/Sprint-1-validate.py-Check-A--Check-B-reference-implementation.py` — Python reference for T1.3
- `5f780dff/ai_outputs/Sprint-1-regression_suite.py-30-test-verbatim-match-acceptance-suite.py` — 30-test acceptance suite for T1.3
- `5f780dff/ai_outputs/Sprint-1--tier2_outlets.json-accepted-Tier-2-outlet-list.json` — Tier-2 outlet allow-list for T1.3 Check B
- `5f780dff/ai_outputs/CompanyIQ-v3--Primary-Source-Truth-Baseline-22-Banks--fw3fw8.md` — truth baseline for A/B testing
- `f86fc7fb/ai_outputs/CompanyIQ-v3-PR-1--PR-2-Handover-Summary.md` — PR#1 + PR#2 deploy summary
- `../companyiq-refs/companyiq-v3/scripts/audit_dry_run_2026-09-03.json` — this-session domain-and-ISIN audit dry-run
