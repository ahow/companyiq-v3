/**
 * Standalone tests for the credit-exhaustion circuit breaker.
 * Run: npx tsx server/lib/credit-breaker.test.ts
 *
 * Note: env tunables are set BEFORE importing the module so the thresholds are
 * deterministic for the test (threshold=3, window=60s).
 */
process.env.CREDIT_BREAKER_THRESHOLD = "3";
process.env.CREDIT_BREAKER_WINDOW_MS = "60000";
process.env.CREDIT_BREAKER_COOLDOWN_MS = "120000";

import {
  isCreditExhaustionError,
  recordCreditExhaustion,
  isProviderTripped,
  resetProvider,
  shouldProbe,
} from "./credit-breaker.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`); }
}

console.log("\n— isCreditExhaustionError classification —");
// Canonical 402s in various shapes
check("axios 402 (response.status)", isCreditExhaustionError({ response: { status: 402 } }));
check("sdk 402 (status)", isCreditExhaustionError({ status: 402 }));
check("statusCode 402", isCreditExhaustionError({ statusCode: 402 }));
check("string status '402'", isCreditExhaustionError({ status: "402" }));
// Billing message bodies on non-402 status
check("insufficient balance message", isCreditExhaustionError({ message: "Error: Insufficient Balance" }));
check("insufficient_quota body", isCreditExhaustionError({ response: { data: { error: { type: "insufficient_quota" } } } }));
check("exceeded quota body", isCreditExhaustionError({ response: { data: "You exceeded your current quota, please check your plan" } }));
check("payment required text", isCreditExhaustionError({ message: "402 Payment Required" }));

// Things that must NOT be classified as credit exhaustion
console.log("\n— negatives (must be false) —");
check("429 rate limit is NOT credit", !isCreditExhaustionError({ response: { status: 429 }, message: "Too Many Requests" }));
check("500 server error is NOT credit", !isCreditExhaustionError({ response: { status: 500 }, message: "Internal Server Error" }));
check("timeout is NOT credit", !isCreditExhaustionError({ message: "ETIMEDOUT" }));
check("null is NOT credit", !isCreditExhaustionError(null));
check("plain rate-limit message NOT credit", !isCreditExhaustionError({ message: "rate limit reached for requests" }));

console.log("\n— rolling-window trip / reset —");
const P = "deepseek-test";
resetProvider(P);
check("not tripped initially", !isProviderTripped(P));
const t1 = recordCreditExhaustion(P); // 1
const t2 = recordCreditExhaustion(P); // 2
check("not tripped after 2 (threshold 3)", !isProviderTripped(P) && !t1 && !t2);
const t3 = recordCreditExhaustion(P); // 3 -> trips
check("newly-tripped flag returned on 3rd event", t3 === true);
check("tripped after threshold reached", isProviderTripped(P));
const t4 = recordCreditExhaustion(P); // already tripped
check("subsequent event does not re-flag newlyTripped", t4 === false);

console.log("\n— probe throttling while tripped —");
// First probe allowed (lastProbeAt was null), second within cooldown denied.
const probe1 = shouldProbe(P);
const probe2 = shouldProbe(P);
check("first probe allowed", probe1 === true);
check("second probe within cooldown denied", probe2 === false);

console.log("\n— reset clears state —");
resetProvider(P);
check("not tripped after reset", !isProviderTripped(P));
check("probe allowed after reset (not tripped)", shouldProbe(P) === true);

console.log(`\n──────────────\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
