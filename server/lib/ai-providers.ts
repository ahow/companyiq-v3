import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

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
  private client: Anthropic | null = null;

  constructor(model: string = "claude-sonnet-4-20250514") {
    this.model = model;
    if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  isAvailable(): boolean {
    return !!this.client;
  }

  async complete(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    json?: boolean;
    temperature?: number;
  }): Promise<string> {
    if (!this.client) throw new Error("Claude not configured");
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: Math.min(opts.maxTokens ?? 4096, 8192),
      temperature: opts.temperature ?? 0,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text;
    throw new Error("Unexpected response type from Claude");
  }
}

class ClaudeHaikuProvider extends ClaudeProvider {
  constructor() {
    super("claude-3-5-haiku-20241022");
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

  constructor(config: {
    name: string;
    model: string;
    family: string;
    apiKeyEnv: string;
    baseUrl: string;
    seed?: number;
    maxOutputTokens?: number;
  }) {
    this.name = config.name;
    this.model = config.model;
    this.family = config.family;
    // Support comma-separated keys for rotation (e.g., DEEPSEEK_API_KEY="key1,key2,key3")
    const rawKey = process.env[config.apiKeyEnv] || "";
    this.apiKeys = rawKey.split(",").map(k => k.trim()).filter(k => k.length > 0);
    this.baseUrl = config.baseUrl;
    this.seed = config.seed;
    this.maxOutputTokens = config.maxOutputTokens ?? 8192;
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
    const apiKey = this.getNextKey();

    const body: any = {
      model: this.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      max_tokens: Math.min(opts.maxTokens ?? 4096, this.maxOutputTokens),
      temperature: opts.temperature ?? 0,
    };

    if (this.seed !== undefined) body.seed = this.seed;
    if (opts.json) body.response_format = { type: "json_object" };

    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 120000,
      }
    );

    return response.data.choices[0].message.content;
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
    seed: 42,
    maxOutputTokens: 8192,
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
    baseUrl: "https://api.minimax.chat/v1",
    seed: 42,
    maxOutputTokens: 16384,
  });
  providers.set("minimax", minimax);

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
  // Prioritize OpenAI as first fallback for reliability
  available.sort((a, b) => {
    if (a.name === "openai") return -1;
    if (b.name === "openai") return 1;
    if (a.name === "gemini") return -1;
    if (b.name === "gemini") return 1;
    return 0;
  });
  return available;
}

export function getIndependentTieBreakerProvider(primaryName: string): AIProvider | undefined {
  const primary = providers.get(primaryName);
  if (!primary) return undefined;
  const candidates = getAvailableProviders().filter(
    (p) => p.family !== primary.family && p.name !== "claude-haiku"
  );
  return candidates[0];
}

export async function completeWithFallback(
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
