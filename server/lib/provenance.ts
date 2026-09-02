// U17 — Source-provenance classifier.
//
// Determines whether a document is "issuer" (authored or filed by the target
// company) or "third_party" (about the target company but authored elsewhere).
//
// The pre-U17 classifier in pipeline.ts:295 uses hostname-only comparison
// against company.domain, which produced two systematic misclassifications:
//
//   (a) sec.gov EDGAR filings of the target company were tagged third_party
//       because the URL host is sec.gov, not e.g. newmont.com. This
//       under-scored issuers with rich SEC disclosure.
//
//   (b) Third-party PDFs that mention the target company as a case study
//       (e.g. Proteus Partners biodiversity training PDFs) were retained in
//       the corpus and their bullets quoted as if they were the issuer's own
//       disclosure. This produced false-positive Yes verdicts.
//
// The classifier here:
//   1. Recognises regulator/registry hosting patterns (SEC EDGAR, ASIC,
//      HKEX, SEDAR+, Australian Modern Slavery Register, LSE RNS, etc.).
//   2. For those hosts, applies an identity check: does the target company's
//      ticker or a distinctive alias appear in the document title/content?
//      This is a heuristic (a CIK lookup would be exact) but sufficient in
//      practice because regulator filings always name the filer prominently.
//   3. For non-regulator hosts, retains the existing hostname match against
//      company.domain (and its related_domains) to identify first-party.
//   4. Everything else is third_party.
//
// This module has no external dependencies beyond string parsing so it can
// be called from pipeline.ts (discovery-time tagging) and from analyzer.ts
// (verdict-time provenance gate).

export type ProvenanceClass = "issuer" | "third_party";

export interface ProvenanceInput {
  url: string;
  title?: string | null;
  content?: string | null; // may be a snippet; the first ~4KB is enough
  companyDomain?: string | null;
  relatedDomains?: string[] | null;
  companyName?: string | null;
  companyTicker?: string | null;
  companyAliases?: string[] | null; // distinctive tokens from deriveAliases()
}

export interface ProvenanceResult {
  provenance: ProvenanceClass;
  reason: string; // one-line explanation for logging / audit
  regulatorHost: string | null; // if the URL lives on a regulator host, its label
}

// ─── Regulator / registry host patterns ─────────────────────────────────────

// Mirrors the STATUTORY_REGISTRY_HOSTS + REGULATORY_PRIMARY_HOST list in
// ranking.ts. Kept here as a self-contained mapping so the classifier does
// not import ranking.ts (which pulls the full issuer-profile chain).
//
// Keys are host suffixes; values are human-readable labels used only for the
// diagnostic reason string.
const REGULATOR_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)sec\.gov$/i, "SEC EDGAR"],
  [/(^|\.)sedarplus\.ca$/i, "SEDAR+"],
  [/(^|\.)sedar\.com$/i, "SEDAR"],
  [/(^|\.)asx\.com\.au$/i, "ASX"],
  [/(^|\.)hkexnews\.hk$/i, "HKEX news"],
  [/(^|\.)hkex\.com\.hk$/i, "HKEX"],
  [/(^|\.)modernslaveryregister\.gov\.au$/i, "Australian Modern Slavery Register"],
  [/(^|\.)find-and-update\.company-information\.service\.gov\.uk$/i, "UK Companies House"],
  [/(^|\.)data\.fca\.org\.uk$/i, "UK FCA"],
  [/(^|\.)fca\.org\.uk$/i, "UK FCA"],
  [/(^|\.)unternehmensregister\.de$/i, "German Unternehmensregister"],
  [/(^|\.)handelsregister\.de$/i, "German Handelsregister"],
  [/(^|\.)registers\.esma\.europa\.eu$/i, "ESMA registers"],
  [/(^|\.)esap\.europa\.eu$/i, "ESAP"],
  [/(^|\.)info-financiere\.fr$/i, "AMF (France)"],
  [/(^|\.)cnmv\.es$/i, "CNMV (Spain)"],
  [/(^|\.)1info\.it$/i, "1Info (Italy)"],
  [/(^|\.)registroimprese\.it$/i, "Registro Imprese"],
  [/(^|\.)afm\.nl$/i, "AFM (Netherlands)"],
  [/(^|\.)kvk\.nl$/i, "KvK (Netherlands)"],
  [/(^|\.)bolagsverket\.se$/i, "Bolagsverket"],
  [/(^|\.)brreg\.no$/i, "Brønnøysundregistrene"],
  [/(^|\.)datacvr\.virk\.dk$/i, "CVR (Denmark)"],
  [/(^|\.)zefix\.ch$/i, "Zefix (Switzerland)"],
  [/(^|\.)core\.cro\.ie$/i, "CRO (Ireland)"],
  [/(^|\.)disclosure2\.edinet-fsa\.go\.jp$/i, "EDINET (Japan)"],
  [/(^|\.)release\.tdnet\.info$/i, "TDnet (Japan)"],
  [/(^|\.)kind\.krx\.co\.kr$/i, "KRX (Korea)"],
  [/(^|\.)mops\.twse\.com\.tw$/i, "TWSE MOPS"],
  [/(^|\.)sgx\.com$/i, "SGX"],
  [/(^|\.)bseindia\.com$/i, "BSE India"],
  [/(^|\.)nseindia\.com$/i, "NSE India"],
  [/(^|\.)sebi\.gov\.in$/i, "SEBI"],
  [/(^|\.)cninfo\.com\.cn$/i, "CNINFO"],
  [/(^|\.)sse\.com\.cn$/i, "SSE"],
  [/(^|\.)szse\.cn$/i, "SZSE"],
  [/(^|\.)b3\.com\.br$/i, "B3 (Brazil)"],
  [/(^|\.)rad\.cvm\.gov\.br$/i, "CVM (Brazil)"],
  [/(^|\.)saudiexchange\.sa$/i, "Saudi Exchange"],
  [/(^|\.)adx\.ae$/i, "ADX"],
  [/(^|\.)dfm\.ae$/i, "DFM"],
  [/(^|\.)kap\.org\.tr$/i, "KAP (Turkey)"],
  [/(^|\.)maya\.tase\.co\.il$/i, "TASE (Israel)"],
  [/(^|\.)clientportal\.jse\.co\.za$/i, "JSE (South Africa)"],
  [/(^|\.)mca\.gov\.in$/i, "MCA (India)"],
  [/(^|\.)connectonline\.asic\.gov\.au$/i, "ASIC (Australia)"],
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matchRegulatorHost(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [re, label] of REGULATOR_HOSTS) {
    if (re.test(host)) return label;
  }
  return null;
}

// ─── Identity heuristics ────────────────────────────────────────────────────

// Normalise a string for substring search: lowercase, collapse whitespace,
// strip a handful of punctuation that varies across HTML/PDF extraction.
function normalise(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[\u00a0\u2007\u202f]/g, " ") // various non-breaking spaces
    .replace(/[’'`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[\s\r\n\t]+/g, " ")
    .trim();
}

// Distinctive tokens from a company name — same "distinctive words" idea as
// issuer-profile.deriveAliases but simpler and generic-safe. We only accept
// tokens ≥ 4 chars that aren't generic corporate qualifiers, because a match
// on "group" or "bank" would fire on almost every filing.
const GENERIC_TOKENS = new Set([
  "the", "and", "for", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "incorporated", "ltd", "limited", "llc", "plc",
  "international", "global", "worldwide", "industries", "industrial",
  "enterprise", "enterprises", "technologies", "technology", "systems",
  "solutions", "services", "products", "bank", "banking", "capital",
  "partners", "resources", "materials", "energy", "power", "motors",
  "financial", "pharmaceutical", "pharmaceuticals", "chemical", "chemicals",
  "insurance", "asset", "management", "trust", "australia", "america",
  "american", "national", "japan", "china", "korea", "india", "canada",
  "canadian", "british", "german", "french",
]);

function distinctiveNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return normalise(name)
    .replace(/[\/\\,.'()&]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !GENERIC_TOKENS.has(w));
}

// True if the target company can be identified in the document based on its
// name tokens, ticker, or provided aliases appearing in title+content head.
// This is the "filer identity match" check for regulator-hosted docs.
function documentReferencesIssuer(
  input: ProvenanceInput,
  content: string
): { matched: boolean; matchedOn: string | null } {
  const nameTokens = distinctiveNameTokens(input.companyName);
  const nameTokenSet = new Set(nameTokens);
  const aliases = (input.companyAliases || [])
    .map(a => normalise(a))
    .filter(a => a.length >= 3);
  const ticker = normalise(input.companyTicker);

  // Ticker match must be word-bounded to avoid substring collisions
  // (e.g. "NEM" inside "problem" — unlikely, but strict is safer).
  if (ticker && ticker.length >= 2) {
    const re = new RegExp(`(^|[^a-z0-9])${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(content)) return { matched: true, matchedOn: `ticker:${input.companyTicker}` };
  }

  // Alias whole-string match. Multi-word aliases (>= 2 space-separated words)
  // are strong signals and match on any occurrence. Single-word aliases that
  // are also the company's sole distinctive name token defer to the name-token
  // 2-occurrence rule below, because one occurrence of "newmont" in a footnote
  // isn't identity.
  for (const a of aliases) {
    if (a.length < 3) continue;
    const isMultiWord = /\s/.test(a);
    const isSoleDistinctiveToken = nameTokens.length === 1 && nameTokenSet.has(a);
    if (!isMultiWord && isSoleDistinctiveToken) {
      // Skip — will be handled by the name-token rule with occurrence counting.
      continue;
    }
    if (content.includes(a)) return { matched: true, matchedOn: `alias:${a}` };
  }

  // Distinctive name-token match — require ≥ 2 distinct tokens to appear so
  // a document that just mentions "kering" once in a footnote doesn't count.
  // For single-distinctive-token companies (e.g. "Newmont" has one), require
  // ≥ 2 occurrences of that token instead.
  if (nameTokens.length >= 2) {
    const hits = nameTokens.filter(t => content.includes(t));
    if (hits.length >= 2) return { matched: true, matchedOn: `name-tokens:${hits.slice(0,2).join(",")}` };
  } else if (nameTokens.length === 1) {
    const t = nameTokens[0];
    // Count occurrences (bounded scan)
    let count = 0;
    let idx = 0;
    while (count < 2) {
      const found = content.indexOf(t, idx);
      if (found < 0) break;
      count++;
      idx = found + t.length;
    }
    if (count >= 2) return { matched: true, matchedOn: `name-token:${t}(x2)` };
  }

  return { matched: false, matchedOn: null };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify a document's provenance relative to a target company.
 *
 * Rules (in order):
 *   1. If hostname matches company.domain or any related_domain → issuer.
 *   2. If hostname is a known regulator/registry host AND the document
 *      references the issuer by ticker, alias, or distinctive name tokens
 *      → issuer (filed-by-issuer).
 *   3. If hostname is a known regulator/registry host but the document does
 *      NOT reference the issuer → third_party. This catches "wrong company's
 *      filing surfaced under this issuer".
 *   4. Otherwise → third_party.
 */
export function classifyProvenance(input: ProvenanceInput): ProvenanceResult {
  const host = hostOf(input.url);

  // Rule 1: hostname match on primary or related domain.
  const primaryDomain = (input.companyDomain || "").replace(/^www\./i, "").toLowerCase();
  const relatedDomains = (input.relatedDomains || [])
    .map(d => (d || "").replace(/^www\./i, "").toLowerCase())
    .filter(Boolean);
  const allIssuerDomains = [primaryDomain, ...relatedDomains].filter(Boolean);
  if (host) {
    for (const d of allIssuerDomains) {
      if (host === d || host.endsWith("." + d)) {
        return { provenance: "issuer", reason: `hostname matches company domain (${d})`, regulatorHost: null };
      }
    }
  }

  // Rule 2 + 3: regulator host with identity check.
  const regulatorLabel = matchRegulatorHost(input.url);
  if (regulatorLabel) {
    // Combine title + first ~8KB of content for the identity scan. If we have
    // no content (e.g. classifying before fetch), fall back to title only —
    // regulator filings usually carry the filer's name/ticker in the title.
    const scanText = normalise([input.title || "", (input.content || "").slice(0, 8192)].join(" "));
    if (scanText) {
      const check = documentReferencesIssuer(input, scanText);
      if (check.matched) {
        return {
          provenance: "issuer",
          reason: `regulator-hosted (${regulatorLabel}) + identity match on ${check.matchedOn}`,
          regulatorHost: regulatorLabel,
        };
      }
    }
    // Regulator host but no identity signal — treat as third-party (this is
    // likely another issuer's filing that was surfaced by mistake).
    return {
      provenance: "third_party",
      reason: `regulator-hosted (${regulatorLabel}) but no ticker/alias/name-token match found`,
      regulatorHost: regulatorLabel,
    };
  }

  // Rule 4: default.
  return {
    provenance: "third_party",
    reason: host ? `hostname ${host} does not match company domain and is not a known regulator host` : "invalid URL",
    regulatorHost: null,
  };
}

// Exported for use by pipeline.ts (existing string field) — encodes the
// two-way class into the DB `source_type` column.
export function provenanceToSourceType(p: ProvenanceClass): "first_party" | "third_party" {
  return p === "issuer" ? "first_party" : "third_party";
}
