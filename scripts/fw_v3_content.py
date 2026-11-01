#!/usr/bin/env python3
"""fw_v3_content.py — authored v3 content for the NEW framework
"Physical Climate Resilience and Business Continuity" (supersedes framework 20,
"Physical Climate Risk Management"), per the developer specification
/home/ubuntu/Uploads/Developer_specification_—_Physical_Climate_Resilie.md.

DATA ONLY (no DB writes). scripts/fw-v3-apply.py imports MEASURES,
FRAMEWORK_CONFIG, PILLARS, STRUCTURED, OLD_TO_NEW, CHANGELOG_ENTRY and inserts a
NEW inactive framework row (workspace_id=3) + its 36 measures.

ENGINE CONTEXT (read the brief): the production scorer is BINARY (Yes/No; no
partial). It has NO dedicated columns for scopeTrack / attributionRequirement /
applicabilityRule / decisionPredicates / coverageRule / crossMeasureExclusions /
claimType / criticalGate / dimension weights. Per the spec's §"Add machine-
readable decision fields" compatibility clause, those class-B decision fields are
encoded TWO ways:
  (1) IN TEXT — every measure's substantive_definition OPENS with the track +
      attribution rule + applicability rule + the atomic decision predicates in
      prose, and scoring_guidance restates the Yes-gate and predicates, so the
      binary scorer enforces them via the prompt; and
  (2) STRUCTURED — the full machine-readable objects are preserved per measure in
      the STRUCTURED dict below and emitted into the EXPORT ARTIFACT JSON only
      (never written as new DB columns), ready for when the schema evolves.

What is DEFERRED (class B — NOT built here; see CHANGELOG_ENTRY['deferred']):
the weighted multi-dimension scoring engine, CoreGate computation, machine
applicability gating, predicate evaluation, dashboard weight/assumption controls,
the static validator, the fixture harness and calibration re-scoring. Those touch
the SHARED live analyzer (a large framework-21 batch is running) and the spec's
own gate keeps productionReady=false until validated.
"""

# ── Pillar (sub-area) structure — six resilience pillars G/U/A/P/R/L ──────────
PILLARS = {
    "type": "custom",
    "rationale": (
        "Recast from the five 'Physical Climate Risk Management' pillars into six "
        "resilience-and-continuity pillars that follow how a company understands, reduces, "
        "withstands, responds to and learns from physical-climate disruption and its cascading "
        "effects. The design follows IFRS S2's definition of climate resilience as strategic and "
        "operational capacity, and ISO 22301's managed business-continuity system, so that a "
        "mature, hazard-neutral continuity/recovery capability can be credited on an "
        "operational-resilience track without being mistaken for physical-climate management."
    ),
    "categories": [
        {"number": 1, "letter": "G", "name": "Govern and decide",
         "question": "Is physical-climate resilience governed, owned and embedded in decisions?"},
        {"number": 2, "letter": "U", "name": "Understand exposure, criticality and dependencies",
         "question": "Does the company know what is exposed, what is critical and what it depends on?"},
        {"number": 3, "letter": "A", "name": "Reduce vulnerability and adapt the business",
         "question": "Is it reducing exposure and adapting its assets, operations and value chain?"},
        {"number": 4, "letter": "P", "name": "Maintain critical operations",
         "question": "Can it keep critical operations running and recover them?"},
        {"number": 5, "letter": "R", "name": "Respond and recover",
         "question": "When disruption occurs, how did it perform?"},
        {"number": 6, "letter": "L", "name": "Measure, learn and improve",
         "question": "Does it monitor, learn and keep the programme current?"},
    ],
}

# ── Dimension weights & critical-measure set (EXPORT ARTIFACT ONLY — class B) ──
# These are NOT applied by the binary engine; preserved for the future scoring model.
DIMENSION_WEIGHTS = {"W_physical": 0.50, "W_operational": 0.30, "W_performance": 0.20}
CRITICAL_MEASURE_SET = ["U1", "U2", "A1", "P4"]  # criticalMeasureSet (CoreGate — deferred)

# track -> attributionRequirement map (spec §1)
_ATTR = {
    "physical_climate": "explicit_physical_climate",
    "operational_resilience": "named_disruption_and_control",
    "performance": "event_or_exercise",
}

# ── Migration of every original (v2/27) measure -> v3 destination ─────────────
# kind: becomes | splits-into | merges-into | absorbed | new
OLD_TO_NEW = [
    ("A1-board-oversight", "G1", "becomes",
     "Board oversight; broaden to physical-climate resilience but retain an explicit physical-risk link as the Yes requirement."),
    ("A2-exec-accountability-incentives", "G2 + G3", "splits-into",
     "Executive accountability (G2, operational_resilience track, no pay linkage required) splits from incentive linkage (G3, a distinct differentiator)."),
    ("A3-policy-framework", "G5 + A3", "splits-into",
     "Do not score policy existence alone: embedded decision controls (G5) split from technical design/maintenance standards (A3)."),
    ("B1-hazard-coverage", "U1", "becomes",
     "Replace the universal >=5-of-8 hazard-breadth rule with materiality-driven hazard selection and company-specific findings."),
    ("B2-scenario-horizons", "U3", "becomes",
     "Retain long-horizon/high-warming analysis for long-lived assets; add an equally rigorous severe-physical-disruption stress route for asset-light businesses."),
    ("B3-asset-screening-coverage", "U2", "becomes",
     "Retain explicit coverage; allow business-relevant denominators and implement a structured coverageRule (no 'all operations' inference)."),
    ("B4-vulnerability-methodology", "U4", "becomes",
     "Broaden beyond damage functions to business-consequence/financial-impact modelling; absorbs the forward-looking part of B6. Still reject exposure-only claims."),
    ("B5-valuechain-infra-exposure", "U6 + U7", "splits-into",
     "Supplier/logistics dependency mapping (U6) and shared infrastructure/utility/IT dependency mapping (U7) are distinct assessment objects."),
    ("B6-financial-impact", "U4 + R2", "splits-into",
     "Forward-looking physical-risk financial modelling -> U4; historic operational/financial impact measurement -> R2."),
    ("B7-gross-residual-exposure", "L1", "absorbed",
     "Gross-vs-residual exposed value becomes a strong supporting metric inside L1, not a standalone disclosure-format measure."),
    ("B8-erm-integration-prioritisation", "G4", "becomes",
     "ERM integration; add risk appetite/tolerance or escalation threshold as the decision-control signal."),
    ("C1-adaptation-strategy", "A1", "becomes",
     "Expand from capex/site linkage to a plan with exposure linkage, ownership and dated milestones (asset-light routes allowed)."),
    ("C2-resilience-capital", "A6", "becomes",
     "Allow capex, opex, staffing, reserves and contingency funding; remove the mandatory share-of-total-capex gate."),
    ("C3-implemented-mitigation", "A2", "becomes",
     "Retain completion + physical-risk-mechanism linkage; broaden covered population beyond sites with a deterministic coverage result."),
    ("C4-insurability-strategy", "A10", "becomes",
     "Preserve the strategic bar; add business interruption, exclusions, deductibles and liquidity/residual-loss elements."),
    ("C5-siting-ma-design-standards", "A3 + A4", "splits-into",
     "Technical future-climate design standards (A3) split from pre-commitment investment/siting due diligence (A4). Decision-embedding part -> G5."),
    ("C6-asset-portfolio-decisions", "A5", "becomes",
     "Purpose unchanged but tightened at the boundary: asset hardening is A2; ownership/use/location/life/portfolio changes are A5."),
    ("C7-supplychain-resilience-actions", "A8", "becomes",
     "Permit non-climate wording where it protects a named critical dependency; reject generic supplier-engagement language."),
    ("C8-water-security", "A11", "merges-into",
     "Merges with C10 into A11 (chronic-hazard operational continuity), conditional on material water/heat/smoke/workforce exposure."),
    ("C9-adaptation-investment-appraisal", "A7", "becomes",
     "Keep a defined appraisal requirement; allow business benefits beyond avoided loss."),
    ("C10-workforce-heat-stress", "A11", "merges-into",
     "Merges with C8 into A11; extends to chronic-condition effects on workforce safety and productive capacity."),
    ("D1-business-continuity-tested", "P1 + P2 + P4 + P6", "splits-into",
     "A continuity system (P1), recovery objectives (P2), climate-scenario integration (P4) and exercised performance (P6) are scored independently."),
    ("D2-early-warning-triggers", "P5", "becomes",
     "Retain trigger-to-action requirement; broaden permitted hazard/dependency trigger classes."),
    ("D3-recovery-performance", "R1", "becomes",
     "Require recovery against an objective/service threshold rather than bare elapsed time; if_event_occurred applicability."),
    ("E1-incident-loss-metrics", "R2", "becomes",
     "Retain quantification; remove the mandatory improving-trend condition."),
    ("E2-targets-progress", "L1", "becomes",
     "Broaden targets to include risk tolerances and residual-exposure monitoring; require a baseline and current progress/status."),
    ("E3-post-event-learning", "L2", "becomes",
     "Include exercises and near misses so companies are not penalised for an absence of recent disasters."),
]

NEW_MEASURE_IDS = ["G6", "U5", "U6", "U7", "U8", "A9", "P3", "L3"]

_CATNAME = {c["number"]: c["name"] for c in PILLARS["categories"]}
_CATLETTER = {c["number"]: c["letter"] for c in PILLARS["categories"]}

_PRIOR = ("UNCALIBRATED PRIOR. This expected_yes_rate is an authoring judgement, not a "
          "measured rate: the measure was re-scoped for v3, so no legacy prior is comparable. "
          "Per the spec, calibration (re-scoring a reviewed corpus) is DEFERRED; this value "
          "must be replaced by the observed distribution before productionReady is set true.")


def M(mid, cat_num, title, target, definition, substantive, scoring, fallback,
      wce, wdnce, pos, neg, kw, vehicles, c1, eyr, struct, coverage_whitelist=None):
    """Build one measure dict. `struct` is the machine-readable object set, carried
    under '_struct' for the EXPORT ARTIFACT ONLY (apply script never writes it)."""
    return {
        "measure_id": mid,
        "category": _CATNAME[cat_num],           # pillar NAME (DB/dashboard display convention; letter is in sub_area_structure + id prefix)
        "category_number": cat_num,
        "title": title,
        "primary_assessment_target": target,
        "definition": definition,
        "substantive_definition": substantive,
        "scoring_guidance": scoring,
        "fallback_yes_criterion": fallback,
        "what_constitutes_evidence": wce,
        "what_does_not_constitute_evidence": wdnce,
        "positive_examples": pos,
        "negative_examples": neg,
        "evidence_keywords": kw,
        "disclosure_vehicles": vehicles,
        "coverage_whitelist": coverage_whitelist or [],
        "c1_achievement_guidance": c1,
        "required_source_types": None,            # vehicle-agnostic (spec §6): verdict must not depend on doc type
        "min_quote_context_chars": 240,
        "expected_yes_rate": eyr,
        "expected_yes_rate_justification": _PRIOR,
        "r3_1_exception_metrics": False,
        "r3_1_exception_coverage": False,
        "flagged_non_discriminating": False,
        "_struct": struct,
    }


def S(track, claim, mode, requires_any, applic_rationale, predicates,
      coverage=None, exclusions=None):
    """Assemble a machine-readable struct object (export artifact only)."""
    mid_critical = None  # set later
    return {
        "scopeTrack": track,
        "attributionRequirement": _ATTR[track],
        "claimType": claim,
        "dimension": track,
        "applicabilityRule": {
            "mode": mode,
            "requiresAny": requires_any,
            "rationale": applic_rationale,
        },
        "decisionPredicates": predicates,
        "coverageRule": coverage,
        "crossMeasureExclusions": exclusions or [],
        "criticalGate": False,   # overwritten for criticalMeasureSet after MEASURES is built
    }



MEASURES = [

# ═══════════════════════ PILLAR G — Govern and decide ═══════════════════════
M("G1", 1,
  "Board oversight of physical climate resilience is specific and active",
  "Board or named board committee's physical-climate-resilience oversight",
  "Whether the board, or a named board committee, actively oversees physical climate resilience with an explicit physical-risk link and an evidenced depth signal. Replaces A1-board-oversight.",
  ("TRACK physical_climate (requires explicit physical-climate / weather-hazard / physical-impact attribution). "
   "APPLICABILITY always for a public company (depth commensurate with exposure). "
   "ATOMIC PREDICATES, all required for Yes: (1) names the board or a board committee; (2) explicitly links that body's remit to "
   "physical climate risk, climate resilience or named physical hazards (not generic 'climate-related risk' or ESG); and "
   "(3) shows ONE depth signal — a review cadence, a named information input, or a decision/change influenced by the oversight. "
   "Boundary: board-level oversight only here (executive ownership is G2; decision-embedding process is G5; independent review is G6). "
   "DEFINITION: a bounded disclosure must name the oversight body, tie it to physical climate risk, and evidence that the oversight "
   "is live through cadence, inputs or a decision — not a one-line governance claim."),
  ("Binary. Score Yes only when all three predicates are quoted verbatim within the context window: a named board/committee, an "
   "explicit physical-climate-resilience remit, and one depth signal (cadence OR input OR decision). Generic 'the Board oversees "
   "climate-related risks', a committee name with no remit, or continuity oversight with no physical-risk connection is No. Do not "
   "infer depth from the existence of a committee alone."),
  ("1. An annual report or governance statement names the board/committee, states its physical-climate-resilience remit, and gives a "
   "review cadence (e.g. 'reviewed quarterly').\n"
   "2. A proxy/governance disclosure names the committee and describes a specific physical-risk information input it receives (e.g. a "
   "physical-hazard exposure dashboard or scenario briefing).\n"
   "3. A board minute, CDP governance answer or risk-report section records a board decision or change driven by physical-climate "
   "oversight (e.g. approving a resilience plan or deferring a site expansion on flood-risk grounds)."),
  "A named board/committee with an explicit physical-climate remit AND a cadence, a named information input, or a documented decision driven by that oversight.",
  "Generic 'the Board oversees climate-related risks' or ESG oversight with no physical specificity; a committee name with no remit; executive/management accountability with no board role (that is G2); a decision-embedding process (G5); internal audit/assurance review (G6); stakeholder-engagement statements.",
  ["The Risk Committee is responsible for physical climate risk and reviews a physical-hazard exposure dashboard at each quarterly meeting.",
   "In 2025 the Board, on its Sustainability Committee's recommendation, deferred the Gulf Coast terminal expansion after a physical flood-risk review.",
   "The Audit & Risk Committee's charter names oversight of climate-related physical hazards and receives a semi-annual resilience briefing from the Chief Risk Officer.",
   "The Board reviewed the physical-climate scenario results in March and directed management to prioritise flood defences at the two highest-exposure plants."],
  ["The Board maintains oversight of climate-related risks and opportunities as part of its ESG remit.",
   "Our Sustainability Committee oversees the Group's net-zero transition and decarbonisation roadmap.",
   "The Board is committed to building a resilient and sustainable business for all stakeholders.",
   "Management holds primary responsibility for climate risk, reporting to the executive committee."],
  ["board committee", "physical climate risk", "oversight remit", "review cadence", "charter", "exposure briefing", "board decision", "resilience"],
  ["Annual Report", "Proxy / governance statement", "Corporate governance report", "CDP response", "Board/committee charter", "Risk report"],
  {"yes_cases": "A named board/committee with an explicit physical-climate-resilience remit and at least one live-oversight signal (cadence, specific input, or a decision it drove).",
   "no_cases": "Generic climate/ESG oversight, an unremitted committee name, or management-only accountability with no board link.",
   "distinguishing_test": "Does the quote name the body, tie it to physical climate risk, AND show the oversight actually operating (not just existing)?"},
  0.28,
  S("physical_climate", "governance", "always", ["public_company"],
    "Board accountability for material physical-climate resilience is expected of any public company; depth of evidence scales with exposure.",
    [{"id": "physical_attribution", "requires": "remit explicitly tied to physical climate risk / resilience / named hazards"},
     {"id": "named_body", "requires": "board or named board committee identified"},
     {"id": "depth_signal", "requires": "a review cadence, a named information input, or a decision/change driven by the oversight"}],
    exclusions=["G5 (decision-embedding process, not board oversight)", "G6 (independent/assurance review of control effectiveness)", "G2 (executive, not board, accountability)"])),

M("G2", 1,
  "Executive accountability and escalation for resilience are disclosed",
  "Executive ownership of resilience / continuity capability",
  "Whether an accountable executive or management role owns resilience/continuity, with a defined responsibility and an escalation/reporting/resource mechanism. Replaces part of A2-exec-accountability-incentives (the accountability half; pay linkage is G3).",
  ("TRACK operational_resilience (hazard-neutral: a named critical activity/dependency/disruption type plus a specific control/capability; "
   "climate wording is NOT required). APPLICABILITY always. "
   "ATOMIC PREDICATES, all required: (1) names an accountable executive or management role; (2) defines that role's responsibility for "
   "resilience, continuity, emergency response or recovery; and (3) provides a reporting, escalation or resource-accountability mechanism. "
   "Boundary: executive ownership here; board oversight is G1; incentive/pay linkage is G3. "
   "DEFINITION: a disclosure must put a named role in charge of the resilience/continuity capability and show how issues escalate or how "
   "the role is resourced/held to account — not merely list a C-suite title."),
  ("Binary. Yes requires a named accountable executive/role, a specific resilience/continuity/recovery responsibility, and an escalation/"
   "reporting/resource mechanism, all quote-verifiable. Naming a CSO/CRO/COO with no specific resilience mandate, or a generic executive "
   "committee, is No. Pay linkage is neither required nor sufficient here (that is G3)."),
  ("1. An annual report or policy names the executive/role accountable for business continuity or resilience and states a reporting line "
   "into senior management or the board.\n"
   "2. A continuity/emergency-response policy assigns a named role responsibility for recovery and defines an escalation path for a major "
   "disruption.\n"
   "3. A governance disclosure describes a management resilience committee chaired by a named executive with authority over resources or "
   "corrective actions."),
  "A named executive/management role with a defined resilience/continuity/recovery responsibility and an escalation, reporting or resource-accountability mechanism.",
  "A C-suite title with no specific resilience mandate; a generic 'the executive committee manages risk'; board-level oversight (G1); an incentive/remuneration link with no defined responsibility (G3); a policy with no named owner.",
  ["The Chief Operating Officer is accountable for the Group's operational resilience programme and reports quarterly to the Board Risk Committee.",
   "Our Business Continuity Policy assigns the Head of Resilience responsibility for recovery and sets a defined escalation path to the Crisis Management Team for Tier-1 incidents.",
   "A management Resilience Steering Group, chaired by the CRO, approves continuity resources and tracks remediation of exercise findings.",
   "Divisional managing directors own continuity for their business units and escalate unresolved disruptions to the Group Operations Director within 24 hours."],
  ["We have a strong risk-management culture led by our executive team.",
   "The CEO is ultimately responsible for all risks facing the Group.",
   "Our Chief Sustainability Officer leads our climate and ESG agenda.",
   "Resilience is everyone's responsibility across the organisation."],
  ["accountable executive", "business continuity owner", "escalation path", "reporting line", "resilience programme", "crisis management team", "management responsibility"],
  ["Annual Report", "Business continuity / resilience policy", "Corporate governance report", "Earnings call transcript", "Risk report"],
  {"yes_cases": "A specific role owns resilience/continuity with a defined responsibility and an escalation or resource mechanism.",
   "no_cases": "A bare C-suite title, a generic committee, or 'everyone is responsible'.",
   "distinguishing_test": "Is there a named role, a specific continuity/recovery responsibility, AND a mechanism to escalate or resource it?"},
  0.33,
  S("operational_resilience", "governance", "always", ["public_company"],
    "Executive ownership of continuity/resilience is expected of any operating company regardless of climate exposure.",
    [{"id": "named_role", "requires": "accountable executive or management role named"},
     {"id": "responsibility", "requires": "defined responsibility for resilience/continuity/emergency response/recovery"},
     {"id": "mechanism", "requires": "a reporting, escalation or resource-accountability mechanism"}],
    exclusions=["G1 (board oversight)", "G3 (incentive/pay linkage)"])),

M("G3", 1,
  "Executive incentives link to a defined physical-resilience outcome",
  "Incentive design for physical-climate resilience",
  "Whether a named executive remuneration or performance arrangement includes a defined resilience outcome/metric with a physical-climate link and a stated weighting or assessment mechanism. Replaces part of A2-exec-accountability-incentives (incentive half). This is a differentiator, not a gateway to crediting G2.",
  ("TRACK physical_climate (the incentivised outcome must carry a physical-climate / climate-adaptation / physical-hazard link). "
   "APPLICABILITY always (a company may demonstrate good accountability under G2 without disclosing pay linkage, so a No here is not a "
   "governance failure). ATOMIC PREDICATES, all required: (1) a named executive remuneration/performance arrangement; (2) a defined "
   "resilience outcome or metric within it; (3) a physical-climate / adaptation / physical-hazard link to that outcome; and (4) a stated "
   "weighting, target or assessment mechanism. DEFINITION: generic ESG pay or net-zero-only incentives do not qualify; the incentive must "
   "reward a physical-resilience or physical-adaptation result and show how it is weighted/assessed."),
  ("Binary. Yes requires a named incentive arrangement, a defined resilience metric/outcome, an explicit physical-climate link, and a stated "
   "weighting/assessment mechanism. Generic ESG pay, net-zero/emissions-only incentives, or accountability with no incentive link is No. "
   "Do NOT credit G2 merely because G3 is met, and do not require G3 for G2."),
  ("1. A remuneration report names a physical-resilience or adaptation metric in the executive scorecard with a stated percentage weighting.\n"
   "2. A proxy statement ties a portion of the LTIP/annual bonus to a defined resilience target (e.g. completion of a site-hardening "
   "programme) with an assessment basis.\n"
   "3. A governance disclosure states that executive variable pay is assessed partly against physical-climate adaptation milestones and "
   "describes how performance is measured."),
  "A named remuneration/performance arrangement with a defined resilience metric, an explicit physical-climate link, and a stated weighting/target/assessment mechanism.",
  "Generic ESG or sustainability pay; net-zero or emissions-reduction incentives; a resilience 'consideration' with no metric or weighting; executive accountability with no incentive link (that is G2).",
  ["20% of the CEO's annual scorecard is tied to delivery of the climate-resilience capital programme, assessed against site-hardening milestones.",
   "The LTIP includes a physical-climate adaptation measure (weighting 10%) linked to flood-defence completion at the three highest-risk plants.",
   "Executive bonuses are assessed partly against a drought-resilience water-reduction target at our water-stressed operations, with a defined threshold and stretch level.",
   "The remuneration committee set a 15% weighting on business-interruption-days-avoided from the heat-resilience programme for operational executives."],
  ["Executive remuneration includes an ESG modifier covering our broad sustainability agenda.",
   "A portion of annual bonus is linked to progress on our net-zero emissions target.",
   "The board considers climate performance when determining executive pay.",
   "Our incentive plan rewards long-term value creation and responsible business."],
  ["remuneration", "incentive weighting", "executive scorecard", "resilience metric", "LTIP", "adaptation milestone", "variable pay", "performance condition"],
  ["Remuneration report", "Proxy / governance statement", "Annual Report", "CDP response"],
  {"yes_cases": "A named pay arrangement rewards a defined physical-resilience outcome with a stated weighting/assessment.",
   "no_cases": "Generic ESG pay, net-zero incentives, or no incentive link at all.",
   "distinguishing_test": "Is the incentivised metric specifically a physical-resilience/adaptation outcome with a disclosed weighting, not a general ESG/emissions modifier?"},
  0.08,
  S("physical_climate", "governance", "always", ["public_company"],
    "Incentive linkage is an advanced differentiator; always assessed but a No does not imply weak governance (G2 stands alone).",
    [{"id": "named_arrangement", "requires": "named executive remuneration/performance arrangement"},
     {"id": "resilience_metric", "requires": "a defined resilience outcome or metric within it"},
     {"id": "physical_attribution", "requires": "physical-climate / adaptation / physical-hazard link to the metric"},
     {"id": "weighting", "requires": "stated weighting, target or assessment mechanism"}],
    exclusions=["G2 (accountability without pay linkage — do not gate on G3)"])),

M("G4", 1,
  "ERM prioritises physical climate risk with risk appetite or escalation thresholds",
  "Physical-climate risk's treatment within ERM",
  "Whether physical climate risk or named physical hazards appear in ERM/risk reporting with a rating, materiality determination, risk appetite/tolerance or defined escalation threshold. Replaces B8-erm-integration-prioritisation.",
  ("TRACK physical_climate (physical hazard/impact attribution required). APPLICABILITY always for a public company. "
   "ATOMIC PREDICATES, all required: (1) physical climate risk or named physical hazards appear in the ERM/risk-management process or risk "
   "reporting; and (2) they are accompanied by a decision-control signal — a risk rating/score, a materiality determination, a risk "
   "appetite/tolerance statement, or a defined escalation threshold. Boundary: this is ERM prioritisation/appetite; board oversight is G1; "
   "embedding criteria into specific business decisions is G5. DEFINITION: climate merely listed as an 'emerging' or 'principal' risk with "
   "no ranking, threshold or action route does not qualify."),
  ("Binary. Yes requires physical climate risk inside ERM PLUS at least one of: a rating/score, a materiality determination, a risk "
   "appetite/tolerance, or an escalation threshold, quote-verifiable. Climate named as an emerging issue with no ranking/threshold/action "
   "route is No."),
  ("1. A principal-risks table rates physical climate risk (likelihood/impact or a heat-map position) and states the treatment or owner.\n"
   "2. A risk-management disclosure sets a risk appetite or tolerance statement that explicitly covers physical climate/weather risk.\n"
   "3. An ERM description defines an escalation threshold (e.g. a loss or exposure trigger) at which physical-climate risk is escalated to "
   "a risk committee."),
  "Physical climate risk present in ERM/risk reporting with a rating, materiality determination, appetite/tolerance, or escalation threshold.",
  "Climate listed as an emerging/principal risk with no rating, threshold or action route; a generic ERM framework with no physical-climate content (operational-resilience ERM alone belongs nowhere here); board oversight (G1); embedding into a specific decision type (G5).",
  ["Our principal-risks register rates physical climate risk as High/High and assigns it to the Group Risk Committee with a defined tolerance.",
   "The Board has set a risk appetite that limits uninsured physical-climate loss exposure to 2% of EBITDA, triggering escalation above that level.",
   "Physical climate hazards are scored in the enterprise risk heat map and breaching the amber threshold escalates to the Risk Committee.",
   "Flood and heat risks carry a defined materiality rating in our ERM and are prioritised ahead of lower-rated risks for mitigation funding."],
  ["Climate change is identified as an emerging risk in our risk universe.",
   "We operate a comprehensive enterprise risk management framework aligned with ISO 31000.",
   "Climate-related risks are considered as part of our principal risks and uncertainties.",
   "Our risk appetite reflects our commitment to responsible and sustainable growth."],
  ["enterprise risk management", "risk appetite", "risk tolerance", "escalation threshold", "principal risk rating", "materiality determination", "risk heat map", "physical climate risk"],
  ["Annual Report", "Risk report / principal risks", "Risk management disclosure", "CDP response", "10-K Item 1A"],
  {"yes_cases": "Physical climate risk is rated/prioritised in ERM or governed by an appetite/tolerance/escalation threshold.",
   "no_cases": "Climate named as an emerging risk with no ranking or threshold; a generic ERM framework.",
   "distinguishing_test": "Beyond listing climate as a risk, is there a rating, materiality call, appetite/tolerance, or escalation threshold attached to it?"},
  0.30,
  S("physical_climate", "decision_control", "always", ["public_company"],
    "ERM treatment of material risks is expected of any public company; physical-climate depth scales with exposure.",
    [{"id": "physical_in_erm", "requires": "physical climate risk/named hazards present in ERM or risk reporting"},
     {"id": "decision_signal", "requires": "a rating, materiality determination, risk appetite/tolerance, or escalation threshold"}],
    exclusions=["G1 (board oversight)", "G5 (embedding into a specific decision type)"])),

M("G5", 1,
  "Material physical-risk and resilience criteria are embedded in business decisions",
  "Decision-control process for capital allocation, projects, acquisitions, leases, outsourcing or material supplier selection",
  "Whether a policy, process or approval rule requires a physical-risk/resilience assessment before a stated decision type, with a described criterion, threshold or approval consequence. Replaces part of A3-policy-framework and part of C5-siting-ma-design-standards (the decision-embedding part).",
  ("TRACK physical_climate (the embedded criterion must concern physical risk/resilience). APPLICABILITY if_material — for companies that "
   "make material capital, project, acquisition, lease, outsourcing or supplier-selection decisions (most operating companies). "
   "ATOMIC PREDICATES, all required: (1) a reusable policy/process/approval rule (not a one-off); (2) it requires a physical-risk/resilience "
   "assessment BEFORE a stated decision type; and (3) it describes a criterion, threshold or approval consequence. Boundary: this is the "
   "decision GATE/process; the technical design standard applied is A3; pre-commitment due-diligence screening is A4; portfolio decisions "
   "are A5. DEFINITION: a generic commitment to 'consider climate in decisions', or a single past decision with no reusable process, is No."),
  ("Binary. Yes requires a reusable decision-control process that mandates physical-risk/resilience assessment before a named decision type "
   "and states a criterion/threshold/approval consequence, all quote-verifiable. A generic 'we factor climate into decisions' or a one-off "
   "decision is No. Do not double-count with A3/A4/A5 unless the quote independently contains this gate."),
  ("1. A capital-approval or investment policy requires a physical-risk assessment before project sign-off and states an approval consequence "
   "(e.g. escalation or rejection above a risk threshold).\n"
   "2. A procurement/outsourcing standard requires physical-resilience due diligence before selecting a critical supplier or site, with a "
   "defined criterion.\n"
   "3. An M&A/leasing policy mandates a physical-climate screening step in the approval workflow and specifies the threshold at which the "
   "decision is escalated."),
  "A reusable policy/process/approval rule requiring a physical-risk/resilience assessment before a stated decision type, with a criterion, threshold or approval consequence.",
  "A generic commitment to consider climate in decisions; a one-off decision with no reusable process; policy existence with no decision gate; the technical design standard itself (A3); pre-commitment site/asset screening (A4); portfolio relocation/retirement decisions (A5).",
  ["Our capital-approval framework requires a physical-climate risk assessment for any project above £10m; projects exceeding the risk threshold require Board Risk Committee approval.",
   "The procurement standard mandates a physical-resilience due-diligence check before onboarding any single-source critical supplier.",
   "Site-selection policy requires a flood- and heat-exposure assessment prior to lease commitment, and locations above the defined risk band are rejected or escalated.",
   "Our M&A playbook includes a mandatory physical-climate screening gate before completion, with findings fed into the valuation and approval decision."],
  ["We take climate change into account in our investment decisions.",
   "Sustainability is embedded across everything we do.",
   "The Group approved a new flood barrier at its Rotterdam site last year.",
   "Our capital allocation prioritises long-term value creation."],
  ["capital approval", "investment policy", "decision gate", "approval threshold", "due-diligence requirement", "procurement standard", "pre-commitment assessment", "physical risk screening"],
  ["Capital allocation / investment policy", "Procurement / outsourcing policy", "Annual Report", "Corporate governance report", "CDP response"],
  {"yes_cases": "A reusable approval process requires a physical-risk assessment before a named decision type and defines a criterion/threshold/consequence.",
   "no_cases": "A generic 'we consider climate', or a single past decision with no process.",
   "distinguishing_test": "Is there a repeatable decision rule with a physical-risk gate and a stated consequence, not just awareness or one example?"},
  0.16,
  S("physical_climate", "decision_control", "if_material", ["material_capital_decisions", "material_projects", "acquisitions_leases_outsourcing", "material_supplier_selection"],
    "A decision-embedding control is relevant where the company makes material capital, project, acquisition, lease, outsourcing or supplier decisions.",
    [{"id": "reusable_process", "requires": "a policy/process/approval rule, not a one-off decision"},
     {"id": "pre_decision_assessment", "requires": "requires a physical-risk/resilience assessment before a stated decision type"},
     {"id": "consequence", "requires": "a described criterion, threshold or approval consequence"}],
    exclusions=["A3 (technical design standard applied)", "A4 (pre-commitment screening due diligence)", "A5 (portfolio decisions)", "G1 (board oversight)"])),

M("G6", 1,
  "Resilience-control effectiveness receives independent review or formal management review",
  "Challenge and review of resilience controls",
  "Whether internal audit, assurance, board review or a formal management review evaluates resilience/continuity control effectiveness, identifies findings, or records a review cycle and corrective actions. New measure (no single legacy equivalent).",
  ("TRACK physical_climate (the reviewed controls are the physical-climate-resilience/continuity controls). APPLICABILITY always. "
   "ATOMIC PREDICATES, all required: (1) an independent or formal review body/process — internal audit, external assurance, board review or "
   "a formal management review; (2) it evaluates the EFFECTIVENESS of resilience/continuity controls (not merely their existence); and "
   "(3) it identifies findings, or records a review cycle AND corrective actions. Boundary: this is challenge/assurance of control "
   "effectiveness; board oversight of the risk is G1; the ERM rating is G4. DEFINITION: self-certification, or a policy 'approved' with no "
   "evidence of evaluation, is No."),
  ("Binary. Yes requires an independent/formal review that tests resilience-control effectiveness and produces findings or a review-cycle-"
   "plus-corrective-actions record, quote-verifiable. Self-certification or unevaluated policy approval is No."),
  ("1. An internal-audit or assurance report evaluates the continuity/resilience control framework and lists findings and remediation actions.\n"
   "2. A governance disclosure records a formal management review of resilience-control effectiveness on a stated cycle, with corrective "
   "actions tracked to closure.\n"
   "3. A board/committee record documents an independent review of the resilience programme's effectiveness and the resulting improvement "
   "actions."),
  "An independent or formal review (internal audit, assurance, board or formal management review) of resilience-control effectiveness that identifies findings or records a review cycle with corrective actions.",
  "Self-certification; a policy 'reviewed and approved' with no evaluation of effectiveness; board oversight of the risk itself (G1); the ERM risk rating (G4); an exercise/test of continuity arrangements (that is P6).",
  ["Internal Audit completed an assurance review of the Group's business-continuity controls in 2025, raising four findings now tracked to closure.",
   "The resilience programme is subject to a formal annual management review that assesses control effectiveness and assigns corrective actions.",
   "An independent third party assured our continuity management system against ISO 22301 and identified two non-conformities with agreed remediation.",
   "The Board Risk Committee reviewed the effectiveness of physical-climate resilience controls and directed improvements to the escalation process."],
  ["Our business-continuity policy is reviewed and approved annually by management.",
   "We maintain robust internal controls across the organisation.",
   "The Board is satisfied that the Group's risk-management arrangements are effective.",
   "We are committed to continuous improvement in our resilience capabilities."],
  ["internal audit", "assurance review", "control effectiveness", "management review", "findings", "corrective actions", "non-conformity", "review cycle"],
  ["Internal audit / assurance report", "Annual Report", "Corporate governance report", "Business continuity / resilience policy", "CDP response"],
  {"yes_cases": "An independent/formal review tests resilience-control effectiveness and yields findings or a review cycle plus corrective actions.",
   "no_cases": "Self-certification, or policy approval with no evaluation of whether controls work.",
   "distinguishing_test": "Is the effectiveness of the controls actually evaluated (with findings/actions), rather than the policy merely being approved?"},
  0.14,
  S("physical_climate", "governance", "always", ["public_company"],
    "Independent/formal challenge of resilience controls is relevant to any company operating such controls.",
    [{"id": "review_body", "requires": "internal audit, assurance, board review or formal management review"},
     {"id": "effectiveness", "requires": "evaluates effectiveness of resilience/continuity controls, not mere existence"},
     {"id": "findings_or_cycle", "requires": "identifies findings, or records a review cycle and corrective actions"}],
    exclusions=["G1 (board oversight of the risk)", "G4 (ERM rating)", "P6 (exercising/testing arrangements)"])),
]



# ════════ PILLAR U — Understand exposure, criticality and dependencies ════════
MEASURES += [
M("U1", 2,
  "Material physical hazards are assessed with company-specific findings",
  "Material-hazard assessment",
  "Whether the company identifies the physical hazards relevant to its footprint/business model and discloses a company-specific result for each relevant hazard class assessed. Replaces B1-hazard-coverage. CRITICAL-GATE measure (criticalMeasureSet).",
  ("TRACK physical_climate (explicit hazard/physical-impact attribution required). APPLICABILITY always for a public company; evidence depth "
   "commensurate with exposure. CRITICAL GATE: U1 is one of the four criticalMeasureSet measures [U1, U2, A1, P4] — in the deferred weighted "
   "model a failed critical measure caps the rating (CoreGate); encoded here so a reviewer treats a U1 failure as materially serious. "
   "ATOMIC PREDICATES, all required: (1) identifies physical hazards RELEVANT to the company's footprint/business model (materiality-driven, "
   "not a fixed breadth count); and (2) discloses, for each relevant hazard class assessed, a company-specific finding — an affected location, "
   "an operational implication, or a materiality rationale. CHANGE FROM LEGACY: the universal '>=5 of 8 hazards' rule is REMOVED; a "
   "geographically concentrated company with a genuinely narrow risk profile must not be penalised. DEFINITION: require relevance plus "
   "company-specific results, not generic hazard breadth."),
  ("Binary. Yes requires materially-relevant hazards identified AND at least one company-specific finding per relevant hazard class (location, "
   "operational implication, or materiality rationale). Do NOT require a fixed number of hazards. A generic list of climate hazards with no "
   "company-specific result is No. Treat a U1 No as a critical-gate failure in narrative."),
  ("1. A TCFD/CDP or annual-report disclosure lists the hazards material to the company and states, for each, the affected sites/regions or "
   "the operational consequence identified.\n"
   "2. A risk disclosure explains why a given hazard is (or is not) material to the business model and gives the company-specific finding "
   "that supports it.\n"
   "3. A sustainability report presents a hazard-by-hazard assessment result for the company's own operations (not a generic hazard primer)."),
  "Materially-relevant physical hazards identified with company-specific findings (affected locations, operational implications, or materiality rationale) for each relevant hazard class.",
  "A generic catalogue of climate hazards with no company-specific result; 'climate change may affect our operations'; a hazard map purchased with no interpretation; exposure screening coverage (that is U2); vulnerability/consequence method (that is U4).",
  ["We assessed flood, extreme-heat and water-stress exposure; 12 of our 40 sites lie in high flood-risk zones, chiefly in South-East Asia.",
   "Wildfire is our dominant physical hazard: three Californian facilities face elevated risk, while our northern-European sites are immaterial for wildfire.",
   "As a single-campus software firm, our material physical hazard is heat/grid stress at our Phoenix data centre; coastal and wildfire hazards are not material to us.",
   "Drought and river-flooding were each assessed; drought materially affects two water-intensive plants in Spain, with quantified production-at-risk."],
  ["Climate change presents a range of physical risks to businesses globally.",
   "We recognise that extreme weather events are becoming more frequent and severe.",
   "The Group is exposed to acute and chronic climate hazards across its value chain.",
   "We purchased a climate hazard dataset covering all major perils."],
  ["physical hazard", "hazard relevance", "company-specific finding", "affected location", "materiality rationale", "flood", "extreme heat", "wildfire", "drought", "water stress"],
  ["CDP response", "Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "10-K Item 1A"],
  {"yes_cases": "Relevant hazards identified with company-specific findings per hazard class (locations/consequences/materiality).",
   "no_cases": "Generic hazard lists, bought hazard maps, or 'climate may affect us' with no company result.",
   "distinguishing_test": "Does the company state its OWN findings for each relevant hazard, rather than describing hazards in general?"},
  0.45,
  S("physical_climate", "assessment", "always", ["public_company"],
    "Material-hazard assessment is expected of any public company; narrow-profile firms assess fewer hazards without penalty.",
    [{"id": "relevance", "requires": "physical hazards relevant to footprint/business model identified (materiality-driven)"},
     {"id": "company_specific_finding", "requires": "company-specific result per relevant hazard class: location, operational implication, or materiality rationale"}],
    exclusions=["U2 (exposure screening coverage)", "U4 (vulnerability/consequence method)"])),

M("U2", 2,
  "Material exposure screening has a stated, appropriate coverage denominator",
  "Coverage of physical-climate exposure screening",
  "Whether the disclosure identifies the screened population, gives a stated coverage figure or complete enumerated population, and covers at least the applicable threshold of material exposure. Replaces B3-asset-screening-coverage. CRITICAL-GATE measure.",
  ("TRACK physical_climate (physical-exposure attribution required). APPLICABILITY always. CRITICAL GATE (criticalMeasureSet [U1,U2,A1,P4]). "
   "ATOMIC PREDICATES, all required: (1) physical-climate attribution of the screening; (2) a defined population of material exposure "
   "(sites, assets, revenue, production capacity, insured value or equivalent); (3) a stated coverage numerator/denominator OR a complete "
   "enumerated population; and (4) coverage meets the applicable threshold policy (default 0.50, materiality-adjusted). CHANGE FROM LEGACY: "
   "coverage may NOT be inferred from 'all operations'; it needs a structured coverage rule (see coverageRule). DEFINITION: a quantified or "
   "fully-enumerated coverage of a defined material population, on a business-relevant denominator — not a vague 'company-wide' claim."),
  ("Binary. Yes requires a defined population, a STATED coverage figure (numerator/denominator) or a complete enumerated population, and "
   "coverage at/above the applicable threshold, all quote-verifiable. 'Across our operations', 'company-wide' or 'all sites' with no figure "
   "or enumeration is No. Accepted denominators include sites, facilities, asset value, revenue and production capacity."),
  ("1. A disclosure states a coverage ratio over a defined population (e.g. '310 of 356 facilities screened for physical climate risk').\n"
   "2. A disclosure gives a percentage on a business-relevant denominator (e.g. '82% of asset value assessed for flood and heat exposure').\n"
   "3. A disclosure enumerates the complete material population and confirms all were screened (e.g. 'all 14 material plants assessed')."),
  "A defined material population with a stated coverage numerator/denominator or a complete enumeration, on a business-relevant denominator, at/above the applicable threshold.",
  "'Across our operations' / 'company-wide' / 'all sites' with no figure or enumeration; coverage inferred from a general statement; hazard identification without a coverage denominator (that is U1); vulnerability method (U4).",
  ["We screened 310 of 356 facilities (87%) for physical climate exposure, covering all sites above our materiality threshold.",
   "82% of asset value and 100% of our top-20 revenue-generating sites were assessed for flood, heat and water-stress exposure.",
   "All 14 material manufacturing plants were enumerated and individually screened for acute and chronic physical hazards.",
   "Physical-risk screening covered 75% of insured property value, with the remaining low-value leased offices excluded as immaterial and the rationale stated."],
  ["We assess physical climate risk across our operations.",
   "Our climate risk screening covers the whole Group.",
   "All material sites are reviewed for climate-related risks.",
   "We have conducted a company-wide climate risk assessment."],
  ["coverage", "screened population", "denominator", "% of asset value", "facilities assessed", "enumerated sites", "revenue coverage", "insured value", "materiality threshold"],
  ["CDP response", "Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "Risk report"],
  {"yes_cases": "A stated coverage ratio or complete enumeration over a defined material population on a business denominator, meeting threshold.",
   "no_cases": "'All operations'/'company-wide' with no figure, or inferred coverage.",
   "distinguishing_test": "Is there a numerator/denominator or a complete named population — not just a claim that everything is covered?"},
  0.30,
  S("physical_climate", "assessment", "always", ["public_company"],
    "Exposure-screening coverage is expected of any public company; threshold is materiality-adjusted.",
    [{"id": "physical_attribution", "requires": "physical-climate exposure screening"},
     {"id": "population", "requires": "defined population of material exposure"},
     {"id": "coverage", "requires": "stated coverage numerator/denominator or complete enumerated population"},
     {"id": "threshold", "requires": "coverage meets the applicable threshold policy (default 0.50, materiality-adjusted)"}],
    coverage={"populationDefinition": "material operating locations, production capacity, asset value, revenue or insured value",
              "acceptedDenominators": ["sites", "facilities", "asset_value", "revenue", "production_capacity", "insured_value"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["310 of 356 facilities", "82% of asset value", "all 14 material plants"],
              "doesNotCount": ["across our operations", "company-wide", "many sites", "all sites (no figure)"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["U1 (hazard identification, no coverage denominator)", "U4 (vulnerability/consequence method)"]),
  coverage_whitelist=["310 of 356 facilities", "82% of asset value", "all 14 material plants", "75% of insured property value", "100% of top-20 revenue sites"]),

M("U3", 2,
  "Scenario or stress analysis is commensurate with business exposure and planning horizons",
  "Physical-climate scenario / stress analysis",
  "Whether the company uses a physical-climate scenario or severe physical-disruption stress, states an appropriate horizon, and links it to asset life, contracts, strategic plan, exposure or a decision process. Replaces B2-scenario-horizons.",
  ("TRACK physical_climate. APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a physical-climate scenario OR a severe physical-"
   "disruption stress test; (2) a stated, appropriate horizon; and (3) a link from the exercise to asset life, contracts, strategic plan, "
   "exposure or a decision process. CHANGE FROM LEGACY: a high-warming scenario beyond 2050 remains a strong route for long-lived-asset owners "
   "but is NOT a universal gate; asset-light/service/short-cycle businesses may qualify via another severe, decision-relevant physical-"
   "disruption analysis. DEFINITION: the analysis must be decision-relevant and horizon-appropriate to THIS company, not a generic scenario "
   "mention."),
  ("Binary. Yes requires a physical-climate scenario or severe physical-disruption stress, an appropriate stated horizon, and a link to "
   "asset life/contracts/strategy/exposure/decisions, quote-verifiable. A named scenario with no horizon or no decision linkage is No. Do not "
   "force a >2050 high-warming horizon on asset-light businesses if a severe decision-relevant stress is disclosed."),
  ("1. A long-lived-asset owner runs a high-warming physical scenario to 2050+ and links results to asset life/capex planning.\n"
   "2. An asset-light firm stress-tests a severe multi-week outage of a critical data-centre region and links it to its continuity/strategic "
   "plan over a relevant horizon.\n"
   "3. A disclosure states the scenario(s), the horizon chosen and why it fits the business, and the decision or plan the results informed."),
  "A physical-climate scenario or severe physical-disruption stress, with an appropriate stated horizon, linked to asset life, contracts, strategy, exposure or a decision.",
  "A scenario named with no horizon; a horizon with no decision/exposure link; a transition-only (net-zero/2°C emissions-pathway) scenario with no physical-impact analysis; exposure screening (U2); correlated/cascading analysis (U8).",
  ["We ran RCP8.5 to 2050 and 2080 across our property portfolio and used the results to set the asset-life and capex plan for coastal sites.",
   "As an asset-light payments firm we stress-tested a 10-day loss of our primary cloud region to extreme heat; results fed our continuity strategy over a 3-year horizon.",
   "Physical-climate scenarios at 2030 and 2050 were linked to lease-renewal decisions for our highest-exposure distribution centres.",
   "A severe drought stress over a 5-year horizon was modelled for our beverage operations and informed the water-resilience investment plan."],
  ["We consider a range of climate scenarios in our strategy.",
   "Our analysis is aligned with a 1.5°C transition pathway and net-zero by 2050.",
   "We use RCP scenarios published by the IPCC.",
   "Climate scenario analysis is an area of ongoing development for the Group."],
  ["scenario analysis", "stress test", "RCP", "SSP", "planning horizon", "asset life", "decision linkage", "severe disruption", "2050", "physical scenario"],
  ["CDP response", "TCFD/IFRS S2 report", "Annual Report", "Sustainability/ESG Report", "Strategy section"],
  {"yes_cases": "A physical scenario/stress with an appropriate horizon linked to asset life, contracts, strategy, exposure or a decision.",
   "no_cases": "A named scenario with no horizon or no decision link; a transition-only emissions scenario.",
   "distinguishing_test": "Is a PHYSICAL scenario/stress run at a horizon that fits the business AND tied to a decision, not just named?"},
  0.35,
  S("physical_climate", "assessment", "always", ["public_company"],
    "Scenario/stress analysis commensurate with exposure is expected of any public company (form varies by business model).",
    [{"id": "physical_scenario", "requires": "physical-climate scenario or severe physical-disruption stress"},
     {"id": "horizon", "requires": "an appropriate stated horizon"},
     {"id": "decision_link", "requires": "linked to asset life, contracts, strategic plan, exposure or a decision process"}],
    exclusions=["U2 (exposure screening)", "U8 (correlated/cascading analysis)"])),

M("U4", 2,
  "Vulnerability and business consequences are assessed, not only hazard exposure",
  "Exposure-to-business-consequence methodology",
  "Whether the company describes a method linking a physical hazard/exposure to vulnerability or consequence (asset sensitivity, damage function, design threshold, downtime/production model, revenue/cash-flow impact, service interruption or customer consequence). Replaces B4-vulnerability-methodology and the forward-looking part of B6-financial-impact.",
  ("TRACK physical_climate. APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a physical hazard/exposure input; and (2) a described "
   "METHOD that links it to vulnerability or business consequence — asset sensitivity, damage function, design threshold, downtime/production "
   "model, revenue/cash-flow impact, service interruption or customer consequence. Boundary: this is forward-looking consequence METHOD; "
   "historic realised incident impact is R2; hazard identification is U1. DEFINITION: reject exposure-only outputs — a hazard map, a vendor "
   "name, or a loss figure with no stated basis/method does not qualify."),
  ("Binary. Yes requires a described method linking hazard/exposure to a vulnerability or business consequence, quote-verifiable. Hazard maps, "
   "vendor names, or a loss estimate with no stated basis/method are No. Forward-looking only — realised event losses are R2."),
  ("1. A disclosure describes damage functions or asset-sensitivity curves applied to exposed assets to estimate expected damage/downtime.\n"
   "2. A disclosure models revenue/cash-flow or production impact from a hazard using a stated methodology and assumptions.\n"
   "3. A disclosure links a design threshold or service-interruption model to a quantified or bounded business consequence."),
  "A described method linking physical hazard/exposure to vulnerability or business/financial consequence (damage function, sensitivity, downtime/production model, revenue/cash-flow impact, service/customer consequence).",
  "A hazard/exposure map with no consequence method; a vendor/tool name alone; a loss number with no stated basis; historic realised event losses (R2); hazard identification only (U1).",
  ["We apply asset-specific damage functions to flood depth to estimate expected annual damage and downtime per facility.",
   "Our model translates heat-days above 40°C into productivity loss and cooling-cost impact for outdoor operations, with stated assumptions.",
   "A cash-flow-at-risk method links drought severity to production curtailment and revenue impact at our two water-intensive plants.",
   "We model service-interruption hours from storm scenarios and the resulting customer-SLA and revenue consequences for our network."],
  ["We use Munich Re's climate risk data to assess exposure.",
   "Our assets face increasing risk from floods and storms.",
   "We estimate potential climate losses of up to $50m (no basis disclosed).",
   "Hazard maps show several sites in high-risk zones."],
  ["vulnerability", "damage function", "asset sensitivity", "downtime model", "production impact", "cash-flow at risk", "consequence methodology", "service interruption", "design threshold"],
  ["CDP response", "TCFD/IFRS S2 report", "Annual Report", "Sustainability/ESG Report", "Financial statement notes"],
  {"yes_cases": "A described method converting hazard/exposure into vulnerability or business/financial consequence.",
   "no_cases": "Exposure maps, vendor names, or a loss figure with no method; realised event losses.",
   "distinguishing_test": "Is there a stated METHOD linking hazard to consequence, forward-looking, rather than exposure or an unexplained number?"},
  0.28,
  S("physical_climate", "assessment", "always", ["public_company"],
    "A consequence/vulnerability method is expected of any public company assessing material physical risk.",
    [{"id": "hazard_input", "requires": "a physical hazard/exposure input"},
     {"id": "consequence_method", "requires": "a described method linking it to vulnerability or business/financial consequence"}],
    exclusions=["U1 (hazard identification)", "R2 (historic realised incident impact)", "B6 historic portion -> R2"])),

M("U5", 2,
  "Critical business activities and tolerable disruption are defined",
  "Business-impact analysis (BIA)",
  "Whether the company identifies critical activities, products, services or systems and discloses a bounded tolerable-disruption parameter (maximum tolerable disruption, RTO, RPO, criticality ranking or equivalent). New measure (no legacy equivalent).",
  ("TRACK operational_resilience (hazard-neutral: a named critical activity plus a bounded prioritisation; climate wording NOT required). "
   "APPLICABILITY always. ATOMIC PREDICATES, all required: (1) identifies critical activities, products, services or systems; and (2) discloses "
   "a bounded tolerable-disruption parameter — maximum tolerable disruption/downtime, recovery-time objective (RTO), recovery-point objective "
   "(RPO), criticality ranking or equivalent. Boundary: this is the BIA/prioritisation; recovery STRATEGY and objectives are P2; the continuity "
   "SYSTEM is P1. DEFINITION: a generic BIA/continuity claim with no named critical activity or recovery parameter does not qualify."),
  ("Binary. Yes requires named critical activities AND a bounded disruption/recovery parameter (MTD/RTO/RPO/criticality ranking), quote-"
   "verifiable. 'We have performed a business impact analysis' with no critical activity or parameter is No."),
  ("1. A disclosure names its critical activities/systems and states a maximum tolerable disruption or RTO for each tier.\n"
   "2. A disclosure presents a criticality ranking of products/services with recovery priorities.\n"
   "3. A disclosure states RPO/RTO targets for critical systems identified in its BIA."),
  "Named critical activities/products/services/systems with a bounded tolerable-disruption parameter (MTD, RTO, RPO, criticality ranking or equivalent).",
  "A generic 'we conduct a BIA'/'we have continuity plans' with no named critical activity or recovery parameter; recovery strategy/objectives detail (P2); the continuity system itself (P1); dependency mapping (U6/U7).",
  ["Our BIA identifies order-processing and payments as Tier-1 activities with a maximum tolerable downtime of 4 hours.",
   "We rank our 9 critical services and set RTOs ranging from 2 to 24 hours by criticality tier.",
   "Critical systems carry defined RPOs (data loss tolerance) of 15 minutes for transactional platforms.",
   "The business-impact analysis designates three production lines as critical, each with a stated tolerable interruption window."],
  ["We perform regular business impact analyses across the Group.",
   "Business continuity is embedded in our operations.",
   "We understand which parts of our business are most important.",
   "Our continuity plans ensure we can keep operating."],
  ["business impact analysis", "critical activity", "maximum tolerable disruption", "recovery time objective", "RTO", "RPO", "criticality ranking", "tolerable downtime"],
  ["Business continuity / resilience policy", "Annual Report", "Operational resilience disclosure", "Earnings call transcript"],
  {"yes_cases": "Named critical activities/systems with a bounded disruption/recovery parameter.",
   "no_cases": "A generic BIA/continuity claim with no critical activity or parameter.",
   "distinguishing_test": "Are specific critical activities named AND bounded by MTD/RTO/RPO/criticality — not just a claim that a BIA exists?"},
  0.20,
  S("operational_resilience", "assessment", "always", ["public_company"],
    "A BIA defining critical activities and tolerable disruption is expected of any operating company regardless of climate exposure.",
    [{"id": "critical_activities", "requires": "critical activities/products/services/systems identified"},
     {"id": "tolerable_disruption", "requires": "MTD/RTO/RPO/criticality ranking or equivalent bounded prioritisation"}],
    exclusions=["P1 (continuity system)", "P2 (recovery strategy & objectives)", "U6/U7 (dependency mapping)"])),

M("U6", 2,
  "Critical supplier and logistics dependencies are mapped and prioritised",
  "Supplier/logistics dependency assessment",
  "Whether the company identifies critical supplier, input, route, inventory or logistics dependencies and states a coverage, criticality ranking, single-source concentration, or priority population. Replaces part of B5-valuechain-infra-exposure.",
  ("TRACK operational_resilience (named critical dependency + prioritisation; climate wording NOT required). APPLICABILITY always. "
   "ATOMIC PREDICATES, all required: (1) identifies critical supplier/input/route/inventory/logistics dependencies; and (2) states a coverage, "
   "criticality ranking, single-source concentration, or priority population. Boundary: this is dependency MAPPING; the resilience ACTION on "
   "those dependencies is A8; infrastructure/utility/IT dependencies are U7. DEFINITION: generic supply-chain-disruption language, or supplier "
   "resilience ACTIONS with no evidence of dependency assessment, does not qualify."),
  ("Binary. Yes requires named critical supplier/logistics dependencies AND a coverage/ranking/concentration/priority population, quote-"
   "verifiable. Generic 'supply chains face disruption risk' or actions with no dependency assessment is No. Supplier ACTIONS are A8; "
   "infrastructure dependencies are U7."),
  ("1. A disclosure maps critical suppliers/inputs and states single-source concentration or a tier-1 criticality ranking.\n"
   "2. A disclosure identifies key logistics routes/nodes and a priority population (e.g. 'top 20 suppliers by criticality').\n"
   "3. A disclosure states coverage of its supplier base assessed for dependency criticality."),
  "Named critical supplier/input/route/inventory/logistics dependencies with a coverage, criticality ranking, single-source concentration, or priority population.",
  "Generic supply-chain-disruption risk language; supplier resilience ACTIONS with no dependency assessment (that is A8); infrastructure/utility/IT dependencies (U7); a supplier code of conduct.",
  ["We mapped our top-50 suppliers; 12 are single-source for critical inputs and are prioritised for continuity planning.",
   "Our logistics dependency assessment identifies three port nodes whose disruption would halt 60% of outbound volume.",
   "Critical-input dependency mapping covers 85% of direct spend and ranks suppliers by criticality tier.",
   "We identified two sole-source active-ingredient suppliers as our highest supply-chain dependency concentration."],
  ["We work closely with our suppliers to manage risk.",
   "Supply chain disruption is a risk we monitor.",
   "We have a diverse global supplier base.",
   "Our procurement team ensures resilient sourcing."],
  ["supplier dependency", "single source", "criticality ranking", "logistics route", "supply concentration", "tier-1 suppliers", "dependency mapping", "priority population"],
  ["Annual Report", "Sustainability/ESG Report", "Supply chain disclosure", "Operational resilience disclosure", "Earnings call transcript"],
  {"yes_cases": "Named critical supplier/logistics dependencies with coverage/ranking/concentration/priority population.",
   "no_cases": "Generic supply-chain risk language, or actions with no dependency assessment.",
   "distinguishing_test": "Is there a mapped/prioritised set of critical supplier-logistics dependencies — not just engagement or an action?"},
  0.22,
  S("operational_resilience", "assessment", "always", ["public_company"],
    "Supplier/logistics dependency mapping is expected of any company with a material value chain.",
    [{"id": "critical_dependencies", "requires": "critical supplier/input/route/inventory/logistics dependencies identified"},
     {"id": "prioritisation", "requires": "coverage, criticality ranking, single-source concentration, or priority population"}],
    coverage={"populationDefinition": "critical suppliers, inputs, routes or logistics nodes",
              "acceptedDenominators": ["suppliers", "direct_spend", "volume", "critical_inputs"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["top-50 suppliers", "85% of direct spend", "two sole-source suppliers"],
              "doesNotCount": ["our suppliers", "global supplier base", "supply chain generally"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["A8 (supplier/logistics resilience action)", "U7 (infrastructure/utility/IT dependencies)"]),
  coverage_whitelist=["top-50 suppliers", "85% of direct spend", "two sole-source active-ingredient suppliers", "top 20 suppliers by criticality"]),

M("U7", 2,
  "Critical infrastructure, utility and technology dependencies are mapped and prioritised",
  "Dependencies on power, water, telecoms, transport, data/IT, communications or other enabling infrastructure",
  "Whether the company names a material infrastructure/utility/technology dependency class, its service/operational relevance, and a coverage, ranking, vulnerability or recovery requirement. Replaces part of B5-valuechain-infra-exposure.",
  ("TRACK operational_resilience. APPLICABILITY always. ATOMIC PREDICATES, all required: (1) names a material dependency class — power, water, "
   "telecoms, transport, data/IT, communications or other enabling infrastructure; (2) states its service/operational relevance; and (3) "
   "states a coverage, ranking, vulnerability or recovery requirement. Boundary: this is infrastructure dependency MAPPING; the resilience "
   "CONTROL on those dependencies is A9; supplier/logistics dependencies are U6. DEFINITION: a generic statement that infrastructure 'is "
   "important' does not qualify."),
  ("Binary. Yes requires a named infrastructure/utility/tech dependency class, its operational relevance, AND a coverage/ranking/vulnerability/"
   "recovery requirement, quote-verifiable. 'We rely on power and IT' with no relevance or prioritisation is No. Controls are A9; supplier "
   "dependencies are U6."),
  ("1. A disclosure identifies grid-power dependency for named critical sites and ranks sites by exposure to outage.\n"
   "2. A disclosure maps data-centre/IT dependencies and states recovery requirements for each critical system.\n"
   "3. A disclosure names water/telecoms/transport dependencies, their operational relevance and the vulnerability or coverage assessed."),
  "A named infrastructure/utility/technology dependency class with stated operational relevance and a coverage, ranking, vulnerability or recovery requirement.",
  "A generic 'infrastructure is important'; reliance mentioned with no relevance or prioritisation; the resilience control itself (A9); supplier/logistics dependencies (U6).",
  ["Grid power is our most critical utility dependency; the 6 highest-load sites are ranked by outage exposure and recovery requirement.",
   "Our IT dependency map identifies two data-centre regions as critical, each with a defined maximum outage tolerance.",
   "Water supply is a material dependency for 4 plants; we assessed each for interruption vulnerability and minimum supply requirements.",
   "Telecoms and transport corridors feeding our distribution hub were mapped and prioritised by operational criticality."],
  ["We depend on reliable infrastructure to operate.",
   "Power and connectivity are important to our business.",
   "We have backup generators at our head office.",
   "Our operations rely on third-party utilities and networks."],
  ["utility dependency", "grid power", "data centre", "telecoms", "transport corridor", "water supply", "dependency ranking", "outage tolerance", "infrastructure criticality"],
  ["Annual Report", "Operational resilience disclosure", "Sustainability/ESG Report", "Risk report", "Earnings call transcript"],
  {"yes_cases": "A named infrastructure/utility/tech dependency with operational relevance and a coverage/ranking/vulnerability/recovery requirement.",
   "no_cases": "'Infrastructure is important', or reliance with no prioritisation; a control (A9).",
   "distinguishing_test": "Is a specific infrastructure dependency mapped/prioritised with relevance and requirement — not just acknowledged?"},
  0.18,
  S("operational_resilience", "assessment", "always", ["public_company"],
    "Infrastructure/utility/IT dependency mapping is expected of any operating company.",
    [{"id": "dependency_class", "requires": "named material infrastructure/utility/technology dependency class"},
     {"id": "relevance", "requires": "stated service/operational relevance"},
     {"id": "prioritisation", "requires": "a coverage, ranking, vulnerability or recovery requirement"}],
    coverage={"populationDefinition": "critical infrastructure/utility/technology dependencies",
              "acceptedDenominators": ["sites", "systems", "dependency_classes"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["6 highest-load sites", "two critical data-centre regions", "4 plants"],
              "doesNotCount": ["infrastructure generally", "we rely on utilities"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["A9 (infrastructure/utility/tech resilience control)", "U6 (supplier/logistics dependencies)"]),
  coverage_whitelist=["6 highest-load sites", "two critical data-centre regions", "4 water-dependent plants"]),

M("U8", 2,
  "Correlated and cascading disruption is assessed",
  "Multi-dependency / correlated physical-disruption analysis",
  "Whether a physical hazard or scenario is analysed for its ability to disrupt more than one relevant operation, facility, supplier, utility, transport corridor or service at the same time, with a stated dependency or consequence. New measure (no legacy equivalent).",
  ("TRACK physical_climate. APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a physical hazard or scenario; (2) analysed for "
   "SIMULTANEOUS disruption of MORE THAN ONE relevant operation, facility, supplier, utility, transport corridor or service; and (3) a stated "
   "dependency or consequence of that correlated failure. Boundary: single-asset hazard analysis is U1/U4; this measure requires correlation/"
   "cascade. DEFINITION: one-asset hazard analysis that does not consider correlated failure does not qualify."),
  ("Binary. Yes requires a physical hazard/scenario analysed for simultaneous/correlated disruption across more than one dependency, with a "
   "stated consequence, quote-verifiable. Independent single-asset analyses do not qualify unless their correlation is analysed."),
  ("1. A disclosure analyses how one storm/flood event would simultaneously hit multiple sites in a region plus a shared supplier or port.\n"
   "2. A scenario examines concurrent heat-driven grid failure and water-supply loss across co-located operations.\n"
   "3. A disclosure models a cascade (hazard -> utility loss -> supplier outage -> service interruption) with the dependency chain stated."),
  "A physical hazard/scenario analysed for simultaneous disruption of more than one operation/facility/supplier/utility/route/service, with a stated dependency or consequence.",
  "Single-asset hazard analysis (U1/U4); independent per-site assessments with no correlation; a generic statement that risks are 'interconnected'; dependency mapping with no hazard-driven correlation (U6/U7).",
  ["We modelled a single Gulf hurricane hitting three co-located plants, the shared port and a key supplier simultaneously, quantifying combined downtime.",
   "A regional heatwave scenario analysed concurrent grid-power loss and water-curtailment across our four Spanish sites.",
   "Our cascade analysis traces river flooding to substation loss, then to our data centre and dependent customer services.",
   "We assessed correlated wildfire exposure across our Californian facilities and the regional logistics network they share."],
  ["Climate risks are interconnected across our value chain.",
   "A single event could affect multiple parts of our business.",
   "We assess each site individually for climate hazards.",
   "Systemic climate risks are a concern for all companies."],
  ["correlated disruption", "cascading failure", "simultaneous impact", "co-located", "regional event", "dependency chain", "concurrent loss", "systemic scenario"],
  ["CDP response", "TCFD/IFRS S2 report", "Annual Report", "Risk report", "Sustainability/ESG Report"],
  {"yes_cases": "A hazard/scenario analysed for simultaneous/cascading disruption across multiple dependencies with a consequence.",
   "no_cases": "Single-asset analysis, independent per-site assessments, or generic 'interconnected risk'.",
   "distinguishing_test": "Does the analysis examine correlated/cascading failure across more than one dependency — not one asset in isolation?"},
  0.10,
  S("physical_climate", "assessment", "always", ["public_company"],
    "Correlated/cascading analysis is relevant to any company with multiple interdependent operations or dependencies.",
    [{"id": "physical_scenario", "requires": "a physical hazard or scenario"},
     {"id": "correlation", "requires": "simultaneous disruption of more than one operation/facility/supplier/utility/route/service"},
     {"id": "consequence", "requires": "a stated dependency or consequence of the correlated failure"}],
    exclusions=["U1/U4 (single-asset hazard/consequence)", "U6/U7 (dependency mapping without hazard correlation)"])),
]



# ══════════════ PILLAR A — Reduce vulnerability and adapt the business ══════════════
MEASURES += [

M("A1", 3,
  "A physical-climate adaptation/resilience plan has owners, milestones and exposure linkage",
  "Adaptation action plan",
  "Whether a disclosed plan identifies an adaptation action portfolio, links it to material physical exposure/hazards, names owners or governance, and includes dated milestones, budget/action status or a decision timetable. Replaces C1-adaptation-strategy. CRITICAL-GATE measure.",
  ("TRACK physical_climate (explicit physical-climate / hazard attribution required). APPLICABILITY always. "
   "CRITICAL GATE (criticalMeasureSet [U1,U2,A1,P4]). ATOMIC PREDICATES, all required for Yes: (1) an identified adaptation/resilience "
   "ACTION portfolio (not an aspiration); (2) an explicit link to material physical exposure or named hazards; (3) a named owner or "
   "governance accountability for the plan; and (4) a dated milestone, budget/action status, or a decision timetable. CHANGE FROM LEGACY: "
   "capex/site-plan linkage is a VALID route, not the only route — asset-light businesses may adapt through operating models, supplier "
   "arrangements or technology/hosting choices, and those count. Boundary: a PLAN with owners+milestones here; a completed/operational "
   "control is A2; resourcing amounts are A6; appraisal basis is A7. DEFINITION: a bounded disclosure must show an owned, time-bound "
   "adaptation plan tied to the company's own physical exposure — not a generic commitment to 'build resilience'."),
  ("Binary. Yes requires all four predicates quote-verifiable: an action portfolio, physical-exposure linkage, named ownership/governance, "
   "and a dated milestone / action status / decision timetable. A statement of intent, a resilience 'ambition' with no owner or date, or a "
   "plan with no physical-exposure link is No. Operating-model / supplier / technology adaptation routes are accepted — do not require capex."),
  ("1. A report sets out an adaptation plan with named workstreams tied to the company's flood/heat/water exposure, a responsible owner, and "
   "dated milestones to 2027.\n"
   "2. An asset-light firm discloses a resilience plan to re-architect hosting across climate-resilient regions, owned by the COO, with a "
   "phased timetable and status per phase.\n"
   "3. A CDP/TCFD disclosure links an adaptation action portfolio to material hazard findings, names the accountable committee, and reports "
   "budget allocated and percentage complete."),
  "An owned, dated adaptation action plan (capex OR operating-model/supplier/technology route) explicitly linked to the company's material physical exposure.",
  "A generic 'we are building climate resilience' ambition; a plan with no owner or no date; an adaptation goal with no link to the company's own physical exposure; a completed single control (A2); a resourcing figure alone (A6); an appraisal method alone (A7).",
  ["Our Climate Adaptation Plan sets five workstreams addressing our flood- and heat-exposed sites, is owned by the Group Resilience Director, and has dated milestones through 2027 with status reported quarterly.",
   "As an asset-light business we are migrating critical workloads to three climate-resilient hosting regions; the programme is owned by the COO with a phased 2025-2026 timetable and completion status per region.",
   "The Board-approved adaptation portfolio links each action to a material physical hazard identified in our screening, names an accountable owner per action, and allocates GBP 40m across a three-year milestone plan.",
   "Our resilience roadmap ties supplier-diversification and inventory-buffering actions to drought and flood exposure in our sourcing regions, with the Chief Procurement Officer accountable and target dates for each action."],
  ["We are committed to building resilience to climate change across our business.",
   "The company recognises the importance of adapting to physical climate risks.",
   "We have an ambition to make our operations more climate-resilient over time.",
   "A climate adaptation strategy is under development and will be published in due course."],
  ["adaptation plan", "resilience plan", "milestone", "owner", "accountable", "action portfolio", "exposure linkage", "decision timetable", "budget allocated"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "CDP response", "Climate transition/adaptation plan"],
  {"yes_cases": "An owned, time-bound adaptation action plan linked to the company's material physical exposure (any adaptation route).",
   "no_cases": "Ambition/intent with no owner, date, or physical-exposure link.",
   "distinguishing_test": "Is there a specific, owned, dated action portfolio tied to this company's physical exposure — not a general resilience aspiration?"},
  0.22,
  S("physical_climate", "plan", "always", ["public_company"],
    "Any materially exposed public company is expected to hold an owned, time-bound adaptation plan; critical-gate measure.",
    [{"id": "action_portfolio", "requires": "an identified adaptation/resilience action portfolio (not aspiration)"},
     {"id": "exposure_linkage", "requires": "explicit link to material physical exposure or named hazards"},
     {"id": "ownership", "requires": "a named owner or governance accountability"},
     {"id": "time_bound", "requires": "a dated milestone, action status, or decision timetable"}],
    exclusions=["A2 (completed/operational control)", "A6 (resourcing amount)", "A7 (appraisal basis)", "G1 (board oversight, no plan)"])),

M("A2", 3,
  "Risk-mechanism-specific adaptation has been implemented at material operations or dependencies",
  "Implemented physical-climate adaptation control",
  "Whether a completed/operational action is linked to a named physical risk mechanism and states a covered material operation/dependency or a deterministic coverage result. Replaces C3-implemented-mitigation.",
  ("TRACK physical_climate (named physical risk mechanism required). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) the action is COMPLETED or operational (not planned/piloted-only); (2) it is linked to a named physical risk mechanism "
   "(flood, heat, wind, wildfire, water stress, subsidence, storm surge, etc.); and (3) it states a covered material operation/dependency "
   "OR a deterministic coverage result (see coverageRule). Boundary: a PLAN is A1; a change of asset ownership/use/location/life/portfolio "
   "allocation is A5; this measure is physical hardening/operational adaptation that is DONE. DEFINITION: evidence of a built, in-service "
   "adaptation control tied to a specific hazard mechanism and a covered material operation — not an intention or an isolated pilot."),
  ("Binary. Yes requires a completed/operational control, a named physical risk mechanism, and a covered material operation/dependency or a "
   "coverage result, all quote-verifiable. A future plan, an isolated pilot with no materiality/coverage, or an unrelated environmental "
   "action (e.g. emissions reduction) is No. Accept operational and supplier/technology controls, not only physical site works."),
  ("1. A report states flood barriers and raised plant were commissioned at the two highest-flood-risk production sites, covering 100% of at-risk capacity.\n"
   "2. A disclosure confirms heat-resilient cooling was installed across 18 of 20 data halls exposed to rising wet-bulb temperatures.\n"
   "3. A company reports it completed relocation of critical switchgear above the modelled flood level at all three coastal substations."),
  "A completed/operational control linked to a named physical hazard mechanism with a stated covered material operation/dependency or coverage result.",
  "A future/planned action; an isolated pilot with no materiality or coverage; a generic environmental or emissions action; an asset ownership/use/location change (that is A5); a plan with owners/milestones (A1).",
  ["We completed installation of flood defences and raised critical equipment at our two highest-flood-risk plants, protecting 100% of exposed production capacity.",
   "Heat-resilient cooling upgrades are now operational across 18 of our 20 data halls most exposed to rising wet-bulb temperatures.",
   "During 2025 we commissioned backup water-storage and recycling at all four drought-exposed manufacturing sites, cutting mains dependency by 60%.",
   "Wildfire defensible-space and ember-resistant retrofits were completed at the three facilities within our highest-rated fire zones."],
  ["We plan to install flood defences at our most exposed sites by 2028.",
   "A pilot resilience retrofit is under evaluation at one facility.",
   "We reduced our Scope 1 and 2 emissions by 30% through energy-efficiency measures.",
   "The company is committed to protecting its operations from extreme weather."],
  ["installed", "commissioned", "completed", "operational", "flood defence", "heat-resilient", "retrofit", "coverage", "exposed capacity protected"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "TCFD/IFRS S2 report", "Operational/plant report"],
  {"yes_cases": "A built, in-service control tied to a named hazard mechanism and a covered material operation or coverage result.",
   "no_cases": "Planned/piloted action, generic environmental action, or no coverage/materiality.",
   "distinguishing_test": "Is the control actually DONE and tied to a specific hazard and covered population — not planned or generic?"},
  0.20,
  S("physical_climate", "implemented_action", "always", ["public_company"],
    "Implemented hazard-specific adaptation is expected where material exposure exists.",
    [{"id": "completed", "requires": "a completed/operational action (not planned or pilot-only)"},
     {"id": "mechanism", "requires": "linkage to a named physical risk mechanism"},
     {"id": "coverage", "requires": "a covered material operation/dependency or deterministic coverage result"}],
    coverage={"populationDefinition": "material operations/dependencies exposed to the named hazard mechanism",
              "acceptedDenominators": ["exposed_sites", "exposed_capacity", "at_risk_assets", "critical_dependencies"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["2 highest-risk plants", "18 of 20 data halls", "all four drought-exposed sites"],
              "doesNotCount": ["a pilot", "one facility (no materiality)", "across our sites (no figure)"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["A1 (plan, not completed)", "A5 (asset ownership/use/location change)", "A11 (chronic-hazard continuity control)"]),
  coverage_whitelist=["2 highest-flood-risk plants", "18 of 20 data halls", "all four drought-exposed sites", "all three coastal substations"]),

M("A3", 3,
  "Engineering, maintenance and design standards apply future resilience thresholds where material",
  "Technical resilience standard",
  "Whether a standard or rule specifies a future-relevant climate/design threshold or requirement and identifies the assets/project classes to which it applies. Replaces part of A3-policy-framework and C5-siting-ma-design-standards.",
  ("TRACK physical_climate (future-climate/design threshold attribution required). APPLICABILITY if_material (applies where the company "
   "has physical assets, facilities or capital projects whose design/maintenance can embed climate thresholds; non-applicable for pure "
   "asset-light models with no design control — handled as an applicability determination, not an automatic No). ATOMIC PREDICATES, all "
   "required: (1) a standard, rule or specification exists; (2) it specifies a FUTURE-relevant climate/design threshold, return period, or "
   "heat/wind/flood/water/fire requirement (not historical code compliance alone); and (3) it identifies the assets or project classes to "
   "which it applies. Boundary: technical DESIGN/maintenance thresholds here; pre-commitment due-diligence screening is A4; embedding into "
   "governance/decision process is G5. DEFINITION: a technical requirement with a forward-looking climate threshold and a defined scope of "
   "application — not a policy statement with no technical content."),
  ("Binary. Yes requires a standard/rule, a future-relevant climate/design threshold, and a defined asset/project-class scope, all "
   "quote-verifiable. Historical building-code compliance alone, or a policy with no technical/operational requirement, is No. The "
   "threshold must be forward-looking (future return periods, projected heat/wind/water loads), not merely current-code conformance."),
  ("1. A standard requires new facilities to be designed to a 1-in-200-year flood level under a mid-century climate projection, applied to all new builds and major refurbishments.\n"
   "2. An engineering spec sets maximum design wet-bulb and peak-wind loads aligned to 2050 projections for all data-centre and logistics-hub projects.\n"
   "3. A maintenance standard mandates drainage and roof-load upgrades to projected rainfall-intensity thresholds across the owned-estate portfolio."),
  "A technical standard/rule with a forward-looking climate/design threshold and a defined set of assets or project classes it governs.",
  "Historical building-code compliance alone; a policy with no technical/operational requirement; a general design-quality statement; pre-commitment site screening (A4); decision-process embedding (G5).",
  ["Our engineering standard requires all new facilities and major refurbishments to be designed to a 1-in-200-year flood level using mid-century climate projections.",
   "Data-centre and logistics projects must meet design wet-bulb and peak-wind thresholds aligned to 2050 climate scenarios under our Group Technical Standard.",
   "The estate maintenance standard mandates drainage and roof upgrades to projected rainfall-intensity return periods for all owned warehouses.",
   "Our design code specifies climate-adjusted cooling-capacity margins for all critical plant procured after 2024."],
  ["All our buildings comply with local building codes and regulations.",
   "We maintain high standards of engineering and design quality.",
   "The company follows good practice in facilities management.",
   "We aim to design resilient infrastructure across our estate."],
  ["design standard", "return period", "future climate projection", "wet-bulb threshold", "flood level", "wind load", "engineering specification", "applies to new builds"],
  ["Annual Report", "Sustainability/ESG Report", "Engineering/technical standard", "TCFD/IFRS S2 report", "Operational/plant report"],
  {"yes_cases": "A technical standard specifying a forward-looking climate/design threshold with a defined asset/project scope.",
   "no_cases": "Historical code compliance only, or a policy with no technical requirement.",
   "distinguishing_test": "Does the standard set a FUTURE climate threshold and say which assets/projects it governs — beyond current-code compliance?"},
  0.12,
  S("physical_climate", "decision_control", "if_material", ["has_physical_assets", "has_capital_projects"],
    "Applies where design/maintenance of physical assets or projects can embed climate thresholds; excluded for pure asset-light models.",
    [{"id": "standard", "requires": "a standard, rule or specification"},
     {"id": "future_threshold", "requires": "a future-relevant climate/design threshold or requirement (not historical code alone)"},
     {"id": "scope", "requires": "identified assets or project classes to which it applies"}],
    exclusions=["A4 (pre-commitment due diligence)", "G5 (decision-process embedding)", "A2 (completed physical control)"])),

M("A4", 3,
  "Physical risk is assessed before committing to material locations, acquisitions, leases, outsourcing or critical suppliers",
  "Pre-commitment screening process",
  "Whether a disclosed process requires physical-risk due diligence before at least one specified commitment type, plus a decision criterion or escalation/approval consequence. Replaces part of C5-siting-ma-design-standards.",
  ("TRACK physical_climate (physical-risk due-diligence attribution required). APPLICABILITY if_material (applies where the company makes "
   "material commitment decisions — new locations, M&A, leases, outsourcing, supplier onboarding). ATOMIC PREDICATES, all required: "
   "(1) a disclosed PROCESS requiring physical-risk due diligence; (2) it applies BEFORE at least one specified commitment type (location, "
   "acquisition, lease, outsourcing or critical supplier); and (3) it carries a decision criterion or an escalation/approval consequence. "
   "Boundary: FORWARD pre-commitment screening here; retrospective existing-site screening is U1/U2; technical design thresholds are A3. "
   "DEFINITION: a gate in the company's commitment process that forces physical-risk assessment before a decision and can change it — not a "
   "general responsible-investment statement."),
  ("Binary. Yes requires a process, a named pre-commitment type, and a decision/escalation consequence, all quote-verifiable. "
   "Retrospective screening of existing sites, or a general statement about responsible investment/ESG due diligence, is No. The "
   "assessment must occur BEFORE the commitment and be able to influence or block it."),
  ("1. A disclosure states physical-climate due diligence is mandatory before any site acquisition or major lease, with sign-off required from the Risk Committee.\n"
   "2. An M&A process requires a physical-risk assessment of target assets, and material findings must be escalated to the investment committee before approval.\n"
   "3. A supplier-onboarding standard requires physical-hazard screening of critical new suppliers, with high-risk cases requiring mitigation or rejection."),
  "A process requiring physical-risk assessment before a named commitment type, with a decision criterion or escalation/approval consequence.",
  "Retrospective screening of existing sites (that is U1/U2); a general responsible-investment or ESG due-diligence statement; a screening that cannot affect the decision; technical design standards (A3).",
  ["Physical-climate due diligence is mandatory before any site acquisition or major lease, and the findings require Risk Committee sign-off before commitment.",
   "Our M&A playbook requires physical-risk assessment of target assets, with material exposure escalated to the investment committee before deal approval.",
   "Critical new suppliers must pass physical-hazard screening during onboarding; high-risk results require mitigation plans or disqualify the supplier.",
   "Before approving a new outsourced data-centre region, our process requires a physical-climate exposure review and a documented go/no-go decision."],
  ["We take environmental factors into account in our investment decisions.",
   "The company conducts due diligence on acquisitions in line with good practice.",
   "We screen our existing sites for physical climate risk annually.",
   "Responsible investment principles guide our capital allocation."],
  ["pre-commitment", "due diligence", "before acquisition", "site selection", "supplier onboarding", "go/no-go", "escalation", "investment committee approval"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "Risk report", "Investment/M&A policy"],
  {"yes_cases": "A pre-commitment process forcing physical-risk assessment before a named decision type, with a decision/escalation consequence.",
   "no_cases": "Retrospective screening or a general responsible-investment statement.",
   "distinguishing_test": "Does physical-risk assessment happen BEFORE a commitment and can it change the decision?"},
  0.10,
  S("physical_climate", "decision_control", "if_material", ["makes_material_commitments"],
    "Applies where the company makes material location/M&A/lease/outsourcing/supplier commitments.",
    [{"id": "process", "requires": "a disclosed due-diligence process"},
     {"id": "pre_commitment", "requires": "applies before at least one specified commitment type"},
     {"id": "consequence", "requires": "a decision criterion or escalation/approval consequence"}],
    exclusions=["U1/U2 (retrospective existing-site screening)", "A3 (technical design standard)", "G5 (general decision embedding)"])),

M("A5", 3,
  "Asset portfolio decisions address material high-risk assets",
  "Portfolio-level response to high-risk asset exposure",
  "Whether the company discloses an actual or defined decision pathway to relocate, retire, sell, redesign, harden or otherwise alter material high-risk assets, with the physical-risk rationale and a decision status or portfolio coverage. Replaces C6-asset-portfolio-decisions.",
  ("TRACK physical_climate (physical-risk rationale required). APPLICABILITY if_material (applies where the company holds a material "
   "portfolio of physical assets exposed to climate hazards). ATOMIC PREDICATES, all required: (1) an actual decision OR a defined "
   "decision pathway affecting material high-risk assets (relocate, retire, sell, redesign, harden or alter use/life/allocation); "
   "(2) a physical-risk rationale for the decision; and (3) a decision status OR portfolio coverage (see coverageRule). BOUNDARY (spec): "
   "physical hardening at individual operations is A2; a change to an asset's OWNERSHIP, USE, LOCATION, LIFE or PORTFOLIO ALLOCATION is A5. "
   "DEFINITION: a portfolio-level response that changes what the company owns/holds in light of physical risk — not routine site works."),
  ("Binary. Yes requires a portfolio-level decision or defined pathway on material high-risk assets, a physical-risk rationale, and a "
   "decision status or coverage, all quote-verifiable. Site-level hardening with no ownership/use/location change belongs in A2. A generic "
   "'we review our portfolio' statement with no physical-risk rationale or status is No."),
  ("1. A report discloses the sale of two coastal assets rated highest for storm-surge and sea-level-rise exposure, completed in 2025.\n"
   "2. A company defines a portfolio pathway to retire or repurpose chronically water-stressed facilities by 2030, covering all assets above its exposure threshold.\n"
   "3. A disclosure states a decision to relocate a flood-exposed distribution hub, with the physical-risk rationale and approval status."),
  "A portfolio-level decision or defined pathway (relocate/retire/sell/redesign/alter) on material high-risk assets, with a physical-risk rationale and status or coverage.",
  "Site-level physical hardening with no change of ownership/use/location (that is A2); a generic 'we review our portfolio' statement; a decision with no physical-risk rationale; a portfolio claim with no status or coverage.",
  ["In 2025 we divested two coastal terminals rated highest for storm-surge and sea-level-rise exposure, completing both disposals within the year.",
   "Our portfolio strategy defines a pathway to retire or repurpose all facilities above our water-stress exposure threshold by 2030, covering 11 assets.",
   "The Board approved relocating our flood-exposed central distribution hub to a lower-risk inland site following the physical-risk review.",
   "We redesigned the use of three heat-exposed assets, converting them from continuous production to buffered operation, across our highest-risk tier."],
  ["We regularly review our asset portfolio for performance and value.",
   "The company considers a range of factors in portfolio decisions.",
   "We hardened flood defences at one of our plants last year.",
   "Our assets are managed in line with our capital-allocation framework."],
  ["divest", "relocate", "retire", "repurpose", "portfolio decision", "high-risk asset", "sea-level rise", "decision pathway", "coverage of exposed assets"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "CDP response", "Strategic/portfolio report"],
  {"yes_cases": "A portfolio-level response altering material high-risk assets, with physical rationale and status/coverage.",
   "no_cases": "Site hardening only, generic portfolio review, or no physical rationale.",
   "distinguishing_test": "Does the company CHANGE what it owns/holds (ownership/use/location/life/allocation) because of physical risk — not just harden a site?"},
  0.08,
  S("physical_climate", "decision_control", "if_material", ["holds_material_physical_portfolio"],
    "Applies where the company holds a material portfolio of climate-exposed physical assets.",
    [{"id": "decision_pathway", "requires": "an actual decision or defined pathway to relocate/retire/sell/redesign/alter material high-risk assets"},
     {"id": "physical_rationale", "requires": "a physical-risk rationale"},
     {"id": "status_or_coverage", "requires": "a decision status or portfolio coverage"}],
    coverage={"populationDefinition": "material high-risk assets above the company's physical-exposure threshold",
              "acceptedDenominators": ["high_risk_assets", "asset_value", "exposed_portfolio_share"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["11 assets above threshold", "two highest-exposure terminals", "highest-risk tier"],
              "doesNotCount": ["we review our portfolio", "one asset (no coverage)"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["A2 (site-level physical hardening)", "A1 (plan, no portfolio decision)"]),
  coverage_whitelist=["11 assets above water-stress threshold", "two highest-exposure terminals", "highest-risk tier", "all assets above exposure threshold"]),

M("A6", 3,
  "Resilience resources are proportionate to material risk",
  "Resilience resourcing",
  "Whether the company links resources to physical-resilience priorities using an appropriate funding form and gives an amount, allocation, multi-year commitment, priority relation or plan-versus-actual comparison. Replaces C2-resilience-capital.",
  ("TRACK physical_climate (resourcing tied to physical-resilience priorities). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) resources are linked to physical-resilience priorities; (2) via an appropriate funding form — capex, opex, staffing, contingency "
   "funding, reserves or project approval; and (3) a quantification or relation — an amount, allocation, multi-year commitment, a priority "
   "relation, or a plan-versus-actual comparison. CHANGE FROM LEGACY: the mandatory share-of-total-capex gate is REMOVED — it is unsuitable "
   "for asset-light businesses and discourages legitimate operational solutions; opex/staffing/reserves all count. Boundary: resourcing "
   "AMOUNT/allocation here; the appraisal/decision basis is A7; the plan itself is A1. DEFINITION: evidence that resilience is resourced in "
   "proportion to risk, in any legitimate funding form — not a bare 'we invest in resilience' claim."),
  ("Binary. Yes requires resources linked to physical-resilience priorities, an appropriate funding form, and a quantification/relation, all "
   "quote-verifiable. Do NOT require a share of total capex. A generic 'we invest in resilience' with no amount, allocation or relation is No. "
   "Opex, staffing, reserves and contingency funding are all acceptable forms."),
  ("1. A report states GBP 25m of multi-year capex is allocated to flood and heat resilience across the highest-exposure sites.\n"
   "2. An asset-light firm discloses a dedicated resilience opex budget and a three-FTE continuity team, prioritised to its most critical services.\n"
   "3. A disclosure compares planned versus actual resilience spend and relates the allocation to its highest physical-risk priorities."),
  "Resources linked to physical-resilience priorities via a legitimate funding form (capex/opex/staffing/reserves/contingency) with an amount, allocation, multi-year commitment, priority relation or plan-vs-actual.",
  "A generic 'we invest in resilience' with no figure or relation; a demand for share-of-total-capex (removed); a resourcing claim with no physical-resilience link; the appraisal method (A7); the plan (A1).",
  ["We have allocated GBP 25m of multi-year capital to flood and heat resilience, prioritised to our ten highest-exposure sites.",
   "As an asset-light business we fund resilience through a dedicated opex budget and a three-person continuity team focused on our most critical services.",
   "Resilience spend is reported plan-versus-actual each year and allocated in proportion to our ranked physical-risk priorities.",
   "We hold a contingency reserve and ring-fenced staffing for climate-disruption response, sized to our highest-impact scenarios."],
  ["We invest appropriately in the resilience of our operations.",
   "The company allocates resources to managing climate-related risks.",
   "Resilience is a priority in our capital planning.",
   "We dedicate significant investment to protecting our business."],
  ["capex allocated", "opex budget", "staffing", "contingency funding", "reserves", "multi-year commitment", "plan versus actual", "resilience investment", "proportionate"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "TCFD/IFRS S2 report", "Financial statements"],
  {"yes_cases": "Resources tied to physical-resilience priorities in any legitimate funding form with an amount/allocation/relation.",
   "no_cases": "Generic investment claim with no figure, relation, or physical-resilience link.",
   "distinguishing_test": "Is there a quantified or relational resourcing commitment (capex OR opex/staffing/reserves) tied to physical-resilience priorities?"},
  0.16,
  S("physical_climate", "resourcing", "always", ["public_company"],
    "All companies can resource resilience in some legitimate form; share-of-capex is not required.",
    [{"id": "priority_link", "requires": "resources linked to physical-resilience priorities"},
     {"id": "funding_form", "requires": "an appropriate funding form (capex/opex/staffing/contingency/reserves/project approval)"},
     {"id": "quantification", "requires": "an amount, allocation, multi-year commitment, priority relation, or plan-vs-actual comparison"}],
    exclusions=["A7 (appraisal/decision basis)", "A1 (adaptation plan)"])),

M("A7", 3,
  "Resilience investments use a defined decision or appraisal basis",
  "Resilience investment appraisal",
  "Whether a stated appraisal compares or evaluates adaptation options using a defined business criterion. Replaces C9-adaptation-investment-appraisal.",
  ("TRACK physical_climate (appraisal of physical-resilience options). APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a stated "
   "appraisal or evaluation of resilience/adaptation options; (2) it COMPARES or evaluates options; and (3) using a defined business "
   "criterion — avoided loss, service capacity, safety, downtime, business interruption, cost-benefit, benefit-cost ratio, risk reduction "
   "or another defined basis. Boundary: the appraisal METHOD here; the resourcing amount is A6; the plan is A1. DEFINITION: a decision basis "
   "that evaluates resilience options against a defined business criterion — not a bare spend figure or a generic financial-approval claim."),
  ("Binary. Yes requires a stated appraisal, an option comparison/evaluation, and a defined business criterion, all quote-verifiable. A spend "
   "amount alone, or a generic financial-approval/capital-governance claim with no criterion, is No. The criterion may be avoided loss, "
   "downtime, business interruption, benefit-cost, risk reduction or another explicit basis."),
  ("1. A disclosure describes appraising flood-defence options on a benefit-cost basis using avoided business-interruption loss.\n"
   "2. A company evaluates resilience investments against risk-reduction and service-continuity criteria before approval.\n"
   "3. A report states adaptation options are ranked by avoided loss per pound invested within the capital-allocation process."),
  "A stated appraisal that compares/evaluates resilience options using a defined business criterion (avoided loss, downtime, business interruption, benefit-cost, risk reduction, service capacity, safety).",
  "A spend amount alone (that is A6); a generic 'subject to our capital-approval process' claim with no criterion; a resilience plan (A1); a risk-financing strategy (A10).",
  ["We appraise flood-defence options on a benefit-cost basis, quantifying avoided business-interruption loss against capital cost before approval.",
   "Resilience investments are evaluated against risk-reduction and service-continuity criteria, and only options meeting the threshold proceed.",
   "Adaptation options are ranked by avoided expected loss per pound of capital within our investment-appraisal framework.",
   "Our capital process requires each resilience proposal to state the downtime and safety benefit it delivers relative to cost."],
  ["All investments go through our standard capital-approval process.",
   "We spent GBP 10m on resilience measures last year.",
   "The company applies financial discipline to its investments.",
   "Resilience projects are approved by the investment committee."],
  ["appraisal", "cost-benefit", "benefit-cost ratio", "avoided loss", "risk reduction", "downtime avoided", "business interruption", "option comparison", "decision basis"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "CDP response", "Investment/capital-allocation policy"],
  {"yes_cases": "An appraisal comparing resilience options against a defined business criterion.",
   "no_cases": "Spend figure alone or generic capital-approval claim with no criterion.",
   "distinguishing_test": "Is there a defined criterion (avoided loss/downtime/benefit-cost/risk reduction) used to evaluate resilience options?"},
  0.09,
  S("physical_climate", "appraisal", "always", ["public_company"],
    "Any company investing in resilience can state its appraisal basis.",
    [{"id": "appraisal", "requires": "a stated appraisal/evaluation of resilience options"},
     {"id": "comparison", "requires": "options are compared or evaluated"},
     {"id": "criterion", "requires": "a defined business criterion (avoided loss/service/safety/downtime/business interruption/cost-benefit/risk reduction)"}],
    exclusions=["A6 (resourcing amount)", "A1 (plan)", "A10 (risk financing)"])),

M("A8", 3,
  "Critical supply-chain and logistics resilience actions are implemented",
  "Supplier/logistics continuity control",
  "Whether a named action protects a named critical input, supplier, route or dependency. Replaces C7-supplychain-resilience-actions.",
  ("TRACK operational_resilience (named disruption + control required; non-climate disruption wording is PERMITTED where it protects a named "
   "critical dependency). APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a NAMED resilience action — alternative/dual sourcing, "
   "supplier continuity requirement, buffer inventory, contract contingency, logistics alternative, route redundancy or other control; and "
   "(2) it protects a NAMED critical input, supplier, route or dependency. Boundary: supply-chain/logistics continuity CONTROL here; mapping "
   "the dependency without a control is U6; a utility/technology/communications control is A9. DEFINITION: a concrete, implemented supply or "
   "logistics continuity control tied to a named critical dependency — not a generic 'we work with suppliers' statement."),
  ("Binary. Yes requires a named action and a named critical dependency it protects, both quote-verifiable. Climate attribution is NOT "
   "required on this operational-resilience track, but a named disruption/dependency and a control ARE. 'We work with our suppliers' or a "
   "generic sourcing-policy statement is No. Mapping/assessment with no control is U6, not A8."),
  ("1. A report states dual sourcing was established for a sole-source active ingredient, removing single-supplier dependency.\n"
   "2. A company discloses buffer inventory and an alternative inland logistics route to protect deliveries from port-closure disruption.\n"
   "3. A disclosure describes contractual continuity requirements imposed on its two most critical component suppliers."),
  "A named, implemented supply/logistics continuity control (dual sourcing, buffer stock, route redundancy, contractual continuity) protecting a named critical input, supplier, route or dependency.",
  "'We work with our suppliers' or generic sourcing-policy language; a dependency map with no control (that is U6); a utility/IT/comms control (A9); a future supplier-engagement intention.",
  ["We established dual sourcing for our sole-source active ingredient, eliminating single-supplier dependency on that critical input.",
   "To protect against port-closure disruption we hold eight weeks of buffer inventory and have qualified an alternative inland logistics route.",
   "Our two most critical component suppliers are contractually required to maintain continuity plans and alternative production sites.",
   "We implemented route redundancy for inbound logistics to our main distribution centre after assessing single-route dependency."],
  ["We work closely with our suppliers to manage risk.",
   "Supply-chain resilience is important to our business.",
   "We have a responsible sourcing policy.",
   "The company engages suppliers on sustainability matters."],
  ["dual sourcing", "alternative supplier", "buffer inventory", "route redundancy", "supplier continuity requirement", "contract contingency", "critical input", "single-source"],
  ["Annual Report", "Sustainability/ESG Report", "Operational/supply-chain report", "Risk report", "TCFD/IFRS S2 report"],
  {"yes_cases": "A named implemented supply/logistics control protecting a named critical dependency.",
   "no_cases": "Generic supplier-engagement language or a dependency map with no control.",
   "distinguishing_test": "Is there a specific implemented control (dual sourcing/buffer/route redundancy/contract) tied to a NAMED critical dependency?"},
  0.16,
  S("operational_resilience", "implemented_action", "always", ["public_company"],
    "Any company with critical suppliers/logistics can implement continuity controls; climate wording not required.",
    [{"id": "named_action", "requires": "a named supply/logistics continuity control"},
     {"id": "named_dependency", "requires": "a named critical input, supplier, route or dependency it protects"}],
    exclusions=["U6 (supplier dependency mapping without control)", "A9 (utility/technology/communications control)"])),

M("A9", 3,
  "Critical utility, technology and communications dependencies have resilience controls",
  "Dependency resilience control",
  "Whether the company identifies an alternate supply, redundancy, backup, restoration arrangement, manual workaround or resilience control for a named critical utility, transport, data, technology or communications dependency. NEW measure.",
  ("TRACK operational_resilience (named dependency + control required). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) a NAMED critical utility, transport, data, technology or communications dependency; and (2) an identified resilience CONTROL for it "
   "— alternate supply, redundancy, backup capacity, restoration arrangement or manual workaround. Boundary: utility/technology/comms "
   "continuity CONTROL here; mapping the dependency without a control is U7; a supplier/logistics control is A8. CHANGE: a dependency "
   "ASSESSMENT with no control does NOT count here — it belongs in U7. DEFINITION: a concrete resilience control for a named critical "
   "utility/technology/communications dependency — not an inventory of dependencies."),
  ("Binary. Yes requires a named critical utility/technology/comms dependency AND a resilience control for it, both quote-verifiable. A "
   "dependency assessment or map with no control is No (that is U7). Backup power, redundant connectivity, failover data centres, manual "
   "workarounds and alternate utility supply all qualify as controls."),
  ("1. A report states on-site backup generation and 48-hour fuel reserves protect operations against grid-power loss at all critical sites.\n"
   "2. A company discloses geographically redundant data centres with automated failover for its core transaction systems.\n"
   "3. A disclosure describes diverse network connectivity and a manual fallback process for order processing if primary systems fail."),
  "A resilience control (alternate supply, redundancy, backup capacity, restoration arrangement or manual workaround) for a named critical utility, transport, data, technology or communications dependency.",
  "A dependency assessment/map with no control (that is U7); a supplier/logistics control (A8); a generic 'our systems are resilient' claim; an IT-security statement unrelated to continuity.",
  ["On-site backup generation with 48-hour fuel reserves protects all critical sites against grid-power loss.",
   "Our core transaction systems run across two geographically redundant data centres with automated failover tested annually.",
   "We maintain diverse network connectivity and a documented manual fallback for order processing should primary systems fail.",
   "Critical water-dependent processes have on-site storage and a tankered-supply arrangement to bridge mains interruption."],
  ["We have assessed our dependency on key utilities and technology.",
   "Our critical dependencies include power, water and connectivity.",
   "The company relies on robust IT infrastructure.",
   "We take cybersecurity and system availability seriously."],
  ["backup power", "redundancy", "failover", "alternate supply", "restoration arrangement", "manual workaround", "critical dependency", "diverse connectivity"],
  ["Annual Report", "Sustainability/ESG Report", "Operational/technology report", "Risk report", "Business-continuity disclosure"],
  {"yes_cases": "A resilience control for a named critical utility/technology/communications dependency.",
   "no_cases": "A dependency assessment/map with no control, or a generic resilience claim.",
   "distinguishing_test": "Is there a CONTROL (backup/redundancy/failover/workaround) for a NAMED critical utility/tech/comms dependency — not just an assessment?"},
  0.18,
  S("operational_resilience", "implemented_action", "always", ["public_company"],
    "Every company depends on utilities/technology/communications and can disclose controls.",
    [{"id": "named_dependency", "requires": "a named critical utility/transport/data/technology/communications dependency"},
     {"id": "control", "requires": "an alternate supply, redundancy, backup capacity, restoration arrangement or manual workaround"}],
    exclusions=["U7 (dependency assessment without control)", "A8 (supplier/logistics control)"])),

M("A10", 3,
  "Risk financing addresses physical-climate insurability and residual loss",
  "Risk-financing strategy for physical climate impacts",
  "Whether a physical-risk/insurability disclosure addresses at least one insurability/risk-financing element and describes an action, assessment or strategic response. Replaces C4-insurability-strategy.",
  ("TRACK physical_climate (physical-risk/insurability attribution required). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) a physical-risk/insurability disclosure addressing AT LEAST ONE of — premium or deductible trends, availability/withdrawal of "
   "cover, exclusions, self-insurance/captive/parametric cover, business interruption, uninsured exposure or contingent liquidity; and "
   "(2) a described ACTION, assessment or strategic response. Boundary: risk FINANCING here; resilience resourcing is A6; appraisal is A7. "
   "DEFINITION: a strategic treatment of physical-climate insurability or residual loss with a response — not 'we maintain appropriate "
   "insurance'."),
  ("Binary. Yes requires a named insurability/risk-financing element AND a described action/assessment/strategic response, both "
   "quote-verifiable. 'We maintain appropriate insurance' or a bare statement that the company is insured is No. Captive/parametric cover, "
   "rising premiums, cover withdrawal, business interruption and uninsured/contingent-liquidity treatment all qualify."),
  ("1. A report discloses rising physical-risk premiums and the company's move to a captive and parametric flood cover in response.\n"
   "2. A disclosure quantifies uninsured physical exposure and describes a contingent-liquidity facility held against it.\n"
   "3. A company states insurers have signalled cover withdrawal at two sites and describes its self-insurance and hardening response."),
  "A physical-risk/insurability disclosure addressing at least one named element (premiums/deductibles, availability/withdrawal, exclusions, captive/parametric, business interruption, uninsured exposure, contingent liquidity) with a described response.",
  "'We maintain appropriate insurance'; a bare statement of being insured; an insurance claim with no physical-risk link or response; resilience resourcing (A6); investment appraisal (A7).",
  ["Physical-risk insurance premiums rose sharply, so we established a captive and purchased parametric flood cover for our highest-exposure sites.",
   "We quantify our uninsured physical-climate exposure and hold a contingent-liquidity facility sized against the modelled residual loss.",
   "Insurers signalled potential cover withdrawal at two coastal sites; our response combines self-insurance, deductible increases and accelerated hardening.",
   "Our risk-financing strategy addresses business-interruption cover limits and the growing share of physical exposure retained on our balance sheet."],
  ["We maintain appropriate insurance cover for our operations.",
   "The company has comprehensive insurance arrangements in place.",
   "We review our insurance programme annually.",
   "Insurance is an important part of our risk management."],
  ["premium trend", "deductible", "cover withdrawal", "exclusions", "captive", "parametric cover", "business interruption", "uninsured exposure", "contingent liquidity", "self-insurance"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "CDP response", "Financial statements"],
  {"yes_cases": "A physical-insurability/risk-financing element with a described action/assessment/strategic response.",
   "no_cases": "'Appropriate insurance' or bare insured statement with no element or response.",
   "distinguishing_test": "Does it address a specific physical-insurability/residual-loss element AND a response — beyond 'we are insured'?"},
  0.11,
  S("physical_climate", "risk_financing", "always", ["public_company"],
    "Any company facing physical risk can disclose its risk-financing/insurability response.",
    [{"id": "insurability_element", "requires": "at least one of premium/deductible trend, availability/withdrawal, exclusions, captive/parametric, business interruption, uninsured exposure, contingent liquidity"},
     {"id": "response", "requires": "a described action, assessment or strategic response"}],
    exclusions=["A6 (resilience resourcing)", "A7 (investment appraisal)"])),

M("A11", 3,
  "Material chronic-hazard effects on water, workforce and productive capacity are managed",
  "Chronic-hazard operational continuity control",
  "Whether a water, heat, smoke, drought or chronic-condition control identifies the exposed business activity/people/site and states an operational threshold, protocol, coverage, action or performance indicator. Replaces C8-water-security and C10-workforce-heat-stress.",
  ("TRACK physical_climate (chronic physical-hazard attribution required). APPLICABILITY if_material — applies ONLY if the materiality "
   "profile identifies water dependency, outdoor/non-conditioned workforce exposure, heat/smoke exposure, drought exposure or equivalent "
   "chronic physical risk; otherwise a non-applicable determination, not an automatic No. ATOMIC PREDICATES, all required: (1) a water, "
   "heat, smoke, drought or chronic-condition CONTROL; (2) it identifies the exposed business activity, people or site; and (3) it states an "
   "operational threshold, protocol, coverage, action or performance indicator. Boundary: CHRONIC-hazard continuity here; acute hardening is "
   "A2; mapping with no control is U-pillar. DEFINITION: a managed response to a material chronic hazard affecting water, workforce or "
   "productive capacity — not a generic health-and-safety or water-stewardship statement."),
  ("Binary. Yes requires a chronic-hazard control, an identified exposed activity/people/site, and a threshold/protocol/coverage/action/KPI, "
   "all quote-verifiable. A generic health-and-safety statement, a water-stewardship claim, or a mere mention of heat/drought with no control "
   "is No. Applies only where the chronic hazard is material to the company."),
  ("1. A report describes a heat-stress protocol with wet-bulb thresholds that trigger shift changes for outdoor workers at named sites.\n"
   "2. A company discloses water-recycling and abstraction limits managing drought exposure at its water-dependent plants, with coverage stated.\n"
   "3. A disclosure sets a wildfire-smoke air-quality protocol protecting workforce and production at facilities in fire-prone regions."),
  "A chronic-hazard (water/heat/smoke/drought) control that names the exposed activity/people/site and states an operational threshold, protocol, coverage, action or performance indicator.",
  "A generic health-and-safety statement; a water-stewardship or water-reduction claim with no continuity link; a bare hazard mention; acute physical hardening (A2); a dependency assessment with no control.",
  ["Our heat-stress protocol sets wet-bulb thresholds that trigger adjusted shift patterns and rest breaks for outdoor workers at our 12 highest-exposure sites.",
   "We manage drought exposure at our six water-dependent plants through recycling, abstraction limits and on-site storage, covering 100% of at-risk capacity.",
   "A wildfire-smoke air-quality protocol suspends outdoor operations above defined PM2.5 thresholds, protecting workforce and production at fire-prone sites.",
   "Chronic water-stress management includes a site-level water-intensity KPI and a reduction target for our most drought-exposed facilities."],
  ["We are committed to the health and safety of our employees.",
   "The company is a responsible steward of water resources.",
   "We recognise that heat and drought can affect our operations.",
   "Water efficiency is part of our environmental programme."],
  ["heat-stress protocol", "wet-bulb threshold", "water recycling", "drought exposure", "smoke/air-quality protocol", "chronic hazard", "exposed workforce", "productive capacity", "coverage"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "TCFD/IFRS S2 report", "Operational/HSE report"],
  {"yes_cases": "A chronic-hazard control naming the exposed activity/people/site with a threshold/protocol/coverage/action/KPI.",
   "no_cases": "Generic H&S, water-stewardship, or a bare hazard mention.",
   "distinguishing_test": "Is there a CONTROL for a material chronic hazard (water/heat/smoke/drought) tied to exposed people/sites and a threshold/action — not generic H&S or stewardship?"},
  0.10,
  S("physical_climate", "implemented_action", "if_material", ["material_chronic_hazard"],
    "Applies only where water/heat/smoke/drought/chronic exposure is material; otherwise non-applicable.",
    [{"id": "chronic_control", "requires": "a water/heat/smoke/drought/chronic-condition control"},
     {"id": "exposed_target", "requires": "an identified exposed business activity, people or site"},
     {"id": "operational_detail", "requires": "an operational threshold, protocol, coverage, action or performance indicator"}],
    exclusions=["A2 (acute physical hardening)", "U-pillar (chronic-hazard assessment without control)"])),
]



# ══════════════════════ PILLAR P — Maintain critical operations ══════════════════════
MEASURES += [

M("P1", 4,
  "A formal business-continuity management system covers material critical activities",
  "Business-continuity management system (BCMS)",
  "Whether a system, programme or policy has designated ownership, a defined scope covering material business units/critical activities, and a review/maintenance cycle. Replaces part of D1-business-continuity-tested.",
  ("TRACK operational_resilience (named-disruption-and-control attribution; climate wording NOT required). APPLICABILITY always. "
   "ATOMIC PREDICATES, all required: (1) a business-continuity SYSTEM, programme or policy; (2) designated OWNERSHIP; (3) a defined SCOPE "
   "covering material business units/critical activities (see coverageRule); and (4) a review/maintenance CYCLE. Boundary: the managed SYSTEM "
   "here; recovery objectives are P2; crisis command is P3; climate-scenario integration is P4; exercising is P6. DEFINITION: a managed, "
   "owned, scoped and maintained BCMS — not the bare existence of 'a BCP' or a single local emergency plan."),
  ("Binary. Yes requires a system/programme/policy, designated ownership, a defined material scope, and a review/maintenance cycle, all "
   "quote-verifiable. Bare 'we have a business-continuity plan', or one local site emergency plan, is No. Alignment to ISO 22301 with "
   "ownership, scope and review is a strong Yes signal."),
  ("1. A report states a Group BCMS aligned to ISO 22301, owned by the Chief Operating Officer, covering all critical business services and reviewed annually.\n"
   "2. A disclosure describes a continuity programme with a named owner, a scope defined over its material business units, and a defined maintenance cycle.\n"
   "3. A company documents a continuity-management policy covering its critical activities with assigned ownership and an annual review."),
  "A continuity system/programme/policy with designated ownership, a defined scope over material units/critical activities, and a review/maintenance cycle.",
  "Bare 'we have a BCP'; a single local emergency plan; a continuity claim with no owner, scope or review cycle; recovery objectives alone (P2); a crisis-contact list (P3).",
  ["Our Group business-continuity management system is aligned to ISO 22301, owned by the COO, covers all critical business services and is reviewed annually.",
   "The continuity programme has a named owner, a scope defined across our eight material business units, and a documented annual maintenance cycle.",
   "We operate a continuity-management policy covering our critical activities, with assigned ownership and a formal review each year.",
   "Our BCMS scope covers 100% of services classified business-critical, under a designated Resilience Director and a defined review calendar."],
  ["We have a business-continuity plan in place.",
   "The company is prepared for operational disruptions.",
   "Each site maintains its own local emergency procedures.",
   "Business continuity is managed as part of our operations."],
  ["BCMS", "ISO 22301", "continuity programme", "designated owner", "defined scope", "critical activities", "review cycle", "maintenance cycle", "material business units"],
  ["Annual Report", "Sustainability/ESG Report", "Risk report", "Business-continuity disclosure", "Operational report"],
  {"yes_cases": "An owned, scoped, maintained BCMS covering material critical activities.",
   "no_cases": "Bare 'a BCP', a single local plan, or no owner/scope/review.",
   "distinguishing_test": "Is there a MANAGED system (owner + material scope + review cycle) — not just the existence of a plan?"},
  0.20,
  S("operational_resilience", "capability", "always", ["public_company"],
    "A managed continuity system is expected of any company with critical activities.",
    [{"id": "system", "requires": "a business-continuity system, programme or policy"},
     {"id": "ownership", "requires": "designated ownership"},
     {"id": "scope", "requires": "a defined scope covering material business units/critical activities"},
     {"id": "review_cycle", "requires": "a review/maintenance cycle"}],
    coverage={"populationDefinition": "material business units / business-critical activities",
              "acceptedDenominators": ["critical_activities", "business_units", "critical_services"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["all critical business services", "eight material business units", "100% of business-critical services"],
              "doesNotCount": ["we have a BCP", "one local emergency plan"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["P2 (recovery objectives)", "P3 (crisis command)", "P4 (climate-scenario integration)", "P6 (exercising)"]),
  coverage_whitelist=["all critical business services", "eight material business units", "100% of business-critical services"]),

M("P2", 4,
  "Continuity strategies and measurable recovery objectives are defined for critical activities",
  "Actionable continuity design",
  "Whether a continuity arrangement sets recovery strategies and recovery objectives for critical activities, systems, people, facilities or third parties. Replaces part of D1-business-continuity-tested.",
  ("TRACK operational_resilience (named-disruption-and-control attribution). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) a continuity arrangement that sets RECOVERY STRATEGIES; and (2) measurable RECOVERY OBJECTIVES for critical activities, systems, "
   "people, facilities or third parties — qualifying metrics include RTO, RPO, maximum tolerable downtime, a service-level threshold, "
   "alternative capacity or a restoration target. Boundary: the actionable DESIGN (strategies + objectives) here; the managing system is "
   "P1; exercising is P6. DEFINITION: a continuity design with usable recovery strategies AND at least one measurable recovery objective — "
   "not a plan with no recovery objective."),
  ("Binary. Yes requires both a recovery strategy and at least one measurable recovery objective (RTO/RPO/MTD/service-level/alternative "
   "capacity/restoration target), quote-verifiable. A plan with no recovery objective, or a vague 'we will restore operations' with no "
   "metric, is No. The objective must be measurable, not aspirational."),
  ("1. A disclosure sets RTOs and RPOs for each critical system plus alternative-site recovery strategies.\n"
   "2. A company defines maximum tolerable downtime per critical activity and the recovery strategy (workaround, alternate capacity) that meets it.\n"
   "3. A report states service-level restoration targets and the continuity strategies designed to achieve them for its critical services."),
  "A continuity design with recovery strategies AND at least one measurable recovery objective (RTO, RPO, maximum tolerable downtime, service-level threshold, alternative capacity, restoration target).",
  "A plan with no recovery objective; a vague 'we will restore operations quickly'; a continuity system with no strategy/metric (that is P1); an exercise record (P6).",
  ["We define RTOs and RPOs for every critical system and maintain alternative-site recovery strategies to meet them.",
   "Each critical activity has a maximum tolerable downtime and a documented recovery strategy — workaround or alternate capacity — designed to meet it.",
   "Our continuity design sets service-level restoration targets for critical services and the specific strategies that deliver them.",
   "Recovery objectives (RTO 4 hours, RPO 15 minutes) are defined for core transaction processing, with failover capacity sized accordingly."],
  ["We aim to restore operations as quickly as possible after any disruption.",
   "Our business-continuity plan covers recovery of critical functions.",
   "The company is committed to operational resilience.",
   "We have procedures to recover from incidents."],
  ["recovery objective", "RTO", "RPO", "maximum tolerable downtime", "service-level threshold", "restoration target", "recovery strategy", "alternative capacity"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Operational/technology report", "Sustainability/ESG Report"],
  {"yes_cases": "Recovery strategies plus at least one measurable recovery objective for critical activities.",
   "no_cases": "A plan with no recovery objective or metric.",
   "distinguishing_test": "Is there a measurable recovery objective (RTO/RPO/MTD/service target) AND a strategy to meet it — not just 'restore quickly'?"},
  0.14,
  S("operational_resilience", "capability", "always", ["public_company"],
    "Measurable recovery objectives are expected of any company with critical activities.",
    [{"id": "recovery_strategy", "requires": "a defined recovery strategy"},
     {"id": "recovery_objective", "requires": "a measurable recovery objective (RTO/RPO/MTD/service-level/alternative capacity/restoration target)"}],
    exclusions=["P1 (continuity system)", "P6 (exercising)"])),

M("P3", 4,
  "Crisis and incident management provides defined command and communication arrangements",
  "Crisis/incident-management structure",
  "Whether a disclosure assigns incident roles/authority, describes a crisis-command or escalation structure, and names at least one stakeholder-communication route relevant to a disruption. NEW measure.",
  ("TRACK operational_resilience (named-disruption-and-control attribution). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) assigned incident ROLES/authority; (2) a described crisis-command or escalation STRUCTURE; and (3) at least one named "
   "stakeholder-COMMUNICATION route (employees, customers, suppliers, regulators, communities or investors) relevant to a disruption. "
   "Boundary: crisis COMMAND + communication here; the continuity system is P1; recovery objectives are P2; pre-event triggers are P5. "
   "DEFINITION: a defined crisis-management structure with roles, command/escalation and a stakeholder-communication route — not an "
   "emergency phone number or a generic crisis-policy claim."),
  ("Binary. Yes requires assigned roles/authority, a command/escalation structure, and a named stakeholder-communication route, all "
   "quote-verifiable. An emergency contact number alone, or a generic 'we have a crisis-management policy', is No. Communication must be to "
   "a named stakeholder group relevant to a disruption."),
  ("1. A report describes a crisis-management team with defined roles and decision authority, an escalation structure, and defined communication routes to employees, customers and regulators.\n"
   "2. A disclosure sets out an incident-command structure with tiered escalation and a stakeholder-communication plan for major disruptions.\n"
   "3. A company documents crisis roles, an activation/escalation protocol, and how it communicates with investors and customers during an incident."),
  "An assigned-role/authority crisis structure with a command/escalation arrangement and at least one named stakeholder-communication route for a disruption.",
  "An emergency contact number; a generic crisis-management-policy claim; a continuity system with no crisis structure (P1); a plan with no communication route; media-relations boilerplate.",
  ["Our crisis-management team has defined roles and decision authority, a tiered escalation structure, and set communication routes to employees, customers and regulators during a major incident.",
   "We operate an incident-command structure with clear escalation tiers and a stakeholder-communication plan covering staff, suppliers and investors.",
   "Crisis roles and an activation/escalation protocol are documented, together with how we communicate with customers and regulators during a disruption.",
   "Our Gold-Silver-Bronze command structure assigns authority at each tier and defines internal and external communication responsibilities."],
  ["In an emergency, staff should call the incident hotline.",
   "The company has a crisis-management policy.",
   "We are prepared to respond to incidents as they arise.",
   "Our communications team handles media enquiries."],
  ["crisis management", "incident command", "escalation structure", "defined roles", "decision authority", "stakeholder communication", "activation protocol", "command tiers"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Operational report", "Sustainability/ESG Report"],
  {"yes_cases": "A crisis structure with roles/authority, command/escalation, and a named stakeholder-communication route.",
   "no_cases": "An emergency number or generic crisis-policy claim.",
   "distinguishing_test": "Are crisis roles/authority, a command/escalation structure, AND a stakeholder-communication route all present — not just a policy or hotline?"},
  0.14,
  S("operational_resilience", "capability", "always", ["public_company"],
    "A defined crisis-command and communication structure is expected of any company.",
    [{"id": "roles", "requires": "assigned incident roles/authority"},
     {"id": "command_structure", "requires": "a crisis-command or escalation structure"},
     {"id": "communication", "requires": "at least one named stakeholder-communication route relevant to a disruption"}],
    exclusions=["P1 (continuity system)", "P2 (recovery objectives)", "P5 (pre-event triggers)"])),

M("P4", 4,
  "Continuity arrangements explicitly address material weather, natural-hazard or physical-climate scenarios",
  "Climate integration in continuity planning",
  "Whether a continuity, emergency-response, disaster-recovery or crisis-management plan explicitly covers a material physical hazard, weather/natural-disaster scenario or physical climate impact and states a corresponding control, activation or recovery approach. Replaces part of D1-business-continuity-tested. CRITICAL-GATE measure.",
  ("TRACK physical_climate (explicit physical-climate/weather/natural-hazard attribution required). APPLICABILITY always. "
   "CRITICAL GATE (criticalMeasureSet [U1,U2,A1,P4]). ATOMIC PREDICATES, all required: (1) a continuity/emergency-response/disaster-recovery/"
   "crisis-management plan; (2) it EXPLICITLY covers a material physical hazard, weather/natural-disaster scenario or physical climate "
   "impact; and (3) it states a corresponding control, activation or recovery approach. Boundary: the CLIMATE INTEGRATION in continuity here; "
   "a generic BCMS is P1; a physical-risk disclosure NOT connected to continuity is U-pillar; pre-event triggers are P5. DEFINITION: "
   "continuity planning that is explicitly connected to a material physical-climate scenario with a response — the bridge between physical "
   "risk and operational continuity. NOT a generic BCP, and NOT a climate-risk disclosure that never reaches continuity."),
  ("Binary. Yes requires a continuity/ER/DR/crisis plan, explicit coverage of a material physical hazard/weather scenario, AND a "
   "corresponding control/activation/recovery approach, all quote-verifiable. A generic BCP with no climate scenario, a climate-risk "
   "disclosure unconnected to continuity, or a generic natural-disaster reference with no material scenario/control is No."),
  ("1. A report states the continuity plan includes a named flood scenario for its two highest-exposure sites, with activation triggers and a recovery approach.\n"
   "2. A disaster-recovery plan explicitly covers hurricane and extreme-heat scenarios affecting operations, with corresponding response and recovery actions.\n"
   "3. A company's crisis plan integrates wildfire and water-curtailment scenarios for exposed facilities, each with a defined control and activation step."),
  "A continuity/ER/DR/crisis plan that explicitly covers a material physical hazard or weather/natural-disaster scenario AND states a corresponding control, activation or recovery approach.",
  "A generic BCP with no climate scenario (that is P1); a climate-risk disclosure not connected to continuity (U-pillar); a generic 'we plan for natural disasters' with no material scenario or control; a hazard assessment with no continuity response.",
  ["Our continuity plan includes a named flood scenario for our two highest-exposure sites, with activation triggers and a defined recovery approach.",
   "The disaster-recovery plan explicitly covers hurricane and extreme-heat scenarios, each with corresponding response and recovery actions.",
   "Our crisis plan integrates wildfire and water-curtailment scenarios for exposed facilities, with a defined control and activation step for each.",
   "Continuity arrangements address a 1-in-100-year storm scenario at our coastal terminal, including shutdown, protection and restoration procedures."],
  ["We maintain a business-continuity plan for our operations.",
   "The company assesses physical climate risks across its sites.",
   "We are prepared for a range of operational disruptions.",
   "Natural disasters are considered in our risk management."],
  ["continuity plan flood scenario", "disaster-recovery climate", "weather scenario", "natural-hazard activation", "physical climate continuity", "recovery approach", "activation trigger", "named hazard scenario"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "TCFD/IFRS S2 report", "Sustainability/ESG Report"],
  {"yes_cases": "Continuity planning explicitly tied to a material physical hazard/weather scenario with a control/activation/recovery approach.",
   "no_cases": "Generic BCP, or climate disclosure not connected to continuity.",
   "distinguishing_test": "Does a continuity/DR/crisis plan name a material physical-climate scenario AND a response — bridging physical risk to continuity?"},
  0.16,
  S("physical_climate", "capability", "always", ["public_company"],
    "Connecting continuity planning to material physical-climate scenarios is expected; critical-gate measure.",
    [{"id": "continuity_plan", "requires": "a continuity/emergency-response/disaster-recovery/crisis-management plan"},
     {"id": "climate_scenario", "requires": "explicit coverage of a material physical hazard, weather/natural-disaster scenario or physical climate impact"},
     {"id": "response", "requires": "a corresponding control, activation or recovery approach"}],
    exclusions=["P1 (generic continuity system)", "U-pillar (physical-risk disclosure not connected to continuity)", "P5 (pre-event triggers)"])),

M("P5", 4,
  "Early warning or predefined triggers activate protective or continuity actions",
  "Pre-event action trigger",
  "Whether a hazard, forecast, threshold or warning source is tied to a named pre-event protective/continuity action. Replaces D2-early-warning-triggers.",
  ("TRACK physical_climate (hazard/forecast/warning attribution required). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) a hazard, forecast, threshold or warning SOURCE; and (2) it is tied to a NAMED pre-event protective/continuity ACTION — safe "
   "shutdown, inventory move, workforce protocol, evacuation, supplier switch or asset protection. Boundary: the TRIGGER-to-action link "
   "here; crisis command is P3; climate scenario in continuity is P4. DEFINITION: a warning/threshold connected to a specific pre-event "
   "action — not weather monitoring with no action link."),
  ("Binary. Yes requires a warning/forecast/threshold source AND a named pre-event action it triggers, both quote-verifiable. Weather "
   "monitoring with no trigger or action link is No. The action must be pre-event and protective/continuity-oriented (not post-event "
   "recovery, which is R)."),
  ("1. A disclosure ties flood-forecast thresholds to a safe-shutdown and equipment-protection protocol at exposed sites.\n"
   "2. A company links heatwave warnings to a predefined workforce protocol and production-rescheduling action.\n"
   "3. A report states storm warnings trigger inventory relocation and asset-protection steps at coastal facilities."),
  "A hazard/forecast/threshold/warning source tied to a named pre-event protective or continuity action (safe shutdown, inventory move, workforce protocol, evacuation, supplier switch, asset protection).",
  "Weather monitoring with no trigger/action link; a generic 'we monitor forecasts' claim; post-event recovery (that is R1/R2); a continuity plan with no activation trigger.",
  ["Flood-forecast thresholds trigger our safe-shutdown and equipment-protection protocol at exposed sites.",
   "Heatwave warnings activate a predefined workforce protocol and production-rescheduling action at affected plants.",
   "When storm warnings are issued, we relocate inventory and execute asset-protection steps at our coastal facilities.",
   "Defined river-level thresholds trigger pre-emptive barrier deployment and evacuation at our two highest-flood-risk sites."],
  ["We monitor weather forecasts closely.",
   "The company tracks potential hazards to its operations.",
   "Early warning is part of our risk management.",
   "We receive meteorological alerts for our sites."],
  ["early warning", "forecast threshold", "trigger", "safe shutdown", "inventory move", "workforce protocol", "evacuation", "asset protection", "pre-event action"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Operational/plant report", "Sustainability/ESG Report"],
  {"yes_cases": "A warning/threshold source tied to a named pre-event protective/continuity action.",
   "no_cases": "Weather monitoring with no action link.",
   "distinguishing_test": "Is a warning/forecast/threshold tied to a SPECIFIC pre-event action — not just monitoring?"},
  0.11,
  S("physical_climate", "capability", "always", ["public_company"],
    "Pre-event triggers are relevant to any company exposed to forecastable hazards.",
    [{"id": "warning_source", "requires": "a hazard, forecast, threshold or warning source"},
     {"id": "triggered_action", "requires": "a named pre-event protective/continuity action tied to it"}],
    exclusions=["P3 (crisis command)", "P4 (climate scenario in continuity)", "R1/R2 (post-event performance)"])),

M("P6", 4,
  "Continuity and crisis arrangements are exercised with defined scope and recorded results",
  "Test/exercise performance",
  "Whether the company discloses an exercise/test of continuity, crisis or recovery arrangements; identifies the population/scenario/scope; and records an outcome, finding, corrective action or change. Replaces part of D1-business-continuity-tested.",
  ("TRACK operational_resilience (named-disruption-and-control attribution). APPLICABILITY always. ATOMIC PREDICATES, all required: "
   "(1) a disclosed EXERCISE/test of continuity, crisis or recovery arrangements; (2) an identified population/scenario/SCOPE (see "
   "coverageRule); and (3) a recorded OUTCOME, finding, corrective action or change. Boundary: the EXERCISE + result here; the system is P1; "
   "recovery objectives are P2; actual event performance is R1; learning across events is L2. DEFINITION: evidence of a scoped test with a "
   "recorded result — not a promise to test, a training event with no test scope, or a test with no result/follow-up."),
  ("Binary. Yes requires a disclosed exercise/test, an identified scope/scenario, AND a recorded outcome/finding/corrective action, all "
   "quote-verifiable. A promise to test, a generic 'we conduct exercises', a training event with no test scope, or a test with no "
   "result/follow-up is No."),
  ("1. A report states a full continuity exercise simulated a data-centre outage across all critical services, with findings and corrective actions recorded.\n"
   "2. A company discloses a crisis simulation of a flood scenario at a named site, the participants, and the resulting plan changes.\n"
   "3. A disclosure describes an annual recovery test of core systems, its scope, and the issues found and remediated."),
  "A disclosed exercise/test with an identified population/scenario/scope AND a recorded outcome, finding, corrective action or change.",
  "A promise to test; a generic 'we run exercises'; a training event with no test scope; a test with no result or follow-up; actual event recovery performance (R1); cross-event learning (L2).",
  ["We ran a full continuity exercise simulating a data-centre outage across all critical services; findings and corrective actions were recorded and tracked to closure.",
   "A crisis simulation of a flood scenario at our main plant involved the crisis team and site leadership, and resulted in three documented plan changes.",
   "Our annual recovery test covered core transaction systems; the scope, the issues found and the remediation are documented.",
   "We exercised our supplier-disruption playbook against a sole-source failure scenario, recorded the gaps identified, and updated the plan."],
  ["We will test our continuity plans regularly.",
   "The company conducts business-continuity exercises.",
   "Staff receive training on emergency procedures.",
   "Our plans are reviewed periodically."],
  ["exercise", "test", "simulation", "scenario", "scope", "findings", "corrective action", "plan change", "recorded result"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Operational report", "Sustainability/ESG Report"],
  {"yes_cases": "A scoped exercise/test with a recorded outcome, finding or corrective action.",
   "no_cases": "A promise to test, a training event, or a test with no result.",
   "distinguishing_test": "Was an exercise actually RUN with a defined scope AND a recorded result/follow-up — not planned or training only?"},
  0.13,
  S("operational_resilience", "exercise", "always", ["public_company"],
    "Exercising continuity/crisis arrangements is expected of any company with such arrangements.",
    [{"id": "exercise", "requires": "a disclosed exercise/test of continuity, crisis or recovery arrangements"},
     {"id": "scope", "requires": "an identified population/scenario/scope"},
     {"id": "result", "requires": "a recorded outcome, finding, corrective action or change"}],
    coverage={"populationDefinition": "critical activities/scenarios exercised",
              "acceptedDenominators": ["critical_services_tested", "scenarios_exercised", "sites_exercised"],
              "thresholdMode": "materiality_adjusted", "defaultThreshold": 0.50,
              "acceptedPhrases": ["all critical services", "flood scenario at main plant", "core transaction systems"],
              "doesNotCount": ["we will test", "we run exercises (no scope/result)", "training only"],
              "nonApplicableHandling": "exclude_before_scoring_with_rationale"},
    exclusions=["P1 (continuity system)", "P2 (recovery objectives)", "R1 (actual event performance)", "L2 (cross-event learning)"]),
  coverage_whitelist=["all critical services", "flood scenario at main plant", "core transaction systems", "sole-source failure scenario"]),
]

# ═══════════════════════════ PILLAR R — Respond and recover ═══════════════════════════
MEASURES += [

M("R1", 5,
  "Actual recovery performance after material disruption is disclosed against an objective or service threshold",
  "Actual recovery performance",
  "Whether a named event is linked to a recovery metric or service/operating result and compared with a stated target, threshold, expected service level or objectively bounded recovery outcome. Replaces D3-recovery-performance.",
  ("TRACK performance (event_or_exercise attribution required). APPLICABILITY if_event_occurred — applies ONLY when the company has "
   "experienced a material/disclosed disruption in the measurement period; ABSENCE of a qualifying event is an applicability "
   "determination, NOT an automatic No. ATOMIC PREDICATES, all required: (1) a NAMED event; (2) linked to a recovery metric or "
   "service/operating result; and (3) COMPARED with a stated target, threshold, expected service level or objectively bounded recovery "
   "outcome. Boundary: actual recovery PERFORMANCE here; an RTO target with no event is P2; impact quantification is R2; learning is L2. "
   "DEFINITION: evidence that an actual disruption was recovered against an objective — not an RTO target without event performance, and "
   "not anecdotal 'operations resumed quickly'."),
  ("Binary. Yes requires a named event, a recovery metric/result, AND a comparison to a target/threshold/service level, all "
   "quote-verifiable. An RTO target with no event performance, or anecdotal 'operations resumed quickly', is No. If NO qualifying event "
   "occurred in the period, treat as non-applicable (exclude), not No."),
  ("1. A report states that after the June flood, the affected site was restored within 18 hours against a 24-hour RTO.\n"
   "2. A company discloses that following a hurricane, service was recovered to 95% within two days, meeting its service-level target.\n"
   "3. A disclosure links a named power-loss event to the time taken to restore critical systems, compared with the recovery objective."),
  "A named disruption linked to a recovery metric/service result AND compared with a stated target, threshold, expected service level or bounded recovery outcome.",
  "An RTO/RPO target with no actual event performance (that is P2); anecdotal 'operations resumed quickly'; an impact figure with no recovery comparison (R2); no qualifying event in the period (non-applicable, not No).",
  ["Following the June flood at our Midlands site, operations were restored within 18 hours against our 24-hour recovery-time objective.",
   "After Hurricane X, we recovered service to 95% of normal within two days, meeting our stated service-level recovery target.",
   "The December grid-outage event was contained with critical systems restored in 3 hours, inside the 4-hour RTO.",
   "Our main plant resumed full output nine days after the storm, ahead of the 14-day recovery objective set in our continuity plan."],
  ["We aim to recover operations within our target recovery times.",
   "The company recovered quickly from recent disruptions.",
   "Our recovery-time objective for critical systems is four hours.",
   "Operations resumed promptly after the incident."],
  ["recovery performance", "restored within", "against RTO", "service recovered", "met target", "named event", "recovery outcome", "service-level threshold"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Operational report", "Sustainability/ESG Report"],
  {"yes_cases": "A named event recovered and measured against a stated objective/threshold.",
   "no_cases": "An RTO target with no event, or anecdotal quick recovery.",
   "distinguishing_test": "Is an actual event's recovery measured AGAINST a stated target/service level — not just a target or an anecdote?"},
  0.07,
  S("performance", "outcome", "if_event_occurred", ["material_disruption_in_period"],
    "Applies only when a material/disclosed disruption occurred; absence is non-applicable, not No.",
    [{"id": "named_event", "requires": "a named material disruption event"},
     {"id": "recovery_metric", "requires": "a recovery metric or service/operating result linked to the event"},
     {"id": "comparison", "requires": "comparison with a stated target, threshold, expected service level or bounded recovery outcome"}],
    exclusions=["P2 (RTO target with no event)", "R2 (impact quantification)", "L2 (learning)"])),

M("R2", 5,
  "Operational and financial impacts of material disruptions are measured and disclosed",
  "Material-disruption impact measurement",
  "Whether the company quantifies one or more relevant effects of a material disruption and identifies the event or reporting period to which it relates. Replaces E1-incident-loss-metrics and the historic-event portion of B6-financial-impact.",
  ("TRACK performance (event_or_exercise attribution required). APPLICABILITY if_event_occurred — applies when a material/disclosed "
   "disruption occurs OR when the company reports a relevant incident metric. ATOMIC PREDICATES, all required: (1) the company QUANTIFIES "
   "one or more relevant effects — downtime, lost production/service, revenue/EBITDA/cash-flow impact, business interruption, repair cost, "
   "customer impact, insurance recovery or similar; and (2) it IDENTIFIES the event or reporting period to which it relates. CHANGE FROM "
   "LEGACY: do NOT require an improving trend — a worse hazard year or better reporting does not demonstrate weaker management by itself. "
   "Boundary: impact QUANTIFICATION here; recovery-vs-target is R1; forward-looking modelling is U4. DEFINITION: measured impact of an "
   "actual disruption tied to the event/period — not a forward estimate and not an unquantified mention."),
  ("Binary. Yes requires a quantified impact AND an identified event/period, both quote-verifiable. Do NOT require an improving trend. A "
   "forward-looking impact estimate (that is U4), or an unquantified 'the storm affected operations', is No. If no qualifying event/metric, "
   "treat as non-applicable."),
  ("1. A report quantifies 12 days of lost production and GBP 8m business-interruption cost from a named flood event.\n"
   "2. A company discloses the revenue and repair-cost impact of a hurricane in the reporting period.\n"
   "3. A disclosure reports downtime hours and insured/uninsured loss from a named power-outage incident."),
  "A quantified operational/financial impact (downtime, lost production/service, revenue/EBITDA/cash-flow, business interruption, repair cost, customer impact, insurance recovery) tied to a named event or reporting period.",
  "A forward-looking impact estimate (that is U4); an unquantified 'the storm affected us'; recovery time vs target (R1); a demand for an improving trend (removed); no qualifying event/metric (non-applicable).",
  ["The June flood caused 12 days of lost production and GBP 8m of business-interruption cost, net of GBP 5m insurance recovery.",
   "Hurricane X reduced quarterly revenue by GBP 15m and incurred GBP 6m of repair cost, as disclosed for the reporting period.",
   "A regional power outage caused 36 hours of downtime at two sites, with GBP 2.1m uninsured loss in the year.",
   "Severe heat in 2025 cut output by 7% at our affected plants, quantified as GBP 4m lost contribution."],
  ["Extreme weather affected our operations during the year.",
   "We experienced some disruption from a storm event.",
   "The company may face financial impacts from physical climate risks.",
   "Climate events could cost us up to GBP 50m by 2030."],
  ["downtime", "lost production", "business interruption cost", "revenue impact", "repair cost", "insurance recovery", "quantified loss", "named event", "reporting period"],
  ["Annual Report", "Financial statements", "Risk report", "Sustainability/ESG Report", "CDP response"],
  {"yes_cases": "A quantified impact of an actual disruption tied to a named event/period.",
   "no_cases": "A forward estimate, an unquantified mention, or no event.",
   "distinguishing_test": "Is an ACTUAL event's impact quantified and tied to the event/period — not a forward projection or a vague mention?"},
  0.08,
  S("performance", "outcome", "if_event_occurred", ["material_disruption_in_period", "incident_metric_reported"],
    "Applies when a material disruption occurs or an incident metric is reported; improving trend not required.",
    [{"id": "quantified_impact", "requires": "a quantified operational/financial effect (downtime/lost production/revenue/business interruption/repair/customer/insurance)"},
     {"id": "event_identified", "requires": "the event or reporting period to which it relates"}],
    exclusions=["R1 (recovery vs target)", "U4 (forward-looking impact modelling)"])),
]

# ═══════════════════════ PILLAR L — Measure, learn and improve ═══════════════════════
MEASURES += [

M("L1", 6,
  "Resilience performance or residual physical-climate exposure is monitored against a dated target or risk tolerance",
  "Progress/risk monitoring system",
  "Whether a quantified and dated resilience target, residual-risk limit or risk-tolerance metric has a baseline/denominator and reported progress, current result or variance. Replaces E2-targets-progress; absorbs B7-gross-residual-exposure as supporting evidence.",
  ("TRACK performance (event_or_exercise/monitoring attribution). APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a QUANTIFIED "
   "and DATED resilience target, residual-risk limit or risk-tolerance metric; (2) a BASELINE or denominator; and (3) reported PROGRESS, "
   "current result or variance. Boundary: ongoing monitoring/targets here; one-off exposure numbers belong in U-pillar; closed-loop learning "
   "is L2. IMPLEMENTATION NOTE (spec): gross-versus-residual exposed value remains a strong qualifying metric for L1 where relevant, but it "
   "is NOT a universal standalone measure of management effectiveness. DEFINITION: a dated, quantified target or risk-tolerance metric with "
   "a baseline and current progress — not a broad ambition, a one-off exposure number, or a target with no progress/status."),
  ("Binary. Yes requires a quantified+dated target/limit/tolerance, a baseline/denominator, AND reported progress/current result/variance, "
   "all quote-verifiable. A broad ambition, a one-off exposure figure with no target, or a target with no progress/current status is No. "
   "Gross-vs-residual exposed value qualifies where relevant but is not required."),
  ("1. A report sets a dated target to reduce residual flood-exposed value by 40% by 2028 from a 2023 baseline, and reports current progress.\n"
   "2. A company discloses a risk-tolerance limit for business-interruption exposure and its current position against that limit.\n"
   "3. A disclosure tracks a resilience KPI (e.g. % critical sites hardened) against a dated target with year-on-year progress."),
  "A quantified, dated resilience target / residual-risk limit / risk-tolerance metric with a baseline or denominator AND reported progress, current result or variance.",
  "A broad resilience ambition with no metric; a one-off exposure number with no target (U-pillar); a target with no baseline or no current progress; closed-loop learning (L2).",
  ["We target a 40% reduction in residual flood-exposed asset value by 2028 from a 2023 baseline, and report 22% achieved to date.",
   "Our risk-tolerance limit for annual business-interruption exposure is GBP 20m; we are currently within tolerance at GBP 14m.",
   "We track the percentage of critical sites meeting our resilience standard against a dated target, reporting 68% versus an 80% 2026 goal.",
   "Gross-versus-residual exposed value is monitored against a residual-risk ceiling, with current-year variance disclosed."],
  ["We aim to improve the resilience of our business over time.",
   "Our total climate-exposed asset value is GBP 1.2bn.",
   "The company is committed to reducing its physical risk.",
   "We have set ambitious resilience goals."],
  ["dated target", "residual-risk limit", "risk tolerance", "baseline", "progress", "variance", "current result", "exposed value", "resilience KPI"],
  ["Annual Report", "Sustainability/ESG Report", "TCFD/IFRS S2 report", "CDP response", "Risk report"],
  {"yes_cases": "A quantified+dated target/tolerance with a baseline and reported progress/current status.",
   "no_cases": "A broad ambition, a one-off exposure number, or a target with no progress.",
   "distinguishing_test": "Is there a dated quantified target/tolerance WITH a baseline AND current progress/variance — not an ambition or single number?"},
  0.10,
  S("performance", "outcome", "always", ["public_company"],
    "Monitoring resilience performance/residual exposure against dated targets is expected of any company.",
    [{"id": "dated_target", "requires": "a quantified and dated resilience target, residual-risk limit or risk-tolerance metric"},
     {"id": "baseline", "requires": "a baseline or denominator"},
     {"id": "progress", "requires": "reported progress, current result or variance"}],
    exclusions=["U-pillar (one-off exposure number)", "L2 (closed-loop learning)"])),

M("L2", 6,
  "Lessons from events, near misses and exercises are assigned and implemented",
  "Closed-loop learning",
  "Whether a named event, near miss or exercise produces a documented lesson/finding, a resulting action/change is assigned or described, and completion/status is evidenced. Replaces E3-post-event-learning.",
  ("TRACK performance (event_or_exercise attribution required). APPLICABILITY always (companies can learn from near misses and exercises, so "
   "absence of a recent disaster is not a penalty). ATOMIC PREDICATES, all required: (1) a NAMED event, near miss or exercise produces a "
   "documented LESSON/finding; (2) a resulting ACTION/change is assigned or described; and (3) COMPLETION/status is evidenced. Boundary: "
   "CLOSED-LOOP learning here; the exercise itself is P6; recovery performance is R1; target monitoring is L1. DEFINITION: a documented "
   "lesson from an event/near-miss/exercise that led to an assigned, status-evidenced change — not a generic continuous-improvement "
   "statement or a lessons-learned claim without a change."),
  ("Binary. Yes requires a named event/near-miss/exercise, a documented lesson, an assigned/described resulting change, AND completion/status, "
   "all quote-verifiable. A generic continuous-improvement statement, or a 'lessons were learned' claim with no change/status, is No. Near "
   "misses and exercises count — do not require an actual disaster."),
  ("1. A report states a post-flood review produced findings, assigned remediation actions, and confirms their completion status.\n"
   "2. A company discloses that a near-miss power event led to a defined control change, owned and tracked to closure.\n"
   "3. A disclosure describes lessons from a continuity exercise, the plan changes made, and their implementation status."),
  "A named event/near-miss/exercise producing a documented lesson, an assigned or described resulting action/change, AND evidenced completion/status.",
  "A generic continuous-improvement statement; a 'lessons learned' claim with no change; the exercise record itself with no learning loop (P6); recovery performance (R1); target monitoring (L1).",
  ["Our post-flood review produced specific findings; remediation actions were assigned to owners and all were confirmed complete within six months.",
   "A near-miss grid event led us to add a documented control change, owned by site engineering and tracked to closure.",
   "Lessons from our 2025 continuity exercise drove four plan changes, each assigned and now implemented.",
   "Following a supplier near-miss, we revised our dual-sourcing standard; the change is recorded as completed and audited."],
  ["We are committed to continuous improvement.",
   "We learn from incidents and apply the lessons.",
   "The company takes a proactive approach to improvement.",
   "Lessons learned are shared across the organisation."],
  ["lessons learned", "post-event review", "near miss", "finding", "assigned action", "corrective action", "implemented", "completion status", "closed loop"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "Sustainability/ESG Report", "Operational report"],
  {"yes_cases": "A documented lesson from an event/near-miss/exercise with an assigned, status-evidenced change.",
   "no_cases": "Generic continuous-improvement or a lessons claim with no change/status.",
   "distinguishing_test": "Did a named event/near-miss/exercise lead to an ASSIGNED change with evidenced completion — not a generic improvement claim?"},
  0.09,
  S("performance", "learning", "always", ["public_company"],
    "Learning from events, near misses and exercises is expected of any company; recent disaster not required.",
    [{"id": "lesson", "requires": "a documented lesson/finding from a named event, near miss or exercise"},
     {"id": "assigned_change", "requires": "a resulting action/change assigned or described"},
     {"id": "completion", "requires": "evidenced completion/status"}],
    exclusions=["P6 (exercise record without learning loop)", "R1 (recovery performance)", "L1 (target monitoring)"])),

M("L3", 6,
  "Physical-risk and continuity assumptions are periodically reassessed after material change",
  "Programme currency",
  "Whether the company states a review/reassessment trigger or cycle that applies after material changes and indicates the resilience/continuity programme is updated as a result. NEW measure.",
  ("TRACK performance (reassessment/currency attribution). APPLICABILITY always. ATOMIC PREDICATES, all required: (1) a stated "
   "review/reassessment TRIGGER or cycle that applies after MATERIAL CHANGES in footprint, assets, suppliers, insurance/availability, "
   "climate science, risk data or disruptive events; and (2) an indication that the resilience/continuity programme is UPDATED as a result. "
   "Boundary: programme CURRENCY (keeping assumptions live) here; the system itself is P1; target monitoring is L1; closed-loop event "
   "learning is L2. DEFINITION: a reassessment mechanism tied to the risk/control environment that keeps the programme current — not a "
   "fixed-calendar policy review unrelated to change."),
  ("Binary. Yes requires a reassessment trigger/cycle tied to material change AND evidence the programme is updated as a result, both "
   "quote-verifiable. A fixed policy review with no relation to the risk/control environment is No. Triggers may be footprint/asset change, "
   "supplier change, insurance availability, new climate science/data, or disruptive events."),
  ("1. A disclosure states physical-risk and continuity assumptions are reassessed whenever the company acquires assets, changes suppliers or new climate science emerges, and the programme is updated accordingly.\n"
   "2. A company describes a trigger-based review tied to insurance-availability change and disruptive events, with resulting programme updates.\n"
   "3. A report states that after any material footprint change, the resilience programme and its assumptions are re-evaluated and revised."),
  "A review/reassessment trigger or cycle tied to material change (footprint, assets, suppliers, insurance, climate science, risk data, events) WITH an indication the programme is updated as a result.",
  "A fixed-calendar policy review with no link to the risk/control environment; a generic 'we review our policies annually'; the continuity system (P1); target monitoring (L1); event learning (L2).",
  ["Physical-risk and continuity assumptions are reassessed whenever we acquire assets, change critical suppliers, or new climate science emerges, and the programme is updated accordingly.",
   "Our trigger-based review is tied to changes in insurance availability and to disruptive events, each prompting a documented programme update.",
   "After any material change to our footprint, the resilience programme and its underlying assumptions are re-evaluated and revised.",
   "New regional climate data triggers a reassessment of exposure assumptions and a refresh of the affected continuity plans."],
  ["We review our policies on a regular basis.",
   "The company keeps its risk-management framework under review.",
   "Our continuity plans are reviewed annually.",
   "We update our procedures from time to time."],
  ["reassessment trigger", "after material change", "footprint change", "new climate science", "supplier change", "insurance availability", "programme updated", "currency", "re-evaluated"],
  ["Annual Report", "Risk report", "Business-continuity disclosure", "TCFD/IFRS S2 report", "Sustainability/ESG Report"],
  {"yes_cases": "A reassessment trigger/cycle tied to material change with the programme updated as a result.",
   "no_cases": "A fixed-calendar review unrelated to the risk/control environment.",
   "distinguishing_test": "Is reassessment triggered by MATERIAL CHANGE (footprint/suppliers/science/events) AND does the programme get updated — not just a periodic policy review?"},
  0.09,
  S("performance", "learning", "always", ["public_company"],
    "Keeping physical-risk/continuity assumptions current after material change is expected of any company.",
    [{"id": "reassessment_trigger", "requires": "a review/reassessment trigger or cycle applying after material changes (footprint/assets/suppliers/insurance/climate science/risk data/events)"},
     {"id": "programme_update", "requires": "an indication the resilience/continuity programme is updated as a result"}],
    exclusions=["P1 (continuity system)", "L1 (target monitoring)", "L2 (closed-loop event learning)"])),
]



# ══════════════════════════════ FINALISATION ════════════════════════════════
# display_order (1..36 in authored pillar order)
for _i, _m in enumerate(MEASURES, 1):
    _m["display_order"] = _i

# Mark the critical-gate measures (criticalMeasureSet) in the structured objects (export only).
for _m in MEASURES:
    if _m["measure_id"] in CRITICAL_MEASURE_SET:
        _m["_struct"]["criticalGate"] = True

# Machine-readable decision objects, keyed by measure_id (EXPORT ARTIFACT ONLY).
STRUCTURED = {_m["measure_id"]: _m["_struct"] for _m in MEASURES}

# ── Integrity asserts (fail fast at import) ───────────────────────────────────
assert len(MEASURES) == 36, f"expected 36 measures, got {len(MEASURES)}"
_ids = [m["measure_id"] for m in MEASURES]
assert len(set(_ids)) == 36, "duplicate measure_id"
from collections import Counter as _C
_counts = dict(_C(m["category_number"] for m in MEASURES))
assert _counts == {1: 6, 2: 8, 3: 11, 4: 6, 5: 2, 6: 3}, f"bad pillar counts: {_counts}"
assert [m["measure_id"] for m in MEASURES if m["_struct"]["criticalGate"]] == CRITICAL_MEASURE_SET, "critical gate mismatch"
for _m in MEASURES:
    assert _m["substantive_definition"].strip(), f"{_m['measure_id']} empty substantive_definition"
    assert _m["scoring_guidance"].strip(), f"{_m['measure_id']} empty scoring_guidance"
    assert _m["fallback_yes_criterion"].strip(), f"{_m['measure_id']} empty fallback"
    assert len(_m["positive_examples"]) >= 4, f"{_m['measure_id']} <4 positive_examples"
    assert len(_m["negative_examples"]) >= 4, f"{_m['measure_id']} <4 negative_examples"
    assert isinstance(_m["c1_achievement_guidance"], dict) and all(
        _m["c1_achievement_guidance"].get(k, "").strip() for k in ("yes_cases", "no_cases", "distinguishing_test")
    ), f"{_m['measure_id']} incomplete c1_achievement_guidance"
    assert _m["required_source_types"] is None, f"{_m['measure_id']} required_source_types must be null (vehicle-agnostic)"
    assert _m["min_quote_context_chars"] >= 120, f"{_m['measure_id']} min_quote_context_chars <120"
# coverageRule present on exactly the 7 measures that need a coverage denominator
_cov = sorted(m["measure_id"] for m in MEASURES if m["_struct"]["coverageRule"] is not None)
assert _cov == ["A2", "A5", "P1", "P6", "U2", "U6", "U7"], f"coverageRule set mismatch: {_cov}"

# ── Controlled lexicons (spec §2/§5) ─────────────────────────────────────────
PHYSICAL_CLIMATE_LEXICON = [
    "physical climate risk", "climate resilience", "climate adaptation",
    "extreme heat", "flood", "coastal flooding", "storm surge",
    "wildfire", "drought", "water stress", "sea-level rise",
]
OPERATIONAL_RESILIENCE_LEXICON = [
    "business continuity", "business impact analysis", "recovery time objective",
    "crisis management", "disaster recovery", "incident command",
    "alternate supplier", "dual sourcing", "backup power", "service restoration",
]

# ── Retrieval query families (spec §5) — each tagged with scopeTrack + eligible measures ──
QUERY_FAMILIES = [
    {"family": "physical_climate", "scopeTrack": "physical_climate",
     "eligibleMeasures": ["G1", "G3", "G4", "G5", "G6", "U1", "U2", "U3", "U4", "U8",
                          "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A10", "A11", "P4", "P5"],
     "templates": [
         '"{company}" ("physical climate risk" OR "climate resilience" OR adaptation OR flood OR heat OR wildfire OR drought) (assessment OR exposure OR scenario OR vulnerability OR resilience OR continuity)',
         '"{company}" (flood OR heat OR wildfire OR drought OR storm) ("business interruption" OR recovery OR downtime OR impairment OR insurance)',
         '"{company}" ("future climate" OR RCP OR SSP OR "climate scenario") (asset OR site OR facility OR design OR capex)',
     ]},
    {"family": "operational_resilience", "scopeTrack": "operational_resilience",
     "eligibleMeasures": ["G2", "U5", "U6", "U7", "A8", "A9", "P1", "P2", "P3", "P6"],
     "templates": [
         '"{company}" ("business continuity" OR "operational resilience" OR "disaster recovery") (exercise OR test OR "recovery time" OR "business impact analysis")',
         '"{company}" ("critical supplier" OR "dual sourcing" OR "alternative supplier" OR "supply disruption") (continuity OR resilience OR contingency)',
         '"{company}" ("incident command" OR "crisis management" OR "emergency response") (roles OR escalation OR communication)',
         '"{company}" ("backup power" OR redundancy OR "alternate route" OR "alternative water" OR "service restoration")',
     ]},
    {"family": "performance", "scopeTrack": "performance",
     "eligibleMeasures": ["R1", "R2", "L1", "L2", "L3"],
     "templates": [
         '"{company}" (outage OR disruption OR storm OR flood OR wildfire OR heat) (downtime OR restoration OR recovery OR "business interruption")',
         '"{company}" (exercise OR drill OR simulation OR "after-action" OR "lessons learned") (continuity OR crisis OR recovery)',
         '"{company}" ("residual risk" OR "resilience target" OR "risk tolerance") (progress OR baseline OR performance)',
     ]},
]

# ── FRAMEWORK-LEVEL CONFIG overrides (applied on top of the fw20 baseline row) ──
# The apply script loads the fw20 backup framework dict as the base (carrying all jsonb
# config), then overrides these keys. anchor_frameworks: the 4 ISO entries are APPENDED
# to the base list by the apply script (ANCHOR_FRAMEWORKS_ADD).
FRAMEWORK_CONFIG = {
    "name": "Physical Climate Resilience and Business Continuity",
    "topic_description": (
        "Assessment of how a company governs, understands, reduces, withstands, responds to and learns "
        "from physical-climate disruption and its cascading operational effects. Supersedes the "
        "'Physical Climate Risk Management' framework: it keeps a dedicated physical-climate track while "
        "adding operational-resilience and performance tracks so that a mature business-continuity, crisis "
        "and recovery capability can be credited on its own terms without being mistaken for — or masking — "
        "physical-climate management."
    ),
    "version": 3,
    "builder_version": "v2",   # schema/engine builder generation unchanged (binary scorer); content redesign only
    "topic_term": "physical climate resilience",
    # §2 — synonyms pruned: removed 'water security','physical climate','physical risk','natural disaster risk';
    # NOT added: business continuity / operational resilience / ERM / crisis management / downtime / supply chain disruption.
    "topic_synonyms": [
        "acute climate risk", "asset climate exposure", "chronic climate risk", "climate adaptation",
        "climate-related physical risk", "climate resilience", "climate vulnerability",
        "extreme weather risk", "physical climate hazards", "physical climate impacts", "physical climate risk",
    ],
    # §3 — replace 'operational risk (non-climate)' with precise boilerplate exclusion; keep the rest.
    "negative_domains": [
        "transition risk / decarbonization",
        "general climate risk (undifferentiated)",
        "general esg / sustainability",
        "generic or unspecified operational-risk boilerplate",
        "environmental compliance / pollution",
    ],
    # §3 — five track-aware anti-inference rules (verbatim intent of spec lines 435-439).
    "anti_inference_rules": [
        "A general BCP, ERM, crisis-management or supplier-resilience disclosure may satisfy only a measure designated operational_resilience, and only when it meets that measure's named object/control/test gate.",
        "General operational-resilience evidence does not by itself satisfy a physical_climate measure that requires physical hazard, climate scenario, physical-impact or climate-adaptation attribution.",
        "A transition-risk, net-zero, emissions-reduction or renewable-energy disclosure does not satisfy a physical-climate measure unless the evidence independently identifies a physical hazard/impact and the required measure-specific control.",
        "A climate/ESG statement does not satisfy an operational-resilience measure unless it describes the required continuity, recovery, dependency, crisis or exercise control.",
        "A general policy, aspiration or outcome statement does not satisfy an implemented-control, test, decision-rule or performance measure without the required quote-verifiable tokens.",
    ],
    # §6 — expanded, vehicle-agnostic doc-type priority (non-blocking; required_source_types stays null per measure).
    "required_doc_types": [
        "Annual Report", "10-K filing", "20-F filing", "Interim / 10-Q filing", "Interim report",
        "Financial Statements / Notes", "Principal risks section", "Risk management section",
        "Earnings call transcript", "Quarterly earnings report", "Earnings materials",
        "Proxy Statement", "Corporate Governance Statement", "Remuneration Report",
        "Sustainability/ESG Report", "CDP response", "TCFD/IFRS S2 report",
        "Business continuity section", "Continuity / emergency-response policy", "Incident / outage disclosure",
        "Supply chain section", "Capital expenditure section", "Operational report",
        "Policy Document", "Website / Webpage", "Presentation / Deck", "Sector/regulatory disclosure",
    ],
    # §6 — broaden filing-type weights beyond CDP/TCFD/ESG to the vehicles operational & performance evidence appears in.
    "authoritative_filing_types": [
        {"weight": 8.0, "pattern": r"\bcdp\b|tcfd|ifrs.?s2|climate.?report"},
        {"weight": 7.0, "pattern": r"10.?k\b|20.?f\b|annual.?report|principal.?risk"},
        {"weight": 6.5, "pattern": r"business.?continuit|disaster.?recover|iso.?22301|resilience"},
        {"weight": 6.0, "pattern": r"sustainab|esg\b|csr\b|responsibility"},
        {"weight": 5.5, "pattern": r"10.?q\b|interim|earnings|transcript"},
        {"weight": 5.0, "pattern": r"outage|incident|service.?restorat"},
    ],
    # §5 — retrieval: query families (physical-climate / operational-resilience / performance) + controlled lexicons.
    "search_templates": [t for fam in QUERY_FAMILIES for t in fam["templates"]],
    "multi_document_query_templates": [t for fam in QUERY_FAMILIES for t in fam["templates"]],
    "retrieval_query_terms": {
        "physicalClimateLexicon": PHYSICAL_CLIMATE_LEXICON,
        "operationalResilienceLexicon": OPERATIONAL_RESILIENCE_LEXICON,
        "queryFamilies": QUERY_FAMILIES,
    },
    "data_patterns": {
        "physicalClimateLexicon": PHYSICAL_CLIMATE_LEXICON,
        "operationalResilienceLexicon": OPERATIONAL_RESILIENCE_LEXICON,
    },
    "document_priority_url_patterns": [
        r"annual.?report", r"10-?k", r"20-?f", r"10-?q", r"interim",
        r"sustainab|esg|csr", r"cdp|tcfd|climate", r"governance|proxy",
        r"business.?continuit|resilience|disaster.?recover", r"risk",
        r"earnings|results|transcript", r"incident|outage|status",
        r"supplier|supply.?chain",
    ],
    "authoritative_registries": [
        {"name": "CDP Climate Change", "source": "https://www.cdp.net/"},
        {"name": "SEC EDGAR (10-K/20-F/10-Q)", "source": "https://www.sec.gov/edgar"},
        {"name": "UK National Storage Mechanism (RNS/annual reports)", "source": "https://data.fca.org.uk/#/nsm/nationalstoragemechanism"},
    ],
    # Six-pillar G/U/A/P/R/L structure (replaces the five v2 pillars).
    "sub_area_structure": PILLARS,
    # Rebuilt residual warnings (v1/v2 overlap IDs removed; stale knownDisclosureUrls warning corrected per §5).
    "residual_warnings": [
        {"issue": "class_b_deferred", "severity": "high",
         "note": ("Machine-readable scoring (weighted multi-dimension model, CoreGate over criticalMeasureSet "
                  "[U1,U2,A1,P4], applicability gating, predicate evaluation, coverageRule enforcement) is NOT "
                  "executed by the current binary engine. Track/attribution/applicability/predicates/coverage are "
                  "encoded IN TEXT and preserved in the export artifact only. productionReady stays false until the "
                  "engine, schema and validator land and calibration re-scoring is complete.")},
        {"issue": "calibration_pending", "severity": "medium",
         "note": ("expected_yes_rate values are UNCALIBRATED authoring priors (measures were re-scoped for v3). "
                  "Replace with observed distributions from a reviewed corpus before productionReady is set true.")},
        {"issue": "applicability_in_text_only", "severity": "medium",
         "note": ("if_material (G5,A3,A4,A5,A11) and if_event_occurred (R1,R2) applicability is enforced only via "
                  "prompt text; a non-applicable company must be EXCLUDED before scoring, not scored No. Machine "
                  "applicability gating is deferred (class B).")},
    ],
    # Mirror fw20's enabled rule set — do NOT enable anything beyond the existing baseline.
    "rules_active": {"C1": True, "C2": True, "C3": True, "C4": True, "C5": True, "C6": True,
                     "C7": True, "C8": True, "C9": True, "C10": True, "C11": True},
    "is_active": False,
    "production_ready": False,
    "workspace_id": 3,
}

# ISO continuity/risk anchors appended to the fw20 anchor list by the apply script (spec §4).
ANCHOR_FRAMEWORKS_ADD = [
    {"name": "ISO 22301 (Business continuity management systems)", "source": "https://www.iso.org/standard/75106.html"},
    {"name": "ISO 22313 (Guidance on ISO 22301)", "source": "https://www.iso.org/standard/75107.html"},
    {"name": "ISO 31000 (Risk management guidelines)", "source": "https://www.iso.org/standard/65694.html"},
    {"name": "ISO 22361 (Crisis management guidelines)", "source": "https://www.iso.org/standard/50267.html"},
]

# ── Changelog payload (consumed by the changelog artifact + export) ───────────
CHANGELOG_ENTRY = {
    "framework_name": FRAMEWORK_CONFIG["name"],
    "supersedes": "framework 20 — Physical Climate Risk Management (v2, 27 measures)",
    "version": 3,
    "measure_count": 36,
    "pillars": {c["letter"]: {"number": c["number"], "name": c["name"]} for c in PILLARS["categories"]},
    "critical_measure_set": CRITICAL_MEASURE_SET,
    "dimension_weights_deferred": DIMENSION_WEIGHTS,
    "config_changes": [
        "§1 Scope tracks + attributionRequirement: added per measure (physical_climate / operational_resilience / performance). No DB column exists — encoded in substantive_definition text + scoring_guidance, and preserved in the export artifact STRUCTURED objects.",
        "§2 topic_term set to 'physical climate resilience'. topic_synonyms pruned (removed 'water security','physical climate','physical risk','natural disaster risk'); did NOT add business-continuity/operational-resilience/ERM terms. Controlled physicalClimateLexicon + operationalResilienceLexicon stored in retrieval_query_terms and data_patterns.",
        "§3 negative_domains: replaced 'operational risk (non-climate)' with 'generic or unspecified operational-risk boilerplate'; kept transition-risk, undifferentiated-climate, ESG and environmental-compliance. anti_inference_rules replaced with 5 track-aware rules.",
        "§4 anchor_frameworks: added ISO 22301, ISO 22313, ISO 31000, ISO 22361; retained IFRS S2, ESRS E1, CDP, TCFD, GRI.",
        "§5 retrieval rebuilt as three query families (physical-climate, operational-resilience, performance), each tagged with scopeTrack + eligible measure IDs; populated search_templates, multi_document_query_templates, document_priority_url_patterns, authoritative_registries, data_patterns.",
        "§6 vehicle-agnostic sources: required_source_types=null on every measure; expanded required_doc_types and authoritative_filing_types to cover 10-K/20-F/10-Q, earnings transcripts, incident/outage and continuity disclosures; disclosure_vehicles set per measure for retrieval ordering.",
        "§7 applicabilityRule (always / if_material / if_event_occurred) added per measure. No DB column — encoded in text and preserved in STRUCTURED; machine gating deferred (class B).",
        "sub_area_structure replaced with the six G/U/A/P/R/L pillars.",
        "residual_warnings rebuilt for v3 (stale v1/v2 overlap IDs and the stale knownDisclosureUrls warning removed; class-B deferral, calibration-pending and applicability-in-text warnings added).",
        "is_active=false, production_ready=false, workspace_id=3, builder_version='v2', rules_active mirrors fw20 (nothing enabled beyond baseline).",
    ],
    "defensible_choices_noted": [
        "category column stores the pillar NAME (e.g. 'Govern and decide'), not the letter, to match the existing DB/dashboard convention (v2 used names; dashboard groups by category_number + sub_area_structure). The pillar letter lives in sub_area_structure.categories[].letter and in the measure_id prefix.",
        "builder_version kept at 'v2' (the engine/schema generation is unchanged — this is a content redesign, not an engine upgrade).",
        "Applicability assignments not explicitly enumerated in the spec were chosen defensibly: always for G1-G4,G6,U1-U8,A1,A2,A6-A10,P1-P6,L1-L3; if_material for G5,A3,A4,A5,A11; if_event_occurred for R1,R2. Spec explicitly fixed U1-U4/G1/G4=always, A3/A4/A5/A11=if_material, R1/R2=if_event_occurred.",
        "coverageRule attached to U2,U6,U7,A2,A5,P1,P6 (the measures whose Yes-gate turns on a coverage denominator/population).",
        "expected_yes_rate values are uncalibrated authoring priors (flagged in residual_warnings + per-measure justification), to be replaced by observed rates before productionReady.",
    ],
    "deferred_class_b": [
        "Weighted multi-dimension scoring engine (W_physical .50 / W_operational .30 / W_performance .20) — binary engine has no weighting.",
        "CoreGate computation over criticalMeasureSet [U1,U2,A1,P4].",
        "Machine applicability gating (exclude non-applicable companies before scoring).",
        "Decision-predicate evaluation as structured logic.",
        "coverageRule enforcement as deterministic computation.",
        "Dashboard weight/assumption controls.",
        "Static validator + fixture harness.",
        "Calibration re-scoring of a reviewed corpus.",
    ],
    "migration_27_to_36": [
        {"old": o, "new": n, "kind": k, "note": note} for (o, n, k, note) in OLD_TO_NEW
    ],
    "new_measures": NEW_MEASURE_IDS,
}

if __name__ == "__main__":
    print(f"MEASURES={len(MEASURES)}  pillars={_counts}  critical={CRITICAL_MEASURE_SET}")
    print(f"coverageRule on: {_cov}")
    print(f"new measures: {NEW_MEASURE_IDS}")
    print("content module OK")
