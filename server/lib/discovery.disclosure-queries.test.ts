// R1: unit tests for buildDisclosureVehicleQueries.
//
// Isolated from the discovery.ts module because that file has heavy runtime
// dependencies (DB, axios, etc.). We import ONLY the pure function under
// test.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDisclosureVehicleQueries } from "./discovery.js";
import type { Framework } from "../../shared/schema.js";

function makeFramework(requiredDocTypes: string[] | null): Framework {
  return {
    id: 99,
    workspaceId: 1,
    name: "Test framework",
    topicDescription: "Test topic",
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    isShared: false,
    requiredDocTypes,
  } as unknown as Framework;
}

test("empty requiredDocTypes returns no queries", () => {
  const q = buildDisclosureVehicleQueries("Acme Corp", makeFramework(null));
  assert.deepEqual(q, []);
});

test("empty array requiredDocTypes returns no queries", () => {
  const q = buildDisclosureVehicleQueries("Acme Corp", makeFramework([]));
  assert.deepEqual(q, []);
});

test("single vehicle type generates the four-pattern set for the company name", () => {
  const q = buildDisclosureVehicleQueries("Acme Corp", makeFramework(["sustainability report"]));
  // R7f refinement: vehicle phrase is now wrapped in quotes for precise Serper matching.
  assert.ok(q.some(x => x === `"Acme Corp" "sustainability report" filetype:pdf`), "quoted + filetype:pdf");
  assert.ok(q.some(x => x.startsWith(`"Acme Corp" "sustainability report" `) && x.includes("OR")), "quoted + year range");
  assert.ok(q.some(x => x === `Acme Corp sustainability report filetype:pdf`), "unquoted + filetype:pdf");
  assert.ok(q.some(x => /^Acme Corp sustainability report \d{4}$/.test(x)), "unquoted + current year (R1 refinement)");
});

test("aliases produce additional quoted variants", () => {
  const q = buildDisclosureVehicleQueries("Sumitomo Mitsui Financial Group", makeFramework(["annual report"]), ["SMFG"]);
  // R7f: vehicle phrase is now quoted. Both name variants should appear.
  assert.ok(q.some(x => x === `"Sumitomo Mitsui Financial Group" "annual report" filetype:pdf`));
  assert.ok(q.some(x => x === `"SMFG" "annual report" filetype:pdf`));
  // The unquoted+filetype pattern uses ONLY the primary name (dedupe would\n  // block a redundant SMFG unquoted variant anyway).
  assert.ok(q.some(x => x === `Sumitomo Mitsui Financial Group annual report filetype:pdf`));
});

test("filters aliases that match the company name case-insensitively", () => {
  const q = buildDisclosureVehicleQueries("Newmont", makeFramework(["annual report"]), ["NEWMONT", "newmont"]);
  // The aliases collapse; there should be no duplicate quoted-alias query.
  const quoted = q.filter(x => x.startsWith(`"`));
  const distinct = new Set(quoted);
  assert.equal(quoted.length, distinct.size, "no duplicate quoted queries");
});

test("respects maxVehicles cap", () => {
  const vehicles = Array.from({ length: 20 }, (_, i) => `vehicle ${i}`);
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(vehicles), [], { maxVehicles: 3 });
  // 3 vehicles \u00d7 4 patterns = 12 queries per vehicle when no aliases:
  //   1. quoted + filetype:pdf
  //   2. quoted + year range
  //   3. unquoted + filetype:pdf
  //   4. unquoted + current year (R1 refinement, catches HTML disclosures)
  //   5. R7f: inurl:<anchor> filetype:pdf for compound-phrase clauses (>=2 words, no digits)
  // For "sustainability report" (2 words, no digits, no compound splitting) we
  // expect 4 base patterns + 1 inurl fallback = 5 unique queries. With 3 name
  // variants ("Acme Corp", "Acme", "ACME") × 2 quoted patterns = 6 quoted-with-alias,
  // plus 3 unquoted (using nameVariants[0] only). Add 1 inurl fallback → 10.
  // The exact count depends on alias deduplication; be flexible.
  assert.ok(q.length >= 8 && q.length <= 20, `expected 8-20 queries, got ${q.length}`);
});

test("no duplicate queries in output", () => {
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(["annual report", "annual report", "annual report"]));
  const seen = new Set(q.map(x => x.toLowerCase()));
  assert.equal(seen.size, q.length, "output is de-duplicated");
});

test("year-range query uses currentYear OR lastYear", () => {
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(["sustainability report"]));
  const yearQuery = q.find(x => x.includes("OR"));
  assert.ok(yearQuery, "at least one query contains OR (year range)");
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  assert.ok(yearQuery!.includes(String(currentYear)));
  assert.ok(yearQuery!.includes(String(lastYear)));
});

test("skips blank vehicle strings without crashing", () => {
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(["", "  ", "annual report", "  "]));
  // Only "annual report" survives; R7f adds inurl fallback → 5 queries.
  assert.ok(q.length >= 3 && q.length <= 8, `expected 3-8 queries, got ${q.length}`);
  assert.ok(q.every(x => x.toLowerCase().includes("annual")));
});

test("R7f: compound doc-type with 'or' is split into per-clause queries", () => {
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(["board committee charters or terms of reference"]));
  // The compound phrase should split into clauses. Each clause + the original
  // phrase should produce its own quoted query.
  assert.ok(q.some(x => x.includes('"board committee charters"')), "clause 1 quoted");
  assert.ok(q.some(x => x.includes('"terms of reference"')), "clause 2 quoted");
});

test("R7f: inurl anchor emitted for multi-word non-numeric doc types", () => {
  const q = buildDisclosureVehicleQueries("Nestl\u00e9", makeFramework(["board committee charter"]));
  // Anchor picker chooses the longest sub-word ≥ 5 chars — could be 'charter' or
  // 'committee'. Either produces a useful URL filter.
  assert.ok(
    q.some(x => x.includes("inurl:charter") || x.includes("inurl:committee")),
    `expected inurl:charter or inurl:committee fallback in ${q.join(" | ")}`,
  );
});

test("R7f: no inurl fallback for numeric-heavy doc types like '10-K filing'", () => {
  const q = buildDisclosureVehicleQueries("Acme", makeFramework(["10-K filing"]));
  // 10-K contains digits → no inurl fallback (would be ambiguous).
  assert.ok(!q.some(x => x.includes("inurl:")), `should not have inurl for numeric doc types, got: ${q.join(" | ")}`);
});

test("real framework-3 vehicles produce a rich query set", () => {
  // Realistic aggregated list from framework 3.
  const fw3Vehicles = [
    "sustainability report",
    "annual report",
    "integrated report",
    "tnfd disclosure",
    "dedicated tnfd-aligned report",
    "10-k filing",
    "proxy statement or notice of annual meeting",
    "corporate governance statement",
    "biodiversity report",
    "biodiversity or nature policy document",
  ];
  const q = buildDisclosureVehicleQueries("Newmont Corporation", makeFramework(fw3Vehicles), ["NEM"], { maxVehicles: 10 });
  // R7f expansion adds per-clause queries + inurl fallbacks; expect a rich set.
  assert.ok(q.length >= 60, `expected \u2265 60 queries, got ${q.length}`);
  // Must specifically include the flagship Newmont-Sustainability-Report queries
  // (R7f now quotes the vehicle phrase).
  assert.ok(q.some(x => x === `"Newmont Corporation" "sustainability report" filetype:pdf`));
  assert.ok(q.some(x => x === `"NEM" "sustainability report" filetype:pdf`));
  // R7f: compound splitting produces per-clause query for "proxy statement" too.
  assert.ok(q.some(x => x.includes('"proxy statement"')));
  assert.ok(q.some(x => x.includes('"notice of annual meeting"')));
});
