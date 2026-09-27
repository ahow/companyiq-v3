/**
 * Export fidelity — original-in-memory vs reconstructed-after-import (Workstream 3).
 *
 * This is the reviewer's KEY acceptance test. It is deliberately NOT an
 * export-to-export comparison (which could pass while both artefacts share the same
 * bug). Instead it:
 *
 *   1. builds a representative in-memory framework exercising the tricky cases:
 *        - anchorFrameworks that MIX JSON-encoded object strings with plain labels,
 *          plus nested typed anchors in the intake artefact (dedupe + provenance),
 *        - scope fields present ONLY in the nested intake artefact (root null),
 *        - per-measure evidenceKeywords distinct from the framework-level surface,
 *        - stable logical ids (measureId) alongside volatile DB-surrogate ids (id,
 *          frameworkId) that must be excluded,
 *        - the distinct lexicon surfaces (topicSynonyms / evidenceKeywords /
 *          documentFilingHints / retrievalQueryTerms / negativeKeywords /
 *          antiInferenceRules) which must never be collapsed;
 *   2. resolves it to the canonical operational object (`resolveConfig`);
 *   3. builds the canonical JSON export (`buildFrameworkExport`);
 *   4. runs that export back through the import path (`buildFrameworkInserts`);
 *   5. reconstructs the operational object from the imported framework + measures;
 *   6. asserts DEEP EQUALITY over ALL operational fields.
 *
 * If any operational field is lost or mutated across export→import, the deepEqual
 * assertion fails. The assertion is intentionally strict and must NOT be weakened:
 * a genuine round-trip gap is a bug to be fixed in the resolver/export/import, not
 * in this test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "./resolve-config.js";
import {
  buildFrameworkExport,
  buildFrameworkInserts,
} from "../import-framework.js";

/**
 * A representative in-memory framework. Every field here is a deliberate stress
 * case for the resolver + export/import round-trip. Volatile ids (id/frameworkId)
 * are present precisely so the test proves they are excluded consistently.
 */
function buildRepresentativeFramework(): {
  framework: Record<string, any>;
  measures: Record<string, any>[];
} {
  const framework: Record<string, any> = {
    // Volatile identity/audit columns — must be stripped, never appear in the
    // resolved config on either side.
    id: 4242,
    workspaceId: 7,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
    isActive: true,

    name: "AI Governance and Strategy",
    version: 3,
    topicTerm: "AI governance",
    topicDescription: "How an entity governs its use and development of AI.",

    // Lexicon surface #1 — topic synonyms (root).
    topicSynonyms: ["artificial intelligence governance", "AI oversight"],
    // Lexicon surface #2 — framework-level evidence keywords (DISTINCT from the
    // per-measure evidence keywords below).
    evidenceKeywords: ["board oversight of AI", "AI policy", "model risk"],
    // Lexicon surface #3 — document/filing hints arrive as requiredDocTypes and
    // must resolve to documentFilingHints without collapsing into another surface.
    requiredDocTypes: ["10-K", "proxy statement", "sustainability report"],
    // Lexicon surface #4 — retrieval query terms (root).
    retrievalQueryTerms: ["responsible AI", "AI ethics committee"],

    // ANCHORS: a mix of genuinely plain labels and JSON-ENCODED object strings.
    anchorFrameworks: [
      "OECD AI Principles",
      '{"name":"EU AI Act","source":"European Commission"}',
      "NIST AI RMF",
      '{"name":"ISO/IEC 42001","source":"ISO"}',
    ],

    // Scope fields are ABSENT at root — they live only in the intake artefact and
    // must be carried up to the root of the resolved config.
    entityType: null,
    sectorScope: null,
    universe: null,
    reportingPeriod: null,

    // Hardening surfaces live ONLY in the intake artefact (a real persist defect):
    // they must be promoted/resolved to the root, not lost.
    negativeKeywords: null,
    antiInferenceRules: null,

    intakeArtefact: {
      topicTerm: "AI governance",
      entityType: "Publicly-listed companies",
      sectorScope: "agnostic",
      universe: "MSCI ACWI",
      reportingPeriod: "last 3 years, most recent preferred",
      // Nested typed anchors — one duplicates a root JSON-encoded anchor (dedupe),
      // one is new and only present here (must be merged in).
      anchorFrameworks: [
        { name: "EU AI Act", source: "European Commission" },
        { name: "UN Global Compact", source: "United Nations" },
      ],
      negativeKeywords: ["marketing claim", "aspirational statement"],
      antiInferenceRules: [
        "Do not infer a board AI committee from a generic risk committee.",
      ],
      confirmed: true,
    },
  };

  const measures: Record<string, any>[] = [
    {
      // Volatile ids present — must be excluded from the resolved measure.
      id: 90001,
      frameworkId: 4242,
      measureId: "AIG-1",
      displayOrder: 1,
      category: "Governance",
      title: "Board oversight of AI",
      definition: "The board has explicit oversight of AI risk.",
      // camelCase named surface — must normalise to snake_case counterpart too.
      substantiveDefinition: "A named board committee reviews AI risk quarterly.",
      // snake_case named surface — must normalise consistently.
      fallback_yes_criterion: "A board charter references AI risk oversight.",
      whatConstitutesEvidence: "Charter text naming AI risk oversight.",
      scoringGuidance: "YES only with a named committee AND cadence.",
      // Per-measure evidence keywords — a DISTINCT surface from the framework one.
      evidenceKeywords: ["board AI committee", "AI risk charter"],
      requiredSourceTypes: ["proxy statement"],
    },
    {
      id: 90002,
      frameworkId: 4242,
      measureId: "AIG-2",
      displayOrder: 2,
      category: "Strategy",
      title: "AI strategy disclosure",
      definition: "The entity discloses an AI strategy.",
      substantiveDefinition: "A forward-looking AI strategy with objectives.",
      fallbackYesCriterion: "A stated intent to adopt AI responsibly.",
      whatConstitutesEvidence: "A dedicated AI strategy section.",
      scoringGuidance: "YES with concrete objectives; NO for boilerplate.",
      evidenceKeywords: ["AI roadmap", "responsible AI strategy"],
      requiredSourceTypes: ["annual report"],
    },
  ];

  return { framework, measures };
}

test("original in-memory framework equals reconstruction after export→import (full deep equality)", () => {
  const { framework, measures } = buildRepresentativeFramework();

  // 1. The canonical operational object for the ORIGINAL in-memory framework.
  const originalResolved = resolveConfig({ framework, measures });

  // 2. Canonical JSON export (now reads from the resolved config internally).
  const payload = buildFrameworkExport(framework, measures);

  // 3. Import path → DB insert shapes for a new framework in a workspace.
  //    existingNames=[] so the name is preserved verbatim (no " (imported)" suffix).
  const inserts = buildFrameworkInserts(payload, 999, []);

  // 4. Reconstruct the operational object from the imported framework + measures.
  const reconstructedResolved = resolveConfig({
    framework: inserts.framework as Record<string, any>,
    measures: inserts.measures as Record<string, any>[],
  });

  // 5. DEEP EQUALITY over ALL operational fields. This MUST fail if any field is
  //    lost or mutated across the round-trip. Do not weaken this assertion.
  assert.deepEqual(reconstructedResolved, originalResolved);
});

test("round-trip preserves the tricky cases explicitly (documents what the deepEqual guards)", () => {
  const { framework, measures } = buildRepresentativeFramework();
  const payload = buildFrameworkExport(framework, measures);
  const inserts = buildFrameworkInserts(payload, 999, []);
  const resolved = resolveConfig({
    framework: inserts.framework as Record<string, any>,
    measures: inserts.measures as Record<string, any>[],
  });

  // Anchors: JSON-encoded strings are parsed (NOT double-wrapped), plain labels
  // coerced, nested typed anchors merged, duplicates deduped by name.
  const anchorNames = resolved.anchorFrameworks.map((a) => a.name);
  assert.deepEqual(anchorNames, [
    "OECD AI Principles",
    "EU AI Act",
    "NIST AI RMF",
    "ISO/IEC 42001",
    "UN Global Compact",
  ]);
  const euAiAct = resolved.anchorFrameworks.find((a) => a.name === "EU AI Act");
  assert.equal(euAiAct?.source, "European Commission");
  // No anchor name is a raw JSON blob (would indicate double-wrapping).
  for (const a of resolved.anchorFrameworks) {
    assert.equal(a.name.trim().startsWith("{"), false);
  }

  // Scope carried from the nested intake artefact up to the root.
  assert.equal(resolved.entityType, "Publicly-listed companies");
  assert.equal(resolved.sectorScope, "agnostic");
  assert.equal(resolved.universe, "MSCI ACWI");
  assert.equal(resolved.reportingPeriod, "last 3 years, most recent preferred");

  // Distinct lexicon surfaces survive and are NOT collapsed into one another.
  assert.deepEqual(resolved.topicSynonyms, [
    "artificial intelligence governance",
    "AI oversight",
  ]);
  assert.deepEqual(resolved.evidenceKeywords, [
    "board oversight of AI",
    "AI policy",
    "model risk",
  ]);
  assert.deepEqual(resolved.documentFilingHints, [
    "10-K",
    "proxy statement",
    "sustainability report",
  ]);
  assert.deepEqual(resolved.negativeKeywords, [
    "marketing claim",
    "aspirational statement",
  ]);

  // Stable logical ids preserved; volatile DB-surrogate ids excluded.
  assert.deepEqual(
    resolved.measures.map((m) => m.measureId),
    ["AIG-1", "AIG-2"],
  );
  for (const m of resolved.measures) {
    assert.equal("id" in m, false);
    assert.equal("frameworkId" in m, false);
  }
  // Per-measure evidence keywords remain a distinct surface.
  assert.deepEqual(resolved.measures[0].evidenceKeywords, [
    "board AI committee",
    "AI risk charter",
  ]);
});
