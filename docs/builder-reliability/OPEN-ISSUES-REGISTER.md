# Open-issues register (builder reliability)

_Stage 1 deliverable. Companion to the four reliability workstreams._

This register records **broader audit findings that the four reliability workstreams do
NOT close.** It exists so that closing the workstreams is not mistaken for closing the
whole reliability audit.

Two things are true of every item below and must be kept in mind:

1. **These concerns may already be handled — in whole or in part — by the scorer /
   runtime code.** This register makes no claim that they are unhandled. It only records
   that the *builder and export files delivered in these workstreams do not establish
   them*. The builder produces a correct, self-consistent configuration; whether the
   scorer then applies that configuration correctly is a separate question that lives in
   scorer code and scorer tests.
2. **None of these can be closed by wording.** An item is closed only by **test results**
   that demonstrate the behaviour — not by a paragraph in a design doc, a code comment, or
   a builder-side assertion. Until such tests exist and pass, the item stays `open`.

| id | status | title |
| --- | --- | --- |
| OI-1 | open | Global answer semantics, confidence overrides, score contribution, and total reconciliation |
| OI-2 | open | Issuer/group perimeter, activity-actor vs. article-author, and source-date eligibility |
| OI-3 | open | Claim-to-source linkage, exact-quote validation, and wrong-year / unrelated-link protection |
| OI-4 | open | Frozen-evidence replay, retrieval coverage, and repeated-run consistency |
| OI-5 | open | Applicability / weighting / overlap-credit, disclosure-vs-performance labelling, and cross-version comparability |

---

## OI-1 — Answer semantics, confidence, score contribution, total reconciliation

**Status:** open

**Description.** The system uses answer values `Yes` / `Partial` / `No` / `not-found` /
`N/A`. It is not established by the builder/export files that these have a single,
consistent semantics across the pipeline: how each maps to a score contribution, how a
confidence override interacts with the answer (can low confidence downgrade a `Yes`? does
`not-found` differ from `No` in scoring?), and whether the per-measure contributions
reconcile to the reported total. Any of these may already be correct in the scorer, but it
is not demonstrated here. **Closes only with** scorer tests showing the mapping,
override interaction, and total reconciliation for each answer value.

## OI-2 — Perimeter, actor attribution, source-date eligibility

**Status:** open

**Description.** Correct scoring depends on a well-defined issuer/group perimeter (which
legal entities count as "the company"), on distinguishing the actor who performed an
activity from the author of the article reporting it (an NGO reporting on a company is not
the company acting), and on source-date eligibility (evidence must fall in the reporting
period). The builder/export files do not establish these rules. **Closes only with** tests
exercising group-perimeter inclusion/exclusion, actor-vs-author attribution, and
out-of-period source rejection.

## OI-3 — Claim-to-source linkage and quote fidelity

**Status:** open

**Description.** Each scored claim should be linked to a specific source, the quoted
evidence should actually appear in that source (exact-quote validation), and the pipeline
should be protected against wrong-year evidence and links that do not support the claim
(unrelated-link protection). These are runtime/evidence concerns not established by the
builder/export files. **Closes only with** tests that reject fabricated/altered quotes,
wrong-year evidence, and unrelated links.

## OI-4 — Replay, retrieval coverage, run-to-run consistency

**Status:** open

**Description.** Reliability requires that a run against frozen evidence replays to the
same result, that retrieval coverage is sufficient (the absence of evidence reflects
absence in the corpus, not a retrieval gap), and that repeated runs on the same inputs are
consistent. The builder/export files do not establish these. **Closes only with** tests
that replay frozen evidence to an identical result, measure retrieval coverage, and assert
repeated-run stability within a defined tolerance.

## OI-5 — Applicability, weighting, overlap credit, labelling, comparability

**Status:** open

**Description.** Scoring policy questions remain open: how measure applicability is
decided, how measures are weighted, how overlapping measures share credit (double-counting
risk), how disclosure is distinguished from performance in labelling, and whether scores
are comparable across framework versions. Workstream 2 recomputes overlap *diagnostics*
from current measures, but **recomputing overlap deliberately does not define the
score-contribution of overlapping measures** — that policy decision is tracked here.
**Closes only with** scorer tests demonstrating applicability gating, weighting,
overlap-credit handling, disclosure/performance labelling, and cross-version
comparability.

---

_When any item is closed, replace its `open` status with a reference to the passing
test(s) that establish it, and note the commit/PR._
