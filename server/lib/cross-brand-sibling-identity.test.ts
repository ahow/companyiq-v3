// 41-F identity gate for cross-brand sibling discovery (Method 1).
// Run: DATABASE_URL=postgres://x:y@localhost:1/z npx tsx --test server/lib/cross-brand-sibling-identity.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { shareIssuerIdentityToken } from "./discovery.js";
import { deriveAliases } from "./issuer-resolver.js";

const tokensFor = (name: string) => deriveAliases(name, null).filter(a => a.length >= 4);

test("token-sharing brand sibling is admitted (chase.com for JPMorgan Chase)", () => {
  const tokens = tokensFor("JPMorgan Chase & Co.");
  assert.ok(tokens.includes("chase"), `expected 'chase' in ${JSON.stringify(tokens)}`);
  assert.equal(shareIssuerIdentityToken("chase.com", tokens), true);
  assert.equal(shareIssuerIdentityToken("jpmorgan.com", tokens), true);
});

test("aggregator/portal hosts from live logs are rejected", () => {
  const tokens = tokensFor("JPMorgan Chase & Co.");
  for (const d of ["yahoo.com", "perplexity.ai", "spglobal.com", "globaldata.com", "scribd.com", "hkexnews.hk"]) {
    assert.equal(shareIssuerIdentityToken(d, tokens), false, d);
  }
});

test("no overlap / empty tokens => rejected", () => {
  assert.equal(shareIssuerIdentityToken("acmewidgets.com", tokensFor("Zentrix Holdings plc")), false);
  assert.equal(shareIssuerIdentityToken("chase.com", []), false);
  assert.equal(shareIssuerIdentityToken("", ["chase"]), false);
});

test("short tokens (<4 chars) never satisfy the gate", () => {
  assert.equal(shareIssuerIdentityToken("abcfinance.com", ["abc"]), false);
});
