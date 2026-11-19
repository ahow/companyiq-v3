/**
 * 1.3 — ATTRIBUTION_TRUSTED_SOURCE_RESOLVE: publisher-provenance attribution +
 * framework trusted-source registry resolution. Default-off / behaviour-preserving.
 * node:test — run with:  npx tsx --test server/lib/attribution-trusted-source.test.ts
 * Trusted domains are FRAMEWORK DATA passed in; nothing hardcoded.
 */
// eligibility-flags transitively imports the pg pool at load time; a dummy URL is
// enough (no DB I/O — reviewQuoteAttribution is pure). Set BEFORE the dynamic
// import below so the test is runnable standalone (ESM hoists static imports, so a
// dynamic import is required for the assignment to take effect first).
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x";
import { test } from "node:test";
import assert from "node:assert/strict";
const { reviewQuoteAttribution } = await import("./eligibility-flags.js");
type CompanyIdentity = import("./eligibility-flags.js").CompanyIdentity;

const company: CompanyIdentity = {
  name: "Example Issuer PLC",
  domain: "example-issuer.com",
  // Framework-registered trusted-source registry domain (from config, not literal).
  frameworkTrustedDomains: ["registry.example-framework.org"],
};

const OWN_DOMAIN_QUOTE = {
  text: "A statement about governance with no first-party-sounding language whatsoever.",
  source: "Company site",
  sourceUrl: "https://www.example-issuer.com/sustainability/report",
};
const REGISTRY_QUOTE = {
  text: "A filing lodged with the authoritative framework registry.",
  source: "Registry filing",
  sourceUrl: "https://registry.example-framework.org/filings/12345",
};
const THIRD_PARTY_QUOTE = {
  text: "Example Issuer PLC said it has a dedicated board committee overseeing the programme.",
  source: "Reuters",
  sourceUrl: "https://www.reuters.com/business/example-issuer-story",
};

function reasonsFlag(on: boolean) {
  if (on) process.env.ATTRIBUTION_TRUSTED_SOURCE_RESOLVE = "1";
  else delete process.env.ATTRIBUTION_TRUSTED_SOURCE_RESOLVE;
  // Keep the legacy P2.4 third-party host gate off so we isolate 1.3's effect.
  delete process.env.P2_THIRD_PARTY_HOST_ATTRIBUTION_GATE;
}

test("flag ON → own-domain document is first-party by provenance", () => {
  reasonsFlag(true);
  const res = reviewQuoteAttribution([OWN_DOMAIN_QUOTE], company);
  assert.equal(res[0].attributedToTarget, true);
  assert.ok((res[0].reason || "").toLowerCase().includes("own domain"));
  reasonsFlag(false);
});

test("flag ON → framework trusted-source registry document is first-party by provenance", () => {
  reasonsFlag(true);
  const res = reviewQuoteAttribution([REGISTRY_QUOTE], company);
  assert.equal(res[0].attributedToTarget, true);
  assert.ok((res[0].reason || "").toLowerCase().includes("registry"));
  reasonsFlag(false);
});

test("flag ON → third-party host naming the company is NOT first-party (provenance authoritative)", () => {
  reasonsFlag(true);
  const res = reviewQuoteAttribution([THIRD_PARTY_QUOTE], company);
  assert.equal(res[0].attributedToTarget, false);
  reasonsFlag(false);
});

test("flag ON but empty framework registry → registry path is a pure no-op", () => {
  reasonsFlag(true);
  const noRegistry: CompanyIdentity = { name: company.name, domain: company.domain, frameworkTrustedDomains: [] };
  const res = reviewQuoteAttribution([REGISTRY_QUOTE], noRegistry);
  // registry.example-framework.org is not own-domain and not in an empty registry
  assert.equal(res[0].attributedToTarget, false);
  reasonsFlag(false);
});

test("flag OFF → registry/own-domain provenance path does not fire (behaviour preserved)", () => {
  reasonsFlag(false);
  const res = reviewQuoteAttribution([REGISTRY_QUOTE], company);
  // With the flag off, a plain registry URL whose text has no identity match is not
  // upgraded to first-party by the (disabled) provenance path.
  assert.equal(res[0].attributedToTarget, false);
});
