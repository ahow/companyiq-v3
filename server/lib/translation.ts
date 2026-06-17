import crypto from "crypto";
import { completeWithFallback } from "./ai-providers.js";

/**
 * Multilingual passage translation (DeepSeek-first).
 *
 * Strategy (per product decision): translate only the *retrieved evidence
 * passages* to English before scoring — never whole documents — using the LLM
 * we already pay for (DeepSeek primary, with the standard fallback chain). This
 * is ~100x cheaper than dedicated document-translation APIs and is sufficient
 * for scoring because only the evidence that is actually scored needs to be in
 * English. Original (source-language) text is always preserved for audit.
 *
 * The translation runs at the corpus-assembly stage so each foreign passage is
 * translated at most once per company (not once per measure), and so BM25
 * retrieval and the English topic-floor operate over English text.
 */

// ─── Config (env-tunable) ────────────────────────────────────────────────────

const TRANSLATION_PROVIDER = process.env.TRANSLATION_PROVIDER || "deepseek";
// Read at call-time so the feature can be toggled without a restart.
function translationEnabled(): boolean {
  return process.env.MULTILINGUAL_TRANSLATION_ENABLED !== "false";
}
// Below this non-English character ratio a block is treated as English and skipped.
const NON_ENGLISH_RATIO_THRESHOLD = parseFloat(process.env.TRANSLATION_NONENGLISH_RATIO || "0.10");
// Max characters of foreign text to translate per company (cost guardrail).
const MAX_TRANSLATE_CHARS = parseInt(process.env.TRANSLATION_MAX_CHARS || "120000", 10);
// Block size sent to the LLM per translation call.
const TRANSLATE_BLOCK_SIZE = parseInt(process.env.TRANSLATION_BLOCK_SIZE || "6000", 10);

// ─── Language detection (heuristic, no external deps) ────────────────────────

// CJK, Hangul, Hiragana/Katakana, and common accented-Latin ranges.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
// Latin letters with diacritics used by FR/DE/ES/IT/PT/NL/Nordic.
const ACCENTED_LATIN_RE = /[\u00c0-\u024f]/g;

// Common high-frequency function words for major Latin-script languages. These
// disambiguate languages that are mostly ASCII (French/Spanish/Italian/etc.),
// where the accent ratio alone is too weak a signal. Word-boundaried to avoid
// English false positives.
const FOREIGN_STOPWORDS_RE = new RegExp(
  "\\b(" + [
    // FR
    "le", "la", "les", "des", "une", "nous", "notre", "avec", "pour", "dans", "est", "sont", "qui", "sur",
    // ES
    "el", "los", "las", "una", "nuestra", "nuestro", "con", "para", "que", "como", "por",
    // IT
    "il", "lo", "gli", "della", "nostro", "sono", "con", "per", "che",
    // PT
    "os", "as", "uma", "nossa", "nosso", "com", "para", "que", "como",
    // DE
    "und", "der", "die", "das", "ist", "sind", "unsere", "unser", "mit", "f\u00fcr", "von", "eine",
    // NL
    "het", "een", "onze", "met", "voor", "zijn", "van",
  ].join("|") + ")\\b",
  "gi"
);

// Native-language AI terms — strong signal regardless of script.
const FOREIGN_AI_RE = new RegExp(
  [
    "intelligence artificielle", "intelligenza artificiale", "inteligencia artificial",
    "intelig\u00eancia artificial", "k\u00fcnstliche intelligenz", "kunstmatige intelligentie",
    "artificiell intelligens", "teko\u00e4ly", "kunstig intelligens",
  ].join("|"),
  "i"
);

/** Returns the fraction of characters that are clearly non-English (0..1). */
export function nonEnglishRatio(text: string): number {
  if (!text) return 0;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  const letters = sample.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (letters.length === 0) return 0;
  const cjk = (sample.match(CJK_RE) || []).length;
  const accented = (sample.match(ACCENTED_LATIN_RE) || []).length;
  return (cjk + accented) / letters.length;
}

/** Quick check whether a block likely needs translation. */
export function looksNonEnglish(text: string): boolean {
  if (!text) return false;
  // CJK presence is a strong signal even at low ratios (dense scripts).
  CJK_RE.lastIndex = 0;
  if (CJK_RE.test(text)) return true;
  // Native-language AI terms are an unambiguous signal.
  if (FOREIGN_AI_RE.test(text)) return true;
  // Accented-Latin density (Nordic/German/etc.).
  if (nonEnglishRatio(text) >= NON_ENGLISH_RATIO_THRESHOLD) return true;
  // Latin-script languages that are mostly ASCII: use foreign function-word
  // density relative to text length as the discriminator.
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  const words = sample.split(/\s+/).filter(Boolean).length;
  if (words >= 8) {
    const foreign = (sample.match(FOREIGN_STOPWORDS_RE) || []).length;
    if (foreign / words >= 0.12) return true;
  }
  return false;
}

// ─── Translation cache (per-process, content-hash keyed) ─────────────────────

const cache = new Map<string, string>();
function hash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

async function translateBlock(block: string): Promise<string> {
  const key = hash(block);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const { text } = await completeWithFallback(TRANSLATION_PROVIDER, {
      system:
        "You are a professional financial-document translator. Translate the user's text to English. " +
        "Preserve meaning, numbers, named entities, and company/product names exactly. " +
        "Do not summarize, omit, or add commentary. If a segment is already English, return it unchanged. " +
        "Output only the translation, with no preamble.",
      prompt: block,
      maxTokens: Math.min(8000, Math.ceil(block.length / 2) + 500),
    });
    const out = (text || "").trim() || block;
    cache.set(key, out);
    return out;
  } catch (err: any) {
    console.warn(`[Translation] block failed (${err?.message}); keeping original`);
    cache.set(key, block);
    return block;
  }
}

/**
 * Translate the foreign-language portions of a single document's text to
 * English, preserving the original inline for audit. English documents are
 * returned unchanged (no LLM call). Honors the per-company char budget via the
 * shared `budget` accumulator.
 */
async function translateDocumentText(
  text: string,
  budget: { remaining: number }
): Promise<{ text: string; translated: boolean; lang?: string }> {
  if (!text || !looksNonEnglish(text)) return { text, translated: false };
  if (budget.remaining <= 0) return { text, translated: false };

  // Split into paragraph blocks; translate only the non-English ones.
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let didTranslate = false;

  for (const para of paras) {
    if (budget.remaining > 0 && para.trim().length > 0 && looksNonEnglish(para)) {
      // Chunk long paragraphs to keep each LLM call bounded.
      const pieces: string[] = [];
      for (let i = 0; i < para.length; i += TRANSLATE_BLOCK_SIZE) {
        pieces.push(para.slice(i, i + TRANSLATE_BLOCK_SIZE));
      }
      const translatedPieces: string[] = [];
      for (const piece of pieces) {
        if (budget.remaining <= 0) {
          translatedPieces.push(piece); // budget exhausted: keep original
          continue;
        }
        const t = await translateBlock(piece);
        budget.remaining -= piece.length;
        translatedPieces.push(t);
      }
      const translated = translatedPieces.join("");
      // Preserve the original inline (audit) but lead with English so BM25 +
      // the English topic-floor operate over the translated text.
      out.push(`${translated}\n[original-language source]: ${para}`);
      didTranslate = true;
    } else {
      out.push(para);
    }
  }

  return { text: out.join("\n\n"), translated: didTranslate };
}

/**
 * Corpus-level entry point. Takes the per-document texts (already fetched and
 * length-capped) and returns English-forward versions, translating only the
 * non-English ones via DeepSeek, within a per-company character budget.
 *
 * Returns the (possibly translated) texts plus stats for logging/audit.
 */
export async function translateDocumentsToEnglish(
  documentTexts: string[]
): Promise<{ texts: string[]; translatedCount: number; charsTranslated: number }> {
  if (!translationEnabled()) {
    return { texts: documentTexts, translatedCount: 0, charsTranslated: 0 };
  }
  const budget = { remaining: MAX_TRANSLATE_CHARS };
  const startBudget = budget.remaining;
  let translatedCount = 0;

  const texts: string[] = [];
  for (const text of documentTexts) {
    const res = await translateDocumentText(text, budget);
    if (res.translated) translatedCount++;
    texts.push(res.text);
  }

  return {
    texts,
    translatedCount,
    charsTranslated: startBudget - budget.remaining,
  };
}
