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
  // Under R2: title tier fires first with name-token match on 'newmont'.
  // Ticker match still supported but title is checked first.
  assert.match(r.reason, /identity match on (name-token:newmont|ticker:NEM|name-tokens?)/);
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
  assert.match(r.reason, /no title\/URL\/content match/);
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
  // R2: rewording covers regulator + IR-platform + domain. Match the
  // generalised reason string that any host outside those classes yields.
  assert.match(r.reason, /does not match company domain, IR-platform or regulator host/);
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
  // R2: title tier fires first. Ticker match still permitted in title or
  // content; either is acceptable evidence of issuer identity.
  assert.match(r.reason, /identity match on (ticker:SAN|alias:santander|name-token)/);
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

test("Single-distinctive-token company requires 2 occurrences in content (case-study guard)", () => {
  // Newmont has one distinctive token ("newmont"). Under R2, a title/URL
  // occurrence would fire; this test intentionally keeps the title generic
  // and puts the sole occurrence in content — so only the content tier is
  // available and it needs 2 occurrences to fire.
  const r = classifyProvenance({
    url: "https://www.sec.gov/Archives/edgar/data/999/random.htm",
    title: "Unrelated filing",
    content: "This filing mentions newmont in a footnote about industry peers.",
    ...NEWMONT,
  });
  // Only 1 occurrence in content, and 0 in title/URL → third_party
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

// ─── R2: IR-platform / hosted-IR CDN tests ─────────────────────────────────
// These verify the new IR-platform host class introduced in R2. Covers:
//   • title-tier fire (primary signal per user steer)
//   • URL-path tier fire
//   • CIK-path exact match (strongest signal for Q4 Inc)
//   • wrong-issuer rejection (Q4 URL for a competitor)
//   • MZiQ Brazilian IR platform recognition
//   • tenant-UUID identifier extraction without match (no company-side value)
//   • title tier PRIMARY over content (title-primary contract)

test("R2: Q4 CDN with title identifying the issuer → issuer via title tier", () => {
  const r = classifyProvenance({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/newmont-2024-sustainability-report.pdf",
    title: "Newmont 2024 Sustainability Report",
    content: "",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /IR-platform \(Q4 Inc IR CDN\)/);
  assert.match(r.reason, /title identity match/);
  assert.equal(r.irPlatformHost, "Q4 Inc IR CDN");
  assert.equal(r.identitySignal, "title");
});

test("R2: Q4 CDN with title-tier failure but URL-path fire → issuer via url-path tier", () => {
  const r = classifyProvenance({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/newmont-2024-sustainability-report.pdf",
    title: "[PDF] 2024 Sustainability Report", // title lacks name-token
    content: "",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /url-path identity match/);
  assert.equal(r.identitySignal, "url-path");
});

test("R5c: Q4 CDN with title-identity match → issuer via title tier (Q4 tenant ID not treated as CIK)", () => {
  // Pre-R5c, this URL would have been rejected because 382246808 (Newmont's
  // Q4 tenant ID) doesn't equal Newmont's SEC CIK (1164727). R5c relabels
  // Q4 identifiers as `q4_tenant_id`, so the CIK-comparison branch is
  // skipped and identity is established via the title tier instead.
  const NEWMONT_WITH_CIK = { ...NEWMONT, companySecCik: "1164727" };
  const r = classifyProvenance({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/Newmont-2024-Sustainability-report-1.pdf",
    title: "Newmont 2024 Sustainability Report",
    content: "",
    ...NEWMONT_WITH_CIK,
  });
  assert.equal(r.provenance, "issuer");
  assert.equal(r.identitySignal, "title");
  assert.match(r.reason, /IR-platform \(Q4 Inc IR CDN\) \+ title identity match/);
});

test("R5c: Q4 CDN with WRONG title identity → third_party (sibling issuer URL surfaced by mistake)", () => {
  // Newmont-cohort search returns an Apple Q4 URL. Even though 382246808 is
  // a valid Q4 tenant ID for SOMEONE, the title clearly names another
  // company, so no identity tier matches Newmont → third_party.
  const NEWMONT_WITH_CIK = { ...NEWMONT, companySecCik: "1164727" };
  const r = classifyProvenance({
    url: "https://s24.q4cdn.com/320193/files/doc_downloads/apple-report.pdf",
    title: "Apple 2024 Annual Report", // strong Apple identity signal
    content: "",
    ...NEWMONT_WITH_CIK,
  });
  assert.equal(r.provenance, "third_party");
  assert.equal(r.irPlatformHost, "Q4 Inc IR CDN");
});

test("R2: Q4 CDN with no company-side CIK falls back to title/URL/content tiers", () => {
  // Newmont in the company row doesn't have companySecCik set. The path
  // extracts a CIK candidate but no comparison is possible — the classifier
  // should still find identity via the title tier and classify as issuer.
  const r = classifyProvenance({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/2024/random.pdf",
    title: "Newmont 2024 Sustainability Report",
    content: "",
    ...NEWMONT,
  });
  assert.equal(r.provenance, "issuer");
  assert.equal(r.identitySignal, "title");
});

test("R2: MZiQ (Brazilian IR CDN) with title identifying issuer → issuer", () => {
  const AMBEV = {
    companyName: "Ambev S.A.",
    companyDomain: "ambev.com.br",
    relatedDomains: ["ri.ambev.com.br"],
    companyTicker: "ABEV",
    companyAliases: ["ambev"],
  };
  const r = classifyProvenance({
    url: "https://api.mziq.com/mzfilemanager/v2/d/c8182463-4b7e-408c-9d0f-42797662435e/4856137f-de39-cf2f-a900-8114590d6230?origin=2",
    title: "Ambev Annual and Sustainability Report 2024",
    content: "",
    ...AMBEV,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /IR-platform \(MZiQ IR platform\)/);
  assert.equal(r.identitySignal, "title");
});

test("R2: MZiQ URL with no title/content signal → third_party (safe default)", () => {
  // We cannot verify tenant-UUID identity without a company-side value, so
  // an anonymous MZiQ URL should NOT be trusted as issuer just because its
  // hostname is on the IR-platform list.
  const AMBEV = {
    companyName: "Ambev S.A.",
    companyDomain: "ambev.com.br",
    relatedDomains: [],
    companyTicker: "ABEV",
    companyAliases: ["ambev"],
  };
  const r = classifyProvenance({
    url: "https://api.mziq.com/mzfilemanager/v2/d/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb/1234.pdf",
    title: "[PDF] Corporate report", // no identifying signal
    content: "",
    ...AMBEV,
  });
  assert.equal(r.provenance, "third_party");
  assert.equal(r.irPlatformHost, "MZiQ IR platform");
});

test("R2: title-primary contract — title identifies issuer even when content is missing", () => {
  // The most consequential R2 rule: with content=null the classifier must
  // still classify as issuer if the title identifies the company. This is
  // the pre-fetch classification case.
  const r = classifyProvenance({
    url: "https://www.hkexnews.hk/listedco/listconews/sehk/2025/0409/2025040900057.pdf",
    title: "Prudential plc Sustainability Report 2024",
    content: null,
    companyName: "Prudential plc",
    companyDomain: "prudentialplc.com",
    relatedDomains: ["prudential.com"],
    companyTicker: "PRU",
    companyAliases: ["prudential"],
  });
  assert.equal(r.provenance, "issuer");
  assert.equal(r.regulatorHost, "HKEX news");
  assert.equal(r.identitySignal, "title");
});

test("R2: title-primary — title fires FIRST when title matches AND content also matches a wrong entity", () => {
  // Edge case: a filing archived on hkexnews with the correct issuer title
  // but a body that happens to mention many companies (e.g. peer analysis).
  // The title-primary rule ensures we don't wait for content mis-attribution.
  const r = classifyProvenance({
    url: "https://www.hkexnews.hk/listedco/listconews/sehk/2025/example.pdf",
    title: "Prudential plc Sustainability Report 2024",
    content: "This report includes references to AIA, Manulife, and other peers throughout its peer benchmarks.",
    companyName: "Prudential plc",
    companyDomain: "prudentialplc.com",
    relatedDomains: [],
    companyTicker: "PRU",
    companyAliases: ["prudential"],
  });
  assert.equal(r.provenance, "issuer");
  assert.equal(r.identitySignal, "title");
});

// ─── R2 Rule 1b: brand-token-in-hostname ──────────────────────────────────
test("R2 Rule 1b: subsidiary hostname (unilevernepal.com) with brand token → issuer", () => {
  const UNILEVER = {
    companyName: "Unilever",
    companyDomain: "unilever.com",
    relatedDomains: [], // deliberately empty to force Rule 1b
    companyTicker: "UL",
    companyAliases: ["unilever"],
  };
  const r = classifyProvenance({
    url: "https://www.unilevernepal.com/legal-and-financial-resources/",
    title: "Legal and Financial Resources - Unilever Nepal",
    content: "",
    ...UNILEVER,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /brand-token "unilever" in hostname/);
});

test("R2 Rule 1b: subsidiary hostname (unileverconsumercarebd.com) → issuer", () => {
  const UNILEVER = {
    companyName: "Unilever",
    companyDomain: "unilever.com",
    relatedDomains: [],
    companyTicker: "UL",
    companyAliases: ["unilever"],
  };
  const r = classifyProvenance({
    url: "https://www.unileverconsumercarebd.com/investor-relations/",
    title: "Investor Relations | Unilever",
    content: "",
    ...UNILEVER,
  });
  assert.equal(r.provenance, "issuer");
});

test("R2 Rule 1b: brand-content CDN (santandermedia.com) → issuer", () => {
  const SANTANDER = {
    companyName: "Banco Santander",
    companyDomain: "santander.com",
    relatedDomains: [],
    companyTicker: "SAN",
    companyAliases: ["santander"],
  };
  const r = classifyProvenance({
    url: "https://assets.santandermedia.com/adobe/assets/x/y.pdf",
    title: "YE-25 SFS CLEAN",
    content: "",
    ...SANTANDER,
  });
  assert.equal(r.provenance, "issuer");
});

test("R2 Rule 1b: short brand tokens do NOT trigger the fallback (over-fire guard)", () => {
  // A company with 3-4 char distinctive tokens must not fire Rule 1b, which
  // requires >=5 chars to avoid matching arbitrary embedded 3-char runs.
  const NIKE = {
    companyName: "Nike",
    companyDomain: "nike.com",
    relatedDomains: [],
    companyTicker: "NKE",
    companyAliases: ["nike"],
  };
  const r = classifyProvenance({
    url: "https://nikeman.example.com/random.pdf",
    title: "random",
    content: "",
    ...NIKE,
  });
  assert.equal(r.provenance, "third_party"); // token "nike" < 5 chars
});

test("R2 Rule 1b: multi-token names do NOT trigger the fallback", () => {
  // A company with multiple distinctive tokens (e.g. Newmont Corporation →
  // 'newmont') has a single distinctive token, so Rule 1b WOULD fire. Test
  // a genuinely multi-token case (e.g. "General Electric") to confirm the
  // fallback is only used for the single-token case.
  const GE = {
    companyName: "General Electric",
    companyDomain: "ge.com",
    relatedDomains: [],
    companyTicker: "GE",
    companyAliases: ["general electric"],
  };
  const r = classifyProvenance({
    url: "https://electricsomething.example.com/page",
    title: "Something Electric",
    content: "",
    ...GE,
  });
  // 'general' and 'electric' are both generic tokens — the distinctive-token
  // list is empty. Rule 1b requires exactly 1 distinctive token of >=5 chars,
  // so this case must fall through to third_party.
  assert.equal(r.provenance, "third_party");
});

test("R2 Rule 1b: token embedded in unrelated word does NOT match", () => {
  const UNILEVER = {
    companyName: "Unilever",
    companyDomain: "unilever.com",
    relatedDomains: [],
    companyTicker: "UL",
    companyAliases: ["unilever"],
  };
  const r = classifyProvenance({
    // A host with 'unilever' embedded in the middle of a random segment.
    // This should NOT match because 'x-unilever-y' as a compound word
    // isn't a hyphen-bounded segment matching startsWith/endsWith rules.
    url: "https://nonunileveryeah.example.com/page",
    title: "random",
    content: "",
    ...UNILEVER,
  });
  // Segment 'nonunileveryeah' does not startsWith or endsWith 'unilever'.
  assert.equal(r.provenance, "third_party");
});

test("R2: rad.cvm.gov.br (Brazilian regulator) + title match → issuer", () => {
  const AMBEV = {
    companyName: "Ambev S.A.",
    companyDomain: "ambev.com.br",
    relatedDomains: [],
    companyTicker: "ABEV",
    companyAliases: ["ambev"],
  };
  const r = classifyProvenance({
    url: "http://rad.cvm.gov.br/enet/frmDownloadDocumento.aspx?CodigoInstituicao=1&NumeroSequencialDocumento=12345",
    title: "Ambev S.A. Formul\u00e1rio de Refer\u00eancia 2024",
    content: "",
    ...AMBEV,
  });
  assert.equal(r.provenance, "issuer");
  assert.match(r.reason, /CVM \(Brazil\)/);
  assert.equal(r.identitySignal, "title");
});

// ─── R5c: IR-platform tenant propagation ─────────────────────────────────────

test("R5c: sibling Q4 URL is accepted via tenant cache after first-touch title match", () => {
  // Newmont's Sustainability Report has "Newmont" in the title, but the
  // biodiversity-approach paper doesn't (only in the filename). Pre-R5c the
  // biodiversity paper would land as third_party. With R5c, the tenant cache
  // populated by the SR's title match lets the biodiversity paper propagate.
  const cp = classifyProvenance;
  const knownIrTenants = new Map();
  // First URL: title contains "Newmont" → title-tier identity match, binds tenant
  const r1 = cp({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/Newmont-2024-Sustainability-report-1.pdf",
    title: "Newmont 2024 Sustainability Report",
    content: "",
    ...NEWMONT,
    knownIrTenants,
  });
  assert.equal(r1.provenance, "issuer");
  assert.equal(r1.identitySignal, "title");
  assert.equal(r1.boundIrTenant?.platform, "Q4 Inc IR CDN");
  assert.equal(r1.boundIrTenant?.tenantId, "382246808");
  assert.equal(knownIrTenants.size, 1);

  // Second URL on same tenant with NO title identity signal — accepted via cache
  const r2 = cp({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/priority-topics/2025/biodiversity-approach.pdf",
    title: "priority topics biodiversity",
    content: "",
    ...NEWMONT,
    knownIrTenants,
  });
  assert.equal(r2.provenance, "issuer");
  assert.equal(r2.identitySignal, "tenant-match");
  assert.match(r2.reason, /tenant-cache hit 382246808/);
  // No new binding since one already exists
  assert.equal(r2.boundIrTenant, undefined);
});

test("R5c: tenant cache is per-company — a different company cannot borrow another's binding", () => {
  const cp = classifyProvenance;
  const knownIrTenants = new Map();
  // Newmont writes the binding
  cp({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/Newmont-2024-Sustainability-report-1.pdf",
    title: "Newmont 2024 Sustainability Report",
    content: "",
    ...NEWMONT,
    knownIrTenants,
  });
  assert.equal(knownIrTenants.size, 1);

  // Kering happens to have a URL on the SAME Q4 tenant (this doesn't happen
  // in practice, but the guard is what makes cross-company reuse impossible).
  const r = cp({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/kering-policy.pdf",
    title: "Kering environmental policy",
    content: "",
    ...KERING,
    knownIrTenants,
  });
  // Kering's URL has its OWN title identity match to "Kering", so it lands
  // as issuer via title — NOT via the Newmont tenant cache. This proves the
  // company-match guard in `companyMatchesBinding` correctly rejects the
  // cross-company cache hit before falling through to fresh identity check.
  assert.equal(r.provenance, "issuer");
  assert.equal(r.identitySignal, "title");
});

test("R5c: no cache provided → old behaviour preserved (Q4 tenant without identity → third_party)", () => {
  const cp = classifyProvenance;
  const r = cp({
    url: "https://s24.q4cdn.com/382246808/files/doc_downloads/anonymous.pdf",
    title: "random report",
    content: "",
    ...NEWMONT,
    // knownIrTenants intentionally omitted
  });
  assert.equal(r.provenance, "third_party");
  assert.equal(r.irPlatformHost, "Q4 Inc IR CDN");
});

test("R5c: tenant cache with wrong tenant ID does not match", () => {
  const cp = classifyProvenance;
  const knownIrTenants = new Map();
  // Bind Newmont's real tenant
  cp({
    url: "https://s24.q4cdn.com/382246808/files/newmont.pdf",
    title: "Newmont 2024 Report",
    content: "",
    ...NEWMONT,
    knownIrTenants,
  });
  // A DIFFERENT tenant on same Q4 platform → no cache hit, no title/URL/
  // content signal (title says "Newmont" — actually it would match... let's
  // use a title that DOESN'T match to isolate the cache-key mismatch check)
  const r = cp({
    url: "https://s24.q4cdn.com/999999/files/random.pdf",
    title: "random",
    content: "",
    ...NEWMONT,
    knownIrTenants,
  });
  assert.equal(r.provenance, "third_party");
  assert.equal(r.identitySignal, "none");
});
