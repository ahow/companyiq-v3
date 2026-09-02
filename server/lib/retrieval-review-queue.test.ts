// Standalone test runner for retrieval-review-queue.ts (PR 1 · Change 4).
// No Vitest/Jest dep. Run with:
//   DATABASE_URL="postgresql://placeholder@localhost/placeholder" \
//     npx tsx server/lib/retrieval-review-queue.test.ts
//
// Exits non-zero if any assertion fails. Covers:
//   - Queue idempotence: hasFired false → markFired → hasFired true
//   - Queue keys are (companyId, measureId) — different measures on the
//     same company are tracked independently
//   - Query composition: substantiveDefinition > definition > title precedence
//   - Query composition: sentence-boundary truncation, ≤ 120-char fragment
//   - Query composition: embedded double quotes are stripped so the outer
//     `"…"` wrapping stays balanced
//   - Query composition: currentYear is embedded verbatim (backward-compat)
//   - Dedupe short-circuit: runTargetedReretrieval returns skipped-already-fired
//     WITHOUT invoking discovery when the fingerprintKey is already in the Set
//
// End-to-end verification of the discovery+fetch+merge path is deferred to
// iteration 9 (brief §5) — mocking searchCompanyDocuments would require
// module-level surgery that isn't warranted for a first pass.

import {
  RetrievalReviewQueue,
  composeTargetedQuery,
  runTargetedReretrieval,
  type ReretrievalRequest,
} from "./retrieval-review-queue.js";
import type { FrameworkMeasure, Framework } from "../../shared/schema.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(name: string) { console.log(`\n── ${name} ──`); }

// Deterministic "current year" so tests don't drift with the wall clock.
const CY = 2026;

// Minimal FrameworkMeasure factory — only sets the fields the module actually reads.
function mkMeasure(overrides: Partial<FrameworkMeasure> = {}): FrameworkMeasure {
  return {
    id: 1,
    frameworkId: 1,
    measureId: "M1",
    category: "Governance",
    categoryNumber: 1,
    title: "Board oversight of climate risk",
    definition: null,
    scoringGuidance: null,
    evidenceKeywords: null,
    requiredSourceTypes: null,
    displayOrder: 0,
    primaryAssessmentTarget: null,
    substantiveDefinition: null,
    whatConstitutesEvidence: null,
    whatDoesNotConstituteEvidence: null,
    fallbackYesCriterion: null,
    positiveExamples: null,
    negativeExamples: null,
    coverageWhitelist: null,
    c1AchievementGuidance: null,
    minQuoteContextChars: null,
    expectedYesRate: null,
    disclosureVehicles: null,
    r31ExceptionMetrics: false,
    r31ExceptionCoverage: false,
    ...overrides,
  } as FrameworkMeasure;
}

// ─── RetrievalReviewQueue idempotence ────────────────────────────────────────

section("RetrievalReviewQueue — hasFired/markFired basic idempotence");
{
  const q = new RetrievalReviewQueue();
  ok(!q.hasFired(1, "M1"), "hasFired returns false before markFired");
  q.markFired(1, "M1");
  ok(q.hasFired(1, "M1"), "hasFired returns true after markFired");
  // Second markFired is a no-op (Set semantics)
  q.markFired(1, "M1");
  ok(q.size === 1, `duplicate markFired stays at size 1 (got ${q.size})`);
}

section("RetrievalReviewQueue — different (company, measure) keys are independent");
{
  const q = new RetrievalReviewQueue();
  q.markFired(1, "M1");
  ok(!q.hasFired(1, "M2"), "different measure on same company is untracked");
  ok(!q.hasFired(2, "M1"), "same measure on different company is untracked");
  q.markFired(1, "M2");
  q.markFired(2, "M1");
  ok(q.size === 3, `three distinct keys ⇒ size=3 (got ${q.size})`);
  ok(q.hasFired(1, "M1") && q.hasFired(1, "M2") && q.hasFired(2, "M1"), "all three keys individually resolvable");
}

section("RetrievalReviewQueue — getFiredSet is the underlying Set (by-reference)");
{
  const q = new RetrievalReviewQueue();
  const s = q.getFiredSet();
  s.add("99:MX");
  ok(q.hasFired(99, "MX"), "mutation via getFiredSet is visible on hasFired");
}

// ─── Query composition — field precedence ────────────────────────────────────

section("composeTargetedQuery — substantiveDefinition wins over definition wins over title");
{
  const measureSD = mkMeasure({
    title: "T",
    definition: "DEF",
    substantiveDefinition: "SUBSTANTIVE",
  });
  const qSD = composeTargetedQuery("Acme Corp", measureSD, CY);
  ok(qSD.includes("SUBSTANTIVE"), `substantiveDefinition wins (got "${qSD}")`);
  ok(!qSD.includes("DEF") && !qSD.includes(" T "), "definition/title not present when substantiveDefinition set");

  const measureDef = mkMeasure({ title: "T", definition: "DEFONLY", substantiveDefinition: null });
  const qDef = composeTargetedQuery("Acme Corp", measureDef, CY);
  ok(qDef.includes("DEFONLY"), `definition wins when substantiveDefinition is null (got "${qDef}")`);

  const measureTitleOnly = mkMeasure({ title: "TITLEONLY", definition: null, substantiveDefinition: null });
  const qT = composeTargetedQuery("Acme Corp", measureTitleOnly, CY);
  ok(qT.includes("TITLEONLY"), `title used as final fallback (got "${qT}")`);
}

// ─── Query composition — truncation ──────────────────────────────────────────

section("composeTargetedQuery — first-sentence truncation");
{
  const longDefinition =
    "The company discloses board-level oversight of climate-related risks and opportunities. " +
    "This second sentence should be dropped by the sentence-boundary truncation rule.";
  const m = mkMeasure({ substantiveDefinition: longDefinition });
  const q = composeTargetedQuery("Acme Corp", m, CY);
  ok(q.includes("board-level oversight"), "first-sentence content preserved");
  ok(!q.includes("second sentence should be dropped"), "second sentence dropped at boundary");
}

section("composeTargetedQuery — 120-char fragment ceiling");
{
  // Build a first "sentence" (no periods) that runs well beyond 120 chars.
  const runOn = "board climate oversight " + "x".repeat(300);
  const m = mkMeasure({ substantiveDefinition: runOn });
  const q = composeTargetedQuery("Acme Corp", m, CY);
  // Extract the fragment between the company-quoted name and the trailing year.
  // Anything past 120 chars from the raw fragment must be gone.
  ok(!q.includes("x".repeat(150)), "runaway fragment truncated well below 150 chars");
  // Sanity: the produced query should be far smaller than the raw input.
  ok(q.length < 300, `truncated query length (${q.length}) < raw input length (${runOn.length})`);
}

// ─── Query composition — embedded quotes / year ──────────────────────────────

section("composeTargetedQuery — embedded double quotes in company name are stripped");
{
  const m = mkMeasure({ definition: "climate governance" });
  const q = composeTargetedQuery('Berkshire "Hathaway"', m, CY);
  // Count double quotes: only the two wrapping the company name should remain.
  const quoteCount = (q.match(/"/g) || []).length;
  ok(quoteCount === 2, `exactly two quotes in output (got ${quoteCount}: "${q}")`);
  ok(q.startsWith('"Berkshire Hathaway"'), `outer wrapping is intact and inner quotes stripped (got "${q}")`);
}

section("composeTargetedQuery — currentYear and prior year both present");
{
  const m = mkMeasure({ definition: "climate governance" });
  const q = composeTargetedQuery("Acme Corp", m, CY);
  ok(q.includes(String(CY)), `currentYear ${CY} present`);
  ok(q.includes(String(CY - 1)), `prior year ${CY - 1} present`);
  ok(q.includes("annual report") && q.includes("sustainability report"),
    "doc-type OR clause preserved verbatim");
}

// ─── Dedupe short-circuit — does NOT hit the network when key already fired ──

section("runTargetedReretrieval — dedupe short-circuits without invoking discovery");
{
  const firedSet = new Set<string>(["7:M1"]);
  const req: ReretrievalRequest = {
    company: { id: 7, name: "Acme Corp" },
    measure: mkMeasure({ measureId: "M1", definition: "climate governance" }),
    // Empty framework/trustedSources are safe here — the dedupe branch returns
    // BEFORE discovery is ever consulted. If the branch order regresses and
    // discovery is called, the test will fail via network/DB errors below.
    framework: { id: 1, name: "Test", topicDescription: null } as unknown as Framework,
    trustedSources: [],
    existingCorpusText: "",
    existingDocUrls: new Set<string>(),
    fingerprintKey: "7:M1",
  };
  const started = Date.now();
  const result = await runTargetedReretrieval(req, firedSet);
  const elapsed = Date.now() - started;
  ok(result.fired === false, `fired=false on already-fired key (got ${result.fired})`);
  ok(result.reason === "skipped-already-fired", `reason=skipped-already-fired (got "${result.reason}")`);
  ok(result.newDocsAdded === 0, `newDocsAdded=0 (got ${result.newDocsAdded})`);
  ok(typeof result.targetedQuery === "string" && result.targetedQuery.length > 0,
    "targetedQuery is still populated for diagnostics");
  // A network round-trip would take >>50ms; short-circuit must complete near-instant.
  ok(elapsed < 200, `short-circuit finishes fast (${elapsed}ms; must be <200ms)`);
  ok(firedSet.size === 1, "firedSet size unchanged after short-circuit");
}

console.log(`\n────────────────────────────\nPASSED: ${passed}   FAILED: ${failed}`);
if (failed > 0) process.exit(1);
