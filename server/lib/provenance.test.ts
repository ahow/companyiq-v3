// U17 — provenance classifier unit tests.
// Run: npx tsx --test server/lib/provenance.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProvenance } from "./provenance.js";

const NEWMONT = {
  companyName: "Newmont Corporation",
  companyDomain: "newmont.com",
  relatedDomains: ["operations.newmont.com"],
  companyTicker: "NEM",
  companyAliases: ["newmont"],
};

const KERING = {
  companyName: "Kering",
  companyDomain: "kering.com",
  relatedDomains: [],
  companyTicker: "KER",
  companyAliases: ["kering"],
};

test("issuer domain match — direct newmont.com", () => {
  const r = classifyProvenance({
    url: "https://www.newmont.com/sustainability/environment/default.aspx",
    title: "Sustainability - Environment",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /hostname matches company domain/);
});

test("issuer domain match — related domain", () => {
  const r = classifyProvenance({
    url: "https://operations.newmont.com/tanami/sustainability.pdf",
    title: "Tanami operations sustainability report",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /hostname matches company domain/);
});

test("issuer domain match — subdomain of company domain", () => {
  // Even if not listed in related_domains, a subdomain of the primary domain
  // matches. Newmont's `sustainability.newmont.com` should classify as issuer.
  const r = classifyProvenance({
    url: "https://sustainability.newmont.com/",
    title: "Newmont sustainability",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
});

test("SEC EDGAR + ticker match → issuer", () => {
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/1164727/000155837025003000/nem-20250430xdef14a.htm",
    title: "Newmont Corporation DEF 14A",
    content: "Newmont Corporation (Ticker: NEM) files this proxy statement...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /SEC EDGAR/);
  assert.match(r.reason, /ticker:NEM/);
  assert.equal(r.regulatorHost, "SEC EDGAR");
});

test("SEC EDGAR without any identity match → third_party", () => {
  // A random SEC filing that got surfaced but has nothing to do with Newmont.
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
    title: "Apple Inc. 10-K",
    content: "Apple Inc. (Ticker: AAPL) files this annual report... The Company designs...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "third_party");
  assert.match(r.reason, /SEC EDGAR/);
  assert.match(r.reason, /no ticker\/alias\/name-token match/);
});

test("Australian Modern Slavery Register + name match → issuer", () => {
  const r = classifyProvenance({
    url: "https://modernslaveryregister.gov.au/statements/Buhkx6gtXBGS6I0/pdf/",
    title: "Newmont",
    content: "Modern Slavery Statement 2024 - Newmont Corporation and its subsidiaries...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /Modern Slavery Register/);
});

test("Australian Modern Slavery Register + wrong company name → third_party", () => {
  // Another company's statement surfaced under Newmont.
  const r = classifyProvenance({
    url: "https://modernslaveryregister.gov.au/statements/xxxxx/pdf/",
    title: "BHP Group Modern Slavery Statement 2024",
    content: "BHP Group Limited Modern Slavery Statement...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "third_party");
});

test("SEDAR+ Canadian filing + name-token match → issuer", () => {
  const r = classifyProvenance({
    url: "https://www.sedarplus.ca/csa-party/records/document.html?id=abc123",
    title: "Kering Annual Report",
    content: "Kering (Paris: KER) files this Canadian regulatory disclosure. Kering’s sustainability commitments...",
    ...KERING,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /SEDAR/);
});

test("HKEX news + Chinese-company identity match", () => {
  // Samsung on HKEX would be unusual, but a Hong Kong-listed issuer's own
  // filing on hkexnews.hk should classify as issuer.
  const r = classifyProvenance({
    url: "https://www1.hkexnews.hk/listedco/latestinfo/example.pdf",
    title: "Kering plc HKEX 2024 filing",
    content: "Kering annual disclosure to Hong Kong Exchange. Ticker: KER. Kering group...",
    ...KERING,
  });
  assert.equal(r.provenance, "issuer");
});

test("Proteus training PDF (real Newmont contamination case) → third_party", () => {
  // The actual document that caused Newmont measure 1.4 / 2.4 misfires.
  const r = classifyProvenance({
    url: "https://www.proteuspartners.org/content/uploads/2022/12/Biodiversity-management_3hr.pdf",
    title: "Newmont", // this is the mis-title in the DB
    content: "IBAT... A web-based map & reporting tool that provides fast, easy & integrated access to critical biodiversity information...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "third_party");
  assert.match(r.reason, /not a known regulator host/);
});

test("Third-party news site → third_party", () => {
  const r = classifyProvenance({
    url: "https://www.reuters.com/business/newmont-earnings-2025-05-15/",
    title: "Newmont reports Q1 2025 earnings",
    content: "Newmont Corp reported earnings...",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "third_party");
});

test("Generic-token-only company: 'Bank' alone doesn't identify Santander", () => {
  const SANTANDER = {
    companyName: "Banco Santander",
    companyDomain: "santander.com",
    relatedDomains: ["santander.co.uk"],
    companyTicker: "SAN",
    companyAliases: ["santander"],
  };
  // A random SEC filing about a US bank should not classify as Santander
  // just because the word "bank" appears in generic banking language.
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/999999/some-random-bank-filing.htm",
    title: "First National Community Bank 10-Q",
    content: "First National Community Bank filed this quarterly report... banking operations...",
    ...SANTANDER,
  });
  assert.equal(r.provenance, "third_party");
});

test("Genuine Santander SEC filing → issuer", () => {
  const SANTANDER = {
    companyName: "Banco Santander",
    companyDomain: "santander.com",
    relatedDomains: ["santander.co.uk", "santanderus.com"],
    companyTicker: "SAN",
    companyAliases: ["santander"],
  };
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/891478/000089147825000010/santander-20241231.htm",
    title: "Banco Santander S.A. Form 20-F",
    content: "Banco Santander (NYSE: SAN) filed this annual report...",
    ...SANTANDER,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /ticker:SAN/);
});

test("URL parse failure returns third_party with reason", () => {
  const r = classifyProvenance({
    url: "not-a-url",
    title: "Nothing",
    content: "",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "third_party");
});

test("Single-distinctive-token company requires 2 occurrences", () => {
  // Newmont has one distinctive token ("newmont"). One occurrence should
  // NOT alone match — protects against a stray mention in an unrelated doc.
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/999/random.htm",
    title: "Unrelated filing",
    content: "This filing mentions newmont in a footnote about industry peers.",
    ...NEWMONT,
  });
  // Only 1 occurrence + no ticker match → should be third_party
  assert.equal(r.provenance, "third_party");
});

test("Single-distinctive-token company: 2+ occurrences match", () => {
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/1164727/newmont-10k.htm",
    title: "Newmont Corporation Form 10-K",
    content: "Newmont Corporation... Newmont's mining operations... signed by Newmont's CEO.",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
});
