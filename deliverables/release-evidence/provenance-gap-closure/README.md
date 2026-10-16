# Provenance-gap closure — offline re-verify (batch 1287, companies 9–18)

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
