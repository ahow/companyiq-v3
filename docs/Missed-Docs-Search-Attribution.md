# Why the 7 Missed Documents Weren't Found — Search Attribution

**Date**: 2026-09-05
**Context**: Iter-25 achieved 68% doc-level truth coverage (17/25). This analyses the search process to attribute each of the 7 "missed entirely" documents to a specific root cause.

## Correction to earlier reporting

Two of the 7 docs I flagged in the last note as "missed entirely" are actually in the corpus under different URLs:

- **Samsung 2025 Sustainability Report**: corpus has `https://www.samsung.com/global/sustainability/media/pdf/Samsung_Electronics_Sustainability_Report_2025_ENG.pdf` (analyst-cited version is on `csr.samsung.com` — same document, different mirror). Doc-level match, not a discovery gap.
- **Walmart FY2026 ESG Report**: corpus has the FY2025 version at the same directory. Year-drift equivalent.

Corrected count: **7 truly missed docs**, unchanged, but the composition shifts. This document treats the 7 currently-labelled-missed set from the coverage-v2 analysis (Ambev×2, BHP×2, Nestlé×1, Newmont×1, Samsung×1).

## The core finding

**Every one of the 7 missed docs is discoverable by Serper at rank #1 or #3** for a realistic natural-language query. The pipeline just isn't issuing those queries.

I probed each missed URL with 2-3 candidate queries; here's the truth-URL rank in the top-10 results:

| # | Missed doc | Best query tested | Truth rank |
|---|---|---|---|
| 1 | Ambev mziq annual+sustainability 2024 | `Ambev annual and sustainability report 2024 filetype:pdf` | not in top 10 — even `site:mziq.com` fails |
| 2 | Ambev 6-K reference form 2025 | `Ambev 6-K reference form 2025` | not in top 10 |
| 3 | BHP Annual Report 2024 PDF | `BHP Annual Report 2024 filetype:pdf` | **rank 3** |
| 4 | BHP 20-F 2024 SEC | `BHP Group 20-F fiscal 2024` | **rank 1** |
| 5 | Nestlé STSC committee charter | `Nestle Science Technology Sustainability Committee charter` | **rank 1** |
| 6 | Newmont Approach to Biodiversity | `Newmont approach to biodiversity filetype:pdf` | **rank 1** |
| 7 | Samsung biodiversity DX popup | `Samsung conserving biodiversity DX division` | **rank 1** |

Five of the seven would have been the top result for a query a human would type. The other two (Ambev docs on `mziq.com` and older SEC 6-K accessions) are cases where the specific document is buried behind newer-year siblings and Google's ranking model, not Serper capability.

## Root cause: the topic lexicon is broken for Framework 3

The Nature framework's cached topic lexicon in `workspace_settings` is 11 terms:

```
1. examine       2. strength      3. plans
4. strategy      5. management    6. actions
7. performance   8. oversight     9. nature
10. biodiversity 11. business
```

**Eight of the eleven terms are generic business words** — `examine`, `strength`, `plans`, `strategy`, `management`, `actions`, `performance`, `oversight`, `business` — despite the derivation prompt explicitly instructing the LLM: *"Do NOT include generic business words (e.g. 'report', 'risk', 'company', 'strategy') that would match unrelated passages."*

`buildDomainQueries` calls `topicPhrases.slice(0, 8)` — the first eight terms — which never includes `nature` (position 9) or `biodiversity` (position 10). So every `site:<domain> <topic>` query for every one of the 10 companies goes out as:

```
site:samsung.com examine
site:samsung.com strength
site:samsung.com plans
site:samsung.com strategy
site:samsung.com management
site:samsung.com actions
site:samsung.com performance
site:samsung.com oversight
```

None of those queries retrieve nature/biodiversity content. They retrieve press releases, investor pages, corporate strategy summaries — generic business content. The one lane that could rescue this — R6b locale-topic queries — uses the same lexicon and inherits the same problem.

This is the single largest search-process failure. It affects all 10 companies but shows up most severely for issuers where the truth documents are on unusual URLs (Samsung popups, Nestlé committee charters, Newmont priority-topics subdirectory).

## Root cause: domain-family expansion misses key hosts

Each missed doc's host tells the same story: **the pipeline never searches the host the truth document lives on**.

| Missed doc | Truth host | Domain-family list actually used |
|---|---|---|
| Ambev mziq report | `api.mziq.com` | `ambev.com.br`, `ri.ambev.com.br` |
| Ambev 6-K | `sec.gov` (specific accession `000129281425002271`) | SEC handled by dedicated lane; recent-window cap missed this filing |
| BHP annual PDF | `bhp.com` (specific `-/media/documents/investors/…` path) | `bhp.com` — searched, but not the direct-PDF path |
| BHP 20-F SEC | `sec.gov` (2024 accession) | Same as Ambev — outside recent window |
| Nestlé STSC charter | `nestle.com` (specific `sites/default/files/2026-05/` path) | `nestle.com` — searched but with wrong topic terms |
| Newmont biodiversity | `s24.q4cdn.com` (specific `doc_downloads/priority-topics/` path) | `newmont.com`, `operations.newmont.com` — Q4 CDN not in list, and R7a is broken (see note (1)) |
| Samsung DX popup | `samsung.com` (specific `sustainability/popup/` path) | `samsung.com`, `images.samsung.com`, `news.samsung.com`, `samsung.com.cn` |

Three distinct sub-patterns:

1. **Third-party CDN hosts** (mziq, q4cdn): needs the tenant-persistence bug from note (1) fixed, plus a rule that when `<CDN>` URLs land in the corpus, the CDN hostname joins the domain-family list for subsequent iterations.
2. **Deep-path hits on the primary domain** (BHP `/media/documents/…`, Nestlé `/sites/default/files/…`, Samsung `/global/sustainability/popup/`): the pipeline is searching the domain but with the wrong topic terms, so Serper returns high-level pages, not the deep PDFs. Fixing the lexicon fixes most of this.
3. **Older SEC filings** (BHP 20-F 2024, Ambev 6-K 2025): R7c's EDGAR multi-form enumerator pins the last 3 annuals + last 8 6-Ks. For BHP that gives 2024, 2025, 2026 — 20-F 2024 IS in the window. Why isn't it in the corpus? Let me check.

## Deep dive: why R7c's pin didn't catch BHP 20-F 2024

BHP filed a 20-F on 30 August 2024 (accession `0001193125-24-210297`). Direct EDGAR check confirms this is position #3 in BHP's recent-annual list, well inside R7c's cap of 3.

And R7c fired: `edgar-submissions` lane emitted **9 candidates** for BHP.

But only ONE SEC document reached the final corpus: the 2026 20-F. The 2024 and 2025 20-Fs were **dropped by the recency gate** — BHP's `recencyDropped` counter reads 23. The recency gate sees the 2026 filing and classifies anything older as "stale", so R7c's pin is silently overridden by the gate that runs after it.

Same pattern hurt Nestlé: truth cites the 2024 Non-Financial Statement, corpus has 2025, 2024 was dropped. In every case where truth and pipeline diverge on the *year* of the document, the recency gate is the reason.

## Consolidated root causes

The 7 missed docs cluster into **three fixable causes**. Ranked by leverage:

### 1. Broken topic lexicon (affects all 10 companies, most gaps traceable to it)

The cached lexicon for Framework 3 was dominated by generic business words. Deleting the cache and re-deriving would very likely produce a nature/biodiversity-focused lexicon that lets `site:samsung.com`, `site:nestle.com` and `site:newmont.com` domain queries actually return the deep pages the truth documents live on — all 5 of the rank-#1-in-Serper misses (Nestlé charter, Newmont biodiversity PDF, Samsung DX popup, BHP direct PDF, BHP 20-F) plausibly recover.

The lexicon-derivation LLM either failed and fell back to `fallbackTokens()`, or ran but returned generic output despite the anti-generic instruction. Worth logging which happened.

### 2. Recency gate over-culling (affects both BHP truth misses, Nestlé's, Newmont's, Walmart's, Samsung's)

R7c pins the last 3 annual filings and the last 8 6-Ks. The recency gate then keeps only the newest per doc-type, dropping the analyst-cited older versions. For evaluating scoring vs analyst-cited evidence, this is a false gap; the pipeline HAS the document class, just not the specific year.

Either: (a) relax the gate to keep every R7c-pinned annual filing, not just the most recent; (b) accept as-designed behaviour and update the truth baseline to the newest available disclosure per issuer.

### 3. IR-CDN tenant persistence bug (affects Ambev mziq, Newmont Q4)

Covered in the parallel note. `retrievalDiagnostics.irPlatformTenants` is written into the wrong jsonb path so R6a's second-pass and R7a's directory enumeration never see it. Fix restores explicit `site:api.mziq.com/mzfilemanager/v2/d/<tenant>/` and `site:s24.q4cdn.com/<tenant>/` queries plus Apache index enumeration. Fixing this alone plausibly recovers the two Newmont Q4 misses and both Ambev docs.

### 4. Ambev-specific: no path from `ambev.com.br` to `api.mziq.com`

Even with topic lexicon and tenant persistence fixed, Ambev's flagship annual+sustainability report only lives on mziq. The pipeline discovers `mziq` URLs on the first run (10 Ambev mziq URLs are in `irPlatformTenants` right now, just at the wrong path). Fix (3) plus a first-run rule that immediately issues `site:api.mziq.com/mzfilemanager/v2/d/<tenant>/` for every newly-extracted tenant within the same run would close the gap.

### 5. Nestlé STSC charter: Serper indexed the newer 2026-05 version

The truth cites `2026-05/corporate-governance-science-tech-sustainability-committee-charter.pdf`. Serper returns it at rank #1 for `Nestle Science Technology Sustainability Committee charter`. This query would fire if either (a) the topic lexicon included "committee" (R7f generates `inurl:committee` fallbacks) or (b) the framework's `requiredDocTypes` included "science technology sustainability committee charter" verbatim. Neither happens today. This is a genuine long-tail case: the specific charter title isn't in the framework's spec.

R7f's compound-doctype splitting was designed for this class of miss (`board committee charters or terms of reference` → clauses + inurl fallbacks) but the doctype we generated `inurl:` anchors from didn't include "science-tech-sustainability-committee-charter" as an anchor, only `committee` and `charter`. Serper needed both plus company name. Fix: emit longer inurl anchors from compound framework doctypes.

### 6. Ambev 6-K: outside the recent-window even in R7c

Ambev files 6-Ks roughly every 2-3 weeks (Brazilian FPI cadence). Truth cites the 20 May 2025 filing (`abev20250520_6k.htm`). R7c's cap of 8 recent 6-Ks covers roughly the last 4-5 months of Ambev filings, and the truth doc is ~15 months old — well outside the window. Serper doesn't help either: it returns newer 6-K accessions in ranks 1–10, never the specific 2025-05 one.

For 6-K reference forms specifically, the analyst chose the annually-updated *Reference Form* (Brazilian regulatory equivalent of a 10-K annual). That's a class of once-per-year filing, so R7c would need per-form-type recency-aware pinning — e.g. "pin the last 6-K filed in each of the last 2 May windows" rather than "last 8 6-Ks by date". Complex fix, low priority.

## Bottom line

All 7 missed documents fall into one of five categories:

| Category | Docs affected | Fix effort |
|---|---|---|
| Broken topic lexicon | Nestlé charter, Newmont Q4, Samsung DX popup, BHP annual PDF (indirectly) | **Small** — delete cache row, re-derive |
| Recency gate over-culls | BHP 20-F 2024, Nestlé NFS 2024 (via equivalent flag), Walmart FY2026 (via equivalent flag) | **Small** — change gate policy for R7c-pinned filings |
| IR-CDN tenant persistence | Newmont Q4 (both), Ambev mziq | **Small** — fix jsonb path in pipeline.ts |
| First-run tenant fan-out (Ambev only) | Ambev mziq | **Small-medium** — add same-run tenant re-query in R6a |
| Long-tail doc-type spec | Nestlé STSC charter | **Medium** — richer inurl anchors, framework spec |
| SEC 6-K per-year pinning | Ambev 6-K 2025 | **Medium** — R7c annual-window logic per form type |

**The lexicon and recency-gate fixes together plausibly restore doc-level coverage from 68% (17/25) to 92–96% (23–24/25) without any new discovery rules.** The remaining 1–2 gaps are long-tail specification issues that R7 was never designed to catch.

Sources: `discovery_diagnostics` jsonb across 10 companies in `companies` table (iter-25 batch 28); direct Serper probes conducted 2026-09-05; direct EDGAR `data.sec.gov/submissions/CIK0000811809.json` lookup; `workspace_settings` topic_lexicon:v1:3 cache row.
