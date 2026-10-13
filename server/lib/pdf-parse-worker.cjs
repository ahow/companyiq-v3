#!/usr/bin/env node
/*
 * batch-1277 (B6) — killable pdf-parse boundary.
 *
 * pdf-parse is a SYNCHRONOUS, CPU-bound, NON-interruptible in-process parse. Run
 * in the main server process it cannot observe an AbortSignal, so a pathological
 * PDF blocks the event loop past the operation deadline. Moving the parse into
 * THIS short-lived child process makes it killable by the SAME boundary used for
 * pdftotext / OCR (runProcessCollect: deadline timer + SIGKILL on scope abort),
 * so the parent can reclaim the slot and honour the company deadline regardless
 * of how long the parse would have taken.
 *
 * Protocol (dumb by design — all policy stays in the parent):
 *   stdin  : raw PDF bytes
 *   stdout : raw extracted text (data.text) as UTF-8, NOTHING else
 *   stderr : diagnostic only
 *   exit 0 : success (text on stdout; may be empty for an image-only PDF)
 *   exit 1 : parse error
 *
 * The parent applies normaliseTableHorizonMarkers() to stdout — NOT here — so the
 * horizon-marker annotation is byte-identical to the old in-process path (same
 * library output, same normaliser, same process boundary for the annotation).
 *
 * package.json is "type":"module", so this MUST be .cjs to use require().
 */
const pdfParse = require("pdf-parse");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

(async () => {
  try {
    const buffer = await readStdin();
    if (!buffer || buffer.length === 0) {
      process.stderr.write("pdf-parse-worker: empty stdin\n");
      process.exit(1);
    }
    // pdfjs first-invocation quirk (pdf-parse@1.1.4 bundles pdfjs ~v1.10.100):
    // for a PDF whose cross-reference table pdfjs rejects and must rebuild via its
    // indexObjects() recovery scan, the VERY FIRST pdfParse() call in a process
    // throws 'bad XRef entry' because the recovery path runs before some one-time
    // state is initialised; the SECOND call on the same bytes succeeds. In the old
    // long-lived in-process design this only ever bit the first such PDF in the
    // whole process lifetime; because B6 now runs ONE parse per short-lived child,
    // EVERY xref-recovery PDF would otherwise become that "first call" and fail.
    // One retry on the SAME buffer restores (and improves) parity with the old
    // path. A genuinely-corrupt PDF still fails both attempts -> exit 1 -> the
    // parent falls through to pdftotext / OCR exactly as before.
    let data;
    try {
      data = await pdfParse(buffer);
    } catch (first) {
      data = await pdfParse(buffer);
    }
    // Write ONLY the raw text to stdout. Normalisation happens in the parent.
    process.stdout.write(data.text || "", "utf8", () => {
      process.exit(0);
    });
  } catch (err) {
    process.stderr.write(`pdf-parse-worker: ${(err && err.message) || err}\n`);
    process.exit(1);
  }
})();
