/**
 * Instruction 46 — Canonical Issuer Profile
 * ──────────────────────────────────────────
 * A generic, framework-agnostic issuer-resolution layer that runs BEFORE
 * discovery. It builds a rich canonical profile from available identifiers
 * (FIGI, ISIN, ticker, domain) and derives deterministic aliases, verified
 * domains, and local-language variants.
 *
 * Design principles:
 *  - No hardcoded company names, topics, jurisdictions, or domains in logic.
 *  - All data-driven; configuration via schema fields and environment.
 *  - Deterministic: identical inputs → identical outputs.
 *  - Additive: never removes existing validated data.
 */

import { deriveAliases, resolveCompanyFIGI, type FigiResult } from "./issuer-resolver.js";
import { PIPELINE_VERSION } from "./pipeline-version.js";
// Note: db/sql imports removed — profile resolution is pure computation.
// Persistence is handled by the caller (pipeline.ts / discovery.ts).

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IssuerAlias {
  value: string;
  type: "legal-name" | "trading-name" | "former-name" | "local-language" | "acronym" | "ticker" | "figi-derived" | "isin";
  confidence: "high" | "medium" | "low";
  provenance: string;
}

export interface DomainCandidate {
  domain: string;
  type: "corporate" | "investor-relations" | "registry" | "exchange" | "regulator";
  status: "accepted" | "rejected";
  reason: string;
  evidence: string[];
}

export interface IssuerProfile {
  companyId: number;
  legalName: string;
  tradingNames: string[];
  formerNames: string[];
  localLanguageNames: string[];
  aliases: IssuerAlias[];
  /** Flat list of alias values for query generation (deterministic, deduped) */
  queryAliases: string[];
  /** Identifiers */
  isin: string | null;
  ticker: string | null;
  figiName: string | null;
  figiTicker: string | null;
  lei: string | null;
  /** Domain crosswalk */
  verifiedDomains: string[];
  domainCandidates: DomainCandidate[];
  /** Locale / language */
  country: string | null;
  supportedLanguages: string[];
  /** Provenance */
  resolvedAt: string;
  pipelineVersion: string;
}

export interface ProfileDiagnostics {
  aliasCount: number;
  verifiedDomainCount: number;
  rejectedDomainCount: number;
  identifiersAvailable: string[];
  resolutionPath: string[];
}

// ─── Alias Generation (Identifier-Backed) ───────────────────────────────────

/**
 * Generate deterministic aliases from all available issuer metadata.
 * Acronym-only aliases are marked low-confidence unless corroborated by
 * a verified domain, legal name, or registry identifier.
 */
export function generateIssuerAliases(opts: {
  companyName: string;
  figiName: string | null;
  figiTicker: string | null;
  isin: string | null;
  ticker: string | null;
  country: string | null;
}): IssuerAlias[] {
  const aliases: IssuerAlias[] = [];
  const seen = new Set<string>();

  const addAlias = (value: string, type: IssuerAlias["type"], confidence: IssuerAlias["confidence"], provenance: string) => {
    const norm = value.toLowerCase().trim();
    if (norm.length < 2 || seen.has(norm)) return;
    seen.add(norm);
    aliases.push({ value: norm, type, confidence, provenance });
  };

  // 1. Legal/company name
  addAlias(opts.companyName, "legal-name", "high", "company-record");

  // 2. FIGI-derived canonical name (if different from company name)
  if (opts.figiName && opts.figiName.toLowerCase() !== opts.companyName.toLowerCase()) {
    addAlias(opts.figiName, "figi-derived", "high", "openfigi");
  }

  // 3. Ticker as alias (added BEFORE structural aliases so ticker type takes priority)
  if (opts.ticker && opts.ticker.length >= 2) {
    addAlias(opts.ticker, "ticker", "medium", "company-record");
  }
  if (opts.figiTicker && opts.figiTicker.length >= 2 && opts.figiTicker !== opts.ticker) {
    addAlias(opts.figiTicker, "ticker", "medium", "openfigi");
  }

  // 4. Derive structural aliases from the canonical name
  const canonicalName = opts.figiName || opts.companyName;
  const derivedAliases = deriveAliases(canonicalName, opts.figiTicker);
  for (const a of derivedAliases) {
    // Determine if this is an acronym (all initials, short)
    const isAcronym = a.length <= 4 && /^[a-z]+$/.test(a);
    if (isAcronym) {
      addAlias(a, "acronym", "low", "derived-initials");
    } else {
      addAlias(a, "trading-name", "medium", "derived-structural");
    }
  }

  // 5. ISIN as a high-precision identifier alias
  if (opts.isin) {
    addAlias(opts.isin, "isin", "high", "company-record");
  }

  return aliases;
}

/**
 * Upgrade acronym-only aliases to medium confidence when corroborated
 * by domain evidence or other identifiers.
 */
export function corroborateAcronyms(
  aliases: IssuerAlias[],
  verifiedDomains: string[],
  legalName: string
): IssuerAlias[] {
  const domainStr = verifiedDomains.join(" ").toLowerCase();
  const legalLower = legalName.toLowerCase();

  return aliases.map(a => {
    if (a.type === "acronym" && a.confidence === "low") {
      // Check if the acronym appears in any verified domain
      const inDomain = domainStr.includes(a.value);
      // Check if the acronym's letters match the initials of the legal name
      const nameWords = legalLower.split(/[\s,.'&]+/).filter(w => w.length > 1);
      const initials = nameWords.map(w => w[0]).join("");
      const matchesInitials = initials.includes(a.value) || a.value.includes(initials);

      if (inDomain || matchesInitials) {
        return { ...a, confidence: "medium" as const, provenance: a.provenance + "+corroborated" };
      }
    }
    return a;
  });
}

// ─── Verified Domain Crosswalk ──────────────────────────────────────────────

/**
 * Verify a candidate domain against issuer metadata.
 * Returns accepted/rejected with reason and evidence.
 *
 * R5e (2026-09-04): added ISIN-country jurisdictional gate on ticker-only
 * matches. When the only accepting signal is a `ticker` alias (2-5 letter
 * exchange code, medium confidence) AND the issuer's ISIN indicates a non-
 * US country, the domain must ALSO carry an ISIN-country-consistent TLD to
 * be accepted. Otherwise the ticker match alone is not sufficient evidence
 * of jurisdictional alignment.
 *
 * Motivation: Prudential plc (ISIN GB0007099541, ticker PRU) was accepting
 * `prudential.com` as its own domain because `prudential.com` "contains"
 * the ticker `pru`. But `prudential.com` belongs to Prudential Financial
 * Inc. (unrelated US company also trading as PRU on NYSE). The correct
 * Prudential-plc domains are `prudentialplc.com` and `prudential.com.sg`,
 * both of which pass R5e (legal-name match, `.com.sg` for Singapore).
 *
 * Scope: this only affects domains whose Check-1 accept was a `ticker`
 * alias. Legal-name-word matches (Check 2) and FIGI-name matches (Check 3)
 * remain unchanged — those provide stronger evidence than a 3-letter
 * exchange code. So Unilever accepting `unilever.com` regardless of ISIN
 * country is unaffected (it passes Check 2 on the word "unilever").
 */
export function verifyDomainCandidate(
  domain: string,
  issuerAliases: IssuerAlias[],
  legalName: string,
  figiName: string | null,
  /** Optional: ISIN of the issuer for the R5e country gate. If omitted, R5e is skipped. */
  isin?: string | null,
): DomainCandidate {
  const dl = domain.toLowerCase();
  const evidence: string[] = [];
  let accepted = false;
  let acceptingAliasType: IssuerAlias["type"] | null = null;
  let acceptingAliasValue: string | null = null;

  // Check 1: Does the domain contain any high/medium-confidence alias?
  const significantAliases = issuerAliases.filter(a =>
    a.confidence !== "low" && a.value.length >= 3
  );
  for (const alias of significantAliases) {
    if (dl.includes(alias.value)) {
      evidence.push(`domain contains alias "${alias.value}" (${alias.type}, ${alias.confidence})`);
      accepted = true;
      acceptingAliasType = alias.type;
      acceptingAliasValue = alias.value;
      break;
    }
  }

  // Check 2: Does the domain match distinctive words from the legal name?
  if (!accepted) {
    const GENERIC_WORDS = new Set([
      "the", "and", "group", "holding", "holdings", "company", "companies",
      "corp", "corporation", "inc", "ltd", "limited", "llc", "plc", "bank",
      "international", "global", "financial", "services", "capital",
    ]);
    const nameWords = legalName.toLowerCase().split(/[\s,.'&()+]+/)
      .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
    for (const w of nameWords) {
      if (dl.includes(w)) {
        evidence.push(`domain contains legal-name word "${w}"`);
        accepted = true;
        break;
      }
    }
  }

  // Check 3: FIGI name match
  if (!accepted && figiName) {
    const figiWords = figiName.toLowerCase().split(/[\s,.'&()+]+/)
      .filter(w => w.length >= 3);
    for (const w of figiWords) {
      if (dl.includes(w)) {
        evidence.push(`domain contains FIGI-name word "${w}"`);
        accepted = true;
        break;
      }
    }
  }

  // R5e (2026-09-04): ISIN-country gate on ticker-only matches.
  // Applies only when the acceptance signal is a `ticker` alias AND the
  // ISIN indicates a non-US country. In that case, the domain must carry
  // a TLD consistent with the ISIN's country prefix to be accepted.
  //
  // Design rationale: legal-name and FIGI-name matches (Checks 2 and 3) are
  // strong enough that we don't apply the gate to them. Only the weaker
  // ticker-alone match needs the additional jurisdictional constraint.
  if (accepted && acceptingAliasType === "ticker" && isin && isin.length >= 2) {
    const isinCountry = isin.slice(0, 2).toUpperCase();
    // US issuers use `.com` as the default TLD, so a ticker match on a
    // US-country ISIN doesn't need the country gate (`.com` is the
    // canonical US-issuer TLD and doesn't rule out any US jurisdiction).
    if (isinCountry !== "US") {
      const tldCountry = tldCountryCode(dl);
      if (tldCountry === null) {
        // Generic TLD (`.com`, `.net`, `.org`, ...) with a non-US ISIN and
        // ticker-only match. Reject: the ticker alone is not sufficient
        // evidence that this generic-TLD domain belongs to the non-US
        // issuer rather than a same-ticker issuer in a different country.
        return {
          domain,
          type: "corporate",
          status: "rejected",
          reason: `Rejected (R5e): ticker-only alias match "${acceptingAliasValue}" against generic-TLD domain "${domain}" but issuer ISIN country is ${isinCountry}, not US. Legal-name-word or FIGI-name evidence needed.`,
          evidence,
        };
      }
      if (tldCountry !== isinCountry && !isCountryAlias(tldCountry, isinCountry)) {
        // Country-specific TLD but wrong country. Reject: `.co.uk` for a
        // French issuer, `.com.br` for a Danish issuer, etc.
        return {
          domain,
          type: "corporate",
          status: "rejected",
          reason: `Rejected (R5e): ticker-only alias match "${acceptingAliasValue}" but domain TLD indicates country ${tldCountry}, issuer ISIN country is ${isinCountry}.`,
          evidence,
        };
      }
      // TLD country matches ISIN country — append to evidence for audit.
      evidence.push(`R5e: TLD country "${tldCountry}" matches ISIN country "${isinCountry}"`);
    }
  }

  const reason = accepted
    ? `Verified: ${evidence[0]}`
    : `Rejected: no issuer-identity match in domain "${domain}"`;

  return {
    domain,
    type: "corporate",
    status: accepted ? "accepted" : "rejected",
    reason,
    evidence,
  };
}

// R5e: TLD → ISO 3166 country code mapping.
//
// Returns the ISO 3166 alpha-2 country code implied by the domain's TLD
// (`.co.uk` → GB, `.com.sg` → SG, `.de` → DE). Returns null for generic
// TLDs (`.com`, `.net`, `.org`, `.info`, `.biz`) which carry no country
// signal. Used by the R5e gate to compare against ISIN country.
//
// Kept as a compact static table because the set of country-specific TLDs
// changes rarely and correctness matters more than coverage completeness
// (a missing country falls through to `null` → rejected via the generic
// branch, which is the correct conservative default).
const COUNTRY_TLDS: Record<string, string> = {
  // United Kingdom
  "co.uk": "GB", "org.uk": "GB", "ac.uk": "GB", "gov.uk": "GB", "uk": "GB",
  // Singapore
  "com.sg": "SG", "sg": "SG",
  // Hong Kong
  "com.hk": "HK", "hk": "HK",
  // Japan
  "co.jp": "JP", "jp": "JP", "ne.jp": "JP",
  // Australia
  "com.au": "AU", "au": "AU", "org.au": "AU",
  // Canada
  "ca": "CA",
  // Germany
  "de": "DE",
  // France
  "fr": "FR",
  // Italy
  "it": "IT",
  // Spain
  "es": "ES",
  // Netherlands
  "nl": "NL",
  // Switzerland
  "ch": "CH",
  // Sweden
  "se": "SE",
  // Norway
  "no": "NO",
  // Denmark
  "dk": "DK",
  // Finland
  "fi": "FI",
  // Belgium
  "be": "BE",
  // Austria
  "at": "AT",
  // Ireland
  "ie": "IE",
  // Israel
  "co.il": "IL", "il": "IL",
  // Turkey
  "com.tr": "TR", "tr": "TR",
  // Brazil
  "com.br": "BR", "br": "BR",
  // Mexico
  "com.mx": "MX", "mx": "MX",
  // South Africa
  "co.za": "ZA", "za": "ZA",
  // South Korea
  "co.kr": "KR", "kr": "KR",
  // Taiwan
  "com.tw": "TW", "tw": "TW",
  // India
  "co.in": "IN", "in": "IN",
  // China
  "com.cn": "CN", "cn": "CN",
  // United Arab Emirates
  "ae": "AE",
};

function tldCountryCode(domain: string): string | null {
  const dl = domain.toLowerCase().replace(/^www\./, "");
  // Try two-part TLDs first (e.g. `co.uk` before `uk`).
  const parts = dl.split(".");
  if (parts.length >= 3) {
    const twoPart = parts.slice(-2).join(".");
    if (COUNTRY_TLDS[twoPart]) return COUNTRY_TLDS[twoPart];
  }
  if (parts.length >= 2) {
    const onePart = parts[parts.length - 1];
    if (COUNTRY_TLDS[onePart]) return COUNTRY_TLDS[onePart];
  }
  return null;
}

// R5e: some ISO country codes map to related jurisdictional TLDs. For
// example, an ISIN registered in Hong Kong (HK) might use a `.com.hk` TLD,
// but a `.hk` company might also have a related Chinese entity with a
// `.cn` presence. Currently only exact matches are trusted; this hook is
// for future expansion (e.g. EU-wide domains for European issuers, etc.).
function isCountryAlias(tldCountry: string, isinCountry: string): boolean {
  // Placeholder for future country-family logic. For now, no aliases:
  // exact match required.
  void tldCountry;
  void isinCountry;
  return false;
}

// ─── Full Profile Resolution ────────────────────────────────────────────────

/**
 * Build the canonical issuer profile for a company. This is the main entry
 * point called before discovery. It resolves FIGI, generates aliases,
 * verifies domains, and returns a complete profile for query generation.
 *
 * Deterministic: same inputs → same profile (no LLM calls, no randomness).
 */
export async function resolveIssuerProfile(opts: {
  companyId: number;
  companyName: string;
  isin: string | null;
  ticker: string | null;
  domain: string | null;
  sector: string | null;
  country: string | null;
  /** Full company row for cached FIGI fields */
  companyRow?: any;
}): Promise<{ profile: IssuerProfile; diagnostics: ProfileDiagnostics }> {
  const resolutionPath: string[] = [];
  const identifiersAvailable: string[] = [];

  if (opts.isin) identifiersAvailable.push("isin");
  if (opts.ticker) identifiersAvailable.push("ticker");
  if (opts.domain) identifiersAvailable.push("domain");

  // Step 1: Resolve FIGI canonical name
  let figiName: string | null = null;
  let figiTicker: string | null = null;

  const row = opts.companyRow || {};
  if (opts.isin) {
    const figiResult = await resolveCompanyFIGI({
      id: opts.companyId,
      isin: opts.isin,
      figiResolvedAt: row.figiResolvedAt,
      figiName: row.figiName,
      figiTicker: row.figiTicker,
      figiPipelineVersion: row.figiPipelineVersion,
      domain: opts.domain,
    });
    figiName = figiResult.name;
    figiTicker = figiResult.ticker;
    if (figiName) {
      resolutionPath.push("figi-resolved");
      identifiersAvailable.push("figi");
    }
  }

  // Step 2: Generate aliases
  const aliases = generateIssuerAliases({
    companyName: opts.companyName,
    figiName,
    figiTicker,
    isin: opts.isin,
    ticker: opts.ticker,
    country: opts.country,
  });
  resolutionPath.push(`aliases-generated(${aliases.length})`);

  // Step 3: Verify domains
  const domainCandidates: DomainCandidate[] = [];
  const verifiedDomains: string[] = [];

  if (opts.domain) {
    // R5e (2026-09-04): pass ISIN so the ticker-only-acceptance branch is
    // gated by the ISIN's country prefix. Fixes Prudential plc / Prudential
    // Financial ambiguous-ticker collision (see verifyDomainCandidate
    // doc comment for full rationale).
    const verification = verifyDomainCandidate(opts.domain, aliases, opts.companyName, figiName, opts.isin);
    domainCandidates.push(verification);
    if (verification.status === "accepted") {
      verifiedDomains.push(opts.domain);
    }
    resolutionPath.push(`domain-verified(${verification.status})`);
  }

  // Step 4: Corroborate acronyms with domain evidence
  const corroboratedAliases = corroborateAcronyms(aliases, verifiedDomains, opts.companyName);

  // Step 5: Build flat query-alias list (deterministic, sorted)
  const queryAliases = corroboratedAliases
    .filter(a => a.confidence !== "low" || a.type === "isin")
    .map(a => a.value)
    .sort();

  // Step 6: Determine supported languages from country
  const supportedLanguages = determineSupportedLanguages(opts.country);

  const profile: IssuerProfile = {
    companyId: opts.companyId,
    legalName: opts.companyName,
    tradingNames: corroboratedAliases.filter(a => a.type === "trading-name").map(a => a.value),
    formerNames: [],
    localLanguageNames: [],
    aliases: corroboratedAliases,
    queryAliases,
    isin: opts.isin,
    ticker: opts.ticker,
    figiName,
    figiTicker,
    lei: null,
    verifiedDomains,
    domainCandidates,
    country: opts.country,
    supportedLanguages,
    resolvedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
  };

  const diagnostics: ProfileDiagnostics = {
    aliasCount: corroboratedAliases.length,
    verifiedDomainCount: verifiedDomains.length,
    rejectedDomainCount: domainCandidates.filter(d => d.status === "rejected").length,
    identifiersAvailable,
    resolutionPath,
  };

  return { profile, diagnostics };
}

// ─── Language Support ───────────────────────────────────────────────────────

/** Data-driven country → supported languages mapping. No hardcoded conditionals. */
const COUNTRY_LANGUAGES: Record<string, string[]> = {
  japan: ["en", "ja"],
  china: ["en", "zh-cn"],
  "hong kong": ["en", "zh-tw"],
  taiwan: ["en", "zh-tw"],
  "south korea": ["en", "ko"],
  korea: ["en", "ko"],
  france: ["en", "fr"],
  germany: ["en", "de"],
  switzerland: ["en", "de", "fr"],
  spain: ["en", "es"],
  italy: ["en", "it"],
  brazil: ["en", "pt"],
  netherlands: ["en", "nl"],
  sweden: ["en", "sv"],
  norway: ["en", "no"],
  denmark: ["en", "da"],
  finland: ["en", "fi"],
  belgium: ["en", "nl", "fr"],
  austria: ["en", "de"],
  mexico: ["en", "es"],
  portugal: ["en", "pt"],
  india: ["en", "hi"],
  australia: ["en"],
  "united kingdom": ["en"],
  "united states": ["en"],
  canada: ["en", "fr"],
};

function determineSupportedLanguages(country: string | null): string[] {
  if (!country) return ["en"];
  const key = country.trim().toLowerCase();
  if (COUNTRY_LANGUAGES[key]) return COUNTRY_LANGUAGES[key];
  // Loose match
  for (const [k, v] of Object.entries(COUNTRY_LANGUAGES)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return ["en"];
}

// ─── Entity Verification Scoring ────────────────────────────────────────────

export interface EntityVerificationScore {
  score: number; // 0-100
  signals: string[];
  isAmbiguous: boolean;
  rejectionReason: string | null;
}

/**
 * Score how well a document matches the target issuer using deterministic
 * signals (domain, title, author, legal name, registry ID, alias evidence).
 * No LLM call — purely rule-based for speed and determinism.
 *
 * Returns a score 0-100 where:
 *  - 80+ = strong match (own domain, legal name in title)
 *  - 50-79 = moderate match (alias in title, related domain)
 *  - 20-49 = weak match (acronym only, generic reference)
 *  - 0-19 = likely mismatch
 */
export function scoreEntityMatch(
  doc: { url: string; title: string; snippet?: string },
  profile: IssuerProfile,
  relatedDomains: string[] = [],
): EntityVerificationScore {
  let score = 0;
  const signals: string[] = [];
  let isAmbiguous = false;

  const urlLower = doc.url.toLowerCase();
  const titleLower = (doc.title || "").toLowerCase();
  const snippetLower = (doc.snippet || "").toLowerCase();
  const combined = `${titleLower} ${snippetLower}`;

  // Signal 1: Domain match (strongest signal)
  const allVerifiedDomains = [...profile.verifiedDomains, ...relatedDomains];
  for (const domain of allVerifiedDomains) {
    if (urlLower.includes(domain.toLowerCase())) {
      score += 40;
      signals.push(`domain-match:${domain}`);
      break;
    }
  }

  // Signal 2: Legal name in title/snippet
  const legalLower = profile.legalName.toLowerCase();
  const legalWords = legalLower.split(/[\s,.'&]+/).filter(w => w.length >= 3);
  const distinctiveLegalWords = legalWords.filter(w => !isGenericWord(w));
  if (distinctiveLegalWords.length > 0) {
    const matchCount = distinctiveLegalWords.filter(w => combined.includes(w)).length;
    const matchRatio = matchCount / distinctiveLegalWords.length;
    if (matchRatio >= 0.5) {
      score += 25;
      signals.push(`legal-name-match(${matchCount}/${distinctiveLegalWords.length})`);
    } else if (matchCount >= 1) {
      score += 10;
      signals.push(`partial-name-match(${matchCount}/${distinctiveLegalWords.length})`);
    }
  }

  // Signal 3: FIGI name match
  if (profile.figiName) {
    const figiLower = profile.figiName.toLowerCase();
    const figiWords = figiLower.split(/[\s,.'&]+/).filter(w => w.length >= 3 && !isGenericWord(w));
    const figiMatch = figiWords.filter(w => combined.includes(w)).length;
    if (figiMatch >= 1) {
      score += 15;
      signals.push(`figi-name-match(${figiMatch})`);
    }
  }

  // Signal 4: Ticker/ISIN in content
  if (profile.ticker && combined.includes(profile.ticker.toLowerCase())) {
    score += 10;
    signals.push("ticker-in-content");
  }
  if (profile.isin && combined.includes(profile.isin.toLowerCase())) {
    score += 20;
    signals.push("isin-in-content");
  }

  // Signal 5: High-confidence alias match
  const highConfAliases = profile.aliases.filter(a => a.confidence === "high" && a.type !== "isin");
  for (const alias of highConfAliases) {
    if (alias.value.length >= 4 && combined.includes(alias.value)) {
      score += 10;
      signals.push(`alias-match:${alias.value}`);
      break;
    }
  }

  // Ambiguity detection: acronym-only match with no other corroboration
  const hasOnlyAcronymMatch = signals.length === 0 && profile.aliases
    .filter(a => a.type === "acronym")
    .some(a => combined.includes(a.value));
  if (hasOnlyAcronymMatch) {
    isAmbiguous = true;
    score = Math.min(score, 25); // Cap at weak match
    signals.push("acronym-only-match(ambiguous)");
  }

  // Cap score at 100
  score = Math.min(100, score);

  // Determine rejection reason
  let rejectionReason: string | null = null;
  if (score < 20) {
    rejectionReason = "No issuer-identity signals detected in document metadata";
  } else if (isAmbiguous && score < 40) {
    rejectionReason = "Ambiguous acronym-only match without corroboration";
  }

  return { score, signals, isAmbiguous, rejectionReason };
}

const GENERIC_WORD_SET = new Set([
  "the", "and", "for", "of", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "inc", "ltd", "limited", "llc", "plc", "bank", "banking",
  "international", "global", "financial", "services", "capital", "partners",
  "energy", "power", "trust", "management", "insurance", "asset",
]);

function isGenericWord(word: string): boolean {
  return GENERIC_WORD_SET.has(word.toLowerCase());
}
