// Browser-lifetime reproduction child (loaded by job-child.ts via CIQ_CHILD_TEST_MODULE).
// Runs inside a REAL isolated job child: the production fetchPdfViaBrowser path
// (parent-brokered browser permit, real puppeteer-core Chromium, real text
// extraction) against synthetic documents served on 127.0.0.1, then a synthetic
// "scoring" hold (REPRO_HOLD_MS, no providers called — zero paid calls) so
// children overlap the way real jobs do (browser fetches early, long LLM phase).
//
// Each job fetches its OWN documents (REPRO_DOC_BASE/job-<company>-doc-<i>.pdf);
// every document carries a unique marker (markerFor). The job succeeds only if
// EVERY document was fetched (no BrowserUnavailableError / silent skip) AND its
// own marker survived extraction; per-document outcomes are returned in `docs`.
import { markerFor } from "./marker-pdf.js";

export async function run(opts: any): Promise<any> {
  const company = opts?.company?.id ?? 0;
  const tag = `[REPRO-CHILD pid=${process.pid} company=${company}]`;
  const { fetchPdfViaBrowser } = await import("../processor.js");
  const base = String(process.env.REPRO_DOC_BASE || "");
  const n = parseInt(process.env.REPRO_DOCS_PER_CHILD || "1", 10);
  const docs: Array<{ key: string; chars: number; markerFound: boolean; skipped: boolean; error?: string; ms: number }> = [];
  for (let i = 0; i < n; i++) {
    const key = `job-${company}-doc-${i}`;
    const t0 = Date.now();
    try {
      const text = await fetchPdfViaBrowser(`${base}/${key}.pdf`);
      const markerFound = text.includes(markerFor(key));
      docs.push({ key, chars: text.length, markerFound, skipped: false, ms: Date.now() - t0 });
      console.log(`${tag} fetch ok key=${key} chars=${text.length} marker=${markerFound} ms=${Date.now() - t0}`);
    } catch (e: any) {
      const error = `${e?.name}: ${String(e?.message || e).slice(0, 160)}`;
      docs.push({ key, chars: 0, markerFound: false, skipped: e?.name === "BrowserUnavailableError", error, ms: Date.now() - t0 });
      console.log(`${tag} fetch FAILED key=${key} err=${error}`);
    }
  }
  const hold = parseInt(process.env.REPRO_HOLD_MS || "15000", 10);
  console.log(`${tag} synthetic scoring hold ${hold}ms (no provider calls)`);
  await new Promise((r) => setTimeout(r, hold));
  const allOk = docs.length === n && docs.every((d) => d.markerFound);
  return {
    success: allOk, documentsProcessed: docs.filter((d) => d.markerFound).length, scoresCreated: 0, docs,
    error: allOk ? undefined : docs.every((d) => d.chars === 0) ? "no document text" : "document marker missing",
  };
}
