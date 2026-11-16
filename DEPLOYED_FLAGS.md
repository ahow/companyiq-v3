# Deployed Env Flags — Framework Robustness Workstreams (W1–W8)

Companion to `FRAMEWORK_ROBUSTNESS_PLAN_20261116.md`. Every change to the
production discovery / scoring path introduced by W1–W8 is reversible via an env
flag. Flag parsing lives in `server/lib/robustness-flags.ts`.

**Convention**
- **default-ON** flags are disabled only by an explicit `false` / `0` / `off` / `no`.
- **default-OFF** flags are enabled only by an explicit `true` / `1` / `on` / `yes`.

Set these in the Railway service variables for the production environment.

---

## Boolean feature flags

| Flag | Workstream | Default | Effect when ON |
|------|-----------|---------|----------------|
| `GATE_FAILOPEN` | W2 | **ON** | On persistent relevance-gate LLM error, KEEP the candidate batch (defer to the post-fetch content stage) instead of failing closed and dropping all ~20 candidates. |
| `GATE_SPLIT_IDENTITY_TOPIC` | W2 | **ON** | Split entity-disambiguation (strict) from topic-relevance (loosened); a candidate matching a declared disclosure vehicle passes on company-identity alone. |
| `DOCTYPE_AWARE_DISCOVERY` | W5 | **ON** | Guarantee dedicated discovery queries per declared `requiredDocType` AND apply a ranking boost (−30 priority) so those disclosure vehicles survive the pre-gate cap and near-dup collapse. |
| `FRAMEWORK_READINESS_GATE` | W3 | **ON** | Enforce the framework readiness gate on activation — block / require override when a framework would fall to the 6-query generic fallback. |
| `FROZEN_CORPUS_DEV` | W1 | **ON** | Enable the frozen-corpus (lock / replay / re-discover) dev controls on framework drafts (`/frameworks/:id/freeze-corpus`). |
| `STALLED_BATCH_REQUEUE` | W7 | **ON** | Detect zero-retrieval terminal companies (unresolved gaps + zero usable docs across the run) and auto-requeue instead of persisting false zeros. |
| `VARIANCE_HARNESS` | W8 | **ON** | Expose the framework variance report endpoints (`/variance/launch`, `/variance/report`). |
| `MULTILINGUAL_EVIDENCE_TRANSLATE` | W6 | **OFF** | Translate RETRIEVED EVIDENCE PASSAGES (not whole corpora) to English before grading. **Costs per-passage LLM calls — off by default.** |
| `VARIANCE_GATE_STRICT` | W3+W8 | **OFF** | Make *unknown* framework variance a hard readiness BLOCKER (otherwise it is an advisory warning). A known-bad variance report is always a blocker regardless of this flag. |

> ⚠️ **Behaviour change — W6 (`MULTILINGUAL_EVIDENCE_TRANSLATE`).**
> Evidence-passage translation was previously **default-ON** (legacy
> `MULTILINGUAL_TRANSLATION_ENABLED !== "false"`). Per the ENV-FLAG POLICY it is
> now gated **default-OFF** because it spends money per passage. **To preserve the
> prior multilingual / CJK scoring behaviour you MUST set
> `MULTILINGUAL_EVIDENCE_TRANSLATE=true` in production.** With it off, non-English
> evidence passages are graded as-is (no translation call).

---

## Numeric tunables

| Env var | Workstream | Default | Effect |
|---------|-----------|---------|--------|
| `STALLED_BATCH_MIN_COMPANIES` | W7 | `3` | Minimum completed companies before a run can be treated as a stall (never act on tiny batches). |
| `STALLED_BATCH_MIN_FRACTION` | W7 | `1.0` | Fraction of completed companies that must have zero usable docs for the run to count as stalled (1.0 = all). |
| `VARIANCE_MAX_FLIP_RATE` | W8 | `0.05` | Max acceptable per-measure verdict flip rate (No↔Yes) across repeated runs before variance is "unacceptable". |
| `VARIANCE_MAX_SCORE_STDDEV` | W8 | `1.0` | Max acceptable mean per-company score standard deviation across repeated runs. |

> `DOCTYPE_RESERVED_SLOTS` (W5, value `20`) is a **hardcoded constant** in
> `server/lib/discovery.ts`, not an env var — it reserves up to 20 pre-gate slots
> for declared `requiredDocType` vehicles. Listed here for completeness only.

---

## Summary: what defaults ON vs OFF

- **ON by default (net-beneficial, reversible):** `GATE_FAILOPEN`,
  `GATE_SPLIT_IDENTITY_TOPIC`, `DOCTYPE_AWARE_DISCOVERY`,
  `FRAMEWORK_READINESS_GATE`, `FROZEN_CORPUS_DEV`, `STALLED_BATCH_REQUEUE`,
  `VARIANCE_HARNESS`.
- **OFF by default (spends money / opt-in strictness):**
  `MULTILINGUAL_EVIDENCE_TRANSLATE`, `VARIANCE_GATE_STRICT`.
