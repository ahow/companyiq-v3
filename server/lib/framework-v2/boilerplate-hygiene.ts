/**
 * boilerplate-hygiene.ts
 *
 * WHY: the terminology-gap miner (test-drive.detectTerminologyGaps) mines 2–3
 * word phrases from the company corpus around known topic terms and proposes them
 * as new topicSynonyms. It already drops function-word pollution (leading/trailing
 * stopword), but CONTENT-word filing boilerplate slips through: SEC EDGAR
 * cover-page / fee-table / exhibit language such as "filing fee", "all boxes",
 * "computed table", "paid previously". Those are not topic vocabulary for ANY
 * framework — they are the scaffolding of the filing itself — yet they became
 * persisted topicSynonyms (observed on fw12: 11 extraneous terms including exactly
 * these). At runtime such terms promote irrelevant filing material into the
 * corpus.
 *
 * WHAT: a GENERIC, topic-agnostic sanitiser that removes filing/report
 * boilerplate and generic filler from a candidate term list. It is built from:
 *   - a small set of filing-boilerplate REGEX heuristics (cover-page, fee, exhibit,
 *     form-type, "pursuant to", "check mark", …) that are structural to filings
 *     and never topic vocabulary;
 *   - the existing GENERIC_TERM_BLOCKLIST and GENERIC_FILLER_TOKENS stoplists;
 *   - the existing document-frequency gate against REFERENCE_FILING_CORPUS (a term
 *     that appears across generic corporate filings is not a discriminator).
 *
 * It is NOT a hardcode of this one topic: it contains no AI/governance/company
 * vocabulary. It protects the framework's OWN lexicon — any candidate that
 * overlaps the framework's topic term / topic synonyms is never dropped, so a
 * genuine topic term that happens to look filing-ish is preserved.
 *
 * Pure/deterministic, no LLM, no DB — unit-testable in isolation.
 */

import {
  REFERENCE_FILING_CORPUS,
  GENERIC_TERM_BLOCKLIST,
  referenceDocumentFrequency,
} from "./retrieval-query-terms.js";
import { GENERIC_FILLER_TOKENS } from "./evidence-keyword-distinctiveness.js";

/**
 * Filing / report boilerplate heuristics. Each pattern matches text that is
 * STRUCTURAL to a regulatory filing or annual report — the machinery of the
 * document, not the subject it is about. GENERIC across every framework: there is
 * no topic vocabulary here, so protecting the framework's own lexicon (below)
 * cannot conflict with these.
 *
 * Sourced from SEC EDGAR cover pages, the EX-FILING-FEE exhibit, form headers and
 * proxy/prospectus scaffolding — the exact families that contaminated fw12.
 */
export const FILING_BOILERPLATE_PATTERNS: RegExp[] = [
  // — Fee table / EX-FILING-FEE exhibit —
  // A bare "fee"/"filing" token is filing scaffolding, never topic vocabulary for
  // a subject-matter framework; a framework genuinely ABOUT fees or filings is
  // protected via topicTokens overlap, so these broad patterns are safe.
  /\bfee(?:s)?\b/i,
  /\bfiling(?:s)?\b/i,
  /\bpaid previously\b/i,
  /\bpreviously (?:paid|with)\b/i,
  /\bcomputed (?:table|fee)\b/i,
  /\btable exhibit\b/i,
  /\bamount (?:of|previously)\b/i,
  // — Cover-page check-box scaffolding —
  /\b(?:all|the) boxes\b/i,
  /\bcheck (?:mark|the appropriate box|box)\b/i,
  /\bindicate by check\b/i,
  /\bemerging growth company\b/i,
  /\bshell company\b/i,
  /\bwell-known seasoned issuer\b/i,
  // — Exhibit / incorporation-by-reference scaffolding —
  /\bexhibit(?:s)?\b/i,
  /\bincorporated (?:herein )?by reference\b/i,
  /\bpursuant to\b/i,
  /\bas amended\b/i,
  // — Form / filing-type identifiers —
  /\bform (?:10-?k|10-?q|8-?k|20-?f|40-?f|6-?k|s-\d|def ?14a|424b\d?)\b/i,
  /\bschedule (?:13d|13g|14a)\b/i,
  /\bregistration statement\b/i,
  /\bpreliminary (?:proxy|prospectus)\b/i,
  // — Signature / attestation scaffolding —
  /\bformer (?:name|address|managing)\b/i,
  /\bmanaging (?:member|general partner)\b/i,
  // — Proxy / notice / meeting-logistics scaffolding —
  // The machinery of a proxy statement and its "notice of internet availability":
  // how to receive/vote materials, meeting logistics, contact details. GENERIC —
  // it describes the delivery of a document, never the subject the framework is
  // about, and topicTokens overlap still protects a framework genuinely about
  // (e.g.) shareholder voting.
  /\bproxy (?:statement|materials|card|solicitation)\b/i,
  /\bnotice of (?:internet )?availability\b/i,
  /\b(?:regarding|availability) of (?:the )?proxy\b/i,
  /\bimportant notice\b/i,
  /\bannual meeting of (?:share|stock)holders\b/i,
  /\bspecial meeting of (?:share|stock)holders\b/i,
  /\brecord date\b/i,
  /\bvote (?:your shares|by (?:internet|telephone|mail|phone))\b/i,
  /\bvoting instructions?\b/i,
  /\bboxes? that apply\b/i,
  // — Contact-detail / delivery residue —
  /\breceive (?:email|e-mail|paper copies|future)\b/i,
  /\b(?:e-?mail|telephone|toll-free) (?:address|number)\b/i,
  /\bwww\.[^\s]+/i,
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i,
  // — Registrar / transfer-agent scaffolding —
  /\btransfer agent\b/i,
  /\bregistrar and\b/i,
  /\bstock (?:transfer|registrar)\b/i,
];

/**
 * Safe-harbour / forward-looking-statement disclaimer scaffolding (Issue 5).
 *
 * This is the boilerplate legal machinery that wraps risk disclosures in filings
 * ("this document contains forward-looking statements ... actual results may
 * differ materially ..."). It is NEVER topic vocabulary for any subject-matter
 * framework — same class as FILING_BOILERPLATE_PATTERNS, kept separate only so the
 * drop reason is reported distinctly. Protected by topicTokens like every other
 * class, so a framework genuinely about securities-law disclosure is unaffected.
 */
export const SAFE_HARBOUR_PATTERNS: RegExp[] = [
  /\bforward[- ]looking statements?\b/i,
  /\bactual results\b/i,
  /\bdiffer materially\b/i,
  /\bno obligation to update\b/i,
  /\bundertakes? no obligation\b/i,
  /\bwithin the meaning of\b/i,
  /\bprivate securities litigation reform act\b/i,
  /\bsafe harbou?r\b/i,
  /\brisks and uncertainties\b/i,
  /\bcautionary (?:statement|note)\b/i,
];

function normalise(term: unknown): string {
  return typeof term === "string" ? term.trim().toLowerCase() : "";
}

/**
 * Strip leading/trailing punctuation and collapse internal whitespace so that a
 * punctuation-artefact variant ("artificial intelligence,") folds onto its clean
 * form ("artificial intelligence"). Preserves internal casing. Issue 5(b).
 */
export function stripEdgePunctuation(term: unknown): string {
  const s = typeof term === "string" ? term : "";
  return s
    .replace(/^[\s"'“”‘’.,;:!?()\[\]{}\-–—]+/, "")
    .replace(/[\s"'“”‘’.,;:!?()\[\]{}\-–—]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when `term` is safe-harbour / forward-looking disclaimer scaffolding.
 * Protected by the framework's own lexicon exactly like isFilingBoilerplateTerm.
 */
export function isSafeHarbourTerm(term: string, opts?: BoilerplateCheckOpts): boolean {
  const s = normalise(term);
  if (!s) return false;
  const tokens = tokensOf(s);
  const topicTokens = opts?.topicTokens;
  if (topicTokens && topicTokens.size > 0 && tokens.some((t) => topicTokens.has(t))) {
    return false;
  }
  return SAFE_HARBOUR_PATTERNS.some((re) => re.test(s));
}

/** Tokenise a candidate phrase into lowercased word tokens. */
function tokensOf(term: string): string[] {
  return normalise(term).split(/\s+/).filter(Boolean);
}

export interface BoilerplateCheckOpts {
  /** Lowercased tokens of the framework's own lexicon (topicTerm + topicSynonyms).
   * Any candidate that overlaps one of these is protected and never flagged. */
  topicTokens?: Set<string>;
}

/**
 * True when `term` is filing/report boilerplate or generic filler that should not
 * be a topic synonym. GENERIC — no topic-specific knowledge.
 *
 * Protection: if any token of the candidate is part of the framework's own
 * lexicon (`topicTokens`), the candidate is NEVER treated as boilerplate. This is
 * what keeps the sanitiser safe on a genuine topic term that superficially looks
 * filing-ish.
 */
export function isFilingBoilerplateTerm(term: string, opts?: BoilerplateCheckOpts): boolean {
  const s = normalise(term);
  if (!s) return false; // empty handled by caller as its own reason
  const tokens = tokensOf(s);
  const topicTokens = opts?.topicTokens;

  // Protect the framework's own lexicon: never drop a candidate that carries a
  // topic token (e.g. a topic whose vocabulary legitimately overlaps filing words).
  if (topicTokens && topicTokens.size > 0 && tokens.some((t) => topicTokens.has(t))) {
    return false;
  }

  // 1) Structural filing-boilerplate regex heuristics.
  for (const re of FILING_BOILERPLATE_PATTERNS) {
    if (re.test(s)) return true;
  }

  // 2) Whole candidate is entirely generic filler / blocklisted tokens (no
  //    discriminating content). A single generic token is fine (a real phrase
  //    can contain one); ALL tokens generic means the phrase carries no signal.
  const allGeneric = tokens.every(
    (t) => GENERIC_TERM_BLOCKLIST.has(t) || GENERIC_FILLER_TOKENS.has(t),
  );
  if (allGeneric) return true;

  return false;
}

export type DropReason =
  | "empty"
  | "duplicate"
  | "boilerplate"
  | "high_df"
  | "safe_harbour"
  | "cross_framework_leak"
  | "punctuation_variant";

export interface SanitizeTopicTermsResult {
  kept: string[];
  dropped: Array<{ term: string; reason: DropReason }>;
}

export interface SanitizeTopicTermsOpts {
  /** Framework's own lexicon (topicTerm + topicSynonyms, any casing). Overlapping
   * candidates are protected from every drop rule below. */
  topicTokens?: Iterable<string>;
  /** Reference corpus for the document-frequency gate. Defaults to the bundled
   * generic-filings corpus. */
  corpus?: string[];
  /** DF at/above which a term is corpus-generic and dropped. Default 0.5. */
  dfThreshold?: number;
  /** When false (default) the DF gate is applied; set true to skip it (regex +
   * stoplist only) e.g. when no meaningful corpus is available. */
  skipDfGate?: boolean;
  /** Registered adjacent-topic names for THIS framework (Issue 5). A candidate that
   * equals or contains one of these is off-topic for this framework and dropped as
   * `cross_framework_leak`. Uses the framework's OWN declared adjacency, so it is
   * fully topic-agnostic (no global block-list). */
  adjacentTopics?: Iterable<string>;
}

/**
 * Clean a candidate topic-term list: drop filing boilerplate, generic filler, and
 * corpus-generic terms, while PRESERVING the framework's own lexicon, de-duping
 * case-insensitively, and keeping first-seen order. Deterministic, non-LLM.
 *
 * Returns both the kept list (original casing preserved) and an inspectable
 * dropped list with reasons, so callers can fail-loud log what was removed.
 */
export function sanitizeTopicTerms(
  terms: unknown,
  opts?: SanitizeTopicTermsOpts,
): SanitizeTopicTermsResult {
  const list = Array.isArray(terms) ? terms : [];
  const corpus = opts?.corpus ?? REFERENCE_FILING_CORPUS;
  const dfThreshold = opts?.dfThreshold ?? 0.5;
  const skipDf = opts?.skipDfGate ?? false;

  // Build the protected topic-token set (lowercased single tokens).
  const topicTokens = new Set<string>();
  for (const t of opts?.topicTokens ?? []) {
    for (const tok of tokensOf(String(t))) topicTokens.add(tok);
  }
  const checkOpts: BoilerplateCheckOpts = { topicTokens };

  // Normalised adjacent-topic names for the cross_framework_leak class.
  const adjacentNames: string[] = [];
  for (const a of opts?.adjacentTopics ?? []) {
    const n = normalise(stripEdgePunctuation(String(a)));
    if (n) adjacentNames.push(n);
  }

  const kept: string[] = [];
  const dropped: SanitizeTopicTermsResult["dropped"] = [];
  const seen = new Set<string>();

  for (const raw of list) {
    // Fold punctuation-artefact variants onto their clean form BEFORE dedup, so
    // "artificial intelligence," collapses onto "artificial intelligence".
    const rawTrimmed = typeof raw === "string" ? raw.trim() : "";
    const original = stripEdgePunctuation(rawTrimmed);
    const norm = normalise(original);
    if (!norm) { dropped.push({ term: rawTrimmed, reason: "empty" }); continue; }
    if (seen.has(norm)) {
      // Distinguish a pure duplicate from a punctuation-only variant of a term we
      // already kept (fold-and-drop) so the drop is reported accurately.
      const hadEdgePunct = normalise(rawTrimmed) !== norm;
      dropped.push({ term: rawTrimmed, reason: hadEdgePunct ? "punctuation_variant" : "duplicate" });
      continue;
    }

    // Is this candidate protected by the framework's own lexicon?
    const candTokens = tokensOf(norm);
    const isProtected = topicTokens.size > 0 && candTokens.some((t) => topicTokens.has(t));

    if (!isProtected) {
      // Cross-framework leak: candidate equals or contains a registered adjacent
      // topic of THIS framework (its own declared adjacency — topic-agnostic).
      const leaks = adjacentNames.some(
        (a) => norm === a || norm.includes(a) || a.includes(norm),
      );
      if (leaks) {
        dropped.push({ term: original, reason: "cross_framework_leak" });
        continue;
      }
      if (isSafeHarbourTerm(norm, checkOpts)) {
        dropped.push({ term: original, reason: "safe_harbour" });
        continue;
      }
      if (isFilingBoilerplateTerm(norm, checkOpts)) {
        dropped.push({ term: original, reason: "boilerplate" });
        continue;
      }
      if (!skipDf && referenceDocumentFrequency(norm, corpus) >= dfThreshold) {
        dropped.push({ term: original, reason: "high_df" });
        continue;
      }
    }

    seen.add(norm);
    kept.push(original); // store the punctuation-folded clean form
  }

  return { kept, dropped };
}

/**
 * Sanitise a list of anchor-framework references (Issue 5c). Anchors are saved raw
 * today; this gives them the same treatment as synonyms:
 *   - case-insensitive dedup (collapses GRI×3 / duplicated ISO padding),
 *   - punctuation-variant folding,
 *   - cross_framework_leak drop when an anchor maps to a registered adjacent topic.
 *
 * Anchors are proper names (standards/frameworks), so the filing-boilerplate and
 * DF gates do NOT apply — only dedup + adjacency. Deterministic, topic-agnostic.
 */
export function sanitizeAnchorFrameworks(
  anchors: unknown,
  opts?: Pick<SanitizeTopicTermsOpts, "adjacentTopics">,
): { kept: Array<{ name: string; source?: string }>; dropped: Array<{ term: string; reason: DropReason }> } {
  const list = Array.isArray(anchors) ? anchors : [];
  const adjacentNames: string[] = [];
  for (const a of opts?.adjacentTopics ?? []) {
    const n = normalise(stripEdgePunctuation(String(a)));
    if (n) adjacentNames.push(n);
  }
  const kept: Array<{ name: string; source?: string }> = [];
  const dropped: Array<{ term: string; reason: DropReason }> = [];
  const seen = new Set<string>();

  for (const raw of list) {
    // Anchors may be plain strings or { name, source } objects.
    const rawName =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as any).name === "string"
          ? (raw as any).name
          : "";
    const source =
      raw && typeof raw === "object" && typeof (raw as any).source === "string"
        ? (raw as any).source
        : undefined;
    const rawTrimmed = rawName.trim();
    const name = stripEdgePunctuation(rawTrimmed);
    const norm = normalise(name);
    if (!norm) { dropped.push({ term: rawTrimmed, reason: "empty" }); continue; }
    if (seen.has(norm)) {
      const hadEdgePunct = normalise(rawTrimmed) !== norm;
      dropped.push({ term: rawTrimmed, reason: hadEdgePunct ? "punctuation_variant" : "duplicate" });
      continue;
    }
    const leaks = adjacentNames.some((a) => norm === a || norm.includes(a) || a.includes(norm));
    if (leaks) {
      dropped.push({ term: name, reason: "cross_framework_leak" });
      continue;
    }
    seen.add(norm);
    kept.push(source ? { name, source } : { name });
  }

  return { kept, dropped };
}
