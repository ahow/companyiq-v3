// ─────────────────────────────────────────────────────────────────────────────
// 1.5 — GATE_RATIONALE_SYNC: keep the rationale and the verdict self-consistent
// when a gate or rule overrides the model's verdict.
//
// When a gate downgrades a verdict (e.g. Yes → No), the model's original
// affirmative rationale is left intact and the override reason is only appended to
// evidenceSummary — which the screen path truncates to 600 chars, so on a long
// rationale the "why No" is dropped off-screen and the reader sees affirmative
// prose under a "No". This module (gated by GATE_RATIONALE_SYNC) writes the
// controlling reason into a dedicated, never-truncated field (verdictOverrideReason)
// AND prefixes the rationale with a durable marker so the displayed narrative no
// longer asserts the opposite of the verdict. It NEVER moves a verdict — display
// and consistency only. No company/framework/measure names are referenced.
// ─────────────────────────────────────────────────────────────────────────────

import { gateRationaleSyncEnabled } from "./scoring-fix-flags.js";

/** Strip bracket characters and collapse whitespace so a reason can live inside a
 *  `[OVERRIDE: ...]` marker without breaking the extractor. */
export function sanitizeOverrideReason(reason: string): string {
  return String(reason ?? "")
    .replace(/[\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the durable marker prefixed onto a reconciled rationale. The marker sits
 *  at the START of the text so it survives the 600-char screen slice. */
export function buildOverrideMarker(reason: string): string {
  return `[OVERRIDE: ${sanitizeOverrideReason(reason)}] `;
}

/** Extract the controlling override reason from a rationale/summary that was
 *  reconciled by `recordVerdictOverride`, or null when none is present. */
export function extractVerdictOverrideReason(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^\s*\[OVERRIDE:\s*([\s\S]*?)\]\s*/.exec(String(text));
  const reason = m?.[1]?.trim();
  return reason ? reason : null;
}

/** Shape of the (subset of a) measure result this helper reconciles. */
export interface OverridableResult {
  verdict?: string;
  evidenceSummary?: string | null;
  verdictNuance?: string | null;
  verdictOverrideReason?: string | null;
}

/**
 * Record a gate/rule verdict override on a measure result so the rationale and
 * verdict stay self-consistent.
 *
 * When GATE_RATIONALE_SYNC is OFF this is a NO-OP (returns the result unchanged):
 * the caller keeps its legacy append-to-evidenceSummary behaviour. When ON:
 *   (a) writes the sanitized reason into the dedicated `verdictOverrideReason`
 *       field (surfaced in both screen and CSV, independent of the 600-char slice);
 *   (b) PREFIXES evidenceSummary and verdictNuance with a durable `[OVERRIDE: …]`
 *       marker so the displayed narrative no longer asserts the opposite of the
 *       verdict. The prefix sits at the start so it survives the screen slice.
 * Idempotent: a text already carrying an OVERRIDE marker is not prefixed again.
 * Never moves a verdict.
 */
export function recordVerdictOverride<T extends OverridableResult>(result: T, reason: string): T {
  if (!gateRationaleSyncEnabled()) return result;
  const clean = sanitizeOverrideReason(reason);
  if (!clean) return result;

  result.verdictOverrideReason = clean;
  const marker = buildOverrideMarker(clean);

  if (!extractVerdictOverrideReason(result.evidenceSummary)) {
    result.evidenceSummary = `${marker}${result.evidenceSummary ?? ""}`.trimEnd();
  }
  if (!extractVerdictOverrideReason(result.verdictNuance)) {
    result.verdictNuance = `${marker}${result.verdictNuance ?? ""}`.trimEnd();
  }
  return result;
}
