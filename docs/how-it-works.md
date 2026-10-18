# How CompanyIQ Works — Technical Documentation

> **Audience.** This document is the single, authoritative technical reference for how CompanyIQ v3
> turns public corporate disclosure into a scored, evidence-backed assessment. The public, plain-language
> page at [`/how-it-works`](https://companyiq.online/how-it-works) links here for "the full technical detail".
> Keeping this file current in the repository keeps that link current.
>
> **Grounding.** Every claim below is grounded in the application source on `main` and in the project's own
> records: the implementation ledger (`docs/implementation-run-ledger.md`) and the external
> *CompanyIQ v3 Readiness Review* (18 October 2026). Where a capability is designed-but-dormant, measured-but-
> noisy, or not-yet-armed, this document says so explicitly rather than overstating it.

---

## 1. What CompanyIQ answers

CompanyIQ assesses **how well a company manages, governs and discloses its use of artificial intelligence**.
It does this by scoring a company against a structured **framework** of binary (Yes/No) *measures*, where each
measure is a specific, checkable disclosure question — for example, *"Discloses a named AI strategy or AI
transformation plan"* or *"Discloses board-level oversight of AI strategy or AI risk"*.

For each company × measure cell the system produces:

- a **Yes/No verdict** ("does the company disclose this?"),
- a **rationale** explaining the decision,
- a **supporting verbatim quote** and the **source document + link** it came from,
- a **confidence** signal, and
- full **rule provenance** (which rule, version and framework hash produced the verdict).

These roll up to a **company-level score** (percentage of measures met) plus coverage/research-status metadata.

The application is a Node.js/TypeScript app served by Express, with a React + Tailwind single-page frontend.
Production is deployed on Railway and served at **https://companyiq.online** (pushing to `main` auto-deploys all
Railway services).

---

## 2. The AI Management framework and its measures

A **framework** is a versioned set of measures. The production "AI Management" framework (framework id 18 in the
run records) contains **36 measures**, confirmed consistently across the implementation ledger
(`10 companies × 36 measures = 360 cells`) and the exported CSV (`AI Management-14 Oct 2026.csv`), which carries
36 per-measure column groups.

> **Note on the "29" figure.** Some stability experiments in the WP05 program (Section 9) were run against a
> **29-measure replay corpus** — a reduced subset frozen for reproducibility testing (`var_out_phase1_postfix`:
> `10 companies × 29 measures × 5 runs`). That 29 refers to the *experiment's* corpus, not the live framework.
> The current AI Management framework in production is 36 measures. This document uses 36 for the live framework
> and flags 29 only where it describes those specific replay experiments.

Each measure is more than a title. A measure definition carries scoring guidance, keyword/lexicon hints used for
retrieval, and optionally a **fallback Yes criterion** (`analyzer.ts`): numbered conditions that trigger Yes when
the primary evidence is weak but one of the fallback conditions is clearly satisfied. Measures span themes such
as **strategy**, **governance & accountability**, **deployment / use-cases**, **outcomes**, and
**responsible-AI / risk** (bias testing, human-in-the-loop oversight, AI risk management frameworks, dedicated AI
governance bodies, named accountable executives, and so on).

Measures are **binary** (Yes/No, with a "partial"/incomplete research signal layered on top) — not a 0–4 scale.
All scoring logic is **framework-level**: it reads the measure definitions and never hard-codes branches for a
specific company or topic.

---

## 3. End-to-end pipeline overview

```
  Company
    │
    ▼
 (1) Discovery ──────────► candidate source URLs (annual reports, sustainability reports,
    │                       proxy statements, policies, regulatory filings, IR pages)
    ▼
 (2) Fetch & extract ────► clean text per document (HTML via cheerio; PDF via pdf-parse,
    │                       with pdftotext / OCR fallbacks) + a completeness label
    ▼
 (3) Evidence retrieval ─► per-measure passage retrieval, BM25 ranking, LLM rescore,
    │                       authority+quality layered ranking → an evidence pack per measure
    ▼
 (4) Scoring ────────────► LLM reads the evidence pack and returns a Yes/No verdict + quote
    │                       (temperature 0, three-pass self-consistency; optional multi-LLM
    │                       cascade + cascade_v2 second pass on disagreeing cells)
    ▼
 (5) Persist & present ──► per-cell verdict, rationale, quote, source, confidence, provenance,
                            research/stability status → company page, dashboard, CSV export
```

Sections 4–8 describe each stage; Section 9 describes the WP05 stability program that sits around scoring.

---

## 4. Stage 1 — Data ingestion and sources (discovery)

CompanyIQ works from **public corporate disclosure**. It does not take a company's word from a questionnaire; it
discovers and reads primary documents.

- **Discovery** (`server/lib/discovery.ts`, `server/lib/r6-discovery.ts`) locates candidate source documents for
  a company: annual reports, sustainability/ESG reports, proxy statements, dedicated AI/responsible-AI policies,
  investor-relations pages, and regulatory filings (e.g. SEC EDGAR primary filings).
- A **topic lexicon** (`server/lib/topic-lexicon.ts`) supplies the framework's topic vocabulary, which raises the
  discovery priority of documents likely to contain the relevant disclosures and later feeds a topic bonus during
  retrieval.
- Documents are **classified** by type (regulatory, proxy, topic-primary, other) so that the most authoritative
  primary disclosures are preferred and are never crowded out or truncated during later ranking (`analyzer.ts`
  document-class caps).

Discovery is a genuine source of run-to-run variation: a fresh run can find a slightly different set of documents
than a previous run, which can change verdicts even when nothing else changed (see Section 9, Issue 1). For
*frozen-corpus* re-assessment the same document set is reused so discovery variance is removed.

---

## 5. Stage 2 — Fetch and extraction (with honest partial labels)

Once candidate URLs are known, the pipeline fetches and extracts clean text (`server/lib/pipeline.ts`,
`server/lib/processor.ts`):

- **HTML** is parsed with `cheerio`.
- **PDF** is parsed with `pdf-parse`, with **`pdftotext` and OCR fallbacks** for scanned or awkward PDFs.
- Each extraction is classified for **completeness** — `complete`, `partial`, `empty`, or `unknown`
  (`ExtractionStateLabel` in `storage.ts`; `getExtractionCompleteness` in `processor.ts`). This is the WP05
  Phase 0 work: the pipeline stopped over-aggressively trimming extracted text, and it now attaches an **honest
  partial label** instead of silently treating a truncated or timed-out document as fully read.

> **Honest limitation (Readiness Review, Issue 5).** The completeness label is computed, but it is **only partly
> wired into the research-status signal**: the A4 completeness label is not yet fully passed into
> `extraction_state`, so a timed-out partial PDF can still count toward "researched" in the A1 research status.
> Full wiring is a known, tracked follow-up. This document does not claim the research-status flag already
> reflects every partial extraction.

---

## 6. Stage 3 — Evidence retrieval and chunk ranking

For each measure, the system builds an **evidence pack**: the specific passages most likely to answer that measure.

1. **Passage retrieval & chunking** (`server/lib/passage-retrieval.ts`) splits documents into passages and scores
   them with **BM25** (a classic lexical relevance ranking), boosted by the measure's topic lexicon terms.
2. **LLM rescore** (`server/lib/passage-rescore.ts`) re-ranks the top lexical candidates with an LLM judgement of
   how relevant each passage actually is to the measure — catching relevant passages that use different wording
   than the keywords, and down-weighting keyword coincidences.
3. **Layered ranking** (`server/lib/ranking.ts`) combines **source authority** (primary filings over mirrors/
   third parties) with the fine relevance score so that the evidence pack is drawn from the strongest documents.
4. The result is a bounded **evidence pack** per measure, with reserved capacity for topic-primary documents so a
   single authoritative annual filing is never truncated out of the pack.

**Recall expansion (A5)** adds passages that lexical retrieval missed, and a **context-trim lever (B5,
`server/lib/model-cost.ts`)** can drop *repeated* context to reduce prompt size.

> **Honest limitations.**
> - The A5 "recall" and B5 "no decisive passage dropped" proofs grade themselves against a **keyword oracle built
>   from the measure's own keywords** (`server/lib/evidence-recall.ts`). That is a useful guard but is *circular*
>   as a proof of accuracy — a passage that expresses the fact in different words may not be counted "decisive"
>   (Readiness Review, Issue 2). Breaking this circularity is the purpose of the Phase 2 ground-truth gate
>   (Section 9).
> - The B5 trim rule removes a passage only when it adds no new keyword token and comes from an
>   already-represented document, but the Readiness Review (Issue 4) notes this can still drop a non-duplicate
>   passage carrying a qualifier, date, scope limit or negation. The saving is small (~11.6% of LLM cost); the
>   lever has a kill-switch (`CONTEXT_COST_POLICY=off|shadow|on`) and is tested against a recall-preservation
>   invariant, but `shadow` mode is the conservative setting pending holdout evaluation.

---

## 7. Stage 4 — Producing a Yes/No verdict + evidence per measure

The scorer (`server/lib/analyzer.ts`) sends the per-measure evidence pack to an LLM and asks for a structured
verdict. Key properties:

- **Temperature 0** and **three-pass self-consistency** (`selfConsistencyPasses`): the measure is scored multiple
  times and the passes are reconciled, so a single stochastic answer does not decide a cell.
- The verdict is **evidence-bound**: the model must return a **verbatim supporting quote** and the **source
  document** it came from. A stricter verbatim-quote gate (A2, v2 default) rejects quotes that are not actually
  present in the evidence.
- A **fallback Yes criterion** per measure allows a Yes when primary evidence is weak but a clearly-defined
  fallback condition is met — this is framework-declared, not model improvisation.
- Each verdict is persisted with its **rationale, confidence, rule id/version/provenance and framework hash**, so
  every Yes/No is auditable back to a rule and a passage.

### 7.1 The multi-LLM cascade and `cascade_v2`

CompanyIQ has a **cross-architecture cascade** (`analyzer.ts`, ~lines 270–325), gated by the
`scoring_cascade` setting, that routes a cell through more than one model family to reduce single-model bias:

- **Primary:** `deepseek` (`cascade_primary`, default `deepseek`).
- **Secondary:** `glm-4.6` (`cascade_secondary`).
- **Arbiter:** `claude-arbiter` by default; when **`cascade_v2`** is enabled the default arbiter becomes
  **`gpt5-arbiter`** (OpenAI GPT-5 via OpenRouter). `cascade_v2` also **disables the legacy post-cascade
  auto-downgrade-to-Low-confidence rule**, because the stronger arbiter already provides the disagreement signal.
  The arbiter is overridable via `cascade_arbiter`.

The intent is: **stable cells stay on the low-cost primary path; only disagreeing/borderline cells escalate** to
the arbiter (second pass). This keeps cost low while giving contested cells a cross-model check.

> **Honest current state (Readiness Review, Issue 1).** In the measured production baseline the cascade was
> **off** — the baseline used **1,825 DeepSeek calls with a single escalation**. So `cascade_v2` is the
> **designed and available** second-pass mechanism for disagreeing cells, and the WP05 reproducibility plan
> (Section 9) is explicitly to escalate only unstable cells through it — but this document does not claim the
> cascade was continuously live in the baseline corpus.

---

## 8. Stage 5 — Outputs: company view, research status, and CSV export

Verdicts and metadata surface in three places:

- **Company page / dashboard** — per-measure verdicts with rationale, quote, source link and confidence, plus a
  **research-status** label (complete vs incomplete research, A1) and, from the WP05 work, a **stable/borderline**
  flag so users can see which Yes verdicts are fragile.
- **CSV export** (e.g. `AI Management-14 Oct 2026.csv`) — one row per company. Top-level columns: *Company, ISIN,
  Sector, Country, Total Score (%), Measures Met, Measures Total, Coverage Level, Missing Tier 1 Sources*, then a
  per-measure block for each of the 36 measures: *Score, Rationale, Supporting Quote, Source Document, Source
  Link, Confidence, Rule ID, Rule Version, Rule Provenance, Rule Source Field, Framework Hash, Fallback Reason,
  Validation Status, Trace Diagnostics*, ending with a consolidated *Source Documents* column.
- **Research-status / partial labels** — the completeness signals from Section 5 (subject to the wiring caveat).

---

## 9. The WP05 stability and ground-truth program

The *Readiness Review* identified three issues that matter before the tool is used for investment decisions:
(1) scores are **not reproducible**, (2) accuracy has **never been measured against independent ground truth**,
and (3) the pipeline has **not completed a run larger than ~10 companies**. WP05 is the focused program that
addresses reproducibility and ground truth. It is organised in three phases.

### Phase 0 — Stop dropping evidence; label partial extractions honestly

The extraction step previously trimmed text too aggressively. Phase 0 stopped that (relevant text is never
dropped) and introduced the honest **complete / partial / empty / unknown** extraction labels described in
Section 5 (`phase0-partial-threading.test.ts`, `deriveExtractionState`, `extraction_state` migration). The known
follow-up (full wiring of the partial label into research status) is disclosed in Section 5.

### Phase 1 — Reproducibility

The Readiness Review measured real non-determinism: re-running the same 10 companies with no code change altered
**28 of 360 verdicts**; even on a *frozen* document set, 11–19 verdicts still changed, because the scoring step is
non-deterministic despite temperature 0 and three-pass self-consistency. Phase 1
(`server/lib/reproducibility.ts`, `server/lib/variability-stability.ts`, `server/scripts/variability_run.ts`,
tests `phase1-reproducibility.test.ts` 16/16) targets this with:

- **Content-stable score/verdict caching** — a content-stable hash of the evidence/document texts
  (`generateContentStableHash`, `CONTENT_STABLE_HASH`, tenant-isolated by company id) so **identical evidence
  yields the identical verdict on re-run** (and cheaper).
- **Escalating only disagreeing cells** through `cascade_v2` (the second pass), rather than re-scoring everything.
- A per-cell **stable / borderline flag** exposed to the company page and CSV.
- **Reduced discovery variance** for re-assessment by reusing the prior source manifest.

**Honest residual.** Even with caching and escalation, a small **~2% irreducible verdict-flip rate** remains: this
is inherent LLM scoring non-determinism and is reported as such, not hidden. The acceptance target is to bring
frozen-corpus replays down to no more than ~3 changed cells across any pair of runs.

### Phase 2 — The offline ground-truth gate (built, but NOT-ARMED)

The deepest problem is **Issue 2**: every change so far was accepted by comparing *flip counts* against a noise
floor, and the recall/decisive proofs grade the scorer against the **same keyword oracle the scorer uses** — so
they are circular and cannot measure true accuracy. Meanwhile the total "Yes" count drifted up (56 → 70, +25%)
with no way to tell better recall from more false positives.

Phase 2 (`server/lib/phase2-groundtruth.ts`, `server/lib/phase2-holdout-roster.ts`,
`server/scripts/phase2_gate_cli.ts`; tests `phase2-groundtruth.test.ts` 23/23) builds a **small, fixed,
human-labelled answer key** — the *holdout* — and makes it a **standing, build-time regression gate** for every
later scoring/retrieval change. It is **pure, offline, and framework-level**: no DB, no LLM, no network, and no
company- or topic-specific branches.

1. **Holdout selection** — `selectHoldout()` makes a deterministic, seeded (xmur3 → mulberry32, Fisher–Yates),
   **stratified ~250–300-cell** draw. Strata are assigned by priority so each cell appears exactly once:
   current-Yes → historically-unstable → low-yield "0/36-type" companies → a deterministic random sample of No
   cells → then a rule ensuring **≥2 non-English filers** are represented. Same seed + inputs ⇒ a byte-identical
   manifest. Against the real 10-company × 29-measure × 5-run post-fix replay corpus (1,450 observations) this
   selected **280 holdout cells** (current-yes 19, unstable 7, low-yield-company 192, random-no 62; 3 non-English
   filers — Sumitomo Forestry, TSMC, Suzano).
2. **Label schema** — the authoritative field is **`human_label`** ∈ {Yes, No, Unsure, **PENDING** (default)},
   plus labeller id, document, passage, ISO timestamp, and a 20%-overlap flag for inter-labeller agreement. A
   separate, **non-authoritative** `provisional_suggestion` (from an independent model family) exists only for
   analyst triage — the gate **never** reads it as truth.
3. **Standing regression gate** — `computeGate()` reads **only** `human_label` as truth and reports Yes
   **precision** and **recall** with **Wilson 95% confidence intervals**, split by complete/incomplete research,
   plus the **total cells flipping Yes→No and No→Yes versus the oracle-era baseline (the split, not the net)**. It
   emits pass/fail against configurable thresholds (default **precision ≥ 0.85, recall ≥ 0.75**, flagged
   illustrative and overridable).

**Honesty — the gate is NOT-ARMED.** No human labels have been produced yet. The holdout ships with an
**all-PENDING** template, and with no authoritative human labels the gate returns **`not-armed` ("ground truth
pending")** and **fabricates no pass result and no precision/recall numbers** (it still reports the oracle-flip
split, which needs no human labels). The infrastructure is fully exercised by **synthetic** labels in unit tests
only; those synthetic values are never presented as human ground truth, and **$0 of model spend** was used to
pre-annotate.

**Runtime impact — none.** The Phase 2 modules are imported **only** by their test and the offline CLI. Nothing
is wired into the analyzer/evidence/scoring pipeline, so at runtime **Total cells Y→N = 0, N→Y = 0, Total Flips =
0 by construction**.

**What remains is one human input.** A **one-time analyst adjudication** of the fixed ~280-cell holdout (filling
`human_label`) arms the gate, after which A2/A3/A5/B5 and the 0/36 companies can be re-decided against truth. This
is a one-time build-time labelling of a fixed yardstick — explicitly **not** a per-company production review of
thousands of companies.

---

## 10. What this document (and page) changed

This documentation and the public `/how-it-works` page are **additive**: they introduce a public information page
and this reference file. They touch **no scoring, retrieval, or evidence surface**.

- **Total cells Y→N = 0, N→Y = 0, Total Flips = 0** — verdict-invariant by construction.
- All content here is **framework-level** and carries **no company- or topic-specific** logic.
- Known limitations are stated in-line rather than omitted: discovery/scoring non-determinism (~2% residual
  flips), the partially-wired completeness label, the circular keyword oracle (the reason Phase 2 exists), the
  cascade being off in the measured baseline, and the Phase 2 gate being **NOT-ARMED** pending human labels.

---

## 11. Source map (where to verify each claim)

| Claim in this doc | Source |
| --- | --- |
| Framework = 36 measures; 360 cells | `docs/implementation-run-ledger.md` ("framework 18 (36 measures)", "10 companies × 36 measures = 360 cells"); `AI Management-14 Oct 2026.csv` |
| Discovery & sources | `server/lib/discovery.ts`, `server/lib/r6-discovery.ts`, `server/lib/topic-lexicon.ts` |
| Fetch/extract + completeness labels | `server/lib/pipeline.ts`, `server/lib/processor.ts`, `server/lib/storage.ts` (`ExtractionStateLabel`), `phase0-partial-threading.test.ts` |
| Retrieval, BM25, rescore, ranking | `server/lib/passage-retrieval.ts`, `server/lib/passage-rescore.ts`, `server/lib/ranking.ts` |
| Scoring, self-consistency, cascade/cascade_v2 | `server/lib/analyzer.ts` (~lines 235, 270–325) |
| Reproducibility / caching / stability | `server/lib/reproducibility.ts`, `server/lib/variability-stability.ts`, `phase1-reproducibility.test.ts` |
| Phase 2 ground-truth gate | `server/lib/phase2-groundtruth.ts`, `server/lib/phase2-holdout-roster.ts`, `server/scripts/phase2_gate_cli.ts`, `phase2-groundtruth.test.ts` |
| Non-determinism / Yes-drift / oracle circularity / cascade-off baseline | *CompanyIQ v3 Readiness Review* (18 Oct 2026), Issues 1–5 |
| CSV columns | `AI Management-14 Oct 2026.csv` export |

*Last updated alongside the public `/how-it-works` page. Update this file in the repository to keep the linked
documentation current.*
