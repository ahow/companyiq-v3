
import * as storage from "./server/storage.js";
import { finalizeBatchAndSave } from "./server/worker.js";

async function main() {
  const batchId = 2265;
  const workspaceId = 3;
  const frameworkId = 21;
  
  console.log(`Rescuing results for cancelled batch ${batchId}...`);
  
  // Call finalise in admin mode to force snapshot generation for terminal batch
  await finalizeBatchAndSave(batchId, frameworkId, workspaceId, 20, { adminRecoverTerminal: true });
  
  console.log(`Rescue attempt for batch ${batchId} complete.`);
}

main().catch(console.error).finally(() => process.exit());
