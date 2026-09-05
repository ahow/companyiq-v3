# R7 — Discovery gap analysis and generalised rule design

## Purpose

After R6 shipped, truth-doc coverage on the 25 unique reconciled truth documents reached **60%** (15/25 exact-or-newer). The remaining 40% (10 truth URLs) fall into a small number of systematic mechanism gaps. This memo diagnoses each gap and proposes a generalised discovery rule.

## Gap inventory (10 problematic truth URLs)

| # | Company | Truth URL (abbreviated) | Verdict | Root-cause gap |
|---|---|---|---|---|
| 1 | Ambev | `api.mziq.com/mzfilemanager/…FY2024 Annual & Sust Report` | missed | IR-platform not in `IR_PLATFORMS` registry (mziq) |
| 2 | Ambev | `sec.gov/…/abev20250520_6k.htm` (Reference Form 2025) | missed | EDGAR 6-K filings not enumerated by lane; only 10-K/20-F pinned |
| 3 | BHP Group | `bhp.com/-/media/documents/investors/annual-reports/2024/…` | missed | Pipeline found the 2026 annual report but not 2024; truth-year mismatch (real doc found for different year) |
| 4 | BHP Group | `sec.gov/…/d812514d20f.htm` (FY2024 20-F) | missed | Same: pipeline pinned the 2026 20-F; truth-year mismatch |
| 5 | Kering | `filings.xbrl.org/…kering-2023-12-31-fr.xhtml` | in DB, fetch failed | R6c v2 discovered but fetcher returned dead; classified third_party by provenance |
| 6 | Nestlé | `nestle.com/…committee-charter.pdf` | missed | Framework requiredDocTypes includes "board committee charters" but no exact-phrase query built |
| 7 | Newmont | `s24.q4cdn.com/382246808/…/2025/newmont-2024-sustainability-report.pdf` | missed | Q4 CDN — R6a Serper-based bootstrap not surfacing specific URL |
| 8 | Newmont | `s24.q4cdn.com/382246808/…/priority-topics/…biodiversity.pdf` | missed | Same: Q4 CDN sub-directory not enumerated |
| 9 | Samsung | `samsung.com/global/sustainability/popup/popup_doc/AZ4apkJ6FFkALYM5` | missed | JS-populated popup viewer, but the parent `/global/sustainability/` HTML DOES contain the link. R6e never fired because that landing page isn't in corpus |
| 10 | Walmart | `corporate.walmart.com/purpose/esgreport/regeneration-of-natural-resources` | landing-only | R6f `parseSitemapForSubpaths` exists but was never wired into the discovery pipeline |

## Root-cause categorisation

**Category A — Truth-year mismatch, not a real discovery gap** (BHP #3, #4; also Nestlé already resolved via newer-version match)
- Not a discovery-side fix. The pipeline correctly finds the CURRENT year of the required document type; the truth baseline references older versions.
- Handled by treating "newer-version-of-same-doc" as a hit in coverage measurement (already implemented in the coverage analyser). No rule needed.

**Category B — Directory / index enumeration not called for the discovered host** (Newmont #7, #8; Ambev #1)
- All three fit the pattern: **we know the host and the tenant path, but Serper doesn't surface every PDF under it.** The fix is deterministic directory traversal — the same pattern R6c v2 used for ESEF.
- Applies to any IR-platform CDN with an Apache/nginx index, or any AEM DAM path.

**Category C — EDGAR filing types beyond 10-K/20-F** (Ambev #2)
- Current `edgar-submissions` lane pins only the latest annual filing per issuer. Any 6-K (foreign-issuer material events), DEF 14A (proxy), 8-K (current report) is only found by luck via web search.
- Fix: extend `edgar-submissions` to pull the latest N filings of each relevant type for the issuer, keyed on CIK.

**Category D — Landing-page discovery gaps** (Samsung #9)
- R6e link-farming only fires on landing pages ALREADY in the candidate pool. Samsung's `/global/sustainability/` isn't discovered because Serper prefers other Samsung pages. Fix: seed the corporate sustainability landing page directly using known URL patterns rather than waiting for Serper to surface it.

**Category E — Sitemap-based subpage enumeration not wired in** (Walmart #10)
- The helper function `parseSitemapForSubpaths` exists in `r6-discovery.ts` but the discovery pipeline never calls it. Fix: wire it into the R6e/R6f block so we attempt `/sitemap.xml` when a landing page is found.

**Category F — Framework-declared doc-types not producing specific-phrase queries** (Nestlé #6)
- `requiredDocTypes` includes "board committee charters or terms of reference" but `buildDisclosureVehicleQueries` uses the whole phrase as-is, which Serper matches loosely. Fix: split multi-clause doc types (`X or Y`) and generate a query per clause with quotation marks.

**Category G — R6c v2 discovery works but fetch fails / provenance mis-classifies** (Kering #5)
- Not a discovery gap. The truth URL WAS discovered but the fetcher couldn't retrieve the gzipped XHTML, and even the .zip package was classified as `third_party` by the provenance gate — which then filters it out at scoring time.
- Fix: (a) add `filings.xbrl.org` and `www.hkexnews.hk` to the provenance classifier's regulator-host list so they get labelled `regulator` not `third_party`; (b) add a fetch-fallback that retries with `Accept-Encoding: gzip` explicitly when Node's automatic decompression fails on these Apache-served files.

## Generalised rules

### R7a — Directory-index enumeration for known-tenant CDNs

**Mechanism**: When R6a discovers an IR-platform tenant path (e.g. `s24.q4cdn.com/382246808/`), directly fetch the tenant's directory index (`{platform-host}/{tenant}/files/doc_downloads/` for Q4, `{tenant}/files/annual_reports/` etc) and parse the Apache/nginx HTML index for `<a href="*.pdf">` links.

**Generalisation**: applies to every IR-platform whose tenant path serves an Apache/nginx directory index. Same pattern as R6c v2's `filings.xbrl.org` directory traversal (which we didn't need only because ESMA has a JSON API).

**Fallback path for hosts WITHOUT an index**: use HEAD requests on known conventional subdirectories (`/files/doc_financials/`, `/files/doc_downloads/`, `/files/annual_reports/`, `/files/sustainability/`, `/files/policies/`) and parse whatever comes back.

**Expected coverage lift**: Newmont's 2 URLs, plus latent hits on any issuer using Q4Inc, Investis, Computershare, Nasdaq IR.

### R7b — mziq.com and other IR-platform registry additions

**Mechanism**: extend `IR_PLATFORMS` in `r6-discovery.ts` with additional providers common outside the US:

- `api.mziq.com` — SelfWealth (Brazilian issuers: Ambev, Vale, Petrobras, Itaú, B3)
- `northeurope.blob.euroland.com` and `press-releases-attachments.euroland.com` — Euroland (European mid-caps)
- `s3.amazonaws.com/finexecutivereports/*` — Various small/mid caps
- `assets.contentstack.io` — Contentstack (some US issuers)
- `wilddogdigital.com`, `computershareweb.com`, `precisionir.com`

Each entry: hostname pattern, tenant-extraction regex, seed-search template. First-run bootstrap queries `site:<host> "<company>"`, tenant discovered from result URLs is persisted for subsequent runs.

**Generalisation**: applies to every issuer using one of these IR platforms.

**Expected coverage lift**: Ambev mziq URL + latent hits for other Brazilian/European mid-cap issuers.

### R7c — Multi-year, multi-form EDGAR enumeration

**Mechanism**: extend `resolveAuthoritativeAnnualFilings` (`server/lib/discovery.ts:1815`) to pull the last N filings per form type from EDGAR's `submissions/CIK<cik>.json`, not just the single latest annual filing.

For each issuer with a CIK, pin URLs for:
- Latest 3 annual filings (10-K / 20-F / 40-F) — currently only 1 pinned
- Latest 3 proxy filings (DEF 14A / DEFA14A / PRE 14A)
- Latest 6 material-event filings (6-K, 8-K) — new
- Latest 4 quarterly filings (10-Q, 6-K quarterly) — new

**Reason for capping**: EDGAR issuers with 500+ 6-Ks over the years would blow the corpus budget; N=6 for 6-K is enough to catch recent-year sustainability updates while staying bounded.

**Generalisation**: applies to every US-listed and dual-listed issuer with a CIK. Bounded by N so single-issuer budget is predictable.

**Expected coverage lift**: Ambev 6-K URL + latent hits on any issuer whose sustainability disclosures land in 6-K/proxy rather than annual reports.

### R7d — Corporate landing-page seeding

**Mechanism**: before running discovery lanes, ATTEMPT to fetch a set of known corporate-landing URL patterns for the issuer:
- `<effective_domain>/sustainability/`
- `<effective_domain>/esg/`
- `<effective_domain>/responsibility/`
- `<effective_domain>/purpose/`
- `<effective_domain>/environment/`
- `<effective_domain>/climate/`
- `<effective_domain>/investors/` and `<effective_domain>/investor-relations/`
- `<effective_domain>/en/sustainability/` (localised variant)
- `<effective_domain>/global/sustainability/` (Samsung-style global-prefix pattern)

For each candidate URL that returns HTTP 200 with a substantive HTML body, add it as a first-class candidate with `lane=r7d-landing-seed`. Then R6e link-farming can extract sub-page links from those landings.

**Generalisation**: applies to every issuer with a known effective domain. Bounded by ~10 URLs × 3s HEAD-request timeout = ~30s worst-case per issuer.

**Expected coverage lift**: Samsung popup_doc + latent hits on any issuer whose landing pages aren't returned by Serper.

### R7e — Wire in `parseSitemapForSubpaths` on discovered landing pages

**Mechanism**: R6e's `extractLandingPageLinks` currently only extracts `<a href>` from HTML. Add a parallel step: for each landing page detected, ALSO fetch `<domain>/sitemap.xml` (and `sitemap_index.xml`) and use existing `parseSitemapForSubpaths` to enumerate all URLs under the landing page's parent path. Emit those as candidates in a new `r7e-sitemap` lane.

**Generalisation**: applies to every issuer with a public sitemap. Best-effort — many issuers block sitemap access (BHP's returns 403), so failure is silently swallowed.

**Expected coverage lift**: Walmart regeneration-of-natural-resources + latent hits on any web-native ESG-report tree.

### R7f — Split multi-clause `requiredDocTypes` into per-clause queries

**Mechanism**: `buildDisclosureVehicleQueries` treats `"board committee charters or terms of reference"` as a single phrase and quotes it as-is, which Serper matches poorly. Split on ` or `, `, `, `/`, `and`, `&` and generate a quoted query per clause. Combine into an OR search.

Also: for compound doc types, generate a filename-hint query — Serper often finds documents by URL slug better than title:
- `"board committee charter"` → also emit `inurl:charter filetype:pdf "<company>"`
- `"terms of reference"` → also emit `inurl:tor OR inurl:terms-of-reference filetype:pdf "<company>"`

**Generalisation**: applies to every framework with multi-clause doc types. Purely a query-generation enhancement.

**Expected coverage lift**: Nestlé committee charter + latent hits on any framework declaring compound doc types.

### R7g — Add regulator hosts to provenance classifier + fetch fallback

**Mechanism**:

1. `filings.xbrl.org`, `www.hkexnews.hk`, `www1.hkexnews.hk`, `sedarplus.ca`, `asx.com.au` are ALREADY in the ranking priority list AND `STATUTORY_REGISTRY_HOSTS`, but the provenance classifier (`server/lib/provenance.ts`) may not tag them as `regulator` (needs verification). If they're being tagged `third_party`, U17 filters them from scoring.

2. Fetch fallback for gzipped Apache directories: when a URL ends in `.xhtml` and the fetcher returns 200 but empty body (or dead status), retry with `Accept-Encoding: identity` to bypass Node's decompression, then decompress manually with `zlib`.

**Generalisation**: applies to any regulator-hosted primary filing. Small fix, high impact for Kering ESEF + potentially other ESEF filings across the EU-27 issuer universe.

## Combined expected effect

| Rule | Truth URLs closed | Latent expected lift |
|---|---|---|
| R7a | 2 (Newmont Q4) | Q4Inc, Investis, Nasdaq IR issuers |
| R7b | 1 (Ambev mziq) | Brazilian & European mid-caps |
| R7c | 1 (Ambev 6-K) | Any FPI 6-K sustainability filers |
| R7d | 1 (Samsung landing) | Any issuer with corporate landing pages |
| R7e | 1 (Walmart subpage) | Any web-native ESG report tree |
| R7f | 1 (Nestlé charter) | Any framework with compound doc types |
| R7g | 1 (Kering ESEF fetch) | Any ESEF/HKEX-hosted primary filing |
| **Total** | **8 additional truth URLs** | Broader benchmark impact |

Combined coverage projection: **60% → 92% of unique truth docs** on this 10-company benchmark. The 2 remaining misses (BHP annual + 20-F truth-year mismatch) are truth-baseline artefacts, not discovery gaps.

## Rule interaction & ordering

- R7c (EDGAR extension) is a small change to an existing lane — easy first.
- R7b (registry additions) is a config-only change — trivial to ship.
- R7f (query splitting) is a query-builder tweak — no runtime cost.
- R7g (provenance + fetch fallback) needs verification of the provenance classifier before coding.
- R7a and R7d require modest runtime cost (each fetches 5-20 URLs per issuer). Both bounded, both time-bounded.
- R7e (sitemap parsing) requires wiring the existing helper into `discovery.ts`.

Suggested ship order: R7b → R7c → R7f → R7g → R7e → R7d → R7a. Group into 2-3 PRs for atomic deploys.

## Out of scope

- JS-rendered content extraction (Puppeteer-based crawling). Samsung's popup_doc is directly linked from `/global/sustainability/` in raw HTML, so R7d + R6e is sufficient. But some issuers (React SPAs) render everything in JS and would need Puppeteer.
- Company-specific hard-coded patterns. Every rule above is generalised to a population of issuers with the trait.
- Chunking / retrieval improvements (Stage 2). This memo is discovery-only.
