import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateMatchesDocType,
  computeMissingRequiredDocTypes,
  planCompletenessResearch,
  buildDocTypeResearchQuery,
  docTypeMatchForms,
} from "./completeness-research.js";

// ─── doc-type matching (framework-agnostic; label text only) ──────────────────

test("candidateMatchesDocType matches on title or url, case-insensitively, whole-word", () => {
  // multi-word type: matches the literal phrase in the title (mirrors discovery's
  // own matchesRequiredDocType, which requires the full phrase for multi-word forms)
  assert.ok(candidateMatchesDocType({ title: "2025 Sustainability Report" }, "Sustainability Report"));
  assert.ok(candidateMatchesDocType({ title: "acme SUSTAINABILITY report" }, "Sustainability Report"));
  // single-token/acronym type: word-boundary match works even in a hyphenated URL
  assert.ok(candidateMatchesDocType({ url: "https://ir.acme.com/reports/tcfd-report.pdf" }, "TCFD"));
  // substring-in-word must NOT match (word boundary)
  assert.ok(!candidateMatchesDocType({ title: "Unsustainability notes" }, "Sustainability Report"));
  // empty candidate never matches
  assert.ok(!candidateMatchesDocType({ title: "", url: "" }, "Annual Report"));
});

test("docTypeMatchForms splits compound labels (or/and/&/comma/slash) into clauses", () => {
  const forms = docTypeMatchForms("Proxy Statement or Annual Report");
  assert.ok(forms.includes("proxy statement"));
  assert.ok(forms.includes("annual report"));
});

test("a compound required type is satisfied by a candidate matching EITHER clause", () => {
  assert.ok(
    candidateMatchesDocType({ title: "FY24 Annual Report" }, "Proxy Statement or Annual Report"),
  );
});

// ─── G — compute the still-missing required types (gap detection) ─────────────

test("computeMissingRequiredDocTypes returns only required types with zero matching candidates", () => {
  const required = ["Sustainability Report", "Proxy Statement", "TCFD Report"];
  const candidates = [
    { title: "2025 Sustainability Report" },
    { title: "Acme TCFD Report 2025", url: "https://ir.example.com/tcfd-report.pdf" },
  ];
  const missing = computeMissingRequiredDocTypes(required, candidates);
  assert.deepEqual(missing, ["Proxy Statement"]);
});

test("computeMissingRequiredDocTypes de-duplicates and preserves original label text", () => {
  const missing = computeMissingRequiredDocTypes(
    ["Proxy Statement", "proxy statement", "  Proxy Statement  "],
    [],
  );
  assert.deepEqual(missing, ["Proxy Statement"]);
});

test("no required doc types ⇒ nothing is missing (default-preserving: no research)", () => {
  assert.deepEqual(computeMissingRequiredDocTypes([], [{ title: "x" }]), []);
  assert.deepEqual(computeMissingRequiredDocTypes(null, [{ title: "x" }]), []);
  assert.deepEqual(computeMissingRequiredDocTypes(undefined, []), []);
});

// ─── E → G → D coordination (do not double-fetch the same gap) ────────────────

test("planCompletenessResearch subtracts already-researched types (E→G coordination)", () => {
  const missing = ["Proxy Statement", "TCFD Report", "Modern Slavery Statement"];
  const alreadyResearched = ["proxy statement"]; // E already did this one
  const plan = planCompletenessResearch({ missing, alreadyResearched });
  assert.deepEqual(plan, ["TCFD Report", "Modern Slavery Statement"]);
});

test("planCompletenessResearch coordination is case-insensitive and trims whitespace (D/RC6 overlap)", () => {
  const plan = planCompletenessResearch({
    missing: ["  Annual Report ", "Proxy Statement"],
    alreadyResearched: ["ANNUAL REPORT"], // e.g. RC6 readiness retry covered this gap
  });
  assert.deepEqual(plan, ["Proxy Statement"]);
});

test("planCompletenessResearch de-duplicates within the missing list too", () => {
  const plan = planCompletenessResearch({
    missing: ["Proxy Statement", "proxy statement"],
    alreadyResearched: [],
  });
  assert.deepEqual(plan, ["Proxy Statement"]);
});

test("planCompletenessResearch with no prior research returns the full missing list", () => {
  const missing = ["A Report", "B Report"];
  assert.deepEqual(planCompletenessResearch({ missing }), ["A Report", "B Report"]);
});

// ─── query builder (no hardcoded company/framework/measure names) ─────────────

test("buildDocTypeResearchQuery composes only company name + framework-authored label", () => {
  assert.equal(buildDocTypeResearchQuery("Acme Corp", "Proxy Statement"), "Acme Corp Proxy Statement");
  assert.equal(buildDocTypeResearchQuery("  Acme  ", "  Annual Report "), "Acme Annual Report");
});
