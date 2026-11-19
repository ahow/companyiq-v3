
import * as storage from "./server/storage.js";
import { addBatchJobs } from "./server/queue.js";
import fs from "fs";

async function main() {
  const workspaceId = 3;
  const frameworkId = 21;
  
  const ids = fs.readFileSync("suspect_ids.txt", "utf8").split("\n").filter(Boolean).map(Number);
  console.log(`Loaded ${ids.length} suspect IDs.`);

  const companies = await storage.getCompanies(workspaceId);
  const targets = companies.filter(c => ids.includes(c.id));
  
  console.log(`Found ${targets.length} companies in DB. Launching recovery batch...`);

  if (targets.length === 0) {
    console.log("No targets found.");
    return;
  }

  // Create a NEW batch
  // We'll use scoreOnly=false to be sure evidence is complete as requested.
  const batch = await storage.createBatchRun(
    workspaceId,
    frameworkId,
    targets.length,
    20,       // listId (MSCI_ACWI_011126)
    false,    // offPeakOnly
    false,    // scoreOnly = FALSE (Full Run)
  );
  
  const jobsData = targets.map((c) => ({
    workspaceId,
    batchId: batch.id,
    companyId: c.id,
    companyName: c.name,
    frameworkId
  }));
  
  await storage.createAnalysisJobs(jobsData);
  const allJobs = await storage.getJobsForBatch(batch.id);
  
  const queueJobs = allJobs.map((j: any) => ({
    jobId: j.id,
    companyId: j.companyId,
    frameworkId: j.frameworkId,
    batchId: batch.id,
    workspaceId,
    skipFetch: false,
  }));
  
  await addBatchJobs(queueJobs, workspaceId, batch.id);
  
  console.log(`Recovery Batch #${batch.id} launched successfully for ${targets.length} companies.`);
}

main().catch(console.error).finally(() => process.exit());
