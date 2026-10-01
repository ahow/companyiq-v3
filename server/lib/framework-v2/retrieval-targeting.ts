// ─── Issue 6 — Retrieval-targeting derivation (topic-agnostic) ──────────────
//
// The `frameworks` table carries a family of retrieval-targeting columns
// (requiredDocTypes, withdrawalPatterns, negativeDomains, query templates,
// authoritativeRegistries, knownDisclosureUrls, ...). Fresh builds never author
// them, so retrieval runs with empty targeting — a top cause of C10 evidence
// variance.
//
// This module fills the DETERMINISTICALLY-DERIVABLE fields at build with NO LLM
// and NO subject hardcode: every value is derived from the framework's OWN
// declared structure (its measures' disclosure_vehicles, its topicTerm, its
// adjacentTopics). Fields that are genuinely operator/topic knowledge
// (authoritativeRegistries, knownDisclosureUrls, trustedSourceIds,
// documentPriorityUrlPatterns) are NOT fabricated — `validateTargetingCoverage`
// surfaces them as empty instead (fail-loud, source-grounded).

// ── (a) requiredDocTypes — from measures' declared disclosure_vehicles ──────
//
// Canonicalise the free-text disclosure-vehicle labels the drafter emits into a
// stable set of DOCUMENT-TYPE labels. The map keys/values are STRUCTURAL
// document classes (annual report, proxy, policy document, regulatory filing) —
// never subject vocabulary — so this works for any framework.
const DOC_TYPE_CANONICAL: Array<{ canonical: string; match: RegExp }> = [
  { canonical: "Annual Report", match: /\bannual\s*report|10-?k|form\s*20-?f|integrated\s*report\b/i },
  { canonical: "Sustainability/ESG Report", match: /\b(sustainab|esg|csr|responsib|climate|tcfd|non-?financial)\b/i },
  { canonical: "Proxy Statement", match: /\bprox(y|ies)|def\s*14a|remuneration\s*report|say[- ]on[- ]pay\b/i },
  { canonical: "Policy Document", match: /\bpolic(y|ies)|code\s*of\s*(conduct|ethics)|charter|standard\b/i },
  { canonical: "Regulatory Filing", match: /\b(regulat|filing|prospectus|8-?k|6-?k|sec\s*filing|disclosure\s*statement)\b/i },
  { canonical: "Financial Statements", match: /\b(financial\s*statement|balance\s*sheet|income\s*statement|10-?q|quarterly\s*report)\b/i },
  { canonical: "Press Release / News", match: /\bpress\s*release|news\s*release|media\s*statement|announcement\b/i },
  { canonical: "Website / Webpage", match: /\bweb\s*(site|page)|corporate\s*site|investor\s*relations\s*page\b/i },
  { canonical: "Presentation / Deck", match: /\bpresentation|slide|deck|investor\s*day|capital\s*markets\s*day\b/i },
];

/**
 * Derive a deduped set of canonical required document types from the
 * disclosure_vehicles declared across a draft's measures. Unmatched vehicle
 * labels are preserved verbatim (title-cased-ish, trimmed) so no operator
 * intent is lost. Deterministic; topic-agnostic. Returns [] when none declared.
 */
export function deriveRequiredDocTypes(measures: any[]): string[] {
  if (!Array.isArray(measures)) return [];
  const out = new Set<string>();
  for (const m of measures) {
    const vehicles = m?.disclosure_vehicles ?? m?.disclosureVehicles;
    if (!Array.isArray(vehicles)) continue;
    for (const v of vehicles) {
      if (typeof v !== "string") continue;
      const label = v.trim();
      if (!label) continue;
      const hit = DOC_TYPE_CANONICAL.find((d) => d.match.test(label));
      out.add(hit ? hit.canonical : label);
    }
  }
  return Array.from(out);
}

// ── (b) withdrawalPatterns — parameterised from the framework's topicTerm ────
//
// Withdrawal/discontinuation detection is structurally identical across topics:
// "<verb> <topicTerm>". Seed a generic template set parameterised with the
// framework's OWN topicTerm — no subject hardcode.
const WITHDRAWAL_VERBS = ["discontinued", "withdrawn", "retired", "scrapped", "abandoned", "cancelled", "ceased"];

/**
 * Seed withdrawal-detection patterns from the framework's own topicTerm.
 * `queries`: search strings; `documentRegex`: regex substrings proving a
 * withdrawal statement co-occurs with the topic. Returns empty structure when
 * no usable topicTerm. Deterministic; topic-agnostic (topicTerm is the only
 * subject input, supplied by the framework itself).
 */
export function deriveWithdrawalPatterns(topicTerm: string | undefined | null): { queries: string[]; documentRegex: string[] } {
  const t = (topicTerm || "").trim();
  if (!t) return { queries: [], documentRegex: [] };
  const queries = WITHDRAWAL_VERBS.map((v) => `"${v}" "${t}"`);
  // A single anchored regex: any withdrawal verb within a short window of the topic term.
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const documentRegex = [
    `(?:${WITHDRAWAL_VERBS.join("|")})[\\s\\S]{0,60}${escaped}`,
    `${escaped}[\\s\\S]{0,60}(?:${WITHDRAWAL_VERBS.join("|")})`,
  ];
  return { queries, documentRegex };
}

// ── (c) negativeDomains — from the framework's declared adjacentTopics ───────
//
/**
 * Seed negative subject-domain signals from the framework's OWN declared
 * adjacent topics: content strongly about an ADJACENT topic is a negative
 * signal for the target topic. Normalises to trimmed, deduped, lower-cased
 * labels. Uses only the framework's declared adjacency — no fabrication.
 */
export function deriveNegativeDomains(adjacentTopicNames: string[]): string[] {
  if (!Array.isArray(adjacentTopicNames)) return [];
  const out = new Set<string>();
  for (const n of adjacentTopicNames) {
    if (typeof n !== "string") continue;
    const label = n.trim().toLowerCase();
    if (label) out.add(label);
  }
  return Array.from(out);
}

// ── Fail-loud advisory — targeting coverage ─────────────────────────────────
//
export interface TargetingCoverageResult {
  emptyFields: string[];
  populatedFields: string[];
  advisory: string | null;
}

// The genuinely operator/topic-knowledge fields we must NOT fabricate. Emptiness
// is reported, never silently shipped.
const OPERATOR_KNOWLEDGE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "authoritativeRegistries", label: "authoritativeRegistries" },
  { key: "knownDisclosureUrls", label: "knownDisclosureUrls" },
  { key: "trustedSourceIds", label: "trustedSourceIds" },
  { key: "documentPriorityUrlPatterns", label: "documentPriorityUrlPatterns" },
  { key: "dataPatterns", label: "dataPatterns" },
];

function isEmptyField(v: any): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/**
 * Advisory (never blocking): report which operator-knowledge targeting fields
 * were left empty on a built framework, so the empty state is visible instead of
 * silently shipped. Topic-agnostic (presence check only).
 */
export function validateTargetingCoverage(fields: Record<string, any>): TargetingCoverageResult {
  const emptyFields: string[] = [];
  const populatedFields: string[] = [];
  for (const f of OPERATOR_KNOWLEDGE_FIELDS) {
    if (isEmptyField(fields?.[f.key])) emptyFields.push(f.label);
    else populatedFields.push(f.label);
  }
  const advisory =
    emptyFields.length > 0
      ? `Retrieval targeting: ${emptyFields.length} operator-knowledge field(s) are empty (${emptyFields.join(", ")}). Populate them for higher retrieval precision — these cannot be auto-derived without inventing sources.`
      : null;
  return { emptyFields, populatedFields, advisory };
}
