// ─── Synonym / anchor hygiene choke-point (Issue 5a) ─────────────────────────────
//
// A SINGLE place every synonym / anchor WRITE must pass through, so build-time
// creation, the improvement-chat `add_synonyms` action, and the framework-level
// proposal applier all get identical treatment. Before this module existed each of
// those three sites wrote raw jsonb with (at best) a DISTINCT dedup, so boilerplate
// / safe-harbour / cross-framework-leak terms that were stripped at build time could
// be re-introduced by a later edit. Routing all writes here closes that bypass.
//
// Layering (deterministic first, operator decisions second):
//   1. sanitizeTopicTerms — deterministic, topic-agnostic HARD drops
//      (empty / duplicate / punctuation_variant / boilerplate / high_df /
//       safe_harbour / cross_framework_leak). Protects the framework's OWN lexicon
//      (topicTerm only) and drops terms that map onto its declared adjacent topics.
//   2. runSynonymAdjudicationGate — applies operator "removed" adjudications to the
//      survivors and re-flags anything new for review (advisory, never hard-blocks).
//
// Everything here is topic-agnostic: the only inputs are the candidate list, the
// framework's own topicTerm, its own declared adjacentTopics, and its own recorded
// adjudications. No framework name, company list, or hard-coded vocabulary appears.

import {
  sanitizeTopicTerms,
  sanitizeAnchorFrameworks,
  type DropReason,
} from "./boilerplate-hygiene.js";
import {
  runSynonymAdjudicationGate,
  type SynonymAdjudication,
} from "./synonym-adjudication.js";

export interface SynonymHygieneOpts {
  /** The framework's canonical topic term (protected; never dropped). */
  topicTerm?: string | null;
  /** The framework's declared adjacent-topic names (drive cross_framework_leak). */
  adjacentTopics?: Iterable<string>;
  /** Previously recorded operator adjudications for this framework. */
  adjudications?: SynonymAdjudication[];
  /** Origin passed to the adjudication gate. Defaults to "llm". */
  origin?: "intake" | "llm";
  /** Reference corpus + DF-gate controls, forwarded to sanitizeTopicTerms. */
  corpus?: string[];
  dfThreshold?: number;
  skipDfGate?: boolean;
}

export interface SynonymHygieneResult {
  /** Final clean synonym set to persist (deterministic drops + operator removals). */
  kept: string[];
  /** Every term removed, with its machine reason class. */
  dropped: Array<{ term: string; reason: string }>;
  /** Counts keyed by reason class, for fail-loud residualWarnings / audit. */
  dropCountsByClass: Record<string, number>;
  /** Newly flagged terms that carry NO operator decision yet (drive the advisory). */
  unresolvedFlagged: Array<{ term: string; flagReason: string | null }>;
  /** True when no unresolved flags remain (the review loop has terminated). */
  gatePassed: boolean;
}

export interface AnchorHygieneResult {
  kept: Array<{ name: string; source?: string }>;
  dropped: Array<{ term: string; reason: string }>;
  dropCountsByClass: Record<string, number>;
}

function tallyByClass(
  dropped: Array<{ term: string; reason: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of dropped) counts[d.reason] = (counts[d.reason] ?? 0) + 1;
  return counts;
}

/**
 * The synonym write choke-point. Deterministic hard-hygiene, then operator
 * adjudications. Never throws — on any internal failure it degrades to returning
 * the input unchanged so a write can never be blocked by a hygiene fault
 * (fail-open for availability, fail-loud via the reported drop counts).
 */
export function applySynonymHygiene(
  raw: unknown,
  opts?: SynonymHygieneOpts,
): SynonymHygieneResult {
  const topicTerm = opts?.topicTerm ?? "";
  const adjacentTopics = opts?.adjacentTopics ?? [];

  // 1. Deterministic hard drops. Protect the CANONICAL topic term ONLY — NOT the
  //    adjacent names (those must be droppable as cross_framework_leak), and NOT the
  //    candidate list itself (or boilerplate would protect itself).
  const det = sanitizeTopicTerms(raw, {
    topicTokens: topicTerm ? [topicTerm] : [],
    adjacentTopics,
    corpus: opts?.corpus,
    dfThreshold: opts?.dfThreshold,
    skipDfGate: opts?.skipDfGate,
  });

  // 2. Operator adjudication gate on the survivors. topicTokens here PROTECT the
  //    framework's real vocabulary (topic term + adjacent names + survivors) from
  //    being spuriously flagged; the gate only removes explicit operator decisions
  //    and re-flags anything new for advisory review.
  const adjacentList = Array.from(adjacentTopics).filter(
    (a): a is string => typeof a === "string" && a.trim().length > 0,
  );
  let gateKept = det.kept;
  let gateRemoved: string[] = [];
  let unresolvedFlagged: Array<{ term: string; flagReason: string | null }> = [];
  let gatePassed = true;
  try {
    const gate = runSynonymAdjudicationGate({
      topicTerm,
      topicSynonyms: det.kept,
      topicTokens: [topicTerm, ...adjacentList, ...det.kept].filter(Boolean),
      adjudications: opts?.adjudications ?? [],
      origin: opts?.origin ?? "llm",
    });
    gateKept = gate.resolvedSynonyms;
    gateRemoved = gate.removedTerms;
    unresolvedFlagged = gate.unresolved;
    gatePassed = gate.passed;
  } catch {
    // Gate failure must not block the write — keep the deterministic survivors.
    gateKept = det.kept;
    gateRemoved = [];
    unresolvedFlagged = [];
    gatePassed = true;
  }

  const dropped: Array<{ term: string; reason: string }> = [
    ...det.dropped.map((d) => ({ term: d.term, reason: d.reason as string })),
    ...gateRemoved.map((t) => ({ term: t, reason: "adjudicated_removed" })),
  ];

  return {
    kept: gateKept,
    dropped,
    dropCountsByClass: tallyByClass(dropped),
    unresolvedFlagged,
    gatePassed,
  };
}

/**
 * The anchor-framework write choke-point. Anchors are proper names, so only dedup +
 * punctuation folding + cross_framework_leak apply (no boilerplate / DF gate).
 */
export function applyAnchorHygiene(
  raw: unknown,
  opts?: Pick<SynonymHygieneOpts, "adjacentTopics">,
): AnchorHygieneResult {
  const res = sanitizeAnchorFrameworks(raw, { adjacentTopics: opts?.adjacentTopics });
  const dropped = res.dropped.map((d) => ({ term: d.term, reason: d.reason as string }));
  return { kept: res.kept, dropped, dropCountsByClass: tallyByClass(dropped) };
}

/** Compact human string of drop counts, e.g. "safe_harbour: 2, duplicate: 1". */
export function formatDropCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
}

export type { DropReason };
