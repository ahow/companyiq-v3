/* Test the actual completeWithFallback LLM call used by /improvement/chat. Diagnostic only. */
import { completeWithFallback, getProviderStatus } from "../lib/ai-providers.js";

async function main() {
  console.log("=== provider status ===");
  console.log(JSON.stringify(getProviderStatus(), null, 2));

  const system = "You are a helpful assistant for framework improvement. Keep replies short.";
  const prompt = "User: summarise findings\n\nAssistant:";
  console.log("\n=== calling completeWithFallback(claude) ===");
  const t0 = Date.now();
  try {
    const { text, provider } = await completeWithFallback("claude", {
      system, prompt, maxTokens: 4000, temperature: 0.2,
    });
    console.log(`OK in ${Date.now()-t0}ms via ${provider}. reply len=${text.length}`);
    console.log("reply preview:", text.slice(0, 200));
  } catch (e: any) {
    console.error(`THREW after ${Date.now()-t0}ms:`, e?.message || e);
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
