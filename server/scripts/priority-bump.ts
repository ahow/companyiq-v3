/**
 * Re-enqueue specific BullMQ jobs at TOP priority so they jump an existing backlog.
 * Self-contained: takes full job tuples so it does not depend on storage helpers.
 *
 * Usage:
 *   BUMP_JOBS="jobId:companyId:batchId:frameworkId:workspaceId,..." \
 *     node --import tsx server/scripts/priority-bump.ts
 */
import { getQueue } from "../queue.js";

const TUPLES = (process.env.BUMP_JOBS || "").split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  if (TUPLES.length === 0) throw new Error("BUMP_JOBS required");
  const q = getQueue();
  for (const t of TUPLES) {
    const [jobId, companyId, batchId, frameworkId, workspaceId] = t.split(":").map((x) => parseInt(x, 10));
    const bullId = `batch-${batchId}-company-${companyId}`;
    const existing = await q.getJob(bullId);
    if (existing) { try { await existing.remove(); } catch (e: any) { console.warn(`remove ${bullId}: ${e.message}`); } }
    await q.add(
      `validate-${batchId}-${companyId}`,
      { jobId, companyId, frameworkId, batchId, workspaceId },
      { priority: 1, jobId: bullId }
    );
    console.log(`bumped ${bullId} (jobId ${jobId}) at priority 1`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
