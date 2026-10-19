/**
 * model-cost.test.ts — B5 / WP13-C/D/E committed test suite.
 *
 * Proves the three model-cost levers ship SAFE and framework-level. As of the
 * Issue-4 fix "redundant" means a GENUINE near-duplicate (>=90% word-shingle
 * containment within an already-KEPT passage) — a passage that carries unique
 * information is NEVER trimmed, even with no keyword hit and an already-cited doc —
 * and the shipped default is "shadow" (drops nothing out of the box):
 *   CC01 (HEADLINE) — a DECISIVE pack passage is NEVER dropped by trim, across
 *                     negative evidence, contradiction, qualifier, low-frequency
 *                     decisive token, table-style evidence, and the single
 *                     decisive passage case. decisive-pack-ids ⊆ kept-ids AND
 *                     pack recall unchanged for every case.
 *   CC02 — genuine >=90% near-duplicate trimmed; a passage ~85% overlapping (below
 *          threshold) is NOT trimmed.
 *   CC02b (ISSUE-4 CORE REGRESSION) — a unique qualifier/date/scope/negation with
 *          NO keyword hit, from an ALREADY-CITED document, is NEVER trimmed.
 *   CC02c — word-shingle primitives: wordShingles (empty below k) + shingleContainment.
 *   CC03 — kill-switch default (shadow): drops nothing; env/explicit override.
 *   CC04 — applyContextTrimPolicy: off → full pack + no log; shadow → full pack +
 *          would-trim marker/count; on → trimmed pack.
 *   CC05 — lever D prefix reorder preserves content multiset; off → identical.
 *   CC06 — lever E routing: verification never routed cheap; escalation fires on
 *          uncertainty/contradiction; off → always strong.
 *   CC07 — resolveContextCostPolicy fail-safe (unrecognised env → shadow), total,
 *          never throws; structured returns frozen.
 *   CC08 — determinism: same input → same output (ids + order + bytesSaved).
 *   CC09 — short passages (below shingle size) are NEVER trimmed, even if repeated.
 *
 * All deterministic — no DB, no network, no LLM. Custom in-file harness (matches
 * the existing suite); the process self-exits on completion (no open handles), and
 * exits non-zero on any failure. Run WITHOUT a forced timeout:
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *     npx tsx server/lib/model-cost.test.ts
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
  applyContextTrimPolicy,
  wordShingles,
  shingleContainment,
  NEAR_DUP_SHINGLE_K,
  NEAR_DUP_CONTAINMENT,
  // lever D
  stablePrefixOrder,
  type PromptSegment,
  // lever E
  routeModel,
} from "./model-cost.js";
import {
  computeDecisivePassages,
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

// Deterministic neutral word sequence "w0 w1 ... w{n-1}", with one optional swap.
// None of these tokens are decisive for MEASURE, so passages built from them are
// non-decisive — isolating the near-duplicate math from the decisive oracle.
function words(n: number, swapIdx = -1, swapTo = "zz"): string {
  const arr: string[] = [];
  for (let i = 0; i < n; i++) arr.push(i === swapIdx ? swapTo : `w${i}`);
  return arr.join(" ");
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
    chunk("Only an informal risk committee exists, subject to board oversight review.", "https://www.gruposura.com/wp-content/uploads/2025/06/Graficos_Gobierno_GS_EN.png"),
    // low-frequency decisive token (rare 'remuneration' + phrase)
    chunk("The risk committee reports on remuneration matters once per year.", "https://src/lowfreq"),
    // table-style evidence
    chunk("| Committee | Meetings |\n| risk committee | 4 | board oversight | yes |", "https://lh7-rt.googleusercontent.com/docsz/AD_4nXdZ5y9XW0Ea0w2lO606rOeOoN3ORYXGEpceRfp9ywZnRaHwLit9mVfEB3UGVRo5PzyFVbT8jp9j74ICr9zh88zAcOzpfZRkuIIZIUv9NHsKb_f0p9HezICmRrmpOoNWNdgttPx4wQ?key=VDk_jnxTfC1CObQecGlTZH1E"),
    // single decisive passage that looks repeated
    chunk("Risk committee. Risk committee. Risk committee oversees audit.", "https://src/single"),
  ];
  // Non-decisive short noise (same links). These are too short to form a shingle
  // and so are also never trimmable — but CC01 only asserts the decisive invariant.
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

// ─── CC02 — only GENUINE >=90% near-duplicates trimmed ────────────────────────

test("CC02: genuine >=90% near-duplicate trimmed; ~85% overlap (below threshold) NOT trimmed", () => {
  // base: 30 neutral tokens → 30-4+1 = 27 four-shingles. Non-decisive, kept first.
  const base = chunk(words(30), "https://d/1");
  // nearDup: only the LAST token changed → breaks a single shingle window ⇒
  // containment 26/27 = 0.963 >= 0.90 → TRIMMED.
  const nearDup = chunk(words(30, 29, "zz"), "https://d/1");
  // belowThreshold: a MIDDLE token changed → breaks 4 windows ⇒ 23/27 = 0.852
  // < 0.90 → KEPT (carries enough that is not contained in base).
  const belowThreshold = chunk(words(30, 15, "qq"), "https://d/2");
  const pack = [base, nearDup, belowThreshold];
  const corpus = [...pack];

  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });

  assert.ok(plan.trimmedIds.includes(stablePassageId(nearDup)), "genuine >=90% near-dup not trimmed");
  assert.ok(plan.keptIds.includes(stablePassageId(base)), "base (first occurrence) wrongly trimmed");
  assert.ok(plan.keptIds.includes(stablePassageId(belowThreshold)), "~85% overlap passage wrongly trimmed");
  assert.equal(plan.trimmedIds.length, 1, "only the true near-duplicate should be trimmed");
  assert.ok(plan.bytesSaved > 0, "bytesSaved should be positive when a near-dup is trimmed");
});

// ─── CC02b — ISSUE-4 CORE REGRESSION ──────────────────────────────────────────

test("CC02b (Issue-4): unique qualifier/date/scope/negation, NO keyword, already-cited doc → NEVER trimmed", () => {
  // anchor: decisive (phrase "risk committee" + "board oversight"); it cites doc d/1.
  const anchor = chunk("The risk committee reports to board oversight.", "https://d/1");
  // These carry UNIQUE information and NO decisive keyword/token, and come from the
  // SAME already-cited document d/1. The OLD predicate dropped them (no keyword +
  // doc already represented). The fixed predicate keeps them (not near-duplicates).
  const negation = chunk("However, no equivalent arrangement existed at the subsidiary tier during that year.", "https://d/1");
  const dateScope = chunk("This provision did not apply to the overseas joint ventures before March 2021.", "https://d/1");
  const pack = [anchor, negation, dateScope];
  const corpus = [...pack];

  // Confirm the two regression passages really are NON-decisive (no keyword hit).
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: corpus });
  const decisiveIds = new Set(decisive.map((d) => d.id));
  assert.ok(!decisiveIds.has(stablePassageId(negation)), "negation fixture unexpectedly decisive");
  assert.ok(!decisiveIds.has(stablePassageId(dateScope)), "dateScope fixture unexpectedly decisive");

  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  assert.equal(plan.trimmedIds.length, 0, "a unique non-keyword passage from an already-cited doc was trimmed — Issue-4 regression");
  assert.ok(plan.keptIds.includes(stablePassageId(negation)), "unique negation wrongly trimmed");
  assert.ok(plan.keptIds.includes(stablePassageId(dateScope)), "unique date/scope wrongly trimmed");
});

// ─── CC02c — word-shingle primitives ──────────────────────────────────────────

test("CC02c: wordShingles (empty below k) + shingleContainment math", () => {
  assert.equal(NEAR_DUP_SHINGLE_K, 4);
  assert.equal(NEAR_DUP_CONTAINMENT, 0.9);
  // below k tokens → NO shingles (short-passage guarantee).
  assert.equal(wordShingles("a b c").size, 0);
  assert.equal(wordShingles("one two three").size, 0);
  // exactly k tokens → exactly one shingle.
  assert.equal(wordShingles("one two three four").size, 1);
  // n tokens → n-k+1 shingles.
  assert.equal(wordShingles(words(30)).size, 27);
  // containment of a set within itself is 1; empty candidate → 0.
  const s = wordShingles(words(10));
  assert.equal(shingleContainment(s, s), 1);
  assert.equal(shingleContainment(new Set<string>(), s), 0);
  // 26/27 overlap for a single-word tail change.
  const a = wordShingles(words(30));
  const b = wordShingles(words(30, 29, "zz"));
  assert.ok(Math.abs(shingleContainment(b, a) - 26 / 27) < 1e-9, "tail-change containment should be 26/27");
});

// ─── CC03 — kill-switch default (shadow, Issue-4) + env/explicit override ──────

test("CC03: shadow default (Issue-4); env off/on + explicit arg override", () => {
  // As of the Issue-4 fix the shipped default is "shadow" (drops nothing).
  assert.equal(DEFAULT_CONTEXT_COST_POLICY, "shadow");
  assert.equal(CONTEXT_COST_POLICY_VERSION, 1);
  assert.equal(CONTEXT_COST_POLICY_ENV, "CONTEXT_COST_POLICY");

  const prev = process.env[CONTEXT_COST_POLICY_ENV];
  try {
    // env UNSET → resolves to the shipped default "shadow" (NOT enforced).
    delete process.env[CONTEXT_COST_POLICY_ENV];
    assert.equal(resolveContextCostPolicy(), "shadow", "unset env should resolve to default shadow");
    assert.equal(isContextCostEnforced(), false, "shadow default must not enforce trimming");

    // env can override to off (rollback) or on (active trim), no redeploy.
    process.env[CONTEXT_COST_POLICY_ENV] = "off";
    assert.equal(resolveContextCostPolicy(), "off", "env=off must override default shadow");
    assert.equal(isContextCostEnforced(), false);
    process.env[CONTEXT_COST_POLICY_ENV] = "on";
    assert.equal(resolveContextCostPolicy(), "on", "env=on must override default shadow");
    assert.equal(isContextCostEnforced(), true);

    // explicit arg wins over env (env=on here).
    assert.equal(resolveContextCostPolicy("off"), "off", "explicit off must win over env");
    assert.equal(resolveContextCostPolicy("shadow"), "shadow", "explicit shadow must win over env");
  } finally {
    if (prev === undefined) delete process.env[CONTEXT_COST_POLICY_ENV];
    else process.env[CONTEXT_COST_POLICY_ENV] = prev;
  }

  // planContextTrim is a passthrough whenever NOT applied (apply=false), independent
  // of the policy default — this is what the analyzer relies on for the =off skip.
  const base = chunk(words(30), "https://d/1");
  const nearDup = chunk(words(30, 29, "zz"), "https://d/1");
  const pack = [base, nearDup];
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

// ─── CC04 — applyContextTrimPolicy modes (off / shadow / on) ──────────────────

test("CC04: applyContextTrimPolicy — off → full pack + no log; shadow → full pack + would-trim marker; on → trimmed", () => {
  const base = chunk(words(30), "https://s/1");           // kept first (non-decisive)
  const nearDup = chunk(words(30, 29, "zz"), "https://s/1"); // >=90% near-dup of base
  const pack = [base, nearDup];
  const corpus = [...pack];

  // off → identity: full pack, no log line, not applied.
  const off = applyContextTrimPolicy({ policy: "off", measure: MEASURE, packChunks: pack, corpusChunks: corpus });
  assert.equal(off.policy, "off");
  assert.equal(off.applied, false);
  assert.equal(off.keptChunks.length, pack.length, "off must return the FULL pack");
  assert.equal(off.logLine, null, "off must not log");

  // shadow → DROPS NOTHING: full pack returned, but reports what it WOULD trim.
  const shadow = applyContextTrimPolicy({ policy: "shadow", measure: MEASURE, packChunks: pack, corpusChunks: corpus });
  assert.equal(shadow.policy, "shadow");
  assert.equal(shadow.applied, false, "shadow must not apply the trim");
  assert.equal(shadow.keptChunks.length, pack.length, "shadow must return the FULL pack unchanged");
  assert.ok(shadow.logLine && shadow.logLine.includes("[CONTEXT-TRIM][shadow]"), "shadow must log the marker");
  assert.ok(shadow.logLine!.includes("would-trim 1/2"), `shadow log should report the would-trim count, got: ${shadow.logLine}`);
  assert.equal(shadow.plan.trimmedIds.length, 1, "shadow should still DETECT the 1 near-duplicate");

  // on → actually trims the near-duplicate, keeping pack order.
  const on = applyContextTrimPolicy({ policy: "on", measure: MEASURE, packChunks: pack, corpusChunks: corpus });
  assert.equal(on.policy, "on");
  assert.equal(on.applied, true, "on should apply the trim");
  assert.deepEqual(on.keptChunks.map((c) => stablePassageId(c)), [stablePassageId(base)], "on must keep base, drop near-dup");
  assert.ok(on.plan.trimmedIds.includes(stablePassageId(nearDup)));
  assert.ok(on.logLine && on.logLine.includes("[CONTEXT-TRIM][on]"));

  // on with NOTHING trimmable → full pack, not applied, 0-count log.
  const uniq = [chunk(words(30), "https://s/2"), chunk(words(30).replace(/w/g, "x"), "https://s/2")];
  const onNoop = applyContextTrimPolicy({ policy: "on", measure: MEASURE, packChunks: uniq, corpusChunks: [...uniq] });
  assert.equal(onNoop.applied, false, "on with no near-dups must not apply");
  assert.equal(onNoop.keptChunks.length, uniq.length);
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

test("CC07: resolveContextCostPolicy fail-safe (→ shadow) + total + frozen returns", () => {
  const prev = process.env[CONTEXT_COST_POLICY_ENV];
  try {
    for (const bad of ["", "   ", "garbage", "ON2", "shadowy", "0", "true"]) {
      process.env[CONTEXT_COST_POLICY_ENV] = bad;
      // Issue-4 fail-safe is the shipped default "shadow" (a typo can NEVER
      // silently drop evidence — it drops nothing).
      assert.equal(resolveContextCostPolicy(), "shadow", `env="${bad}" should resolve to default shadow`);
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
      chunk(words(30), "https://z/1"),             // base, kept
      chunk(words(30, 29, "zz"), "https://z/1"),   // >=90% near-dup → trimmed
      chunk(words(30, 15, "qq"), "https://z/2"),   // ~85% overlap → kept
    ];
  };
  const p1 = build();
  const plan1 = planContextTrim({ measure: MEASURE, packChunks: p1, corpusChunks: [...p1], apply: true });
  const p2 = build();
  const plan2 = planContextTrim({ measure: MEASURE, packChunks: p2, corpusChunks: [...p2], apply: true });
  assert.deepEqual(plan1.keptIds, plan2.keptIds);
  assert.deepEqual(plan1.trimmedIds, plan2.trimmedIds);
  assert.equal(plan1.bytesSaved, plan2.bytesSaved);
  assert.equal(plan1.trimmedIds.length, 1, "exactly the one near-duplicate should trim");
});

// ─── CC09 — short passages below shingle size are NEVER trimmed ───────────────

test("CC09: short passages (below shingle size) are never trimmed, even when repeated", () => {
  // Short, NON-decisive passages (< k=4 tokens). Neither can form a shingle, so
  // even an EXACT repeat is kept — isolating the short-passage guarantee from the
  // decisive oracle (none of these tokens are decisive for MEASURE).
  const a = chunk("alpha beta gamma", "https://sh/1");  // 3 tokens
  const b = chunk("alpha beta gamma", "https://sh/2");  // exact repeat, different doc
  const c = chunk("delta epsilon", "https://sh/3");     // 2 tokens
  const pack = [a, b, c];
  const corpus = [...pack];
  // Guard: confirm the fixtures really are non-decisive, so a "kept" result proves
  // the short-passage guarantee and not merely the decisive force-keep.
  const decisive = computeDecisivePassages({ measure: MEASURE, chunks: corpus });
  assert.equal(decisive.length, 0, "short fixtures should be non-decisive");
  const plan = planContextTrim({ measure: MEASURE, packChunks: pack, corpusChunks: corpus, apply: true });
  assert.equal(plan.trimmedIds.length, 0, "short passages must never be trimmed");
  assert.deepEqual(plan.keptIds, ids(pack));
});

// ─── CC-G3 — offline byte-identical-at-off proof (GATE 3) ──────────────────────

test("CC-G3: at CONTEXT_COST_POLICY=off, applyContextTrimPolicy leaves pack byte-identical ⇒ Y→N=0, N→Y=0", () => {
  // Simulate the analyzer seam: finalEvidence is the ordered pack text.
  const packChunks: Chunk[] = [
    chunk("The risk committee reports to board oversight.", "https://g/1"),
    chunk(words(30), "https://g/1"),              // a would-be near-dup anchor
    chunk(words(30, 29, "zz"), "https://g/1"),    // a would-be >=90% near-duplicate
  ];
  const finalEvidence = packChunks.map((c) => c.text).join("\n");

  // At off, the mode helper returns the FULL pack and no log — nothing can flip.
  const outcome = applyContextTrimPolicy({ policy: "off", measure: MEASURE, packChunks, corpusChunks: [...packChunks] });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.logLine, null);
  const rebuilt = outcome.keptChunks.map((c) => c.text).join("\n");
  assert.equal(rebuilt, finalEvidence, "pack not byte-identical at off");
  // By construction: no cell can flip ⇒ Total Y→N = 0, N→Y = 0, Total Flips = 0.
});

// ─── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
