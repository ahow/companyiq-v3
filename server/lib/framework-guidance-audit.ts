// ─── Framework scoring_guidance Audit ───────────────────────────────────────
//
// GENERIC, framework-agnostic audit. Given a framework's measures, it flags those
// whose `scoring_guidance` is non-empty but is NOT a usable structured JSON object
// (either it fails to parse as JSON, or it parses to something other than an object
// with the expected yes/no/partial buckets).
//
// Motivation: the scoring-prompt builders expect `scoring_guidance` to be a JSON
// object with yes/no/partial keys. When a framework stores it as PLAIN PROSE the
// JSON.parse fails; the builders now (Change B) render such prose under a neutral
// heading instead of mis-bucketing it under "- Yes:". This audit SURFACES those
// measures for review — it NEVER rewrites or auto-converts the content.

export type GuidanceAuditIssue =
  | "non_json_prose" // non-empty but not parseable as JSON
  | "not_object" // parses as JSON but not to an object (e.g. a bare string/number/array)
  | "missing_expected_keys"; // parses to an object but has none of yes/no/partial

export interface GuidanceAuditFinding {
  measureId: string;
  title: string;
  issue: GuidanceAuditIssue;
  detail: string;
}

interface AuditableMeasure {
  measureId: string;
  title?: string | null;
  scoringGuidance?: string | null;
}

const EXPECTED_KEYS = ["yes", "no", "partial"];

/**
 * Attempt to interpret a measure's scoring_guidance the same way the prompt
 * builders do. Returns a classification the caller can act on.
 */
export function classifyGuidance(scoringGuidance: string | null | undefined): {
  ok: boolean;
  issue?: GuidanceAuditIssue;
  detail?: string;
} {
  // Empty / null guidance is not a defect — the builders simply omit the block.
  if (scoringGuidance === null || scoringGuidance === undefined) return { ok: true };
  const raw = typeof scoringGuidance === "string" ? scoringGuidance : String(scoringGuidance);
  if (raw.trim().length === 0) return { ok: true };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      issue: "non_json_prose",
      detail: "scoring_guidance is non-empty but is not valid JSON (stored as plain prose).",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      issue: "not_object",
      detail: `scoring_guidance parses as JSON but is a ${Array.isArray(parsed) ? "array" : typeof parsed}, not an object with yes/no/partial buckets.`,
    };
  }

  const hasExpected = EXPECTED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(parsed, k));
  if (!hasExpected) {
    const keys = Object.keys(parsed);
    return {
      ok: false,
      issue: "missing_expected_keys",
      detail: `scoring_guidance is a JSON object but has none of the expected keys (${EXPECTED_KEYS.join("/")}); found: ${keys.length > 0 ? keys.join(", ") : "no keys"}.`,
    };
  }

  return { ok: true };
}

/**
 * Audit a framework's measures. Returns one finding per measure whose
 * scoring_guidance is non-empty but not a usable structured JSON object.
 * Pure function — no DB access, no mutation.
 */
export function auditFrameworkGuidance(measures: AuditableMeasure[]): GuidanceAuditFinding[] {
  const findings: GuidanceAuditFinding[] = [];
  for (const m of measures || []) {
    const c = classifyGuidance(m.scoringGuidance);
    if (!c.ok && c.issue) {
      findings.push({
        measureId: m.measureId,
        title: m.title || "",
        issue: c.issue,
        detail: c.detail || "",
      });
    }
  }
  return findings;
}
