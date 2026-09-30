/**
 * Issue 8 — instruction-reconciliation ledger (operator-triggered spec).
 *
 * Verifies the ledger closes both holes in the old detectUnappliedEditClaim
 * guardrail:
 *   - the line-190 short-circuit (any action ⇒ no warning), and
 *   - the completion-verb dependency (neutral prose ⇒ no warning).
 *
 * All fixtures are synthetic strings — no LLM, no DB — and topic-agnostic
 * (generic "set field X to Y" shapes, no subject vocabulary).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractActionsFromReply,
  parseIntentManifest,
  reconcileInstructions,
  countImperativeInstructionClauses,
  detectCountParityDeficit,
  type ExtractedAction,
} from "./improvement-chat.js";

function action(type: ExtractedAction["type"], attrs: Record<string, string> = {}): ExtractedAction {
  return { type, attrs };
}

// ─── parseIntentManifest ─────────────────────────────────────────────────────

test("parseIntentManifest extracts one entry per <intent> block", () => {
  const text =
    'Here is what I understood.\n' +
    '<intent summary="set field A on measure 1.1" measure="1.1" field="substantive_definition" />\n' +
    '<intent summary="lower expected rate on 1.2" measure="1.2" field="expected_yes_rate" />';
  const intents = parseIntentManifest(text);
  assert.equal(intents.length, 2);
  assert.equal(intents[0].measure, "1.1");
  assert.equal(intents[0].field, "substantive_definition");
  assert.equal(intents[1].summary, "lower expected rate on 1.2");
});

test("parseIntentManifest ignores intents with no summary", () => {
  assert.equal(parseIntentManifest('<intent measure="1.1" />').length, 0);
});

// ─── reconcileInstructions ───────────────────────────────────────────────────

test("multi-instruction, partial emit → N-1 unimplemented (line-190 hole)", () => {
  const intents = parseIntentManifest(
    '<intent summary="edit 1.1" measure="1.1" />' +
      '<intent summary="edit 1.2" measure="1.2" />' +
      '<intent summary="edit 1.3" measure="1.3" />',
  );
  const actions = [action("apply_custom_edit", { measure: "1.1", field: "substantive_definition" })];
  const ledger = reconcileInstructions(intents, actions);
  const unimplemented = ledger.entries.filter((e) => e.status === "unimplemented");
  assert.equal(unimplemented.length, 2, "two of three intents had no action");
  assert.equal(ledger.manifestAbsent, false);
});

test("clean turn → intent count == action count → zero unimplemented", () => {
  const intents = parseIntentManifest(
    '<intent summary="edit 1.1" measure="1.1" /><intent summary="edit 1.2" measure="1.2" />',
  );
  const actions = [
    action("apply_custom_edit", { measure: "1.1" }),
    action("apply_custom_edit", { measure: "1.2" }),
  ];
  const ledger = reconcileInstructions(intents, actions);
  assert.equal(ledger.entries.filter((e) => e.status === "unimplemented").length, 0);
});

test("measure-id match is preferred over position", () => {
  const intents = parseIntentManifest(
    '<intent summary="edit 2.2" measure="2.2" /><intent summary="edit 1.1" measure="1.1" />',
  );
  // Actions emitted in the opposite order — id match must still pair correctly.
  const actions = [
    action("apply_custom_edit", { measure: "1.1" }),
    action("apply_custom_edit", { measure: "2.2" }),
  ];
  const ledger = reconcileInstructions(intents, actions);
  assert.equal(ledger.entries.every((e) => e.status === "implemented"), true);
});

// ─── end-to-end via extractActionsFromReply ──────────────────────────────────

test("neutral prose + intent + no action → still flagged (claim-phrase hole)", () => {
  // No first-person completion verb anywhere; the old heuristic would stay silent.
  const reply =
    "That measure could be tightened to require a named committee.\n" +
    '<intent summary="tighten measure 1.4 definition" measure="1.4" field="substantive_definition" />';
  const out = extractActionsFromReply(reply);
  assert.equal(out.actions.length, 0);
  assert.equal(out.unimplementedInstructions.length, 1);
  assert.equal(out.instructionLedger.manifestAbsent, false);
});

test("intent + action pair → no unimplemented, action still returned", () => {
  const reply =
    "Applying that now.\n" +
    '<action type="apply_custom_edit" measure="1.5" field="fallback_yes_criterion" instruction="broaden to accept a dated review" />\n' +
    '<intent summary="broaden fallback on 1.5" measure="1.5" field="fallback_yes_criterion" />';
  const out = extractActionsFromReply(reply);
  assert.equal(out.actions.length, 1);
  assert.equal(out.unimplementedInstructions.length, 0);
  // display text must not leak the structured blocks
  assert.equal(/<action|<intent/.test(out.displayText), false);
});

// ─── count-parity backstop (manifest absent) ─────────────────────────────────

test("countImperativeInstructionClauses splits on conjunctions and list markers", () => {
  assert.equal(countImperativeInstructionClauses("set field A to X and lower rate on 1.2"), 2);
  assert.equal(
    countImperativeInstructionClauses("1. set field A to X\n2. lower rate on 1.2\n3. add an example"),
    3,
  );
  assert.equal(countImperativeInstructionClauses("just one change here"), 1);
  assert.equal(countImperativeInstructionClauses(""), 0);
});

test("detectCountParityDeficit fires when clauses exceed actions", () => {
  const w = detectCountParityDeficit("set field A to X and lower rate on 1.2", 1);
  assert.ok(w, "expected a deficit advisory");
  assert.match(w!, /2 instruction/);
});

test("detectCountParityDeficit stays silent at parity or for a single clause", () => {
  assert.equal(detectCountParityDeficit("set field A to X and lower rate on 1.2", 2), null);
  assert.equal(detectCountParityDeficit("just one change", 0), null);
});

test("manifest-absent reply routes to the count-parity backstop, not the ledger", () => {
  const reply = "I could make those changes if you confirm the target measures.";
  const out = extractActionsFromReply(reply);
  assert.equal(out.instructionLedger.manifestAbsent, true);
  assert.equal(out.unimplementedInstructions.length, 0);
});
