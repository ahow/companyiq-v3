/**
 * Unit tests for the edit proposer — Phase 0 / B6.1 de-duplication.
 *
 * A single measure can carry more than one flag that routes to the SAME edit
 * (e.g. both "too-broad" and "off-expected-broad" produce an identical
 * add-negative-examples / tighten-definition proposal). proposeEditsForFlags
 * must collapse genuinely-identical proposals so surfaced counts are honest,
 * while still reporting the raw flag count in totalFlags.
 *
 * Run with:  npx tsx --test server/lib/framework-v2/edit-proposer.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { proposeEditsForFlags } from "./edit-proposer.js";
import type { Flag } from "./test-drive.js";

function flag(measureId: string, rule: string): Flag {
  return {
    measureId,
    rule,
    severity: "warning",
    message: `${rule} on ${measureId}`,
    suggestedFix: "n/a",
  };
}

// A measure with fewer than 3 negative examples: both broad flags route to the
// add-negative-examples branch → byte-identical proposals.
const measuresById: Record<string, any> = {
  "2.1": { measureId: "2.1", negative_examples: [], substantive_definition: "def" },
  "2.2": { measureId: "2.2", negative_examples: [], substantive_definition: "def" },
};

test("B6.1: duplicate broad flags on one measure collapse to a single proposal", () => {
  const flags = [flag("2.1", "too-broad"), flag("2.1", "off-expected-broad")];
  const bundle = proposeEditsForFlags(flags, measuresById);

  // Two flags, but one deduplicated proposal.
  assert.equal(bundle.proposals.length, 1, "identical proposals should collapse to one");
  assert.equal(bundle.totalWithProposals, 1, "totalWithProposals reflects deduped set");
  // totalFlags stays the RAW flag count (flags and proposals are not 1:1).
  assert.equal(bundle.totalFlags, 2, "totalFlags reports raw flag count");
  // causeBreakdown counts the deduped proposal once.
  const cause = bundle.proposals[0].cause;
  assert.equal(bundle.causeBreakdown[cause], 1, "causeBreakdown counts deduped proposal once");
});

test("B6.1: identical proposals on DIFFERENT measures are NOT collapsed", () => {
  const flags = [flag("2.1", "too-broad"), flag("2.2", "too-broad")];
  const bundle = proposeEditsForFlags(flags, measuresById);

  assert.equal(bundle.proposals.length, 2, "distinct measures keep distinct proposals");
  assert.equal(bundle.totalWithProposals, 2);
  assert.equal(bundle.totalFlags, 2);
});

test("B6.1: a single broad flag still yields exactly one proposal (no regression)", () => {
  const bundle = proposeEditsForFlags([flag("2.1", "too-broad")], measuresById);
  assert.equal(bundle.proposals.length, 1);
  assert.equal(bundle.totalWithProposals, 1);
  assert.equal(bundle.totalFlags, 1);
});
