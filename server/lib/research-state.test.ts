// WP02 / A1 — research-state accounting tests (CV01–CV07).
//
// Run with:  npx tsx --test server/lib/research-state.test.ts
//
// These lock the correctness guarantees of the research-state layer:
//   CV01 first-party timeout → INCOMPLETE, not an unqualified substantive "No"
//   CV02 excluded third-party does NOT inflate the essential-gap count
//   CV03 pre-fetch cancellation stays RETRYABLE (not conclusive absence)
//   CV04 cached corpus missing a newer eligible doc → freshness gap
//   CV05 equivalent copy satisfies the version; a wrong-year copy does not
//   CV06 truncated extraction → dependent family unresolved (not comprehensive)
//   CV07 API / UI / CSV / export render the SAME research status
//
// The layer is pure derivation: no score/verdict is read or produced here, so
// these also implicitly document that completeness accounting is additive.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDocument,
  isRetryable,
  isConclusiveAbsence,
  isRetrieved,
  buildManifest,
  computeEssentialGaps,
  deriveResearchStatus,
  summarizeResearchStatus,
  researchStatusCsvColumns,
  deriveEssentialDocChecklist,
  summarizeEssentialChecklist,
  isLowScoreCompany,
  LOW_SCORE_ESSENTIAL_THRESHOLD,
  type GapDocument,
  type ResearchScopeManifest,
} from "../../shared/research-state.js";

// A manifest whose single essential family is a first-party primary disclosure.
const baseManifest: ResearchScopeManifest = buildManifest({ entityBoundary: "ACME plc" });

// ─── CV01: first-party timeout → incomplete, not unqualified No ───────────────
test("CV01 first-party timeout classifies as transient/retryable, status incomplete", () => {
  const doc: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "dead",
    failureReason: "timeout",
  };
  const state = classifyDocument(doc);
  assert.equal(state, "transient_unavailable");
  assert.equal(isRetryable(state), true, "timeout must be retryable");
  assert.equal(isConclusiveAbsence(state), false, "timeout is NOT a conclusive absence");

  const rs = deriveResearchStatus({ documents: [doc], manifest: baseManifest });
  assert.equal(rs.comprehensive, false, "a timed-out essential source cannot be comprehensive");
  assert.equal(rs.state, "incomplete", "retryable gap → incomplete (not unresolved_gaps)");
  assert.equal(rs.retryableGaps.length, 1);
  assert.equal(rs.coverage.retryable, 1);
  assert.equal(rs.coverage.conclusivelyAbsent, 0, "must NOT be counted as a conclusive absence");
});

// ─── CV02: excluded third-party does NOT inflate the gap count ────────────────
test("CV02 excluded third-party does not inflate essential-gap count", () => {
  const satisfied: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "ok",
    extractionState: "complete",
  };
  const excludedThirdParty: GapDocument = {
    sourceType: "third_party",
    gateVerdict: "reject",
    gateReason: "policy-excluded aggregator",
    fetchStatus: "ok",
    extractionState: "complete",
  };

  const gapsWithout = computeEssentialGaps([satisfied], baseManifest);
  const gapsWith = computeEssentialGaps([satisfied, excludedThirdParty], baseManifest);
  assert.equal(gapsWithout.length, 0, "satisfied family → no gap");
  assert.deepEqual(gapsWith, gapsWithout, "adding an excluded third-party doc must not change gaps");

  // And the excluded doc is reported as excluded, never as a satisfying source.
  const rs = deriveResearchStatus({ documents: [satisfied, excludedThirdParty], manifest: baseManifest });
  assert.equal(rs.comprehensive, true);
  assert.equal(rs.coverage.excluded, 1, "excluded doc is surfaced, not hidden");
  assert.equal(classifyDocument(excludedThirdParty), "excluded_with_reason");
});

// A policy-excluded aggregator must NOT substitute for a missing primary disclosure.
test("CV02b excluded aggregator does not substitute for a missing primary disclosure", () => {
  const onlyExcluded: GapDocument = {
    sourceType: "third_party",
    gateVerdict: "reject",
    fetchStatus: "ok",
    extractionState: "complete",
  };
  const rs = deriveResearchStatus({ documents: [onlyExcluded], manifest: baseManifest });
  assert.equal(rs.comprehensive, false, "excluded aggregator cannot satisfy an essential family");
  assert.equal(rs.unresolvedEssentialGaps.length, 1);
  assert.equal(rs.unresolvedEssentialGaps[0].kind, "absent");
});

// ─── CV03: pre-fetch cancellation stays retryable ────────────────────────────
test("CV03 pre-fetch cancellation is retryable, never a conclusive absence", () => {
  const doc: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "pending",
    failureReason: "not_attempted_cancelled",
  };
  const state = classifyDocument(doc);
  assert.equal(state, "not_attempted_cancelled");
  assert.equal(isRetryable(state), true);
  assert.equal(isConclusiveAbsence(state), false);

  const rs = deriveResearchStatus({ documents: [doc], manifest: baseManifest });
  assert.equal(rs.comprehensive, false);
  assert.equal(rs.state, "incomplete", "cancelled-before-fetch is retryable → incomplete");
  assert.equal(rs.retryableGaps.length, 1);
  assert.equal(rs.unresolvedEssentialGaps[0].kind, "unretrieved");
});

// ─── CV04: cached corpus missing a newer eligible doc → freshness gap ─────────
test("CV04 cached corpus missing the required newer version → freshness gap", () => {
  const manifest = buildManifest({
    entityBoundary: "ACME plc",
    essentialFamilies: [
      {
        id: "annual_report",
        label: "Annual report",
        requiredVersion: { entity: "ACME plc", version: "annual-report", date: "2024" },
      },
    ],
  });
  const staleDoc: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "ok",
    extractionState: "complete",
    version: { entity: "ACME plc", version: "annual-report", date: "2023" }, // older
  };
  const rs = deriveResearchStatus({ documents: [staleDoc], manifest });
  assert.equal(rs.comprehensive, false, "only an older copy is present → not comprehensive");
  assert.equal(rs.unresolvedEssentialGaps.length, 1);
  assert.equal(rs.unresolvedEssentialGaps[0].kind, "stale");
});

// ─── CV05: equivalent copy satisfies version; wrong-year does not ─────────────
test("CV05 equivalent copy satisfies the version; a wrong-year copy does not", () => {
  const manifest = buildManifest({
    entityBoundary: "ACME plc",
    essentialFamilies: [
      {
        id: "annual_report",
        label: "Annual report",
        requiredVersion: { entity: "ACME plc", version: "annual-report", date: "2024" },
      },
    ],
  });
  const equivalentCopy: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "ok",
    extractionState: "complete",
    version: { entity: "ACME plc", version: "annual-report", date: "2024" }, // matches
  };
  const wrongYear: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "ok",
    extractionState: "complete",
    version: { entity: "ACME plc", version: "annual-report", date: "2022" },
  };

  const okRs = deriveResearchStatus({ documents: [equivalentCopy], manifest });
  assert.equal(okRs.comprehensive, true, "entity+version+date match → satisfied");
  assert.equal(computeEssentialGaps([equivalentCopy], manifest).length, 0);

  const badRs = deriveResearchStatus({ documents: [wrongYear], manifest });
  assert.equal(badRs.comprehensive, false, "wrong-year copy must NOT satisfy the version");
  assert.equal(badRs.unresolvedEssentialGaps[0].kind, "stale");
});

// ─── CV06: truncated extraction → dependent family unresolved ─────────────────
test("CV06 truncated extraction leaves the dependent family unresolved", () => {
  const partialDoc: GapDocument = {
    sourceType: "first_party",
    gateVerdict: "accept",
    fetchStatus: "ok",
    extractionState: "partial", // truncated
  };
  assert.equal(classifyDocument(partialDoc), "extracted_partial");
  assert.equal(isRetrieved(classifyDocument(partialDoc)), true, "partial still holds some content");

  const rs = deriveResearchStatus({ documents: [partialDoc], manifest: baseManifest });
  assert.equal(rs.comprehensive, false, "a partial extraction cannot make the family comprehensive");
  assert.equal(rs.unresolvedEssentialGaps.length, 1);
  assert.equal(rs.unresolvedEssentialGaps[0].kind, "partial");
  assert.equal(rs.unresolvedEssentialGaps[0].retryable, true);

  // A fully-extracted copy of the same family DOES resolve it.
  const completeDoc: GapDocument = { ...partialDoc, extractionState: "complete" };
  const rs2 = deriveResearchStatus({ documents: [partialDoc, completeDoc], manifest: baseManifest });
  assert.equal(rs2.comprehensive, true, "a complete copy resolves the family");
});

// ─── CV07: API / UI / CSV / export render the SAME status ─────────────────────
test("CV07 every reader renders the same research status", () => {
  const docs: GapDocument[] = [
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "dead", failureReason: "timeout" },
  ];
  const rs = deriveResearchStatus({ documents: docs, manifest: baseManifest });

  // The UI label and the CSV's "Research Status" column come from the SAME
  // summariser, so they are identical by construction.
  const uiLabel = summarizeResearchStatus(rs);
  const csvCols = researchStatusCsvColumns(rs);
  const csvStatus = csvCols.find((c) => c.header === "Research Status")?.value;
  assert.equal(csvStatus, uiLabel, "CSV status column must equal the UI label");

  // The "Comprehensive" flag is consistent across representations.
  const csvComprehensive = csvCols.find((c) => c.header === "Comprehensive")?.value;
  assert.equal(csvComprehensive, rs.comprehensive ? "Yes" : "No");
  assert.equal(rs.comprehensive, false);

  // The share/export path streams the whole researchStatus object verbatim, so a
  // round-trip through JSON (what the full export does) preserves it exactly.
  const roundTripped = JSON.parse(JSON.stringify(rs));
  assert.equal(summarizeResearchStatus(roundTripped), uiLabel);
  assert.deepEqual(roundTripped.unresolvedEssentialGaps, rs.unresolvedEssentialGaps);

  // Column headers are stable even without data (header row built from null).
  const headerOnly = researchStatusCsvColumns(null).map((c) => c.header);
  assert.deepEqual(headerOnly, csvCols.map((c) => c.header));
});

// ═══ Issue 5 — essential-document checklist (part 2) ══════════════════════════

const checklistDocTypes = ["Annual Report", "Sustainability Report", "Responsible AI Policy"];

// Build a manifest carrying the framework's declared required doc types.
const checklistManifest: ResearchScopeManifest = buildManifest({
  entityBoundary: "ACME plc",
  requiredDocTypes: checklistDocTypes,
});

test("I5.1 extraction_state complete/partial/empty/null map to the right research state", () => {
  const base: GapDocument = { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok" };
  assert.equal(classifyDocument({ ...base, extractionState: "complete" }), "extracted_complete");
  assert.equal(classifyDocument({ ...base, extractionState: "partial" }), "extracted_partial");
  // "empty" and null are completeness-unknown content → conservative "retrieved".
  assert.equal(classifyDocument({ ...base, extractionState: "empty" }), "retrieved");
  assert.equal(classifyDocument({ ...base, extractionState: null }), "retrieved");
});

test("I5.2 checklist marks a framework doc type found / partial / not found", () => {
  const docs: GapDocument[] = [
    // Annual report: fully extracted → found
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete",
      title: "ACME Annual Report 2024", url: "https://acme.example/annual-report-2024.pdf" },
    // Sustainability report: only partial extraction → partial
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "partial",
      title: "ACME Sustainability Report", url: "https://acme.example/sustainability.pdf" },
    // No AI policy doc at all → not_found
  ];
  const checklist = deriveEssentialDocChecklist(docs, checklistDocTypes);
  assert.equal(checklist.length, 3);
  const byType = Object.fromEntries(checklist.map((i) => [i.docType, i.status]));
  assert.equal(byType["Annual Report"], "found");
  assert.equal(byType["Sustainability Report"], "partial");
  assert.equal(byType["Responsible AI Policy"], "not_found");
});

test("I5.3 a timed-out/failed essential doc that matched is not_found (never counted as obtained)", () => {
  const docs: GapDocument[] = [
    // Annual report fetch timed out — matched by title but never retrieved.
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "dead", failureReason: "timeout",
      title: "ACME Annual Report 2024", url: "https://acme.example/annual.pdf" },
    // A conclusively-absent sustainability report (404).
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "dead", failureReason: "not_found_404",
      title: "Sustainability Report 2024", url: "https://acme.example/sustainability-report.pdf" },
  ];
  const checklist = deriveEssentialDocChecklist(docs, checklistDocTypes);
  const byType = Object.fromEntries(checklist.map((i) => [i.docType, i]));
  assert.equal(byType["Annual Report"].status, "not_found");
  assert.match(byType["Annual Report"].detail, /retryable/);
  assert.equal(byType["Sustainability Report"].status, "not_found");
  assert.match(byType["Sustainability Report"].detail, /conclusively absent/);
});

test("I5.4 only first-party, non-excluded docs can satisfy a checklist item", () => {
  const docs: GapDocument[] = [
    // A third-party article titled like an annual report must NOT satisfy it.
    { sourceType: "third_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete",
      title: "Analysis of ACME Annual Report", url: "https://news.example/acme-annual-report" },
    // An excluded first-party doc must NOT satisfy it either.
    { sourceType: "first_party", gateVerdict: "reject", fetchStatus: "ok", extractionState: "complete",
      title: "ACME Sustainability Report", url: "https://acme.example/sustainability-report.pdf" },
  ];
  const checklist = deriveEssentialDocChecklist(docs, ["Annual Report", "Sustainability Report"]);
  const byType = Object.fromEntries(checklist.map((i) => [i.docType, i.status]));
  assert.equal(byType["Annual Report"], "not_found", "third-party cannot satisfy");
  assert.equal(byType["Sustainability Report"], "not_found", "gate-rejected cannot satisfy");
});

test("I5.5 checklist is empty and framework-level when no required doc types are declared", () => {
  // No hardcoded fallback list: an empty/absent requiredDocTypes yields no checklist.
  assert.deepEqual(deriveEssentialDocChecklist([], []), []);
  assert.deepEqual(deriveEssentialDocChecklist([], null), []);
  assert.deepEqual(deriveEssentialDocChecklist([], undefined), []);
  // deriveResearchStatus with the base manifest (no requiredDocTypes) → empty checklist.
  const rs = deriveResearchStatus({ documents: [], manifest: baseManifest });
  assert.deepEqual(rs.essentialChecklist, []);
});

test("I5.6 deriveResearchStatus attaches the checklist from the manifest's requiredDocTypes", () => {
  const docs: GapDocument[] = [
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete",
      title: "Annual Report 2024", url: "https://acme.example/annual-report.pdf" },
  ];
  const rs = deriveResearchStatus({ documents: docs, manifest: checklistManifest });
  const checklist = rs.essentialChecklist ?? [];
  assert.equal(checklist.length, 3);
  assert.equal(checklist.find((i) => i.docType === "Annual Report")?.status, "found");
  // Checklist is additive — it does not alter the comprehensive/gap semantics.
  const rsNoDocTypes = deriveResearchStatus({ documents: docs, manifest: baseManifest });
  assert.equal(rs.comprehensive, rsNoDocTypes.comprehensive);
  assert.deepEqual(rs.unresolvedEssentialGaps, rsNoDocTypes.unresolvedEssentialGaps);
});

test("I5.7 low-score gating: metCount <= threshold surfaces the checklist", () => {
  assert.equal(LOW_SCORE_ESSENTIAL_THRESHOLD, 2);
  assert.equal(isLowScoreCompany(0), true);
  assert.equal(isLowScoreCompany(2), true);
  assert.equal(isLowScoreCompany(3), false);
  assert.equal(isLowScoreCompany(null), false);
  assert.equal(isLowScoreCompany(undefined), false);
});

test("I5.8 checklist + missing-docs appear in the CSV columns (naming the missing documents)", () => {
  const docs: GapDocument[] = [
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete",
      title: "Annual Report 2024", url: "https://acme.example/annual-report.pdf" },
    // Sustainability + AI policy missing.
  ];
  const rs = deriveResearchStatus({ documents: docs, manifest: checklistManifest });
  const cols = researchStatusCsvColumns(rs);
  const checklistCol = cols.find((c) => c.header === "Essential Document Checklist")?.value || "";
  const missingCol = cols.find((c) => c.header === "Missing Essential Documents")?.value || "";
  assert.match(checklistCol, /Annual Report: found/);
  assert.match(missingCol, /Sustainability Report \(not found\)/);
  assert.match(missingCol, /Responsible AI Policy \(not found\)/);
  // Header stability (null → same headers as populated).
  assert.deepEqual(researchStatusCsvColumns(null).map((c) => c.header), cols.map((c) => c.header));
});

test("I5.9 summarizeEssentialChecklist renders 'not found' label", () => {
  const items = deriveEssentialDocChecklist(
    [{ sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete",
       title: "Annual Report", url: "https://acme.example/annual-report.pdf" }],
    ["Annual Report", "Sustainability Report"],
  );
  const summary = summarizeEssentialChecklist(items);
  assert.match(summary, /Annual Report: found/);
  assert.match(summary, /Sustainability Report: not found/);
  assert.equal(summarizeEssentialChecklist([]), "");
});

// ─── Additive guarantee: derivation never mutates its inputs ──────────────────
test("research-state derivation does not mutate the documents it reads", () => {
  const docs: GapDocument[] = [
    { sourceType: "first_party", gateVerdict: "accept", fetchStatus: "ok", extractionState: "complete" },
  ];
  const before = JSON.stringify(docs);
  deriveResearchStatus({ documents: docs, manifest: baseManifest });
  assert.equal(JSON.stringify(docs), before, "inputs must be untouched (pure derivation)");
});
