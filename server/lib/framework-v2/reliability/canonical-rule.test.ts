// Canonical-rule tests (pure, DB-free).
// Run: DATABASE_URL=dummy npx tsx --test server/lib/framework-v2/reliability/canonical-rule.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonicalRule,
  evaluateCanonicalRule,
  decomposeYesBar,
  clauseIdsFor,
} from "./canonical-rule.js";
import type { StructuredFacts } from "./schemas.js";

// ── buildCanonicalRule precedence / provenance ────────────────────────────────

test("substantive criterion wins precedence over a strict fallback", () => {
  // Reviewer counterexample 1.1: substantive says a named strategy + substantive
  // content; the strict fallback additionally demands two attribution tokens.
  const measure = {
    measureId: "1.1-ai-strategy-published",
    substantiveDefinition: "A named AI strategy is disclosed with substantive content describing its focus areas.",
    fallbackYesCriterion: "Requires at least two attribution constructions such as 'we published' and 'the Board approved'.",
  };
  const rule = buildCanonicalRule(measure);
  assert.equal(rule.sourceField, "substantiveDefinition", "substantive field is the precedence winner");
  assert.equal(rule.provenance, "substantive");
  assert.equal(rule.flaggedForReview, false, "substantive-derived rule is NOT flagged for review");
  // The strict fallback's 'two attribution tokens' bar must NOT be a required clause.
  const joined = rule.requiredClauses.join(" ").toLowerCase();
  assert.ok(!/two attribution/.test(joined), "fallback's two-attribution requirement did not become canonical");
});

test("fallback-only measure is flagged for review, never silently authoritative", () => {
  const measure = {
    measureId: "x.fallback-only",
    fallbackYesCriterion: "Requires two named artefacts and a dated board approval.",
  };
  const rule = buildCanonicalRule(measure);
  assert.equal(rule.sourceField, "fallbackYesCriterion");
  assert.equal(rule.provenance, "fallback-derived");
  assert.equal(rule.flaggedForReview, true, "a strict-fallback-only rule must be flagged for human review");
});

test("rule carries stable identity, version and an evidence binding", () => {
  const rule = buildCanonicalRule({ measureId: "m1", substantiveDefinition: "A discloses X." });
  assert.equal(rule.ruleId, "canon:m1");
  assert.equal(typeof rule.ruleVersion, "number");
  assert.equal(rule.evidenceBindings.length, 1);
  assert.equal(rule.evidenceBindings[0].measureId, "m1");
  assert.match(rule.evidenceBindings[0].contentHash, /^[0-9a-f]{16}$/);
  // Deterministic: same measure ⇒ same hash.
  const rule2 = buildCanonicalRule({ measureId: "m1", substantiveDefinition: "A discloses X." });
  assert.equal(rule.evidenceBindings[0].contentHash, rule2.evidenceBindings[0].contentHash);
});

// ── decomposition ─────────────────────────────────────────────────────────────

test("decomposeYesBar separates required, OR, exclusion and threshold clauses", () => {
  const d = decomposeYesBar(
    "The entity names a strategy and describes substantive content. It must not merely mention the topic. Either the CEO or the Board endorses it. Requires at least two named functions.",
  );
  assert.ok(d.requiredClauses.length >= 1, "has required clauses");
  assert.ok(d.exclusions.length >= 1, "captured the 'must not merely mention' exclusion");
  assert.ok(d.orAlternatives.length >= 1, "captured the CEO/Board OR-group");
  assert.ok(d.thresholds.length >= 1, "captured the 'at least two' threshold");
  assert.equal(d.thresholds[0].operator, ">=");
  assert.equal(d.thresholds[0].value, 2);
});

// ── evaluateCanonicalRule three-valued logic ──────────────────────────────────

function factsFor(rule: ReturnType<typeof buildCanonicalRule>, presence: Record<string, boolean | "unknown">, measurements?: Record<string, number | string>): StructuredFacts {
  return { clausePresence: presence, measurements };
}

test("evaluate: all required facts true ⇒ pass (1.1 passes under substantive bar)", () => {
  const rule = buildCanonicalRule({
    measureId: "1.1-ai-strategy-published",
    substantiveDefinition: "A named AI strategy is disclosed with substantive content.",
    fallbackYesCriterion: "Requires at least two attribution constructions.",
  });
  const ids = clauseIdsFor(rule);
  const presence: Record<string, boolean | "unknown"> = {};
  ids.required.forEach((id) => (presence[id] = true));
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.equal(res.status, "pass", "the named-strategy positive example passes the substantive bar");
});

test("evaluate: a definitely-false required clause ⇒ fail", () => {
  const rule = buildCanonicalRule({ measureId: "m", substantiveDefinition: "A discloses X. B discloses Y." });
  const ids = clauseIdsFor(rule);
  const presence: Record<string, boolean | "unknown"> = {};
  ids.required.forEach((id, i) => (presence[id] = i === 0 ? true : false));
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.equal(res.status, "fail");
});

test("evaluate: a missing fact ⇒ unknown-review-required, never a false certainty", () => {
  const rule = buildCanonicalRule({ measureId: "m", substantiveDefinition: "A discloses X. B discloses Y." });
  const ids = clauseIdsFor(rule);
  const presence: Record<string, boolean | "unknown"> = {};
  presence[ids.required[0]] = true; // leave the rest unknown
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.equal(res.status, "unknown-review-required");
});

test("evaluate: OR-group passes when any alternative is true", () => {
  const rule = buildCanonicalRule({
    measureId: "m",
    substantiveDefinition: "Either the CEO or the Board endorses the strategy.",
  });
  const ids = clauseIdsFor(rule);
  assert.ok(ids.orGroups.length >= 1, "an OR-group was produced");
  const presence: Record<string, boolean | "unknown"> = {};
  // required clauses (if any) true; first alternative true, second false.
  ids.required.forEach((id) => (presence[id] = true));
  const g = ids.orGroups[0];
  presence[g[0]] = true;
  presence[g[1]] = false;
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.equal(res.status, "pass", "OR-group is satisfied by one true alternative");
});

test("evaluate: exclusion present ⇒ fail", () => {
  const rule = buildCanonicalRule({
    measureId: "m",
    substantiveDefinition: "A discloses X. It must not merely mention the topic.",
  });
  const ids = clauseIdsFor(rule);
  assert.ok(ids.exclusions.length >= 1, "an exclusion was produced");
  const presence: Record<string, boolean | "unknown"> = {};
  ids.required.forEach((id) => (presence[id] = true));
  ids.exclusions.forEach((id) => (presence[id] = true)); // disqualifier present
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.equal(res.status, "fail", "a present disqualifier forces a fail");
});

test("evaluate: clause trace carries clauseId, expression and factRefs", () => {
  const rule = buildCanonicalRule({ measureId: "m", substantiveDefinition: "A discloses X." });
  const ids = clauseIdsFor(rule);
  const presence: Record<string, boolean | "unknown"> = {};
  ids.required.forEach((id) => (presence[id] = true));
  const res = evaluateCanonicalRule(rule, factsFor(rule, presence));
  assert.ok(res.clauseResults.length >= 1);
  const c = res.clauseResults[0];
  assert.equal(typeof c.clauseId, "string");
  assert.equal(c.expression, "required");
  assert.ok(Array.isArray(c.factRefs));
});
