# R5 Design Note — Section-aware Retrieval + Topic-strict Term Split

**Date**: 2026-09-04
**Context**: After iter-14, 15 High-confidence FN cells remain. This note designs R5 as the next fix, drawing on findings from `Investigation-Prudential-Kering-2026-09-04.md` and a fresh Newmont deep-dive below.

## The design has evolved

The pre-investigation hypothesis was a single fix: "section-aware retrieval + topic-strict term split". After investigating Newmont's 7 FN cells, that hypothesis is only partly right. R5 needs to address **three distinct root causes**, each of which is generalisable but they don't share a single fix.

## Newmont deep-dive (7 FN cells at High confidence)

### The corpus problem — a specific R2 bug

Newmont's iter-14 corpus is missing the two primary truth-source documents:
- `s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/newmont-2024-sustainability-report.pdf`
- `s24.q4cdn.com/382246808/files/doc_downloads/priority-topics/newmont-approach-to-biodiversity.pdf`

**Why they're missing:**

1. R1 vehicle queries DO surface both URLs (verified with live `pplx_sdk.search.web('"Newmont Corporation" sustainability report filetype:pdf')` — the target is result #3).
2. R2 has an IR-platform rule for `q4cdn.com` in `server/lib/provenance.ts`.
3. The rule's Q4-tenant path-identifier extractor treats `/382246808/...` as a SEC CIK: `extractIdentifier: (url) => { kind: "cik", value: match[1] }`.
4. Newmont's actual SEC CIK is `1164727`, not `382246808`. `382246808` is Newmont's **Q4 tenant identifier**, which is a Q4-internal identifier unrelated to SEC CIK.
5. The `irPlatformPathIdentityMatch` check therefore returns `matched: false`, and the URL falls through to `third_party` classification (`provenance.ts:513-520`).
6. Third-party classification means the pipeline downranks this URL. It didn't make it into the top-64 corpus.

Meanwhile, the corpus DID include a Papua New Guinea Stock Exchange repost (`pngx.com.pg/…NEM-2024-Sustainability-and-Taxes-Royalties-Reports.pdf`) — but that document is only 2 pages (an exchange notification summary), not the full report. `Coverage.requiredDocsFound.sustainability report: True` marks the requirement as satisfied even though the pipeline has the wrong document.

**Generalisable fix — call it R2b (a bug-fix on R2)**:

The Q4 IR platform's `extractIdentifier` returns `kind: "cik"` for `/{digits}/…`, but Q4 tenant IDs are Q4-internal, not SEC CIKs. The correct label is `kind: "q4_tenant_id"`. The downstream verification then needs to either:
- (a) resolve the Q4 tenant ID via a lookup table (Newmont=382246808, Corning=24741, …) built from manual audit or from crawling Q4's client index, OR
- (b) accept the Q4 tenant match on the first `s24.q4cdn.com/{digits}/...` document that ALSO has three-tier title-primary identity match, then propagate that tenant→company binding for subsequent URLs in the same batch.

Option (b) is preferable — no manual lookup table, but needs a first-touch identity signal (title/URL/content match to company).

**Impact estimate**: closes 2 of 7 Newmont FN cells (the ones where the biodiversity content is in `newmont-approach-to-biodiversity.pdf`, which never enters the corpus).

### The scoring problem — literal-string over-narrowing

Where the pipeline HAS the right passages, scoring is still failing.

**Newmont 2.3-nature-risks (Partial verdict, iter-14)**:
The pipeline correctly extracted the exact truth quote:
> Advanced our Nature-Positive approach by applying the TNFD LEAP framework to identify nature-related dependencies, impacts and risks.

The measure title is *"Discloses nature-related risks to the organization over short, medium and long term"*. The evidence covers "nature-related risks" (identified through TNFD LEAP) but doesn't specify time horizons. The pipeline scored `Partial` (a special third state that then rolls down to `No` in the binary comparison to truth). Analysts scored `Yes` because they read the same passages as sufficient without an explicit time-horizon disclosure.

**Kering 3.3-tnfd-leap-application**:
Pipeline extracted:
> In 2023, Kering became one of the Taskforce for Nature-Related Financial Disclosures (TNFD) Early Adopters, undertaking to make disclosures aligned with…

The measure title says *"Discloses use of the TNFD LEAP approach or similar nature assessment methodology"*. The evidence is a TNFD adoption commitment — clearly covered by the "similar" disjunct. But scoring returned `No` at Low confidence because the acronym "LEAP" (Locate/Evaluate/Assess/Prepare) isn't literally present.

**Generalised pattern**: measure titles contain implicit OR-clauses ("… OR similar", "… over short, medium and long term") that scoring collapses. Once the strict literal isn't matched, the scorer returns No/Partial with Low confidence.

**Generalisable fix — the topic-strict term split**:

1. **Parse measure titles for disjunctive markers** at framework load time. Split on ` or `, `, or `, `such as`, `including`, `e.g.`, `similar to`. Store each disjunct as an independent evidence gate.
2. **Score against each disjunct separately.** Score is `max(disjunct_scores)`. The pipeline currently sends the whole title as one prompt; instead, run K prompts (one per disjunct) and take the max.
3. **Confidence downgrade rule**: if scoring returns `No` with Low confidence, and any disjunct's evidence contains an "explicit topic term" (per the truth-baseline's `Explicit topic term` field's spirit), promote to Partial and require review rather than emit No confidently.

**Impact estimate**: closes 4-5 Newmont FN cells (all the "TNFD LEAP applied" pattern) + Kering 3.3.

### The section problem — retrieval favours cover pages

**Newmont 1.1-board-oversight**:
Truth quote (from `newmont-2024-sustainability-report.pdf`):
> The full Board is tasked with overseeing the Company's safety and sustainability performance and holding management accountable for these areas. To ensure sustainability is embedded across the business, the Board delegates specific matters to its com…

Pipeline evidence (from the same or similar doc):
> assists the Board in furtherance of its commitments to adoption of best practices in promoting a healthy and safe work environment, and environmentally sound and socially responsible resource develop…

The pipeline surfaced a passage from a governance committee mandate (adjacent section) rather than the passage from the board-role-on-sustainability section. The retrieval ranker's chunk-scoring prioritises text density of topic keywords in each chunk, not the SECTION the chunk belongs to.

**Newmont 1.5-stakeholder-engagement**:
Truth quote:
> To further support our No Net Loss efforts, we partner with the International Union for the Conservation of Nature (IUCN), a leading NGO focused on conservation. In 2024, IUCN completed a technical review of our No Net Loss biodiversity efforts at Me…

Pipeline surfaced generic community-consultation passages, not the IUCN partnership passage. Again, section-context is lost.

**Generalisable fix — section-aware retrieval**:

1. **PDF section extraction** — before chunking, detect section headers (font-size heuristics + regex like `^(Chapter|Section|Part) \d+`, or `^[A-Z][a-zA-Z ]{4,}$` at start of a page). Tag each chunk with its enclosing section title.
2. **Boost chunks in section titles that match measure keywords** — a section titled "Board Oversight" boosts chunks for measure 1.1-board-oversight. A section titled "Stakeholder Engagement" or "Partnerships" boosts 1.5. Simple keyword overlap between section title and measure title/description.
3. **Section-title first, chunk-content second** — currently the chunk score is `contentScore(chunk) * hostTier`. Add `sectionMatchScore(chunk.section, measure)`, weight 1.5× against contentScore because section context is much stronger disambiguating signal than a topic-keyword hit in a random paragraph.

**Impact estimate**: closes 2-3 Newmont FN cells that hinge on retrieving the right sections rather than the loudest topic-keyword passages.

## R5 as a package — sub-parts

| Sub-part | Effect | Est. FN cells closed |
|---|---|---|
| **R5a — Section-aware retrieval** | Chunk-section tags + section-title boost | 2-3 Newmont |
| **R5b — Disjunctive-clause scoring** | Split measure titles on "OR / similar / including", score each disjunct, take max | 4-5 Newmont + Kering 3.3 |
| **R5c — Q4 tenant ID lookup** (bug-fix on R2) | Accept q4cdn.com tenant match via first-touch title identity, propagate to sibling URLs | 2 Newmont |
| **R5d — Kering-style policy vehicle expansion** | Raise R1 maxVehicles cap; remove "environmental statement" from REJECT | 1 Kering |
| R4 (out of scope for R5) | Country-gated EDGAR + domain-jurisdictional check | 2 Prudential |
| R6 (out of scope for R5) | HTML content extraction | 2 Walmart |

R5a and R5b are the main body of R5 (the original scope). R5c is a small bug-fix R5 should absorb because it's cheap and unblocks 2 more cells for the same investigation cycle. R5d is even cheaper and worth including.

## Implementation sequence

R5c and R5d first (they're small, high-confidence fixes). Then R5a. Then R5b (the largest single change).

Feature-flag every change: `R5A_SECTION_AWARE`, `R5B_DISJUNCT_SCORING`, `R5C_Q4_TENANT_MATCH`, `R5D_POLICY_VEHICLES`. Ship independently, measure each in a delta report.

## Feature-flag defaults

Start OFF except R5c (which is a bug fix — should default ON).

## Retro-simulation plan

Before shipping each sub-part:
1. **R5c**: verify that setting `provenance.classifyDocument` return `issuer` for `s24.q4cdn.com/382246808/…` when the first Newmont doc from that tenant has a title identity match. Retro-sim: seed one Q4 URL with title identity, then verify siblings pass.
2. **R5d**: bump maxVehicles to 12 and drop "environmental statement" from REJECT_PATTERNS. Retro-sim on the R1 test suite; verify Kering Environmental Policy URL is now generated.
3. **R5a**: pass Newmont 2024 SR PDF through section extractor; verify "Board Oversight of Sustainability" and "Partnerships" sections are detected; verify measure 1.1 and 1.5 select chunks from those sections.
4. **R5b**: parse each measure in framework 3 for disjunctive markers; verify 3.3-tnfd-leap-application splits into ["TNFD LEAP approach", "similar nature assessment methodology"]; verify Kering 3.3's TNFD Early Adopter quote scores Yes against the second disjunct.

## Cross-check with truth adjudication rules

The reconciled truth's `Explicit topic term` field is `True` for cells where a first-party document contains the topic term literally. The 7 Newmont FN cells + Kering 3.3 + Kering 1.2 all have `Explicit topic term=True` in the reconciled workbook — meaning R5 doesn't need to invent evidence, only to route the pipeline to evidence that's already present in first-party docs. Ceiling on R5's expected impact: essentially the full remaining 15 High-conf FN cell recall gap, minus Prudential's 2 cells (which are R4's remit) and Walmart's 2 cells (R6).

Expected R5-only recall lift on High-conf: from 81.0% (iter-14) to ~89% (closing ~10 of the 15 remaining FN cells). With R4 also, would go to ~91%.

## Next action

Prototype R5c first — it's a 30-line change (make Q4 CIK match either optional-when-title-matches, or add first-touch tenant→company propagation). Small enough to eyeball, biggest signal-to-noise ratio for R5's implementation risk.
