// ─── Synonym Adjudication Gate (Option 3 — terminating loop, not a hard block) ─
//
// PURPOSE
// The lexicon-hygiene advisory (rules.ts, Dimension 5) surfaces every suspect
// topicSynonym — a term that is filing/notice residue or not topically anchored —
// as a dismissible `info` violation. Because nothing RECORDS the operator's
// decision about a flagged term, the SAME advisory reappears on every subsequent
// validation / review pass. That is the recurring-message loop the operator hit:
// "I agree it's noise" changes nothing, so the notice comes back forever.
//
// This module is the single, TOPIC-AGNOSTIC gate that terminates that loop. It does
// NOT introduce a hard block (consistent with the standing "no blocking guards;
// feedback dismissible" constraint). Instead it makes the advisory TERMINATING:
//
//   1. It flags exactly the terms the advisory flags — by delegating to the same
//      runLexiconHygiene detection (topicSynonyms surface, origin "llm"), so the
//      gate and the advisory can never disagree.
//   2. It subtracts terms that already carry a recorded adjudication (removed OR
//      kept), matched by a normalised idempotency key. Those never re-surface.
//   3. It applies "removed" adjudications by physically dropping the term from
//      topicSynonyms, so a removed term is gone from the lexicon (and therefore
//      from any future advisory pass) — the loop cannot restart.
//
// The report it returns is fail-loud (every flagged/resolved/unresolved term is
// enumerated with a machine-readable reason) but dismissible (finalisation is never
// blocked; `unresolved` simply drives the same info-level notice until decided).
//
// IDEMPOTENCY KEY
// `${normalizedTopicKey}::${normalizedTerm}` where normalisation is lowercase, trim,
// collapse internal whitespace. The topicKey scopes decisions to a framework's topic
// so the same surface term can be judged differently under different topics.

import {
  runLexiconHygiene,
  type SurfaceInput,
  type TermProvenance,
} from "./reliability/lexicon-hygiene.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AdjudicationDecision = "removed" | "kept";

export interface SynonymAdjudication {
  /** The term as adjudicated (original casing retained for display). */
  term: string;
  /** Normalised topic key the decision was made under (idempotency scope). */
  topicKey: string;
  decision: AdjudicationDecision;
  /** Optional operator justification (free text). */
  justification?: string;
  /** ISO timestamp the decision was recorded. */
  decidedAt: string;
  /** Optional operator identity. */
  decidedBy?: string;
}

export interface FlaggedSynonym {
  term: string;
  /** Machine-readable reason class from lexicon hygiene (e.g.
   * "admission-not-anchored", "filing-boilerplate-shape"). */
  flagReason: string | null;
}

export interface SynonymGateReport {
  generatedAt: string;
  version: 1;
  /** Normalised topic key the gate ran under. */
  topicKey: string;
  /** Every term the hygiene detection flagged for review (before subtraction). */
  flagged: FlaggedSynonym[];
  /** Flagged terms that already carry a recorded adjudication (removed or kept). */
  resolved: SynonymAdjudication[];
  /** Flagged terms with NO recorded decision yet — these drive the advisory.
   * Empty ⇒ the gate has terminated (nothing left to decide). */
  unresolved: FlaggedSynonym[];
  /** Terms dropped from topicSynonyms by applying "removed" adjudications. */
  removedTerms: string[];
  /** topicSynonyms after removals were applied. */
  resolvedSynonyms: string[];
  /** True when unresolved.length === 0 (loop terminated). */
  passed: boolean;
  summary: {
    flagged: number;
    resolved: number;
    unresolved: number;
    removed: number;
  };
}

export interface RunSynonymGateInput {
  /** The framework's topic term (used for the topicKey + hygiene protection). */
  topicTerm?: string | null;
  /** The topicSynonyms list to adjudicate. */
  topicSynonyms: unknown;
  /** The framework's own lexicon tokens (topicTerm + synonyms + adjacent topic
   * names). Protects genuine vocabulary from being flagged. */
  topicTokens?: Iterable<string>;
  /** Previously recorded adjudications for this framework. */
  adjudications?: SynonymAdjudication[];
  /** Term origin passed to hygiene. Defaults to "llm" to EXACTLY mirror the
   * rules.ts advisory (which treats topicSynonyms as llm-origin). */
  origin?: "intake" | "llm";
}

// ─── Normalisation / keys ──────────────────────────────────────────────────────

/** Lowercase, trim, collapse internal whitespace. */
export function normalizeSynTerm(term: unknown): string {
  return String(term ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalise a topic term into a stable idempotency scope key. */
export function normalizeTopicKey(topicTerm: unknown): string {
  return normalizeSynTerm(topicTerm);
}

/** Stable idempotency key for a (term, topic) pair. */
export function adjudicationKey(term: unknown, topicKey: string): string {
  return `${topicKey}::${normalizeSynTerm(term)}`;
}

/** Index adjudications by their idempotency key (last write wins). */
function indexAdjudications(
  adjudications: SynonymAdjudication[],
): Map<string, SynonymAdjudication> {
  const map = new Map<string, SynonymAdjudication>();
  for (const a of adjudications) {
    if (!a || typeof a.term !== "string") continue;
    const key = adjudicationKey(a.term, normalizeTopicKey(a.topicKey));
    map.set(key, a);
  }
  return map;
}

// ─── Apply removals ────────────────────────────────────────────────────────────

/**
 * Apply "removed" adjudications to a synonyms list: drop any term whose normalised
 * key has a recorded decision of "removed". Deterministic, order-preserving.
 * Topic-agnostic — the only inputs are the list, the decisions, and the topic key.
 */
export function applyAdjudications(
  synonyms: unknown,
  adjudications: SynonymAdjudication[],
  topicKey: string,
): { kept: string[]; removed: string[] } {
  const list = Array.isArray(synonyms) ? synonyms : [];
  const byKey = indexAdjudications(adjudications);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const raw of list) {
    const term = typeof raw === "string" ? raw : "";
    if (!term) continue;
    const decision = byKey.get(adjudicationKey(term, topicKey));
    if (decision && decision.decision === "removed") removed.push(term);
    else kept.push(term);
  }
  return { kept, removed };
}

/**
 * True when a specific term (under a topic key) already carries ANY recorded
 * adjudication. Used by the advisory to skip already-decided terms so the notice
 * does not recur. Topic-agnostic.
 */
export function isAdjudicated(
  term: unknown,
  topicKey: string,
  adjudications: SynonymAdjudication[] | null | undefined,
): boolean {
  if (!Array.isArray(adjudications) || adjudications.length === 0) return false;
  const byKey = indexAdjudications(adjudications);
  return byKey.has(adjudicationKey(term, normalizeTopicKey(topicKey)));
}

// ─── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the terminating synonym-adjudication gate.
 *
 * Mirrors runCompletenessValidator's return shape (report + resolved values to
 * persist). Never throws for empty/malformed input — returns an empty, passed
 * report so it can never break finalisation.
 */
export function runSynonymAdjudicationGate(
  input: RunSynonymGateInput,
): SynonymGateReport {
  const topicKey = normalizeTopicKey(input.topicTerm);
  const adjudications = Array.isArray(input.adjudications)
    ? input.adjudications
    : [];
  const origin = input.origin ?? "llm";

  // 1. Detect flagged terms via the SAME hygiene path the advisory uses.
  const surfaces: SurfaceInput[] = [
    { surface: "topicSynonyms", terms: input.topicSynonyms, origin },
  ];
  let provenance: TermProvenance[] = [];
  try {
    const hygiene = runLexiconHygiene({ surfaces, topicTokens: input.topicTokens });
    provenance = hygiene.provenance;
  } catch {
    provenance = [];
  }
  const flagged: FlaggedSynonym[] = provenance
    .filter((p) => p.action === "flagged-for-review")
    .map((p) => ({ term: p.term, flagReason: p.flagReason }));

  // 2. Subtract already-adjudicated terms (removed OR kept).
  const byKey = indexAdjudications(adjudications);
  const resolved: SynonymAdjudication[] = [];
  const unresolved: FlaggedSynonym[] = [];
  for (const f of flagged) {
    const decision = byKey.get(adjudicationKey(f.term, topicKey));
    if (decision) resolved.push(decision);
    else unresolved.push(f);
  }

  // 3. Apply "removed" adjudications to the actual synonyms list.
  const { kept, removed } = applyAdjudications(
    input.topicSynonyms,
    adjudications,
    topicKey,
  );

  return {
    generatedAt: new Date().toISOString(),
    version: 1,
    topicKey,
    flagged,
    resolved,
    unresolved,
    removedTerms: removed,
    resolvedSynonyms: kept,
    passed: unresolved.length === 0,
    summary: {
      flagged: flagged.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      removed: removed.length,
    },
  };
}
