/**
 * programme_finalise_batch.ts — force the analysis_results snapshot for a finished
 * batch so the programme gate metric (analysis_results.average_score) can be read.
 *
 * WHY: a normal analysis batch that finishes with >=1 failed company pauses in
 * `pending_review` and NO analysis_results snapshot is written (see
 * server/lib/batch-completion-route.ts). finalizeBatchAndSave with
 * adminRecoverTerminal:true rebuilds the Results snapshot (completed companies
 * only) regardless of the review state, which is exactly the gate input we need.
 *
 * SAFETY: dry-run by default. Pass --confirm to actually finalise. Prints the DB
 * host first (deployment-target verification). Idempotent: re-running rebuilds
 * the same snapshot from the same completed jobs.
 *
 * Usage:
 *   DATABASE_URL=$(cat /home/ubuntu/.prod_db_url) REDIS_URL=$(cat /home/ubuntu/.prod_redis_url) \
 *     node --import tsx server/scripts/programme_finalise_batch.ts --batch 1308 --ws 3 --fw 18 --list 9 --confirm
 */
import { finalizeBatchAndSave } from "../worker.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

(async () => {
  const batchId = parseInt(arg("batch")!, 10);
  const workspaceId = parseInt(arg("ws", "3")!, 10);
  const frameworkId = parseInt(arg("fw", "18")!, 10);
  const listArg = arg("list");
  const listId = listArg !== undefined ? parseInt(listArg, 10) : undefined;
  const confirm = process.argv.includes("--confirm");

  if (!batchId || Number.isNaN(batchId)) throw new Error("--batch <id> required");

  const dbUrl = process.env.DATABASE_URL || "";
  const host = dbUrl.replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log(`[finalise] DB host: ${host}`);
  console.log(`[finalise] batch=${batchId} ws=${workspaceId} fw=${frameworkId} list=${listId ?? "none"} confirm=${confirm}`);

  const { db } = await import("../db.js");
  const { sql } = await import("drizzle-orm");
  const before = (await db.execute(sql`SELECT status, completed_jobs, failed_jobs, total_jobs FROM batch_runs WHERE id = ${batchId}`)).rows[0] as any;
  console.log(`[finalise] before: ${JSON.stringify(before)}`);
  const arBefore = (await db.execute(sql`SELECT average_score, companies_count FROM analysis_results WHERE batch_id = ${batchId} ORDER BY id DESC LIMIT 1`)).rows[0] as any;
  console.log(`[finalise] analysis_results before: ${arBefore ? JSON.stringify(arBefore) : "NONE"}`);

  if (!confirm) {
    console.log("[finalise] DRY-RUN — re-run with --confirm to rebuild the snapshot.");
    process.exit(0);
  }

  await finalizeBatchAndSave(batchId, frameworkId, workspaceId, listId, { adminRecoverTerminal: true });

  const arAfter = (await db.execute(sql`SELECT average_score, companies_count FROM analysis_results WHERE batch_id = ${batchId} ORDER BY id DESC LIMIT 1`)).rows[0] as any;
  console.log(`[finalise] analysis_results after: ${arAfter ? JSON.stringify(arAfter) : "STILL NONE"}`);
  if (!arAfter) { console.error("[finalise] ERROR: snapshot still absent after finalise"); process.exit(2); }
  console.log(`[finalise] OK snapshot average_score=${arAfter.average_score} companies=${arAfter.companies_count}`);
  process.exit(0);
})().catch((e) => { console.error("[finalise] ERR", e?.message || e); process.exit(1); });
