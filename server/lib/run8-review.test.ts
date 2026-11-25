import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePhysicalHazardGate,
  matchesPhysicalHazardTrack,
  evidenceHasPhysicalHazardTerm,
  withSelfConsistencyVoteInTrace,
  readSelfConsistencyVoteFromTrace,
  quoteTokenOverlap,
  scoringPhysicalHazardTermRequiredEnabled,
  frameworkScoringCapabilityEnabled,
  PHYSICAL_HAZARD_TERM_REQUIRED_CAPABILITY,
  decideTopicTermGate,
  frameworkTopicTerms,
  scoringTopicTermRequiredEnabled,
  evidenceHasAnyTerm,
  TOPIC_TERM_REQUIRED_CAPABILITY,
  // FW25 Track A — FIX 1–4 helpers
  parseMeasureTrack,
  frameworkRequiredForTracks,
  measureTrackGated,
  measureIsTrackGated,
  frameworkPerCompanyDocCap,
  buildPinnedUrlsForRun,
  mergeAutoPins,
  getFrameworkAutoPins,
  frameworkRecencyWindowYears,
  extractCitedSourceYear,
  decideRecencyWindowGate,
  resolvePerCompanyList,
  frameworkRelatedListedCompanies,
  frameworkSubsidiaryDomains,
  relatedListedGateEnabled,
  decideRelatedListedExclusion,
} from "./scoring-fix-flags.js";
import { QuoteLedger } from "./retrieval-funnel.js";
import { classifiedCoverageComprehensive } from "../../shared/research-state.js";
import { recognizePdfPayload } from "./processor.js";

// ── CHANGE 5 — SCORING_PHYSICAL_HAZARD_TERM_REQUIRED ─────────────────────────
test("decidePhysicalHazardGate: flag off never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: false, isPhysicalTrack: true, verdict: "Yes", evidenceText: "climate-related disclosures" });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "flag-off");
});

test("decidePhysicalHazardGate: non-physical track never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: false, verdict: "Yes", evidenceText: "flood risk" });
  assert.equal(r.downgrade, false);
});

test("decidePhysicalHazardGate: non-Yes verdict never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "No", evidenceText: "nothing" });
  assert.equal(r.downgrade, false);
});

test("decidePhysicalHazardGate: Yes with a concrete hazard term stays", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "Yes", evidenceText: "The company assessed flood and heatwave exposure." });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "physical-hazard-term-present");
});

test("decidePhysicalHazardGate: Yes with only 'climate-related' is downgraded", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "Yes", evidenceText: "We discuss climate-related matters generally." });
  assert.equal(r.downgrade, true);
  assert.equal(r.reason, "physical-hazard-term-missing");
});

test("matchesPhysicalHazardTrack / evidenceHasPhysicalHazardTerm basics", () => {
  assert.equal(matchesPhysicalHazardTrack(["physical_climate", null]), true);
  assert.equal(matchesPhysicalHazardTrack(["governance", undefined]), false);
  assert.equal(evidenceHasPhysicalHazardTerm("exposure to drought and wildfire"), true);
  assert.equal(evidenceHasPhysicalHazardTerm("climate-related only"), false);
});

// ── Framework-scoped physical-hazard capability (env OR per-framework data) ──
// The capability must resolve ON when EITHER the global env flag is set OR the
// framework's stored scoringFlags map opts in — otherwise OFF. No framework id or
// name is referenced; the per-framework switch is pure data.

test("frameworkScoringCapabilityEnabled: reads boolean from scoringFlags map", () => {
  const key = PHYSICAL_HAZARD_TERM_REQUIRED_CAPABILITY;
  assert.equal(frameworkScoringCapabilityEnabled({ scoringFlags: { [key]: true } }, key), true);
  assert.equal(frameworkScoringCapabilityEnabled({ scoringFlags: { [key]: false } }, key), false);
  assert.equal(frameworkScoringCapabilityEnabled({ scoringFlags: {} }, key), false);
  assert.equal(frameworkScoringCapabilityEnabled({}, key), false);
  assert.equal(frameworkScoringCapabilityEnabled(null, key), false);
  assert.equal(frameworkScoringCapabilityEnabled({ scoringFlags: { [key]: 1 as any } }, key), false);
});

test("scoringPhysicalHazardTermRequiredEnabled: (a) global env ON enables it for ANY framework", () => {
  const prev = process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
  process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED = "true";
  try {
    // enabled regardless of (and even without) a per-framework map
    assert.equal(scoringPhysicalHazardTermRequiredEnabled(), true);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled({}), true);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled({ scoringFlags: {} }), true);
  } finally {
    if (prev === undefined) delete process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
    else process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED = prev;
  }
});

test("scoringPhysicalHazardTermRequiredEnabled: (b) env OFF + framework opts in => ON for that framework only", () => {
  const prev = process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
  delete process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
  try {
    const optedIn = { scoringFlags: { [PHYSICAL_HAZARD_TERM_REQUIRED_CAPABILITY]: true } };
    const other = { scoringFlags: { [PHYSICAL_HAZARD_TERM_REQUIRED_CAPABILITY]: false } };
    assert.equal(scoringPhysicalHazardTermRequiredEnabled(optedIn), true);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled(other), false);
  } finally {
    if (prev !== undefined) process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED = prev;
  }
});

test("scoringPhysicalHazardTermRequiredEnabled: (c) env OFF + framework without the field => OFF", () => {
  const prev = process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
  delete process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED;
  try {
    assert.equal(scoringPhysicalHazardTermRequiredEnabled(), false);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled({}), false);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled({ scoringFlags: {} }), false);
    assert.equal(scoringPhysicalHazardTermRequiredEnabled({ name: "whatever" }), false);
  } finally {
    if (prev !== undefined) process.env.SCORING_PHYSICAL_HAZARD_TERM_REQUIRED = prev;
  }
});

// ── GENERIC TOPIC-TERM GATE (SCORING_TOPIC_TERM_REQUIRED / topicTermRequired) ─
// The framework-agnostic analogue of the physical-hazard gate. Capability is OFF
// by default, enabled by EITHER the global env flag OR a per-framework
// scoringFlags.topicTermRequired, and the required vocabulary is derived from the
// framework's OWN topic fields. No topic word, framework id, or name is hardcoded.

test("scoringTopicTermRequiredEnabled: OFF by default (no env, no framework flag)", () => {
  const prev = process.env.SCORING_TOPIC_TERM_REQUIRED;
  delete process.env.SCORING_TOPIC_TERM_REQUIRED;
  try {
    assert.equal(scoringTopicTermRequiredEnabled(), false);
    assert.equal(scoringTopicTermRequiredEnabled({}), false);
    assert.equal(scoringTopicTermRequiredEnabled({ scoringFlags: {} }), false);
    assert.equal(scoringTopicTermRequiredEnabled({ name: "whatever" }), false);
  } finally {
    if (prev !== undefined) process.env.SCORING_TOPIC_TERM_REQUIRED = prev;
  }
});

test("scoringTopicTermRequiredEnabled: (a) global env ON enables it for ANY framework", () => {
  const prev = process.env.SCORING_TOPIC_TERM_REQUIRED;
  process.env.SCORING_TOPIC_TERM_REQUIRED = "true";
  try {
    assert.equal(scoringTopicTermRequiredEnabled(), true);
    assert.equal(scoringTopicTermRequiredEnabled({}), true);
    assert.equal(scoringTopicTermRequiredEnabled({ scoringFlags: {} }), true);
  } finally {
    if (prev === undefined) delete process.env.SCORING_TOPIC_TERM_REQUIRED;
    else process.env.SCORING_TOPIC_TERM_REQUIRED = prev;
  }
});

test("scoringTopicTermRequiredEnabled: (b) env OFF + framework opts in => ON for that framework only", () => {
  const prev = process.env.SCORING_TOPIC_TERM_REQUIRED;
  delete process.env.SCORING_TOPIC_TERM_REQUIRED;
  try {
    const optedIn = { scoringFlags: { [TOPIC_TERM_REQUIRED_CAPABILITY]: true } };
    const other = { scoringFlags: { [TOPIC_TERM_REQUIRED_CAPABILITY]: false } };
    assert.equal(scoringTopicTermRequiredEnabled(optedIn), true);
    assert.equal(scoringTopicTermRequiredEnabled(other), false);
    // A different framework with no flag at all stays OFF — proves per-framework scoping.
    assert.equal(scoringTopicTermRequiredEnabled({ scoringFlags: {} }), false);
  } finally {
    if (prev !== undefined) process.env.SCORING_TOPIC_TERM_REQUIRED = prev;
  }
});

test("frameworkTopicTerms: derives + normalises from the framework's own topic fields", () => {
  const prev = process.env.SCORING_TOPIC_TERMS;
  delete process.env.SCORING_TOPIC_TERMS;
  try {
    const terms = frameworkTopicTerms({
      topicTerm: "Biodiversity",
      topicSynonyms: ["Nature loss", "  ecosystem  ", "Biodiversity"],
      retrievalQueryTerms: ["habitat restoration", ""],
      adjacentTopics: [
        { name: "Deforestation", example_phrases: ["forest clearing", "Nature loss"] },
        "Rewilding",
      ],
    });
    // lowercased + trimmed + de-duplicated across every field/shape
    assert.ok(terms.includes("biodiversity"));
    assert.ok(terms.includes("nature loss"));
    assert.ok(terms.includes("ecosystem"));
    assert.ok(terms.includes("habitat restoration"));
    assert.ok(terms.includes("deforestation"));
    assert.ok(terms.includes("forest clearing"));
    assert.ok(terms.includes("rewilding"));
    // no empties, no dupes
    assert.ok(!terms.includes(""));
    assert.equal(terms.filter((t) => t === "biodiversity").length, 1);
    assert.equal(terms.filter((t) => t === "nature loss").length, 1);
  } finally {
    if (prev !== undefined) process.env.SCORING_TOPIC_TERMS = prev;
  }
});

test("frameworkTopicTerms: empty / malformed framework yields no vocabulary", () => {
  const prev = process.env.SCORING_TOPIC_TERMS;
  delete process.env.SCORING_TOPIC_TERMS;
  try {
    assert.deepEqual(frameworkTopicTerms(), []);
    assert.deepEqual(frameworkTopicTerms({}), []);
    assert.deepEqual(frameworkTopicTerms(null), []);
    assert.deepEqual(frameworkTopicTerms({ topicTerm: null, topicSynonyms: null }), []);
  } finally {
    if (prev !== undefined) process.env.SCORING_TOPIC_TERMS = prev;
  }
});

test("frameworkTopicTerms: global SCORING_TOPIC_TERMS env override wins when set", () => {
  const prev = process.env.SCORING_TOPIC_TERMS;
  process.env.SCORING_TOPIC_TERMS = "Alpha, Beta ,, alpha";
  try {
    const terms = frameworkTopicTerms({ topicTerm: "biodiversity" });
    assert.deepEqual(terms, ["alpha", "beta"]); // normalised, de-duped, framework fields ignored
  } finally {
    if (prev === undefined) delete process.env.SCORING_TOPIC_TERMS;
    else process.env.SCORING_TOPIC_TERMS = prev;
  }
});

test("evidenceHasAnyTerm: case-insensitive substring match, defensive about bad terms", () => {
  assert.equal(evidenceHasAnyTerm("We assessed BIODIVERSITY loss", ["biodiversity"]), true);
  assert.equal(evidenceHasAnyTerm("nothing relevant", ["biodiversity"]), false);
  assert.equal(evidenceHasAnyTerm("", ["biodiversity"]), false);
  assert.equal(evidenceHasAnyTerm("text", [null as any, "", "text"]), true);
  assert.equal(evidenceHasAnyTerm("text", []), false);
});

test("decideTopicTermGate: flag off never downgrades", () => {
  const r = decideTopicTermGate({ flagOn: false, verdict: "Yes", evidenceText: "anything", topicTerms: ["biodiversity"] });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "flag-off");
});

test("decideTopicTermGate: non-Yes verdict never downgrades", () => {
  const r = decideTopicTermGate({ flagOn: true, verdict: "No", evidenceText: "x", topicTerms: ["biodiversity"] });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "verdict-not-yes");
});

test("decideTopicTermGate: no derived vocabulary fails OPEN (never downgrades)", () => {
  const r = decideTopicTermGate({ flagOn: true, verdict: "Yes", evidenceText: "x", topicTerms: [] });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "no-topic-vocabulary");
});

test("decideTopicTermGate: Yes with a framework topic term in evidence passes", () => {
  const r = decideTopicTermGate({
    flagOn: true,
    verdict: "Yes",
    evidenceText: "The company reports on biodiversity impacts across its sites.",
    topicTerms: ["biodiversity", "nature loss"],
  });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "topic-term-present");
});

test("decideTopicTermGate: Yes whose evidence lacks any topic term is downgraded", () => {
  const r = decideTopicTermGate({
    flagOn: true,
    verdict: "Yes",
    evidenceText: "We discuss general sustainability matters, with no specifics.",
    topicTerms: ["biodiversity", "nature loss"],
  });
  assert.equal(r.downgrade, true);
  assert.equal(r.reason, "topic-term-missing");
});

// ── CHANGE 6 — vote persisted in decision_trace jsonb ────────────────────────
test("withSelfConsistencyVoteInTrace: flag off is a no-op", () => {
  const trace = { a: 1 };
  assert.equal(withSelfConsistencyVoteInTrace(trace, "3/3", false), trace);
});

test("withSelfConsistencyVoteInTrace: empty vote is a no-op", () => {
  const trace = { a: 1 };
  assert.equal(withSelfConsistencyVoteInTrace(trace, "", true), trace);
});

test("withSelfConsistencyVoteInTrace: merges without overwriting, roundtrips", () => {
  const merged = withSelfConsistencyVoteInTrace({ a: 1, diagnostics: ["x"] }, "2/3", true) as any;
  assert.equal(merged.a, 1);
  assert.deepEqual(merged.diagnostics, ["x"]);
  assert.equal(merged.selfConsistencyVote, "2/3");
  assert.equal(readSelfConsistencyVoteFromTrace(merged), "2/3");
});

test("withSelfConsistencyVoteInTrace: tolerates null/non-object trace", () => {
  const merged = withSelfConsistencyVoteInTrace(null, "1/3", true) as any;
  assert.equal(merged.selfConsistencyVote, "1/3");
  assert.equal(readSelfConsistencyVoteFromTrace(undefined), "");
  assert.equal(readSelfConsistencyVoteFromTrace([1, 2]), "");
});

// ── CHANGE 8 — EVIDENCE_QUOTE_OVERLAP_MATCH ──────────────────────────────────
test("quoteTokenOverlap: identical=1, disjoint=0", () => {
  assert.equal(quoteTokenOverlap("flood risk assessment", "flood risk assessment"), 1);
  assert.equal(quoteTokenOverlap("alpha beta", "gamma delta"), 0);
});

test("QuoteLedger flag OFF: exact-text only (near-duplicates are distinct)", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("The company assessed flood risk in 2023", "m1", false), true);
  // near-dup but not exact → distinct measure can claim it (no threshold passed)
  assert.equal(led.claim("The company assessed flood risk during 2023 fully", "m2", false), true);
  // exact reuse by a different measure → blocked
  assert.equal(led.claim("The company assessed flood risk in 2023", "m2", false), false);
});

test("QuoteLedger flag ON: same passage id = match", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("quote one text here", "m1", false, { passageId: "p1", overlapThreshold: 0.6 }), true);
  // totally different text but same passage id → treated as same, owned by m1
  assert.equal(led.claim("completely unrelated words entirely", "m2", false, { passageId: "p1", overlapThreshold: 0.6 }), false);
});

test("QuoteLedger flag ON: >=60% token overlap = match, <60% = distinct", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("alpha beta gamma delta epsilon", "m1", false, { overlapThreshold: 0.6 }), true);
  // 4 of 5 tokens shared → Jaccard = 4/6 ≈ 0.67 ≥ 0.6 → match (blocked for m2)
  assert.equal(led.claim("alpha beta gamma delta zeta", "m2", false, { overlapThreshold: 0.6 }), false);
  // only 1 shared token with any claimed quote → distinct, m3 may claim
  assert.equal(led.claim("alpha one two three four five", "m3", false, { overlapThreshold: 0.6 }), true);
});

// ── CHANGE 7 — CHECKLIST_SOURCE_TYPE_CLASSIFY (classified coverage) ──────────
const fp = (url: string, title: string) => ({ url, title, gateVerdict: "accept", sourceType: "first_party" }) as any;

test("classifiedCoverageComprehensive: no classifier → not comprehensive", () => {
  const r = classifiedCoverageComprehensive({ documents: [fp("https://x.com/ar.pdf", "Annual Report")] });
  assert.equal(r.comprehensive, false);
});

test("classifiedCoverageComprehensive: both annual + sustainability → comprehensive", () => {
  const classify = (url: string, title: string) => {
    const s = (url + " " + title).toLowerCase();
    const out: string[] = [];
    if (s.includes("annual")) out.push("annual-report");
    if (s.includes("sustain")) out.push("sustainability report");
    return out;
  };
  const r = classifiedCoverageComprehensive({
    documents: [fp("https://x.com/annual.pdf", "Annual Report"), fp("https://x.com/sustainability.pdf", "Sustainability Report")],
    classifySourceTypes: classify,
  });
  assert.equal(r.annualReportPresent, true);
  assert.equal(r.sustainabilityOrClimatePresent, true);
  assert.equal(r.comprehensive, true);
});

test("classifiedCoverageComprehensive: only annual → not comprehensive", () => {
  const classify = (url: string) => (url.includes("annual") ? ["annual-report"] : []);
  const r = classifiedCoverageComprehensive({
    documents: [fp("https://x.com/annual.pdf", "Annual Report")],
    classifySourceTypes: classify,
  });
  assert.equal(r.annualReportPresent, true);
  assert.equal(r.sustainabilityOrClimatePresent, false);
  assert.equal(r.comprehensive, false);
});


// ═════════════════════════════════════════════════════════════════════════════
// FW25 Track A — scoring-correctness fixes (FIX 1–5). Pure-helper unit tests.
// ═════════════════════════════════════════════════════════════════════════════

// ── FIX 1 — measure-level track gate: fail-open vs fire ──────────────────────
test("FIX1 parseMeasureTrack: reads leading TRACK token (both field spellings)", () => {
  assert.equal(parseMeasureTrack({ substantiveDefinition: "TRACK physical_climate — flood risk…" }), "physical_climate");
  assert.equal(parseMeasureTrack({ substantive_definition: "  track Operational_Resilience bla" }), "operational_resilience");
  assert.equal(parseMeasureTrack({ substantiveDefinition: "No track token here" }), null);
  assert.equal(parseMeasureTrack({}), null);
});

test("FIX1 frameworkRequiredForTracks: declared [] wins over env (fail-open)", () => {
  const prev = process.env.SCORING_REQUIRED_FOR_TRACKS;
  process.env.SCORING_REQUIRED_FOR_TRACKS = "physical_climate";
  try {
    // declared empty array → declaration wins → no tracks gated
    assert.deepEqual(frameworkRequiredForTracks({ requiredForTracks: [] }), []);
    // declared value normalised + lowercased
    assert.deepEqual(frameworkRequiredForTracks({ required_for_tracks: ["Physical_Climate", " "] }), ["physical_climate"]);
    // undeclared → env fallback
    assert.deepEqual(frameworkRequiredForTracks({}), ["physical_climate"]);
  } finally {
    if (prev === undefined) delete process.env.SCORING_REQUIRED_FOR_TRACKS;
    else process.env.SCORING_REQUIRED_FOR_TRACKS = prev;
  }
});

test("FIX1 measureTrackGated / measureIsTrackGated: fires only for gated track, fail-open otherwise", () => {
  // undeclared requiredForTracks → never gate (the regression: business-continuity Yes preserved)
  assert.equal(measureTrackGated("operational_resilience", []), false);
  assert.equal(measureTrackGated(null, ["physical_climate"]), false);
  // fires only when the measure's OWN track is in the list
  assert.equal(measureTrackGated("physical_climate", ["physical_climate"]), true);
  assert.equal(measureTrackGated("operational_resilience", ["physical_climate"]), false);

  const fw = { requiredForTracks: ["physical_climate"] };
  assert.equal(measureIsTrackGated({ substantiveDefinition: "TRACK physical_climate x" }, fw), true);
  assert.equal(measureIsTrackGated({ substantiveDefinition: "TRACK operational_resilience x" }, fw), false);
  assert.equal(measureIsTrackGated({ substantiveDefinition: "TRACK performance x" }, fw), false);
  // framework declares nothing → fail-open even for a physical_climate measure
  assert.equal(measureIsTrackGated({ substantiveDefinition: "TRACK physical_climate x" }, { requiredForTracks: [] }), false);
});

// ── FIX 2 — per-company doc cap + cross-run dedup ────────────────────────────
test("FIX2 frameworkPerCompanyDocCap: declared/env/fail-open", () => {
  const prev = process.env.SCORING_PER_COMPANY_DOC_CAP;
  delete process.env.SCORING_PER_COMPANY_DOC_CAP;
  try {
    assert.equal(frameworkPerCompanyDocCap({ perCompanyDocCap: 50 }), 50);
    assert.equal(frameworkPerCompanyDocCap({ per_company_doc_cap: 12 }), 12);
    assert.equal(frameworkPerCompanyDocCap({}), null); // undeclared → no cap (fail-open)
    process.env.SCORING_PER_COMPANY_DOC_CAP = "7";
    assert.equal(frameworkPerCompanyDocCap({}), 7);
    assert.equal(frameworkPerCompanyDocCap({ perCompanyDocCap: 0 }), 7); // non-positive declared → env
  } finally {
    if (prev === undefined) delete process.env.SCORING_PER_COMPANY_DOC_CAP;
    else process.env.SCORING_PER_COMPANY_DOC_CAP = prev;
  }
});

test("FIX2 buildPinnedUrlsForRun: manual pins lead, dedup, cap", () => {
  const out = buildPinnedUrlsForRun({
    manualPins: ["https://m/doc.pdf", "https://shared/x.pdf", "  "],
    frameworkAutoPins: ["https://shared/x.pdf", "https://a/1.pdf", "https://a/2.pdf"],
    cap: 3,
  });
  // dedup (shared/x.pdf once), manual first, capped to 3
  assert.deepEqual(out, ["https://m/doc.pdf", "https://shared/x.pdf", "https://a/1.pdf"]);
  // null cap → no cap, manual pin never dropped
  const uncapped = buildPinnedUrlsForRun({ manualPins: ["https://m.pdf"], frameworkAutoPins: ["https://a.pdf", "https://b.pdf"], cap: null });
  assert.deepEqual(uncapped, ["https://m.pdf", "https://a.pdf", "https://b.pdf"]);
});

test("FIX2 mergeAutoPins keeps newest under cap; getFrameworkAutoPins reads per-framework", () => {
  // cap keeps the NEWEST (tail) — most recent evidence retained
  const merged = mergeAutoPins({ existingFrameworkAutoPins: ["old1", "old2"], newPins: ["new1", "new2"], cap: 3 });
  assert.deepEqual(merged, ["old2", "new1", "new2"]);
  // framework-scoped read: other frameworks' pins never bleed in
  const map = { "25": ["https://fw25/a.pdf"], "5": ["https://fw5/b.pdf"] };
  assert.deepEqual(getFrameworkAutoPins(map, 25), ["https://fw25/a.pdf"]);
  assert.deepEqual(getFrameworkAutoPins(map, 99), []);
  assert.deepEqual(getFrameworkAutoPins(null, 25), []);
});

// ── FIX 3 — recency window downgrade with fail-open on unknown date ──────────
test("FIX3 extractCitedSourceYear: most-recent plausible year or null", () => {
  assert.equal(extractCitedSourceYear("https://x/annual-2023.pdf", "Annual Report 2024"), 2024);
  assert.equal(extractCitedSourceYear("https://x/doc.pdf", "Sustainability Report"), null);
  assert.equal(extractCitedSourceYear("https://x/18880000.pdf", "junk 3000"), null); // out of 1990–2099
});

test("FIX3 frameworkRecencyWindowYears: declared/env/fail-open", () => {
  const prev = process.env.SCORING_RECENCY_WINDOW_YEARS;
  delete process.env.SCORING_RECENCY_WINDOW_YEARS;
  try {
    assert.equal(frameworkRecencyWindowYears({ recencyWindowYears: 4 }), 4);
    assert.equal(frameworkRecencyWindowYears({}), null);
    process.env.SCORING_RECENCY_WINDOW_YEARS = "3";
    assert.equal(frameworkRecencyWindowYears({}), 3);
  } finally {
    if (prev === undefined) delete process.env.SCORING_RECENCY_WINDOW_YEARS;
    else process.env.SCORING_RECENCY_WINDOW_YEARS = prev;
  }
});

test("FIX3 decideRecencyWindowGate: downgrade only when ALL dated sources stale; fail-open on unknown/none", () => {
  const base = { windowYears: 4, currentYear: 2026 };
  // all cited sources stale (<2022) → downgrade
  assert.equal(decideRecencyWindowGate({ ...base, verdict: "Yes", citedSourceYears: [2019, 2020] }).downgrade, true);
  // at least one in window → keep
  assert.equal(decideRecencyWindowGate({ ...base, verdict: "Yes", citedSourceYears: [2019, 2025] }).downgrade, false);
  // no dated sources → fail-open
  assert.equal(decideRecencyWindowGate({ ...base, verdict: "Partial", citedSourceYears: [null, null] }).downgrade, false);
  // no cited sources → fail-open
  assert.equal(decideRecencyWindowGate({ ...base, verdict: "Yes", citedSourceYears: [] }).downgrade, false);
  // window undeclared → fail-open
  assert.equal(decideRecencyWindowGate({ windowYears: null, currentYear: 2026, verdict: "Yes", citedSourceYears: [2000] }).downgrade, false);
  // not a positive verdict → never downgrade
  assert.equal(decideRecencyWindowGate({ ...base, verdict: "No", citedSourceYears: [2000] }).downgrade, false);
});

// ── FIX 4 — related-listed hard exclusion + per-company map ──────────────────
test("FIX4 resolvePerCompanyList: flat array vs per-company map (+ wildcard)", () => {
  assert.deepEqual(resolvePerCompanyList(["A Corp", "B Ltd"], "anyone"), ["A Corp", "B Ltd"]);
  const map = { "Hyundai Glovis": ["Hyundai Motor Company"], "*": ["Shared Peer"] };
  assert.deepEqual(resolvePerCompanyList(map, "hyundai glovis"), ["Shared Peer", "Hyundai Motor Company"]);
  assert.deepEqual(resolvePerCompanyList(map, "Unrelated Co"), ["Shared Peer"]);
  assert.deepEqual(resolvePerCompanyList(undefined, "x"), []);
});

test("FIX4 frameworkRelatedListedCompanies / frameworkSubsidiaryDomains read the columns", () => {
  const fw = {
    relatedListedCompanies: { "Hyundai Glovis": ["Hyundai Motor Company"] },
    subsidiaryDomains: { "Hyundai Glovis": ["www.Glovis.net/", "glovis.com"] },
  };
  assert.deepEqual(frameworkRelatedListedCompanies(fw, "Hyundai Glovis"), ["Hyundai Motor Company"]);
  assert.deepEqual(frameworkRelatedListedCompanies(fw, "Someone Else"), []);
  // subsidiary domains normalised to bare hosts
  assert.deepEqual(frameworkSubsidiaryDomains(fw, "Hyundai Glovis"), ["glovis.net", "glovis.com"]);
});

test("FIX4 decideRelatedListedExclusion: hard-reject peer mention; fail-open when undeclared", () => {
  assert.equal(relatedListedGateEnabled(), true); // default on (no env override)
  // peer named, target not → HARD REJECT
  const r1 = decideRelatedListedExclusion({
    relatedListed: ["Hyundai Motor Company"],
    quoteTexts: ["Hyundai Motor Company published a TCFD report covering physical climate risk."],
    targetName: "Hyundai Glovis",
  });
  assert.equal(r1.reject, true);
  assert.equal(r1.matched, "Hyundai Motor Company");
  // target also named, non-strict → keep (own disclosure referencing a peer)
  const r2 = decideRelatedListedExclusion({
    relatedListed: ["Hyundai Motor Company"],
    quoteTexts: ["Hyundai Glovis, part of the group alongside Hyundai Motor Company, assessed flood risk."],
    targetName: "Hyundai Glovis",
  });
  assert.equal(r2.reject, false);
  // strict → reject even with target named
  const r3 = decideRelatedListedExclusion({
    relatedListed: ["Hyundai Motor Company"],
    quoteTexts: ["Hyundai Glovis and Hyundai Motor Company."],
    targetName: "Hyundai Glovis",
    strict: true,
  });
  assert.equal(r3.reject, true);
  // undeclared list → fail-open
  assert.equal(decideRelatedListedExclusion({ relatedListed: [], quoteTexts: ["anything"], targetName: "X" }).reject, false);
});

// ── FIX 5 — pinned gzip / content-type ingest (pure sniff core) ──────────────
test("FIX5 recognizePdfPayload: magic bytes, content-type, gzip-decompress, reject non-PDF", async () => {
  const zlibMod = await import("node:zlib");
  // (a) plain PDF by magic bytes, no .pdf-ish content-type
  const pdf = Buffer.from("%PDF-1.7\n...body...", "latin1");
  const a = recognizePdfPayload(pdf, "application/octet-stream");
  assert.ok(a && a.via === "magic-bytes");
  // (b) recognised by content-type even without magic bytes
  const b = recognizePdfPayload(Buffer.from("not-a-magic-header"), "application/pdf; charset=binary");
  assert.ok(b && b.via === "content-type");
  // (c) gzip-compressed PDF (CDN gzip not auto-decompressed) → transparently inflated
  const gz = zlibMod.gzipSync(pdf);
  assert.equal(gz[0], 0x1f);
  const c = recognizePdfPayload(gz, "application/octet-stream");
  assert.ok(c && c.via === "magic-bytes");
  assert.equal(c!.buf.slice(0, 5).toString("latin1"), "%PDF-");
  // (d) genuinely not a PDF → null
  assert.equal(recognizePdfPayload(Buffer.from("<html>hi</html>"), "text/html"), null);
});
