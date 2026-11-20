// Unit tests for the Score-Only Replay harness (SCORE_ONLY_REPLAY).
//
// PURPOSE OF THE HARNESS: hold the evidence set CONSTANT across runs. When the
// flag is ON and a (company, framework) has a pinned frozen_corpus_snapshot, the
// pipeline bypasses discovery + retrieval(fetch) + extraction and feeds EXACTLY
// that pinned corpus to scoring; a pair with NO pinned set is SKIPPED with a
// logged reason (never re-discovered). With the flag OFF the pipeline behaves
// byte-for-byte as today.
//
// These tests pin the pure contract that drives the pipeline branch:
//   (a) the flag defaults OFF;
//   (b) OFF  → decision mode "off"  → replay branch NOT taken (pipeline unchanged);
//   (c) ON + pinned set present → mode "replay" → discovery/retrieval/extraction
//       bypassed and the pinned corpus is what reaches scoring;
//   (d) ON + NO pinned set → mode "skip" → the documented fail-safe path (skip the
//       company, do NOT re-discover), and its error is classified NON-RETRIABLE so
//       the worker does not loop a fresh discovery on top.
// Also: ON while a batch_corpus (sourceBatchId) replay is already active yields
// "off" so the two replay paths never double-engage.
//
// Pure fixtures only — no network, no DB, no runs (matches the pattern of
// framework-rules.test.ts / retrieval-funnel.test.ts).
//
// Run: node --import tsx --test server/lib/score-only-replay.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { scoreOnlyReplayEnabled, decideScoreOnlyReplay } from "./scoring-fix-flags.js";
import { isRetriableError } from "./retry-policy.js";

function setFlag(name: string, v: string | null) {
  if (v == null) delete process.env[name];
  else process.env[name] = v;
}

afterEach(() => {
  setFlag("SCORE_ONLY_REPLAY", null);
});

// ─── (a) flag default is OFF ────────────────────────────────────────────────────

test("SCORE_ONLY_REPLAY defaults OFF when the env var is unset", () => {
  setFlag("SCORE_ONLY_REPLAY", null);
  assert.equal(scoreOnlyReplayEnabled(), false, "unset → disabled");
});

test("SCORE_ONLY_REPLAY reads truthy/falsey env values via the shared helper", () => {
  setFlag("SCORE_ONLY_REPLAY", "1");
  assert.equal(scoreOnlyReplayEnabled(), true, "'1' → enabled");
  setFlag("SCORE_ONLY_REPLAY", "true");
  assert.equal(scoreOnlyReplayEnabled(), true, "'true' → enabled");
  setFlag("SCORE_ONLY_REPLAY", "0");
  assert.equal(scoreOnlyReplayEnabled(), false, "'0' → disabled");
  setFlag("SCORE_ONLY_REPLAY", "false");
  assert.equal(scoreOnlyReplayEnabled(), false, "'false' → disabled");
});

// ─── (b) OFF → replay branch NOT taken (pipeline unchanged) ─────────────────────

test("decideScoreOnlyReplay: flag OFF → mode 'off' regardless of pinned docs", () => {
  // Even with a pinned corpus present, a disabled harness must not change behaviour.
  const d = decideScoreOnlyReplay({ enabled: false, sourceBatchIdPresent: false, pinnedDocCount: 7 });
  assert.equal(d.mode, "off");
  assert.equal(d.reason, "flag-off");
});

// ─── sourceBatchId replay active → 'off' (never double-engage) ───────────────────

test("decideScoreOnlyReplay: flag ON but a batch_corpus (sourceBatchId) replay is active → 'off'", () => {
  const d = decideScoreOnlyReplay({ enabled: true, sourceBatchIdPresent: true, pinnedDocCount: 12 });
  assert.equal(d.mode, "off", "existing batch_corpus replay takes precedence");
  assert.equal(d.reason, "source-batch-replay-active");
});

// ─── (c) ON + pinned set present → 'replay' ─────────────────────────────────────

test("decideScoreOnlyReplay: flag ON + pinned corpus present → 'replay'", () => {
  const d = decideScoreOnlyReplay({ enabled: true, sourceBatchIdPresent: false, pinnedDocCount: 5 });
  assert.equal(d.mode, "replay", "pinned docs exist → replay against that exact set");
  assert.match(d.reason, /^pinned-corpus-present:5$/);
});

test("decideScoreOnlyReplay: a single pinned doc is still enough to replay", () => {
  const d = decideScoreOnlyReplay({ enabled: true, sourceBatchIdPresent: false, pinnedDocCount: 1 });
  assert.equal(d.mode, "replay");
});

// ─── (d) ON + NO pinned set → 'skip' (fail-safe; never re-discover) ──────────────

test("decideScoreOnlyReplay: flag ON + NO pinned corpus → 'skip' (fail-safe, no re-discovery)", () => {
  const d = decideScoreOnlyReplay({ enabled: true, sourceBatchIdPresent: false, pinnedDocCount: 0 });
  assert.equal(d.mode, "skip", "no pinned docs → skip the company, do NOT re-discover");
  assert.equal(d.reason, "no-pinned-corpus");
});

// ─── skip error is NON-RETRIABLE (worker must not loop a fresh discovery) ────────

test("the score-only-replay skip error is classified NON-RETRIABLE", () => {
  // This is the exact error string runAnalysisPipeline returns on the skip path.
  const skipError =
    "score-only-replay: no pinned corpus for company=123 fw=25 — skipped (no re-discovery)";
  assert.equal(
    isRetriableError(skipError),
    false,
    "skip must be final so the worker does not re-enqueue and re-discover, moving the evidence",
  );
});

test("an ordinary transient error is still retriable (guard: substring is specific)", () => {
  assert.equal(isRetriableError("ECONNRESET while fetching"), true);
});

// ─── decision is pure (no hidden env / company / framework coupling) ─────────────

test("decideScoreOnlyReplay is a pure function of its explicit inputs", () => {
  const args = { enabled: true, sourceBatchIdPresent: false, pinnedDocCount: 3 } as const;
  const a = decideScoreOnlyReplay(args);
  const b = decideScoreOnlyReplay(args);
  assert.deepEqual(a, b, "same inputs → same output, every time");
});
