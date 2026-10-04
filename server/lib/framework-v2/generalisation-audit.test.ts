/**
 * Unit tests for the generalisation audit (STEP 1, Detector D3).
 *
 * The safety-net test deep-equals the detector output against the committed
 * fixture `__fixtures__/sample-generalisation-audit.json` (the Python PoC's
 * expected output). This guards the precision-critical distinction between
 * labelled examples (allowed to be topical) and copy-risk positions (schema
 * defaults / construction rules) from regressing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditGeneralisation, classifyBlocks } from "./generalisation-audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "__fixtures__");
const builderText = fs.readFileSync(path.join(FIX, "sample-builder-prompt.md"), "utf-8");
const expected = JSON.parse(fs.readFileSync(path.join(FIX, "sample-generalisation-audit.json"), "utf-8"));

test("D3 reproduces the PoC generalisation findings exactly (deep-equal fixture)", () => {
  const report = auditGeneralisation(builderText);
  assert.deepEqual(report, expected);
});

test("D3 does NOT flag topic tokens inside clearly-labelled examples", () => {
  // A 'rule' line that explicitly gives an example ("e.g. ...") is allowed to be topical.
  const text = ["# Part 3", "Reference the topic abstractly, e.g. biodiversity or TNFD for a nature framework."].join("\n");
  const report = auditGeneralisation(text);
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings));
});

test("D3 flags a topic token leaking into an output-schema default", () => {
  const text = [
    "# Part 5",
    "```json",
    '{ "topicTerm": "biodiversity", "anchor": "TNFD" }',
    "```",
  ].join("\n");
  const report = auditGeneralisation(text);
  assert.ok(report.findings.length > 0, "expected at least one schema-default finding");
  assert.ok(report.findings.every((f) => f.position === "output-schema-default"));
  assert.ok(report.counts["output-schema-default"] >= 1);
});

test("D3 allow-lists builder-infrastructure acronyms (JSON/LLM/BM25...)", () => {
  const text = ["# Part 5", "```json", '{ "format": "JSON", "retriever": "BM25" }', "```"].join("\n");
  const report = auditGeneralisation(text);
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings));
});

test("classifyBlocks tags Part>=5 fenced lines as schema and Part 3/4 as rule", () => {
  const lines = ["# Part 3", "normative text", "# Part 5", "```json", "x", "```"];
  const tags = classifyBlocks(lines);
  assert.equal(tags[1], "rule");
  assert.equal(tags[4], "schema");
});
