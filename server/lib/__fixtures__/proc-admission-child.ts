// Cancellable proc-admission child (loaded by job-child.ts via CIQ_CHILD_TEST_MODULE).
//
// Runs inside a REAL isolated job child. It drives the PRODUCTION child-side
// admission path (processorSlotBroker.proc.acquire → acquireProcSlot →
// remoteAcquire over the IPC channel to the parent broker), NOT an in-process
// broker stub. The parent test holds the single parent-side proc slot, so this
// child's request queues in the parent broker; the child's OperationScope then
// aborts at its own deadline, which must (a) send cancelAcquire to the parent and
// (b) reject the child's acquire with an OperationAbortedError at the
// proc_admission boundary — never silently hang, never consume a phantom slot.
//
//   PROC_ADMIT_MODE   = queue_then_abort   (the only mode)
//   PROC_ADMIT_BUDGET = scope budget in ms (default 600)
//   PROC_ADMIT_OUT    = file to also write the outcome to (parent reads it)
export async function run(_opts: any): Promise<any> {
  const { processorSlotBroker } = await import("../processor.js");
  const { createOperationScope, isOperationAbortedError } = await import("../lifecycle-fence.js");

  const budgetMs = parseInt(process.env.PROC_ADMIT_BUDGET || "600", 10);
  const out: Record<string, any> = { mode: process.env.PROC_ADMIT_MODE || "queue_then_abort", budgetMs };

  // Absolute-deadline scope: it aborts on its own timer while the request is still
  // queued in the parent broker (the parent holds the only slot, so no grant).
  const scope = createOperationScope({ budgetMs, label: "proc-admission-child" });
  const t0 = Date.now();
  try {
    await processorSlotBroker.proc.acquire(scope);
    // Should never reach here while the parent holds the only slot.
    out.outcome = "granted";
    out.waitedMs = Date.now() - t0;
    processorSlotBroker.proc.release();
  } catch (e: any) {
    out.outcome = "aborted";
    out.waitedMs = Date.now() - t0;
    out.isOperationAborted = isOperationAbortedError(e);
    out.reason = e?.reason ?? null;
    out.error = `${e?.name}: ${String(e?.message || e).slice(0, 160)}`;
  } finally {
    scope.dispose();
  }

  if (process.env.PROC_ADMIT_OUT) {
    (await import("node:fs")).writeFileSync(process.env.PROC_ADMIT_OUT, JSON.stringify(out));
  }
  return { success: true, documentsProcessed: 0, scoresCreated: 0, procAdmission: out };
}
