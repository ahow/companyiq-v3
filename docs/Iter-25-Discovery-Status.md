# Iter-25 Document Discovery vs Truth — Status

**Date**: 2026-09-05
**Iteration**: iter-25 (batch 28), post R7 rollout
**Truth baseline**: 25 unique documents cited across 200 truth cells (10 companies × 20 measures)

## Headline

| Coverage tier | Count | % of 25 |
|---|---|---|
| **Exact URL match** — specific document is in the corpus | 12 | 48% |
| **Same doc class, different version/year** — pipeline found the equivalent document from a different reporting period | 5 | 20% |
| **Landing/parent path only** — corpus has an ancestor URL but not the truth doc itself | 1 | 4% |
| **Missed entirely** — nothing on that host in the corpus | 7 | 28% |
| **Effective coverage** (anything found on the host) | 18 | 72% |
| **Doc-class present** (exact + same-class) | 17 | 68% |

**Correction to earlier reporting**: Last session I quoted "60% at iter-24 vs 25 truth docs". The truth workbook actually contains 36 citations across **25 unique URLs**. I under-counted and mis-classified some landing-page matches as full-document matches. The corrected iter-25 numbers above use strict URL matching plus a year-agnostic doc-class comparator.

## What each miss actually is

### Same-class matches — 5 docs (probably fine for scoring)

Pipeline found the current-year equivalent; truth cites an older year. For a scoring test this is a genuine coverage hit — the analyst-cited disclosure and the pipeline-found disclosure describe the same programme with a year's drift.

| Company | Truth year → Found year |
|---|---|
| BHP Group Annual Report | 2024 → 2026 |
| Nestlé Creating Shared Value | 2024 → 2025 |
| Nestlé Non-Financial Statement | 2024 → 2025 |
| Samsung Sustainability Report | 2025 → 2022 (regression — older version found) |
| Walmart ESG Report | 2026 → 2025 |

The Samsung case is different: the pipeline found the 2022 report, not the 2025. R6a/R7d probably surfaced the older link because the newer URL sits behind csr.samsung.com which has weak Google indexing.

### Missed entirely — 7 docs (the real discovery gap)

| Company | Doc | Truth URL | Why R7 didn't catch it |
|---|---|---|---|
| Ambev | Ambev Annual & Sustainability Report 2024 (mziq CDN) | api.mziq.com/mzfilemanager/…/4856137f-de39-cf2f-a900-8114590d6230 | R7b added mziq to IR_PLATFORMS but no persisted tenant seeded R6a queries |
| Ambev | 6-K Reference Form 2025 (SEC) | sec.gov/…/abev20250520_6k.htm | R7c multi-form EDGAR should have pinned this — needs debug |
| BHP Group | 20-F 2024 (SEC) | sec.gov/…/d812514d20f.htm | Older filing pushed out by EDGAR "recent" window; R7c only pins the last 3 |
| Nestlé | Committee Charter (2026-05 filename) | nestle.com/sites/default/files/2026-05/corporate-governance-… | R7f compound-doctype splitting emitted `inurl:charter` queries but Serper didn't return this specific URL |
| Newmont | 2024 Sustainability Report (Q4 CDN) | s24.q4cdn.com/…/newmont-2024-sustainability-report.pdf | **R7a Q4 directory enumeration did not fire — no `irPlatformTenants` persisted for Newmont despite s24.q4cdn.com URLs already being in the corpus** |
| Newmont | Approach to Biodiversity (Q4 CDN) | s24.q4cdn.com/…/newmont-approach-to-biodiversity.pdf | Same root cause as above |
| Samsung | Conserving Biodiversity in DX Division (popup HTML) | samsung.com/global/sustainability/popup/popup_doc/AZ4apkJ6FFkALYM5 | Popup URL not linked from the main site's HTML — needs sitemap or targeted lane |

### Landing-only — 1 doc

Walmart's `regeneration-of-natural-resources` page. Corpus has `/purpose/esgreport` (the parent) but not the child page. R7e sitemap parsing worked for Nestlé (119 subpages emitted) but Walmart's sitemap either didn't return, wasn't accessible, or the parent didn't match `isEsgLandingPage()`.

## Per-company coverage

| Company | Exact / Total | Missed | Notes |
|---|---|---|---|
| **Kering** | 4/4 | 0 | Full coverage. ESEF + governance PDFs all captured. |
| **Unilever** | 2/2 | 0 | Full coverage. |
| **Banco Santander** | 1/1 | 0 | Full coverage. |
| **Prudential plc** | 1/1 | 0 | Full coverage. |
| **Walmart** | 1/3 | 1 (+1 landing) | ESG report family split across years; specific page missing. |
| **Nestlé** | 0/3 | 3 (but 2 same-class) | Older 2024 versions absent; 2025/2026 counterparts present. Committee charter genuinely missed. |
| **BHP Group** | 1/3 | 2 (but 1 same-class) | 2026 annual report found; 2024 20-F truly missing. |
| **Newmont** | 1/3 | 2 | Q4 CDN docs missed — R7a directory enumeration bug. |
| **Ambev** | 1/3 | 2 | mziq tenant not persisted; SEC 6-K not pinned. |
| **Samsung** | 0/2 | 2 (1 same-class) | Older 2022 report only; 2025 report on csr.samsung.com missed; popup URL missed. |

## Which R7 rules actually fired

I checked `discovery_diagnostics.lanes` on each company after the run:

| Rule | Companies fired | Doc count emitted | Status |
|---|---|---|---|
| **R7a** (Q4 CDN directory) | 0 / 10 | 0 | **Not firing** — no `irPlatformTenants` persisted for anyone, so the loop skipped everyone. R6a's tenant-persistence step didn't populate the field despite Newmont having Q4 URLs in its corpus. |
| **R7d** (landing seed) | 5 / 10 (BHP×3, Kering×1, Newmont×1, Samsung×1, Walmart×2) | 8 | Working but modest. Nestlé and Ambev didn't produce hits — their effective domains likely didn't match the probe patterns. |
| **R7e** (sitemap) | 1 / 10 (Nestlé×119) | 119 | Working for Nestlé (huge fan-out), silent for all 9 others. Most corporate sitemaps blocked or robots-restricted. |

R7b, R7c, R7f are config/query-shape changes and don't leave lane-level traces in the diagnostics — I can only see their effect indirectly through what docs landed in the corpus.

## Honest summary

**Discovery is capturing the right document class for 68% of the truth baseline (17/25) and finding an ancestor page on the same host for one more (72% effective coverage on-host)**. Seven documents are genuinely missing from the corpus.

The R7 rollout did move the needle on landing-page coverage for Nestlé (119 sitemap-emitted subpages) but two of its three headline rules — **R7a** and **R7e for hosts other than Nestlé** — are not delivering value in production:

- **R7a is broken end-to-end**: the tenant-persistence step at the end of R6a isn't populating the field R7a reads. Newmont has s24.q4cdn.com documents in its corpus but the pipeline never seeds a `{platform: "q4inc", tenant: "382246808"}` record, so R7a never enumerates the directory. Fixing this alone would very likely add both missed Newmont Q4 docs.
- **R7e works but only for one issuer** because most corporate sitemaps aren't reachable. This is expected: sitemap.xml is an opportunistic optimisation, not a reliable channel.

The remaining true-miss docs cluster into three distinct causes:

1. **SEC EDGAR window** (BHP 20-F 2024): R7c pins the last 3 annuals, but the truth cites a filing older than the window.
2. **URL patterns Serper cannot find** (Nestlé committee charter with 2026-05 datestamp, Samsung popup URLs): needs targeted host-specific enumeration.
3. **Wrong-year drift on issuer-hosted CDNs** (Ambev mziq, Samsung csr.samsung.com): needs the persisted-tenant loop that R7a is meant to power, but with tenants extracted from the FIRST run's IR-platform URL matches.

Ready to move on to fixes when you want; the highest-leverage single change looks like debugging why `irPlatformTenants` isn't persisting, which should recover Newmont's two Q4 misses and set R7a working for the rest of the population.
