// ─── Unit tests for F1 (FRAMEWORK_LINEAGE_FREEZE) lineage resolution ──────────
//
// Pure, DB-free: deriveLineageKey + resolveImportLineageId decide the stable
// lineage id for an imported framework without any hardcoded framework name.
//
// Run: node --import tsx --test server/lib/framework-v2/framework-lineage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveLineageKey,
  resolveImportLineageId,
  type ExistingLineageFramework,
} from "./import-framework.js";

// ── deriveLineageKey ─────────────────────────────────────────────────────────
test("deriveLineageKey: normalizes name + topic (case/whitespace insensitive)", () => {
  const a = deriveLineageKey({ name: "Physical Climate  Risk", topicTerm: "Climate" });
  const b = deriveLineageKey({ name: "physical climate risk", topicTerm: "climate" });
  assert.equal(a, b);
});

test("deriveLineageKey: strips trailing ' (imported)' suffixes so re-imports collide", () => {
  const base = deriveLineageKey({ name: "Physical Climate Risk", topicTerm: "Climate" });
  const imp1 = deriveLineageKey({ name: "Physical Climate Risk (imported)", topicTerm: "Climate" });
  const imp2 = deriveLineageKey({ name: "Physical Climate Risk (imported) (imported)", topicTerm: "Climate" });
  assert.equal(imp1, base);
  assert.equal(imp2, base);
});

test("deriveLineageKey: accepts snake_case field aliases", () => {
  const camel = deriveLineageKey({ name: "X", topicDescription: "desc here" });
  const snake = deriveLineageKey({ name: "X", topic_description: "desc here" });
  assert.equal(camel, snake);
});

test("deriveLineageKey: different topics produce different keys", () => {
  const a = deriveLineageKey({ name: "Same Name", topicTerm: "water" });
  const b = deriveLineageKey({ name: "Same Name", topicTerm: "carbon" });
  assert.notEqual(a, b);
});

test("deriveLineageKey: tolerates null/undefined input", () => {
  assert.equal(deriveLineageKey(null), "|");
  assert.equal(deriveLineageKey(undefined), "|");
  assert.equal(deriveLineageKey({}), "|");
});

// ── resolveImportLineageId ───────────────────────────────────────────────────
const KEY = "physical climate risk|climate";

test("resolveImportLineageId: no existing match → root (null lineageId, no backfill)", () => {
  const r = resolveImportLineageId({ candidateKey: KEY, existing: [] });
  assert.deepEqual(r, { lineageId: null, backfillFrameworkId: null });
});

test("resolveImportLineageId: match with an existing lineage id → adopt it", () => {
  const existing: ExistingLineageFramework[] = [
    { id: 23, frameworkLineageId: 23, lineageKey: KEY },
    { id: 25, frameworkLineageId: 23, lineageKey: KEY },
  ];
  const r = resolveImportLineageId({ candidateKey: KEY, existing });
  assert.deepEqual(r, { lineageId: 23, backfillFrameworkId: null });
});

test("resolveImportLineageId: match with NULL lineage id → root at earliest id + backfill", () => {
  const existing: ExistingLineageFramework[] = [
    { id: 25, frameworkLineageId: null, lineageKey: KEY },
    { id: 23, frameworkLineageId: null, lineageKey: KEY },
  ];
  const r = resolveImportLineageId({ candidateKey: KEY, existing });
  // Earliest id (23) becomes the lineage root and is flagged for backfill.
  assert.deepEqual(r, { lineageId: 23, backfillFrameworkId: 23 });
});

test("resolveImportLineageId: ignores frameworks with a different lineage key", () => {
  const existing: ExistingLineageFramework[] = [
    { id: 10, frameworkLineageId: 10, lineageKey: "other|topic" },
  ];
  const r = resolveImportLineageId({ candidateKey: KEY, existing });
  assert.deepEqual(r, { lineageId: null, backfillFrameworkId: null });
});

test("resolveImportLineageId: prefers an already-set lineage even if a null-lineage match has a smaller id", () => {
  const existing: ExistingLineageFramework[] = [
    { id: 5, frameworkLineageId: null, lineageKey: KEY },
    { id: 9, frameworkLineageId: 9, lineageKey: KEY },
  ];
  const r = resolveImportLineageId({ candidateKey: KEY, existing });
  assert.deepEqual(r, { lineageId: 9, backfillFrameworkId: null });
});
