# CompanyIQ v3 — Framework Creation Design (v2)

**Status:** Revised design document. Supersedes v1.
**Date:** 2026-08-29
**Author:** Sprint 10 planning
**Change log vs v1:** Incorporates 20 user comments from annotated v1 plus 11 items from follow-up review. Migration path removed; test-drive and export-as-seed stages added; per-measure interaction, robustness gate, LLM pushback, and TCFD default structure formalised.

## Purpose

Redesign the framework-creation component so a user can provide a topic in plain language (optionally guided by a pre-fill template) and the application, via an LLM chat, produces a framework that is correct-by-construction against all identified failure modes. The output should require no post-hoc transformation, should be validated against sample scoring before finalisation, and should generalise across topics, sectors, and entity types.

## What this replaces

The current builder skill and the post-hoc `generic_framework_transformer.py` are both replaced by a single build-time pipeline. **Migration of legacy frameworks (fw3_v5, fw8_v7fx, fw11b_v2) is out of scope** — new frameworks are built fresh for these topics using the revised builder. The runtime pipeline retains softened R3.3 as insurance.

## Non-goals

- Changing the scoring pipeline architecture (per-measure retrieval, evidence-absent tagging, tiered CoT, ML filter all stay)
- Introducing non-binary scoring — verdicts remain 1/0
- Framework-specific behaviour — every rule below is topic-agnostic

## Governing principles

Every construction rule below is derived from one or more of these.

1. **Substantiation over rhetoric** — measures distinguish substantiated practice (named programmes, quantified metrics, time-bound targets, externally assured data) from generic or aspirational language.
2. **Disclosure is not practice** — non-disclosure is a separate state from "No". The framework tests what the entity has disclosed, not what it has done.
3. **Position, not outcome (with permissive interpretation)** — measures test the existence of a disclosed position (policy, target, commitment, standard), OR an achievement claim that logically implies such a position. A stated outcome that unambiguously entails a prior commitment (e.g. "we achieved net zero") counts as evidence of that commitment. A factual outcome that does not entail a position (e.g. "emissions fell 30%") does not.
4. **Topic attribution is required for evidence to count** — a policy on an adjacent topic is not evidence of a policy on this topic, even if vocabulary overlaps. Alternative terms for the topic (synonyms) are handled explicitly via a topic-term registration.
5. **Independent perspective** — the framework must surface evidence both for and against entity performance. Never infer the desired verdict from the topic.
6. **Assertive LLM guidance** — the builder LLM is expected to push back on user answers that contradict its research or produce measurable framework weaknesses. Framework robustness takes precedence over user comfort.

---

## Part 0 — Initial-input template (NEW)

Before the intake conversation begins, the user optionally provides a structured pre-fill using this template. This lets the user prepare their thinking outside the chat and gives the LLM a strong starting point. Users who submit only a topic sentence get the full intake experience; users who submit a completed template get a shorter, more targeted intake.

The template is also the artefact used to **export an existing framework as a seed** for a new build (see Part 6).

### Template

```markdown
# Framework build brief

## 1. Topic
(2–5 sentences in plain language. What is the topic and what makes it distinct?
Do not list terms or measures — describe the concept.)

## 2. Purpose
(1–3 sentences. Why are you building this framework? What decision will it
support — screening, benchmarking, engagement, thematic exposure, other?)

## 3. Entity scope
- Entity type: [listed companies | funds | projects | public bodies | other]
- Sector scope: [agnostic | specific: <sector list>]
- Universe: [global | region | index — e.g. FTSE All-World, MSCI Europe]
- Reporting period: [default = last 3 years, most recent preferred]
- Explicit exclusions: [any entities or sectors to exclude]

## 4. Evidence anchors (all optional)
- Authoritative standards or regulations you consider anchor references
  (e.g. TCFD, ISSB, SBTi — leave blank if none come to mind)
- Peer methodologies or benchmarks you've seen used for this topic
- Example disclosures that would clearly count as evidence
  (2–4 examples, verbatim if possible, else paraphrased)
- Example disclosures that would LOOK convincing but should NOT count
  (2–4 examples — this is the most valuable input for preventing false positives)

## 5. Sensitivity and priorities
- Overall preference: [precision | recall | balanced (default)]
- Practices or disclosures that MUST be captured (if any):
- Practices or disclosures that MUST NOT be treated as evidence (if any):
- Guardrails — decisions the framework must NOT infer:
```

The template deliberately does NOT ask for:
- Adjacent topics (LLM proposes; user prunes)
- Anchor framework names (LLM proposes if user leaves blank)
- Sub-areas or categories (LLM proposes TCFD-style structure with alternatives)
- Synonyms (LLM proposes)
- Measure IDs or titles

Why: the user typically doesn't know these at the start. Asking them to guess produces low-quality guesses. The LLM is better at proposing candidates the user can react to.

### Using the template

- **New topic**: user fills in Section 1 minimum; other sections optional. LLM reads and starts intake.
- **Seeded from existing framework**: `export_framework_as_seed` produces a filled template from an existing framework's metadata. User edits and uses as seed for the new build. See Part 6.

---

## Part 1 — Intake conversation

The intake conversation runs after the user provides the initial-input template (or a topic sentence). The LLM's job is to resolve every ambiguity that would otherwise leak into a measure. The conversation is **not a fixed number of turns** — it continues until a robustness gate is satisfied, or the user chooses to proceed with residual ambiguity flagged.

### Conversation principles

1. **LLM proposes long lists, user reacts.** For adjacent topics, anchor frameworks, synonyms, and example phrases, the LLM generates an intentionally-long candidate list (drawing on its Stage 1 research and general knowledge) and asks the user to prune, edit, or add. Users are prone to omission when asked to enumerate from scratch; reaction is easier than recall.

2. **Cluster clarifications, don't fragment them.** When the same clarification applies to multiple measures or sub-areas, ask once — e.g. "for these five governance measures, is disclosure of a named board committee sufficient, or must the committee have specified responsibilities?" — not five times.

3. **Ask only where ambiguity exists.** If Stage 1 research plus prior turns already resolve a question, skip it. Don't ask routine questions on measures that are clearly-defined.

4. **Push back on suspicious answers.** If a user answer directly contradicts Stage 1 research, the LLM must challenge it before accepting. Example: "You said 'human rights' is not adjacent to modern slavery. Stage 1 research found that most modern-slavery disclosures appear in general human rights sections. Are you sure — this would cause the framework to accept general human-rights evidence for modern-slavery measures."

5. **Robustness over user comfort.** The LLM's assertiveness threshold should be tuned so it will re-raise concerns two or three times if the user dismisses them; only proceeds with recorded warnings after the user has explicitly acknowledged the risk.

### Robustness gate

After each intake turn, the LLM internally scores intake completeness against this checklist. Continues asking questions until every item is satisfied, or the user explicitly requests to proceed with warnings.

**Robustness checklist:**

- [ ] Topic term is defined as a canonical short phrase
- [ ] Topic synonyms (2–6) are proposed and confirmed
- [ ] Adjacent topics: ≥2 identified with example phrases, OR explicit "no adjacent topics identified" acknowledgment
- [ ] Anchor frameworks: either confirmed non-empty list or explicit "none applicable"
- [ ] Entity type, sector scope, universe, reporting period all set
- [ ] Sensitivity preference set (default = balanced)
- [ ] Sub-area structure agreed (TCFD default or alternative — see below)
- [ ] For each sub-area: at least one distinct measure type is anticipated
- [ ] User has answered any Stage 1 pushback (or explicitly overruled it)
- [ ] Ambiguity notes: LLM has recorded and resolved any remaining questions that would change measure phrasing

After each turn the LLM reports checklist state to the user: "8 of 10 items resolved. Two open: [list]. Answer these or should I proceed with best-guess drafts and flagged warnings?" User chooses continue-asking or proceed-with-warnings.

### Category structure — TCFD-style default with alternatives

For most framework topics, the LLM defaults to proposing a TCFD-inspired four-pillar structure adapted for the topic:

- **Governance** — board / executive / committee oversight of the topic
- **Strategy** — the entity's stated position, targets, and commitments on the topic
- **Risk management** — how the entity identifies, monitors, and mitigates topic-specific risk
- **Metrics and targets** — quantified disclosures and time-bound targets on the topic

The LLM MUST also assess whether this structure fits the topic. If not, it proposes an alternative structure with a rationale — for example, modern slavery is often better organised as Policy / Due Diligence / Remediation / Reporting; AI governance as Principles / Governance / Development / Deployment / Monitoring. User confirms which structure to use during intake.

### Conversation flow (typical)

Illustrative flow — actual turns are LLM-driven and adapt to what the initial template already covered. If the user submitted a rich template, several of these turns collapse to a single "confirm what I've inferred" check.

**Turn 1 — Topic term and scope boundaries**
Reads the topic from the template. Proposes:
- Canonical topicTerm
- Sub-area structure (TCFD default or topic-specific alternative, with rationale)
- Long candidate list of adjacent topics (5–10) drawn from Stage 1 research
User confirms/edits the topicTerm, chooses the structure, and prunes the adjacent-topics list. LLM PUSHES BACK on any adjacent topic the user removes if Stage 1 research indicates high vocabulary overlap.

**Turn 2 — Topic synonyms**
LLM proposes 4–8 synonym candidates drawn from a thesaurus and Stage 1 research (e.g. for modern slavery: forced labour, human trafficking, unfree labour, bonded labour, involuntary servitude). User confirms which are substantively equivalent for scoring purposes. The final list must be conservative — 2–6 entries, only substantively equivalent terms.

**Turn 3 — Anchor frameworks and standards**
If the template listed anchor frameworks, LLM confirms and may propose additions from Stage 1 research. If the template left this blank, LLM proposes 4–8 candidates the user can prune.

**Turn 4 — Entity scope, reporting period, sensitivity**
Reads template. Confirms:
- Entity type, sector scope, universe
- Reporting period (default: last 3 years, most recent preferred; if 2025 reporting contradicts 2024, use 2025)
- Sensitivity preference (default: balanced)

**Turn 5 — Example evidence: positive and adversarial**
LLM proposes 3–5 example positive disclosures (paraphrased from Stage 1 research findings) and 3–5 adversarial cases drawn from adjacent topics. User confirms, edits, adds their own. This populates the base examples used in every measure's `positive_examples` and `negative_examples` fields (C6).

**Turn N — Sub-area confirmations**
For each proposed sub-area, LLM asks whether it captures the intended scope, and whether any sub-area-specific ambiguity needs resolving. Typically 1 turn covers 2–3 sub-areas.

**Turn N+1 to N+M — Measure-cluster clarifications (during Stage 3)**
Extends into Stage 3 measure drafting. When the LLM detects ambiguity while drafting a cluster of related measures, it pauses drafting and asks a clustered question. Example: "I'm drafting the five governance measures. For these, does disclosure of a named board committee with topic-relevant scope satisfy the measure, or must the committee's mandate include specific responsibilities like 'reviews annual policy' or 'signs off on reporting'?" One question resolves five measures.

**Final Turn — Read-back and confirmation**
LLM reads back intake summary, flags any residual warnings, and asks user to confirm before Stage 4 (schema conversion) begins.

### Intake output artefact

Structured intake summary saved as `topic_intake_[slug].md`. Every measure downstream must be traceable to a line in this document.

- `topic`: string (from template Section 1)
- `topicTerm`: canonical short phrase
- `topicSynonyms`: list of 2–6 entries
- `purpose`: string (from template Section 2)
- `subAreaStructure`: {"type": "tcfd" | "custom", "categories": [...], "rationale": "..."}
- `adjacentTopics`: list of {name, example_phrases, cooccurrence_possible, source} entries
- `anchorFrameworks`: list of {name, source} entries
- `entityType`, `sectorScope`, `universe`, `reportingPeriod`: from template Section 3
- `sensitivityPreference`: precision | recall | balanced
- `basePositiveExamples`, `baseNegativeExamples`: shared examples for use in measures
- `pushbackRecord`: list of {question, user_response, resolved} — every LLM pushback recorded, with the user's response and whether it was resolved or overruled
- `residualWarnings`: list of {issue, severity, note} for any items proceeding with user acknowledgment
- `confirmed`: boolean, timestamp

---

## Part 2 — Construction rules (C1-C10)

Each rule specifies:
- **What it enforces**
- **How it enforces at build time** (Stage 3 prompt instruction)
- **How it's validated** (Stage 5 assertion)
- **Why it matters**

### C1 — Position-testing phrasing (permissive interpretation)

**Enforces:** Every measure title tests the existence of a disclosed position (policy, target, commitment, standard, statement), OR an achievement claim that logically entails such a position. Every measure carries per-measure guidance on what counts as "achievement-implies-commitment" for THAT measure.

**Stage 3 instruction:**
"Every measure title MUST test the existence of a disclosed position. Rewrite any question phrased as 'has X done Y' to 'does X disclose Y' or 'does X disclose a policy/target/commitment on Y'.

Achievement claims that entail a position count as evidence. Draft per-measure `c1_achievement_guidance` describing:
- Which achievement claims for THIS measure entail a stated position (Yes cases) — e.g. for a net-zero-policy measure: 'we have achieved net zero', 'we have reached carbon neutrality'
- Which factual outcomes for THIS measure do NOT entail a position (No cases) — e.g. 'our emissions fell 30%', 'energy use declined last year'
- The distinguishing test: the disclosure must contain a target-state, aspiration, or programme reference. A pure numerical outcome without target-state language does not qualify.

Two exceptions to the position-testing requirement:
- Metrics measures — the title tests a disclosed quantitative value. Set `r3_1_exception_metrics: true`.
- Coverage measures — the title tests scope of application (see C7). Set `r3_1_exception_coverage: true`.

Achievement-verb blacklist for titles (unless in exception): has achieved, has phased out, has eliminated, has excluded, currently excludes, currently applies, has implemented enterprise-wide, currently operates."

**Stage 5 validator:**
- For every non-exception measure, title and `primary_assessment_target` must not contain any blacklisted achievement verb
- Every measure must have `c1_achievement_guidance` populated with both Yes cases and No cases

**Why it matters:** FP1 forward-looking failure mode (~20% of fw3 FPs) came from measures asking about achievement but the LLM reading commitment language as past-tense achievement. The permissive interpretation captures cases where achievement DOES entail commitment (e.g. "we have achieved net zero" implies a net-zero policy).

### C2 — Substantive-only exclusions

**Enforces:** `whatDoesNotConstituteEvidence` rejects only on substantive grounds. May NOT reject on tense, aspiration-vs-execution, or vocabulary grounds. MUST reject on wrong subject, missing specificity, third-party attribution, or wrong topic.

**Stage 3 instruction:**
"The `whatDoesNotConstituteEvidence` field is for substantive exclusions only. Do NOT include:
- Any clause saying commitments, targets, plans, intentions, or future actions don't count
- Any clause requiring specific vocabulary or specific document types
- Any clause rejecting on tense

You MUST include:
- Rejection of aspirational language ('we care about', 'we recognise the importance of') without specific subject, action, and timeframe
- Rejection of third-party or industry references the entity has not adopted
- Rejection of adjacent-topic evidence (via C5)"

**Stage 5 validator:** Regex check — must not contain any variant of "forward-looking", "commitment does not qualify", "intention to disclose", "plans are not evidence".

**Why it matters:** FP diagnostic showed measures were routinely rejecting valid commitment evidence.

### C3 — Quote-context requirement

**Enforces:** Every measure declares `min_quote_context_chars: 120` (or higher). Every measure's `scoringGuidance` requires the scoring LLM to return a verbatim quote of at least 120 characters including surrounding sentence context.

**Stage 3 instruction:**
"For every measure, set `min_quote_context_chars: 120`. In `scoringGuidance`, include verbatim: 'When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context. Do not truncate at the topic term.'"

**Stage 5 validator:** `min_quote_context_chars ≥ 120` integer; `scoringGuidance` contains "adjacent sentence" or equivalent context instruction.

**Why it matters:** FP12 class where short quotes matched on numeric shape but full context revealed different topic.

### C4 — Topic-anchored fallback conditions

**Enforces:** Every measure's `fallback_yes_criterion` is a numbered OR-list of ≥3 substantive conditions. Every condition must reference the framework's `topicTerm` or a measure-specific narrowing meaningfully, not decoratively.

**Stage 3 instruction:**
"Every measure must have a `fallback_yes_criterion` structured as numbered conditions. Template:
```
Yes if ANY of the following substantive conditions is met, regardless of vocabulary or disclosure vehicle:
(1) The entity discloses a policy, commitment, target, or statement specifically on [TOPIC], at any level of detail — including forward-looking commitments and framework alignments (e.g. [anchor framework names]).
(2) The entity discloses a monitoring, audit, KPI, or measurement programme specifically addressing [TOPIC].
(3) The entity discloses a governance structure (board committee, executive owner, working group) with [TOPIC] explicitly in its mandate.
(4) The entity discloses a contractual clause, supplier code provision, employee code provision, or legal instrument specifically addressing [TOPIC].
```

CRITICAL: In every condition, substitute [TOPIC] with the actual topic term or a narrower sub-topic. A condition like 'The entity discloses a policy' with the topic term appended is NOT sufficient — the topic must be central to the condition's meaning."

**Stage 5 validator:** ≥3 numbered conditions; every condition contains topicTerm or a documented topicSynonym as a substring in a semantically-central position (not merely appended at the end).

**Why it matters:** fw8_R31R32R34 lost 0.058 F1 because generic fallback matched adjacent-topic evidence.

### C5 — Adjacent-topic exclusion in substantive_definition

**Enforces:** Every measure's `substantive_definition` includes an explicit adjacent-topic exclusion clause drawn verbatim from the intake artefact's `adjacentTopics` list.

**Stage 3 instruction:**
"Every measure's `substantive_definition` must include: 'This measure specifically tests [TOPIC]. Evidence attributed to adjacent topics does NOT satisfy this measure, even if language overlaps. Adjacent topics that must be excluded include: [list from intake].' Draw the adjacent topics VERBATIM from the intake artefact. Do not invent adjacent topics."

**Stage 5 validator:** For every measure, `substantive_definition` must reference at least one adjacent-topic exclusion drawn from the intake. If intake has <2 adjacent topics, framework metadata must record "no adjacent topics identified".

**Why it matters:** fw8 modern slavery FPs came primarily from general human-rights supplier clauses.

### C6 — Positive AND adversarial-negative examples

**Enforces:** Every measure carries `positive_examples` (2–4 short verbatim excerpts that should score Yes) AND `negative_examples` (2–4 adversarial excerpts that superficially look like they should score Yes but should not).

**Stage 3 instruction:**
"For every measure, generate:
- `positive_examples`: 2–4 short (≤200-char) excerpts that clearly satisfy the measure. Draw from intake `basePositiveExamples` and adapt to the specific measure.
- `negative_examples`: 2–4 short excerpts that superficially look like they satisfy the measure but should NOT. Draw from intake `baseNegativeExamples` and the adjacent-topics list.

If drafting is ambiguous for a specific measure, ask the user directly — 'For this measure, would <example> count as evidence?' — using clustered questions to resolve multiple measures at once."

**Stage 5 validator:** Both fields present, ≥2 entries each, ≤300 characters per entry.

**Why it matters:** Adversarial examples give the scoring LLM a clear boundary. Prior diagnostics attributed 15–20% of FPs to this signal being absent.

### C7 — Coverage-explicit phrasing with per-measure whitelist

**Enforces:** Any measure testing scope of application must specify the coverage threshold explicitly in its title AND carry a per-measure whitelist of plain-language phrases that satisfy the threshold. The scoring LLM reports observed coverage numerically or ordinally.

**Stage 3 instruction:**
"If a measure tests coverage or scope, its title must state the threshold explicitly. Examples:
- 'Coverage applies enterprise-wide OR to ≥70% of the portfolio' (good)
- 'The policy is applied broadly' (bad — no threshold)

Additionally, every coverage measure must carry a `coverage_whitelist`: a list of plain-language phrases that satisfy the threshold. Draft the whitelist per measure — companies rarely disclose specific percentages, so plain-language equivalents must be captured. Example for an enterprise-wide policy measure:
```
coverage_whitelist: [
  'across the group', 'across all our business', 'enterprise-wide',
  'globally', 'group-wide', 'all our operations', 'company-wide'
]
```

For each candidate coverage measure, if the appropriate whitelist is unclear, ASK the user during Stage 3 — 'For this measure, what phrases would you accept as evidence of full coverage?'

The `scoringGuidance` for coverage measures must instruct the LLM to report observed coverage as one of: enterprise-wide, majority (>50%), material (25–50%), limited (<25%), unknown. Whitelisted phrases map to enterprise-wide.

Flag such measures with `r3_1_exception_coverage: true`."

**Stage 5 validator:**
- Any measure flagged as coverage exception must contain a numerical or ordinal threshold in title
- Any coverage measure must have `coverage_whitelist` with ≥3 entries

**Why it matters:** FP class where "we have this in Europe" scored as coverage=Yes for enterprise-wide measures. Also prevents over-punitive rejection of valid plain-language coverage statements.

### C8 — Vehicle-agnostic evidence acceptance

**Enforces:** `substantive_definition` explicitly states evidence may appear in any disclosure vehicle. `disclosure_vehicles` lists PREFERRED vehicles for retrieval, not required vehicles for scoring.

**Stage 3 instruction:**
"Every `substantive_definition` must include: 'Evidence may be disclosed in any vehicle — including annual reports, sustainability reports, dedicated policy documents, code-of-conduct sections, KPI tables, or statements published on the entity website — provided the content substantively matches this measure's target. Specific vehicle labels are illustrative, not required.'"

**Stage 5 validator:** `substantive_definition` contains "any vehicle" or equivalent.

**Why it matters:** Valid disclosures appearing in a different vehicle were rejected on vehicle grounds.

### C9 — Expected Yes-rate calibration per measure

**Enforces:** Every measure carries `expected_yes_rate` (fraction of large-cap universe expected to score Yes). Range 0.01–0.99. Used for sanity check at Stage 5 and for flag analysis at Stage 6.5 test-drive.

**Stage 3 instruction:**
"For every measure, estimate `expected_yes_rate` — the fraction of large-cap listed companies you'd expect to score Yes if applied at random. Reflect current disclosure practice, not aspiration. Use scale: 0.05, 0.10, 0.20, 0.35, 0.50, 0.65, 0.80, 0.95. Default 0.35 if uncertain."

**Stage 5 validator:** Present as float in [0.01, 0.99]. Framework-level distribution recorded; flag frameworks where >20% of measures have `expected_yes_rate` <0.10 or >0.80.

**Why it matters:** Sanity check that catches framework design errors before scoring. Test-drive uses observed vs expected deviation as a flag signal.

### C10 — Topic term registration and synonym set

**Enforces:** Framework declares `topicTerm` at framework level plus `topicSynonyms` list (2–6 entries).

**Stage 3 instruction:**
"Declare at framework level:
- `topicTerm`: canonical short phrase (e.g. 'modern slavery and forced labour')
- `topicSynonyms`: 2–6 alternative phrasings considered substantively equivalent for scoring

Every topic-term reference in measures may be substituted with any synonym. Be conservative — synonyms must be substantively equivalent, not merely adjacent."

**Stage 5 validator:** Both fields present; `topicSynonyms` has 2–6 entries.

**Why it matters:** Enables C4 anchoring to accept semantically-equivalent phrasings without flagging valid measures as violating topic anchoring.

---

## Part 3 — Stage-by-stage builder flow

The builder runs eight stages. Stages 0, 6.5, 6.6 are new versus v1.

### Stage 0 — Initial input and intake (NEW/REVISED)

- User submits initial-input template (Part 0). If not submitted, user provides at minimum a topic sentence and LLM proceeds without pre-fill.
- LLM runs intake conversation per Part 1 with robustness gate.
- LLM pushes back on any user answer that contradicts Stage 1 research findings; records every pushback and outcome in `pushbackRecord`.
- Produces `topic_intake_[slug].md`.
- User confirms intake before proceeding.

### Stage 1 — Topic discovery and standards research

- LLM researches anchor standards, regulatory landscape, common disclosure patterns.
- Saves findings to `topic_research_notes_[slug].md` with citations (URLs required per user preference).
- Findings feed pushback logic — the LLM has research-backed grounds for challenging suspicious user answers.

### Stage 2 — Exhaustive question bank (draft)

- LLM drafts 80–200 candidate questions covering all sub-areas.
- Every question is C1-compliant (position-testing phrasing).
- Every question tagged with its sub-area and any measure-cluster it belongs to.

### Stage 3 — Consolidate into 5–9 categories, draft measures (interactive)

- LLM consolidates question bank into 25–40 measures.
- **Clustered clarifications**: whenever the LLM detects ambiguity across a cluster of related measures, it pauses and asks a clustered question. Skips clarifications where intake already resolved the ambiguity.
- Every drafted measure includes:
  - Title, definition, `primary_assessment_target` (C1-compliant)
  - `c1_achievement_guidance` (C1 per-measure Yes/No cases for achievement claims)
  - `substantive_definition` with adjacent-topic exclusion (C5) and vehicle-agnostic clause (C8)
  - `whatConstitutesEvidence` and `whatDoesNotConstituteEvidence` (C2-compliant)
  - `scoringGuidance` with quote-context instruction (C3)
  - `fallback_yes_criterion` with topic-anchored numbered conditions (C4)
  - `positive_examples` and `negative_examples` (C6)
  - `min_quote_context_chars: 120` (C3)
  - `expected_yes_rate` (C9)
  - `coverage_whitelist` if coverage measure (C7)
  - Exception flags where applicable (C1, C7)

### Stage 4 — Convert to output JSON schema

Framework-level metadata now includes:
- `topicTerm`, `topicSynonyms` (C10)
- `adjacentTopics` (from intake)
- `anchorFrameworks` (from intake)
- `sensitivityPreference` (from intake, influences fallback strictness — see below)
- `pushbackRecord` (from intake)
- `residualWarnings` (from intake)
- `rulesActive` (all C1-C10 recorded as active for auditability)

**Sensitivity lever concrete effects:**
- `precision`: fallback conditions require 2+ substantive elements to trigger Yes; adjacent-topic exclusions phrased strictly ("Evidence attributed to adjacent topics does NOT count under any circumstances")
- `recall`: fallback conditions accept any 1 substantive element; adjacent-topic exclusions phrased softly ("Evidence attributed to adjacent topics does not count unless it explicitly addresses [TOPIC]")
- `balanced` (default): standard C4 template; adjacent-topic exclusions per C5 default template

### Stage 5 — Validate

- Runs all C1-C10 assertions.
- Failure produces per-measure report with specific rule violated and suggested fix.
- Builder LLM may re-draft violating measures and re-validate — up to 3 iteration cycles.
- Additional structural assertions retained: 5–9 categories ordered existence→quality→coverage→progress, 25–40 measures, 10–14 search templates, 30–45 evidence keywords, every search template uses OR groups and ends with `filetype:pdf` unless HTML exception.
- If C1-C10 pass, framework is accepted for Stage 6 review.

### Stage 6 — Sanity review

- Builder produces a one-page summary:
  - Distribution of `expected_yes_rate` (flag outliers)
  - Coverage of sub-areas from intake (are all sub-areas covered by ≥1 measure)
  - Sample of 3 measures shown to user for review
- User can request specific measure re-drafts before test-drive.

### Stage 6.5 — Test-drive on 10-company sample (NEW)

- **Sample selection**: 10 companies chosen with the following rules:
  - **Sector-agnostic framework**: 10 companies representative of the global equity market — mix of sectors, market caps, geographies. LLM proposes the list drawing on Stage 1 research to prioritise companies likely to disclose on the topic (so we get signal, not silence).
  - **Sector-specific framework**: 10 companies from that sector, chosen for the same signal-generating criterion.
- User can override the list (add/remove specific companies).
- **Test-drive scoring**: score all 10 companies through the full pipeline (softened R3.3 on).
- **Automated flag analysis**:
  - Measures where 0/10 score Yes — probably too narrow
  - Measures where 10/10 score Yes — probably too broad
  - Measures where observed Yes rate deviates from `expected_yes_rate` by >2× — flagged for review
  - Measures where R3.3 flipped ≥40% of Yes verdicts — quote-context issues
  - Any measure where scoring produced No verdicts but the LLM's evidence retrieval found high-confidence adjacent-topic hits — potential C5 exclusion tightening needed
- **Cross-check with intake — LLM pushback (post-test)**:
  - If Stage 1 research indicated an adjacent topic that the user excluded from the intake list, AND the test-drive results show FPs likely attributable to that adjacent topic, LLM raises this to the user with evidence: "You chose to exclude 'human rights' as an adjacent topic. In the test-drive, 6 of the 22 Yes verdicts on measure X were supported by quotes that came from human-rights sections. Do you want to add 'human rights' to the adjacent-topics list?"
  - This is the second pushback moment (the first was during intake based on research; this is after evidence).

### Stage 6.6 — Flag review and iteration (NEW)

- LLM presents the test-drive flag report in plain language.
- For each flag, LLM proposes a specific fix (e.g. "measure 3.2 fires on 0/10 companies — consider softening its fallback conditions", "measure 4.1 fires on 10/10 companies — consider adding an adjacent-topic exclusion for X").
- User accepts, rejects, or requests custom fixes.
- Fixes trigger return to Stage 3 for the affected measures only, followed by Stage 5 re-validation.
- Optionally another test-drive if fixes are substantial.
- Loop continues until user confirms results are acceptable.

### Stage 7 — Finalisation

- User confirms the test-drive results and any residual warnings are acceptable.
- Framework saved as canonical with metadata:
  - All intake artefacts
  - Stage 5 validation results
  - Stage 6.5 test-drive results (companies scored, flag report, fixes applied)
  - Stage 6.6 iteration history
  - `test_drive_warnings` field records any flags the user chose to proceed with despite LLM concern
- Framework marked as `production_ready: true`.

**If test-drive fails and user says proceed anyway**: framework is saved with `production_ready: true` but `test_drive_warnings` records the specific unresolved flags. Users of the framework in future can see these caveats. This preserves user autonomy without silently discarding LLM concerns.

---

## Part 4 — Output schema

### Per-measure fields

| Field | Type | Required | Source rule |
|-------|------|----------|-------------|
| `title` | string | yes | C1 |
| `primary_assessment_target` | string | yes | C1 |
| `c1_achievement_guidance` | object | yes | C1 |
| `substantive_definition` | string | yes | C5, C8 |
| `whatConstitutesEvidence` | string \| list | yes | — |
| `whatDoesNotConstituteEvidence` | string \| list | yes | C2 |
| `scoringGuidance` | string | yes | C3 |
| `fallback_yes_criterion` | string | yes | C4 |
| `positive_examples` | list[string] | yes (≥2) | C6 |
| `negative_examples` | list[string] | yes (≥2) | C6 |
| `min_quote_context_chars` | int ≥120 | yes | C3 |
| `expected_yes_rate` | float [0.01, 0.99] | yes | C9 |
| `coverage_whitelist` | list[string] | if coverage measure (≥3) | C7 |
| `r3_1_exception_metrics` | bool | optional | C1 |
| `r3_1_exception_coverage` | bool | optional | C1, C7 |
| `disclosure_vehicles` | list[string] | optional | C8 (preferred only) |

`c1_achievement_guidance` structure:
```json
{
  "yes_cases": ["achievement claims that entail a position", ...],
  "no_cases": ["factual outcomes without target-state language", ...],
  "distinguishing_test": "the disclosure must contain target-state / aspiration / programme reference"
}
```

### Framework-level fields

| Field | Type | Required | Source |
|-------|------|----------|--------|
| `topicTerm` | string | yes | C10 |
| `topicSynonyms` | list[string] (2–6) | yes | C10 |
| `adjacentTopics` | list[{name, example_phrases, cooccurrence_possible, source}] | yes | C5, intake |
| `anchorFrameworks` | list[{name, source}] | yes | intake |
| `sensitivityPreference` | "precision" \| "recall" \| "balanced" | yes | intake |
| `subAreaStructure` | object | yes | intake |
| `pushbackRecord` | list[{question, user_response, resolved}] | yes | intake |
| `residualWarnings` | list[{issue, severity, note}] | yes | intake |
| `test_drive_summary` | object | yes | Stage 6.5 |
| `test_drive_warnings` | list | yes | Stage 6.5/6.6 |
| `production_ready` | bool | yes | Stage 7 |
| `rulesActive` | dict | yes | audit |

---

## Part 5 — Test-drive and iteration (elaborated)

Elaborates Stages 6.5 and 6.6 above with specific mechanics.

### Sample composition

**For sector-agnostic frameworks**, the 10-company sample is chosen with the following rules:
- Cover ≥5 sectors
- Cover ≥3 geographies (Americas, Europe, Asia-Pacific)
- Cover ≥2 market cap tiers (large cap and mid cap)
- Include ≥3 companies known from Stage 1 research to disclose on the topic (signal companies)
- Include ≥2 companies from sectors where the topic is peripheral (edge cases)

**For sector-specific frameworks**, all 10 from the specified sector, with:
- Geographic diversity where possible
- Market-cap diversity where possible
- At least 3 known-good disclosers on the topic (signal)
- At least 2 known-limited disclosers (edge cases)

LLM proposes the list; user can override. LLM records the rationale for each company chosen.

### Flag rules (concrete)

Each flag has a defined threshold:

| Flag | Threshold | Suggested fix |
|------|-----------|---------------|
| Too narrow | 0/10 Yes verdicts | Soften fallback conditions or broaden `c1_achievement_guidance` Yes cases |
| Too broad | 10/10 Yes verdicts | Tighten adjacent-topic exclusion or narrow `substantive_definition` |
| Off-expected (narrow) | Observed Yes rate < 0.5 × `expected_yes_rate` AND `expected_yes_rate` ≥ 0.20 | Review measure phrasing; likely under-firing |
| Off-expected (broad) | Observed Yes rate > 2 × `expected_yes_rate` AND `expected_yes_rate` ≤ 0.80 | Review adjacent-topic exclusion |
| R3.3 heavy flipping | ≥40% of initial Yes verdicts flipped by R3.3 | `scoringGuidance` needs strengthening; quote-context requirement not being respected |
| Adjacent-topic contamination | ≥30% of Yes verdicts backed by quotes from adjacent-topic sections | C5 exclusion needs to include the specific adjacent topic explicitly |

### Iteration loop mechanics

Each fix flagged as "affecting measure X" triggers:
1. Return to Stage 3 for measure X only
2. LLM proposes revised draft with the specific fix
3. User approves or edits
4. Stage 5 re-validation on measure X
5. If ≥5 measures were revised, re-run Stage 6.5 test-drive on same 10 companies
6. If <5 measures revised, spot-check by scoring the revised measures on 3 companies

### Cost budget

A full 10-company test-drive on a 30-measure framework = ~300 measure evaluations. Rough estimate: 5-10 hours of chunked pipeline compute. This is the honest cost. Two ways to reduce if the user needs speed:
- **Progressive test-drive**: score first 5 companies, review flags, iterate, then score remaining 5. Catches egregious issues early.
- **Measure-subset**: score all 10 companies on a stratified subset of 15 measures (spanning categories), then run flagged measures on remaining companies.

Default is full 10 × all measures. User can opt for a faster variant.

---

## Part 6 — Export existing framework as build seed (NEW)

Allows an existing framework to seed a new build without carrying over its measures verbatim.

### Export mechanism

Command: `export_framework_as_seed(framework_path, output_path)`

Produces a filled Part 0 initial-input template with:
- **Section 1 (Topic)**: from `framework.topic` metadata field or reconstructed from `topicTerm` + `topicSynonyms`
- **Section 2 (Purpose)**: left blank (user-specific)
- **Section 3 (Entity scope)**: from framework's `entityType`, `sectorScope`, `universe`, `reportingPeriod`
- **Section 4 (Evidence anchors)**:
  - Standards: from framework's `anchorFrameworks`
  - Positive examples: aggregated `basePositiveExamples` and top 3 examples across measures
  - Negative examples: aggregated `baseNegativeExamples` and top 3 negative examples across measures
- **Section 5 (Sensitivity and priorities)**: from framework's `sensitivityPreference`

The export deliberately does NOT carry over:
- Individual measure titles, definitions, or drafts
- Adjacent topics (user should review these afresh; framework may have missed some)
- Sub-area structure (may need reconsidering for new build)
- Coverage whitelists or fallback conditions

Rationale: exporting the seed is meant to save the user typing the topic description and remembering the anchor frameworks. It's not meant to encourage copying an existing framework's decisions.

### Usage

```bash
python export_framework_as_seed.py fw11b_v2.json seed_ai_governance_v3.md
```

User edits the seed, provides it as the initial-input template, and starts a fresh build.

---

## Part 7 — Risks and honest concerns

### Risk 1 — LLM compliance with topic-anchoring rule (C4) may be mechanical

**Assessment**: The Stage 5 validator can check that the topic term appears, but not whether it appears meaningfully. Mitigation: Stage 5 adds a second-pass LLM review that samples 5 measures and rates whether the topic anchoring is meaningful (rubric-based). If <80% pass, framework returns to Stage 3 with specific feedback.

### Risk 2 — Robustness gate may terminate too early or loop forever

**Assessment**: The 10-item checklist is concrete but the LLM's interpretation of "resolved" is fuzzy. Mitigation: the LLM must present checklist state to the user after every turn; the user has the final say on whether to proceed. If the LLM has looped ≥5 turns without new information, it must ask the user "we seem stuck — should I proceed with best-guess drafts?"

### Risk 3 — Test-drive sample is unrepresentative

**Assessment**: If the 10-company sample lacks disclosure on the topic, we learn nothing. Mitigation: sample composition rules require ≥3 known-good disclosers based on Stage 1 research. If Stage 1 doesn't identify known disclosers (rare, e.g. very new topic), test-drive is skipped and framework is flagged `test_drive_skipped: true` with rationale.

### Risk 4 — Losing truth baseline means we can't compare to prior work

**Acknowledged**: rebuilding fw3, fw8, fw11b from scratch produces frameworks with different measure IDs. We can't directly compare F1 to previous ablation results. Mitigation: the test-drive itself becomes the quality signal. Frameworks that pass test-drive with acceptable flag rates are treated as validated. If future comparison to old baselines is needed, a partial truth-relabelling exercise (5 companies × new measures) can be done separately.

### Risk 5 — LLM pushback may be too aggressive and annoy the user

**Assessment**: The design has the LLM push back both during intake (research-grounded) and after test-drive (evidence-grounded). If the user finds this annoying, we've calibrated wrong. Mitigation: track pushback rejection rate; if the user rejects >70% of pushbacks in a session, the LLM asks "am I raising too many concerns? Should I hold back?" but records this as a session-level warning. Default is assertive; the user must explicitly ask for less if they want less.

### Risk 6 — The revised builder is substantially more complex than v1

**Acknowledged**: eight stages, per-measure interaction, robustness gate, test-drive, iteration loop. This is roughly 2× the complexity of the current builder. The complexity is justified by the quality improvements but should be recognised as a maintenance cost.

### Risk 7 — Cost of test-drive on every new framework

**Acknowledged**: 5–10 hours of pipeline compute per framework build. For high-frequency framework creation, this is a real constraint. Mitigation: progressive test-drive variant reduces to ~2 hours. Alternatively, mandate test-drive only for `production_ready: true` frameworks, and allow `draft` frameworks to skip.

---

## Part 8 — Files this design would touch

- `/home/user/workspace/skills/user/topic-assessment-framework-builder/SKILL.md` — replace with revised builder flow (Parts 1–7 above)
- `/home/user/workspace/skills/user/topic-assessment-framework-builder/references/output-schema.md` — replace with new schema (Part 4)
- `/home/user/workspace/skills/user/topic-assessment-framework-builder/references/initial-input-template.md` — new file with Part 0 template
- `/home/user/workspace/skills/user/topic-assessment-framework-builder/scripts/export_framework_as_seed.py` — new script (Part 6)
- `/home/user/workspace/skills/user/topic-assessment-framework-builder/references/robustness-checklist.md` — new file with 10-item checklist
- `/home/user/workspace/skills/user/topic-assessment-framework-builder/references/test-drive-flag-rules.md` — new file with Part 5 flag thresholds
- `/home/user/workspace/companyiq-runs/generic_framework_transformer.py` — deprecated; kept in repo as historical artefact for reference
- `/home/user/workspace/companyiq-runs/sprint3_pipeline.py` — no changes required (softened R3.3 already the default)

---

## End of design v2

Changes vs v1 summarised for the record:
- Migration path dropped; rebuild-from-scratch only
- Part 0 initial-input template added
- Part 1 intake conversation restructured: LLM-proposes-long-lists, clustered clarifications during Stage 3, robustness gate, TCFD default with alternatives, in-conversation pushback
- C1 broadened to permissive achievement-implies-commitment interpretation with per-measure guidance
- C7 extended with per-measure coverage whitelist
- Sensitivity lever concretely defined
- Part 5 test-drive stage (10 companies) added with flag rules
- Part 6 export-as-seed capability added
- LLM pushback formalised at two points: after intake based on research, after test-drive based on evidence
- Framework metadata extended with pushback record and test-drive results
