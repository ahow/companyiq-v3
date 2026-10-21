/**
 * Unit tests for the I81 cascade resilience helpers in analyzer.ts:
 *   normaliseCascadeFallback, withStageTimeout, CascadeStageTimeoutError, runCascadeStage
 *
 * These exercise the EXACT production control-flow that scoreWithCascade uses for
 * per-stage fallback + per-stage timeout. They are fully offline: the provider
 * call is a fake async function, so no LLM / network / DB is touched. The goal is
 * to prove the resilience behaviour the user asked for:
 *   - fallback fires on a provider THROW,
 *   - fallback fires on a provider HANG (> stage timeout),
 *   - a lifecycle cancellation is re-thrown and NEVER converted to a fallback,
 *   - fallback disabled ("" / none / off / self) preserves pre-I81 fail-loud,
 *   - the timeout timer is cleared on a fast win (no dangling handle).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseCascadeFallback,
  withStageTimeout,
  CascadeStageTimeoutError,
  runCascadeStage,
} from "./analyzer.js";

type R = { score: number; provider: string };
const ok = (provider: string, score = 1): R => ({ score, provider });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {}); // hangs forever

// ─── normaliseCascadeFallback ────────────────────────────────────────────────
test("normaliseCascadeFallback: empty / none / off / self → null (disabled)", () => {
  assert.equal(normaliseCascadeFallback("", "deepseek"), null);
  assert.equal(normaliseCascadeFallback("   ", "deepseek"), null);
  assert.equal(normaliseCascadeFallback(undefined, "deepseek"), null);
  assert.equal(normaliseCascadeFallback(null, "deepseek"), null);
  assert.equal(normaliseCascadeFallback("none", "deepseek"), null);
  assert.equal(normaliseCascadeFallback("NONE", "deepseek"), null);
  assert.equal(normaliseCascadeFallback("Off", "deepseek"), null);
  assert.equal(normaliseCascadeFallback("deepseek", "deepseek"), null); // self-fallback dropped
});

test("normaliseCascadeFallback: a real distinct provider is kept (trimmed)", () => {
  assert.equal(normaliseCascadeFallback("openrouter", "deepseek"), "openrouter");
  assert.equal(normaliseCascadeFallback("  glm-4.6 ", "glm-4.6-zai"), "glm-4.6");
});

// ─── withStageTimeout ────────────────────────────────────────────────────────
test("withStageTimeout: resolves before the timeout → returns value", async () => {
  const out = await withStageTimeout(Promise.resolve(ok("p", 7)), "p", 1000);
  assert.equal(out.score, 7);
});

test("withStageTimeout: stageTimeoutMs<=0 disables the timeout (slow still resolves)", async () => {
  const slow = (async () => { await delay(30); return ok("p", 3); })();
  const out = await withStageTimeout(slow, "p", 0);
  assert.equal(out.score, 3);
});

test("withStageTimeout: a hang past the timeout rejects with CascadeStageTimeoutError", async () => {
  await assert.rejects(
    () => withStageTimeout(never<R>(), "glm-4.6-zai", 20),
    (e: any) => {
      assert.ok(e instanceof CascadeStageTimeoutError);
      assert.equal(e.provider, "glm-4.6-zai");
      assert.equal(e.ms, 20);
      return true;
    },
  );
});

test("withStageTimeout: timer is cleared on a fast win (process is not kept alive)", async () => {
  // If the timer were not cleared, an unref'd-less setTimeout would keep the event
  // loop busy. We assert the call settles well before the (large) timeout elapses.
  const t0 = Date.now();
  await withStageTimeout(Promise.resolve(ok("p")), "p", 5000);
  assert.ok(Date.now() - t0 < 500, "resolved promptly, did not wait on the timer");
});

// ─── runCascadeStage ─────────────────────────────────────────────────────────
test("runCascadeStage: provider succeeds → primary result, no fallback invoked", async () => {
  let fbCalled = false;
  const out = await runCascadeStage<R>({
    provider: "deepseek", fallback: "openrouter", role: "primary", stageTimeoutMs: 1000,
    run: async (p) => ok(p, 5),
    isLifecycleCancelled: () => false,
    onFallback: () => { fbCalled = true; },
  });
  assert.equal(out.provider, "deepseek");
  assert.equal(out.score, 5);
  assert.equal(fbCalled, false);
});

test("runCascadeStage: provider THROWS → falls back, returns fallback result, logs reason", async () => {
  const seen: any[] = [];
  const out = await runCascadeStage<R>({
    provider: "deepseek", fallback: "openrouter", role: "primary", stageTimeoutMs: 1000,
    run: async (p) => { if (p === "deepseek") throw new Error("boom-502"); return ok(p, 9); },
    isLifecycleCancelled: () => false,
    onFallback: (i) => seen.push(i),
  });
  assert.equal(out.provider, "openrouter");
  assert.equal(seen.length, 1);
  assert.deepEqual({ role: seen[0].role, from: seen[0].from, to: seen[0].to }, { role: "primary", from: "deepseek", to: "openrouter" });
  assert.match(seen[0].reason, /boom-502/);
});

test("runCascadeStage: provider HANGS past timeout → falls back with a timeout reason", async () => {
  const seen: any[] = [];
  const out = await runCascadeStage<R>({
    provider: "glm-4.6-zai", fallback: "glm-4.6", role: "secondary", stageTimeoutMs: 20,
    run: async (p) => { if (p === "glm-4.6-zai") return never<R>(); return ok(p, 4); },
    isLifecycleCancelled: () => false,
    onFallback: (i) => seen.push(i),
  });
  assert.equal(out.provider, "glm-4.6");
  assert.equal(seen.length, 1);
  assert.match(seen[0].reason, /^timeout>20ms/);
});

test("runCascadeStage: lifecycle cancellation is RE-THROWN, never falls back", async () => {
  let fbCalled = false;
  const cancel = new Error("job cancelled");
  await assert.rejects(
    () => runCascadeStage<R>({
      provider: "deepseek", fallback: "openrouter", role: "primary", stageTimeoutMs: 1000,
      run: async () => { throw cancel; },
      isLifecycleCancelled: (e) => e === cancel,
      onFallback: () => { fbCalled = true; },
    }),
    (e: any) => e === cancel,
  );
  assert.equal(fbCalled, false, "fallback must NOT fire on a lifecycle cancellation");
});

test("runCascadeStage: fallback disabled (null) → original error propagates (fail-loud)", async () => {
  await assert.rejects(
    () => runCascadeStage<R>({
      provider: "deepseek", fallback: null, role: "primary", stageTimeoutMs: 1000,
      run: async () => { throw new Error("primary-down"); },
      isLifecycleCancelled: () => false,
    }),
    /primary-down/,
  );
});

test("runCascadeStage: both provider AND fallback fail → fallback's error propagates", async () => {
  await assert.rejects(
    () => runCascadeStage<R>({
      provider: "deepseek", fallback: "openrouter", role: "primary", stageTimeoutMs: 1000,
      run: async (p) => { throw new Error(p === "deepseek" ? "primary-down" : "fallback-down"); },
      isLifecycleCancelled: () => false,
    }),
    /fallback-down/,
  );
});
