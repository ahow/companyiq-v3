# Scoring Remediation Plan — Run 4 Review (2026-11-18)

Status: **PLAN FOR REVIEW — no code changed, nothing deployed.** This document diagnoses
each point in the run-4 reviewer feedback against the specific code path that produces it,
ties every regression to the RC1–RC7 fix that caused it, and proposes a sequenced set of
changes built around the two priorities you set. Every fix is generalised (keyed on document
provenance, entity identity from the workspace company list, page nature, or per-measure
sourcing) with **no company / framework / sector / measure hardcoding**, and each sits behind
an env flag with a preview-batch verification gate before any production promotion.

---

## 1. Executive read

Run 4 is a net step back for one structural reason: **the evidence set is still rebuilt on
every run, and the fixes we added to clean it up now fire in the wrong order and on the wrong
inputs.** The two things that actually moved the needle — a brand-new contamination error
(Vodafone inside Iberdrola) and falling run-to-run consistency — are both symptoms of an
unstable corpus, which is exactly what your priority #1 (lock documents per company) targets.
Several of the "improvements" from last turn (RC1 checklist, RC2 suspect, RC5 subsidiary
disambiguation) regressed because they were layered *on top of* that unstable corpus and given
thresholds/ordering that misfire across a cross-sector, mostly-"No" binary framework.

The plan therefore has two headline workstreams that match your priorities, then three
regression repairs for the self-inflicted damage, then the persistent-zero / leakage work that
survived four runs, and finally the verification protocol that was skipped last time.

---

## 2. Diagnosis — every reviewer point mapped to its code path

### 2.1 Contamination: Iberdrola cited Vodafone's 2024–2026 reports (16 of 36 measures)

Three gates should have stopped this; each has a specific hole.

- **Pre-gate title filter** (`server/lib/discovery.ts` ~L5374–5490). It rejects a candidate
  only when the candidate *title* contains a known peer name **and** does not also contain the
  target's name. It is title-only and depends on `opts.peerCompanyNames`. A Vodafone annual
  report reached Iberdrola's set either because Vodafone was not in that workspace's peer list
  at discovery time, or — more likely — because it never went through discovery at all: it was
  pulled in by the **global content cache** (`linkExistingContent`, `pipeline.ts` ~L840), which
  links documents by URL across all companies (shared-CDN PDFs).
- **Reuse aboutness floor** (`pipeline.ts` ~L860 → `aboutness.ts` `scoreAboutness`). On
  cache-linked content this is the only body-level check, and it is deliberately a *lenient
  hard-reject floor*: it rejects only when `!anchored && targetHits ≤ 1 && topOtherHits ≥
  ratio·targetHits`. A Vodafone report that mentions "Iberdrola" even a couple of times (supply
  chain, peer benchmarking, an index table) clears `targetHits ≤ 1` and survives.
- **LLM issuer verification** (`verifyDocumentCompany`, invoked for non-own-domain docs). This
  is the backstop that should have returned `mismatch` on a Vodafone document under Iberdrola.
  It returned a false "match" (or was skipped because the doc fast-pathed). This is a genuine
  false negative and is why the reviewer notes the gate "did not stop the Vodafone evidence."

Net: the contamination is a **corpus-admission** failure, not a scoring failure. The flag
caught it after the fact, but the 16 citations and the spurious utility/technology-dependencies
"Yes" were already baked into the score.

### 2.2 Consistency fell (Yes-match 74→66→59%; rank corr 0.95→0.95→0.82, 0.85 ex-Iberdrola)

The RC7 corpus-reuse layer (default ON) is not actually locking the corpus for the re-runs
being compared. Two concrete reasons:

- **Reuse is keyed globally per company, not per framework.** `worker.ts` ~L506–525 calls
  `storage.getAcceptedDocuments(companyId)`; that query (`storage.ts` ~L493–514) selects from
  the live `documents` table `WHERE company_id = ? AND gate_verdict = 'accept'` — with **no
  framework filter**. So the "frozen" set a re-run reuses is whatever was last accepted for the
  company under *any* framework, and it drifts as other runs touch the same company.
- **`recheck:true` disables reuse entirely.** `shouldReuseCorpusForRerun` returns `false` on
  `recheck`. The dashboard "Re-examine Failures" button (`api.ts` `/batch/review/reexamine`,
  ~L1767–1804) enqueues the failed companies with **`recheck: true`**, which forces fresh
  discovery and therefore a different document set for exactly the companies most likely to be
  compared across runs.
- Even when reuse is active it only skips **search/discovery**; fetch, ranking and the LLM
  scoring pass still re-run, so residual LLM nondeterminism remains a variance source that
  corpus-locking alone cannot remove.

### 2.3 Gate rejects companies' own documents (fired 8×: MAA, ING 2025, Smiths, Gerdau)

The Yes→No flip is the **entity-attribution gate** in `analyzer.ts` `runProvenanceGate`
(~L3666–3672): when `computeEligibilityFlags` returns a triggered `entity-attribution` flag on
a positive verdict, the verdict is forced to `No`/0. That flag triggers when
`reviewQuoteAttribution` (`eligibility-flags.ts` L454+) attributes **none** of the supporting
quotes to the target.

The ordering inside `reviewQuoteAttribution` is the defect. It evaluates, in order: RC6
low-value → case-study negatives → **RC5 subsidiary disambiguation** → identity-token match →
**RC4 own-domain / filing provenance** → own-domain+first-party → own-brand → trusted-source.
Because **RC5 runs before every own-document acceptance path**, a quote lifted from the
company's own sustainability report or statutory filing is rejected by RC5 before RC4/own-domain
provenance ever gets to accept it.

RC5's `namesMoreSpecificEntity` is also too loose: it fires on *core-name token + any adjacent
geographic word or subsidiary noun* (e.g. "Gerdau Brasil", "ING Australia", "Smiths Detection"
isn't geo but "… division/unit" is), and its only escape hatch is a `we/our/us` token in the
same span. An issuer's own report routinely describes its own regional operations in the third
person ("Gerdau's Brazil operations achieved…"), so RC5 mislabels first-party disclosure as a
distinct subsidiary and the whole measure flips to No.

### 2.4 "Suspect" flag too broad (13 companies) and the gaps field is blank

- **Too broad.** RC2 (`pipeline.ts` ~L3446–3485 → `analyzer.ts` `computeSourcingCoverage`
  L375) marks a company "suspect" when the share of *answered* measures carrying ≥1 eligible
  supporting quote drops below `COVERAGE_SUSPECT_MIN_SOURCED_RATIO` (default **0.8**). In a
  binary, cross-sector framework the correct answer for most measures is "No", and a correct
  "No" legitimately has **no eligible supporting quote**. So a company can be fully, correctly
  assessed and still have a sourced ratio far below 0.8 — the threshold conflates "No because
  there is genuinely no disclosure" with "No because retrieval failed." That is why solid
  names (Klépierre, JPX, Demant, Wolters Kluwer, Power Finance) are swept in.
- **Blank gaps.** The human-readable reason (`sourcingSuspectReason` / the downgrade note) is
  written **only** when the RC2 sourcing trigger itself fires. The other two paths that set
  `coverageLevel = "suspect"` — the corpus-validity trigger (`pipeline.ts` ~L1089) and the
  discovery "minimal" path — set the level but write **no reason string**, so any company
  flagged by those paths shows a suspect level with an empty gaps field.

### 2.5 Document checklist flipped: "TCFD report found" 50/50 → 0/50

RC1 (`worker.ts` ~L1326–1349). When `CHECKLIST_EMBEDDING_CONTENT_CHECK` is on, an embeddable
thematic disclosure (TCFD etc. embedded inside an umbrella annual/sustainability report) is
only marked "found" when `getAcceptedDocContentMap(companyId, cap)` returns body content **and**
that body contains the disclosure's own terms. The `catch` block degrades to `not_found` for
every unconfirmed embedding. The flip from 50/50 to 0/50 is the signature of the content map
coming back **systematically empty** — most plausibly because RC7 reuse / the batch-corpus
snapshot path carries document *metadata* but not the full body text into the map the checklist
reads, so the content check silently fails closed for all 50 companies at once. It is an
all-or-nothing data-availability failure, not a per-company content judgement.

### 2.6 Still unresolved

- **Michelin 0% every run.** The 2025 Universal Registration Document is now *in* the evidence
  set, but passage retrieval ranks its Code of Ethics and website-terms pages above the climate
  chapter. RC6's low-value filter drops the website-terms page from *backing* a verdict, but
  the Code of Ethics is substantive-looking and still dominates. This is a **within-document
  passage-retrieval / ranking** problem (the right chapter exists but is never selected), not a
  discovery problem.
- **Five companies 0% every run** (Grupo Aeroportuario del Pacífico, Hanmi, Jiangsu Zhongtian,
  Hyundai Glovis, Michelin). Three are non-US/non-English issuers (KR/CN); combined with
  Michelin's ranking issue and GAP's thin corpus, these are a mix of retrieval-depth and
  language-coverage gaps — all are now correctly caught by the coverage flag, so the priority is
  to stop them scoring a misleading 0% rather than to force a number.
- **Subsidiary / third-party leakage** (PNC via Morningstar report on its Midland subsidiary;
  a T. Rowe Price *fund* document supporting a "Yes"). `morningstar.com` *is* in
  `THIRD_PARTY_HOST_SUFFIXES`, so the own-brand waiver already refuses to treat it as
  first-party — but the Morningstar quote still mentions "PNC"/"Midland", so the identity-token
  path (which runs before the third-party checks for the *gate* flag) can still attribute it.
  RC5 misses "Midland" because it is a brand name, not a geographic word or a generic
  subsidiary noun. A T. Rowe Price *fund* document is a distinct product/legal entity that the
  current entity model doesn't separate from the manager.

---

## 3. Workstream P1 — Lock the documents per company (per framework)

**Goal:** one immutable evidence set per (company, framework), fixed on first successful
assessment and reused byte-for-byte on every subsequent run, so run-to-run swings caused by
different documents disappear. This is the single biggest lever on consistency and it also
removes the surface that let Vodafone in.

**P1.1 — Key the frozen corpus on (companyId, frameworkId), not companyId.**
Replace the global `getAcceptedDocuments(companyId)` lookup in the reuse decision with a
framework-scoped frozen set. Add `getFrozenCorpus(companyId, frameworkId)` to storage that
returns the snapshot for that pair; `worker.ts` uses it to decide `effectiveSkipDiscovery` and
to load exactly those document IDs. A first assessment of a (company, framework) pair still
discovers normally and then **writes the snapshot**; every later run of that pair reuses it.

**P1.2 — Make the frozen set an explicit immutable snapshot, not the live `documents` table.**
The live table mutates as other runs touch the company. Persist the locked set as a real
snapshot (reuse/extend the existing `batch_corpus` / `frozen_corpus` machinery rather than
inventing a third mechanism) holding the document IDs, URLs, content hashes and body text that
were accepted. Reuse reads from the snapshot, so concurrent runs on the same company under other
frameworks cannot alter it.

**P1.3 — Stop `recheck:true` from silently re-discovering.**
The "Re-examine Failures" button should re-*score* against the frozen corpus, not re-discover,
unless the operator explicitly asks for a refresh. Split the two intents: keep the longer
fetch-phase budget that `recheck` currently grants, but gate the *discovery* reset behind a
separate explicit `forceRediscover` flag. Companies that failed for transient fetch reasons then
re-run against the same locked set.

**P1.4 — Add an explicit, operator-visible "refresh corpus" action.**
Locking is only safe if there is a deliberate way to rebuild a stale set. Expose one endpoint /
button that purges the frozen snapshot for a (company, framework) and forces a clean
re-discovery, so the default is "locked" and refresh is a conscious choice (matches your
"fix one evidence set and reuse it" instruction, with an escape hatch).

**P1.5 — Residual determinism (document the limit, don't overclaim).**
Even with the corpus locked, the fetch/rank/LLM-scoring passes re-run. We already have a
deterministic seed + verdict cache; P1 should verify the verdict cache is keyed on
(companyId, frameworkId, measureId, corpusHash) so a locked corpus genuinely reproduces prior
verdicts. The optional cross-run majority layer (RC7 layer 2, `SCORING_CROSS_RUN_MAJORITY`,
currently OFF) stays available as a belt-and-braces consistency measure but is **not** required
if P1.1–P1.5 land; I'd keep it off and measure first.

---

## 4. Workstream P2 — Fix the gate in both directions

**Goal:** accept the company's own domain and filings automatically; reject documents that name
another listed company. Both directions key on provenance and on the workspace company list —
no company names in code.

**P2.1 — Own-document provenance must win over the subsidiary/cross-entity rejects.**
Reorder `reviewQuoteAttribution` so the **own-domain / own-filing provenance checks (RC4 +
own-domain + own-brand) run before RC5 subsidiary disambiguation**. A quote whose source is the
issuer's own domain or a verified statutory filing in a trusted repository whose title names the
issuer is first-party by construction and should never be knocked out by a third-person regional
phrase. RC5 then only applies to quotes that are *not* already established as own-document.
This directly fixes the 8 false rejections (MAA, ING 2025, Smiths, Gerdau).

**P2.2 — Narrow RC5 so it keys on the entity list, not on any geographic word.**
RC5 should fire only when the adjacent qualifier identifies a **distinct reporting entity**,
i.e. when "target-core + qualifier" matches another entity in the workspace company list, or a
known-subsidiary token, rather than any geographic noun. "Gerdau Brazil" inside Gerdau's own
report is Gerdau; "ING Australia" is only a problem if ING Australia is itself a separately
assessed entity or the passage otherwise fails own-document provenance. This removes RC5's
over-reach while keeping its genuine purpose.

**P2.3 — Reject documents naming another listed company, at admission (the Vodafone fix).**
Promote cross-company contamination from a title-only pre-gate heuristic to a **body-level
admission check that uses the workspace company list as the disambiguation set**:
  - Extend the aboutness / verification step so that, for any document whose body is dominated
    by another *listed* company (peer hits ≫ target hits, target not anchored in the opening),
    the document is refused — tightening the current lenient floor specifically when the
    competitor is a known listed entity, not just any org-shaped string.
  - Make `linkExistingContent` (the global cache path) run the **same** body-level
    competitor-dominance check it currently skips, so a shared-CDN PDF cached for Vodafone can't
    be silently linked to Iberdrola.
  - Treat a verified-issuer `mismatch` (or a competitor-dominant body) as a hard reject at
    admission, so contaminated documents never reach scoring rather than being flagged after.

**P2.4 — Keep the third-party host guard, extend it to the gate flag.**
`THIRD_PARTY_HOST_SUFFIXES` already blocks morningstar/analyst hosts from the own-brand waiver.
Ensure the **entity-attribution gate flag** also refuses to attribute a quote whose host is a
third-party analyst/news/ratings domain *even when it mentions the target*, so PNC's
Morningstar-sourced Midland evidence cannot support a "Yes". This closes the third-party
leakage generically (host nature, not company name).

---

## 5. Regression repairs (self-inflicted by RC1 / RC2 / RC5)

**R1 — RC1 checklist content map must not fail closed for everyone.**
Fix the content-availability path so `getAcceptedDocContentMap` returns body text for the
frozen/reused corpus (P1 makes the snapshot carry body text, which fixes the root cause). Until
then, **when the content map is empty for a document, fall back to the title/type signal rather
than forcing `not_found`**, so "TCFD report found" reflects reality instead of collapsing to
0/50 whenever content isn't in the map. Add an assertion/telemetry line that logs how many
checklist entries degraded for lack of content, so a future 50→0 flip is visible immediately.

**R2 — RC2 suspect threshold must not punish correct "No"s, and must always carry a reason.**
  - Change the suspect trigger so it keys on measures that are **answered "Yes" but unsourced**,
    or on an explicit *retrieval-failure* signal (zero eligible quotes **and** the measure's
    evidence was expected given corpus coverage), instead of the blanket "share of all answered
    measures with a quote < 0.8". A correct "No" with no disclosure must not count as a coverage
    gap. (Equivalently: lower/retarget `COVERAGE_SUSPECT_MIN_SOURCED_RATIO` and compute it over
    the measures where a source was *expected*.)
  - Always populate the reason: have **all three** suspect paths (RC2 sourcing, corpus-validity,
    discovery-minimal) write a `sourcingSuspectReason` / gaps string, so no suspect company ever
    shows a blank gaps field. This lets you tell real failures (Iberdrola, Hanmi) from false
    alarms (Klépierre, JPX) directly from the file.

**R3 — RC5 ordering + scope.** Covered by P2.1 (ordering) and P2.2 (scope). No separate change.

---

## 6. Persistent zeros and within-document retrieval

**Z1 — Michelin / within-document chapter retrieval.**
The climate chapter of the URD exists in the corpus but loses to the Code of Ethics in passage
ranking. Fix generically: boost passage-retrieval weight for chunks from the *section* of an
umbrella document that matches the framework's own thematic vocabulary (TCFD/physical-climate
terms come from the framework definition, not a company list), and down-weight boilerplate
governance/ethics/terms chunks when a thematically-matching chunk exists in the same document.
This is the same lever (per-measure passage selection) for every company, so it also helps any
other issuer whose disclosure is buried in a large registration document.

**Z2 — The five persistent zeros.**
With Z1 and P1 in place, re-measure the five. For the non-English issuers (Hanmi, Jiangsu
Zhongtian, Hyundai Glovis), confirm the corpus-readiness retry (RC6) and query-expansion are
issuing native-language / local-portal queries; GAP's thin corpus is a discovery-depth question.
The immediate correctness goal is that a genuinely unassessable company surfaces as
**suspect/low-coverage, never a confident 0%** — which the coverage flag now does; forcing a
number is explicitly out of scope.

**Z3 — Subsidiary / fund third-party leakage.** PNC/Morningstar is closed by P2.4 (third-party
host) plus P2.2 (entity-list subsidiary detection picking up "Midland"). The T. Rowe Price fund
document needs the entity model to treat a named *fund/product* as a distinct reporting entity
from the manager — handled by the same P2.2 entity-list check once fund entities are in the
disambiguation set; flag this as the one item that may need a data input (fund names) and
confirm scope with you before building.

---

## 7. Verification protocol (the step skipped last time)

No change promotes to production without this, because last run shipped RC1–RC7 straight to prod
and the regressions only surfaced after a full re-run:

1. **Unit tests** for each changed pure function (reuse keying, reordered attribution, narrowed
   RC5, RC2 trigger, competitor-dominance admission) — these are already pure/testable.
2. **Preview batch against the known problem set** on a preview environment with the new flags
   on: Iberdrola (contamination), MAA / ING / Smiths / Gerdau (own-doc false rejects), the 13
   suspect-flagged names (false-alarm check), Michelin + the five zeros, PNC + T. Rowe (leakage).
   Compare run-over-run **Yes-match %, rank correlation, suspect count, and the contamination
   count** before/after.
3. **Promotion gate:** promote only when contamination = 0, own-doc false rejects = 0, suspect
   count drops to the genuinely-thin companies, and rank correlation recovers toward ≥0.95 — and
   no previously-passing company regresses.
4. Each change behind its own env flag (extend `scoring-fix-flags.ts`) so any single fix can be
   rolled back independently without a redeploy.

---

## 8. Proposed sequencing

1. **P1 (lock corpus per framework)** + **R1 content-map fix** — biggest consistency lever and
   it removes the surface for most other problems; R1 rides along because P1's snapshot carries
   body text.
2. **P2 (two-directional gate)** — depends on nothing in P1; fixes contamination admission and
   own-doc false rejects. P2.1 reorder is low-risk and high-value, do it first within P2.
3. **R2 (suspect threshold + reasons)** — small, isolated, immediately improves signal.
4. **Z1 (within-document retrieval)** then **Z2/Z3 re-measure.**
5. Preview batch after each of steps 1–3; full promotion only after the combined preview passes
   section 7's gate.

---

## 9. What this plan deliberately does **not** do

- No change to binary scoring (0/1, Partial→0) and no per-sector logic — every rule keys on
  provenance, page nature, the workspace entity list, or per-measure sourcing.
- No forcing of a non-zero score for genuinely unassessable companies; the goal there is honest
  coverage labelling.
- No cross-run majority (RC7 layer 2) unless P1 proves insufficient on its own.
- The weak-"Yes" / construct-match tightening (the deferred `yesQuoteBasis` item) stays a
  documented fast-follow unless you want it pulled into this round.

---

*Prepared for review. On your approval I will implement in the order in section 8, one flag at a
time, with the preview batch in section 7 run before any production promotion.*
