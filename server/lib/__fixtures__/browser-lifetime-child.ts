// Browser-lifetime reproduction child (loaded by job-child.ts via CIQ_CHILD_TEST_MODULE).
// Runs inside a REAL isolated job child: the production fetchPdfViaBrowser path
// (parent-brokered browser permit, real puppeteer-core Chromium, real pdftotext)
// against a SAVED document served on 127.0.0.1, then a synthetic "scoring" hold
// (REPRO_HOLD_MS, no providers called — zero paid calls) so children overlap the
// way real jobs do (browser fetches early, long LLM phase afterwards).
export async function run(opts: any): Promise<any> {
  const tag = `[REPRO-CHILD pid=${process.pid} company=${opts?.company?.id ?? "-"}]`;
  const { fetchPdfViaBrowser } = await import("../processor.js");
  const urls = String(process.env.REPRO_DOC_URLS || "").split(",").filter(Boolean);
  let chars = 0;
  for (const u of urls) {
    const t0 = Date.now();
    try {
      const text = await fetchPdfViaBrowser(u);
      chars += text.length;
      console.log(`${tag} fetch ok url=${u} chars=${text.length} ms=${Date.now() - t0}`);
    } catch (e: any) {
      console.log(`${tag} fetch FAILED url=${u} err=${String(e?.message || e).slice(0, 160)}`);
    }
  }
  const hold = parseInt(process.env.REPRO_HOLD_MS || "15000", 10);
  console.log(`${tag} synthetic scoring hold ${hold}ms (no provider calls)`);
  await new Promise((r) => setTimeout(r, hold));
  return { success: chars > 0, documentsProcessed: urls.length, scoresCreated: 0, error: chars > 0 ? undefined : "no document text" };
}
