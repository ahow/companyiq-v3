// Close-before-release ordering child (loaded by job-child.ts via CIQ_CHILD_TEST_MODULE).
// Drives the PRODUCTION browser call sites inside a real isolated job child
// against a local HTTP server (CLOSE_ORDER_BASE); the parent test observes, at
// the instant each browser permit returns to the replica broker, whether any
// Chromium process is still alive. Zero paid calls, no external network.
//   CLOSE_ORDER_MODE = success | failure | cancel | kill
export async function run(_opts: any): Promise<any> {
  const { fetchPdfViaBrowser, fetchIssuerPdfsWithPrimedSession } = await import("../processor.js");
  const base = String(process.env.CLOSE_ORDER_BASE);
  const mode = String(process.env.CLOSE_ORDER_MODE);
  const out: Record<string, any> = { mode };
  const attempt = async (name: string, f: () => Promise<any>) => {
    const t0 = Date.now();
    try { const v = await f(); out[name] = { ok: true, chars: typeof v === "string" ? v.length : (v?.size ?? 0), text: typeof v === "string" ? v.slice(0, 200) : "", ms: Date.now() - t0 }; }
    catch (e: any) { out[name] = { ok: false, error: `${e?.name}: ${String(e?.message || e).slice(0, 160)}`, ms: Date.now() - t0 }; }
  };
  if (mode === "success") {
    await attempt("fetchPdfViaBrowser", () => fetchPdfViaBrowser(`${base}/ok-0.pdf`));
  } else if (mode === "failure") {
    await attempt("fetchPdfViaBrowser", () => fetchPdfViaBrowser(`${base}/reset.pdf`));
    await attempt("pdfRecovery", () => fetchIssuerPdfsWithPrimedSession(base, [`${base}/reset.pdf`], { overallBudgetMs: 8000, perPdfTimeoutMs: 3000 }));
  } else if (mode === "cancel") {
    // A holds the permit on a slow document; B queues for the permit; the parent
    // cancels the batch while A is mid-fetch. A finishes → close+reap → release;
    // B is granted → post-acquire refusal → release; C is refused pre-acquire.
    const a = attempt("A_inflight", () => fetchPdfViaBrowser(`${base}/slow.pdf`));
    await new Promise((r) => setTimeout(r, 150));
    const b = attempt("B_postAcquire", () => fetchPdfViaBrowser(`${base}/ok-1.pdf`));
    await Promise.all([a, b]);
    await attempt("C_preAcquire", () => fetchPdfViaBrowser(`${base}/ok-2.pdf`));
  } else if (mode === "kill") {
    // Never returns: the parent's pipeline deadline SIGKILLs this child while it
    // holds the permit and Chromium is live (child-death path).
    await attempt("hang", () => fetchPdfViaBrowser(`${base}/hang.pdf`));
  }
  // The parent discards a child report that arrives after a terminal cancel
  // decision, so the per-call outcomes are also written to CLOSE_ORDER_OUT.
  if (process.env.CLOSE_ORDER_OUT) (await import("node:fs")).writeFileSync(process.env.CLOSE_ORDER_OUT, JSON.stringify(out));
  return { success: true, documentsProcessed: 0, scoresCreated: 0, closeOrder: out };
}
