/**
 * EX04 LIVE-FETCH OBSERVATION
 * ───────────────────────────
 * Observe the EX04 recovery mechanism firing end-to-end on a GENUINELY failed
 * small-PDF extraction, using the REAL deployed modules (b0c3118) and REAL
 * network discovery + fetch (NOT the injected fake).
 *
 * Chain exercised, all real:
 *   1. extractPdfWithFidelity()  on a real, broken (truncated) PDF  → completeness
 *      must classify as 'unknown' / 'partial' (a real failed read).
 *   2. maybeFireDocumentCompletenessReretrieval() with the DEFAULT runTargetedReretrieval
 *      (live searchCompanyDocuments + live fetchCandidateText) and skipFetch=false
 *      → fires ONE bounded re-retrieval and recovers real documents.
 *   3. Bound proof (same reviewQueue, second call)  → 'already-fired', no 2nd fetch.
 *   4. Control (all docs 'empty'/'complete')         → 'no-failed-extraction', never fires.
 *   5. Control (skipFetch=true)                       → 'skipFetch', suppressed.
 *
 * READ-ONLY w.r.t. the DB (loads a real company + framework; writes nothing).
 * Uses production discovery/fetch env pulled from the Railway worker service.
 */
import { extractPdfWithFidelity, type ExtractionCompleteness } from "../lib/processor.js";
import {
  maybeFireDocumentCompletenessReretrieval,
  DOC_COMPLETENESS_RERETRIEVAL_KEY,
} from "../lib/analyzer.js";
import { RetrievalReviewQueue } from "../lib/retrieval-review-queue.js";
import { getCompanyById, getFrameworkById, getFrameworkMeasures } from "../storage.js";

const COMPANY_ID = Number(process.env.EX04_COMPANY_ID || 9); // CSX Corporation (ws 3)
const WORKSPACE_ID = Number(process.env.EX04_WORKSPACE_ID || 3);
const FRAMEWORK_ID = Number(process.env.EX04_FRAMEWORK_ID || 18); // AI Management

function log(...a: unknown[]) {
  console.log(...a);
}

/** Candidate real PDFs to fetch then truncate (realistic partial-download corruption). */
const PDF_SOURCES = [
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  "https://africau.edu/images/default/sample.pdf",
  "https://www.orimi.com/pdf-test.pdf",
];

/** A minimal, genuinely-pathological PDF: valid header, broken xref + truncated
 *  object stream. pdf-parse's bundled pdfjs rejects this structure. Deterministic
 *  fallback so the observation never depends on an external URL being up. */
function pathologicalPdf(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/Contents 4 0 R>>endobj\n" +
      "4 0 obj<</Length 60>>stream\nBT /F1 12 Tf (truncated befo", // stream cut off mid-way; no endstream, no xref, no trailer
    "latin1",
  );
}

async function fetchAndTruncate(): Promise<{ buf: Buffer; origin: string } | null> {
  for (const url of PDF_SOURCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const full = Buffer.from(await res.arrayBuffer());
      if (full.length < 200) continue;
      // Truncate to ~55% — keeps the %PDF header, severs the xref/trailer and a
      // content stream: exactly a real interrupted/partial download.
      const cut = Math.max(120, Math.floor(full.length * 0.55));
      return { buf: full.subarray(0, cut), origin: `${url} (truncated ${cut}/${full.length} bytes)` };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function main() {
  const out: Record<string, unknown> = { ts: new Date().toISOString() };

  // ── Load the REAL company + framework + measures (read-only) ────────────────
  const company = await getCompanyById(COMPANY_ID, WORKSPACE_ID);
  const framework = await getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  const measures = await getFrameworkMeasures(FRAMEWORK_ID);
  if (!company) throw new Error(`company ${COMPANY_ID} not found in ws ${WORKSPACE_ID}`);
  if (!framework) throw new Error(`framework ${FRAMEWORK_ID} not found in ws ${WORKSPACE_ID}`);
  log(`Loaded company #${company.id} ${company.name} (domain=${company.domain}); framework #${framework.id} ${framework.name}; ${measures.length} measures`);
  out.company = { id: company.id, name: company.name, domain: company.domain };
  out.framework = { id: framework.id, name: framework.name, measures: measures.length };

  // ── STEP 1: a REAL failed extraction ────────────────────────────────────────
  let buf: Buffer;
  let origin: string;
  const real = await fetchAndTruncate();
  if (real) {
    buf = real.buf;
    origin = real.origin;
  } else {
    buf = pathologicalPdf();
    origin = "constructed pathological PDF (truncated stream, broken xref/trailer)";
  }
  log(`\n[STEP 1] Real failed-extraction artifact: ${origin} — ${buf.length} bytes`);
  const fidelity = await extractPdfWithFidelity(buf);
  log(`[STEP 1] extractPdfWithFidelity → engine=${fidelity.engine} completeness=${fidelity.completeness} textLen=${fidelity.text.length} truncationReason=${fidelity.truncationReason}`);
  out.extraction = {
    artifact: origin,
    bytes: buf.length,
    engine: fidelity.engine,
    completeness: fidelity.completeness,
    textLen: fidelity.text.length,
    truncationReason: fidelity.truncationReason,
    timedOut: fidelity.timedOut,
  };
  const failedRead = fidelity.completeness === "unknown" || fidelity.completeness === "partial";
  if (!failedRead) {
    // One more attempt with the deterministic pathological PDF before giving up.
    const f2 = await extractPdfWithFidelity(pathologicalPdf());
    log(`[STEP 1] retry w/ pathological PDF → completeness=${f2.completeness}`);
    out.extraction = { ...(out.extraction as object), retryCompleteness: f2.completeness };
    if (f2.completeness !== "unknown" && f2.completeness !== "partial") {
      throw new Error(`could not produce a failed extraction; got ${fidelity.completeness}/${f2.completeness}`);
    }
  }
  const completeness: ExtractionCompleteness =
    (out.extraction as any).retryCompleteness ?? fidelity.completeness;
  const failedUrl = "https://example-failed-doc.invalid/truncated-report.pdf";

  // ── STEP 2: LIVE re-retrieval via the REAL path (skipFetch=false) ────────────
  log(`\n[STEP 2] Firing EX04 with LIVE runTargetedReretrieval (skipFetch=false, retrievalV2=on, autoReretrieval=on)…`);
  const queue = new RetrievalReviewQueue();
  const t0 = Date.now();
  const fire1 = await maybeFireDocumentCompletenessReretrieval({
    documentCompleteness: [completeness],
    reviewQueue: queue,
    company,
    framework,
    measures,
    trustedSources: [],
    issuerProfile: undefined,
    existingCorpusText: "",
    existingDocUrls: new Set<string>([failedUrl]),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: false,
  }); // DEFAULT reretrievalFn = real runTargetedReretrieval → live network
  const dt = Date.now() - t0;
  log(`[STEP 2] fired=${fire1.fired} reason=${fire1.reason} (${(dt / 1000).toFixed(1)}s) → re-retrieval.reason=${fire1.result?.reason} newDocsAdded=${fire1.result?.newDocsAdded}`);
  log(`[STEP 2] targetedQuery: ${fire1.result?.targetedQuery}`);
  if (fire1.result?.newDocs?.length) {
    for (const d of fire1.result.newDocs) log(`          recovered: [${d.text.length} chars] ${d.title} — ${d.url}`);
  }
  if (fire1.result?.detail) log(`          detail: ${fire1.result.detail}`);
  out.fire1 = {
    fired: fire1.fired,
    reason: fire1.reason,
    elapsedMs: dt,
    reretrievalReason: fire1.result?.reason,
    newDocsAdded: fire1.result?.newDocsAdded ?? 0,
    targetedQuery: fire1.result?.targetedQuery,
    recovered: (fire1.result?.newDocs ?? []).map((d) => ({ url: d.url, title: d.title, chars: d.text.length })),
    detail: fire1.result?.detail,
  };
  out.queueSizeAfterFire1 = queue.size;
  out.markedFired = queue.hasFired(company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY);

  // ── STEP 3: bound proof — second call on same queue must NOT fetch again ─────
  log(`\n[STEP 3] Second call on SAME reviewQueue (bound check)…`);
  const fire2 = await maybeFireDocumentCompletenessReretrieval({
    documentCompleteness: [completeness],
    reviewQueue: queue,
    company,
    framework,
    measures,
    trustedSources: [],
    issuerProfile: undefined,
    existingCorpusText: "",
    existingDocUrls: new Set<string>([failedUrl]),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: false,
  });
  log(`[STEP 3] fired=${fire2.fired} reason=${fire2.reason}  (expect fired=false reason=already-fired)`);
  out.fire2 = { fired: fire2.fired, reason: fire2.reason };

  // ── STEP 4: control — genuinely empty/complete docs never fire ──────────────
  const qCtl = new RetrievalReviewQueue();
  const ctl = await maybeFireDocumentCompletenessReretrieval({
    documentCompleteness: ["empty", "complete"],
    reviewQueue: qCtl,
    company,
    framework,
    measures,
    trustedSources: [],
    existingCorpusText: "",
    existingDocUrls: new Set<string>(),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: false,
  });
  log(`\n[STEP 4] control empty/complete → fired=${ctl.fired} reason=${ctl.reason}  (expect fired=false reason=no-failed-extraction)`);
  out.controlEmpty = { fired: ctl.fired, reason: ctl.reason };

  // ── STEP 5: control — skipFetch/replay suppression ──────────────────────────
  const qSkip = new RetrievalReviewQueue();
  const skip = await maybeFireDocumentCompletenessReretrieval({
    documentCompleteness: [completeness],
    reviewQueue: qSkip,
    company,
    framework,
    measures,
    trustedSources: [],
    existingCorpusText: "",
    existingDocUrls: new Set<string>(),
    retrievalV2: true,
    autoReretrieval: true,
    skipFetch: true,
  });
  log(`[STEP 5] control skipFetch=true → fired=${skip.fired} reason=${skip.reason}  (expect fired=false reason=skipFetch)`);
  out.controlSkipFetch = { fired: skip.fired, reason: skip.reason };

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const observed =
    failedRead &&
    fire1.fired === true &&
    fire1.reason === "fired" &&
    fire2.fired === false &&
    fire2.reason === "already-fired" &&
    ctl.fired === false &&
    ctl.reason === "no-failed-extraction" &&
    skip.fired === false &&
    skip.reason === "skipFetch";
  out.OBSERVED_EX04_FIRED_ON_FAILED_EXTRACTION = observed;
  out.RECOVERED_REAL_DOCS = (fire1.result?.newDocsAdded ?? 0) > 0;

  log(`\n=== RESULT JSON ===`);
  log(JSON.stringify(out, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("EX04 observation FAILED:", e);
    process.exit(1);
  });
