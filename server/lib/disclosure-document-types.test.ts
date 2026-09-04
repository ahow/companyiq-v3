import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDisclosureVehicles } from "./disclosure-document-types.js";

// Real framework-3 data — one entry per measure (20 measures).
const FRAMEWORK3_VEHICLES: string[][] = [
  ["Annual report (governance section)", "Sustainability report (governance section)", "Corporate governance statement", "Board committee charters or terms of reference", "TNFD disclosure", "Integrated report", "Proxy statement or notice of annual meeting", "Dedicated governance policy document", "Entity website (governance or sustainability pages)"],
  ["Annual report (governance or management section)", "Sustainability report (governance section)", "Corporate governance statement", "Management structure or organizational chart", "TNFD disclosure", "Integrated report", "Dedicated governance policy document", "Entity website (governance, leadership, or sustainability pages)"],
  ["Annual report (governance section)", "Sustainability report (governance section)", "Corporate governance statement", "TNFD disclosure", "Integrated report", "Dedicated governance policy document", "Entity website (governance or sustainability pages)"],
  ["Annual report (strategy or governance section)", "Sustainability report (governance or strategy section)", "Integrated report", "TNFD disclosure", "Risk management framework document", "Investment policy or capital allocation framework", "Procurement policy or supplier standards", "Entity website (governance, strategy, or sustainability pages)"],
  ["annual report", "sustainability report", "TNFD disclosure", "natural capital report", "integrated report", "CDP forests questionnaire", "materiality assessment", "strategy section", "risk disclosure"],
  ["annual report", "sustainability report", "TNFD disclosure", "biodiversity report", "impact assessment", "CDP forests questionnaire", "materiality assessment", "environmental statement", "integrated report"],
  ["annual report", "sustainability report", "TNFD disclosure", "risk register", "10-K filing", "integrated report", "CDP disclosure", "scenario analysis", "materiality assessment"],
  ["annual report", "sustainability report", "TNFD disclosure", "strategy section", "innovation report", "integrated report", "investor presentation", "business model description"],
  ["Sustainability report", "Annual report", "TNFD disclosure", "Integrated report", "Biodiversity or nature policy document", "Risk management framework document", "CDP Forests/Water questionnaire response", "Dedicated nature-related financial disclosure"],
  ["Sustainability report", "Biodiversity or nature policy document", "Annual report", "Environmental management system documentation", "Project-level environmental impact assessments", "TNFD disclosure", "CDP Forests questionnaire response", "Integrated report"],
];

test("aggregates and normalises vehicles from real framework-3 data", () => {
  const r = aggregateDisclosureVehicles(FRAMEWORK3_VEHICLES, { maxItems: 12 });

  // Must be non-empty and capped
  assert.ok(r.vehicles.length > 0, "vehicles should be non-empty");
  assert.ok(r.vehicles.length <= 12, "vehicles should be capped at maxItems");

  // Must include the four highest-priority document types
  assert.ok(r.vehicles.includes("sustainability report"), "must include sustainability report");
  assert.ok(r.vehicles.includes("annual report"), "must include annual report");
  assert.ok(r.vehicles.includes("integrated report"), "must include integrated report");
  assert.ok(r.vehicles.includes("tnfd disclosure"), "must include tnfd disclosure");
});

test("strips parenthetical section qualifiers", () => {
  const r = aggregateDisclosureVehicles([
    ["Sustainability report (governance section)"],
    ["Sustainability report (strategy section)"],
    ["annual report"],
  ]);
  // Both parenthetical variants collapse to the same normalised label.
  assert.ok(r.vehicles.includes("sustainability report"));
  assert.ok(!r.vehicles.some(v => v.includes("(")), "no parentheses in vehicles");
});

test("rejects vague or non-standalone vehicle labels", () => {
  const r = aggregateDisclosureVehicles([
    ["Sustainability report", "strategy section", "materiality assessment", "risk disclosure", "impact assessment"],
  ]);
  assert.ok(r.vehicles.includes("sustainability report"));
  assert.ok(!r.vehicles.includes("strategy section"), "strategy section rejected");
  assert.ok(!r.vehicles.includes("materiality assessment"), "materiality assessment rejected");
  assert.ok(!r.vehicles.includes("risk disclosure"), "risk disclosure rejected");
  assert.ok(r.rejected.length >= 3, "rejects should be recorded");
});

test("deduplicates across measures on normalised form", () => {
  const r = aggregateDisclosureVehicles([
    ["Annual Report"],
    ["annual report"],
    ["ANNUAL REPORT"],
    ["annual report (governance section)"],
  ]);
  const annualCount = r.vehicles.filter(v => v === "annual report").length;
  assert.equal(annualCount, 1, "annual report appears exactly once");
});

test("ranks by known-priority document types", () => {
  const r = aggregateDisclosureVehicles([
    ["Sustainability report", "annual report", "integrated report", "TNFD disclosure", "investor presentation", "innovation report"],
  ], { maxItems: 6 });
  // Sustainability report should rank #1 (highest boost)
  assert.equal(r.vehicles[0], "sustainability report");
  // Annual report should rank #2
  assert.equal(r.vehicles[1], "annual report");
});

test("empty input returns empty aggregation", () => {
  const r = aggregateDisclosureVehicles([]);
  assert.deepEqual(r.vehicles, []);
});

test("null and undefined arrays are handled", () => {
  const r = aggregateDisclosureVehicles([null, undefined, ["annual report"]]);
  assert.deepEqual(r.vehicles, ["annual report"]);
});

test("respects maxItems cap", () => {
  const many: string[][] = [];
  for (let i = 0; i < 30; i++) many.push([`custom report type ${i}`]);
  const r = aggregateDisclosureVehicles(many, { maxItems: 5 });
  assert.equal(r.vehicles.length, 5);
  // But `all` retains the full unfiltered ranked list.
  assert.ok(r.all.length > 5);
});
