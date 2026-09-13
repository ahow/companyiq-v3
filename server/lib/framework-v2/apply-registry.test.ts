/**
 * Apply-loop guardrail (requirement E).
 *
 * The accept/reject/apply loop only has no silent no-ops if EVERY patch.op the
 * proposer can emit is reachable by a wired handler. This test is the contract
 * between the two modules and is deliberately GENERIC — it enumerates ops
 * structurally from representative inputs and never references any framework,
 * topic, or company.
 *
 * It asserts three things:
 *   1. The ops actually emitted by proposeEditForFlag / proposeMergeForNearDuplicate
 *      for representative inputs are EXACTLY the declared EMITTABLE_PATCH_OPS set
 *      (catches an op added to the proposer but not declared, or vice-versa).
 *   2. Every declared emittable op has an entry in APPLY_HANDLED_OPS (catches an
 *      op with no wired handler — the silent no-op we are guarding against).
 *   3. Every op whose handler kind is "batch_regenerate" has at least one
 *      BATCH_REGENERATORS key of the form "<op>::<path>" (catches a batch op
 *      declared handled but with no regenerator function behind it).
 *
 * Run with:  npx tsx --test server/lib/framework-v2/apply-registry.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  proposeEditForFlag,
  proposeMergeForNearDuplicate,
  proposeSynonymAddition,
  proposeAdjacentTopics,
  proposeAnchorFrameworks,
  FRAMEWORK_SENTINEL,
  FRAMEWORK_LEVEL_OPS,
  EMITTABLE_PATCH_OPS,
} from "./edit-proposer.js";
import { APPLY_HANDLED_OPS, BATCH_REGENERATORS } from "./edit-applier.js";
import type { Flag } from "./test-drive.js";

function flag(rule: string, extra: Partial<Flag> = {}): Flag {
  return {
    measureId: "m",
    rule,
    severity: "warning",
    message: `${rule}`,
    suggestedFix: "n/a",
    ...extra,
  };
}

// Representative (measure, flag) inputs that between them exercise EVERY branch
// of proposeEditForFlag, plus the near-duplicate proposer. Chosen structurally
// from the proposer's branch conditions, not from any real framework content.
const flagCases: Array<{ flag: Flag; measure: any }> = [
  // too-narrow WITH a fallback clause → op "replace" (broaden-fallback)
  { flag: flag("too-narrow"), measure: { fallback_yes_criterion: "requires all of A and B" } },
  // too-narrow WITHOUT a fallback → op "regenerate_examples" (positive)
  { flag: flag("off-expected-narrow"), measure: {} },
  // too-broad with <3 negative examples → op "regenerate_examples" (negative)
  { flag: flag("too-broad"), measure: { negative_examples: [] } },
  // too-broad with >=3 negative examples → op "tighten_definition"
  { flag: flag("off-expected-broad"), measure: { negative_examples: ["a", "b", "c"], substantive_definition: "d" } },
  // heavy flipping → op "replace" (min_quote_context_chars)
  { flag: flag("r33-heavy-flipping"), measure: { min_quote_context_chars: 120 } },
  // adjacent-topic contamination → op "append_exclusion"
  { flag: flag("adjacent-topic-contamination"), measure: { substantive_definition: "d" } },
  // residual instability → op "rewrite_countable"
  { flag: flag("residual-instability", { flipRate: 0.5 }), measure: { substantive_definition: "d" } },
  // no differentiation → op "broaden_or_redefine"
  { flag: flag("no-differentiation"), measure: { substantive_definition: "d" } },
];

test("E1: emitted patch.op set exactly matches declared EMITTABLE_PATCH_OPS", () => {
  const emitted = new Set<string>();
  for (const c of flagCases) {
    const p = proposeEditForFlag(c.flag, c.measure);
    assert.ok(p, `expected a proposal for rule '${c.flag.rule}'`);
    assert.ok(p!.patch && typeof p!.patch.op === "string", `proposal for '${c.flag.rule}' must carry patch.op`);
    emitted.add(p!.patch.op);
  }
  // Near-duplicate pairs come from the quality-metrics list, not the flag stream.
  emitted.add(
    proposeMergeForNearDuplicate({
      measureIdA: "a",
      measureIdB: "b",
      labelA: "A",
      labelB: "B",
      agreement: 0.95,
      kappa: 0.9,
      n: 20,
    }).patch.op,
  );

  // Framework-level builders emit their own ops. Fed a non-empty candidate pool
  // and the current registered list, each returns exactly one proposal. Values
  // are placeholders — the op set is what E1 checks, and it is topic-agnostic.
  for (const p of [
    proposeSynonymAddition(["x"], []),
    proposeAdjacentTopics(["y"], [], 2),
    proposeAnchorFrameworks(["z"], []),
  ]) {
    assert.ok(p, "framework-level builder must return a proposal for a non-empty pool");
    assert.ok(p!.patch && typeof p!.patch.op === "string", "framework-level proposal must carry patch.op");
    emitted.add(p!.patch.op);
  }

  assert.deepEqual(
    [...emitted].sort(),
    [...EMITTABLE_PATCH_OPS].sort(),
    "ops emitted by the proposer must exactly match the declared EMITTABLE_PATCH_OPS",
  );
});

test("E2: every emittable op has a wired handler in APPLY_HANDLED_OPS", () => {
  for (const op of EMITTABLE_PATCH_OPS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(APPLY_HANDLED_OPS, op),
      `patch.op '${op}' is emitted by the proposer but has no wired handler (silent no-op)`,
    );
  }
});

test("E3: every batch_regenerate op has at least one BATCH_REGENERATORS entry", () => {
  const batchKeys = Object.keys(BATCH_REGENERATORS);
  for (const [op, kind] of Object.entries(APPLY_HANDLED_OPS)) {
    if (kind !== "batch_regenerate") continue;
    const hasRegenerator = batchKeys.some((k) => k.startsWith(`${op}::`));
    assert.ok(
      hasRegenerator,
      `op '${op}' is handled as batch_regenerate but no BATCH_REGENERATORS key starts with '${op}::'`,
    );
  }
});

// ─── Framework-level builders (PART A + PART B) ────────────────────────────

test("E4: framework-level builders emit sentinel-scoped, additive proposals", () => {
  const syn = proposeSynonymAddition(["Alpha", "beta"], ["gamma"]);
  const adj = proposeAdjacentTopics(["neighbouring area"], [], 3);
  const anc = proposeAnchorFrameworks(["Some Standard v1"], ["Existing Std"]);

  for (const p of [syn, adj, anc]) {
    assert.ok(p, "builder must return a proposal for a non-empty pool");
    // Framework-scoped: sentinel measureId, flagRule === cause (identity uniqueness).
    assert.equal(p!.measureId, FRAMEWORK_SENTINEL, "framework-level proposals carry the sentinel measureId");
    assert.equal(p!.flagRule, p!.cause, "flagRule must equal cause so identity resolves per framework-level type");
    // Additive: patch.value is a non-empty array aggregated into ONE proposal.
    assert.ok(Array.isArray(p!.patch.value) && p!.patch.value.length > 0, "patch.value is a non-empty array");
    assert.ok(FRAMEWORK_LEVEL_OPS.includes(p!.patch.op), "op must be a framework-level op");
    assert.equal(p!.patch.path, p!.fieldPath, "patch.path must match fieldPath (the jsonb column)");
  }

  // Values are de-duplicated (case-insensitive) and trimmed.
  const dup = proposeSynonymAddition([" x ", "X", "x", "y"], []);
  assert.deepEqual(dup!.patch.value, ["x", "y"], "builder de-dupes and trims the candidate pool");
});

test("E5: framework-level builders return null on an empty candidate pool", () => {
  assert.equal(proposeSynonymAddition([], ["a"]), null);
  assert.equal(proposeAdjacentTopics([], [], 5), null);
  assert.equal(proposeAnchorFrameworks(["   ", ""], []), null, "whitespace-only candidates count as empty");
});

test("E6: every framework-level op is handled as direct_replace (no LLM on apply)", () => {
  for (const op of FRAMEWORK_LEVEL_OPS) {
    assert.ok(EMITTABLE_PATCH_OPS.includes(op), `framework-level op '${op}' must be declared emittable`);
    assert.equal(
      APPLY_HANDLED_OPS[op],
      "direct_replace",
      `framework-level op '${op}' must apply as a direct jsonb append, not a batch regeneration`,
    );
  }
});
