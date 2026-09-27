/**
 * Workstream 1 — lexicon hygiene (multi-surface, provenance-tracked, admission-gated).
 *
 * Root cause this addresses: hygiene previously ran silently, and only on
 * `topicSynonyms`. Evidence keywords and other retrieval surfaces were never checked,
 * and the drops were console-only (fail-silent). This module:
 *
 *   1. Treats each retrieval lexicon surface DISTINCTLY (topic synonyms, evidence
 *      keywords, document/filing hints, retrieval query terms).
 *   2. Deterministically auto-cleans ONLY unambiguous formatting / notice debris.
 *      Anything that needs a semantic-topicality judgement is FLAGGED FOR REVIEW and
 *      KEPT (never force-dropped), with its provenance retained.
 *   3. Records per-term provenance so the full drop/flag list can be surfaced in the
 *      builder response / structured diagnostics — never console-only (fail-loud).
 *   4. Applies an explicit admission predicate to LLM-originated terms: passing a
 *      boilerplate check does NOT establish topical relevance, so a new LLM term that
 *      is not topically anchored is flagged for review rather than silently admitted.
 *
 * Topic-agnostic: there is no topic/company/framework vocabulary hardcoded here. The
 * only thing that protects legitimate vocabulary is `topicTokens` overlap, supplied by
 * the caller from the framework's own lexicon.
 */

import { isFilingBoilerplateTerm } from "../boilerplate-hygiene.js";
import { GENERIC_TERM_BLOCKLIST } from "../retrieval-query-terms.js";
import { GENERIC_FILLER_TOKENS } from "../evidence-keyword-distinctiveness.js";

// ---------------------------------------------------------------------------
// Surfaces, origins, actions
// ---------------------------------------------------------------------------

export type LexiconSurface =
  | "topicSynonyms"
  | "evidenceKeywords"
  | "documentFilingHints"
  | "retrievalQueryTerms";

/** Where a term came from: the operator/intake, or the LLM expansion step. */
export type TermOrigin = "intake" | "llm";

export type HygieneAction =
  /** Deterministically removed as unambiguous debris. */
  | "auto-cleaned"
  /** Kept in the lexicon but marked as a suspect a human should review. */
  | "flagged-for-review"
  /** Kept with no concern. */
  | "kept";

export interface TermProvenance {
  term: string;
  surface: LexiconSurface;
  origin: TermOrigin;
  /** Machine-readable reason class (e.g. an auto-clean debris class, or an admission
   * reason). Null only for cleanly-kept terms. */
  flagReason: string | null;
  action: HygieneAction;
  /** Optional operator override recorded against this specific term. It never changes
   * `action` — it is an annotation, mirroring the ValidationState invariant. */
  operatorOverride?: {
    by: string;
    at: string;
    reason: string;
    disposition: string;
  };
}

// ---------------------------------------------------------------------------
// Auto-clean debris classes (the 12 unambiguous residue classes)
// ---------------------------------------------------------------------------

/**
 * Each entry is an UNAMBIGUOUS structural/formatting/notice residue class. Matching
 * one of these justifies a deterministic drop (auto-clean) because the string is the
 * machinery of a document (a proxy statement, a cover page, a notice of availability),
 * not a subject-matter term — and it carries no plausible topical reading.
 *
 * Anything filing-ish that is NOT in this list is treated more conservatively: it is
 * flagged for review and kept, because deciding it is off-topic needs judgement.
 *
 * `topicTokens` overlap still protects a framework whose genuine vocabulary happens to
 * intersect one of these shapes — that check runs BEFORE debris classification.
 */
export const AUTO_CLEAN_DEBRIS: Array<{ reason: string; re: RegExp }> = [
  // 1. Formatting debris: a stray close-paren + colon, or a leftover trailing colon.
  { reason: "formatting-debris", re: /\)\s*:|:\s*$/ },
  // 2. Checkbox / cover-page scaffolding.
  { reason: "checkbox-scaffolding", re: /\b(?:boxes? that apply|check (?:mark|the appropriate box|box)|indicate by check)\b/i },
  // 3. Proxy-materials machinery.
  { reason: "proxy-materials", re: /\bproxy (?:statement|materials|card|solicitation)\b/i },
  // 4. Notice-of-availability machinery.
  { reason: "notice-of-availability", re: /\bnotice of (?:internet )?availability\b|\b(?:regarding|availability) of (?:the )?proxy\b|\bimportant notice\b/i },
  // 5. Meeting logistics.
  { reason: "meeting-logistics", re: /\b(?:annual|special) meeting of (?:share|stock)holders\b|\brecord date\b/i },
  // 6. Voting logistics.
  { reason: "voting-logistics", re: /\bvote (?:your shares|by (?:internet|telephone|mail|phone))\b|\bvoting instructions?\b/i },
  // 7. Contact detail (email / phone / url).
  { reason: "contact-detail", re: /\bwww\.[^\s]+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|\b(?:e-?mail|telephone|toll-free) (?:address|number)\b/i },
  // 8. "Receive materials" delivery residue.
  { reason: "receive-materials", re: /\breceive (?:email|e-mail|paper copies|future|these documents)\b/i },
  // 9. Registrar / transfer-agent residue.
  { reason: "registrar-residue", re: /\btransfer agent\b|\bregistrar and\b|\bstock (?:transfer|registrar)\b/i },
  // 10. Signature / attestation scaffolding.
  { reason: "signature-attestation", re: /\bmanaging (?:member|general partner)\b|\bformer (?:name|address|managing)\b/i },
  // 11. Fee / exhibit scaffolding.
  { reason: "fee-exhibit-scaffolding", re: /\b(?:filing )?fees?\b|\bexhibit(?:s)?\b|\bpaid previously\b/i },
  // 12. Form-type / schedule identifiers.
  { reason: "form-type-identifier", re: /\bform (?:10-?k|10-?q|8-?k|20-?f|40-?f|6-?k|s-\d|def ?14a|424b\d?)\b|\bschedule (?:13d|13g|14a)\b/i },
];

/** Return the debris class a term matches, or null if it is not unambiguous debris. */
export function classifyAutoCleanDebris(term: string): string | null {
  const s = typeof term === "string" ? term.trim() : "";
  if (!s) return null;
  for (const { reason, re } of AUTO_CLEAN_DEBRIS) {
    if (re.test(s)) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Admission predicate
// ---------------------------------------------------------------------------

function tokensOf(term: string): string[] {
  return term.toLowerCase().split(/\s+/).filter(Boolean);
}

/** A token distinctive enough to carry topical signal: length >= 4 and not generic. */
function isDistinctiveToken(tok: string): boolean {
  if (tok.length < 4) return false;
  if (GENERIC_TERM_BLOCKLIST.has(tok)) return false;
  if (GENERIC_FILLER_TOKENS.has(tok)) return false;
  return true;
}

/**
 * ADMISSION PREDICATE (documented in SCHEMAS.md / this module).
 *
 * A term is *topically anchored* when it shares at least one distinctive token
 * (length >= 4, not a generic/filler token) with the framework's own topic lexicon.
 *
 * This is the explicit predicate that a new LLM-originated term must satisfy to be
 * admitted into the resolved lexicon without review. Passing a boilerplate check does
 * NOT satisfy it — absence of debris is not evidence of relevance.
 */
export function isTopicallyAnchored(term: string, topicTokens: Set<string>): boolean {
  if (topicTokens.size === 0) return false;
  const candTokens = tokensOf(term).filter(isDistinctiveToken);
  return candTokens.some((t) => topicTokens.has(t));
}

// ---------------------------------------------------------------------------
// Per-surface hygiene
// ---------------------------------------------------------------------------

export interface SurfaceHygieneResult {
  surface: LexiconSurface;
  /** Terms that remain in the lexicon (action kept OR flagged-for-review). */
  kept: string[];
  /** Terms deterministically removed. */
  autoCleaned: string[];
  /** Full per-term provenance for this surface (kept, flagged, and cleaned). */
  provenance: TermProvenance[];
  /** Count of surviving suspects (action === flagged-for-review). Drives one
   * dismissible info diagnostic per surviving suspect at the set level. */
  suspectCount: number;
}

export interface SurfaceInput {
  surface: LexiconSurface;
  terms: unknown;
  origin: TermOrigin;
}

export interface LexiconHygieneInput {
  surfaces: SurfaceInput[];
  /** Framework's own lexicon (topicTerm + topicSynonyms + adjacent topics, any casing). */
  topicTokens?: Iterable<string>;
}

export interface LexiconHygieneResult {
  surfaces: SurfaceHygieneResult[];
  /** Flattened provenance across all surfaces. */
  provenance: TermProvenance[];
  /** Total surviving suspects across all surfaces. */
  suspectCount: number;
  /** Total auto-cleaned across all surfaces. */
  autoCleanedCount: number;
}

function buildTopicTokenSet(topicTokens?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const t of topicTokens ?? []) {
    for (const tok of tokensOf(String(t))) set.add(tok);
  }
  return set;
}

/**
 * Run hygiene over a single surface.
 *
 * Decision order (first match wins):
 *   empty / duplicate            -> auto-cleaned (structural)
 *   protected (topicToken match) -> kept
 *   unambiguous debris           -> auto-cleaned  (DROP)
 *   filing-ish shape             -> flagged-for-review (KEEP; needs judgement)
 *   LLM-origin & not anchored    -> flagged-for-review (KEEP; admission not satisfied)
 *   otherwise                    -> kept
 */
export function runSurfaceHygiene(
  input: SurfaceInput,
  topicTokens: Set<string>,
): SurfaceHygieneResult {
  const list = Array.isArray(input.terms) ? input.terms : [];
  const provenance: TermProvenance[] = [];
  const kept: string[] = [];
  const autoCleaned: string[] = [];
  const seen = new Set<string>();

  const push = (
    term: string,
    action: HygieneAction,
    flagReason: string | null,
  ) => {
    provenance.push({ term, surface: input.surface, origin: input.origin, flagReason, action });
    if (action === "auto-cleaned") autoCleaned.push(term);
    else kept.push(term);
  };

  for (const raw of list) {
    const term = typeof raw === "string" ? raw.trim() : "";
    const norm = term.toLowerCase();

    if (!term) {
      push(term, "auto-cleaned", "empty");
      continue;
    }
    if (seen.has(norm)) {
      push(term, "auto-cleaned", "duplicate");
      continue;
    }
    seen.add(norm);

    const candTokens = tokensOf(norm);
    const isProtected = topicTokens.size > 0 && candTokens.some((t) => topicTokens.has(t));
    if (isProtected) {
      push(term, "kept", null);
      continue;
    }

    const debrisClass = classifyAutoCleanDebris(term);
    if (debrisClass) {
      push(term, "auto-cleaned", debrisClass);
      continue;
    }

    // Filing-ish shape that isn't unambiguous debris: keep but flag for review.
    if (isFilingBoilerplateTerm(norm, { topicTokens })) {
      push(term, "flagged-for-review", "filing-boilerplate-shape");
      continue;
    }

    // Admission gate for LLM-originated terms: absence of debris != relevance.
    if (input.origin === "llm" && !isTopicallyAnchored(term, topicTokens)) {
      push(term, "flagged-for-review", "admission-not-anchored");
      continue;
    }

    push(term, "kept", null);
  }

  const suspectCount = provenance.filter((p) => p.action === "flagged-for-review").length;
  return { surface: input.surface, kept, autoCleaned, provenance, suspectCount };
}

/** Run hygiene across every provided surface. */
export function runLexiconHygiene(input: LexiconHygieneInput): LexiconHygieneResult {
  const topicTokens = buildTopicTokenSet(input.topicTokens);
  const surfaces = input.surfaces.map((s) => runSurfaceHygiene(s, topicTokens));
  const provenance = surfaces.flatMap((s) => s.provenance);
  return {
    surfaces,
    provenance,
    suspectCount: surfaces.reduce((n, s) => n + s.suspectCount, 0),
    autoCleanedCount: surfaces.reduce((n, s) => n + s.autoCleaned.length, 0),
  };
}
