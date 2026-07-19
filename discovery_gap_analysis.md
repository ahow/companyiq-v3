# Discovery Gap Analysis — Why Dedicated Pages Are Missed

## Root Cause 1: No deterministic "own-site topic page" probe

The discovery pipeline relies entirely on **search-engine queries** (`site:domain topic-keyword`) to find pages on a company's own website. It does NOT:
- Crawl the company's sitemap
- Probe common URL patterns (e.g., `{domain}/ai`, `{domain}/responsible-ai`, `{domain}/sustainability`)
- Follow internal links from the homepage

This means if Google doesn't rank `aboutamazon.com/ai` for the query `site:aboutamazon.com artificial intelligence`, that page is never discovered. Search engines are unreliable for deep corporate pages.

## Root Cause 2: Domain queries are topic-branch-specific (not fully general)

`buildDomainQueries()` (line 953-1013) has hard-coded branches:
- `isAIRelated` → searches for AI/ML/responsible AI terms
- `isClimateRelated` → searches for sustainability/TCFD/net zero terms
- `isESGBroad` → searches for ESG/sustainability terms
- `else` → generic fallback using topic words

For a NEW framework topic (e.g., "Modern Slavery", "Cybersecurity", "Biodiversity"), it falls into the generic `else` branch which only does `site:{domain} {topicWords}`. This is thin — it doesn't try synonyms, related terms, or common page patterns.

## Root Cause 3: The relevance gate is company-specific but NOT topic-specific

The LLM relevance gate (line 1921-2010) only checks:
- "Is this document ABOUT THIS SPECIFIC COMPANY?" (company identity gate)

It does NOT check:
- "Is this document relevant to the TOPIC being assessed?"

So a company's generic "About Us" page, a product catalog, or a job posting on the company's own domain passes the gate (it IS about the company) even though it contains zero evidence for the framework topic.

## Root Cause 4: The localized query builder is AI-only

`buildLocalizedAIQueries()` (line 1105-1123) explicitly checks `isAIRelated` and returns empty for non-AI frameworks. The locale profiles have `aiTerms` but no generic `topicTerms`. So non-English companies get localized discovery ONLY for AI frameworks.

## Proposed General Fix: "Own-Site Topic Probe" Lane

A new discovery lane that:
1. Takes the company's effective domain
2. Uses the framework's topic lexicon (already derived at line 2082-2093) to build topic-aware URL probes
3. Deterministically tries common corporate page patterns: `{domain}/{topic-slug}`, `{domain}/about/{topic-slug}`, `{domain}/corporate/{topic-slug}`
4. Also does a broader `site:{domain}` search using the topic lexicon terms (not just the hard-coded branches)

This is topic-agnostic because it uses `topicPhrases` from the lexicon, not hard-coded AI/climate terms.

---

# Scoring Precision Gap — Why Existing Rules Don't Filter Non-Topic Evidence

## The Scoring Prompt Already Has Topic Restrictions

From analyzer.ts (line 151-318), the scoring prompt includes:
- `explicit_exclusions` per measure (e.g., "General corporate governance or ESG reporting")
- Anti-inference rules ("Do NOT infer from general statements")
- Required evidence type text

## But the BM25 Passage Retrieval is the Real Weak Point

From analyzer.ts (line 1096-1221), the scoring loop:
1. Derives topic lexicon terms
2. Uses BM25 to find relevant passages in the fetched documents
3. If BM25 returns thin results, falls back to `combinedText.slice(0, 10000)` — the first 10KB of ALL documents

This fallback is the problem: when BM25 can't find topic-specific passages (because the documents are about general corporate governance, not AI specifically), it feeds the LLM the first 10KB of whatever was fetched. If that happens to contain general governance language, the LLM may score "Yes" despite the exclusions — because the exclusion says "don't count general governance" but the LLM sees governance text and conflates it.

## The Fix

The fix is NOT in the scoring prompt (which already has the right exclusions). It's in the **evidence retrieval step**:
- When BM25 returns no topic-relevant passages, the fallback should be "No relevant evidence found" (abstain), NOT "here's the first 10KB of whatever we have"
- The topic lexicon should be used as a hard filter: if no passage contains any topic term, the measure should score "No" or "Insufficient evidence"

This is already partially implemented via `requiredSourceTypes` (measures can require specific document types), but there's no equivalent "required topic relevance" gate on the evidence passages themselves.
