#!/usr/bin/env python3
"""fw20_v2_content.py — authored v2 content for Framework 20 (Physical Climate
Risk Management), adapted to the BINARY scoring engine.

This module is DATA ONLY (no DB writes). The apply script imports MEASURES,
FRAMEWORK_CONFIG, PILLARS, OLD_TO_NEW and CHANGELOG_ENTRY from here.

BINARY-ADAPTATION RUBRIC (applied to every measure):
  The reviewer asked for a 0-4 maturity scale. The engine is Yes/No only, so the
  feedback's level-2/level-3 bar is encoded as a SINGLE discriminating Yes gate in
  substantive_definition + fallback_yes_criterion + scoring_guidance. "Awareness"
  measures raise the bar to COVERAGE/DEPTH (company-stated coverage, never inferred).
  Action/response/outcome measures require a NAMED action/decision/quantified outcome.
  Each measure names its neighbour in what_does_not_constitute_evidence to control
  the 25 residual overlap warnings. expected_yes_rate is a PRIOR pending re-scoring.
"""

# ── Pillar (sub-area) structure — replaces the four TCFD pillars ──────────────
PILLARS = {
    "type": "custom",
    "rationale": (
        "Restructured from the four TCFD disclosure pillars to five resilience pillars that "
        "follow how physical-climate resilience is actually managed: Oversight, Understand, "
        "Anticipate, Respond and Recover, and Outcomes and Learning. The conceptual basis is "
        "the hazard-exposure-vulnerability model used by IIGCC's Climate Resilience Investment "
        "Framework (CRIF), with PCRAM 2.0 as the asset-level appraisal method. TCFD/IFRS S2 is "
        "retained as a disclosure-mapping tag inside each measure's text, not as the category "
        "structure. This moves 16 of 27 measures (59%) onto strategic action, response and "
        "outcomes, versus 9 of 30 (30%) in v1."
    ),
    "categories": [
        {"number": 1, "letter": "A", "name": "Oversight",
         "question": "Is someone accountable with the right incentives?"},
        {"number": 2, "letter": "B", "name": "Understand",
         "question": "Does the company know where and how badly it is exposed and vulnerable?"},
        {"number": 3, "letter": "C", "name": "Anticipate",
         "question": "Is it making strategic decisions that reduce exposure?"},
        {"number": 4, "letter": "D", "name": "Respond and Recover",
         "question": "Can it absorb and recover from events?"},
        {"number": 5, "letter": "E", "name": "Outcomes and Learning",
         "question": "Did it work, and does it learn?"},
    ],
}

# ── Every v1 measure id -> its v2 destination (for the changelog) ────────────
# kind: merged-into | retained+fixed | retired-folded
OLD_TO_NEW = [
    ("1.1-board-oversight",             "A1-board-oversight",              "merged-into",
     "Board oversight of physical climate risk; v1 0.35 Yes because boards oversee 'climate risks' collectively. Merged with 1.2 and 1.4."),
    ("1.2-board-committee",             "A1-board-oversight",              "merged-into",
     "Named board committee becomes a Yes-gate depth signal inside A1."),
    ("1.4-board-frequency",             "A1-board-oversight",              "merged-into",
     "Stated review frequency + physical-risk agenda becomes a Yes-gate depth signal inside A1."),
    ("1.7-stakeholder-engagement",      "A1-board-oversight",              "retired-folded",
     "Retired as a standalone measure (v1 0.10 Yes, weak link to exposure reduction); folded into A1 as a non-sufficient descriptor only."),
    ("1.3-executive-accountability",    "A2-exec-accountability-incentives","merged-into",
     "Executive accountability becomes the floor of A2."),
    ("1.5-executive-compensation",      "A2-exec-accountability-incentives","merged-into",
     "Incentive linkage (v1 0.05 Yes, too rare to stand alone) becomes the discriminating Yes-gate of A2."),
    ("1.6-policy-framework",            "A3-policy-framework",             "retained+fixed",
     "Kept; Yes now requires the policy to set design or siting standards, not mere existence."),
    ("2.1-scenario-analysis",          "B2-scenario-horizons",            "merged-into",
     "Scenario-analysis use merged with horizons."),
    ("2.2-scenario-timeframes",        "B2-scenario-horizons",            "merged-into",
     "v1 accepted any two dates; Yes now requires horizons matching long-lived asset life (>=2050 for 30y+ assets) and >=1 high-warming scenario."),
    ("2.3-acute-hazards",              "B1-hazard-coverage",              "merged-into",
     "v1 0.84 Yes, non-discriminating; merged into hazard-breadth count."),
    ("2.4-chronic-hazards",           "B1-hazard-coverage",              "merged-into",
     "v1 0.80 Yes, non-discriminating; merged into hazard-breadth count."),
    ("2.5-financial-impact",          "B6-financial-impact",             "retained+fixed",
     "Kept; removed cross-measure examples (capex/exposure value), deleted the near-universal 'company-authored report' test, require an impact/loss figure not an exposure value or spend."),
    ("2.6-asset-exposure",            "B3-asset-screening-coverage",     "merged-into",
     "v1 passed on one named site; merged with 3.1 into a coverage-graded screening measure."),
    ("3.1-risk-identification-process","B3-asset-screening-coverage",     "merged-into",
     "v1 title promised >=70% but criteria tested 'all operations' loosely; now a stated coverage threshold (>=50% Yes)."),
    ("3.2-risk-assessment-methodology","B4-vulnerability-methodology",    "merged-into",
     "Methodology quality: vulnerability (damage functions/design thresholds), resolution, supply-chain inclusion."),
    ("3.6-third-party-data",          "B4-vulnerability-methodology",    "merged-into",
     "v1 rewarded buying vendor data; third-party data is now an evidence route, not the score."),
    ("3.5-supply-chain-risk",         "B5-valuechain-infra-exposure",    "retained+fixed",
     "Kept as exposure; added infrastructure dependencies (grid/water/ports/transport). Supplier ACTIONS moved to new C7."),
    ("2.9-capital-allocation",        "C2-resilience-capital",           "merged-into",
     "Plan (floor) merged with amount."),
    ("4.3-adaptation-investment",     "C2-resilience-capital",           "merged-into",
     "Amount with share of total capex becomes the Yes-gate of C2 (v1 4.3 0.10 Yes)."),
    ("2.7-business-model-impact",     "C3-implemented-mitigation",       "retired-folded",
     "Retired as standalone (v1 0.92 Yes); used as a precondition/context for C3 (credit actions only where they address an identified mechanism)."),
    ("3.7-mitigation-actions",        "C3-implemented-mitigation",       "retained+fixed",
     "Kept; graded by share of high-risk sites with implemented measures (stated)."),
    ("2.8-adaptation-strategy",       "C1-adaptation-strategy",          "retained+fixed",
     "Kept; Yes now requires links to capex or site plans, not a named strategy alone."),
    ("2.10-insurance-strategy",       "C4-insurability-strategy",        "retained+fixed",
     "Reframed from 'uses insurance' (near-universal) to insurability strategy: premium/deductible trends, cover withdrawn, captives/parametric, disclosed uninsured exposure."),
    ("3.3-erm-integration",           "B8-erm-integration-prioritisation","merged-into",
     "ERM integration merged with prioritisation."),
    ("3.4-risk-prioritization",       "B8-erm-integration-prioritisation","merged-into",
     "Prioritisation/ranking merged into B8."),
    ("3.8-incident-response",         "D1-business-continuity-tested",   "retained+fixed",
     "v1 title said 'all/majority of operations' with no coverage test; now graded by stated coverage AND testing (frequency/scenario exercises/RTOs)."),
    ("4.1-exposure-metrics",          "B7-gross-residual-exposure",      "retained+fixed",
     "Aligned to IFRS S2 29(b)/ESRS E1 66: amount and % of assets exposed, acute/chronic split, GROSS vs RESIDUAL. Kept separate from B6 (loss estimate)."),
    ("4.2-resilience-targets",        "E2-targets-progress",             "merged-into",
     "v1 flagged non-discriminating; target (floor) merged with 4.5."),
    ("4.5-progress-reporting",        "E2-targets-progress",             "merged-into",
     "Progress reported against a quantified/dated target becomes the Yes-gate of E2 (v1 4.5 0.05 Yes)."),
    ("4.4-incident-metrics",          "E1-incident-loss-metrics",        "retained+fixed",
     "v1 counted incidents only; now graded by quantification (cost/downtime) and trend; fed by transcripts/10-Q/FS-notes (R6)."),
]

NEW_MEASURE_IDS = [
    "C5-siting-ma-design-standards", "C6-asset-portfolio-decisions",
    "C7-supplychain-resilience-actions", "C8-water-security",
    "C9-adaptation-investment-appraisal", "C10-workforce-heat-stress",
    "D2-early-warning-triggers", "D3-recovery-performance",
    "E3-post-event-learning",
]

# E4 (red flags) is DEFERRED — the binary engine has no negative scoring.
# Its signals are folded into the what_does_not_constitute_evidence of C4/D3/E1.
DEFERRED = ["E4-red-flags (negative-scored measure — engine has no 0/-1/-2 scoring)"]



# ── Measure builder (fills DB-column defaults) ───────────────────────────────
_CATNAME = {c["number"]: c["name"] for c in PILLARS["categories"]}

def M(mid, cat_num, title, definition, substantive, scoring, fallback,
      wce, wdnce, pos, neg, kw, vehicles, eyr, eyr_just, source_types=None):
    return {
        "measure_id": mid,
        "category": _CATNAME[cat_num],
        "category_number": cat_num,
        "title": title,
        "definition": definition,
        "scoring_guidance": scoring,
        "substantive_definition": substantive,
        "fallback_yes_criterion": fallback,
        "what_constitutes_evidence": wce,
        "what_does_not_constitute_evidence": wdnce,
        "positive_examples": pos,
        "negative_examples": neg,
        "evidence_keywords": kw,
        "disclosure_vehicles": vehicles,
        "required_source_types": source_types or [
            "Annual Report", "Sustainability/ESG Report", "CDP response",
            "Risk Management Disclosure", "Financial Statements / Notes",
            "Quarterly earnings report",
        ],
        "primary_assessment_target": "Company",
        "coverage_whitelist": [],
        "c1_achievement_guidance": [],
        "min_quote_context_chars": 240,
        "expected_yes_rate": eyr,
        "expected_yes_rate_justification": eyr_just,
        "r3_1_exception_metrics": False,
        "r3_1_exception_coverage": False,
        "flagged_non_discriminating": False,
    }

_PRIOR = ("PRIOR pending re-scoring. v1 Yes-rate is not comparable because the binary "
          "bar was raised to a coverage/depth gate per the v2 rubric; this figure is a "
          "judgement prior to be replaced by the re-scored sample distribution.")

MEASURES = [

# ══════════════════ PILLAR A — OVERSIGHT ══════════════════
M("A1-board-oversight", 1,
  "Board oversight of physical climate risk is specific and active",
  "Assesses whether the board (or a named board committee) actively oversees PHYSICAL climate risk with evidenced depth, not merely a collective reference to 'climate-related risks'. [TCFD/IFRS S2 mapping: Governance a).] Merges v1 1.1/1.2/1.4; v1 1.7 (stakeholder engagement) folded in as a non-sufficient descriptor only.",
  "Yes requires board-level oversight that is specific to physical climate risk AND shows at least one DEPTH signal: (a) a NAMED board committee with physical-climate-risk responsibility, OR (b) a STATED board review frequency together with a physical-risk agenda item, OR (c) a described instance where board oversight changed a decision. Under anti-inference rule R1, oversight framed as integrated 'climate-related risk' may supply the physical-attribution context where the company identifies physical risk as material elsewhere in the same reporting cycle, but that alone is the floor and does NOT meet the Yes bar without one of (a)-(c).",
  "Score Yes only when one of the three depth signals is quoted verbatim. A bare statement that 'the board oversees climate-related risks' is No. Stakeholder engagement on climate (old 1.7) is context, never sufficient for Yes.",
  "A table row naming a committee plus its charter column/caption, or a CDP governance question plus its answer, counts as one bounded passage provided the quote includes the header text (R2). Minimum: a verbatim quote naming the committee/frequency/decision tied to physical climate risk.",
  "A named board committee (e.g. 'Risk Committee', 'Safety, Health & Environment Committee') with an explicit physical-climate-risk or resilience remit; a stated cadence (e.g. 'the Board reviews physical climate risks quarterly') with agenda detail; or a described board decision driven by physical-risk oversight.",
  "Generic 'the Board oversees climate-related risks' with no physical specificity, named committee, frequency or decision. Stakeholder-engagement statements. Executive/management accountability without board involvement (that is A2). Policy existence (that is A3).",
  ["The Risk Committee holds explicit responsibility for physical climate risk and reviews a physical-hazard exposure dashboard at each quarterly meeting.",
   "In 2025 the Board, on the recommendation of its Sustainability Committee, deferred the Gulf Coast terminal expansion after a physical flood-risk review."],
  ["The Board maintains oversight of climate-related risks and opportunities as part of its ESG remit.",
   "Our stakeholder engagement programme covers climate change."],
  ["board committee", "physical climate risk", "oversight", "review frequency", "charter", "agenda", "resilience"],
  ["Annual Report", "Proxy Statement", "Corporate Governance Statement", "CDP response"],
  0.25,
  "v1 components 1.1=0.35, 1.2=0.20, 1.4=0.10; harder merged depth bar. " + _PRIOR,
  ["Annual Report", "Proxy Statement", "Corporate Governance Statement", "CDP response"]),

M("A2-exec-accountability-incentives", 1,
  "Executive accountability for physical climate risk is linked to incentives",
  "Assesses named executive accountability for physical climate risk AND, as the discriminating bar, whether remuneration is linked to resilience/physical-risk outcomes. [TCFD/IFRS S2 mapping: Governance b).] Merges v1 1.3 (accountability) + 1.5 (compensation linkage).",
  "Yes requires BOTH a named executive or management role accountable for physical climate risk AND an explicit linkage between executive incentives/remuneration and physical-resilience or physical-risk-management outcomes (e.g. a named KPI, scorecard metric or weighting). Accountability alone is the floor and is No; the incentive linkage is the Yes gate.",
  "Accountability-only disclosures score No. Score Yes only when the remuneration linkage to a physical-resilience/physical-risk metric is quoted. A generic 'ESG-linked pay' with no physical-risk metric is No.",
  "A remuneration-report row naming the metric plus its weighting column/caption counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote naming both the accountable role and the physical-risk-linked incentive.",
  "A named CRO/COO/CSO with physical-climate-risk accountability; a remuneration scorecard metric tied to resilience targets, asset-hardening delivery, or physical-risk reduction with a stated weighting.",
  "Accountability with no incentive linkage. Generic ESG- or emissions-linked pay with no PHYSICAL-risk metric (decarbonisation targets are out of scope — see negative keywords). Board-level oversight (that is A1).",
  ["The COO is accountable for operational climate resilience, and 10% of the executive annual scorecard is tied to delivery of the site flood-defence programme.",
   "Executive long-term incentives include a resilience KPI: reduction in assets located in high-hazard zones by 2028."],
  ["Our Chief Sustainability Officer is responsible for climate strategy.",
   "20% of executive pay is linked to ESG performance, including our net-zero transition plan."],
  ["executive accountability", "remuneration", "incentive", "KPI", "scorecard", "resilience target", "CRO"],
  ["Annual Report", "Proxy Statement", "Remuneration Report", "CDP response"],
  0.10,
  "v1 components 1.3=0.20, 1.5=0.05; Yes now gated on the rare incentive-linkage. " + _PRIOR,
  ["Annual Report", "Proxy Statement", "Remuneration Report", "CDP response"]),

M("A3-policy-framework", 1,
  "Physical climate risk policy sets design or siting standards",
  "Assesses whether a formal policy/framework for physical climate risk exists AND sets actionable design or siting standards. [TCFD/IFRS S2 mapping: Governance / Risk Management.] Retains v1 1.6 with a raised bar.",
  "Yes requires a named policy or framework for physical climate risk that goes beyond existence to SET a design, siting or asset-standard requirement (e.g. a flood design basis, a siting screen, a build-to-standard). A policy that only states intent to 'manage climate risks' is the floor and is No.",
  "Policy existence alone is No. Score Yes only when the policy's design/siting standard is quoted. Under R1 an integrated climate-risk policy may supply physical context, but the standard-setting content is still required for Yes.",
  "A policy-document clause plus its section header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the design/siting/asset standard the policy sets.",
  "A climate-resilience policy mandating a design basis (e.g. 'all new facilities designed to the projected 1-in-100-year flood level'); a siting standard screening against hazard maps; an asset-standard requirement.",
  "A policy that merely states the company 'is committed to managing climate-related risks'. Generic environmental or sustainability policies with no physical-risk design/siting standard. Oversight structure (that is A1).",
  ["Our Climate Resilience Policy requires all new sites to be screened against RCP8.5 hazard maps and built above the projected 2050 1-in-100-year flood level.",
   "Group Engineering Standard CS-14 sets heat and wind design bases for all facilities in high-hazard regions."],
  ["We have a climate change policy covering our environmental commitments.",
   "Our risk policy references climate-related risks among emerging risks."],
  ["policy", "framework", "design standard", "design basis", "siting", "build standard", "resilience policy"],
  ["Policy Document", "Annual Report", "Sustainability/ESG Report", "Corporate Governance Statement"],
  0.15,
  "v1 1.6=0.10; raised to require standard-setting content. " + _PRIOR,
  ["Policy Document", "Annual Report", "Sustainability/ESG Report", "Corporate Governance Statement"]),

# ══════════════════ PILLAR B — UNDERSTAND ══════════════════
M("B1-hazard-coverage", 2,
  "Breadth of physical hazards assessed, with hazard-specific results",
  "Assesses how many of the eight named physical hazards the company has assessed WITH hazard-specific results, not mere mention. [TCFD/IFRS S2 mapping: Risk Management a)/Strategy.] Merges v1 2.3 (acute) + 2.4 (chronic).",
  "The eight hazards are: river flood, coastal flood/storm surge, wind/cyclone, wildfire, extreme heat, drought/water stress, sea-level rise, precipitation change. Yes requires >=5 of the 8 hazards assessed WITH hazard-specific results or affected locations stated (coverage/depth bar). Merely listing or naming hazards without company-specific results is No, regardless of count.",
  "Count only hazards for which the company states a hazard-specific result (an exposed site, a quantified exposure, an affected region). A generic list of climate hazards with no company-specific findings is No even if all eight are named. >=5 hazards with results = Yes.",
  "A hazard table plus its column header (hazard | exposure | location) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim passage showing >=5 hazards each tied to a company-specific result.",
  "Hazard-by-hazard assessment naming exposed assets, regions or quantified exposure for at least five distinct hazards; a hazard matrix with company-specific results.",
  "A generic list of climate hazards ('we are exposed to floods, storms, heat and drought') with no company-specific results. Assessing only one or two hazards. Scenario-model mention without hazard results (that is B2). Financial loss figures (that is B6).",
  ["Our 2025 assessment covered river and coastal flooding, cyclone, wildfire, extreme heat, drought and sea-level rise across 412 sites; 38 sites face high river-flood risk and 11 coastal sites are exposed to >0.5m sea-level rise by 2050.",
   "Hazard screening identified extreme heat affecting 6 of 9 manufacturing regions, wildfire risk at 3 North American sites, and drought stress at 2 Indian plants."],
  ["We are exposed to a range of physical climate hazards including floods, storms, heatwaves and droughts.",
   "Climate change may increase the frequency of extreme weather events affecting our operations."],
  ["river flood", "coastal flood", "storm surge", "cyclone", "wildfire", "extreme heat", "drought", "water stress", "sea-level rise", "precipitation"],
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Risk Management Disclosure"],
  0.25,
  "v1 2.3=0.84, 2.4=0.80 (non-discriminating); harder >=5/8-with-results bar. " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Risk Management Disclosure"]),

M("B2-scenario-horizons", 2,
  "Scenario analysis uses asset-life horizons and a high-warming scenario",
  "Assesses whether physical-climate scenario analysis uses time horizons matched to long-lived asset life and includes at least one high-warming scenario. [TCFD/IFRS S2 mapping: Strategy c).] Merges v1 2.1 (scenario use) + 2.2 (timeframes).",
  "Yes requires disclosed use of physical-climate scenario analysis AND (a) a time horizon matched to the life of long-lived assets (e.g. extending to >=2050 where the company holds 30-year+ assets) AND (b) at least one high-warming scenario (e.g. RCP8.5 / SSP5-8.5 / >=3C). v1 accepted any two dates; that is now the floor and is No without asset-life matching and a high-warming scenario.",
  "Two near-term dates with no high-warming scenario is No. Score Yes only when both the long-horizon (>=2050 for long-lived assets) and a named high-warming scenario are quoted.",
  "A scenario table plus its header (scenario | horizon) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim passage naming the scenario and the long-dated horizon.",
  "Named scenarios (RCP8.5, SSP5-8.5, NGFS Hot House World) with horizons to 2050/2100 for long-lived assets; a scenario matrix showing physical-risk pathways by horizon.",
  "Scenario analysis limited to 2030 with no long-horizon for long-lived assets. Transition-only scenarios (NGFS Net Zero) with no physical pathway. Hazard results without a scenario (that is B1).",
  ["We ran physical-risk scenario analysis under RCP8.5 to 2050 and 2100 for our refineries (30+ year asset life), and RCP4.5 as a lower bound.",
   "Scenario analysis applied SSP5-8.5 across 2030/2050/2080 horizons aligned to the design life of our coastal terminals."],
  ["We use climate scenarios to inform our strategy.",
   "Our scenario analysis considers 2025 and 2030 time horizons."],
  ["scenario analysis", "RCP8.5", "SSP5-8.5", "NGFS", "time horizon", "2050", "high-warming", "asset life"],
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Strategy section"],
  0.25,
  "v1 2.1=0.59, 2.2=0.53; harder asset-life + high-warming bar. " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Strategy section"]),

M("B3-asset-screening-coverage", 2,
  "Asset-level exposure screening with stated coverage",
  "Assesses whether the company has screened its sites/assets for physical exposure with a STATED coverage figure. [TCFD/IFRS S2 mapping: Risk Management b).] Merges v1 2.6 (asset exposure) + 3.1 (identification process).",
  "Yes requires a company-STATED coverage figure of at least 50% of sites, asset value or facilities screened for physical hazard exposure. v1 passed on one named asset or a loose 'all operations' claim; coverage must now be explicit and company-stated, never inferred. Below 50% stated, or coverage not stated, is No.",
  "A single named exposed site is No. 'We assess all our operations' with no figure is No (coverage not stated). Score Yes only when a >=50% coverage figure (sites, asset value or facilities) is quoted.",
  "A coverage table plus its header (sites screened | % of portfolio) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the >=50% coverage figure.",
  "A stated share of sites/asset value screened ('we screened 78% of asset value for flood exposure'); a site list or hazard map covering a stated majority of the estate.",
  "One or a few named exposed sites with no portfolio coverage figure. 'All operations' claims with no number. Hazard breadth without a coverage figure (that is B1). Vulnerability methodology detail (that is B4).",
  ["We screened sites representing 82% of asset value against flood, heat and wind hazards; a site-level hazard map is published in our CDP response.",
   "Physical-risk screening covered 310 of 356 operating facilities (87%) under two scenarios."],
  ["We have identified that some of our facilities are located in flood-prone areas.",
   "Our risk identification process considers physical climate risks across the business."],
  ["asset screening", "coverage", "% of sites", "asset value", "hazard map", "facilities screened", "site-level"],
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Risk Management Disclosure"],
  0.15,
  "v1 2.6=0.76, 3.1=0.80 but presence-only; harder >=50% stated-coverage bar. " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Annual Report", "Risk Management Disclosure"]),

M("B4-vulnerability-methodology", 2,
  "Vulnerability assessment methodology quality",
  "Assesses the quality of the assessment METHOD — vulnerability (not just exposure), damage functions/design thresholds, resolution and supply-chain inclusion. [TCFD/IFRS S2 mapping: Risk Management a).] Merges v1 3.2 (methodology) + 3.6 (third-party data).",
  "Yes requires a described method that assesses VULNERABILITY (damage functions, sensitivity, design thresholds or impact modelling), not merely hazard exposure, AND names at least one methodological depth feature: spatial resolution, asset-sensitivity modelling, or supply-chain inclusion. Third-party/vendor data is an evidence route, not the score; buying a data product is not sufficient.",
  "Naming a vendor data provider alone is No. Exposure mapping with no vulnerability/damage modelling is No. Score Yes only when a vulnerability-method feature is quoted.",
  "A methodology-section passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote describing a vulnerability/damage-function method.",
  "Damage-function or design-threshold modelling; asset-sensitivity analysis; stated spatial resolution (e.g. asset-level downscaling); supply-chain nodes included in the vulnerability model.",
  "Naming a data vendor ('we use [vendor] climate data') with no method. Hazard exposure mapping with no vulnerability modelling (exposure is B3). Scenario choice (that is B2).",
  ["Vulnerability was modelled with asset-specific damage functions calibrated to flood depth and wind speed, at 90m resolution, including tier-1 supplier sites.",
   "We applied design-threshold analysis (temperature, flood depth) to each facility to estimate damage and downtime, not just exposure."],
  ["We use a leading third-party climate data provider to assess our physical risks.",
   "Our methodology maps our sites against climate hazard layers."],
  ["vulnerability", "damage function", "design threshold", "sensitivity", "resolution", "downscaling", "methodology"],
  ["Sustainability/ESG Report", "CDP response", "Risk Management Disclosure", "Annual Report"],
  0.20,
  "v1 3.2=0.69, 3.6=0.65; harder vulnerability-method bar (vendor data no longer scores). " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Risk Management Disclosure", "Annual Report"]),

M("B5-valuechain-infra-exposure", 2,
  "Value-chain and infrastructure exposure, with stated coverage",
  "Assesses exposure assessment of the value chain (suppliers/logistics) AND dependence on external infrastructure (grid, water, ports, transport). [TCFD/IFRS S2 mapping: Strategy/Risk Management.] Retains v1 3.5 and adds the infrastructure element; supplier ACTIONS move to C7.",
  "Yes requires EITHER (a) assessment of critical/tier-1 suppliers with a stated coverage figure (e.g. '% of direct spend screened'), OR (b) identification of dependence on named external infrastructure (grid/water/ports/transport) as a physical-climate vulnerability. This measures EXPOSURE/assessment; supplier response ACTIONS (dual-sourcing etc.) are scored in C7.",
  "A generic 'our supply chain may be disrupted' is No. Score Yes only when supplier coverage is stated OR a named infrastructure dependence is identified as a climate vulnerability.",
  "A supply-chain table plus its header, or a CDP supply-chain answer, counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the supplier coverage figure or the named infrastructure dependence.",
  "Supplier screening with stated coverage ('65% of direct spend screened for flood/heat'); identification of grid/water/port/transport dependence as a physical vulnerability.",
  "Generic supply-chain disruption statements with no coverage or infrastructure naming. Supplier ACTIONS such as dual-sourcing (that is C7). Own-site screening (that is B3).",
  ["We screened suppliers representing 65% of direct spend for flood and heat exposure, and identified reliance on two ports exposed to storm surge.",
   "Our Gulf Coast operations depend on a single regional grid; we assessed its exposure to hurricane-driven outage."],
  ["Climate change could affect our suppliers and logistics networks.",
   "We rely on global supply chains that may face disruption."],
  ["supply chain", "supplier", "tier-1", "logistics", "grid", "water", "ports", "transport", "infrastructure dependence", "coverage"],
  ["Sustainability/ESG Report", "CDP response", "Supply chain section", "Annual Report"],
  0.20,
  "v1 3.5=0.33; retained with infra element; coverage still required. " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Supply chain section", "Annual Report"]),

M("B6-financial-impact", 2,
  "Quantified financial impact of physical climate risk (loss estimate)",
  "Assesses a QUANTIFIED financial impact or loss estimate from physical climate risk. [TCFD/IFRS S2 mapping: Strategy b)/Metrics.] Retains v1 2.5 with cross-measure examples removed and test (d) deleted. Kept distinct from B7 (exposed value).",
  "Yes requires a quantified estimate of the FINANCIAL IMPACT or expected LOSS from physical climate risk (e.g. $ value-at-risk, expected annual loss, EBITDA impact). The figure must be an impact/loss estimate, NOT an exposure value (that is B7) and NOT resilience spend (that is C2). The v1 near-universal 'company-authored report' test is deleted.",
  "An exposure value (assets in high-hazard zones) is No here — that is B7. Resilience capex is No here — that is C2. Score Yes only when a loss/impact figure is quoted.",
  "A financial-notes passage or quantification table plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the loss/impact figure.",
  "An expected annual loss, value-at-risk, or modelled EBITDA/revenue impact from physical hazards, stated as a monetary figure or percentage of financials.",
  "An exposure value such as 'assets worth $X in high-hazard zones' (that is B7). Resilience/adaptation spend figures (that is C2). Qualitative 'material financial impact' with no number. A company-authored climate report presented as if it were itself the evidence of quantification.",
  ["We estimate physical climate risks could reduce EBITDA by up to $180m per year by 2050 under RCP8.5.",
   "Modelled expected annual loss from flooding across our estate is $42m (2024)."],
  ["We hold $2.1bn of assets in regions exposed to physical climate hazards.",
   "We have invested $200m in resilience measures.",
   "Physical climate risks could have a material financial impact on the Group."],
  ["financial impact", "expected annual loss", "value at risk", "EBITDA impact", "loss estimate", "quantified"],
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Sustainability/ESG Report"],
  0.10,
  "v1 2.5=0.10; retained, examples cleaned, impact/loss-only bar. " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Sustainability/ESG Report"]),

M("B7-gross-residual-exposure", 2,
  "Gross vs residual exposed-value metric (IFRS S2 29(b) / ESRS E1 66)",
  "Assesses disclosure of the amount and share of assets EXPOSED to physical risk, split acute/chronic, with a GROSS (before adaptation) versus RESIDUAL (after adaptation) distinction. [TCFD/IFRS S2 mapping: Metrics — IFRS S2 para 29(b); ESRS E1 para 66 = value of assets exposed, NOT expected loss.] Retains v1 4.1 with alignment and coverage.",
  "Yes requires a disclosed amount AND percentage of assets exposed to physical risk, with EITHER an acute/chronic split OR an explicit gross-versus-residual (before/after adaptation) distinction. Per EFRAG's ESRS E1 66 Q&A this is EXPOSED VALUE, not expected loss (loss is B6). A single exposure number with no split/residual framing is the floor and is No.",
  "A loss estimate is No here — that is B6. A bare 'assets in high-hazard areas' with no % and no split is No. Score Yes only when the exposed amount+% with an acute/chronic or gross/residual split is quoted.",
  "A metrics table plus its header (exposed value | % of assets | gross/residual) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the exposed amount and percentage with a split.",
  "Amount and % of assets/PP&E exposed to acute vs chronic hazards; gross exposed value before adaptation and residual after adaptation; an IFRS S2 29(b)-aligned exposure metric.",
  "An expected-loss figure (that is B6). A single exposure number with no percentage or split. Spend on resilience (that is C2).",
  ["12% of net PP&E ($1.9bn) is exposed to acute hazards and 7% ($1.1bn) to chronic hazards; after completed flood defences, residual acute exposure falls to 8%.",
   "Gross assets exposed to physical risk: $2.4bn (14% of total); residual after adaptation: $1.6bn (9%)."],
  ["We estimate annual losses of $40m from flooding.",
   "Some of our assets are located in areas exposed to physical climate hazards."],
  ["exposed value", "assets exposed", "% of assets", "acute", "chronic", "gross", "residual", "before adaptation", "IFRS S2"],
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Sustainability/ESG Report"],
  0.05,
  "v1 4.1=0.43 but no coverage/split; harder gross/residual bar. " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Sustainability/ESG Report"]),

M("B8-erm-integration-prioritisation", 2,
  "Physical climate risk integrated and prioritised in ERM",
  "Assesses whether physical climate risk is integrated into enterprise risk management AND prioritised/ranked against other risks. [TCFD/IFRS S2 mapping: Risk Management c).] Merges v1 3.3 (ERM integration) + 3.4 (prioritisation).",
  "Yes requires BOTH (a) physical climate risk embedded in the enterprise risk management process (named in the risk register/ERM framework) AND (b) a prioritisation/ranking signal — a risk rating, materiality score, or placement among the company's principal/top risks. Integration without any prioritisation is the floor and is No.",
  "Listing climate among emerging risks with no rating is No. Score Yes only when both ERM integration and a prioritisation/rating are quoted.",
  "A risk-register row plus its header (risk | rating | owner) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote showing physical climate risk in the ERM process with a rating/ranking.",
  "Physical climate risk in the risk register with a likelihood/impact rating; listed among principal risks; a materiality ranking placing it relative to other risks.",
  "Climate listed among 'emerging risks' with no rating or ranking. A generic statement that climate is 'integrated into risk management' with no prioritisation. Oversight structure (that is A1).",
  ["Physical climate risk is a principal risk in our risk register, rated high likelihood / high impact, reviewed by the Risk Committee.",
   "Our ERM framework scores physical climate risk at 16/25, placing it third among our top enterprise risks."],
  ["Climate change is considered among our emerging risks.",
   "We integrate climate-related risks into our risk management processes."],
  ["enterprise risk management", "ERM", "risk register", "principal risk", "risk rating", "prioritisation", "materiality"],
  ["Annual Report", "Risk Management Disclosure", "CDP response"],
  0.30,
  "v1 3.3=0.61, 3.4=0.47; merged, prioritisation required. " + _PRIOR,
  ["Annual Report", "Risk Management Disclosure", "CDP response"]),

# ══════════════════ PILLAR C — ANTICIPATE ══════════════════
M("C1-adaptation-strategy", 3,
  "Adaptation/resilience strategy linked to capex or site plans",
  "Assesses a climate adaptation/resilience strategy that is LINKED to capital allocation or site plans, not merely named. [TCFD/IFRS S2 mapping: Strategy.] Retains v1 2.8 with a raised bar.",
  "Yes requires a named adaptation/resilience strategy AND an explicit link to capex or site-level plans (a budget line, a programme tied to specific sites, or an investment commitment). A strategy stated in the abstract is the floor and is No.",
  "A named strategy with no capex/site linkage is No. Score Yes only when the strategy is tied to spend or specific site plans.",
  "A strategy passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote tying the strategy to capex or named site plans.",
  "A resilience strategy with an attached capex programme or site-adaptation plans; a named multi-year adaptation plan with budget.",
  "A named adaptation strategy with no capex or site linkage. Capex AMOUNTS alone (that is C2). Individual implemented actions (that is C3).",
  ["Our Climate Resilience Strategy is backed by a $300m 2024-2028 programme covering flood defences at 14 named sites.",
   "The adaptation strategy sets site-level resilience plans for all high-risk facilities, funded through the annual resilience capex line."],
  ["We have a climate adaptation strategy.",
   "Resilience is a key pillar of our sustainability approach."],
  ["adaptation strategy", "resilience strategy", "capex", "site plan", "investment", "programme"],
  ["Sustainability/ESG Report", "Annual Report", "Strategy section", "CDP response"],
  0.25,
  "v1 2.8=0.47; raised to require capex/site linkage. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "Strategy section", "CDP response"]),

M("C2-resilience-capital", 3,
  "Resilience capital allocation with share of total capex",
  "Assesses capital allocation to physical-resilience measures with an amount AND its share of total capex (or spend-vs-plan over time). [TCFD/IFRS S2 mapping: Strategy/Metrics.] Merges v1 2.9 (plans) + 4.3 (amounts).",
  "Yes requires a disclosed resilience/adaptation capital AMOUNT together with its share of total capex OR a multi-year spend-vs-plan comparison. A plan with no amount is the floor and is No; an amount with no denominator/share is weaker but a quantified multi-year spend qualifies.",
  "A resilience plan with no amount is No. A one-off amount with no share and no time series is borderline — require either a % of total capex or a spend-vs-plan trend. Score Yes only when the amount+share/trend is quoted.",
  "A capex table plus its header (resilience spend | % of capex) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the amount and its share/trend.",
  "Resilience capex stated as an amount and % of total capex; a multi-year resilience investment track with spend vs plan.",
  "A resilience plan with no amount. An avoided-loss business case for the spend (that is C9). Strategy without spend (that is C1). The exposure value protected (that is B7).",
  ["Resilience capex was $210m in 2024 (6% of group capex), rising to a committed $900m over 2024-2028.",
   "We have spent $140m of the planned $180m flood-defence programme to date (78%)."],
  ["We invest in climate resilience.",
   "We have a plan to increase spending on adaptation."],
  ["resilience capex", "adaptation investment", "% of capex", "spend vs plan", "capital allocation", "amount invested"],
  ["Annual Report", "Financial Statements / Notes", "Capital expenditure section", "CDP response"],
  0.15,
  "v1 2.9=0.20, 4.3=0.10; merged, amount+share bar. " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "Capital expenditure section", "CDP response"]),

M("C3-implemented-mitigation", 3,
  "Implemented mitigation actions at a stated share of high-risk sites",
  "Assesses physical-risk mitigation actions actually IMPLEMENTED, graded by the share of high-risk sites covered, and crediting only actions that address an identified mechanism. [TCFD/IFRS S2 mapping: Strategy/Risk Management.] Merges v1 3.7 (actions) with v1 2.7 (business-model mechanism) as a precondition/context.",
  "Yes requires NAMED, implemented mitigation actions (completed or in delivery, not intent) addressing a physical-risk mechanism the company has identified, with a stated share of high-risk sites covered. Actions must be concrete (built/installed/operational), not planned. 'We take action on climate risk' is No.",
  "Planned or intended actions are No (that is C1/strategy). Score Yes only when a named implemented action with a stated site-coverage share is quoted. Credit actions only where they address an identified mechanism (old 2.7 as precondition).",
  "An actions table plus its header (site | measure | status) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of a completed action and the share of high-risk sites covered.",
  "Flood barriers/pumps installed, cooling retrofits completed, elevation works done — named and with a stated share of high-risk sites addressed.",
  "Planned or committed future actions with no implementation (that is C1). Capex amounts (that is C2). Supplier actions (that is C7). Asset relocation/divestment (that is C6).",
  ["Flood defences have been installed at 11 of 14 high-risk sites (79%); cooling upgrades completed at all 6 heat-exposed plants.",
   "We have implemented drainage and elevation works at the majority (82%) of facilities identified as high flood risk."],
  ["We are taking action to address physical climate risks.",
   "We plan to install flood defences at key sites."],
  ["installed", "implemented", "completed", "flood defence", "cooling", "elevation", "retrofit", "high-risk sites", "share"],
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Risk Management Disclosure"],
  0.25,
  "v1 3.7=0.69 but mixed ad-hoc; harder implemented+coverage bar. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Risk Management Disclosure"]),

M("C4-insurability-strategy", 3,
  "Insurability strategy (not mere insurance use)",
  "Assesses a strategic response to insurability of physical risk — premium/deductible trends, cover withdrawn, captives/parametric cover, or disclosed uninsured exposure. [TCFD/IFRS S2 mapping: Strategy/Risk Management.] Reframes v1 2.10 (insurance use) which was near-universal.",
  "Yes requires a SUBSTANTIVE insurability signal: a stated premium/deductible trend, cover reduced or withdrawn, use of a captive or parametric instrument for climate perils, or a disclosed uninsured/self-insured exposure. Merely 'we maintain insurance' is No.",
  "A generic statement that the company holds insurance is No. Score Yes only when a trend, structural instrument, or uninsured-exposure figure is quoted. Note the red-flag signal (insurer non-renewal/withdrawal) is relevant negative context here.",
  "An insurance-note passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the premium/cover trend, captive/parametric instrument, or uninsured-exposure figure.",
  "Rising premiums/deductibles for climate perils; cover withdrawn or non-renewed; a captive or parametric scheme for flood/wind; a disclosed uninsured exposure amount.",
  "'We maintain appropriate insurance cover.' Generic risk-transfer statements. A loss estimate (that is B6). RED FLAG to weigh: insurer non-renewal or withdrawal signalling declining insurability (folded E4 signal) is material negative context, not a Yes on its own.",
  ["Property premiums for our Gulf Coast assets rose 34% in 2024 and we increased deductibles; we established a captive to retain $50m of flood risk.",
   "One insurer declined to renew wind cover on two Caribbean sites, and we now carry $30m of uninsured exposure, disclosed here."],
  ["We maintain comprehensive insurance cover for our assets.",
   "Insurance is part of our risk management approach."],
  ["insurability", "premium", "deductible", "captive", "parametric", "non-renewal", "uninsured", "self-insured", "cover withdrawn"],
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Risk Management Disclosure"],
  0.15,
  "v1 2.10=0.20 (presence); reframed to insurability-strategy signals. " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "CDP response", "Risk Management Disclosure"]),

M("C5-siting-ma-design-standards", 3,
  "Physical risk in siting, M&A and design standards",
  "NEW. Assesses whether new assets and acquisitions are screened for physical risk, and whether assets are built to FUTURE climate rather than historical. [TCFD/IFRS S2 mapping: Strategy.]",
  "Yes requires EITHER (a) physical-risk screening embedded as standard practice in site selection or M&A due diligence, OR (b) a design basis that uses PROJECTED (not historical) climate — e.g. a future 1-in-100-year flood level or forward heat/wind design temperatures. The discriminating depth is a named decision changed or a deal repriced on physical-risk grounds.",
  "A one-off site study is No. Score Yes only when screening is stated as standard practice in siting/M&A OR a forward-looking design basis is quoted. A named decision/repricing is the strongest evidence.",
  "A due-diligence or engineering-standard passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the siting/M&A screen or forward design basis.",
  "Climate screening as a standard due-diligence step; a design basis referencing projected return periods or future design temperatures; a named acquisition repriced or site rejected on physical-risk grounds.",
  "Screening existing sites for exposure (that is B3). Hardening EXISTING assets (that is C6). Generic 'we consider climate in investment decisions' with no screen or design basis.",
  ["All capital projects and acquisitions pass a mandatory physical-climate due-diligence screen; new facilities are designed to the projected 2050 1-in-100-year flood level.",
   "We repriced a 2024 acquisition after due diligence revealed two target sites in high storm-surge zones."],
  ["We consider sustainability in our investment decisions.",
   "Our engineering standards meet local building codes."],
  ["site selection", "due diligence", "M&A", "design standard", "design basis", "return period", "projected climate", "future flood level"],
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Strategy section"],
  0.10,
  "New measure; binary gate on standard-practice screening or forward design basis. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Strategy section"]),

M("C6-asset-portfolio-decisions", 3,
  "Asset portfolio decisions on high-risk assets",
  "NEW. Assesses relocation, divestment, retirement or hardening of high-risk assets, with coverage of high-risk sites. [TCFD/IFRS S2 mapping: Strategy.]",
  "Yes requires NAMED portfolio decisions on high-risk assets — relocations, divestments, retirements or hardening programmes — with a stated share of high-risk sites covered. Site-specific adaptation plans for a stated share of high-risk sites is the floor; named decisions with a coverage figure is the Yes bar. Residual exposure reduced (links B7) is the strongest evidence.",
  "Intent to 'review the portfolio' is No. Score Yes only when a named relocation/divestment/retirement/hardening decision with a site-coverage share is quoted.",
  "A portfolio-decision passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of a named decision and the share of high-risk sites covered.",
  "Named relocations, divestments, retirements or hardening programmes; site-specific adaptation plans covering a stated share of high-risk sites; residual exposure reduced.",
  "Capex AMOUNTS for the programme (that is C2). Design standards for NEW assets (that is C5). Implemented operational mitigations such as flood barriers (that is C3). Generic 'we manage our portfolio for climate risk'.",
  ["We divested two coastal terminals in the top flood-risk quintile and relocated a distribution centre out of a high-surge zone; site adaptation plans now cover 88% of high-risk sites.",
   "A hardening programme covers all 9 high-risk refineries, cutting residual exposed value by $400m (see B7)."],
  ["We keep our asset portfolio under review for climate risks.",
   "We may consider relocating assets in future."],
  ["relocate", "divest", "retire", "harden", "site adaptation plan", "high-risk sites", "portfolio decision"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "Strategy section"],
  0.08,
  "New measure; binary gate on named portfolio decisions with coverage. " + _PRIOR,
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "Strategy section"]),

M("C7-supplychain-resilience-actions", 3,
  "Supply-chain resilience actions (not assessment)",
  "NEW. Assesses ACTIONS to reduce supplier/logistics exposure — dual/regional sourcing, buffer stock, supplier adaptation requirements — not assessment. [TCFD/IFRS S2 mapping: Strategy.]",
  "Yes requires NAMED actions for critical inputs: dual/multi-sourcing, regional diversification, safety/buffer-stock policy, or adaptation requirements written into supplier contracts. The discriminating depth is coverage of critical spend and/or a disruption avoided or contained in an event. Assessment/screening of suppliers is NOT this measure.",
  "Supplier screening/assessment is No here — that is B5. Score Yes only when a named resilience ACTION for critical inputs is quoted.",
  "A procurement/supplier passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the named supply-chain resilience action.",
  "Dual-sourcing agreed for critical inputs; nearshoring/regional diversification; buffer-stock policy; adaptation clauses in supplier contracts; a disruption contained in a named event.",
  "Supplier EXPOSURE screening or coverage (that is B5). Own-site actions (that is C3). Generic 'we work with suppliers on resilience' with no named action.",
  ["For the 9 highest-risk suppliers identified, we agreed dual-sourcing for 7 and hold 60-day buffer stock for two critical chemicals.",
   "Supplier contracts for critical inputs now require a climate-adaptation plan; during the 2024 Gulf hurricane we switched to a pre-qualified alternate and avoided a line stoppage."],
  ["We assess physical climate risks across our supply chain.",
   "We engage with our suppliers on sustainability."],
  ["dual sourcing", "multi-sourcing", "safety stock", "buffer stock", "nearshoring", "supplier requirements", "regional diversification"],
  ["Sustainability/ESG Report", "Annual Report", "Supply chain section", "CDP response"],
  0.15,
  "New measure; binary gate on named supply-chain actions (excludes B5 screening). " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "Supply chain section", "CDP response"]),

M("C8-water-security", 3,
  "Water security for sites in water-stressed basins",
  "NEW. Assesses plans for sites in water-stressed basins (chronic risk). [TCFD/IFRS S2 mapping: Strategy/Risk Management.]",
  "Yes requires EITHER (a) identification of sites in high-water-stress basins with a stated share, OR (b) site water plans with targets (reuse, storage, alternative supply). The discriminating depth is a withdrawal/outage trend improving. Mere acknowledgement of water risk is No.",
  "A generic 'water is a risk' statement is No. Score Yes only when a stated share of sites in stressed basins OR a site water plan with targets is quoted.",
  "A water-disclosure passage or CDP Water answer plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the stressed-basin share or a water plan with a target.",
  "Sites in high-stress basins identified with a stated share (e.g. via WRI Aqueduct); site water-resilience plans with reuse/storage/alternative-supply targets; an improving withdrawal/outage trend.",
  "Generic water-risk acknowledgement. Flood (acute) exposure (that is B1/B3). Drought named as a hazard with no plan (that is B1).",
  ["28% of our sites sit in Aqueduct high/extremely-high water-stress basins; each has a water-resilience plan targeting 30% reuse by 2027.",
   "At our three most water-stressed plants we installed storage and recycling, cutting freshwater withdrawal 22% since 2022."],
  ["Water is an important resource for our business.",
   "We recognise drought as a climate hazard."],
  ["water stress", "basin", "Aqueduct", "water resilience", "water reuse", "freshwater withdrawal", "alternative supply"],
  ["Sustainability/ESG Report", "CDP response", "Annual Report"],
  0.12,
  "New measure; binary gate on stressed-basin coverage or water plans with targets. " + _PRIOR,
  ["Sustainability/ESG Report", "CDP response", "Annual Report"]),

M("C9-adaptation-investment-appraisal", 3,
  "Adaptation investment appraisal (avoided-loss basis)",
  "NEW. Assesses whether resilience spending is chosen on an avoided-loss / cost-benefit basis, not ad hoc. [TCFD/IFRS S2 mapping: Strategy/Metrics; aligns to PCRAM 2.0.]",
  "Yes requires a STATED cost-benefit or avoided-loss test applied to resilience capex. The discriminating depth is a disclosed hurdle rate or benefit-cost ratio, and strongest is a realised avoided loss reported. Spending without an appraisal method is No.",
  "Disclosing a resilience spend amount is No here — that is C2. Score Yes only when an appraisal method (cost-benefit, avoided loss, BCR, hurdle rate) is quoted.",
  "An appraisal/business-case passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the avoided-loss/cost-benefit test or BCR.",
  "A cost-benefit or avoided-loss test for resilience projects; a disclosed benefit-cost ratio or hurdle rate; a realised avoided loss reported after an event.",
  "A resilience spend AMOUNT with no appraisal method (that is C2). Generic 'we assess returns on investment'. The exposure value protected (that is B7).",
  ["Each resilience project must clear a benefit-cost ratio of >1.5 on modelled avoided loss; our flood-defence programme shows a BCR of 2.3.",
   "A 2024 levee upgrade appraised at $18m avoided a modelled $45m loss when the river peaked in Q3 (realised avoided loss)."],
  ["We invest in resilience where it makes commercial sense.",
   "We spent $50m on adaptation measures."],
  ["cost-benefit", "avoided loss", "benefit-cost ratio", "BCR", "hurdle rate", "resilience business case", "appraisal"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "Capital expenditure section"],
  0.05,
  "New measure; binary gate on appraisal method/avoided-loss. " + _PRIOR,
  ["Annual Report", "Sustainability/ESG Report", "CDP response", "Capital expenditure section"]),

M("C10-workforce-heat-stress", 3,
  "Workforce heat-stress protocols",
  "NEW. Assesses protocols that protect workers and productivity in heat. [TCFD/IFRS S2 mapping: Strategy/Risk Management.] Not applicable to fully remote/indoor-only businesses; absence of outdoor/non-air-conditioned staff is a legitimate No-context, not a failing.",
  "Yes requires stated heat protocols for outdoor or non-air-conditioned staff with coverage. The discriminating depth is defined thresholds (e.g. WBGT triggers), monitoring and rest-shade-water rules; strongest is a lost-time or productivity trend reported. Generic 'we care about worker wellbeing' is No.",
  "Generic worker-safety statements are No. Score Yes only when heat-specific protocols with coverage, or WBGT thresholds/monitoring, are quoted. For businesses with no heat-exposed workforce, expect No (not applicable) — do not infer a protocol.",
  "A health-and-safety passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the heat protocol with coverage or thresholds.",
  "Heat protocols for outdoor/non-AC workers with stated coverage; WBGT or temperature triggers, monitoring and work-rest/shade/water rules; a lost-time or productivity trend.",
  "Generic occupational-health statements with no heat specifics. Cooling retrofits of buildings/assets (that is C3). Extreme heat named only as a hazard (that is B1).",
  ["Heat-stress protocols cover all 12,000 outdoor field staff: WBGT monitoring, mandatory work-rest cycles above 30C WBGT, and shaded hydration points; heat lost-time incidents fell 40% since 2022.",
   "All non-air-conditioned plants operate a heat action plan with temperature triggers and rest schedules."],
  ["We are committed to the health and safety of our employees.",
   "We monitor working conditions at our sites."],
  ["heat stress", "WBGT", "heat illness", "work-rest", "heat action plan", "outdoor workers", "hydration"],
  ["Sustainability/ESG Report", "Annual Report", "CDP response"],
  0.08,
  "New measure; binary gate on heat protocols with coverage/thresholds. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "CDP response"]),

# ══════════════════ PILLAR D — RESPOND AND RECOVER ══════════════════
M("D1-business-continuity-tested", 4,
  "Climate business continuity, covered and tested",
  "Assesses climate-specific business continuity with STATED coverage AND testing. [TCFD/IFRS S2 mapping: Risk Management/Strategy.] Retains v1 3.8 and folds in the testing element; v1 title promised 'all/majority of operations' with no coverage test.",
  "Yes requires business continuity plans that (a) cover a STATED share of sites, (b) name the physical hazards addressed and an owner, AND (c) are TESTED — a stated testing frequency, climate-scenario exercises, or recovery-time objectives (RTOs). A continuity plan that merely 'covers extreme weather' with no coverage or testing is the floor and is No.",
  "An untested plan, or one with no coverage figure, is No. Score Yes only when stated coverage AND a testing/RTO element are quoted together.",
  "A BCP passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote showing stated site coverage and a testing/RTO element.",
  "Continuity plans covering a stated share of sites, naming hazards and an owner, tested at a stated frequency or against climate scenarios, with recovery-time objectives.",
  "A continuity plan with no coverage figure or no testing. Early-warning/pre-event triggers (that is D2). Actual recovery performance after an event (that is D3).",
  ["Business continuity plans cover 94% of sites, name flood/heat/wind hazards with a site owner, are tested annually against climate scenarios, and set a 48-hour recovery-time objective.",
   "Climate BCPs cover all tier-1 manufacturing sites and are exercised twice a year with defined RTOs."],
  ["We have business continuity plans in place for extreme weather.",
   "Our operations are supported by continuity planning."],
  ["business continuity", "BCP", "recovery time objective", "RTO", "tested", "scenario exercise", "coverage", "owner"],
  ["Annual Report", "Sustainability/ESG Report", "Business continuity section", "CDP response"],
  0.20,
  "v1 3.8=0.57 but no coverage/testing; harder coverage+tested bar. " + _PRIOR,
  ["Annual Report", "Sustainability/ESG Report", "Business continuity section", "CDP response"]),

M("D2-early-warning-triggers", 4,
  "Early warning and pre-event triggers",
  "NEW. Assesses monitoring and triggers that act BEFORE events hit. [TCFD/IFRS S2 mapping: Risk Management.]",
  "Yes requires a named monitoring/alert system AND defined pre-event triggers that drive action (pre-positioning stock, safe shutdown, redeployment). A named system alone is the floor; defined triggers are the Yes bar; documented use in a named event is strongest.",
  "Simply subscribing to a weather feed is No. Score Yes only when defined triggers tied to actions are quoted.",
  "A preparedness passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the trigger and the action it drives.",
  "A named early-warning/forecast system with defined thresholds that trigger pre-positioning, safe shutdown or redeployment; documented use in a named event.",
  "A continuity plan generally (that is D1). Post-event recovery (that is D3). A weather-monitoring mention with no triggers or actions.",
  ["Our hurricane-preparedness protocol triggers staged shutdown and stock pre-positioning at defined forecast thresholds (72/48/24h); it was activated for Hurricane Helene in 2024.",
   "A heat early-warning system triggers work-rest escalation and redeployment above defined WBGT forecasts."],
  ["We monitor weather forecasts for our sites.",
   "We prepare for severe weather events."],
  ["early warning", "forecast trigger", "pre-positioning", "hurricane preparedness", "safe shutdown", "alert system", "threshold"],
  ["Sustainability/ESG Report", "Annual Report", "Business continuity section", "CDP response"],
  0.10,
  "New measure; binary gate on defined triggers driving action. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "Business continuity section", "CDP response"]),

M("D3-recovery-performance", 4,
  "Recovery performance after events",
  "NEW. Assesses how quickly operations recover after events, with reported performance. [TCFD/IFRS S2 mapping: Metrics; fed by financial-statement notes / transcripts per R6.]",
  "Yes requires reported recovery performance: actual downtime or time-to-restore by event, or performance against a recovery-time objective. Stated RTOs alone are the floor (also credited in D1); the Yes bar is ACTUAL downtime/restore data for a named event, strongest is an improving trend or peer-relative performance.",
  "An RTO target with no actual outcome is No here. Score Yes only when actual downtime/time-to-restore for an event is quoted. Repeated disruption at the same site with NO disclosed recovery is a red flag (folded E4 signal) and weighs negative.",
  "A post-event disclosure or financial-note passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of actual downtime/recovery for a named event.",
  "Actual downtime or time-to-restore by event; recovery measured against an RTO; an improving recovery trend across events.",
  "A recovery-time OBJECTIVE with no actual outcome (that is D1). Early-warning triggers (that is D2). RED FLAG: repeated disruption at the same site with no disclosed response (folded E4 signal) weighs negative, not Yes.",
  ["After the 2024 flood our main plant resumed partial output in 6 days and full output in 19, against a 21-day RTO; our 2022 recovery took 34 days, an improving trend.",
   "Following Cyclone Gabrielle our two affected sites were restored in 11 and 14 days, within objective."],
  ["We aim to recover quickly from disruptions.",
   "Our recovery-time objective is 30 days."],
  ["downtime", "time to restore", "recovery", "resumed operations", "days to recover", "restored", "RTO performance"],
  ["Annual Report", "Financial Statements / Notes", "Quarterly earnings report", "Sustainability/ESG Report"],
  0.08,
  "New measure; binary gate on actual recovery performance (not RTO targets). " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "Quarterly earnings report", "Sustainability/ESG Report"]),

# ══════════════════ PILLAR E — OUTCOMES AND LEARNING ══════════════════
M("E1-incident-loss-metrics", 5,
  "Quantified incident and loss metrics, with trend",
  "Assesses metrics on physical-climate incidents/disruptions, graded by quantification (cost/downtime) and trend. [TCFD/IFRS S2 mapping: Metrics.] Retains v1 4.4; fed by transcripts/10-Q/financial-statement notes (R6).",
  "Yes requires QUANTIFIED incident/loss metrics — a monetary loss, downtime, or number of disruptive events WITH a cost/downtime figure — and ideally a multi-period trend. A bare count of incidents with no quantification is the floor and is No.",
  "A count of incidents with no cost/downtime is No. Score Yes only when a quantified loss/downtime figure is quoted; a trend across periods is stronger. Rising UNINSURED losses are a red flag (folded E4 signal) and material negative context.",
  "A metrics table or financial note plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the quantified loss/downtime figure.",
  "Weather-related losses in $ or % of EBITDA; downtime days from climate events; insurance recoveries; a multi-year loss/downtime trend.",
  "A count of incidents with no cost or downtime. A forward-looking loss ESTIMATE (that is B6). RED FLAG: rising uninsured losses with no response (folded E4 signal) weigh negative, not Yes.",
  ["Weather-related losses were $61m in 2024 (down from $88m in 2023), with 540 site-days of downtime across 7 events; insurance recoveries of $37m.",
   "We disclose a three-year trend of climate-event downtime: 1,200, 940 and 610 days (2022-2024)."],
  ["We experienced several weather-related disruptions during the year.",
   "Climate events affected some of our operations."],
  ["weather-related loss", "downtime", "insurance recoveries", "incident metrics", "storm damage", "disruption days", "trend"],
  ["Annual Report", "Financial Statements / Notes", "Quarterly earnings report", "CDP response"],
  0.20,
  "v1 4.4=0.32 (count only); harder quantified+trend bar. " + _PRIOR,
  ["Annual Report", "Financial Statements / Notes", "Quarterly earnings report", "CDP response"]),

M("E2-targets-progress", 5,
  "Resilience targets with reported progress",
  "Assesses physical-resilience targets that are quantified, dated AND reported against. [TCFD/IFRS S2 mapping: Metrics/Targets.] Merges v1 4.2 (targets, flagged non-discriminating) + 4.5 (progress reporting).",
  "Yes requires a QUANTIFIED, DATED physical-resilience target AND reported progress against it. A target stated in the abstract is the floor and is No; the discriminating bar is quantification+date+progress. (Decarbonisation/emissions targets are out of scope — see negative keywords.)",
  "A qualitative or undated target is No. An emissions/net-zero target is out of scope (No). Score Yes only when a quantified dated resilience target AND progress against it are quoted.",
  "A targets table plus its header (target | baseline | progress) counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote of the quantified dated target and its reported progress.",
  "A quantified dated resilience target (e.g. 'reduce assets in high-hazard zones to <8% by 2028') with reported progress to date.",
  "A qualitative or undated resilience aspiration. Emissions/net-zero/decarbonisation targets (out of scope). Resilience capex plans (that is C2).",
  ["Target: cut net PP&E in high-hazard zones from 14% to 8% by 2028; at end-2024 we are at 11% (progress reported).",
   "We target 100% of high-risk sites with flood defences by 2026; 79% complete at year-end."],
  ["We aim to improve our climate resilience over time.",
   "We have set a net-zero target for 2040."],
  ["resilience target", "quantified target", "progress against target", "baseline", "by 2028", "% complete"],
  ["Annual Report", "Sustainability/ESG Report", "CDP response"],
  0.10,
  "v1 4.2=0.10 (flagged non-discriminating), 4.5=0.05; merged, progress required. " + _PRIOR,
  ["Annual Report", "Sustainability/ESG Report", "CDP response"]),

M("E3-post-event-learning", 5,
  "Post-event learning acted upon",
  "NEW. Assesses whether lessons from events are captured AND acted on. [TCFD/IFRS S2 mapping: Risk Management/Strategy.]",
  "Yes requires a post-event review process AND named changes to capex, plans or standards following a SPECIFIC event. A review process alone is the floor; named changes are the Yes bar; a lower repeat-event impact is strongest.",
  "A generic 'we learn from incidents' is No. Score Yes only when a specific event drove a named change (to capex, a plan, or a standard).",
  "A post-incident-review passage plus its header counts as one bounded passage if the quote includes the header text (R2). Minimum: a verbatim quote tying a named change to a specific event.",
  "A post-event/after-action review that led to named changes in capex, continuity plans or design standards; evidence of lower impact in a repeat event.",
  "A generic continuous-improvement statement. Continuity plan existence (that is D1). Recovery time for an event (that is D3).",
  ["After the 2023 flood at our Rotterdam site we raised the site design basis by 0.5m, added $20m of defences, and the 2024 high-water event caused no outage.",
   "Our post-incident review of Cyclone Gabrielle led to revised continuity plans and backup-power installation at all exposed NZ sites."],
  ["We continuously improve our resilience.",
   "We learn from operational incidents."],
  ["lessons learned", "post-incident review", "after-action", "following the event", "revised plans", "repeat event"],
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Quarterly earnings report"],
  0.08,
  "New measure; binary gate on named post-event changes. " + _PRIOR,
  ["Sustainability/ESG Report", "Annual Report", "CDP response", "Quarterly earnings report"]),
]

# assign display_order in authored sequence
for _i, _m in enumerate(MEASURES, start=1):
    _m["display_order"] = _i



# ══════════════════════════════════════════════════════════════════════════════
# FRAMEWORK-ROW CONFIG CHANGES (R1-R7)
# Each key is a frameworks-table column; value is the FULL new value to write.
# ══════════════════════════════════════════════════════════════════════════════

# ── R1 — anti_inference_rules: keep the 5 existing strict rules, add the cross-
#        measure integrated-oversight allowance (A1-A3 only). ──────────────────
_ANTI_INFERENCE_EXISTING = [
    "A general ESG or sustainability policy is not evidence of a physical climate risk policy unless it explicitly addresses physical climate hazards.",
    "A climate strategy or TCFD alignment statement is not evidence of physical climate risk management unless it explicitly addresses physical impacts (not just transition risks).",
    "A net-zero target, carbon reduction pathway, or emissions reduction commitment is not evidence of physical climate risk management.",
    "A business continuity plan or enterprise risk management framework is not evidence of physical climate risk management unless it explicitly addresses climate/weather disruptions.",
    "An environmental compliance or pollution control measure is not evidence of physical climate risk management.",
]
_ANTI_INFERENCE_R1 = (
    "R1 cross-measure allowance (Oversight pillar only): for A1-A3, oversight or policy framed as "
    "integrated 'climate-related risk' MAY supply the physical-attribution context at the floor level "
    "IF the company identifies physical climate risk as material elsewhere in the same reporting cycle. "
    "This allowance does NOT meet the Yes bar on its own — a depth/standard signal is still required — "
    "and it does NOT apply to pillars B-E, where strict explicit physical attribution remains mandatory."
)

# ── R3 — anchor_frameworks: remove SEC rule; add IIGCC CRIF + PCRAM 2.0; add
#        ISO 14091 and UK TPT adaptation guidance as references. Keep the rest. ─
ANCHOR_FRAMEWORKS = [
    {"name": "TCFD (Task Force on Climate-related Financial Disclosures)", "source": "https://www.fsb-tcfd.org/"},
    {"name": "ISSB IFRS S2 (Climate-related Disclosures)", "source": "https://www.ifrs.org/issued-standards/ifrs-sustainability-standards-navigator/ifrs-s2-climate-related-disclosures/"},
    {"name": "EU CSRD / ESRS E1 (Climate Change)", "source": "https://www.efrag.org/lab6"},
    {"name": "CDP Climate Change Questionnaire", "source": "https://www.cdp.net/"},
    {"name": "GRI 201-2 (Financial implications of climate change)", "source": "https://www.globalreporting.org/standards/gri-standards-download-center/"},
    {"name": "IIGCC Climate Resilience Investment Framework (CRIF)", "source": "https://www.iigcc.org/resources"},
    {"name": "PCRAM 2.0 (Physical Climate Risk Assessment Methodology)", "source": "https://www.eci.ox.ac.uk/news/oxford-researchers-help-investors-build-climate-resilience-infrastructure"},
    {"name": "ISO 14091 (Adaptation to climate change — vulnerability, impacts and risk assessment)", "source": "https://www.iso.org/standard/68508.html"},
    {"name": "UK TPT (Transition Plan Taskforce) adaptation guidance", "source": "https://transitiontaskforce.net/"},
]
# NOTE: the SEC Climate Disclosure Rule is intentionally REMOVED (SEC voted on
# 27 Mar 2025 to stop defending it; it never took effect). ISO 14091 and UK TPT
# links are provided for the analyst to verify before external publication.

# ── R4 — negative_keywords: remove "renewable energy" (it would exclude on-site
#        backup generation / microgrids installed for resilience). ─────────────
NEGATIVE_KEYWORDS = [
    "net zero", "carbon footprint", "Scope 1", "Scope 2", "Scope 3",
    "decarbonization", "emissions reduction", "transition plan", "carbon neutral",
    "ESG framework", "sustainability strategy", "environmental permits", "waste management",
]

# ── R5 — legacy_query_templates: replace weak/non-specific templates with
#        hazard- and action-specific ones. ──────────────────────────────────────
LEGACY_QUERY_TEMPLATES = [
    "\"{company}\" flood defence site {currentYear} OR {lastYear}",
    "\"{company}\" business interruption hurricane {currentYear} OR {lastYear}",
    "\"{company}\" dual sourcing climate {currentYear} OR {lastYear}",
    "\"{company}\" heat stress workers {currentYear} OR {lastYear}",
    "\"{company}\" weather-related impairment {currentYear} OR {lastYear}",
    "\"{company}\" site relocation flood risk {currentYear} OR {lastYear}",
    "\"{company}\" insurance non-renewal climate {currentYear} OR {lastYear}",
    "\"{company}\" water stress basin plan {currentYear} OR {lastYear}",
    "\"{company}\" asset hardening resilience capex {currentYear} OR {lastYear}",
    "\"{company}\" recovery time after storm {currentYear} OR {lastYear}",
]

# ── R6 — required_doc_types + populate empty operator fields. ─────────────────
REQUIRED_DOC_TYPES = [
    "Annual Report", "Sustainability/ESG Report", "Proxy Statement",
    "Corporate Governance Statement", "Website / Webpage", "Policy Document",
    "Stakeholder Engagement Report", "CDP response", "Presentation / Deck",
    "Risk management section", "Financial statements", "Strategy section",
    "Risk Management Disclosure", "Financial Statements / Notes", "Supply chain section",
    "Capital expenditure section", "Business continuity section", "Quarterly earnings report",
    # R6 additions:
    "Earnings call transcript", "Interim / 10-Q filing", "10-K filing",
    "Financial statement notes", "Remuneration Report",
]

KNOWN_DISCLOSURE_URLS = [
    {"name": "CDP Climate Change response (company disclosure)", "url": "https://www.cdp.net/en/responses"},
    {"name": "CDP full data / scores portal", "url": "https://www.cdp.net/en/data"},
]

AUTHORITATIVE_FILING_TYPES = [
    "10-K Item 1A (Risk Factors)",
    "10-K Item 7 (MD&A) — climate / weather impacts",
    "10-Q interim filing — subsequent-event and impairment notes",
    "Annual Report — Principal Risks and Uncertainties",
    "Financial statement notes — impairment, provisions, insurance recoveries",
    "Earnings call transcript (FMP)",
]

# ── R6 — retrieval_query_terms: keep existing hazard terms, add financial-
#        statement-note / event terms. ─────────────────────────────────────────
RETRIEVAL_QUERY_TERMS = [
    "flood", "flooding", "wildfire", "hurricane", "storm", "drought", "sea-level rise",
    "extreme weather", "heat stress", "precipitation", "climate adaptation",
    "climate resilience", "asset vulnerability", "climate hazard", "exposure assessment",
    "RCP", "climate scenario", "physical risk assessment", "infrastructure resilience",
    "supply chain disruption", "operational continuity", "climate modeling",
    "temperature increase", "water stress", "coastal flooding", "extreme heat",
    "climate vulnerability",
    # R6 financial-statement-note / event evidence terms:
    "weather-related", "storm damage", "insurance recoveries", "impairment",
    "accelerated depreciation", "provision", "business interruption",
    "weather-related impairment", "flood damage", "hurricane impact",
    "non-renewal", "uninsured loss", "recovery time", "downtime",
]

# ── R7 — scoring_persona + topic_description: reframe from disclosure assessment
#        to effectiveness in reducing exposure and responding/recovering. ───────
SCORING_PERSONA = (
    "You are an expert physical-climate-resilience analyst. Your task is NOT to grade the quality of "
    "disclosure, but to assess how EFFECTIVELY a company reduces the exposure of its business to the "
    "damaging effects of climate change — through forward-looking strategic decisions (asset portfolio, "
    "siting, supply-chain strategy, capital allocation, insurability) and through responsiveness "
    "(business continuity, early warning, recovery and learning). Judge the substance of actions, "
    "decisions and outcomes against the physical-risk materiality the company plausibly faces for its "
    "sector, qualitatively. Reward named decisions, stated coverage and quantified outcomes; do not "
    "reward awareness, intent or process description on their own."
)
TOPIC_DESCRIPTION = (
    "This framework evaluates how effectively companies minimise the exposure of their operations, assets "
    "and value chains to physical climate change, and how well they respond to and recover from physical "
    "climate events. It covers both acute hazards (floods, storms, wildfire, cyclone) and chronic hazards "
    "(sea-level rise, extreme heat, drought/water stress), organised into five resilience pillars — "
    "Oversight, Understand, Anticipate, Respond and Recover, and Outcomes and Learning. Effectiveness is "
    "judged against the physical-risk materiality of the company's sector, with weight on strategic action, "
    "response and demonstrated outcomes rather than on disclosure or process alone."
)

# Assemble the config change-set the apply script will write to the frameworks row.
FRAMEWORK_CONFIG = {
    "sub_area_structure": PILLARS,                                   # Change 1
    "anti_inference_rules": _ANTI_INFERENCE_EXISTING + [_ANTI_INFERENCE_R1],  # R1
    "anchor_frameworks": ANCHOR_FRAMEWORKS,                          # R3
    "negative_keywords": NEGATIVE_KEYWORDS,                          # R4
    "legacy_query_templates": LEGACY_QUERY_TEMPLATES,               # R5
    "required_doc_types": REQUIRED_DOC_TYPES,                        # R6
    "known_disclosure_urls": KNOWN_DISCLOSURE_URLS,                 # R6
    "authoritative_filing_types": AUTHORITATIVE_FILING_TYPES,       # R6
    "retrieval_query_terms": RETRIEVAL_QUERY_TERMS,                 # R6
    "scoring_persona": SCORING_PERSONA,                             # R7
    "topic_description": TOPIC_DESCRIPTION,                         # R7
}

# Note: R2 (table-row + header / CDP Q+A counts as one bounded passage, quote must
# include the header) is implemented INSIDE each measure's fallback_yes_criterion,
# since there is no framework-level single-passage column to change in this schema.

# ══════════════════════════════════════════════════════════════════════════════
# CHANGELOG ENTRY (appended to frameworks.intake_artefact.changelog)
# ══════════════════════════════════════════════════════════════════════════════
import datetime as _dt
CHANGELOG_ENTRY = {
    "date": _dt.date.today().isoformat(),
    "version": 2,
    "summary": (
        "v2 Physical Climate Risk Management — restructured from four TCFD pillars to five resilience "
        "pillars (Oversight / Understand / Anticipate / Respond and Recover / Outcomes and Learning); "
        "acted on all 30 v1 measures (9 merges, 2 retirements folded, targeted fixes to the rest) and "
        "added 9 new action/response/outcome measures; applied rule/config changes R1-R7. Net 30 -> 27 "
        "measures, with 16/27 (59%) on strategic action, response and outcomes. Adapted to the BINARY "
        "scoring engine: the reviewer's 0-4 maturity intent is encoded as a single raised coverage/depth "
        "Yes-gate per measure (see engine_adaptation_note). is_active unchanged."
    ),
    "changes": [
        "Change 1 (structure): sub_area_structure.type set to 'custom' with five resilience pillars A-E; TCFD/IFRS S2 retained as a per-measure mapping tag inside measure text.",
        "Measures: 30 v1 -> 27 v2. Merges: A1<-1.1+1.2+1.4; A2<-1.3+1.5; B1<-2.3+2.4; B2<-2.1+2.2; B3<-2.6+3.1; B4<-3.2+3.6; B8<-3.3+3.4; C2<-2.9+4.3; E2<-4.2+4.5. Retired-and-folded: 1.7->A1 (descriptor), 2.7->C3 (precondition). Retained+fixed: 1.6->A3, 2.5->B6, 3.5->B5, 3.7->C3, 2.8->C1, 2.10->C4, 3.8->D1, 4.1->B7, 4.4->E1.",
        "New measures added (9): C5 siting/M&A/design standards, C6 asset-portfolio decisions, C7 supply-chain resilience actions, C8 water security, C9 adaptation investment appraisal, C10 workforce heat stress, D2 early-warning triggers, D3 recovery performance, E3 post-event learning. (B5 infrastructure dependencies and D1 scenario-testing folded into existing measures.)",
        "R1: added a cross-measure anti-inference allowance for Oversight (A1-A3) only — integrated climate-risk oversight supplies physical context at the floor where physical risk is identified as material in the same cycle; strict explicit physical attribution retained for pillars B-E.",
        "R2: each measure's fallback_yes_criterion now allows a table row plus its header/caption, or a CDP question plus its answer, to count as one bounded passage, provided the quote includes the header text.",
        "R3: removed the SEC Climate Disclosure Rule from anchor_frameworks; added IIGCC CRIF and PCRAM 2.0; added ISO 14091 and UK TPT adaptation guidance as references (links to be verified before external publication).",
        "R4: removed 'renewable energy' from negative_keywords so on-site backup generation / microgrids installed for resilience are not excluded.",
        "R5: replaced 8 weak legacy_query_templates with 10 hazard- and action-specific templates.",
        "R6: added earnings-call transcripts, interim/10-Q and 10-K filings and financial-statement notes to required_doc_types; populated known_disclosure_urls (CDP) and authoritative_filing_types (10-K Item 1A, principal risks, FS notes); added financial-statement-note/event terms to retrieval_query_terms.",
        "R7: reframed scoring_persona and topic_description from disclosure assessment to assessing effectiveness in reducing exposure and in responding/recovering, judged against sector materiality qualitatively.",
    ],
    "engine_adaptation_note": (
        "The production scorer is BINARY (Yes/No) only; it has no 0-4 level engine and no columns for "
        "levelAnchors, expectedLevelDistribution, tcfdMapping or applicability. The reviewer's graded "
        "0-4 maturity scale (Change 2) could NOT be implemented as a scale. Instead, for each measure the "
        "level-2/level-3 bar was translated into a SINGLE discriminating Yes gate: awareness measures were "
        "raised to require company-stated coverage/depth (never inferred); action/response/outcome measures "
        "require a named action, decision or quantified outcome. Coverage thresholds from the feedback "
        "(>=50%/>=80%) are expressed as the Yes bar in substantive_definition/scoring_guidance. Overlap is "
        "controlled by naming each neighbour measure in what_does_not_constitute_evidence. expected_yes_rate "
        "values are judgement PRIORS pending a re-score of the test sample."
    ),
    "deferred": [
        "Full 0-4 maturity scale with per-level anchors (needs a graded scoring engine + schema columns levelAnchors/expectedLevelDistribution).",
        "Sector-materiality weighting + inherent-exposure score + management-gap + financials variant (Change 3) — needs external vendor asset-location data not held on the platform, plus a weighting/aggregation layer.",
        "Event-based revealed-resilience module (Change 4) — partially approximated by R5/R6 pulling transcript/10-Q/FS-note event evidence into existing retrieval; a true module needs an event list + per-company-event exposure matching.",
        "E4 red flags as a scored NEGATIVE measure (0/-1/-2) — engine has no negative scoring; its signals are folded into the what_does_not_constitute_evidence / insurability wording of C4, D3 and E1.",
    ],
    "measure_count": {"v1": 30, "v2": 27},
    "is_active_unchanged": True,
    "reversible_from_backup": "framework20_backup_20261101T015256Z.json",
}
