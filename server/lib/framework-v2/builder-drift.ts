/**
 * STEP 1 — Builder <-> validator drift detector (Detector D1).
 *
 * Faithful TypeScript port of `skills/framework-review/scripts/builder_drift.py`.
 * The framework BUILDER prompt declares construction rules C1..C10. The live
 * engine (server/lib/framework-v2/rules.ts) ENFORCES DEF + C1..C13 + set-level.
 * When the builder tells the generating LLM to produce something the validator
 * then rejects (contradiction), or is silent about a rule the validator enforces
 * (missing), or hardcodes a threshold the engine reads per-measure (mismatch),
 * EVERY framework inherits the defect. The fix belongs in the BUILDER, once.
 *
 * Deterministic and fail-loud: it extracts the builder's C-rule lines and
 * compares them to a curated map of validator semantics (with rules.ts line
 * refs so a human can re-verify). It emits GATED builder-change proposals — it
 * NEVER edits the builder. Topic-agnostic: no topic tokens or company names.
 */

export type DriftType = "contradiction" | "missing" | "mismatch";

export interface DriftProposal {
  id: string;
  rule: string;
  type: DriftType;
  blocking: boolean;
  builderSays: string | null;
  validatorEnforces: string;
  ref: string;
  rationale: string;
  proposedBuilderEdit: string;
}

export interface BuilderDriftReport {
  detector: "builder-validator-drift";
  builderRulesFound: string[];
  proposalCount: number;
  blockingProposals: number;
  proposals: DriftProposal[];
  note: string;
}

interface ValidatorSemantic {
  ref: string;
  enforces: string;
  blocking: boolean;
}

// Curated from server/lib/framework-v2/rules.ts (re-verify against the cited
// lines). Mirrors VALIDATOR_SEMANTICS in builder_drift.py byte-for-byte.
const VALIDATOR_SEMANTICS: Record<string, ValidatorSemantic> = {
  DEF: {
    ref: "validateDefinitionPresent",
    enforces: "every measure must have a derivable definition (fail-loud)",
    blocking: true,
  },
  C4: {
    ref: "validateC4 L656-742",
    enforces:
      "fallback_yes_criterion = >=3 numbered AND-joined conditions; >=1 condition anchors the topic term/synonym. Conditions are conjunctive (ALL must hold).",
    blocking: true,
  },
  C9: {
    ref: "validateC9 L1029-1114",
    enforces: "extreme expectedYesRate (very high/low) requires an explicit justification string; else error",
    blocking: true,
  },
  C10: {
    ref: "validateC10 L1124-1142",
    enforces: "topicTerm present AND topicSynonyms.length>=2 at framework level",
    blocking: true,
  },
  C11: {
    ref: "validateC11 L1159+",
    enforces:
      "decidable thresholds: any degree word in a condition needs an in-condition countable/named test (judged per-condition for fallback)",
    blocking: true,
  },
  C12: {
    ref: "validateC12 L1330+",
    enforces: "advisory(info): prefer a conjunctive hard-token bundle over an M-of-N/OR-list soft gate",
    blocking: false,
  },
  C13: {
    ref: "validateC13",
    enforces: "advisory(warning/info): examples must not contradict the one authoritative rule",
    blocking: false,
  },
};

// What the builder SAYS each rule is (filled by parsing). We only need the lines.
//
// The PoC regex only matched the sample builder-prompt form `* **Cn**: text`.
// The IN-REPO builder source (intake-prompt.ts) writes rules as `- Cn: text`
// and `## Cn — text`, so this port BROADENS the pattern to a safe superset that
// matches BOTH forms while staying anchored enough not to over-match prose
// (verified against the committed fixture, which reproduces the PoC output
// exactly). Leading list/heading markers and bold markers are optional; the
// rule code must appear near the line start, optionally followed by `:`/`—`/`-`.
const BUILDER_RULE_RE = /^[-*#>\s]*\*{0,2}\s*(C\d{1,2})\b\*{0,2}\s*[:.\u2014-]?\s*(.*)$/;

/** Parse the builder prompt text into a map of C-rule → declared text. */
export function parseBuilderRules(text: string): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const ln of text.split(/\r?\n/)) {
    const m = BUILDER_RULE_RE.exec(ln.trim());
    if (m) {
      // First occurrence wins (mirrors dict assignment order in the PoC, where
      // each rule appears once in the normative section).
      if (!(m[1] in rules)) rules[m[1]] = (m[2] || "").trim();
    }
  }
  return rules;
}

// Bespoke proposed edits for missing rules whose generic `enforces` summary
// would make a misleading verbatim builder instruction (operators can only
// select/deselect proposals, not edit them). Rules absent here use the generic
// template. Topic-agnostic by construction.
const MISSING_RULE_EDIT_OVERRIDES: Record<string, string> = {
  // C12 is advisory and never blocks; it must not become a blanket mandate that
  // homogenises every measure toward one gate shape.
  C12:
    "Add an ADVISORY construction note C12 to Part 3: WHERE the measurable signal permits, " +
    "a conjunctive hard-token bundle (co-occurrence in a single verbatim quote of a named " +
    "artefact/function AND a hard qualifier) is more flip-resistant than an M-of-N / OR-list " +
    "soft gate — but KEEP a soft or N-of-M gate where a conjunctive bundle would be too strict " +
    "for the measure. This is advisory, never a blanket requirement; do not homogenise measures " +
    "toward one gate shape.",
  // C13 fires when examples ship without a substantive_definition; fix the root
  // cause (missing authoritative Yes-bar), not just the symptom.
  C13:
    "Add a construction rule C13 to Part 3: when a measure ships positive/negative examples, " +
    "it MUST also carry a `substantive_definition` that states the single authoritative Yes-bar, " +
    "and every example must be consistent with THAT rule (do not let a strict fallback silently " +
    "become the authoritative bar).",
};

const NOTE =
  "GATED proposals only. A builder change affects ALL future frameworks and must be " +
  "human-approved, then VERIFIED by an operator-triggered regeneration — implemented != verified-fixed.";

/**
 * Detect builder↔validator drift from the builder prompt text. Pure function;
 * faithful port of builder_drift.py `drift()`.
 */
export function detectBuilderDrift(builderText: string): BuilderDriftReport {
  const builder = parseBuilderRules(builderText);
  const proposals: DriftProposal[] = [];

  // C4 contradiction: builder says OR-list, validator enforces AND-joined.
  if ("C4" in builder && /\bOR[- ]?list/i.test(builder["C4"])) {
    proposals.push({
      id: "bd-C4",
      rule: "C4",
      type: "contradiction",
      blocking: true,
      builderSays: builder["C4"].slice(0, 200),
      validatorEnforces: VALIDATOR_SEMANTICS["C4"].enforces,
      ref: VALIDATOR_SEMANTICS["C4"].ref,
      rationale:
        "Builder instructs the LLM to author fallback conditions as an OR-list " +
        "(any one suffices), but validateC4 treats conditions as AND-joined " +
        "(all must hold) and anchors only one to the topic. Authors and the " +
        "engine disagree on the semantics of every fallback block produced.",
      proposedBuilderEdit:
        "Rewrite builder C4 to: 'Fallback conditions are a numbered " +
        "list of >=3 substantive conditions that are AND-joined (ALL must hold for " +
        "the fallback to fire); at least one condition must explicitly reference " +
        "the topic term or a registered synonym.'",
    });
  }

  // Missing rules: validator enforces but builder never mentions.
  for (const rule of ["C11", "C12", "C13"]) {
    if (!(rule in builder)) {
      const v = VALIDATOR_SEMANTICS[rule];
      proposals.push({
        id: `bd-${rule}`,
        rule,
        type: "missing",
        blocking: v.blocking,
        builderSays: null,
        validatorEnforces: v.enforces,
        ref: v.ref,
        rationale:
          `The live engine runs ${rule} but the builder never instructs the LLM ` +
          `about it, so the generator cannot pre-satisfy it. ${v.blocking ? "Blocking" : "Advisory"}.`,
        proposedBuilderEdit:
          MISSING_RULE_EDIT_OVERRIDES[rule] ??
          `Add a construction rule ${rule} to Part 3 describing: ${v.enforces}`,
      });
    }
  }

  // DEF missing.
  if (!("DEF" in builder)) {
    proposals.push({
      id: "bd-DEF",
      rule: "DEF",
      type: "missing",
      blocking: true,
      builderSays: null,
      validatorEnforces: VALIDATOR_SEMANTICS["DEF"].enforces,
      ref: VALIDATOR_SEMANTICS["DEF"].ref,
      rationale:
        "Validator fails loud if any measure lacks a derivable definition; builder " +
        "should state that substantive_definition (from which the short definition " +
        "is derived at save) is mandatory and non-empty.",
      proposedBuilderEdit:
        "Add to Part 3: every measure MUST carry a non-empty `substantive_definition` " +
        "that states what constitutes a Yes verdict (the short `definition` field is " +
        "derived from it at save).",
    });
  }

  // C3 threshold mismatch (builder hardcodes 120 chars).
  const c3 = builder["C3"] || "";
  if (/\b120\b/.test(c3)) {
    proposals.push({
      id: "bd-C3",
      rule: "C3",
      type: "mismatch",
      blocking: false,
      builderSays: c3.slice(0, 160),
      validatorEnforces:
        "quote-context length is driven by per-measure min_quote_context_chars, not a fixed 120",
      ref: "validateC3 L614-645",
      rationale:
        "Builder hardcodes a 120-char constant; the engine reads a per-measure " +
        "min_quote_context_chars field. Hardcoding prevents per-measure tuning.",
      proposedBuilderEdit:
        "Rephrase C3 to set a per-measure min_quote_context_chars " +
        "(default 120) rather than a global constant.",
    });
  }

  return {
    detector: "builder-validator-drift",
    builderRulesFound: Object.keys(builder).sort(),
    proposalCount: proposals.length,
    blockingProposals: proposals.filter((p) => p.blocking).length,
    proposals,
    note: NOTE,
  };
}
