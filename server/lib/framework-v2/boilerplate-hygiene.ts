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
];

function normalise(term: unknown): string {
  return typeof term === "string" ? term.trim().toLowerCase() : "";
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

export type DropReason = "empty" | "duplicate" | "boilerplate" | "high_df";

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

  const kept: string[] = [];
  const dropped: SanitizeTopicTermsResult["dropped"] = [];
  const seen = new Set<string>();

  for (const raw of list) {
    const original = typeof raw === "string" ? raw.trim() : "";
    const norm = normalise(raw);
    if (!norm) { dropped.push({ term: original, reason: "empty" }); continue; }
    if (seen.has(norm)) { dropped.push({ term: original, reason: "duplicate" }); continue; }

    // Is this candidate protected by the framework's own lexicon?
    const candTokens = tokensOf(norm);
    const isProtected = topicTokens.size > 0 && candTokens.some((t) => topicTokens.has(t));

    if (!isProtected) {
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
    kept.push(original);
  }

  return { kept, dropped };
}
