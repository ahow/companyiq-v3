# R6 — Generalised discovery rules to close FN gaps in the corpus

## Purpose

The current discovery pipeline reaches 41% (iter-14) / 36% (iter-19) of truth-source URLs on the Nature-framework 10-company evaluation set. This document proposes six generalised discovery rules (R6a–R6f) that, together, would let the pipeline reach the remaining truth URLs. Each rule is deliberately generic — it applies to any framework, any issuer with the relevant characteristic, not just the specific FN cell that motivated it.

## Method

For each FN cell that has a known truth-source URL, I identified the URL fingerprint (hostname, path shape, filename pattern), the reason the current discovery pipeline missed it, and the smallest generalised rule that would capture the class of documents like it.

## Rules

### R6a — IR-platform tenant enumeration

**Motivating misses** (Newmont): `s24.q4cdn.com/382246808/files/doc_downloads/sustainability/...`, `s24.q4cdn.com/382246808/files/doc_downloads/priority-topics/...`

**Class of documents affected**: Sustainability reports, annual reports, and other investor documents hosted on shared IR-platform CDNs (Q4Inc `s24.q4cdn.com`, Nasdaq IR `nasdaq.com/api/v1/document`, Edelman `ir.edelman.com`, ShareFile, Investis Digital, Bakery Marketing). These CDNs serve multiple issuers under numeric tenant IDs; each tenant maps 1:1 to a real company but the hostname carries no company identifier.

**Rule**: At the issuer-profile resolution stage, for each known IR-platform pattern, run a one-time discovery query `site:<cdn> <company legal name>` to identify the tenant path prefix, then persist the discovered tenant path on the company record (new column `ir_platform_paths`). On subsequent runs, seed `site:s24.q4cdn.com/<tenant>/` as a first-class domain-search target.

**Generalisation check**: applies to every issuer whose IR outsources to a template provider (widespread US mid- and large-caps; also many European issuers).

**Complementary code**: R5c already relabels s24.q4cdn.com as first_party — R6a fills in the missing discovery step so those URLs actually enter the candidate pool.

**Estimated effect**: 2 truth URLs for Newmont; likely 3-8 across a broader benchmark.

---

### R6b — Multi-lingual query variants keyed on issuer locale

**Motivating miss** (Banco Santander): `www.santander.com/content/dam/santander-com/en/documentos/informe-anual-de-sostenibilidad/2024/sustainability_statement-2024-en.pdf` — filename uses Spanish path components (`documentos`, `informe-anual-de-sostenibilidad`) even though the file itself is the English-language version.

**Class of documents affected**: Company websites in non-English HQ countries where the URL path uses local language even for the English-content page. Notable in: ES/PT/FR/DE/IT/JP/KR/CN/BR HQ issuers.

**Rule**: For each candidate topic term used in query generation, produce localised variants keyed on `issuer.country` (or `issuer.locale`):
- ES/MX/AR: sostenibilidad, informe anual, reporte
- FR/BE: durabilité, rapport annuel, extra-financier
- DE/AT/CH: nachhaltigkeit, geschäftsbericht
- IT: sostenibilità
- PT/BR: sustentabilidade
- JP: サステナビリティ, 統合報告書
- KR: 지속가능경영
- CN: 可持续
Add these variants to the general and domain lanes. Keep an OR clause so localised and English variants both match.

**Generalisation check**: applies to any framework, any issuer with a non-English HQ. Six of the ten companies in our benchmark are non-English HQ (Ambev BR, Banco Santander ES, Kering FR, Nestlé CH, Prudential HK/UK dual, Samsung KR).

**Estimated effect**: 1 truth URL for Santander; broader impact likely at 3-5 URLs across non-English issuers on any framework.

---

### R6c — Regulator-repository targeting (ESEF, HKEX, EDGAR)

**Motivating misses**:
- Kering — `filings.xbrl.org/549300VGEJKB7SVUZR78/2023-12-31/ESEF/FR/0/kering-2023-12-31-fr/reports/kering-2023-12-31-fr.xhtml` (ESMA ESEF)
- Prudential plc — `www.hkexnews.hk/listedco/listconews/sehk/2025/0409/2025040900057.pdf` (Hong Kong Exchange)

**Class of documents affected**: Regulator-hosted primary filings for issuers listed on non-US exchanges. These are the authoritative version of the annual report / prospectus for each jurisdiction and often contain the fullest disclosure.

**Rule**: At the issuer-profile resolution stage, look up ALL of the issuer's listing venues via FIGI (openfigi's `securities` field returns every exchange listing under one composite FIGI). For each listing venue, register the venue-specific filing repository as a regulatory-lane target:
- US listing (any exchange, CIK known): `sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>` + `sec.gov/Archives/edgar/data/<CIK>/` — already covered
- LSE listing: `londonstockexchange.com/stock/<ticker>/*/news` — partly covered
- EU regulated market listing (any EU-27), LEI known: `filings.xbrl.org/<LEI>/` — NEW
- HKEX listing: `hkexnews.hk/listedco/listconews/sehk/*/<hk-numeric-code>/*.pdf` (find by stock code from FIGI, not always numeric-derived — may need a HK-code resolution step) — NEW
- TSX: `sedar.com/DisplayCompanyDocuments.do?lang=EN&issuerNo=<sedar-id>` — future
- ASX: `www.asx.com.au/asxpdf/*.pdf` — future

Each venue-specific repository is added to the regulatory lane's candidate pool.

**Generalisation check**: applies to every framework, every issuer with a listing outside the US. Approximately 60% of the MSCI ACWI. Dual-listed issuers get multiple repositories.

**Estimated effect**: 2 truth URLs across Kering (ESEF) and Prudential (HKEX). Broader effect for global benchmarks likely 10-20 truth URLs on a 100-company panel.

---

### R6d — Framework-declared regulatory disclosure document types

**Motivating miss** (Nestlé): `www.nestle.com/sites/default/files/2025-02/non-financial-statement-2024.pdf` — this is Nestlé's CSRD Sustainability Statement for FY2024. The URL contains "non-financial-statement" — a specific EU CSRD/NFRD document type that our current queries do not know to search for.

**Class of documents affected**: Regulator-mandated report types that use jurisdiction-specific filename conventions:
- EU CSRD "Sustainability Statement" / "non-financial statement"
- UK Companies Act "Section 172 Statement" / "Streamlined Energy and Carbon Report (SECR)"
- US SEC "Form 10-K", "Proxy Statement", "Sustainability Report"
- Japan METI "有価証券報告書" (Yūka Shōken Hōkokusho)
- Global voluntary: TCFD, TNFD, ISSB S1/S2, SASB

**Rule**: Frameworks declare not only their topic vocabulary but also a `document_type_hints` field listing regulator-mandated document types the framework's evidence typically appears in. R1 already added `document_types` at framework level — extend it with jurisdiction-aware document-type patterns. For issuer of jurisdiction X on framework F, generate site-search queries: `site:<issuer.domain> "<document-type>" filetype:pdf` for each `document_type` in `F.document_types WHERE jurisdiction ∈ (X, "global")`.

**Framework-3 (Nature) document_type_hints already has "sustainability report", "non-financial statement" — verify these are being passed to the query generator with quotation-preserved phrase matching**, not tokenised.

**Generalisation check**: applies to every framework, every issuer. This is a framework-side extension that requires per-framework curation but each addition serves every issuer.

**Estimated effect**: 1 truth URL for Nestlé; broader effect for CSRD-reporting EU issuers likely 5-10 URLs on a 100-company benchmark.

---

### R6e — Link-farming from first-party landing pages

**Motivating misses** (Walmart):
- `corporate.walmart.com/purpose/esgreport/regeneration-of-natural-resources` (HTML subpage)
- `corporate.walmart.com/content/dam/corporate/documents/esgreport/2026/FY2026-Walmart-ESG-Report.pdf` (AEM DAM PDF)

**Class of documents affected**: Deeply-structured ESG reporting sites where:
(a) the ESG report is broken into topic-specific HTML subpages under a common parent (Walmart `/purpose/esgreport/*`, Home Depot `/responsibility/*`, Nestlé `/sustainability/nature-environment/*`), or
(b) the PDF version is hidden behind a CMS asset path (Adobe AEM `/content/dam/*`, Drupal `/sites/default/files/*`) that is only linked from the landing page.

**Rule**: When the domain-search lane discovers a top-level ESG landing page (any URL matching `/(esg|sustainability|responsibility|purpose|impact|corporate-responsibility|planet|nature)/?(report)?/?$` or containing an "ESG report" title fragment), also FETCH that HTML page, extract all `<a href>` links whose target is:
- Same-origin `.pdf`
- Same-origin `/content/dam/*`, `/sites/default/files/*`, `/media/*`, `/downloads/*`
- Same-origin path under the landing-page parent (`/purpose/esgreport/*` for Walmart)
- Cross-origin to a known IR-platform CDN (R6a)

Emit those extracted URLs as first-class candidates in a new `link-farm` lane. Rank them via the same gate & retrieval pipeline; do not exempt them from provenance/topic filters — this is a discovery multiplier, not a bypass.

**Generalisation check**: applies to every framework, every issuer with a corporate ESG landing page. This is arguably the single highest-leverage discovery rule because ESG landing pages are how issuers themselves organise their disclosures.

**Complementary code**: R6e effectively re-purposes the existing `evidence-expansion` lane (which already extracts inline PDF links from arbitrary pages) to be seeded by domain-search landing-page hits, not just by measure-level search results.

**Estimated effect**: 2 truth URLs for Walmart; broader impact likely 5-10 URLs across most issuers on any framework.

---

### R6f — Sub-page enumeration on ESG report URL trees

**Motivating miss** (Walmart): `corporate.walmart.com/purpose/esgreport/regeneration-of-natural-resources` — one of ~15 topic subpages under `/purpose/esgreport/*`. Iter-14 accidentally found several via a lucky general-query hit; iter-19 does not.

**Class of documents affected**: Companies whose "ESG report" is a **sitemap of HTML subpages** rather than a single PDF (Walmart, Home Depot, Microsoft, Google, Amazon, and increasingly common as issuers move to web-native reporting).

**Rule**: Once R6e has extracted the first-party landing page for an issuer, run a second-pass query `site:<domain> inurl:<parent-path>` (e.g. `site:corporate.walmart.com inurl:/purpose/esgreport/`) with each of the framework's topic tokens appended as free-text (biodiversity, water, climate, governance...). This returns any subpage of the tree that matches ANY topic token. Combine with sitemap.xml discovery: if `<domain>/sitemap.xml` exists, parse it and extract all URLs under the ESG landing-page path.

**Generalisation check**: applies to every framework (topic tokens come from the framework), every issuer with a web-native ESG tree. This is a superset of R6e for the specific pattern of hierarchical HTML reports.

**Estimated effect**: 1 truth URL for Walmart; potentially transformative for future web-native reporters as PDF disclosure declines.

---

## Rule interaction & ordering

R6a → R6c → R6b → R6d → R6e → R6f in resolution order:

1. **R6a and R6c** are issuer-profile augmentations, run once per company at profile-resolution time. They ADD candidate site-search targets (IR CDNs, filing repositories) that persist across runs.
2. **R6b and R6d** are query-generation augmentations, applied per run. They ADD variant queries to the general and domain lanes.
3. **R6e and R6f** are two-stage discovery augmentations. They EXPAND the candidate pool from a landing-page hit, and are cheap to run once per issuer per run.

None of the six rules changes the gate, provenance filter, or retrieval logic. They all only affect **which URLs enter the candidate pool** — the same downstream stages then filter, rank, and score them exactly as before. This keeps R6 orthogonal to R5 (which touched provenance) and to future retrieval work.

## Non-goals

- R6 does not attempt to improve chunk ranking or retrieval quality. Those are Stage 2 problems, addressed separately after discovery is closed.
- R6 does not attempt to reduce false positives. All new candidates go through the existing gate and provenance filter unchanged.
- R6 does not attempt to increase corpus size for its own sake. The goal is to close specific gaps between the corpus and truth-source documents; the mean corpus size increment is expected to be small.

## Expected combined effect

- All 8 currently-MISSED truth-source URLs across Newmont/Santander/Kering/Nestlé/Prudential/Walmart become discoverable if all six rules ship correctly.
- Because the FN cells with truth URLs are the HARDEST subset (they persisted through iter-13 to iter-19), closing them at discovery should move the pipeline from ~36% truth-URL coverage on FN cases to close to 100%.
- Whether that translates to a full recall recovery depends on whether the newly-discovered documents are then retrieved into top-20 chunks and correctly scored — those are Stage 2 and Stage 3 problems, addressed separately.
- Conservative estimate: recall improvement of +5 to +10 percentage points on High-conf on this benchmark; noise-floor considerations mean this must be measured across multi-run medians, not single runs.

## Rollout plan

Ship in this order to keep each PR small and separately measurable:

1. **PR-R6a** — IR-platform tenant enumeration. Small, self-contained, targets Newmont's 2 URLs.
2. **PR-R6c** — Regulator-repository targeting (ESEF + HKEX). Targets Kering, Prudential.
3. **PR-R6b** — Localised query variants. Targets Santander + many latent misses on non-English issuers.
4. **PR-R6d** — Framework-declared document types with jurisdiction hints. Targets Nestlé + broader latent CSRD misses.
5. **PR-R6e** — Link-farming from ESG landing pages. Targets Walmart's PDF + broader latent misses.
6. **PR-R6f** — Sub-page enumeration on ESG report trees. Targets Walmart's HTML subpage tree.

Each PR should include:
- A unit test that fixtures a small HTML/JSON response and asserts the rule fires and emits the expected candidate URL
- An integration diagnostic added to `discoveryDiagnostics.lanes` (e.g. new lanes `ir-tenant`, `regulator-eu`, `regulator-hk`, `link-farm`, `subpage-enum`)
- An update to the Investigation-Prudential-Kering memo or a new memo pointing to which truth URLs the PR closes

## Open questions before implementation

1. **R6a (IR-platform enumeration)**: what is the authoritative list of IR platforms and their URL patterns? Q4Inc (`s24.q4cdn.com`), Investis Digital, Nasdaq IR, Sharefile, ShareFile Edelman are known; a complete list needs a small research pass (probably 15-25 patterns covers 90%+ of listed issuers).
2. **R6c (regulator repositories)**: FIGI OpenFIGI is our current identifier resolver but does not always return every listing venue reliably for dual-listed issuers. May need a fallback (LSE listing lookup by ISIN, HKEX search by legal name, TSX SEDAR by CUSIP).
3. **R6b (locale variants)**: does the current query generator preserve non-ASCII characters (Japanese, Korean, Chinese) through the search API? Verify Serper/Bing/Google search endpoints accept the vernacular queries and return meaningful results. Fall back to Latin transliteration only if not.
4. **R6d (document types)**: which jurisdiction ↔ document-type mapping to encode? Start with a small set (EU CSRD → "Sustainability Statement", "non-financial statement"; UK Companies Act → "Section 172 Statement"; US SEC → "10-K", "Sustainability Report"). Extend as more jurisdictions enter the benchmark.
5. **R6e (link-farming)**: how to bound the number of extracted links per landing page? Cap at (say) 50 links per landing page to prevent explosion, ranked by heuristic (path-depth, filename topic-token match, filename year-recent).
