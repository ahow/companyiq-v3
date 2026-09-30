// Unit tests for the terminating synonym-adjudication gate.
//
// Pure functions only — no DB, no LLM. These verify the LOOP TERMINATOR: once an
// operator adjudicates a flagged synonym, the gate stops surfacing it, and
// "removed" decisions physically drop the term. Topic-agnostic throughout.
//
// Run: npx tsx --test server/lib/framework-v2/synonym-adjudication.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSynonymAdjudicationGate,
  applyAdjudications,
  isAdjudicated,
  adjudicationKey,
  normalizeSynTerm,
  normalizeTopicKey,
  type SynonymAdjudication,
} from "./synonym-adjudication.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TOPIC = "climate transition planning";
// "climate" / "transition" are distinctive tokens (len>=4) shared with the topic,
// so these are anchored and NOT flagged.
const ANCHORED = "climate transition strategy";
// Unrelated, non-debris, non-filing term — llm-origin + not topically anchored ⇒
// flagged-for-review by lexicon hygiene. This is the recurring-noise class.
const NOISE = "quarterly dividend policy";

function adj(term: string, decision: "removed" | "kept"): SynonymAdjudication {
  return {
    term,
    topicKey: normalizeTopicKey(TOPIC),
    decision,
    decidedAt: new Date().toISOString(),
  };
}

// ─── The gate detects flagged non-anchored synonyms ──────────────────────────

test("gate flags a non-anchored synonym (unresolved, not terminated)", () => {
  const report = runSynonymAdjudicationGate({
    topicTerm: TOPIC,
    topicSynonyms: [ANCHORED, NOISE],
    topicTokens: [TOPIC, ANCHORED],
  });
  // The anchored term is protected; the noise term is flagged.
  const flaggedTerms = report.flagged.map((f) => f.term);
  assert.ok(flaggedTerms.includes(NOISE), "noise term should be flagged for review");
  assert.ok(!flaggedTerms.includes(ANCHORED), "anchored term must not be flagged");
  // With no adjudications, the flagged term is unresolved ⇒ loop NOT terminated.
  assert.equal(report.passed, false);
  assert.ok(report.unresolved.some((u) => u.term === NOISE));
  assert.equal(report.resolved.length, 0);
});

// ─── The gate terminates once every flag is adjudicated ──────────────────────

test("gate subtracts adjudicated terms and terminates (kept)", () => {
  const report = runSynonymAdjudicationGate({
    topicTerm: TOPIC,
    topicSynonyms: [ANCHORED, NOISE],
    topicTokens: [TOPIC, ANCHORED],
    adjudications: [adj(NOISE, "kept")],
  });
  assert.equal(report.passed, true, "no unresolved flags ⇒ loop terminated");
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.resolved.length, 1);
  // "kept" does NOT drop the term from the synonyms list.
  assert.ok(report.resolvedSynonyms.includes(NOISE));
  assert.equal(report.removedTerms.length, 0);
});

test("gate drops removed terms and terminates (removed)", () => {
  const report = runSynonymAdjudicationGate({
    topicTerm: TOPIC,
    topicSynonyms: [ANCHORED, NOISE],
    topicTokens: [TOPIC, ANCHORED],
    adjudications: [adj(NOISE, "removed")],
  });
  assert.equal(report.passed, true);
  assert.equal(report.unresolved.length, 0);
  assert.deepEqual(report.removedTerms, [NOISE]);
  assert.ok(!report.resolvedSynonyms.includes(NOISE), "removed term dropped from synonyms");
  assert.ok(report.resolvedSynonyms.includes(ANCHORED), "anchored term preserved");
});

// ─── applyAdjudications drops "removed" only, order-preserving ───────────────

test("applyAdjudications drops removed only and preserves order", () => {
  const { kept, removed } = applyAdjudications(
    ["alpha", "beta", "gamma"],
    [adj("beta", "removed"), adj("gamma", "kept")],
    normalizeTopicKey(TOPIC),
  );
  assert.deepEqual(kept, ["alpha", "gamma"]);
  assert.deepEqual(removed, ["beta"]);
});

// ─── isAdjudicated true/false ────────────────────────────────────────────────

test("isAdjudicated reflects recorded decisions", () => {
  const decisions = [adj(NOISE, "removed")];
  const key = normalizeTopicKey(TOPIC);
  assert.equal(isAdjudicated(NOISE, key, decisions), true);
  assert.equal(isAdjudicated("never seen", key, decisions), false);
  assert.equal(isAdjudicated(NOISE, key, []), false);
  assert.equal(isAdjudicated(NOISE, key, undefined), false);
});

// ─── Idempotency key normalisation (case / whitespace) ──────────────────────

test("adjudication key is stable under case and whitespace", () => {
  const key = normalizeTopicKey(TOPIC);
  assert.equal(
    adjudicationKey("  Quarterly   Dividend Policy ", key),
    adjudicationKey("quarterly dividend policy", key),
  );
  // A decision recorded under messy casing still resolves a clean lookup.
  const messy = [adj("  QUARTERLY  dividend POLICY ", "removed")];
  assert.equal(isAdjudicated("quarterly dividend policy", key, messy), true);
});

test("normalizeSynTerm collapses case and internal whitespace", () => {
  assert.equal(normalizeSynTerm("  Foo   Bar "), "foo bar");
  assert.equal(normalizeSynTerm(null), "");
  assert.equal(normalizeSynTerm(undefined), "");
});

// ─── The gate never throws on malformed input ───────────────────────────────

test("gate returns an empty passed report for malformed/empty input", () => {
  const empty = runSynonymAdjudicationGate({ topicTerm: TOPIC, topicSynonyms: null });
  assert.equal(empty.passed, true);
  assert.equal(empty.flagged.length, 0);
  assert.equal(empty.unresolved.length, 0);

  const junk = runSynonymAdjudicationGate({
    topicTerm: undefined,
    topicSynonyms: [123, null, {}, "  "] as unknown[],
  });
  assert.ok(Array.isArray(junk.resolvedSynonyms));
  assert.equal(junk.passed, junk.unresolved.length === 0);
});
