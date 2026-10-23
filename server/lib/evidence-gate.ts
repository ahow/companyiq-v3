/**
 * Deterministic evidence-integrity gate — pure string logic, NO LLM.
 *
 * Applied to EVERY model output (primaries, extra votes, and the arbiter) right
 * after its JSON is parsed and BEFORE any cascade decision is reconstructed.
 *
 * For each quote {text, source} a model returns for a measure it runs three
 * independent checks; a quote is VALID only if it passes ALL three:
 *
 *   (1) PROVENANCE  — the quote text must actually appear in the assembled
 *       evidence-pack text the model was shown for that measure. Normalise both
 *       and match by longest common SUBSTRING (contiguous run).
 *
 *   (2) ANTI-ECHO   — if the quote shares a normalised verbatim run of >= 60
 *       chars with ANY injected positiveExample / negativeExample of that
 *       measure, it is a fabricated prompt-echo. FAIL (see v2 override below).
 *
 *   (3) SOURCE      — an empty / thin source (< 4 chars) or a self-declared-
 *       absent source (contains "no such" / "not found" / "n/a") = FAIL.
 *
 * Consequence (binary scoring preserved, 0/1 only):
 *   - A YES (score === 1) is sustained ONLY if at least one VALID quote remains,
 *     otherwise the score is downgraded to 0.
 *   - A NO (score === 0) stays 0.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POLICY VERSIONING (A2 / WP03)
 * ────────────────────────────────────────────────────────────────────────────
 * The gate ships two behavioural policies, selectable per-call (`policyVersion`)
 * or by env flag `EVIDENCE_GATE_POLICY` (default `v2`). `v1` reproduces the
 * previous behaviour EXACTLY for A/B delta measurement; `v2` is the hardened
 * default that fixes three evidence-integrity defects:
 *
 *   E6-1  Fuzzy absolute-120-char escape hatch — v1 passed a quote whose first
 *         120 normalised chars matched even if the rest was invented. v2 REMOVES
 *         the absolute-LCS hatch and requires full-quote coverage (>= 90% of the
 *         normalised quote length), splitting honest ellipsis (`…` / `...`) into
 *         spans that must EACH match contiguously (never merging fragments).
 *
 *   E6-2  Silent pack-wide provenance fallback — v1, when a quote.source named a
 *         document that resolved to no segment, silently fell back to pack-wide
 *         provenance (no attribution fail). v2 performs BOUNDED REPAIR: the quote
 *         must trace to SOME present document segment; if it traces to none, it is
 *         an explicit `source-attribution` failure rather than a silent pass.
 *
 *   E6-3  ASCII-only normalisation — v1 stripped every non-ASCII char and all
 *         punctuation (incl. minus signs, decimals, %), so `-5%` and `5%`
 *         normalised identically. v2 is Unicode-aware (NFKC + \p{L}\p{N}),
 *         preserving digits, sign (U+002D / U+2212 unified), decimals, `, . %`
 *         and non-Latin scripts, so sign/magnitude tampering no longer passes.
 *
 * v2 also adds an anti-echo OVERRIDE: a quote with exact provenance that is
 * authoritatively attributed to a resolvable document segment is NOT rejected as
 * an echo merely because it also matches a rubric example verbatim — exact
 * provenance + authoritative source identity beats lexical similarity (QI07),
 * without weakening the fabricated-echo check for unprovenanced quotes (QI01).
 *
 * Synchronous and cheap: LCS is computed with a rolling 1-D DP array.
 */

export type GateFailureReason =
  | "provenance"
  | "anti-echo"
  | "source"
  | "source-attribution";

export interface GateFailure {
  quoteText: string;
  source: string;
  reasons: GateFailureReason[];
}

/**
 * Optional per-document segment of the assembled pack (Task C). `id` is a
 * document identity (e.g. filename / title) that a quote.source may name; `text`
 * is that document's slice of the pack. When supplied, a quote whose source
 * resolves to a segment must have provenance against THAT segment's text.
 */
export interface DocumentSegment {
  id: string;
  text: string;
}

/** Policy version for the evidence gate. `v2` is the hardened default. */
export type GatePolicyVersion = "v1" | "v2";

export interface EvidenceGateResult {
  quotesTotal: number;
  quotesValid: number;
  failures: GateFailure[];
  downgraded: boolean;
  originalScore: number;
  /** Which policy actually ran (resolved from param / env / default). */
  policyVersion: GatePolicyVersion;
  /**
   * v2 bounded-repair audit: quotes whose named source did not resolve to a
   * segment but that were re-attributed to a present segment they genuinely
   * trace to. Records the original (unresolved) source for audit.
   */
  repairs?: RepairRecord[];
  /**
   * Option C (search-and-repair) audit: when EVERY model quote failed provenance
   * and the YES was rescued by a deterministic corpus re-search, the passage that
   * was found (verbatim-present in the pack) and the segment it came from. Present
   * only in the repair path (`gateEvidenceWithRepair`).
   */
  researched?: ResearchRecord[];
}

/**
 * Option C audit record: a quote that was relabelled (not rejected) because its
 * source bound to the wrong segment — or to no segment — while its verbatim text
 * lives in another present segment. `repairedTo` is the segment it now cites.
 */
export interface RepairRecord {
  quoteText: string;
  originalSource: string;
  repairedTo: string;
}

/**
 * Option C audit record: a YES that was rescued by corpus re-search after every
 * model quote failed provenance. `repairedQuote` is the best verbatim-present
 * passage found in the pack for the measure's positive criteria; `repairedSource`
 * is the segment it was drawn from; `criteria` is the query used.
 */
export interface ResearchRecord {
  criteria: string;
  repairedSource: string;
  repairedQuote: string;
}

export interface QuoteInput {
  text: string;
  source: string;
}

export interface GateParams {
  originalScore: number;
  quotes: QuoteInput[];
  packText: string;
  positiveExamples?: string[];
  negativeExamples?: string[];
  /**
   * Task B — strict-strip. When true (default), invalid quotes are dropped from
   * the returned `keptQuotes` so a flagged quote is never presented as support,
   * even when the YES survives on another valid quote. When false, `keptQuotes`
   * is the full input list (legacy behaviour).
   */
  strictStrip?: boolean;
  /**
   * Task C — optional per-document pack segments. If a quote.source resolves to
   * one of these, provenance is required against THAT document's text. Omit for
   * exactly-as-before behaviour.
   */
  documentSegments?: DocumentSegment[];
  /**
   * Task C — enable the source-attribution dimension. Default true, but only has
   * any effect when documentSegments are supplied.
   */
  sourceAttribution?: boolean;
  /**
   * A2 / WP03 — force a gate policy version for this call. When omitted, the
   * active policy is read from env `EVIDENCE_GATE_POLICY` (default `v2`). Tests
   * pass this explicitly to compare v1 vs v2 on identical input.
   */
  policyVersion?: GatePolicyVersion;
  /**
   * Option C (search-and-repair) — the measure's positive criteria as free text
   * (title / definition / assessment target). Used ONLY by `gateEvidenceWithRepair`
   * to run a deterministic, corpus-only re-search when every model quote fails
   * provenance. Ignored by the legacy `gateEvidence` path.
   */
  researchCriteria?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Thresholds (documented above).
// ────────────────────────────────────────────────────────────────────────────
const PROVENANCE_MIN_RATIO = 0.9; // >= 90% of normalised quote length
const PROVENANCE_MIN_LCS = 120; // v1 ONLY: absolute LCS escape hatch (E6-1)
const ANTI_ECHO_MIN_RUN = 60; // shared verbatim run >= 60 chars = echo
const SOURCE_MIN_LEN = 4; // source shorter than this = thin
const SOURCE_ABSENT_MARKERS = ["no such", "not found", "n/a"];
// Task C: how strongly a quote.source must overlap a segment id to be "attributed"
// to that document. Whole id, or an absolute run of this many chars.
const SOURCE_ATTRIBUTION_MIN_RATIO = 0.9;
const SOURCE_ATTRIBUTION_MIN_RUN = 12;

/** The hardened policy version that ships as the default. */
export const GATE_POLICY_VERSION: GatePolicyVersion = "v2";

/**
 * Resolve the active gate policy: explicit param wins, else env
 * `EVIDENCE_GATE_POLICY` (`v1` opts out), else the hardened default `v2`.
 */
export function resolveGatePolicy(explicit?: GatePolicyVersion): GatePolicyVersion {
  if (explicit === "v1" || explicit === "v2") return explicit;
  const env = (process.env.EVIDENCE_GATE_POLICY || "").trim().toLowerCase();
  if (env === "v1") return "v1";
  return GATE_POLICY_VERSION;
}

// ────────────────────────────────────────────────────────────────────────────
// Normalisation
// ────────────────────────────────────────────────────────────────────────────

/**
 * v1 normalise — exactly like echo_provenance_scan.py:norm(). ASCII-only:
 * strips every non-`[a-z0-9 ]` char (incl. minus / decimals / % and all
 * non-Latin scripts). Preserved verbatim for v1 A/B parity. (E6-3 defect.)
 */
export function normaliseForGateV1(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * v2 normalise — Unicode-aware (E6-3 fix). NFKC-fold, lowercase, then:
 *   - strip soft hyphen / zero-width format chars entirely (hyphenation &
 *     word-join artefacts collapse so "co­operate" == "cooperate"),
 *   - unify the minus sign (U+2212 → U+002D) so sign variants compare equal,
 *   - keep letters & numbers of ANY script (\p{L}\p{N}) plus the material
 *     symbols that carry meaning: `-` `.` `,` `%`,
 *   - collapse remaining runs of anything else to a single space.
 * Sign, magnitude, decimals, units and non-Latin content all survive, so
 * `-5%` !== `5%` and tampered CJK/Arabic no longer normalises to its origin.
 *
 * NOTE: used ONLY for comparison; original characters are preserved untouched
 * for display / audit (this function never mutates inputs).
 */
export function normaliseForGateV2(s: string): string {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    // Remove soft hyphen (U+00AD) and zero-width chars (join/non-join/space/BOM).
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, "")
    // Unify unicode minus (U+2212) with ASCII hyphen-minus (U+002D).
    .replace(/\u2212/g, "-")
    // Keep letters/numbers of any script + material symbols; everything else → space.
    .replace(/[^\p{L}\p{N}\-.,%\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Backward-compatible export: `normaliseForGate` is the v1 (ASCII) normaliser so
 * existing importers keep their exact semantics. Use `normaliseForGateV2` (or
 * run the gate with policy v2) for the hardened, Unicode-aware normalisation.
 */
export function normaliseForGate(s: string): string {
  return normaliseForGateV1(s);
}

function normaliseFor(policy: GatePolicyVersion, s: string): string {
  return policy === "v1" ? normaliseForGateV1(s) : normaliseForGateV2(s);
}

/**
 * Length of the longest common CONTIGUOUS substring of a and b.
 * Rolling 1-D DP over the shorter string to keep memory small.
 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let outer = a;
  let inner = b;
  if (inner.length > outer.length) {
    const t = outer;
    outer = inner;
    inner = t;
  }
  const n = inner.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  let best = 0;
  for (let i = 0; i < outer.length; i++) {
    const oc = outer.charCodeAt(i);
    for (let j = 0; j < n; j++) {
      if (oc === inner.charCodeAt(j)) {
        const v = prev[j] + 1;
        curr[j + 1] = v;
        if (v > best) best = v;
      } else {
        curr[j + 1] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return best;
}

// ────────────────────────────────────────────────────────────────────────────
// Provenance
// ────────────────────────────────────────────────────────────────────────────

/** Split a quote into contiguous spans on honest ellipsis (`…` or `...`). */
function splitEllipsisSpans(quoteText: string): string[] {
  // U+2026 (…) or three-or-more ASCII dots. A lone "." (decimals, sentence end)
  // is NOT a split point.
  return (quoteText || "").split(/\u2026|\.{3,}/g);
}

/**
 * Does a single (already contiguous) span appear in the pack under `policy`?
 * p.includes(q) is the LCS == len special case; otherwise require the longest
 * contiguous run to cover >= PROVENANCE_MIN_RATIO of the normalised span. The
 * v1 absolute-120 escape hatch (E6-1) applies ONLY under policy v1.
 */
function spanHasProvenance(policy: GatePolicyVersion, span: string, packText: string): boolean {
  const q = normaliseFor(policy, span);
  if (!q) return false;
  const p = normaliseFor(policy, packText);
  if (!p) return false;
  if (p.includes(q)) return true;
  const lcs = longestCommonSubstringLength(q, p);
  if (lcs >= q.length * PROVENANCE_MIN_RATIO) return true;
  // E6-1: the absolute-LCS hatch survives ONLY in v1 for A/B parity.
  if (policy === "v1" && lcs >= PROVENANCE_MIN_LCS) return true;
  return false;
}

/**
 * (1) PROVENANCE under an explicit policy.
 *   v1 — whole-quote fuzzy match with the absolute-120 hatch (legacy).
 *   v2 — split on ellipsis; EVERY non-empty span must independently (and
 *        contiguously) match the pack, with no absolute-LCS hatch. This forces
 *        full-quote coverage: a quote with a genuine 120-char prefix and an
 *        invented tail fails, and noncontiguous fragments are never merged.
 */
export function checkProvenanceWithPolicy(
  policy: GatePolicyVersion,
  quoteText: string,
  packText: string,
): boolean {
  if (policy === "v1") {
    return spanHasProvenance("v1", quoteText, packText);
  }
  const spans = splitEllipsisSpans(quoteText).filter((s) => normaliseForGateV2(s).length > 0);
  if (spans.length === 0) return false;
  for (const span of spans) {
    if (!spanHasProvenance("v2", span, packText)) return false;
  }
  return true;
}

/**
 * Backward-compatible export: `checkProvenance` keeps the v1 semantics (fuzzy
 * whole-quote match WITH the absolute-120 hatch) so existing importers are
 * unchanged. The gate itself uses `checkProvenanceWithPolicy`.
 */
export function checkProvenance(quoteText: string, packText: string): boolean {
  return checkProvenanceWithPolicy("v1", quoteText, packText);
}

// ────────────────────────────────────────────────────────────────────────────
// Anti-echo & source
// ────────────────────────────────────────────────────────────────────────────

/** (2) ANTI-ECHO under an explicit policy. */
export function checkAntiEchoWithPolicy(
  policy: GatePolicyVersion,
  quoteText: string,
  examples: string[],
): boolean {
  const q = normaliseFor(policy, quoteText);
  if (!q) return true; // empty handled by provenance/source
  for (const ex of examples) {
    const e = normaliseFor(policy, ex);
    if (!e) continue;
    if (longestCommonSubstringLength(q, e) >= ANTI_ECHO_MIN_RUN) return false;
  }
  return true;
}

/** Backward-compatible export: v1 semantics. */
export function checkAntiEcho(quoteText: string, examples: string[]): boolean {
  return checkAntiEchoWithPolicy("v1", quoteText, examples);
}

/** (3) SOURCE: non-empty, not thin, not self-declared-absent. (Policy-agnostic.) */
export function checkSource(source: string): boolean {
  const s = (source || "").trim();
  if (s.length < SOURCE_MIN_LEN) return false;
  const lower = s.toLowerCase();
  for (const marker of SOURCE_ABSENT_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Source attribution (Task C)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a quote.source to one of the supplied per-document segments under an
 * explicit policy. A segment matches when its normalised id shares a
 * >= SOURCE_ATTRIBUTION_MIN_RUN contiguous run with the normalised source
 * (either direction). Returns the best (longest-run) match, or null.
 */
export function resolveDocumentSegmentWithPolicy(
  policy: GatePolicyVersion,
  source: string,
  segments: DocumentSegment[],
): DocumentSegment | null {
  const s = normaliseFor(policy, source);
  if (!s || !segments || segments.length === 0) return null;
  let best: DocumentSegment | null = null;
  let bestRun = 0;
  for (const seg of segments) {
    const id = normaliseFor(policy, seg.id || "");
    if (!id) continue;
    const run = longestCommonSubstringLength(s, id);
    const enough =
      run >= id.length * SOURCE_ATTRIBUTION_MIN_RATIO ||
      run >= SOURCE_ATTRIBUTION_MIN_RUN;
    if (enough && run > bestRun) {
      bestRun = run;
      best = seg;
    }
  }
  return best;
}

/** Backward-compatible export: v1 semantics. */
export function resolveDocumentSegment(
  source: string,
  segments: DocumentSegment[],
): DocumentSegment | null {
  return resolveDocumentSegmentWithPolicy("v1", source, segments);
}

/**
 * Parse an assembled evidence pack into per-document segments (unchanged).
 * Relies only on the pack's own delimiter `--- DOCUMENT: <title> [<url>] ---`.
 * Returns [] when the pack has no such headers (→ pack-wide provenance).
 */
export function parsePackSegments(packText: string): DocumentSegment[] {
  if (!packText) return [];
  const headerPattern = /--- DOCUMENT: (.+?) \[(.+?)\] ---/g;
  const headers: Array<{ title: string; url: string; startIdx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerPattern.exec(packText)) !== null) {
    headers.push({ title: (m[1] || "").trim(), url: (m[2] || "").trim(), startIdx: m.index });
  }
  if (headers.length === 0) return [];
  const segments: DocumentSegment[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].startIdx;
    const end = i + 1 < headers.length ? headers[i + 1].startIdx : packText.length;
    const id = headers[i].title || headers[i].url;
    if (!id) continue;
    segments.push({ id, text: packText.slice(start, end) });
  }
  return segments;
}

// ────────────────────────────────────────────────────────────────────────────
// Gate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run the full gate on a model's output for a single measure.
 * Pure & synchronous. Returns the (possibly downgraded) binary score, a
 * per-llmResult gate record, and the quotes to keep (strict-strip aware).
 * Never mutates its inputs.
 */
export function gateEvidence<Q extends QuoteInput>(
  params: Omit<GateParams, "quotes"> & { quotes: Q[] },
): {
  score: number;
  gate: EvidenceGateResult;
  keptQuotes: Q[];
} {
  const { originalScore, quotes, packText } = params;
  const policy = resolveGatePolicy(params.policyVersion);
  const strictStrip = params.strictStrip !== false; // Task B: default true
  const sourceAttribution = params.sourceAttribution !== false; // Task C: default true
  const segments = params.documentSegments || [];
  const examples = [
    ...(params.positiveExamples || []),
    ...(params.negativeExamples || []),
  ];

  const failures: GateFailure[] = [];
  const keptQuotes: Q[] = [];
  const repairs: Array<{ quoteText: string; originalSource: string; repairedTo: string }> = [];
  let quotesValid = 0;

  for (const q of quotes || []) {
    const text = q?.text || "";
    const source = q?.source || "";
    const reasons: GateFailureReason[] = [];

    const packOk = checkProvenanceWithPolicy(policy, text, packText);
    // Was the quote authoritatively attributed to a resolvable segment it
    // genuinely traces to? (Grants the v2 anti-echo override.)
    let authoritative = false;

    if (!packOk) {
      reasons.push("provenance");
    } else if (sourceAttribution && segments.length > 0) {
      const seg = resolveDocumentSegmentWithPolicy(policy, source, segments);
      if (seg) {
        // The source names a present document: the quote MUST trace to it.
        if (checkProvenanceWithPolicy(policy, text, seg.text)) {
          authoritative = true;
        } else {
          reasons.push("source-attribution");
        }
      } else if (policy === "v2") {
        // E6-2 fix: the named source resolves to NO segment. v1 silently fell
        // back to pack-wide (a pass); v2 performs bounded repair — the quote
        // must trace to SOME present segment, else it is an attribution failure.
        const repairedSeg = segments.find((sg) =>
          checkProvenanceWithPolicy(policy, text, sg.text),
        );
        if (repairedSeg) {
          repairs.push({ quoteText: text, originalSource: source, repairedTo: repairedSeg.id });
        } else {
          reasons.push("source-attribution");
        }
      }
      // policy v1, seg === null → legacy pack-wide fallback (no action).
    }

    if (!checkAntiEchoWithPolicy(policy, text, examples)) {
      // v2 anti-echo OVERRIDE (QI07): a quote with exact provenance that is
      // authoritatively attributed to a resolvable segment, with a valid source,
      // beats lexical similarity to a rubric example. QI01 (no valid provenance)
      // is unaffected because `packOk`/`authoritative` are false there.
      const override =
        policy === "v2" && packOk && authoritative && checkSource(source);
      if (!override) reasons.push("anti-echo");
    }

    if (!checkSource(source)) reasons.push("source");

    if (reasons.length === 0) {
      quotesValid++;
      keptQuotes.push(q);
    } else {
      failures.push({ quoteText: text, source, reasons });
      if (!strictStrip) keptQuotes.push(q); // legacy: keep flagged quotes too
    }
  }

  const quotesTotal = (quotes || []).length;
  // Binary scoring preserved: a YES survives only with >=1 VALID quote; NO stays 0.
  const sustained = originalScore === 1 && quotesValid >= 1;
  const score = sustained ? 1 : 0;
  const downgraded = originalScore === 1 && !sustained;

  return {
    score,
    gate: {
      quotesTotal,
      quotesValid,
      failures,
      downgraded,
      originalScore,
      policyVersion: policy,
      ...(repairs.length > 0 ? { repairs } : {}),
    },
    keptQuotes,
  };
}



// ────────────────────────────────────────────────────────────────────────────
// Option C — search-and-repair (behind RETRIEVAL_EVIDENCE_REPAIR in analyzer)
// ────────────────────────────────────────────────────────────────────────────

/** Tokenise free text into content tokens (>= 4 chars) under a policy. */
function researchTokens(policy: GatePolicyVersion, s: string): string[] {
  return normaliseFor(policy, s)
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

/**
 * Deterministic, corpus-only re-search (Option C step 3). Given the measure's
 * positive criteria, find the best verbatim-present passage in the pack that
 * supports them. Candidate passages are sentences sliced from each present
 * segment (or the whole pack when there are no DOCUMENT headers), so every
 * returned passage is — by construction — a contiguous substring of the pack and
 * therefore passes pack-wide provenance. Scored by distinct-criteria-term
 * overlap; the single best candidate (ties broken deterministically by first
 * occurrence) is returned, or null when nothing in the corpus matches (→ the
 * last-resort downgrade). NO network, NO new fetch — existing pack only.
 */
export function researchBestPassage(
  policy: GatePolicyVersion,
  criteria: string[],
  segments: DocumentSegment[],
  packText: string,
): { text: string; source: string } | null {
  const terms = new Set<string>();
  for (const c of criteria || []) for (const t of researchTokens(policy, c)) terms.add(t);
  if (terms.size === 0) return null;

  const searchSegs: DocumentSegment[] =
    segments && segments.length > 0 ? segments : [{ id: "pack", text: packText || "" }];

  let best: { text: string; source: string } | null = null;
  let bestScore = 0;
  for (const seg of searchSegs) {
    // Drop the DOCUMENT header line so it never becomes a candidate passage.
    const body = (seg.text || "").replace(/--- DOCUMENT: .+? \[.+?\] ---/g, " ");
    const sentences = body
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 40 && s.length <= 600);
    for (const sent of sentences) {
      const toks = new Set(researchTokens(policy, sent));
      let overlap = 0;
      for (const t of terms) if (toks.has(t)) overlap++;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = { text: sent, source: seg.id };
      }
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Option A + C: search-and-repair evidence verification.
 *
 * This is the flag-ON path (`RETRIEVAL_EVIDENCE_REPAIR=1`). It differs from the
 * legacy `gateEvidence` (flag-OFF, byte-identical current behaviour) in exactly
 * the ways §5 of docs/gate-ab-and-cascade-redesign.md specifies:
 *
 *   1. Provenance (unchanged) — a quote must be verbatim-present pack-wide.
 *   2. Attribution becomes REPAIR, not reject — a provenanced quote whose source
 *      binds to the wrong segment (or to none) is RELABELLED to the segment that
 *      actually contains its verbatim text, recorded in `repairs[]`, and counts
 *      as valid. Covers BOTH the "resolved-to-wrong-segment" and the
 *      "resolve-failed" paths that the legacy gate rejected / only audited.
 *   3. Re-search on failure — if EVERY model quote fails provenance, run a
 *      deterministic corpus-only re-search (`researchBestPassage`) for the
 *      measure's positive criteria and, if a supporting passage is found, KEEP
 *      the YES with that repaired quote (recorded in `researched[]`).
 *   4. Downgrade only as last resort — flip YES→NO ONLY when steps 1–3 find no
 *      verbatim-present supporting passage anywhere in the corpus.
 *   5. Audit everything — same gate blob plus `repairs[]` / `researched[]`.
 *
 * Option A is enforced at the call site (analyzer `gateOne`): the gate's ONLY
 * score effect is `gate.downgraded` (step 4). It never silently flips a YES as a
 * side effect of a per-quote strip.
 *
 * Pure & synchronous. Never mutates its inputs.
 */
export function gateEvidenceWithRepair<Q extends QuoteInput>(
  params: Omit<GateParams, "quotes"> & { quotes: Q[] },
): {
  score: number;
  gate: EvidenceGateResult;
  keptQuotes: Q[];
} {
  const { originalScore, quotes, packText } = params;
  const policy = resolveGatePolicy(params.policyVersion);
  const strictStrip = params.strictStrip !== false;
  const sourceAttribution = params.sourceAttribution !== false;
  const segments = params.documentSegments || [];
  const examples = [
    ...(params.positiveExamples || []),
    ...(params.negativeExamples || []),
  ];
  const researchCriteria = params.researchCriteria || [];

  const failures: GateFailure[] = [];
  const keptQuotes: Q[] = [];
  const repairs: RepairRecord[] = [];
  const researched: ResearchRecord[] = [];
  let quotesValid = 0;

  for (const q of quotes || []) {
    const text = q?.text || "";
    const source = q?.source || "";
    const reasons: GateFailureReason[] = [];
    let authoritative = false;
    let repairedSource: string | null = null;

    const packOk = checkProvenanceWithPolicy(policy, text, packText);

    if (!packOk) {
      // Step 1: genuine provenance failure (not present pack-wide). Not repairable
      // per-quote; the YES may still be rescued by the corpus re-search below.
      reasons.push("provenance");
    } else if (sourceAttribution && segments.length > 0) {
      const seg = resolveDocumentSegmentWithPolicy(policy, source, segments);
      if (seg && checkProvenanceWithPolicy(policy, text, seg.text)) {
        // The source correctly binds to a segment that contains the verbatim text.
        authoritative = true;
      } else {
        // Step 2: attribution REPAIR (not reject). The label bound to the wrong
        // segment (seg != null, text not in it) or to no segment (seg == null).
        // Relabel to the segment that actually contains the verbatim text.
        const repairedSeg = segments.find((sg) =>
          checkProvenanceWithPolicy(policy, text, sg.text),
        );
        if (repairedSeg) {
          repairedSource = repairedSeg.id;
          repairs.push({ quoteText: text, originalSource: source, repairedTo: repairedSeg.id });
          authoritative = true;
        } else {
          // Present pack-wide but in no single segment slice (e.g. the verbatim
          // run straddles a chunk boundary). Provenance already passed pack-wide,
          // which is the anti-hallucination guarantee — accept as a pack-wide pass
          // rather than strip genuine evidence. No relabel is possible.
          authoritative = true;
        }
      }
    } else {
      // Source-attribution off or no segments → pack-wide provenance suffices.
      authoritative = true;
    }

    // Anti-echo (anti-hallucination) still filters individual quotes, with the v2
    // override: exact provenance + authoritative attribution + valid source beats
    // lexical similarity to a rubric example.
    if (!checkAntiEchoWithPolicy(policy, text, examples)) {
      const override = policy === "v2" && packOk && authoritative && checkSource(source);
      if (!override) reasons.push("anti-echo");
    }

    if (!checkSource(source)) reasons.push("source");

    if (reasons.length === 0) {
      quotesValid++;
      keptQuotes.push(repairedSource ? ({ ...q, source: repairedSource } as Q) : q);
    } else {
      failures.push({ quoteText: text, source, reasons });
      if (!strictStrip) keptQuotes.push(q);
    }
  }

  const quotesTotal = (quotes || []).length;

  // Score resolution (Option A: the gate's ONLY score effect is the last-resort
  // downgrade). A NO stays NO. A YES is sustained when >=1 quote is valid.
  let score: number;
  let downgraded = false;
  if (originalScore !== 1) {
    score = 0;
  } else if (quotesValid >= 1) {
    score = 1;
  } else {
    // Step 3: every model quote failed provenance. Re-search the corpus for a
    // verbatim-present supporting passage before considering any downgrade.
    const found = researchBestPassage(policy, researchCriteria, segments, packText);
    if (found) {
      researched.push({
        criteria: researchCriteria.join(" | "),
        repairedSource: found.source,
        repairedQuote: found.text,
      });
      if (strictStrip) {
        // Replace the stripped (unprovenanced) quotes with the repaired one.
        keptQuotes.length = 0;
      }
      keptQuotes.push({ text: found.text, source: found.source } as unknown as Q);
      quotesValid++;
      score = 1;
    } else {
      // Step 4: no supporting passage anywhere in the corpus → last-resort flip.
      score = 0;
      downgraded = true;
    }
  }

  return {
    score,
    gate: {
      quotesTotal,
      quotesValid,
      failures,
      downgraded,
      originalScore,
      policyVersion: policy,
      ...(repairs.length > 0 ? { repairs } : {}),
      ...(researched.length > 0 ? { researched } : {}),
    },
    keptQuotes,
  };
}
