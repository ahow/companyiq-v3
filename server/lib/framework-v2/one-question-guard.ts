/**
 * One-question-per-turn guard (deterministic, server-side).
 *
 * The intake system prompt (intake-prompt.ts) already instructs the model to ask
 * AT MOST ONE question per message with exactly one decision + its own option
 * chips. That rule is prompt-only; the model occasionally violates it by packing
 * several questions / proposals into a single turn, which makes "accept the
 * proposal" ambiguous for the operator.
 *
 * This module adds a lightweight, fully deterministic detector the /v2/chat
 * handler runs AFTER the model responds. On a detected violation the handler
 * performs EXACTLY ONE corrective re-generation that constrains the model to
 * emit only the single highest-priority next question + its chips. Held-back
 * questions are not lost: they re-surface on later turns from the persisted
 * robustness-gate state, exactly as before.
 *
 * Design priorities:
 *  - TOPIC/COMPANY-AGNOSTIC: no framework/topic/company strings or branches.
 *    Only generic English-language + chip-protocol structure is inspected.
 *  - Robust against false positives: a single question with many option chips is
 *    COMPLIANT; embedded examples ("for example, ...?"), trivial confirm tags
 *    ("Right?", "Sound good?"), and sub-clauses must all PASS.
 *  - Defense in depth: this does NOT replace the prompt rule; it backstops it.
 */

/** A chip marker line, e.g. `[[option:Publicly-listed companies]]`. */
const OPTION_LINE_RE = /\[\[option:\s*[\s\S]*?\]\]/i;

/** Fenced code blocks (```json / ```gate_state / etc.) — machine-readable, never user questions. */
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;

/** Inline chip markers anywhere in the text. */
const OPTION_INLINE_RE = /\[\[option:\s*[\s\S]*?\]\]/gi;

/** The robustness-gate status readout line — a status report, not a question. */
const GATE_LINE_RE = /robustness\s+gate\s*:/i;

/**
 * Enumerated question/step headers the prompt explicitly forbids combining, e.g.
 * "Question 3", "Step 4", "Item 2", "Q1". Two or more DISTINCT numbers => the
 * turn bundled multiple enumerated items.
 */
const ENUM_HEADER_RE = /\b(?:question|step|item|q)\s*#?\s*(\d+)\b/gi;

/** Elaboration / example openers — a "?" after one of these is not a new decision. */
const ELABORATION_OPENERS = [
  "for example",
  "for instance",
  "e.g.",
  "eg.",
  "i.e.",
  "ie.",
  "that is",
  "such as",
  "like",
  "namely",
];

/** Interrogative (wh-) words used to detect two questions fused into one sentence. */
const WH_WORDS = ["what", "which", "who", "whom", "whose", "where", "when", "how", "why"];

export interface MultiProposalDetection {
  violation: boolean;
  /** Count of distinct, decision-bearing question sentences. */
  questionCount: number;
  /** Count of distinct enumerated "Question N / Step N / Item N" numbers. */
  enumeratedHeaderCount: number;
  /** Count of separate chip GROUPS (runs of consecutive option lines). */
  chipGroupCount: number;
  /** Whether a single sentence fused >=2 wh-interrogatives via and/or/comma. */
  multiWhSingleSentence: boolean;
  /** Human-readable reason for the decision (for logging). */
  reason: string;
}

/**
 * Count separate chip GROUPS: runs of consecutive option-marker lines. One
 * question legitimately carries many chips, but those chips sit together as one
 * block. Two or more SEPARATE blocks (prose between them) signals two questions
 * each with their own chip set — a violation.
 */
function countChipGroups(lines: string[]): number {
  let groups = 0;
  let inGroup = false;
  for (const line of lines) {
    const isOption = OPTION_LINE_RE.test(line.trim());
    if (isOption && !inGroup) {
      groups += 1;
      inGroup = true;
    } else if (!isOption && line.trim() !== "") {
      // Non-blank, non-option line breaks the run. (Blank lines between chips of
      // the same block are common and must NOT split the group.)
      inGroup = false;
    }
  }
  return groups;
}

/** Strip a trailing elaboration clause so "Pick A? For example, B?" counts once. */
function startsWithElaboration(sentenceFragment: string): boolean {
  const t = sentenceFragment.trim().toLowerCase();
  return ELABORATION_OPENERS.some((opener) => t.startsWith(opener));
}

/** A trivial confirm tag like "Right?", "OK?", "Sound good?" (<=3 words). */
function isTrivialConfirmTag(sentence: string): boolean {
  const words = sentence.trim().replace(/[?]+$/, "").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3;
}

/**
 * Detect whether a single "?"-terminated span fuses two or more wh-questions
 * bridged by and / or / comma — the documented anti-pattern
 * "What entity type, and what sector scope?".
 */
function hasMultiWhSingleSentence(questionSpans: string[]): boolean {
  for (const span of questionSpans) {
    const lower = span.toLowerCase();
    // Count TOTAL wh-word OCCURRENCES (not distinct words) as standalone tokens,
    // so a repeated interrogative like "What X, and what Y?" counts as two.
    let whOccurrences = 0;
    for (const w of WH_WORDS) {
      const matches = lower.match(new RegExp(`\\b${w}\\b`, "gi"));
      if (matches) whOccurrences += matches.length;
    }
    if (whOccurrences < 2) continue;
    // Require a bridging connector (and / or / comma) so a single clause that
    // merely mentions two wh-words incidentally does not trip the guard.
    const hasBridge = /,|\band\b|\bor\b/i.test(lower);
    // Two wh-tokens + a bridge + ends with "?" is the fused-question shape.
    if (hasBridge) return true;
  }
  return false;
}

/**
 * Split cleaned prose into "?"-terminated spans and keep only those that are a
 * genuine, distinct decision: drops elaboration/example continuations and
 * trivial confirm tags.
 */
function extractDecisionQuestions(prose: string): { spans: string[]; count: number } {
  // Normalise whitespace; keep sentence punctuation.
  const text = prose.replace(/\s+/g, " ").trim();
  if (!text) return { spans: [], count: 0 };

  // Split into spans that each END at a '?' (capture the segment leading up to
  // and including each question mark).
  const spans: string[] = [];
  const re = /([^?]*\?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (raw) spans.push(raw);
  }

  // For each raw "?" span, isolate the clause closest to the '?' (after the last
  // sentence terminator . ! ; or chip boundary) to decide if it's a real question.
  const decisionSpans: string[] = [];
  for (const raw of spans) {
    // The clause is the text after the last hard sentence break.
    const clause = raw.split(/(?<=[.!;])\s+/).pop()?.trim() ?? raw;
    if (!clause || clause === "?") continue;
    if (startsWithElaboration(clause)) continue; // "For example, ...?"
    if (isTrivialConfirmTag(clause)) continue; // "Right?" / "Sound good?"
    decisionSpans.push(clause);
  }

  return { spans: decisionSpans, count: decisionSpans.length };
}

/**
 * Deterministically decide whether an assistant intake turn violated the
 * one-question-per-message rule.
 *
 * A turn is a VIOLATION when ANY of:
 *   - it carries >=2 separate chip GROUPS (each question bringing its own chips);
 *   - it uses >=2 distinct enumerated headers (Question 3 + Question 4 / Step N …);
 *   - it contains >=2 distinct decision-bearing question sentences;
 *   - a single sentence fuses >=2 wh-questions via and/or/comma.
 *
 * A single question with one chip group (any number of chips) PASSES.
 */
export function detectMultiProposalTurn(rawMessage: string): MultiProposalDetection {
  const empty: MultiProposalDetection = {
    violation: false,
    questionCount: 0,
    enumeratedHeaderCount: 0,
    chipGroupCount: 0,
    multiWhSingleSentence: false,
    reason: "empty",
  };
  if (!rawMessage || typeof rawMessage !== "string") return empty;

  // 1) Count chip groups on the ORIGINAL text (before stripping chips), so we can
  //    see how the option lines are grouped.
  const originalLines = rawMessage.split(/\r?\n/);
  const chipGroupCount = countChipGroups(originalLines);

  // 2) Build a "prose only" view: remove fenced blocks, remove chip markers,
  //    and drop the robustness-gate status line (status readout, not a question).
  let prose = rawMessage.replace(FENCED_BLOCK_RE, " ").replace(OPTION_INLINE_RE, " ");
  prose = prose
    .split(/\r?\n/)
    .filter((line) => !GATE_LINE_RE.test(line))
    .join("\n");

  // 3) Enumerated headers (Question N / Step N / Item N / Q N) — distinct numbers.
  const enumNumbers = new Set<string>();
  let em: RegExpExecArray | null;
  const enumRe = new RegExp(ENUM_HEADER_RE.source, "gi");
  while ((em = enumRe.exec(prose)) !== null) {
    enumNumbers.add(em[1]);
  }
  const enumeratedHeaderCount = enumNumbers.size;

  // 4) Distinct decision-bearing question sentences.
  const { spans, count: questionCount } = extractDecisionQuestions(prose);

  // 5) Multi-wh single sentence.
  const multiWhSingleSentence = hasMultiWhSingleSentence(spans);

  const reasons: string[] = [];
  if (enumeratedHeaderCount >= 2) reasons.push(`enumeratedHeaders=${enumeratedHeaderCount}`);
  if (chipGroupCount >= 2) reasons.push(`chipGroups=${chipGroupCount}`);
  if (questionCount >= 2) reasons.push(`questions=${questionCount}`);
  if (multiWhSingleSentence) reasons.push("multiWhSingleSentence");

  const violation =
    enumeratedHeaderCount >= 2 ||
    chipGroupCount >= 2 ||
    questionCount >= 2 ||
    multiWhSingleSentence;

  return {
    violation,
    questionCount,
    enumeratedHeaderCount,
    chipGroupCount,
    multiWhSingleSentence,
    reason: violation ? reasons.join(",") : "compliant",
  };
}

/**
 * Appended to the intake system prompt during the single corrective
 * re-generation. Topic/company-agnostic; reinforces the existing prompt rule
 * without introducing any new policy. The model must keep all other formatting
 * rules (chips, gate_state block, robustness-gate line) intact.
 */
export const ONE_QUESTION_CORRECTIVE_SUFFIX = `

# CORRECTION REQUIRED — EMIT ONLY ONE QUESTION
Your previous draft of this turn asked more than one question or bundled several proposals. Re-send this turn with EXACTLY ONE question: pick the single highest-priority next unresolved checklist item and ask only that. Requirements:
- Exactly one question with exactly one decision. No "Question 3 / Question 4" or "Step N / Step N+1" bundling. No second question anywhere, including inside the gate status line.
- Emit exactly ONE group of [[option:...]] chips, and those chips must answer only that single question. The first chip must be the acceptance option.
- You MAY briefly note how many items remain, but phrase it as a status, not as additional questions.
- Keep the \`\`\`gate_state block and the final "Robustness gate: X/10 items resolved. Open: [...]" line exactly as required.
- Do not apologise or mention this correction; just send the corrected single-question turn. The other items will be asked on later turns.`;
