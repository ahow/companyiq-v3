import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

// ─── Key Collection Helper ───────────────────────────────────────────────────

// Collects all keys for a provider from env vars, supporting BOTH:
//   1. Numbered variants: KEY, KEY2, KEY3, ... (e.g., DEEPSEEK_API_KEY, DEEPSEEK_API_KEY2)
//   2. Comma-separated values within a single var: KEY="k1,k2,k3"
// Returns a deduplicated list of non-empty keys for round-robin rotation.
export function collectApiKeys(baseEnvName: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const addFrom = (raw: string | undefined) => {
    if (!raw) return;
    for (const part of raw.split(",").map((k) => k.trim()).filter((k) => k.length > 0)) {
      if (!seen.has(part)) {
        seen.add(part);
        keys.push(part);
      }
    }
  };
  // Base var (e.g., DEEPSEEK_API_KEY)
  addFrom(process.env[baseEnvName]);
  // Numbered variants (e.g., DEEPSEEK_API_KEY2 ... DEEPSEEK_API_KEY10)
  for (let i = 2; i <= 10; i++) {
    addFrom(process.env[`${baseEnvName}${i}`]);
  }
  return keys;
}

// ─── Global LLM Concurrency Limiter ──────────────────────────────────────────
// A single semaphore gates ALL outbound LLM calls in this process. No matter how
// many companies/documents are processed concurrently (worker concurrency ×
// in-company fetch parallelism), at most LLM_MAX_CONCURRENCY requests are in
// flight at once. This keeps the primary provider (DeepSeek) within its rate
// limit and prevents 429-storm-induced dropped scoring — protecting analysis
// quality at scale. When running multiple worker replicas, size this so that
// (LLM_MAX_CONCURRENCY × replica_count) stays within the provider's account
// limit.
const LLM_MAX_CONCURRENCY = parseInt(process.env.LLM_MAX_CONCURRENCY || "8", 10);
let llmActive = 0;
const llmWaiters: Array<() => void> = [];

async function acquireLlmSlot(): Promise<void> {
  if (llmActive < LLM_MAX_CONCURRENCY) {
    llmActive++;
    return;
  }
  await new Promise<void>((resolve) => llmWaiters.push(resolve));
  llmActive++;
}

function releaseLlmSlot(): void {
  llmActive = Math.max(0, llmActive - 1);
  const next = llmWaiters.shift();
  if (next) next();
}

// ─── Provider Interface ──────────────────────────────────────────────────────

export interface AIProvider {
  name: string;
  model: string;
  family: string;
  isAvailable(): boolean;
  complete(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    json?: boolean;
    temperature?: number;
  }): Promise<string>;
}

// ─── Claude Provider ─────────────────────────────────────────────────────────

class ClaudeProvider implements AIProvider {
  name = "claude";
  model: string;
  family = "anthropic";
  private apiKeys: string[];
  private currentKeyIndex: number = 0;

  constructor(model: string = "claude-sonnet-4-5-20250929") {
    this.model = model;
    // Collect ANTHROPIC_API_KEY, ANTHROPIC_API_KEY2, ANTHROPIC_API_KEY3, ... for rotation
    this.apiKeys = collectApiKeys("ANTHROPIC_API_KEY");
  }

  private getNextKey(): string {
    if (this.apiKeys.length === 0) throw new Error("Claude not configured");
    const key = this.apiKeys[this.currentKeyIndex % this.apiKeys.length];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  isAvailable(): boolean {
    return this.apiKeys.length > 0;
  }

  async complete(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    json?: boolean;
    temperature?: number;
  }): Promise<string> {
    if (this.apiKeys.length === 0) throw new Error("Claude not configured");
    // Try each available key once; rotate on rate-limit (429) or auth (401) errors
    let lastError: any;
    const attempts = Math.max(1, this.apiKeys.length);
    for (let i = 0; i < attempts; i++) {
      const client = new Anthropic({ apiKey: this.getNextKey() });
      try {
        const response = await client.messages.create({
          model: this.model,
          max_tokens: Math.min(opts.maxTokens ?? 4096, 8192),
          temperature: opts.temperature ?? 0,
          system: opts.system,
          messages: [{ role: "user", content: opts.prompt }],
        });
        const block = response.content[0];
        if (block.type === "text") return block.text;
        throw new Error("Unexpected response type from Claude");
      } catch (error: any) {
        lastError = error;
        const status = error.status || error.response?.status;
        if ((status === 429 || status === 401) && i < attempts - 1) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }
}

class ClaudeHaikuProvider extends ClaudeProvider {
  constructor() {
    super("claude-haiku-4-5-20251001");
    this.name = "claude-haiku";
  }
}

// ─── OpenAI-Compatible Provider (DeepSeek, Mistral, Kimi, OpenAI, MiniMax) ──

class OpenAICompatibleProvider implements AIProvider {
  name: string;
  model: string;
  family: string;
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private baseUrl: string;
  private seed: number | undefined;
  private maxOutputTokens: number;

  private extraHeaders: Record<string, string>;
  private supportsJsonMode: boolean;
  private supportsSeed: boolean;

  constructor(config: {
    name: string;
    model: string;
    family: string;
    apiKeyEnv: string;
    baseUrl: string;
    seed?: number;
    maxOutputTokens?: number;
    extraHeaders?: Record<string, string>;
    supportsJsonMode?: boolean;
    supportsSeed?: boolean;
  }) {
    this.name = config.name;
    this.model = config.model;
    this.family = config.family;
    // Collect keys for rotation, supporting both numbered variants (KEY, KEY2, KEY3)
    // and comma-separated values within a single var.
    this.apiKeys = collectApiKeys(config.apiKeyEnv);
    this.baseUrl = config.baseUrl;
    this.seed = config.seed;
    this.maxOutputTokens = config.maxOutputTokens ?? 8192;
    this.extraHeaders = config.extraHeaders ?? {};
    // JSON mode (response_format) is supported by most OpenAI-compatible APIs, but
    // not universally (e.g., MiniMax rejects response_format type json_object);
    // allow opt-out.
    this.supportsJsonMode = config.supportsJsonMode ?? true;
    // Mistral's API rejects the `seed` parameter (422 extra_forbidden); allow opt-out.
    this.supportsSeed = config.supportsSeed ?? true;
  }

  private getNextKey(): string {
    if (this.apiKeys.length === 0) throw new Error(`${this.name} not configured`);
    const key = this.apiKeys[this.currentKeyIndex % this.apiKeys.length];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  isAvailable(): boolean {
    return this.apiKeys.length > 0;
  }

  async complete(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    json?: boolean;
    temperature?: number;
  }): Promise<string> {
    const body: any = {
      model: this.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      max_tokens: Math.min(opts.maxTokens ?? 4096, this.maxOutputTokens),
      temperature: opts.temperature ?? 0,
    };

    if (this.seed !== undefined && this.supportsSeed) body.seed = this.seed;
    if (opts.json && this.supportsJsonMode) body.response_format = { type: "json_object" };

    // Try each available key once; rotate on rate-limit (429) or auth (401) errors
    let lastError: any;
    const attempts = Math.max(1, this.apiKeys.length);
    for (let i = 0; i < attempts; i++) {
      const apiKey = this.getNextKey();
      try {
        const response = await axios.post(
          `${this.baseUrl}/chat/completions`,
          body,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...this.extraHeaders,
            },
            timeout: 120000,
          }
        );
        return response.data.choices[0].message.content;
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        // Only rotate to another key for rate-limit or auth errors; otherwise fail fast
        if (status === 429 || status === 401) {
          if (i < attempts - 1) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
        }
        throw error;
      }
    }
    throw lastError;
  }
}

// ─── Gemini Provider ─────────────────────────────────────────────────────────

class GeminiProvider implements AIProvider {
  name = "gemini";
  model = "gemini-2.5-flash";
  family = "google";
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async complete(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    json?: boolean;
    temperature?: number;
  }): Promise<string> {
    if (!this.apiKey) throw new Error("Gemini not configured");

    const body: any = {
      contents: [{ parts: [{ text: opts.prompt }] }],
      systemInstruction: { parts: [{ text: opts.system }] },
      generationConfig: {
        temperature: opts.temperature ?? 0,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    };

    if (opts.json) {
      body.generationConfig.responseMimeType = "application/json";
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      body,
      { timeout: 180000 }
    );

    return response.data.candidates[0].content.parts[0].text;
  }
}

// ─── Provider Registry ───────────────────────────────────────────────────────

const providers: Map<string, AIProvider> = new Map();

function initProviders() {
  // Claude
  const claude = new ClaudeProvider();
  providers.set("claude", claude);

  // Claude Haiku (cheap gate model)
  const haiku = new ClaudeHaikuProvider();
  providers.set("claude-haiku", haiku);

  // GPT-4o-mini (cheap, fast gate model — fallback when Claude is unavailable)
  const gpt4oMini = new OpenAICompatibleProvider({
    name: "gpt-4o-mini",
    model: "gpt-4o-mini",
    family: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
    seed: 42,
    maxOutputTokens: 16384,
  });
  providers.set("gpt-4o-mini", gpt4oMini);

  // DeepSeek (supports up to 8K output tokens)
  const deepseek = new OpenAICompatibleProvider({
    name: "deepseek",
    model: "deepseek-chat",
    family: "deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    seed: 42,
    maxOutputTokens: 8192,
  });
  providers.set("deepseek", deepseek);

  // DeepSeek V4-Pro (flagship-tier; direct API). Supports JSON mode cleanly and
  // returns pure JSON with no reasoning preamble (verified), so no special
  // handling needed. Higher quality than V4-Flash at ~3x the cost.
  const deepseekPro = new OpenAICompatibleProvider({
    name: "deepseek-pro",
    model: "deepseek-v4-pro",
    family: "deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    seed: 42,
    maxOutputTokens: 8192,
  });
  providers.set("deepseek-pro", deepseekPro);

  // OpenAI (gpt-4o supports up to 16K output tokens)
  const openai = new OpenAICompatibleProvider({
    name: "openai",
    model: "gpt-4o",
    family: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
    seed: 42,
    maxOutputTokens: 16384,
  });
  providers.set("openai", openai);

  // Mistral (supports up to 8K output tokens by default)
  if (!process.env.MISTRAL_API_KEY) process.env.MISTRAL_API_KEY = "su87mOP2zoe9nQmj0nQWyIbpETWovjJd";
  const mistral = new OpenAICompatibleProvider({
    name: "mistral",
    model: "mistral-large-latest",
    family: "mistral",
    apiKeyEnv: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    maxOutputTokens: 8192,
    supportsSeed: false, // Mistral API rejects the seed parameter (422)
  });
  providers.set("mistral", mistral);

  // Gemini
  const gemini = new GeminiProvider();
  providers.set("gemini", gemini);

  // MiniMax (supports up to 16K output tokens)
  if (!process.env.MINIMAX_API_KEY) process.env.MINIMAX_API_KEY = "sk-api-25Re2DovSZz4FyuaVEX1YmEgkjLYEqSL-wQzDZnALk88MQJmdYZUg27T11hJoXdzvVoapO-l2ARhml3AdeLESQ6sMg8zJuoNGIzVCUB7Ygy_nTAWLFo4QSE";
  const minimax = new OpenAICompatibleProvider({
    name: "minimax",
    model: "MiniMax-Text-01",
    family: "minimax",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
    maxOutputTokens: 16384,
    supportsJsonMode: false, // MiniMax rejects response_format type json_object
  });
  providers.set("minimax", minimax);

  // ─── OpenRouter (gateway to many models, incl. high-tier DeepSeek R1) ──────
  // Provides access to reasoning models (deepseek/deepseek-r1) and acts as an
  // additional redundant route for Claude/GPT/Gemini families.
  const openrouterHeaders = {
    "HTTP-Referer": "https://app-production-9929.up.railway.app",
    "X-Title": "CompanyIQ",
  };

  // Default OpenRouter route: DeepSeek V3.1 chat (fast, cheap, JSON-friendly).
  const openrouter = new OpenAICompatibleProvider({
    name: "openrouter",
    model: "deepseek/deepseek-chat-v3.1",
    family: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    seed: 42,
    maxOutputTokens: 16384,
    extraHeaders: openrouterHeaders,
  });
  providers.set("openrouter", openrouter);

  // High-tier DeepSeek reasoning model via OpenRouter (R1). Reasoning models can
  // emit non-JSON preamble, so JSON mode is disabled; the analyzer extracts JSON
  // from the response defensively.
  const deepseekR1 = new OpenAICompatibleProvider({
    name: "deepseek-r1",
    model: "deepseek/deepseek-r1-0528",
    family: "openrouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    seed: 42,
    maxOutputTokens: 16384,
    extraHeaders: openrouterHeaders,
    supportsJsonMode: false,
  });
  providers.set("deepseek-r1", deepseekR1);

  // Kimi (moonshot supports up to 4K output tokens)
  if (!process.env.KIMI_API_KEY) process.env.KIMI_API_KEY = "sk-SqknNt8WxX66s7vDUWcAY6ML7TCR2abC1ZOSRazHhIN5iZQY";
  const kimi = new OpenAICompatibleProvider({
    name: "kimi",
    model: "moonshot-v1-32k",
    family: "kimi",
    apiKeyEnv: "KIMI_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1",
    seed: 42,
    maxOutputTokens: 4096,
  });
  providers.set("kimi", kimi);
}

initProviders();

// ─── Public API ──────────────────────────────────────────────────────────────

export function getProvider(name: string): AIProvider | undefined {
  return providers.get(name);
}

export function getAvailableProviders(): AIProvider[] {
  return Array.from(providers.values()).filter((p) => p.isAvailable());
}

export function getProviderStatus(): Record<string, { available: boolean; model: string; family: string }> {
  const status: Record<string, { available: boolean; model: string; family: string }> = {};
  for (const [name, provider] of providers) {
    status[name] = {
      available: provider.isAvailable(),
      model: provider.model,
      family: provider.family,
    };
  }
  return status;
}

export function getFallbackProviders(primaryName: string): AIProvider[] {
  const primary = providers.get(primaryName);
  if (!primary) return getAvailableProviders();
  const available = getAvailableProviders().filter(
    (p) => p.name !== primaryName && p.family !== primary.family
  );
  // Fallback ordering reflects the benchmarked quality/cost/reliability tiering
  // (see MODEL_COMPARISON.md). With DeepSeek V4-Flash as primary, prefer the
  // independent, high-grounding, reliable routes first and avoid Gemini early
  // in the chain (it rate-limits under batch load):
  //   1. openrouter  (DeepSeek V3.1 — 97% grounding, independent network path, ultra-cheap)
  //   2. openai      (GPT-4o — fast, 100% completion, independent vendor)
  //   3. claude      (premium, highest-tier reasoning)
  //   4. everything else (gpt-4o-mini, minimax, mistral, deepseek-pro, gemini, r1)
  const rank = (name: string): number => {
    if (name === "openrouter") return 0;
    if (name === "openai") return 1;
    if (name === "claude") return 2;
    if (name === "gpt-4o-mini") return 3;
    if (name === "minimax") return 4;
    if (name === "mistral") return 5;
    if (name === "deepseek-pro") return 6;
    if (name === "gemini") return 7; // de-prioritized: rate-limits under batch load
    return 8;
  };
  available.sort((a, b) => rank(a.name) - rank(b.name));
  return available;
}

export function getIndependentTieBreakerProvider(primaryName: string): AIProvider | undefined {
  const primary = providers.get(primaryName);
  if (!primary) return undefined;
  const candidates = getAvailableProviders().filter(
    (p) => p.family !== primary.family && p.name !== "claude-haiku"
  );
  if (candidates.length === 0) return undefined;
  // High-tier arbiter preference for the false-negative tie-break (see MODEL_COMPARISON.md):
  // Claude Sonnet 4.5 is the strongest independent premium reviewer (95% grounding,
  // 100% completion, balanced strictness) and is a different family from the DeepSeek
  // primary, so it is the ideal arbiter. GPT-4o is the next independent choice.
  // (DeepSeek V4-Pro is excluded here because it shares the primary's family.)
  const preferred = ["claude", "openai"];
  for (const name of preferred) {
    const match = candidates.find((p) => p.name === name);
    if (match) return match;
  }
  return candidates[0];
}

export async function completeWithFallback(
  providerName: string,
  opts: { system: string; prompt: string; maxTokens?: number; json?: boolean; temperature?: number }
): Promise<{ text: string; provider: string }> {
  // Gate every LLM call (primary + fallbacks) through the global semaphore so
  // total in-flight requests never exceed LLM_MAX_CONCURRENCY for this process.
  await acquireLlmSlot();
  try {
    return await completeWithFallbackInner(providerName, opts);
  } finally {
    releaseLlmSlot();
  }
}

async function completeWithFallbackInner(
  providerName: string,
  opts: { system: string; prompt: string; maxTokens?: number; json?: boolean; temperature?: number }
): Promise<{ text: string; provider: string }> {
  const errors: string[] = [];
  const primary = getProvider(providerName);
  if (primary?.isAvailable()) {
    try {
      const text = await primary.complete(opts);
      return { text, provider: primary.name };
    } catch (error: any) {
      const msg = `${primary.name}: ${error.message || error.response?.data?.error?.message || 'unknown error'}`;
      errors.push(msg);
      console.warn(`[AI] ${msg}, trying fallbacks`);
    }
  } else {
    errors.push(`${providerName}: not available`);
  }

  const fallbacks = getFallbackProviders(providerName);
  for (const fallback of fallbacks) {
    try {
      const text = await fallback.complete(opts);
      return { text, provider: fallback.name };
    } catch (error: any) {
      const msg = `${fallback.name}: ${error.message || error.response?.data?.error?.message || 'unknown error'}`;
      errors.push(msg);
      console.warn(`[AI] Fallback ${msg}`);
    }
  }

  throw new Error(`All AI providers failed: ${errors.join(' | ')}`);
}
