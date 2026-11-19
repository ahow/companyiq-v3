import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequiredSourceTypes,
  REQUIRED_SOURCE_TYPE_BACKBONE,
} from "./required-source-types.js";

// Deliverable B (a): deriveRequiredSourceTypes — builder auto-fill of a measure's
// requiredSourceTypes from its disclosure vehicles + the universal backbone, so a
// freshly-built framework arrives with a LIVE abstain gate instead of null.

test("appends the universal backbone when vehicles are empty", () => {
  const out = deriveRequiredSourceTypes([]);
  assert.deepEqual(out, [...REQUIRED_SOURCE_TYPE_BACKBONE]);
});

test("appends the backbone for null/undefined vehicles (never returns null/empty)", () => {
  assert.deepEqual(deriveRequiredSourceTypes(null), [...REQUIRED_SOURCE_TYPE_BACKBONE]);
  assert.deepEqual(deriveRequiredSourceTypes(undefined), [...REQUIRED_SOURCE_TYPE_BACKBONE]);
  assert.ok(deriveRequiredSourceTypes(undefined).length > 0);
});

test("declared vehicles come first, in order, then backbone", () => {
  const out = deriveRequiredSourceTypes(["Sustainability/ESG Report", "CDP response"]);
  assert.deepEqual(out, [
    "Sustainability/ESG Report",
    "CDP response",
    "Annual Report",
    "annual-report",
    "regulatory-filing",
  ]);
});

test("de-duplicates case-insensitively and keeps first-seen casing", () => {
  const out = deriveRequiredSourceTypes(["Annual Report", "annual report", "CDP Response", "cdp response"]);
  // "Annual Report" (vehicle) dedupes with the backbone "Annual Report"; the
  // lowercase "annual report" duplicate is dropped; "CDP Response" kept once.
  assert.deepEqual(out, [
    "Annual Report",
    "CDP Response",
    "annual-report",
    "regulatory-filing",
  ]);
});

test("trims whitespace and drops empty / non-string entries", () => {
  const out = deriveRequiredSourceTypes(["  TCFD/IFRS S2 report  ", "", "   ", 42 as any, null as any]);
  assert.deepEqual(out, [
    "TCFD/IFRS S2 report",
    "Annual Report",
    "annual-report",
    "regulatory-filing",
  ]);
});

test("every result is non-empty and contains the full backbone (no abstain-forever)", () => {
  for (const vehicles of [[], ["Proxy Statement"], ["Risk management section", "Business continuity section"]]) {
    const out = deriveRequiredSourceTypes(vehicles);
    for (const b of REQUIRED_SOURCE_TYPE_BACKBONE) {
      assert.ok(out.includes(b), `expected backbone token ${b} in result`);
    }
  }
});
