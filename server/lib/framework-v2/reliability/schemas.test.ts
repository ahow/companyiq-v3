import { test } from "node:test";
import assert from "node:assert/strict";

import {
  carryValidationStateIntoPayload,
  carryValidationStatesIntoPayload,
  type ValidationState,
} from "./schemas.js";

test("INVARIANT: dismissing a failed check does NOT change its status", () => {
  const state: ValidationState = {
    checkId: "chk-1",
    status: "failed",
    dismissedByOperator: true,
  };
  const carried = carryValidationStateIntoPayload(state);
  assert.equal(carried.status, "failed", "status must survive dismissal");
  assert.equal(carried.dismissedByOperator, true);
  assert.equal(carried.requiresAttention, true, "a failed check still requires attention");
});

test("INVARIANT: an operator override does NOT change status", () => {
  const state: ValidationState = {
    checkId: "chk-2",
    status: "failed",
    dismissedByOperator: false,
    operatorOverride: {
      by: "andy",
      at: "2026-01-01T00:00:00Z",
      reason: "accepted risk",
      disposition: "accept-risk",
    },
  };
  const carried = carryValidationStateIntoPayload(state);
  assert.equal(carried.status, "failed", "override annotates but never flips status");
  assert.ok(carried.operatorOverride);
  assert.equal(carried.operatorOverride!.disposition, "accept-risk");
  assert.equal(carried.requiresAttention, true);
});

test("passed check carries through with requiresAttention=false", () => {
  const state: ValidationState = { checkId: "chk-3", status: "passed", dismissedByOperator: false };
  const carried = carryValidationStateIntoPayload(state);
  assert.equal(carried.status, "passed");
  assert.equal(carried.requiresAttention, false);
});

test("unknown-review-required and unresolved both require attention", () => {
  const states: ValidationState[] = [
    { checkId: "a", status: "unknown-review-required", dismissedByOperator: true },
    { checkId: "b", status: "unresolved", dismissedByOperator: false },
  ];
  const carried = carryValidationStatesIntoPayload(states);
  assert.equal(carried[0].requiresAttention, true);
  assert.equal(carried[1].requiresAttention, true);
  // Dismissal on the first did not flip its status.
  assert.equal(carried[0].status, "unknown-review-required");
});
