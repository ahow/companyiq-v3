import assert from "node:assert/strict";
import { ProviderScoringError } from "./credit-breaker.js";
import { classifyProviderError, type ProviderFailureClass } from "./provider-resilience.js";

/**
 * Scoring-crash fail-loud regression tests.
 * ──────────────────────────────────────────────────────────────────────────────
 * Bug: a scoring content-crash (null/empty model content → "Cannot read
 * properties of null", JSON-parse failure on empty content) was silently
 * converted into a substantive `score:0 / verdict:"No"` cell, indistinguishable
 * in totals and in the CSV from a genuine evidence-based "No".
 *
 * Fix (server/lib/analyzer.ts): the scoring-pass catch block now
 *   1. re-throws ProviderScoringError quota_exhausted/authentication UNCHANGED
 *      (pipeline pause/retry), never converting them to a zero;
 *   2. bounded-retries content crashes (scoring_error/timeout) up to
 *      SCORING_CONTENT_RETRIES times (default 2 → 3 attempts);
 *   3. after retries, FAILS LOUD by returning an ABSTAINED sentinel
 *      (abstained:true, verdict:"Scoring error", _scoringFailure set) that
 *      aggregation excludes from the numerator AND the denominator, and that the
 *      client CSV exports verbatim as "Scoring error" — never "No".
 * The N-pass majority vote (scoreSingleMeasure) additionally excludes crashed
 * passes from the tally, only abstaining when EVERY pass crashed. The pipeline
 * mass-failure detector still counts crashes regardless of the abstained flag.
 *
 * These tests mirror that decision logic deterministically (no live LLM), but
 * drive it with the REAL classifyProviderError + ProviderScoringError so the
 * quota/auth-vs-content-crash classification is genuinely exercised.
 *
 * No hardcoded company names, topics, jurisdictions, or framework IDs.
 */

// ─── Types (mirror of analyzer.ts MeasureResult, minimal fields) ─────────────

interface MeasureResult {
  measureId: string;
  score: number;
  confidence: string;
  evidenceSummary: string;
  quotes: Array<{ text: string; source: string }>;
  verdict: "Yes" | "No" | "Partial" | "Insufficient evidence" | "Scoring error";
  verdictNuance: string | null;
  abstained?: boolean;
  _scoringFailure?: string;
  _failureClass?: string;
}

// ─── Mirror of scoreSingleMeasurePass catch-block decision (analyzer.ts) ──────

type ScoringOutcome =
  | { action: "throw" }
  | { action: "retry"; retriesLeft: number }
  | { action: "abstain"; result: MeasureResult };

/**
 * Exact mirror of the catch block in scoreSingleMeasurePass:
 *   - ProviderScoringError quota_exhausted/authentication → re-throw (unchanged)
 *   - retryable (scoring_error/timeout) with budget remaining → retry
 *   - otherwise → abstained "Scoring error" sentinel (NOT verdict "No")
 */
function decideScoringOutcome(measureId: string, error: any, retriesLeft: number): ScoringOutcome {
  if (error instanceof ProviderScoringError) {
    const cls = error.failureClass as ProviderFailureClass;
    if (cls === "quota_exhausted" || cls === "authentication") {
      return { action: "throw" };
    }
  }
  const failureClass = classifyProviderError(error);
  const failureType = failureClass === "timeout" ? "timeout" : "scoring_error";
  if ((failureType === "scoring_error" || failureType === "timeout") && retriesLeft > 0) {
    return { action: "retry", retriesLeft: retriesLeft - 1 };
  }
  return {
    action: "abstain",
    result: {
      measureId,
      score: 0,
      confidence: "Low",
      evidenceSummary: `Scoring ${failureType}: ${error.message}`,
      quotes: [],
      abstained: true,
      verdict: "Scoring error",
      verdictNuance: `[SCORING_FAILURE:${failureType}:${failureClass}] excluded (abstained)`,
      _scoringFailure: failureType,
      _failureClass: failureClass,
    },
  };
}

/**
 * Mirror of the recursive bounded-retry loop. Runs `attempt` up to
 * maxRetries+1 times; returns the success result or the abstained sentinel, or
 * re-throws for quota/auth. Records the number of attempts made.
 */
function runPassWithRetries(
  measureId: string,
  attempt: () => MeasureResult,
  maxRetries: number,
): { result: MeasureResult; attempts: number } {
  let retriesLeft = maxRetries;
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++;
    try {
      return { result: attempt(), attempts };
    } catch (error: any) {
      const outcome = decideScoringOutcome(measureId, error, retriesLeft);
      if (outcome.action === "throw") throw error;
      if (outcome.action === "abstain") return { result: outcome.result, attempts };
      retriesLeft = outcome.retriesLeft;
    }
  }
}

// ─── Mirror of scoreSingleMeasure majority vote (crash exclusion) ────────────

function voteWithCrashExclusion(passResults: MeasureResult[]): MeasureResult {
  const substantivePasses = passResults.filter((r) => !r._scoringFailure);
  if (substantivePasses.length === 0) {
    // All passes crashed → propagate the abstained sentinel.
    return passResults[0];
  }
  const tally = new Map<number, MeasureResult[]>();
  for (const r of substantivePasses) {
    if (!tally.has(r.score)) tally.set(r.score, []);
    tally.get(r.score)!.push(r);
  }
  let winningBucket = substantivePasses[0].score;
  let winningCount = 0;
  for (const [bucket, rs] of tally) {
    if (rs.length > winningCount || (rs.length === winningCount && bucket > winningBucket)) {
      winningBucket = bucket;
      winningCount = rs.length;
    }
  }
  const winners = tally.get(winningBucket)!;
  winners.sort((a, b) => b.quotes.length - a.quotes.length);
  return winners[0];
}

// ─── Mirror of analyzer.ts aggregation (abstained excluded) ──────────────────

function aggregate(measures: MeasureResult[]) {
  const answeredResults = measures.filter((r) => !r.abstained);
  const abstainedCount = measures.length - answeredResults.length;
  const answeredCount = answeredResults.length;
  const totalScore = answeredResults.reduce((sum, r) => sum + r.score, 0);
  const denominator = answeredCount > 0 ? answeredCount : 1;
  const scorePercentage = Math.round((totalScore / denominator) * 100);
  return { totalScore, answeredCount, abstainedCount, scorePercentage };
}

// ─── Mirror of pipeline.ts mass-failure detector (post-fix) ──────────────────

function massFailureRatio(measures: MeasureResult[]) {
  const failuresInAnswered = measures.filter((r) => r._scoringFailure).length;
  const answeredForRatio = measures.filter((r) => !r.abstained || r._scoringFailure).length;
  return answeredForRatio > 0 ? failuresInAnswered / answeredForRatio : 0;
}

// ─── Mirror of client CSV Score cell (ResultsPage.tsx L151) ──────────────────

function csvScoreCell(ms: MeasureResult): string {
  return ms.verdict || (ms.score > 0 ? "Yes" : "No");
}

// ─── Test scaffolding (matches zero-guard.test.ts style) ─────────────────────

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.error(`  [FAIL] ${label}`); }
}

function genuineNo(measureId: string): MeasureResult {
  return {
    measureId, score: 0, confidence: "High", verdict: "No",
    evidenceSummary: "No qualifying disclosure found in reviewed documents",
    quotes: [{ text: "The company does not disclose ...", source: "Annual Report" }],
    verdictNuance: null,
  };
}

async function main() {
  console.log("═ SCORING-CRASH FAIL-LOUD REGRESSION TESTS ═\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: a null-content crash is retried then ABSTAINED — never substantive No
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("═ TEST 1: null-content crash → retry → abstained (not substantive No) ═");
  {
    const nullContentError = new TypeError("Cannot read properties of null (reading 'score')");
    // Sanity: this classifies as a content crash, NOT quota/auth/timeout.
    check("null-content error classifies as non-timeout content crash",
      classifyProviderError(nullContentError) !== "timeout" &&
      classifyProviderError(nullContentError) !== "quota_exhausted" &&
      classifyProviderError(nullContentError) !== "authentication");

    const { result, attempts } = runPassWithRetries("m1", () => { throw nullContentError; }, 2);
    check("crash retried the full budget (3 attempts for SCORING_CONTENT_RETRIES=2)", attempts === 3);
    check("crash cell is abstained (excluded from totals)", result.abstained === true);
    check("crash cell verdict is 'Scoring error', NOT 'No'", result.verdict === "Scoring error");
    check("crash cell carries _scoringFailure tag", result._scoringFailure === "scoring_error");
    check("crash cell is NOT a substantive score:0/verdict:'No'",
      !(result.verdict === "No" && result.abstained !== true));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: an empty-content JSON parse failure behaves the same way
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 2: empty-content JSON parse failure → abstained ═");
  {
    const parseError = new Error("Failed to parse JSON from empty model content");
    const { result } = runPassWithRetries("m2", () => { throw parseError; }, 2);
    check("parse-failure cell abstained", result.abstained === true);
    check("parse-failure cell verdict 'Scoring error'", result.verdict === "Scoring error");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: quota_exhausted re-throws immediately, NO retry, NO zero conversion
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 3: quota_exhausted re-throws unchanged (no retry, no zero) ═");
  {
    const quotaError = new ProviderScoringError("openai", "quota_exhausted");
    let threw = false;
    let attempts = 0;
    try {
      runPassWithRetries("m3", () => { attempts++; throw quotaError; }, 2);
    } catch (e) {
      threw = true;
      check("re-thrown error is the ProviderScoringError", e === quotaError);
    }
    check("quota_exhausted propagated (thrown), not converted to a cell", threw);
    check("quota_exhausted was NOT retried (single attempt)", attempts === 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: authentication re-throws immediately, unchanged
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 4: authentication re-throws unchanged ═");
  {
    const authError = new ProviderScoringError("claude", "authentication");
    let threw = false;
    let attempts = 0;
    try {
      runPassWithRetries("m4", () => { attempts++; throw authError; }, 2);
    } catch (e) {
      threw = true;
    }
    check("authentication propagated (thrown)", threw);
    check("authentication was NOT retried (single attempt)", attempts === 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: a crash that succeeds on retry returns the real result (no abstain)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 5: transient crash succeeds on retry → real result ═");
  {
    let calls = 0;
    const { result, attempts } = runPassWithRetries("m5", () => {
      calls++;
      if (calls < 3) throw new Error("transient content crash");
      return genuineNo("m5");
    }, 2);
    check("succeeded on the 3rd attempt", attempts === 3);
    check("returns the real (non-abstained) result", result.abstained !== true);
    check("real result verdict is the genuine 'No'", result.verdict === "No");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: aggregation excludes abstained crash cells from num AND denom
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 6: aggregation excludes crash cells from totals ═");
  {
    const abstainedCrash = runPassWithRetries("c1", () => {
      throw new TypeError("Cannot read properties of null (reading 'score')");
    }, 2).result;
    // 8 genuine Yes (score 1), 2 genuine No (score 0), 1 crash (abstained)
    const measures: MeasureResult[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ ...genuineNo(`y${i}`), score: 1, verdict: "Yes" as const })),
      genuineNo("n1"), genuineNo("n2"),
      abstainedCrash,
    ];
    const agg = aggregate(measures);
    check("denominator = 10 answered (crash cell excluded, not 11)", agg.answeredCount === 10);
    check("abstainedCount = 1 (the crash cell)", agg.abstainedCount === 1);
    check("totalScore = 8 (crash contributes nothing)", agg.totalScore === 8);
    check("scorePercentage = 80% (8/10, not 8/11≈73%)", agg.scorePercentage === 80);

    // Contrast: the OLD buggy behaviour (crash as substantive No) would have
    // been 8/11 ≈ 73% — verify the crash cell is not silently in the denominator.
    const buggyPct = Math.round((8 / 11) * 100);
    check("crash cell is NOT counted as a substantive No in the denominator",
      agg.scorePercentage !== buggyPct);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 7: majority vote excludes crashed passes; all-crashed → abstained
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 7: N-pass vote excludes crash passes ═");
  {
    const crash = runPassWithRetries("v1", () => {
      throw new TypeError("Cannot read properties of null (reading 'score')");
    }, 2).result;

    // 1 crash + 2 genuine No → chosen is a genuine No (crash not counted)
    const mixed = voteWithCrashExclusion([crash, genuineNo("v1"), genuineNo("v1")]);
    check("mixed vote: crash excluded, chosen is genuine No", mixed.verdict === "No" && mixed.abstained !== true);

    // 1 crash + 2 genuine Yes → chosen is Yes (crash cannot drag toward 0)
    const yes = { ...genuineNo("v2"), score: 1, verdict: "Yes" as const };
    const mixedYes = voteWithCrashExclusion([crash, yes, { ...yes }]);
    check("mixed vote: crash cannot override genuine Yes", mixedYes.verdict === "Yes");

    // 3 crashes → all-crashed → abstained sentinel propagated
    const allCrashed = voteWithCrashExclusion([crash, { ...crash }, { ...crash }]);
    check("all-crashed vote: abstained sentinel propagated", allCrashed.abstained === true);
    check("all-crashed vote: verdict 'Scoring error'", allCrashed.verdict === "Scoring error");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 8: mass-failure detector still counts crashes despite abstained flag
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 8: mass-failure detector counts abstained crash cells ═");
  {
    const crash = runPassWithRetries("f", () => {
      throw new TypeError("Cannot read properties of null (reading 'score')");
    }, 2).result;
    // 6 crashes (abstained) + 4 genuine answered → ratio 6/10 = 0.6 > 0.5 threshold
    const measures: MeasureResult[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ ...crash, measureId: `f${i}` })),
      ...Array.from({ length: 4 }, (_, i) => genuineNo(`ok${i}`)),
    ];
    const ratio = massFailureRatio(measures);
    check("mass-failure ratio = 0.6 (crashes counted despite abstained)", Math.abs(ratio - 0.6) < 1e-9);
    check("mass-failure detector would fire (> 0.5 threshold)", ratio > 0.5);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 9: CSV exports 'Scoring error' verbatim — never 'No'
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═ TEST 9: CSV exports 'Scoring error' verbatim, not 'No' ═");
  {
    const crash = runPassWithRetries("csv", () => {
      throw new TypeError("Cannot read properties of null (reading 'score')");
    }, 2).result;
    check("CSV Score cell for a crash is 'Scoring error'", csvScoreCell(crash) === "Scoring error");
    check("CSV Score cell for a crash is NOT 'No'", csvScoreCell(crash) !== "No");
    // A genuine No still exports as "No".
    check("CSV Score cell for a genuine No is 'No'", csvScoreCell(genuineNo("g")) === "No");
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Scoring-crash fail-loud tests: ${failed === 0 ? "PASS" : "FAIL"} (${passed} passed, ${failed} failed)`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
