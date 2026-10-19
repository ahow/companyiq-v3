/**
 * Unit tests for the verdict-stability classifier (Issue 1, build-time).
 *
 * Deterministic: NO LLM, NO DB, NO network. Pure functions only.
 *
 * Topic-agnosticism is proved explicitly: the SAME structural wording is flagged
 * (or cleared) identically regardless of the topic vocabulary around it. Fixtures
 * span THREE unrelated domains — climate/emissions, workplace safety/labour, and
 * data privacy — none of which the classifier knows anything about.
 *
 * Runner:  DATABASE_URL=postgres://x npx tsx --test verdict-stability.test.ts
 * (No DB is touched; DATABASE_URL only satisfies module-load of sibling imports.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyMeasureStability,
  COUNTABLE_REWRITE_GUIDANCE,
  CONJUNCTIVE_BUNDLE_GUIDANCE,
  type MeasureStabilityInput,
} from "./verdict-stability.js";
import {
  hasCountableRule,
  splitIntoConditions,
  hasNamedArtefactEnumeration,
  hasSoftSelectionGate,
  hasConjunctiveBundle,
  describeSoftGate,
} from "./rules.js";

// ─── Exported-predicate sanity (the shared primitives, one definition) ───────

test("hasCountableRule detects N-of-M selection and >=3 enumerations", () => {
  assert.equal(hasCountableRule("Yes if at least 2 of the following appear"), true);
  assert.equal(hasCountableRule("any three of the listed items"), true);
  assert.equal(hasCountableRule("(1) foo (2) bar (3) baz"), true);
  assert.equal(hasCountableRule("the policy is comprehensive and robust"), false);
  assert.equal(hasCountableRule(""), false);
});

test("hasNamedArtefactEnumeration needs >=2 lettered sub-items", () => {
  assert.equal(hasNamedArtefactEnumeration("names (a) a target and (b) a date"), true);
  assert.equal(hasNamedArtefactEnumeration("only (a) one item"), false);
});

test("splitIntoConditions splits top-level numbered conditions, not (a)(b) sub-items", () => {
  const parts = splitIntoConditions("(1) first condition (2) second with (a) sub (b) sub");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /first condition/);
});

test("soft-gate vs conjunctive-bundle predicates are mutually distinguishing", () => {
  assert.equal(hasSoftSelectionGate("Yes if any of the following are present"), true);
  assert.equal(hasConjunctiveBundle("Yes if any of the following are present"), false);
  assert.equal(hasConjunctiveBundle("requires all of the following to co-occur"), true);
  const d = describeSoftGate("at least 2 of the following: (1) x (2) y (3) z");
  assert.equal(d.n, 2);
});

// ─── Topic-agnostic fixture builders ─────────────────────────────────────────
// Each builder injects a DIFFERENT topic's vocabulary into an IDENTICAL gramm/ structure.

/** A degree-word-decided fallback with NO countable/named test (borderline). */
function degreeWordMeasure(topic: string, subject: string): MeasureStabilityInput {
  return {
    measureId: `${topic}-dw`,
    title: `Does the entity have a ${subject}`,
    fallbackYesCriterion: `Yes if the entity has a substantively integrated and robust ${subject} that is systematically applied.`,
  };
}

/** The SAME degree word, but rescued by an in-condition named-artefact enumeration (stable). */
function degreeWordRescuedMeasure(topic: string, subject: string): MeasureStabilityInput {
  return {
    measureId: `${topic}-dw-ok`,
    title: `Does the entity have a ${subject}`,
    fallbackYesCriterion: `Yes if a verbatim quote shows a robust ${subject} naming (a) a quantified target and (b) an approval date.`,
  };
}

/** An M-of-N soft gate not hardened into a conjunctive bundle (borderline). */
function softGateMeasure(topic: string, items: [string, string, string]): MeasureStabilityInput {
  return {
    measureId: `${topic}-soft`,
    title: `Does the entity address ${topic}`,
    fallbackYesCriterion: `Yes if any of the following are present: (1) ${items[0]}, (2) ${items[1]}, (3) ${items[2]}.`,
  };
}

/** A conjunctive hard-token bundle (stable). */
function bundleMeasure(topic: string, items: [string, string]): MeasureStabilityInput {
  return {
    measureId: `${topic}-bundle`,
    title: `Does the entity address ${topic}`,
    fallbackYesCriterion: `Return Yes ONLY if a single verbatim quote satisfies ALL of the following: (1) it names ${items[0]}, AND (2) it names ${items[1]}.`,
  };
}

// Three unrelated topics used throughout.
const TOPICS = {
  climate: { subject: "emissions reduction plan", items: ["a scope-1 figure", "a net-zero date", "a capex line"] as [string, string, string], bundle: ["a reduction target", "a baseline year"] as [string, string] },
  safety: { subject: "worker safety management system", items: ["an incident rate", "a training record", "an audit"] as [string, string, string], bundle: ["a lost-time injury rate", "a corrective-action log"] as [string, string] },
  privacy: { subject: "personal-data retention policy", items: ["a retention period", "a deletion process", "a DPO contact"] as [string, string, string], bundle: ["a retention schedule", "a legal basis"] as [string, string] },
};

// ─── Reason 1: degree-word deciding test ─────────────────────────────────────

test("degree-word deciding test is flagged borderline across ALL topics identically", () => {
  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const res = classifyMeasureStability(degreeWordMeasure(topic, cfg.subject));
    assert.equal(res.risk, "borderline", `${topic} should be borderline`);
    assert.ok(res.reasons.some((r) => r.code === "degree-word-deciding-test"), `${topic} missing degree-word reason`);
    assert.equal(res.reasons.find((r) => r.code === "degree-word-deciding-test")!.fix, COUNTABLE_REWRITE_GUIDANCE);
  }
});

test("degree word rescued by a named-artefact enumeration is stable across ALL topics", () => {
  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const res = classifyMeasureStability(degreeWordRescuedMeasure(topic, cfg.subject));
    assert.ok(!res.reasons.some((r) => r.code === "degree-word-deciding-test"), `${topic} should NOT carry a degree-word reason`);
  }
});

test("degree word rescued by a countable rule in the SAME condition is stable", () => {
  const res = classifyMeasureStability({
    measureId: "x",
    fallbackYesCriterion: "Yes if the robust programme meets at least 2 of the following: (a) x, (b) y, (c) z.",
  });
  assert.ok(!res.reasons.some((r) => r.code === "degree-word-deciding-test"));
});

test("measure-level degree word (scoringGuidance) with no countable rule is borderline", () => {
  const res = classifyMeasureStability({
    measureId: "x",
    scoringGuidance: "Award Yes when the disclosure is comprehensive and effective.",
  });
  assert.equal(res.risk, "borderline");
  assert.ok(res.reasons.some((r) => r.code === "degree-word-deciding-test"));
});

// ─── Reason 2: M-of-N / OR-list soft gate ────────────────────────────────────

test("M-of-N soft gate is flagged borderline across ALL topics identically", () => {
  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const res = classifyMeasureStability(softGateMeasure(topic, cfg.items));
    assert.equal(res.risk, "borderline", `${topic} should be borderline`);
    assert.ok(res.reasons.some((r) => r.code === "m-of-n-soft-gate"), `${topic} missing soft-gate reason`);
    assert.equal(res.reasons.find((r) => r.code === "m-of-n-soft-gate")!.fix, CONJUNCTIVE_BUNDLE_GUIDANCE);
  }
});

test("conjunctive hard-token bundle is stable across ALL topics", () => {
  for (const [topic, cfg] of Object.entries(TOPICS)) {
    const res = classifyMeasureStability(bundleMeasure(topic, cfg.bundle));
    assert.equal(res.risk, "stable", `${topic} bundle should be stable`);
    assert.equal(res.reasons.length, 0);
  }
});

// ─── Topic-agnosticism invariant (the core proof) ────────────────────────────

test("identical structure yields identical risk+reason-codes regardless of topic", () => {
  const results = Object.entries(TOPICS).map(([t, cfg]) => classifyMeasureStability(degreeWordMeasure(t, cfg.subject)));
  const codeSets = results.map((r) => r.reasons.map((x) => x.code).sort().join(","));
  assert.equal(new Set(codeSets).size, 1, "all topics must produce the same reason-code set");
  assert.equal(codeSets[0], "degree-word-deciding-test");
});

test("a measure carrying BOTH defects reports both reasons", () => {
  const res = classifyMeasureStability({
    measureId: "both",
    fallbackYesCriterion: "Yes if any of the following are present: (1) a robust and comprehensively integrated programme, (2) b, (3) c.",
  });
  const codes = new Set(res.reasons.map((r) => r.code));
  assert.ok(codes.has("degree-word-deciding-test"));
  assert.ok(codes.has("m-of-n-soft-gate"));
});

// ─── Clean measure ───────────────────────────────────────────────────────────

test("a countable, conjunctive measure with no degree words is stable", () => {
  const res = classifyMeasureStability({
    measureId: "clean",
    fallbackYesCriterion: "Return Yes ONLY if a single verbatim quote names all of the following: (a) a dated board approval, (b) a numeric target.",
  });
  assert.equal(res.risk, "stable");
});

test("empty / undefined fields are stable (nothing to decide)", () => {
  assert.equal(classifyMeasureStability({ measureId: "empty" }).risk, "stable");
});
