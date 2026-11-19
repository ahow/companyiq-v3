
import * as storage from "./server/storage.js";
import { addBatchJobs, removeBatchJobs } from "./server/queue.js";

async function main() {
  const batchId = 2265;
  const workspaceId = 3;
  console.log(`Re-enqueuing jobs for batch ${batchId}...`);

  // Clear BullMQ records first so deterministic IDs can be re-added
  await removeBatchJobs(batchId);
  
  // requeueFailedJobsForBatch resets status to 'pending' and clears errors in PG
  const jobs = await storage.requeueFailedJobsForBatch(batchId);
  console.log(`Found ${jobs.length} jobs to re-run.`);

  if (jobs.length > 0) {
    const queueJobs = jobs.map((j) => ({
      jobId: j.id,
      companyId: j.companyId,
      frameworkId: j.frameworkId,
      batchId: batchId,
      workspaceId: workspaceId,
    }));
    await addBatchJobs(queueJobs, workspaceId, batchId);
    
    // Ensure batch is back to 'running'
    await storage.setBatchRunStatus(batchId, "running");
    
    // Clear the review alert
    await storage.clearSystemAlert("batch_review", String(batchId));
    
    console.log(`Successfully re-enqueued ${jobs.length} jobs.`);
  } else {
    console.log("No jobs found to re-enqueue.");
  }
}

main().catch(console.error).finally(() => process.exit());
