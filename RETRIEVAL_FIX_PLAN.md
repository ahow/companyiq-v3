# CompanyIQ v3 — Retrieval Robustness Fix Plan

Context: reviewer feedback on a ~370/2556 partial run. The dead-URL fix solved the
timeout/straggler problem but NOT the underlying retrieval problem. Adobe @ 9% is
the canary: 60 relevant docs discovered, but the key PDFs (AI Ethics Principles,
Responsible AI page, 10-K, proxy) came back `dead`, so the score is driven by a
marketing doc. This is structurally the same failure as v2 BoA @ 0%.

## Root causes (code-confirmed)

1. **Over-eager terminal 403 (my regression).** `processor.ts` treats a 403 on a
   direct file URL (`.pdf/.xlsx/...`) as `PermanentFetchError` and SKIPS the
   browser fallback entirely. But Adobe/MS/NVIDIA PDFs sit behind Cloudflare/
   Akamai WAFs that block plain-HTTP (TLS/JA3 + header fingerprint) yet a real
   browser session often passes. We gave up on exactly the docs that matter.

2. **Browser fallback cannot read PDFs.** `fetchWithBrowser` does `page.goto()`
   then scrapes `document.body.textContent`. For a PDF, Chromium shows its PDF
   viewer plugin and `textContent` is ~empty. So even when the browser runs on a
   protected PDF, it returns nothing useful. No byte-level PDF fetch path exists.

3. **No fetch-coverage signal at the result level.** Pipeline logs ok/dead counts
   but the company result does not expose "X of Y fetched" or a low-coverage flag.
   A 9% with 23/60 fetched looks identical to a genuine 9%.

4. **10-K Item 1A (risk factors) not guaranteed.** Measures 9.1/9.3 score "No"
   when the 10-K text isn't in the evidence pool, instead of abstaining. This
   conflates "absent evidence" with "negative evidence".

5. **measuresMet / measuresTotal null in API/CSV export.** Visible export bug.

## Prioritized fixes

### P0 — Protected-PDF byte fetch via browser (fixes #1 + #2 together)
- Add `fetchPdfViaBrowser(url)`: navigate to the origin to acquire WAF cookies,
  then run an in-page `fetch(url)` (reuses browser cookies + TLS fingerprint),
  read arraybuffer, base64 back to Node, `extractTextFromPdf`. Falls back to CDP
  `Page.navigate` + response body if in-page fetch is blocked by CORS.
- Re-route the `isCdnBlock` (403-on-file) and PDF-interstitial cases to this path
  INSTEAD of marking permanent. Only mark dead after the browser path also fails.
- Keep 401 paywall terminal (credentials genuinely absent).
- Keep timeouts dead-in-one-step (that fix was correct), but a 403/interstitial
  PDF gets ONE browser-PDF attempt before being marked dead.

### P1 — Fetch-coverage signal on the result
- Persist `documentsFetched`, `documentsDead`, `documentsDiscovered` on the
  company result; compute a `fetchCoverage` ratio + `lowCoverageFlag`
  (e.g. < 0.6 fetched OR any Tier-1 doc dead).
- Surface in API export so the UI can show "23 of 60 fetched — coverage may be
  incomplete" next to the score.

### P1 — measuresMet / measuresTotal export fix
- Populate these in the result payload + CSV/API serializer.

### P2 — 10-K Item 1A abstention rule
- If no 10-K/annual-report risk-factors text is in the evidence pool, mark 9.1/9.3
  as `abstain`/`insufficient_evidence` rather than `No`.

### Validation
- Re-run a sample: Adobe (the canary) + Microsoft, NVIDIA (Cloudflare/Akamai PDFs)
  + 2-3 already-working names as controls. Confirm Adobe's key PDFs now fetch and
  the score reflects real disclosure.

This document is scratch/internal and is git-ignored from commits.


---
---

# ADDENDUM (2026-06-19) — Reviewer-Concern Fix Plan v2 (post-550-run)

Branch: main (Railway worker, 3 replicas, production). The P0/P1 fixes above are
deployed. This addendum covers the four NEW reviewer concerns after the ~550-company
run: determinism, 10-K section-awareness, Chinese-listed zero-scores, mega-cap test.

## Production scoring configuration (workspace 3, from `workspace_settings`)

| Key | Value |
|-----|-------|
| scoring_provider | deepseek |
| ensemble_scoring | **false** (single-pass scoring) |
| ensemble_iterations | 3 |
| pipeline_llm_1 / 2 / 3 | deepseek / claude / openrouter |
| scoring_mode | binary |
| use_bm25_retrieval | true |
| terminology_discovery_enabled | true |

Implication: scoring is single-pass DeepSeek; ensemble is OFF, so multi-model
ensemble is NOT the variance source. Variance comes from the fallback chain and
evidence-pack/corpus differences.

## Concern 1 — Cross-run volatility ±20–34pp (Michelin +34, SocGen −26)

Root causes (ranked by controllable leverage):
1. **Silent cross-model fallback during scoring.** `completeWithFallback("deepseek")`
   (analyzer.ts:1002) tries DeepSeek once; on ANY error (timeout/500/network, not just
   429/401) it switches to a different model family (openrouter→openai→claude). One
   transient hiccup flips that measure's grader → Yes/No swing. A handful of flips
   across 34 binary measures = ±20–34pp.
2. **Evidence-pack / corpus variance** (document-set + terminology + deep-read differ).
3. **DeepSeek seed is best-effort** even at temp 0.

### Fix
- **Strict scoring provider** (`SCORING_STRICT_PROVIDER`, default ON): during scoring
  calls, retry the SAME provider (key rotation + backoff) instead of silently jumping
  model families; record `gradedBy` for audit. Fetch/summarize/terminology keep normal
  fallback.
- **3× self-consistency vote** (`SCORING_SELF_CONSISTENCY`, default 3): score each
  measure 3× same provider, take majority verdict (binary). Confidence High if
  unanimous, Medium if 2/3. Bounds residual best-effort-seed noise.

## Concern 2 — 10-K Item 1A retrieval (section-blind chunker)
Detect SEC item headings during chunking, tag chunks with `section`, and boost BM25
for chunks whose section matches risk/oversight measures (Item 1A / 7 / 7A).

## Concern 3 — Chinese-listed systematic zero-scores
1. Fetch gap (360 Security 1/5 docs) — diagnose dead docs + confirm Lane 4b gl=cn.
2. CJK tokenization broken — whitespace tokenizer collapses a Chinese paragraph to
   ~1 token → BM25 overlap ≈ 0. Add CJK character-bigram subtokens.

## Concern 4 — Mega-cap test set
Run + validate Adobe, Microsoft, NVIDIA, JPMorgan, Alphabet, Apple, Amazon, Meta,
Tesla, Wells Fargo, BNY Mellon, CBA, DBS vs known AI disclosures.
