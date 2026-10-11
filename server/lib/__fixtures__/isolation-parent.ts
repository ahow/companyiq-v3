export {};
// Gap C fixture: a stand-alone supervisor process that the test SIGKILLs
// (process.on("exit") never runs). Env (FIXTURE_MODE, FIXTURE_PIDFILE,
// CIQ_CHILD_TEST_MODULE, ...) is inherited from the test.
const { runPipelineIsolated } = await import("../job-isolation.js");
const { runWithDiagContext } = await import("../diag-context.js");
const { createAttemptLifecycle } = await import("../lifecycle-fence.js");

const lc = createAttemptLifecycle({ jobId: 78, batchId: 1274, attemptNumber: 1, deadlineAt: null, attemptToken: "00000000-0000-4000-8000-000000000002" });
await runWithDiagContext({ batchId: 1274, jobId: 78, attemptId: "parent-kill", attemptNumber: 1, companyId: 5001, frameworkId: 9001, stage: "pipeline", lifecycle: lc }, () =>
  runPipelineIsolated({ company: { id: 5001, name: "Stub PLC" }, framework: { id: 9001 }, measures: [], workspaceId: 1, batchId: 1274, attemptId: "parent-kill" } as any));
