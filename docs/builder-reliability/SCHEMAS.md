# Builder-reliability shared schemas

_Stage 1 foundation. Types live in `server/lib/framework-v2/reliability/schemas.ts`._

These four schemas are the shared contract that the later reliability workstreams
(runtime execution, JSON export, Markdown export, structured-rule evaluation,
cross-reference integrity) all build on. They are intentionally minimal but precise,
and they are **topic-agnostic**: no field encodes any specific topic, company, or
framework.

The overarching goal is *one canonical resolved shape from which the runtime and both
export formats derive*, so those three artefacts can never silently disagree.

---

## 1. `ResolvedConfig` — the single source of truth

`ResolvedConfig` is the one canonical, fully-resolved configuration for a framework.

### Authority and precedence (the core rule)

The runtime, the JSON export, and the Markdown export **must all derive from this one
object**. This is the fix for the class of defects where a root-level field and a nested
artefact (e.g. the original intake) drift apart and it is ambiguous which one "wins".

- Root-level fields and any nested artefact **must not be independently editable with
  ambiguous precedence.** `ResolvedConfig` is authoritative.
- The original intake artefact is retained (`intakeArtefact`) **only for audit**. It is
  never a second live source of configuration. Nothing at runtime or export time reads
  configuration from the intake artefact in preference to the resolved fields. Keeping
  it (rather than discarding it) preserves traceability from resolved config back to
  what the operator/LLM originally supplied.

### Distinct retrieval lexicon surfaces

The retrieval lexicon is represented as **four distinct fields**, not one merged bag:

| Field | Purpose |
| --- | --- |
| `topicSynonyms` | Alternative names for the topic itself. |
| `evidenceKeywords` | Terms that indicate the presence of qualifying evidence. |
| `documentFilingHints` | Hints about which documents/filings tend to carry the evidence. |
| `retrievalQueryTerms?` | Optional expansion terms used to build retrieval queries. |

They are kept separate on purpose: each surface is consumed differently by retrieval and
each is subject to **its own hygiene and admission rules** (see Workstream 1). Collapsing
them into a single list destroys the ability to apply the correct rule per surface — which
is exactly how evidence keywords ended up never being hygiene-checked.

### Scope fields

`entityType`, `sectorScope`, `universe`, and `reportingPeriod` are first-class fields
(nullable), not folded into free text, so runtime and exports can reason about each
independently.

### Other typed surfaces

- `anchorFrameworks: { name: string; source: string | null }[]` — typed records rather
  than bare strings, so an anchor's provenance is explicit and a missing source is `null`
  rather than an empty string that reads as "sourced".
- `negativeKeywords`, `antiInferenceRules` — first-class arrays.
- `measures` — the resolved measures (each carries its own `evidenceKeywords` surface).
- `resolvedConfigVersion` — shape/version marker for drift detection.

---

## 2. `StructuredRule` — machine-evaluable rule logic

Builder rule logic is expressed explicitly and machine-readably instead of as free-text
prose, so it can be evaluated deterministically.

The **type is fixed in Stage 1**; the **evaluator is implemented in Stage 3**. This lets
Stage 1/2 artefacts already reference and store rules in the final shape.

Fields: `requiredClauses` (all must hold), `orAlternatives` (at least one per group),
`exclusions` (disqualifiers), `thresholds` (typed comparisons with optional units), and
`evidenceBindings` (each binds a clause to a `measureId` + `contentHash`).

### Three-valued evaluation result

`StructuredRuleResult.status` is one of:

- `pass`
- `fail`
- `unknown-review-required`

The third value is essential: evaluation must **never report a falsely-certain
pass/fail when the interpretation is genuinely uncertain.** Instead it returns
`unknown-review-required`, which a human dispositions. This prevents the scorer from
manufacturing confidence it does not have.

---

## 3. `StructuredReference` — staleness-detectable references

A reference to a measure is stored as structured data — `{ measureId, contentHash,
ruleVersion? }` — **not free text**. Because the reference carries a hash of the
referenced measure's decision-relevant content, a later recompute can detect when the
measure has changed underneath the reference (staleness) instead of the reference
silently pointing at content that no longer says what it used to.

See Workstream 2 (`cross-reference.ts`) for the hashing and reconciliation logic.

---

## 4. `ValidationState` — keep three concepts strictly separate

This schema encodes the central design correction of this work: **saving a draft,
dismissing a diagnostic, and passing a machine-readable check are three different
things** and must never be conflated.

```
ValidationState {
  checkId: string
  status: "passed" | "failed" | "unresolved" | "unknown-review-required"
  dismissedByOperator: boolean
  operatorOverride?: { by, at, reason, disposition }
}
```

- `status` is the **authoritative machine outcome** of the check.
- `dismissedByOperator` records that a human hid/acknowledged the diagnostic in the UI.
- `operatorOverride` records a human judgement about the diagnostic.

### The invariant

> **`dismissedByOperator` and `operatorOverride` never change `status`.**

A failed check stays `failed` in the record even after it is dismissed, saved, and run.
That authoritative status — together with any operator override annotation — is carried
into run results and exported results. Severity and dismissal **never** determine whether
saving or running is permitted (saving a draft is always allowed).

The invariant is enforced in exactly one place: `carryValidationStateIntoPayload()`. It
copies `status` verbatim, derives a `requiresAttention` convenience flag purely from
`status` (never from dismissal/override), and passes the operator annotations through
alongside — so downstream consumers see both the machine truth and the human annotation
without conflating them. Tests assert that dismissing/overriding a `failed` state yields a
carried payload that is still `failed` with `requiresAttention === true`.

---

## Relationship to existing builder code

These schemas are additive. They do not replace `MeasureDraft` / `FrameworkDraft` /
`Violation` in `server/lib/framework-v2/rules.ts`; later stages map between the builder
drafts and `ResolvedConfig`, and reference the builder `Violation` shape when surfacing
diagnostics. Nothing here changes existing behaviour on its own.
