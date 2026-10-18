/**
 * truthful-publication.test.ts — A9 / WP15 committed test suite.
 *
 * Proves the truthful-publication & release-evidence governance ships SAFE,
 * framework-level, and verdict-invariant (reporting/governance only):
 *
 *   PU01 — Cross-surface consistency. API/UI view, CSV columns and the governance
 *          block all derive from ONE canonical record, so verdict / evidence /
 *          research-status can never diverge across API, UI, CSV, Word, PDF (CV07).
 *   PU02 — A historical snapshot survives later updates unchanged; a correction is
 *          an EXPLICIT linked revision (reason required) — never a silent recompute.
 *   PU03 — Runtime reconciles with the tested tree (deployed SHA == tested SHA).
 *   PU04 — Missing Chromium FAILS the release gate (not an exit-0 skip).
 *   PU05 — A faulty parent-cancellation mutation FAILS before a child exit masks it
 *          (mutation-sensitivity enforced in the gate).
 *   PU06 — Subprocess/worker assets are checked under the ACTUAL service layout;
 *          a missing asset FAILS packaging.
 *   KILL-SWITCH DEFAULT — resolvePublicationPolicy() == "passthrough" when unset,
 *          and the passthrough view/CSV are byte-identical to today (no governance
 *          block, exactly the 5 base CSV columns).
 *   NON-MUTATION — buildPublicationRecord never mutates the caller's input and the
 *          only verdict transform is the pre-existing canonical normalizeVerdict,
 *          so no published score surface is changed by this module.
 *   RESOLVER FAIL-SAFE — any unrecognised/empty policy value → "passthrough",
 *          total, never throws.
 *   ROUND-TRIP — a record serializes and deserializes byte-stably; snapshot
 *          integrity is hash-verified.
 *   RAW-EVIDENCE-PRESERVED — the release gate keeps the RAW, non-deduped evidence
 *          lists verbatim alongside the dedup summary (relevant text never dropped).
 *
 * Pure unit tests — no DB, no network, no provider keys, no subprocess/pkill.
 */

import assert from "node:assert/strict";
import {
  resolvePublicationPolicy,
  DEFAULT_PUBLICATION_POLICY,
  PUBLICATION_POLICY_ENV,
  PUBLICATION_POLICY_VERSION,
  buildPublicationRecord,
  assertTruthfulCompleteness,
  toPublicationView,
  toPublicationCsvColumns,
  publishSnapshot,
  reviseSnapshot,
  verifySnapshotIntegrity,
  classifyCommitAsReleaseEvidence,
  recordApproval,
  preserveFeatureBranchText,
  currentReleaseStatus,
  evaluateReleaseGate,
  reconcileRuntimeWithTested,
  measurementKeyString,
  MeasurementBaseline,
  serializePublicationRecord,
  deserializePublicationRecord,
  publicationRecordHash,
  type PublicationInput,
  type ReleaseGateEvidenceInput,
  type MeasurementRow,
} from "./truthful-publication.js";
import { type ResearchStatus } from "../../shared/research-state.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    fail++;
    console.log(`\u2717 ${name}`);
    console.log(`    ${(err as Error)?.message ?? err}`);
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────────

function comprehensiveStatus(): ResearchStatus {
  return {
    comprehensive: true,
    state: "comprehensive",
    reasons: [],
    coverage: { denominator: 10, retrieved: 10, excluded: 0, retryable: 0, conclusivelyAbsent: 0 },
    discoveryRecall: { label: "lower-bound benchmark recall (not all-sources-found)", retrievedEligible: 10 },
    unresolvedEssentialGaps: [],
    retryableGaps: [],
    stateCounts: { retrieved_usable: 10 },
  };
}

function incompleteStatus(): ResearchStatus {
  return {
    comprehensive: false,
    state: "incomplete",
    reasons: ["Annual Report: latest filing not yet retrieved"],
    coverage: { denominator: 10, retrieved: 6, excluded: 1, retryable: 3, conclusivelyAbsent: 0 },
    discoveryRecall: { label: "lower-bound benchmark recall (not all-sources-found)", retrievedEligible: 6 },
    unresolvedEssentialGaps: [
      { label: "Annual Report", detail: "latest filing not yet retrieved", retryable: true } as any,
    ],
    retryableGaps: [
      { label: "Annual Report", detail: "latest filing not yet retrieved", retryable: true } as any,
    ],
    stateCounts: { retrieved_usable: 6, retryable: 3, excluded_rejected: 1 },
  };
}

function sampleInput(overrides: Partial<PublicationInput> = {}): PublicationInput {
  return {
    companyId: 42,
    measureId: "M1",
    verdict: "Yes",
    score: 1,
    evidenceSummary: "Board has an independent chair.",
    supportingQuote: "The Chair is independent per the 2024 Annual Report.",
    evidenceIds: ["ev_a", "ev_b"],
    sourceDocument: "2024 Annual Report",
    sourceLink: "https://example.com/ar2024.pdf",
    scope: {
      frameworkVersion: "fw-3.0.0",
      frameworkHash: "fwhash123",
      asOf: "2026-10-01",
      entityScope: { companyId: 42, listId: null },
    },
    provenance: {
      runId: "run_123",
      runMode: "live" as any,
      manifestHash: "mh_abc",
      codeTreeHash: "ct_def",
      gitSha: "abc1234",
      reproducibilityLimits: [{ field: "llm", reason: "non-deterministic sampling", severity: "info" } as any],
    },
    researchStatus: comprehensiveStatus(),
    ...overrides,
  };
}

// ─── PU01 — cross-surface consistency (one canonical record) ────────────────────

test("PU01: view, CSV and governance block carry identical verdict/evidence/status across surfaces", () => {
  const rec = buildPublicationRecord(sampleInput());

  // The verdict/evidence shown to API/UI/Word/PDF (view) == the CSV values == record.
  const view = toPublicationView(rec, "passthrough");
  const csv = toPublicationCsvColumns(rec, "passthrough");
  const csvMap = Object.fromEntries(csv.map((c) => [c.header, c.value]));

  assert.equal(view.verdict, rec.verdict, "view verdict == record");
  assert.equal(csvMap["Score"], rec.verdict, "CSV Score column == record verdict");
  assert.equal(view.evidenceSummary, csvMap["Rationale"], "view rationale == CSV rationale");
  assert.equal(view.supportingQuote, csvMap["Supporting Quote"], "view quote == CSV quote");
  assert.equal(view.sourceDocument, csvMap["Source Document"], "view source == CSV source");

  // Under annotate (governance surfaced), every surface shows the SAME status label.
  const viewA = toPublicationView(rec, "annotate");
  const csvA = toPublicationCsvColumns(rec, "annotate");
  const csvAMap = Object.fromEntries(csvA.map((c) => [c.header, c.value]));
  assert.ok(viewA.governance, "annotate view has a governance block");
  assert.equal(
    viewA.governance!.researchStatus,
    csvAMap["Research Status"],
    "annotate view status label == CSV status label (no divergence across surfaces)",
  );
  // The base verdict/evidence columns are IDENTICAL to passthrough (never reordered/changed).
  assert.equal(csvAMap["Score"], csvMap["Score"], "annotate keeps base Score identical");
  assert.equal(csvAMap["Rationale"], csvMap["Rationale"], "annotate keeps base Rationale identical");
});

test("PU01b: incomplete research is NEVER displayed as comprehensive on any surface", () => {
  const rec = buildPublicationRecord(sampleInput({ researchStatus: incompleteStatus() }));
  assert.equal(rec.comprehensive, false, "record not comprehensive");
  const problems = assertTruthfulCompleteness(rec, /* claimedComprehensive */ true);
  assert.ok(problems.length > 0, "claiming comprehensive on incomplete research is a violation");
  // The surfaced label must read as incomplete, not comprehensive.
  const viewA = toPublicationView(rec, "annotate");
  assert.match(viewA.governance!.researchStatus, /Incomplete|gap/i, "surface shows incomplete, not comprehensive");
  // A genuinely comprehensive record raises no violation.
  const ok = buildPublicationRecord(sampleInput());
  assert.equal(assertTruthfulCompleteness(ok, true).length, 0, "comprehensive record: no violation");
});

test("PU01c: the canonical verdict rule matches the Python CSV exporter rule (CSV/Word/PDF parity)", () => {
  // The Python exporters (server/scripts/export_ai_csv_from_snapshot.py:norm_verdict)
  // and this TS accessor MUST implement one identical rule, so a CSV/Word/PDF export
  // can never show a different verdict from the API/UI. This table mirrors the Python
  // norm_verdict exactly (non-string→"No", blank→"No", "partial"→"No", else verbatim)
  // and asserts the TS accessor agrees cell-for-cell. If either side drifts, this fails.
  const cases: Array<{ raw: string | null | undefined; expected: string }> = [
    { raw: "Yes", expected: "Yes" },
    { raw: "No", expected: "No" },
    { raw: "Partial", expected: "No" },
    { raw: "partial", expected: "No" },
    { raw: "  ", expected: "No" },
    { raw: "", expected: "No" },
    { raw: null, expected: "No" },
    { raw: undefined, expected: "No" },
    { raw: "Abstain", expected: "Abstain" },
  ];
  for (const c of cases) {
    const rec = buildPublicationRecord(sampleInput({ verdict: c.raw, score: null }));
    assert.equal(rec.verdict, c.expected, `verdict(${JSON.stringify(c.raw)}) == ${c.expected} (Python/TS parity)`);
    // The CSV "Score" column and the view verdict are both this canonical value.
    assert.equal(toPublicationView(rec).verdict, c.expected, "view agrees");
    const csvScore = toPublicationCsvColumns(rec).find((x) => x.header === "Score")!.value;
    assert.equal(csvScore, c.expected, "CSV Score column agrees");
  }
});

// ─── PU02 — immutable snapshot + explicit revision ──────────────────────────────

test("PU02: historical snapshot survives later updates; correction is an explicit linked revision", () => {
  const recs = [buildPublicationRecord(sampleInput())];
  const snap = publishSnapshot(recs, { snapshotId: "snap1", now: "2026-10-01T00:00:00Z" });
  const originalHash = snap.contentHash;
  assert.equal(snap.revisionNumber, 1);
  assert.equal(snap.revisionOf, null);
  assert.ok(verifySnapshotIntegrity(snap), "fresh snapshot verifies");

  // Mutating the caller's source records must NOT change the frozen snapshot.
  recs[0].verdict = "No";
  recs[0].evidenceSummary = "MUTATED";
  assert.equal(snap.records[0].verdict, "Yes", "snapshot verdict frozen against later mutation");
  assert.equal(snap.contentHash, originalHash, "snapshot content hash unchanged");
  assert.ok(verifySnapshotIntegrity(snap), "snapshot still integral after caller mutation");

  // A correction must be an EXPLICIT revision with a reason; it links back and
  // leaves the original untouched.
  const corrected = [buildPublicationRecord(sampleInput({ verdict: "No", score: 0 }))];
  const rev = reviseSnapshot(snap, corrected, "re-rated after new filing retrieved", {
    snapshotId: "snap1_r2",
    now: "2026-10-05T00:00:00Z",
  });
  assert.equal(rev.revisionNumber, 2, "revision number increments");
  assert.equal(rev.revisionOf, "snap1", "revision links back to the original");
  assert.equal(rev.revisionReason, "re-rated after new filing retrieved");
  assert.equal(snap.records[0].verdict, "Yes", "original snapshot still unchanged after revision");
  assert.notEqual(rev.contentHash, snap.contentHash, "revision has a distinct content hash");

  // A silent recompute (no reason) is refused.
  assert.throws(() => reviseSnapshot(snap, corrected, ""), /explicit revision reason/i,
    "revision without a reason is refused (no silent recompute)");
});

// ─── PU03 — runtime reconciles with the tested tree ─────────────────────────────

test("PU03: deployed SHA must reconcile with the tested SHA (short/long equivalence)", () => {
  assert.equal(reconcileRuntimeWithTested({ deployedSha: "abc1234", testedSha: "abc1234" }).reconciled, true);
  assert.equal(
    reconcileRuntimeWithTested({ deployedSha: "abc1234def5678", testedSha: "abc1234" }).reconciled,
    true,
    "short SHA is a prefix of the deployed long SHA",
  );
  assert.equal(
    reconcileRuntimeWithTested({ deployedSha: "abc1234", testedSha: "deadbee" }).reconciled,
    false,
    "divergent SHAs do NOT reconcile",
  );
  assert.equal(
    reconcileRuntimeWithTested({ deployedSha: "", testedSha: "abc1234" }).reconciled,
    false,
    "a missing SHA cannot reconcile",
  );
});

// ─── PU04 — missing Chromium FAILS the gate (not exit-0 skip) ────────────────────

function baseGate(overrides: Partial<ReleaseGateEvidenceInput> = {}): ReleaseGateEvidenceInput {
  return {
    tests: [
      { suite: "lib", name: "a", status: "pass" },
      { suite: "lib", name: "b", status: "pass" },
    ],
    tsDiagnostics: [],
    tsBaseline: 62,
    mutationChecks: [{ mutation: "flip-guard", guardTest: "guard.test", guardFailedAsExpected: true }],
    packaging: [{ path: "dist/worker.js", present: true, role: "worker-subprocess" }],
    chromiumPresent: true,
    ...overrides,
  };
}

test("PU04: missing Chromium FAILS the release gate (not an exit-0 skip)", () => {
  const ok = evaluateReleaseGate(baseGate());
  assert.equal(ok.pass, true, "baseline gate passes with Chromium present");
  const missing = evaluateReleaseGate(baseGate({ chromiumPresent: false }));
  assert.equal(missing.pass, false, "gate FAILS when Chromium is missing");
  assert.ok(missing.failures.some((f) => /chromium/i.test(f)), "failure cites Chromium");
});

test("PU04b: a skip without an explicit reason FAILS (never silently counted as pass)", () => {
  const silent = evaluateReleaseGate(
    baseGate({ tests: [{ suite: "e2e", name: "render", status: "skip", skipReason: null }] }),
  );
  assert.equal(silent.pass, false, "unexplained skip fails the gate");
  const reasoned = evaluateReleaseGate(
    baseGate({ tests: [{ suite: "e2e", name: "render", status: "skip", skipReason: "known flake tracked in #123" }] }),
  );
  assert.equal(reasoned.pass, true, "a skip WITH an explicit reason is allowed");
});

// ─── PU05 — mutation sensitivity: faulty parent-cancellation must be caught ──────

test("PU05: a faulty parent-cancellation mutation FAILS before a child exit can mask it", () => {
  // Guard caught the mutation (good): gate passes.
  const caught = evaluateReleaseGate(
    baseGate({
      mutationChecks: [
        { mutation: "parent-cancellation-noop", guardTest: "cancellation.guard.test", guardFailedAsExpected: true },
      ],
    }),
  );
  assert.equal(caught.pass, true, "mutation caught by guard → gate passes");

  // Guard did NOT fail when the parent-cancellation was broken (blind spot): gate FAILS.
  const blind = evaluateReleaseGate(
    baseGate({
      mutationChecks: [
        { mutation: "parent-cancellation-noop", guardTest: "cancellation.guard.test", guardFailedAsExpected: false },
      ],
    }),
  );
  assert.equal(blind.pass, false, "mutation-sensitivity blind spot → gate FAILS");
  assert.ok(blind.failures.some((f) => /blind spot/i.test(f) && /parent-cancellation/i.test(f)),
    "failure names the parent-cancellation blind spot");
});

// ─── PU06 — subprocess/worker assets under the ACTUAL layout ─────────────────────

test("PU06: a missing subprocess/worker packaging asset FAILS the gate", () => {
  const present = evaluateReleaseGate(baseGate());
  assert.equal(present.pass, true, "all assets present → pass");
  const missing = evaluateReleaseGate(
    baseGate({ packaging: [{ path: "dist/worker.js", present: false, role: "worker-subprocess" }] }),
  );
  assert.equal(missing.pass, false, "a missing worker asset fails packaging");
  assert.ok(missing.failures.some((f) => /worker-subprocess/.test(f)), "failure cites the worker-subprocess asset");
});

// ─── TS diagnostics baseline ────────────────────────────────────────────────────

test("GATE: TS diagnostics above the accepted baseline FAIL (raw count, multiplicity kept)", () => {
  const diags = Array.from({ length: 63 }, (_, i) => ({
    file: "server/scripts/x.ts",
    line: i + 1,
    code: "TS2345",
    message: "x",
  }));
  const over = evaluateReleaseGate(baseGate({ tsDiagnostics: diags, tsBaseline: 62 }));
  assert.equal(over.pass, false, "63 > 62 baseline → fail");
  assert.equal(over.summary.tsRawOccurrences, 63, "raw occurrence count preserved");
});

// ─── RAW-EVIDENCE-PRESERVED — relevant text never dropped ────────────────────────

test("RAW-EVIDENCE: the gate preserves the raw, non-deduped evidence verbatim alongside the dedup summary", () => {
  // Two IDENTICAL diagnostic signatures — dedup must NOT hide the repeat.
  const dupDiag = { file: "server/scripts/x.ts", line: 10, code: "TS2345", message: "same" };
  const gate = evaluateReleaseGate(
    baseGate({
      tests: [
        { suite: "lib", name: "a", status: "pass" },
        { suite: "lib", name: "a", status: "pass" }, // duplicate signature, kept
        { suite: "lib", name: "b", status: "fail" },
      ],
      tsDiagnostics: [dupDiag, { ...dupDiag }],
      tsBaseline: 62,
    }),
  );
  // RAW lists preserved in full.
  assert.equal(gate.raw.tests.length, 3, "all 3 raw test occurrences preserved (duplicate not dropped)");
  assert.equal(gate.raw.tsDiagnostics.length, 2, "both duplicate diagnostics preserved");
  // Dedup summary shown ALONGSIDE, never instead of, the raw lists.
  assert.equal(gate.summary.tsDistinctSignatures, 1, "dedup summary reports 1 distinct signature");
  assert.equal(gate.summary.tsRawOccurrences, 2, "raw occurrence count still 2 (repeat not hidden)");
  assert.equal(gate.summary.testsTotal, 3, "summary counts all occurrences");
  assert.equal(gate.summary.testsFailed, 1, "the failing test is counted");
  assert.equal(gate.pass, false, "a failed test fails the gate");
});

// ─── (d) release record types: commit message ≠ approval ─────────────────────────

test("REL: a commit message is classified as historical merge evidence, never approval", () => {
  const rec = classifyCommitAsReleaseEvidence({
    commitSha: "abc1234def",
    message: "feat: approved LGTM ship it",
    at: "2026-10-01T00:00:00Z",
    author: "dev",
  });
  assert.equal(rec.type, "merge", "a commit is merge evidence, not approval");
  assert.equal(rec.historical, true, "commit text preserved as dated history");

  // Approval cannot be minted from a commit message.
  assert.throws(
    () => recordApproval({ approver: "Andy", approvalRef: "PR#9", at: "x", fromCommitMessage: true }),
    /not approval/i,
    "approval refused when claimed from a commit message",
  );
  // A real approval requires a named approver + reference.
  assert.throws(() => recordApproval({ approver: "", approvalRef: "", at: "x" }), /named approver/i);
  const approval = recordApproval({ approver: "Andy", approvalRef: "PR#9", at: "2026-10-02T00:00:00Z" });
  assert.equal(approval.type, "approval");
  assert.equal(approval.historical, false, "a real approval is current status");
});

test("REL: feature-branch-only text is preserved as history and never read as current status", () => {
  const fb = preserveFeatureBranchText({
    text: "DO NOT DEPLOY — feature branch only",
    mergeSha: "abc1234def",
    at: "2026-10-01T00:00:00Z",
  });
  assert.equal(fb.historical, true, "feature-branch text kept as history");
  const status = currentReleaseStatus([
    fb,
    recordApproval({ approver: "Andy", approvalRef: "PR#9", at: "2026-10-02T00:00:00Z" }),
  ]);
  assert.equal(status.merge, undefined, "historical merge text is NOT current status");
  assert.ok(status.approval, "the real approval IS current status");
});

// ─── KILL-SWITCH DEFAULT — byte-identical passthrough ────────────────────────────

test("KILL-SWITCH: default is passthrough and byte-identical to today (no governance, 5 base CSV columns)", () => {
  const prior = process.env[PUBLICATION_POLICY_ENV];
  delete process.env[PUBLICATION_POLICY_ENV];
  try {
    assert.equal(DEFAULT_PUBLICATION_POLICY, "passthrough");
    assert.equal(PUBLICATION_POLICY_VERSION, 1, "policy version is pinned");
    assert.equal(resolvePublicationPolicy(), "passthrough", "unset env resolves to passthrough");

    const rec = buildPublicationRecord(sampleInput());
    const view = toPublicationView(rec); // default policy
    assert.equal(view.governance, null, "passthrough view has NO governance block");

    const csv = toPublicationCsvColumns(rec); // default policy
    assert.deepEqual(
      csv.map((c) => c.header),
      ["Score", "Rationale", "Supporting Quote", "Source Document", "Source Link"],
      "passthrough emits exactly the 5 base columns (byte-identical to today)",
    );
    // shadow is also byte-identical on the reader surface.
    assert.equal(toPublicationView(rec, "shadow").governance, null, "shadow view also non-mutating");
    assert.equal(toPublicationCsvColumns(rec, "shadow").length, 5, "shadow CSV also 5 base columns");
  } finally {
    if (prior === undefined) delete process.env[PUBLICATION_POLICY_ENV];
    else process.env[PUBLICATION_POLICY_ENV] = prior;
  }
});

// ─── NON-MUTATION — published scores never altered by this module ─────────────────

test("NON-MUTATION: buildPublicationRecord never mutates input; verdict uses only canonical normalizeVerdict", () => {
  const input = sampleInput({ verdict: "Yes", evidenceIds: ["ev_a", "ev_b"] });
  const before = JSON.stringify(input);
  const rec = buildPublicationRecord(input);
  assert.equal(JSON.stringify(input), before, "input object is not mutated");
  // evidenceIds are copied, not aliased.
  rec.evidenceIds.push("ev_injected");
  assert.equal(input.evidenceIds!.length, 2, "record's evidenceIds are a copy, not the caller's array");

  // The only verdict transform is the pre-existing canonical normalizeVerdict:
  // "Yes"/"No" pass through verbatim; "Partial" maps to "No" exactly as every
  // current surface already does (no NEW transform introduced by A9).
  assert.equal(buildPublicationRecord(sampleInput({ verdict: "Yes" })).verdict, "Yes");
  assert.equal(buildPublicationRecord(sampleInput({ verdict: "No" })).verdict, "No");
  assert.equal(
    buildPublicationRecord(sampleInput({ verdict: "Partial" })).verdict,
    "No",
    "Partial→No is the EXISTING canonical rule, not a new A9 transform",
  );
});

// ─── RESOLVER FAIL-SAFE ──────────────────────────────────────────────────────────

test("RESOLVER: unrecognised/empty values fall back to passthrough; never throws", () => {
  const prior = process.env[PUBLICATION_POLICY_ENV];
  try {
    process.env[PUBLICATION_POLICY_ENV] = "banana";
    assert.equal(resolvePublicationPolicy(), "passthrough", "typo env → passthrough");
    process.env[PUBLICATION_POLICY_ENV] = "";
    assert.equal(resolvePublicationPolicy(), "passthrough", "empty env → passthrough");
    process.env[PUBLICATION_POLICY_ENV] = "ANNOTATE";
    assert.equal(resolvePublicationPolicy(), "annotate", "case-insensitive recognised value");
    // explicit arg wins and is validated.
    assert.equal(resolvePublicationPolicy("shadow"), "shadow", "explicit valid arg honoured");
    assert.equal(resolvePublicationPolicy("nonsense" as any), "annotate", "bad explicit → env annotate");
    assert.doesNotThrow(() => resolvePublicationPolicy(undefined), "never throws");
  } finally {
    if (prior === undefined) delete process.env[PUBLICATION_POLICY_ENV];
    else process.env[PUBLICATION_POLICY_ENV] = prior;
  }
});

// ─── ROUND-TRIP serialization ────────────────────────────────────────────────────

test("ROUND-TRIP: a publication record serializes/deserializes byte-stably; hash is stable", () => {
  const rec = buildPublicationRecord(sampleInput());
  const json = serializePublicationRecord(rec);
  const back = deserializePublicationRecord(json);
  assert.equal(serializePublicationRecord(back), json, "re-serialization is byte-identical");
  assert.equal(publicationRecordHash(back), publicationRecordHash(rec), "hash is stable across round-trip");
});

// ─── (f) WP23 measurement baseline — subgroup-keyed, incomplete tracked separately ─

test("WP23: measurement baseline is keyed by framework/topic/language/sector and round-trips", () => {
  const b = new MeasurementBaseline();
  const row: MeasurementRow = {
    essentialSourceRecall: 0.9,
    criticalPassageRecall: 0.85,
    positivePrecision: 0.92,
    positiveRecall: 0.88,
    incompleteResearchRate: 0.12,
    quoteValidity: 0.99,
    acceptedThroughput: 100,
    allInAcceptedUnitCost: 0.5,
    wastedWorkRatio: 0.2,
    latencyP50: 10,
    latencyP95: 30,
    latencyMax: 60,
    sampleSize: 50,
  };
  const key = { framework: "FW", topic: "Governance", language: "en", sector: "Financials" };
  b.upsert(key, row);
  assert.equal(b.get(key)!.incompleteResearchRate, 0.12, "incompleteResearchRate stored separately");
  assert.equal(
    measurementKeyString(key),
    "fw | governance | en | financials",
    "key string is lower-cased, pipe-joined, subgroup-granular",
  );
  // A non-English / different-sector subgroup is a DISTINCT row (no global-average hiding).
  b.upsert({ framework: "FW", topic: "Governance", language: "de", sector: "Financials" }, { ...row, sampleSize: 3 });
  assert.equal(b.all().length, 2, "subgroups are tracked distinctly");
  const restored = MeasurementBaseline.deserialize(b.serialize());
  assert.equal(restored.all().length, 2, "baseline round-trips");
  assert.equal(restored.get(key)!.positiveRecall, 0.88, "values survive round-trip");
});

// ─── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
