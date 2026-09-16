// ─── Oversized-document guard (generic, framework-independent) ────────────────
//
// A single oversized fetched/decompressed document must never be able to blow the
// Node heap. The live incident: an ESEF filing pulled via the R7g gzip-fallback
// path was read into memory whole (~104 MB) and decompressed in one shot, driving
// the heap past its ~6 GB ceiling and killing the worker replica.
//
// This module provides ONE shared cap used at every document body-read/decompress
// site:
//   • getMaxDocBytes()            — the configurable cap (env MAX_DOC_BYTES,
//                                    default 52428800 = 50 MB).
//   • capDocumentText()           — truncate an already-in-memory string to the
//                                    cap (defensive post-fetch guard for all
//                                    text-producing paths). Prefers TRUNCATION
//                                    over dropping the whole document.
//   • readBodyDecompressedCapped()— STREAM a fetch Response body, gunzipping on
//                                    the fly when the bytes are raw-gzip, and stop
//                                    as soon as the cap is reached. This applies
//                                    the cap DURING decompression, so the full
//                                    104 MB is never materialised — the actual OOM
//                                    fix. Truncation is preferred over skipping.
//
// Everything here is generic: no framework/rubric/scoring logic. Normal-sized
// documents are returned byte-for-byte unchanged; only oversized ones are capped.

import { Readable } from "node:stream";
import zlib from "node:zlib";

/** Default cap: 50 MB of decompressed/document content. Configurable via env. */
export const DEFAULT_MAX_DOC_BYTES = 52428800; // 50 * 1024 * 1024

/** Resolve the cap from env at call time (so it can be tuned without a redeploy of code). */
export function getMaxDocBytes(): number {
  const raw = parseInt(process.env.MAX_DOC_BYTES || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_DOC_BYTES;
}

/**
 * Truncate a string so its UTF-8 byte length does not exceed the cap. Returns the
 * input unchanged when it is within the cap (the overwhelmingly common case, so
 * there is no cost for normal documents). Logs once, greppably, when it trims.
 *
 * Prefers truncation over dropping the document, to preserve as much information
 * as possible. A partial multi-byte character at the cut point is dropped cleanly.
 */
export function capDocumentText(text: string, url: string, tag = "fetch"): string {
  if (!text) return text;
  const cap = getMaxDocBytes();
  // Fast path: character count can never exceed byte count, so if chars <= cap
  // the bytes are <= cap too and we skip the (allocating) byteLength check.
  if (text.length <= cap) return text;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= cap) return text;
  // Truncate on a valid UTF-8 boundary: slice the raw buffer, then decode with
  // stream:true semantics via TextDecoder to discard a trailing partial char.
  const sliced = Buffer.from(text, "utf8").subarray(0, cap);
  // stream:true (with no final flush) holds back an incomplete trailing multi-byte
  // sequence instead of emitting a U+FFFD replacement char — i.e. drops it cleanly.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const capped = decoder.decode(sliced, { stream: true });
  console.log(
    `[${tag}] Document exceeded MAX_DOC_BYTES (${cap} bytes) — truncated ${bytes} -> ${Buffer.byteLength(capped, "utf8")} bytes: ${url}`,
  );
  return capped;
}

/**
 * Stream a `fetch()` Response body into a string, applying the byte cap DURING
 * read/decompression so an oversized document is never fully materialised.
 *
 * - Detects raw gzip (magic bytes 1f 8b) on the first chunk and, if present,
 *   decompresses incrementally through a streaming gunzip, stopping the moment
 *   the decompressed output reaches the cap. (Some Apache indexes, e.g.
 *   filings.xbrl.org, serve gzip WITHOUT a correct Content-Encoding header, so
 *   the platform fetch does not auto-decompress and we must do it here.)
 * - Otherwise reads the raw bytes, stopping at the cap.
 *
 * Prefers TRUNCATION over skipping. Never throws for size reasons; a genuine
 * stream error is caught and returns whatever was decoded so far (may be empty).
 *
 * @returns the (possibly truncated) decoded content and whether truncation occurred.
 */
export async function readBodyDecompressedCapped(
  body: ReadableStream<Uint8Array> | null | undefined,
  url: string,
  maxBytes: number = getMaxDocBytes(),
  tag = "fetch",
): Promise<{ content: string; truncated: boolean }> {
  if (!body) return { content: "", truncated: false };

  const nodeStream = Readable.fromWeb(body as any);
  const iterator = nodeStream[Symbol.asyncIterator]();

  // Stop consuming and release the underlying stream. Awaiting the iterator's
  // return() cancels the source cleanly (and completes before we return, so no
  // stray async activity fires afterwards); the destroy is belt-and-braces.
  const cleanup = async (): Promise<void> => {
    try { await iterator.return?.(); } catch { /* ignore */ }
    try { nodeStream.destroy(); } catch { /* ignore */ }
  };

  let first;
  try {
    first = await iterator.next();
  } catch {
    await cleanup();
    return { content: "", truncated: false };
  }
  if (first.done || !first.value) {
    await cleanup();
    return { content: "", truncated: false };
  }

  const firstChunk = Buffer.from(first.value);
  const isGzip = firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  const restIterable: AsyncIterable<any> = { [Symbol.asyncIterator]: () => iterator };

  // ── Raw (non-gzip) path: accumulate up to the cap, then stop. ──
  if (!isGzip) {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const push = (b: Buffer): boolean => {
      if (total + b.length > maxBytes) {
        chunks.push(b.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        return false;
      }
      chunks.push(b);
      total += b.length;
      return true;
    };
    try {
      if (push(firstChunk)) {
        for await (const c of restIterable) {
          if (!push(Buffer.from(c))) break;
        }
      }
    } catch {
      /* stream error — return what we have */
    } finally {
      await cleanup();
    }
    if (truncated) {
      console.log(`[${tag}] Document exceeded MAX_DOC_BYTES (${maxBytes} bytes) — truncated during read to ${total} bytes: ${url}`);
    }
    return { content: Buffer.concat(chunks).toString("utf-8"), truncated };
  }

  // ── Gzip path: stream-decompress and stop once output reaches the cap. ──
  const gunzip = zlib.createGunzip();
  const out: Buffer[] = [];
  let outTotal = 0;
  let truncated = false;
  let stopped = false;

  const drained = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (d: Buffer) => {
      if (stopped) return;
      if (outTotal + d.length > maxBytes) {
        out.push(d.subarray(0, maxBytes - outTotal));
        outTotal = maxBytes;
        truncated = true;
        stopped = true;
        try { gunzip.destroy(); } catch { /* ignore */ }
        return;
      }
      out.push(d);
      outTotal += d.length;
    });
    gunzip.on("end", () => resolve());
    gunzip.on("close", () => resolve());
    // Once we've deliberately stopped, a destroy-triggered error is expected.
    gunzip.on("error", (e) => (stopped ? resolve() : reject(e)));
  });

  // Feed compressed bytes into the gunzip stream. We intentionally do not await
  // 'drain': once the decompressed output hits the cap we stop and destroy, and
  // the compressed input required to produce <= cap of output is itself bounded,
  // so memory stays bounded either way.
  const feed = (async () => {
    try {
      gunzip.write(firstChunk);
      for await (const c of restIterable) {
        if (stopped) break;
        gunzip.write(Buffer.from(c));
      }
      if (!stopped) gunzip.end();
    } catch {
      /* gunzip destroyed after cap, or a write race — safe to ignore */
    }
  })();

  try {
    await drained;
  } catch {
    /* genuine decompression error — return whatever decoded so far */
  } finally {
    stopped = true;
    await cleanup();
    await feed.catch(() => {});
  }

  if (truncated) {
    console.log(`[${tag}] Document exceeded MAX_DOC_BYTES (${maxBytes} bytes) — gzip-truncated during decompression to ${outTotal} bytes: ${url}`);
  }
  return { content: Buffer.concat(out).toString("utf-8"), truncated };
}
