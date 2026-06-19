# Follow-up Execution Result

Both changes were executed directly. Summary: **Part 1 (9.x Item 1A fix) is shipped, tested, and live.** **Part 2 (Chinese-issuer confirmation) ran end-to-end and proves the three Chinese-cohort fixes behave correctly — but it also surfaced a distinct, previously-masked root cause for 360 Security: a discovery/source-targeting gap for A-share issuers, not a fetch or tokenization gap.**

---

## Part 1 — 9.x Item 1A evidence-packing fix — DONE & DEPLOYED

**Code (`server/lib/passage-retrieval.ts`, commit `168b3a1` on `main`):**
- Added `requiresRegulatoryFiling()` and `looksLike10KRiskChunk()` helpers.
- Added **Step 0 — Regulatory-filing guarantee** in `buildEvidencePackForMeasure`: for any `9.x` (or otherwise filing-requiring) measure, the single best 10-K/20-F Item 1A AI-risk chunk is force-included in the evidence pack before the topic floor, respecting `maxChars` and the per-doc budget.
- Hard-pinned `9.x` measures to Item 1A/7/7A in `relevantSecSections()`.
- Widened the AI lexicon (`frontier model`, `transformer model`, `diffusion model`, `ai-enabled`).

**Validation:**
- `tsc --noEmit` → no new errors in the changed file.
- Behavioral test: with a keyword-dense ESG chunk competing against a real 10-K Item 1A chunk, the pack now includes the Item 1A chunk (`pack includes Item 1A 10-K chunk: true / PASS`). Before the fix this returned `false` — i.e. the exact NVIDIA/Amazon failure mode is resolved at the retrieval layer.
- Negative control (a non-9.x policy measure) still builds a normal pack (force path does not fire).

**Deploy:** pushed to `main`; Railway rebuilt `app` + `worker` (3/3 replicas) and both are **Online** on the new commit.

> Note: this guarantees the Item 1A passage now *reaches the scorer* for 9.x measures. The final Yes/No is still the model's call on that evidence, but the prior mechanical failure ("no 10-K excerpt was in the pack") is eliminated. A targeted re-score of NVIDIA/Amazon on measure 9.1 is the natural next confirmation if you want it.

---

## Part 2 — Chinese-issuer confirmation (360 Security, id 1914) — RAN; fixes verified; new root cause found

**Run:** full-reset re-analysis, batch 89, completed under the deployed code (elapsed ~3 min after claim).

### Success-criteria results
| Check | Expected | Actual | Verdict |
|---|---|---|---|
| (a) Doc health | >1 `ok`, no all-rejected | **4 ok**, 2 rejected, 1 dead | Improved (was 1 ok/empty before) |
| (b) Annual report `ok` w/ large content | large `content_length` | Futubull AR wrapper **ok, 7,302 chars** (not the full PDF) | Partial |
| (c) CJK AI terms in corpus | `人工智能` present | **Not present** in the fetched docs | Not met (corpus is peripheral) |
| (d) `total_score` > 0 | non-zero | **0** | Not met |

### What this actually proves (fix-by-fix)
1. **JS-shell → browser-render escalation: WORKING.** The Futubull annual-report page (a client-rendered SPA) was fetched and rendered to 7,302 chars of real text — previously it returned an empty/JS stub. The mechanism fired correctly.
2. **Non-terminal "generic-because-empty" handling: WORKING / not the bottleneck.** The two remaining rejects are *correct* rejections, not JS-stub false negatives:
   - HKEXnews "Annual Report" → `different_company: Qifu Technology, Inc.` — Qifu (US-listed fintech, formerly 360 DigiTech) is a **genuinely different issuer**; rejecting it is correct.
   - SEC `ix?doc=…` → `generic — placeholder requiring JavaScript` — this is the interactive **XBRL viewer shell**, not a document; browser rendering doesn't yield a corporate disclosure here.
3. **CJK bigram tokenizer: WORKING (verified independently).** On real Chinese text the tokenizer emits correct character bigrams (`人工`, `工智`, `智能`, …) and a Chinese AI-risk passage is correctly surfaced into the evidence pack for an AI-risk measure (standalone test `PASS`). It simply had nothing to tokenize here because the real Chinese annual-report **text** never entered the corpus.

### The real, newly-isolated root cause
360 Security's **discovery never surfaced the genuine A-share annual report** (Shenzhen-listed **601360**, published on **cninfo.com.cn / SZSE**). What discovery returned instead was:
- a **Futubull news wrapper** *about* the annual report (site chrome + headlines, thin body),
- **wrong-entity** filings (Qifu/360 DigiTech on HKEX/SEC), correctly rejected,
- ESG/sustainability **aggregators** (CSRHub, sustainabilityreports.com, MarketScreener).

So the corpus is now *real but peripheral* — none of it contains substantive Chinese AI-governance disclosure — which is why the score is a legitimate 0 rather than a mechanical-empty 0. This is a **source-targeting / discovery gap specific to A-share issuers**, a different layer than the fetch/tokenization fixes that were the subject of this round.

### Recommended next fix (discovery layer — not yet implemented)
To actually score A-share issuers, discovery needs to reach the primary Chinese filing repositories directly:
- Add a **cninfo.com.cn** (巨潮资讯) lane keyed by the issuer's A-share ticker (here `601360`) and Chinese legal name (三六零安全科技股份有限公司), plus **SZSE/SSE** disclosure portals, and treat their PDF URLs as high-priority primary filings.
- Strengthen **entity disambiguation** so the Qifu/360-DigiTech vs. 360 Security (601360) split is resolved at query-build time (issuer ticker + ISIN), so discovery spends its budget on the right issuer instead of rejecting wrong-entity docs after the fact.
- Once the cninfo PDF is in the corpus, the already-deployed browser-render + CJK tokenizer + Item 1A/section logic will handle it (verified above).

This is scoped as a discovery-lane addition; happy to implement it as a follow-up if you want 360 Security (and the wider A-share cohort) to produce a substantive score.

---

## Security cleanup (still outstanding — needs a dashboard click)
The temporary **public TCP proxies on Postgres and Redis** are still **OPEN** (verified just now). They were required to enqueue from outside Railway's private network. Please remove them:
- Railway dashboard → **Postgres** → Settings → Networking → remove TCP proxy
- Railway dashboard → **Redis** → Settings → Networking → remove TCP proxy

(The API token returns 403 on proxy deletion, so this can't be done from the CLI.) Keep the `SCORING_*` and timeout env vars.

---

## Commits
- `168b3a1` — fix(retrieval): force-include 10-K Item 1A chunk for 9.x measures; pin 9.x to Item 1A/7/7A; widen AI lexicon
