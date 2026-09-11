/** Diagnostic: call each candidate provider directly (no fallback) and print the raw error. Measurement only. */
import { loadSecrets } from "./variability_secrets.js";
import { readFileSync } from "fs";
loadSecrets();
function parseEnvFromMarkdown(md: string, envVar: string): string | undefined {
  const re = new RegExp(`\\|[^|\\n]*\\|\\s*\`?${envVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?\\s*\\|\\s*\`?([^|\`\\n]+?)\`?\\s*\\|`);
  const m = md.match(re); if (!m) return undefined;
  const val = m[1].trim(); if (!val || /^\*+$/.test(val) || val.toLowerCase().includes("masked")) return undefined; return val;
}
try {
  const md = readFileSync("/home/ubuntu/Uploads/CompanyIQ v3 — System Documentation (SENSITIVE).md", "utf8");
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY2", "ANTHROPIC_API_KEY3", "GEMINI_API_KEY"]) {
    const p = parseEnvFromMarkdown(md, v); if (p && !process.env[v]) process.env[v] = p;
  }
} catch {}
async function main() {
  const { getProvider } = await import("../lib/ai-providers.js");
  const system = "You are a scoring assistant. Reply ONLY with compact JSON.";
  const prompt = 'Return exactly this JSON: {"score":0,"verdict":"No","quotes":[]}';
  for (const name of ["claude", "gemini", "glm-4.6-zai"]) {
    const p = getProvider(name);
    if (!p) { console.log(`${name}: NOT REGISTERED`); continue; }
    console.log(`${name}: isAvailable=${p.isAvailable()} model=${p.model}`);
    try {
      const t0 = Date.now();
      const text = await p.complete({ system, prompt, json: true, maxTokens: 2000, temperature: 0, seed: 42 } as any);
      console.log(`  OK (${Date.now() - t0}ms) text[:160]=${JSON.stringify(String(text).slice(0, 160))}`);
    } catch (e: any) {
      console.log(`  ERROR: ${String(e?.message || e).slice(0, 300)}`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
