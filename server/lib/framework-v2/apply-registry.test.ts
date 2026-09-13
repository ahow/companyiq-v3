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
