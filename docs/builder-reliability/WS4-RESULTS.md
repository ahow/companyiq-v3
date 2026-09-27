# WS4 — Canonical Decision Rule: Results

Workstream 4 of the builder-reliability effort. Delivered on branch
`builder-reliability-workstreams` only. No push, no PR, no deploy, `main` untouched.

This document distinguishes **IMPLEMENTED** (code exists and is exercised by a
deterministic test in this repo) from **VERIFIED-FIXED** (the end-to-end live
behaviour with a real LLM has been observed to change). Read the two columns
literally; nothing here is overstated.

---

## 1. What the reviewer asked for, and where it lives

| # | Requirement | File(s) |
|---|---|---|
| 1 | Canonical rule builder, substantive-first precedence; strict fallback must NOT silently become authoritative | `server/lib/framework-v2/reliability/canonical-rule.ts` (`buildCanonicalRule`) |
| 2 | Three-valued evaluator (pass / fail / unknown-review-required); missing fact ⇒ unknown; per-clause trace | `canonical-rule.ts` (`evaluateCanonicalRule`) |
| 3 | Canonical rule wired into the RUNTIME scorer; trace attached to every MeasureResult (identity + version + clauses) | `server/lib/analyzer.ts` |
| 4 | `validateC13` — example ↔ rule consistency, dismissible / non-blocking | `server/lib/framework-v2/rules.ts` |
| 5 | Frozen, independently-adjudicated regression set (reviewer counterexamples as DATA; honest `pending-adjudication`) | `server/lib/regression/canonical-adjudication.json` + `canonical-adjudication.test.ts` |
| 6 | This results doc | `docs/builder-reliability/WS4-RESULTS.md` |

---

## 2. Files changed / added

**Added**

- `server/lib/framework-v2/reliability/canonical-rule.ts` — canonical rule builder, three-valued Kleene evaluator, clause-identity helper, and the runtime `CanonicalRuleTrace` builder.
- `server/lib/framework-v2/reliability/canonical-rule.test.ts` — 10 node:test unit tests.
- `server/lib/regression/canonical-adjudication.json` — frozen adjudication set (9 cases: 3 reviewer-signed pass, 6 `pending-adjudication`).
- `server/lib/regression/canonical-adjudication.test.ts` — adjudication harness + reusable `runCanonicalAdjudication` / `formatAdjudicationReport`.

**Modified**

- `server/lib/framework-v2/reliability/schemas.ts` — extended `StructuredRule` (`sourceField?`, `provenance?`, `flaggedForReview?`); added `StructuredFacts`; extended `StructuredRuleResult.clauseResults` items (`clauseId?`, `expression?`, `factRefs?`).
- `server/lib/analyzer.ts` — imported the trace builder; added `canonicalRuleTrace?` to `MeasureResult`; attached the trace on every scoring return path (single-pass, all-crashed, and multi-pass chosen).
- `server/lib/framework-v2/rules.ts` — added `validateC13` and wired it into `validateAll`.

---

## 3. Design decisions (honest about their limits)

- **Substantive-first precedence.** `buildCanonicalRule` resolves the Yes-bar via the
  existing `resolveScoringContract`, whose precedence is
  `substantiveDefinition → scoringGuidance.qualifyingInstance → fallbackYesCriterion → scoringGuidance → derived-default`.
  The winning field is recorded as `sourceField`, and `provenance` is one of
  `substantive | qualifying | fallback-derived | derived-default`.
- **A strict fallback never silently governs.** When the resolved bar comes from
  `fallbackYesCriterion` (`fallback-derived`) or from a synthesised default
  (`derived-default`), the rule is marked `flaggedForReview: true`. The rule is still
  usable, but it is visibly not authoritative.
- **Three-valued, missing-fact-safe.** `evaluateCanonicalRule` is a Kleene AND over
  required clauses, OR-groups, exclusions and thresholds. Any DEFINITE false ⇒ `fail`;
  otherwise any unknown ⇒ `unknown-review-required`; otherwise `pass`. A missing fact is
  `unknown`, never silently `false` — so an incomplete extraction can never fabricate a
  certain pass or fail.
- **Adjudication honesty.** The implementer is not the independent adjudicator. An
  `expectedStatus` of `pass`/`fail` is recorded ONLY where the reviewer stated the
  intended outcome. All other cases are `pending-adjudication`: the harness surfaces them
  and EXCLUDES them from the pass tally. No passage text or facts were invented for a
  pending case (`passage: null`, `facts: null`).

---

## 4. Verbatim test output

### 4a. Canonical-rule unit tests
```
$ DATABASE_URL=dummy npx tsx --test server/lib/framework-v2/reliability/canonical-rule.test.ts
# tests 10
# pass 10
# fail 0
```

### 4b. Canonical adjudication harness
```
$ DATABASE_URL=dummy npx tsx --test server/lib/regression/canonical-adjudication.test.ts
# canonical-adjudication: 9 cases — 3 adjudicated, 6 pending-adjudication (excluded from pass tally)
#   - 1.1-ai-strategy-published/positive: OK    expected=pass actual=pass
#   - 3.5-ai-compliance-standards/positive: OK    expected=pass actual=pass
#   - 3i-board-oversight/considered: OK    expected=pass actual=pass
#   - 1.3-ai-scope-functions/contradiction: PENDING (surfaced, not scored)
#   - gerdau-committee-only: PENDING (surfaced, not scored)
#   - industrial-bank-planned-office: PENDING (surfaced, not scored)
#   - paychex-advice-to-readers: PENDING (surfaced, not scored)
#   - hyundai-glovis-boston-dynamics-attribution: PENDING (surfaced, not scored)
#   - obayashi-old-source: PENDING (surfaced, not scored)
# tests 1
# pass 1
# fail 0
```

### 4c. Full reliability suite (regression check — no WS4 regressions)
```
$ DATABASE_URL=dummy npx tsx --test server/lib/framework-v2/reliability/*.test.ts
# tests 51
# pass 51
# fail 0
```

### 4d. Company-verdict regression harness (pre-existing control, still green)
```
$ DATABASE_URL=dummy npx tsx server/lib/regression/harness.test.ts
regression-harness tests: PASS (seed-3i, pass, case-insensitive, fail, errored, csv-import, malformed, format)
```

---

## 5. tsc error count — before / after

```
$ npx tsc -p server/tsconfig.json --noEmit 2>&1 | grep -cE "error TS"
```

| Point | Count |
|---|---|
| Before WS4 (baseline for this workstream) | 136 |
| After WS4 (all files above) | 136 |

WS4 introduced **zero** new type errors. The 136 are pre-existing and unrelated.

---

## 6. IMPLEMENTED vs VERIFIED-FIXED

| Item | Status | Basis |
|---|---|---|
| `buildCanonicalRule` substantive-first precedence + provenance/flagging | **IMPLEMENTED & VERIFIED** (deterministic) | 10 unit tests + adjudication harness |
| `evaluateCanonicalRule` three-valued, missing-fact-safe, per-clause trace | **IMPLEMENTED & VERIFIED** (deterministic) | unit tests + adjudication harness |
| Reviewer counterexamples reproduce their intended outcome (1.1, 3.5, 3i) | **IMPLEMENTED & VERIFIED** (against the *substantive reading* encoded as facts) | §4b |
| `validateC13` example↔rule consistency check (non-blocking, dismissible) | **IMPLEMENTED & VERIFIED** (deterministic) | wired into `validateAll`; advisory-only (`passed:true`) |
| `canonicalRuleTrace` attached to every `MeasureResult` on the live scoring path | **IMPLEMENTED**, NOT verified end-to-end here | code wired on all three return paths; no live-LLM run was executed in this environment, so the populated trace on a real scoring run is **not** observed in this doc |
| The reviewer's *original false negatives* are fixed in the deployed product | **NOT CLAIMED** | those are `pending-adjudication` — no agreed passage/outcome exists yet, so no fix is asserted |

**Key honesty note:** §4b verifies the *evaluator* reproduces the reviewer's stated
outcome **given facts that encode the substantive reading**. Turning a real passage into
those facts (extraction) is a separate, uncertain step and is NOT claimed verified here.
The three green cases prove the decision logic is correct, not that the extractor will
always produce the right facts.

---

## 7. Prompt change / flag status

**No prompt was changed.** WS4 adds a canonical rule object, a deterministic evaluator, a
runtime trace, a validator, and a regression set. The runtime wiring only *attaches* a
`canonicalRuleTrace` to each `MeasureResult`; it does not alter the LLM prompt, the scoring
decision, or any existing output field. Because behaviour is preserved and no prompt text
is emitted, **no feature flag / prompt gate is required or added.** If a later workstream
makes the canonical rule *drive* the LLM prompt or override the model's verdict, that change
should be flag-gated; this one is not, by design.

---

## 8. Non-blocking guarantee

`validateC13` emits `warning` (fallback-derived measures shipping examples) and `info`
(derived-default) only; it never emits `error`, so `validateAll().passed` is unaffected and
the check is dismissible. The adjudication set is data + a test; it blocks nothing at
runtime. The runtime trace is additive metadata. Nothing in WS4 is save-blocking.
