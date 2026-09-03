/**
 * Dry-run simulation of U17 Fix B against iter-13 Yes/Partial verdicts.
 *
 * Reads /tmp/iter13_verdicts_yes_partial.json (produced by the analyst
 * SQL export), applies applyProvenanceGate to every entry, and reports
 * per-company + per-measure downgrade counts. No DB writes.
 */

import { readFileSync } from "node:fs";
import { applyProvenanceGate } from "../server/lib/provenance-gate.js";
import type { MeasureResult } from "../server/lib/analyzer.js";

interface VerdictExport {
  company_id: number;
  company_name: string;
  measure_id: string;
  verdict: "Yes" | "Partial";
  domain: string | null;
  related_domains: string[] | null;
  quotes: Array<{ source: string; sourceUrl: string | null; text: string }>;
}

const data: VerdictExport[] = JSON.parse(readFileSync("/tmp/iter13_verdicts_yes_partial.json", "utf8"));

// Force the flag on for the simulation, save original state
const prev = process.env.U17_SCORING_TIME_GATE;
process.env.U17_SCORING_TIME_GATE = "true";

const byCompany: Record<string, { yes: number; partial: number; downgraded_yes: number; downgraded_partial: number; measures_downgraded: string[] }> = {};
let totalDowngrades = 0;
let unlistedSkips = 0;
const detailedDowngrades: Array<{ company: string; measure: string; original: string; quoteCount: number; sample: string }> = [];

for (const entry of data) {
  const bucket = (byCompany[entry.company_name] ||= { yes: 0, partial: 0, downgraded_yes: 0, downgraded_partial: 0, measures_downgraded: [] });
  if (entry.verdict === "Yes") bucket.yes += 1;
  else bucket.partial += 1;

  const fakeMeasureResult: MeasureResult = {
    measureId: entry.measure_id,
    title: entry.measure_id,
    definition: null,
    category: "",
    categoryNumber: 0,
    score: entry.verdict === "Yes" ? 1 : 0.5,
    coverage: null,
    confidence: "Medium",
    evidenceSummary: "",
    quotes: entry.quotes.map(q => ({
      text: q.text,
      source: q.source,
      sourceUrl: q.sourceUrl || undefined,
    })),
    verdict: entry.verdict,
    verdictNuance: null,
    displayOrder: 0,
  };

  const outcome = applyProvenanceGate(fakeMeasureResult, {
    domain: entry.domain,
    relatedDomains: entry.related_domains,
    isUnlisted: false, // all preview rows are listed
  });

  if (outcome.action === "downgraded") {
    totalDowngrades += 1;
    if (entry.verdict === "Yes") bucket.downgraded_yes += 1;
    else bucket.downgraded_partial += 1;
    bucket.measures_downgraded.push(entry.measure_id);
    detailedDowngrades.push({
      company: entry.company_name,
      measure: entry.measure_id,
      original: entry.verdict,
      quoteCount: entry.quotes.length,
      sample: entry.quotes.slice(0, 2).map(q => q.sourceUrl || "no-url").join(" | "),
    });
  } else if (outcome.action === "skipped_unlisted") {
    unlistedSkips += 1;
  }
}

process.env.U17_SCORING_TIME_GATE = prev;

console.log(`Simulated U17 Fix B against ${data.length} Yes/Partial verdicts from iter-13\n`);
console.log(`${"Company".padEnd(24)} ${"Yes".padStart(4)} ${"Ptl".padStart(4)} ${"↓Yes".padStart(5)} ${"↓Ptl".padStart(5)}  Measures downgraded`);
console.log("-".repeat(90));
for (const [name, b] of Object.entries(byCompany).sort()) {
  console.log(`${name.padEnd(24)} ${String(b.yes).padStart(4)} ${String(b.partial).padStart(4)} ${String(b.downgraded_yes).padStart(5)} ${String(b.downgraded_partial).padStart(5)}  ${b.measures_downgraded.join(", ") || "-"}`);
}
console.log("-".repeat(90));
console.log(`\nTOTAL downgrades: ${totalDowngrades} of ${data.length} Yes/Partial verdicts (${(100 * totalDowngrades / data.length).toFixed(1)}%)`);
console.log(`  Yes downgraded: ${Object.values(byCompany).reduce((s, b) => s + b.downgraded_yes, 0)}`);
console.log(`  Partial downgraded: ${Object.values(byCompany).reduce((s, b) => s + b.downgraded_partial, 0)}`);
if (unlistedSkips > 0) console.log(`  Skipped as unlisted: ${unlistedSkips}`);

if (detailedDowngrades.length > 0) {
  console.log(`\n=== Downgrade details ===`);
  for (const d of detailedDowngrades) {
    console.log(`  ${d.company} / ${d.measure} (${d.original}, ${d.quoteCount} quotes): ${d.sample}`);
  }
}
