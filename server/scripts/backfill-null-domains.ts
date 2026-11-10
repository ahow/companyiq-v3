/**
 * backfill-null-domains.ts — one-off FMP-only domain backfill.
 *
 * Resolves `companies.domain` for every company whose domain is currently blank,
 * using ONLY the FMP identity (ISIN -> primary listing -> profile website). No
 * Serper, no LLM — so this spends NO incremental money (FMP is a flat
 * subscription already used across the pipeline). See server/lib/domain-backfill.ts
 * for the full rationale and the non-destructive guarantees.
 *
 * The ongoing / automatic equivalent of this script is the bounded sweep wired
 * into server/reconciler.ts, which picks up newly-added companies within minutes.
 * This script just drains the existing backlog in one pass.
 *
 * USAGE
 *   # Dry-run (DEFAULT) — reports what WOULD be resolved, writes nothing:
 *   DATABASE_URL=... FMP_API_KEY=... node --import tsx server/scripts/backfill-null-domains.ts
 *
 *   # Apply:
 *   DATABASE_URL=... FMP_API_KEY=... node --import tsx server/scripts/backfill-null-domains.ts --apply
 *
 *   # Optional: --workspace <id>  --limit <n>
 */
import { backfillNullDomainsViaFmp } from "../lib/domain-backfill.js";
import { pool } from "../db.js";

function parseArgs(argv: string[]) {
  const a = { apply: false, workspaceId: undefined as number | undefined, limit: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--apply") a.apply = true;
    else if (t === "--workspace") a.workspaceId = parseInt(argv[++i], 10);
    else if (t === "--limit") a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.apply;
  console.log("─".repeat(78));
  console.log(`FMP domain backfill — ${dryRun ? "DRY-RUN (no writes)" : "APPLY (writing)"}`);
  if (args.workspaceId != null) console.log(`  workspace: ${args.workspaceId}`);
  console.log(`  limit    : ${args.limit}`);
  console.log("─".repeat(78));

  try {
    const stats = await backfillNullDomainsViaFmp({
      limit: args.limit,
      workspaceId: args.workspaceId,
      dryRun,
      concurrency: 4,
    });

    console.log("\nSUMMARY");
    console.log(`  Companies scanned (blank domain) : ${stats.scanned}`);
    console.log(`  Domains resolved                 : ${stats.resolved}`);
    console.log(`    - from cached fmp_website      : ${stats.fromCache}`);
    console.log(`    - from fresh FMP ISIN lookup   : ${stats.fromFmpLookup}`);
    console.log(`  Skipped: no ISIN (needs discovery): ${stats.noIsin}`);
    console.log(`  FMP had no usable website        : ${stats.fmpNoMatch}`);
    console.log(`  Errors                           : ${stats.errors}`);
    console.log("─".repeat(78));
    if (dryRun) console.log("Dry-run only. Re-run with --apply to write.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("backfill-null-domains failed:", err);
  process.exit(1);
});
