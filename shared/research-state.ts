/**
 * WP02 / A1 — Research-state accounting (ADDITIVE).
 *
 * This module makes research completeness EXPLICIT so the product stops
 * emitting false *substantive* negatives. Its single hard invariant:
 *
 *   NOTHING here ever changes a verdict, a score, or a measure outcome.
 *
 * Every function is a pure derivation over fields that ALREADY exist on the
 * documents / measure_scores snapshot (plus one new, nullable `extractionState`
 * column). The scorer/analyzer never imports this module, so re-running a frozen
 * roster produces byte-for-byte identical verdicts and scores. researchStatus is
 * computed read-time (API) or at snapshot-build time (worker) and attached to the
 * contract as metadata only.
 *
 * Core distinction the reviewer brief (section 7) demands:
 *   "looked and found nothing"  (conclusive absence of a specific document)
 *       MUST be kept DISTINCT from
 *   "never successfully fetched" (dead / cancelled / blocked / timed out)
 * so a dead or not-attempted-cancelled source is NEVER treated downstream as
 * "conclusively unavailable". That distinction drives isRetryable /
 * isConclusiveAbsence below and is the backbone of CV01 and CV03.
 *
 * Shared between server (worker + API) and client (CSV export) via the @shared
 * alias so every reader renders the SAME research status (CV07).
 */

// ─── Conceptual document research states ────────────────────────────────────
// These are the brief's conceptual lifecycle states, mapped onto the REAL
// schema (documents.fetch_status + failure_reason + gate_verdict + source_type
// + the new extraction_state). We do not invent a parallel storage model.
export type DocumentResearchState =
  | "candidate"                            // discovered, not yet queued
  | "queued"                               // pending, awaiting fetch
  | "attempting"                           // fetch in progress
  | "retrieved"                            // fetched ok, extraction completeness unknown (legacy/null)
  | "extracted_complete"                   // fetched ok + extraction verified complete
  | "extracted_partial"                    // fetched ok but extraction truncated/partial
  | "excluded_with_reason"                 // deliberately gated out (gate_verdict = reject)
  | "transient_unavailable"               // fetch failed for a RETRYABLE reason (timeout/blocked/paywall/…)
  | "permanent_unavailable_with_evidence" // we looked and the document is conclusively absent (404 / empty)
  | "not_attempted_cancelled"             // never attempted (cancelled before fetch) — RETRYABLE, not absence
  | "superseded";                          // replaced by a newer/equivalent document

/** Minimal document shape this module classifies. All fields optional/forgiving. */
export interface ClassifiableDocument {
  fetchStatus?: string | null;   // pending | ok | dead | rejected | inaccessible | needs_verify
  failureReason?: string | null; // blocked_403 | not_found_404 | timeout | empty_after_render | paywall_401 | transient | not_attempted_cancelled | …
  gateVerdict?: string | null;   // accept | reject
  gateReason?: string | null;    // human reason for the gate verdict (diagnostic)
  sourceType?: string | null;    // first_party | third_party | null
  extractionState?: string | null; // complete | partial | empty | null (legacy = unknown)
  contentId?: number | null;
  superseded?: boolean | null;
  url?: string | null;           // document URL (used only for generic doc-type matching)
  title?: string | null;         // document title (used only for generic doc-type matching)
}

// failure_reason values that mean "we never got a conclusive look at the
// document" — the fetch was blocked/timed out/deferred. These are RETRYABLE and
// must NOT be read as the document being absent.
const RETRYABLE_FAILURE_REASONS = new Set([
  "timeout",
  "transient",
  "blocked_403",
  "paywall_401",
  "waf_block",
  "circuit_broken",
  "inaccessible",
  "budget_exceeded",
  "max_retries_exceeded",
  "not_attempted_cancelled",
  "unspecified",
]);

// failure_reason values that mean "we looked and there is conclusively no
// document here" — a genuine, evidenced absence of that specific URL/document.
const CONCLUSIVE_ABSENCE_FAILURE_REASONS = new Set([
  "not_found_404",
  "empty_after_render",
]);

/**
 * Map a document's real stored fields onto its conceptual research state.
 * Pure; never mutates. The ordering of checks matters: gate exclusion wins over
 * fetch outcome (an excluded doc is excluded regardless of how its fetch went).
 */
export function classifyDocument(doc: ClassifiableDocument): DocumentResearchState {
  if (doc?.superseded) return "superseded";

  // Deliberate exclusion takes precedence — this is NOT an absence/gap.
  if (doc?.gateVerdict === "reject") return "excluded_with_reason";

  const status = (doc?.fetchStatus || "").toLowerCase();
  const reason = (doc?.failureReason || "").toLowerCase();

  // Not yet fetched.
  if (status === "" || status === "pending") {
    if (reason === "not_attempted_cancelled") return "not_attempted_cancelled";
    return "queued";
  }

  // Successfully fetched — refine by extraction completeness (new nullable field).
  if (status === "ok") {
    const ext = (doc?.extractionState || "").toLowerCase();
    if (ext === "partial") return "extracted_partial";
    if (ext === "complete") return "extracted_complete";
    // null/unknown/empty → "retrieved": we have content but completeness is
    // not asserted. Treated conservatively (never a conclusive absence).
    return "retrieved";
  }

  // Fetch did not yield usable content (dead / inaccessible / rejected / needs_verify).
  if (reason === "not_attempted_cancelled") return "not_attempted_cancelled";
  if (CONCLUSIVE_ABSENCE_FAILURE_REASONS.has(reason)) {
    return "permanent_unavailable_with_evidence";
  }
  if (RETRYABLE_FAILURE_REASONS.has(reason)) return "transient_unavailable";

  // Unknown failure reason on a failed fetch: be conservative — treat as
  // retryable/transient, NOT as conclusive absence.
  return "transient_unavailable";
}

/**
 * Whether a state represents work that could still yield the document on retry.
 * CV01 (first-party timeout) and CV03 (pre-fetch cancellation) both land here:
 * their measures are INCOMPLETE/retryable, never a qualified substantive "No".
 */
export function isRetryable(state: DocumentResearchState): boolean {
  switch (state) {
    case "candidate":
    case "queued":
    case "attempting":
    case "not_attempted_cancelled":
    case "transient_unavailable":
      return true;
    default:
      return false;
  }
}

/**
 * Whether a state is a genuine, evidenced absence of that specific document.
 * ONLY "looked and found nothing" qualifies. A dead/cancelled/blocked fetch does
 * NOT — that is the central correctness guard of this work package.
 */
export function isConclusiveAbsence(state: DocumentResearchState): boolean {
  return state === "permanent_unavailable_with_evidence";
}

/** Whether a state means we actually hold usable content for the document. */
export function isRetrieved(state: DocumentResearchState): boolean {
  return (
    state === "retrieved" ||
    state === "extracted_complete" ||
    state === "extracted_partial"
  );
}

// ─── Research-scope manifest ────────────────────────────────────────────────

/** A required source/document family for an assessment (e.g. a primary disclosure). */
export interface EssentialSourceFamily {
  id: string;                 // stable family id, e.g. "primary_disclosure"
  label: string;              // human label
  /** If set, the family is only satisfied by a document matching this exact version. */
  requiredVersion?: EvidenceVersion;
}

/** Version identity for equivalent-copy / freshness checks (CV04, CV05). */
export interface EvidenceVersion {
  entity: string;   // entity the document belongs to
  version: string;  // e.g. "annual-report"
  date: string;     // reporting year/date the assessment requires, e.g. "2024"
}

export interface ResearchScopeManifest {
  entityBoundary: string;        // the entity the assessment is about
  asOf?: string;                 // as-of date of the assessment
  lookback?: string;             // lookback window label
  /** Source families that are eligible evidence (first-party families, etc.). */
  eligibleSourceFamilies: string[];
  /** Families whose absence is a MATERIAL gap. Conservative: first-party only. */
  essentialFamilies: EssentialSourceFamily[];
  evidenceRequirements?: string[];
  /**
   * Framework-declared required document types (verbatim from
   * `framework.required_doc_types`, e.g. "Annual Report", "Sustainability
   * Report", "Responsible AI Policy"). Used ONLY to build the per-document-type
   * essential checklist (Issue 5, part 2) — a generic, framework-derived list,
   * never a hardcoded company/topic string. Does NOT affect comprehensive/gap
   * semantics.
   */
  requiredDocTypes?: string[];
}

/**
 * Build a conservative manifest from a company + its measures. Production use:
 * the only essential family declared is a first-party primary disclosure, which
 * is the minimal honest requirement. Richer per-measure requirements can be
 * layered later (WP05) without changing this contract.
 */
export function buildManifest(input: {
  entityBoundary: string;
  asOf?: string;
  lookback?: string;
  essentialFamilies?: EssentialSourceFamily[];
  eligibleSourceFamilies?: string[];
  evidenceRequirements?: string[];
  requiredDocTypes?: string[];
}): ResearchScopeManifest {
  return {
    entityBoundary: input.entityBoundary,
    asOf: input.asOf,
    lookback: input.lookback,
    eligibleSourceFamilies:
      input.eligibleSourceFamilies ?? ["first_party"],
    essentialFamilies:
      input.essentialFamilies ?? [
        { id: "first_party_primary_disclosure", label: "First-party primary disclosure" },
      ],
    evidenceRequirements: input.evidenceRequirements,
    requiredDocTypes: input.requiredDocTypes,
  };
}

// ─── Gap accounting ─────────────────────────────────────────────────────────

/** A document enriched with the fields gap-accounting needs. */
export interface GapDocument extends ClassifiableDocument {
  /** Version identity of this document, when known, for equivalent-copy checks. */
  version?: EvidenceVersion | null;
}

export interface EssentialGap {
  familyId: string;
  label: string;
  /** "absent": no eligible doc at all. "unretrieved": only retryable attempts so far.
   *  "stale": only wrong-version/older copies. "partial": only truncated extraction. */
  kind: "absent" | "unretrieved" | "stale" | "partial";
  retryable: boolean;
  detail: string;
}

/** Does a document satisfy a required version (equivalent-copy rule, CV05)? */
function versionSatisfies(docVer: EvidenceVersion | null | undefined, req: EvidenceVersion): boolean {
  if (!docVer) return false;
  // An equivalent copy satisfies the requirement when entity + version + date all
  // match — a verified equivalent copy may satisfy. A wrong-year copy does NOT.
  return (
    docVer.entity === req.entity &&
    docVer.version === req.version &&
    docVer.date === req.date
  );
}

/**
 * Compute the material gaps against the manifest's essential families.
 * CONSERVATIVE by design: a gap is reported only when NO eligible document
 * satisfies the family. Deliberately-excluded third-party docs (gate reject)
 * are ignored entirely — they neither satisfy a family nor count as a gap (CV02).
 * A policy-excluded aggregator therefore never substitutes for a missed primary
 * disclosure, and never inflates the gap count.
 */
export function computeEssentialGaps(
  documents: GapDocument[],
  manifest: ResearchScopeManifest,
): EssentialGap[] {
  const gaps: EssentialGap[] = [];

  // Only first-party documents are eligible to satisfy an essential family.
  // Excluded (gate-reject) docs are dropped up front so they can't satisfy OR
  // be mistaken for a gap-causing attempt.
  const eligible = documents.filter(
    (d) => d.gateVerdict !== "reject" && d.sourceType === "first_party",
  );

  for (const fam of manifest.essentialFamilies) {
    // Partition eligible docs by their research state.
    let hasSatisfying = false;      // fully satisfies (retrieved + version ok)
    let hasPartialOnly = false;     // only a truncated extraction satisfies version
    let hasStaleOnly = false;       // retrieved but wrong version/year
    let hasRetryableAttempt = false; // a transient/cancelled attempt exists

    for (const d of eligible) {
      const state = classifyDocument(d);

      if (isRetrieved(state)) {
        // Version check (only when the family pins a version).
        const versionOk = fam.requiredVersion
          ? versionSatisfies(d.version, fam.requiredVersion)
          : true;
        if (!versionOk) {
          hasStaleOnly = true;
          continue;
        }
        if (state === "extracted_partial") {
          hasPartialOnly = true;
          continue;
        }
        hasSatisfying = true;
        break;
      }
      if (isRetryable(state)) hasRetryableAttempt = true;
      // conclusive-absence / excluded states contribute nothing positive.
    }

    if (hasSatisfying) continue; // family is satisfied — no gap.

    if (hasPartialOnly) {
      gaps.push({
        familyId: fam.id,
        label: fam.label,
        kind: "partial",
        retryable: true,
        detail: "Only a partial/truncated extraction is available for this family.",
      });
    } else if (hasStaleOnly) {
      gaps.push({
        familyId: fam.id,
        label: fam.label,
        kind: "stale",
        retryable: true,
        detail: fam.requiredVersion
          ? `No copy matching required version ${fam.requiredVersion.version}/${fam.requiredVersion.date}; only other/older copies present.`
          : "Only an out-of-scope version is present.",
      });
    } else if (hasRetryableAttempt) {
      gaps.push({
        familyId: fam.id,
        label: fam.label,
        kind: "unretrieved",
        retryable: true,
        detail: "Essential source not yet retrieved; only retryable/incomplete attempts so far.",
      });
    } else {
      // No eligible doc at all for this family.
      gaps.push({
        familyId: fam.id,
        label: fam.label,
        kind: "absent",
        retryable: false,
        detail: "No eligible first-party document found for this essential family.",
      });
    }
  }

  return gaps;
}

// ─── Essential-document checklist (Issue 5, part 2) ──────────────────────────
//
// For low-scoring companies the reviewer must be able to tell "looked and found
// nothing" apart from "never obtained the key documents". This produces a
// per-document-type checklist — found / partial / not found — for the document
// types the FRAMEWORK itself declares as required (`framework.required_doc_types`,
// e.g. "Annual Report", "Sustainability Report", "Responsible AI Policy").
//
// Framework-level by construction: the list is read from framework metadata, so
// there are no hardcoded company names, tickers, or framework-18 strings. The
// matching mirrors the analyzer's topic-primary classifier (generic token match
// against title + URL) so the checklist agrees with how the corpus is classified.
// Pure + additive: never reads or changes any score/verdict, and does NOT affect
// the comprehensive/gap semantics above.

/** Score at or below which a company's essential-document checklist is surfaced. */
export const LOW_SCORE_ESSENTIAL_THRESHOLD = 2;

/** Whether a company's met/Yes count is low enough to surface the checklist. */
export function isLowScoreCompany(
  metCount: number | null | undefined,
  threshold: number = LOW_SCORE_ESSENTIAL_THRESHOLD,
): boolean {
  return typeof metCount === "number" && metCount <= threshold;
}

export interface EssentialDocChecklistItem {
  /** The framework-declared required document type, verbatim. */
  docType: string;
  /** Human label (same as docType). */
  label: string;
  /** found: retrieved usable content. partial: only a truncated extraction.
   *  not_found: no usable copy obtained (absent, or only retryable attempts). */
  status: "found" | "partial" | "not_found";
  detail: string;
}

/**
 * Generic token match (mirrors analyzer.ts classifyDoc): a document matches a
 * required doc type when its title+URL contains at least min(2, words) of the
 * doc-type's words (words of length >= 3). Framework-agnostic.
 */
function matchesDocType(haystack: string, docType: string): boolean {
  const words = docType.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  const matched = words.filter((w) => haystack.includes(w)).length;
  return matched >= Math.min(2, words.length);
}

/**
 * Build the essential-document checklist from the framework's declared required
 * document types. Each entry is marked found / partial / not_found by matching
 * eligible (first-party, non-excluded) documents and classifying their research
 * state. Pure derivation; empty list when the framework declares no doc types.
 */
export function deriveEssentialDocChecklist(
  documents: ClassifiableDocument[],
  requiredDocTypes: string[] | null | undefined,
): EssentialDocChecklistItem[] {
  const docTypes = (requiredDocTypes || [])
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter((d) => d.length > 0);
  if (docTypes.length === 0) return [];

  // Only first-party, non-excluded documents can satisfy an essential doc type.
  const eligible = (documents || []).filter(
    (d) => d.gateVerdict !== "reject" && d.sourceType === "first_party",
  );

  const items: EssentialDocChecklistItem[] = [];
  const seen = new Set<string>();
  for (const docType of docTypes) {
    const key = docType.toLowerCase();
    if (seen.has(key)) continue; // dedupe case-insensitively, preserve first spelling
    seen.add(key);

    let found = false;
    let partial = false;
    let retryableAttempt = false;
    let conclusivelyAbsent = false;
    let matchedAny = false;

    for (const d of eligible) {
      const haystack = `${(d.url || "").toLowerCase()} ${(d.title || "").toLowerCase()}`;
      if (!matchesDocType(haystack, docType)) continue;
      matchedAny = true;
      const state = classifyDocument(d);
      if (state === "extracted_complete" || state === "retrieved") {
        found = true;
        break;
      }
      if (state === "extracted_partial") partial = true;
      else if (isRetryable(state)) retryableAttempt = true;
      else if (isConclusiveAbsence(state)) conclusivelyAbsent = true;
    }

    let status: EssentialDocChecklistItem["status"];
    let detail: string;
    if (found) {
      status = "found";
      detail = "Essential document retrieved.";
    } else if (partial) {
      status = "partial";
      detail = "Only a partial/truncated extraction is available.";
    } else {
      status = "not_found";
      if (!matchedAny) detail = "No document of this type was found.";
      else if (retryableAttempt) detail = "Attempted but not yet obtained (retryable).";
      else if (conclusivelyAbsent) detail = "Looked and found nothing (conclusively absent).";
      else detail = "No usable copy obtained.";
    }

    items.push({ docType, label: docType, status, detail });
  }

  return items;
}

/** Single-line summary of a checklist (CSV / compact display). */
export function summarizeEssentialChecklist(items?: EssentialDocChecklistItem[] | null): string {
  if (!items || items.length === 0) return "";
  return items
    .map((i) => `${i.label}: ${i.status === "not_found" ? "not found" : i.status}`)
    .join("; ");
}

// ─── Research status contract ───────────────────────────────────────────────

export interface ResearchCoverage {
  /** Explicit denominator: eligible (first-party, non-excluded) documents considered. */
  denominator: number;
  /** Eligible documents we actually retrieved usable content for. */
  retrieved: number;
  /** Eligible documents excluded by policy/gate (reported, not hidden). */
  excluded: number;
  /** Eligible attempts still retryable (cancelled/transient/queued). */
  retryable: number;
  /** Eligible documents conclusively absent (looked, found nothing). */
  conclusivelyAbsent: number;
}

export interface DiscoveryRecall {
  /**
   * Discovery recall is ALWAYS a lower bound against a known benchmark set — we
   * can never assert "all sources were found". This label must travel with the
   * number everywhere it is displayed/exported.
   */
  label: string;
  retrievedEligible: number;
}

export interface ResearchStatus {
  /**
   * TRUE only when there is no unresolved essential gap (absent/stale/partial)
   * and no retryable essential gap. When false, the assessment must NEVER be
   * displayed or exported as "comprehensive".
   */
  comprehensive: boolean;
  /** Short machine state: "comprehensive" | "incomplete" | "unresolved_gaps". */
  state: "comprehensive" | "incomplete" | "unresolved_gaps";
  reasons: string[];
  coverage: ResearchCoverage;
  discoveryRecall: DiscoveryRecall;
  unresolvedEssentialGaps: EssentialGap[];
  /** Essential gaps that are still retryable (not yet conclusive). */
  retryableGaps: EssentialGap[];
  /** Counts of documents by conceptual state (diagnostic; additive). */
  stateCounts: Record<string, number>;
  /**
   * Per-document-type checklist (Issue 5, part 2) derived from the framework's
   * declared required doc types. Empty when the framework declares none. Additive
   * metadata — does NOT affect comprehensive/gap semantics above. Optional so
   * legacy/fixture ResearchStatus literals need not supply it; deriveResearchStatus
   * always populates it, and every reader guards against an absent value.
   */
  essentialChecklist?: EssentialDocChecklistItem[];
}

/**
 * Derive the full research status from the document set + manifest. Pure
 * derivation — does not read or affect any score/verdict.
 */
export function deriveResearchStatus(input: {
  documents: GapDocument[];
  manifest: ResearchScopeManifest;
}): ResearchStatus {
  const documents = input.documents || [];
  const manifest = input.manifest;

  // Classify every document once.
  const stateCounts: Record<string, number> = {};
  for (const d of documents) {
    const s = classifyDocument(d);
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  }

  // Coverage denominator = eligible (first-party, non-excluded) documents.
  const eligible = documents.filter(
    (d) => d.gateVerdict !== "reject" && d.sourceType === "first_party",
  );
  let retrieved = 0;
  let retryable = 0;
  let conclusivelyAbsent = 0;
  for (const d of eligible) {
    const s = classifyDocument(d);
    if (isRetrieved(s)) retrieved++;
    else if (isRetryable(s)) retryable++;
    else if (isConclusiveAbsence(s)) conclusivelyAbsent++;
  }
  const excluded = documents.filter((d) => d.gateVerdict === "reject").length;

  const gaps = computeEssentialGaps(documents, manifest);
  const retryableGaps = gaps.filter((g) => g.retryable);
  const unresolvedEssentialGaps = gaps; // every essential gap is "unresolved" by definition

  const reasons: string[] = [];
  for (const g of gaps) reasons.push(`${g.label}: ${g.detail}`);

  const hasUnresolved = unresolvedEssentialGaps.length > 0;
  const comprehensive = !hasUnresolved;

  let state: ResearchStatus["state"];
  if (comprehensive) state = "comprehensive";
  else if (retryableGaps.length > 0) state = "incomplete";
  else state = "unresolved_gaps";

  return {
    comprehensive,
    state,
    reasons,
    coverage: {
      denominator: eligible.length,
      retrieved,
      excluded,
      retryable,
      conclusivelyAbsent,
    },
    discoveryRecall: {
      label: "lower-bound benchmark recall (not all-sources-found)",
      retrievedEligible: retrieved,
    },
    unresolvedEssentialGaps,
    retryableGaps,
    stateCounts,
    essentialChecklist: deriveEssentialDocChecklist(documents, manifest.requiredDocTypes),
  };
}

// ─── Reader-facing summarisation (shared by API, UI, CSV, export → CV07) ─────

/** Single-line, human-readable label + reason. Every reader uses this. */
export function summarizeResearchStatus(rs?: ResearchStatus | null): string {
  if (!rs) return "research status unknown";
  if (rs.comprehensive) return "Comprehensive — no unresolved essential gaps";
  const n = rs.unresolvedEssentialGaps.length;
  const kind = rs.state === "incomplete" ? "Incomplete" : "Unresolved gaps";
  const first = rs.reasons[0] ? ` — ${rs.reasons[0]}` : "";
  return `${kind} (${n} essential gap${n === 1 ? "" : "s"})${first}`;
}

/** Ordered CSV columns for research status. Appended AFTER existing columns. */
export function researchStatusCsvColumns(rs?: ResearchStatus | null): Array<{ header: string; value: string }> {
  return [
    { header: "Research Status", value: rs ? summarizeResearchStatus(rs) : "" },
    { header: "Comprehensive", value: rs ? (rs.comprehensive ? "Yes" : "No") : "" },
    { header: "Research Coverage Denominator", value: rs ? String(rs.coverage.denominator) : "" },
    { header: "Eligible Retrieved", value: rs ? String(rs.coverage.retrieved) : "" },
    { header: "Eligible Retryable", value: rs ? String(rs.coverage.retryable) : "" },
    { header: "Eligible Conclusively Absent", value: rs ? String(rs.coverage.conclusivelyAbsent) : "" },
    { header: "Excluded (policy/gate)", value: rs ? String(rs.coverage.excluded) : "" },
    { header: "Unresolved Essential Gaps", value: rs ? rs.unresolvedEssentialGaps.map((g) => g.label).join("; ") : "" },
    { header: "Essential Document Checklist", value: rs ? summarizeEssentialChecklist(rs.essentialChecklist) : "" },
    { header: "Missing Essential Documents", value: rs ? (rs.essentialChecklist || []).filter((i) => i.status !== "found").map((i) => `${i.label} (${i.status === "not_found" ? "not found" : i.status})`).join("; ") : "" },
    { header: "Discovery Recall", value: rs ? rs.discoveryRecall.label : "" },
  ];
}
