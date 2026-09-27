/**
 * WS4 — Canonical rule GOVERNS the runtime prompt (SCORING_CANONICAL_RULE_GOVERNS).
 *
 * These tests assert the ACTUAL prompt text emitted by buildV2GuidanceBlock (the
 * pure prompt-assembly function used by every measure of every framework), proving
 * the behavioural change rather than merely attaching a trace:
 *
 *   1. Flag OFF (default)               → live behaviour byte-preserved: the strict
 *                                          "FALLBACK YES CRITERION … ANY numbered
 *                                          condition … triggers Yes" wording is emitted.
 *   2. Flag ON + SUBSTANTIVE canonical  → the strict fallback is DEMOTED to a clearly
 *      bar                                subordinate last-resort tie-breaker that cannot
 *                                          independently trigger a Yes. This removes the
 *                                          contradictory co-equal instruction the reviewer
 *                                          flagged.
 *   3. Flag ON + FALLBACK-DERIVED bar   → behaviour UNCHANGED (strict wording retained),
 *      (no substantive criterion)         because demoting the only available bar would
 *                                          leave the scorer with no Yes criterion.
 *
 * Topic-agnostic: no framework/measure id is referenced. buildV2GuidanceBlock is a
 * pure function (no DB / LLM / network), so this runs offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildV2GuidanceBlock } from "../../analyzer.js";

const FLAG = "SCORING_CANONICAL_RULE_GOVERNS";

/** Run fn with the governance flag forced to a value (restores prior value after). */
function withFlag(value: string | undefined, fn: () => void): void {
  const prior = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prior;
  }
}

// A measure with a genuine SUBSTANTIVE bar + a strict numbered fallback.
const SUBSTANTIVE_MEASURE: any = {
  measureId: "GOV-SUBSTANTIVE",
  substantiveDefinition:
    "The company must publish audited absolute Scope 1+2 emissions for the reporting year.",
  fallbackYesCriterion:
    "1) mentions a net-zero ambition; 2) states a target year",
};

// A measure with ONLY a strict fallback (no substantive/qualifying criterion).
const FALLBACK_ONLY_MEASURE: any = {
  measureId: "GOV-FALLBACK-ONLY",
  fallbackYesCriterion:
    "1) mentions a net-zero ambition; 2) states a target year",
};

const STRICT_MARKER = "FALLBACK YES CRITERION";
const STRICT_TRIGGER = "ANY numbered condition below being satisfied triggers Yes";
const SUBORDINATE_MARKER = "FALLBACK CRITERION (SUBORDINATE";

test("flag OFF: substantive measure keeps the original strict fallback wording (live behaviour preserved)", () => {
  withFlag(undefined, () => {
    const { guidanceBlock } = buildV2GuidanceBlock(SUBSTANTIVE_MEASURE, undefined, "topic");
    assert.ok(guidanceBlock.includes(STRICT_MARKER), "strict FALLBACK YES CRITERION header expected");
    assert.ok(guidanceBlock.includes(STRICT_TRIGGER), "strict 'triggers Yes' wording expected when flag off");
    assert.ok(!guidanceBlock.includes(SUBORDINATE_MARKER), "must NOT demote when flag off");
  });
});

test("flag ON: substantive measure DEMOTES the strict fallback to a subordinate tie-breaker", () => {
  withFlag("1", () => {
    const { guidanceBlock } = buildV2GuidanceBlock(SUBSTANTIVE_MEASURE, undefined, "topic");
    assert.ok(guidanceBlock.includes(SUBORDINATE_MARKER), "subordinate fallback header expected when governed");
    assert.ok(
      !guidanceBlock.includes(STRICT_TRIGGER),
      "the strict co-equal 'triggers Yes' instruction must be gone when governed",
    );
  });
});

test("flag ON accepts 'true' as well as '1'", () => {
  withFlag("true", () => {
    const { guidanceBlock } = buildV2GuidanceBlock(SUBSTANTIVE_MEASURE, undefined, "topic");
    assert.ok(guidanceBlock.includes(SUBORDINATE_MARKER), "'true' should activate governance");
  });
});

test("flag ON: fallback-derived measure (no substantive bar) is left UNCHANGED", () => {
  withFlag("1", () => {
    const { guidanceBlock } = buildV2GuidanceBlock(FALLBACK_ONLY_MEASURE, undefined, "topic");
    assert.ok(guidanceBlock.includes(STRICT_MARKER), "strict header retained when only a fallback exists");
    assert.ok(guidanceBlock.includes(STRICT_TRIGGER), "strict wording retained — demoting the only bar would leave no Yes criterion");
    assert.ok(!guidanceBlock.includes(SUBORDINATE_MARKER), "must not demote a fallback-derived bar");
  });
});
