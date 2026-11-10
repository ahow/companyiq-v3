// (A) FMP anchor-derivation unit tests — the durable provenance fix (§4.1).
// Run: node --import tsx --test server/lib/fmp-anchors.test.ts
//
// Proves the 3M root-cause fix end-to-end at the unit level: a company with
// BLANK native domain/ticker/related_domains but a resolved fmp_website /
// fmp_symbol has anchors derived from the FMP identity, so classifyProvenance()
// Rule 1 (the deterministic host match) fires and the issuer's own documents
// classify issuer -> first_party.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFmpAnchors, registrableDomain } from "./fmp-resolver.js";
import { classifyProvenance, provenanceToSourceType } from "./provenance.js";

// The exact 3M production state (3m_corpus note §1): native anchors blank,
// FMP identity resolved.
const THREE_M_FMP = {
  nativeDomain: null as string | null,
  nativeTicker: null as string | null,
  relatedDomains: [] as string[],
  fmpWebsite: "https://www.3m.com",
  fmpSymbol: "MMM",
};

test("registrableDomain — strips www and reduces to eTLD+1", () => {
  assert.equal(registrableDomain("www.3m.com"), "3m.com");
  assert.equal(registrableDomain("investors.3m.com"), "3m.com");
  assert.equal(registrableDomain("multimedia.3m.com"), "3m.com");
  assert.equal(registrableDomain("3m.co.uk"), "3m.co.uk"); // two-part ccTLD
  assert.equal(registrableDomain(""), null);
});

test("deriveFmpAnchors — fills blank domain/ticker and unions fmp host (3M)", () => {
  const a = deriveFmpAnchors(THREE_M_FMP);
  assert.equal(a.changed, true);
  assert.equal(a.domain, "3m.com");
  assert.equal(a.ticker, "MMM");
  assert.ok(a.relatedDomains && a.relatedDomains.includes("3m.com"));
});

test("deriveFmpAnchors — NEVER overwrites a resolved native domain", () => {
  const a = deriveFmpAnchors({
    nativeDomain: "existing-domain.com",
    nativeTicker: "XYZ",
    relatedDomains: ["existing-domain.com"],
    fmpWebsite: "https://www.3m.com",
    fmpSymbol: "MMM",
  });
  // domain and ticker are already set natively — must NOT be changed.
  assert.equal(a.domain, undefined);
  assert.equal(a.ticker, undefined);
  // The fmp host is still unioned additively into related_domains.
  assert.ok(a.relatedDomains && a.relatedDomains.includes("3m.com"));
  assert.ok(a.relatedDomains && a.relatedDomains.includes("existing-domain.com"));
});

test("deriveFmpAnchors — no change when fmp host already present and anchors set", () => {
  const a = deriveFmpAnchors({
    nativeDomain: "3m.com",
    nativeTicker: "MMM",
    relatedDomains: ["3m.com"],
    fmpWebsite: "https://www.3m.com",
    fmpSymbol: "MMM",
  });
  assert.equal(a.changed, false);
  assert.equal(a.relatedDomains, undefined);
});

// ─── The end-to-end provenance outcome the fix is for ──────────────────────────

function classifyWithAnchors(url: string, title: string) {
  const a = deriveFmpAnchors(THREE_M_FMP);
  const effectiveDomain = THREE_M_FMP.nativeDomain || a.domain || "";
  const effectiveRelated = a.relatedDomains ?? THREE_M_FMP.relatedDomains;
  const effectiveTicker = THREE_M_FMP.nativeTicker || a.ticker || null;
  return classifyProvenance({
    url,
    title,
    content: null,
    companyDomain: effectiveDomain,
    relatedDomains: effectiveRelated,
    companyName: "3M COMPANY",
    companyTicker: effectiveTicker,
    companyAliases: ["3m"],
    companyIsin: "US88579Y1010",
  });
}

test("3M annual report on investors.3m.com → issuer → first_party (was third_party)", () => {
  const r = classifyWithAnchors(
    "https://investors.3m.com/financials/annual-reports/mmm4298631-ars.pdf",
    "3M 2024 Annual Report",
  );
  assert.equal(r.provenance, "issuer");
  assert.equal(provenanceToSourceType(r.provenance), "first_party");
});

test("3M 10-K on www.3m.com → issuer → first_party", () => {
  const r = classifyWithAnchors("https://www.3m.com/investor/mmm-20251231.htm", "3M 10-K");
  assert.equal(r.provenance, "issuer");
  assert.equal(provenanceToSourceType(r.provenance), "first_party");
});

// Isolates the Rule 1 value of fix (A) honestly. For 3M specifically, the 2-char
// short-token rescue (Rule 1a (ii), live since 2026-11-02) now also rescues
// "3m.com" from the name token "3m", so blank anchors no longer misclassify 3M by
// themselves. To prove Rule 1 is what the FMP anchor restores — independent of the
// short-token rescue — we use an issuer whose NAME does not appear in its domain,
// so ONLY a derived domain anchor can make the host match fire.
const OPAQUE_ISSUER_FMP = {
  nativeDomain: null as string | null,
  nativeTicker: null as string | null,
  relatedDomains: [] as string[],
  fmpWebsite: "https://www.contoso-labs.com",
  fmpSymbol: "CTSO",
};

test("WITHOUT the fix: an issuer whose name ≠ its domain misclassifies third_party", () => {
  // Blank native anchors, and the name shares no token with the host, so neither
  // Rule 1 nor the short-token rescue can fire → the issuer's own filing is
  // mis-tagged third_party. This is the class of failure fix (A) removes.
  const r = classifyProvenance({
    url: "https://ir.contoso-labs.com/annual-reports/2024-ar.pdf",
    title: "2024 Annual Report",
    content: null,
    companyDomain: "",
    relatedDomains: [],
    companyName: "Acme Holdings Corporation",
    companyTicker: null,
    companyAliases: [],
    companyIsin: "US0000000000",
  });
  assert.equal(r.provenance, "third_party");
});

test("WITH the fix: FMP-derived domain anchor makes Rule 1 fire → issuer", () => {
  const a = deriveFmpAnchors(OPAQUE_ISSUER_FMP);
  const r = classifyProvenance({
    url: "https://ir.contoso-labs.com/annual-reports/2024-ar.pdf",
    title: "2024 Annual Report",
    content: null,
    companyDomain: a.domain || "",
    relatedDomains: a.relatedDomains ?? [],
    companyName: "Acme Holdings Corporation",
    companyTicker: a.ticker || null,
    companyAliases: [],
    companyIsin: "US0000000000",
  });
  assert.equal(r.provenance, "issuer");
  assert.equal(provenanceToSourceType(r.provenance), "first_party");
});

test("A third-party host (news site) stays third_party even with FMP anchors", () => {
  const r = classifyWithAnchors("https://www.reuters.com/markets/3m-earnings", "3M earnings coverage");
  assert.equal(r.provenance, "third_party");
  assert.equal(provenanceToSourceType(r.provenance), "third_party");
});
