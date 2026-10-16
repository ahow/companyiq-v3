# Provenance-gap closure — offline re-verify (batch 1287, companies 9–18)

> ## ⭐ SUPERSEDING FIX — framework-level, zero per-company data (2026-10-16)
>
> The per-company `related_domains` tenant declaration described further down
> (the `AFTER_code-fix-plus-SP-tenant-declaration.*` run) was **REJECTED** as
> company-specific. It has been **replaced by a framework-level code mechanism**
> that needs **no per-company data and no DB write** and applies identically to
> every issuer on every IR platform. Evidence:
> `AFTER_framework-phrase-and-propagation.json` / `.md`.
>
> ### What the framework fix does
> Two name-derived, company-/topic-agnostic code mechanisms, both in the general
> classifier path:
>
> 1. **Full-name phrase identity** (`server/lib/provenance.ts`
>    `fullNamePhraseMatch`). An issuer's complete legal name — minus generic
>    corporate-form suffixes (Inc/Corp/PLC/Co/…) — is matched as a **contiguous
>    phrase** against a document's title, URL path and content. This lets an
>    issuer whose name produces no distinctive single token and whose ticker is
>    absent from the URL (e.g. S&P Global, ticker `SPGI`, on
>    `s29.q4cdn.com/690959130/.../S-P-Global-Inc-2026-Proxy-Statement.pdf`)
>    self-confirm its *own* IR document. Guarded: ≥2 name tokens and ≥6 joined
>    characters, so short/ambiguous names (`AT&T`, `Visa`) do not over-fire.
> 2. **IR-tenant propagation through the A3 eligibility composer**
>    (`composeCellEligibility`, two-pass, order-independent). The existing R5c
>    `knownIrTenants` cache — populated by write-through whenever ANY source
>    self-confirms a Q4/IR-CDN tenant (via the phrase match above, or tokens,
>    ticker, or path identity) — is now threaded through the composer and shared
>    across all sources of a company (one cache per company in `analyzer.ts` and
>    in the GATE3 builder, so offline == live). A confirmed tenant then covers
>    *sibling* documents on the same tenant that carry no self-identifying name.
>    The cross-company reuse guard (`companyMatchesBinding`) still blocks a
>    different issuer from borrowing another issuer's bound tenant.
>
> Both signals are derived purely from the issuer's own name and the document —
> **no company-specific list, no topic-specific rule, no related_domains row.**
>
> ### Before / after (framework fix only — NO overlay, NO DB write)
>
> | Bucket (64 positive cells) | BEFORE | AFTER |
> |---|---|---|
> | STAY | 56 | **63** |
> | QUOTE_CORRECT | 5 | **1** |
> | VERDICT_CHANGE | 3 | **0** |
> | REVIEW | 0 | **0** |
>
> **Directional:** Yes→No flips **3 → 0**; No→Yes **0** (A3 acts only on positive
> cells). Genuine verdict-change = 0 before and after. Only S&P Global (id 12)
> changed; the other 9 companies (CSX, Magna, Southern, Martin Marietta, Darden,
> BCE, Stryker, Amphenol, Aflac) are **byte-identical before/after — zero
> regressions**. Verified by the a3 + provenance unit suites (34 + 49 tests pass,
> incl. R5c sibling-propagation order-independence and negative guards) and by a
> free GATE3 replay over the batch-1287 snapshot (no paid batch, no overlay).
>
> Everything below documents the earlier, now-superseded per-company approach and
> is retained for history only.

---

This folder is the offline, no-cost evidence for the 2026-10 provenance-gap closure
(redirect-mask unwrapping + data-driven IR-CDN tenant declaration) and the
enforcement default-ON change.

## What changed in code
- `server/lib/provenance.ts`
  - `unwrapRedirectUrl()` — unwraps search-engine redirect masks (Google `/url`,
    Bing `/ck/a` base64url) to the true target URL before host classification.
    Opaque/encrypted Google `/goto?url=CAES…` protobuf tokens are left unchanged
    (honest no-op — they cannot be resolved client-side).
  - `irTenantDeclaredInRelatedDomains()` — classifies an IR-distribution CDN
    tenant (e.g. Q4 Inc `s29.q4cdn.com/<tenant>`) as the issuer's own **only**
    when the exact tenant is declared in that issuer's `related_domains`. This is a
    precise, per-issuer, data-driven binding — NOT a blanket acceptance of the CDN
    host (a different tenant on the same host stays `third_party`).
- `server/lib/analyzer.ts` — eligibility enforcement is now **default-ON**. Unset/
  empty `ELIGIBILITY_ENFORCE` enforces; `ELIGIBILITY_ENFORCE=off` is the kill
  switch (restores shadow mode); `ELIGIBILITY_POLICY=v1` remains an independent
  kill switch inside `composeEligibilityDecision` (passes every source through).

## Before / after (GATE3 label builder over batch 1287 snapshot)

| Scenario | S&P 1.2 | S&P 2.8 | S&P 2.9 | STAY | QUOTE_CORRECT | VERDICT_CHANGE | REVIEW |
|---|---|---|---|---|---|---|---|
| **BEFORE** — code fix only (current prod data) | VERDICT_CHANGE | VERDICT_CHANGE | VERDICT_CHANGE | 56 | 5 | **3** | 0 |
| **AFTER** — code fix + S&P tenant declaration | STAY | STAY | STAY | 63 | 1 | **0** | 0 |

Positive cells = 64 in both. In BEFORE, all 3 VERDICT_CHANGE cells are
provenance-attribution artifacts (`verdictChangeGenuine: 0`); every excluded quote
is S&P's own disclosure recovered to a Q4 IR-CDN tenant URL
(`s29.q4cdn.com/690959130/.../S-P-Global-Inc-20xx-Proxy-Statement.pdf`) that the
classifier could not map to the issuer. AFTER the tenant declaration, those cells
classify `issuer_self` → eligible → STAY.

## IMPORTANT — the AFTER run used an in-memory overlay, NOT a DB write

The AFTER run was produced with `GATE3_RELATED_OVERLAY="12=s29.q4cdn.com/690959130"`,
which appends the tenant declaration to S&P's `related_domains` **for that run only**
(printed as `OVERLAY: … (in-memory preview, NOT persisted)`). It does NOT write to
the database. It is a preview of the effect of the proposed 1-row data change — not
a statement of current production behaviour.

### Pending production data change (requires explicit confirmation)
For production to realise VERDICT_CHANGE=0 for S&P, the following irreversible
1-row change must be applied to the Railway production DB:

- Table/row: `companies` WHERE `id = 12` (S&P Global Inc.)
- Column: `related_domains`
- Before: `["investor.spglobal.com","portal.s1.spglobal.com","press.spglobal.com"]`
- After:  `["investor.spglobal.com","portal.s1.spglobal.com","press.spglobal.com","s29.q4cdn.com/690959130"]`
- Rollback: remove the single appended element `"s29.q4cdn.com/690959130"`.

The code mechanism (this commit) ships via `main` → Railway auto-deploy. The S&P
tenant DATA above is a separate, confirmation-gated production write and was NOT
applied as part of this commit.
