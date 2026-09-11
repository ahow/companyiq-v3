/**
 * STEP 4b helper — count how many of the 25 production measures are
 * "boundary / degree-word-flagged", using the SAME decidability rule the
 * framework linter applies (C11) plus a raw degree-word scan for context.
 * Measurement/analysis only; touches no production path.
 */
import { readFileSync } from "fs";
import { validateC11, findDegreeWords } from "../lib/framework-v2/rules.js";

const measures = JSON.parse(readFileSync("/home/ubuntu/var_measures.json", "utf8"));

// Map camelCase measure JSON -> the snake_case fields validateC11 reads.
const draftMeasures = measures.map((m: any) => ({
  measureId: m.measureId,
  scoringGuidance: m.scoringGuidance || "",
  substantive_definition: m.substantiveDefinition || "",
  fallback_yes_criterion: m.fallbackYesCriterion || "",
}));

const res = validateC11({ measures: draftMeasures } as any);
const flagged = new Set(res.violations.filter((v) => v.severity === "error").map((v) => v.measureId));

// Raw degree-word presence across the decision-criteria fields (context only).
const decisionText = (m: any) =>
  [m.scoringGuidance, m.substantiveDefinition, m.fallbackYesCriterion, m.whatConstitutesEvidence]
    .filter(Boolean).join("\n");

let anyDegree = 0;
const rows: any[] = [];
for (const m of measures) {
  const dw = findDegreeWords(decisionText(m));
  if (dw.length) anyDegree++;
  rows.push({ measureId: m.measureId, c11Flagged: flagged.has(m.measureId), degreeWords: dw });
}

console.log(JSON.stringify({
  total: measures.length,
  c11FlaggedCount: flagged.size,
  c11FlaggedIds: [...flagged],
  anyDegreeWordCount: anyDegree,
  rows,
}, null, 2));
