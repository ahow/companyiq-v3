// ─────────────────────────────────────────────────────────────────────────────
// WS4 — VERDICT_STABILITY: verdict boundary stability (default OFF, fail-open).
//
// Problem: scoring is strictly BINARY — each measure cell is verdict "Yes"
// (score 1) or "No" (score 0); there is NO Partial and NO 0.5. Across replays on
// an IDENTICAL frozen corpus the LLM first-pass verdict for borderline-evidence
// cells is non-deterministic (Yes in one replay, No in another). This "flip" is
// concentrated in the operational_resilience track. The fix is a deterministic
// majority-of-k re-adjudication that resolves residual borderline jitter.
//
// Design (all decision logic is PURE and unit-testable WITHOUT the LLM — the
// analyzer wiring supplies the k sampled verdicts by calling the model k times):
//   • Eligibility (GENERALISED, per-measure-k driven, hysteresis): a cell is
//     eligible iff it is "borderline" (confidence Low/Medium below the threshold
//     OR needsReadjudication === true) AND stabilisation is switched on for its
//     measure. "Switched on" is decided per-measure: when the measure carries a
//     CALIBRATED k (verdict_stability_k, written by test-drive calibration from
//     its empirical flip-proneness) that value is AUTHORITATIVE — eligible iff
//     k > 1 (a stored k=1 opts the measure OUT). Only when the measure is
//     UNCALIBRATED (null k) do we fall back to the legacy flip-prone TRACK set
//     (default ["operational_resilience"], env-overridable). So eligibility now
//     generalises to ANY framework/topic once calibrated, with the track set
//     retained solely as the uncalibrated back-compat fallback. Non-borderline
//     or opted-out cells are LOCKED: verdict/score untouched (hysteresis).
//   • k (GENERALISED): effectiveVerdictStabilityK(measure) uses the calibrated
//     per-measure k when present, else the global default verdictStabilityK().
//   • Resolution for eligible cells: take the strict majority of the k samples.
//     Threshold = floor(n/2) + 1 over the n VALID (Yes/No) samples. A tie (no
//     side reaches the threshold) KEEPS the first-pass verdict — never flip on a
//     tie. Score is kept consistent with the resolved verdict (Yes→1, No→0).
//   • Fail-open: flag off / no track token / unknown track / null confidence
//     while not needsReadjudication / no samples → not eligible → unchanged; any
//     error in the k-pass is handled by the caller (keep first pass, log warn).
//
// No company/framework/measure names are referenced anywhere in this module.
// ─────────────────────────────────────────────────────────────────────────────

import {
  parseMeasureTrack,
  flipProneTracks,
  verdictStabilityBorderlineConfidence,
  confidenceToNumber,
  perMeasureVerdictStabilityK,
  verdictStabilityK,
} from "./scoring-fix-flags.js";

/** Canonical binary verdicts. */
export type BinaryVerdict = "Yes" | "No";

/** Auditable record of a single verdict-stability decision (mirrors the
 *  ReadjudicationTrace pattern). Attached only when the pass acted on the row. */
export interface VerdictStabilityTrace {
  /** The first-pass verdict before stabilisation. */
  originalVerdict: string;
  /** The first-pass score before stabilisation. */
  originalScore: number;
  /** The measure's parsed track (lowercased), or null. */
  track: string | null;
  /** Number of re-adjudication samples requested (k). */
  k: number;
  /** The k sampled verdicts, normalised to "Yes"/"No"/raw. */
  sampledVerdicts: string[];
  yesVotes: number;
  noVotes: number;
  /** The verdict the pass settled on (may equal the original on a tie/confirm). */
  resolvedVerdict: string;
  resolution:
    | "majority-flip"
    | "majority-confirm"
    | "tie-keep-first"
    | "locked"
    | "skipped";
  /** Human-readable reason for the outcome. */
  reason: string;
}

/** The (subset of a) measure result the pass reads and may mutate. */
export interface StabilisableResult {
  verdict?: string;
  score?: number;
  confidence?: string | null;
  needsReadjudication?: boolean;
  verdictNuance?: string | null;
  verdictStabilityTrace?: VerdictStabilityTrace | null;
}

/** Normalise a raw verdict string to "Yes"/"No"/null. Case-insensitive; treats
 *  "not met"/"not-met" as No. Anything else (Partial, Insufficient evidence,
 *  Scoring error, empty) → null (not a valid binary vote). */
export function normalizeBinaryVerdict(v: string | null | undefined): BinaryVerdict | null {
  const c = (v || "").trim().toLowerCase();
  if (c === "yes") return "Yes";
  if (c === "no" || c === "not met" || c === "not-met") return "No";
  return null;
}

/** PURE: is this measure's track in the flip-prone set? Null track (no TRACK
 *  token) or a track outside the set → false (locked, fail-open). */
export function isFlipProneTrack(measure: any, tracks: string[] = flipProneTracks()): boolean {
  const track = parseMeasureTrack(measure);
  if (!track) return false;
  if (!Array.isArray(tracks) || tracks.length === 0) return false;
  return tracks.includes(track.toLowerCase());
}

/** PURE: is this first-pass cell "borderline"? True when confidence maps strictly
 *  below the borderline threshold (Low/Medium) OR needsReadjudication === true.
 *  Null/unknown confidence maps to 1.0 (high) so, absent an explicit
 *  needsReadjudication, it is NOT borderline. */
export function isBorderlineCell(
  result: StabilisableResult,
  borderlineConfidence: number = verdictStabilityBorderlineConfidence(),
): boolean {
  if (result?.needsReadjudication === true) return true;
  return confidenceToNumber(result?.confidence) < borderlineConfidence;
}

/** PURE: a cell is eligible for stabilisation. GENERALISED (per-measure-k driven):
 *   1. A cell must first be BORDERLINE — otherwise it is LOCKED (hysteresis),
 *      regardless of any calibrated k.
 *   2. If the measure carries a CALIBRATED per-measure k (not null), that value
 *      is AUTHORITATIVE: eligible iff k > 1 (a stored k=1 means the measure was
 *      empirically stable and opted OUT of stabilisation). No track involved.
 *   3. Otherwise (UNCALIBRATED / null k) fall back to the legacy track gate
 *      (flip-prone track set) for backward compatibility.
 *  This makes eligibility work for ANY framework/topic once calibrated, while
 *  preserving today's behaviour for measures that have not yet been calibrated. */
export function isStabilityEligible(
  measure: any,
  result: StabilisableResult,
  opts?: { tracks?: string[]; borderlineConfidence?: number },
): boolean {
  if (!isBorderlineCell(result, opts?.borderlineConfidence)) return false;
  const pmK = perMeasureVerdictStabilityK(measure);
  if (typeof pmK === "number") {
    // Calibrated: the per-measure k is authoritative. k=1 → locked.
    return pmK > 1;
  }
  // Uncalibrated: back-compat track gate.
  return isFlipProneTrack(measure, opts?.tracks);
}

/** GENERALISED: resolve the effective majority-vote k for a measure. When the
 *  measure carries a calibrated per-measure k it is authoritative (floored at 1);
 *  otherwise fall back to the global default verdictStabilityK(). Topic-agnostic. */
export function effectiveVerdictStabilityK(measure: any): number {
  const pmK = perMeasureVerdictStabilityK(measure);
  if (typeof pmK === "number") return pmK >= 1 ? pmK : 1;
  return verdictStabilityK();
}

/** Outcome of the pure majority resolution. */
export interface MajorityResolution {
  resolvedVerdict: BinaryVerdict;
  yesVotes: number;
  noVotes: number;
  /** True when the resolved verdict differs from the first-pass verdict. */
  flipped: boolean;
  resolution: "majority-flip" | "majority-confirm" | "tie-keep-first";
}

/** PURE core: resolve a binary verdict by strict majority of the sampled
 *  verdicts, falling back to the first-pass verdict on a tie.
 *
 *  Threshold = floor(n/2) + 1 over the n VALID (Yes/No) samples. If Yes reaches
 *  the threshold → "Yes"; else if No reaches it → "No"; otherwise (no strict
 *  majority, i.e. a tie or no valid samples) KEEP the first-pass verdict — never
 *  flip on a tie. Non-binary samples (Partial/error/empty) are ignored in the
 *  count. This function NEVER calls the LLM; the caller injects the samples. */
export function resolveByMajority(
  sampledVerdicts: Array<string | null | undefined>,
  firstPassVerdict: string | null | undefined,
): MajorityResolution {
  const firstPass = normalizeBinaryVerdict(firstPassVerdict) ?? "No";
  let yesVotes = 0;
  let noVotes = 0;
  for (const s of sampledVerdicts) {
    const v = normalizeBinaryVerdict(s);
    if (v === "Yes") yesVotes += 1;
    else if (v === "No") noVotes += 1;
  }
  const n = yesVotes + noVotes;
  const threshold = Math.floor(n / 2) + 1;

  let resolvedVerdict: BinaryVerdict;
  let resolution: MajorityResolution["resolution"];
  if (n > 0 && yesVotes >= threshold) {
    resolvedVerdict = "Yes";
    resolution = resolvedVerdict === firstPass ? "majority-confirm" : "majority-flip";
  } else if (n > 0 && noVotes >= threshold) {
    resolvedVerdict = "No";
    resolution = resolvedVerdict === firstPass ? "majority-confirm" : "majority-flip";
  } else {
    // Tie (or no valid samples): keep the first-pass verdict, never flip.
    resolvedVerdict = firstPass;
    resolution = "tie-keep-first";
  }

  return {
    resolvedVerdict,
    yesVotes,
    noVotes,
    flipped: resolvedVerdict !== firstPass,
    resolution,
  };
}

export interface StabiliseParams<T extends StabilisableResult> {
  measure: any;
  result: T;
  /** The k sampled verdicts produced by re-running the scorer on the SAME frozen
   *  evidence (injected by the analyzer wiring; empty in a failed k-pass). */
  sampledVerdicts: Array<string | null | undefined>;
  /** k used (for the trace); defaults to sampledVerdicts.length. */
  k?: number;
  /** Eligibility overrides (tests / env). */
  tracks?: string[];
  borderlineConfidence?: number;
}

/**
 * Resolve verdict-boundary stability for a single measure result.
 *
 * Idempotent and PURE except for mutating the passed result (and only when the
 * verdict actually changes). When the cell is NOT eligible (locked by
 * hysteresis), or already carries a trace, or the samples do not form a strict
 * majority that differs from the first pass, the verdict/score are left
 * byte-for-byte unchanged. Deterministic given the injected samples; never
 * throws.
 */
export function stabiliseVerdict<T extends StabilisableResult>(params: StabiliseParams<T>): T {
  const { measure, result, sampledVerdicts } = params;
  if (!result) return result;
  // Idempotency: a row already stabilised this run is not touched again.
  if (result.verdictStabilityTrace) return result;

  const track = parseMeasureTrack(measure);
  const k = typeof params.k === "number" ? params.k : sampledVerdicts.length;
  const originalVerdict = String(result.verdict ?? "");
  const originalScore = typeof result.score === "number" ? result.score : 0;

  // Hysteresis: non-eligible cells are LOCKED — never moved, no trace written
  // (so the result stays byte-for-byte identical to first pass).
  if (
    !isStabilityEligible(measure, result, {
      tracks: params.tracks,
      borderlineConfidence: params.borderlineConfidence,
    })
  ) {
    return result;
  }

  const normalizedSamples = sampledVerdicts.map((s) => normalizeBinaryVerdict(s) ?? String(s ?? ""));
  const maj = resolveByMajority(sampledVerdicts, originalVerdict);

  const trace: VerdictStabilityTrace = {
    originalVerdict,
    originalScore,
    track,
    k,
    sampledVerdicts: normalizedSamples,
    yesVotes: maj.yesVotes,
    noVotes: maj.noVotes,
    resolvedVerdict: maj.resolvedVerdict,
    resolution: maj.resolution,
    reason:
      maj.resolution === "tie-keep-first"
        ? `no strict majority over ${maj.yesVotes + maj.noVotes} valid sample(s) (Yes ${maj.yesVotes}/No ${maj.noVotes}) → kept first-pass ${originalVerdict || "No"}`
        : `majority ${maj.yesVotes >= maj.noVotes ? maj.yesVotes : maj.noVotes}/${maj.yesVotes + maj.noVotes} (Yes ${maj.yesVotes}/No ${maj.noVotes}) → ${maj.resolvedVerdict}`,
  };
  result.verdictStabilityTrace = trace;

  if (maj.flipped) {
    const prevVerdict = originalVerdict || "No";
    result.verdict = maj.resolvedVerdict;
    result.score = maj.resolvedVerdict === "Yes" ? 1 : 0;
    const note = `[Verdict-stability: ${track ?? "flip-prone"} borderline cell resolved by majority ${
      maj.resolvedVerdict === "Yes" ? maj.yesVotes : maj.noVotes
    }/${maj.yesVotes + maj.noVotes} → ${maj.resolvedVerdict} (was ${prevVerdict})]`;
    result.verdictNuance = (result.verdictNuance || "") + (result.verdictNuance ? " " : "") + note;
  }

  return result;
}
