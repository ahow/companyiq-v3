// ─── Framework Completeness Validator (single source of truth) ───────────────
//
// PURPOSE
// A framework must never be finalised (or audited) with silently-empty metadata
// fields that the discovery engine and scorer depend on. This module is the ONE
// generalised, TOPIC-AGNOSTIC validator used by BOTH:
//   • the finalisation path (framework-builder /save)  — Part B
//   • the retroactive audit endpoint (/audit-completeness) — Part D
// so there is a single enumeration of the required-field set and a single fill
// policy. Do NOT fork this logic into either caller.
//
// POLICY (fail-loud but DISMISSIBLE)
// For every required field, IN ORDER:
//   1. If already present & plausible          → status "present".
//   2. Else attempt a DETERMINISTIC derivation (aggregate from the measures)
//      where one exists                         → status "derived".
//   3. Else attempt an LLM-authored fill (the caller injects the LLM client,
//      so unit tests can stub it and never hit a live model)
//                                               → status "llm_filled".
//   4. Else, if the field is explicitly declared justified-empty WITH a reason
//                                               → status "justified_empty".
//   5. Else                                     → status "missing" (recorded
//      with a machine-readable reason).
// Finalisation is NEVER hard-blocked: missing fields are reported and signalled,
// but the framework still saves. The user can proceed (dismiss) or run the audit
// endpoint later to backfill.
//
// PLAUSIBILITY (avoids the Goodhart / non-emptiness trap)
// A non-empty value is not automatically a good value. We additionally flag:
//   • trivial string entries (single char / pure punctuation / whitespace)
//   • documentPriorityUrlPatterns entries that do NOT compile as a valid RegExp
//   • degenerate arrays (duplicates-only, or every entry a single-char token)
// A field whose ONLY content is degenerate/invalid is treated as still-empty so
// the derive→LLM-fill→missing ladder runs on it.

export type LlmComplete = (
  providerName: string,
  opts: { system: string; prompt: string; maxTokens?: number; json?: boolean; temperature?: number; callType?: string },
) => Promise<{ text: string }>;

export type FieldStatus = "present" | "derived" | "llm_filled" | "justified_empty" | "missing";
export type FieldScope = "measure" | "framework";

export interface FieldResult {
  scope: FieldScope;
  /** Present only for scope === "measure". */
  measureId?: string;
  field: string;
  status: FieldStatus;
  /** Machine-readable reason for missing / justified_empty. */
  reason?: string;
  /** The derived / llm_filled value (used by callers to persist the backfill). */
  value?: unknown;
  /** Non-fatal quality warnings (e.g. invalid regex, degenerate duplicates). */
  plausibilityFlags?: string[];
}

export interface CompletenessReport {
  generatedAt: string;
  frameworkId?: number;
  version: 1;
  results: FieldResult[];
  /** Convenience slices (subsets of results). */
  filled: FieldResult[]; // derived + llm_filled — need persisting by caller
  missing: FieldResult[];
  justifiedEmpty: FieldResult[];
  plausibilityWarnings: FieldResult[];
  /** True if ANY required field is still missing after derive + LLM-fill. */
  hasIncompleteness: boolean;
  summary: {
    total: number;
    present: number;
    derived: number;
    llmFilled: number;
    justifiedEmpty: number;
    missing: number;
    plausibilityWarnings: number;
  };
}

export interface FrameworkLike {
  id?: number;
  name?: string;
  topicDescription?: string | null;
  requiredDocTypes?: string[] | null;
  dataPatterns?: string[] | null;
  negativeKeywords?: string[] | null;
  antiInferenceRules?: string[] | null;
  authoritativeRegistries?: string[] | null;
  authoritativeFilingTypes?: unknown[] | null;
  documentPriorityUrlPatterns?: string[] | null;
  [k: string]: unknown;
}

export interface MeasureLike {
  measureId?: string;
  title?: string;
  definition?: string | null;
  /** Stored as a JSON string in the DB; may also be an object in-memory. */
  scoringGuidance?: string | Record<string, unknown> | null;
  evidenceKeywords?: string[] | null;
  requiredSourceTypes?: string[] | null;
  substantiveDefinition?: string | null;
  fallbackYesCriterion?: string | null;
  [k: string]: unknown;
}

export interface RunCompletenessInput {
  framework: FrameworkLike;
  measures: MeasureLike[];
  /** Injected LLM client (e.g. completeWithFallback). Omit to skip LLM fills. */
  llmComplete?: LlmComplete;
  /**
   * Explicit justified-empty declarations. Key is a framework field name
   * (e.g. "authoritativeRegistries") or "measureId:field" for a measure field.
   * Value is the human/machine reason the emptiness is intentional.
   */
  justifiedEmpty?: Record<string, string>;
}

export interface RunCompletenessResult {
  report: CompletenessReport;
  /** Framework-level fills to apply via the standard updateFramework path. */
  frameworkUpdates: Record<string, unknown>;
  /** Per-measure fills: measureId -> { field: value }. */
  measureUpdates: Record<string, Record<string, unknown>>;
}

// ─── Plausibility helpers ────────────────────────────────────────────────────

/** A non-trivial string: has real content beyond a single char / punctuation. */
export function isNonTrivialString(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 2) return false;
  // reject pure punctuation / symbol tokens
  if (!/[a-z0-9]/i.test(t)) return false;
  return true;
}

/** Does a string compile as a valid JS RegExp? */
export function compilesAsRegex(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect a string[] for plausibility. Returns the plausible (kept) entries and
 * any flags describing what was dropped/degenerate. `regexMustCompile` enforces
 * that every entry compiles as a RegExp (used for documentPriorityUrlPatterns).
 */
export function inspectStringArray(
  arr: unknown,
  opts: { regexMustCompile?: boolean } = {},
): { plausible: string[]; flags: string[] } {
  const flags: string[] = [];
  if (!Array.isArray(arr)) return { plausible: [], flags };
  const raw = arr.map((x) => (typeof x === "string" ? x : String(x ?? "")));
  const nonTrivial: string[] = [];
  for (const s of raw) {
    if (!isNonTrivialString(s)) {
      flags.push(`trivial_entry:${JSON.stringify(s).slice(0, 40)}`);
      continue;
    }
    if (opts.regexMustCompile && !compilesAsRegex(s)) {
      flags.push(`invalid_regex:${JSON.stringify(s).slice(0, 60)}`);
      continue;
    }
    nonTrivial.push(s.trim());
  }
  // Degenerate: duplicates-only collapse
  const deduped = Array.from(new Set(nonTrivial.map((s) => s.toLowerCase())));
  if (nonTrivial.length > 0 && deduped.length < nonTrivial.length) {
    flags.push(`degenerate_duplicates:${nonTrivial.length - deduped.length}`);
  }
  // Degenerate: every entry a single short token (<=1 char after trim already
  // excluded by isNonTrivialString, but catch all-2-char noise arrays)
  if (nonTrivial.length > 0 && nonTrivial.every((s) => s.trim().length <= 2)) {
    flags.push("degenerate_all_short_tokens");
  }
  // preserve original order while de-duplicating case-insensitively
  const seen = new Set<string>();
  const plausible: string[] = [];
  for (const s of nonTrivial) {
    const lk = s.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    plausible.push(s);
  }
  return { plausible, flags };
}

// ─── Deterministic derivations (shared with framework-builder B8 block) ──────
// Exported so the /save path uses the SAME logic rather than a divergent copy.

/** Aggregate requiredDocTypes from every measure's requiredSourceTypes. */
export function deriveRequiredDocTypes(measures: MeasureLike[]): string[] {
  const types = new Set<string>();
  for (const m of measures) {
    for (const t of m.requiredSourceTypes || []) {
      if (isNonTrivialString(t)) types.add(String(t).trim());
    }
  }
  return Array.from(types);
}

/** Derive dataPatterns from every measure's evidenceKeywords. */
export function deriveDataPatterns(measures: MeasureLike[], limit = 15): string[] {
  const patterns = new Set<string>();
  for (const m of measures) {
    for (const kw of m.evidenceKeywords || []) {
      const t = String(kw || "").toLowerCase().trim();
      if (t.length >= 4) patterns.add(t.replace(/\s+/g, ".?"));
    }
  }
  return Array.from(patterns).slice(0, limit);
}

// ─── scoringGuidance parsing ─────────────────────────────────────────────────

function parseScoringGuidance(sg: MeasureLike["scoringGuidance"]): Record<string, unknown> {
  if (!sg) return {};
  if (typeof sg === "object") return sg as Record<string, unknown>;
  try {
    const parsed = JSON.parse(sg);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.some((x) => (typeof x === "string" ? x.trim().length > 0 : x != null));
}

// ─── LLM fill ────────────────────────────────────────────────────────────────
// Topic-agnostic: the prompt describes the field's PURPOSE generically and hands
// the model the framework's own definition/measures as context, so the fill is
// derived from THIS framework — never a hard-coded topic template.

interface FieldSpec {
  field: string;
  scope: FieldScope;
  /** "array" | "string" | "object-array" */
  kind: "string-array" | "string" | "object-array";
  /** May this field be legitimately empty (with a justification)? */
  justifiableEmpty: boolean;
  /** Documentation string handed to the LLM to author the fill. */
  purpose: string;
  /** Deterministic derivation, if one exists. */
  derive?: (measures: MeasureLike[]) => string[];
  /** For string-array fields, enforce regex compilation on entries. */
  regexEntries?: boolean;
}

const FRAMEWORK_FIELD_SPECS: FieldSpec[] = [
  {
    field: "requiredDocTypes",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: false,
    derive: deriveRequiredDocTypes,
    purpose:
      "The specific published DOCUMENT TYPES that, for this framework's topic, contain the evidence (e.g. 'Sustainability Report', 'Proxy Statement', 'Modern Slavery Statement'). The discovery engine searches for these by name. 4-10 entries.",
  },
  {
    field: "dataPatterns",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: false,
    derive: (m) => deriveDataPatterns(m),
    regexEntries: true,
    purpose:
      "5-10 regex fragments that prove the topic's actual DATA is present in a document's text (specific figures, standard names, target phrasings for THIS topic). Each entry MUST be a valid regular expression fragment.",
  },
  {
    field: "negativeKeywords",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: true,
    purpose:
      "Terms that, when a candidate document is dominated by them, indicate the document is OFF-topic for this framework (used to down-rank false-positive corpora). May be empty only if the topic has no meaningful off-topic confusors.",
  },
  {
    field: "antiInferenceRules",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: false,
    purpose:
      "3-6 topic-specific 'DO NOT' rules (Layer-3 residue only) that block topic-specific false-positive inference patterns at scoring time. Each rule starts with 'DO NOT' and names a specific topic-specific false-positive pattern. Do NOT restate universal/family rules.",
  },
  {
    field: "authoritativeRegistries",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: true,
    purpose:
      "4-15 domain strings for statutory or thematic registries that directly list disclosures for this topic (e.g. 'modernslaveryregister.gov.au', 'sciencebasedtargets.org'). Empty is acceptable ONLY when no such registry exists for the topic — in which case a justification is required.",
  },
  {
    field: "documentPriorityUrlPatterns",
    scope: "framework",
    kind: "string-array",
    justifiableEmpty: true,
    regexEntries: true,
    purpose:
      "URL-substring / regex patterns that identify this topic's highest-value DEDICATED disclosures (e.g. 'biodivers', 'tcfd', '/csr', 'tax-transparency'), promoting them into the top tier of PDF-candidate recovery. Each entry MUST be a valid regex fragment. Empty is acceptable only if the topic has no dedicated-disclosure URL signature.",
  },
];

// Per-measure required fields.
interface MeasureFieldSpec {
  field: string;
  kind: "string" | "string-array";
  justifiableEmpty: boolean;
  purpose: string;
}

const MEASURE_FIELD_SPECS: MeasureFieldSpec[] = [
  {
    field: "substantiveDefinition",
    kind: "string",
    justifiableEmpty: false,
    purpose:
      "A precise, self-contained restatement of what this measure assesses, describing observable evidence in public documents and explicit boundary conditions (what counts and what does NOT).",
  },
  {
    field: "fallbackYesCriterion",
    kind: "string",
    justifiableEmpty: false,
    purpose:
      "The minimum bar that still justifies a YES for this measure when the strongest evidence form is absent — a single, explicit fallback condition (never a generic template).",
  },
  {
    field: "evidenceKeywords",
    kind: "string-array",
    justifiableEmpty: false,
    purpose:
      "10-15 highly specific keywords/phrases for this measure (technical terms, acronyms, metric names, common disclosure phrasings).",
  },
  {
    field: "requiredSourceTypes",
    kind: "string-array",
    justifiableEmpty: false,
    purpose:
      "The document/source TYPES required to answer this measure (topic-agnostic source categories, e.g. 'regulatory-filing', 'proxy', 'annual-report', 'standalone-policy'). Derived from this measure's own evidence requirement.",
  },
];

// scoringGuidance sub-fields that must be present & non-empty per measure.
const SCORING_GUIDANCE_REQUIRED: Array<{ path: string; kind: "string" | "string-array" }> = [
  { path: "qualifyingInstance", kind: "string" },
  { path: "disqualifiers", kind: "string-array" },
  { path: "anchors.yes", kind: "string" },
  { path: "anchors.no", kind: "string" },
  { path: "yesRequiresQuote", kind: "string" },
];

function summariseMeasures(measures: MeasureLike[]): string {
  return measures
    .slice(0, 40)
    .map((m) => `- ${m.measureId || "?"}: ${m.title || ""} — ${String(m.definition || "").slice(0, 160)}`)
    .join("\n");
}

async function llmFillField(
  llmComplete: LlmComplete,
  framework: FrameworkLike,
  measures: MeasureLike[],
  spec: { field: string; kind: "string" | "string-array" | "object-array"; purpose: string; regexEntries?: boolean },
  measureContext?: MeasureLike,
): Promise<{ value: unknown; flags: string[] } | null> {
  const wantArray = spec.kind === "string-array" || spec.kind === "object-array";
  const context = measureContext
    ? `MEASURE:\n- id: ${measureContext.measureId}\n- title: ${measureContext.title}\n- definition: ${measureContext.definition || ""}`
    : `FRAMEWORK: ${framework.name || ""}\nTOPIC DESCRIPTION:\n${String(framework.topicDescription || "").slice(0, 1500)}\n\nMEASURES:\n${summariseMeasures(measures)}`;

  const system =
    "You author a single missing metadata field for an existing corporate-disclosure assessment framework. " +
    "You are TOPIC-AGNOSTIC: derive the value ONLY from the framework/measure context provided — never from a generic template. " +
    "Return STRICT JSON only, no prose.";
  const shape = wantArray
    ? `{"value": [ ...${spec.regexEntries ? "valid regex fragment strings" : "strings"}... ]}`
    : `{"value": "..."}`;
  const prompt =
    `${context}\n\n` +
    `FIELD TO AUTHOR: "${spec.field}"\n` +
    `PURPOSE: ${spec.purpose}\n\n` +
    `If — and only if — this field genuinely does not apply to this framework/measure, return {"value": ${wantArray ? "[]" : '""'}, "justification": "<why it is legitimately empty>"}.\n` +
    `Otherwise return ${shape}. JSON only.`;

  let text = "";
  try {
    const res = await llmComplete("gemini", { system, prompt, maxTokens: 2048, json: true, callType: "framework-completeness-fill" });
    text = res?.text || "";
  } catch {
    return null;
  }
  let parsed: any = null;
  const m = text.match(/```json\s*([\s\S]*?)```/);
  const rawJson = m ? m[1].trim() : text.trim();
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("value" in parsed)) return null;

  if (wantArray) {
    const insp = inspectStringArray(parsed.value, { regexMustCompile: !!spec.regexEntries });
    if (insp.plausible.length === 0) return { value: [], flags: insp.flags };
    return { value: insp.plausible, flags: insp.flags };
  }
  const v = parsed.value;
  if (!nonEmptyString(v)) return { value: "", flags: [] };
  return { value: String(v).trim(), flags: [] };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runCompletenessValidator(input: RunCompletenessInput): Promise<RunCompletenessResult> {
  const { framework, measures, llmComplete, justifiedEmpty = {} } = input;
  const results: FieldResult[] = [];
  const frameworkUpdates: Record<string, unknown> = {};
  const measureUpdates: Record<string, Record<string, unknown>> = {};

  const addMeasureUpdate = (measureId: string, field: string, value: unknown) => {
    if (!measureUpdates[measureId]) measureUpdates[measureId] = {};
    measureUpdates[measureId][field] = value;
  };

  // ── Framework-level fields ──
  for (const spec of FRAMEWORK_FIELD_SPECS) {
    const current = framework[spec.field];
    const insp = inspectStringArray(current, { regexMustCompile: !!spec.regexEntries });
    const plausibilityFlags = insp.flags.length > 0 ? insp.flags : undefined;

    if (insp.plausible.length > 0) {
      results.push({ scope: "framework", field: spec.field, status: "present", value: insp.plausible, plausibilityFlags });
      // If plausibility dropped some entries, persist the cleaned value.
      if (Array.isArray(current) && insp.plausible.length !== (current as unknown[]).length) {
        frameworkUpdates[spec.field] = insp.plausible;
      }
      continue;
    }

    // (2) deterministic derivation
    if (spec.derive) {
      const derived = spec.derive(measures);
      const dInsp = inspectStringArray(derived, { regexMustCompile: !!spec.regexEntries });
      if (dInsp.plausible.length > 0) {
        frameworkUpdates[spec.field] = dInsp.plausible;
        results.push({ scope: "framework", field: spec.field, status: "derived", value: dInsp.plausible, plausibilityFlags: dInsp.flags.length ? dInsp.flags : undefined });
        continue;
      }
    }

    // (3) LLM-authored fill
    if (llmComplete) {
      const filled = await llmFillField(llmComplete, framework, measures, spec, undefined);
      if (filled && Array.isArray(filled.value) && filled.value.length > 0) {
        frameworkUpdates[spec.field] = filled.value;
        results.push({ scope: "framework", field: spec.field, status: "llm_filled", value: filled.value, plausibilityFlags: filled.flags.length ? filled.flags : undefined });
        continue;
      }
    }

    // (4) justified-empty
    const jreason = justifiedEmpty[spec.field];
    if (spec.justifiableEmpty && jreason) {
      results.push({ scope: "framework", field: spec.field, status: "justified_empty", reason: jreason });
      continue;
    }

    // (5) missing
    results.push({
      scope: "framework",
      field: spec.field,
      status: "missing",
      reason: llmComplete ? "empty after deterministic derivation and LLM fill" : "empty and no LLM client available to author a fill",
    });
  }

  // ── Per-measure fields ──
  for (const m of measures) {
    const mid = m.measureId || "(unknown)";

    for (const spec of MEASURE_FIELD_SPECS) {
      const key = `${mid}:${spec.field}`;
      const current = m[spec.field as keyof MeasureLike];
      const present = spec.kind === "string-array" ? nonEmptyArray(current) : nonEmptyString(current);
      if (present) {
        results.push({ scope: "measure", measureId: mid, field: spec.field, status: "present" });
        continue;
      }
      if (llmComplete) {
        const filled = await llmFillField(
          llmComplete,
          framework,
          measures,
          { field: spec.field, kind: spec.kind, purpose: spec.purpose },
          m,
        );
        const ok = filled && (spec.kind === "string-array" ? Array.isArray(filled.value) && filled.value.length > 0 : nonEmptyString(filled.value));
        if (ok) {
          addMeasureUpdate(mid, spec.field, filled!.value);
          results.push({ scope: "measure", measureId: mid, field: spec.field, status: "llm_filled", value: filled!.value });
          continue;
        }
      }
      const jreason = justifiedEmpty[key];
      if (spec.justifiableEmpty && jreason) {
        results.push({ scope: "measure", measureId: mid, field: spec.field, status: "justified_empty", reason: jreason });
        continue;
      }
      results.push({
        scope: "measure",
        measureId: mid,
        field: spec.field,
        status: "missing",
        reason: llmComplete ? "empty after LLM fill" : "empty and no LLM client available to author a fill",
      });
    }

    // scoringGuidance sub-fields
    const sg = parseScoringGuidance(m.scoringGuidance);
    for (const sub of SCORING_GUIDANCE_REQUIRED) {
      const val = sub.path.includes(".")
        ? (sg[sub.path.split(".")[0]] as Record<string, unknown> | undefined)?.[sub.path.split(".")[1]]
        : sg[sub.path];
      const present = sub.kind === "string-array" ? nonEmptyArray(val) : nonEmptyString(val);
      const field = `scoringGuidance.${sub.path}`;
      if (present) {
        results.push({ scope: "measure", measureId: mid, field, status: "present" });
        continue;
      }
      // scoringGuidance sub-fields are not independently LLM-filled here (they
      // must be authored coherently with the rest of the guidance object at
      // generation time — Part A). Record as missing so it is surfaced loudly.
      const jreason = justifiedEmpty[`${mid}:${field}`];
      results.push({
        scope: "measure",
        measureId: mid,
        field,
        status: jreason ? "justified_empty" : "missing",
        reason: jreason || "scoringGuidance sub-field empty — must be authored at generation time (Part A)",
      });
    }
  }

  const filled = results.filter((r) => r.status === "derived" || r.status === "llm_filled");
  const missing = results.filter((r) => r.status === "missing");
  const justifiedEmptyResults = results.filter((r) => r.status === "justified_empty");
  const plausibilityWarnings = results.filter((r) => r.plausibilityFlags && r.plausibilityFlags.length > 0);

  const report: CompletenessReport = {
    generatedAt: new Date().toISOString(),
    frameworkId: framework.id,
    version: 1,
    results,
    filled,
    missing,
    justifiedEmpty: justifiedEmptyResults,
    plausibilityWarnings,
    hasIncompleteness: missing.length > 0,
    summary: {
      total: results.length,
      present: results.filter((r) => r.status === "present").length,
      derived: results.filter((r) => r.status === "derived").length,
      llmFilled: results.filter((r) => r.status === "llm_filled").length,
      justifiedEmpty: justifiedEmptyResults.length,
      missing: missing.length,
      plausibilityWarnings: plausibilityWarnings.length,
    },
  };

  return { report, frameworkUpdates, measureUpdates };
}
