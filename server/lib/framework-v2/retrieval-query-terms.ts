// ─── Approach 2a: corpus-SELECTION query vocabulary generation + DF gate ─────
//
// Generates a clean, DISCRIMINATIVE query vocabulary for corpus selection at
// framework CREATION, distinct from the prompt-only topicSynonyms. The result is
// persisted to frameworks.retrievalQueryTerms and fed (weighted) into
// summarizeDocuments' allQueryTerms so the corpus is chosen by the framework's own
// discriminative vocabulary rather than generic business/stop words.
//
// TWO stages, both GENERIC / framework-independent:
//   (1) an LLM generation pass that produces 15-30 topic discriminators
//       (product/technique/artefact vocabulary a relevant passage would contain);
//   (2) a DF-validation gate that scores each candidate's document-frequency
//       against a small BUNDLED reference corpus of unrelated, generic corporate
//       filings and DROPS any term whose DF is stopword-indistinguishable. This is
//       a structural invariant (non-discriminating terms), safe to hard-filter —
//       NOT an empirical quality threshold on the framework's own content.
//
// Nothing here is company/framework/topic-specific: the reference corpus contains
// only generic boilerplate, and the blocklist is generic business/stop words.

// A small reference corpus of UNRELATED, generic corporate-filing boilerplate
// (annual-report / proxy / governance / risk language). It contains NO topic
// vocabulary for any specific framework (no AI/climate/tax/etc.), so a genuine
// topic discriminator appears in ~none of these docs (low DF → kept), while a
// generic business/stop word appears across most of them (high DF → dropped).
export const REFERENCE_FILING_CORPUS: string[] = [
  "The board of directors is responsible for the overall management and strategic direction of the company. During the financial year the board reviewed the performance of the business, approved the annual budget, and considered the principal risks and uncertainties facing the group.",
  "The audit committee met regularly throughout the year to review the integrity of the financial statements, the effectiveness of internal controls, and the independence of the external auditor. The committee reports its findings to the board.",
  "Our people are central to the success of the organisation. We remain committed to attracting, developing and retaining talented employees, and to fostering a diverse and inclusive workplace that reflects the communities in which we operate.",
  "The remuneration committee determines the policy for executive directors and senior management. Total compensation comprises base salary, annual bonus and long-term incentive awards designed to align the interests of management with those of shareholders.",
  "The group is exposed to a variety of financial risks including credit risk, liquidity risk and market risk. The company manages these risks through a framework of policies and procedures approved by the board and monitored by management.",
  "Revenue increased during the period driven by growth across our principal markets. Operating profit and earnings per share improved compared with the prior year, reflecting continued focus on operational efficiency and cost discipline.",
  "The company is committed to conducting business responsibly and with integrity. Our code of conduct sets out the standards of behaviour expected of all employees, and we operate a confidential whistleblowing channel for reporting concerns.",
  "This annual report contains forward-looking statements that involve risks and uncertainties. Actual results may differ materially from those expressed or implied. The company undertakes no obligation to update these statements except as required by law.",
  "The directors present their report together with the audited financial statements for the year ended. The results for the year and the financial position of the company and the group are set out in the accompanying statements and related notes.",
  "Shareholders are invited to attend the annual general meeting. The notice of meeting sets out the resolutions to be proposed. The board recommends that shareholders vote in favour of each of the resolutions as they intend to do in respect of their own holdings.",
];

// Generic business / stop words that are never useful corpus discriminators.
// GENERIC across ALL frameworks — no topic vocabulary here.
export const GENERIC_TERM_BLOCKLIST: Set<string> = new Set([
  "the", "and", "for", "with", "our", "your", "their", "this", "that", "these", "those",
  "company", "companies", "business", "businesses", "group", "corporation", "organisation", "organization",
  "board", "director", "directors", "management", "committee", "shareholder", "shareholders",
  "strategy", "strategic", "governance", "framework", "policy", "policies", "process", "processes",
  "report", "reporting", "annual", "financial", "statement", "statements", "year", "period",
  "performance", "risk", "risks", "control", "controls", "compliance", "disclosure", "disclosures",
  "how", "what", "why", "when", "where", "which", "who", "assess", "assessment", "effectively",
  "approach", "approaches", "opportunity", "opportunities", "objective", "objectives", "operation", "operations",
  "value", "values", "growth", "market", "markets", "customer", "customers", "employee", "employees",
  "significant", "material", "materially", "including", "various", "overall", "principal", "relevant",
  "manage", "managing", "managed", "ensure", "ensuring", "provide", "providing", "support", "supporting",
]);

const DF_STOPWORD_THRESHOLD = 0.5; // appears in >= half of unrelated filings → stopword-like

function normaliseTerm(t: unknown): string {
  return typeof t === "string" ? t.trim().toLowerCase() : "";
}

/** Document-frequency of a term across the reference corpus (fraction 0..1).
 * A reference doc "contains" the term when the term (as a whole lowercased
 * substring) appears in the doc — matching multi-word phrases and single tokens
 * uniformly. Pure, deterministic. */
export function referenceDocumentFrequency(term: string, corpus: string[] = REFERENCE_FILING_CORPUS): number {
  const needle = normaliseTerm(term);
  if (!needle) return 1; // empty → treat as maximally stopword-like (drop)
  const docs = corpus.length || 1;
  let hits = 0;
  for (const doc of corpus) {
    if (doc.toLowerCase().includes(needle)) hits++;
  }
  return hits / docs;
}

export interface RetrievalTermValidationResult {
  kept: string[];
  dropped: Array<{ term: string; reason: "blocklist" | "high_df" | "too_short" | "duplicate" | "empty" }>;
}

/**
 * DF-validation gate (stage 2). GENERIC / framework-independent. Cleans an array
 * of candidate discriminators:
 *   - drops empty / blocklisted / stopword-like (DF >= threshold) terms;
 *   - drops single-character noise (length < 2);
 *   - de-duplicates case-insensitively, preserving first-seen order (deterministic).
 * Returns both the kept set and an inspectable dropped list. Never throws.
 */
export function validateRetrievalQueryTerms(
  candidates: unknown,
  opts?: { corpus?: string[]; dfThreshold?: number },
): RetrievalTermValidationResult {
  const corpus = opts?.corpus ?? REFERENCE_FILING_CORPUS;
  const dfThreshold = opts?.dfThreshold ?? DF_STOPWORD_THRESHOLD;
  const kept: string[] = [];
  const dropped: RetrievalTermValidationResult["dropped"] = [];
  const seen = new Set<string>();
  const list = Array.isArray(candidates) ? candidates : [];

  for (const raw of list) {
    const original = typeof raw === "string" ? raw.trim() : "";
    const term = normaliseTerm(raw);
    if (!term) { dropped.push({ term: original, reason: "empty" }); continue; }
    if (term.length < 2) { dropped.push({ term: original, reason: "too_short" }); continue; }
    if (seen.has(term)) { dropped.push({ term: original, reason: "duplicate" }); continue; }
    // Blocklist applies to single-token generic words; a multi-word phrase whose
    // FIRST token is generic (e.g. "machine learning") is still allowed.
    if (!term.includes(" ") && GENERIC_TERM_BLOCKLIST.has(term)) {
      dropped.push({ term: original, reason: "blocklist" });
      continue;
    }
    if (referenceDocumentFrequency(term, corpus) >= dfThreshold) {
      dropped.push({ term: original, reason: "high_df" });
      continue;
    }
    seen.add(term);
    kept.push(original); // preserve the original casing/spelling the LLM produced
  }

  return { kept, dropped };
}

// Injected LLM shape (matches ai-providers.completeWithFallback's relevant fields)
// so this module is unit-testable without importing the provider stack.
export type LlmComplete = (
  provider: string,
  args: { system: string; prompt: string; maxTokens?: number; temperature?: number },
) => Promise<{ text: string }>;

export interface GenerateRetrievalTermsInput {
  topicTerm?: string | null;
  topicSynonyms?: string[] | null;
  topicDescription?: string | null;
  frameworkName?: string | null;
  providerName?: string;
}

const GENERATION_SYSTEM_PROMPT = `You produce a CORPUS-SELECTION query vocabulary for a document-retrieval system. Given a framework's topic, output the distinctive vocabulary that a passage genuinely ABOUT this topic would contain — the products, techniques, artefacts, systems, named methods, and quantified-metric words specific to the topic.

HARD RULES:
- Output 15-30 terms.
- Each term is a topic DISCRIMINATOR: a word or short (<=2 word) phrase that is DENSE in relevant passages but RARE in generic corporate boilerplate (annual-report/governance/proxy language).
- COMMON topic vocabulary is fine (e.g. for an AI topic: "machine learning", "chatbot", "algorithm", "model", "automation"); GENERIC business/stop words are NOT (reject: strategy, governance, management, board, framework, risk, performance, disclosure, company, stakeholder, objective, etc.).
- Prefer single tokens; include standard acronyms/abbreviations as their own entries (e.g. "ML", "LLM", "5G") — short tokens are allowed here.
- No company names, no framework name, no years, no generic verbs.
- Output ONLY a JSON array of strings, nothing else. Example: ["generative", "machine learning", "chatbot", "LLM", "automation"]`;

/**
 * Stage 1 + 2: generate discriminative candidates via the LLM, then run the
 * DF-validation gate. Returns the cleaned, persistable term set (possibly empty).
 * Never throws — on any LLM/parse failure it degrades to [] so framework creation
 * proceeds unchanged (backward-compatible). The DF gate runs regardless, so even a
 * partially-noisy LLM response is cleaned before persistence.
 */
export async function generateRetrievalQueryTerms(
  input: GenerateRetrievalTermsInput,
  llm: LlmComplete,
  opts?: { corpus?: string[]; dfThreshold?: number },
): Promise<{ terms: string[]; validation: RetrievalTermValidationResult; raw: string[] }> {
  const emptyResult = { terms: [], validation: { kept: [], dropped: [] }, raw: [] as string[] };
  const topic = [
    input.topicTerm ? `Topic: ${input.topicTerm}` : "",
    input.topicSynonyms && input.topicSynonyms.length ? `Known synonyms: ${input.topicSynonyms.join(", ")}` : "",
    input.topicDescription ? `Topic description: ${input.topicDescription}` : "",
    input.frameworkName ? `Framework name (do NOT include as a term): ${input.frameworkName}` : "",
  ].filter(Boolean).join("\n");
  if (!topic.trim()) return emptyResult;

  let raw: string[] = [];
  try {
    const { text } = await llm(input.providerName || "claude", {
      system: GENERATION_SYSTEM_PROMPT,
      prompt: topic,
      maxTokens: 800,
      temperature: 0.2,
    });
    raw = parseTermArray(text);
  } catch {
    return emptyResult; // degrade gracefully — creation proceeds with []
  }

  const validation = validateRetrievalQueryTerms(raw, opts);
  return { terms: validation.kept, validation, raw };
}

/** Tolerant parse of an LLM reply into a string[] of terms. Accepts a bare JSON
 * array, a ```json fenced array, or the first balanced [...] blob. Never throws. */
export function parseTermArray(text: string | null | undefined): string[] {
  if (!text) return [];
  const tryParse = (s: string): string[] | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    } catch { /* fall through */ }
    return null;
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const b = tryParse(text.slice(start, end + 1));
    if (b) return b;
  }
  return [];
}
