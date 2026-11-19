# CompanyIQ v3 — Scoring-Integrity Remediation Plan

**Date:** 2026-11-17
**Author:** diagnosis grounded in the current `main` tree (HEAD `47115ad`)
**Scope rule:** every fix below is a *generalised* rule keyed on document provenance,
document nature, declared framework metadata (`requiredDocTypes` / disclosure
vehicles) or reporting-entity identity — **never** on a company, framework id,
sector or individual measure. Where an existing fix is suspected of being
case-specific (which is why issues "thought addressed" regressed), it is called
out explicitly.

The reviewer raised seven symptoms. Several share a single root cause, so this
plan is organised by root cause, not by symptom, and maps each symptom to its
cause in the summary table at the end.

---

## Why the earlier fixes regressed

The previous round fixed each symptom at the point where it was *observed* rather
than at the mechanism that produces it. Two of those point-fixes over-corrected:

- The checklist "not found for everyone" fix (`42e2588`) swung to "found for
  everyone" because it lets a thematic required document be satisfied by *any*
  umbrella report **without checking the umbrella actually contains that
  disclosure**.
- The attribution-gate recall fixes (`40a353e` + master-rules Rules 1–8) were
  tuned to *recover* false-negative "No"s. They raised recall with no matching
  precision rule, so they now over-attribute subsidiary/affiliate evidence and
  still trip on genuine primary filings whose quoted span lacks a pronoun.

The durable answer is to make each decision key off **structural facts that are
stable across runs and frameworks** (what kind of document this is, whose
document it is, whether the disclosure is actually present in the text) instead of
surface heuristics (a title token, a pronoun in one sentence, a topic keyword
anywhere in the corpus).

---

## Root cause 1 — Document checklist is satisfied by embedding without a content check

**Symptom:** "TCFD/IFRS S2 report: found" for all 50 companies, including firms
whose evidence contains no TCFD report (Hanmi, Jiangsu Zhongtian, MAA, Grupo
Aeroportuario del Pacífico).

**Location:** `shared/research-state.ts` — `deriveEssentialDocChecklist()`,
`matchesEmbeddingReport()`, `UMBRELLA_REPORT_REGEX`, `NARRATIVE_DISCLOSURE_REGEX`
(≈ L432–560).

**Mechanism (traced):** a required doc type such as *"TCFD / IFRS S2 report"*
passes `isEmbeddableDisclosureDocType()` (it names narrative content — "report" —
and is not a standalone statutory filing). `matchesEmbeddingReport()` then returns
`found` for that required type **as soon as any retrieved first-party document's
title/URL matches `UMBRELLA_REPORT_REGEX`** (annual / integrated / sustainability
/ ESG / responsibility report). Because almost every company has *some* annual or
sustainability report, the thematic requirement is marked "found — embedded" for
almost everyone. The embedding decision never inspects the umbrella document's
*content* for the thematic disclosure; it trusts the container's title alone.

**Generalised fix:** keep the topic-neutral "thematic disclosures can live inside
an umbrella report" model, but require **positive content evidence** that the
disclosure is actually present before marking it found-via-embedding:

1. An embeddable required type is marked `found` via an umbrella report **only if
   that umbrella document's extracted content contains the required type's own
   terms** (the same `matchesDocType` token test already used for direct matches,
   run against the document *body*, not just title/URL). No content hit → the type
   is **not** satisfied by that umbrella.
2. Introduce a distinct status `embedded` (or reuse `partial` with an explicit
   detail) so the reviewer sees *"present inside the annual report"* versus
   *"standalone document retrieved"* — never a bare "found" that implies a
   dedicated report exists.
3. If no eligible document — standalone or umbrella-with-content — satisfies the
   type, it stays `not_found`, which is the honest state for the firms the
   reviewer flagged.

This keys only off document nature + presence of the disclosure's own terms in
text, so it holds for any topic (climate, AI-governance, human-rights, cyber) and
any framework's `requiredDocTypes`.

**Verification:** unit tests in `research-state.test.ts` — (a) an umbrella report
whose body contains the thematic terms → `embedded`; (b) an umbrella report with
no thematic terms in body → `not_found` (this is the Hanmi/MAA case); (c) a
retrieved standalone report of the type → `found`. Plus a spot re-check on the
named companies in a preview batch.

---

## Root cause 2 — Coverage/"suspect" level ignores per-measure sourcing

**Symptom:** Grupo Aeroportuario del Pacífico rated "full" coverage although 8 of
its measures have no source; the earlier "suspect" warning was lost.

**Location:** `server/lib/pipeline.ts` corpus-validity block (≈ L1040–1095);
`server/lib/discovery.ts` `coverageLevel` tiering (L755–877).

**Mechanism (traced):** the "suspect" downgrade fires **only** when the corpus
contains no document whose *text* matches framework keywords
(`contentPattern` / `frameworkDataPatterns`) **and** there are ≥5 documents with
readable content. `coverageLevel` itself is a function of document *tier counts*
(how many Tier-1/2/3 documents were fetched), not of how many measures ended the
run with real evidence. A company can therefore have a keyword-matching
sustainability report and a healthy document count — hence "full" — while 8
individual measures retrieved nothing usable. Coverage is measured on the
*corpus*, never reconciled against the *scoring outcome*.

**Generalised fix:** make coverage a function of the actual per-measure sourcing
result, which is already computed during scoring:

1. After scoring, compute the share of measures that ended with ≥1 *eligible*
   supporting source (first-party, gate-passed). Call it `sourcedMeasureRatio`.
2. Downgrade coverage to **`suspect`** whenever `sourcedMeasureRatio` falls below
   a tunable threshold (`COVERAGE_SUSPECT_MIN_SOURCED_RATIO`, default e.g. 0.8),
   independent of document counts or keyword presence — i.e. "many measures have
   no source" is sufficient on its own to flag suspect.
3. Keep the existing keyword/data-presence check as an *additional* trigger (OR,
   not AND), so neither a thin corpus nor many unsourced measures can be masked by
   the other.
4. Surface the count ("N of M measures have no eligible source") in the same
   diagnostics object the dashboard already reads
   (`discoveryDiagnostics.coverage`).

Driven entirely by sourcing outcome + existing corpus signals; no company or
framework special-casing.

**Verification:** a pipeline-level test feeding a synthetic scoring result with
k unsourced measures and asserting `coverageLevel === "suspect"` once the ratio
crosses the threshold; re-run the flagged companies in preview and confirm the
warning returns.

---

## Root cause 3 — No cross-measure quote-reuse control

**Symptom:** reused quotes now support 44 "Yes" scores; one PPG passage (Valencia
flood) counts toward four measures.

**Location:** `server/lib/analyzer.ts` — each measure is scored independently with
its own pack from `buildEvidencePackForMeasure`; the verdict/quote assembly has a
*cross-company* reuse fingerprint (≈ L449) but **no cross-measure** dedup within a
company. Rescued passages (`server/lib/evidence-gate.ts`, `researchBestPassage` /
`gateEvidenceWithRepair`) can hand the same passage to several measures.

**Mechanism (traced):** because measures are graded in isolation, the same
high-salience passage legitimately surfaces in multiple measures' packs and is
quoted by each. Nothing reconciles the full set afterwards, so a single incident
("a flood in Valencia") can satisfy four distinct measures.

**Generalised fix (reviewer's "one quote → one measure"):** add a deterministic
post-scoring reconciliation pass over all of a company's measure results:

1. Fingerprint every supporting quote (normalised text hash — the same
   normalisation already used for the cross-company fingerprint).
2. When the *same* fingerprint supports a "Yes" on more than one measure, keep it
   on the **single best-fit measure** (highest passage-retrieval relevance score
   for that measure, deterministic tiebreak on measureId) and strip it from the
   others.
3. Any measure left with **no** distinct supporting quote after stripping is
   demoted from "Yes" (reverts to "No" with a reason, or abstains if the cell was
   evidence-thin) — it must stand on its own evidence.
4. Make it tunable (`SCORING_ONE_QUOTE_PER_MEASURE`, default **on**) and log each
   reassignment so the reviewer can audit it.

Purely structural (fingerprint + relevance ranking); no measure/framework
knowledge required, so it generalises across frameworks.

**Verification:** unit test with a crafted result set where one quote backs three
measures → after the pass it backs exactly one, the other two are demoted; metric
check on a preview batch that the reused-quote-supported-Yes count drops sharply.

---

## Root cause 4 — Attribution gate demands an in-span pronoun even on primary filings

**Symptom:** the gate downgrades genuine own-document scores — four on measure 22,
all from the companies' own filings (Klépierre 2025 URD, Gerdau, Wolters Kluwer,
PKO).

**Location:** `server/lib/eligibility-flags.ts` — `reviewQuoteAttribution()`
(L347–460). Own-domain attribution requires `isOwnDomainSource(...) && (PRONOUNS_
REGEX.test(text) || CJK_FIRST_PARTY_REGEX.test(text))`.

**Mechanism (traced):** the pronoun requirement was added to stop the "own
marketing page credits a client" pattern (the Accenture bug). But it is applied
uniformly to **all** own-domain documents, including primary regulatory filings. A
factual sentence in a company's own Universal Registration Document or annual
report ("the portfolio depends on district-heating networks…") carries no
"we/our" and does not repeat the company name, so it fails the pronoun test and is
treated as third-party — a false rejection. The guard over-triggers because it
keys on *linguistic cue in the span* rather than on *document class*.

**Generalised fix:** make attribution key off **document class**, which is
already classified elsewhere in the pipeline:

1. For a document that is a **verified primary/statutory filing or registration
   document on the issuer's own domain or an authenticated filing repository**
   (annual report, integrated report, 10-K/20-F, Universal Registration Document,
   sustainability/ESG report — the `STANDALONE_DOCTYPE_REGEX` family already
   defines these), **provenance alone establishes first-party attribution** — no
   in-span pronoun required. By its nature such a document is the issuer's own
   disclosure about itself.
2. Keep the pronoun/first-party-cue requirement **only** for *non-filing*
   own-domain pages (marketing, insights, thought-leadership, blog, case study),
   where the "describes another entity" risk is real.
3. Retain all existing negative rules (case-study penalty, third-party-host
   rejection) unchanged, so Morningstar/Reuters passages and client case studies
   are still rejected.

This distinguishes *filing* from *marketing page* — a document-nature test that is
topic/company/framework-agnostic.

**Verification:** unit tests — (a) a pronoun-free factual sentence from an
own-domain annual report / URD → attributed; (b) the same sentence from an
own-domain blog without a pronoun → not attributed; (c) a Morningstar passage →
still rejected. Re-check the four measure-22 downgrades in preview.

---

## Root cause 5 — No subsidiary/affiliate disambiguation (gate over-attributes)

**Symptom:** the gate misses real problems — PNC/Midland, ING Australia (back as
"Yes"), Manulife Philippines — evidence about a *subsidiary/affiliate* credited to
the parent.

**Location:** `server/lib/eligibility-flags.ts` — `reviewQuoteAttribution()` first
positive rule: `if (toks.some(t => lowerText.includes(t))) return attributedTo
Target:true`. Confirmed there is **no** subsidiary/affiliate handling anywhere in
the file (only comments mention it).

**Mechanism (traced):** a bare identity-token substring match attributes any
passage containing the parent's name/token to the target. When the passage is
actually about a distinct legal/geographic entity ("ING **Australia**",
"Manulife **Philippines**", a named subsidiary), the parent token still appears,
so it is wrongly attributed to the parent. The recall-oriented rule set has no
opposing precision rule for "names a *more specific* entity than the target".

**Generalised fix:** add a precision rule that runs **before** the bare-token
acceptance:

1. Detect when the passage names a **more specific reporting entity** than the
   target — the target's core name followed by a distinguishing qualifier
   (geographic token, "subsidiary/affiliate/unit/branch" noun, or a named
   subsidiary from the company record where available). This is detectable
   structurally: *target core name + adjacent qualifier that is not part of the
   target's own legal name*.
2. When such a mismatch is detected and the passage does **not** also establish
   the target entity itself as the actor, mark `attributedToTarget=false` with
   reason "names a distinct subsidiary/affiliate reporting entity".
3. Keep it conservative (require the qualifier to be adjacent to the core name) so
   ordinary mentions of the parent are unaffected; make the entity-attribution
   flag gate the score only in combination with the existing thresholds.

Keys off reporting-entity identity structure, not specific company names.

**Verification:** unit tests — "ING Australia launched…" with target *ING Group*
→ not attributed; "ING Group reports…" → attributed; a subsidiary named in the
company record → not attributed to parent. Re-check the three named cases in
preview.

---

## Root cause 6 — Scoring proceeds without the key primary reports loaded

**Symptom:** persistent 0% retrieval for Michelin, MAA, Grupo Aeroportuario,
Hanmi, Jiangsu Zhongtian, Hyundai Glovis; Michelin cites "Website Terms of Use".

**Location:** `server/lib/primary-disclosure-check.ts`
(`verifyLatestPrimaryDisclosure` → `{present, missing, targetedQueries}`,
L239–347); `server/lib/pipeline.ts` discovery/fetch; `server/lib/analyzer.ts`
`requiredDocPresent` flag (L158, L3251, L3295, L3645).

**Mechanism (traced):** the pipeline *computes* which primary disclosures are
missing and even builds targeted queries for them, but scoring still runs on
whatever was fetched — including low-value pages ("Website Terms of Use") — when
the primaries never arrive. There is no hard precondition that the latest
sustainability / TCFD-or-equivalent / annual-or-registration primary is actually
in the evidence set before grading; and when primaries are absent, the retriever
accepts junk pages rather than reporting the corpus as unfit.

**Generalised fix (reviewer's "make sure the key reports are loaded"):**

1. **Corpus-readiness precondition.** Before scoring a company, assert that the
   framework's *essential* primary families (derived from `requiredDocTypes` /
   disclosure vehicles via the existing `verifyLatestPrimaryDisclosure`) are
   present as eligible documents. These families are declared per framework, so
   the check is framework-driven, not hardcoded.
2. **When essential primaries are missing:** run the already-built
   `targetedQueries` as a bounded, higher-priority retrieval pass (fetch lane
   "known/pinned") before grading, to close most of the 0% cases.
3. **If they still cannot be obtained:** do **not** fall back to scoring on junk
   pages. Mark the company `suspect`/low-coverage (ties into Root cause 2) and
   exclude non-substantive pages (terms-of-use, cookie/privacy, login walls) from
   the eligible set via a generic low-value-page filter keyed on page nature, so a
   "Website Terms of Use" citation can never back a verdict.
4. Tunable retry budget (`CORPUS_READINESS_RETRY`, default on) so the completeness
   priority the team wants is explicit and cost-bounded.

Entirely framework-metadata-driven; the low-value-page filter keys on page nature,
not on any site.

**Verification:** test that a corpus with only a terms-of-use page yields zero
eligible documents and a `suspect` flag (never a "Yes"); re-run the six 0%
companies in preview and confirm primaries load or coverage drops to suspect.

---

## Root cause 7 — Run-to-run variance is driven by evidence composition, not grading noise

**Symptom:** cross-run consistency slightly *worse* (Yes-match 74% → 66%; 68 then
89 measure flips; Klépierre 31→19→28, PPG 28→22→31).

**Location:** grading determinism already exists —
`server/lib/analyzer.ts` deterministic per-measure seed (L3786+), in-run
self-consistency voting (default 3 passes, L3831), and a verdict cache keyed on
*evidence hash* (L3779). Corpus is frozen **within** a batch
(`server/lib/pipeline.ts` L2492 "freeze the evidence set for this batch"). The
variance enters **across** batches: discovery re-runs live web search
(`server/lib/discovery.ts`, Serper/SerpAPI, L1060/L1160), which returns different
document sets on each run.

**Mechanism (traced):** the verdict cache and in-run self-consistency are keyed on
the evidence text, so they only smooth *grading* noise for a *fixed* corpus. Two
separate full runs of the same company discover *different corpora* (live search
is non-deterministic), producing different evidence hashes and therefore
different verdicts. The majority-vote-over-LLM-passes already in place cannot fix
this because every pass in a given run sees the same (run-specific) evidence. The
reviewer's "majority vote over 3 runs" works only because it averages over three
*different* corpora — i.e. it treats the symptom, at 3× the cost.

**Generalised fix — two layers:**

1. **Durable (addresses the cause): persist and reuse the corpus across re-runs.**
   The per-batch corpus snapshot already exists (L2492). Add an opt-in
   **corpus-reuse** mode (`CORPUS_REUSE_ACROSS_RUNS`, default on for re-runs of an
   already-researched company): a re-run reuses the frozen accepted-document set
   (the existing `skipDiscovery` path) instead of re-searching, unless the
   operator forces a refresh. With the same corpus, the existing deterministic
   seed + verdict cache make the re-run reproduce the prior verdicts. This removes
   the dominant variance source at near-zero extra cost.
2. **Optional smoothing (reviewer's majority vote), default OFF.** Add a
   cross-run majority-vote mode (`SCORING_CROSS_RUN_MAJORITY`, default **off**):
   run the full assessment 3× and score "Yes" only when ≥2 runs agree. It stays
   binary and removes residual noise, but it triples LLM + search spend on a
   2,343-company universe, so it is a **money decision for the operator**, left
   off by default and enabled per batch when wanted. (This is the same opt-in
   stance I flagged earlier; keeping it off by default avoids silently tripling
   cost.)

Both layers are generic batch mechanics; neither touches framework content.

**Verification:** re-run a sample company twice with corpus-reuse on and assert
identical verdicts; with the cross-run flag on, assert a measure flips to "Yes"
only at ≥2/3 agreement on a synthetic three-run fixture.

---

## Secondary — Weak "Yes" where evidence is topical but not the required construct

**Symptom:** Adani supplier-dependency met by emissions-hotspot mapping; Adani
risk-financing met by a cyclone hazard description; Klépierre crisis-management
met by a 2020 COVID crisis team.

**Observation:** this is a *construct-match* gap: the quote is on-topic for the
framework but does not instantiate the **specific construct** the measure
requires. The generalised lever already exists — the "A2: Yes requires a verbatim
quote that contains the measure's qualifying instance" precondition
(`analyzer.ts` ≈ L604–634, `yesQuoteBasis`). The durable improvement is to ensure
every measure carries a machine-checkable `yesQuoteBasis` / qualifying-instance
definition in framework metadata and to enforce it in the gate, rather than
relying on the grader's judgement. This is framework-authoring work (define the
bar per measure) plus enforcement code; it is cross-sector because it keys on each
measure's own declared construct. Recommended as a fast-follow once Root causes
1–6 land, since it depends partly on framework content the team curates.

---

## Symptom → root-cause map

| Reviewer symptom | Root cause | Primary file |
| :-- | :-- | :-- |
| "TCFD report: found" for all 50 | RC1 | `shared/research-state.ts` |
| Grupo rated "full" despite 8 unsourced | RC2 | `server/lib/pipeline.ts` |
| Reused quotes support 44 Yes; 1 quote → 4 measures | RC3 | `server/lib/analyzer.ts` |
| Gate rejects own filings (measure 22) | RC4 | `server/lib/eligibility-flags.ts` |
| Gate misses subsidiaries (ING AU, Manulife PH) | RC5 | `server/lib/eligibility-flags.ts` |
| Persistent 0% / "Website Terms of Use" | RC6 | `primary-disclosure-check.ts` + `pipeline.ts` |
| Run-to-run consistency worse | RC7 | `discovery.ts` + `pipeline.ts` corpus snapshot |
| Weak Yes (Adani, Klépierre COVID) | Secondary | `analyzer.ts` + framework metadata |

## Delivery order (dependencies)

1. **RC6** (corpus readiness) and **RC1** (checklist content check) first — both
   fix "what is actually in the evidence set", which everything else reads.
2. **RC4 + RC5** (gate precision+recall rebalance) — independent, ship together.
3. **RC3** (one quote → one measure) — post-scoring pass, independent.
4. **RC2** (coverage from sourcing) — consumes RC6's sourcing signal.
5. **RC7** (corpus reuse default-on; cross-run majority default-off).
6. **Secondary** (construct-match bar) as fast-follow.

Each change ships behind a default-sensible, env-tunable flag, with unit tests in
the relevant `*.test.ts` and a preview-batch re-check on the named companies
before anything reaches `main`/prod. No fix hardcodes a company, framework, sector
or measure.
