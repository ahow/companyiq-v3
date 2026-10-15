// ─── WP08 — Run manifest / immutable replay tests (RP01–RP06) ─────────────────
// Plan: docs/quality-and-efficiency-improvement-plan.md "A7. Immutable replay &
//       dependency-aware artifacts (WP08)" — tests RP01–RP06 (line ~195):
//   RP01 deterministic replay;
//   RP02 framework edit invalidates score/prompt caches but NOT unchanged bytes;
//   RP03 extraction update invalidates dependent passages;
//   RP04 entity/date/policy change invalidates eligibility WITHOUT cross-tenant
//        contamination;
//   RP05 fresh-source update distinguished from scorer change;
//   RP06 output ties to one owning attempt + immutable snapshot.
//
// Run: node --import tsx --test server/lib/run-manifest.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRunManifest,
  classifyRunMode,
  detectReproducibilityLimits,
  computeCodeTreeHash,
  canonicalize,
  hashObject,
  type RunManifestInput,
} from "./run-manifest.js";

// A representative FRESH-run input. Helper clones it so each test can perturb one
// dependency in isolation.
function baseInput(): RunManifestInput {
  return {
    runId: "run-A",
    batchId: 1001,
    workspaceId: 7,
    frameworkId: 42,
    listId: 3,
    scoreOnly: false,
    sourceBatchId: null,
    asOf: "2026-01-01T00:00:00.000Z",
    entityScope: { companyIds: [1, 2, 3], listId: 3 },
    frameworkHash: "fw-hash-v1",
    frameworkVersion: 12,
    measureHashes: [
      { measureId: "m1", hash: "mh1" },
      { measureId: "m2", hash: "mh2" },
    ],
    corpusFingerprint: "corpus-fp-1",
    sourceCorpusFingerprint: null,
    perCompanyCorpus: [
      { companyId: 1, corpusHash: "c1" },
      { companyId: 2, corpusHash: "c2" },
    ],
    extractionVersion: "extract-v3",
    translationSettings: { provider: "deepseek", non_english_ratio_threshold: 0.1 },
    retrievalSettings: { chunk_size: 2200, evidence_top_k: 45 },
    tokenizerSettings: { scheme: "ascii-word>2 + cjk-bigram" },
    packs: [{ companyId: 1, measureId: "m1", packHash: "p1" }],
    promptHashes: { binary: "ph-bin", partial: "ph-part" },
    providerModelParams: [
      { role: "scoring", provider: "deepseek", model: "deepseek-chat", temperature: 0 },
    ],
  };
}

function clone(i: RunManifestInput): RunManifestInput {
  return JSON.parse(JSON.stringify(i));
}

// ── RP01 — deterministic replay ───────────────────────────────────────────────
// A replay of the same dependencies produces an identical manifestHash even when
// the wall-clock (createdAt) differs AND even when it runs under a fresh
// runId/batchId/workspaceId (run-identity is excluded from the dependency hash).
test("RP01: identical dependencies → identical manifestHash regardless of clock & run identity", () => {
  const input = baseInput();

  const a = buildRunManifest(input, "2026-01-01T10:00:00.000Z");
  const b = buildRunManifest(input, "2099-12-31T23:59:59.000Z");
  assert.equal(a.manifestHash, b.manifestHash, "clock must not change the manifest hash");
  assert.notEqual(a.createdAt, b.createdAt, "createdAt still reflects the real emit time");

  // Same dependencies, brand-new run identity (a genuine re-run).
  const rerun = clone(input);
  rerun.runId = "run-B";
  rerun.batchId = 2002;
  rerun.workspaceId = 9;
  rerun.listId = 99;
  const c = buildRunManifest(rerun, "2030-06-06T06:06:06.000Z");
  assert.equal(
    a.manifestHash,
    c.manifestHash,
    "a deterministic replay under a fresh runId/batchId must reproduce the hash",
  );
  // But the identity columns still record *which* run emitted it.
  assert.equal(c.runId, "run-B");
  assert.equal(c.batchId, 2002);
  assert.equal(c.workspaceId, 9);
});

// ── RP02 — framework edit invalidates caches, unchanged bytes stay stable ──────
test("RP02: framework/measure edit changes the hash; unrelated sub-objects are byte-identical", () => {
  const input = baseInput();
  const before = buildRunManifest(input, "t0");

  // Edit the framework hash (a published framework revision).
  const edited = clone(input);
  edited.frameworkHash = "fw-hash-v2";
  const after = buildRunManifest(edited, "t0");

  assert.notEqual(before.manifestHash, after.manifestHash, "framework edit must invalidate the hash");

  // The parts that did NOT change must serialize identically (unchanged bytes are
  // not invalidated — caches keyed on them stay valid).
  assert.equal(canonicalize(before.corpus), canonicalize(after.corpus));
  assert.equal(canonicalize(before.retrieval), canonicalize(after.retrieval));
  assert.equal(canonicalize(before.translation), canonicalize(after.translation));
  assert.equal(canonicalize(before.prompts), canonicalize(after.prompts));
  assert.equal(canonicalize(before.extraction), canonicalize(after.extraction));

  // Editing a single measure hash also invalidates.
  const measureEdited = clone(input);
  measureEdited.measureHashes![1] = { measureId: "m2", hash: "mh2-v2" };
  const after2 = buildRunManifest(measureEdited, "t0");
  assert.notEqual(before.manifestHash, after2.manifestHash, "measure edit must invalidate the hash");

  // Changing ONLY run identity does not (RP01 corollary — proves the hash is a
  // pure dependency fingerprint, so a framework edit is distinguishable from a
  // mere re-run).
  const reran = clone(input);
  reran.runId = "run-Z";
  reran.batchId = 5005;
  assert.equal(before.manifestHash, buildRunManifest(reran, "t9").manifestHash);
});

// ── RP03 — extraction update invalidates dependent passages ────────────────────
test("RP03: extraction version change invalidates the hash while other deps stay stable", () => {
  const input = baseInput();
  const before = buildRunManifest(input, "t0");

  const bumped = clone(input);
  bumped.extractionVersion = "extract-v4";
  const after = buildRunManifest(bumped, "t0");

  assert.notEqual(before.manifestHash, after.manifestHash, "extraction bump must invalidate the hash");
  assert.equal(after.extraction.version, "extract-v4");
  // Framework/corpus that feed the same passages are unchanged bytes.
  assert.equal(canonicalize(before.framework), canonicalize(after.framework));
  assert.equal(canonicalize(before.corpus), canonicalize(after.corpus));
});

// ── RP04 — entity/date change invalidates eligibility, no cross-tenant bleed ────
test("RP04: scope (as-of / entities) changes the hash; disjoint tenants never collide", () => {
  const input = baseInput();
  const before = buildRunManifest(input, "t0");

  // As-of (policy/date) change → different eligibility → different hash.
  const dateChanged = clone(input);
  dateChanged.asOf = "2026-06-30T00:00:00.000Z";
  assert.notEqual(
    before.manifestHash,
    buildRunManifest(dateChanged, "t0").manifestHash,
    "as-of change must invalidate the hash",
  );

  // Entity scope change → different hash.
  const entityChanged = clone(input);
  entityChanged.entityScope = { companyIds: [1, 2], listId: 3 };
  assert.notEqual(
    before.manifestHash,
    buildRunManifest(entityChanged, "t0").manifestHash,
    "entity-scope change must invalidate the hash",
  );

  // Cross-tenant isolation: tenant A [1,2,3] vs tenant B [4,5,6], identical in
  // every other dependency, must produce DIFFERENT hashes (no contamination) even
  // though workspaceId (a run-identity column) is excluded from the hash.
  const tenantA = clone(input);
  tenantA.workspaceId = 100;
  tenantA.entityScope = { companyIds: [1, 2, 3], listId: 3 };
  const tenantB = clone(input);
  tenantB.workspaceId = 200;
  tenantB.entityScope = { companyIds: [4, 5, 6], listId: 3 };
  const hashA = buildRunManifest(tenantA, "t0").manifestHash;
  const hashB = buildRunManifest(tenantB, "t0").manifestHash;
  assert.notEqual(hashA, hashB, "disjoint company scopes must hash differently");

  // workspaceId alone is NOT in the dependency hash, but IS recorded on the row.
  const wsOnly = clone(input);
  wsOnly.workspaceId = 999;
  const wsManifest = buildRunManifest(wsOnly, "t0");
  assert.equal(before.manifestHash, wsManifest.manifestHash, "workspaceId alone must not change the hash");
  assert.equal(wsManifest.workspaceId, 999, "workspaceId is still stored for query-time tenant filtering");
});

// ── RP05 — fresh-source update distinguished from scorer change ─────────────────
test("RP05: fresh vs replay run modes, and corpus-change vs scorer-change are distinguishable", () => {
  // Run-mode classification: replay only when scoreOnly AND a source batch is pinned.
  assert.equal(classifyRunMode({ scoreOnly: true, sourceBatchId: 5 }), "replay");
  assert.equal(classifyRunMode({ scoreOnly: true, sourceBatchId: null }), "fresh");
  assert.equal(classifyRunMode({ scoreOnly: false, sourceBatchId: 5 }), "fresh");
  assert.equal(classifyRunMode({ scoreOnly: false, sourceBatchId: null }), "fresh");

  const fresh = buildRunManifest(baseInput(), "t0");
  assert.equal(fresh.runMode, "fresh");

  const replayInput = clone(baseInput());
  replayInput.scoreOnly = true;
  replayInput.sourceBatchId = 900;
  const replay = buildRunManifest(replayInput, "t0");
  assert.equal(replay.runMode, "replay");

  // FRESH carries a 'corpus' blocks-limit; REPLAY does not.
  assert.ok(
    fresh.reproducibilityLimits.some((l) => l.field === "corpus" && l.severity === "blocks"),
    "fresh run must flag the unpinned corpus as a blocking limit",
  );
  assert.ok(
    !replay.reproducibilityLimits.some((l) => l.field === "corpus"),
    "a fixed-corpus replay must NOT carry the corpus limit",
  );

  // A fresh-SOURCE update (corpus fingerprint moves) and a SCORER change
  // (provider/model params move) are distinguishable: each changes the hash, and
  // the change is localized to its own sub-object.
  const base = baseInput();
  const sourceMoved = clone(base);
  sourceMoved.corpusFingerprint = "corpus-fp-2";
  const scorerMoved = clone(base);
  scorerMoved.providerModelParams = [
    { role: "scoring", provider: "openai", model: "gpt-4o", temperature: 0 },
  ];

  const baseM = buildRunManifest(base, "t0");
  const sourceM = buildRunManifest(sourceMoved, "t0");
  const scorerM = buildRunManifest(scorerMoved, "t0");

  assert.notEqual(baseM.manifestHash, sourceM.manifestHash, "corpus change must invalidate");
  assert.notEqual(baseM.manifestHash, scorerM.manifestHash, "scorer change must invalidate");
  assert.notEqual(sourceM.manifestHash, scorerM.manifestHash, "the two kinds of change are distinct");

  // Localization: when only the source moved, providerModelParams are byte-equal;
  // when only the scorer moved, the corpus is byte-equal.
  assert.equal(
    canonicalize(baseM.providerModelParams),
    canonicalize(sourceM.providerModelParams),
    "a corpus change leaves the scorer untouched",
  );
  assert.notEqual(canonicalize(baseM.corpus), canonicalize(sourceM.corpus));
  assert.equal(
    canonicalize(baseM.corpus),
    canonicalize(scorerM.corpus),
    "a scorer change leaves the corpus untouched",
  );
  assert.notEqual(canonicalize(baseM.providerModelParams), canonicalize(scorerM.providerModelParams));
});

// ── RP06 — one owning run + immutable snapshot (no faked determinism) ──────────
test("RP06: manifest ties to one run, honestly records alias drift, and is immutable", () => {
  const input = baseInput();
  const m = buildRunManifest(input, "2026-02-02T02:02:02.000Z");

  // Ties to exactly one owning run.
  assert.equal(m.runId, "run-A");
  assert.equal(m.batchId, 1001);
  assert.equal(m.schemaVersion, 1);

  // Honesty: a remote provider/model alias is flagged as a BLOCKING reproducibility
  // limit — we never claim faked determinism even for a fixed-corpus replay.
  const limits = detectReproducibilityLimits({
    runMode: "replay",
    codeTreeComponents: computeCodeTreeHash().components,
    providerModelParams: input.providerModelParams,
  });
  assert.ok(
    limits.some((l) => l.field.startsWith("model_alias") && l.severity === "blocks"),
    "a provider/model alias must be recorded as a blocking reproducibility limit",
  );
  // The live manifest carries the same honesty ledger.
  assert.ok(m.reproducibilityLimits.some((l) => l.field.startsWith("model_alias")));

  // Immutable snapshot: recomputing from the identical body yields the identical
  // hash, and the hash matches a direct canonical hash of the dependency body
  // (minus the excluded run-identity + clock fields).
  const again = buildRunManifest(input, "2026-02-02T02:02:02.000Z");
  assert.equal(m.manifestHash, again.manifestHash, "the manifest hash is stable / immutable");

  const {
    manifestHash: _h,
    createdAt: _c,
    runId: _r,
    batchId: _b,
    workspaceId: _w,
    listId: _l,
    ...dependencyBody
  } = m;
  assert.equal(
    m.manifestHash,
    hashObject(dependencyBody),
    "manifestHash is exactly the canonical hash of the dependency body",
  );
});

// ── code-tree reproducibility limit ───────────────────────────────────────────
test("code-tree 'dev' build is recorded as a (bounding) reproducibility limit", () => {
  const limits = detectReproducibilityLimits({
    runMode: "replay",
    codeTreeComponents: { git_sha: "dev", pipeline_version: "x" },
    providerModelParams: [],
  });
  assert.ok(limits.some((l) => l.field === "code_tree" && l.severity === "bounds"));

  const pinned = detectReproducibilityLimits({
    runMode: "replay",
    codeTreeComponents: { git_sha: "abc123", pipeline_version: "x" },
    providerModelParams: [],
  });
  assert.ok(!pinned.some((l) => l.field === "code_tree"), "a pinned commit carries no code_tree limit");
});
