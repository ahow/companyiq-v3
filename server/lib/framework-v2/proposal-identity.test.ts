import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProposalByIdentity,
  proposalKeyFromProposal,
  proposalKeyFromEditRow,
  proposalIdentityKeyParts,
} from "./proposal-identity.js";

// Minimal proposal shape for identity resolution.
function p(measureId: string, flagRule: string, op: string, path: string) {
  return { measureId, flagRule, patch: { op, path, value: "x" } };
}

// A realistic bundle spanning multiple measures / rules / patch ops.
const BUNDLE = [
  p("m-alpha", "too-narrow", "replace", "/fallback_yes_criterion"),
  p("m-beta", "too-narrow", "append", "/positive_examples"),
  p("m-gamma", "off-expected-high", "replace", "/min_quote_context_chars"),
  p("m-alpha", "off-expected-narrow", "replace", "/fallback_yes_criterion"),
];

test("matches by identity, not by position (reordered bundle)", () => {
  // Client accepted m-gamma at some index; server re-derived bundle is reordered.
  const reordered = [BUNDLE[3], BUNDLE[2], BUNDLE[0], BUNDLE[1]];
  const r = resolveProposalByIdentity(reordered, {
    measure: "m-gamma",
    flagRule: "off-expected-high",
    op: "replace",
    path: "/min_quote_context_chars",
    proposal: "P1", // stale positional label points at the wrong proposal now
  });
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.proposal.measureId, "m-gamma");
});

test("never mis-maps to a wrong measure when position is stale", () => {
  // Positional index 0 in the re-derived bundle is m-alpha, but identity is m-beta.
  const r = resolveProposalByIdentity(BUNDLE, {
    measure: "m-beta",
    flagRule: "too-narrow",
    op: "append",
    path: "/positive_examples",
    proposal: "P1",
  });
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.proposal.measureId, "m-beta");
});

test("exact tuple disambiguates two proposals for the same measure", () => {
  // m-alpha has two proposals differing only by flagRule/path.
  const r = resolveProposalByIdentity(BUNDLE, {
    measure: "m-alpha",
    flagRule: "off-expected-narrow",
    op: "replace",
    path: "/fallback_yes_criterion",
    proposal: "P4",
  });
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.proposal.flagRule, "off-expected-narrow");
});

test("genuinely absent proposal (flag no longer fires) → absent", () => {
  // Shorter re-derived bundle no longer contains m-gamma's proposal.
  const shorter = [BUNDLE[0], BUNDLE[1]];
  const r = resolveProposalByIdentity(shorter, {
    measure: "m-gamma",
    flagRule: "off-expected-high",
    op: "replace",
    path: "/min_quote_context_chars",
    proposal: "P3",
  });
  assert.equal(r.status, "absent");
});

test("older client (measure+flagRule only, no op/path) → single match resolves", () => {
  const r = resolveProposalByIdentity(BUNDLE, {
    measure: "m-beta",
    flagRule: "too-narrow",
    proposal: "P2",
  });
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.proposal.measureId, "m-beta");
});

test("older client with ambiguous measure+flagRule → ambiguous (not mis-applied)", () => {
  // Two proposals share measure+rule; without op/path we cannot disambiguate.
  const ambiguousBundle = [
    p("m-delta", "too-narrow", "replace", "/fallback_yes_criterion"),
    p("m-delta", "too-narrow", "append", "/positive_examples"),
  ];
  const r = resolveProposalByIdentity(ambiguousBundle, {
    measure: "m-delta",
    flagRule: "too-narrow",
    proposal: "P1",
  });
  assert.equal(r.status, "ambiguous");
});

test("fully old client (only positional proposal, no identity) → no-identity", () => {
  const r = resolveProposalByIdentity(BUNDLE, { proposal: "P2" });
  assert.equal(r.status, "no-identity");
});

test("no attrs at all → no-identity", () => {
  const r = resolveProposalByIdentity(BUNDLE, undefined);
  assert.equal(r.status, "no-identity");
});

test("op/path sent but no measure+rule+op/path proposal exists → absent (never wrong match)", () => {
  // measure exists but the specific op/path tuple does not.
  const r = resolveProposalByIdentity(BUNDLE, {
    measure: "m-alpha",
    flagRule: "too-narrow",
    op: "append",
    path: "/does_not_exist",
    proposal: "P1",
  });
  assert.equal(r.status, "absent");
});

// ─── Shared resolved-proposal identity key (suppression invariant) ──────────
//
// deriveProposalBundle suppresses a proposal iff a persisted measure_edits row
// (applied OR dismissed) keys to the SAME string. These tests pin the ONE
// invariant that keeps that correct: a derived proposal and the audit row the
// apply/dismiss loop writes for it MUST produce an identical key.

test("proposal key and its persisted edit-row key are identical", () => {
  // Apply/dismiss records field = patch.path, op = patch.op (see the apply loop).
  const prop = p("m-alpha", "too-narrow", "replace", "/fallback_yes_criterion");
  const row = { measure_id: "m-alpha", field: "/fallback_yes_criterion", op: "replace" };
  assert.equal(proposalKeyFromProposal(prop), proposalKeyFromEditRow(row));
});

test("key ignores flagRule: a second flag targeting the same field+op is the same resolved edit", () => {
  const a = p("m-alpha", "too-narrow", "replace", "/fallback_yes_criterion");
  const b = p("m-alpha", "off-expected-narrow", "replace", "/fallback_yes_criterion");
  assert.equal(proposalKeyFromProposal(a), proposalKeyFromProposal(b));
});

test("key distinguishes different measure / field / op", () => {
  const base = p("m-alpha", "too-narrow", "replace", "/fallback_yes_criterion");
  const diffMeasure = p("m-beta", "too-narrow", "replace", "/fallback_yes_criterion");
  const diffField = p("m-alpha", "too-narrow", "replace", "/positive_examples");
  const diffOp = p("m-alpha", "too-narrow", "append", "/fallback_yes_criterion");
  const k = proposalKeyFromProposal(base);
  assert.notEqual(k, proposalKeyFromProposal(diffMeasure));
  assert.notEqual(k, proposalKeyFromProposal(diffField));
  assert.notEqual(k, proposalKeyFromProposal(diffOp));
});

test("proposal key falls back to fieldPath when patch.path is absent", () => {
  const prop = { measureId: "m-alpha", fieldPath: "/substantive_definition", patch: { op: "tighten_definition" } };
  const row = { measure_id: "m-alpha", field: "/substantive_definition", op: "tighten_definition" };
  assert.equal(proposalKeyFromProposal(prop), proposalKeyFromEditRow(row));
});

test("near-duplicate proposal keys match a dismiss audit row", () => {
  // Near-dup: measureId = measureIdA, patch.op merge_or_differentiate, path substantive_definition.
  const prop = { measureId: "m-alpha", flagRule: "near-duplication", patch: { op: "merge_or_differentiate", path: "substantive_definition" } };
  const dismissRow = { measure_id: "m-alpha", field: "substantive_definition", op: "merge_or_differentiate" };
  assert.equal(proposalKeyFromProposal(prop), proposalKeyFromEditRow(dismissRow));
});

test("edit-row key accepts both snake_case and camelCase measure id", () => {
  assert.equal(
    proposalKeyFromEditRow({ measure_id: "m-alpha", field: "f", op: "replace" }),
    proposalKeyFromEditRow({ measureId: "m-alpha", field: "f", op: "replace" }),
  );
});

test("key parts are trimmed and null/undefined-safe", () => {
  // Trimming: padded parts key identically to their trimmed form.
  assert.equal(
    proposalIdentityKeyParts({ measureId: " m-alpha ", field: " f ", op: " replace " }),
    proposalIdentityKeyParts({ measureId: "m-alpha", field: "f", op: "replace" }),
  );
  // Three empty parts joined by "::" → two separators → "::::".
  assert.equal(proposalIdentityKeyParts({}), "::::");
  // null/undefined normalise to empty parts (no throw).
  assert.equal(
    proposalIdentityKeyParts({ measureId: null, field: undefined, op: "replace" }),
    "::::replace",
  );
});
