/**
 * FIX5 verification harness — Michelin pinned PDF ingest.
 *
 * Read-only: fetches Michelin's single pinned document (company 145, the 2025
 * universal registration document on an Azure blob URL) and confirms the pinned
 * fetch path (a) downloads the bytes, (b) transparently gzip-decompresses, and
 * (c) yields extractable text. Exercises the SAME helpers the processor now uses
 * (fetchPinnedPdfBytes + extractPdfWithFidelity) so a pass here maps directly to
 * the production pinned path.
 *
 * Run: node --import tsx server/scripts/michelin-pin-harness.ts
 * Optional: pass a URL arg to test an arbitrary pinned URL instead.
 */
import axios from "axios";
import { fetchPinnedPdfBytes, extractPdfWithFidelity } from "../lib/processor.js";

// Michelin's pinned URL (company 145). Overridable via argv for ad-hoc testing.
const MICHELIN_PINNED_URL =
  "https://dgaddcosprod.blob.core.windows.net/b2b-experience-production/attachments/cmtwzhxi003tk01jtgqhg6s47-f40ixh7py2bnps4raz3p2z4q-universal-registration-document-for-2025.pdf";

async function main() {
  const url = process.argv[2] || MICHELIN_PINNED_URL;
  console.log(`\n=== Michelin pinned-PDF harness ===`);
  console.log(`URL: ${url}\n`);

  // Step 0 — raw HEAD/GET to show server-reported shape (content-type, encoding, size).
  try {
    const head = await axios.get(url, {
      responseType: "arraybuffer",
      maxContentLength: 64 * 1024 * 1024,
      maxBodyLength: 64 * 1024 * 1024,
      timeout: 120000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip, deflate, br" },
    });
    console.log(`[raw] HTTP ${head.status}`);
    console.log(`[raw] content-type: ${head.headers["content-type"]}`);
    console.log(`[raw] content-encoding: ${head.headers["content-encoding"] || "(none reported after decompress)"}`);
    console.log(`[raw] axios-decoded bytes: ${Buffer.from(head.data).length}`);
    const first5 = Buffer.from(head.data).slice(0, 5).toString("latin1");
    console.log(`[raw] first 5 bytes: ${JSON.stringify(first5)} (${first5 === "%PDF-" ? "PDF magic" : "NOT %PDF-"})`);
  } catch (e: any) {
    console.error(`[raw] fetch failed: ${e?.message}`);
  }

  // Step 1 — the production pinned fetch helper (gunzip + content-type/magic sniff).
  console.log(`\n[fetchPinnedPdfBytes] fetching...`);
  const sniff = await fetchPinnedPdfBytes(url);
  if (!sniff) {
    console.error(`❌ FAIL: fetchPinnedPdfBytes returned null — not recognised as PDF`);
    process.exit(1);
  }
  console.log(`✅ recognised as PDF via ${sniff.via}; content-type=${sniff.contentType}; bytes=${sniff.buf.length}`);

  // Step 2 — extraction.
  console.log(`\n[extractPdfWithFidelity] extracting...`);
  const fid = await extractPdfWithFidelity(sniff.buf);
  const text = (fid.text || "").trim();
  console.log(`extracted chars: ${text.length}`);
  console.log(`completeness: ${JSON.stringify(fid.completeness)}`);
  console.log(`\n--- first 400 chars ---\n${text.slice(0, 400)}\n-----------------------`);

  if (text.length > 1000) {
    console.log(`\n✅ PASS: pinned PDF downloaded, decompressed, and yielded ${text.length} chars of extractable text.`);
    process.exit(0);
  } else {
    console.error(`\n❌ FAIL: extracted text too short (${text.length} chars).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n❌ harness error: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
