/**
 * Unit tests for parseBooleanFlag.
 *
 * The tri-state design (true / false / null) is the reason for this file:
 * we want callers to be able to distinguish "user said no" from "user said
 * nothing", so unrecognised inputs must map to null, not false.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBooleanFlag } from "./parse-boolean-flag.js";

// ─── null cases (absent / empty / unrecognised) ───────────────────────

for (const bad of [null, undefined, "", "   ", "\t\n"]) {
  test(`parseBooleanFlag: null for ${JSON.stringify(bad)}`, () => {
    assert.equal(parseBooleanFlag(bad as any), null);
  });
}

for (const bad of ["maybe", "TBD", "n/a", "pending", "on", "off", "yesish"]) {
  test(`parseBooleanFlag: null for unrecognised value ${JSON.stringify(bad)}`, () => {
    assert.equal(parseBooleanFlag(bad), null);
  });
}

// ─── true cases ───────────────────────────────────────────────────────

for (const good of ["true", "TRUE", "True", " true ", "yes", "Yes", "YES", "y", "Y", "1", "unlisted", "UNLISTED", "private"]) {
  test(`parseBooleanFlag: true for ${JSON.stringify(good)}`, () => {
    assert.equal(parseBooleanFlag(good), true);
  });
}

// ─── false cases ──────────────────────────────────────────────────────

for (const good of ["false", "FALSE", "False", " false ", "no", "No", "NO", "n", "N", "0", "listed", "LISTED", "public"]) {
  test(`parseBooleanFlag: false for ${JSON.stringify(good)}`, () => {
    assert.equal(parseBooleanFlag(good), false);
  });
}

// ─── The specific tri-state contract ──────────────────────────────────

test("parseBooleanFlag: null is distinct from false", () => {
  // The whole point of the tri-state: callers that treat null as
  // "unspecified" and false as "explicitly listed" must both be supported.
  const absent = parseBooleanFlag(null);
  const explicit = parseBooleanFlag("no");
  assert.equal(absent, null);
  assert.equal(explicit, false);
  assert.notEqual(absent, explicit);
});

test("parseBooleanFlag: numbers passed as strings still work", () => {
  // Spreadsheets often serialise 0/1 as strings; also as numbers via JSON.
  // We accept string form; number form is a caller responsibility.
  assert.equal(parseBooleanFlag("1"), true);
  assert.equal(parseBooleanFlag("0"), false);
});
