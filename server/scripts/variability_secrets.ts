/**
 * Secrets loader for the variability-experiment harness.
 *
 * Reads live credentials at RUNTIME from their source files and injects them into
 * process.env BEFORE any lib module (analyzer / ai-providers / passage-*) is
 * imported. Nothing is hardcoded: the DB DSN comes from db_corpus.py and the LLM
 * provider keys come from the SENSITIVE system-documentation markdown table.
 *
 * Usage (must run first, before importing analyzer/ai-providers):
 *   import { loadSecrets } from "./variability_secrets.js";
 *   loadSecrets();
 *   const { summarizeDocuments } = await import("../lib/analyzer.js");
 */
import { readFileSync } from "fs";

const DB_CORPUS_PY = "/home/ubuntu/db_corpus.py";
const SENSITIVE_MD =
  "/home/ubuntu/Uploads/CompanyIQ v3 — System Documentation (SENSITIVE).md";

// Extract a `| Label | ENV_VAR | value |` row's value column for a given env var
// name from the markdown table. Returns undefined if absent or if the value is a
// masked placeholder (all asterisks / empty).
function parseEnvFromMarkdown(md: string, envVar: string): string | undefined {
  const re = new RegExp(
    `\\|[^|\\n]*\\|\\s*\`?${envVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?\\s*\\|\\s*\`?([^|\`\\n]+?)\`?\\s*\\|`,
  );
  const m = md.match(re);
  if (!m) return undefined;
  const val = m[1].trim();
  if (!val || /^\*+$/.test(val) || val.toLowerCase().includes("masked")) return undefined;
  return val;
}

export function loadSecrets(): {
  present: Record<string, boolean>;
  lengths: Record<string, number>;
} {
  // --- DB DSN from db_corpus.py ---
  const py = readFileSync(DB_CORPUS_PY, "utf8");
  const dsnMatch = py.match(/DSN\s*=\s*"([^"]+)"/);
  if (dsnMatch && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = dsnMatch[1];
  }

  // --- LLM provider keys from the SENSITIVE markdown table ---
  const md = readFileSync(SENSITIVE_MD, "utf8");
  const wanted = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_API_KEY2",
    "DEEPSEEK_API_KEY3",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "MISTRAL_API_KEY2",
  ];
  for (const v of wanted) {
    const parsed = parseEnvFromMarkdown(md, v);
    if (parsed && !process.env[v]) process.env[v] = parsed;
  }

  const check = [
    "DATABASE_URL",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
  ];
  const present: Record<string, boolean> = {};
  const lengths: Record<string, number> = {};
  for (const k of check) {
    present[k] = !!process.env[k];
    lengths[k] = (process.env[k] || "").length;
  }
  return { present, lengths };
}

// When run directly, report presence + lengths ONLY (never the secret values).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { present, lengths } = loadSecrets();
  console.log("Secrets presence (values never printed):");
  for (const k of Object.keys(present)) {
    console.log(`  ${k.padEnd(20)} present=${present[k]} length=${lengths[k]}`);
  }
}
