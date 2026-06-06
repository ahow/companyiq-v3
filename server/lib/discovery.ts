import axios from "axios";
import * as storage from "../storage.js";
import { completeWithFallback } from "./ai-providers.js";
import type { Framework, TrustedSource } from "../../shared/schema.js";

const MAX_DOCS_RETURNED = 60;
const PRE_GATE_CAP = 120;
const SEARCH_TIMEOUT = 15000;

// ─── Search API Keys ────────────────────────────────────────────────────────

function getSerperApiKey(): string | null {
  return process.env.SERPER_API_KEY || null;
}

function getSerpApiKey(): string | null {
  return process.env.SERP_API_KEY || null;
}

// ─── Search Provider (Serper.dev primary, SerpAPI fallback) ─────────────────

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

async function webSearchSerper(
  query: string,
  apiKey: string,
  opts: { num?: number; tbs?: string } = {}
): Promise<SearchResult[]> {
  const body: any = {
    q: query,
    num: opts.num || 10,
  };
  // Map tbs (time-based search) to Serper's tbs parameter
  if (opts.tbs) body.tbs = opts.tbs;

  const response = await axios.post("https://google.serper.dev/search", body, {
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    timeout: SEARCH_TIMEOUT,
  });

  const organic = response.data.organic || [];
  return organic.map((r: any, idx: number) => ({
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
    position: r.position || idx + 1,
  }));
}

async function webSearchSerpApi(
  query: string,
  apiKey: string,
  opts: { num?: number; tbs?: string } = {}
): Promise<SearchResult[]> {
  const params: any = {
    q: query,
    api_key: apiKey,
    engine: "google",
    num: opts.num || 10,
  };
  if (opts.tbs) params.tbs = opts.tbs;

  const response = await axios.get("https://serpapi.com/search.json", {
    params,
    timeout: SEARCH_TIMEOUT,
  });

  const organic = response.data.organic_results || [];
  return organic.map((r: any, idx: number) => ({
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
    position: r.position || idx + 1,
  }));
}

async function webSearch(
  query: string,
  opts: { num?: number; tbs?: string } = {}
): Promise<SearchResult[]> {
  // Try Serper.dev first (cheaper, faster), fall back to SerpAPI
  const serperKey = getSerperApiKey();
  const serpApiKey = getSerpApiKey();

  if (serperKey) {
    try {
      return await webSearchSerper(query, serperKey, opts);
    } catch (error: any) {
      console.warn(`[Discovery] Serper.dev failed for "${query}": ${error.message}`);
      // Fall through to SerpAPI
    }
  }

  if (serpApiKey) {
    try {
      return await webSearchSerpApi(query, serpApiKey, opts);
    } catch (error: any) {
      console.warn(`[Discovery] SerpAPI failed for "${query}": ${error.message}`);
      return [];
    }
  }

  console.error("[Discovery] No search API key configured (SERPER_API_KEY or SERP_API_KEY)");
  return [];
}

// ─── Query Variant Generation ───────────────────────────────────────────────

async function generateQueryVariants(
  companyName: string,
  baseQueries: string[],
  numVariants: number,
  framework: Framework
): Promise<string[]> {
  if (numVariants <= 0) return [];

  try {
    const { text } = await completeWithFallback("deepseek", {
      system: `You generate search query variants for corporate document discovery. Given base search queries about a company, generate alternative phrasings that would find the same or similar documents but using different keywords, synonyms, or angles. Focus on finding sustainability reports, ESG disclosures, policy documents, and governance materials.`,
      prompt: `Company: ${companyName}
Topic: ${framework.topicDescription || framework.name}

Base queries:
${baseQueries.slice(0, 4).map((q, i) => `${i + 1}. ${q}`).join("\n")}

Generate ${numVariants} alternative search queries that would find similar corporate disclosure documents using different keywords or phrasings. Return ONLY a JSON array of strings.

Example: ["HSBC climate risk disclosure 2024", "HSBC net zero transition plan", "HSBC financed emissions report"]`,
      json: true,
      maxTokens: 500,
    });

    const variants = JSON.parse(text);
    if (Array.isArray(variants)) {
      return variants.slice(0, numVariants * 2); // Allow up to 2x variants
    }
    return [];
  } catch (error: any) {
    console.warn(`[Discovery] Query variant generation failed: ${error.message}`);
    return [];
  }
}

// ─── Query Construction ──────────────────────────────────────────────────────

interface DiscoveryCandidate {
  url: string;
  title: string;
  snippet: string;
  lane: string;
  priority: number;
}

function buildGeneralQueries(companyName: string, framework: Framework): string[] {
  const topic = framework.topicDescription || framework.name;
  const templates = framework.searchTemplates || [
    `"${companyName}" sustainability report`,
    `"${companyName}" ESG report`,
    `"${companyName}" corporate responsibility report`,
    `"${companyName}" annual report governance`,
    `"${companyName}" ${topic}`,
    `"${companyName}" policy framework`,
  ];
  return templates.map((t) => t.replace(/\{company\}/g, companyName));
}

/**
 * Multi-Document Sourcing Expansion
 * 
 * Generates additional search queries targeting three distinct document classes
 * beyond the main sustainability/climate report:
 * 1. Specialized Policies: Environmental & Social Risk frameworks, coal policies,
 *    fossil fuel exclusion policies, sector-specific policies
 * 2. Ancillary Disclosures: Sustainable finance frameworks, investor presentations,
 *    press releases announcing targets, transition plans
 * 3. Regulatory Filings: TCFD reports, CDP responses, transition plan disclosures
 * 
 * This addresses the systematic sourcing gap where evidence is scattered across
 * multiple documents (e.g., coal exclusion in E&S policy, sustainable finance
 * targets in investor presentations, not in the main climate report).
 */
function buildMultiDocumentQueries(companyName: string, framework: Framework): string[] {
  const queries: string[] = [];
  const topic = (framework.topicDescription || framework.name || "").toLowerCase();

  // Topic-gated queries for relevance (not memory — server has 8GB)
  const isClimateRelated = /climate|emission|carbon|net.?zero|fossil|coal|energy transition/i.test(topic);
  const isESGBroad = /esg|sustainability|environmental|social|governance/i.test(topic);

  if (isClimateRelated) {
    // Class 1: Specialized Policy Documents
    queries.push(
      `"${companyName}" environmental social policy framework`,
      `"${companyName}" fossil fuel policy OR coal policy`,
      `"${companyName}" sector exclusion policy`,
      `"${companyName}" environmental and social risk framework`,
      `"${companyName}" responsible lending policy`,
    );

    // Class 2: Ancillary Disclosures & Announcements
    queries.push(
      `"${companyName}" sustainable finance target OR green bond framework`,
      `"${companyName}" transition plan OR climate transition`,
      `"${companyName}" 2030 target announcement OR interim target`,
      `"${companyName}" financed emissions target OR net zero commitment`,
      `"${companyName}" investor presentation climate`,
    );

    // Class 3: Regulatory & Voluntary Framework Filings
    queries.push(
      `"${companyName}" TCFD report OR climate-related financial disclosures`,
      `"${companyName}" CDP climate response OR CDP submission`,
      `"${companyName}" NZBA progress report OR net-zero banking`,
    );
  } else if (isESGBroad) {
    // Broader ESG policy documents
    queries.push(
      `"${companyName}" sustainable finance framework OR green bond framework`,
      `"${companyName}" sustainability report 2024 OR sustainability report 2023`,
      `"${companyName}" ESG policy framework OR responsible investment`,
      `"${companyName}" TCFD report OR climate-related financial disclosures`,
      `"${companyName}" CDP response OR sustainability disclosure`,
    );
  } else {
    // General topic: search for policy documents related to the framework topic
    const topicWords = topic.split(/\s+/).slice(0, 4).join(" ");
    queries.push(
      `"${companyName}" ${topicWords} policy OR framework`,
      `"${companyName}" ${topicWords} report OR disclosure`,
      `"${companyName}" ${topicWords} governance OR strategy`,
    );
  }

  return queries;
}

function buildDomainQueries(companyName: string, domain: string, framework: Framework): string[] {
  const baseQueries = [
    `site:${domain} sustainability report`,
    `site:${domain} governance`,
    `site:${domain} ESG`,
    `site:${domain} annual report`,
    `site:${domain} policy`,
    `site:${domain}/investors`,
  ];

  // AI-specific domain queries to find AI governance disclosures
  const aiQueries = [
    `site:${domain} responsible AI`,
    `site:${domain} AI policy`,
    `site:${domain} artificial intelligence`,
    `site:${domain} AI ethics`,
    `site:${domain} AI governance`,
    `site:${domain} AI principles`,
    `site:${domain} machine learning`,
    `site:${domain} AI risk`,
    `site:${domain} AI transparency`,
    `site:${domain} data privacy AI`,
  ];

  return [...baseQueries, ...aiQueries];
}

function buildTrustedSourceQueries(companyName: string, sources: TrustedSource[]): string[] {
  return sources
    .filter((s) => s.isActive)
    .map((s) => `site:${s.domain} "${companyName}"`);
}

function buildCJKQueries(companyName: string, framework: Framework): string[] {
  // Detect if company name contains CJK characters
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(companyName);
  if (!hasCJK) return [];

  const topic = framework.topicDescription || framework.name;
  // Generate localized queries
  return [
    `${companyName} サステナビリティ報告書`,
    `${companyName} ESG報告`,
    `${companyName} 可持续发展报告`,
    `${companyName} 지속가능경영보고서`,
    `${companyName} ${topic}`,
  ];
}

// ─── Ranking and Demotion ────────────────────────────────────────────────────

function calculatePriority(
  url: string,
  title: string,
  companyDomain: string | null,
  framework: Framework
): number {
  let priority = 0;
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  // On-company-domain bonus
  if (companyDomain && urlLower.includes(companyDomain)) {
    priority -= 8;
  }

  // Trusted disclosure platform bonus (Tier 1: priority domains from curated sources list)
  // These are statutory filing repositories, ESG registries, voluntary frameworks,
  // certification registries, and national company registers
  const priorityDomains = [
    // Statutory / securities filing repositories
    "sec.gov", "efts.sec.gov", "fca.org.uk", "data.fca.org.uk",
    "find-and-update.company-information.service.gov.uk", "esap.europa.eu",
    "registers.esma.europa.eu", "unternehmensregister.de", "fsma.be",
    "info-financiere.fr", "data.inpi.fr", "1info.it", "cnmv.es",
    "afm.nl", "dl.bourse.lu", "web3.cmvm.pt", "rss.knf.gov.pl",
    "direct.euronext.com", "bolagsverket.se", "brreg.no", "datacvr.virk.dk",
    "tietopalvelu.ytj.fi", "zefix.ch", "core.cro.ie", "kbopub.economie.fgov.be",
    "registradores.org", "registroimprese.it", "kvk.nl", "handelsregister.de",
    "e-justice.europa.eu", "sedarplus.ca", "connectonline.asic.gov.au",
    "asx.com.au", "www1.hkexnews.hk", "disclosure2.edinet-fsa.go.jp",
    "release.tdnet.info", "kind.krx.co.kr", "mops.twse.com.tw",
    "sgx.com", "bseindia.com", "nseindia.com", "sebi.gov.in",
    "cninfo.com.cn", "sse.com.cn", "gsxt.gov.cn", "maya.tase.co.il",
    "saudiexchange.sa", "adx.ae", "dfm.ae", "kap.org.tr",
    "clientportal.jse.co.za", "b3.com.br", "rad.cvm.gov.br", "mca.gov.in",
    // UK-specific statutory ESG
    "modern-slavery-statement-registry.service.gov.uk",
    "gender-pay-gap.service.gov.uk", "gov.uk",
    // Country-specific ESG registries
    "modernslaveryregister.gov.au", "wgea.gov.au",
    "natural-resources.canada.ca", "publicsafety.gc.ca",
    "enviro.epa.gov", "industry.eea.europa.eu", "eea.europa.eu",
    "environment.data.gov.uk", "ec.europa.eu", "ww2.arb.ca.gov",
    "hatvp.fr", "lda.senate.gov", "fec.gov",
    "transparency-register.europa.eu",
    // Voluntary global frameworks
    "cdp.net", "tnfd.global", "sciencebasedtargets.org",
    "sciencebasedtargetsnetwork.org", "unglobalcompact.org",
    // Finance-sector pledges
    "netzeroassetmanagers.org", "unepfi.org", "unpri.org",
    "equator-principles.com", "financeforbiodiversity.org",
    "frc.org.uk", "fsa.go.jp", "carbonaccountingfinancials.com",
    // UN-backed campaigns
    "climateaction.unfccc.int", "there100.org", "theclimategroup.org", "weps.org",
    // Sector-specific & certification registries
    "eiti.org", "icmm.com", "rspo.org", "search.fsc.org", "connect.fsc.org",
    "pefc.org", "responsiblesoy.org", "bonsucro.com", "rsb.org",
    "responsiblemining.net", "aluminium-stewardship.org",
    "responsiblesteel.org", "responsiblejewellery.com",
    "bettercotton.org", "fisheries.msc.org", "asc-aqua.org",
    "knowledge.rainforest-alliance.org", "flocert.net", "goodweave.org",
    "fairlabor.org", "iafcertsearch.org",
    // Certification & verified-status registries
    "bcorporation.net", "usgbc.org", "tools.breeam.com",
    "account.wellcertified.com", "dgnb.de",
    // Human rights & social
    "hrc.org", "disabilityin.org", "ungpreporting.org",
    // Other regulatory/reporting
    "oecd.org",
  ];
  if (priorityDomains.some((d) => urlLower.includes(d))) {
    priority -= 4;
  }

  // URL slug bonuses
  const slugBonuses: Record<string, number> = {
    governance: -5,
    sustainability: -4,
    "responsible-ai": -5,
    ethics: -3,
    policy: -3,
    report: -2,
    esg: -4,
    "annual-report": -4,
    proxy: -3,
    "def-14a": -5,
  };
  for (const [slug, bonus] of Object.entries(slugBonuses)) {
    if (urlLower.includes(slug)) priority += bonus;
  }

  // AI keyword bonus
  const aiKeywords = ["ai", "artificial-intelligence", "model-risk", "machine-learning"];
  if (aiKeywords.some((k) => urlLower.includes(k))) {
    priority -= 3;
  }

  // Third-party blog/news penalty
  const newsDomains = ["reuters.com", "bloomberg.com", "cnbc.com", "bbc.com", "medium.com"];
  if (newsDomains.some((d) => urlLower.includes(d))) {
    priority += 5;
  }

  // Negative keywords penalty
  if (framework.negativeKeywords) {
    for (const kw of framework.negativeKeywords) {
      if (titleLower.includes(kw.toLowerCase())) {
        priority += 12;
      }
    }
  }

  // Negative domains penalty
  if (framework.negativeDomains) {
    for (const domain of framework.negativeDomains) {
      if (urlLower.includes(domain.toLowerCase())) {
        priority += 15;
      }
    }
  }

  // Customer content paths penalty
  const customerPaths = ["/wealth-management/articles/", "/insights/", "/blog/", "/news/"];
  if (companyDomain && urlLower.includes(companyDomain)) {
    if (customerPaths.some((p) => urlLower.includes(p))) {
      priority += 25;
    }
  }

  return priority;
}

// ─── Relevance Gate ──────────────────────────────────────────────────────────

async function runRelevanceGate(
  candidates: DiscoveryCandidate[],
  framework: Framework,
  companyName: string,
  companyContext?: { sector?: string | null; country?: string | null; isin?: string | null; domain?: string | null }
): Promise<DiscoveryCandidate[]> {
  const gateModel = "claude-haiku";
  const batchSize = 20;
  const accepted: DiscoveryCandidate[] = [];

  // Build company identity context for disambiguation
  const identityParts: string[] = [];
  if (companyContext?.sector) identityParts.push(`Sector: ${companyContext.sector}`);
  if (companyContext?.country) identityParts.push(`Country: ${companyContext.country}`);
  if (companyContext?.isin) identityParts.push(`ISIN: ${companyContext.isin}`);
  if (companyContext?.domain) identityParts.push(`Official domain: ${companyContext.domain}`);
  const identityBlock = identityParts.length > 0 ? `\nCompany identity: ${identityParts.join(", ")}` : "";

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const urlList = batch
      .map((c, idx) => `${idx + 1}. URL: ${c.url}\n   Title: ${c.title}\n   Snippet: ${c.snippet}`)
      .join("\n\n");

    try {
      const { text } = await completeWithFallback(gateModel, {
        system: `You are a document relevance classifier for corporate disclosure analysis. Given a list of URLs found for a specific company, classify each as "accept" or "reject".

ACCEPT: Corporate reports, filings, policy documents, governance pages, sustainability reports, annual reports, and other substantive disclosures that are ABOUT THIS SPECIFIC COMPANY.

REJECT:
- Documents about a DIFFERENT entity that happens to share a similar name or acronym (e.g., EU regulatory body ACER vs. Acer the computer company)
- News articles, marketing content, job postings, product pages
- YouTube videos, social media posts (unless they link to official disclosures)
- Documents from unrelated organizations

IMPORTANT: Pay close attention to the company identity (sector, country, domain) to distinguish from similarly-named entities.`,
        prompt: `Company: ${companyName}${identityBlock}\nAnalysis topic: ${framework.topicDescription || framework.name}\n\nClassify each URL as relevant to THIS SPECIFIC COMPANY's disclosures:\n\n${urlList}\n\nReturn a JSON array of objects: [{"index": 1, "verdict": "accept"|"reject", "reason": "brief reason"}]`,
        json: true,
        maxTokens: 2000,
      });

      const verdicts = JSON.parse(text);
      for (const v of verdicts) {
        const idx = v.index - 1;
        if (idx >= 0 && idx < batch.length) {
          if (v.verdict === "accept") {
            accepted.push(batch[idx]);
          }
        }
      }
    } catch (error: any) {
      // On gate failure, accept all in this batch (fail-open)
      console.warn(`[Discovery] Gate batch failed: ${error.message}, accepting all`);
      accepted.push(...batch);
    }
  }

  return accepted;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────

export interface DiscoveryDiagnostics {
  totalCandidates: number;
  acceptedByGate: number;
  finalCount: number;
  lanes: Record<string, number>;
  topUrls: Array<{ url: string; title: string; priority: number }>;
}

export interface DiscoveryResult {
  documents: DiscoveryCandidate[];
  diagnostics: DiscoveryDiagnostics;
}

export async function searchCompanyDocuments(opts: {
  companyName: string;
  companyId: number;
  companyDomain?: string | null;
  isin?: string | null;
  sector?: string | null;
  country?: string | null;
  pinnedUrls?: string[];
  framework: Framework;
  trustedSources: TrustedSource[];
  searchDepth?: number; // Number of results per query (default: 10)
  queryVariants?: number; // Number of LLM-generated query variants (default: 3)
}): Promise<DiscoveryResult> {
  const { companyName, companyId, companyDomain, pinnedUrls, framework, trustedSources } = opts;
  const searchDepth = opts.searchDepth || 10;
  const queryVariants = opts.queryVariants ?? 3;
  const allCandidates: DiscoveryCandidate[] = [];
  const seenUrls = new Set<string>();
  const laneCounts: Record<string, number> = {};

  function addCandidate(result: SearchResult, lane: string) {
    if (seenUrls.has(result.link)) return;
    seenUrls.add(result.link);
    const priority = calculatePriority(result.link, result.title, companyDomain || null, framework);
    allCandidates.push({
      url: result.link,
      title: result.title,
      snippet: result.snippet,
      lane,
      priority,
    });
    laneCounts[lane] = (laneCounts[lane] || 0) + 1;
  }

  // Add pinned URLs with maximum priority
  if (pinnedUrls) {
    for (const url of pinnedUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allCandidates.push({
          url,
          title: "Pinned document",
          snippet: "",
          lane: "pinned",
          priority: -100,
        });
        laneCounts["pinned"] = (laneCounts["pinned"] || 0) + 1;
      }
    }
  }

  // Lane 1: General search (with recency filter)
  console.log(`[${companyName}] Running general search lane`);
  const generalQueries = buildGeneralQueries(companyName, framework);
  for (const query of generalQueries) {
    const results = await webSearch(query, { num: searchDepth, tbs: "qdr:y2" });
    for (const r of results) addCandidate(r, "general");

    // If too few results with recency filter, retry without
    if (results.length < 3) {
      const unfiltered = await webSearch(query, { num: searchDepth });
      for (const r of unfiltered) addCandidate(r, "general-unfiltered");
    }
  }

  // Lane 2: Domain-anchored search
  if (companyDomain) {
    console.log(`[${companyName}] Running domain-anchored search lane`);
    const domainQueries = buildDomainQueries(companyName, companyDomain, framework);
    for (const query of domainQueries) {
      const results = await webSearch(query, { num: searchDepth });
      for (const r of results) addCandidate(r, "domain");
    }
  }

  // Lane 3: Trusted source search (framework-specific sources take priority)
  const frameworkSourceIds = framework.trustedSourceIds as number[] | null;
  let effectiveSources = trustedSources;
  if (frameworkSourceIds && frameworkSourceIds.length > 0) {
    // Use framework-specific sources if configured, otherwise fall back to global list
    effectiveSources = trustedSources.filter((s) => frameworkSourceIds.includes(s.id));
    if (effectiveSources.length === 0) effectiveSources = trustedSources; // fallback
  }
  if (effectiveSources.length > 0) {
    console.log(`[${companyName}] Running trusted source search lane (${effectiveSources.length} sources)`);
    const tsQueries = buildTrustedSourceQueries(companyName, effectiveSources);
    // Allow up to 15 trusted source queries per company (increased from 5)
    for (const query of tsQueries.slice(0, 15)) {
      const results = await webSearch(query, { num: Math.max(5, searchDepth) });
      for (const r of results) addCandidate(r, "trusted");
    }
  }

  // Lane 4: CJK localized search
  const cjkQueries = buildCJKQueries(companyName, framework);
  if (cjkQueries.length > 0) {
    console.log(`[${companyName}] Running CJK search lane`);
    for (const query of cjkQueries) {
      const results = await webSearch(query, { num: searchDepth });
      for (const r of results) addCandidate(r, "cjk");
    }
  }

  // Lane 5: Known disclosure URLs from framework
  if (framework.knownDisclosureUrls) {
    for (const url of framework.knownDisclosureUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allCandidates.push({
          url,
          title: "Framework known disclosure",
          snippet: "",
          lane: "known",
          priority: -50,
        });
        laneCounts["known"] = (laneCounts["known"] || 0) + 1;
      }
    }
  }

  // Lane 6: Auto-generated query variants (LLM-generated alternative phrasings)
  const numVariants = queryVariants;
  if (numVariants > 0) {
    console.log(`[${companyName}] Generating ${numVariants} query variants for broader discovery`);
    const variantQueries = await generateQueryVariants(companyName, generalQueries, numVariants, framework);
    if (variantQueries.length > 0) {
      console.log(`[${companyName}] Running ${variantQueries.length} variant queries`);
      for (const query of variantQueries) {
        const results = await webSearch(query, { num: searchDepth });
        for (const r of results) addCandidate(r, "variant");
      }
    }
  }

  // Lane 7: Multi-Document Sourcing Expansion
  // Targets specialized policy documents, ancillary disclosures, and regulatory filings
  // that are often separate from the main sustainability/climate report.
  console.log(`[${companyName}] Running multi-document sourcing expansion lane`);
  const multiDocQueries = buildMultiDocumentQueries(companyName, framework);
  for (const query of multiDocQueries) {
    const results = await webSearch(query, { num: Math.min(searchDepth, 10) });
    for (const r of results) addCandidate(r, "multi-doc");
  }

  console.log(`[${companyName}] Discovery found ${allCandidates.length} total candidates`);

  // Cap before gate to bound LLM cost
  const preGateCandidates = allCandidates
    .sort((a, b) => a.priority - b.priority)
    .slice(0, PRE_GATE_CAP);

  // Run relevance gate
  console.log(`[${companyName}] Running relevance gate on ${preGateCandidates.length} candidates`);
  const accepted = await runRelevanceGate(preGateCandidates, framework, companyName, {
    sector: opts.sector,
    country: opts.country,
    isin: opts.isin,
    domain: companyDomain,
  });

  console.log(`[${companyName}] Gate accepted ${accepted.length} documents`);

  // Sort by priority and cap
  const finalDocs = accepted
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_DOCS_RETURNED);

  const diagnostics: DiscoveryDiagnostics = {
    totalCandidates: allCandidates.length,
    acceptedByGate: accepted.length,
    finalCount: finalDocs.length,
    lanes: laneCounts,
    topUrls: finalDocs.slice(0, 20).map((d) => ({
      url: d.url,
      title: d.title,
      priority: d.priority,
    })),
  };

  return { documents: finalDocs, diagnostics };
}

// ─── Ensemble Discovery (multiple passes with varied phrasing) ───────────────

export async function searchCompanyDocumentsWithEnsemble(opts: {
  companyName: string;
  companyId: number;
  companyDomain?: string | null;
  isin?: string | null;
  pinnedUrls?: string[];
  framework: Framework;
  trustedSources: TrustedSource[];
  iterations?: number;
}): Promise<DiscoveryResult> {
  const iterations = opts.iterations || 1;

  if (iterations <= 1) {
    return searchCompanyDocuments(opts);
  }

  // Multiple passes with slightly varied queries
  const allDocs: DiscoveryCandidate[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < iterations; i++) {
    const result = await searchCompanyDocuments(opts);
    for (const doc of result.documents) {
      if (!seenUrls.has(doc.url)) {
        seenUrls.add(doc.url);
        allDocs.push(doc);
      }
    }
  }

  const finalDocs = allDocs
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_DOCS_RETURNED);

  return {
    documents: finalDocs,
    diagnostics: {
      totalCandidates: allDocs.length,
      acceptedByGate: allDocs.length,
      finalCount: finalDocs.length,
      lanes: {},
      topUrls: finalDocs.slice(0, 20).map((d) => ({
        url: d.url,
        title: d.title,
        priority: d.priority,
      })),
    },
  };
}
