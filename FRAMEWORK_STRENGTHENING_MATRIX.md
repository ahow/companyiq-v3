# Framework-Strengthening Matrix — Scoring-Integrity Issues, Generalised Solutions, and Verification Tests

**Scope.** This document describes the scoring-integrity weaknesses surfaced by a multi-company review as **generalised framework problems** — i.e. defects in how *any* company × *any* framework-measure is scored — together with the **generalised, framework-level fix** for each and the **automated test** that proves the fix is in place. Company names (Adani, PNC, ING, Accenture, Alibaba, …) appear only as illustrative instances of a general pattern; none of the fixes or tests encode a company, a ticker, a topic, or a specific framework. The fixes are topic-agnostic and apply unchanged to any company list or framework the engine is pointed at.

**Design constraints honoured by every fix below.**
- When attribution is in doubt, prefer recognising genuine first-party evidence over blind downgrading (the gate only downgrades when it can find *no* valid same-measure attribution).
- No change to scoring math, search-call volume, concurrency/throughput, the OpenRouter LLM fallback, or any env kill-switch default (`ENTITY_ATTRIBUTION_GATE` stays on, `U17_SCORING_TIME_GATE` stays off).
- Advisory flags are **display/audit only** — they never change a verdict or a score. Only the `entity-attribution` flag gates, and the gate change here can only **reduce** false downgrades (strictly safe).

---

## Summary table

| # | Generalised problem | Generalised framework solution | Verification test(s) | Status |
|---|---------------------|-------------------------------|----------------------|--------|
| 1 | **First-party evidence on a sibling own-brand domain is falsely downgraded.** The entity-attribution gate only recognised the DB apex domain + related-domains, so genuine first-party disclosure served from a *different host owned by the same issuer* (e.g. a per-division brand domain, an IR sub-brand, a localized site) was treated as third-party and the verdict was forced to No / score 0. | **Brand-aware own-domain recognition.** Derive brand tokens from the company identity (name minus legal suffixes, ticker, aliases) and accept a source host as first-party when the host embeds a company brand token **and** the passage uses strict first-party possessive language (`we/our/us/ours/ourselves`). Does not use the generic "the company" set on this path, so third-party case studies on a vendor's own marketing host are still rejected. Strictly reduces false downgrades. | `eligibility-flags.test.ts`: `BUG1: own-brand sibling domain + 'our'/'we'`, `BUG1: entity-attribution does NOT fire on Adani own-report cell`, `BUG1: own-brand host + generic 'the company'` (negative) | ✅ Fully implemented + tested |
| 2 | **A "confident 0%" is indistinguishable from "we never found the evidence".** A measure scored 0 because essential primary disclosure was never retrieved looks identical, in the output, to a measure genuinely assessed and found absent — inflating apparent confidence in a 0. | **Evidence-completeness derivation.** Compute, per measure/company, whether essential declared doc types were retrieved and whether any first-party evidence exists; label a 0 as `insufficient-evidence` when nothing essential was found and `confident` otherwise. Purely additive output field; never changes the score. | `research-state.test.ts`: `BUG2.1`–`BUG2.6` (insufficient vs confident 0, non-zero never relabelled, no-declared-docs → cannot judge, malformed input safe) | ✅ Implemented (additive label) + tested |
| 3 | **Checklist shows a disclosure "not found" when it is embedded in a broader retrieved report.** Doc-type checklists required an exact doc-type token match, so a disclosure that lives *inside* a retrieved annual / integrated / sustainability / ESG report (rather than as a standalone document) was reported as missing. | **Embedded-disclosure reconciliation, keyed on document NATURE (topic-neutral).** A required doc type that *names narrative disclosure content* (report / disclosure / statement / review / analysis / assessment) and is not itself an umbrella or standalone statutory filing is satisfied when a first-party corporate umbrella report (annual / integrated / sustainability / ESG) embedding it was retrieved. A *governance artefact* (policy / charter / code) and standalone/statutory filings (10-K, 20-F, annual report) still require a direct match. Keys off document nature, **not** subject matter — applies equally to climate, AI-governance, human-rights, cyber, etc. | `research-state.test.ts`: `BUG3.1`, `BUG3.2`, `BUG3.3` (non-climate disclosure embeddable; policy still direct), `BUG3.3b` (standalone 10-K/20-F NOT satisfied by embedding), `BUG3.4` | ✅ Fully implemented + tested + **generalised** |
| 4 | **The same quote is silently reused as evidence across unrelated measures.** One passage can be counted as independent support for several different measures, overstating breadth of evidence. | **Cross-measure quote-reuse advisory.** Normalise quote text (case/whitespace-insensitive, short fragments ignored) and flag passages that appear as evidence in **more than one** measure. Advisory only — surfaced for audit, never changes any verdict or score. | `research-state.test.ts`: `BUG4.1`–`BUG4.4` (reuse detected, intra-measure not flagged, short/whitespace handling, malformed input safe) | ✅ Implemented (advisory) + tested |
| 5 | **Mislabelled / outdated source labels go unnoticed.** A supporting quote whose in-text year post-dates the year in its source label indicates a mislabelled or stale citation, but nothing surfaced it. | **Source-label-mismatch advisory.** Compare the year parsed from the quote text against the year in the source label; raise an advisory when the quote year exceeds the label year. Advisory only; never changes score. | `eligibility-flags.test.ts`: `BUG5: source-label-mismatch FIRES when quote year (2024) > label year (2021)`, `BUG5: ... CLEARS when quote year matches label year` | ✅ Implemented (advisory) + tested |
| 6 | **Third-party / wrong-entity evidence can pass as first-party.** Evidence hosted on a known analyst / news / aggregator domain (or about a different sub-entity) could be attributed to the target. The brand waiver in #1 must not re-open this hole. | **Third-party-host negative guard + advisory.** A reusable `isThirdPartyHost()` classifies known analyst/news/aggregator host suffixes; the brand-domain waiver (#1) **never** whitelists such hosts, so third-party-sourced evidence stays correctly unattributed and the existing gate still catches it. An `evidence-on-third-party-host` advisory flag is raised for audit. | `eligibility-flags.test.ts`: `BUG6: Morningstar host ... NOT attributed`, `BUG6: entity-attribution FIRES on PNC Morningstar cell (still rejected)`, `BUG6: evidence-on-third-party-host advisory flag FIRES`, `BUG6: isThirdPartyHost true/false`, `BUG6: third-party-host flag does NOT fire on own-domain evidence` | ✅ Fully implemented + tested |

---

## Detail per issue

### Issue 1 — First-party evidence on a sibling own-brand domain falsely downgraded (highest priority)

**Generalised problem.** The entity-attribution gate decides whether a measure's supporting quotes are attributable to the target company. Its own-domain recognition keyed only off the company's DB apex `domain` and `related_domains`. Large issuers routinely publish first-party disclosure on *other* hosts they own — division brand sites, investor sub-brands, localized domains. For any such company the gate classified genuine first-party disclosure as third-party and forced `verdict = No`, `score = 0`.

**Generalised solution.** Add brand-aware own-domain recognition (`isOwnBrandDomainSource`, driven by `companyBrandTokens`): a host counts as first-party when it contains a brand token derived from the company identity (core name with legal suffixes stripped, ticker, aliases) **and** the passage uses strict first-party possessive language (`FIRST_PARTY_POSSESSIVE_REGEX = /\b(we|our|us|ours|ourselves)\b/i`). The strict possessive set — rather than the looser "the company" set — keeps vendor case-study language on a vendor's own marketing host from being mis-attributed. This aligns with Rule 1 (First-Party Domain Waiver) and Rule 5 (Possessive & Unit Match) of the gate-refinement master rules, and preserves the Negative Rules (case-study penalty; generic-news no-waiver). The change can only *reduce* false downgrades — it never introduces a new downgrade — so it is safe and needs no kill-switch default change.

**Files.** `server/lib/eligibility-flags.ts` — `companyBrandTokens`, `isOwnBrandDomainSource`, `FIRST_PARTY_POSSESSIVE_REGEX`, applied in `reviewQuoteAttribution` (brand-domain waiver branch). Application point unchanged in `server/lib/analyzer.ts` (gate still fires only when `attributedCount === 0`).

### Issue 2 — Confident-0 vs insufficient-evidence

**Generalised problem.** A score of 0 conflates two very different states: "assessed and genuinely absent" and "essential source material never retrieved". Consumers of the output cannot tell a trustworthy 0 from an evidence gap.

**Generalised solution.** `deriveEvidenceCompleteness` (in `shared/research-state.ts`, surfaced on the company-detail response as `evidenceCompleteness`) classifies a 0 as `insufficient-evidence` when no essential declared doc type and no first-party evidence were found, and `confident` otherwise; non-zero scores and "no declared essential doc types" are never relabelled. Additive output only — the numeric score is untouched.

### Issue 3 — Embedded-disclosure checklist reconciliation

**Generalised problem.** Doc-type checklists mark a disclosure "not found" unless a standalone document of that exact type was retrieved, even when the disclosure is embedded in a broader first-party report that *was* retrieved.

**Generalised solution.** `deriveEssentialDocChecklist` treats a required doc type as satisfied-via-embedding when it is an *embeddable thematic disclosure* — `isEmbeddableDisclosureDocType` returns true for a type that names narrative disclosure content (`NARRATIVE_DISCLOSURE_REGEX`) and is not an umbrella/standalone type (`STANDALONE_DOCTYPE_REGEX`) — and a retrieved first-party doc matches `UMBRELLA_REPORT_REGEX`. This keys off **document nature, not subject matter**, so it carries no climate/topic/framework hardcoding and generalises to any topic (a Human-Rights or Cyber-Risk *Disclosure* is embeddable exactly like a Climate Disclosure; any *Policy* must be found directly).

### Issue 4 — Cross-measure quote reuse

**Generalised problem.** A single passage reused as evidence across multiple measures overstates how much independent evidence supports a company.

**Generalised solution.** `deriveQuoteReuse` normalises quote text and reports passages used in more than one measure (`quoteReuse` on the response). Advisory only.

### Issue 5 — Source-label / date mismatch

**Generalised problem.** A quote whose in-text year is later than its source-label year signals a mislabelled or stale citation.

**Generalised solution.** `flagSourceLabelMismatch` raises the `source-label-mismatch` advisory when the quote-text year exceeds the source-label year. Advisory only.

### Issue 6 — Third-party-host evidence

**Generalised problem.** Evidence from analyst / news / aggregator hosts, or about a different sub-entity, can be mis-attributed to the target — and the Issue-1 brand waiver must not widen this.

**Generalised solution.** `isThirdPartyHost` (exported, reusable) classifies known third-party host suffixes; the brand waiver never whitelists them, so such evidence stays unattributed and the existing gate catches it. `flagThirdPartyHost` raises the `evidence-on-third-party-host` advisory for audit. Aligned with the master-rules Negative Rule "Generic News: do not apply the Domain Waiver to third-party news sites."

---

## Mapping to the developer-spec build-time acceptance tests

The spec's *Build-time acceptance tests* catalogue frames these as release-blocking checks. The fixes above correspond to:

- **Evidence-fixture test 2 (Positive/negative boundary)** — each authored positive/negative example becomes an executable regression fixture: Issues 1 & 6 add paired positive (own-report preserved) and adversarial (third-party rejected) fixtures.
- **Evidence-fixture test 3 (Vehicle invariance)** — "the same qualifying quote … verdict must be unchanged": Issue 3 makes an embedded disclosure in a broader report satisfy the checklist the same as a standalone document.
- **Evidence-fixture test 7 (Cross-measure exclusivity)** — Issue 4 surfaces when one quote is reused across measures.
- **Evidence-fixture test 8 (Time/supersession)** — Issue 5 surfaces outdated/mislabelled citations.
- **Schema/authoring check 9 (generic-keyword flag)** and **Calibration check 3 (top scores require topic-specific core controls)** — Issue 2's confident-vs-insufficient label supports distinguishing a real 0 from an evidence gap during calibration.

---

## How to run the verification tests

```bash
cd /home/ubuntu/github_repos/companyiq-v3

# Entity-gate / advisory flags (Issues 1, 5, 6):
DATABASE_URL=postgres://x:y@localhost:1/z npx tsx server/lib/eligibility-flags.test.ts

# Checklist / completeness / quote-reuse (Issues 2, 3, 4):
DATABASE_URL=postgres://x:y@localhost:1/z npx tsx --test server/lib/research-state.test.ts

# Typecheck (must not add errors vs baseline):
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | wc -l
```

**Current results (verified):** research-state = 33 pass / 0 fail; eligibility = 53 pass / 4 fail where **all 4 failures are pre-existing on `main`** (own-domain attribution behaviour at the base own-domain rule, confirmed identical on parent commit `c9173c0`) and are unrelated to these fixes; typecheck = 63 errors with and without these changes (zero new errors).

---

## Whole-codebase generalisation audit

Scope of the active ask: *"review the entire code to ensure there are no topic, framework, or company specific elements included in the application code which would not generalise to any topic or company list."* The audit covered `server/lib/`, `shared/`, and `client/src/` (scoring, analyzer, ranking, prompt assembly, retrieval, discovery, eligibility/attribution, checklist).

### Verdict

The core scoring path is **framework-parameterised and topic-agnostic by design.** Topic terms are derived *per framework* at runtime (`server/lib/topic-lexicon.ts`, LLM-derived + cached; `deriveTopicTerms` deterministic fallback) rather than hardcoded. There is **no framework-id branching in scoring logic, no per-company logic, and no per-company discovery URLs** anywhere in application code.

### The one genuine behavioural topic-lock found — and fixed

Issue 3's original embedded-disclosure reconciliation keyed on **climate-specific** doc-type regexes (it only recognised a disclosure as embeddable if it was a *climate* document). That is the only place where behaviour differed by subject matter. It has been **generalised** (this session) to key on **document nature** (`isEmbeddableDisclosureDocType` / `NARRATIVE_DISCLOSURE_REGEX` / `UMBRELLA_REPORT_REGEX` / `STANDALONE_DOCTYPE_REGEX` in `shared/research-state.ts`), so it now applies identically to climate, AI-governance, human-rights, cyber, or any future topic. Covered by `BUG3.3` (non-climate disclosure embeddable) and `BUG3.3b` (standalone filing still requires a direct match).

### Topic-leaning literals that are present but do NOT break generalisation

These are topic-*aware* infrastructure that degrade gracefully (no-op) for other topics. Removing them would **regress** the production climate framework without improving generalisation, so they are intentionally retained:

| Location | Literal | Why it is a graceful no-op |
|---|---|---|
| `server/lib/query-expansion.ts` (`REPORT_TYPE_SYNONYMS`) | report-type synonym map | Only fires when the *framework's own* `requiredDocTypes` matches a key; otherwise falls back to the literal term. Never injects climate terms into a non-climate search. |
| `server/lib/disclosure-document-types.ts` (`RANK_BOOSTS`) | per-doc-type rank boosts | Boosts the *framework's own declared* disclosure vehicles; topic-specific entries simply never match for other topics. |
| `server/lib/retrieval-targeting.ts` (`DOC_TYPE_CANONICAL`) | `climate`/`tcfd` canonical tokens | Only misfire if a *non-climate* framework literally labels a vehicle "climate"/"tcfd" (not a realistic case); otherwise inert. |
| `server/lib/discovery.ts` (`UNIVERSAL_PRIORITY_DOMAINS`, `excludedDomains`) | cross-topic registry/exclusion lists | Deliberately broad, cross-topic domain registry; `cdp.net`/`sciencebasedtargets` sit in an *exclusion* list alongside AI job-boards and tech-news, i.e. used to filter noise, not to inject topic bias. |

### Company names

Company names (Adani, PNC, Accenture, Metro de Madrid, etc.) appear **only in explanatory code comments and in test fixtures** — never in scoring/attribution logic branches. These are legitimate real-world regression anchors and documentation; removing them would reduce maintainability without changing behaviour, so they are retained.

### Audit conclusion

No non-generalising element remains in application scoring behaviour. The single genuine topic-lock (Issue 3) is fixed; the remaining topic-aware literals are graceful no-ops that benefit the shipped climate framework and harm nothing else.
