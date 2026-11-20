/**
 * 1.3b — ATTRIBUTION_FAIL_OPEN_WHEN_NO_TRUSTED_DATA: the resolver fails OPEN at the
 * terminal "could-not-determine" rejections (F-prototype bare name-mention, and the
 * final fallthrough) so a company's OWN-published document is not wrongly rejected
 * when no per-company trusted/own-domain data was available to confirm provenance.
 * Default-off / behaviour-preserving. Negative-signal rejections (third-party host,
 * subsidiary, etc.) are unaffected. Nothing hardcoded.
 * node:test — run with:  node --import tsx --test server/lib/attribution-fail-open.test.ts
 */
// eligibility-flags transitively imports the pg pool at load time; a dummy URL is
// enough (no DB I/O — reviewQuoteAttribution is pure). Set BEFORE the dynamic import.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x";
import { test } from "node:test";
import assert from "node:assert/strict";
const { reviewQuoteAttribution } = await import("./eligibility-flags.js");
type CompanyIdentity = import("./eligibility-flags.js").CompanyIdentity;

// Company whose stored `domain` does NOT cover the host of its own published docs,
// and with NO relatedDomains available — the exact production shape (the resolver
// has no per-company own-domain data that matches the quote host).
const companyNoTrustedData: CompanyIdentity = {
  name: "Example Issuer PLC",
  domain: "example-issuer.be", // regional registration domain, not the group host
  relatedDomains: null,
};
// Same company WITH its group domain declared in relatedDomains → own-domain match.
const companyWithOwnDomain: CompanyIdentity = {
  ...companyNoTrustedData,
  relatedDomains: ["example-issuergroup.eu"],
};

// Own published document, hosted on the issuer's group site, naming the issuer.
const OWN_DOC_QUOTE = {
  text: "Identification of the events has been performed considering materiality in the Example Issuer geographical footprint.",
  source: "Example Issuer Group Disclosure (Pillar III)",
  sourceUrl: "https://www.example-issuergroup.eu/documents/en/investors/disclosure-2024.pdf",
};
// Own document whose passage does NOT name the issuer (bare, no first-party language).
const OWN_DOC_NO_NAME_QUOTE = {
  text: "At counterparty level, a physical scoring system generates scores based on hazard thresholds.",
  source: "Example Issuer Group Disclosure (Pillar III)",
  sourceUrl: "https://www.example-issuergroup.eu/documents/en/investors/disclosure-2024.pdf",
};
// Genuine THIRD-PARTY document (analyst/news host) — must STILL be rejected.
const THIRD_PARTY_QUOTE = {
  text: "Example Issuer climate data aggregated by our analysts.",
  source: "Morningstar Report",
  sourceUrl: "https://www.morningstar.com/stocks/example-issuer-esg.html",
};

// Isolate the relevant env so each scenario is deterministic regardless of ambient env.
function setEnv(opts: { failOpen?: boolean; fProto?: boolean }) {
  if (opts.failOpen) process.env.ATTRIBUTION_FAIL_OPEN_WHEN_NO_TRUSTED_DATA = "on";
  else delete process.env.ATTRIBUTION_FAIL_OPEN_WHEN_NO_TRUSTED_DATA;
  if (opts.fProto) process.env.ADMISSION_GATE_PROTOTYPE = "on";
  else delete process.env.ADMISSION_GATE_PROTOTYPE;
  // Keep other optional strictness flags at their compiled defaults for isolation.
  delete process.env.ATTRIBUTION_TRUSTED_SOURCE_RESOLVE;
}

const attributed = (r: Array<{ attributedToTarget: boolean }>) => r.filter((x) => x.attributedToTarget).length;

test("own-domain doc is positively recognised (flag OFF) — unchanged behaviour", () => {
  setEnv({ failOpen: false, fProto: false });
  const r = reviewQuoteAttribution([OWN_DOC_QUOTE], companyWithOwnDomain, null);
  assert.equal(r[0].attributedToTarget, true);
  assert.match(r[0].reason || "", /own domain/i);
});

test("genuine third-party doc is STILL rejected even with fail-open flag ON", () => {
  setEnv({ failOpen: true, fProto: false });
  const r = reviewQuoteAttribution([THIRD_PARTY_QUOTE], companyNoTrustedData, null);
  assert.equal(r[0].attributedToTarget, false);
  assert.match(r[0].reason || "", /third-party/i);
});

test("third-party doc still rejected with fail-open AND F-prototype both ON", () => {
  setEnv({ failOpen: true, fProto: true });
  const r = reviewQuoteAttribution([THIRD_PARTY_QUOTE], companyNoTrustedData, null);
  assert.equal(r[0].attributedToTarget, false);
  assert.match(r[0].reason || "", /third-party/i);
});

test("empty trusted data + F-prototype: flag OFF fails CLOSED (today's bug)", () => {
  setEnv({ failOpen: false, fProto: true });
  // Production shape: own docs, no own-domain match, F-prototype removes the bare
  // name-mention acceptance → every quote rejected → attributedCount 0 → gate fires.
  const r = reviewQuoteAttribution([OWN_DOC_QUOTE, OWN_DOC_NO_NAME_QUOTE], companyNoTrustedData, null);
  assert.equal(attributed(r), 0);
});

test("empty trusted data + F-prototype: flag ON fails OPEN (fix) — own docs accepted", () => {
  setEnv({ failOpen: true, fProto: true });
  const r = reviewQuoteAttribution([OWN_DOC_QUOTE, OWN_DOC_NO_NAME_QUOTE], companyNoTrustedData, null);
  assert.equal(attributed(r), 2);
  // Named passage: fail-open on the name-mention path.
  assert.match(r[0].reason || "", /fail-open/i);
  // Un-named passage: fail-open on the terminal fallthrough.
  assert.match(r[1].reason || "", /fail-open/i);
});

test("fail-open flag does not change a quote that already attributes by own-domain", () => {
  setEnv({ failOpen: true, fProto: false });
  const r = reviewQuoteAttribution([OWN_DOC_QUOTE], companyWithOwnDomain, null);
  assert.equal(r[0].attributedToTarget, true);
  // Own-domain match wins before the fail-open fallthrough is reached.
  assert.match(r[0].reason || "", /own domain/i);
});
