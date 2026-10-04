/**
 * Unit tests for the builder<->validator drift detector (STEP 1, Detector D1).
 *
 * The safety-net test deep-equals the detector output against the committed
 * fixture `__fixtures__/sample-builder-drift.json`, which is the expected output
 * of the original Python PoC on the same builder prompt. This guards against the
 * broadened regex over-matching: if the TS port ever drifts from the PoC, the
 * deep-equal fails loudly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBuilderDrift, parseBuilderRules } from "./builder-drift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "__fixtures__");
const builderText = fs.readFileSync(path.join(FIX, "sample-builder-prompt.md"), "utf-8");
const expected = JSON.parse(fs.readFileSync(path.join(FIX, "sample-builder-drift.json"), "utf-8"));

test("D1 reproduces the PoC drift findings exactly (deep-equal fixture)", () => {
  const report = detectBuilderDrift(builderText);
  assert.deepEqual(report, expected);
});

test("D1 detects the C4 OR-list contradiction as blocking", () => {
  const report = detectBuilderDrift(builderText);
  const c4 = report.proposals.find((p) => p.id === "bd-C4");
  assert.ok(c4, "expected a bd-C4 proposal");
  assert.equal(c4!.type, "contradiction");
  assert.equal(c4!.blocking, true);
});

test("D1 flags missing validator rules the builder never mentions", () => {
  // The fixture builder omits C11/C12/C13 and never declares a parseable DEF
  // marker (the C-rule regex only captures C-codes), so DEF is always surfaced
  // as missing alongside them → four 'missing' proposals.
  const report = detectBuilderDrift(builderText);
  const missing = report.proposals.filter((p) => p.type === "missing").map((p) => p.rule).sort();
  assert.deepEqual(missing, ["C11", "C12", "C13", "DEF"]);
});

test("D1 clears the fixable C-rule drifts when the builder is aligned", () => {
  // A builder that declares the conjunctive C4 + C11/C12/C13 and a per-measure
  // C3 clears every fixable drift. DEF is never parseable as a C-code, so the
  // single residual proposal is the DEF marker — this pins that contract.
  const aligned = [
    "## C4 — Fallback conditions are a numbered list of >=3 substantive conditions that are AND-joined (ALL must hold); at least one references the topic term or a registered synonym.",
    "## C11 — decidable thresholds: any degree word needs an in-condition countable test.",
    "## C12 — prefer a conjunctive hard-token bundle over an M-of-N/OR-list soft gate.",
    "## C13 — examples must not contradict the one authoritative rule.",
    "## C3 — set a per-measure min_quote_context_chars rather than a global constant.",
  ].join("\n");
  const report = detectBuilderDrift(aligned);
  const nonDef = report.proposals.filter((p) => p.rule !== "DEF");
  assert.deepEqual(nonDef, [], JSON.stringify(nonDef));
  assert.deepEqual(report.proposals.map((p) => p.rule), ["DEF"]);
});

test("parseBuilderRules is first-occurrence-wins and matches multiple markdown forms", () => {
  const rules = parseBuilderRules(["* **C4**: first", "- C4: second", "## C7 — seventh"].join("\n"));
  assert.equal(rules["C4"], "first");
  assert.equal(rules["C7"], "seventh");
});
