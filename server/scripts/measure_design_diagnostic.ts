/**
 * Measure-design diagnostic CLI (Change E).
 *
 *   tsx server/scripts/measure_design_diagnostic.ts <frameworkId> [batchId,batchId,...]
 *
 * Runs the GENERIC, framework-agnostic design-time diagnostic
 * (server/lib/measure-design-diagnostic.ts) against a framework:
 *   - PRE-TEST  (always): static definition analysis — whitelist/exclusion
 *     conflicts, existence↔strength conflation, non-JSON scoring_guidance.
 *   - POST-TEST (needs ≥1 batchId): verdict distribution, low-confidence/review
 *     rate, rationale↔score inconsistency-flag rate, drawn from stored results.
 *   - MULTI-RUN (needs ≥2 batchIds): per-measure flip rate + a composite
 *     instability ranking across the supplied runs.
 *
 * SURFACES findings only — performs NO writes and NO auto-edits to any measure.
 *
 * Prints a human-readable summary to stdout and writes the full JSON report to
 *   /home/ubuntu/measure_design_diagnostic_<frameworkId>.json
 *
 * Requires DATABASE_URL (loaded via the shared secrets loader, same as the
 * variability harness).
 */
import { loadSecrets } from "./variability_secrets.js";
const secretsStatus = loadSecrets();
if (!secretsStatus.present["DATABASE_URL"]) {
  console.error("FATAL: DATABASE_URL not available", secretsStatus.present);
  process.exit(1);
}

import { writeFileSync } from "fs";

async function main() {
  const frameworkId = parseInt(process.argv[2] || "", 10);
  if (!frameworkId || Number.isNaN(frameworkId)) {
    console.error(
      "usage: measure_design_diagnostic.ts <frameworkId> [batchId,batchId,...]",
    );
    process.exit(1);
  }
  const batchIds = (process.argv[3] || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  // Import AFTER secrets are loaded so db.ts sees DATABASE_URL.
  const { runMeasureDesignDiagnostic } = await import(
    "../lib/measure-design-diagnostic.js"
  );

  const report = await runMeasureDesignDiagnostic({ frameworkId, batchIds });

  console.log(report.humanSummary);

  const outPath = `/home/ubuntu/measure_design_diagnostic_${frameworkId}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull JSON report written to ${outPath}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("measure_design_diagnostic failed:", err);
  process.exit(1);
});
