// R1 (2026-09-04) — Framework-level disclosure-document-type aggregation.
//
// The pre-R1 discovery pipeline built queries from evidence_keywords, which
// describes what appears INSIDE a disclosure document (e.g. "biodiversity
// impact", "stress testing", "cross-functional team"). This does not surface
// the actual first-party disclosures because their TITLES rarely contain any
// of these evidence keywords — they're called "Sustainability Report" or
// "TNFD Report", not "Genetic Resources Report".
//
// This module aggregates each measure's `disclosure_vehicles` into a
// deduplicated, normalised, framework-level list. The result is intended to
// be persisted into `framework.required_doc_types` (the existing schema
// column) and consumed by the discovery query builders in discovery.ts.
//
// The aggregator is TOPIC-AGNOSTIC and framework-agnostic. Any framework
// whose measures declare disclosureVehicles benefits automatically.

/** Vehicle-type label used in framework_measures.disclosure_vehicles. */
export type VehicleLabel = string;

/** Normalised, deduplicated, ranked list of vehicle types per framework. */
export interface AggregatedVehicles {
  /** Ranked list — highest priority first. Length capped to `maxItems`. */
  vehicles: string[];
  /** Full unfiltered list for diagnostics (before cap). */
  all: string[];
  /** Vehicles rejected by the filter (short, aspirational, generic). */
  rejected: string[];
}

// Section-qualifier suffix stripper — turns "Sustainability report (governance
// section)" into "sustainability report" so we don't build search queries
// with parentheses that Google interprets as syntax.
const SECTION_QUALIFIER_RE = /\s*\(.*?\)\s*$/;

// Vehicle types that are too vague or too generic to serve as useful search
// anchors. These are still part of the source list but omitted from the
// per-framework searchable set. Kept as a regex list so new patterns can be
// added easily.
//
// R5d (2026-09-04): narrowed the REJECT set. Several previously rejected
// labels ARE legitimate standalone vehicles for other frameworks / other
// topics (see docs/R5-Design-Note-2026-09-04.md for the analysis):
//   - "environmental statement" — dropped: Kering publishes an
//     "Environmental Policy 2024-2025" PDF that IS its primary
//     environmental-management vehicle; the earlier reject blocked queries
//     that would surface it.
//   - "principal risks disclosure" — dropped: for human-rights /
//     modern-slavery frameworks, a "principal risks disclosure" is a
//     legitimate top-level document (UK section-172 statements etc.).
//   - "board committee reports" — dropped: governance frameworks in
//     particular list committee reports as substantive disclosures.
//   - "management structure or organizational chart" — dropped: some
//     governance / audit-committee frameworks reference "organizational
//     chart" as a discoverable disclosure.
//   - "strategic resilience assessment" — dropped: climate/nature
//     frameworks (esp. TCFD-style) publish this as a named vehicle.
//
// Only labels that are truly vague or sub-section names are still rejected.
const REJECT_PATTERNS: RegExp[] = [
  // Section names inside a larger doc — not standalone vehicles
  /^strategy section$/i,
  /^risk disclosure$/i,
  /^business model description$/i,
  /^entity website( |$).*/i, // "Entity website (governance pages)" — too vague
  // Assessment/analysis nouns without a proper report noun
  /^materiality assessment$/i,
  /^impact assessment$/i,
  /^site assessment$/i,
  /^scenario analysis$/i,
  /^strategic plan$/i,
  /^value chain assessment$/i,
  /^geographic footprint disclosure$/i,
];

// A ranking hint — vehicles matching earlier patterns rank higher when we
// have to cap the list. Kept small and generic so it works for any topic.
//
// R5d (2026-09-04): policy-family boost. The Kering FN investigation
// (docs/Investigation-Prudential-Kering-2026-09-04.md) surfaced that:
//   - Kering's "Environmental Policy 2024-2025" doc contained the truth
//     evidence for measure 1.2-management-responsibility, but the policy-
//     vehicle-lane queries didn't survive the priority cut with the pre-
//     R5d weight of 50.
// The fix generalises across frameworks and topics: policy documents,
// standards, principles, commitments, charters, and guidelines are
// often substantive first-party disclosures with specific coverage
// details that don't appear in the flagship sustainability/annual
// report. Boosting them from 50 -> 78 places them above ESG report (72)
// and roughly on par with the URD (78). This matches how analysts
// treat these documents in practice (a company's environmental policy
// is usually the AUTHORITATIVE source for its environmental commitments,
// even when the annual report describes the same commitments in prose).
//
// The boost also broadens the pattern to include several policy-family
// noun forms (standards, principles, commitment, charter, guideline)
// so topic-agnostic vehicles for governance, human rights, AI, tax,
// biodiversity policies etc. all rank consistently.
const RANK_BOOSTS: Array<{ re: RegExp; weight: number }> = [
  { re: /sustainability\s+report/i, weight: 100 },
  { re: /annual\s+report/i, weight: 95 },
  { re: /integrated\s+report/i, weight: 90 },
  { re: /tnfd\b/i, weight: 85 },
  { re: /tcfd\b/i, weight: 85 },
  { re: /csrd\b/i, weight: 85 },
  { re: /10-?k\b/i, weight: 82 },
  { re: /20-?f\b/i, weight: 82 },
  { re: /proxy statement/i, weight: 80 },
  { re: /universal registration document|urd\b/i, weight: 78 },
  // R5d: policy-family vehicles — boosted from 50 to 78. Broadened to
  // catch standards, principles, commitments, charters, guidelines so the
  // ranking is topic-agnostic (works for ESG, AI, human rights, tax, etc).
  { re: /policy|framework|standards|principles|commitment|charter|guideline/i, weight: 78 },
  { re: /corporate governance/i, weight: 75 },
  { re: /esg report/i, weight: 72 },
  { re: /biodiversity|nature/i, weight: 70 },
  { re: /cdp\b/i, weight: 65 },
  { re: /climate transition/i, weight: 65 },
  { re: /supply chain report/i, weight: 60 },
  { re: /investor presentation/i, weight: 55 },
];

function normaliseLabel(raw: string): string {
  let s = (raw || "").trim();
  // Strip parenthetical section qualifiers.
  s = s.replace(SECTION_QUALIFIER_RE, "").trim();
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ");
  // Lowercase for dedup key; presentation form retains lowercase because
  // Google is case-insensitive anyway. Keeping labels lowercase also makes
  // downstream regex construction and query template substitution simpler.
  s = s.toLowerCase();
  return s;
}

function rankOf(label: string): number {
  for (const b of RANK_BOOSTS) if (b.re.test(label)) return b.weight;
  return 10; // default rank for anything not boosted
}

function shouldReject(label: string): boolean {
  return REJECT_PATTERNS.some(re => re.test(label));
}

/**
 * Aggregate a set of `disclosureVehicles` arrays (one per measure) into a
 * framework-level list ready for consumption by discovery query builders.
 *
 * @param perMeasureVehicles array of vehicle-label arrays, one per measure
 * @param opts.maxItems       cap on the ranked list (default 12)
 * @param opts.includeRejected include rejected labels in `all` for audit
 */
export function aggregateDisclosureVehicles(
  perMeasureVehicles: Array<string[] | null | undefined>,
  opts: { maxItems?: number } = {},
): AggregatedVehicles {
  const maxItems = opts.maxItems ?? 12;
  const seen = new Set<string>();
  const kept: Array<{ label: string; rank: number; freq: number }> = [];
  const rejected: string[] = [];
  const freqMap = new Map<string, number>();

  // Pass 1 — count frequencies on normalised labels.
  for (const arr of perMeasureVehicles) {
    for (const raw of arr || []) {
      const norm = normaliseLabel(raw);
      if (!norm) continue;
      freqMap.set(norm, (freqMap.get(norm) || 0) + 1);
    }
  }

  // Pass 2 — filter and rank.
  for (const [label, freq] of freqMap) {
    if (seen.has(label)) continue;
    seen.add(label);
    if (shouldReject(label)) {
      rejected.push(label);
      continue;
    }
    kept.push({ label, rank: rankOf(label), freq });
  }

  // Sort by rank desc, then frequency desc, then alpha for stability.
  kept.sort((a, b) => (b.rank - a.rank) || (b.freq - a.freq) || a.label.localeCompare(b.label));

  const capped = kept.slice(0, maxItems).map(k => k.label);
  return {
    vehicles: capped,
    all: kept.map(k => k.label),
    rejected,
  };
}
