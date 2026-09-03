/**
 * Unit tests for the deterministic pieces of domain-audit.
 * Network-touching functions (FMP, OpenFIGI, Serper) are exercised by the
 * CLI integration run, not here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countriesLooselyMatch,
  normaliseCountry,
  nameTokens,
  computeU17Impact,
} from "./domain-audit.js";

// ─── Country normalisation ──────────────────────────────────────────────

test("normaliseCountry: null / empty passthrough", () => {
  assert.equal(normaliseCountry(null), null);
  assert.equal(normaliseCountry(undefined), null);
});

test("normaliseCountry: long names to ISO alpha-2", () => {
  assert.equal(normaliseCountry("United Kingdom"), "GB");
  assert.equal(normaliseCountry("UK"), "GB");
  assert.equal(normaliseCountry("United States"), "US");
  assert.equal(normaliseCountry("Japan"), "JP");
  assert.equal(normaliseCountry("South Korea"), "KR");
});

test("normaliseCountry: unknown values fall through case-uppered", () => {
  // Not in the map — treated as an already-canonical code / unknown label.
  assert.equal(normaliseCountry("XX"), "XX");
  assert.equal(normaliseCountry("Antarctica"), "ANTARCTICA");
});

test("countriesLooselyMatch: long-name vs code equivalence", () => {
  assert.equal(countriesLooselyMatch("United Kingdom", "GB"), true);
  assert.equal(countriesLooselyMatch("gb", "United Kingdom"), true);
  assert.equal(countriesLooselyMatch("US", "United States"), true);
});

test("countriesLooselyMatch: obvious mismatches", () => {
  assert.equal(countriesLooselyMatch("US", "GB"), false);
  assert.equal(countriesLooselyMatch("United Kingdom", "Hong Kong"), false);
});

test("countriesLooselyMatch: nulls are non-matches (not throw)", () => {
  assert.equal(countriesLooselyMatch(null, "GB"), false);
  assert.equal(countriesLooselyMatch("GB", null), false);
  assert.equal(countriesLooselyMatch(null, null), false);
});

// ─── Name tokenisation ──────────────────────────────────────────────────

test("nameTokens: strips legal suffixes and stopwords", () => {
  assert.deepEqual(nameTokens("Prudential plc"), ["prudential"]);
  assert.deepEqual(nameTokens("Banco Santander, S.A."), ["banco", "santander"]);
  assert.deepEqual(nameTokens("Toyota Motor Corporation"), ["toyota", "motor"]);
});

test("nameTokens: NFD-normalises diacritics so accented and unaccented forms match", () => {
  // The specific bug that motivated the NFD normalisation step:
  //   FMP returns "L'Or\u00e9al S.A." and OpenFIGI returns "L'OREAL".
  //   Without normalisation, the two token sets don't intersect and we
  //   falsely report an identity conflict.
  // Apostrophe is treated as punctuation, so "L'Oreal" splits into "l" +
  // "oreal". Single-char tokens are filtered, leaving just ["oreal"] —
  // that's still enough to match OpenFIGI's "L'OREAL" via the same rule.
  assert.deepEqual(nameTokens("L'Or\u00e9al S.A."), ["oreal"]);
  assert.deepEqual(nameTokens("L'OREAL"), ["oreal"]);
  assert.deepEqual(nameTokens("Nestl\u00e9 S.A."), ["nestle"]);
  assert.deepEqual(nameTokens("NESTLE SA-REG"), ["nestle"]);
  // Ambev with the S.A. suffix.
  assert.deepEqual(nameTokens("Ambev S.A."), ["ambev"]);
});

test("nameTokens: preserves multi-token brand names", () => {
  assert.deepEqual(nameTokens("Newmont Corporation"), ["newmont"]);
  assert.deepEqual(nameTokens("NextEra Energy, Inc."), ["nextera", "energy"]);
});

// ─── U17 impact simulator ──────────────────────────────────────────────

test("computeU17Impact: flip count only counts third \u2192 first transitions", () => {
  const docs = [
    { id: 1, url: "https://prudentialplc.com/report.pdf", title: "Annual report", sourceType: "third_party" as const },
    { id: 2, url: "https://apple.com/investor.pdf", title: "Investor day", sourceType: "third_party" as const },
    { id: 3, url: "https://randomblog.com/apple.pdf", title: "Blog post", sourceType: "third_party" as const },
    { id: 4, url: "https://apple.com/existing.pdf", title: "10-K", sourceType: "first_party" as const },
  ];
  const proposed = {
    domain: "apple.com",
    relatedDomains: ["prudentialplc.com"],
    ticker: "AAPL",
    isin: "US0378331005",
    name: "Apple Inc.",
    aliases: ["apple"],
  };
  const { flippedToFirst, demotedToThird } = computeU17Impact(docs, proposed);
  // 1 (prudentialplc.com via related_domains) + 2 (apple.com via primary) = 2
  assert.equal(flippedToFirst, 2);
  // Existing first_party on apple.com stays first_party.
  assert.equal(demotedToThird, 0);
});

test("computeU17Impact: demotion counted when proposal shrinks the domain family", () => {
  // Current: apple.com had a related_domain 'randomblog.com' that was
  // incorrectly first-partied. Proposal drops randomblog.com. Any docs on
  // that host previously first_party should be flagged demoted.
  const docs = [
    { id: 1, url: "https://randomblog.com/hot-take.html", title: "Hot take", sourceType: "first_party" as const },
  ];
  const proposed = {
    domain: "apple.com",
    relatedDomains: [] as string[],
    ticker: "AAPL",
    isin: "US0378331005",
    name: "Apple Inc.",
    aliases: ["apple"],
  };
  const { flippedToFirst, demotedToThird } = computeU17Impact(docs, proposed);
  assert.equal(flippedToFirst, 0);
  assert.equal(demotedToThird, 1);
});

test("computeU17Impact: null current state doesn't count either way", () => {
  const docs = [{ id: 1, url: "https://apple.com/x.pdf", title: null, sourceType: null }];
  const proposed = {
    domain: "apple.com", relatedDomains: [], ticker: "AAPL", isin: "US0378331005",
    name: "Apple Inc.", aliases: ["apple"],
  };
  const { flippedToFirst, demotedToThird } = computeU17Impact(docs, proposed);
  assert.equal(flippedToFirst, 0);
  assert.equal(demotedToThird, 0);
});
