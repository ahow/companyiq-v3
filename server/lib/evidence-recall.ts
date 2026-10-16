/**
 * evidence-recall.ts — A5 / WP06: retrieval & evidence-pack recall.
 *
 * WHY (plan §"A5. Improve retrieval and evidence-pack recall (WP06)"):
 *   A valid document can be in the corpus while its DECISIVE PASSAGE never
 *   reaches the model prompt. Smarter models cannot fix missing input. The fix
 *   is NOT a new retriever — the analyzer ALREADY has BM25 retrieval
 *   (buildEvidencePackForMeasure), a bounded deep-read second pass
 *   (eligibleForDeepRead / buildDeepIndex), and a targeted re-retrieval path.
 *   The A5 work is: (a) MEASURE passage-level recall of decisive passages AT THE
 *   ACTUAL PROMPT BUDGET, and (b) close MEASURED misses with a BOUNDED
 *   evidence-expansion that COMPOSES with A3 eligibility (never reintroduces
 *   excluded material) and A4 fidelity — never by shrinking top-k or pack length.
 *
 * WHAT THIS MODULE IS:
 *   A deterministic, pure, DB-free, LLM-free toolkit with three responsibilities:
 *     1. DECISIVE-PASSAGE ORACLE (computeDecisivePassages) — a framework-level,
 *        corpus-based oracle that marks, per measure, which passages carry a
 *        sufficient density of that measure's DECISIVE LEXICAL SIGNAL (its own
 *        framework-authored evidenceKeywords + distinctive title tokens). ZERO
 *        per-company or per-topic logic — it reads only measure fields.
 *     2. RECALL MEASUREMENT (measurePackRecall) — given the exact pack shown to
 *        the scoring role (by stable passage identity) and the oracle set, report
 *        passage-level recall AT THE ACTUAL PROMPT BUDGET, plus the exact misses.
 *     3. BOUNDED EXPANSION PLANNER (planBoundedExpansion) — on DEMONSTRATED
 *        insufficiency (an eligible decisive passage exists in the corpus but did
 *        not reach the pack), return a BOUNDED set of ADDITIONAL eligible
 *        passages to append, recording WHY it fired. It:
 *          - COMPOSES with A3: an injected eligibility predicate filters out
 *            excluded material BEFORE selection, so expansion can NEVER
 *            reintroduce what A3 excluded (RT04);
 *          - is BOUNDED: caps extra passages and extra chars; no unlimited calls;
 *          - NEVER shrinks top-k or pack length (append-only);
 *          - dedups ONLY when every unique decisive token AND source link stays
 *            recoverable (RT06 — qualifiers/negation preserved);
 *          - is DETERMINISTIC: stable passage identity + stable ordering (RT05).
 *
 * VERSIONED KILL-SWITCH (mirrors the A2 EVIDENCE_GATE_POLICY / A3
 * ELIGIBILITY_ENFORCE precedent). As of GATE5 the shipped default is "on":
 *   resolveRecallExpansionPolicy() reads env RECALL_EXPANSION_POLICY:
 *     - "on"     (DEFAULT): apply the bounded expansion (behaviour-changing).
 *     - "shadow": compute the expansion plan + recall telemetry but DO NOT change
 *                 the evidence pack (observability only; verdict-invariant).
 *     - "off":    expansion disabled — byte-identical to the pre-A5 prod pack.
 *   The shipped default is "on" after GATE5 validation, so bounded recall
 *   expansion is the standing production behaviour. The kill-switch still fully
 *   overrides without a redeploy: set RECALL_EXPANSION_POLICY=off to restore the
 *   exact pre-A5 pack, or =shadow for telemetry-only. A typo or unrecognised
 *   value fails safe to the shipped default ("on"), never to an unintended mode.
 *
 * SAFETY: every exported function is pure and total (never throws on bad input),
 * returns plain data, performs no I/O, and never calls a model.
 */

import { createHash } from "crypto";
import { tokenize } from "./passage-retrieval.js";
import type { Chunk } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

// ─── Policy / kill-switch ─────────────────────────────────────────────────────

export type RecallExpansionPolicy = "off" | "shadow" | "on";

/** DEFAULT = standing production behaviour post-GATE5 (bounded expansion applied). */
export const DEFAULT_RECALL_EXPANSION_POLICY: RecallExpansionPolicy = "on";

/** Env var name for the kill-switch (documented in the ledger). */
export const RECALL_EXPANSION_ENV = "RECALL_EXPANSION_POLICY";

/**
 * Resolve the active policy: explicit arg > env RECALL_EXPANSION_POLICY > default.
 * Any unrecognised value falls back to the shipped default ("on" post-GATE5 —
 * fail-safe to the standing production behaviour, so a typo can never silently
 * change the mode). Set RECALL_EXPANSION_POLICY=off (or =shadow) to override.
 */
export function resolveRecallExpansionPolicy(
  explicit?: RecallExpansionPolicy | null,
): RecallExpansionPolicy {
  if (explicit === "off" || explicit === "shadow" || explicit === "on") return explicit;
  const env = (process.env[RECALL_EXPANSION_ENV] || "").trim().toLowerCase();
  if (env === "off" || env === "shadow" || env === "on") return env as RecallExpansionPolicy;
  return DEFAULT_RECALL_EXPANSION_POLICY;
}

/** True only when the kill-switch actively changes the pack ("on"). */
export function isRecallExpansionEnforced(explicit?: RecallExpansionPolicy | null): boolean {
  return resolveRecallExpansionPolicy(explicit) === "on";
}

// ─── Tunable bounds (all env-overridable; defaults chosen for recall, not cost) ─

/** Minimum distinct decisive tokens for a passage to count as "decisive". */
const DECISIVE_MIN_DISTINCT = Math.max(
  1,
  parseInt(process.env.RECALL_DECISIVE_MIN_DISTINCT || "2", 10) || 2,
);
/** Max decisive passages the oracle marks per measure (ranked, deterministic). */
const DECISIVE_MAX = Math.max(
  1,
  parseInt(process.env.RECALL_DECISIVE_MAX || "12", 10) || 12,
);
/** Bounded expansion: max ADDITIONAL passages appended per measure. */
const EXPANSION_MAX_PASSAGES = Math.max(
  0,
  parseInt(process.env.RECALL_EXPANSION_MAX_PASSAGES || "6", 10),
);
/** Bounded expansion: max ADDITIONAL characters appended per measure. */
const EXPANSION_MAX_CHARS = Math.max(
  0,
  parseInt(process.env.RECALL_EXPANSION_MAX_CHARS || "12000", 10),
);

// ─── Stable passage identity (RT05) ────────────────────────────────────────────

/**
 * Deterministic, content-stable identity for a passage. Mirrors the evidence-pack
 * fingerprint scheme (docUrl # seqInDoc # sha1(text)) so a passage has the SAME id
 * regardless of input array order or run. Never depends on positional index alone.
 */
export function stablePassageId(chunk: Pick<Chunk, "text" | "docUrl" | "seqInDoc" | "docIndex">): string {
  const url = (chunk.docUrl || "").trim().toLowerCase();
  const seq = chunk.seqInDoc ?? chunk.docIndex ?? 0;
  const h = createHash("sha1").update(chunk.text || "").digest("hex").slice(0, 12);
  return `${url}#${seq}#${h}`;
}

// ─── Decisive lexical signal (framework-level, measure-authored only) ──────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are",
  "was", "were", "will", "its", "our", "their", "they", "them", "which", "who",
  "whom", "what", "when", "where", "how", "why", "any", "all", "each", "such",
  "may", "can", "shall", "should", "would", "could", "must", "not", "but", "nor",
  "company", "companies", "group", "report", "annual", "disclosure", "disclosures",
  "information", "including", "include", "included", "within", "across", "also",
  "measure", "measures", "framework", "criterion", "criteria", "evidence",
]);

/**
 * The set of DECISIVE lexical tokens for a measure, drawn ONLY from the measure's
 * own framework-authored fields (title + evidenceKeywords). These are the signals
 * whose presence makes a passage decisive for THIS measure. Framework-level: no
 * company names, no topic hardcoding — only what the framework author wrote.
 *
 * Returns both single tokens and any multi-word evidenceKeyword phrases (lower-
 * cased) so a verbatim phrase hit can count even when no single token clears the
 * density bar (RT01 — synonym/sector language; RT02 — table/low-frequency terms).
 */
export function decisiveSignal(measure: Pick<FrameworkMeasure, "title" | "evidenceKeywords">): {
  tokens: string[];
  phrases: string[];
} {
  const tokenSet = new Set<string>();
  const phrases: string[] = [];
  const addTokens = (s: string | null | undefined, keepShort: boolean) => {
    if (!s) return;
    for (const t of tokenize(s)) {
      if (!t) continue;
      if (STOPWORDS.has(t)) continue;
      if (!keepShort && t.length < 3) continue;
      tokenSet.add(t);
    }
  };
  // Title tokens are distinctive but lower-weighted than explicit keywords.
  addTokens(measure.title, false);
  // evidenceKeywords are the most measure-specific signal — keep short acronyms.
  const kws = Array.isArray(measure.evidenceKeywords) ? measure.evidenceKeywords : [];
  for (const kw of kws) {
    if (!kw) continue;
    addTokens(kw, true);
    const phrase = String(kw).trim().toLowerCase();
    if (phrase.includes(" ") && phrase.length >= 4) phrases.push(phrase);
  }
  // Deterministic order.
  const tokens = [...tokenSet].sort();
  const uniquePhrases = [...new Set(phrases)].sort();
  return { tokens, phrases: uniquePhrases };
}

/**
 * How many DISTINCT decisive tokens (and whether any decisive phrase) a passage
 * carries. Deterministic, case-insensitive, no scoring side effects.
 */
export function passageDecisiveHits(
  text: string,
  signal: { tokens: string[]; phrases: string[] },
): { distinctTokens: number; matchedTokens: string[]; phraseHit: boolean } {
  const hay = (text || "").toLowerCase();
  const matched: string[] = [];
  // Token presence via word-ish boundary to avoid substring false positives.
  for (const tok of signal.tokens) {
    if (!tok) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(tok)}(?:[^a-z0-9]|$)`, "i");
    if (re.test(hay)) matched.push(tok);
  }
  let phraseHit = false;
  for (const p of signal.phrases) {
    if (p && hay.includes(p)) { phraseHit = true; break; }
  }
  return { distinctTokens: matched.length, matchedTokens: matched.sort(), phraseHit };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Decisive-passage oracle ───────────────────────────────────────────────────

export interface DecisivePassage {
  id: string;
  docUrl: string | null;
  docTitle: string | null;
  seqInDoc: number | null;
  distinctTokens: number;
  matchedTokens: string[];
  phraseHit: boolean;
  /** index into the input chunk array (diagnostic only; identity is `id`). */
  chunkIndex: number;
}

/**
 * Mark the decisive passages for a measure over the FULL corpus chunk set.
 *
 * A passage is decisive when it carries >= DECISIVE_MIN_DISTINCT distinct decisive
 * tokens OR contains a verbatim multi-word evidenceKeyword phrase (so a single
 * strong phrase, or a table cell with a rare qualifier, still counts — RT02).
 * The result is ranked by (phraseHit desc, distinctTokens desc, stable id asc)
 * and capped at DECISIVE_MAX, so the oracle is deterministic and bounded.
 *
 * This is the ground-truth the benchmark measures recall against AND the candidate
 * universe the bounded expansion draws from — a single definition, so "what should
 * have reached the model" and "what expansion may add" can never diverge.
 */
export function computeDecisivePassages(opts: {
  measure: Pick<FrameworkMeasure, "title" | "evidenceKeywords">;
  chunks: Chunk[];
  minDistinct?: number;
  max?: number;
}): DecisivePassage[] {
  const { measure, chunks } = opts;
  const minDistinct = opts.minDistinct ?? DECISIVE_MIN_DISTINCT;
  const max = opts.max ?? DECISIVE_MAX;
  const signal = decisiveSignal(measure);
  if (signal.tokens.length === 0 && signal.phrases.length === 0) return [];

  const candidates: DecisivePassage[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const hits = passageDecisiveHits(c.text, signal);
    const isDecisive = hits.phraseHit || hits.distinctTokens >= minDistinct;
    if (!isDecisive) continue;
    candidates.push({
      id: stablePassageId(c),
      docUrl: c.docUrl ?? null,
      docTitle: c.docTitle ?? null,
      seqInDoc: c.seqInDoc ?? null,
      distinctTokens: hits.distinctTokens,
      matchedTokens: hits.matchedTokens,
      phraseHit: hits.phraseHit,
      chunkIndex: i,
    });
  }
  candidates.sort((a, b) => {
    if (a.phraseHit !== b.phraseHit) return a.phraseHit ? -1 : 1;
    if (b.distinctTokens !== a.distinctTokens) return b.distinctTokens - a.distinctTokens;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // De-duplicate by stable id (same passage fetched twice) keeping the first.
  const seen = new Set<string>();
  const unique: DecisivePassage[] = [];
  for (const cand of candidates) {
    if (seen.has(cand.id)) continue;
    seen.add(cand.id);
    unique.push(cand);
    if (unique.length >= max) break;
  }
  return unique;
}

// ─── Recall measurement (at the actual prompt budget) ──────────────────────────

export interface RecallResult {
  decisiveCount: number;
  recalledCount: number;
  recall: number; // 0..1; 1 when decisiveCount === 0 (nothing to miss)
  misses: DecisivePassage[]; // decisive passages NOT present in the pack
  recalledIds: string[];
}

/**
 * Passage-level recall of decisive passages AT THE ACTUAL PROMPT BUDGET.
 *
 * `packPassageIds` MUST be the stable ids of the chunks that actually reached the
 * pack shown to the scoring role (compute them with stablePassageId over the pack
 * chunks). Recall is |decisive ∩ pack| / |decisive|. Misses are the decisive
 * passages absent from the pack, in oracle order — the exact set that drives
 * demonstrated-insufficiency expansion.
 */
export function measurePackRecall(opts: {
  decisive: DecisivePassage[];
  packPassageIds: Iterable<string>;
}): RecallResult {
  const packSet = new Set(opts.packPassageIds);
  const recalled: string[] = [];
  const misses: DecisivePassage[] = [];
  for (const d of opts.decisive) {
    if (packSet.has(d.id)) recalled.push(d.id);
    else misses.push(d);
  }
  const decisiveCount = opts.decisive.length;
  const recalledCount = recalled.length;
  const recall = decisiveCount === 0 ? 1 : recalledCount / decisiveCount;
  return { decisiveCount, recalledCount, recall, misses, recalledIds: recalled };
}

// ─── Bounded expansion planner (A3-composing, append-only, deterministic) ──────

export interface ExpansionCandidate {
  id: string;
  text: string;
  docUrl: string | null;
  docTitle: string | null;
  seqInDoc: number | null;
  distinctTokens: number;
  matchedTokens: string[];
  phraseHit: boolean;
}

export interface ExpansionPlan {
  fired: boolean;
  /** Machine + human readable reason the expansion fired (or why it did not). */
  reason: string;
  /** Additional passages to APPEND to the pack (bounded, deterministic order). */
  added: ExpansionCandidate[];
  addedChars: number;
  /** decisive misses dropped because A3 marked them excluded (never re-added). */
  droppedExcluded: number;
  /** candidates dropped as fully-redundant duplicates (no new fact/link lost). */
  droppedDuplicate: number;
  /** true when a cap (passages or chars) stopped further additions. */
  capHit: boolean;
  caps: { maxPassages: number; maxChars: number };
  /** ids of the eligible decisive misses considered (diagnostic). */
  eligibleMissIds: string[];
}

/**
 * Plan a BOUNDED evidence expansion for ONE measure, on DEMONSTRATED
 * insufficiency. Append-only: it NEVER removes or reorders existing pack content
 * and NEVER shrinks top-k or pack length.
 *
 * Inputs:
 *   - decisive misses: decisive passages that did NOT reach the pack (from
 *     measurePackRecall). If empty, the expansion does not fire (no demonstrated
 *     insufficiency) — returns fired:false.
 *   - chunks: the FULL corpus chunk set (to resolve a miss id back to its text).
 *   - packPassageIds: ids already in the pack (never re-added).
 *   - isEligible: an A3-composing predicate (chunk -> boolean). A passage A3
 *     marks EXCLUDED is dropped BEFORE selection, so expansion can NEVER
 *     reintroduce excluded material (RT04). Default: everything eligible — the
 *     analyzer injects the real A3 predicate; tests inject exclusions.
 *
 * Bounding: at most `maxPassages` extra passages and `maxChars` extra characters.
 *
 * Dedup (RT06): a candidate is dropped as a pure duplicate ONLY when it adds no
 * new decisive token AND its source link is already represented among kept
 * passages — so every unique decisive fact and source link stays recoverable
 * (qualifiers/negation in a distinct passage are never dropped).
 */
export function planBoundedExpansion(opts: {
  misses: DecisivePassage[];
  chunks: Chunk[];
  packPassageIds: Iterable<string>;
  isEligible?: (chunk: Chunk) => boolean;
  maxPassages?: number;
  maxChars?: number;
  /** passages already represented in the pack, for dedup source-link coverage. */
  packChunks?: Chunk[];
  /**
   * The measure, used ONLY to seed dedup coverage from the pack: when provided
   * alongside packChunks, the decisive tokens ALREADY present in the pack are
   * treated as covered, so a candidate that merely repeats pack facts (and adds
   * no new link / phrase) is dropped as redundant (RT06). Omitting it makes dedup
   * expansion-internal only (candidates are still deduped against each other).
   */
  measure?: Pick<FrameworkMeasure, "title" | "evidenceKeywords">;
}): ExpansionPlan {
  const maxPassages = opts.maxPassages ?? EXPANSION_MAX_PASSAGES;
  const maxChars = opts.maxChars ?? EXPANSION_MAX_CHARS;
  const caps = { maxPassages, maxChars };
  const isEligible = opts.isEligible ?? (() => true);
  const packSet = new Set(opts.packPassageIds);

  // Resolve each decisive miss back to its live chunk (by stable id) so we have
  // its text + provenance. A miss whose chunk is not found is skipped defensively.
  const byId = new Map<string, Chunk>();
  for (const c of opts.chunks) byId.set(stablePassageId(c), c);

  // Seed dedup coverage from the EXISTING pack: decisive tokens and source links
  // already present. Expansion must only add NEW facts/links.
  const coveredTokens = new Set<string>();
  const coveredLinks = new Set<string>();
  const packSignal = opts.measure ? decisiveSignal(opts.measure) : null;
  if (opts.packChunks) {
    for (const pc of opts.packChunks) {
      coveredLinks.add((pc.docUrl || "").trim().toLowerCase());
      // Seed decisive-token coverage from the pack so a candidate that merely
      // repeats facts already in the pack (and adds no new link/phrase) is deduped.
      if (packSignal) {
        for (const t of passageDecisiveHits(pc.text, packSignal).matchedTokens) {
          coveredTokens.add(t);
        }
      }
    }
  }

  let droppedExcluded = 0;
  let droppedDuplicate = 0;
  let capHit = false;
  const added: ExpansionCandidate[] = [];
  let addedChars = 0;
  const eligibleMissIds: string[] = [];

  for (const miss of opts.misses) {
    if (packSet.has(miss.id)) continue; // already present — never re-add
    const chunk = byId.get(miss.id);
    if (!chunk) continue;
    // A3 COMPOSITION: excluded material is never reintroduced.
    if (!isEligible(chunk)) { droppedExcluded++; continue; }
    eligibleMissIds.push(miss.id);

    // Cap checks — bounded, no unlimited retrieval.
    if (added.length >= maxPassages) { capHit = true; continue; }
    const text = chunk.text || "";
    if (addedChars + text.length > maxChars) {
      // Only mark capHit if this candidate is otherwise additive; tiny headroom
      // overflow still stops growth. Skip (do not truncate a passage mid-fact).
      capHit = true;
      continue;
    }

    // Dedup: drop ONLY if it introduces no new decisive token AND its link is
    // already covered (so no unique fact/link is lost — RT06).
    const link = (chunk.docUrl || "").trim().toLowerCase();
    const newTokens = miss.matchedTokens.filter((t) => !coveredTokens.has(t));
    const linkNew = !coveredLinks.has(link);
    if (newTokens.length === 0 && !linkNew && !miss.phraseHit) {
      droppedDuplicate++;
      continue;
    }

    added.push({
      id: miss.id,
      text,
      docUrl: chunk.docUrl ?? null,
      docTitle: chunk.docTitle ?? null,
      seqInDoc: chunk.seqInDoc ?? null,
      distinctTokens: miss.distinctTokens,
      matchedTokens: miss.matchedTokens,
      phraseHit: miss.phraseHit,
    });
    addedChars += text.length;
    for (const t of miss.matchedTokens) coveredTokens.add(t);
    coveredLinks.add(link);
  }

  const fired = added.length > 0;
  let reason: string;
  if (fired) {
    reason =
      `bounded-expansion: ${added.length} eligible decisive passage(s) were present in the ` +
      `corpus but missing from the pack (added ${addedChars} chars` +
      `${capHit ? `, cap ${maxPassages}p/${maxChars}c hit` : ""}` +
      `${droppedExcluded ? `, ${droppedExcluded} excluded by A3 not re-added` : ""}` +
      `${droppedDuplicate ? `, ${droppedDuplicate} redundant dropped` : ""})`;
  } else if (eligibleMissIds.length === 0 && droppedExcluded > 0) {
    reason = `no-expansion: all ${droppedExcluded} decisive miss(es) are A3-excluded (not re-addable)`;
  } else {
    reason = "no-expansion: no eligible decisive passage missing from the pack (recall sufficient)";
  }

  return {
    fired,
    reason,
    added,
    addedChars,
    droppedExcluded,
    droppedDuplicate,
    capHit,
    caps,
    eligibleMissIds,
  };
}

/**
 * Format the bounded-expansion additions as an APPEND block for the evidence
 * pack text, with per-passage provenance headers so every added fact keeps its
 * source link. Deterministic (input order preserved). Returns "" when nothing to
 * add, so a no-op expansion yields a byte-identical pack.
 */
export function formatExpansionAppend(plan: ExpansionPlan): string {
  if (!plan.fired || plan.added.length === 0) return "";
  const parts: string[] = ["\n\n--- A5 RECALL EXPANSION (bounded, eligible decisive passages) ---"];
  for (const p of plan.added) {
    const title = p.docTitle || "(untitled source)";
    const url = p.docUrl || "";
    parts.push(`\n--- DOCUMENT: ${title}${url ? ` [${url}]` : ""} ---\n${p.text}`);
  }
  return parts.join("\n");
}
