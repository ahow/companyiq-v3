import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProposalByIdentity } from "./proposal-identity.js";

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
