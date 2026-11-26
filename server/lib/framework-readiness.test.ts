// WS5 — Framework onboarding gate: focused unit tests for the PURE onboarding
// readiness checklist + dry-run probe. This file imports ONLY ./framework-readiness.js
// (which is DB-free) so it loads without a DATABASE_URL.
//
// Run: node --import tsx --test server/lib/framework-readiness.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOnboardingReadiness,
  safeComputeOnboardingReadiness,
  computeReadinessProbe,
  readOnboardingWaivers,
  ONBOARDING_CHECK_KEYS,
} from "./framework-readiness.js";

// ── Checklist: all-missing config → not ready, blockingReasons lists each ──────
test("all-missing config → not ready with a blocking reason per required item", () => {
  const r = computeOnboardingReadiness({});
  assert.equal(r.ready, false);
  assert.equal(r.checks.length, ONBOARDING_CHECK_KEYS.length);
  // Every check is missing (none ok/waived).
  assert.ok(r.checks.every((c) => c.status === "missing"));
  // One blocking reason per missing item.
  assert.equal(r.blockingReasons.length, ONBOARDING_CHECK_KEYS.length);
  // Each check key is represented, in canonical order.
  assert.deepEqual(r.checks.map((c) => c.key), [...ONBOARDING_CHECK_KEYS]);
  // Blocking reasons name the specific config (actionable).
  const joined = r.blockingReasons.join("\n");
  assert.match(joined, /entity/i);
  assert.match(joined, /recencyWindowYears/);
  assert.match(joined, /perCompanyDocCap/);
  assert.match(joined, /requiredForTracks/);
});

test("null / undefined config → not ready, never throws", () => {
  for (const cfg of [null, undefined]) {
    const r = computeOnboardingReadiness(cfg as any);
    assert.equal(r.ready, false);
    assert.equal(r.checks.length, ONBOARDING_CHECK_KEYS.length);
    assert.equal(r.blockingReasons.length, ONBOARDING_CHECK_KEYS.length);
  }
});

// ── Checklist: all-present config → ready ─────────────────────────────────────
test("all-present config (camelCase) → ready with no blocking reasons", () => {
  const r = computeOnboardingReadiness({
    parentEntities: ["Parent Co"],
    subsidiaryEntities: [{ name: "Sub Co", aliases: ["Subsidiary"], domains: ["sub.example"] }],
    relatedListedCompanies: ["Peer Co"],
    recencyWindowYears: 3,
    perCompanyDocCap: 40,
    requiredForTracks: ["physical_climate"],
  });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockingReasons, []);
  assert.ok(r.checks.every((c) => c.status === "ok"));
});

test("all-present config (snake_case) → ready", () => {
  const r = computeOnboardingReadiness({
    parent_entities: ["Parent Co"],
    subsidiary_entities: ["Sub Co"],
    related_listed_companies: ["Peer Co"],
    recency_window_years: 5,
    per_company_doc_cap: 25,
    required_for_tracks: ["operational_resilience", "physical_climate"],
  });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockingReasons, []);
});

test("entity graph present via ONLY one relationship list (per-company map) → entity check ok", () => {
  const r = computeOnboardingReadiness({
    // per-company map form (object, not flat list)
    relatedListedCompanies: { "Acme Corp": ["Peer A", "Peer B"] },
    recencyWindowYears: 3,
    perCompanyDocCap: 40,
    requiredForTracks: ["x"],
  });
  const entity = r.checks.find((c) => c.key === "entityRelationships")!;
  assert.equal(entity.status, "ok");
  assert.equal(r.ready, true);
});

// ── Checklist: waived items → ready ───────────────────────────────────────────
test("missing items waived via onboardingWaivers → ready", () => {
  const r = computeOnboardingReadiness({
    // nothing populated, but all four keys waived
    onboardingWaivers: [...ONBOARDING_CHECK_KEYS],
  });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockingReasons, []);
  assert.ok(r.checks.every((c) => c.status === "waived"));
});

test("partial waiver (snake_case waiver key) → only unwaived missing items block", () => {
  const r = computeOnboardingReadiness({
    recencyWindowYears: 3,
    perCompanyDocCap: 40,
    requiredForTracks: ["x"],
    // entity relationships absent but waived
    onboarding_waivers: ["entityRelationships"],
  });
  assert.equal(r.ready, true);
  const entity = r.checks.find((c) => c.key === "entityRelationships")!;
  assert.equal(entity.status, "waived");
  assert.deepEqual(r.blockingReasons, []);
});

test("waiver for one item but another still missing → not ready", () => {
  const r = computeOnboardingReadiness({
    recencyWindowYears: 3,
    perCompanyDocCap: 40,
    // requiredForTracks missing and NOT waived; entity waived
    onboardingWaivers: ["entityRelationships"],
  });
  assert.equal(r.ready, false);
  assert.equal(r.blockingReasons.length, 1);
  assert.match(r.blockingReasons[0], /requiredForTracks/);
});

// ── Presence edge cases ───────────────────────────────────────────────────────
test("non-positive recency / cap and empty tracks count as missing", () => {
  const r = computeOnboardingReadiness({
    parentEntities: ["P"],
    recencyWindowYears: 0,
    perCompanyDocCap: -5,
    requiredForTracks: ["  ", null],
  });
  assert.equal(r.checks.find((c) => c.key === "recencyWindow")!.status, "missing");
  assert.equal(r.checks.find((c) => c.key === "perCompanyCap")!.status, "missing");
  assert.equal(r.checks.find((c) => c.key === "requiredTracks")!.status, "missing");
  assert.equal(r.checks.find((c) => c.key === "entityRelationships")!.status, "ok");
  assert.equal(r.ready, false);
});

test("readOnboardingWaivers ignores non-string / blank entries and non-array values", () => {
  assert.deepEqual([...readOnboardingWaivers({ onboardingWaivers: ["a", " ", 3, null, "b"] })].sort(), ["a", "b"]);
  assert.deepEqual([...readOnboardingWaivers({ onboardingWaivers: "notarray" })], []);
  assert.deepEqual([...readOnboardingWaivers(null)], []);
});

// ── Fail-open wrapper ─────────────────────────────────────────────────────────
test("safeComputeOnboardingReadiness returns a safe proceed shape on thrown error", () => {
  // Force an error by passing a config whose getter throws when read.
  const booby: any = {};
  Object.defineProperty(booby, "parentEntities", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  let captured: unknown = null;
  const r = safeComputeOnboardingReadiness(booby, (e) => (captured = e));
  assert.equal(r.ready, true);
  assert.equal(r.failOpen, true);
  assert.deepEqual(r.blockingReasons, []);
  assert.deepEqual(r.checks, []);
  assert.ok(captured instanceof Error);
});

test("safeComputeOnboardingReadiness on normal config matches computeOnboardingReadiness", () => {
  const cfg = { parentEntities: ["P"], recencyWindowYears: 3, perCompanyDocCap: 40, requiredForTracks: ["x"] };
  assert.deepEqual(safeComputeOnboardingReadiness(cfg), computeOnboardingReadiness(cfg));
});

test("checklist itself never throws on malformed/garbage input", () => {
  for (const cfg of [0, "x", true, [], NaN, { parentEntities: 123, requiredForTracks: "no" }, Symbol("s") as any]) {
    assert.doesNotThrow(() => computeOnboardingReadiness(cfg as any));
  }
});

// ── Dry-run probe correctness ─────────────────────────────────────────────────
test("probe computes deterministic fields from well-formed stats", () => {
  const p = computeReadinessProbe({
    entityAttributionCoverage: 0.9,
    duplicateRate: 0.1,
    corpusDepth: 30,
    perCompanyCap: 40,
    nearBoundaryCount: 3,
  });
  assert.equal(p.coverage, 0.9);
  assert.equal(p.duplicateRate, 0.1);
  assert.equal(p.corpusDepthVsCap, 0.75); // 30/40
  assert.equal(p.nearBoundaryCount, 3);
  // 0.4*0.9 + 0.3*0.9 + 0.2*min(1,0.75) + 0.1*(1/4) = 0.36+0.27+0.15+0.025 = 0.805
  assert.ok(Math.abs(p.preflightScore - 0.805) < 1e-9);
});

test("probe caps depth health at 1 when depth exceeds cap", () => {
  const p = computeReadinessProbe({
    entityAttributionCoverage: 1,
    duplicateRate: 0,
    corpusDepth: 100,
    perCompanyCap: 40,
    nearBoundaryCount: 0,
  });
  assert.equal(p.corpusDepthVsCap, 2.5); // raw ratio preserved
  // depthHealth capped at 1: 0.4 + 0.3 + 0.2*1 + 0.1*1 = 1.0 (modulo fp rounding)
  assert.ok(Math.abs(p.preflightScore - 1) < 1e-9);
});

test("probe guards division-by-zero and out-of-range / NaN inputs", () => {
  const p = computeReadinessProbe({
    entityAttributionCoverage: 5, // >1 → clamp to 1
    duplicateRate: -2, // <0 → clamp to 0
    corpusDepth: 10,
    perCompanyCap: 0, // div-by-zero guard → 0
    nearBoundaryCount: -4, // <0 → 0
  });
  assert.equal(p.coverage, 1);
  assert.equal(p.duplicateRate, 0);
  assert.equal(p.corpusDepthVsCap, 0);
  assert.equal(p.nearBoundaryCount, 0);
  // 0.4*1 + 0.3*1 + 0.2*0 + 0.1*1 = 0.8
  assert.ok(Math.abs(p.preflightScore - 0.8) < 1e-9);
});

test("probe never throws on null / undefined / malformed stats", () => {
  for (const s of [null, undefined, {}, 42, "x", [], { entityAttributionCoverage: "bad", corpusDepth: NaN }]) {
    assert.doesNotThrow(() => computeReadinessProbe(s as any));
    const p = computeReadinessProbe(s as any);
    assert.ok(p.preflightScore >= 0 && p.preflightScore <= 1);
    assert.ok(p.coverage >= 0 && p.coverage <= 1);
    assert.ok(p.duplicateRate >= 0 && p.duplicateRate <= 1);
    assert.ok(p.corpusDepthVsCap >= 0);
    assert.ok(Number.isInteger(p.nearBoundaryCount) && p.nearBoundaryCount >= 0);
  }
});

test("probe near-boundary count is floored", () => {
  const p = computeReadinessProbe({ nearBoundaryCount: 7.9 });
  assert.equal(p.nearBoundaryCount, 7);
});
