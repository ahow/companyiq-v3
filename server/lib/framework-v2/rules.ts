/**
 * Framework Creation v2 — Construction Rules C1–C10
 *
 * Each rule is a build-time enforcement of a property that prevents a specific
 * failure mode identified in Sprint 9 FP/FN diagnostics.
 *
 * Rules are pure functions returning { passed, violations }. They do not
 * mutate the framework; the caller decides how to respond to failures.
 *
 * Design ref: CompanyIQ-Framework-Creation-Design-v2.md
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface MeasureDraft {
  measureId: string;
  title: string;
  definition?: string;
  primary_assessment_target?: string;
  substantive_definition?: string;
  whatConstitutesEvidence?: string | string[];
  whatDoesNotConstituteEvidence?: string | string[];
  scoringGuidance?: string;
  fallback_yes_criterion?: string;
  positive_examples?: string[];
  negative_examples?: string[];
  min_quote_context_chars?: number;
  expected_yes_rate?: number;
  coverage_whitelist?: string[];
  c1_achievement_guidance?: {
    yes_cases: string[];
    no_cases: string[];
    distinguishing_test: string;
  };
  r3_1_exception_metrics?: boolean;
  r3_1_exception_coverage?: boolean;
  disclosure_vehicles?: string[];
}

export interface FrameworkDraft {
  frameworkId?: string;
  name: string;
  topicTerm: string;
  topicSynonyms?: string[];
  adjacentTopics?: Array<{
    name: string;
    example_phrases?: string[];
    cooccurrence_possible?: boolean;
  }>;
  anchorFrameworks?: Array<{ name: string; source?: string }>;
  sensitivityPreference?: "precision" | "recall" | "balanced";
  measures: MeasureDraft[];
}

export interface Violation {
  measureId?: string;
  rule: string;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  passed: boolean;
  violations: Violation[];
}

// ─── Constants ───────────────────────────────────────────────────────────

const ACHIEVEMENT_VERB_PATTERNS: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /\bhas achieved\b/i, verb: "has achieved" },
  { pattern: /\bhas phased out\b/i, verb: "has phased out" },
  { pattern: /\bhas eliminated\b/i, verb: "has eliminated" },
  { pattern: /\bhas excluded\b/i, verb: "has excluded" },
  { pattern: /\bcurrently excludes\b/i, verb: "currently excludes" },
  { pattern: /\bcurrently applies\b/i, verb: "currently applies" },
  { pattern: /\bhas implemented enterprise-wide\b/i, verb: "has implemented enterprise-wide" },
  { pattern: /\bcurrently operates\b/i, verb: "currently operates" },
  { pattern: /\bcurrently maintains\b/i, verb: "currently maintains" },
];

const FORBIDDEN_EXCLUSION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /forward[- ]looking (commitments? do not|commitments? does not)/i, label: "forward-looking commitment disqualifier" },
  { pattern: /\bcommitments? or plans do not qualify\b/i, label: "commitments-or-plans disqualifier" },
  { pattern: /\bforward[- ]looking language\b/i, label: "forward-looking language disqualifier" },
  { pattern: /future actions? do not count/i, label: "future-actions disqualifier" },
  { pattern: /\bplans or commitments? are not evidence\b/i, label: "plans-or-commitments disqualifier" },
  { pattern: /\ban intention to (disclose|develop|adopt|publish)/i, label: "intention-to-disclose disqualifier" },
  { pattern: /\ba commitment to (disclose|develop|adopt|publish)/i, label: "commitment-to-disclose disqualifier" },
  { pattern: /the measure requires an existing disclosure, not an intention to disclose/i, label: "existing-disclosure-only disqualifier" },
];

const MIN_QUOTE_CONTEXT_CHARS = 120;

const COVERAGE_KEYWORDS_IN_TITLE = [
  "enterprise-wide", "portfolio", "operations", "supply chain",
  "coverage", "applies to", "all", "%", "percent", "majority",
  "group-wide", "company-wide", "globally",
];

// ─── Helper ──────────────────────────────────────────────────────────────

function toText(field: string | string[] | undefined): string {
  if (!field) return "";
  return Array.isArray(field) ? field.join(" ") : field;
}

function isExceptionMeasure(m: MeasureDraft): boolean {
  return Boolean(m.r3_1_exception_metrics || m.r3_1_exception_coverage);
}

function containsTopicOrSynonym(text: unknown, topicTerm: unknown, synonyms: unknown): boolean {
  const t = typeof text === "string" ? text : "";
  const term = typeof topicTerm === "string" ? topicTerm : "";
  const syns: string[] = Array.isArray(synonyms)
    ? synonyms.filter((s): s is string => typeof s === "string")
    : [];
  const lc = t.toLowerCase();
  if (term && lc.includes(term.toLowerCase())) return true;
  for (const s of syns) {
    if (s && lc.includes(s.toLowerCase())) return true;
  }
  return false;
}

// ─── C1 — Position-testing phrasing with permissive interpretation ────────

export function validateC1(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    if (isExceptionMeasure(m)) continue;
    const combined = ((m.title || "") + " " + (m.primary_assessment_target || "")).toLowerCase();
    for (const { pattern, verb } of ACHIEVEMENT_VERB_PATTERNS) {
      if (pattern.test(combined)) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: `Title or primary_assessment_target contains achievement verb "${verb}"`,
          suggestion: `Rewrite as "does the entity disclose a policy/target/commitment on X" instead of achievement phrasing. If this is truly a metrics or coverage measure, set r3_1_exception_metrics: true or r3_1_exception_coverage: true.`,
        });
      }
    }
    // C1 also requires per-measure achievement guidance
    if (!m.c1_achievement_guidance) {
      violations.push({
        measureId: m.measureId,
        rule: "C1",
        severity: "error",
        message: "Missing c1_achievement_guidance",
        suggestion: `Add c1_achievement_guidance with yes_cases (achievement claims that entail a position), no_cases (factual outcomes without target-state language), and distinguishing_test.`,
      });
    } else {
      const g = m.c1_achievement_guidance as any;
      // Accept either array-of-strings OR a single non-empty string. Some LLM
      // outputs emit a single descriptive sentence rather than a list.
      const yesOk =
        (Array.isArray(g.yes_cases) && g.yes_cases.length > 0) ||
        (typeof g.yes_cases === "string" && g.yes_cases.trim().length >= 10);
      const noOk =
        (Array.isArray(g.no_cases) && g.no_cases.length > 0) ||
        (typeof g.no_cases === "string" && g.no_cases.trim().length >= 10);
      if (!yesOk) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: "c1_achievement_guidance.yes_cases is empty (must be non-empty array or non-empty string)",
        });
      }
      if (!noOk) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "error",
          message: "c1_achievement_guidance.no_cases is empty (must be non-empty array or non-empty string)",
        });
      }
      if (!g.distinguishing_test || String(g.distinguishing_test).length < 20) {
        violations.push({
          measureId: m.measureId,
          rule: "C1",
          severity: "warning",
          message: "c1_achievement_guidance.distinguishing_test is missing or too brief",
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C2 — Substantive-only exclusions ─────────────────────────────────────

export function validateC2(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const excl = toText(m.whatDoesNotConstituteEvidence);
    if (!excl) {
      violations.push({
        measureId: m.measureId,
        rule: "C2",
        severity: "error",
        message: "whatDoesNotConstituteEvidence is missing",
        suggestion: "Provide substantive-only exclusions (wrong subject, missing specificity, third-party attribution, adjacent-topic evidence).",
      });
      continue;
    }
    for (const { pattern, label } of FORBIDDEN_EXCLUSION_PATTERNS) {
      if (pattern.test(excl)) {
        violations.push({
          measureId: m.measureId,
          rule: "C2",
          severity: "error",
          message: `whatDoesNotConstituteEvidence contains forbidden ${label}`,
          suggestion: "Remove tense/aspiration-based exclusions. Reject only on substantive grounds: wrong subject, missing specificity, third-party attribution, adjacent-topic evidence.",
        });
      }
    }
    // Must include aspirational-language rejection (substantive form)
    if (!/aspirational/i.test(excl) && !/generic (statement|language)/i.test(excl)) {
      violations.push({
        measureId: m.measureId,
        rule: "C2",
        severity: "warning",
        message: "whatDoesNotConstituteEvidence should include aspirational-language rejection (without specific subject/action/timeframe)",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C3 — Quote-context requirement ───────────────────────────────────────

export function validateC3(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    if (typeof m.min_quote_context_chars !== "number" || m.min_quote_context_chars < MIN_QUOTE_CONTEXT_CHARS) {
      violations.push({
        measureId: m.measureId,
        rule: "C3",
        severity: "error",
        message: `min_quote_context_chars must be an integer ≥${MIN_QUOTE_CONTEXT_CHARS}`,
      });
    }
    const sg = m.scoringGuidance || "";
    if (!/adjacent sentence|surrounding sentence|surrounding context|full sentence/i.test(sg)) {
      violations.push({
        measureId: m.measureId,
        rule: "C3",
        severity: "error",
        message: "scoringGuidance must instruct the scorer to include an adjacent sentence for context",
        suggestion: "Add: 'When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.'",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C4 — Topic-anchored fallback conditions ──────────────────────────────

export function validateC4(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  const synonyms = fw.topicSynonyms || [];
  for (const m of fw.measures) {
    const fb = m.fallback_yes_criterion || "";
    if (!fb) {
      violations.push({
        measureId: m.measureId,
        rule: "C4",
        severity: "error",
        message: "fallback_yes_criterion is missing",
      });
      continue;
    }
    // Count numbered conditions. Accept multiple styles: (1) (2), 1. 2., 1) 2),
    // or list-array form if the LLM emitted an array. Bullet-style dashes are
    // not accepted — conditions must be enumerable.
    let conditions: Array<{ n: string; text: string }> = [];
    if (Array.isArray(fb)) {
      conditions = (fb as unknown as string[]).map((t, i) => ({ n: String(i + 1), text: String(t) }));
    } else {
      // Try parenthesised "(1)", then dotted "1." (allowing multi-line), then
      // paren-suffix "1)".
      const parenPattern = /\((\d+)\)\s*([\s\S]*?)(?=\(\d+\)|$)/g;
      const dottedPattern = /(?:^|\n|\.\s)(\d+)\.\s+([\s\S]*?)(?=(?:^|\n|\.\s)\d+\.\s+|$)/g;
      const suffixPattern = /(?:^|\n)(\d+)\)\s+([\s\S]*?)(?=(?:^|\n)\d+\)\s+|$)/g;
      for (const pat of [parenPattern, dottedPattern, suffixPattern]) {
        pat.lastIndex = 0;
        const found: Array<{ n: string; text: string }> = [];
        let match: RegExpExecArray | null;
        while ((match = pat.exec(fb as string)) !== null) {
          const text = String(match[2] || "").trim();
          if (text.length >= 10) found.push({ n: match[1], text });
        }
        if (found.length >= 3) {
          conditions = found;
          break;
        }
        // Keep the best partial for reporting
        if (found.length > conditions.length) conditions = found;
      }
    }
    if (conditions.length < 3) {
      violations.push({
        measureId: m.measureId,
        rule: "C4",
        severity: "error",
        message: `fallback_yes_criterion has ${conditions.length} numbered conditions; requires ≥3 (accepted formats: "(1) ...", "1. ...", or "1) ...")`,
      });
      continue;
    }
    for (const c of conditions) {
      if (c.text.length < 20) continue; // skip empty / trivially short
      if (!containsTopicOrSynonym(c.text, fw.topicTerm, synonyms)) {
        violations.push({
          measureId: m.measureId,
          rule: "C4",
          severity: "error",
          message: `Fallback condition #${c.n} does not reference the topic term "${fw.topicTerm}" or any registered synonym`,
          suggestion: "Ensure each numbered condition names the topic explicitly, not decoratively appended.",
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C5 — Adjacent-topic exclusion in substantive_definition ──────────────

export function validateC5(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  const adjacent = fw.adjacentTopics || [];
  const hasAdjacent = adjacent.length >= 2;

  for (const m of fw.measures) {
    const sd = m.substantive_definition || "";
    if (!sd) {
      violations.push({
        measureId: m.measureId,
        rule: "C5",
        severity: "error",
        message: "substantive_definition is missing",
      });
      continue;
    }
    if (hasAdjacent) {
      // Check that at least one adjacent-topic reference appears in the
      // substantive_definition. The LLM often paraphrases adjacent-topic
      // names ("climate scenario analysis" instead of "Climate Change") when
      // embedding them in a sentence — that is correct and natural, so we
      // match on ANY of:
      //   1. the full adjacent.name substring, OR
      //   2. any distinctive content token from adjacent.name (≥4 chars,
      //      excluding common stopwords like "and", "of", "the",
      //      "management", "topic", "change", "issues"), OR
      //   3. any example_phrase from the adjacent-topic entry.
      // We also require the substantive_definition to contain an "exclusion"
      // marker phrase so we do not falsely match on random topical mentions.
      const sdLower = String(sd || "").toLowerCase();
      // Require an explicit exclusion / rejection phrase, not just the word "exclusion".
      const hasExclusionMarker =
        /does not satisfy|does not count|not evidence|not sufficient|must be excluded|are excluded|are not evidence|are not sufficient|does not qualify|are not accepted|do not accept|specifically tests .+ (?:and not|not) |does NOT satisfy|adjacent topic/i.test(
          sd,
        );
      const found = adjacent.some((a) => {
        const name = typeof a?.name === "string" ? a.name : "";
        if (!name) return false;
        if (sdLower.includes(name.toLowerCase())) return true;
        // Tokenised match: any distinctive word from the adjacent-topic name.
        const tokens = name
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(
            (t) =>
              t.length >= 4 &&
              ![
                "and",
                "the",
                "of",
                "for",
                "with",
                "management",
                "topic",
                "topics",
                "change",
                "issues",
                "related",
                "policy",
                "general",
                "other",
              ].includes(t),
          );
        for (const tok of tokens) {
          if (sdLower.includes(tok)) return true;
        }
        // Example-phrase match.
        const phrases = Array.isArray(a?.example_phrases) ? a.example_phrases : [];
        for (const p of phrases) {
          if (typeof p === "string" && p.length >= 4 && sdLower.includes(p.toLowerCase())) {
            return true;
          }
        }
        return false;
      });
      if (!hasExclusionMarker) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "error",
          message: `substantive_definition is missing an exclusion clause. Add a sentence naming what does NOT count as evidence (e.g. "Evidence attributed to <adjacent topic> does not satisfy this measure").`,
          suggestion: `Reference at least one adjacent topic from the intake list [${adjacent.map((a) => (typeof a?.name === "string" ? a.name : "?")).join(", ")}].`,
        });
      } else if (!found) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "warning", // downgraded: exclusion clause exists but doesn't match intake vocabulary
          message: `substantive_definition has an exclusion clause but does not obviously reference an intake-listed adjacent topic. Verify the exclusion covers at least one of: ${adjacent.map((a) => (typeof a?.name === "string" ? a.name : "?")).join(", ")}.`,
          suggestion: `Ensure exclusion language names one of the intake's adjacent topics either by name, distinctive keyword, or example phrase.`,
        });
      }
    } else {
      // If no adjacent topics were identified, the framework must state so
      if (!/no adjacent topics identified/i.test(sd)) {
        violations.push({
          measureId: m.measureId,
          rule: "C5",
          severity: "warning",
          message: "No adjacent topics were identified in intake, but substantive_definition should acknowledge this explicitly",
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C6 — Positive AND adversarial-negative examples ──────────────────────

export function validateC6(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    const pos = m.positive_examples || [];
    const neg = m.negative_examples || [];
    if (pos.length < 2) {
      violations.push({
        measureId: m.measureId,
        rule: "C6",
        severity: "error",
        message: `positive_examples must have ≥2 entries (found ${pos.length})`,
      });
    }
    if (neg.length < 2) {
      violations.push({
        measureId: m.measureId,
        rule: "C6",
        severity: "error",
        message: `negative_examples must have ≥2 entries (found ${neg.length})`,
      });
    }
    for (const p of pos) {
      if (p.length > 300) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "warning",
          message: `positive_example exceeds 300 characters (${p.length})`,
        });
      }
    }
    for (const n of neg) {
      if (n.length > 300) {
        violations.push({
          measureId: m.measureId,
          rule: "C6",
          severity: "warning",
          message: `negative_example exceeds 300 characters (${n.length})`,
        });
      }
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C7 — Coverage-explicit phrasing with per-measure whitelist ───────────

export function validateC7(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  for (const m of fw.measures) {
    if (!m.r3_1_exception_coverage) continue;
    // Coverage measures must have coverage_whitelist with ≥3 entries
    const wl = m.coverage_whitelist || [];
    if (wl.length < 3) {
      violations.push({
        measureId: m.measureId,
        rule: "C7",
        severity: "error",
        message: `Coverage measure requires coverage_whitelist with ≥3 plain-language equivalents (found ${wl.length})`,
        suggestion: `Add phrases like "across the group", "enterprise-wide", "all our operations", etc.`,
      });
    }
    // Title must contain a threshold indicator
    const titleLower = (m.title || "").toLowerCase();
    const hasThreshold = COVERAGE_KEYWORDS_IN_TITLE.some((kw) => titleLower.includes(kw)) || /\d+\s*%/.test(titleLower);
    if (!hasThreshold) {
      violations.push({
        measureId: m.measureId,
        rule: "C7",
        severity: "error",
        message: "Coverage measure title must state the threshold explicitly (e.g. 'enterprise-wide', '≥70% of portfolio')",
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C8 — Vehicle-agnostic evidence acceptance ────────────────────────────

export function validateC8(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  // Accept ANY of the following as evidence that the framework is
  // vehicle-agnostic:
  //   1. An explicit "any vehicle" / "any document" / "regardless of vehicle"
  //      phrase in the substantive_definition, OR
  //   2. The substantive_definition enumerates >=2 disclosure vehicles from a
  //      known set (annual report, sustainability report, policy document,
  //      website, code of conduct, KPI table, ESG report, etc.), OR
  //   3. The measure has a disclosure_vehicles array with >=2 entries.
  const VEHICLE_KEYWORDS = [
    "annual report",
    "sustainability report",
    "esg report",
    "policy document",
    "code of conduct",
    "kpi table",
    "entity website",
    "company website",
    "corporate website",
    "integrated report",
    "proxy statement",
    "10-k",
    "annual filing",
    "disclosure document",
    "regulatory filing",
  ];
  const AGNOSTIC_PHRASES = /any vehicle|any disclosure vehicle|any document type|regardless of (the )?disclosure vehicle|regardless of the (report|vehicle|document|form)|whether disclosed in|any of the following (vehicles|documents|reports)/i;
  for (const m of fw.measures) {
    const sd = String(m.substantive_definition || "").toLowerCase();
    const hasAgnosticPhrase = AGNOSTIC_PHRASES.test(sd);
    const vehicleHits = VEHICLE_KEYWORDS.filter((v) => sd.includes(v)).length;
    const hasDisclosureVehiclesField =
      Array.isArray((m as any).disclosure_vehicles) && ((m as any).disclosure_vehicles as string[]).length >= 2;
    if (!hasAgnosticPhrase && vehicleHits < 2 && !hasDisclosureVehiclesField) {
      violations.push({
        measureId: m.measureId,
        rule: "C8",
        severity: "warning",
        message: `substantive_definition should describe vehicle-agnostic evidence acceptance (found ${vehicleHits} vehicle mentions and no explicit agnostic phrase).`,
        suggestion: `Either add an explicit phrase like "disclosed in any vehicle" OR mention ≥2 disclosure vehicles (annual report, sustainability report, policy document, website, etc.) OR populate disclosure_vehicles: [...].`,
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C9 — Expected Yes-rate calibration ───────────────────────────────────

export function validateC9(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  let tooNarrow = 0;
  let tooBroad = 0;
  for (const m of fw.measures) {
    if (typeof m.expected_yes_rate !== "number") {
      violations.push({
        measureId: m.measureId,
        rule: "C9",
        severity: "error",
        message: "expected_yes_rate must be a float in [0.01, 0.99]",
      });
      continue;
    }
    if (m.expected_yes_rate < 0.01 || m.expected_yes_rate > 0.99) {
      violations.push({
        measureId: m.measureId,
        rule: "C9",
        severity: "error",
        message: `expected_yes_rate ${m.expected_yes_rate} out of range [0.01, 0.99]`,
      });
      continue;
    }
    if (m.expected_yes_rate < 0.10) tooNarrow++;
    if (m.expected_yes_rate > 0.80) tooBroad++;
  }
  const total = fw.measures.length;
  if (total > 0) {
    if (tooNarrow / total > 0.20) {
      violations.push({
        rule: "C9",
        severity: "warning",
        message: `${tooNarrow}/${total} measures (${((100 * tooNarrow) / total).toFixed(0)}%) have expected_yes_rate <0.10 — framework may be too narrow overall`,
      });
    }
    if (tooBroad / total > 0.20) {
      violations.push({
        rule: "C9",
        severity: "warning",
        message: `${tooBroad}/${total} measures (${((100 * tooBroad) / total).toFixed(0)}%) have expected_yes_rate >0.80 — framework may be too broad overall`,
      });
    }
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── C10 — Topic term registration and synonym set ────────────────────────

export function validateC10(fw: FrameworkDraft): ValidationResult {
  const violations: Violation[] = [];
  if (!fw.topicTerm || fw.topicTerm.trim().length < 2) {
    violations.push({
      rule: "C10",
      severity: "error",
      message: "topicTerm is missing or too short",
    });
  }
  const syn = fw.topicSynonyms || [];
  if (syn.length < 2 || syn.length > 10) {
    violations.push({
      rule: "C10",
      severity: "error",
      message: `topicSynonyms must have 2–10 entries (found ${syn.length})`,
      suggestion: "Provide 2–10 substantively-equivalent alternative phrasings. Be conservative; do not include adjacent terms.",
    });
  }
  return { passed: violations.filter((v) => v.severity === "error").length === 0, violations };
}

// ─── Combined validator ───────────────────────────────────────────────────

export function validateAll(fw: FrameworkDraft): ValidationResult {
  const all: Violation[] = [];
  for (const [name, fn] of [
    ["C1", validateC1],
    ["C2", validateC2],
    ["C3", validateC3],
    ["C4", validateC4],
    ["C5", validateC5],
    ["C6", validateC6],
    ["C7", validateC7],
    ["C8", validateC8],
    ["C9", validateC9],
    ["C10", validateC10],
  ] as const) {
    const r = fn(fw);
    all.push(...r.violations);
  }
  return {
    passed: all.filter((v) => v.severity === "error").length === 0,
    violations: all,
  };
}

export function summariseViolations(violations: Violation[]): string {
  if (violations.length === 0) return "All C1–C10 rules pass.";
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const byMeasure = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = v.measureId || "framework-level";
    if (!byMeasure.has(key)) byMeasure.set(key, []);
    byMeasure.get(key)!.push(v);
  }
  const lines: string[] = [
    `Validation ${errors.length === 0 ? "PASSED (with warnings)" : "FAILED"}: ${errors.length} errors, ${warnings.length} warnings.`,
    "",
  ];
  for (const [measureId, vs] of byMeasure) {
    lines.push(`## ${measureId}`);
    for (const v of vs) {
      lines.push(`- [${v.severity.toUpperCase()}][${v.rule}] ${v.message}`);
      if (v.suggestion) lines.push(`  → ${v.suggestion}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
