// Test spec for Issue 6 — retrieval-targeting derivation (topic-agnostic).
// Run with:  node --test  (NOT auto-run by the build).
//
// All fixtures use synthetic, subject-neutral strings so the tests prove the
// derivations are STRUCTURAL, not tuned to any one framework topic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequiredDocTypes,
  deriveWithdrawalPatterns,
  deriveNegativeDomains,
  validateTargetingCoverage,
} from "./retrieval-targeting.js";

// ── deriveRequiredDocTypes ──────────────────────────────────────────────────

test("requiredDocTypes: canonicalises known document classes from disclosure_vehicles", () => {
  const measures = [
    { disclosure_vehicles: ["Annual Report 2023", "Sustainability report"] },
    { disclosure_vehicles: ["Proxy statement (DEF 14A)"] },
  ];
  const out = deriveRequiredDocTypes(measures);
  assert.ok(out.includes("Annual Report"), "annual report canonicalised");
  assert.ok(out.includes("Sustainability/ESG Report"), "sustainability canonicalised");
  assert.ok(out.includes("Proxy Statement"), "proxy canonicalised");
});

test("requiredDocTypes: preserves unmatched vehicle labels verbatim (no operator intent lost)", () => {
  const measures = [{ disclosure_vehicles: ["Bespoke Stewardship Ledger"] }];
  const out = deriveRequiredDocTypes(measures);
  assert.deepEqual(out, ["Bespoke Stewardship Ledger"]);
});

test("requiredDocTypes: dedupes across measures and accepts camelCase key", () => {
  const measures = [
    { disclosure_vehicles: ["Annual report"] },
    { disclosureVehicles: ["10-K"] }, // camelCase + different label, same canonical
  ];
  const out = deriveRequiredDocTypes(measures);
  assert.deepEqual(out, ["Annual Report"]);
});

test("requiredDocTypes: returns [] when no vehicles declared or bad input", () => {
  assert.deepEqual(deriveRequiredDocTypes([]), []);
  assert.deepEqual(deriveRequiredDocTypes([{ title: "x" }]), []);
  assert.deepEqual(deriveRequiredDocTypes(null as any), []);
});

// ── deriveWithdrawalPatterns ────────────────────────────────────────────────

test("withdrawalPatterns: parameterised with the framework's own topicTerm", () => {
  const out = deriveWithdrawalPatterns("widget stewardship");
  assert.ok(out.queries.length > 0, "queries produced");
  assert.ok(out.queries.every((q) => q.includes("widget stewardship")), "every query references topicTerm");
  assert.ok(out.documentRegex.length === 2, "two anchored regexes");
  assert.ok(out.documentRegex.every((r) => r.includes("widget stewardship")), "regex references topicTerm");
});

test("withdrawalPatterns: regex-escapes special characters in topicTerm", () => {
  const out = deriveWithdrawalPatterns("scope (1+2) emissions");
  // The literal parens/plus must be escaped in the emitted regex substring.
  assert.ok(out.documentRegex.some((r) => r.includes("\\(1\\+2\\)")), "special chars escaped");
});

test("withdrawalPatterns: empty structure when no usable topicTerm", () => {
  assert.deepEqual(deriveWithdrawalPatterns(""), { queries: [], documentRegex: [] });
  assert.deepEqual(deriveWithdrawalPatterns(null), { queries: [], documentRegex: [] });
  assert.deepEqual(deriveWithdrawalPatterns("   "), { queries: [], documentRegex: [] });
});

// ── deriveNegativeDomains ───────────────────────────────────────────────────

test("negativeDomains: normalises/dedupes/lowercases adjacent topic names", () => {
  const out = deriveNegativeDomains(["Adjacent Topic A", "adjacent topic a", "  Other Domain  "]);
  assert.deepEqual(out, ["adjacent topic a", "other domain"]);
});

test("negativeDomains: returns [] for empty or bad input", () => {
  assert.deepEqual(deriveNegativeDomains([]), []);
  assert.deepEqual(deriveNegativeDomains(null as any), []);
});

// ── validateTargetingCoverage ───────────────────────────────────────────────

test("targetingCoverage: advisory fires listing every empty operator-knowledge field", () => {
  const res = validateTargetingCoverage({});
  assert.equal(res.populatedFields.length, 0);
  assert.ok(res.emptyFields.length >= 5, "all operator-knowledge fields flagged empty");
  assert.ok(res.advisory && res.advisory.includes("operator-knowledge"), "advisory text present");
});

test("targetingCoverage: advisory is null when all fields populated", () => {
  const res = validateTargetingCoverage({
    authoritativeRegistries: ["reg-a"],
    knownDisclosureUrls: ["https://example.test/x"],
    trustedSourceIds: [1],
    documentPriorityUrlPatterns: ["/reports/"],
    dataPatterns: ["\\btoken\\b"],
  });
  assert.equal(res.advisory, null);
  assert.equal(res.emptyFields.length, 0);
});

test("targetingCoverage: partial population reports only the empty ones", () => {
  const res = validateTargetingCoverage({ authoritativeRegistries: ["reg-a"] });
  assert.ok(res.populatedFields.includes("authoritativeRegistries"));
  assert.ok(res.emptyFields.includes("knownDisclosureUrls"));
  assert.ok(res.advisory);
});
