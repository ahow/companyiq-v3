/**
 * phase2-groundtruth.test.ts — WP05/Phase 2 (Ground truth, Issue 2) unit tests.
 *
 * OFFLINE like phase1-reproducibility.test.ts: node:test + assert/strict, NO live
 * LLM, NO DB, NO network. All labels here are SYNTHETIC — they exist only to prove
 * the gate MATH and the selection DETERMINISM. They are NOT human ground truth and
 * are never presented as such (that is exactly the circularity Phase 2 breaks).
 *
 * Proves:
 *   (2.1) stratified-selection determinism (same seed ⇒ identical set; different
 *         seed ⇒ differing random-No stratum) and correct strata composition.
 *   (2.2) label schema validation (valid/invalid cases, PENDING vs adjudicated
 *         requirements, provisional_suggestion, duplicates, key-not-in-manifest).
 *   (2.3) precision/recall math (hand-computed TP/FP/FN/TN) + Wilson CI sanity.
 *   (2.4) Yes→No / No→Yes split vs oracle-era baseline (the split, not the net).
 *   (2.5) threshold pass/fail.
 *   (2.6) "labels pending ⇒ gate not armed" and "too few Yes ⇒ not armed"
 *         (no fabricated pass / invented numbers).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  seededRng,
  seededShuffle,
  selectHoldout,
  slugifyMeasure,
  makeCellKey,
  validateHoldoutLabel,
  validateLabelFile,
  buildLabelTemplate,
  computeGate,
  wilsonInterval,
  DEFAULT_GATE_THRESHOLDS,
  type RunCellObservation,
  type RosterCompany,
  type HoldoutLabel,
  type ModelVerdictEntry,
  type OracleBaselineEntry,
} from "./phase2-groundtruth.js";
import type { Verdict } from "./variability-stability.js";

// Keep the event loop alive so node:test flushes results deterministically, then
// release it once all tests finish (same guard the phase1 reproducibility suite uses).
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fixture builder — a small, deterministic replay universe.
// companies 1..C, measures m1..mM, R runs each. Verdict decided by a pure rule so
// we can reason about strata exactly. NO real company data, NO model, NO network.
// ─────────────────────────────────────────────────────────────────────────────
function buildObservations(opts: {
  companies: number[];
  measures: string[];
  runs: number;
  /** verdict(companyId, measureIdx, runIdx) → "Yes" | "No" (synthetic rule). */
  verdict: (c: number, mi: number, r: number) => Verdict;
  nonEnglishIds?: number[];
}): RunCellObservation[] {
  const obs: RunCellObservation[] = [];
  for (const c of opts.companies) {
    for (let mi = 0; mi < opts.measures.length; mi++) {
      for (let r = 1; r <= opts.runs; r++) {
        obs.push({
          companyId: c,
          companyName: `Company ${c}`,
          measureTitle: opts.measures[mi],
          category: "Cat",
          runIndex: r,
          verdict: opts.verdict(c, mi, r),
          docRef: `doc://${c}/${mi}`,
          passageRef: `passage ${c}-${mi}`,
          researchComplete: null,
        });
      }
    }
  }
  return obs;
}

const MEASURES = ["Measure Alpha", "Measure Beta", "Measure Gamma", "Measure Delta", "Measure Epsilon"];

// ─────────────────────────────────────────────────────────────────────────────
// (2.1) Selection determinism + strata composition
// ─────────────────────────────────────────────────────────────────────────────

test("(2.1a) seededRng + seededShuffle are deterministic for a given seed", () => {
  const a = Array.from({ length: 10 }, seededRng("seed-x"));
  const b = Array.from({ length: 10 }, seededRng("seed-x"));
  assert.deepEqual(a, b, "same seed must produce the same RNG stream");
  const c = Array.from({ length: 10 }, seededRng("seed-y"));
  assert.notDeepEqual(a, c, "different seed should produce a different stream");

  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s1 = seededShuffle(items, seededRng("s"));
  const s2 = seededShuffle(items, seededRng("s"));
  assert.deepEqual(s1, s2, "same seed ⇒ identical shuffle");
  assert.deepEqual([...items], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "shuffle must not mutate input");
});

test("(2.1b) slug + cell key are stable and content-based", () => {
  assert.equal(slugifyMeasure("Discloses a FORMAL AI strategy!"), "discloses-a-formal-ai-strategy");
  assert.equal(makeCellKey(12, "Measure Alpha"), "12::measure-alpha");
});

test("(2.1c) same seed ⇒ identical holdout; different seed ⇒ differing random-No stratum", () => {
  // 8 companies, 5 measures, 3 runs. Each company has 2 Yes + 3 No. With
  // lowYieldYesThreshold=0 no company is "low-yield" (2 > 0), so every No cell
  // falls into the random-No pool (8×3=24) — a genuine sample the seed can vary.
  const obs = buildObservations({
    companies: [1, 2, 3, 4, 5, 6, 7, 8],
    measures: MEASURES,
    runs: 3,
    verdict: (_c, mi) => (mi < 2 ? "Yes" : "No"),
  });
  // targetSize 20 = 16 mandatory current-Yes + 4 sampled from the 24-cell No pool.
  const cfg = { targetSize: 20, lowYieldYesThreshold: 0, minNonEnglishFilers: 0 as number };

  const m1 = selectHoldout(obs, { seed: "same", ...cfg });
  const m2 = selectHoldout(obs, { seed: "same", ...cfg });
  assert.deepEqual(
    m1.cells.map((c) => c.cellKey),
    m2.cells.map((c) => c.cellKey),
    "same seed + inputs ⇒ identical holdout cell set/order",
  );

  const m3 = selectHoldout(obs, { seed: "different-seed", ...cfg });
  const no1 = m1.cells.filter((c) => c.stratum === "random-no").map((c) => c.cellKey).sort();
  const no3 = m3.cells.filter((c) => c.stratum === "random-no").map((c) => c.cellKey).sort();
  // The deterministic strata (yes/unstable/low-yield) are seed-independent; only the
  // random-No sample should move with the seed. Guard that it CAN differ.
  assert.ok(no1.length > 0 && no3.length > 0, "there should be a random-No sample to vary");
  assert.notDeepEqual(no1, no3, "different seed should change the random-No sample");
});

test("(2.1d) strata composition: all current-Yes captured; unstable detected; low-yield company cells", () => {
  // Company 1: measure0 flips across runs (unstable); measure1 steady Yes.
  // Company 2: all No (low-yield). Company 3: all No (low-yield).
  const obs = buildObservations({
    companies: [1, 2, 3],
    measures: MEASURES,
    runs: 3,
    verdict: (c, mi, r) => {
      if (c === 1 && mi === 0) return r === 2 ? "Yes" : "No"; // flips ⇒ unstable
      if (c === 1 && mi === 1) return "Yes"; // steady yes
      return "No";
    },
  });
  const m = selectHoldout(obs, {
    seed: "compose",
    targetSize: 15,
    lowYieldYesThreshold: 1,
    minNonEnglishFilers: 0,
  });

  // (a) every steady-Yes cell present as current-yes
  const yesKeys = m.cells.filter((c) => c.stratum === "current-yes").map((c) => c.cellKey);
  assert.ok(yesKeys.includes(makeCellKey(1, "Measure Beta")), "steady Yes cell must be current-yes");

  // (b) the flipping cell is captured as unstable (its baseline verdict is No at run1)
  const unstable = m.cells.filter((c) => c.stratum === "unstable");
  assert.ok(
    unstable.some((c) => c.cellKey === makeCellKey(1, "Measure Alpha")),
    "flipping cell must be captured in the unstable stratum",
  );
  assert.ok(unstable.every((c) => c.runFlips > 0), "unstable cells must have runFlips > 0");

  // (c) low-yield companies (2 & 3 have 0 Yes) contribute low-yield-company cells
  const lowYield = m.cells.filter((c) => c.stratum === "low-yield-company");
  assert.ok(
    lowYield.some((c) => c.companyId === 2) && lowYield.some((c) => c.companyId === 3),
    "cells from 0-Yes (low-yield) companies must be captured",
  );

  // Each cell appears exactly once (priority assignment, no double counting).
  const allKeys = m.cells.map((c) => c.cellKey);
  assert.equal(new Set(allKeys).size, allKeys.length, "no cell may appear in two strata");
  assert.equal(m.counts.total, m.cells.length);
});

test("(2.1e) ≥N non-English filers represented; placeholders flagged needs-evidence when no artifacts", () => {
  // Only English companies have artifacts; two non-English filers exist ONLY in the
  // roster (no runs) ⇒ must be appended as needs-evidence placeholders.
  const obs = buildObservations({
    companies: [1, 2],
    measures: MEASURES,
    runs: 2,
    verdict: () => "No",
  });
  const roster: RosterCompany[] = [
    { companyId: 1, companyName: "English One" },
    { companyId: 2, companyName: "English Two" },
    { companyId: 9001, companyName: "Idemitsu", nonEnglish: true, placeholderMeasures: ["Measure Alpha"] },
    { companyId: 9002, companyName: "Otsuka", nonEnglish: true, placeholderMeasures: ["Measure Alpha"] },
  ];
  const m = selectHoldout(obs, { seed: "ne", targetSize: 5, minNonEnglishFilers: 2, roster });
  assert.ok(m.counts.nonEnglishFilers >= 2, "must represent ≥2 non-English filers");
  const placeholders = m.cells.filter((c) => c.stratum === "non-english-placeholder");
  assert.ok(placeholders.length >= 2, "placeholder cells must be appended for artifact-less filers");
  assert.ok(placeholders.every((c) => c.needsEvidence === true), "placeholders flagged needs-evidence");
  assert.ok(placeholders.every((c) => c.modelVerdict === null), "placeholders have no model verdict");
});

test("(2.1f) holdout size respects target budget", () => {
  const obs = buildObservations({
    companies: [1, 2, 3, 4],
    measures: MEASURES,
    runs: 2,
    verdict: (c, mi) => (mi === 0 ? "Yes" : "No"),
  });
  const m = selectHoldout(obs, { seed: "budget", targetSize: 8, lowYieldYesThreshold: 0, minNonEnglishFilers: 0 });
  // 4 current-yes (mi0 for each company) are mandatory; budget 8 ⇒ ≤8 non-placeholder.
  const nonPlaceholder = m.cells.filter((c) => c.stratum !== "non-english-placeholder");
  assert.ok(nonPlaceholder.length <= 8, "non-placeholder selection must respect the budget");
  assert.ok(nonPlaceholder.length >= 4, "mandatory current-Yes cells must all be present");
});

// ─────────────────────────────────────────────────────────────────────────────
// (2.2) Label schema validation
// ─────────────────────────────────────────────────────────────────────────────

test("(2.2a) a blank template is all-PENDING and schema-valid", () => {
  const obs = buildObservations({ companies: [1], measures: MEASURES, runs: 1, verdict: () => "No" });
  const m = selectHoldout(obs, { seed: "tpl", targetSize: 5, lowYieldYesThreshold: 0, minNonEnglishFilers: 0 });
  const tpl = buildLabelTemplate(m);
  assert.ok(tpl.length > 0);
  assert.ok(tpl.every((l) => l.human_label === "PENDING"));
  const v = validateLabelFile(tpl, m);
  assert.ok(v.valid, `blank template must validate: ${v.errors.join("; ")}`);
});

test("(2.2b) PENDING needs no labeller; an adjudicated label requires labeller + valid timestamp", () => {
  const pending: HoldoutLabel = {
    cellKey: "1::measure-alpha",
    human_label: "PENDING",
    labeller_id: null,
    document: null,
    passage: null,
    timestamp: null,
    overlap: false,
    provisional_suggestion: null,
  };
  assert.ok(validateHoldoutLabel(pending).valid, "PENDING without labeller must be valid");

  const missingMeta: HoldoutLabel = { ...pending, human_label: "Yes" };
  const r = validateHoldoutLabel(missingMeta);
  assert.ok(!r.valid, "adjudicated label without labeller/timestamp must be invalid");
  assert.ok(r.errors.some((e) => e.includes("labeller_id")));
  assert.ok(r.errors.some((e) => e.includes("timestamp")));

  const good: HoldoutLabel = {
    ...pending,
    human_label: "No",
    labeller_id: "analyst-ah",
    timestamp: "2026-10-18T10:00:00Z",
  };
  assert.ok(validateHoldoutLabel(good).valid, "fully-specified adjudicated label must be valid");
});

test("(2.2c) bad values are rejected (human_label enum, cellKey shape, overlap type)", () => {
  assert.ok(!validateHoldoutLabel(null).valid);
  assert.ok(!validateHoldoutLabel({ cellKey: "nodelimiter", human_label: "Yes" }).valid);
  assert.ok(!validateHoldoutLabel({ cellKey: "1::x", human_label: "Maybe" as any }).valid);
  const badOverlap = validateHoldoutLabel({
    cellKey: "1::x",
    human_label: "PENDING",
    overlap: "yes" as any,
  });
  assert.ok(!badOverlap.valid && badOverlap.errors.some((e) => e.includes("overlap")));
});

test("(2.2d) provisional_suggestion is validated but is separate from the authoritative label", () => {
  const withProv: HoldoutLabel = {
    cellKey: "1::x",
    human_label: "PENDING",
    labeller_id: null,
    document: null,
    passage: null,
    timestamp: null,
    overlap: false,
    provisional_suggestion: { label: "Yes", source: "openrouter:independent-model" },
  };
  assert.ok(validateHoldoutLabel(withProv).valid, "well-formed provisional suggestion must validate");

  const badProv = validateHoldoutLabel({
    ...withProv,
    provisional_suggestion: { label: "Nope" as any, source: "" },
  });
  assert.ok(!badProv.valid, "provisional suggestion with bad label / empty source must be rejected");
  assert.ok(badProv.errors.some((e) => e.includes("provisional_suggestion.label")));
  assert.ok(badProv.errors.some((e) => e.includes("source")));
});

test("(2.2e) label file rejects duplicates and cellKeys absent from the manifest", () => {
  const obs = buildObservations({ companies: [1], measures: MEASURES, runs: 1, verdict: () => "No" });
  const m = selectHoldout(obs, { seed: "file", targetSize: 5, lowYieldYesThreshold: 0, minNonEnglishFilers: 0 });
  const tpl = buildLabelTemplate(m);

  const dup = [tpl[0], { ...tpl[0] }];
  const rDup = validateLabelFile(dup, m);
  assert.ok(!rDup.valid && rDup.errors.some((e) => e.includes("duplicate")));

  const stray: HoldoutLabel = { ...tpl[0], cellKey: "999::not-in-manifest" };
  const rStray = validateLabelFile([stray], m);
  assert.ok(!rStray.valid && rStray.errors.some((e) => e.includes("not in manifest")));

  assert.ok(!validateLabelFile("nope" as any).valid, "non-array label file must be rejected");
});

// ─────────────────────────────────────────────────────────────────────────────
// (2.3) Precision/recall math + Wilson CI
// ─────────────────────────────────────────────────────────────────────────────

/** Build a synthetic (labels, modelVerdicts) pair with explicit confusion counts. */
function synthFromCounts(tp: number, fp: number, fn: number, tn: number): {
  labels: HoldoutLabel[];
  modelVerdicts: ModelVerdictEntry[];
} {
  const labels: HoldoutLabel[] = [];
  const modelVerdicts: ModelVerdictEntry[] = [];
  let i = 0;
  const push = (human: "Yes" | "No", model: Verdict) => {
    const cellKey = `1::m${i++}`;
    labels.push({
      cellKey,
      human_label: human,
      labeller_id: "analyst-synth",
      document: null,
      passage: null,
      timestamp: "2026-10-18T00:00:00Z",
      overlap: false,
      provisional_suggestion: null,
    });
    modelVerdicts.push({ cellKey, verdict: model });
  };
  for (let k = 0; k < tp; k++) push("Yes", "Yes");
  for (let k = 0; k < fp; k++) push("No", "Yes");
  for (let k = 0; k < fn; k++) push("Yes", "No");
  for (let k = 0; k < tn; k++) push("No", "No");
  return { labels, modelVerdicts };
}

test("(2.3a) precision/recall match hand-computed confusion matrix", () => {
  // tp=8 fp=2 fn=4 tn=6 ⇒ precision=8/10=0.8, recall=8/12≈0.6667
  const { labels, modelVerdicts } = synthFromCounts(8, 2, 4, 6);
  const g = computeGate({ labels, modelVerdicts });
  assert.ok(g.overall);
  assert.equal(g.overall!.tp, 8);
  assert.equal(g.overall!.fp, 2);
  assert.equal(g.overall!.fn, 4);
  assert.equal(g.overall!.tn, 6);
  assert.equal(g.overall!.n, 20);
  assert.ok(Math.abs(g.overall!.precision! - 0.8) < 1e-9);
  assert.ok(Math.abs(g.overall!.recall! - 8 / 12) < 1e-9);
});

test("(2.3b) Wilson interval brackets the point estimate and stays within [0,1]", () => {
  const ci = wilsonInterval(8, 10);
  assert.ok(ci);
  const [lo, hi] = ci!;
  assert.ok(lo >= 0 && hi <= 1 && lo < 0.8 && hi > 0.8, "95% CI must bracket p̂=0.8 inside [0,1]");
  assert.equal(wilsonInterval(0, 0), null, "no trials ⇒ no interval");
});

test("(2.3c) precision/recall are null (not 0) when undefined", () => {
  // No model-Yes predictions at all ⇒ precision undefined; no human-Yes ⇒ recall undefined.
  const { labels, modelVerdicts } = synthFromCounts(0, 0, 0, 5); // all true-negatives
  const g = computeGate({ labels, modelVerdicts });
  assert.equal(g.overall!.precision, null, "precision undefined ⇒ null, never fabricated 0");
  assert.equal(g.overall!.recall, null, "recall undefined ⇒ null");
});

// ─────────────────────────────────────────────────────────────────────────────
// (2.4) Yes→No / No→Yes split vs oracle-era baseline
// ─────────────────────────────────────────────────────────────────────────────

test("(2.4) reports the Yes→No / No→Yes SPLIT vs oracle baseline (not the net)", () => {
  const labels: HoldoutLabel[] = ["a", "b", "c", "d", "e"].map((k) => ({
    cellKey: `1::${k}`,
    human_label: "PENDING",
    labeller_id: null,
    document: null,
    passage: null,
    timestamp: null,
    overlap: false,
    provisional_suggestion: null,
  }));
  const modelVerdicts: ModelVerdictEntry[] = [
    { cellKey: "1::a", verdict: "No" }, // oracle Yes → model No  (Y→N)
    { cellKey: "1::b", verdict: "No" }, // oracle Yes → model No  (Y→N)
    { cellKey: "1::c", verdict: "Yes" }, // oracle No  → model Yes (N→Y)
    { cellKey: "1::d", verdict: "Yes" }, // oracle Yes → model Yes (no flip)
    { cellKey: "1::e", verdict: "No" }, // oracle No  → model No  (no flip)
  ];
  const oracleBaseline: OracleBaselineEntry[] = [
    { cellKey: "1::a", verdict: "Yes" },
    { cellKey: "1::b", verdict: "Yes" },
    { cellKey: "1::c", verdict: "No" },
    { cellKey: "1::d", verdict: "Yes" },
    { cellKey: "1::e", verdict: "No" },
  ];
  const g = computeGate({ labels, modelVerdicts, oracleBaseline });
  assert.ok(g.vsOracleBaseline);
  assert.equal(g.vsOracleBaseline!.yesToNo, 2, "Y→N split must be reported");
  assert.equal(g.vsOracleBaseline!.noToYes, 1, "N→Y split must be reported");
  assert.equal(g.vsOracleBaseline!.totalFlips, 3, "total flips = Y→N + N→Y (not net = 1)");
  assert.equal(g.vsOracleBaseline!.comparedCells, 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2.5) Threshold pass/fail
// ─────────────────────────────────────────────────────────────────────────────

test("(2.5a) gate PASSES when precision & recall meet thresholds", () => {
  // tp=9 fp=1 fn=1 tn=9 ⇒ precision=0.9, recall=0.9 ≥ default (0.85 / 0.75)
  const { labels, modelVerdicts } = synthFromCounts(9, 1, 1, 9);
  const g = computeGate({ labels, modelVerdicts });
  assert.equal(g.status, "pass");
  assert.ok(g.overall!.precision! >= DEFAULT_GATE_THRESHOLDS.minYesPrecision);
  assert.ok(g.overall!.recall! >= DEFAULT_GATE_THRESHOLDS.minYesRecall);
});

test("(2.5b) gate FAILS when recall is below threshold", () => {
  // tp=5 fp=0 fn=5 tn=10 ⇒ precision=1.0, recall=0.5 < 0.75
  const { labels, modelVerdicts } = synthFromCounts(5, 0, 5, 10);
  const g = computeGate({ labels, modelVerdicts });
  assert.equal(g.status, "fail");
  assert.ok(g.overall!.recall! < DEFAULT_GATE_THRESHOLDS.minYesRecall);
});

test("(2.5c) thresholds are overridable (illustrative defaults)", () => {
  const { labels, modelVerdicts } = synthFromCounts(5, 0, 5, 10); // recall 0.5
  const lenient = computeGate({
    labels,
    modelVerdicts,
    thresholds: { minYesPrecision: 0.8, minYesRecall: 0.4, illustrative: false },
  });
  assert.equal(lenient.status, "pass", "a lower recall threshold must let it pass");
  assert.equal(DEFAULT_GATE_THRESHOLDS.illustrative, true, "defaults are flagged illustrative");
});

test("(2.5d) complete/incomplete research split is computed when derivable", () => {
  const mk = (cellKey: string, human: "Yes" | "No", model: Verdict, rc: boolean): [HoldoutLabel, ModelVerdictEntry] => [
    {
      cellKey,
      human_label: human,
      labeller_id: "a",
      document: null,
      passage: null,
      timestamp: "2026-10-18T00:00:00Z",
      overlap: false,
      provisional_suggestion: null,
    },
    { cellKey, verdict: model, researchComplete: rc },
  ];
  const rows = [
    mk("1::a", "Yes", "Yes", true),
    mk("1::b", "No", "No", true),
    mk("1::c", "Yes", "No", false),
    mk("1::d", "No", "Yes", false),
  ];
  const g = computeGate({ labels: rows.map((r) => r[0]), modelVerdicts: rows.map((r) => r[1]) });
  assert.ok(g.byResearch);
  assert.equal(g.byResearch!.complete!.n, 2);
  assert.equal(g.byResearch!.incomplete!.n, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2.6) "not armed" honesty behaviour — never fabricate a pass or numbers
// ─────────────────────────────────────────────────────────────────────────────

test("(2.6a) all-PENDING labels ⇒ gate NOT ARMED, no fabricated numbers", () => {
  const obs = buildObservations({ companies: [1, 2], measures: MEASURES, runs: 1, verdict: () => "No" });
  const m = selectHoldout(obs, { seed: "pend", targetSize: 6, lowYieldYesThreshold: 0, minNonEnglishFilers: 0 });
  const labels = buildLabelTemplate(m); // all PENDING
  const modelVerdicts: ModelVerdictEntry[] = m.cells.map((c) => ({
    cellKey: c.cellKey,
    verdict: (c.modelVerdict ?? "No") as Verdict,
  }));
  const g = computeGate({ labels, modelVerdicts });
  assert.equal(g.status, "not-armed");
  assert.equal(g.armedLabelCount, 0);
  assert.equal(g.overall, null, "no precision/recall object fabricated when not armed");
  assert.match(g.reason, /ground truth pending/i);
});

test("(2.6b) Unsure labels do not arm the gate", () => {
  const labels: HoldoutLabel[] = [
    {
      cellKey: "1::a",
      human_label: "Unsure",
      labeller_id: "a",
      document: null,
      passage: null,
      timestamp: "2026-10-18T00:00:00Z",
      overlap: false,
      provisional_suggestion: null,
    },
  ];
  const g = computeGate({ labels, modelVerdicts: [{ cellKey: "1::a", verdict: "Yes" }] });
  assert.equal(g.status, "not-armed", "Unsure is excluded from precision/recall ⇒ not armed");
});

test("(2.6c) too few Yes to define precision/recall ⇒ not armed (no fabricated pass)", () => {
  // Only true-negatives are adjudicated: precision & recall both undefined.
  const { labels, modelVerdicts } = synthFromCounts(0, 0, 0, 4);
  const g = computeGate({ labels, modelVerdicts });
  assert.equal(g.status, "not-armed", "undefined precision/recall must NOT be a pass");
  assert.match(g.reason, /not armed/i);
});

test("(2.6d) oracle split is still reported even when the gate is not armed", () => {
  const labels: HoldoutLabel[] = [
    {
      cellKey: "1::a",
      human_label: "PENDING",
      labeller_id: null,
      document: null,
      passage: null,
      timestamp: null,
      overlap: false,
      provisional_suggestion: null,
    },
  ];
  const g = computeGate({
    labels,
    modelVerdicts: [{ cellKey: "1::a", verdict: "No" }],
    oracleBaseline: [{ cellKey: "1::a", verdict: "Yes" }],
  });
  assert.equal(g.status, "not-armed");
  assert.ok(g.vsOracleBaseline);
  assert.equal(g.vsOracleBaseline!.yesToNo, 1, "the oracle-flip audit is independent of human labels");
});
