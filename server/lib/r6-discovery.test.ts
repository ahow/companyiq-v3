import { describe, it, expect } from "vitest";
import {
  extractIRPlatformTenants,
  buildIRPlatformSeedQueries,
  buildLocaleTopicQueries,
  buildRegulatorRepositoryUrls,
  buildJurisdictionDocTypeQueries,
  isEsgLandingPage,
  extractLandingPageLinks,
  buildSubpageEnumerationQueries,
  parseSitemapForSubpaths,
} from "./r6-discovery.js";

describe("R6a — IR-platform tenant extraction", () => {
  it("extracts Q4Inc tenant from s24.q4cdn.com URL", () => {
    const tenants = extractIRPlatformTenants([
      "https://s24.q4cdn.com/382246808/files/doc_downloads/sustainability/2025/newmont-2024-sustainability-report.pdf",
    ]);
    expect(tenants).toEqual([{ platform: "q4inc", tenant: "382246808" }]);
  });

  it("dedupes tenants across multiple URLs", () => {
    const tenants = extractIRPlatformTenants([
      "https://s24.q4cdn.com/382246808/files/doc_downloads/A.pdf",
      "https://s24.q4cdn.com/382246808/files/doc_downloads/B.pdf",
      "https://s24.q4cdn.com/382246808/press/C.pdf",
    ]);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toEqual({ platform: "q4inc", tenant: "382246808" });
  });

  it("ignores non-IR-platform URLs", () => {
    const tenants = extractIRPlatformTenants([
      "https://www.newmont.com/investors/reports/",
      "https://sec.gov/Archives/edgar/data/1164727/000110465924082861/tm2419639-1_s4.htm",
    ]);
    expect(tenants).toEqual([]);
  });

  it("builds seed queries from persisted tenants", () => {
    const queries = buildIRPlatformSeedQueries("Newmont Corporation", [{ platform: "q4inc", tenant: "382246808" }], ["biodiversity", "nature"]);
    // Should include: direct site: query + topic-scoped variants
    expect(queries.some(q => q.includes("site:q4cdn.com/382246808/"))).toBe(true);
    expect(queries.some(q => q.includes("biodiversity"))).toBe(true);
  });

  it("bootstraps missing platforms on first run", () => {
    const queries = buildIRPlatformSeedQueries("Some Company", [], ["climate"]);
    // No persisted tenants but should still emit bootstrap queries per known platform
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some(q => q.includes("site:q4cdn.com") && q.includes("\"Some Company\""))).toBe(true);
  });
});

describe("R6b — Locale topic queries", () => {
  it("returns Spanish topic queries for ES country", () => {
    const queries = buildLocaleTopicQueries("Banco Santander", "ES", "santander.com");
    expect(queries.some(q => q.includes("sostenibilidad"))).toBe(true);
    expect(queries.some(q => q.startsWith("site:santander.com "))).toBe(true);
  });

  it("returns Portuguese topic queries for BR country", () => {
    const queries = buildLocaleTopicQueries("Ambev", "BR", "ambev.com.br");
    expect(queries.some(q => q.includes("sustentabilidade"))).toBe(true);
  });

  it("returns nothing when country unknown", () => {
    const queries = buildLocaleTopicQueries("Xyz", null, null);
    expect(queries).toEqual([]);
  });
});

describe("R6c — Regulator repositories", () => {
  it("emits ESEF filings URL for EU LEI-known issuer", () => {
    const urls = buildRegulatorRepositoryUrls({
      companyName: "Kering",
      lei: "549300VGEJKB7SVUZR78",
      country: "France",
      isin: "FR0000121485",
    });
    expect(urls.some(u => u.url.startsWith("https://filings.xbrl.org/549300VGEJKB7SVUZR78/"))).toBe(true);
  });

  it("emits HKEX search URL for Prudential plc pattern", () => {
    const urls = buildRegulatorRepositoryUrls({
      companyName: "Prudential plc",
      lei: null,
      country: "GB",
      isin: "GB0007099541",
    });
    expect(urls.some(u => u.url.includes("hkexnews.hk"))).toBe(true);
  });

  it("returns empty for non-EU non-HK non-CA-AU issuer with no LEI", () => {
    const urls = buildRegulatorRepositoryUrls({
      companyName: "US Company",
      lei: null,
      country: "US",
      isin: "US0000000000",
    });
    expect(urls).toEqual([]);
  });
});

describe("R6d — Jurisdiction doc-type queries", () => {
  it("emits CSRD sustainability-statement query for CH issuer (Nestlé)", () => {
    const queries = buildJurisdictionDocTypeQueries({
      companyName: "Nestlé",
      effectiveDomain: "nestle.com",
      country: "CH",
      isin: "CH0038863350",
    });
    expect(queries.some(q => q.includes("\"sustainability statement\""))).toBe(true);
    expect(queries.some(q => q.includes("\"non-financial statement\""))).toBe(true);
  });

  it("emits section 172 statement for UK issuer", () => {
    const queries = buildJurisdictionDocTypeQueries({
      companyName: "Prudential plc",
      effectiveDomain: "prudentialplc.com",
      country: "GB",
      isin: "GB0007099541",
    });
    expect(queries.some(q => q.toLowerCase().includes("section 172 statement"))).toBe(true);
  });
});

describe("R6e — ESG landing page detection", () => {
  it("recognises common ESG hub paths", () => {
    expect(isEsgLandingPage("https://corporate.walmart.com/purpose/esgreport/")).toBe(true);
    expect(isEsgLandingPage("https://www.nestle.com/sustainability/nature-environment/")).toBe(true);
    expect(isEsgLandingPage("https://www.hp.com/impact/")).toBe(true);
    expect(isEsgLandingPage("https://apple.com/environment/")).toBe(true);
  });

  it("rejects non-ESG URLs", () => {
    expect(isEsgLandingPage("https://corporate.walmart.com/news/2024/press-release")).toBe(false);
    expect(isEsgLandingPage("https://sec.gov/Archives/edgar/data/104169/000010416919000016/wmtform10-kx1312019.htm")).toBe(false);
  });
});

describe("R6e — Link extraction from landing page HTML", () => {
  const landing = "https://corporate.walmart.com/purpose/esgreport/";
  const html = `
    <html><body>
      <a href="/purpose/esgreport/regeneration-of-natural-resources">Regeneration</a>
      <a href="/purpose/esgreport/climate">Climate</a>
      <a href="/content/dam/corporate/documents/esgreport/2026/FY2026-Walmart-ESG-Report.pdf">FY26 Report</a>
      <a href="https://external.com/thing">External</a>
      <a href="mailto:info@walmart.com">Contact</a>
      <a href="#top">Top</a>
    </body></html>
  `;

  it("extracts same-origin subpages under landing parent", () => {
    const links = extractLandingPageLinks({ landingUrl: landing, html, maxLinks: 20 });
    expect(links.some(l => l.hint === "subpage" && l.url.includes("regeneration-of-natural-resources"))).toBe(true);
    expect(links.some(l => l.hint === "subpage" && l.url.includes("/climate"))).toBe(true);
  });

  it("extracts DAM PDF links", () => {
    const links = extractLandingPageLinks({ landingUrl: landing, html, maxLinks: 20 });
    expect(links.some(l => (l.hint === "pdf" || l.hint === "dam") && l.url.includes("FY2026-Walmart-ESG-Report.pdf"))).toBe(true);
  });

  it("excludes external, mailto, and anchor links", () => {
    const links = extractLandingPageLinks({ landingUrl: landing, html, maxLinks: 20 });
    expect(links.some(l => l.url.includes("external.com"))).toBe(false);
    expect(links.some(l => l.url.startsWith("mailto:"))).toBe(false);
    expect(links.some(l => l.url.endsWith("#top"))).toBe(false);
  });
});

describe("R6f — Sub-page enumeration queries", () => {
  it("builds site:host inurl:parent-path topic queries", () => {
    const queries = buildSubpageEnumerationQueries(
      "https://corporate.walmart.com/purpose/esgreport/",
      ["biodiversity", "nature", "climate"],
    );
    expect(queries.some(q => q.includes("site:corporate.walmart.com") && q.includes("inurl:/purpose/esgreport") && q.includes("biodiversity"))).toBe(true);
  });

  it("returns empty for URL with no parent path", () => {
    const queries = buildSubpageEnumerationQueries("https://example.com/", ["topic"]);
    expect(queries).toEqual([]);
  });
});

describe("R6f — Sitemap parsing", () => {
  const sitemap = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://corporate.walmart.com/purpose/esgreport/climate</loc></url>
      <url><loc>https://corporate.walmart.com/purpose/esgreport/nature</loc></url>
      <url><loc>https://corporate.walmart.com/news/press-release</loc></url>
    </urlset>`;

  it("returns only URLs under the given parent path", () => {
    const urls = parseSitemapForSubpaths(sitemap, "/purpose/esgreport");
    expect(urls).toHaveLength(2);
    expect(urls.every(u => u.includes("esgreport"))).toBe(true);
  });
});
