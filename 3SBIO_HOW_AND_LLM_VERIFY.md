# (1) How the Lancaster doc entered 3SBio's list, and (2) adding an LLM company-verification step

## (1) Why it got in — and why the 3 existing guards all missed it

The pipeline already has **three** contamination guards. The Lancaster PDF
(`s206.q4cdn.com/621856538/.../ESG_POLICY_STATEMENTS-_LANCASTER.pdf`) slipped
past **all three**, each for a specific reason.

### The chain of events
1. 3SBio has **no `domain`**, so discovery auto-guessed one and (as traced
   earlier) wrongly anchored to the shared CDN `s206.q4cdn.com`.
2. The domain lane issued `site:s206.q4cdn.com environmental policy / ESG / …`
   queries. The search engine returned the Lancaster ESG PDF as a **search hit
   on that host**. So the document entered the candidate pool **purely from the
   URL/host + the search-result title/snippet — its content was never read at
   selection time.**

### Guard 1 — pre-gate keyword filter (`discovery.ts` ~1336–1361)
Cheap title check: keep if the title contains a word from the company name;
reject if the title prominently contains a *known other* company from a
hard-coded list (`KNOWN_OTHER_COMPANIES`: BlackRock, Vanguard, JPMorgan, …).
- The Lancaster PDF's title is **"ESG POLICY STATEMENTS"** — it contains neither
  "3sbio" **nor** any name on the known-other list ("Lancaster" isn't in that
  list). So it was **neither kept-by-name nor rejected-by-name → passed through.**

### Guard 2 — LLM relevance gate (`discovery.ts` `runRelevanceGate` ~1023–1112)
A DeepSeek classifier judges each candidate from **URL + title + snippet only**
(not the document body), with the rule "reject documents about a different
company." This is the guard that *should* have caught it, but:
- It only sees `URL: …/ESG_POLICY_STATEMENTS-_LANCASTER.pdf`, `Title: ESG Policy
  Statements`, and a short snippet. There is **no company name in the URL or
  title** (just a numeric Q4 account id `621856538`), and "Lancaster" reads like
  a generic word, not obviously "a different listed company."
- Crucially, the gate is **told the company's domain is `s206.q4cdn.com`** (the
  mis-detected domain is passed in as identity context). Its CRITICAL RULE #1
  says "if the URL domain belongs to ANOTHER company, reject" — but here the URL
  domain **matches the (wrong) domain it was given**, so the gate read it as
  *on-domain and therefore legitimate.* The bad domain detection actively
  **defeated** the LLM gate.

### Guard 3 — post-fetch content validation (`pipeline.ts` ~266–292)
After downloading, it checks whether the content mentions the company name (or a
name word, or the domain); if not, it rejects the doc (`POST-FETCH REJECT`).
This guard **would** have caught the Lancaster PDF (its text never says
"3sbio") — **except** that specific document's `fetch_status` is **`dead`**: the
download failed, so there was no content to validate, and the row simply stayed
as an accepted-but-unfetched document in the list you saw. (Its successfully
fetched Q4 siblings — e.g. the AllianceBernstein ESG report — *did* download;
those passed/failed this check individually, and several still made it through
because the check is a simple substring match that can be fooled.)

### One-sentence answer
> The Lancaster PDF was selected by URL/host + title alone (never by content)
> because 3SBio's domain was mis-detected as the shared Q4 CDN; the title carried
> no company name to trip the keyword or LLM gates, and the LLM gate was actually
> told that CDN *was* 3SBio's domain — so it treated the file as on-domain and
> legitimate. The only guard that inspects content (post-fetch) never fired for
> this particular file because its download failed, leaving it in the list
> unvalidated.

---

## (2) Adding an LLM step that verifies which company a document refers to

Yes — this is very doable and is the right structural fix. There are two
complementary places to add it; I recommend doing both, but each is independently
useful.

### Option A — Content-based LLM verification (strongest)
**Where:** in the fetch phase, replacing the weak substring check at
`pipeline.ts` ~283 (`mentionsCompany`).
**What:** after a document is downloaded, send the **first ~1–2k tokens of the
actual text** (plus the title/URL) to a cheap model and ask:

> "Whose corporate disclosure is this? Return the primary company/issuer name,
> and whether it is the target company `{name}` (ISIN `{isin}`, {sector},
> {country}). Answer `match` / `different_company` / `generic`, with the detected
> issuer name and a confidence."

- **match** → keep; **different_company** → reject and log the detected issuer
  (so you get an audit trail like "rejected: Lancaster Colony"); **generic** →
  keep only if it substantively concerns the target.
- This catches *exactly* the failure you found, because it reads the body rather
  than trusting the URL/host. The current substring check (line 283) is the thing
  it replaces — that check both over-accepts (Q4 siblings) and can't see content
  for `dead` docs.

**Cost control:** only the first chunk is sent; you already run a per-batch
DeepSeek gate, so the model + plumbing exist. ~1 cheap call per fetched document.

### Option B — Pre-fetch LLM verification, conditional (cheapest, targeted)
Run an extra disambiguation pass in `runRelevanceGate` **only for risky
candidates**, i.e. when:
- the company has **no verified domain**, **or**
- the candidate's host is a **shared CDN / aggregator** (q4cdn, q4web, S3,
  cloudfront, sharepoint, sustainability-reports.com, …), **or**
- the candidate host ≠ the company's known domain.

For those, fetch just the document's first page/snippet and ask the same
"whose document is this?" question before accepting. This focuses spend on the
~exact population at risk (companies without domains, shared-CDN hits) rather
than every document.

### Recommended configuration (matches your three options)
Make the verification **mode** a setting:
1. `all` — verify every fetched document (max safety, max cost).
2. `no_domain_only` — verify only companies whose `domain` is null/empty
   (this alone would have caught 3SBio and the bulk of the 79 multi-account
   cases, since every contaminated company had a null domain).
3. `domain_mismatch` — verify whenever the document's host doesn't match the
   company's verified domain (catches off-domain leaks even for companies that
   *do* have a domain set).

I'd suggest defaulting to **`no_domain_only` + `domain_mismatch`** (the union):
it concentrates LLM cost on genuinely ambiguous documents while leaving
clearly on-domain documents fast-pathed.

### Also fix the upstream cause (so verification isn't doing all the work)
The LLM verifier is a safety net; the *root* cause is the domain mis-detection
that both produced these candidates and defeated the existing LLM gate. The two
should ship together:
- Blocklist shared CDNs/hosts in `inferDomainFromResults` and never pass a
  shared-CDN host to the gate as the company's "domain."
- Drop the "appears 3+ times, use it anyway" fallback (require a name match).
- Scope any CDN match to the full account path (`q4cdn.com/<id>/`).

---

## Suggested next steps (pick any)
- I can implement **Option A** (content-based verifier replacing the substring
  check) + the domain-detection fixes, behind a `companyVerificationMode`
  setting defaulting to `no_domain_only|domain_mismatch`.
- Then purge existing cross-company shared-CDN docs (the 79 clear multi-account
  companies first, optionally the wider 474) and re-run discovery for affected
  companies before you restart the physical-climate-risk extraction.

Tell me which option/mode you want and whether to start with the 79 or the full
474, and I'll proceed.
