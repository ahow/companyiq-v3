/**
 * reproducibility.ts — Phase 1 (Reproducibility, Issue 1) framework-level policy
 * helpers: steps 1.3 (arbiter-on-flip), 1.4 (stable/borderline flag), 1.5
 * (discovery source-manifest reuse).
 *
 * WHY (plan §"Phase 1 — Reproducibility"):
 *   Asking the system the same questions twice on the SAME evidence sometimes
 *   gives different answers. This module holds the pure, company/topic-agnostic
 *   decision rules that remove the biggest sources of that wobble inside the
 *   builder so a SINGLE run is reproducible — and flags genuinely borderline
 *   cells rather than hiding them.
 *
 * SCOPE / SAFETY:
 *   - Every export is PURE/total (no I/O, no DB, no model call, never throws on
 *     bad input), so the whole module runs offline in unit tests.
 *   - FRAMEWORK-LEVEL ONLY: nothing here inspects a company name, a topic term,
 *     or any bespoke string — the inputs are generic scores, booleans and URLs.
 *   - VERDICT-SAFE:
 *       · 1.3 changes a verdict ONLY for a DISAGREEING (flip) cell, by delegating
 *         to the EXISTING cascade_v2 arbiter's vote (it does not invent a new
 *         arbiter). An AGREEING cell is returned untouched, so agreeing cells are
 *         byte-identical to the pre-change path.
 *       · 1.4 is PURELY ADDITIVE metadata: it attaches a "stable"/"borderline"
 *         label and NEVER reads or writes the verdict/score.
 *       · 1.5 only ever WIDENS the source set (prior ∪ current). It never prunes a
 *         prior source, so relevant text is never dropped.
 */

// ─── Shared verdict primitives ────────────────────────────────────────────────

/**
 * Binary scoring score, matching the production scorer: 1 = Yes, 0 = No. (Scoring
 * is binary; Partial is not a distinct persisted outcome — see analyzer.ts.) The
 * type is kept to `number` so callers using 0.5 for a legacy Partial still work:
 * disagreement is strict inequality, so any distinct values disagree.
 */
export type VerdictScore = number;

/** Human label for a binary score (diagnostics only; verdict math uses the number). */
export function verdictLabel(score: VerdictScore): "Yes" | "No" | "Partial" {
  if (score === 1) return "Yes";
  if (score === 0) return "No";
  return "Partial";
}

// ─── 1.3 — Arbiter on DISAGREEING (flip) cells only ───────────────────────────
//
// Reuses the EXISTING cascade_v2 arbiter plumbing (analyzer.ts: when settings
// `scoringCascade` + `cascade_v2` are on, the stage-3 arbiter is gpt5-arbiter and
// fires ONLY on primary/secondary disagreement — see analyzer.ts ~2754-2860 and
// the variability harness's reconstruction). This module does NOT create a new
// arbiter; it encodes WHEN the existing one is consulted (disagreement) and how
// the result converges, as a pure, testable policy.

/**
 * True iff the two deciding passes DISAGREE (a flip cell). Two passes with the
 * same score AGREE and must NOT invoke the arbiter. Nullish scores (a failed
 * pass) are treated as "cannot decide agreement" ⇒ no arbiter fire here (the
 * caller handles the error path), so a missing vote never silently flips a cell.
 */
export function passesDisagree(
  primary: VerdictScore | null | undefined,
  secondary: VerdictScore | null | undefined,
): boolean {
  if (primary == null || secondary == null) return false;
  return primary !== secondary;
}

/** Alias that reads naturally at the call site: fire the arbiter only on a flip. */
export function shouldFireArbiter(
  primary: VerdictScore | null | undefined,
  secondary: VerdictScore | null | undefined,
): boolean {
  return passesDisagree(primary, secondary);
}

export interface ArbiterResolution {
  /** Final converged score for the cell. */
  score: VerdictScore;
  verdict: "Yes" | "No" | "Partial";
  /** True iff the arbiter was consulted (i.e. the primaries disagreed). */
  arbiterFired: boolean;
  /** True once the cell has a single decided verdict (always true on success). */
  converged: boolean;
  /** Which deciding pass the arbiter sided with (diagnostics). */
  arbiterSidedWith: "primary" | "secondary" | "neither" | null;
}

/**
 * Resolve a cell using the conditional-cascade rule:
 *   - AGREE (primary === secondary): return that score, arbiter NOT fired,
 *     byte-identical to the pre-change verdict (untouched).
 *   - DISAGREE (flip): consult the EXISTING arbiter's injected vote `arbiterScore`
 *     and converge on it. The arbiter is the cross-model tie-break that is already
 *     built — here we only decide to USE it, for flip cells only.
 *
 * The arbiter vote is INJECTED (not computed here) so the pure policy stays
 * offline-testable and delegates the actual model call to the existing cascade.
 * `arbiterScore` is consulted ONLY when the primaries disagree; on agreement it is
 * ignored entirely (never fetched by a correct caller).
 */
export function resolveFlipWithArbiter(args: {
  primary: VerdictScore | null | undefined;
  secondary: VerdictScore | null | undefined;
  /** The existing cascade_v2 arbiter's vote; consulted only on disagreement. */
  arbiterScore?: VerdictScore | null;
}): ArbiterResolution | null {
  const { primary, secondary } = args;
  if (primary == null || secondary == null) return null; // error path — caller handles

  if (!passesDisagree(primary, secondary)) {
    // AGREE — untouched, arbiter not fired.
    return {
      score: primary,
      verdict: verdictLabel(primary),
      arbiterFired: false,
      converged: true,
      arbiterSidedWith: null,
    };
  }

  // DISAGREE — the flip cell: converge via the existing arbiter.
  const a = args.arbiterScore;
  if (a == null) {
    // Arbiter unavailable on a disagreement: do NOT fabricate a verdict.
    return {
      score: primary,
      verdict: verdictLabel(primary),
      arbiterFired: true,
      converged: false,
      arbiterSidedWith: null,
    };
  }
  const sidedWith = a === primary ? "primary" : a === secondary ? "secondary" : "neither";
  return {
    score: a,
    verdict: verdictLabel(a),
    arbiterFired: true,
    converged: true,
    arbiterSidedWith: sidedWith,
  };
}

// ─── 1.4 — Per-cell stable / borderline flag (additive metadata) ──────────────
//
// Labels each cell "solid" or "genuinely on-the-fence" instead of pretending all
// answers are equally firm. PURELY ADDITIVE: this never touches the verdict or
// score. The borderline set is derivable from the SAME signal step 1.1 measures
// (a cell whose deciding passes disagreed — i.e. the arbiter had to fire — is the
// cell that would flip on a re-run).

export type CellStability = "stable" | "borderline";

/**
 * Classify a cell as "borderline" when its deciding passes DISAGREED (the arbiter
 * had to break a tie) — exactly the cells the 1.1 stability table counts as
 * flips. An agreeing cell is "stable". The input is the same generic disagreement
 * signal used by 1.3, so the borderline set matches 1.1 by construction.
 */
export function classifyCellStability(signal: {
  /** The deciding passes disagreed (arbiter fired / tie-break needed). */
  disagreed: boolean;
}): CellStability {
  return signal.disagreed ? "borderline" : "stable";
}

/** Convenience: derive stability straight from two deciding pass scores. */
export function classifyCellStabilityFromPasses(
  primary: VerdictScore | null | undefined,
  secondary: VerdictScore | null | undefined,
): CellStability {
  return classifyCellStability({ disagreed: passesDisagree(primary, secondary) });
}

/**
 * Attach the stability label to a cell WITHOUT mutating it or touching its
 * verdict/score. Returns a shallow copy with an added `stability` field; the
 * original object is never modified, so the verdict output is byte-identical
 * whether or not this is applied (proven in phase1-reproducibility.test.ts).
 */
export function annotateCellStability<T extends object>(
  cell: T,
  stability: CellStability,
): T & { stability: CellStability } {
  return { ...cell, stability };
}

// ─── 1.5 — Discovery source-manifest reuse (union; never prune) ───────────────
//
// Reduce discovery variance by starting each replay from the prior run's source
// manifest, so run-to-run evidence is the SAME set. This only ever WIDENS /
// stabilises the source set — it NEVER prunes a real source, so relevant text is
// never dropped (standing constraint).

/**
 * Normalise a source identifier for dedupe only (trim; drop a trailing slash).
 * Deliberately conservative — when in doubt we keep BOTH forms rather than risk
 * dropping a distinct source. Empty/whitespace-only ids are ignored.
 */
function normaliseSourceId(id: string): string {
  return (id || "").trim().replace(/\/+$/, "");
}

/**
 * Reuse the prior source manifest on replay: return the UNION of the prior
 * sources and the current run's sources, deduped, with the PRIOR sources first
 * (stable order) followed by any genuinely new current sources. Every prior
 * source is retained — the function can only grow or keep the set, never shrink
 * it — so the evidence set is stabilised run-to-run and no relevant source is
 * ever dropped.
 *
 * Deterministic: identical inputs yield an identical ordered result, so two
 * replays that start from the same prior manifest see the same source set.
 */
export function reuseSourceManifest(
  prior: readonly string[],
  current: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const id = (raw || "").trim();
    if (!id) return;
    const key = normaliseSourceId(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(id);
  };
  // PRIOR first (stable, reused manifest), then any NEW current sources.
  for (const s of prior || []) add(s);
  for (const s of current || []) add(s);
  return out;
}

/**
 * True iff `merged` retains EVERY source present in `prior` (the never-drop
 * invariant). Used by tests and callers to assert that a manifest-reuse step did
 * not prune any relevant source.
 */
export function manifestRetainsAllPrior(
  prior: readonly string[],
  merged: readonly string[],
): boolean {
  const mergedKeys = new Set(merged.map(normaliseSourceId));
  for (const s of prior || []) {
    const id = (s || "").trim();
    if (!id) continue;
    if (!mergedKeys.has(normaliseSourceId(id))) return false;
  }
  return true;
}
