# How the Lancaster ESG PDF ended up attached to 3SBio — root-cause trace

**Company:** 3SBio Inc. (id `1634`, workspace 3), ISIN `KYG8875G1029`, Hong Kong, Health Care.
**Stored `domain`:** *null* (no official domain was set for this company).
**Offending document:** `doc 1046987` —
`https://s206.q4cdn.com/621856538/files/doc_downloads/statements/ESG_POLICY_STATEMENTS-_LANCASTER.pdf`
tagged `Lane: domain`, `gate=accept`, `fetch=dead`.

## Short version
3SBio had no domain on file, so discovery **auto-detected a domain from search
results and wrongly picked `s206.q4cdn.com`** — a *shared* investor-relations
CDN (Q4 Inc.) that hosts files for hundreds of unrelated companies. Discovery
then ran `site:s206.q4cdn.com …` queries, which returned ESG/10-K/proxy PDFs
belonging to whatever companies Q4 hosts on that CDN (Lancaster Colony,
AllianceBernstein, etc.) and attached them to 3SBio.

## The exact mechanism (code path)
File: `server/lib/discovery.ts`.

1. **No company domain → auto-detect** (lines ~1200–1208):
   ```
   let effectiveDomain = companyDomain || null;
   if (!effectiveDomain) effectiveDomain = inferDomainFromResults(allCandidates, companyName);
   ```
2. **`inferDomainFromResults` (lines ~822–865)** counts hostnames across general
   search results and returns the most frequent one. Its `excludedDomains`
   blocklist covers news/jobs/wiki sites but **does not include shared IR/CDN
   hosts** such as `q4cdn.com` / `s206.q4cdn.com` / `q4web.com`.
   - The company-name guard at line 852 (`domain must contain a word from the
     company name`) failed (“3sbio” is not in `q4cdn.com`), **but** the fallback
     at line ~856 — *“If no name match but appears 3+ times, still use it”* —
     accepted `s206.q4cdn.com` because several Q4-hosted results appeared in the
     candidate set. This is the precise line that mis-anchored the domain.
3. **Domain-anchored lane then queries the shared CDN** (`buildDomainQueries` →
   `site:s206.q4cdn.com investor relations / annual report / proxy statement /
   environmental policy …`). Every hit on that CDN — regardless of which company
   it belongs to — was added as a candidate with `Lane: domain` and accepted by
   the gate.

The discovery diagnostics for 3SBio confirm `domain` was the single largest lane
(83 candidates), and the `topUrls` list is full of foreign Q4-CDN and even an
AMAG Pharmaceuticals SEC filing.

## Impact on 3SBio (quantified)
- **41** documents total attached to 3SBio.
- **10** are shared-CDN (`q4cdn`) documents spanning **5 distinct Q4 account IDs
  = 5 different unrelated companies**: `162757971` (AllianceBernstein),
  `621856538` (Lancaster Colony), `795948973`, `919117365`, `979796730`.
- **6 of those 10 were successfully fetched**, i.e. their text was available to
  the scorer — so 3SBio's AI-Governance scores were potentially influenced by
  other companies' disclosures. (The Lancaster PDF itself was `fetch=dead`, so
  its content was not ingested, but sibling Q4 docs were.)
- Lane breakdown of the contaminated docs: `domain` 7, `regulatory` 2, `multi-doc` 1.
- A separate but related mis-anchor: `doc 1046957` is an **AMAG Pharmaceuticals**
  10-K pulled via the `regulatory` lane (SEC CIK confusion), independent of the
  q4cdn issue.

## Why this matters for your physical-climate-risk extraction
Any company **without a stored domain** is exposed to the same failure: the
auto-detector can latch onto a shared CDN (q4cdn, q4web, s3 buckets, sharepoint,
etc.) or an aggregator and import unrelated companies' documents. For a
climate-risk read this is especially dangerous because ESG/sustainability PDFs
on these shared CDNs look topically relevant and will pass the content gate.

## This is systemic, not just 3SBio
Quick scan across the whole workspace (all companies have `domain` = null, so
auto-detection runs for every one):

- **474** companies have at least one `q4cdn.com` document.
- **79** companies pulled documents from **2 or more distinct Q4 account IDs**,
  which is *definitive* cross-company contamination (a single company cannot own
  multiple Q4 accounts). Combined these hold **448** Q4 documents.
- Worst offenders: **Netflix** (8 distinct Q4 accounts), **Barrick Mining** (6),
  **3SBio / Dow** (5 each), Insulet, Xcel Energy, Blackstone, KeyCorp, Rocket
  Companies (4 each).
- The remaining ~395 single-account companies *may* be legitimate (the company
  genuinely hosts its IR on Q4) **or** mis-anchored to one wrong account — those
  need per-company verification. And this covers only the `q4cdn` family; other
  shared hosts (q4web, S3 buckets, SharePoint, ESG aggregators) likely add more.

## Recommended fix (not yet applied — flagging for your go-ahead)
1. **Blocklist shared IR/CDN and hosting hosts** in `inferDomainFromResults`'s
   `excludedDomains` (and in the domain-lane `site:` builder): `q4cdn.com`,
   `q4web.com`, `s3.amazonaws.com`, `cloudfront.net`, `sharepoint.com`,
   `sustainability-reports.com`, `responsibilityreports.com`, etc. These are
   never a single company's own domain.
2. **Remove/!restrict the “appears 3+ times, use it anyway” fallback** (line
   ~856) — require a company-name match (or an explicit verified domain) before
   anchoring, otherwise skip the domain lane entirely.
3. **Path-scope CDN matches**: if a CDN host is ever used, anchor on the full
   account path (e.g. `s206.q4cdn.com/<accountId>/`) rather than the bare host,
   so one company's account can't pull another's.
4. **Backfill domains** for the ACWI universe so auto-detection is rarely needed.

If you want, I can implement fix (1)+(2) in `discovery.ts`, then re-run discovery
for 3SBio (and optionally re-scan the rest of the list for `q4cdn`/shared-CDN
contamination and purge those documents before you restart the climate-risk
extraction).
