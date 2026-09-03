/**
 * Unit tests for the FMP resolver helpers.
 *
 * Focus on the deterministic pieces that don't require network:
 *   - short-circuit conditions on the two entry points (empty ticker / ISIN)
 *   - fmpWebsiteToDomain normalisation
 *
 * The full network path (`resolveViaFmpByTicker` against a live FMP profile)
 * is covered by integration against the preview environment, not by these
 * unit tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fmpWebsiteToDomain,
  resolveViaFmp,
  resolveViaFmpByTicker,
} from "./fmp-resolver.js";

test("fmpWebsiteToDomain: null input", () => {
  assert.equal(fmpWebsiteToDomain(null), null);
});

test("fmpWebsiteToDomain: strips www and lowercases", () => {
  assert.equal(fmpWebsiteToDomain("https://www.Apple.com"), "apple.com");
  assert.equal(fmpWebsiteToDomain("www.NESTLE.com"), "nestle.com");
});

test("fmpWebsiteToDomain: adds scheme when missing", () => {
  assert.equal(fmpWebsiteToDomain("prudentialplc.com"), "prudentialplc.com");
  assert.equal(fmpWebsiteToDomain("hsbc.com/investors"), "hsbc.com");
});

test("fmpWebsiteToDomain: preserves subdomains that FMP publishes (caller decides)", () => {
  // FMP sometimes publishes a subdomain (e.g. group.<brand>.com). We keep it
  // and rely on the caller / registrable-domain normaliser to trim if needed.
  assert.equal(fmpWebsiteToDomain("https://ir.example.co.uk/"), "ir.example.co.uk");
});

test("fmpWebsiteToDomain: gracefully returns null on garbage input", () => {
  assert.equal(fmpWebsiteToDomain("not a url at all !!!"), null);
});

test("resolveViaFmp: empty ISIN returns null without calling FMP", async () => {
  // No FMP_API_KEY set in test env; even if it were, empty ISIN short-circuits.
  const prev = process.env.FMP_API_KEY;
  delete process.env.FMP_API_KEY;
  try {
    assert.equal(await resolveViaFmp(""), null);
    assert.equal(await resolveViaFmp("   "), null);
  } finally {
    if (prev !== undefined) process.env.FMP_API_KEY = prev;
  }
});

test("resolveViaFmpByTicker: empty ticker returns null without calling FMP", async () => {
  const prev = process.env.FMP_API_KEY;
  delete process.env.FMP_API_KEY;
  try {
    assert.equal(await resolveViaFmpByTicker(""), null);
    assert.equal(await resolveViaFmpByTicker("   "), null);
  } finally {
    if (prev !== undefined) process.env.FMP_API_KEY = prev;
  }
});

test("resolveViaFmpByTicker: missing FMP key returns null without throwing", async () => {
  const prev = process.env.FMP_API_KEY;
  const prev2 = process.env.FMP_TOKEN;
  delete process.env.FMP_API_KEY;
  delete process.env.FMP_TOKEN;
  try {
    assert.equal(await resolveViaFmpByTicker("AAPL"), null);
  } finally {
    if (prev !== undefined) process.env.FMP_API_KEY = prev;
    if (prev2 !== undefined) process.env.FMP_TOKEN = prev2;
  }
});
