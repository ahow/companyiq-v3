# Recall Root-Cause Diagnosis — Framework 3 × List 2 (iter-13)

**Date:** 4 September 2026
**Baseline:** Reconciled truth (3 independent human adjudicators + reviewer, 105 Yes / 84 No / 11 Not disclosed)
**Pipeline data:** iter-13 (batch 16)

## Executive summary

On the 124-cell **High-confidence** subset of the reconciled truth baseline, the pipeline delivers:

| Metric | Value | Reading |
|---|---:|---|
| Precision | **96.9%** | Near-ceiling. When the pipeline says Yes, it is essentially always right. |
| Recall | **73.8%** | Substantial gap. 22 of 84 true Yes verdicts are missed. |
| Accuracy | 80.6% | Bounded by recall. |

The dominant failure mode is **false negatives**. Every planned Tier-1 precision-side intervention (U17 Fix B, U9 Layer 1 verbatim re-verification, U3 forced translation) would leave recall unchanged or worsen it.

## Root-cause classification of 22 false negatives

| Cause class | Count | What is broken |
|---|---:|---|
| **A. Retrieval miss** | **12 (55%)** | The truth source document is not present in the pipeline's corpus. |
| B. Passage miss (in-doc) | 4 (18%) | The doc is fetched, but BM25 picks the wrong chunks. |
| B*. Wrong doc version | 5 (23%) | URL matched a corpus doc but that fetched artefact lacks the truth passage. |
| C. Scoring miss | 1 (4%) | The correct passage was in the evidence pack and was still graded No. |

**Scoring is not the bottleneck.** Once the correct passage is in the evidence pack, the LLM grades it correctly ~96% of the time.

## Generalised failure modes (not company-specific fixes)

### FM-1 — Query-vocabulary miscalibration (discovery)

**Manifestation on this cohort:** Newmont 8 FNs, Prudential 2 FNs, Kering 1 FN, Walmart 1 FN.

**Mechanism:** `framework_measures.evidence_keywords` and `framework.legacy_query_templates` describe what appears INSIDE disclosure documents, not what appears in the TITLES, URLs, or search-result descriptions used to LOCATE them.

Concrete example — Framework 3 legacy query templates as seen on Newmont:
- `"Newmont Corp" biodiversity impact 2026 OR 2025`
- `"Newmont Corp" cross-functional team 2026 OR 2025`
- `"Newmont Corp" genetic resources 2026 OR 2025`
- `"Newmont Corp" high-biodiversity ecosystems 2026 OR 2025`
- `"Newmont Corp" stress testing 2026 OR 2025`

None of these will surface a document titled `Newmont 2024 Sustainability Report`. The `evidence_keywords` derived at measure level suffer the same pathology — Governance and Risk-management measures inject generic process terms (enterprise risk management, strategic planning, capital allocation) that dominate the topic-specific terms in count and depress topic-term specificity in BM25.

**Generalised fix (roadmap candidate R1):**

1. Introduce a distinct field: `framework.disclosure_document_types`. Populate with the actual disclosure vehicles named in each measure's `disclosureVehicles` column (already exists per-measure) — deduplicated and normalised. For framework 3 this is: `sustainability report, TNFD report, TCFD report, annual report, integrated report, biodiversity report, natural capital report, ESG report, proxy statement, corporate governance statement, dedicated policy document`.
2. Generate discovery queries from this field, not from measure-level evidence_keywords. Query patterns: `"{company}" {docType} filetype:pdf`, `"{company}" {docType} {currentYear}`, `site:{domain} {docType}`.
3. Framework-agnostic: any topic (AI, tax, human rights) already has its disclosure vehicles listed per measure. Aggregating them at framework level is a one-time backfill.

### FM-2 — Domain search is under-scoped (discovery)

**Manifestation on this cohort:** Newmont — `domainsSearched: ["newmont.com", "operations.newmont.com"]` but the 2024 Sustainability Report is on `s24.q4cdn.com/382246808/...`.

**Mechanism:** The `domain` and `related_domains` fields on `companies` list corporate web properties. But investor-relations PDFs are routinely hosted on shared CDNs — `q4cdn.com` (Q4 Inc, hundreds of US-listed issuers), `hkexnews.hk` (HKEX-listed issuers), `sedar.com`/`sedarplus.ca` (Canadian issuers), `filings.xbrl.org` (European ESEF filings), `sec.gov` (US-listed). The pipeline treats these as third-party rather than first-party-hosted; and even in the trusted-sources lane, only per-issuer known-good CDN paths are searched.

**Generalised fix (roadmap candidate R2):**

1. Introduce a table `platform_document_hosts` (or extend `platform_sources`): well-known first-party-equivalent hosts keyed by issuer identity. Rows: `q4cdn.com`, `hkexnews.hk`, `sedarplus.ca`, `sedar.com`, `filings.xbrl.org`, `edgar.sec.gov`, `disclosure.tokyo.jpx`, `cninfo.com.cn`, `rad.cvm.gov.br`.
2. In discovery: whenever `q4cdn.com` (etc.) URLs appear in web-search results with the issuer name or ticker in the path, classify them as `first_party` provenance and route into the domain lane not the general lane.
3. The Q4 Inc CDN specifically encodes the issuer ID in the path (`s24.q4cdn.com/382246808/` is Newmont). Cache these mappings after first observation and use them as anchor URLs in future runs.

### FM-3 — Insufficient repair pass on missing primary disclosures (discovery)

**Manifestation on this cohort:** Newmont's `primaryDisclosureRepair` flagged `default-sustainability-current` as missing. Pipeline issued **1 repair query**: `"Newmont Corporation" sustainability report 2025 filetype:pdf`. Live re-execution of the same query returns the correct PDF at position 8 of 10 (`s24.q4cdn.com/.../Newmont-2024-Sustainability-Report.pdf`). But the pipeline's repair fetch either dropped position 8 during the tier gate or the entity-verification gate (Q4 CDN not on the trusted host list — see FM-2).

**Mechanism:** The repair is single-shot, single-query, `num=10`, and its output is subject to the same tier/entity gates as ordinary discovery. When those gates reject the CDN-hosted PDF, the repair produces nothing useful.

**Generalised fix (roadmap candidate R3):**

1. Multi-variant repair: for each missing primary-disclosure requirement fire 3-5 query variants (with/without filetype:pdf; with company legal name and ticker aliases; year variants).
2. Bypass tier/entity gate for repair-lane candidates when they lie on the FM-2 known-CDN list — the whole point of a repair is to accept lower-tier evidence, so a strict tier gate defeats it.
3. Persist near-hit URLs for manual audit rather than dropping silently.

### FM-4 — Entity-resolution false positive (discovery)

**Manifestation on this cohort:** Prudential plc — 10 of 51 corpus docs are actually **Prudential Financial Inc** (US insurer, CIK 1137774) sourced from EDGAR. Prudential plc (UK/Asia insurer, LSE:PRU) is a different company. Top-priority documents in the corpus are Prudential Financial 10-Ks.

**Mechanism:** SEC EDGAR resolution used ticker `PRU` and returned CIK 1137774 (Prudential Financial). Prudential plc's ISIN `GB0007099541` does not identify a US-listed entity, so EDGAR should never have been queried for it in the first place. The pipeline apparently uses ticker fallback when ISIN resolution to EDGAR returns nothing — but for non-US-listed issuers this fallback is wrong.

**Generalised fix (roadmap candidate R4):**

1. In `fmp-resolver.ts` and any EDGAR resolver, require the ISIN's country prefix to be US (or the company's `country` field to be US) before EDGAR search. GB/JP/CN/FR/etc. issuers should skip EDGAR entirely unless they have an ADR flag.
2. On collision detection (ticker match but ISIN mismatch), reject the EDGAR entity rather than accepting it.
3. Add an entity-verification signal to `discovery_diagnostics`: `wrongEntityRejected: [{ url, reason, resolvedEntity }]`.

### FM-5 — Topic dilution in BM25 passage retrieval

**Manifestation on this cohort:** Santander 5 FNs (out of 6). Correct 781KB Sustainability Statement in corpus, all top-20 BM25 chunks are about climate rather than nature despite the document containing a dedicated Section 2.3.5 "Our approach to nature and biodiversity" (pp.42-46).

**Mechanism:** `deriveTopicTerms` pools `topicDescription`, `frameworkName`, `evidenceKeywords`, `dataPatterns` and dumps everything into a single token set. Because measure-level `evidenceKeywords` include process-generic terms (enterprise risk management, strategic planning, capital allocation, integration, embedded, incorporated), the topic-term set for a nature measure ends up 60-80% generic. Meanwhile the target document has 10x more climate content than nature content — so any chunk containing "climate" + generic process terms outscores the nature-specific chunks in Section 2.3.5.

**Generalised fix (roadmap candidate R5):**

1. Split `evidence_keywords` into two fields:
   - `topic_terms` — strictly topic-specific tokens (nature, biodiversity, ecosystem, natural capital, TNFD, LEAP, etc.). These carry HIGH weight in BM25.
   - `mechanism_terms` — generic governance/process terms (integration, ERM, capital allocation, etc.). These carry LOW weight or contribute only when combined with a `topic_term` in the same chunk.
2. Modify `deriveTopicTerms` to accept the two-field split and produce a weighted topic regex.
3. Alternative: apply a **topic-term minimum** at chunk scoring — require ≥1 topic-term hit per chunk before it enters top-K, regardless of BM25 score. (This is a much narrower change but relies on evidence_keywords being cleaned first.)

### FM-6 — PDF-extraction / content-truncation on some fetched docs

**Manifestation on this cohort:** 5 B* cases (Kering ESEF, Kering URD chapter, Nestlé Non-Financial Statement, Walmart FY2026 ESG, one other) where the pipeline fetched the URL, marked it `success`, but the fetched content lacks the truth passage.

**Mechanism:** Need to inspect the actual `document_content.content` for these 5 docs and compare against the fetched byte-count vs the source PDF's size. Likely causes: PDF text extractor truncating at a page/section boundary; ESEF XHTML being parsed as plain HTML dropping tagged data; some CDN returning a landing HTML rather than the PDF.

**Generalised fix (roadmap candidate R6):**

1. Add a content-length audit column: expected byte count from HTTP headers vs actual extracted text length. Ratio < 0.3 = flag for re-fetch.
2. For ESEF/xhtml docs: use an ESEF-aware parser (there's already xbrl in the tech stack for the FIGI integration).
3. For very large PDFs (>500 pages) verify no page-count truncation in the extractor's default limits.

## Direct impact estimate (High-confidence subset)

Assuming each root-cause class is fixed cleanly:

| Fix | FN cells addressed | Recall lift (of 22 FN) | New recall |
|---|---:|---:|---:|
| Current baseline | — | — | 73.8% |
| R1 (query vocabulary) | ~6 | +7 pts | 81% |
| R2 (CDN as first-party) | ~8 (Newmont) | +10 pts | 91% |
| R3 (multi-variant repair) | ~4 | +5 pts | (subsumes some of R2) |
| R4 (entity gate) | 2 (Prudential) | +2 pts | (independent) |
| R5 (BM25 topic weighting) | ~5 (Santander) | +6 pts | (independent) |
| R6 (extraction robustness) | ~5 | +6 pts | (some overlap with R5) |

Realistic combined lift assuming implementation overlap: **recall from 74% to 92-95%** on the High-confidence subset. Precision stays essentially unchanged (all fixes are on the FN side).

## Roadmap update

The prior Tier 1 (T1.2 U17 Fix B — done; T1.3 U9 Layer 1; T1.4 U3 translation) was constructed under the assumption that precision was the primary issue. It isn't. Reordered priority:

| Priority | New identifier | Description | Est. lift | Effort |
|---|---|---|---:|---|
| **1** | **R2** | Well-known CDN registry + first-party-equivalent classification | +10 pts recall | 1-2 days |
| **1** | **R1** | Framework-level `disclosure_document_types` + query overhaul | +7 pts | 1-2 days |
| **1** | **R4** | Entity resolution: require ISIN-country match before EDGAR lookup | +2 pts, prevents cross-contamination | ~0.5 day |
| **2** | **R5** | BM25 topic-term weighting (split evidence_keywords → topic vs mechanism) | +6 pts | 2-3 days |
| **2** | **R3** | Multi-variant primary-disclosure repair | +5 pts | 1 day |
| **2** | **R6** | Content-extraction audit + ESEF handling | +5 pts | 1-2 days |
| Backlog | Prior T1.3 (U9 Layer 1) | Verbatim re-verification | 0 pts (precision-side) | — |
| Backlog | Prior T1.4 (U3) | Force translation | 0 pts (Ambev truth is 0 Yes) | — |
| Backlog | U17 Fix B (shipped, PR #8) | Ship with flag OFF; enable only if precision degrades | 0 pts | done |

## Sanity checks — results

**FM-2 confirmed at platform level.** Every q4cdn.com URL in the batch-16 corpus (10 across list-2, all for Newmont) is classified `third_party`. Same treatment for hkexnews.hk (Prudential plc's 2024 Sustainability Report) and rad.cvm.gov.br (Ambev's Reference Form). Every one of these is a first-party regulatory or investor-relations filing hosted on a shared platform. This is a *systemic* classification bug, not a Newmont-specific one.

**FM-5 confirmed and REFINED.** The problem is not "climate crowds out nature" — the pipeline's cited quotes for the 5 in-corpus Santander FNs are actually more nature- than climate-weighted. The refined mechanism is: BM25 with the current `evidence_keywords` finds nature *mentions* scattered across the doc, but MISSES the nature-DENSE section that carries the fallback-Yes evidence. Concretely: on the Santander Sustainability Statement 2024:
- Section 2.3.5 "Our approach to nature and biodiversity" (chunks 94-98, chars 141k-147k, pp.42-46) contains 27 strict-nature term hits in 5 chunks — this is where every truth-adjudicated Yes came from.
- BM25 with the current governance-heavy `evidence_keywords` for measure 1.4 selects only **1 of 20 top chunks** in common with a strict-nature-term ranking. The other 19 are governance chunks with 0-1 nature hits each.

The scoring LLM does its job correctly on the diluted evidence pack: it says "the disclosure mentions nature but doesn't demonstrate integration/prioritisation/methodology" — because the evidence pack contains the mentions but not the methodology section. So this manifests as an evidence-completeness problem at the retrieval layer, misdiagnosable as a scoring problem.

**Sanity check 1 (query-vocabulary on other frameworks)** — deferred; the fix design does not depend on this being framework-wide, though we should confirm before backfilling all frameworks.

## Adjustment to R5 based on sanity check 3

The fix is section-aware retrieval, not just term reweighting. Specifically:

1. **Detect topically-dense sections** at chunking time. When ≥N contiguous chunks each contain ≥1 strict-topic term, tag them as a "topic section" and reserve at least K chunks from any such section in every measure's evidence pack. This is analogous to the existing `item1a-reserve` for SEC 10-K Item 1A.
2. **Reweight `evidence_keywords` at retrieval time**. Split the field into `topic_terms` (nature-strict) and `mechanism_terms` (governance/process). Multiply chunk BM25 score by (1 + λ · topic_term_hits) where λ ≈ 2. This makes a chunk with 5 nature mentions dominate a chunk with 5 governance mentions and 0 nature mentions.
3. Both changes are additive and independently testable.

## What I recommend doing next

**Run the two verification queries above (sanity checks 2 and 3, ~30 min of DB work).** Then commit to the Priority-1 stack in order R2 → R1 → R4. That's a ~4-5 day implementation window and should lift High-confidence recall to ~85-90%. Then measure. If passage-retrieval failures still dominate, tackle R5.

Do NOT touch R3, R6, or the backlog items until R1/R2/R4 are shipped and measured — the impact estimates for R5/R6 assume R2 lands first, and R3 is a specific case of R2 done properly.
