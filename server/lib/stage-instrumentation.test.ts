// Offline unit tests for Phase 3 / Issue 3 Lever 1 (stage-instrumentation.ts).
// Run: npx tsx server/lib/stage-instrumentation.test.ts
// node:test + assert/strict, no live LLM/DB/network (same house style as
// phase1-reproducibility.test.ts / capacity-config.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveStageInstrumentationPolicy,
  DEFAULT_STAGE_INSTRUMENTATION_POLICY,
  STAGE_INSTRUMENTATION_POLICY_VERSION,
  StageLedger,
  summarizeQueueWaits,
  buildHeartbeatRow,
  formatHeartbeatLog,
  SHARED_RESOURCES,
  type QueueWaitSample,
} from "./stage-instrumentation.js";

// ── SI01: kill-switch default + resolver fail-safe (never throws) ──────────────
test("SI01 default policy is off (byte-identical) and version pinned", () => {
  assert.equal(DEFAULT_STAGE_INSTRUMENTATION_POLICY, "off");
  assert.equal(STAGE_INSTRUMENTATION_POLICY_VERSION, 1);
  const saved = process.env.STAGE_INSTRUMENTATION_POLICY;
  delete process.env.STAGE_INSTRUMENTATION_POLICY;
  assert.equal(resolveStageInstrumentationPolicy(), "off");
  if (saved !== undefined) process.env.STAGE_INSTRUMENTATION_POLICY = saved;
});

test("SI01b resolver: explicit > env > default; unrecognised → off; total", () => {
  const saved = process.env.STAGE_INSTRUMENTATION_POLICY;
  assert.equal(resolveStageInstrumentationPolicy("on"), "on");
  assert.equal(resolveStageInstrumentationPolicy("shadow"), "shadow");
  process.env.STAGE_INSTRUMENTATION_POLICY = "on";
  assert.equal(resolveStageInstrumentationPolicy(), "on");
  process.env.STAGE_INSTRUMENTATION_POLICY = "  SHADOW  ";
  assert.equal(resolveStageInstrumentationPolicy(), "shadow");
  process.env.STAGE_INSTRUMENTATION_POLICY = "garbage";
  assert.equal(resolveStageInstrumentationPolicy(), "off"); // fail-safe
  process.env.STAGE_INSTRUMENTATION_POLICY = "";
  assert.equal(resolveStageInstrumentationPolicy(), "off");
  if (saved === undefined) delete process.env.STAGE_INSTRUMENTATION_POLICY;
  else process.env.STAGE_INSTRUMENTATION_POLICY = saved;
});

// ── SI02: THE HEADLINE — a snapshot taken while a stage is OPEN leaves a record ─
// (the batch-1277 case: timed out mid-stage, logs silent → must still have state)
test("SI02 heartbeat snapshot captures the still-open stage (timed-out record)", () => {
  const led = new StageLedger({ jobId: 7, companyId: 42 });
  led.startStage("discovery", 1000);
  led.endStage("discovery", 1500, "ok");
  led.startStage("analysis", 1500); // never ends — job is killed at the deadline
  const snap = led.snapshot(2600); // heartbeat fires mid-analysis
  assert.equal(snap.currentStage, "analysis");
  assert.equal(snap.currentStageElapsedMs, 1100); // 2600 - 1500
  assert.equal(snap.totalElapsedMs, 1600); // 2600 - 1000
  const analysis = snap.stages.find((s) => s.stage === "analysis")!;
  assert.equal(analysis.endedAt, null); // STILL OPEN — the durable record
  assert.equal(analysis.outcome, null);
  const discovery = snap.stages.find((s) => s.stage === "discovery")!;
  assert.equal(discovery.endedAt, 1500);
  assert.equal(discovery.outcome, "ok");
});

// ── SI03: queue-wait aggregation for every shared resource ─────────────────────
test("SI03 queue-wait summarised per shared resource (browser/llm/db/analysis)", () => {
  const led = new StageLedger({ jobId: 1 });
  led.recordQueueWait("browser", 200, 1200);
  led.recordQueueWait("browser", 800, 2000);
  led.recordQueueWait("llm", 50, 1050);
  led.recordQueueWait("analysis", 300, null); // still queued at snapshot
  led.recordQueueWait("bogus" as any, 999, 1); // ignored (not a shared resource)
  const snap = led.snapshot(3000);
  const browser = snap.queueWaits.find((q) => q.resource === "browser")!;
  assert.equal(browser.samples, 2);
  assert.equal(browser.totalWaitMs, 1000);
  assert.equal(browser.maxWaitMs, 800);
  assert.equal(browser.stillQueued, 0);
  const analysis = snap.queueWaits.find((q) => q.resource === "analysis")!;
  assert.equal(analysis.stillQueued, 1);
  assert.ok(!snap.queueWaits.some((q) => (q.resource as string) === "bogus"));
  // db had no samples → omitted
  assert.ok(!snap.queueWaits.some((q) => q.resource === "db"));
});

test("SI03b summarizeQueueWaits emits resources in canonical order, only sampled", () => {
  const samples: QueueWaitSample[] = [
    { resource: "analysis", waitedMs: 10, grantedAt: 1 },
    { resource: "browser", waitedMs: 20, grantedAt: 2 },
  ];
  const out = summarizeQueueWaits(samples);
  assert.deepEqual(out.map((q) => q.resource), ["browser", "analysis"]); // SHARED_RESOURCES order
  assert.equal(SHARED_RESOURCES[0], "browser");
});

// ── SI04: determinism — identical timing shape ⇒ identical fingerprint ─────────
test("SI04 fingerprint is deterministic over timing SHAPE, not wall-clock instant", () => {
  const mk = (base: number) => {
    const l = new StageLedger({ jobId: 1, companyId: 2 });
    l.startStage("a", base);
    l.endStage("a", base + 100, "ok");
    l.startStage("b", base + 100);
    l.endStage("b", base + 250, "ok");
    l.recordQueueWait("llm", 40, base + 40);
    return l.snapshot(base + 250);
  };
  const s1 = mk(1000);
  const s2 = mk(999000); // same durations, different absolute time
  assert.equal(s1.fingerprint, s2.fingerprint); // shape-identical
  // A different duration MUST change the fingerprint.
  const l3 = new StageLedger({ jobId: 1, companyId: 2 });
  l3.startStage("a", 1000);
  l3.endStage("a", 1101, "ok"); // +1ms
  l3.startStage("b", 1101);
  l3.endStage("b", 1251, "ok");
  l3.recordQueueWait("llm", 40, 1040);
  assert.notEqual(l3.snapshot(1251).fingerprint, s1.fingerprint);
});

test("SI04b snapshot is repeatable (heartbeat can fire many times) and non-mutating", () => {
  const led = new StageLedger({ jobId: 9 });
  led.startStage("x", 0);
  const a = led.snapshot(500);
  const b = led.snapshot(500);
  assert.deepEqual(a.stages, b.stages); // same instant ⇒ identical
  assert.equal(a.fingerprint, b.fingerprint);
  led.endStage("x", 600, "ok");
  const c = led.snapshot(700);
  assert.equal(c.stages.find((s) => s.stage === "x")!.endedAt, 600); // later snapshot sees the close
});

// ── SI05: row builder is pure + carries attribution (persistence-ready) ────────
test("SI05 buildHeartbeatRow flattens attribution + timing deterministically", () => {
  const led = new StageLedger({ workspaceId: 3, batchId: 10, jobId: 11, companyId: 12, frameworkId: 4 });
  led.startStage("fetch", 0);
  led.endStage("fetch", 200, "ok");
  led.startStage("score", 200);
  const row = buildHeartbeatRow(led.snapshot(900));
  assert.equal(row.job_id, 11);
  assert.equal(row.batch_id, 10);
  assert.equal(row.company_id, 12);
  assert.equal(row.current_stage, "score");
  assert.equal(row.current_stage_elapsed_ms, 700);
  assert.equal(row.total_elapsed_ms, 900);
  assert.ok(row.stages_json.includes("fetch"));
  assert.ok(typeof row.fingerprint === "string" && row.fingerprint.length === 64);
});

test("SI05b formatHeartbeatLog is a compact deterministic string (shadow mode)", () => {
  const led = new StageLedger({ jobId: 5, companyId: 6 });
  led.startStage("analysis", 0);
  led.recordQueueWait("browser", 1000, null);
  const line = formatHeartbeatLog(led.snapshot(2000));
  assert.ok(line.includes("job=5"));
  assert.ok(line.includes("stage=analysis@2000ms"));
  assert.ok(line.includes("browser=1000ms/1(+1 queued)"));
});

console.log("stage-instrumentation.test.ts — all tests defined");
