/**
 * phase1-reproducibility.test.ts — WP05/Phase1 (Reproducibility, Issue 1)
 * behavioural + unit tests proving steps 1.1–1.5 and the EX04 recovery-boundary
 * guard still holds.
 *
 * Runs fully OFFLINE — every "expensive" path (the scorer, the arbiter, discovery)
 * is a stub/injected fn; there is NO live LLM-spending replay, NO DB, NO network.
 *
 * Proven invariants:
 *   1.2 — identical pack ⇒ same key + cached verdict (hit byte-identical to a cold
 *         recompute); any change to measure/prompt/model id changes the key (no
 *         false hits); hit is logged (onHit fires); PREP_COMPUTE_CACHE_POLICY
 *         gating respected (OFF ⇒ skip ⇒ always recompute).
 *   1.3 — two DISAGREEING passes trigger the arbiter and converge; two AGREEING
 *         passes do NOT invoke it and are returned untouched.
 *   1.4 — the stable/borderline flag is additive: the verdict object is
 *         byte-identical with and without the flag; borderline ⇔ the same
 *         disagreement signal 1.1 measures.
 *   1.5 — manifest reuse yields the same source set run-to-run and NEVER drops a
 *         prior source (union only; relevant text never dropped).
 *   1.1 — the pure stability-table builder reports correct per-measure Yes→No /
 *         No→Yes totals (the split, not the net) from synthetic runs.
 *   EX04 — recovery-boundary guard: N invocations ⇒ EXACTLY ONE fire.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/phase1-reproducibility.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// Keep the loop alive and pin a DB URL that is never actually connected (only the
// EX04 guard test imports analyzer.js; nothing under test performs DB I/O).
const keepAlive = setInterval(() => {}, 1000);
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
});

import {
  buildVerdictCacheKey,
  getOrComputeVerdict,
  clearVerdictCache,
  verdictCacheSize,
} from "./prep-compute-cache.js";
import {
  passesDisagree,
  shouldFireArbiter,
  resolveFlipWithArbiter,
  classifyCellStability,
  classifyCellStabilityFromPasses,
  annotateCellStability,
  reuseSourceManifest,
  manifestRetainsAllPrior,
} from "./reproducibility.js";
import {
  buildStabilityTable,
  formatStabilityTableMarkdown,
  normaliseVerdict,
  type RunRecord,
} from "./variability-stability.js";

// ─── 1.2 — score/verdict cache ─────────────────────────────────────────────────

const PACK_A = {
  evidencePackHash: "sha256:packA",
  measureVersion: "m-v1",
  promptVersion: "p-v1",
  modelId: "deepseek:deepseek-chat",
};

test("(1.2a) identical pack ⇒ identical key; any key input change ⇒ different key", () => {
  const k = buildVerdictCacheKey(PACK_A);
  assert.equal(buildVerdictCacheKey({ ...PACK_A }), k, "same inputs ⇒ same key (deterministic)");
  assert.notEqual(buildVerdictCacheKey({ ...PACK_A, evidencePackHash: "sha256:packB" }), k, "pack change ⇒ new key");
  assert.notEqual(buildVerdictCacheKey({ ...PACK_A, measureVersion: "m-v2" }), k, "measure version change ⇒ new key");
  assert.notEqual(buildVerdictCacheKey({ ...PACK_A, promptVersion: "p-v2" }), k, "prompt version change ⇒ new key");
  assert.notEqual(buildVerdictCacheKey({ ...PACK_A, modelId: "openrouter:mistral" }), k, "model id change ⇒ new key");
});

test("(1.2b) policy ON: miss computes+stores; identical pack ⇒ HIT byte-identical, hit logged", async () => {
  clearVerdictCache();
  const verdict = { score: 1, verdict: "Yes", rationale: "pack cites a board AI policy" };
  let computeCalls = 0;
  const hits: string[] = [];
  const compute = () => { computeCalls++; return verdict; };

  const r1 = await getOrComputeVerdict({ keyInput: PACK_A, compute, explicit: "on" });
  assert.equal(r1.outcome, "miss");
  assert.equal(computeCalls, 1, "cold path computes once");

  const r2 = await getOrComputeVerdict({ keyInput: { ...PACK_A }, compute, explicit: "on", onHit: (k) => hits.push(k) });
  assert.equal(r2.outcome, "hit", "identical pack ⇒ hit");
  assert.equal(computeCalls, 1, "hit does NOT recompute");
  assert.equal(hits.length, 1, "hit is logged via onHit");
  assert.equal(hits[0], r1.key, "logged key matches the stored key");
  // Verdict-safe: a hit returns EXACTLY what the uncached path produced.
  assert.deepEqual(r2.value, verdict, "hit value byte-identical to cold recompute");
  assert.equal(JSON.stringify(r2.value), JSON.stringify(r1.value), "hit serialises identically");
});

test("(1.2c) a changed key input ⇒ MISS (no false hit)", async () => {
  clearVerdictCache();
  let computeCalls = 0;
  const compute = () => { computeCalls++; return { n: computeCalls }; };
  await getOrComputeVerdict({ keyInput: PACK_A, compute, explicit: "on" });
  const r = await getOrComputeVerdict({ keyInput: { ...PACK_A, modelId: "other:model" }, compute, explicit: "on" });
  assert.equal(r.outcome, "miss", "a different model id must not hit the first entry");
  assert.equal(computeCalls, 2, "recomputed for the new key");
});

test("(1.2d) policy OFF ⇒ SKIP cache ⇒ always recompute (byte-identical to pre-Phase-1)", async () => {
  clearVerdictCache();
  let computeCalls = 0;
  const compute = () => { computeCalls++; return { n: computeCalls }; };
  const a = await getOrComputeVerdict({ keyInput: PACK_A, compute, explicit: "off" });
  const b = await getOrComputeVerdict({ keyInput: PACK_A, compute, explicit: "off" });
  assert.equal(a.outcome, "skip");
  assert.equal(b.outcome, "skip");
  assert.equal(computeCalls, 2, "OFF never serves a hit — recompute every time");
  assert.equal(verdictCacheSize(), 0, "OFF never populates the cache");
});

// ─── 1.3 — arbiter on DISAGREEING (flip) cells only ────────────────────────────

test("(1.3a) two AGREEING passes do NOT invoke the arbiter and are untouched", () => {
  assert.equal(passesDisagree(1, 1), false);
  assert.equal(shouldFireArbiter(1, 1), false);
  const res = resolveFlipWithArbiter({ primary: 1, secondary: 1, arbiterScore: 0 /* ignored */ });
  assert.ok(res);
  assert.equal(res!.arbiterFired, false, "agreeing cell never fires the arbiter");
  assert.equal(res!.score, 1, "agreeing cell keeps its score (untouched)");
  assert.equal(res!.converged, true);
});

test("(1.3b) two DISAGREEING passes fire the arbiter and converge on its vote", () => {
  assert.equal(passesDisagree(1, 0), true);
  assert.equal(shouldFireArbiter(1, 0), true);
  const res = resolveFlipWithArbiter({ primary: 1, secondary: 0, arbiterScore: 0 });
  assert.ok(res);
  assert.equal(res!.arbiterFired, true, "disagreeing cell fires the arbiter");
  assert.equal(res!.converged, true, "disagreeing cell converges");
  assert.equal(res!.score, 0, "converges on the arbiter's vote");
  assert.equal(res!.arbiterSidedWith, "secondary");
});

test("(1.3c) arbiter unavailable on a flip ⇒ does NOT fabricate a verdict (not converged)", () => {
  const res = resolveFlipWithArbiter({ primary: 1, secondary: 0, arbiterScore: null });
  assert.ok(res);
  assert.equal(res!.arbiterFired, true);
  assert.equal(res!.converged, false, "no arbiter vote ⇒ not converged (caller handles)");
});

// ─── 1.4 — additive stable/borderline flag ─────────────────────────────────────

test("(1.4a) borderline ⇔ deciding passes disagreed (same signal as 1.1/1.3)", () => {
  assert.equal(classifyCellStability({ disagreed: true }), "borderline");
  assert.equal(classifyCellStability({ disagreed: false }), "stable");
  assert.equal(classifyCellStabilityFromPasses(1, 0), "borderline");
  assert.equal(classifyCellStabilityFromPasses(1, 1), "stable");
});

test("(1.4b) the flag is PURELY ADDITIVE — verdict object byte-identical with/without it", () => {
  const cell = { measureId: "m1", score: 1, verdict: "Yes", rationale: "r" };
  const before = JSON.stringify(cell);
  const annotated = annotateCellStability(cell, "borderline");
  // Original untouched.
  assert.equal(JSON.stringify(cell), before, "original cell is not mutated");
  // Strip the additive field ⇒ identical to the original verdict payload.
  const { stability, ...verdictOnly } = annotated as any;
  assert.equal(stability, "borderline");
  assert.deepEqual(verdictOnly, cell, "removing the flag yields the identical verdict object");
  assert.equal(JSON.stringify(verdictOnly), before, "verdict payload serialises identically");
});

// ─── 1.5 — discovery source-manifest reuse (union; never prune) ────────────────

test("(1.5a) replay reuses prior manifest ⇒ same source set, deterministic order", () => {
  const prior = ["https://a.example/1", "https://a.example/2"];
  const current = ["https://a.example/2", "https://a.example/3"];
  const m1 = reuseSourceManifest(prior, current);
  const m2 = reuseSourceManifest(prior, current);
  assert.deepEqual(m1, m2, "deterministic — identical inputs ⇒ identical ordered result");
  assert.deepEqual(m1, ["https://a.example/1", "https://a.example/2", "https://a.example/3"], "union, prior first");
});

test("(1.5b) reuse NEVER drops a prior source (relevant text never dropped)", () => {
  const prior = ["s1", "s2", "s3"];
  const current: string[] = []; // a replay that discovered nothing new
  const merged = reuseSourceManifest(prior, current);
  assert.ok(manifestRetainsAllPrior(prior, merged), "every prior source retained even when current is empty");
  for (const s of prior) assert.ok(merged.includes(s), `prior source ${s} retained`);
});

test("(1.5c) reuse WIDENS the set with new current sources, never shrinks", () => {
  const prior = ["s1"];
  const current = ["s2", "s3"];
  const merged = reuseSourceManifest(prior, current);
  assert.ok(merged.length >= prior.length, "set can only grow or stay the same");
  assert.ok(manifestRetainsAllPrior(prior, merged));
  assert.deepEqual(merged, ["s1", "s2", "s3"]);
});

// ─── 1.1 — per-measure stability table (Yes→No / No→Yes split) ──────────────────

test("(1.1a) builder reports correct per-measure Yes→No / No→Yes totals vs baseline", () => {
  const runs: RunRecord[] = [
    { runIndex: 0, cells: [ // baseline
      { measureId: "m1", verdict: "Yes" },
      { measureId: "m2", verdict: "No" },
      { measureId: "m3", verdict: "Yes" },
    ]},
    { runIndex: 1, cells: [
      { measureId: "m1", verdict: "No" },  // Yes→No
      { measureId: "m2", verdict: "Yes" }, // No→Yes
      { measureId: "m3", verdict: "Yes" }, // stable
    ]},
    { runIndex: 2, cells: [
      { measureId: "m1", verdict: "No" },  // Yes→No again
      { measureId: "m2", verdict: "No" },  // stable vs baseline
      { measureId: "m3", verdict: "Yes" }, // stable
    ]},
  ];
  const t = buildStabilityTable(runs);
  const m1 = t.measures.find((m) => m.measureId === "m1")!;
  const m2 = t.measures.find((m) => m.measureId === "m2")!;
  const m3 = t.measures.find((m) => m.measureId === "m3")!;
  assert.equal(m1.yesToNo, 2, "m1 flips Yes→No in both later runs");
  assert.equal(m1.noToYes, 0);
  assert.equal(m2.noToYes, 1, "m2 flips No→Yes once");
  assert.equal(m2.yesToNo, 0);
  assert.equal(m3.totalFlips, 0, "m3 is stable");
  assert.equal(m3.stable, true);
  // Totals are the SPLIT (not the net).
  assert.equal(t.totals.yesToNo, 2);
  assert.equal(t.totals.noToYes, 1);
  assert.equal(t.totals.measuresWithFlips, 2);
});

test("(1.1b) identical runs ⇒ zero flips (reproducible ⇒ Yes→No=0, No→Yes=0)", () => {
  const cells = [ { measureId: "m1", verdict: "Yes" as const }, { measureId: "m2", verdict: "No" as const } ];
  const runs: RunRecord[] = [
    { runIndex: 0, cells: [...cells] },
    { runIndex: 1, cells: [...cells] },
    { runIndex: 2, cells: [...cells] },
  ];
  const t = buildStabilityTable(runs);
  assert.equal(t.totals.yesToNo, 0);
  assert.equal(t.totals.noToYes, 0);
  assert.equal(t.totals.totalFlips, 0);
  assert.ok(formatStabilityTableMarkdown(t).includes("TOTAL"), "markdown renders a TOTAL row");
});

test("(1.1c) normaliseVerdict maps scores/strings to canonical labels", () => {
  assert.equal(normaliseVerdict(1), "Yes");
  assert.equal(normaliseVerdict(0), "No");
  assert.equal(normaliseVerdict("Yes"), "Yes");
  assert.equal(normaliseVerdict("no"), "No");
  assert.equal(normaliseVerdict(undefined), "No");
});

// ─── EX04 recovery-boundary guard (must remain intact; regression check) ───────

const { maybeFireDocumentCompletenessReretrieval, DOC_COMPLETENESS_RERETRIEVAL_KEY } = await import("./analyzer.js");
const { RetrievalReviewQueue } = await import("./retrieval-review-queue.js");

function makeCountingReretrieval() {
  let calls = 0;
  const firedSet = new Set<string>();
  const fn = async (req: any) => {
    calls++;
    firedSet.add(req.fingerprintKey);
    return { fired: true, newDocsAdded: 0, targetedQuery: "fake", reason: "no-new-docs" };
  };
  return { fn, get calls() { return calls; } };
}

const company = { id: 909, name: "Phase1 Co", domain: "p1.example", isin: null, ticker: null, sector: null, country: null } as any;
const framework = { id: 18, name: "AI Management" } as any;
const measures = [ { measureId: "m1", title: "Board AI oversight", definition: "d" } ] as any;

test("(EX04) recovery fires at most ONCE across N invocations (guard not regressed)", async () => {
  const spy = makeCountingReretrieval();
  const reviewQueue = new RetrievalReviewQueue();
  const base = {
    documentCompleteness: ["partial", "unknown"],
    reviewQueue, company, framework, measures,
    trustedSources: [], issuerProfile: undefined,
    existingCorpusText: "EXISTING", existingDocUrls: new Set<string>(),
    retrievalV2: true, autoReretrieval: true, skipFetch: false,
  } as any;

  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await maybeFireDocumentCompletenessReretrieval(base, spy.fn as any));
  }
  assert.equal(spy.calls, 1, "per-company/per-batch bound caps recovery at ONE");
  assert.equal(results[0].fired, true, "first invocation fires");
  for (let i = 1; i < 6; i++) {
    assert.equal(results[i].fired, false, `invocation ${i + 1} is blocked by the bound`);
  }
  assert.ok(
    reviewQueue.hasFired(company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY),
    "the reserved dedupe key is marked fired — recovery cannot loop",
  );
});

test.after(() => clearInterval(keepAlive));
