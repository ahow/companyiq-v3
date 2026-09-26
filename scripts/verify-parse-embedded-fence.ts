/**
 * Regression guard for parseDraftJson (server/routes/framework-builder-v2.ts).
 *
 * BUG (fixed): the LLM repair response for a measure sometimes embeds a ```json
 * example fence INSIDE a string field value (e.g. whatConstitutesEvidence showing
 * an evidence-format example). The original parser used a NON-GREEDY fence match
 * (```json ...*?... ```) which stopped at that first EMBEDDED ``` and truncated the
 * JSON before later fields such as evidenceKeywords. The truncated fragment failed
 * to parse, recovery ran on the fragment (which lacked evidenceKeywords), and the
 * measure kept its original empty evidenceKeywords — so its distinctiveness warning
 * could never be resolved by a re-draft, no matter how well the model complied.
 *
 * This test constructs exactly that shape and asserts the parser recovers the FULL
 * object, including a field that appears AFTER the embedded fence.
 *
 * Run: DATABASE_URL=dummy npx tsx scripts/verify-parse-embedded-fence.ts
 */
import { parseDraftJson } from "../server/routes/framework-builder-v2.js";

function assert(cond: any, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok  -", msg);
}

// A realistic repair response: fenced ```json wrapper, and a string field whose
// value itself contains a ```json ... ``` example, followed by evidenceKeywords.
const embeddedExample =
  "Report an example such as:\\n\\n```json\\n{\\\"quality\\\": \\\"high\\\"}\\n```\\nEnd of example.";
const response = [
  "```json",
  "{",
  '  "measures": [',
  "    {",
  '      "measureId": "9.9-embedded-fence",',
  `      "whatConstitutesEvidence": "${embeddedExample}",`,
  '      "scoringGuidance": "Award Yes if disclosed.",',
  '      "evidenceKeywords": ["disparate", "parity", "calibration", "debiasing", "conformance"]',
  "    }",
  "  ]",
  "}",
  "```",
].join("\n");

const parsed = parseDraftJson(response);
assert(parsed.ok, "response with an embedded ```json fence parses successfully");
if (parsed.ok) {
  const m = parsed.draft?.measures?.[0];
  assert(m?.measureId === "9.9-embedded-fence", "measureId preserved");
  assert(Array.isArray(m?.evidenceKeywords) && m.evidenceKeywords.length === 5,
    `evidenceKeywords (a field AFTER the embedded fence) survives — got ${JSON.stringify(m?.evidenceKeywords)}`);
}

// Sanity: an ordinary single-fence response still parses.
const plain = parseDraftJson('```json\n{"measures":[{"measureId":"1.1","evidenceKeywords":["x","y"]}]}\n```');
assert(plain.ok && plain.draft.measures[0].measureId === "1.1", "ordinary fenced response still parses");

// Sanity: a bare object (no fence) still parses.
const bare = parseDraftJson('{"measures":[{"measureId":"2.2"}]}');
assert(bare.ok && bare.draft.measures[0].measureId === "2.2", "bare (unfenced) object still parses");

console.log("\nALL PASS — embedded-fence regression guard green.");
