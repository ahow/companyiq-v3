import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveryCap } from "./discovery.js";
import {
  rc6CorpusReadinessRetryBudget,
  rc6CorpusReadinessRetryConcurrency,
  eDeepSecondPassEnabled,
  eDeepSecondPassConcurrency,
  gMandatoryCompletenessResearchEnabled,
  gMandatoryCompletenessResearchConcurrency,
  fAdmissionGatePrototypeEnabled,
} from "./scoring-fix-flags.js";

// Helper: run fn with specific env values set, always restoring afterwards.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ─── C — site-walk caps (discoveryCap floors at default, reads env) ────────────
// The three C knobs (DISCOVERY_SITEWALK_LANDING_MAX_HITS / _LINKFARM_MAX /
// _SITEMAP_SUBS_MAX) are all built from discoveryCap(name, default); testing the
// shared helper proves the floor-at-default + env-read contract for each knob.

test("C: discoveryCap returns the default when env is unset (default-preserving)", () => {
  withEnv({ CAP_TEST_C: undefined }, () => {
    assert.equal(discoveryCap("CAP_TEST_C", 5), 5);
    assert.equal(discoveryCap("CAP_TEST_C", 60), 60);
  });
});

test("C: discoveryCap reads a larger env value (widens coverage)", () => {
  withEnv({ CAP_TEST_C: "25" }, () => {
    assert.equal(discoveryCap("CAP_TEST_C", 5), 25);
  });
});

test("C: discoveryCap FLOORS at the default — a smaller env value cannot narrow coverage", () => {
  withEnv({ CAP_TEST_C: "2" }, () => {
    assert.equal(discoveryCap("CAP_TEST_C", 5), 5);
  });
});

test("C: discoveryCap ignores non-numeric env and falls back to the default", () => {
  withEnv({ CAP_TEST_C: "garbage" }, () => {
    assert.equal(discoveryCap("CAP_TEST_C", 5), 5);
  });
});

// ─── D — RC6 readiness retry: budget tunable + concurrency default serial ──────

test("D: retry budget defaults to 6 and is env-tunable", () => {
  withEnv({ CORPUS_READINESS_RETRY_BUDGET: undefined }, () => {
    assert.equal(rc6CorpusReadinessRetryBudget(), 6);
  });
  withEnv({ CORPUS_READINESS_RETRY_BUDGET: "12" }, () => {
    assert.equal(rc6CorpusReadinessRetryBudget(), 12);
  });
});

test("D: retry concurrency defaults to 1 (strictly serial — byte-for-byte as before)", () => {
  withEnv({ CORPUS_READINESS_RETRY_CONCURRENCY: undefined }, () => {
    assert.equal(rc6CorpusReadinessRetryConcurrency(), 1);
  });
});

test("D: retry concurrency reads env and is floored at 1 (never unbounded/zero)", () => {
  withEnv({ CORPUS_READINESS_RETRY_CONCURRENCY: "4" }, () => {
    assert.equal(rc6CorpusReadinessRetryConcurrency(), 4);
  });
  withEnv({ CORPUS_READINESS_RETRY_CONCURRENCY: "0" }, () => {
    assert.equal(rc6CorpusReadinessRetryConcurrency(), 1);
  });
  withEnv({ CORPUS_READINESS_RETRY_CONCURRENCY: "-3" }, () => {
    assert.equal(rc6CorpusReadinessRetryConcurrency(), 1);
  });
});

// ─── E — deep second pass: default OFF, concurrency capped ─────────────────────

test("E: deep second pass is OFF by default and only ON for truthy env values", () => {
  withEnv({ DISCOVERY_DEEP_SECOND_PASS: undefined }, () => {
    assert.equal(eDeepSecondPassEnabled(), false);
  });
  for (const v of ["1", "true", "on", "yes", "TRUE"]) {
    withEnv({ DISCOVERY_DEEP_SECOND_PASS: v }, () => {
      assert.equal(eDeepSecondPassEnabled(), true, `"${v}" should enable E`);
    });
  }
  withEnv({ DISCOVERY_DEEP_SECOND_PASS: "false" }, () => {
    assert.equal(eDeepSecondPassEnabled(), false);
  });
});

test("E: concurrency defaults to 2 and is floored at 1 (bounded, never unbounded)", () => {
  withEnv({ DISCOVERY_DEEP_SECOND_PASS_CONCURRENCY: undefined }, () => {
    assert.equal(eDeepSecondPassConcurrency(), 2);
  });
  withEnv({ DISCOVERY_DEEP_SECOND_PASS_CONCURRENCY: "6" }, () => {
    assert.equal(eDeepSecondPassConcurrency(), 6);
  });
  withEnv({ DISCOVERY_DEEP_SECOND_PASS_CONCURRENCY: "0" }, () => {
    assert.equal(eDeepSecondPassConcurrency(), 1);
  });
});

// ─── G — mandatory completeness re-search: default OFF, concurrency capped ──────

test("G: mandatory re-search is OFF by default and ON for truthy env values", () => {
  withEnv({ COMPLETENESS_MANDATORY_RESEARCH: undefined }, () => {
    assert.equal(gMandatoryCompletenessResearchEnabled(), false);
  });
  withEnv({ COMPLETENESS_MANDATORY_RESEARCH: "yes" }, () => {
    assert.equal(gMandatoryCompletenessResearchEnabled(), true);
  });
});

test("G: concurrency defaults to 2 and is floored at 1", () => {
  withEnv({ COMPLETENESS_MANDATORY_RESEARCH_CONCURRENCY: undefined }, () => {
    assert.equal(gMandatoryCompletenessResearchConcurrency(), 2);
  });
  withEnv({ COMPLETENESS_MANDATORY_RESEARCH_CONCURRENCY: "-1" }, () => {
    assert.equal(gMandatoryCompletenessResearchConcurrency(), 1);
  });
});

// ─── F — admission-gate prototype flag: default OFF ────────────────────────────

test("F: admission-gate prototype is OFF by default and ON only for truthy env", () => {
  withEnv({ ADMISSION_GATE_PROTOTYPE: undefined }, () => {
    assert.equal(fAdmissionGatePrototypeEnabled(), false);
  });
  withEnv({ ADMISSION_GATE_PROTOTYPE: "true" }, () => {
    assert.equal(fAdmissionGatePrototypeEnabled(), true);
  });
  withEnv({ ADMISSION_GATE_PROTOTYPE: "false" }, () => {
    assert.equal(fAdmissionGatePrototypeEnabled(), false);
  });
});
