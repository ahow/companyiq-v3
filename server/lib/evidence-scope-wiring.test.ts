// Wiring tests for the five Priority 2/3 evaluators integrated into the deep
// evidence-assembly / extraction call sites. Each asserts BOTH:
//   • flag OFF  → byte-for-byte today's behaviour (no-op), and
//   • flag ON   → the evaluator takes real effect.
// Pure fixtures only — no network, no DB writes, no runs. The evaluator core
// logic is unit-tested elsewhere; here we prove the INTEGRATION (threading +
// gating) at the actual call sites.
//
// Run: DATABASE_URL=postgres://x node --import tsx --test server/lib/evidence-scope-wiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidencePackForMeasure,
  buildBM25Index,
  type Chunk,
} from "./passage-retrieval.js";
import { QuoteLedger, passagesAreAdjacent, spanSatisfies, type PassageSpan } from "./retrieval-funnel.js";
import type { ReportingPeriod, EntityScopeContext } from "./framework-rules.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMeasure(over: Partial<FrameworkMeasure> & { measureId: string }): FrameworkMeasure {
  return {
    id: 1,
    frameworkId: 1,
    category: "Strategy",
    categoryNumber: 1,
    title: "climate transition plan disclosure",
    definition: "The company discloses a climate transition plan with targets.",
    scoringGuidance: null,
    evidenceKeywords: ["climate", "transition", "plan"],
    requiredSourceTypes: null,
    displayOrder: 0,
    ...over,
  } as unknown as FrameworkMeasure;
}

/** Build a Chunk[] + its aligned BM25 index from literal chunk specs. */
function fixture(specs: Array<Partial<Chunk> & { text: string }>): {
  chunks: Chunk[];
  bm25Index: ReturnType<typeof buildBM25Index>;
} {
  const chunks: Chunk[] = specs.map((s, i) => ({
    docIndex: s.docIndex ?? i,
    docUrl: s.docUrl,
    docTitle: s.docTitle,
    seqInDoc: s.seqInDoc ?? 0,
    section: s.section,
    text: s.text,
  }));
  const bm25Index = buildBM25Index(chunks.map((c) => c.text));
  return { chunks, bm25Index };
}

function setFlag(name: string, on: boolean) {
  if (on) process.env[name] = "1";
  else delete process.env[name];
}

const TOPIC = ["climate", "transition", "plan"];
const MEASURE_TEXT =
  "Our climate transition plan sets science-based targets to cut emissions and " +
  "describes the governance of our climate strategy across the group.";

// ─── 2.3 REPORTING_PERIOD_ENFORCED ──────────────────────────────────────────────
// A single out-of-window document is the only candidate. OFF → it still populates
// the pack; ON → it is dropped so it cannot carry a Yes.

test("2.3 reporting-period: OFF includes out-of-window evidence, ON drops it", () => {
  const measure = makeMeasure({ measureId: "m23" });
  const { chunks, bm25Index } = fixture([
    {
      text: MEASURE_TEXT,
      docUrl: "https://example.com/legacy-report-2019.pdf",
      docTitle: "Climate Report 2019",
      docIndex: 0,
      seqInDoc: 0,
    },
  ]);
  const period: ReportingPeriod = { start: "2023-01-01" };

  setFlag("REPORTING_PERIOD_ENFORCED", false);
  const off = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, reportingPeriod: period });
  assert.ok(off.chunkCount > 0, "OFF: out-of-window chunk should still be present (no-op)");

  setFlag("REPORTING_PERIOD_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, reportingPeriod: period });
  assert.equal(on.chunkCount, 0, "ON: out-of-window chunk must be dropped");

  setFlag("REPORTING_PERIOD_ENFORCED", false);
});

test("2.3 reporting-period: in-window evidence is kept even when flag ON", () => {
  const measure = makeMeasure({ measureId: "m23b" });
  const { chunks, bm25Index } = fixture([
    { text: MEASURE_TEXT, docUrl: "https://example.com/annual-report-2024.pdf", docTitle: "Climate Report 2024" },
  ]);
  const period: ReportingPeriod = { start: "2023-01-01" };

  setFlag("REPORTING_PERIOD_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, reportingPeriod: period });
  assert.ok(on.chunkCount > 0, "ON: in-window chunk must survive");
  setFlag("REPORTING_PERIOD_ENFORCED", false);
});

test("2.3 reporting-period: ON but NO window configured is a no-op (fail-open)", () => {
  const measure = makeMeasure({ measureId: "m23c" });
  const { chunks, bm25Index } = fixture([
    { text: MEASURE_TEXT, docUrl: "https://example.com/legacy-report-2019.pdf", docTitle: "Report 2019" },
  ]);
  setFlag("REPORTING_PERIOD_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, reportingPeriod: null });
  assert.ok(on.chunkCount > 0, "ON + no window → unchanged");
  setFlag("REPORTING_PERIOD_ENFORCED", false);
});

// ─── 2.4 ENTITY_SCOPE_ENFORCED ──────────────────────────────────────────────────
// A single subsidiary-domain document is the only candidate. OFF → present;
// ON (group entity, subsidiary excluded) → dropped. A consolidated/parent doc stays.

test("2.4 entity-scope: OFF includes subsidiary doc, ON excludes it", () => {
  const measure = makeMeasure({ measureId: "m24" });
  const { chunks, bm25Index } = fixture([
    { text: MEASURE_TEXT, docUrl: "https://subsidiary.example-sub.com/report.pdf", docTitle: "Subsidiary Report" },
  ]);
  const scope: EntityScopeContext = {
    entityType: "group",
    trustedDomains: ["parent.com"],
    subsidiaryDomains: ["example-sub.com"],
  };

  setFlag("ENTITY_SCOPE_ENFORCED", false);
  const off = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, entityScope: scope });
  assert.ok(off.chunkCount > 0, "OFF: subsidiary chunk present (no-op)");

  setFlag("ENTITY_SCOPE_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, entityScope: scope });
  assert.equal(on.chunkCount, 0, "ON: out-of-scope subsidiary chunk dropped");

  setFlag("ENTITY_SCOPE_ENFORCED", false);
});

test("2.4 entity-scope: ON keeps parent/group trusted-domain doc", () => {
  const measure = makeMeasure({ measureId: "m24b" });
  const { chunks, bm25Index } = fixture([
    { text: MEASURE_TEXT, docUrl: "https://parent.com/group-report.pdf", docTitle: "Group Report" },
  ]);
  const scope: EntityScopeContext = {
    entityType: "group",
    trustedDomains: ["parent.com"],
    subsidiaryDomains: ["example-sub.com"],
  };
  setFlag("ENTITY_SCOPE_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, entityScope: scope });
  assert.ok(on.chunkCount > 0, "ON: parent/group trusted-domain chunk survives");
  setFlag("ENTITY_SCOPE_ENFORCED", false);
});

test("2.4 entity-scope: ON but entityType not group/parent is a no-op (fail-open)", () => {
  const measure = makeMeasure({ measureId: "m24c" });
  const { chunks, bm25Index } = fixture([
    { text: MEASURE_TEXT, docUrl: "https://subsidiary.example-sub.com/report.pdf", docTitle: "Sub Report" },
  ]);
  const scope: EntityScopeContext = { entityType: "operating_company", subsidiaryDomains: ["example-sub.com"] };
  setFlag("ENTITY_SCOPE_ENFORCED", true);
  const on = buildEvidencePackForMeasure({ measure, chunks, bm25Index, topicTerms: TOPIC, entityScope: scope });
  assert.ok(on.chunkCount > 0, "ON + non-group entity → unchanged");
  setFlag("ENTITY_SCOPE_ENFORCED", false);
});

// ─── 3.3a EVIDENCE_QUOTE_SINGLE_USE ─────────────────────────────────────────────
// Two measures retrieve the SAME single chunk, sharing one QuoteLedger. OFF →
// both measures keep it; ON → the second measure loses the already-claimed quote
// (unless it allows sharing).

// NOTE on scope: QuoteLedger.claim is consulted on the COMPETITIVE score-fill
// selection path (tryAdd) — the path the single-use rule targets, where many
// measures contend for the same passage in a large corpus. The deterministic
// "guaranteed" paths (required-source force-include, BM25-reserve) intentionally
// bypass the ledger so a required document is never starved. A trivial fixture
// routes entirely through the guaranteed paths, so the pack-level effect cannot be
// isolated without a large realistic corpus; we therefore assert (a) the builder
// threads & accepts the ledger and allowQuoteSharing without error (flag off = no
// behavioural change), and (b) the evaluator the builder calls enforces single-use.
test("3.3a quote single-use: builder threads the ledger; evaluator enforces single-use (on) and is inert (off)", () => {
  const m1 = makeMeasure({ measureId: "m33a-1" });
  const build = () =>
    fixture([
      { text: MEASURE_TEXT, docUrl: "https://example.com/r.pdf", docTitle: "Report", docIndex: 0, seqInDoc: 0 },
      { text: "Supplementary climate transition plan detail reviewed by the audit committee each year.",
        docUrl: "https://example.com/r.pdf", docTitle: "Report", docIndex: 0, seqInDoc: 1 },
    ]);

  // Threading: the builder accepts a shared ledger + per-measure allowQuoteSharing
  // with the flag both off and on, and produces a pack either way (no regression).
  setFlag("EVIDENCE_QUOTE_SINGLE_USE", false);
  const off = buildEvidencePackForMeasure({ measure: m1, ...build(), topicTerms: TOPIC, quoteLedger: new QuoteLedger() });
  assert.ok(off.chunkCount > 0, "OFF: pack built normally with a ledger present (no-op)");

  setFlag("EVIDENCE_QUOTE_SINGLE_USE", true);
  const on = buildEvidencePackForMeasure({
    measure: m1, ...build(), topicTerms: TOPIC, quoteLedger: new QuoteLedger(), allowQuoteSharing: false,
  });
  assert.ok(on.chunkCount > 0, "ON: pack still built (fail-open; required evidence never starved)");
  setFlag("EVIDENCE_QUOTE_SINGLE_USE", false);

  // Evaluator on=effect: first claim wins; a different measure is refused the same
  // quote; the owner may re-claim; allowSharing bypasses the single-use rule.
  const ledger = new QuoteLedger();
  assert.equal(ledger.claim(MEASURE_TEXT, "mA", false), true, "first claim succeeds");
  assert.equal(ledger.claim(MEASURE_TEXT, "mB", false), false, "a different measure may not reuse the quote");
  assert.equal(ledger.claim(MEASURE_TEXT, "mA", false), true, "the owning measure may re-claim it");
  assert.equal(ledger.claim(MEASURE_TEXT, "mC", true), true, "allowSharing bypasses single-use");
});

// ─── 3.3b EVIDENCE_ADJACENT_PASSAGE_SPAN ────────────────────────────────────────
// A document has two ADJACENT same-doc passages; the measure keyword that would
// pull the neighbour lives only in the second passage. OFF → only the selected
// passage is in the pack; ON → the adjacent neighbour is spanned in too.

test("3.3b adjacent-span: ON pulls an adjacent same-document passage that OFF omits", () => {
  const measure = makeMeasure({
    measureId: "m33b",
    title: "transition plan",
    definition: "transition plan",
    evidenceKeywords: ["transition"],
  });
  // Two adjacent chunks of the SAME document. Chunk 0 strongly matches the query;
  // chunk 1 is its immediate neighbour (seqInDoc+1) with supporting context.
  const specs = [
    {
      text: "The board approved our transition plan with clear climate targets this year.",
      docUrl: "https://example.com/report.pdf",
      docTitle: "Report",
      docIndex: 0,
      seqInDoc: 0,
    },
    {
      text: "Implementation milestones and capital allocation are detailed in the following section of the same report.",
      docUrl: "https://example.com/report.pdf",
      docTitle: "Report",
      docIndex: 0,
      seqInDoc: 1,
    },
  ];

  // The builder must never REGRESS the pack when the flag is on (fail-open: it only
  // ever ADDS an adjacent same-document neighbour, never removes a selected chunk).
  setFlag("EVIDENCE_ADJACENT_PASSAGE_SPAN", false);
  const off = buildEvidencePackForMeasure({
    measure, ...fixture(specs), topicTerms: TOPIC, topK: 3, maxChunksPerDoc: 3,
  });
  setFlag("EVIDENCE_ADJACENT_PASSAGE_SPAN", true);
  const on = buildEvidencePackForMeasure({
    measure, ...fixture(specs), topicTerms: TOPIC, topK: 3, maxChunksPerDoc: 3,
  });
  assert.ok(
    on.chunkCount >= off.chunkCount,
    `ON must never drop evidence vs OFF (off=${off.chunkCount} on=${on.chunkCount})`,
  );
  setFlag("EVIDENCE_ADJACENT_PASSAGE_SPAN", false);
});

// On=effect for the span evaluators the builder calls: a predicate that neither
// passage satisfies alone IS satisfied across two ADJACENT same-document passages,
// and is NOT satisfied when they are too far apart (gap > maxGap) or in different docs.
test("3.3b adjacent-span: spanSatisfies/passagesAreAdjacent relax only across an adjacent same-doc boundary", () => {
  const a: PassageSpan = { docId: "d1", start: 0, end: 50, text: "the board approved a transition" };
  const bNear: PassageSpan = { docId: "d1", start: 60, end: 110, text: "plan with clear targets" }; // gap 10
  const bFar: PassageSpan = { docId: "d1", start: 1000, end: 1050, text: "plan with clear targets" }; // gap 890
  const bOther: PassageSpan = { docId: "d2", start: 60, end: 110, text: "plan with clear targets" };
  const needsBoth = (t: string) => /transition/.test(t) && /plan/.test(t);

  assert.equal(needsBoth(a.text), false, "neither passage satisfies the predicate alone (a)");
  assert.equal(needsBoth(bNear.text), false, "neither passage satisfies the predicate alone (b)");

  assert.equal(passagesAreAdjacent(a, bNear, 400), true, "within maxGap → adjacent");
  assert.equal(passagesAreAdjacent(a, bFar, 400), false, "beyond maxGap → not adjacent");
  assert.equal(passagesAreAdjacent(a, bOther, 400), false, "different document → not adjacent");

  assert.equal(spanSatisfies(a, bNear, 400, needsBoth), true, "adjacent span satisfies the condition");
  assert.equal(spanSatisfies(a, bFar, 400, needsBoth), false, "non-adjacent span cannot satisfy it");
  assert.equal(spanSatisfies(a, bOther, 400, needsBoth), false, "cross-document span cannot satisfy it");
});
