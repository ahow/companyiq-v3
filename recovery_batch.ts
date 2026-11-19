
import * as storage from "./server/storage.js";
import { addBatchJobs } from "./server/queue.js";

async function main() {
  const workspaceId = 3;
  const frameworkId = 21; // Standard framework for this cycle
  
  // 1. Find Flagged Companies (QA Flag)
  const companies = await storage.getCompanies(workspaceId);
  const flagged = companies.filter((c: any) => {
    const d = c.discoveryDiagnostics;
    return d && d.qaFlag && d.qaFlag.flagged === true;
  });
  
  // 2. Add ACS manually if not already there (it needs a full run due to dead ESEF)
  const acs = companies.find(c => c.id === 820);
  const targets = [...flagged];
  if (acs && !targets.some(t => t.id === acs.id)) {
    targets.push(acs);
  }
  
  console.log(`Launching recovery batch for ${targets.length} companies: ${targets.map(t => t.name).join(", ")}`);

  if (targets.length === 0) {
    console.log("No targets found.");
    return;
  }

  // Create a NEW batch (Full run: score_only=false)
  const batch = await storage.createBatchRun(
    workspaceId,
    frameworkId,
    targets.length,
    undefined, // listId
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
    skipFetch: false, // Force re-discovery/fetch
  }));
  
  await addBatchJobs(queueJobs, workspaceId, batch.id);
  
  console.log(`Recovery Batch #${batch.id} launched successfully.`);
}

main().catch(console.error).finally(() => process.exit());
