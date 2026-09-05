# Discovery-to-Corpus Pipeline: Every Filter and Cap

Written to correct my earlier hand-wave that there were "~15 stages between discovery and corpus". The actual number is **11 filter/cap stages** in the discovery pass plus **3 more after fetch**. Every stage that can drop a URL is listed here. Line numbers refer to `server/lib/discovery.ts` and `server/lib/pipeline.ts` on main at `78ef148` (after PRs #25–#28).

Not counted: URL de-duplication in `addCandidate` (which is a bug source, see PR #29) and the fetcher's HTTP-error handling (which produces `fetch_status='dead'` for network failures rather than a filter).

## Discovery pass (server/lib/discovery.ts)

The pipeline runs 20+ discovery **lanes** in sequence, each calling `addCandidate` to append to `allCandidates`. Then everything flows through these stages:

| # | Stage | Line | What it does | Configurable |
|---|---|---|---|---|
| 1 | **URL deny-list** | ~4318 | Blocks a hard-coded set of noise hosts (Wikipedia, podcasts, LinkedIn, Reddit, etc.) — applied inside `addCandidate` too | Constant `DENY_LIST_DOMAINS` |
| 2 | **Low-quality EDGAR filter** | ~4380 | Drops SEC index pages, bare accession-folder URLs, XBRL viewer URLs, non-primary exhibits, Untitled EDGAR pages | Hard-coded regexes |
| 3 | **Aggregator filter** | ~4395 | Drops known-blocked third-party aggregator hosts (`BLOCKED_AGGREGATOR_DOMAINS`) | Constant |
| 4 | **Wrong-entity heuristic filter** | 4407 | Rejects URLs whose title contains a KNOWN_OTHER_COMPANIES peer name and does NOT contain the target's own name words | Peer-name list from workspace |
| 5 | **Disambiguation filter** | 4412 | Rejects URLs whose title contains a hard-excluded entity token (e.g. distinct issuers sharing an ambiguous ticker) | `disambiguationExclusions()` |
| 6 | **Non-US EDGAR cap** | 4442 | For non-US issuers, keeps only the top-5 **unprotected** SEC EDGAR URLs by priority (protected lanes exempt after PR #27) | `MAX_EDGAR_FOR_FOREIGN=5` |
| 7 | **Pre-gate cap** | ~4491 | Caps the candidate pool at `PRE_GATE_CAP=180` before the LLM gate. Protected lanes (edgar-submissions, ESEF, HKEX, cninfo, registry-search, pinned) exempt; policy-vehicle docs get 10 reserved slots (R5d) | Constant, env-tunable |
| 8 | **LLM relevance gate** | 4495 | DeepSeek classifier accepts/rejects each URL against framework topic. Protected lanes bypass after PR #26 | LLM prompt-based |
| 9 | **EDGAR date enrichment + recency gate** | 4511–4527 | Groups periodic filings (10-K, 20-F, annual report, proxy) by type. Keeps all in-window (last 4 years); keeps `OUT_OF_WINDOW_SOFT_CAP=2` older per type. Env-tunable after PR #25 | `RECENCY_WINDOW_YEARS=4` |
| 10 | **Near-duplicate collapse** | ~4590 | Groups by `(formKey, year, titleStem)` and keeps ONE winner per group by (authorityClass ASC, fineScore DESC, urlHash ASC) | Function `collapseNearDuplicates` |
| 11 | **Ranker cap** | ~4610 | Ranks with layered signal `(authorityClass, fineScore, urlHash)` and slices to `MAX_DOCS_RETURNED=90` | Constant |

Output: `discoveryResult.documents` — the final corpus that gets fetched.

## Post-discovery, post-fetch (server/lib/pipeline.ts)

After `searchCompanyDocuments` returns and each URL is fetched:

| # | Stage | Line | What it does |
|---|---|---|---|
| 12 | **Provenance classification (first pass)** | 339 | `classifyProvenance` runs on URL+title to tag each doc as `issuer` / `third_party` / `generic`. Records `source_type` on the document row. |
| 13 | **Provenance classification (second pass)** | 369 | R5c re-runs classification on `third_party` URLs after tenant discovery, so IR-platform siblings get upgraded to `issuer` |
| 14 | **U17 provenance filter (post-fetch)** | 1450 | With full fetched content, re-classifies and DROPS any `third_party` document from the analyzer evidence pack. Guarded by env `U17_PROVENANCE_FILTER` (default `true`) |

Stages 12–14 don't remove documents from the `documents` table — those docs stay recorded with `gate_verdict='reject'` and a reason — but they DO exclude them from what reaches the LLM scoring engine.

## Where can a valid document be lost?

Ranked by risk of silently dropping a valid document. Ranked by my priors, not measurement yet:

| Stage | Risk of losing a valid analyst-cited doc | Why |
|---|---|---|
| **8** LLM relevance gate | HIGH | Filenames like `bhp-20240630.htm` have no topic vocabulary; LLM rejects them (fixed for protected lanes in PR #26) |
| **11** Ranker cap | MEDIUM-HIGH | 90-doc cap; if the corpus is dense in one lane (e.g. R6e link-farm), other lanes' good docs get pushed out |
| **6** Non-US EDGAR cap | MEDIUM | Only 5 unprotected SEC URLs kept for foreign issuers (fixed for protected lanes in PR #27) |
| **10** Near-duplicate collapse | MEDIUM | If two truth docs share form+year+titleStem, one is dropped |
| **9** Recency gate | LOW after PR #25 | Now keeps all in-window; historical soft-capped at 2 per type |
| **7** Pre-gate cap | LOW | Protected lanes exempt; 180-slot budget rarely fills for a single issuer's target docs |
| **4** Wrong-entity heuristic | LOW-MEDIUM | Can reject a real doc if its title happens to name another peer more prominently than the issuer |
| **14** U17 provenance filter | MEDIUM | Third-party hosts that ARE cited by analysts (e.g. `filings.xbrl.org`, `hkexnews.hk`) get dropped unless explicitly whitelisted in `REGULATOR_HOSTS` |

## What I can't currently see

The DB records aggregate counts per stage (`totalCandidates`, `preGateFiltered`, `gateAccepted`, `recencyDropped`) but **no per-URL trace**. So I can't answer "did BHP's 2024 20-F ever enter the candidate pool at stage N?" without either:

1. Re-running the pipeline with instrumentation
2. Fetching the raw Serper responses per lane (not preserved)
3. Analyzing per-URL trace via a debug endpoint (doesn't exist)

Point 1 is what I'd propose next: add a temporary per-URL trace to `addCandidate` and each filter stage, run one company end-to-end, and produce an exact funnel report showing which stage killed each analyst-cited URL. The trace would be off by default (env-gated) so it doesn't pollute production runs.
