# Why live production runs "miss documents" — a grounded diagnosis
_2026-11-15 · companyiq-v3 · evidence from the production (caboose) database and the deployed worker environment_

## Bottom line

For the **mature production frameworks** (AI Management / fw21, Physical Climate v3 / fw22) the run is **not, in the main, missing documents at discovery**. The corpora are thick and complete. The zeros you keep seeing are dominated by a different failure — **the grader cannot extract evidence from non‑English disclosures** — plus the occasional **stalled batch** that retrieved nothing at all. Discovery breadth *is* the problem in one specific place: **under‑configured frameworks built by the v2 builder (fw24)**, which ship without the query fields that drive discovery. Every discovery‑completeness change we made earlier in this chat is implemented in `main` **and** switched on in the production worker; the discovery‑watch daemon shows they worked (≈6× more documents found, dead‑links 15%→1%). So the lever that will move the needle now is **corpus extraction (non‑English passage retrieval), not more search** — except for the under‑built frameworks, where it is both.

---

## 1. Are all the earlier changes actually implemented? Yes — code *and* prod env.

I checked the deployed `origin/main` (`864ecce`) against every completeness change from this chat, then checked the **production worker's** runtime environment (Railway prod env `c1166ef6…`, worker service `27920e1f…`).

| Change (from earlier in this chat) | In deployed `main`? | Live in prod worker? |
|---|---|---|
| `fetchRatio` 0.7 fetch‑weakness gate | ✅ `pipeline.ts` L2251‑2321 | `FETCH_RATIO_THRESHOLD=0.7` |
| Dead‑link retry (ships dark by default) | ✅ `pipeline.ts` L2064‑2145 | **`FETCH_DEAD_RETRY_ENABLED=true`** — the dark flag is ON |
| Generous fetch budget | ✅ default 6 min | **`FETCH_PHASE_BUDGET_MS=1200000` (20 min)** |
| Low‑discovery / low‑retrieval dashboard flags + rerun | ✅ `api.ts` L2747‑2844 | code defaults (0.7 / 0.3 / 10 / 3) |
| Deferred‑retry + host‑history browser routing | ✅ `pipeline.ts` | `INCOMPANY_FETCH_CONCURRENCY=4`, `HOST_FAIL_THRESHOLD` default 3 |
| FMP transcripts lane + domain identity policy | ✅ `discovery.ts` ~L4100‑4330 | — |
| Retrieval tuning (per‑measure evidence packs) | ✅ `analyzer.ts` | `RETRIEVAL_EVIDENCE_TOP_K=20`, `RETRIEVAL_SECTION_BOOST=2.5`, `RETRIEVAL_LLM_RESCORE=1`, `RETRIEVAL_EVIDENCE_MAX_CHARS=30000` |

Nothing from the earlier work is sitting un‑deployed or dark. **Proof it worked** — the discovery‑watch daemon, baseline (11‑08) → latest (11‑15):

| Metric | 11‑08 | 11‑15 |
|---|---|---|
| Avg documents discovered / company | 19.2 | **113.9** |
| Avg documents used / company | 12.2 | **101.7** |
| Dead‑link % (of resolved) | 14.8% | **1.1%** |
| "OK" fetch % | 63.4% | **89.3%** |

One thing **not** enabled: multi‑pass **ensemble discovery** (`ENSEMBLE`/`ITERATION` unset → a single discovery pass per run). That is an available lever, not a regression.

---

## 2. What the live production data actually shows

### The healthy run (the real baseline)
Batch 2538 / result 862 — **AI Management (fw21), 2,339 companies, 2026‑11‑14**: 2,338 of 2,339 reached `comprehensive` coverage and were scored on all 37 measures. This is a healthy run, not a broken one.

Within it, **387 companies (16.5%) scored exactly 0** despite `comprehensive` coverage. Those are the "misses" worth explaining — and they are **not thin corpora**:

- Median corpus among the zeros = **53 documents**; **306 of 387 (79%) had 40+ documents**. Only 6 had a thin (6‑15 doc) corpus.
- The zeros skew hard to **non‑English markets: 70%** of them (vs 59% of positive‑scorers). China alone is **162 of 387 (42%)**. Chinese companies score zero at **~33%**, versus **~12%** for US companies.

### Two Chinese companies, same corpus depth, opposite outcome
- **Ganfeng Lithium (score 0):** 85 discovered, 82 fetched, `fetchRatio 0.96`, coverage **full**, `lowEvidence=false`. Discovery is excellent. Yet **all 37 measures = "No" with blank rationales**. Its corpus is almost entirely **Chinese‑language** PDFs (cninfo.com.cn 年度报告, hkexnews Chinese filings).
- **Aier Eye Hospital (score 70):** 79 discovered, 71 fetched. Also majority‑Chinese titles (55 of 71), **but** every winning "Yes" quote is pulled from its **English‑language HKEX filing** ("…we pursued 'digital and AI ophthalmology'…").

The difference is not what was found — it is **what the grader could read**. When a company discloses only in Chinese (or Japanese/Korean), the English‑oriented passage‑retrieval and grading layer surfaces nothing and the company takes a **false zero**. Companies with a parallel English filing (HKEX dual‑language, ADR 20‑F) score normally.

### The scary‑looking "avg 0" run was a stall, not a comprehensiveness failure
Batch 2270 / result 864 — fw21, **573 companies, average 0** — looks alarming, but every company has `coverage.retrieved = 0`, `denominator = 0`, `measuresTotalCount = 0`. **Zero documents were retrieved for all 573.** That is the signature of a **stalled/aborted run** (search‑provider outage, quota exhaustion, or a worker restart mid‑batch), not of the framework missing relevant documents. It should be re‑run, not re‑engineered — but it also argues for a **resumable / auto‑requeue** safety net so a mid‑run stall doesn't leave 573 companies parked at zero.

---

## 3. Is it related to the framework specification? Yes — specifically the query‑data fields.

Discovery breadth is **driven by data on the framework row**, assembled in layers by `buildGeneralQueries` (`discovery.ts` L1611): `search_templates` → `legacy_query_templates` (else a thin generic 6‑query fallback) → `required_doc_types` → vehicle queries, plus `multi_document_query_templates`, `retrieval_query_terms`, `topic_synonyms`, `document_priority_url_patterns`, `adjacent_topics` feeding the other lanes. **A framework that doesn't populate those fields gets a thin search.**

Query‑field population, from the production DB:

| fw | search_tpl | legacy | multidoc | retr_terms | synonyms | req_doc | url_pat | status |
|---|---|---|---|---|---|---|---|---|
| 21 AI Mgmt | 0 | 8 | 0 | 29 | 38 | 13 | 0 | prod (2,339‑co run) |
| 22 Phys Climate v3 | 10 | 10 | 10 | 29 | 11 | 27 | 13 | **active** |
| 24 Phys Climate (v2 builder draft) | **0** | **0** | **0** | 30 | 33 | 60 | **0** | test drives |

fw22 (hand/imported v3.1) is richly configured. **fw24 — the framework behind the recent test drives — is missing `search_templates`, `legacy_query_templates`, `multi_document_query_templates` and `document_priority_url_patterns` entirely**, so it falls back to the thin generic queries + vehicle queries. Same engine, far narrower search, because the **v2 builder populates a different (smaller) field set** than the v3.1 import did. This is the clearest "framework‑specification" cause of genuinely missed documents — and it only bites the newer, builder‑made frameworks.

Note `generateQueryVariants` (`discovery.ts` L1555) is also deliberately instructed to stay narrowly on‑topic ("Do NOT generate generic sustainability/ESG queries unless that IS the topic"). That protects precision but can skip broad disclosures that merely *contain* the relevant section — a tunable, not a bug.

---

## 4. Do we need more comprehensive search, or more comprehensive extraction?

Both, but for different frameworks:

**Extraction (the big lever for mature prod — fw21/fw22).** The dominant miss is **non‑English evidence**, not missing files. The fix is at the grading layer, not discovery:
1. **Language‑aware passage retrieval + translation at the grading step** — detect CJK/non‑Latin passages and translate candidate chunks before BM25/embedding selection and grading. This directly targets the ~33% Chinese zero‑rate and the blank‑rationale all‑No pattern.
2. **Prefer the English edition when a dual‑language filing exists** (HKEX `_e`/`en` variants, 20‑F) — already partly present; worth hardening into an explicit ranking boost.

**Search (the lever for under‑built frameworks — fw24 and future builder frameworks).**
3. **Backfill fw24's missing query fields** (`search_templates`, `legacy_query_templates`, `multi_document_query_templates`, `document_priority_url_patterns`) — the `build_fw22_v31.py` import is a working template.
4. **Make the v2 builder auto‑populate those fields** so every future framework ships with full discovery breadth instead of the thin fallback.

**Resilience (so stalls stop masquerading as misses).**
5. **Auto‑requeue / resume** batches that finish with `retrieved=0` across many companies (the 2270 signature), instead of leaving them at zero.

**Optional breadth.**
6. **Enable ensemble discovery (`ITERATION>1`)** for a second varied pass + union on low‑coverage companies — more recall at a search‑cost increase; worth A/B'ing before switching on fleet‑wide.

---

## Suggested priority
1. Language‑aware extraction/translation at grading (fixes the largest, most frequent miss class in live prod). 
2. Backfill fw24 query fields + fix the v2 builder to populate them (fixes genuinely thin discovery on new frameworks). 
3. Auto‑requeue zero‑retrieval batches (stops stalls looking like comprehensiveness failures). 
4. Dual‑language English‑edition preference; then evaluate ensemble iterations.

_No code has been changed or deployed for this diagnosis — it is read‑only analysis of production data and the deployed environment._



---

# ADDENDUM (correction) — the English majors are a DIFFERENT problem

My first write-up diagnosed the non-English zero cohort in the mature AI run. That does **not** explain the companies you actually watched in the test drives — **L'Oréal, General Electric, ExxonMobil, TotalEnergies** — which are English reporters. Those are a separate root cause. Evidence from fw24 test results 865–868 (same companies, repeated runs):

| Company | 865 | 866 | 867 | 868 | corpus grew | CJK docs |
|---|---|---|---|---|---|---|
| ExxonMobil | 0 | 11 | 19 | 16 | 76→110→116→125 | 0 |
| TotalEnergies | 0 | — | 30 | 27 | 49→…→102→109 | 0 |
| General Electric | 0 | 0 | 0 | 0 | 53→83→88→93 | 0 |
| L'Oréal | 0 | 0 | 0 | 0 | 42→58→58→59 | 0 |

**Score tracks corpus size/composition, not language (0 CJK docs).** ExxonMobil flipped 7 measures No→Yes between run 865 (corpus 76) and run 867 (corpus 116). The qualifying evidence is plain English and genuine — e.g. *"The Hebron platform… reinforced concrete"* (physical adaptation), *"Hurricane Harvey's impacts… approximately $160 million in 2017"* (quantified financial impact). It simply wasn't in the smaller corpus. This is **run-to-run discovery non-determinism**, not an extraction/language miss.

### Why this cohort swings (and why some stay stuck at 0)
1. **Discovery is non-deterministic** — live Serper results + no fixed corpus across runs + in-memory cache cleared on worker restart → the corpus differs every run. The specific doc holding the qualifying passage (CDP response, TCFD report, 10-K Item 1A) is present some runs, absent others.
2. **Physical-climate evidence is diffuse and threshold-sensitive** — scattered across many doc types and sitting right on the Yes/No boundary, so small corpus changes flip verdicts (Exxon, Total).
3. **fw24 is thinly configured** (no `search_templates` / `legacy_query_templates` / `multi_document_query_templates` / `url_patterns`) → it leans on the non-deterministic generic fallback, which makes the corpus *more* volatile and sometimes never surfaces the one doc that matters (GE at 93 English docs, L'Oréal at 59, still 0 — a corpus-composition miss, not depth).

### Will my four proposed changes fix L'Oréal / GE / Exxon / Total?
**Mostly no.** Of the four:
- Language-aware extraction → **no effect** (English).
- Auto-requeue zero-retrieval batches → **no effect** (these had full coverage).
- Dual-language English preference → **no effect**.
- Backfill fw24 query fields + fix the v2 builder → **partial help only** — a richer, more stable query set makes the corpus more complete and less volatile, which would lift GE/L'Oréal off false zeros and dampen the Exxon/Total swings, but it does not make discovery *deterministic*.

**The real fix for this cohort is the reproducibility / corpus-composition work, not the language work:**
- **A** — **Fix the corpus across runs** (discover-once → score-many / corpus replay, threaded by source batch), so the same company sees the same evidence every run and borderline measures stop flipping.
- **B** — **Make discovery reliably surface the diffuse physical-climate artefacts** (CDP climate response, TCFD/standalone climate report, 10-K/20-F Item 1A risk factors) via dedicated query templates + doc-type priorities on the framework — so GE/L'Oréal get the qualifying doc every run, not by luck.
- **C** (from the first list) — backfill fw24 + fix the builder, which is a prerequisite for B.

### Why didn't we see this with AI Management (fw21)?
1. **AI evidence is binary-clean and concentrated** — a company either names an AI strategy or it doesn't, and the passage lives in an obvious place (annual report / dedicated AI section). So fw21 verdicts are robust to which exact docs are in the corpus. Physical-climate verdicts are not.
2. **fw21 is better configured** than fw24 (legacy=8, retr=29, syn=38, reqdoc=13 vs fw24's empty template fields), so its corpus is less volatile run to run.
3. **We never stress-tested fw21 for variance.** AI Management ran as large one-shot batches (2,339 companies once). The physical-climate test deliberately re-ran the *same ~50 companies four times* — the design that exposes run-to-run variance. We simply never measured fw21 under that design, so "we didn't see it" partly means "we didn't look." (I can't claim fw21 has zero variance — only that its evidence profile and configuration make it far more robust, and that the repeated-run experiment was physical-climate-only.)
