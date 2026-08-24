/**
 * I73: Layered Anti-Inference Rules
 *
 * The scorer applies anti-inference rules from three layers, composed at
 * measure-scoring time:
 *
 *   Layer 1 — UNIVERSAL_RULES: apply to every measure of every framework.
 *             Cover cross-topic false-positive patterns (published vs referenced,
 *             corporate boundary, recency, sustainability-vs-proxy hierarchy,
 *             explicit-vocabulary discipline). Extracted from empirical
 *             analysis of FP audits across fw3, fw8 and fw9.
 *
 *   Layer 2 — MEASURE_FAMILY_RULES: apply to any measure whose measureId or
 *             title matches a family pattern (e.g. "-policy-published" gets
 *             the published-vs-referenced rule; "board-oversight" gets the
 *             charter-vs-proxy hierarchy rule).
 *
 *   Layer 3 — framework.antiInferenceRules: topic-specific residue. Only the
 *             genuinely topic-specific rules live here (e.g. for AI: chip-vendor
 *             vs foundation-model partner taxonomy; for climate: PCAF Part A
 *             vs Part B distinction).
 *
 * The framework-builder skill (topic-assessment-framework-builder) is now
 * updated to encourage authors to only add Layer 3 rules — Layers 1 and 2
 * are automatic.
 *
 * Rationale: previously all rules had to be authored per-framework and were
 * inconsistently applied across frameworks. The fw9 pre-refresh baseline
 * exposed this: fw9 had NO anti-inference rules and achieved 25% recall, and
 * even after the fw9 refresh added 8 rules, 5 of those 8 were topic-universal
 * patterns that should not need to be re-authored for every future framework.
 * By moving them to code, every framework benefits automatically.
 */

// ─── Layer 1: Universal Rules ────────────────────────────────────────────────
// These apply to every measure of every framework.
export const UNIVERSAL_ANTI_INFERENCE_RULES: string[] = [
  "You must score this measure based STRICTLY on explicit, verbatim disclosures made by the company in the evidence text provided.",
  "DO NOT infer that a company has a specific target, policy or programme because they are a member of an alliance, initiative or signatory group. Alliance or initiative membership (Partnership on AI, OECD signatory, SBTi commitment, UN Global Compact, NZBA member, etc.) alone does not constitute company-specific evidence of the practice the measure asks about.",
  "DO NOT infer that a policy, target or programme applies to all sectors, geographies, subsidiaries or activities if the text only names specific ones. Coverage-scope inference is not permitted.",
  "DO NOT count a policy, programme or committee that is REFERENCED by name in a proxy, annual report or sustainability section but is NOT PUBLISHED as a downloadable artefact (PDF or standalone webpage) as evidence for a 'published X' measure. Named-but-unpublished satisfies only 'internal X adopted' or 'X referenced' measures.",
  "DO NOT count programmes, policies or commitments belonging to a separately-listed subsidiary, affiliate or joint-venture group entity as evidence for the parent unless the parent explicitly adopts, funds or names the programme as its own in the parent's own disclosures.",
  "DO NOT count evidence from documents older than the most recent reporting period (typically the latest annual filing plus interim filings and dated policy documents from the past 24 months). Pre-merger presentations, retired policies, lapsed programmes, or plans that have been superseded do NOT count as current disclosure.",
  "DO NOT treat a mention of a topic in a sustainability or ESG section as evidence of board-level oversight, formal governance mandate or executive accountability when the proxy statement and annual filing are silent on the same point. Board-level measures require evidence in the proxy, annual filing, or a published board committee charter.",
  "DO NOT satisfy topic-specific measures with generic language ('digital transformation', 'technology innovation', 'automation', 'analytics') unless the company explicitly names the practice as being of the topic being assessed. The measure's topic vocabulary must appear explicitly.",
];

// ─── Layer 2: Measure-Family Rules ───────────────────────────────────────────
// Each entry: pattern (regex tested against measure.measureId and measure.title)
// and rules to add when the pattern matches.
//
// Rules are framework-agnostic — they describe evidence-shape false positives
// that apply to any measure of a given shape (e.g. any "published policy"
// measure regardless of what the policy is about).
interface MeasureFamilyRule {
  pattern: RegExp;
  rules: string[];
  description: string;
}

export const MEASURE_FAMILY_RULES: MeasureFamilyRule[] = [
  {
    pattern: /(?:^|[\-\_\s])(policy|framework|principle|charter)[\-\_\s]?(?:published|adopted|documented)?\b|published[\-\_\s]?(?:policy|framework)/i,
    description: "Published policy/framework/principles measures",
    rules: [
      "To satisfy this measure the artefact must exist as a downloadable PDF, standalone webpage, or public document with a locatable URL. A named reference to the artefact in a proxy or annual report — without the artefact itself being findable via site search — is NOT sufficient.",
    ],
  },
  {
    pattern: /(?:^|[\-\_\s])(board|committee|governance)[\-\_\s]?oversight|charter[\-\_\s]?mandate|board[\-\_\s]?(?:mandate|responsib)/i,
    description: "Board-oversight / charter-mandate measures",
    rules: [
      "Board-oversight and charter-mandate measures require evidence in the proxy statement, annual filing, or a published board committee charter that EXPLICITLY names the topic and the committee's responsibility for it. A single-charter mandate covering ONE aspect (e.g. risk-only or policy-only) does not satisfy a measure asking for BOTH aspects (e.g. strategy AND risk).",
    ],
  },
  {
    pattern: /(?:^|[\-\_\s])(partnership|collaboration|strategic[\-\_\s]?(?:partner|alliance))/i,
    description: "Strategic-partnership measures",
    rules: [
      "Strategic-partnership measures require a NAMED counterparty AND an explicit description of the partnership's PURPOSE aligned with the measure's topic. Vendor relationships, hardware supply agreements, load-serving/off-take contracts, and cloud-infrastructure agreements do NOT count unless the counterparty is explicitly named as a strategic partner for the topic-relevant purpose.",
    ],
  },
  {
    pattern: /(?:^|[\-\_\s])(quantified|kpi|target|metric)|financial[\-\_\s]?impact[\-\_\s]?quantified/i,
    description: "Quantified-metric / quantified-target measures",
    rules: [
      "Quantified measures require an explicit NUMBER (percentage, currency amount, headcount, count) attributed to the topic, with a defined scope and time period. Generic references to 'significant investment' or 'material impact' without a specific number do NOT satisfy a quantified measure — they satisfy the qualitative equivalent only.",
    ],
  },
  {
    pattern: /(?:^|[\-\_\s])(risk[\-\_\s]?factor|business[\-\_\s]?model[\-\_\s]?risk|material[\-\_\s]?risk)/i,
    description: "Risk-factor / business-model-risk measures",
    rules: [
      "Risk-factor measures should count ANY explicit mention of the topic in the annual filing's risk factors section (10-K Item 1A, 20-F risk factors, AIF risk factors, or equivalent) as sufficient evidence, EVEN IF the mention is in the context of cyber-security, IT-disruption or regulatory-compliance risks. The measure asks whether the risk is disclosed, not whether the framing is comprehensive.",
      "Business-model-risk measures require the disclosure to name the topic as a threat to the company's own business model, pricing power, product relevance or competitive position — NOT merely as a threat to customers or as a generic industry-wide risk.",
    ],
  },
  {
    pattern: /(?:^|[\-\_\s])(training|reskilling|upskilling|literacy|education)/i,
    description: "Workforce training / literacy measures",
    rules: [
      "Training / reskilling / literacy measures require an explicit programme (named or described), a defined scope (all employees, technical staff, community group), and an indication of scale (headcount, hours, budget, or 'company-wide'). A single-sentence mention that 'we invest in AI training' is insufficient without a named programme or scale indicator.",
    ],
  },
];

// ─── Composition ─────────────────────────────────────────────────────────────
/**
 * Compose all applicable anti-inference rules for a specific measure.
 * Returns a numbered list ready for inclusion in the scorer prompt.
 *
 * @param measureId - the measure's measureId (e.g. "4.1-ai-policy-published")
 * @param measureTitle - the measure's title (used as a secondary match target)
 * @param frameworkRules - Layer 3 rules from framework.antiInferenceRules
 */
export function composeAntiInferenceRules(
  measureId: string,
  measureTitle: string,
  frameworkRules: string[] | null | undefined,
): string {
  const rules: string[] = [];

  // Layer 1: universal
  for (const r of UNIVERSAL_ANTI_INFERENCE_RULES) rules.push(r);

  // Layer 2: family — deduplicate by regex match against measureId + title
  const combined = `${measureId} ${measureTitle}`.toLowerCase();
  const matchedFamilies: string[] = [];
  for (const fam of MEASURE_FAMILY_RULES) {
    if (fam.pattern.test(combined)) {
      matchedFamilies.push(fam.description);
      for (const r of fam.rules) {
        if (!rules.includes(r)) rules.push(r);
      }
    }
  }

  // Layer 3: framework-specific
  const l3 = (frameworkRules || []).filter((r): r is string => typeof r === "string" && r.trim().length > 0);
  for (const r of l3) {
    if (!rules.includes(r)) rules.push(r);
  }

  // Two additional universal tail rules (kept as they were in the prior scorer prompt)
  rules.push("If the evidence does not contain an explicit, direct statement satisfying the measure, you MUST score it 0 (No or Partial), even if you believe the company likely has such a policy based on other context.");
  rules.push("Pay careful attention to the TEMPORAL VALIDITY of evidence. If the evidence indicates a policy or target has been withdrawn, discontinued, or superseded, score based on the current state, not the historical commitment.");

  // Number the composed rules
  const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const diag = matchedFamilies.length > 0 ? `\n[Anti-inference layers applied: universal (${UNIVERSAL_ANTI_INFERENCE_RULES.length}) + family (${matchedFamilies.join("; ")}) + framework (${l3.length}) + tail (2)]` : `\n[Anti-inference layers applied: universal (${UNIVERSAL_ANTI_INFERENCE_RULES.length}) + framework (${l3.length}) + tail (2)]`;
  return numbered + diag;
}
