/**
 * Config verification harness.
 *
 * Drives the REAL production analyzer (analyzeCompanyMeasures) against the live DB
 * for a single company, while instrumenting the provider registry so we can observe
 * exactly which model is invoked for each call (scoring vs tie-break vs fallback).
 *
 * This proves the deployed model configuration end-to-end:
 *   - ensemble OFF  -> single-pass scoring by scoring_provider (DeepSeek V4-Flash)
 *   - tie-break arbiter = Claude (independent family), only on suspicious "No"
 *   - fallback chain only fires if the primary call throws
 *
 * Usage: tsx server/scripts/verify-config.ts <companyId> <frameworkId>
 */
import * as storage from "../storage.js";
import { analyzeCompanyMeasures } from "../lib/analyzer.js";
import * as providersMod from "../lib/ai-providers.js";

const companyId = parseInt(process.argv[2] || "1411");
const frameworkId = parseInt(process.argv[3] || "7");

// ─── Instrument every provider's complete() to record calls ──────────────────
interface CallRec { provider: string; ok: boolean; ms: number; tokensIn?: number; tokensOut?: number; err?: string }
const calls: CallRec[] = [];

function instrument() {
  // getProvider returns the live registry instances; wrap each one's complete().
  const names = ["deepseek", "deepseek-pro", "claude", "openai", "openrouter",
                 "deepseek-r1", "gemini", "mistral", "minimax", "gpt-4o-mini", "claude-haiku"];
  for (const name of names) {
    const p: any = providersMod.getProvider(name);
    if (!p || typeof p.complete !== "function") continue;
    const orig = p.complete.bind(p);
    p.complete = async (opts: any) => {
      const t0 = Date.now();
      try {
        const out = await orig(opts);
        calls.push({ provider: name, ok: true, ms: Date.now() - t0 });
        return out;
      } catch (e: any) {
        calls.push({ provider: name, ok: false, ms: Date.now() - t0, err: (e?.message || String(e)).slice(0, 120) });
        throw e;
      }
    };
  }
}

async function main() {
  const workspaceId = 3; // framework 7 lives in workspace 3
  console.log(`\n=== CONFIG VERIFICATION: company ${companyId}, framework ${frameworkId}, ws ${workspaceId} ===\n`);

  // Show provider availability + the effective settings the analyzer will load
  const status = providersMod.getProviderStatus();
  console.log("Provider availability:");
  for (const [n, s] of Object.entries(status)) {
    console.log(`  ${n.padEnd(14)} available=${s.available}  model=${s.model}  family=${s.family}`);
  }

  const settings = await storage.getSettings(workspaceId);
  console.log("\nEffective settings (live DB):");
  console.log(`  ensemble_scoring = ${settings.ensemble_scoring}`);
  console.log(`  scoring_provider = ${settings.scoring_provider}`);
  console.log(`  pipeline_llm_1/2/3 = ${settings.pipeline_llm_1} / ${settings.pipeline_llm_2} / ${settings.pipeline_llm_3}`);
  console.log(`  scoring_mode = ${settings.scoring_mode}`);

  const company = await storage.getCompanyById(companyId, workspaceId);
  if (!company) throw new Error("company not found");
  const framework = await storage.getFrameworkById(frameworkId, workspaceId);
  if (!framework) throw new Error("framework not found");
  const measures = await storage.getFrameworkMeasures(frameworkId);
  const docs = await storage.getFetchedDocuments(companyId);

  const documentTexts: string[] = [];
  const documentUrls: string[] = [];
  const documentTitles: string[] = [];
  for (const d of docs as any[]) {
    if (d.content) { documentTexts.push(d.content); documentUrls.push(d.url); documentTitles.push(d.title || d.url); }
  }
  console.log(`\nCompany: ${company.name} | docs with content: ${documentTexts.length} | measures: ${measures.length}`);

  instrument();

  const t0 = Date.now();
  const analysis = await analyzeCompanyMeasures({
    workspaceId, companyName: company.name, companyId,
    documentTexts, documentUrls, documentTitles,
    framework: framework as any, measures: measures as any,
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  // ─── Report ────────────────────────────────────────────────────────────────
  const tally: Record<string, { ok: number; fail: number }> = {};
  for (const c of calls) {
    tally[c.provider] = tally[c.provider] || { ok: 0, fail: 0 };
    if (c.ok) tally[c.provider].ok++; else tally[c.provider].fail++;
  }
  console.log(`\n=== RESULT (${secs}s) ===`);
  console.log(`Total score: ${analysis.scorePercentage}%`);
  const allM = analysis.categories.flatMap((c: any) => c.measures);
  const yes = allM.filter((m: any) => m.verdict === "Yes").length;
  const no = allM.filter((m: any) => m.verdict === "No").length;
  const part = allM.filter((m: any) => m.verdict === "Partial").length;
  console.log(`Verdicts: Yes=${yes} No=${no} Partial=${part} (of ${allM.length})`);
  const overrides = allM.filter((m: any) => (m.verdictNuance || "").includes("Tie-breaker override")).length;
  console.log(`Tie-break overrides applied: ${overrides}`);

  console.log("\nProvider call tally (proves which models actually ran):");
  for (const [n, t] of Object.entries(tally)) {
    console.log(`  ${n.padEnd(14)} ok=${t.ok}  fail=${t.fail}`);
  }
  console.log("\nDONE.");
  process.exit(0);
}

main().catch((e) => { console.error("VERIFY ERROR:", e); process.exit(1); });
