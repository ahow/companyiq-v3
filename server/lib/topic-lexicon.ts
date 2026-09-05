import { completeWithFallback } from "./ai-providers.js";
import * as storage from "../storage.js";

// ─── Framework-Derived Topic Lexicon (topic-agnostic) ────────────────────────
//
// CompanyIQ is a template-driven platform: a Framework can target ANY topic
// (AI governance, climate, cyber-security, human rights, tax transparency, …).
// Retrieval used to lean on a single hard-coded AI term list, which both (a) made
// the engine AI-specific and (b) missed issuers that use adjacent vocabulary for
// the SAME topic (e.g. Amazon discussing "machine learning"/"generative AI"
// rather than the literal phrase "artificial intelligence").
//
// This module derives a high-precision synonym/terminology set FROM THE FRAMEWORK
// ITSELF — its topic description plus the wording of its measures — via a single
// cached LLM expansion. The result is reused across every company scored against
// that framework, so the cost is amortised to one call per framework.
//
// The lexicon is cached in `workspace_settings` under a deterministic key, so no
// schema migration is required. A deterministic token fallback (drawn from the
// framework text) guarantees the mechanism degrades gracefully if the LLM is
// unavailable.

const LEXICON_MODEL = "deepseek";
const LEXICON_SETTING_PREFIX = "topic_lexicon:v1:";
// Bound the term set so the BM25 topic regex stays cheap and high-precision.
const MAX_TERMS = 80;

export interface TopicLexicon {
  terms: string[];
  source: "llm" | "fallback" | "cache";
}

/** Deterministic stop-word-filtered token fallback drawn from framework text. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "their", "they", "company",
  "companies", "framework", "assessment", "disclosure", "disclosures", "report",
  "reports", "across", "wider", "economy", "effectively", "manage", "manages",
  "managing", "related", "risks", "risk", "opportunity", "opportunities", "how",
  "are", "its", "was", "has", "have", "been", "which", "such", "into", "over",
  "within", "between", "about", "these", "those", "other", "than", "also", "may",
  "must", "should", "would", "could", "where", "when", "what", "whom", "whose",
]);

function fallbackTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/)) {
    const t = raw.trim();
    if (t.length < 4 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Derive (and cache) the topic lexicon for a framework. Expands the topic
 * description + measure titles into a synonym/terminology set via one LLM call,
 * cached per framework. Topic-agnostic by construction.
 *
 * @param frameworkId   used as the cache key
 * @param workspaceId   workspace owning the cache row
 * @param topicDescription framework topic description (primary signal)
 * @param frameworkName  framework name (secondary signal)
 * @param measureTitles  measure titles/definitions (sharpen domain vocabulary)
 */
export async function deriveTopicLexicon(opts: {
  frameworkId: number;
  workspaceId: number;
  topicDescription?: string | null;
  frameworkName?: string | null;
  measureTitles?: string[];
}): Promise<TopicLexicon> {
  const { frameworkId, workspaceId, topicDescription, frameworkName, measureTitles } = opts;
  const settingKey = `${LEXICON_SETTING_PREFIX}${frameworkId}`;

  // 1) Cache check (workspace_settings).
  try {
    const settings = await storage.getSettings(workspaceId);
    const cachedRaw = settings[settingKey];
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed?.terms) && parsed.terms.length > 0) {
        return { terms: parsed.terms, source: "cache" };
      }
    }
  } catch {
    // ignore cache read errors and fall through to derivation
  }

  const topic = (topicDescription || "").trim();
  const name = (frameworkName || "").trim();
  const measuresBlock = (measureTitles || []).slice(0, 40).join("\n- ");
  const fallback = [...new Set([...fallbackTokens(topic), ...fallbackTokens(name)])].slice(0, MAX_TERMS);

  // No topic signal at all → deterministic fallback only.
  if (!topic && !name) {
    if (fallback.length > 0) await persist(workspaceId, settingKey, fallback);
    return { terms: fallback, source: "fallback" };
  }

  // 2) LLM expansion.
  const prompt = `You are building a high-precision RETRIEVAL LEXICON for an automated corporate-disclosure scoring engine.

The assessment framework targets this topic:
"""
${topic || name}
"""
${measuresBlock ? `\nThe framework's measures include:\n- ${measuresBlock}\n` : ""}
TASK: List the distinctive words and short phrases that signal a passage is ABOUT THIS TOPIC. Include:
- the core concept and its common synonyms / abbreviations / acronyms,
- closely-related sub-concepts and technologies practitioners use interchangeably for this topic,
- the most common NON-ENGLISH renderings of the core concept (French, German, Spanish, Italian, Portuguese, Chinese (Simplified & Traditional), Japanese, Korean) — only if a standard term exists.

RULES:
- High precision only. Do NOT include generic business words (e.g. "report", "risk", "company", "strategy") that would match unrelated passages.
- Prefer multi-word phrases where a single word would be ambiguous.
- Return ONLY a JSON object: {"terms": ["...", "..."]}. Max ${MAX_TERMS} entries. Lowercase. No duplicates.`;

  // 2026-09-05 fix: previously any LLM failure (network, JSON parse, empty response)
  // silently fell through to the generic-token fallback, which then persisted a
  // useless lexicon (e.g. Framework 3's cache was "examine, strength, plans, strategy,
  // management, actions, performance, oversight, nature, biodiversity, business" —
  // 8 generic verbs plus 2 topic terms buried at positions 9-10). Result: every
  // domain-anchored `site:X <topic>` query was firing on generic verbs, not nature
  // terminology.
  //
  // 2026-09-05 (b): also try openai (gpt-4o-mini) as an explicit second attempt if
  // deepseek returns zero terms — we've seen DeepSeek silently return empty content
  // for this exact prompt shape when the framework description is short, and the
  // completeWithFallback chain doesn't distinguish "returned empty" from "returned
  // usable output".
  const attemptLlm = async (providerName: string): Promise<string[]> => {
    try {
      const { text } = await completeWithFallback(providerName, {
        system: "You generate precise topic-retrieval lexicons. Return only valid JSON.",
        prompt,
        json: true,
        maxTokens: 1200,
        temperature: 0,
      });
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.warn(`[topic-lexicon] ${providerName} returned unparseable JSON for framework ${frameworkId}: ${(text || "").slice(0, 200)}`);
      }
      const rawTerms: string[] = Array.isArray(parsed?.terms) ? parsed.terms : [];
      const cleaned = [...new Set(
        rawTerms
          .filter((t: unknown): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length >= 2 && t.length <= 60),
      )].slice(0, MAX_TERMS);
      if (cleaned.length === 0) {
        console.warn(`[topic-lexicon] ${providerName} returned zero usable terms for framework ${frameworkId} (raw text len=${(text || "").length})`);
      } else {
        console.log(`[topic-lexicon] ${providerName} produced ${cleaned.length} terms for framework ${frameworkId}; first-5: ${cleaned.slice(0, 5).join(", ")}`);
      }
      return cleaned;
    } catch (error: any) {
      console.warn(`[topic-lexicon] ${providerName} expansion failed for framework ${frameworkId}: ${error?.message || error}`);
      return [];
    }
  };

  let llmTerms = await attemptLlm(LEXICON_MODEL);
  if (llmTerms.length === 0) {
    console.log(`[topic-lexicon] retrying with openai for framework ${frameworkId}`);
    llmTerms = await attemptLlm("openai");
  }

  // ORDER MATTERS: topic-specific LLM terms first, then deterministic fallback
  // tokens (framework title/description tokens like "examine", "strength", ...).
  // Every downstream slice(0, N) assumes top-of-list = topic-specific.
  const merged = [...new Set([...llmTerms, ...fallback])].slice(0, MAX_TERMS);
  if (merged.length > 0) {
    await persist(workspaceId, settingKey, merged);
    return { terms: merged, source: llmTerms.length > 0 ? "llm" : "fallback" };
  }
  return { terms: fallback, source: "fallback" };
}

async function persist(workspaceId: number, key: string, terms: string[]): Promise<void> {
  try {
    await storage.setSetting(workspaceId, key, JSON.stringify({ terms, ts: Date.now() }));
  } catch (error: any) {
    console.warn(`[topic-lexicon] persist failed (${key}): ${error?.message || error}`);
  }
}
