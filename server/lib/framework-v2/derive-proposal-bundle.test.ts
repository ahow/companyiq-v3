/**
 * Regression test for the FBv2 apply-path proposal-derivation divergence.
 *
 * The GET /v2/test-drive/results (READ) path used to pass the multi-run
 * iteration history to analyseTestDrive while the POST /v2/improvement/apply
 * (WRITE) path re-derived WITHOUT it. Multi-run-only proposals — chiefly
 * residual-instability — were therefore present in the results view the user
 * accepted from, but ABSENT from the apply-time bundle, so every accepted one
 * was skipped as "proposal no longer present (flag no longer fires after
 * rescore)".
 *
 * deriveProposalBundle() is the single shared derivation both endpoints now
 * call. This test drives it with a mock db whose iteration snapshots show a
 * measure flipping run-to-run, and asserts:
 *   1. the shared bundle surfaces the residual-instability flag AND a proposal
 *      for it (so the apply path — which resolves accepted proposals against
 *      this same bundle — can now find it), and
 *   2. the OLD lean apply derivation (analyseTestDrive with NO multi-run) does
 *      NOT surface it — demonstrating exactly the divergence this closes.
 *
 * Run with: npx tsx --test server/lib/framework-v2/derive-proposal-bundle.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveProposalBundle, type DbLike } from "./derive-proposal-bundle.js";
import { analyseTestDrive } from "./test-drive.js";
import { proposeEditsForFlags } from "./edit-proposer.js";

/**
 * Mock db handle: deriveProposalBundle issues exactly four SELECTs in a fixed
 * order — measure_scores, framework_measures, company_lists (labels),
 * framework_v2_iterations. We return canned rows positionally.
 */
function mockDb(rowsInOrder: any[][]): DbLike {
  let call = 0;
  return {
    async execute() {
      const rows = rowsInOrder[call] ?? [];
      call += 1;
      return { rows };
    },
  };
}

// One measure (m1), three companies, each with evidence quotes (NOT sparse).
const scoreRows = [
  { company_id: 1, company_name: "Company 1", measure_id: "m1", verdict: "Yes", confidence: "Medium", quotes: ["q"], verdict_nuance: "", score: 1 },
  { company_id: 2, company_name: "Company 2", measure_id: "m1", verdict: "No", confidence: "Medium", quotes: ["q"], verdict_nuance: "", score: 0 },
  { company_id: 3, company_name: "Company 3", measure_id: "m1", verdict: "Partial", confidence: "Medium", quotes: ["q"], verdict_nuance: "", score: 0.5 },
];

const measureRows = [
  {
    measure_id: "m1",
    expected_yes_rate: 0.35,
    title: "Measure One",
    category: "Pillar A",
    substantive_definition: "Does the company do the thing to a meaningful degree?",
    fallback_yes_criterion: "any mention",
    positive_examples: [],
    negative_examples: [],
    min_quote_context_chars: 100,
  },
];

// Two iteration snapshots of the SAME sample. Company 1's m1 verdict flips
// Yes -> No between runs => residual-instability on m1. Shape mirrors what the
// results endpoint stores: per_measure[measureId].verdictsByCompany.
const iterationRows = [
  { iteration_number: 1, per_measure: { m1: { verdictsByCompany: { "1": "Yes", "2": "No", "3": "Partial" } } } },
  { iteration_number: 2, per_measure: { m1: { verdictsByCompany: { "1": "No", "2": "No", "3": "Partial" } } } },
];

test("deriveProposalBundle surfaces a multi-run residual-instability proposal that the lean (no multi-run) derivation drops", async () => {
  const db = mockDb([
    scoreRows, // 1. measure_scores
    measureRows, // 2. framework_measures
    [], // 3. company_lists labels (none -> inferred)
    iterationRows, // 4. framework_v2_iterations
  ]);

  const bundle = await deriveProposalBundle(db, 999, 888, 777);

  // 1. The shared bundle (used by BOTH endpoints) surfaces the multi-run flag...
  const flag = bundle.report.flags.find(
    (f: any) => f.rule === "residual-instability" && f.measureId === "m1",
  );
  assert.ok(flag, "expected residual-instability flag on m1 in the shared bundle");

  // ...and a proposal derived from it, so the apply path can resolve an accepted
  // residual-instability proposal against this bundle.
  const proposal = bundle.edits.proposals.find((p) => p.flagRule === "residual-instability" && p.measureId === "m1");
  assert.ok(proposal, "expected a residual-instability proposal in bundle.edits.proposals");
  // allProposals (edit proposals first, near-dup merges appended) must contain it too.
  assert.ok(
    bundle.allProposals.some((p) => p.flagRule === "residual-instability" && p.measureId === "m1"),
    "expected the residual-instability proposal in bundle.allProposals (the apply-path resolution list)",
  );

  // 2. The OLD lean apply derivation (no multi-run) would NOT surface it — this
  //    is exactly the divergence deriveProposalBundle closes.
  const leanReport = analyseTestDrive(bundle.results, bundle.measureMetadata);
  assert.ok(
    !leanReport.flags.some((f: any) => f.rule === "residual-instability"),
    "control: without multi-run, no residual-instability flag fires",
  );
  const leanEdits = proposeEditsForFlags(leanReport.flags || [], bundle.measuresById);
  assert.ok(
    !leanEdits.proposals.some((p) => p.flagRule === "residual-instability"),
    "control: without multi-run, the residual-instability proposal is absent (the pre-fix apply bug)",
  );
});

test("deriveProposalBundle edit-proposal prefix of allProposals is byte-stable for positional P<idx> resolution", async () => {
  const db = mockDb([scoreRows, measureRows, [], iterationRows]);
  const bundle = await deriveProposalBundle(db, 999, 888, 777);
  // allProposals must begin with exactly edits.proposals (near-dup merges appended
  // AFTER), so legacy positional P<idx> indices still address edit proposals.
  for (let i = 0; i < bundle.edits.proposals.length; i++) {
    assert.equal(bundle.allProposals[i], bundle.edits.proposals[i]);
  }
});
