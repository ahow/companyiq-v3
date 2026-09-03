/**
 * Unit tests for the ISIN validator.
 *
 * Positive cases are drawn from real primary-listing ISINs verified against
 * FMP for the sprint-10-preview company set; negative cases exercise each
 * failure mode individually.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateIsin, canonicaliseIsin } from "./isin-validator.js";

// ─── Positive cases: real ISINs known to pass ───────────────────────────

const KNOWN_GOOD: Array<[string, string]> = [
  ["US0378331005", "Apple Inc. (NASDAQ)"],
  ["GB0005405286", "HSBC Holdings plc (LSE)"],
  ["GB0007099541", "Prudential plc (LSE)"],
  ["US7443201022", "Prudential Financial (NYSE)"],
  ["FR0000120321", "L'Oréal S.A. (Euronext Paris)"],
  ["CH0038863350", "Nestlé S.A. (SIX)"],
  ["JP3633400001", "Toyota Motor Corp. (TSE)"],
  ["KR7005930003", "Samsung Electronics (KRX)"],
  ["AU000000BHP4", "BHP Group (ASX)"],
  ["CA8672241079", "Suncor Energy (TSX)"],
  ["ES0113900J37", "Banco Santander (BME) \u2014 letter in NSIN"],
  ["BRVALEACNOR0", "Vale S.A. (B3) \u2014 all-letter NSIN"],
  ["FR0000121485", "Kering S.A."],
  ["GB0009895292", "AstraZeneca PLC"],
  ["US65339F1012", "NextEra Energy"],
  ["US02319V1035", "Ambev ADR"],
  ["US9047678035", "Unilever ADR"],
  ["US9311421039", "Walmart Inc."],
  ["US6516391066", "Newmont Corporation"],
  ["GB0007188757", "Rio Tinto Group"],
];

for (const [isin, label] of KNOWN_GOOD) {
  test(`validateIsin: accepts ${isin} (${label})`, () => {
    const r = validateIsin(isin);
    assert.equal(r.valid, true, `expected valid, got reason=${r.reason}`);
    assert.equal(r.canonical, isin);
    assert.equal(r.reason, null);
  });
}

// ─── Normalisation ──────────────────────────────────────────────────────

test("validateIsin: trims whitespace and uppercases", () => {
  const r = validateIsin("  gb0007099541  ");
  assert.equal(r.valid, true);
  assert.equal(r.canonical, "GB0007099541");
});

test("canonicaliseIsin: returns canonical form or null", () => {
  assert.equal(canonicaliseIsin("us0378331005"), "US0378331005");
  assert.equal(canonicaliseIsin("US03783310XX"), null); // charset fail
});

// ─── Negative cases: each failure mode ──────────────────────────────────

test("validateIsin: empty / null / whitespace", () => {
  for (const bad of [null, undefined, "", "   "]) {
    const r = validateIsin(bad as any);
    assert.equal(r.valid, false);
    assert.equal(r.reason, "empty");
    assert.equal(r.canonical, null);
  }
});

test("validateIsin: length mismatch", () => {
  for (const bad of ["US037833100", "US03783310055", "TOOSHORT"]) {
    const r = validateIsin(bad);
    assert.equal(r.valid, false, `expected invalid: ${bad}`);
    assert.equal(r.reason, "length");
  }
});

test("validateIsin: charset violation (12 chars but non-alphanumeric)", () => {
  const r = validateIsin("US03783-1005");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "charset");
});

test("validateIsin: country prefix must be A-Z A-Z", () => {
  const r = validateIsin("1S0378331005"); // starts with digit
  assert.equal(r.valid, false);
  assert.equal(r.reason, "country");
});

test("validateIsin: wrong check digit (transposition)", () => {
  // Apple with two digits transposed \u2014 same charset & length, wrong Luhn.
  const r = validateIsin("US0387331005");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "check-digit");
});

test("validateIsin: right-format wrong-issuer ISIN still passes syntactically", () => {
  // Prudential Financial's US ISIN passes even when supplied for Prudential plc.
  // This is by design \u2014 the syntactic check cannot know intent. Cross-check
  // against name/country is a separate concern (deferred to follow-up PR).
  const r = validateIsin("US7443201022");
  assert.equal(r.valid, true);
});

test("validateIsin: check digit as trailing letter is rejected", () => {
  // Some malformed IDs put a letter where the check digit should be.
  const r = validateIsin("US037833100A");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "check-digit");
});
