/**
 * phase2_gate_cli.ts — thin, OFFLINE CLI around server/lib/phase2-groundtruth.ts.
 *
 * WHY THIN: all logic lives in the pure library (phase2-groundtruth.ts); this file
 * only does file I/O + argument parsing, matching the house "pure-lib + thin-CLI"
 * style. It performs NO live LLM calls, NO DB access, NO network — it only reads
 * local replay-run JSON artifacts and an optional local label file.
 *
 * SUBCOMMANDS:
 *   select  — build the deterministic stratified holdout manifest from the replay
 *             artifacts + default roster/seed, print strata counts, and (optionally)
 *             write the manifest + a blank analyst label template to disk.
 *   gate    — build the holdout manifest, read an optional local labels JSON file,
 *             run the standing regression gate, and print its status. With no
 *             authoritative human labels present the gate reports "not armed"
 *             (it NEVER fabricates a pass or invents precision/recall numbers).
 *
 * This CLI is INERT at runtime (not wired into scoring). It is a builder/CI helper
 * that runs against the FIXED holdout only ⇒ zero per-company production human input.
 *
 * Usage:
 *   npx tsx server/scripts/phase2_gate_cli.ts select [--dir <artifactDir>] [--out <manifest.json>] [--template <labels.json>]
 *   npx tsx server/scripts/phase2_gate_cli.ts gate   [--dir <artifactDir>] [--labels <labels.json>] [--oracle <oracle.json>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  selectHoldout,
  buildLabelTemplate,
  validateLabelFile,
  computeGate,
  type RunCellObservation,
  type HoldoutLabel,
  type ModelVerdictEntry,
  type OracleBaselineEntry,
} from "../lib/phase2-groundtruth.js";
import {
  DEFAULT_HOLDOUT_ROSTER,
  DEFAULT_HOLDOUT_SEED,
} from "../lib/phase2-holdout-roster.js";
import { normaliseVerdict } from "../lib/variability-stability.js";

const DEFAULT_ARTIFACT_DIR = "/home/ubuntu/var_out_phase1_postfix";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const cmd = argv[2] ?? "help";
  const opts: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      opts[key] = val;
    }
  }
  return { cmd, opts };
}

/** Read every replay-run artifact in a directory → flat RunCellObservation[]. Pure I/O. */
function readObservations(dir: string): RunCellObservation[] {
  const obs: RunCellObservation[] = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    let doc: any;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const meta = doc?.meta;
    if (!meta || !Array.isArray(doc?.records)) continue;
    for (const r of doc.records) {
      const verdict = normaliseVerdict(r?.cascade?.verdict ?? "No");
      const topChunk = r?.chunks?.bm25?.topChunks?.[0];
      const auditEntry = Array.isArray(r?.chunkRankAudit?.entries)
        ? r.chunkRankAudit.entries[0]
        : null;
      obs.push({
        companyId: Number(meta.companyId),
        companyName: String(meta.companyName ?? ""),
        measureTitle: String(r?.title ?? ""),
        category: r?.category ?? null,
        runIndex: Number(meta.runIndex ?? 0),
        verdict,
        docRef: topChunk?.docUrl ?? null,
        passageRef: auditEntry?.fingerprint ?? null,
        // researchComplete is left null (unknown): the artifacts carry no explicit
        // research-complete flag, and inventing one would be dishonest. The gate
        // handles null gracefully (complete/incomplete split only over true/false).
        researchComplete: null,
      });
    }
  }
  return obs;
}

function fmtPR(label: string, s: any): string {
  if (!s) return `  ${label}: (n/a)`;
  const p = s.precision == null ? "n/a" : s.precision.toFixed(3);
  const r = s.recall == null ? "n/a" : s.recall.toFixed(3);
  return `  ${label}: n=${s.n} tp=${s.tp} fp=${s.fp} fn=${s.fn} tn=${s.tn} | precision=${p} recall=${r}`;
}

function main(): void {
  const { cmd, opts } = parseArgs(process.argv);
  const dir = opts.dir ?? DEFAULT_ARTIFACT_DIR;

  if (cmd === "help" || (cmd !== "select" && cmd !== "gate")) {
    console.log(
      [
        "phase2_gate_cli — offline Phase 2 ground-truth holdout + standing gate",
        "",
        "  select [--dir <d>] [--out <manifest.json>] [--template <labels.json>]",
        "  gate   [--dir <d>] [--labels <labels.json>] [--oracle <oracle.json>]",
      ].join("\n"),
    );
    return;
  }

  if (!fs.existsSync(dir)) {
    console.error(`artifact dir not found: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const observations = readObservations(dir);
  const manifest = selectHoldout(observations, {
    seed: DEFAULT_HOLDOUT_SEED,
    roster: DEFAULT_HOLDOUT_ROSTER,
    frameworkVersion: "AI Governance and Strategy Framework (frameworkId=8)",
  });

  console.log(`[phase2] artifact dir: ${dir}`);
  console.log(`[phase2] observations read: ${observations.length}`);
  console.log(`[phase2] seed: ${manifest.generatedFromSeed}`);
  console.log(`[phase2] holdout total cells: ${manifest.counts.total}`);
  console.log(`[phase2] by stratum:`);
  for (const [k, v] of Object.entries(manifest.counts.byStratum)) {
    console.log(`           ${k}: ${v}`);
  }
  console.log(`[phase2] non-English filers represented: ${manifest.counts.nonEnglishFilers}`);
  console.log(`[phase2] needs-evidence placeholders: ${manifest.counts.needsEvidence}`);

  if (cmd === "select") {
    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(manifest, null, 2));
      console.log(`[phase2] manifest written: ${opts.out}`);
    }
    if (opts.template) {
      const template = buildLabelTemplate(manifest);
      fs.writeFileSync(opts.template, JSON.stringify(template, null, 2));
      console.log(
        `[phase2] blank analyst label template written (all human_label=PENDING): ${opts.template}`,
      );
    }
    return;
  }

  // cmd === "gate"
  let labels: HoldoutLabel[] = [];
  if (opts.labels && fs.existsSync(opts.labels)) {
    labels = JSON.parse(fs.readFileSync(opts.labels, "utf8"));
    const v = validateLabelFile(labels, manifest);
    if (!v.valid) {
      console.error(`[phase2] label file INVALID:\n  ${v.errors.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // No labels supplied ⇒ use the blank (all-PENDING) template so the gate
    // correctly reports "not armed" instead of failing to run.
    labels = buildLabelTemplate(manifest);
    console.log(`[phase2] no --labels file supplied; using blank PENDING template.`);
  }

  // Model verdicts under test = the current baseline model verdict per holdout cell.
  const modelVerdicts: ModelVerdictEntry[] = manifest.cells
    .filter((c) => c.modelVerdict != null)
    .map((c) => ({ cellKey: c.cellKey, verdict: c.modelVerdict!, researchComplete: c.researchComplete }));

  let oracleBaseline: OracleBaselineEntry[] | undefined;
  if (opts.oracle && fs.existsSync(opts.oracle)) {
    oracleBaseline = JSON.parse(fs.readFileSync(opts.oracle, "utf8"));
  }

  const result = computeGate({ labels, modelVerdicts, oracleBaseline });
  console.log("");
  console.log(`[phase2 GATE] status: ${result.status.toUpperCase()}`);
  console.log(`[phase2 GATE] ${result.reason}`);
  console.log(`[phase2 GATE] armed (authoritative Yes/No) labels: ${result.armedLabelCount}`);
  if (result.overall) console.log(fmtPR("overall", result.overall));
  if (result.byResearch) {
    console.log(fmtPR("research-complete", result.byResearch.complete));
    console.log(fmtPR("research-incomplete", result.byResearch.incomplete));
  }
  if (result.vsOracleBaseline) {
    const o = result.vsOracleBaseline;
    console.log(
      `[phase2 GATE] vs oracle-era baseline (SPLIT): Yes→No=${o.yesToNo} No→Yes=${o.noToYes} ` +
        `total flips=${o.totalFlips} over ${o.comparedCells} compared cells`,
    );
  } else {
    console.log(`[phase2 GATE] vs oracle-era baseline: (no oracle baseline supplied)`);
  }
}

main();
