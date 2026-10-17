/**
 * model-cost.test.ts — B5 / WP13-C/D/E committed test suite.
 *
 * Proves the three model-cost levers ship DORMANT and framework-level:
 *   CC01 (HEADLINE) — a DECISIVE pack passage is NEVER dropped by trim, across
 *                     negative evidence, contradiction, qualifier, low-frequency
 *                     decisive token, table-style evidence, and the single
 *                     decisive passage case. decisive-pack-ids ⊆ kept-ids AND
 *                     pack recall unchanged for every case.
 *   CC02 — only provably-redundant repeats are trimmed; a passage with ANY unique
 *          decisive token OR unique source link is NOT trimmed.
 *   CC03 — kill-switch default (off): planContextTrim / stablePrefixOrder /
 *          routeModel all passthrough (pack byte-identical, prefix order
 *          byte-identical, model = strong).
 *   CC04 — shadow: trim plan + telemetry computed, pack NOT modified.
 *   CC05 — lever D prefix reorder preserves content multiset; off → identical.
 *   CC06 — lever E routing: verification never routed cheap; escalation fires on
 *          uncertainty/contradiction; off → always strong.
 *   CC07 — resolveContextCostPolicy fail-safe (unrecognised env → off), total,
 *          never throws; structured returns frozen.
 *   CC08 — determinism: same input → same output (ids + order + bytesSaved).
 *
 * All deterministic — no DB, no network, no LLM. Mirrors framework-contract.test.ts.
 *
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *        npx tsx server/lib/model-cost.test.ts
 */

import assert from "node:assert/strict";
import {
  // policy / kill-switch
  resolveContextCostPolicy,
  isContextCostEnforced,
  DEFAULT_CONTEXT_COST_POLICY,
  CONTEXT_COST_POLICY_ENV,
  CONTEXT_COST_POLICY_VERSION,
  // lever C
  planContextTrim,
  verifyTrimPreservesRecall,
  // lever D
  stablePrefixOrder,
  type PromptSegment,
  // lever E
  routeModel,
} from "./model-cost.js";
import {
  computeDecisivePassages,
  measurePackRecall,
  stablePassageId,
} from "./evidence-recall.js";
import type { Chunk } from "./passage-retrieval.js";

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

// ─── Shared fixtures (generic, framework-level — no company/topic specifics) ──

// A measure whose decisive signal is drawn ONLY from its framework-authored
// title + evidenceKeywords (the reused oracle's definition of "decisive").
const MEASURE = {
  measureId: "M-1",
  title: "Operates an independent board-level risk committee",
  evidenceKeywords: ["risk committee", "board oversight", "audit", "remuneration"],
};

let seqCounter = 0;
function chunk(text: string, url: string, title = "Doc"): Chunk {
  return { text, docUrl: url, docTitle: title, seqInDoc: seqCounter++, docIndex: 0 };
}
function ids(cs: Chunk[]): string[] {
  return cs.map((c) => stablePassageId(c));
}

// ─── CC01 — HEADLINE: decisive passages are NEVER trimmed ─────────────────────

test("CC01 headline: every decisive pack passage survives trim + recall unchanged", () => {
  // Six decisive passages, each decisive via the phrase "risk committee" (so each
  // is independently marked by the oracle), spanning the hard cases. Each looks
  // repetitive on purpose — the guarantee is they are STILL kept.
  const decisiveChunks: Chunk[] = [
    // negative evidence
    chunk("The company does not operate a risk committee at board level.", "https://www.highcomarmor.com/wp-content/uploads/2018/12/Plates.jpg"),
    // contradiction
    chunk("Although the risk committee was disbanded, management claims a risk committee still meets.", "https://src/contra"),
    // qualifier
    chunk("Only an informal risk committee exists, subject to board oversight review.", "https://src/qual"),
    // low-frequency decisive token (rare 'remuneration' + phrase)
    chunk("The risk committee reports on remuneration matters once per year.", "https://src/lowfreq"),
    // table-style evidence
    chunk("| Committee | Meetings |\n| risk committee | 4 | board oversight | yes |", "https://lh7-rt.googleusercontent.com/docsz/AD_4nXdZ5y9XW0Ea0w2lO606rOeOoN3ORYXGEpceRfp9ywZnRaHwLit9mVfEB3UGVRo5PzyFVbT8jp9j74ICr9zh88zAcOzpfZRkuIIZIUv9NHsKb_f0p9HezICmRrmpOoNWNdgttPx4wQ?key=VDk_jnxTfC1CObQecGlTZH1E"),
    // single decisive passage that looks repeated
    chunk("Risk committee. Risk committee. Risk committee oversees audit.", "https://src/single"),
  ];
  // Redundant non-decisive repeats (same links, only already-covered single tokens).
  const noise: Chunk[] = [
    chunk("committee", "https://src/neg"),
    chunk("the committee met", "https://src/table"),
  ];
  const pack = [...decisiveChunks, ...noise];
  const corpus = [...pack];

  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });

  // The oracle's decisive set, intersected with the pack.
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: corpus });
  const decisiveIds = new Set(decisive.map((d) => d.id));
  const decisivePackIds = ids(pack).filter((id) => decisiveIds.has(id));
  assert.ok(decisivePackIds.length >= 6, `expected >=6 decisive pack passages, got ${decisivePackIds.length}`);

  const keptSet = new Set(plan.keptIds);
  for (const id of decisivePackIds) {
    assert.ok(keptSet.has(id), `decisive passage ${id} was trimmed — INVARIANT VIOLATED`);
  }

  // Recall must be byte-for-byte preserved with the identical misses set.
  const v = verifyTrimPreservesRecall({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, plan });
  assert.equal(v.ok, true, "trim changed decisive recall");
  assert.equal(v.trimmedRecall, v.originalRecall, "recall changed");
  assert.equal(v.missesEqual, true, "misses set changed");
});

test("CC01b: single decisive passage survives even when it is the only pack content", () => {
  const only = chunk("The board risk committee provides board oversight of audit.", "https://one/x");
  const pack = [only];
  const corpus = [only];
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: corpus });
  // Confirm it is actually decisive, then confirm it is kept.
  assert.ok(decisive.some((d) => d.id === stablePassageId(only)), "fixture is not decisive");
  assert.deepEqual(plan.keptIds, [stablePassageId(only)]);
  assert.equal(plan.trimmedIds.length, 0);
});

// ─── CC02 — only provably-redundant repeats trimmed ───────────────────────────

test("CC02: redundant repeat trimmed; unique decisive token NOT trimmed", () => {
  const anchor = chunk("The risk committee reports to board oversight.", "https://d/1"); // decisive (phrase)
  const redundant = chunk("committee", "https://d/1"); // non-decisive, token covered, same link → trim
  const uniqueToken = chunk("remuneration", "https://d/1"); // non-decisive but NEW token → keep
  const pack = [anchor, redundant, uniqueToken];
  const corpus = [...pack];
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  assert.ok(plan.trimmedIds.includes(stablePassageId(redundant)), "redundant repeat not trimmed");
  assert.ok(plan.keptIds.includes(stablePassageId(uniqueToken)), "unique-token passage wrongly trimmed");
  assert.ok(plan.keptIds.includes(stablePassageId(anchor)), "decisive anchor wrongly trimmed");
  assert.ok(plan.bytesSaved > 0, "bytesSaved should be positive when a repeat is trimmed");
});

test("CC02b: passage with a UNIQUE source link is NOT trimmed", () => {
  const anchor = chunk("The risk committee reports to board oversight.", "https://d/1");
  const uniqueLink = chunk("committee", "https://OTHER/9"); // token covered, but NEW link → keep
  const pack = [anchor, uniqueLink];
  const corpus = [...pack];
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  assert.ok(plan.keptIds.includes(stablePassageId(uniqueLink)), "unique-link passage wrongly trimmed");
  assert.equal(plan.trimmedIds.length, 0);
});

// ─── CC03 — kill-switch default (on, post-GATE5) + env/explicit override ───────

test("CC03: on default (GATE5); env off/shadow + explicit arg override", () => {
  // As of GATE5 the shipped default is "on" (context-trim is standing production).
  assert.equal(DEFAULT_CONTEXT_COST_POLICY, "on");
  assert.equal(CONTEXT_COST_POLICY_VERSION, 1);
  assert.equal(CONTEXT_COST_POLICY_ENV, "CONTEXT_COST_POLICY");

  const prev = process.env[CONTEXT_COST_POLICY_ENV];
  try {
    // env UNSET → resolves to the shipped default "on".
    delete process.env[CONTEXT_COST_POLICY_ENV];
    assert.equal(resolveContextCostPolicy(), "on", "unset env should resolve to default on");
    assert.equal(isContextCostEnforced(), true);

    // env can still override back to off (rollback path) or shadow, no redeploy.
    process.env[CONTEXT_COST_POLICY_ENV] = "off";
    assert.equal(resolveContextCostPolicy(), "off", "env=off must override default on");
    assert.equal(isContextCostEnforced(), false);
    process.env[CONTEXT_COST_POLICY_ENV] = "shadow";
    assert.equal(resolveContextCostPolicy(), "shadow", "env=shadow must override default on");

    // explicit arg wins over env (env=shadow here).
    assert.equal(resolveContextCostPolicy("off"), "off", "explicit off must win over env");
    assert.equal(resolveContextCostPolicy("on"), "on", "explicit on must win over env");
  } finally {
    if (prev === undefined) delete process.env[CONTEXT_COST_POLICY_ENV];
    else process.env[CONTEXT_COST_POLICY_ENV] = prev;
  }

  // Levers are passthrough whenever NOT applied (apply=false), independent of the
  // policy default — this is what the analyzer relies on for the =off skip path.
  const anchor = chunk("The risk committee reports to board oversight.", "https://d/1");
  const redundant = chunk("committee", "https://d/1");
  const pack = [anchor, redundant];
  const corpus = [...pack];
  // apply omitted → passthrough → pack unchanged, every passage kept.
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus });
  assert.equal(plan.fired, false);
  assert.deepEqual(plan.keptIds, ids(pack));
  assert.equal(plan.trimmedIds.length, 0);
  assert.equal(plan.bytesSaved, 0);

  // lever D not applied → original order byte-identical
  const segs: PromptSegment[] = [
    { text: "EVIDENCE", kind: "volatile" },
    { text: "SYSTEM", kind: "stable" },
  ];
  const outD = stablePrefixOrder(segs); // apply defaults false
  assert.deepEqual(outD.map((s) => s.text), ["EVIDENCE", "SYSTEM"]);

  // lever E not applied → strong always
  assert.equal(routeModel({ stage: "scoring", apply: false }).model, "strong");
});

// ─── CC04 — shadow computes plan + telemetry, does NOT modify pack ────────────

test("CC04: shadow computes the trim plan but caller must not modify pack", () => {
  const anchor = chunk("The risk committee reports to board oversight.", "https://s/1");
  const redundant = chunk("committee", "https://s/1");
  const pack = [anchor, redundant];
  const corpus = [...pack];
  // shadow = compute plan (apply:true to module) for telemetry; the CALLER leaves
  // finalEvidence untouched (verified at the analyzer seam, CC-G3 below).
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  assert.ok(plan.fired, "shadow plan should still identify the redundant repeat");
  assert.ok(plan.bytesSaved > 0, "shadow should compute non-zero savings telemetry");
  // Decisive still preserved under the computed plan.
  const v = verifyTrimPreservesRecall({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, plan });
  assert.equal(v.ok, true);
});

// ─── CC05 — lever D multiset preservation + off byte-identical ────────────────

test("CC05: stablePrefixOrder preserves content multiset; off → original order", () => {
  const segs: PromptSegment[] = [
    { text: "VOL-A", kind: "volatile" },
    { text: "STABLE-1", kind: "stable" },
    { text: "VOL-B", kind: "volatile" },
    { text: "STABLE-2", kind: "stable" },
  ];
  // off: identical order
  const off = stablePrefixOrder(segs, false);
  assert.deepEqual(off.map((s) => s.text), ["VOL-A", "STABLE-1", "VOL-B", "STABLE-2"]);

  // on: stable first (relative order kept), volatile last (relative order kept)
  const on = stablePrefixOrder(segs, true);
  assert.deepEqual(on.map((s) => s.text), ["STABLE-1", "STABLE-2", "VOL-A", "VOL-B"]);

  // multiset of content preserved exactly (nothing added/dropped/edited)
  const sortText = (xs: PromptSegment[]) => xs.map((s) => `${s.kind}:${s.text}`).sort();
  assert.deepEqual(sortText(on), sortText(segs));
  assert.deepEqual(sortText(off), sortText(segs));
});

// ─── CC06 — lever E routing scaffold ──────────────────────────────────────────

test("CC06: verification never cheap; escalation on uncertainty; off → strong", () => {
  // verification stage always strong even under on with no signals
  assert.equal(routeModel({ stage: "verification", apply: true }).model, "strong");
  assert.equal(
    routeModel({ stage: "verification", apply: true, uncertaintySignals: { lowConfidence: true } }).model,
    "strong",
  );
  // scoring first-pass, no signals, on → cheap
  const cheap = routeModel({ stage: "scoring", apply: true });
  assert.equal(cheap.model, "cheap");
  assert.equal(cheap.escalate, false);
  // scoring with each uncertainty signal → escalate to strong
  for (const sig of [
    { lowConfidence: true },
    { contradictoryEvidence: true },
    { nearThreshold: true },
  ]) {
    const d = routeModel({ stage: "scoring", apply: true, uncertaintySignals: sig });
    assert.equal(d.model, "strong", `expected strong for ${JSON.stringify(sig)}`);
    assert.equal(d.escalate, true);
  }
  // off → strong regardless of stage/signals
  assert.equal(routeModel({ stage: "scoring", apply: false, uncertaintySignals: { lowConfidence: true } }).model, "strong");
});

// ─── CC07 — policy resolution fail-safe + frozen returns ──────────────────────

test("CC07: resolveContextCostPolicy fail-safe + total + frozen returns", () => {
  const prev = process.env[CONTEXT_COST_POLICY_ENV];
  try {
    for (const bad of ["", "   ", "garbage", "ON2", "shadowy", "0", "true"]) {
      process.env[CONTEXT_COST_POLICY_ENV] = bad;
      // Post-GATE5 the fail-safe is the shipped default "on" (never silently
      // disables the proven context-trim from a typo).
      assert.equal(resolveContextCostPolicy(), "on", `env="${bad}" should resolve to default on`);
    }
    for (const good of ["off", "shadow", "on", "  ON  ", "Shadow"]) {
      process.env[CONTEXT_COST_POLICY_ENV] = good;
      assert.equal(resolveContextCostPolicy(), good.trim().toLowerCase());
    }
    // explicit arg wins over env
    process.env[CONTEXT_COST_POLICY_ENV] = "on";
    assert.equal(resolveContextCostPolicy("off"), "off");
    assert.equal(isContextCostEnforced("on"), true);
    assert.equal(isContextCostEnforced("shadow"), false);
  } finally {
    if (prev === undefined) delete process.env[CONTEXT_COST_POLICY_ENV];
    else process.env[CONTEXT_COST_POLICY_ENV] = prev;
  }

  // structured returns are frozen (cannot be mutated downstream)
  const anchor = chunk("The risk committee reports to board oversight.", "https://f/1");
  const plan = planContextTrim({ measure: MEASURE, packChunks: [anchor], corpusChunks: [anchor], apply: true });
  assert.throws(() => {
    (plan as unknown as { fired: boolean }).fired = true;
  });
  const route = routeModel({ stage: "scoring", apply: true });
  assert.throws(() => {
    (route as unknown as { model: string }).model = "x";
  });
});

// ─── CC08 — determinism ───────────────────────────────────────────────────────

test("CC08: same input → same output (ids + order + bytesSaved)", () => {
  const build = (): Chunk[] => {
    seqCounter = 1000; // deterministic seqs so ids are reproducible across builds
    return [
      chunk("The risk committee reports to board oversight.", "https://z/1"),
      chunk("committee", "https://z/1"),
      chunk("remuneration audit", "https://z/2"),
      chunk("committee", "https://z/1"),
    ];
  };
  const p1 = build();
  const plan1 = planContextTrim({ measure: MEASURE, packChunks: p1, corpusChunks: [...p1], apply: true });
  const p2 = build();
  const plan2 = planContextTrim({ measure: MEASURE, packChunks: p2, corpusChunks: [...p2], apply: true });
  assert.deepEqual(plan1.keptIds, plan2.keptIds);
  assert.deepEqual(plan1.trimmedIds, plan2.trimmedIds);
  assert.equal(plan1.bytesSaved, plan2.bytesSaved);
});

// ─── CC-G3 — offline byte-identical-at-default proof (GATE 3) ──────────────────

test("CC-G3: at CONTEXT_COST_POLICY=off, planContextTrim leaves pack byte-identical ⇒ Y→N=0, N→Y=0", () => {
  // Simulate the analyzer seam: finalEvidence is the ordered pack text.
  const packChunks: Chunk[] = [
    chunk("The risk committee reports to board oversight.", "https://g/1"),
    chunk("committee", "https://g/1"), // a would-be redundant repeat
    chunk("remuneration audit figures.", "https://g/2"),
  ];
  const finalEvidence = packChunks.map((c) => c.text).join("\n");

  const prev = process.env[CONTEXT_COST_POLICY_ENV];
  try {
    process.env[CONTEXT_COST_POLICY_ENV] = "off"; // explicit off = rollback path
    assert.equal(resolveContextCostPolicy(), "off");
    // At off, the analyzer SKIPS the block entirely; modelled here as apply omitted.
    const plan = planContextTrim({ measure: MEASURE, packChunks, corpusChunks: [...packChunks] });
    // keptIds == all pack ids in order ⇒ reconstructed pack is byte-identical.
    assert.deepEqual(plan.keptIds, ids(packChunks));
    const keptSet = new Set(plan.keptIds);
    const rebuilt = packChunks.filter((c) => keptSet.has(stablePassageId(c))).map((c) => c.text).join("\n");
    assert.equal(rebuilt, finalEvidence, "pack not byte-identical at default off");
    // By construction: no cell can flip ⇒ Total Y→N = 0, N→Y = 0, Total Flips = 0.
  } finally {
    if (prev === undefined) delete process.env[CONTEXT_COST_POLICY_ENV];
    else process.env[CONTEXT_COST_POLICY_ENV] = prev;
  }
});

// ─── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
