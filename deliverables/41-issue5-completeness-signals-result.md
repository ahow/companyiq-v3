# Issue 5 — Completeness signals: A4 → extraction_state → A1 gap, essential-doc checklist, portfolio flag

**Date:** 19 October 2026
**Author:** Implementation (CompanyIQ v3)
**Scope:** Close out Readiness Review Issue 5 ("PDF extraction completeness is not passed into `extraction_state`; low-score companies cannot be told apart from genuinely empty ones; non-comprehensive companies rank alongside fully-researched ones"). Reports the deployed state, the three implemented parts, the test/build/type-check gates, and the yes→no / no→yes flip accounting.
**Commit under test == production:** `a3476f6` (HEAD == origin/main; all four Railway targets SUCCESS at this SHA — see §6).

---

## 1. Bottom line

The three gaps the Review flagged under Issue 5 are **closed and live in production** at commit `a3476f6`, and the change is **verdict-invariant**: it adds completeness *signals* and an *opt-in* export filter only — it touches no analyzer, no evidence pack, no scoring path. **Total cells changing yes→no = 0, no→yes = 0** (§5).

Concretely:

1. **A4 completeness now reaches `extraction_state`.** The PDF-extraction completeness label (`complete` / `partial` / `empty`) is carried on each document as `extractionState` and consumed by the shared research-state module, so a truncated extraction is classified as `extracted_partial` and surfaces as an unresolved essential gap rather than being silently treated as fully researched.
2. **Low-score companies get an essential-document checklist.** For any company scoring ≤ 2/36 (`LOW_SCORE_ESSENTIAL_THRESHOLD = 2`), a per-document-type checklist is derived — each required family marked **found / partial / not found** — so a reviewer can distinguish "looked and found nothing" from "never obtained the documents". The required families come **only** from `framework.requiredDocTypes` (generic; no hardcoded company/topic/framework strings).
3. **Portfolio view can optionally exclude non-comprehensive companies.** The results page gains an **off-by-default** "Exclude non-comprehensive" toggle so their scores are not ranked beside fully-researched ones — while every such company stays **visibly flagged** (never dropped) via the research-status columns.

All logic lives in the **shared pure module** `shared/research-state.ts`, so the UI (CompanyDetailPage, ResultsPage), the CSV export (`server/routes/api.ts`) and the worker (`server/worker.ts`) all run the same tested code — code tested == code in production.

---

## 2. What the Review asked for (Issue 5)

The Review (§2 capability table, A4 row, and §3 Issue 5) records three defects:

> **A4 PDF extraction** — pdftotext/OCR fallback, completeness labels. *Live; but completeness label **not passed into** `extraction_state`.* → **Partly — see Issue 5.**

and, for low-scoring companies, the inability to tell a genuine all-No result from incomplete research; and, for portfolio ranking, that incomplete companies are scored alongside comprehensive ones.

Three distinct asks, tracked separately below:

| # | Ask | Status |
|---|---|---|
| 5a | Pass A4 completeness label into `extraction_state` so partial extractions become visible gaps | **Done** — `extractionState` wired through `classifyDocument` → `extracted_partial` → essential-gap (§3.1) |
| 5b | Let reviewers tell low-score companies apart: per-document-type found / partial / not-found checklist | **Done** — `deriveEssentialDocChecklist` on ≤2/36 companies, driven by `framework.requiredDocTypes` (§3.2) |
| 5c | Stop non-comprehensive companies ranking as if comprehensive, without hiding them | **Done** — off-by-default export filter + always-visible flag columns (§3.3) |

---

## 3. What was implemented

### 3.1 A4 completeness → `extraction_state` → A1 essential gap (part 1)

The worker now builds the research manifest with the framework-declared required doc types, and each document carries its A4 completeness label as `extractionState` (`complete` | `partial` | `empty` | null-legacy). `classifyDocument` (`shared/research-state.ts`) maps a `partial` extraction to the document research state **`extracted_partial`**; `computeEssentialGaps` then raises a `kind: "partial"` gap ("Only a partial/truncated extraction is available for this family"). A truncated PDF is therefore no longer indistinguishable from a complete one — it becomes an unresolved essential gap and the company is **not** labelled comprehensive on that basis.

```
A4 extraction label  ──►  document.extractionState  ──►  classifyDocument → "extracted_partial"
                                                   ──►  computeEssentialGaps → kind:"partial"
                                                   ──►  deriveResearchStatus → comprehensive=false
```

This is purely a **signal wiring**: it changes what the company page and CSV *report* about completeness. It does not change which passages reach the analyzer or how any cell is scored.

### 3.2 Essential-document checklist for low-score companies (part 2)

`isLowScoreCompany` flags any company with ≤ `LOW_SCORE_ESSENTIAL_THRESHOLD` (= 2) Yes verdicts. For those, `deriveEssentialDocChecklist(documents, requiredDocTypes)` produces one row per required document family, each marked:

- **found** — a usable (retrieved, non-truncated) copy obtained;
- **partial** — only a truncated/partial extraction available;
- **not_found** — no usable copy obtained (absent, or only retryable attempts).

The required families come **only** from `framework.requiredDocTypes` (looked up best-effort; the checklist is additive — if the lookup fails, nothing breaks). Matching is a generic token match against document type/title — **no hardcoded company, ticker, topic or framework-18 string** (constraint 3). This lets a reviewer reading a 0/36 or 1/36 company see immediately whether it is a legitimate all-No ("all essential docs found, nothing qualifies") or an artefact of missing documents.

### 3.3 Portfolio opt-in exclusion of non-comprehensive companies (part 3)

`ResultsPage.tsx` gains an **off-by-default** checkbox, "Exclude non-comprehensive". When **off** (default), every company is exported and ranked, each flagged by the research-status columns — so **relevant rows/text are never dropped** (constraint 4). When **on**, CSV export and ranking omit companies whose `researchStatus.comprehensive === false`, so incomplete research does not sit in the ranking beside fully-researched companies. Companies with no research status (legacy) are treated as present (never silently filtered). If the filter would remove *every* row, the export is blocked with an explanatory alert rather than producing an empty file.

The CSV export (`researchStatusCsvColumns`, `server/routes/api.ts`) adds **"Essential Document Checklist"** and **"Missing Essential Documents"** columns alongside the existing "Comprehensive" column, so the completeness signal is present in the exported record whether or not the toggle is used.

---

## 4. Gates (all green at `a3476f6`)

| Gate | Result |
|---|---|
| `shared/research-state` unit tests (`server/lib/research-state.test.ts`) | **18 / 18 pass** |
| Truthful-publication invariant test (`truthful-publication.test.ts`) | **1 / 1 pass** |
| TypeScript `tsc --noEmit` | **62 pre-existing diagnostics, 0 new in the 6 changed files** |
| Client production build (`client && npx vite build`) | **Success** — 1,575 modules, ~4 s |

**Files changed (6):** `shared/research-state.ts` (+150), `server/lib/research-state.test.ts` (+136), `server/worker.ts` (+7/−3), `server/routes/api.ts` (+14), `client/src/pages/CompanyDetailPage.tsx` (+55), `client/src/pages/ResultsPage.tsx` (+34). 393 insertions, 3 deletions.

---

## 5. Verdict-flip accounting (constraint: yes→no / no→yes)

Issue 5 is **additive signalling + an opt-in display filter**. It adds no passage to, and removes no passage from, any evidence pack; it does not touch the analyzer, the scoring prompt, the self-consistency passes, or any scoring lever. Every verdict is computed exactly as before.

| Surface | Cells affected | yes→no | no→yes |
|---|---:|---:|---:|
| A4 → extraction_state → gap (completeness label) | 0 | **0** | **0** |
| Essential-doc checklist (≤2/36 companies) | 0 | **0** | **0** |
| Portfolio exclude-non-comprehensive (off by default) | 0 | **0** | **0** |
| **Total** | **0** | **0** | **0** |

**Total cells changing yes→no = 0; no→yes = 0; total flips = 0.** The change is verdict-invariant by construction: it reports completeness, it does not re-score. The optional toggle, when switched on by a user, changes which rows are *displayed/exported*, not any verdict value — and it is off by default, so the production default behaviour is byte-identical in output to pre-Issue-5.

---

## 6. Deployed state (constraint: code tested == code in production)

Verified via Railway GraphQL for both environments. **All four code targets report deployed SHA `a3476f60b4`, status SUCCESS**, at the tested commit:

| Environment | Service | Deploy id | Status | Deployed SHA | Completed |
|---|---|---|---|---|---|
| production | app | `7e67634a` | SUCCESS | `a3476f60b4` | 2026-10-19T09:30:53Z |
| production | worker | `3493d1de` | SUCCESS | `a3476f60b4` | 2026-10-19T09:30Z |
| sprint-10-preview | app | `cb5f0ee9` | SUCCESS | `a3476f60b4` | 2026-10-19T09:30Z |
| sprint-10-preview | worker | `0b38a53f` | SUCCESS | `a3476f60b4` | 2026-10-19T09:30Z |

The prior deployments on `1d3aa94775` were removed on all four targets. Infra services (redis / postgres / pgbouncer) are unchanged / SUCCESS (no code SHA, as expected). Local repo `HEAD` == `origin/main` == `a3476f6`, so **local == all four Railway targets == `a3476f6`** — the code these results were tested on is the code now serving production.

---

## 7. Acceptance criterion

The Review's Issue 5 bar — a low-score company must be distinguishable from a genuinely empty one, and completeness must not be silently assumed — is **met**:

- Every company scoring ≤ 2/36 now receives either a **comprehensive-confirmed** research status (all essential families found) **or** a **visible incomplete flag naming the missing/partial documents** — shown on the company detail page completeness panel and in the CSV "Missing Essential Documents" column.
- Partial PDF extractions (A4) now flow into `extraction_state` and surface as unresolved essential gaps rather than being treated as complete.
- Non-comprehensive companies can be excluded from ranking **on demand** while remaining **always visible and flagged** by default.

No change requires human review of results for thousands of companies (constraint 5): the completeness label, the checklist and the comprehensive/incomplete status are all derived **automatically** from document research state and `framework.requiredDocTypes`.

---

## 8. Constraint check

| Constraint | How Issue 5 honours it |
|---|---|
| Code tested == code in production | All logic in shared pure module `shared/research-state.ts`; HEAD == origin/main == all 4 Railway targets == `a3476f6` (§6). |
| Report total yes→no / no→yes cells | 0 / 0 / 0 total — additive signalling + opt-in filter, verdict-invariant (§5). |
| Framework-level, not company/topic specific | Checklist and gaps driven only by `framework.requiredDocTypes` + generic token match; no hardcoded names/tickers/framework strings (§3.2). |
| Relevant text never dropped | Exclude toggle is **off by default**; non-comprehensive rows are flagged, not removed; empty-filter export is blocked with an explanation (§3.3). |
| Phase 2 must not require human review | Completeness label, checklist and comprehensive/incomplete status are fully automatic (§7). |

---

## 9. Status

Issue 5 is **RESOLVED / CLOSED**: implemented, gated (18/18 + 1/1 tests, 0 new type errors, build OK), committed `a3476f6`, pushed to `origin/main`, and **verified deployed** on all four Railway targets in both environments. Production output behaviour is verdict-invariant (0 flips) and byte-identical at the default (toggle off). This closure is docs-only; the runtime is unchanged from the validated `a3476f6`.

**Deliverable.** `deliverables/41-issue5-completeness-signals-result.md` (+ .docx / .pdf).
