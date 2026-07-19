# Response to Round 12 Disagreements, Option A Implementation, and Expected-Score Proposal

## 1. Review of Colleague Disagreements — Validity Assessment

### Important Context: Framework Mismatch

The reviewer's document (Round12_Management_Score_Changes.md) references an **M01–M18 scoring system** (18 measures: "Board AI Oversight", "Published AI Strategy", "AI IP Portfolio", "AI Supply Chain", etc.) that is used in a separate valuation model/dashboard (`dashboard_data.json`). This is a **different framework** from what CompanyIQ uses:

| System | Measures | Labels | Used In |
|--------|----------|--------|---------|
| Reviewer's M01–M18 | 18 binary/partial | Board AI Oversight, AI IP Portfolio, AI Supply Chain, etc. | Valuation model dashboard |
| CompanyIQ Framework 7 | 34 partial-credit | AI Strategy and Integration, AI Deployment and Use Cases, AI Governance and Oversight, etc. | CompanyIQ pipeline |

The two systems overlap conceptually but are not identical. For example, CompanyIQ has no "AI IP Portfolio" or "AI Supply Chain" measure — those concepts don't exist in framework 7's 34 measures. Conversely, CompanyIQ has much more granular measures (e.g., 5 separate measures just for AI Deployment/Use Cases vs. one "AI Product Deployment" in M01–M18).

### Are the Reviewer's Concerns Valid?

**Yes — the underlying observations are valid even though the framework differs.** The patterns the reviewers identified apply to any AI assessment pipeline:

| Concern | Valid? | Applies to CompanyIQ? |
|---------|--------|----------------------|
| Amazon under-scored (missed published AI strategy, $200bn R&D, workforce training) | Yes | Partially — CompanyIQ has measures 165 (AI capex), 158–160 (workforce), 135 (AI strategy). If Amazon scored low on these in CompanyIQ too, same root cause applies. |
| Vertiv over-scored on AI Ethics (general ESG ≠ AI-specific ethics) | Yes | Directly applicable to measure 150 ("published formal AI policy/principles/responsible-AI framework") — scoring guidance already requires AI-specific docs, but the LLM may conflate general governance. |
| Applied Materials missed AI-driven products (AIxA, eBeam) | Yes | Applicable to measures 139–143 (AI Deployment/Use Cases) — if discovery doesn't surface product-level AI for semi-cap companies, same gap. |
| IP Portfolio / Supply Chain systematically missed | Partially | CompanyIQ doesn't have these measures, so this specific gap doesn't apply. But the underlying issue (discovery not surfacing patent/supply-chain evidence) could affect measure 161 (strategic partnerships). |
| Empty vs "No" distinction | Yes | CompanyIQ handles this better (explicit "No relevant evidence found" text + score 0 with Low confidence), but the passage-retrieval gap that causes it is the same. |

### Root Cause Analysis

Having reviewed the CompanyIQ pipeline code, the reviewer's concerns trace to **two distinct failure modes**:

**Failure Mode 1: Discovery Gap (Evidence Never Found)**

The discovery phase already has comprehensive AI-related search queries (6 general queries + 13 multi-document queries + domain-anchored queries + LLM-generated variants). However, for very large companies (hyperscalers), the relevant evidence may be on specific sub-pages (e.g., `aboutamazon.com/ai`, `ai.meta.com`) that don't rank highly for generic queries. The discovery phase finds the *annual report* and *sustainability report* but may miss the dedicated AI strategy microsite.

**Failure Mode 2: Scoring Precision (Evidence Found but Mis-scored)**

When evidence IS found, the LLM scorer may conflate general corporate governance with AI-specific governance (the Vertiv M04 issue). The scoring guidance in framework 7's measures is actually quite precise (e.g., measure 150 requires "formal AI policy, principles, or responsible-AI framework" with explicit exclusions for "general corporate governance or ESG reporting"), but the LLM doesn't always follow the exclusions strictly.

### Recommended Pipeline Changes

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| **High** | Add a "company homepage AI page" discovery lane: for AI frameworks, search `site:{domain} AI OR "artificial intelligence"` and also try common paths like `{domain}/ai`, `{domain}/responsible-ai` | Low (add 2–3 queries to `buildDomainQueries`) | Catches hyperscaler AI microsites |
| **High** | Add explicit negative examples to the scorer prompt: "Do NOT score Yes for general corporate governance, ESG reporting, or sustainability commitments unless they are specifically about AI" | Low (edit system prompt template) | Reduces false-positive scores for non-AI-native companies |
| **Medium** | Add a "workforce training" discovery query: `"{company}" AI training programme OR AI upskilling` | Low | Catches named AI training programmes (Amazon Future Ready, etc.) |
| **Medium** | Add a "quantified AI investment" discovery query: `"{company}" AI investment billion OR AI capex` | Low | Catches disclosed AI spend figures |
| **Low** | Post-scoring validation: flag any company where >80% of measures score "Yes" for manual review (catches over-scoring) | Medium | Quality gate for implausibly high scores |
| **Low** | Post-scoring validation: flag any company in a "tech-adjacent" sector (semis, cloud, enterprise SW) scoring <20% for review (catches under-scoring) | Medium | Quality gate for implausibly low scores |

The last two "Low" priority items are essentially what your **expected-score idea** addresses more systematically — see Section 3 below.

---

## 2. Option A Implementation — Done

**Commit:** `8e28d53` (pushed, deploying now)

**What it does:** When a batch completes with `total_jobs <= 1` AND no `list_id` (the signature of auto-reexaminations and manual single-company analyses), the worker skips saving a Results snapshot. The company's scores are still updated live in the companies table and will appear in the next full-run or consolidated snapshot.

**Guard conditions (conservative):**
- Only suppresses when `total <= 1` (single company)
- Only suppresses when `listId` is absent (re-exams and ad-hoc analyses never have a list; full portfolio runs always do)
- Full portfolio runs, even small ones (e.g., "22 Banks" list), always save normally

**Also cleaned up:** Deleted the remaining 1 single-company result row from the DB. The Results page should now show only your consolidated multi-company records.

---

## 3. Expected-Score Anomaly Detection — Assessment and Proposal

### Is This a Good Idea?

**Yes — this is an excellent quality-control mechanism.** It's essentially a statistical outlier detector that uses peer-group characteristics to flag companies whose actual scores deviate significantly from what you'd expect given their profile. This is a well-established pattern in quantitative finance (factor residual screening) and audit (analytical review procedures).

### Data Available for the Model

Your `companies` table has strong coverage of the key features:

| Feature | Coverage | Signal Strength |
|---------|----------|----------------|
| **Sector** (13 sectors) | 2,543/2,544 (>99%) | Very strong — sector explains most variance (Financials avg 5.8% vs Consumer Staples 17.4%) |
| **Country** (50+ countries) | 2,543/2,544 (>99%) | Strong — UK avg 28% vs China avg 4.1% |
| **ISIN** (→ can derive market cap from external data) | 2,444/2,544 (96%) | Would be strong if enriched |
| **Domain** (→ can infer company size/type) | Partial | Weak proxy |

Even with just **sector + country**, you can build a useful expected-score model because those two features alone explain a large portion of the score variance in your data.

### Proposed Implementation

**Approach: Peer-group median + z-score flagging**

Rather than a complex ML model (overkill for 2,500 companies with 2 features), use a simple but robust approach:

1. **After each full batch completes**, compute the expected score for every company as the **median score of its sector × country peer group** (or sector-only if the country group is too small, <5 peers).

2. **Calculate a residual** = actual_score − expected_score.

3. **Flag outliers** where |residual| > threshold (e.g., 2× the peer-group IQR, or a fixed ±15pp for simplicity).

4. **Surface flagged companies** in the UI as a "Review Suggested" list, sorted by |residual| descending, with the peer-group context shown (e.g., "Amazon scored 15% but US Technology peers average 28% — 13pp below expected").

**Where it runs:** As a post-batch-completion step (after `saveAnalysisResultsForBatch`), writing results to a new `score_anomalies` table. The dashboard shows an alert/tab when anomalies exist.

**What triggers re-examination:** The user reviews the flagged list and can one-click re-examine any company. This keeps a human in the loop (important given your "assessment rigor" preference) while automating the detection.

### Sketch of the Data Model

```sql
CREATE TABLE score_anomalies (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  framework_id INTEGER NOT NULL,
  batch_id INTEGER,
  actual_score REAL NOT NULL,
  expected_score REAL NOT NULL,
  residual REAL NOT NULL,        -- actual - expected
  peer_group TEXT NOT NULL,      -- e.g. "Technology / UNITED STATES"
  peer_count INTEGER NOT NULL,
  peer_median REAL NOT NULL,
  peer_iqr REAL,
  flag_reason TEXT,              -- "under" or "over"
  status TEXT DEFAULT 'open',   -- open / reviewed / dismissed / reexamined
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Enhancement: Enrich with Market Cap

If you want a third feature (company size), I can add a one-time enrichment step that looks up market cap from a free API (e.g., Yahoo Finance via ISIN → ticker mapping) and stores it on the companies table. Larger companies tend to have more AI disclosure simply because they have more resources for governance reporting — so size is a useful predictor. But sector + country alone will catch the Amazon/Applied Materials cases your reviewers flagged.

### Should I Build This?

I can implement the full expected-score system (DB table, post-batch computation, dashboard UI with "Review Suggested" tab, one-click re-examine) as a next step. It's ~2–3 hours of work. Want me to proceed?

---

## Summary of Actions Taken

| Action | Status |
|--------|--------|
| Reviewed Round 12 disagreements against pipeline code | Done — findings above |
| Identified framework mismatch (M01–M18 ≠ CompanyIQ framework 7) | Done |
| Proposed 6 pipeline improvements ranked by priority | Done |
| Implemented Option A (suppress single-company snapshots) | Deployed (commit `8e28d53`) |
| Deleted remaining single-company Results rows | Done |
| Evaluated expected-score idea | Done — recommended approach above |
