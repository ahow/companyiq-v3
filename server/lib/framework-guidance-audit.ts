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
  | "missing_expected_keys" // parses to an object but has none of yes/no/partial
  // ─── Rubric-tightening (A4) structured-guidance checks ─────────────────────
  // These flag a measure whose (usable) structured guidance is missing one of the
  // per-measure rubric-tightening fields the builder now authors. They are GENERIC:
  // the audit never inspects the CONTENT of a field for a specific topic — only its
  // presence and basic shape.
  | "missing_structured_guidance" // no usable structured object at all (prose-only / absent)
  | "missing_qualifying_instance" // structured object present but no qualifyingInstance
  | "missing_disqualifiers" // structured object present but no disqualifiers[]
  | "missing_anchors" // structured object present but no anchors.{yes,no}
  | "missing_yes_requires_quote"; // structured object present but no yesRequiresQuote rule

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

// ─── Shared tolerant structured-guidance extractor ───────────────────────────
//
// GENERIC. The framework builder may store the per-measure structured guidance
// object in any of three shapes, all of which must be understood identically by
// the scoring-prompt builder AND this audit:
//   (a) a pure JSON object (V1 builder path — scoring_guidance IS the object);
//   (b) a ```json fenced block appended to a prose scoring_guidance (V2 path);
//   (c) a trailing balanced {...} blob appended to prose (defensive fallback).
// Returns the parsed object, or null when none is found. Never throws.

function balancedObjectFrom(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function extractGuidanceObject(raw: string | null | undefined): any | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw : String(raw);
  if (s.trim().length === 0) return null;

  // (a) pure JSON object
  try {
    const parsed = JSON.parse(s);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }

  // (b) ```json fenced block anywhere in the string
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  // (c) first balanced {...} blob embedded in prose
  const braceStart = s.indexOf("{");
  if (braceStart >= 0) {
    const objText = balancedObjectFrom(s, braceStart);
    if (objText) {
      try {
        const parsed = JSON.parse(objText);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

/**
 * Remove an appended structured-guidance block (a ```json fence, or a trailing
 * balanced {...} blob) from a prose scoring_guidance string, so the scorer can
 * render the human-readable prose WITHOUT dumping raw JSON into the prompt. When
 * the string has no such block it is returned trimmed and unchanged. GENERIC.
 */
export function stripStructuredGuidanceBlock(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const s = typeof raw === "string" ? raw : String(raw);
  // Remove any fenced ```json ... ``` blocks first.
  const fenceStripped = s.replace(/```(?:json)?\s*[\s\S]*?```/gi, "");
  if (fenceStripped !== s) return fenceStripped.trim();
  // No fence: if a balanced {...} blob runs to the end of the string, drop it.
  const braceStart = s.indexOf("{");
  if (braceStart >= 0) {
    const objText = balancedObjectFrom(s, braceStart);
    if (objText && s.slice(braceStart + objText.length).trim().length === 0) {
      return s.slice(0, braceStart).trim();
    }
  }
  return s.trim();
}

// The four per-measure rubric-tightening fields the builder now authors inside
// the structured guidance object. Kept here so the audit and any future caller
// share one definition.
function hasQualifyingInstance(o: any): boolean {
  return !!o && typeof o.qualifyingInstance === "string" && o.qualifyingInstance.trim().length > 0;
}
function hasDisqualifiers(o: any): boolean {
  return !!o && Array.isArray(o.disqualifiers) && o.disqualifiers.some((d: any) => typeof d === "string" && d.trim().length > 0);
}
function hasAnchors(o: any): boolean {
  const a = o?.anchors;
  return !!a && typeof a === "object" && typeof a.yes === "string" && a.yes.trim().length > 0 && typeof a.no === "string" && a.no.trim().length > 0;
}
function hasYesRequiresQuote(o: any): boolean {
  return !!o && typeof o.yesRequiresQuote === "string" && o.yesRequiresQuote.trim().length > 0;
}

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
    const measureId = m.measureId;
    const title = m.title || "";

    // Try to obtain a usable structured guidance object the same tolerant way the
    // scoring-prompt builder does (pure JSON, ```json fence, or trailing {...}).
    const structured = extractGuidanceObject(m.scoringGuidance);

    if (!structured) {
      // No usable structured object. Preserve the legacy classification for
      // non-empty-but-unusable guidance (non_json_prose / not_object /
      // missing_expected_keys), AND surface the umbrella rubric-tightening flag
      // that the measure carries none of the structured fields. Empty/null
      // guidance is intentionally NOT flagged as structured-missing here — an
      // unauthored measure is a separate (authoring) concern, and flagging every
      // empty measure would be noise. It is only flagged if it is non-empty but
      // unusable (legacy classification below covers that case).
      const c = classifyGuidance(m.scoringGuidance);
      if (!c.ok && c.issue) {
        findings.push({ measureId, title, issue: c.issue, detail: c.detail || "" });
        findings.push({
          measureId,
          title,
          issue: "missing_structured_guidance",
          detail:
            "scoring_guidance has no usable structured object with the rubric-tightening fields (qualifyingInstance / disqualifiers / anchors / yesRequiresQuote). Re-author or refine this measure through the framework builder.",
        });
      }
      continue;
    }

    // A usable structured object exists — check the four per-measure
    // rubric-tightening fields the builder now authors. One finding per missing
    // field. GENERIC: presence/shape only, never topic-specific content.
    if (!hasQualifyingInstance(structured)) {
      findings.push({
        measureId,
        title,
        issue: "missing_qualifying_instance",
        detail: "structured scoring_guidance is missing a non-empty `qualifyingInstance` (the positive definition of what specifically counts for this measure).",
      });
    }
    if (!hasDisqualifiers(structured)) {
      findings.push({
        measureId,
        title,
        issue: "missing_disqualifiers",
        detail: "structured scoring_guidance is missing a non-empty `disqualifiers` array (generic/aspirational/forward-looking mentions that must NOT score Yes).",
      });
    }
    if (!hasAnchors(structured)) {
      findings.push({
        measureId,
        title,
        issue: "missing_anchors",
        detail: "structured scoring_guidance is missing `anchors` with both a `yes` and a `no` worked example.",
      });
    }
    if (!hasYesRequiresQuote(structured)) {
      findings.push({
        measureId,
        title,
        issue: "missing_yes_requires_quote",
        detail: "structured scoring_guidance is missing a non-empty `yesRequiresQuote` rule line (the Yes-requires-a-verbatim-quote precondition).",
      });
    }
  }
  return findings;
}
