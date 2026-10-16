/**
 * eligibility-decision-a3.test.ts — A3 / WP04 committed test suite.
 *
 * Proves the four composition invariants that A3 adds on top of the existing,
 * already-working single-path controls (classifyProvenance, applyProvenanceGate,
 * the chunk-sanity entity/vintage gate, the advisory eligibility flags). The
 * concern A3 closes is COMPOSITION across stages, not any single control, so
 * these tests exercise the guardrail directly and deterministically (no DB, no
 * network, no LLM).
 *
 * Mirrors the A2 suite style: plain tsx script, node:assert/strict, a local
 * test() harness with pass/fail counters.
 *
 * EP01 — a rejected third-party source stays rejected through every path
 *        (compose → excluded, and a later repair can NEVER resurrect it).
 * EP02 — a subsidiary passage cannot support a parent/group-wide claim unless
 *        the framework scope is group_consolidated.
 * EP03 — a current-state question cannot inherit a superseded / out-of-window
 *        report.
 * EP04 — issuer-filed vs analyst-commentary are distinguished, and an
 *        issuer-source requirement rejects analyst commentary.
 * EP05 — cache / byte reuse across targets cannot carry a stale eligibility
 *        decision computed for a different target (per-target recompute).
 * EP06 — incomplete provenance yields `review`, never a silent assumption of
 *        authority; a repair can fill it in but still cannot override exclusion.
 *
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *        npx tsx server/lib/eligibility-decision-a3.test.ts
 */

import assert from "node:assert/strict";
import {
  composeEligibilityDecision,
  composeCellEligibility,
  recomputeForTarget,
  mergeEligibilityRepair,
  isEligible,
  targetKeyOf,
  resolveEligibilityPolicy,
  serializeEligibilityDecision,
  type EligibilityDecisionInput,
  type EligibilityTarget,
} from "./eligibility-decision.js";

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

// Shared assessed target (Aflac, from the frozen roster). domain drives the
// provenance classifier's issuer-vs-third-party decision.
const AFLAC: EligibilityTarget = {
  id: 18,
  name: "Aflac Incorporated",
  ticker: "AFL",
  domain: "aflac.com",
};

const ISSUER_SELF_URL = "https://aflac.com/sustainability-report-2025";
const ISSUER_FILED_URL = "https://www.sec.gov/edgar/aflac-10k-2025";
const ANALYST_URL = "https://www.reuters.com/business/aflac-esg-coverage";

// ─── EP01 ──────────────────────────────────────────────────────────────────
// A rejected third-party source stays rejected through every path. We build a
// hard exclusion (issuer-source required, but the evidence is analyst
// commentary) and then try to "repair" it with a perfectly good issuer source.
// The exclusion must be monotonic — the repair cannot flip it to eligible.

test("EP01: third-party exclusion is monotonic — a later repair cannot resurrect it", () => {
  const excluded = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ANALYST_URL, title: "Reuters coverage of Aflac", content: "Aflac reportedly ..." },
    framework: { requiresIssuerSource: true },
  });
  assert.equal(excluded.status, "excluded", "analyst commentary must be excluded for an issuer-source measure");
  assert.equal(excluded.sourceClass, "analyst_commentary");
  assert.equal(isEligible(excluded), false);

  // Attempt to repair with a genuine issuer source for the SAME target.
  const afterRepair = mergeEligibilityRepair(excluded, {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac Sustainability Report" },
    framework: { requiresIssuerSource: true },
  });
  assert.equal(afterRepair.status, "excluded", "exclusion must survive a repair (I2 monotonicity)");
  assert.ok(
    afterRepair.reasons.some((r) => r.includes("monotonic")),
    "audit trail must record that the repair was ignored as monotonic",
  );
});

test("EP01b: a wrong-entity (unrelated) third-party source is excluded and stays excluded", () => {
  // Third-party URL whose title/content never mention the target → inferred
  // relation 'unrelated' → hard exclusion regardless of issuer requirement.
  const excluded = composeEligibilityDecision({
    target: AFLAC,
    source: {
      url: "https://investor.unrelatedcorp.com/press",
      title: "UnrelatedCorp quarterly update",
      content: "UnrelatedCorp announced a new buyback.",
    },
  });
  assert.equal(excluded.entityRelation, "unrelated");
  assert.equal(excluded.status, "excluded");
  const afterRepair = mergeEligibilityRepair(excluded, {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac Sustainability Report" },
  });
  assert.equal(afterRepair.status, "excluded", "wrong-entity exclusion is final");
});

// ─── EP02 ──────────────────────────────────────────────────────────────────
// A subsidiary passage supports a parent/group-wide claim ONLY under
// group_consolidated scope. entity_only → excluded; group_consolidated →
// eligible.

test("EP02: subsidiary cannot support an entity_only claim but can under group_consolidated", () => {
  const base: EligibilityDecisionInput = {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac subsidiary disclosure", entityRelation: "subsidiary" },
  };

  const entityOnly = composeEligibilityDecision({
    ...base,
    framework: { scopePolicy: "entity_only" },
  });
  assert.equal(entityOnly.status, "excluded", "subsidiary must be excluded under entity_only scope");
  assert.ok(entityOnly.reasons.some((r) => r.includes("entity_only")));

  const consolidated = composeEligibilityDecision({
    ...base,
    framework: { scopePolicy: "group_consolidated" },
  });
  assert.equal(consolidated.status, "eligible", "subsidiary admitted under group_consolidated scope");
  assert.equal(consolidated.scopePolicy, "group_consolidated");
});

test("EP02b: a parent-wide claim never counts as the assessed subsidiary's own practice", () => {
  const parentClaim = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Parent group policy", entityRelation: "parent" },
    framework: { scopePolicy: "group_consolidated" },
  });
  // Even under group_consolidated, a 'parent' relation is a hard wrong-entity
  // exclusion (a parent-wide claim is not the assessed entity's disclosure).
  assert.equal(parentClaim.status, "excluded");
});

// ─── EP03 ──────────────────────────────────────────────────────────────────
// A current-state question cannot inherit a superseded or out-of-window report.

test("EP03: current-state question rejects a superseded source", () => {
  const superseded = composeEligibilityDecision({
    target: AFLAC,
    source: {
      url: ISSUER_SELF_URL,
      title: "Aflac 2021 report",
      supersededBy: "https://aflac.com/sustainability-report-2025",
    },
    framework: { currentStateRequired: true, currentYear: 2026 },
  });
  assert.equal(superseded.status, "excluded", "a superseded source cannot satisfy a current-state question");
  assert.ok(superseded.reasons.some((r) => r.toLowerCase().includes("superseded")));
});

test("EP03b: current-state question rejects an out-of-window (stale) source", () => {
  const stale = composeEligibilityDecision({
    target: AFLAC,
    source: { url: "https://aflac.com/report", title: "Aflac report", asOfYear: 2018 },
    framework: { currentStateRequired: true, currentYear: 2026, yearsBack: 3 },
  });
  assert.equal(stale.status, "excluded", "2018 is outside the 2023-2026 window for a current-state question");
});

test("EP03c: a historical (non-current-state) question tolerates an older issuer source", () => {
  const historical = composeEligibilityDecision({
    target: AFLAC,
    source: { url: "https://aflac.com/report", title: "Aflac report", asOfYear: 2018 },
    framework: { currentStateRequired: false, currentYear: 2026, yearsBack: 3 },
  });
  assert.equal(historical.status, "eligible", "the guardrail must not over-fire on undated/older evidence by default");
});

// ─── EP04 ──────────────────────────────────────────────────────────────────
// Issuer-filed vs analyst-commentary are distinguished; an issuer-source
// requirement rejects analyst commentary but admits issuer-filed evidence.

test("EP04: issuer-filed vs analyst-commentary are distinguished", () => {
  const filed = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ISSUER_FILED_URL, title: "Aflac 10-K" },
  });
  assert.equal(filed.sourceClass, "issuer_filed", "a regulator-hosted issuer filing is issuer_filed");

  const self = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac report" },
  });
  assert.equal(self.sourceClass, "issuer_self", "an on-domain issuer page is issuer_self");

  const analyst = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ANALYST_URL, title: "Reuters on Aflac", content: "Aflac said ..." },
  });
  assert.equal(analyst.sourceClass, "analyst_commentary", "third-party coverage of the target is analyst_commentary");
});

test("EP04b: an issuer-source requirement admits issuer-filed but rejects analyst commentary", () => {
  const filed = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ISSUER_FILED_URL, title: "Aflac 10-K" },
    framework: { requiresIssuerSource: true },
  });
  assert.equal(filed.status, "eligible", "issuer-filed evidence satisfies an issuer-source requirement");

  const analyst = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ANALYST_URL, title: "Reuters on Aflac", content: "Aflac said ..." },
    framework: { requiresIssuerSource: true },
  });
  assert.equal(analyst.status, "excluded", "analyst commentary cannot satisfy an issuer-source requirement");
});

// ─── EP05 ──────────────────────────────────────────────────────────────────
// Cache / byte reuse across targets cannot carry a stale eligibility decision.
// A decision is bound to the target key it was computed for (I1).

test("EP05: a decision computed for another target is never inherited on byte reuse", () => {
  const OTHER: EligibilityTarget = { id: 9, name: "CSX Corporation", ticker: "CSX", domain: "csx.com" };

  // Decision computed for CSX over a CSX-issuer source.
  const csxDecision = composeEligibilityDecision({
    target: OTHER,
    source: { url: "https://csx.com/sustainability", title: "CSX report" },
  });
  assert.equal(csxDecision.targetKey, targetKeyOf(OTHER));
  assert.equal(csxDecision.status, "eligible");

  // The SAME source bytes are now reused for Aflac. For Aflac, csx.com is a
  // third-party domain that does not mention Aflac → unrelated → excluded.
  // recomputeForTarget must IGNORE the CSX decision and recompute for Aflac.
  const forAflac = recomputeForTarget(
    { target: AFLAC, source: { url: "https://csx.com/sustainability", title: "CSX report", content: "CSX operations ..." } },
    csxDecision, // stale prior decision from a different target
  );
  assert.equal(forAflac.targetKey, targetKeyOf(AFLAC), "recomputed decision must be bound to the NEW target");
  assert.notEqual(forAflac.targetKey, csxDecision.targetKey);
  assert.equal(forAflac.status, "excluded", "CSX's eligible decision must not leak onto Aflac");
});

test("EP05b: same-target reuse returns a freshly composed (identical) decision, never the cached object", () => {
  const input: EligibilityDecisionInput = {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac report" },
  };
  const first = composeEligibilityDecision(input);
  const reused = recomputeForTarget(input, first);
  assert.equal(reused.targetKey, first.targetKey);
  assert.equal(reused.status, first.status);
  assert.notEqual(reused, first, "a fresh object is returned so a stale cached reference can never leak");
});

// ─── EP06 ──────────────────────────────────────────────────────────────────
// Incomplete provenance → review, never a silent assumption of authority; a
// repair can fill it in (review → eligible) but still cannot override exclusion.

test("EP06: missing provenance yields review, not authority", () => {
  const noUrl = composeEligibilityDecision({
    target: AFLAC,
    source: { url: null, title: "untitled snippet", content: "some text" },
  });
  assert.equal(noUrl.sourceClass, "unknown");
  assert.equal(noUrl.status, "review", "incomplete provenance must route to review, never eligible");
  assert.equal(isEligible(noUrl), false);
});

test("EP06b: a repair fills missing provenance (review → eligible) for the same target", () => {
  const review = composeEligibilityDecision({
    target: AFLAC,
    source: { url: null, title: "untitled snippet" },
  });
  assert.equal(review.status, "review");

  const repaired = mergeEligibilityRepair(review, {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac report" },
  });
  assert.equal(repaired.status, "eligible", "a repair that supplies issuer provenance upgrades review → eligible");
  assert.equal(repaired.repaired, true, "the repaired flag must be set");
});

test("EP06c: a repair for a DIFFERENT target is ignored (I1 within repair)", () => {
  const review = composeEligibilityDecision({
    target: AFLAC,
    source: { url: null, title: "untitled snippet" },
  });
  const repaired = mergeEligibilityRepair(review, {
    target: { id: 9, name: "CSX Corporation", ticker: "CSX", domain: "csx.com" },
    source: { url: "https://csx.com/report", title: "CSX report" },
  });
  assert.equal(repaired.status, "review", "a cross-target repair must not resolve the decision");
  assert.ok(repaired.reasons.some((r) => r.includes("target mismatch")));
});

test("EP06d: a repair cannot upgrade an exclusion even if the repair source is eligible", () => {
  const excluded = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ANALYST_URL, title: "Reuters on Aflac", content: "Aflac said ..." },
    framework: { requiresIssuerSource: true },
  });
  assert.equal(excluded.status, "excluded");
  const repaired = mergeEligibilityRepair(excluded, {
    target: AFLAC,
    source: { url: ISSUER_SELF_URL, title: "Aflac report" },
  });
  assert.equal(repaired.status, "excluded", "I2: exclusion is final regardless of a good repair source");
});

// ─── Infrastructure: kill-switch, immutability, serialization ────────────────

test("policy kill switch: ELIGIBILITY_POLICY=v1 is a legacy advisory passthrough", () => {
  const prev = process.env.ELIGIBILITY_POLICY;
  process.env.ELIGIBILITY_POLICY = "v1";
  try {
    assert.equal(resolveEligibilityPolicy(), "v1");
    const d = composeEligibilityDecision({
      target: AFLAC,
      source: { url: ANALYST_URL, title: "Reuters on Aflac" },
      framework: { requiresIssuerSource: true },
    });
    // Under v1, even an analyst source on an issuer-required measure is eligible
    // (advisory) — reproducing pre-A3 behaviour with no composition enforced.
    assert.equal(d.policyVersion, "v1");
    assert.equal(d.status, "eligible");
  } finally {
    if (prev === undefined) delete process.env.ELIGIBILITY_POLICY;
    else process.env.ELIGIBILITY_POLICY = prev;
  }
});

test("policy resolution fail-safes to v2 for unknown values", () => {
  const prev = process.env.ELIGIBILITY_POLICY;
  process.env.ELIGIBILITY_POLICY = "banana";
  try {
    assert.equal(resolveEligibilityPolicy(), "v2");
  } finally {
    if (prev === undefined) delete process.env.ELIGIBILITY_POLICY;
    else process.env.ELIGIBILITY_POLICY = prev;
  }
});

test("decisions are deeply frozen (immutable carry-through)", () => {
  const d = composeEligibilityDecision({ target: AFLAC, source: { url: ISSUER_SELF_URL } });
  assert.throws(() => {
    (d as unknown as { status: string }).status = "excluded";
  }, "the decision object must be frozen");
  assert.throws(() => {
    (d.reasons as unknown as string[]).push("tamper");
  }, "the reasons array must be frozen");
});

test("composition is total: never throws on degenerate input", () => {
  assert.doesNotThrow(() => composeEligibilityDecision({ target: { name: "" }, source: {} }));
  assert.doesNotThrow(() => composeEligibilityDecision({} as EligibilityDecisionInput));
});

test("serialization round-trips the load-bearing fields", () => {
  const d = composeEligibilityDecision({
    target: AFLAC,
    source: { url: ISSUER_FILED_URL, title: "Aflac 10-K" },
  });
  const s = serializeEligibilityDecision(d);
  assert.equal(s.targetKey, d.targetKey);
  assert.equal(s.sourceClass, d.sourceClass);
  assert.equal(s.status, d.status);
  assert.equal(s.policyVersion, d.policyVersion);
  assert.ok(Array.isArray(s.reasons));
});

// ─── CELL-LEVEL composition (A3 full-quote-set redesign) ─────────────────────
// composeCellEligibility makes A3's basis EQUAL the verdict's basis: it composes
// one decision per supporting quote and derives a single cell status +
// representative. These prove the four buckets that drive enforcement
// (STAY / QUOTE_CORRECT / VERDICT_CHANGE / REVIEW).

const UNRELATED_SRC = {
  url: "https://investor.unrelatedcorp.com/press",
  title: "UnrelatedCorp quarterly update",
  content: "UnrelatedCorp announced a new buyback.",
};

test("CELL01: one eligible quote among excluded/unknown → status eligible, rep points at the eligible one", () => {
  const cell = composeCellEligibility({
    target: AFLAC,
    sources: [
      UNRELATED_SRC, // excluded (unrelated third party)
      { url: ISSUER_SELF_URL, title: "Aflac Sustainability Report" }, // eligible (issuer self)
      { url: null, title: "untitled snippet", content: "some text" }, // review (unknown provenance)
    ],
  });
  assert.equal(cell.sourceCount, 3);
  assert.equal(cell.status, "eligible");
  assert.equal(cell.anyEligible, true);
  assert.equal(cell.allExcluded, false);
  assert.equal(cell.representativeIndex, 1, "representative must be the eligible quote at index 1");
  assert.equal(cell.representative?.status, "eligible");
  assert.equal(cell.decisions.length, 3);
});

test("CELL02: all quotes hard-excluded → allExcluded, status excluded, representative excluded", () => {
  const cell = composeCellEligibility({
    target: AFLAC,
    sources: [
      UNRELATED_SRC,
      {
        url: "https://news.othercorp.com/story",
        title: "OtherCorp in the news",
        content: "OtherCorp reported earnings.",
      },
    ],
  });
  assert.equal(cell.allExcluded, true);
  assert.equal(cell.status, "excluded");
  assert.equal(cell.anyEligible, false);
  assert.equal(cell.representative?.status, "excluded");
  assert.equal(cell.representativeIndex, 0, "first excluded is the representative when none eligible/review");
});

test("CELL03: no eligible but ≥1 review (unknown) + rest excluded → status review", () => {
  const cell = composeCellEligibility({
    target: AFLAC,
    sources: [
      UNRELATED_SRC, // excluded
      { url: null, title: "untitled snippet" }, // review (no url)
    ],
  });
  assert.equal(cell.anyEligible, false);
  assert.equal(cell.anyReview, true);
  assert.equal(cell.allExcluded, false, "a review present means not every quote is excluded");
  assert.equal(cell.status, "review");
  assert.equal(cell.representativeIndex, 1, "first review is the representative when none eligible");
});

test("CELL04: empty sources → status review, representativeIndex -1, sourceCount 0", () => {
  const cell = composeCellEligibility({ target: AFLAC, sources: [] });
  assert.equal(cell.sourceCount, 0);
  assert.equal(cell.status, "review", "no evidence must never silently assert authority (I4)");
  assert.equal(cell.representativeIndex, -1);
  assert.equal(cell.representative, null);
  assert.equal(cell.anyEligible, false);
  assert.equal(cell.allExcluded, false);
});

test("CELL05: per-target recompute (I1) — same source bytes never inherit a decision across targets", () => {
  const CSX: EligibilityTarget = { id: 9, name: "CSX Corporation", ticker: "CSX", domain: "csx.com" };
  const sharedBytes = { url: "https://csx.com/sustainability", title: "CSX report", content: "CSX operations ..." };

  const forCsx = composeCellEligibility({ target: CSX, sources: [sharedBytes] });
  const forAflac = composeCellEligibility({ target: AFLAC, sources: [sharedBytes] });

  // Decisions are bound to their respective targets…
  assert.equal(forCsx.decisions[0].targetKey, targetKeyOf(CSX));
  assert.equal(forAflac.decisions[0].targetKey, targetKeyOf(AFLAC));
  assert.notEqual(forCsx.decisions[0].targetKey, forAflac.decisions[0].targetKey);
  // …and resolve differently: issuer-self for CSX, unrelated/excluded for Aflac.
  assert.equal(forCsx.status, "eligible", "csx.com is issuer-self for CSX");
  assert.equal(forAflac.status, "excluded", "csx.com must not leak an eligible decision onto Aflac");
});

test("CELL06: representative-first stability — [excluded, eligibleA, eligibleB] → index 1, not 2", () => {
  const cell = composeCellEligibility({
    target: AFLAC,
    sources: [
      UNRELATED_SRC, // excluded
      { url: ISSUER_SELF_URL, title: "Aflac report" }, // eligibleA (issuer_self)
      { url: ISSUER_FILED_URL, title: "Aflac 10-K" }, // eligibleB (issuer_filed)
    ],
  });
  assert.equal(cell.status, "eligible");
  assert.equal(cell.representativeIndex, 1, "the FIRST eligible quote wins, not a later one");
  assert.equal(cell.representative?.sourceClass, "issuer_self");
});

test("CELL07: cell composition is total — never throws on degenerate input", () => {
  assert.doesNotThrow(() => composeCellEligibility({ target: { name: "" }, sources: [] }));
  assert.doesNotThrow(() =>
    composeCellEligibility({ target: AFLAC, sources: [{}, { url: null }] as any }),
  );
  const cell = composeCellEligibility({ target: AFLAC, sources: [{}] as any });
  assert.equal(cell.status, "review", "a contentless source must route to review, not authority");
});

test("CELL08: result and decisions array are frozen (immutable carry-through)", () => {
  const cell = composeCellEligibility({ target: AFLAC, sources: [{ url: ISSUER_SELF_URL }] });
  assert.throws(() => {
    (cell as unknown as { status: string }).status = "excluded";
  }, "the cell result must be frozen");
  assert.throws(() => {
    (cell.decisions as unknown as EligibilityDecisionInput[]).push({} as EligibilityDecisionInput);
  }, "the decisions array must be frozen");
});

// ─── R5c / full-name phrase identity + tenant propagation ────────────────────
// Framework-level closure of the IR-platform recall gap for issuers whose
// corporate name yields NO distinctive identity tokens (e.g. "S&P Global Inc."
// → tokens all generic/short, ticker absent from the URL). The fix is purely
// code + name-derived: a full-name PHRASE match self-confirms the issuer's own
// IR-platform document, which then seeds a shared tenant cache so sibling URLs
// on the SAME tenant are accepted without re-establishing identity. NO
// per-company data (no related_domains seed) is used anywhere in these tests.

// A generic-name issuer with no usable distinctive tokens. Deliberately NO
// domain and NO relatedDomains — the ONLY signals available are the name itself
// and the Q4 tenant in the URL path.
const SPG: EligibilityTarget = { id: 12, name: "S&P Global Inc.", ticker: "SPGI" };
// Q4 CDN URL whose filename carries the full issuer name as a phrase.
const SPG_CONFIRM_URL =
  "https://s29.q4cdn.com/690959130/files/doc_financials/2026/sr/S-P-Global-Inc-2026-Proxy-Statement.pdf";
// Sibling on the SAME Q4 tenant whose path carries NO identity (weak signal).
const SPG_SIBLING_URL =
  "https://s29.q4cdn.com/690959130/files/doc_financials/2026/q1/financial-supplement.pdf";

test("R5c-1: generic-name issuer self-confirms its own IR doc via full-name phrase match", () => {
  // No domain, no related_domains, ticker absent from the path — the ONLY way
  // this can be issuer_self is the general full-name phrase signal.
  const d = composeEligibilityDecision({
    target: SPG,
    source: { url: SPG_CONFIRM_URL, title: "2026 Proxy Statement" },
  });
  assert.equal(d.sourceClass, "issuer_self", "full-name phrase must confirm the issuer's own Q4 doc");
  assert.equal(d.entityRelation, "self");
  assert.equal(isEligible(d), true);
  assert.ok(
    d.reasons.some((r) => r.includes("full-name")),
    "audit trail must record the full-name phrase signal",
  );
});

test("R5c-2: a bare sibling on the same tenant is NOT issuer on its own (no cache)", () => {
  const d = composeEligibilityDecision({
    target: SPG,
    source: { url: SPG_SIBLING_URL, title: "Financial Supplement" },
  });
  // Without a warm tenant cache the weak sibling cannot self-confirm.
  assert.notEqual(d.sourceClass, "issuer_self", "a nameless sibling must not self-confirm without the cache");
});

test("R5c-3: tenant propagation covers a weak sibling — order [confirm, sibling]", () => {
  const cell = composeCellEligibility({
    target: SPG,
    sources: [
      { url: SPG_CONFIRM_URL, title: "2026 Proxy Statement" },
      { url: SPG_SIBLING_URL, title: "Financial Supplement" },
    ],
  });
  assert.equal(cell.decisions[0].sourceClass, "issuer_self");
  assert.equal(cell.decisions[1].sourceClass, "issuer_self", "the sibling inherits issuer_self via the tenant cache");
  assert.equal(cell.status, "eligible");
});

test("R5c-4: tenant propagation is ORDER-INDEPENDENT — order [sibling, confirm]", () => {
  // The confirming source comes SECOND. Pass 2 must retro-cover the earlier
  // sibling once the cache is warm.
  const cell = composeCellEligibility({
    target: SPG,
    sources: [
      { url: SPG_SIBLING_URL, title: "Financial Supplement" },
      { url: SPG_CONFIRM_URL, title: "2026 Proxy Statement" },
    ],
  });
  assert.equal(cell.decisions[1].sourceClass, "issuer_self");
  assert.equal(
    cell.decisions[0].sourceClass,
    "issuer_self",
    "the earlier sibling must be retro-covered regardless of order",
  );
  assert.equal(cell.status, "eligible");
  // Original source indices preserved (sibling stayed at index 0).
  assert.ok(cell.decisions[0].reasons.some((r) => r.includes("tenant-cache") || r.includes("tenant")),
    "the retro-covered sibling must cite a tenant-cache hit");
});

test("R5c-5: negative guard — a DIFFERENT issuer cannot borrow another issuer's bound tenant", () => {
  // Shared cache across two companies. S&P confirms its tenant first; a
  // DIFFERENT issuer (Newmont) with a URL on S&P's tenant must NOT be accepted
  // (companyMatchesBinding rejects the cross-company reuse).
  const shared = new Map();
  composeCellEligibility({
    target: SPG,
    sources: [{ url: SPG_CONFIRM_URL, title: "2026 Proxy Statement" }],
    knownIrTenants: shared as any,
  });
  const other: EligibilityTarget = { id: 99, name: "Newmont Corporation", ticker: "NEM" };
  const cell = composeCellEligibility({
    target: other,
    sources: [{ url: SPG_SIBLING_URL, title: "Financial Supplement" }],
    knownIrTenants: shared as any,
  });
  assert.notEqual(
    cell.decisions[0].sourceClass,
    "issuer_self",
    "a different issuer must not inherit S&P's tenant binding",
  );
});

test("R5c-6: over-fire guard — a too-short two-token name does NOT phrase-match", () => {
  // "AT&T Inc" → ["at","t"] → joined "att" (<6 chars) → phrase match suppressed.
  // With no domain and no distinctive/ticker signal in the path, it must NOT
  // self-confirm (prevents generic phrase over-fire on short initialisms).
  const att: EligibilityTarget = { id: 77, name: "AT&T Inc.", ticker: "T" };
  const d = composeEligibilityDecision({
    target: att,
    source: { url: "https://s1.q4cdn.com/222/files/at-t-overview.pdf", title: "Overview" },
  });
  assert.notEqual(d.sourceClass, "issuer_self", "short two-token name must not phrase-match");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
