/**
 * variability_stability_table.ts — Phase 1.1 OFFLINE aggregator.
 *
 * Reads the per-(company,run) result JSON files that variability_run.ts already
 * wrote into var_out/ and builds the per-cell / per-measure stability table the
 * plan requires: Yes→No and No→Yes totals PER MEASURE (standing constraint 4 —
 * the split, not the net), comparing every run against a baseline run.
 *
 * This script performs NO live scoring and spends NO LLM budget: it only reads
 * existing JSON artefacts and calls the pure builder in
 * server/lib/variability-stability.ts. It is safe to run any time.
 *
 * Usage:
 *   tsx server/scripts/variability_stability_table.ts <companyId> [--dir var_out] [--v2]
 *   tsx server/scripts/variability_stability_table.ts --glob '<companyId>_run*.json'
 *
 * It picks up files named like `${companyId}_run${N}.json` (and the `_v2` cascade
 * variant), one per run, and treats each as one run in the table. The baseline is
 * the lowest run index present.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildStabilityTable,
  formatStabilityTableMarkdown,
  normaliseVerdict,
  type RunRecord,
} from "../lib/variability-stability.js";

const HOME = process.env.HOME || "/home/ubuntu";

function parseArgs(argv: string[]): {
  companyId: string | null;
  dir: string;
  v2: boolean;
  out: string | null;
} {
  let companyId: string | null = null;
  let dir = process.env.VAR_OUT_DIR || `${HOME}/var_out`;
  let v2 = false;
  let out: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--v2") v2 = true;
    else if (a === "--out") out = argv[++i];
    else if (!a.startsWith("--") && companyId == null) companyId = a;
  }
  return { companyId, dir, v2, out };
}

/** Extract the run index from a result filename, or null if it has none. */
function runIndexFromName(name: string): number | null {
  const m = name.match(/_run(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Turn one parsed result-file object into the (measureId, verdict) cells the pure
 * builder consumes. Reads the production cascade verdict per measure — exactly the
 * persisted single-run outcome — and nothing company/topic-specific.
 */
function cellsFromResult(parsed: any): { measureId: string; verdict: ReturnType<typeof normaliseVerdict> }[] {
  const records: any[] = Array.isArray(parsed?.records) ? parsed.records : [];
  return records
    .filter((r) => r && r.measureId != null)
    .map((r) => ({
      measureId: String(r.measureId),
      verdict: normaliseVerdict(r?.cascade?.verdict ?? r?.verdict),
    }));
}

function main(): void {
  const { companyId, dir, v2, out } = parseArgs(process.argv);
  if (!companyId) {
    console.error(
      "usage: variability_stability_table.ts <companyId> [--dir var_out] [--v2] [--out file.md]",
    );
    process.exit(1);
  }
  if (!existsSync(dir)) {
    console.error(`FATAL: output dir not found: ${dir}`);
    process.exit(1);
  }

  const suffix = v2 ? "_v2" : "";
  // Match `${companyId}_run<N>${suffix}.json` but NOT the `_variability.json`
  // diagnostics file (which has a different shape).
  const re = new RegExp(`^${companyId}_run\\d+${suffix}(?:_lim\\d+)?\\.json$`);
  const files = readdirSync(dir)
    .filter((f) => re.test(f) && !f.includes("_variability"))
    .sort();

  if (files.length === 0) {
    console.error(`No run files matching ${companyId}_run*${suffix}.json in ${dir}`);
    process.exit(1);
  }

  const runs: RunRecord[] = [];
  for (const f of files) {
    const runIndex = runIndexFromName(f);
    if (runIndex == null) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      console.error(`  skip ${f}: parse error ${(e as Error).message}`);
      continue;
    }
    runs.push({ runIndex, cells: cellsFromResult(parsed) });
    console.error(`  loaded ${f} (run ${runIndex}, ${runs[runs.length - 1].cells.length} measures)`);
  }

  if (runs.length < 2) {
    console.error(
      `Only ${runs.length} run file(s) found — need at least 2 to compute transitions. ` +
        `The table will still render (all-stable) for a single run.`,
    );
  }

  const table = buildStabilityTable(runs);
  const md = formatStabilityTableMarkdown(table);
  console.log(md);

  if (out) {
    writeFileSync(out, md + "\n");
    console.error(`\nSAVED ${out}`);
  }
}

main();
