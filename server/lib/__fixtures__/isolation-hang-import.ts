// Fixture: a module whose top-level await never resolves. Loaded inside a job
// child via CIQ_CHILD_TEST_MODULE, so the child's `await import(testModule)`
// never settles and the child never reports "warm" — a faithful stand-in for
// the prod cold-import wedge the startup watchdog must catch (and the gate must
// bound). Nothing below the top-level await ever runs.
await new Promise<never>(() => {});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function run(): Promise<any> {
  return { success: true, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
}
