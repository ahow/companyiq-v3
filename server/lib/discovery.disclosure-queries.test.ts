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
  // Expect: quoted+filetype, quoted+yearrange, unquoted+filetype, unquoted+year (R1 refinement)
  assert.ok(q.some(x => x === `"Acme Corp" sustainability report filetype:pdf`), "quoted + filetype:pdf");
  assert.ok(q.some(x => x.startsWith(`"Acme Corp" sustainability report `) && x.includes("OR")), "quoted + year range");
  assert.ok(q.some(x => x === `Acme Corp sustainability report filetype:pdf`), "unquoted + filetype:pdf");
  assert.ok(q.some(x => /^Acme Corp sustainability report \d{4}$/.test(x)), "unquoted + current year (R1 refinement)");
});

test("aliases produce additional quoted variants", () => {
  const q = buildDisclosureVehicleQueries("Sumitomo Mitsui Financial Group", makeFramework(["annual report"]), ["SMFG"]);
  // Should include both name variants for the quoted patterns.
  assert.ok(q.some(x => x === `"Sumitomo Mitsui Financial Group" annual report filetype:pdf`));
  assert.ok(q.some(x => x === `"SMFG" annual report filetype:pdf`));
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
  assert.equal(q.length, 12);
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
  // Only "annual report" survives -> 4 patterns.
  assert.equal(q.length, 4);
  assert.ok(q.every(x => x.includes("annual report")));
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
  // Must be substantial (10 vehicles \u00d7 (2 primary + 2 alias + 1 unquoted) = ~50 unique).
  assert.ok(q.length >= 40, `expected \u2265 40 queries, got ${q.length}`);
  // Must specifically include the flagship Newmont-Sustainability-Report queries
  // that R1 is designed to unblock.
  assert.ok(q.some(x => x === `"Newmont Corporation" sustainability report filetype:pdf`));
  assert.ok(q.some(x => x === `"NEM" sustainability report filetype:pdf`));
});
