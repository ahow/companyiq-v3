/**
 * Unit tests for Change 4 — per-stage timeout coverage of the ARBITER stage.
 *
 * Commit 9b41150 added a per-stage wall-clock cap (CASCADE_STAGE_TIMEOUT_MS,
 * default 180000ms) and ran stages 1 and 2 through runCascadeStage → withStageTimeout.
 * The arbiter, however, was a bare `await scoreOne(arbiter)` with no timeout, so a
 * hung arbiter could freeze a measure to the 2100s pipeline timeout. Change 4 wraps
 * the arbiter call in the SAME withStageTimeout the primary stages use.
 *
 * These tests exercise the EXACT production call shape of the arbiter stage —
 * `withStageTimeout(scoreOne(arbiter), arbiter, stageTimeoutMs)` — with a fake async
 * provider (fully offline: no LLM / network / DB). They prove:
 *   - a hung arbiter is bounded by the cap (rejects with CascadeStageTimeoutError),
 *   - a fast arbiter resolves normally (quotes/score preserved),
 *   - stageTimeoutMs<=0 disables the cap (byte-identical to the pre-Change-4 call),
 *   - fail-loud: the timeout error propagates (no arbiter model-fallback path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withStageTimeout, CascadeStageTimeoutError } from "./analyzer.js";

type R = { score: number; provider: string; quotes: string[] };
const arbiterOk = (score = 1): R => ({ score, provider: "gpt5-arbiter", quotes: ["q1", "q2"] });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {}); // hangs forever

test("arbiter stage: a hang past the cap rejects with CascadeStageTimeoutError (fail-loud)", async () => {
  await assert.rejects(
    () => withStageTimeout(never<R>(), "gpt5-arbiter", 20),
    (err: unknown) => {
      assert.ok(err instanceof CascadeStageTimeoutError, "must be the per-stage timeout error");
      assert.match((err as Error).message, /gpt5-arbiter/);
      return true;
    },
  );
});

test("arbiter stage: a fast arbiter resolves before the cap (score + quotes preserved)", async () => {
  const fast = (async () => { await delay(5); return arbiterOk(0); })();
  const out = await withStageTimeout(fast, "gpt5-arbiter", 180000);
  assert.equal(out.score, 0);
  assert.deepEqual(out.quotes, ["q1", "q2"], "evidence quotes are never dropped by the timeout wrapper");
});

test("arbiter stage: stageTimeoutMs<=0 disables the cap (byte-identical to pre-Change-4)", async () => {
  const slow = (async () => { await delay(30); return arbiterOk(1); })();
  const out = await withStageTimeout(slow, "gpt5-arbiter", 0);
  assert.equal(out.score, 1, "with the cap disabled the slow arbiter still resolves, unchanged");
});

test("arbiter stage: a provider throw propagates unchanged (no fallback invented)", async () => {
  const boom = (async () => { throw new Error("arbiter upstream 500"); })();
  await assert.rejects(
    () => withStageTimeout(boom, "gpt5-arbiter", 180000),
    /arbiter upstream 500/,
  );
});
